// 감독자 폰 알림(10-16 리규형님 결정 — 할 일 남은 멈춤·사람 대기·완료 주장·판별 불가).
// claude-state-bar 의 폰 푸시(server/push.ts)가 만든 발송 키·폰 토큰 파일을 읽기만 한다 — 토큰 정리(404)는 그쪽 몫.
// 🔴 폰 앱과 맞춘 메시지 모양을 바꾸지 않는다(peer_mail 01c8f1ba·d5e4d1d0): data 만 · 값은 전부 문자열 · kind = question | resolved ·
//    eventId 는 불투명 · path = /h/<serverId>/workspace/<workspaceId>. 감독자 알림은 새 종류를 만들지 않고 question 으로 보낸다(제목으로 구분).
// 🔴 비밀 열쇠 파일 값은 기록·출력하지 않는다.
// 10-18 FCM 한 곳 관리: 발송 경로·직발송·중앙 계약은 state-bar 와 같은 pushCore.mjs(정본 claude-state-bar/server/pushCore.mjs 의 손 복사 사본).
//   legacy(파일 없음) = 지금처럼 직발송 · central = 게이트에 올림(PC 소리와 다투지 않는 알림이라 fallback "none" — 로그인된 폰이 받았다고 답하면 게이트가 바로 허락)
//   · off = 보내지 않음. 중앙에 못 닿아도 직발송으로 되돌아가지 않는다. 알림을 올릴 때 고른 경로로 그 알림의 지움도 보낸다.
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { FCM_KEY_FILE, PUSH_TOKENS_FILE, createCentralClient, createLegacyFcm, readPushRoute } from "./pushCore.mjs";

export function createPush({ home, log = () => {}, fetchImpl = (...a) => fetch(...a) }) {
  const dir = join(home, "claude-state-bar");
  const tokensFile = join(dir, PUSH_TOKENS_FILE);
  // 기다리는 시간은 claude-state-bar push.ts·콜택시 gateway fcm.js 와 같게(토큰 교환 5초 · 발송 8초) — pushCore.mjs createLegacyFcm
  const fcm = createLegacyFcm({ keyFile: join(dir, FCM_KEY_FILE), fetchImpl });
  let serverId = null, seq = 0;
  const open = new Map(); // "agentId#칸" → 떠 있는 알림 하나(칸마다 하나 — state: 멈춤·판별 불가 등, ask: 장부 질문) { key, message, route }
  const chains = new Map(); // agentId → 그 대화의 마지막 발송 — 같은 대화는 차례대로 보낸다
  /** 같은 대화의 올림·지움을 차례대로 — 동시에 보내면 늦게 시작한 지움이 먼저 도착해 알림이 남았다(10-16 19:15 실측) */
  function serial(agentId, fn) {
    const run = (chains.get(agentId) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    chains.set(agentId, settled);
    void settled.then(() => { if (chains.get(agentId) === settled) chains.delete(agentId); });
    return run;
  }

  async function tokens() {
    try {
      const j = JSON.parse(await readFile(tokensFile, "utf8"));
      return Array.isArray(j.tokens) ? j.tokens.map((t) => t?.token).filter((t) => typeof t === "string" && t) : [];
    } catch { return []; }
  }
  async function sendLegacy(message) {
    const r = await fcm.send(message, await tokens());
    if (r.skipped) { log(`push ${message.kind} ${message.eventId}: skipped (${r.skipped})`); return; }
    for (const x of r.results) {
      if (x.error !== null) log(`push ${message.kind} ${message.eventId}: send failed ${x.error}`);
      else if (!x.ok) log(`push ${message.kind} ${message.eventId}: ${x.status}`);
    }
    log(`push ${message.kind} ${message.eventId}: sent ${r.sent}/${r.total}`);
  }
  async function sendCentral(message, central) {
    const client = createCentralClient(central, { fetchImpl });
    try {
      if (message.kind === "resolved") {
        const r = await client.resolve(message.eventId);
        log(`push resolved ${message.eventId}: central ${r.ok ? `cleared ${r.json?.cleared ?? 0}` : r.status}`);
        return;
      }
      const { kind, eventId, ...data } = message;
      const r = await client.raise(eventId, "question", "none", data);
      log(`push ${kind} ${eventId}: central ${r.ok ? `${r.json?.status} ${r.json?.accepted ?? 0}/${r.json?.deliveries ?? 0}${r.json?.reason ? ` (${r.json.reason})` : ""}` : r.status}`);
    } catch (e) {
      log(`push ${message.kind} ${message.eventId}: central unreachable ${e?.name ?? e}`);
    }
  }
  /** route = 알림을 올릴 때 읽은 경로(readPushRoute) */
  async function send(message, route) {
    if (route.mode === "legacy") return sendLegacy(message);
    if (route.mode === "central" && route.central) return sendCentral(message, route.central);
    log(`push ${message.kind} ${message.eventId}: skipped (push off${route.error ? ` — ${route.error}` : ""})`);
  }
  async function where(agent) {
    serverId ??= await readFile(join(home, "server-id"), "utf8").then((t) => t.trim() || null, () => null);
    const workspaceId = agent.workspaceId ?? "";
    return { serverId: serverId ?? "", workspaceId, path: serverId ? (workspaceId ? `/h/${serverId}/workspace/${workspaceId}` : `/h/${serverId}`) : "" };
  }
  return {
    /** agent = { id, workspaceId, cwd, label } — 같은 대화·같은 칸에 떠 있던 알림은 지우고 새로 올린다 */
    raise(agent, key, title, body, slot = "state") {
      return serial(agent.id, async () => {
        const k = `${agent.id}#${slot}`;
        const prev = open.get(k);
        if (prev?.key === key) return;
        if (prev) { open.delete(k); await send({ ...prev.message, kind: "resolved" }, prev.route); }
        const at = await where(agent);
        if (!at.serverId) { log(`push ${key}: no server id, skipped`); return; }
        const name = agent.label || basename(agent.cwd || "") || agent.id.slice(0, 8);
        const message = { kind: "question", eventId: `w:${agent.id}:${Date.now()}-${++seq}`, serverId: at.serverId, workspaceId: at.workspaceId,
          agentId: agent.id, title: `${title} — ${name}`, body: String(body ?? "").slice(0, 300), path: at.path };
        const route = await readPushRoute(dir);
        open.set(k, { key, message, route });
        await send(message, route);
      });
    },
    /** slot 을 안 주면 상태 칸만 — "all" 이면 그 대화의 모든 칸(보관될 때) */
    resolve(agentId, slot = "state") {
      return serial(agentId, async () => {
        for (const s of slot === "all" ? ["state", "ask"] : [slot]) {
          const k = `${agentId}#${s}`;
          const prev = open.get(k);
          if (!prev) continue;
          open.delete(k);
          await send({ ...prev.message, kind: "resolved" }, prev.route);
        }
      });
    },
  };
}
