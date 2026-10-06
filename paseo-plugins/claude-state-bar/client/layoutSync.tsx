import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { isLayoutKey, layoutLoad, layoutSave, LAYOUT_ITEMS, type LayoutItemId, type LayoutSnapshot } from "../shared/layoutSync";
import type { SoundSettings } from "../shared/settings";
import { fmtStamp } from "./format";
import { currentSettings, soundProvider } from "./sounds";
import type { HeaderButtonSet } from "./usageButton";
import { appBundleId, isDesktopApp, readLocal, readSession, watchLocalWrites, writeLocalAndReload, writeSession } from "./web";

// 머리줄 동기화 단추(리규형님 10-07 결정 — 다시 묻지 않는다).
// - PC 앱은 작업 공간 순서·화면 구성이 바뀔 때마다 이 PC 데몬에 조용히 맡긴다(startLayoutSave)
// - 웹·폰(웹 감싸기 앱)은 화면을 열 때마다 PC 저장본을 가져온다 — 이 화면 값과 다를 때만 덮어쓰고 새로 읽는다(10-07 실화면 뒤
//   결정: "새로 접속하면 자동으로"). 머리줄 단추로 바로 다시 맞출 수도 있다 — 작은 창에 PC 저장 시각과 항목, [PC 에서 가져오기]
// - 웹 연결 목록의 이 PC 항목 이름이 서버 번호 그대로면 컴퓨터 이름으로 바꾼다(로그인 서버는 PC 이름을 모른다)
// - 무엇을 가져올지는 Claude State Bar 설정 화면에서 켜고 끈다(공통 설정, 처음 값 모두 켬)
// - 설정은 실시간 맞추기가, 서버 3대 열쇠는 로그인 서버가 맡아 여기 없다
// 폰 공식 앱은 화면 저장소를 만질 수 없어 단추를 달지 않는다.

const ENABLED: Record<LayoutItemId, keyof SoundSettings> = { order: "syncWorkspaceOrder", layout: "syncLayout" };

export function itemEnabled(settings: SoundSettings, id: LayoutItemId): boolean {
  return settings[ENABLED[id]] !== false;
}

/** PC 앱 화면에서만 — 두 열쇠를 시작할 때 한 번, 그다음은 바뀔 때마다 맡긴다. 보내는 중에 또 바뀌면 끝난 뒤 마지막 값만 보낸다 */
export function startLayoutSave(client: PluginClientContext, log: (message: string) => void): () => void {
  const slot = appBundleId();
  if (!slot || !isDesktopApp()) {
    log(`layout sync: not saving here (${!slot ? "app bundle unknown" : "not the PC app — this screen pulls with the header button"})`);
    return () => {};
  }
  const sending = new Set<string>();
  const next = new Map<string, string>();
  let stopped = false;
  const send = (key: string, value: string) => {
    if (stopped) return;
    if (sending.has(key)) {
      next.set(key, value);
      return;
    }
    sending.add(key);
    void client
      .rpc(layoutSave, { slot, key, value })
      .catch((error: unknown) => log(`layout sync: save ${key} failed ${String(error)}`))
      .finally(() => {
        sending.delete(key);
        const more = next.get(key);
        if (more === undefined) return;
        next.delete(key);
        send(key, more);
      });
  };
  for (const item of LAYOUT_ITEMS) {
    const value = readLocal(item.key);
    if (value !== null) send(item.key, value);
  }
  const stopWatch = watchLocalWrites((key, value) => {
    if (value !== null && isLayoutKey(key)) send(key, value);
  });
  log(`layout sync: saving ${slot.slice(0, 12)} from the PC app`);
  return () => {
    stopped = true;
    stopWatch();
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
 * 웹·폰 화면을 열 때마다 PC 앱 저장본을 가져온다(리규형님 10-07 결정 — 새로 고침해도 PC 배치로). 이 화면 값과 다를 때만 써 넣고
 * 새로 읽는다. 공통 설정을 못 읽었으면(settings=null) 꺼 둔 항목을 알 수 없어 가져오지 않는다. 연결 목록의 이 PC 항목 이름도 함께 고친다.
 */
export function startLayoutAutoPull(
  client: PluginClientContext,
  log: (message: string) => void,
  host: { serverId?: string | null; hostname?: string },
  settings: (() => SoundSettings) | null,
): () => void {
  const slot = appBundleId();
  if (Platform.OS !== "web" || isDesktopApp() || !slot) return () => {};
  if (readSession(PULLED_KEY)) {
    writeSession(PULLED_KEY, null);
    log("layout sync: opened after an automatic pull");
    return () => {};
  }
  let stopped = false;
  void (async () => {
    const changes: Record<string, string> = {};
    const registry = pcNameFix(host.serverId, host.hostname);
    if (registry) changes[REGISTRY_KEY] = registry;
    if (settings) {
      try {
        const snap = await client.rpc(layoutLoad, { slot });
        if (!snap.keys) log(`layout sync: no PC copy for this app version ${slot.slice(0, 12)}`);
        const current = settings();
        for (const item of LAYOUT_ITEMS) {
          const saved = snap.keys?.[item.key];
          if (saved && itemEnabled(current, item.id) && !sameJson(readLocal(item.key), saved.v)) changes[item.key] = saved.v;
        }
      } catch (error) {
        log(`layout sync: load failed ${String(error)}`);
      }
    } else {
      log("layout sync: settings unread — not pulling on open");
    }
    const keys = Object.keys(changes);
    if (stopped || !keys.length) return;
    log(`layout sync: pulling on open ${keys.join(",")}`);
    writeSession(PULLED_KEY, "1");
    writeLocalAndReload(changes);
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
      setView({ kind: "error", text: "이 화면에서는 가져올 수 없습니다(화면 판을 알 수 없음)" });
      return;
    }
    if (!provider?.loadLayout) {
      setView({ kind: "error", text: "PC 에 연결돼 있지 않아 가져올 수 없습니다" });
      return;
    }
    provider.loadLayout(slot).then(
      (data) => alive && setView({ kind: "ready", slot, data }),
      (error: unknown) => alive && setView({ kind: "error", text: `PC 저장본을 읽지 못했습니다: ${String(error)}` }),
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
        <Text style={text}>PC 에서 가져오기</Text>
        <Text style={muted}>{view.kind === "loading" ? "PC 저장본을 읽는 중입니다" : view.text}</Text>
      </View>
    );
  }

  const keys = view.data.keys;
  const rows = LAYOUT_ITEMS.map((item) => {
    const on = itemEnabled(settings, item.id);
    const saved = keys?.[item.key];
    return { item, on, saved };
  });
  const ready = rows.filter((r) => r.on && r.saved);
  let note: string | null = null;
  if (!keys) {
    note = view.data.slots.length
      ? "PC 앱과 이 화면의 Paseo 판이 달라 가져올 수 없습니다. 웹 화면 판을 PC 앱과 같게 올리면 됩니다"
      : "PC 앱이 아직 저장하지 않았습니다. PC 앱을 한 번 열어 두면 저장됩니다";
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
      <Text style={text}>PC 에서 가져오기</Text>
      {rows.map(({ item, on, saved }) => (
        <Text key={item.id} style={on ? text : muted}>
          {item.title} — {!on ? "설정에서 꺼 둠" : saved ? `PC 저장 ${fmtStamp(saved.at)}` : "PC 저장본 없음"}
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
          {busy ? "가져오는 중" : "PC 에서 가져오기"}
        </Text>
      </Pressable>
    </View>
  );
}

/** 머리줄 동기화 단추(톱니 왼쪽). 웹·폰 웹 감싸기 앱에서만 — PC 앱은 가져올 곳이 자기 자신이다 */
export function createSyncButtons(client: PluginClientContext): HeaderButtonSet {
  const registrations = new Map<string, PluginButtonRegistration>();
  const shown = Platform.OS === "web" && !isDesktopApp();
  return {
    add(workspaceId) {
      if (!shown || registrations.has(workspaceId)) return;
      registrations.set(
        workspaceId,
        client.addHeaderButton({
          id: "layout-sync",
          workspaceId,
          button: { title: "PC 에서 작업 공간 순서·화면 구성 가져오기", icon: "MonitorDown", behavior: { kind: "popover", Content: SyncPopover } },
        }),
      );
    },
    drop(workspaceId) {
      registrations.get(workspaceId)?.remove();
      registrations.delete(workspaceId);
    },
    dispose() {
      for (const registration of registrations.values()) registration.remove();
      registrations.clear();
    },
  };
}
