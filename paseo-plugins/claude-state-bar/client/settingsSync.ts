import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { APP_SETTINGS_KEY, isSyncKey, SHARED_APP_FIELDS, syncPut, syncWait, toShared } from "../shared/settingsSync";
import {
  appBundleId,
  isDesktopApp,
  localKeys,
  onUserInput,
  readLocal,
  readSession,
  reloadPage,
  removeLocal,
  watchLocalWrites,
  writeLocal,
  writeSession,
} from "./web";

// 기기 사이 Paseo 설정 맞추기 — 화면 쪽(리규형님 10-07 결정). PC 앱·웹·폰 웹 감싸기 앱이 같은 설정을 쓰게, 이 화면의
// 브라우저 저장소를 PC 데몬의 정본(server/settingsSync)에 맞춘다.
//  - 맞추는 것: 설정 화면의 설정만(일반·모양·사이드바·채팅·단축키 — 칸 목록은 shared/settingsSync). 글자 크기는 기기별
//  - 다른 기기에서 바꾸면 열려 있어도 바로 — Paseo 는 설정을 시작할 때만 읽어서 화면을 새로 읽는다
//  - 화면 판이 같을 때만 맞추고, 다른 판 화면에서 바꾼 것이 있으면 알린다
//  - 처음 기준은 PC 앱: 정본이 비었으면 PC 앱만 칸을 만든다. 판이 올라가 새 칸이 필요하면 전에 맞춰 본 화면이 만든다
// 정본은 PC 데몬 하나라 이 PC 플러그인(소리 담당 호스트)에서만 시작한다.

/** 이 기기가 정본과 맞춰 본 적 있는지(마지막으로 맞춘 칸) — 판이 올라갔을 때 새 칸을 만들 자격 */
const JOINED_KEY = "claude-state-bar:settings-sync-joined";
/** 이 탭에서 이미 새로 읽은 정본 번호 — 받은 값을 Paseo 가 시작하며 다르게 다시 써도 새로 읽기가 되풀이되지 않게 */
const RELOADED_KEY = "claude-state-bar:settings-sync-reloaded";
/** 새로 읽은 뒤 알릴 말 */
const NOTICE_KEY = "claude-state-bar:settings-sync-notice";
/** 이 탭에서 판 다름을 이미 알린 판 — 새로 읽을 때마다 같은 알림이 뜨지 않게 */
const WARNED_KEY = "claude-state-bar:settings-sync-warned";
/** 묻다가 실패하면 쉬는 시간 — 플러그인의 다른 목록과 같은 쉬는 주기(확장 상태바 기본 새로고침 30초) */
const RETRY_MS = 30_000;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}
/** 같은 내용인지 — JSON 이면 열쇠 순서는 보지 않는다 */
function same(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const pa = parse(a);
  const pb = parse(b);
  return pa !== undefined && pb !== undefined && JSON.stringify(sortKeys(pa)) === JSON.stringify(sortKeys(pb));
}

/** 이 기기에 쓸 값 — 앱 설정은 이 기기 값에서 맞추는 칸만 정본 값으로 바꾼다(글자 크기·터미널 등 나머지 칸은 그대로).
 *  정본에서 앱 설정이 지워졌으면 맞추는 칸만 지운다(기본값) — 이 기기 칸까지 날리지 않게 */
function fromShared(key: string, shared: string | null, local: string | null): string | null {
  if (key !== APP_SETTINGS_KEY) return shared;
  const l = local === null ? undefined : parse(local);
  const out: Record<string, unknown> = isRecord(l) ? { ...l } : {};
  for (const f of SHARED_APP_FIELDS) delete out[f];
  const o = shared === null ? undefined : parse(shared);
  if (isRecord(o)) for (const f of SHARED_APP_FIELDS) if (f in o) out[f] = o[f];
  return JSON.stringify(out);
}

// 화면에 띄울 알림 한 줄(왼쪽 목록 맨 위 칸이 토스트로 띄운다). warn = 맞추지 못한 것
export type SyncNotice = { text: string; warn: boolean };
let notice: SyncNotice | null = null;
const noticeListeners = new Set<(n: SyncNotice | null) => void>();
function setNotice(next: SyncNotice | null): void {
  notice = next;
  for (const l of noticeListeners) l(next);
}
export function useSyncNotice(): SyncNotice | null {
  const [n, setN] = useState(notice);
  useEffect(() => {
    noticeListeners.add(setN);
    setN(notice);
    return () => {
      noticeListeners.delete(setN);
    };
  }, []);
  return n;
}
/** 띄운 쪽이 부른다 — 같은 알림을 두 번 띄우지 않게 */
export function clearSyncNotice(): void {
  setNotice(null);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startSettingsSync(client: PluginClientContext, log: (message: string) => void): () => void {
  const slot = appBundleId();
  if (!slot) {
    log("settings sync: off (not web or app bundle unknown)");
    return () => {};
  }
  const tag = slot.slice(0, 12);
  let stopped = false;
  /** 이 판 칸에서 마지막으로 받은 번호. -1 = 아직 안 물음, 0 = 칸이 없음 */
  let rev = -1;
  /** 이 화면에서 사람이 한 번이라도 눌렀는지 — 그 전에 Paseo 가 스스로 쓰는 것(시작·새로 읽은 직후 정리)은 올리지 않는다.
   *  두 기기가 받은 값을 저마다 다르게 다시 써서 서로를 끝없이 새로 읽히는 것을 막는다 */
  let acted = false;
  let applying = false;
  /** 마지막으로 받은 칸의 열쇠별 바뀐 시각. null = 아직 안 받음(처음엔 전부 맞춘다) */
  let seen: Map<string, number> | null = null;
  let joined = readLocal(JOINED_KEY) !== null;
  /** 아직 안 보낸 것·보내는 중인 것 — 그 사이 받은 옛 정본 값으로 방금 바꾼 것을 덮지 않게 건너뛴다 */
  const pending = new Map<string, string | null>();
  const inflight = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const after = readSession(NOTICE_KEY);
  if (after) {
    writeSession(NOTICE_KEY, null);
    setNotice({ text: after, warn: false });
  }

  const flush = () => {
    flushTimer = null;
    if (pending.size === 0) return;
    const changes = Object.fromEntries(pending);
    pending.clear();
    const keys = Object.keys(changes);
    if (rev <= 0) {
      log(`settings sync: not sent, no shared settings for ${tag} yet: ${keys.join(",")}`);
      return;
    }
    for (const k of keys) inflight.add(k);
    void client
      .rpc(syncPut, { slot, changes, seed: false })
      .then((r) => log(`settings sync: sent ${keys.join(",")} rev=${r.rev} applied=${r.applied}`))
      .catch((error) => log(`settings sync: send failed: ${String(error)}`))
      .finally(() => {
        for (const k of keys) inflight.delete(k);
      });
  };

  const stopWatch = watchLocalWrites((key, value) => {
    if (applying || !acted || !isSyncKey(key)) return;
    const shared = toShared(key, value);
    if (shared === undefined) return;
    pending.set(key, shared);
    // 같은 순간에 몰려 쓰는 것(설정 하나 바꿀 때 여러 열쇠)은 한 번에 보낸다
    flushTimer ??= setTimeout(flush, 0);
  });
  const stopInput = onUserInput(() => {
    acted = true;
  });

  /** 처음엔 전부, 그다음부터는 지난번 뒤로 정본에서 바뀐 열쇠만 맞춘다 — 이 화면이 사람 입력 없이 스스로 다르게 써 둔 값을
   *  (올리지 않은 것) 다른 열쇠가 바뀔 때마다 되돌리며 새로 읽지 않게(10-07 시험에서 자기가 보낸 변경으로 새로 읽던 것) */
  const apply = (keys: Record<string, { v: string | null; at: number }>): string[] => {
    const prev = seen;
    const nextSeen = new Map<string, number>();
    const changed: string[] = [];
    applying = true;
    try {
      for (const [key, e] of Object.entries(keys)) {
        if (!isSyncKey(key)) continue;
        if (pending.has(key) || inflight.has(key)) {
          // 보내는 중인 것은 건너뛰고 다음에 다시 본다
          const at = prev?.get(key);
          if (at !== undefined) nextSeen.set(key, at);
          continue;
        }
        nextSeen.set(key, e.at);
        if (prev && prev.get(key) === e.at) continue;
        const local = readLocal(key);
        const shared = toShared(key, e.v);
        if (shared === undefined) continue;
        const mine = toShared(key, local);
        if (mine !== undefined && same(mine, shared)) continue;
        const next = fromShared(key, shared, local);
        if (next === null) removeLocal(key);
        else writeLocal(key, next);
        changed.push(key);
      }
    } finally {
      applying = false;
    }
    seen = nextSeen;
    return changed;
  };

  const seed = async (why: string) => {
    const changes: Record<string, string | null> = {};
    for (const key of localKeys()) {
      if (!isSyncKey(key)) continue;
      const shared = toShared(key, readLocal(key));
      if (shared !== undefined) changes[key] = shared;
    }
    const r = await client.rpc(syncPut, { slot, changes, seed: true });
    log(`settings sync: seed ${tag} (${why}) applied=${r.applied} keys=${Object.keys(changes).join(",")}`);
  };

  /** 다른 판 칸이 이 칸보다 나중에 바뀌었으면 한 번 알린다 */
  const checkOtherVersions = (slots: { slot: string; at: number }[]) => {
    if (readSession(WARNED_KEY) === slot) return;
    const mine = slots.find((s) => s.slot === slot)?.at ?? 0;
    if (!slots.some((s) => s.slot !== slot && s.at > mine)) return;
    writeSession(WARNED_KEY, slot);
    log(`settings sync: another app version (not ${tag}) has newer settings — not applied here`);
    setNotice({ text: "Paseo 판이 다른 화면에서 바꾼 설정이 있어 이 화면에는 맞추지 않았습니다. 두 화면의 판이 같아지면 다시 맞춰집니다", warn: true });
  };

  const loop = async () => {
    while (!stopped) {
      const res = await client.rpc(syncWait, { slot, rev }).catch((error: unknown) => {
        log(`settings sync: wait failed: ${String(error)}`);
        return null;
      });
      if (stopped) return;
      if (!res) {
        await sleep(RETRY_MS);
        continue;
      }

      if (res.keys === null) {
        const empty = res.slots.length === 0;
        if ((empty && isDesktopApp()) || (!empty && joined)) {
          try {
            await seed(empty ? "first, desktop app" : "new app version");
          } catch (error) {
            log(`settings sync: seed failed: ${String(error)}`);
            await sleep(RETRY_MS);
          }
          continue; // 다음 물음에서 만든 칸을 받는다
        }
        if (!empty) checkOtherVersions(res.slots);
        if (rev !== 0) log(`settings sync: waiting for ${tag} — ${empty ? "PC app has not shared its settings yet" : "this app version has no shared settings"}`);
        rev = 0;
        continue;
      }

      checkOtherVersions(res.slots);
      if (res.rev === rev) continue; // 기다림만 끝났다
      const first = seen === null;
      rev = res.rev;
      if (readLocal(JOINED_KEY) !== slot) writeLocal(JOINED_KEY, slot);
      joined = true;
      const changed = apply(res.keys);
      if (changed.length === 0) continue;
      log(`settings sync: applied ${changed.join(",")} (rev ${rev}, ${first ? "on start" : "changed on another device"})`);
      if (readSession(RELOADED_KEY) === `${slot}:${rev}`) {
        log(`settings sync: already reloaded for rev ${rev} — not again`);
        continue;
      }
      writeSession(RELOADED_KEY, `${slot}:${rev}`);
      writeSession(
        NOTICE_KEY,
        first ? "공통 설정(PC)에 맞춰 화면을 새로 읽었습니다" : "다른 기기에서 바꾼 설정에 맞춰 화면을 새로 읽었습니다",
      );
      reloadPage();
      return;
    }
  };
  void loop();

  return () => {
    stopped = true;
    stopWatch();
    stopInput();
    if (flushTimer) clearTimeout(flushTimer);
  };
}
