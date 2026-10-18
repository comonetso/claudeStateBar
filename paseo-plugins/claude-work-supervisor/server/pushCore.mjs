// 폰 푸시 공용 핵심(10-18 FCM 한 곳 관리 — Codex docs/codex_rescue/261018_052815 D절 · 약속 문서 docs/paseo-plugin-tools/PUSH_CENTRAL_PROTOCOL.md).
// 🔴 정본은 claude-state-bar/server/pushCore.mjs. claude-work-supervisor/server/pushCore.mjs 는 손 복사 사본이다(Paseo 컴파일러가 플러그인 폴더 밖
//    import 를 막는다) — 정본만 고치고 cp 로 사본을 맞춘다. state-bar push.ts 와 감독자 push.mjs 가 같은 발송 경로·같은 중앙 계약을 쓰게 한 곳에 둔다.
// 🔴 공개 코드에 중앙 주소(도메인)를 넣지 않는다 — 기기 설정 파일 <Paseo 홈>/claude-state-bar/push-central.json 에만 둔다.
// 🔴 비밀(FCM 열쇠·데몬 인증 비밀·폰 토큰)은 기록·출력하지 않는다.
//
// 발송 경로(기기마다 하나, 파일을 고치면 다음 알림부터 — 데몬 재시작 없음):
//   legacy  = 지금처럼 이 데몬이 FCM 을 직접 부른다(파일이 없을 때의 기본).
//   central = 콜어드민 게이트(lib/push.mjs)에 사건을 올린다. 열쇠·토큰은 게이트만 갖고, 폰은 게이트 허락(playAllowed) 뒤에만 울린다.
//             중앙에 못 닿으면 legacy 로 되돌아가지 않는다 — PC 소리만(Codex D-6 3).
//   off     = 폰 푸시를 보내지 않는다(PC 소리만). 파일이 있는데 못 읽거나 틀려도 off 로 본다.
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PUSH_ROUTE_FILE = "push-central.json";
export const FCM_KEY_FILE = "fcm-service-account.json";
export const PUSH_TOKENS_FILE = "push-tokens.json";

/** 폰 답을 기다리는 시간 — FCM 접수 뒤 3초(리규형님 10-17 버튼 "3초", 10-16 실기에서 폰 도착은 1초 안쪽) */
export const PHONE_ACK_WAIT_MS = 3000;
/** 중앙 올림 요청 한도 = 게이트의 토큰 교환 5초 + 발송 8초(플러그인·콜택시 fcm.js 와 같은 값) + 왕복 여유 2초(구현 세부) */
export const RAISE_TIMEOUT_MS = 15_000;
/** phone 확정 요청 한도 = 게이트가 앱 수신 보고를 붙잡는 최대 5초(게이트 holdMs)와 같다 — 그 뒤에는 게이트가 이미 거절했다 */
export const COMMIT_TIMEOUT_MS = 5_000;
/**
 * PC 소리 확인이 진행 중인 중앙 판정을 기다리는 최대 — 위 세 한도의 합. 넘으면 pc 로 굳힌다(늦은 폰 허락은 거절된다).
 * 소리 확인 RPC 안에서는 state-bar soundEvents.ts SOUND_VALIDATE_WAIT_MS(요청을 받은 때부터 15초)로 더 줄인다 — 데몬 플러그인 요청 한도가 30초라서(10-18 2차)
 */
export const PC_WAIT_CAP_MS = RAISE_TIMEOUT_MS + PHONE_ACK_WAIT_MS + COMMIT_TIMEOUT_MS;

const ORIGIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** ms 뒤 끊기는 신호(타이머가 프로세스를 붙잡지 않게) */
export function within(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Math.max(0, ms)).unref?.();
  return controller.signal;
}

/** 중앙 주소 — https 만(시험용 loopback http 는 허용). 뒤 / 는 뗀다 */
function centralUrl(text) {
  if (typeof text !== "string") return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/**
 * 이 기기의 발송 경로를 읽는다. dir = <Paseo 홈>/claude-state-bar.
 * @returns {Promise<{ mode: "legacy" | "central" | "off", central: { url: string, originId: string, secret: string } | null, error: string | null }>}
 */
export async function readPushRoute(dir) {
  let text;
  try {
    text = await readFile(join(dir, PUSH_ROUTE_FILE), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { mode: "legacy", central: null, error: null };
    return { mode: "off", central: null, error: `read ${err?.code ?? "failed"}` };
  }
  let j;
  try { j = JSON.parse(text); } catch { return { mode: "off", central: null, error: "bad json" }; }
  const mode = j?.mode;
  if (mode !== "legacy" && mode !== "central" && mode !== "off") return { mode: "off", central: null, error: "bad mode" };
  const c = j.central;
  const url = centralUrl(c?.url);
  const central = c && url && ORIGIN_ID.test(String(c.originId ?? "")) && SECRET.test(String(c.secret ?? "")) ? { url, originId: c.originId, secret: c.secret } : null;
  if (mode === "central" && !central) return { mode: "off", central: null, error: "bad central" };
  return { mode, central, error: null };
}

// ── legacy: 이 데몬이 FCM 을 직접 부른다(지금 동작 그대로 — state-bar 와 감독자가 같은 코드를 쓴다) ──
export function createLegacyFcm({ keyFile, fetchImpl = (...a) => fetch(...a) }) {
  let access = null;
  async function readKey() {
    try {
      const j = JSON.parse(await readFile(keyFile, "utf8"));
      return j.client_email && j.private_key && j.project_id ? j : null;
    } catch {
      return null;
    }
  }
  // 기다리는 시간은 콜택시 gateway/src/services/fcm.js 와 같게(토큰 교환 5초 · 발송 8초)
  async function bearer(key) {
    const now = Math.floor(Date.now() / 1000);
    if (access && access.email === key.client_email && access.until - 60 > now) return access.token;
    const aud = key.token_uri || "https://oauth2.googleapis.com/token";
    const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;
    const res = await fetchImpl(aud, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: within(5000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) throw new Error(`oauth ${res.status}`);
    access = { email: key.client_email, token: body.access_token, until: now + (body.expires_in ?? 3600) };
    return body.access_token;
  }
  return {
    readKey,
    /**
     * 폰마다 차례로 보낸다(지금과 같은 모양 — data 만 + 높은 우선순위). 열쇠·토큰이 없으면 보내지 않는다.
     * @returns {Promise<{ sent: number, total: number, skipped: string | null, gone: string[], results: { token: string, ok: boolean, status: number, code: string, error: string | null }[] }>}
     *   gone = 404 또는 UNREGISTERED(앱을 지웠거나 토큰이 바뀐 폰 — 지울지는 부르는 쪽이 정한다)
     */
    async send(message, tokens) {
      const key = await readKey();
      if (!key || !tokens.length) return { sent: 0, total: tokens.length, skipped: key ? "no phone token" : "no key", gone: [], results: [] };
      const auth = await bearer(key);
      const data = { ...message };
      const results = [];
      for (const token of tokens) {
        let res = null;
        let error = null;
        try {
          res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`, {
            method: "POST",
            headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: { token, data, android: { priority: "HIGH" } } }),
            signal: within(8000),
          });
        } catch (e) {
          error = String(e?.message ?? e);
        }
        if (!res) { results.push({ token, ok: false, status: 0, code: "", error }); continue; }
        if (res.ok) { results.push({ token, ok: true, status: res.status, code: "", error: null }); continue; }
        const body = await res.json().catch(() => null);
        const code = body?.error?.details?.find((d) => d?.errorCode)?.errorCode ?? body?.error?.status ?? "";
        results.push({ token, ok: false, status: res.status, code, error: null });
      }
      const gone = results.filter((r) => r.status === 404 || r.code === "UNREGISTERED").map((r) => r.token);
      return { sent: results.filter((r) => r.ok).length, total: tokens.length, skipped: null, gone, results };
    },
  };
}

// ── central: 게이트의 발생 데몬 API(/__gate/push/origin/*) ──
export function createCentralClient(route, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const call = async (path, body, ms) => {
    const res = await fetchImpl(`${route.url}/__gate/push/origin/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${route.originId}.${route.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: within(ms),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  };
  return {
    originId: route.originId,
    hello: () => call("hello", {}, COMMIT_TIMEOUT_MS),
    /** data = { serverId, workspaceId, agentId, title, body, path } — 폰 앱과 맞춘 기존 칸 그대로 */
    raise: (eventId, kind, fallback, data, revision = 1) => call("raise", { eventId, kind, fallback, revision, data }, RAISE_TIMEOUT_MS),
    /** waitMs 까지 기다리고 그 시각에 끊는다(창이 끝나면 더 기다리지 않는다) */
    wait: (eventId, waitMs) => call("wait", { eventId, waitMs }, waitMs),
    commit: (eventId, decision, deliveryId) => call("commit", { eventId, decision, ...(deliveryId ? { deliveryId } : {}) }, COMMIT_TIMEOUT_MS),
    resolve: (eventId, revision = 2) => call("resolve", { eventId, revision }, RAISE_TIMEOUT_MS),
  };
}

/** 같은 사건의 올림·해결을 차례대로(게이트에 해결이 올림보다 먼저 닿지 않게 — 게이트도 해결을 끝으로 막는다) */
export function createEventSerial() {
  const chains = new Map();
  return (key, fn) => {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    chains.set(key, settled);
    void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
    return run;
  };
}

/**
 * 발생 데몬 쪽 한 사건의 중앙 발송·판정(PC 소리와 다투는 알림 — 질문지·압축 준비).
 * 불변식: 폰 재생 ⇒ 여기서 phone 을 먼저 내구 저장 · PC 재생 ⇒ pending→pc 전이 성공(disposition = soundEvents.ts createPushDisposition).
 * 부르는 쪽이 disposition.begin(eventId) 를 먼저 했어야 한다. 끝나면 판정은 반드시 phone 또는 pc(또는 해결)다 — 마지막에 finish 가 남은 pending 을 pc 로.
 * @returns {Promise<{ outcome: "phone" | "phone_unconfirmed" | "pc" | "resolved", reason: string | null }>}
 */
export async function deliverCentral({ client, disposition, eventId, kind, data, order = (fn) => fn(), windowMs = PHONE_ACK_WAIT_MS, now = () => Date.now(), log = () => {} }) {
  const toPc = async (reason) => {
    // decidePc = 남은 pending 을 pc 로 굳히고 최종 판정을 돌려준다(이미 pc 면 그대로 pc, phone 이면 phone)
    const decision = await disposition.decidePc(eventId, reason);
    if (decision !== "pc") return { outcome: decision === "phone" ? "phone" : "resolved", reason };
    // 게이트에도 알린다 — 붙잡힌·늦은 수신 보고를 바로 거절하게(실패해도 게이트는 붙잡는 한도 뒤 거절한다)
    await client.commit(eventId, "pc").catch(() => null);
    log(`${kind} ${eventId}: central → PC (${reason})`);
    return { outcome: "pc", reason };
  };
  try {
    let r;
    try {
      r = await order(() => client.raise(eventId, kind, "origin", data));
    } catch (e) {
      return await toPc(`central unreachable ${e?.name ?? "error"}`);
    }
    const st = r.json?.status;
    if (r.ok && st === "resolved") return { outcome: "resolved", reason: "resolved" };
    if (!r.ok || st !== "sent" || !(r.json.accepted > 0)) return await toPc(r.ok ? (r.json?.reason ?? st ?? "not_sent") : `http ${r.status}${r.json?.error ? ` ${r.json.error}` : ""}`);
    log(`${kind} ${eventId}: central sent ${r.json.accepted}/${r.json.deliveries}`);
    // 창 = FCM 접수(올림 응답) 뒤 3초. 창이 끝나면 더 기다리지 않고 pc 로 굳힌다
    const until = now() + windowMs;
    for (;;) {
      const left = until - now();
      if (left <= 0) break;
      let w;
      try { w = await client.wait(eventId, left); }
      catch { break; } // 끊김(창 끝 포함) — 기다리지 않고 pc
      const state = w.json?.state;
      if (state === "resolved") return { outcome: "resolved", reason: "resolved" };
      if (state === "decided" && w.json.decision === "phone") return { outcome: "phone", reason: "already" };
      if (state === "decided" || state === "unknown" || !w.ok) break;
      if (state !== "received") continue;
      const deliveryId = w.json.deliveryId;
      const c = await disposition.commitPhone(eventId, deliveryId);
      if (!c.committed) return await toPc(`origin ${c.state}`);
      let g;
      try { g = await client.commit(eventId, "phone", deliveryId); }
      catch { log(`${kind} ${eventId}: phone committed, gate answer lost — PC stays quiet`); return { outcome: "phone_unconfirmed", reason: "commit_unknown" }; }
      if (g.ok && g.json?.granted === true) { log(`${kind} ${eventId}: phone received — PC stays quiet`); return { outcome: "phone", reason: null }; }
      // 게이트가 이 배달을 허락하지 않았다고 분명히 답했다(200 granted:false, 또는 게이트가 처리 전에 거절한 4xx) — phone 을 거두고 PC 로
      if ((g.ok && g.json?.granted === false) || (g.status >= 400 && g.status < 500)) {
        await disposition.voidPhone(eventId, deliveryId, g.json?.reason ?? `http ${g.status}`);
        return await toPc(`gate refused ${g.json?.reason ?? g.status}`);
      }
      // 5xx 등 — 허락했는지 모른다. phone 을 유지한다(이중 울림보다 무음 쪽, Codex D-2 보장 범위)
      log(`${kind} ${eventId}: phone committed, gate answer ${g.status} — PC stays quiet`);
      return { outcome: "phone_unconfirmed", reason: `commit ${g.status}` };
    }
    return await toPc("no receipt in window");
  } finally {
    await disposition.finish(eventId).catch(() => {});
  }
}
