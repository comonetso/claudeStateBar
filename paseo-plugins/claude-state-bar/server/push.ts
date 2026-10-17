import { createSign } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { isCheckpointReport } from "./chime/lastTurn";
import { hostIdentity } from "./layoutSync";
import { isTeamDaemon } from "./sound";

type PaseoApi = PluginHookContext["paseo"];

// 폰 푸시(10-15 리규형님 — "실제로 액션을 해야 하는 것들 위주로": 질문지·압축 준비만, 모든 대화. 소리는 그대로).
// 폰 감싸기 앱과 맞춘 약속(peer_mail 01c8f1ba·d5e4d1d0): data 만 · 값은 전부 문자열 · kind = question | compact | resolved ·
// eventId 는 불투명하고 resolved 는 같은 값 · path = /h/<serverId>/workspace/<workspaceId>. 바꾸면 폰 앱과 어긋난다.
// Paseo 내장 푸시는 Expo 토큰 전용이라 못 쓴다 — 회사(yeogiaen) Firebase 로 FCM HTTP v1 을 직접 부른다.
// 데몬마다 자기 대화의 일만 보낸다. 직원 데몬은 보내지 않는다. 발송 키 파일이 없는 기기는 조용히 안 보낸다.

const DIR = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar");
// 🔴 비밀 열쇠 파일 — 값을 기록·출력하지 않는다. 기기마다 서버끼리 scp 로 옮겨 둔다(10-15 리규형님 "기존 회사 키 쓰기")
const KEY_FILE = join(DIR, "fcm-service-account.json");
const TOKENS_FILE = join(DIR, "push-tokens.json");
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

type Key = { client_email: string; private_key: string; project_id: string; token_uri?: string };
type Message = {
  kind: "question" | "compact" | "resolved";
  eventId: string;
  serverId: string;
  workspaceId: string;
  agentId: string;
  title: string;
  body: string;
  path: string;
};
type TokenEntry = { token: string; at: number };

const log = (message: string) => console.log(`[push] ${message}`);

// 기다리는 시간은 콜택시 gateway/src/services/fcm.js 와 같게(토큰 교환 5초 · 발송 8초)
function within(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}

async function readKey(): Promise<Key | null> {
  try {
    const j = JSON.parse(await readFile(KEY_FILE, "utf8")) as Partial<Key>;
    return j.client_email && j.private_key && j.project_id ? (j as Key) : null;
  } catch {
    return null;
  }
}

let access: { email: string; token: string; until: number } | null = null;

async function accessToken(key: Key): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (access && access.email === key.client_email && access.until - 60 > now) return access.token;
  const aud = key.token_uri || "https://oauth2.googleapis.com/token";
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;
  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: within(5000),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!res.ok || !body?.access_token) throw new Error(`oauth ${res.status}`);
  access = { email: key.client_email, token: body.access_token, until: now + (body.expires_in ?? 3600) };
  return body.access_token;
}

let tokens: TokenEntry[] | null = null;
let writing: Promise<void> = Promise.resolve();

async function loadTokens(): Promise<TokenEntry[]> {
  if (tokens) return tokens;
  try {
    const j = JSON.parse(await readFile(TOKENS_FILE, "utf8")) as { tokens?: TokenEntry[] };
    tokens = Array.isArray(j.tokens) ? j.tokens.filter((t) => typeof t?.token === "string" && t.token) : [];
  } catch {
    tokens = [];
  }
  return tokens;
}

function saveTokens(list: TokenEntry[]): Promise<void> {
  tokens = list;
  writing = writing.then(async () => {
    await mkdir(DIR, { recursive: true });
    const tmp = `${TOKENS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ tokens: list }, null, 2), { mode: 0o600 });
    await rename(tmp, TOKENS_FILE);
  }).catch((error: unknown) => log(`token save failed: ${String(error)}`));
  return writing;
}

export async function registerPushToken(token: string): Promise<{ ok: boolean; enabled: boolean }> {
  if (isTeamDaemon()) return { ok: true, enabled: false };
  const enabled = !!(await readKey());
  const list = await loadTokens();
  const hit = list.find((t) => t.token === token);
  if (hit) hit.at = Date.now();
  await saveTokens(hit ? [...list] : [...list, { token, at: Date.now() }]);
  if (!hit) log(`token registered (${list.length + (hit ? 0 : 1)} on this host, sending ${enabled ? "on" : "off — no key"})`);
  return { ok: true, enabled };
}

/** 보낸 폰 수(Google 이 받은 수). 키·토큰이 없으면 0 */
async function send(message: Message): Promise<number> {
  const key = await readKey();
  const list = await loadTokens();
  if (!key || !list.length) return 0;
  const bearer = await accessToken(key);
  const data: Record<string, string> = { ...message };
  const gone: string[] = [];
  let sent = 0;
  for (const { token } of list) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      // 콜택시 gateway/src/services/fcm.js 와 같은 모양(data 만 + 높은 우선순위)
      body: JSON.stringify({ message: { token, data, android: { priority: "HIGH" } } }),
      signal: within(8000),
    }).catch((error: unknown) => {
      log(`${message.kind} ${message.eventId}: send failed ${String(error)}`);
      return null;
    });
    if (!res) continue;
    if (res.ok) {
      sent++;
      continue;
    }
    const body = (await res.json().catch(() => null)) as { error?: { status?: string; details?: { errorCode?: string }[] } } | null;
    const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode ?? body?.error?.status ?? "";
    // 앱을 지웠거나 토큰이 바뀐 폰 — 목록에서 뺀다. 다른 실패(형식·권한)는 남겨 두고 기록만
    if (res.status === 404 || code === "UNREGISTERED") gone.push(token);
    log(`${message.kind} ${message.eventId}: ${res.status} ${code}`);
  }
  if (gone.length) await saveTokens((await loadTokens()).filter((t) => !gone.includes(t.token)));
  log(`${message.kind} ${message.eventId}: sent ${sent}/${list.length}${gone.length ? `, dropped ${gone.length}` : ""}`);
  return sent;
}

// ── 폰이 받았다(10-17 리규형님 — "FCM 으로 보냈으면 원래 자리에서 소리 내지 않기 · 전송이 실패한 경우만 원래 자리에서") ──
// 성공 기준 = 폰 앱이 "받았다"고 답한 것(버튼 답 — Google 이 받기만 한 건 아님). 앱은 알림을 받는 즉시 웹 화면에 paseoshell:push-received 를
// 보내고(폰 앱 대화와 peer_mail 91f222d6 으로 맞춤), 화면 플러그인이 이 데몬에 push.received 로 알린다(ackPush).
// PC 소리는 재생 직전 확인(soundEvents validate)에서 phoneTook 으로 묻는다 — 보낸 뒤 PHONE_ACK_WAIT_MS 안에 답이 오면 PC 는 울리지 않는다.
// 앱이 꺼져 있다가 깨어난 경우는 웹 화면이 없어 답을 못 보낸다 → PC 도 울린다(폰 앱 대화 설명, 리규형님이 고른 "받았다고 답해야 성공")
/** 폰 답을 기다리는 시간(리규형님 10-17 버튼 "3초" — 10-16 실기에서 폰 도착은 1초 안쪽이었다) */
export const PHONE_ACK_WAIT_MS = 3000;
type Receipt = { agentId: string; kind: "question" | "compact"; sending: Promise<number>; sent: number | null; sentAt: number; ackedAt: number | null; waiters: Set<() => void> };
const receipts = new Map<string, Receipt>();
// 기록은 알림마다 하나 — 오래된 것부터 버린다(소리 확인은 알림 뒤 몇 초 안에 끝난다)
const RECEIPTS_KEEP = 200;

/** 보낸 알림 기록(시험도 이것으로 넣는다 — docs tests-261017/push_receipt_test.mjs) */
export function trackReceipt(message: Message, sending: Promise<number>): void {
  if (message.kind === "resolved") return;
  const r: Receipt = { agentId: message.agentId, kind: message.kind, sending, sent: null, sentAt: 0, ackedAt: null, waiters: new Set() };
  receipts.set(message.eventId, r);
  while (receipts.size > RECEIPTS_KEEP) receipts.delete(receipts.keys().next().value!);
  void sending.then((n) => { r.sent = n; r.sentAt = Date.now(); }, () => { r.sent = 0; r.sentAt = Date.now(); });
}

/** 화면 플러그인이 전한 폰 앱의 "받았다"(push.received). 이 데몬이 보낸 알림이 아니면 무시 */
export function ackPush(eventId: string, receivedAt?: number): { ok: boolean } {
  const r = receipts.get(eventId);
  if (!r) return { ok: false };
  if (r.ackedAt === null) {
    r.ackedAt = Date.now();
    log(`${r.kind} ${eventId}: phone received${r.sentAt ? ` ${r.ackedAt - r.sentAt}ms after send` : ""}${receivedAt ? ` (phone clock ${receivedAt})` : ""}`);
    for (const wake of [...r.waiters]) wake();
  }
  return { ok: true };
}

/** 이 소리의 폰 알림을 폰이 받았는가 — 보내는 중이면 끝날 때까지, 보냈으면 PHONE_ACK_WAIT_MS 까지 기다린다. 안 보냈거나 못 보냈으면 바로 false */
export async function phoneTook(agentId: string, kind: "question" | "compact", nativeId: string): Promise<boolean> {
  let r: Receipt | undefined;
  if (kind === "question") r = receipts.get(`q:${agentId}:${nativeId}`);
  else {
    // 압축 준비 소리의 번호는 [마지막 사람 말 시각, 차례 번호] — 차례 번호가 같은 알림을 먼저, 없으면 그 대화의 마지막 압축 준비 알림
    let turnId: unknown = null;
    try { turnId = (JSON.parse(nativeId) as unknown[])[1]; } catch { /* 형식이 다르면 대화로만 찾는다 */ }
    r = typeof turnId === "string" ? receipts.get(`c:${agentId}:${turnId}`) : undefined;
    if (!r) for (const x of receipts.values()) if (x.agentId === agentId && x.kind === "compact") r = x;
  }
  if (!r) return false;
  if (r.ackedAt !== null) return true;
  const sent = await r.sending.catch(() => 0);
  if (!sent) return false;
  if (r.ackedAt !== null) return true;
  const left = r.sentAt + PHONE_ACK_WAIT_MS - Date.now();
  if (left > 0) {
    await new Promise<void>((done) => {
      const finish = () => { clearTimeout(timer); r!.waiters.delete(finish); done(); };
      const timer = setTimeout(finish, left);
      r!.waiters.add(finish);
    });
  }
  return r.ackedAt !== null;
}

/** 질문 글 — AskUserQuestion 이면 첫 질문, 여럿이면 개수를 붙인다 */
export function questionText(request: PluginLifecycleEvents["agent.permission_requested"]["request"]): string {
  if (request.kind === "plan") return "계획 승인을 기다립니다";
  const questions = (request.input as { questions?: { question?: unknown }[] } | undefined)?.questions;
  const first = Array.isArray(questions) && typeof questions[0]?.question === "string" ? questions[0].question : "";
  const text = first ? first + (questions!.length > 1 ? ` (질문 ${questions!.length}개)` : "") : request.title || request.description || "질문에 답해 주세요";
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** 턴이 압축 명령어 줄이 든 답으로 끝났는지 — 마지막 답 글 뒤에 도구를 불렀으면 아니다(lastTurn.ts turnEndsWithCheckpoint 와 같은 뜻) */
export function endsWithCheckpoint(timeline: PluginLifecycleEvents["agent.turn_ended"]["timeline"]): boolean {
  const parts: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") {
      parts.unshift(item.text);
      continue;
    }
    if (parts.length) break;
    if (item.type === "reasoning" || item.type === "todo" || item.type === "notification") continue;
    return false;
  }
  // 답이 조각으로 쌓였으면 이어 붙여야 줄 맨 앞이 보이고, 따로 쌓인 답이면 하나씩 봐야 한다
  return parts.length > 0 && (isCheckpointReport(parts.join("")) || parts.some((p) => isCheckpointReport(p)));
}

type Agent = PluginLifecycleEvents["agent.turn_started"]["agent"];

// 프로젝트 목록 압축 준비 아이콘의 기다림 요청 — 다른 기다림 요청(claudeLogin.ts·account.ts)과 같은 25초
const WAIT_MS = 25_000;

type Ref = { eventId: string; agentId: string; kind: "question" | "compact" };

export function createPush() {
  const open = new Map<string, Message>();
  // 올리는 중(작업 공간 이름을 읽는 사이) — 그사이 지워지면 보내지 않는다
  const raising = new Map<string, Ref>();
  let serverId: Promise<string | null> | null = null;
  let rev = 0;
  const waiters = new Set<() => void>();
  const changed = () => {
    rev++;
    for (const wake of [...waiters]) wake();
  };

  const where = async (agent: Agent, paseo: PaseoApi) => {
    const id = await (serverId ??= hostIdentity().then((h) => h.serverId, () => null));
    if (!id) return null;
    let name = "";
    if (agent.workspaceId) {
      try {
        const handle = paseo.workspaces.ref(agent.workspaceId);
        await handle.refresh();
        name = handle.name ?? "";
      } catch {
        // 이름은 보기 좋으라고 붙인다 — 못 읽으면 폴더 이름
      }
    }
    const workspaceId = agent.workspaceId ?? "";
    return { serverId: id, workspaceId, agentId: agent.id, name: name || basename(agent.cwd) || agent.cwd, path: workspaceId ? `/h/${id}/workspace/${workspaceId}` : `/h/${id}` };
  };

  const post = (message: Message) => {
    const sending = send(message).catch((error: unknown) => {
      log(`${message.kind} ${message.eventId}: ${String(error)}`);
      return 0;
    });
    trackReceipt(message, sending);
  };

  const resolve = (match: (m: Ref) => boolean) => {
    let compact = false;
    for (const [eventId, ref] of [...raising]) if (match(ref)) raising.delete(eventId);
    for (const [eventId, m] of [...open]) {
      if (m.kind === "resolved" || !match({ eventId, agentId: m.agentId, kind: m.kind })) continue;
      open.delete(eventId);
      if (m.kind === "compact") compact = true;
      post({ ...m, kind: "resolved" });
    }
    if (compact) changed();
  };

  const raise = async (kind: "question" | "compact", eventId: string, agent: Agent, paseo: PaseoApi, title: string, body: string) => {
    if (open.has(eventId) || raising.has(eventId)) return;
    raising.set(eventId, { eventId, agentId: agent.id, kind });
    const at = await where(agent, paseo);
    // 이름을 읽는 사이 답·취소로 닫혔으면 보내지 않는다(보내자마자 지우는 헛알림을 막는다) — 확인할 수 있게 기록만
    if (!raising.delete(eventId)) return log(`${kind} ${eventId}: closed before sending, skipped`);
    if (!at) return log(`${kind} ${eventId}: no server id, skipped`);
    const message: Message = { kind, eventId, serverId: at.serverId, workspaceId: at.workspaceId, agentId: at.agentId, title: `${title} — ${at.name}`, body, path: at.path };
    open.set(eventId, message);
    if (kind === "compact") changed();
    post(message);
  };

  const snapshot = () => ({ rev, agentIds: [...new Set([...open.values()].filter((m) => m.kind === "compact").map((m) => m.agentId))] });

  return {
    onPermissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"], { paseo }: { paseo: PaseoApi }) {
      if (request.kind !== "question" && request.kind !== "plan") return;
      return raise("question", `q:${agent.id}:${request.id}`, agent, paseo, "질문", questionText(request));
    },
    // 답했을 때(버튼·말 모두) · 취소·새 말로 정리됐을 때 데몬이 낸다(agent-manager resolvePendingPermissionsForAgent)
    onPermissionResolved({ agent, requestId }: PluginLifecycleEvents["agent.permission_resolved"]) {
      resolve((m) => m.eventId === `q:${agent.id}:${requestId}`);
    },
    // 다음 턴이 시작되면(압축 명령 포함) 그 대화의 압축 준비는 처리된 것이다. 질문은 이 턴 안에서만 생기므로 함께 지운다
    onTurnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"]) {
      resolve((m) => m.agentId === agent.id);
    },
    onTurnEnded({ agent, turnId, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], { paseo }: { paseo: PaseoApi }) {
      resolve((m) => m.agentId === agent.id);
      if (outcome.kind !== "completed" || !endsWithCheckpoint(timeline)) return;
      return raise("compact", `c:${agent.id}:${turnId ?? Date.now()}`, agent, paseo, "압축 준비", "체크포인트 저장 끝 — 압축 명령어를 복사해 넣으세요");
    },
    onArchived({ agent }: PluginLifecycleEvents["agent.archived"]) {
      resolve((m) => m.agentId === agent.id);
    },
    /** 압축 준비가 떠 있는 대화(프로젝트 목록 아이콘) — 바뀌거나 25초가 지나면 답한다 */
    async waitCompact(known: number | null): Promise<{ rev: number; agentIds: string[] }> {
      if (known !== rev) return snapshot();
      await new Promise<void>((done) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          done();
        };
        const timer = setTimeout(wake, WAIT_MS);
        waiters.add(wake);
      });
      return snapshot();
    },
  };
}
