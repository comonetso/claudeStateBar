import type { PluginClientContext } from "@getpaseo/plugin/client";
import { pushRegister } from "../shared/push";
import { PROJECTS_SCREEN_ID } from "./projectsScreen";

// 폰 감싸기 앱(com.blueming.paseo)과 맞춘 약속(10-15, peer_mail 01c8f1ba·d5e4d1d0) — 바꾸면 폰 앱과 어긋난다.
// 토큰: window.PaseoShell.pushToken()(문자열|null, 막 열렸을 땐 null) + 바뀌거나 늦게 오면 "paseoshell:push-token"(detail.token)
// 알림 누름: "paseoshell:open"(detail {path, serverId, workspaceId, agentId}, cancelable) — 웹이 처리하면 preventDefault(),
// 아무도 안 부르면 앱이 https://paseo.yeogiaen.com + path 로 전체 이동한다
type Shell = { pushToken?: () => string | null };
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
  return () => w.removeEventListener("paseoshell:push-token", onToken);
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
