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
/** 게이트 롱폴 한 번의 최대 = 게이트 waitMaxMs(5초 — 10-18 리규형님이 맡긴 대기 5초). 올림 응답 전의 수신 관측은 이 길이로 묻는다 */
export const WAIT_POLL_MS = 5_000;

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
/** ms 뒤 또는 stop 이 끊길 때 끊기는 신호(중앙 관측 전용 — 관측을 멈추면 진행 중인 롱폴도 바로 끊는다) */
function withinOr(ms, stop) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(0, ms));
  timer.unref?.();
  controller.signal.addEventListener("abort", () => { clearTimeout(timer); stop.removeEventListener("abort", abort); }, { once: true });
  if (stop.aborted) abort();
  else stop.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export function createCentralClient(route, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const call = async (path, body, ms, stop) => {
    const res = await fetchImpl(`${route.url}/__gate/push/origin/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${route.originId}.${route.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: stop ? withinOr(ms, stop) : within(ms),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  };
  return {
    originId: route.originId,
    hello: () => call("hello", {}, COMMIT_TIMEOUT_MS),
    /** data = { serverId, workspaceId, agentId, title, body, path } — 폰 앱과 맞춘 기존 칸 그대로 */
    raise: (eventId, kind, fallback, data, revision = 1) => call("raise", { eventId, kind, fallback, revision, data }, RAISE_TIMEOUT_MS),
    /** waitMs 까지 기다리고 그 시각에 끊는다(창이 끝나면 더 기다리지 않는다). stop(AbortSignal)이 끊기면 그때 끊는다(관측 취소) */
    wait: (eventId, waitMs, stop) => call("wait", { eventId, waitMs }, waitMs, stop),
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
 * 수신 관측(게이트 롱폴)은 올림과 함께 시작한다 — 올림 응답 전에 온 수신 보고도 받고, 창(올림 접수 뒤 windowMs)·확정 규칙은 그대로다.
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
  // 수신 관측 취소 — 판정이 정해지면(finally 포함) 다음 롱폴을 하지 않고 진행 중인 롱폴도 끊는다
  const stop = new AbortController();
  try {
    // 올림과 수신 관측을 함께 시작한다(Codex 261018_164051 F1): 폰은 FCM 발송 HTTP 응답보다 먼저 받아 게이트에 보고할 수 있다.
    // 올림이 끝난 뒤에야 관측하면 발송 응답이 게이트의 붙잡는 한도(holdMs 5초)보다 늦을 때 앱 보고가 origin_timeout 으로 닫힌다.
    // 각 Promise 의 거절은 여기서 소유한다(처리 안 된 거부는 플러그인 프로세스를 죽인다 — 10-18 18:08 PC 사고).
    const flow = { raised: null, windowUntil: null };
    const raiseDone = order(() => client.raise(eventId, kind, "origin", data))
      .then((r) => ({ r, error: null }), (error) => ({ r: null, error }))
      .then((x) => {
        flow.raised = x;
        // 창 = 올림 응답 뒤 windowMs(3초, 새 값 아님). FCM 접수가 있을 때, 그리고 발송 결과가 불확실할 때(FCM 실패 send_failed · 올림 응답
        // 자체를 못 받음)도 연다 — 폰이 실제로 받았는데 실패 응답이 수신 관측보다 먼저 와 PC 로 가던 경합(10-18 리규형님 "발송 실패여도 3초
        // 기다려 폰 수신 확인" · Codex 261018_210725 5-1). 그 대신 발송이 정말 실패한 사건은 PC 소리가 최대 3초 늦다. 발송 꺼짐·받을 기기
        // 없음·인증 오류 같은 명확한 미발송은 여전히 바로 pc
        const accepted = !x.error && x.r.ok && x.r.json?.status === "sent" && x.r.json.accepted > 0;
        const uncertain = Boolean(x.error) || (x.r?.ok && x.r.json?.status === "send_failed");
        if (accepted || uncertain) flow.windowUntil = now() + windowMs;
        return x;
      });
    const watching = watchReceipt({ client, eventId, flow, raiseDone, stop: stop.signal, now });
    let seen = await Promise.race([watching, raiseDone.then(() => null)]);
    if (seen === null) {
      // 올림이 먼저 끝났다: 발송 꺼짐·받을 기기 없음·접수 0 → 바로 pc, 해결 → 끝. 응답을 못 받았거나 FCM 실패면 위에서 창을 열었다 —
      // 창 안에 온 수신 보고를 대조한다(창이 안 열린 오류만 바로 pc)
      const { r, error } = flow.raised;
      if (error && flow.windowUntil === null) { stop.abort(); return await toPc(`central unreachable ${error?.name ?? "error"}`); }
      const st = r?.json?.status;
      if (r?.ok && st === "resolved") return { outcome: "resolved", reason: "resolved" };
      if (flow.windowUntil === null) { stop.abort(); return await toPc(r.ok ? (r.json?.reason ?? st ?? "not_sent") : `http ${r.status}${r.json?.error ? ` ${r.json.error}` : ""}`); }
      log(`${kind} ${eventId}: ${error ? `central raise reply lost (${error?.name ?? "error"}) — checking receipts` : st === "sent" ? `central sent ${r.json.accepted}/${r.json.deliveries}` : `central ${st} — checking receipts`}`);
      // 창이 끝나면 더 기다리지 않고 pc 로 굳힌다 — 올림 중에 시작한 롱폴이 창 끝을 넘겨도 여기서 끊는다
      seen = (await Promise.race([watching, pause(flow.windowUntil - now(), stop.signal).then(() => null)])) ?? { type: "end", reason: "no receipt in window" };
    } else if (!flow.raised) log(`${kind} ${eventId}: central ${seen.type} before the send reply`);
    stop.abort(); // 관측은 여기까지 — 아래는 이 결과 하나로 정한다
    if (seen.type === "resolved") return { outcome: "resolved", reason: "resolved" };
    if (seen.type === "phone") return { outcome: "phone", reason: "already" };
    if (seen.type !== "received") return await toPc(seen.reason ?? "no receipt in window");
    const deliveryId = seen.deliveryId;
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
  } finally {
    stop.abort();
    await disposition.finish(eventId).catch(() => {});
  }
}

/** ms 동안 쉰다 — signal 이 끊기거나 also 가 끝나면 바로 깬다. 거절하지 않는다 */
function pause(ms, signal, also) {
  return new Promise((done) => {
    if (signal.aborted || !(ms > 0)) return done();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    also?.then(finish, finish);
  });
}

/**
 * 게이트 롱폴로 이 사건의 앱 수신 보고를 지켜본다(올림과 함께 시작 — deliverCentral). 거절하지 않는다(오류는 결과로 바꾼다).
 * 결과: { type: "received", deliveryId } · { type: "resolved" } · { type: "phone" }(이미 phone) · { type: "end", reason }(pc 쪽) · null(관측 취소·올림이 접수 없이 끝남).
 * - 올림 중: 사건이 아직 게이트에 없어도(unknown) 롱폴 한 번(최대 WAIT_POLL_MS) 안에서 기다린다. 소식 없이 돌아오거나 끊기면
 *   그 롱폴 길이를 다 채우거나 올림이 끝날 때까지 쉰다 — 촘촘히 다시 묻지 않는다.
 * - 창(올림 접수 뒤 windowMs): 지금 규칙 그대로 — 창 끝까지 묻고, 끊김·응답 오류·unknown·pc 결정이면 끝.
 */
async function watchReceipt({ client, eventId, flow, raiseDone, stop, now }) {
  try {
    for (;;) {
      if (stop.aborted) return null;
      const inWindow = flow.windowUntil !== null;
      if (flow.raised && !inWindow) return null; // 올림이 접수 없이 끝났다 — pc 는 부르는 쪽이 정한다
      const ms = inWindow ? flow.windowUntil - now() : WAIT_POLL_MS;
      if (ms <= 0) return { type: "end", reason: "no receipt in window" };
      const started = now();
      let w = null;
      try { w = await client.wait(eventId, ms, stop); } catch { w = null; }
      if (stop.aborted) return null;
      const state = w?.ok ? w.json?.state : undefined;
      if (state === "resolved") return { type: "resolved" };
      if (state === "decided" && w.json.decision === "phone") return { type: "phone" };
      if (state === "received") return { type: "received", deliveryId: w.json.deliveryId };
      if (state === "decided") return { type: "end", reason: "no receipt in window" }; // pc 로 정해짐
      if (inWindow) {
        // 창 안에서 시작한 롱폴 — 끊김(창 끝 포함)·응답 오류·unknown 이면 기다리지 않고 끝, waiting 이면 창 끝까지 다시
        if (!w || !w.ok || state === "unknown") return { type: "end", reason: "no receipt in window" };
        continue;
      }
      // 올림 중에 시작한 롱폴이 소식 없이 끝남(waiting·unknown·끊김·오류) — 롱폴 길이를 채우거나 올림이 끝날 때까지 쉬고 다시 본다
      await pause(started + WAIT_POLL_MS - now(), stop, raiseDone);
    }
  } catch (e) {
    return { type: "end", reason: `observe failed ${e?.name ?? "error"}` };
  }
}
