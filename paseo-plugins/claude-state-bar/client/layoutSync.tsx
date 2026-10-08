import type { PluginButtonContentProps, PluginButtonMenuEntry, PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { isLayoutKey, layoutLoad, layoutSave, LAYOUT_ITEMS, type LayoutItemId, type LayoutSnapshot } from "../shared/layoutSync";
import type { SoundSettings } from "../shared/settings";
import { fmtStamp } from "./format";
import { isPublisher, noteOwner, onOwnerChange, ownerState, refreshOwner, screenKey } from "./screenRole";
import { currentSettings, soundProvider } from "./sounds";
import { appBundleId, applyPaseoLayoutCopy, isDesktopApp, readLocal, readSession, watchLocalWrites, workspaceInteractionVersion, writeLocal, writeLocalAndReload, writeSession } from "./web";

// PC 에서 가져오기(리규형님 10-07 결정 — 다시 묻지 않는다).
// - PC 앱은 작업 공간 순서·화면 구성이 바뀔 때마다 이 PC 데몬에 조용히 맡긴다(startLayoutSave)
// - 웹·폰(웹 감싸기 앱)은 화면을 열 때마다 PC 저장본을 가져온다 — 이 화면 값과 다를 때 메모리에 반영한다(10-07 실화면 뒤
//   결정: "새로 접속하면 자동으로"). 톱니 메뉴로 바로 다시 맞출 수도 있다 — 작은 창에 PC 저장 시각과 항목, [PC 에서 가져오기]
// - 웹 연결 목록의 이 PC 항목 이름이 서버 번호 그대로면 컴퓨터 이름으로 바꾼다(로그인 서버는 PC 이름을 모른다)
// - 무엇을 가져올지는 Claude State Bar 설정 화면에서 켜고 끈다(공통 설정, 처음 값 모두 켬)
// - 설정은 실시간 맞추기가, 서버 3대 열쇠는 로그인 서버가 맡아 여기 없다
// 폰 공식 앱은 화면 저장소를 만질 수 없어 메뉴 항목을 달지 않는다.

const ENABLED: Record<LayoutItemId, keyof SoundSettings> = { order: "syncWorkspaceOrder", layout: "syncLayout" };

export function itemEnabled(settings: SoundSettings, id: LayoutItemId): boolean {
  return settings[ENABLED[id]] !== false;
}

/**
 * 기준 화면에서만 — 두 열쇠를 기준이 될 때 한 번, 그다음은 바뀔 때마다 맡긴다. 보내는 중에 또 바뀌면 끝난 뒤 마지막 값만 보낸다.
 * 기준 화면 = 대표 PC 웹(10-08, client/screenRole — 설정 화면 버튼으로 지정), 대표가 없으면 예전 그대로 PC 앱.
 * 데몬이 거절하면(다른 화면이 대표) 대표가 바뀔 때까지 보내지 않는다
 */
export function startLayoutSave(client: PluginClientContext, log: (message: string) => void): () => void {
  const slot = appBundleId();
  if (!slot) {
    log("layout sync: not saving here (app bundle unknown)");
    return () => {};
  }
  const sending = new Set<string>();
  const next = new Map<string, string>();
  let stopped = false;
  let refused = false;
  let saving: boolean | null = null;
  const send = (key: string, value: string) => {
    if (stopped || refused || isPublisher() !== true) return;
    if (sending.has(key)) {
      next.set(key, value);
      return;
    }
    sending.add(key);
    void client
      .rpc(layoutSave, { slot, key, value, screen: screenKey() ?? undefined })
      .then((r) => {
        if (!r.refused) return;
        refused = true;
        log(`layout sync: not saving — the representative screen is ${r.owner?.label ?? "another screen"}`);
        noteOwner(r.owner ?? null);
      })
      .catch((error: unknown) => log(`layout sync: save ${key} failed ${String(error)}`))
      .finally(() => {
        sending.delete(key);
        const more = next.get(key);
        if (more === undefined) return;
        next.delete(key);
        send(key, more);
      });
  };
  // 기준이 되면(처음 역할을 알았을 때·이 브라우저를 대표로 정했을 때) 지금 값을 한 번 보낸다. 역할을 아직 모르면 기다린다
  const sync = () => {
    refused = false;
    const { known, owner } = ownerState();
    if (!known) return;
    const publisher = isPublisher() === true;
    if (publisher !== saving) {
      saving = publisher;
      log(
        publisher
          ? `layout sync: saving ${slot.slice(0, 12)} — this is the ${owner ? "representative screen" : "PC app"}`
          : `layout sync: not saving here — ${owner ? `the representative screen is ${owner.label}` : "the PC app saves"}; this screen pulls on open and from the gear menu`,
      );
    }
    if (!publisher) return;
    for (const item of LAYOUT_ITEMS) {
      const value = readLocal(item.key);
      if (value !== null) send(item.key, value);
    }
  };
  const stopRole = onOwnerChange(sync);
  sync();
  const stopWatch = watchLocalWrites((key, value) => {
    if (value !== null && isLayoutKey(key)) send(key, value);
  });
  return () => {
    stopped = true;
    stopWatch();
    stopRole();
  };
}

/** 바로 앞 새로 읽기가 이 자동 가져오기 때문이었다는 표식(이 탭에만) — 새로 읽은 화면이 또 가져와 끝없이 새로 읽지 않게 */
const PULLED_KEY = "claude-state-bar:layout-pulled";
const REGISTRY_KEY = "@paseo:daemon-registry";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
}
function sameJson(a: string | null, b: string): boolean {
  if (a === b) return true;
  if (a === null) return false;
  try {
    return JSON.stringify(sortKeys(JSON.parse(a))) === JSON.stringify(sortKeys(JSON.parse(b)));
  } catch {
    return false;
  }
}

/**
 * 웹 연결 목록에서 이 PC 항목 이름이 서버 번호 그대로면(로그인 서버가 이름 없이 넣은 것) 컴퓨터 이름으로 바꾼 목록. 바꿀 것이 없으면 null.
 * 리규형님이 따로 지은 이름은 건드리지 않는다
 */
function pcNameFix(serverId: string | null | undefined, name: string | undefined): string | null {
  if (!serverId || !name) return null;
  const raw = readLocal(REGISTRY_KEY);
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as { serverId?: string; label?: string }[];
    if (!Array.isArray(list)) return null;
    const entry = list.find((h) => h && h.serverId === serverId);
    if (!entry || (entry.label && entry.label !== serverId) || entry.label === name) return null;
    entry.label = name;
    return JSON.stringify(list);
  } catch {
    return null;
  }
}

/**
 * 웹·폰 화면을 열 때 PC 배치를 메모리에 반영한다. 기다리는 사이 사용자 동작·로컬 변경이 있었으면 그 변경이 우선이다.
 * 지원하지 않는 판은 자동 복사를 건너뛴다. 설정을 못 읽었으면 꺼 둔 항목을 알 수 없어 가져오지 않는다.
 */
export function startLayoutAutoPull(
  client: PluginClientContext,
  log: (message: string) => void,
  host: { serverId?: string | null; hostname?: string },
  settings: (() => SoundSettings) | null,
): () => void {
  const slot = appBundleId();
  // 10-08: PC 앱도 대표 PC 웹이 정해져 있으면 가져가는 쪽이다(기준 화면 판정은 아래 비동기에서)
  if (Platform.OS !== "web" || !slot) return () => {};
  if (readSession(PULLED_KEY)) {
    writeSession(PULLED_KEY, null);
    log("layout sync: opened after an automatic pull");
    return () => {};
  }
  // "열 때 가져온다"(10-07 결정)는 페이지를 열 때다. 이미 열린 페이지에서 플러그인만 다시 읽힌 것(배포·다시 불러오기)은 열기가
  // 아니다 — 그때 가져오면 쓰던 웹 배치가 PC 옛 저장본으로 돌아가고 최대화도 풀린다(10-08 하루 19번, 10-09 확인). 페이지 표식은
  // globalThis 라 페이지를 새로 열면 사라진다. 이 표식이 없던 옛 판이 이미 돈 페이지는 옛 판이 아래 workspaceInteractionVersion()
  // 으로 만든 표식(__claudeStateBar_workspaceAction_v1)으로 알아본다 — 새 페이지에선 여기 오기 전에 그것을 만드는 곳이 없다
  // (만드는 곳은 이 함수와 작업 현황 나누기·프로젝트 목록의 사람 조작뿐, 사람 조작이면 어차피 가져오지 않는다)
  const page = globalThis as { __claudeStateBar_layoutOpened_v1?: boolean; __claudeStateBar_workspaceAction_v1?: unknown };
  if (page.__claudeStateBar_layoutOpened_v1 || page.__claudeStateBar_workspaceAction_v1 !== undefined) {
    log("layout sync: plugin reloaded in an open page — not pulling");
    return () => {};
  }
  page.__claudeStateBar_layoutOpened_v1 = true;
  let stopped = false;
  const interaction = workspaceInteractionVersion();
  if (interaction > 0) {
    log("layout sync: user already acted — keeping this screen's layout");
    return () => {};
  }
  const before = new Map(LAYOUT_ITEMS.map((item) => [item.key, readLocal(item.key)]));
  void (async () => {
    // 기준 화면은 가져오지 않는다(자기가 저장하는 쪽). 데몬에 못 물었으면 예전 규칙(PC 앱은 기준, 웹은 가져감)
    if (!ownerState().known) await refreshOwner().catch(() => {});
    if (stopped) return;
    if (isPublisher() ?? isDesktopApp()) {
      log(`layout sync: this screen is the ${ownerState().owner ? "representative screen" : "PC app"} — not pulling on open`);
      return;
    }
    const changes: Record<string, string> = {};
    // 웹 연결 목록 이름 보정은 웹만(PC 앱은 연결 목록이 따로다)
    const registry = isDesktopApp() ? null : pcNameFix(host.serverId, host.hostname);
    if (registry) changes[REGISTRY_KEY] = registry;
    if (settings) {
      try {
        const snap = await client.rpc(layoutLoad, { slot });
        if (!snap.keys) log(`layout sync: no PC copy for this app version ${slot.slice(0, 12)}`);
        const current = settings();
        for (const item of LAYOUT_ITEMS) {
          const saved = snap.keys?.[item.key];
          if (saved && itemEnabled(current, item.id) && readLocal(item.key) === before.get(item.key) && !sameJson(readLocal(item.key), saved.v)) changes[item.key] = saved.v;
        }
      } catch (error) {
        log(`layout sync: load failed ${String(error)}`);
      }
    } else {
      log("layout sync: settings unread — not pulling on open");
    }
    const keys = Object.keys(changes);
    if (stopped || !keys.length) return;
    if (workspaceInteractionVersion() !== interaction) {
      log("layout sync: user acted while loading — keeping this screen's layout");
      return;
    }
    for (const key of keys) {
      if (key === REGISTRY_KEY) {
        // 이름 보정은 저장본에만 반영하며 문서를 새로 읽지 않는다.
        if (pcNameFix(host.serverId, host.hostname) === changes[key]) writeLocal(key, changes[key]);
      } else if (applyPaseoLayoutCopy(key, changes[key])) {
        log(`layout sync: applied on open without reload ${key}`);
      } else {
        log(`layout sync: live copy unavailable — keeping ${key}`);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

type Status = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready"; slot: string; data: LayoutSnapshot };

function SyncPopover({ theme }: PluginButtonContentProps) {
  const [view, setView] = useState<Status>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const settings = currentSettings();

  useEffect(() => {
    let alive = true;
    const slot = appBundleId();
    const provider = soundProvider();
    if (!slot) {
      setView({ kind: "error", text: "이 화면에서는 가져올 수 없습니다(Paseo 버전을 알 수 없음)" });
      return;
    }
    if (!provider?.loadLayout) {
      setView({ kind: "error", text: "PC 에 연결돼 있지 않아 가져올 수 없습니다" });
      return;
    }
    provider.loadLayout(slot).then(
      (data) => alive && setView({ kind: "ready", slot, data }),
      (error: unknown) => alive && setView({ kind: "error", text: `저장된 배치를 읽지 못했습니다: ${String(error)}` }),
    );
    return () => {
      alive = false;
    };
  }, []);

  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 13 };
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const box = { padding: 12, gap: 8, width: 280, backgroundColor: c.surface1 };

  if (view.kind !== "ready") {
    return (
      <View style={box}>
        <Text style={text}>대표 배치 가져오기</Text>
        <Text style={muted}>{view.kind === "loading" ? "저장된 배치를 읽는 중입니다" : view.text}</Text>
      </View>
    );
  }

  const keys = view.data.keys;
  const rows = LAYOUT_ITEMS.map((item) => {
    const on = itemEnabled(settings, item.id);
    const saved = keys?.[item.key];
    return { item, on, saved };
  });
  const { owner } = ownerState();
  // 기준 화면(10-08 대표 PC 웹, 없으면 PC 앱)
  const source = owner ? `대표 디바이스(${owner.label})` : "PC 앱";
  const ready = isPublisher() === true ? [] : rows.filter((r) => r.on && r.saved);
  let note: string | null = null;
  if (isPublisher() === true) {
    note = "이 브라우저가 대표 디바이스라 가져올 곳이 없습니다 — 이 브라우저의 배치가 저장되는 쪽입니다";
  } else if (!keys) {
    note = view.data.slots.length
      ? `${source} 쪽과 이 화면의 Paseo 버전이 달라 가져올 수 없습니다. 두 곳의 Paseo 버전을 같게 올리면 됩니다`
      : `${source} 쪽이 아직 저장하지 않았습니다. ${owner ? "대표 디바이스에서" : "PC 앱에서"} Paseo 를 한 번 열어 두면 저장됩니다`;
  } else if (!rows.some((r) => r.on)) {
    note = "가져올 항목이 모두 꺼져 있습니다. Claude State Bar 설정 화면에서 켜 주세요";
  }

  const pull = () => {
    if (!keys || !ready.length) return;
    setBusy(true);
    // 작은 창을 닫지 않고 바로 — 닫으면 포커스가 바뀌며 Paseo 가 화면 구성을 다시 저장한다. 써 넣은 뒤 새로 읽힐 때까지
    // 두 열쇠 쓰기를 막는다(writeLocalAndReload)
    writeLocalAndReload(Object.fromEntries(ready.map((r) => [r.item.key, r.saved!.v])));
  };

  return (
    <View style={box}>
      <Text style={text}>대표 배치 가져오기</Text>
      {rows.map(({ item, on, saved }) => (
        <Text key={item.id} style={on ? text : muted}>
          {item.title} — {!on ? "설정에서 꺼 둠" : saved ? `저장 ${fmtStamp(saved.at)}` : "저장된 배치 없음"}
        </Text>
      ))}
      {note ? <Text style={muted}>{note}</Text> : <Text style={muted}>이 화면의 같은 항목을 덮어쓰고 화면을 새로 읽습니다</Text>}
      <Pressable
        onPress={pull}
        disabled={busy || !ready.length}
        accessibilityRole="button"
        style={{ paddingVertical: 8, borderRadius: 8, backgroundColor: ready.length ? c.accent : c.surface2, opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: ready.length ? c.accentForeground : c.foregroundMuted, textAlign: "center", fontSize: 13 }}>
          {busy ? "가져오는 중" : "대표 배치 가져오기"}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * 톱니 메뉴의 "PC 에서 가져오기" 항목. 웹·폰 웹 감싸기 앱에서만 — PC 앱은 가져올 곳이 자기 자신이라 null.
 * 처음엔 톱니 왼쪽 단추였는데 Paseo 가 머리줄 플러그인 단추를 셋까지만 보여 줘(plugins/buttons/view.tsx, 0.11.0-beta.5)
 * 웹에서 작업 현황이 ⋯ 로 접혔다 → 톱니와 합쳤다(리규형님 10-07 결정). 메뉴 안 작은 창은 Paseo 가 다음 쪽으로 연다
 */
export function syncMenuItem(): PluginButtonMenuEntry | null {
  if (Platform.OS !== "web" || isDesktopApp()) return null;
  return { kind: "item", id: "layout-sync", title: "대표 배치 가져오기", icon: "MonitorDown", behavior: { kind: "popover", Content: SyncPopover } };
}
