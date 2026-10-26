import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

// 같이 보기 — 화면 쪽 도우미(10-25). 팀원 화면은 리규형님 데몬이 아니라 웹 게이트(같은 출처)에 자기 로그인 쿠키로 묻는다.
// 전용 머리말 X-Paseo-Share: 1 이 있어야 게이트가 받는다(다른 사이트의 단순 요청으로는 못 붙임). PC 앱(파일 주소)에선 쓸 수 없다.

// owner = 올린 사람 아이디(게이트가 열쇠 주인으로 정함) · forMe = 내가 공유 대상인가(관리자는 대상이 아닌 공유도 미리 본다) — 10-25 팀원도 공유
export type ShareBrief = { id: string; title: string; updatedAt: number; rev: number; running: boolean; count: number; ownerName?: string; owner?: string | null; forMe?: boolean };
export type ShareItem = { role: "user" | "assistant"; text: string; at: string | null };
export type ShareFull = ShareBrief & { truncated: boolean; items: ShareItem[]; pendingReplies: { id: string; text: string; at: string; files?: { name: string; size: number }[] }[] };
/** 답글 첨부(10-25) — data 는 base64 */
export type ShareOutFile = { name: string; mimeType: string; data: string };

/** 이 화면이 웹 게이트 주소에서 열렸는가 */
export function shareGateReachable(): boolean {
  const protocol = (globalThis as { location?: { protocol?: string } }).location?.protocol ?? "";
  return Platform.OS === "web" && /^https?:$/.test(protocol);
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "X-Paseo-Share": "1", ...(init.headers ?? {}) } });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

export const listShares = () => call("/__gate/share/list");
/** rev 를 주면 바뀔 때까지(최대 waitMs) 게이트가 기다렸다 답한다 */
export const getShare = (id: string, rev: number | null, waitMs = 15_000) =>
  call(`/__gate/share/get?id=${encodeURIComponent(id)}${rev === null ? "" : `&rev=${rev}&waitMs=${waitMs}`}`);
export const sendShareReply = (id: string, text: string, files: ShareOutFile[] = []) =>
  call("/__gate/share/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, text, files }) });

/** 게이트 거절 번호 → 화면 문구 */
export function shareErrorText(status: number): string {
  if (status === 401) return "웹 로그인이 필요합니다";
  if (status === 423) return "화면이 잠겨 있습니다 — 잠금을 풀면 다시 보입니다";
  if (status === 404) return "볼 수 없는 공유입니다";
  if (status === 403) return "이 공유의 대상이 아니라 답글을 쓸 수 없습니다";
  if (status === 429) return "아직 확인 안 된 답글이 너무 많습니다 — 확인된 뒤 다시 보내 주세요";
  if (status === 413) return "첨부가 너무 큽니다 — 파일 하나 10MB, 모두 20MB 까지입니다";
  if (status === 415) return "이미지·PDF·PPT·워드·엑셀·한글 파일만 보낼 수 있습니다";
  return `게이트 응답 ${status}`;
}

// 답글 줄의 단추는 그 대화가 도는 기기의 플러그인에 물어야 한다 — 기기(서버 번호)마다 자기 연결을 맡겨 둔다
type Hub = { clients: Map<string, Pick<PluginClientContext, "rpc">> };
const hub = (): Hub => {
  const g = globalThis as { __claudeStateBar_shareClients_v1?: Hub };
  return (g.__claudeStateBar_shareClients_v1 ??= { clients: new Map() });
};
export function registerShareClient(serverId: string, client: Pick<PluginClientContext, "rpc">): () => void {
  hub().clients.set(serverId, client);
  return () => {
    if (hub().clients.get(serverId) === client) hub().clients.delete(serverId);
  };
}
export function shareClientFor(serverId: string | undefined): Pick<PluginClientContext, "rpc"> | null {
  return (serverId && hub().clients.get(serverId)) || null;
}
