import type { PluginClientContext } from "@getpaseo/plugin/client";
import { watchPluginSettings } from "./settingsCache";
import { pageHidden } from "./pageVisible";
import { pushReceived, pushRegister } from "../shared/push";
import { hostInfo, soundDataV2 } from "../shared/sound";
import { PROJECTS_SCREEN_ID } from "./projectsScreen";

// 폰 감싸기 앱(com.blueming.paseo)과 맞춘 약속(10-15, peer_mail 01c8f1ba·d5e4d1d0) — 바꾸면 폰 앱과 어긋난다.
// 토큰: window.PaseoShell.pushToken()(문자열|null, 막 열렸을 땐 null) + 바뀌거나 늦게 오면 "paseoshell:push-token"(detail.token)
// 알림 누름: "paseoshell:open"(detail {path, serverId, workspaceId, agentId}, cancelable) — 웹이 처리하면 preventDefault(),
// 아무도 안 부르면 앱이 https://paseo.yeogiaen.com + path 로 전체 이동한다
// 10-17(peer_mail 91f222d6): 받았다 "paseoshell:push-received"(detail {eventId, kind, receivedAt}) · 원래 소리 PaseoShell.setAlertSound(kind, base64, mimeType)
// (kind = question | compact, 저장하면 true, 빈 base64 는 저장한 소리 지움 — 앱이 알림 때 직접 튼다)
type Shell = { pushToken?: () => string | null; setAlertSound?: (kind: string, base64: string, mimeType: string) => boolean };
type ShellEvent = { detail?: unknown; preventDefault(): void };
type Win = {
  PaseoShell?: Shell;
  addEventListener(type: string, fn: (event: ShellEvent) => void): void;
  removeEventListener(type: string, fn: (event: ShellEvent) => void): void;
};

const win = () => (globalThis as { window?: Win }).window;

/** 데몬마다 도는 화면 플러그인이 자기 데몬에 폰 토큰을 맡긴다(폰 앱 밖 — PC 앱·브라우저 — 에서는 아무것도 안 한다) */
export function startPushToken(client: PluginClientContext, log: (message: string) => void): () => void {
  const w = win();
  if (!w) return () => {};
  let last = "";
  const register = (token: unknown) => {
    if (typeof token !== "string" || !token || token === last) return;
    last = token;
    void client.rpc(pushRegister, { token }).then(
      (r) => log(`push token: registered (sending ${r.enabled ? "on" : "off"})`),
      (error: unknown) => {
        last = "";
        log(`push token: register failed ${String(error)}`);
      },
    );
  };
  try {
    register(w.PaseoShell?.pushToken?.());
  } catch (error) {
    log(`push token: read failed ${String(error)}`);
  }
  const onToken = (event: ShellEvent) => register((event.detail as { token?: unknown } | undefined)?.token);
  w.addEventListener("paseoshell:push-token", onToken);
  // 폰 앱이 알림을 받았다 — 자기 데몬에 전한다(그 알림을 보낸 데몬만 받아들인다). 화면이 가려져 있어도 바로 보낸다
  const onReceived = (event: ShellEvent) => {
    const d = event.detail as { eventId?: unknown; kind?: unknown; receivedAt?: unknown } | undefined;
    if (typeof d?.eventId !== "string" || !d.eventId) return;
    void client.rpc(pushReceived, { eventId: d.eventId, ...(typeof d.kind === "string" ? { kind: d.kind } : {}), ...(typeof d.receivedAt === "number" ? { receivedAt: d.receivedAt } : {}) })
      .then((r) => { if (r.ok) log(`push received: ${d.eventId}`); }, () => { /* 옛 판 데몬 — 그 소리는 PC 에서도 울린다 */ });
  };
  w.addEventListener("paseoshell:push-received", onReceived);
  return () => {
    w.removeEventListener("paseoshell:push-token", onToken);
    w.removeEventListener("paseoshell:push-received", onReceived);
  };
}

/**
 * 폰 앱에 원래 소리를 넘긴다(10-17 리규형님 "폰 알림 소리는 원래 소리 — 폰으로 모든 것을 판단"). 소리 파일이 있는 데몬(소리를 낼 수 있는 PC)을
 * 맡은 화면만 — 그 데몬 설정의 질문·압축 준비 소리를 받아 앱에 맡긴다. 처음 붙을 때와 정본 설정이 바뀔 때 받는다. 뒤에 있으면 다음 전면 복귀까지 보류한다.
 * 설정 변경 없는 앞뒤 전환은 다시 받지 않으며, 같은 길이로 바뀐 소리도 내용으로 비교한다
 */
export function startAlertSounds(client: PluginClientContext, log: (message: string) => void, onVisible: (fn: () => void) => () => void): () => void {
  const w = win();
  if (typeof w?.PaseoShell?.setAlertSound !== "function") return () => {};
  const sent = new Map<string, string>();
  let busy = false, dirty = true, stopped = false, revision = 0;
  const sync = async () => {
    if (busy || stopped || !dirty || pageHidden()) return;
    busy = true; dirty = false;
    const observed = revision;
    let completed = false;
    try {
      const info = await client.rpc(hostInfo, {});
      if (stopped || !info.canPlay || info.team) return;
      for (const kind of ["question", "compact"] as const) {
        const { dataUrl, path } = await client.rpc(soundDataV2, { kind });
        if (stopped) return;
        const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
        if (!m) { dirty = true; continue; }
        const mark = `${path}#${dataUrl}`;
        if (sent.get(kind) === mark) continue;
        const ok = w.PaseoShell?.setAlertSound?.(kind, m[2], m[1]);
        if (ok) sent.set(kind, mark);
        else dirty = true;
        log(`alert sound ${kind}: ${ok ? "handed to the phone app" : "refused by the phone app"} (${Math.round(m[2].length * 0.75 / 1024)}KB)`);
      }
      completed = true;
    } catch (error) {
      dirty = true;
      log(`alert sound: ${String(error)}`);
    } finally {
      busy = false;
      if (completed && revision !== observed && !stopped) void sync();
    }
  };
  const offSettings = watchPluginSettings(client, () => { revision++; dirty = true; void sync(); }, log);
  const offVisible = onVisible(() => void sync());
  void sync();
  return () => { stopped = true; offSettings(); offVisible(); };
}

/** 알림을 누르면 그 대화로 — 화면 담당 하나만 단다. 프로젝트 관리 화면이 대화 번호를 받아 Paseo 대화 열기를 부른다(projectsScreen.tsx) */
export function startPushOpen(client: PluginClientContext, log: (message: string) => void): () => void {
  const w = win();
  if (!w) return () => {};
  const onOpen = (event: ShellEvent) => {
    const detail = event.detail as { serverId?: unknown; agentId?: unknown } | undefined;
    if (typeof detail?.serverId !== "string" || typeof detail.agentId !== "string" || !detail.serverId || !detail.agentId) return;
    event.preventDefault();
    client.openScreen({ screenId: PROJECTS_SCREEN_ID, params: { serverId: detail.serverId, agentId: detail.agentId, n: String(Date.now()) } });
    log(`push open: ${detail.agentId.slice(0, 8)}`);
  };
  w.addEventListener("paseoshell:open", onOpen);
  return () => w.removeEventListener("paseoshell:open", onOpen);
}
