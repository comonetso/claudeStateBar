// 감독자 폰 알림(10-16 리규형님 결정 — 할 일 남은 멈춤·사람 대기·완료 주장·판별 불가).
// claude-state-bar 의 폰 푸시(server/push.ts)가 만든 발송 키·폰 토큰 파일을 읽기만 한다 — 토큰 정리(404)는 그쪽 몫.
// 🔴 폰 앱과 맞춘 메시지 모양을 바꾸지 않는다(peer_mail 01c8f1ba·d5e4d1d0): data 만 · 값은 전부 문자열 · kind = question | resolved ·
//    eventId 는 불투명 · path = /h/<serverId>/workspace/<workspaceId>. 감독자 알림은 새 종류를 만들지 않고 question 으로 보낸다(제목으로 구분).
// 🔴 비밀 열쇠 파일 값은 기록·출력하지 않는다.
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
// 기다리는 시간은 claude-state-bar push.ts·콜택시 gateway fcm.js 와 같게(토큰 교환 5초 · 발송 8초)
function within(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

export function createPush({ home, log = () => {}, fetchImpl = (...a) => fetch(...a) }) {
  const dir = join(home, "claude-state-bar");
  const keyFile = join(dir, "fcm-service-account.json");
  const tokensFile = join(dir, "push-tokens.json");
  let access = null, serverId = null, seq = 0;
  const open = new Map(); // "agentId#칸" → 떠 있는 알림 하나(칸마다 하나 — state: 멈춤·판별 불가 등, ask: 장부 질문)
  const chains = new Map(); // agentId → 그 대화의 마지막 발송 — 같은 대화는 차례대로 보낸다
  /** 같은 대화의 올림·지움을 차례대로 — 동시에 보내면 늦게 시작한 지움이 먼저 도착해 알림이 남았다(10-16 19:15 실측) */
  function serial(agentId, fn) {
    const run = (chains.get(agentId) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    chains.set(agentId, settled);
    void settled.then(() => { if (chains.get(agentId) === settled) chains.delete(agentId); });
    return run;
  }

  async function readKey() {
    try {
      const j = JSON.parse(await readFile(keyFile, "utf8"));
      return j.client_email && j.private_key && j.project_id ? j : null;
    } catch { return null; }
  }
  async function tokens() {
    try {
      const j = JSON.parse(await readFile(tokensFile, "utf8"));
      return Array.isArray(j.tokens) ? j.tokens.map((t) => t?.token).filter((t) => typeof t === "string" && t) : [];
    } catch { return []; }
  }
  async function bearer(key) {
    const now = Math.floor(Date.now() / 1000);
    if (access && access.email === key.client_email && access.until - 60 > now) return access.token;
    const aud = key.token_uri || "https://oauth2.googleapis.com/token";
    const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;
    const res = await fetchImpl(aud, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(), signal: within(5000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) throw new Error(`oauth ${res.status}`);
    access = { email: key.client_email, token: body.access_token, until: now + (body.expires_in ?? 3600) };
    return body.access_token;
  }
  async function send(message) {
    const key = await readKey();
    const list = await tokens();
    if (!key || !list.length) { log(`push ${message.kind} ${message.eventId}: skipped (${key ? "no phone token" : "no key"})`); return; }
    const auth = await bearer(key);
    let sent = 0;
    for (const token of list) {
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`, {
        method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, data: { ...message }, android: { priority: "HIGH" } } }), signal: within(8000),
      }).catch((e) => { log(`push ${message.kind} ${message.eventId}: send failed ${e?.message ?? e}`); return null; });
      if (res?.ok) sent++;
      else if (res) log(`push ${message.kind} ${message.eventId}: ${res.status}`);
    }
    log(`push ${message.kind} ${message.eventId}: sent ${sent}/${list.length}`);
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
        if (prev) { open.delete(k); await send({ ...prev.message, kind: "resolved" }); }
        const at = await where(agent);
        if (!at.serverId) { log(`push ${key}: no server id, skipped`); return; }
        const name = agent.label || basename(agent.cwd || "") || agent.id.slice(0, 8);
        const message = { kind: "question", eventId: `w:${agent.id}:${Date.now()}-${++seq}`, serverId: at.serverId, workspaceId: at.workspaceId,
          agentId: agent.id, title: `${title} — ${name}`, body: String(body ?? "").slice(0, 300), path: at.path };
        open.set(k, { key, message });
        await send(message);
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
          await send({ ...prev.message, kind: "resolved" });
        }
      });
    },
  };
}
