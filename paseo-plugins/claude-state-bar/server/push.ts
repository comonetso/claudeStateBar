import { renameRetry } from "./renameRetry";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { isCheckpointReport } from "./chime/lastTurn";
import { flipTitle } from "../shared/headerTitles";
import { questionRepeatId } from "../shared/push";
import { labelNameOf } from "./headerTitles";
import { hostIdentity } from "./layoutSync";
import { isTeamDaemon } from "./sound";
import type { PushDisposition, SoundPushLink } from "./soundEvents";
import {
  FCM_KEY_FILE, PC_WAIT_CAP_MS, PHONE_ACK_WAIT_MS, PUSH_TOKENS_FILE,
  createCentralClient, createEventSerial, createLegacyFcm, deliverCentral, readPushRoute,
  type CentralRoute, type PushRoute,
} from "./pushCore.mjs";

type PaseoApi = PluginHookContext["paseo"];

// 폰 푸시(10-15 리규형님 — "실제로 액션을 해야 하는 것들 위주로": 질문지·압축 준비만, 모든 대화. 소리는 그대로).
// 폰 감싸기 앱과 맞춘 약속(peer_mail 01c8f1ba·d5e4d1d0): data 만 · 값은 전부 문자열 · kind = question | compact | resolved ·
// eventId 는 불투명하고 resolved 는 같은 값 · path = /h/<serverId>/workspace/<workspaceId>. 바꾸면 폰 앱과 어긋난다.
// Paseo 내장 푸시는 Expo 토큰 전용이라 못 쓴다 — 회사(yeogiaen) Firebase 로 FCM HTTP v1 을 부른다.
// 데몬마다 자기 대화의 일만 보낸다. 직원 데몬은 보내지 않는다. 발송 키 파일이 없는 기기는 조용히 안 보낸다.
// 10-18 FCM 한 곳 관리: 발송 경로는 기기 설정 파일 push-central.json 이 정한다(pushCore.mjs readPushRoute — 없으면 legacy = 아래 직발송 그대로).
// central 이면 열쇠·토큰을 가진 게이트에 사건을 올리고, 폰은 게이트 허락 뒤에만 울린다. PC 소리와의 판정은 soundEvents.ts createPushDisposition.
// 공용 핵심(직발송·중앙 계약)은 pushCore.mjs 한 곳 — 감독자 push.mjs 도 같은 것(사본)을 쓴다.

const DIR = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar");
// 🔴 비밀 열쇠 파일 — 값을 기록·출력하지 않는다. 기기마다 서버끼리 scp 로 옮겨 둔다(10-15 리규형님 "기존 회사 키 쓰기")
const KEY_FILE = join(DIR, FCM_KEY_FILE);
const TOKENS_FILE = join(DIR, PUSH_TOKENS_FILE);

export { PHONE_ACK_WAIT_MS };
/** 이 기기의 폰 푸시 경로 — <Paseo 홈>/claude-state-bar/push-central.json(없으면 legacy). 알림마다 다시 읽는다(데몬 재시작 없이 바뀐다) */
export function pushRoute(): Promise<PushRoute> {
  return readPushRoute(DIR);
}
/** 답하지 않은 질문을 다시 알리는 간격(10-24 리규형님 버튼 "5분마다, 누를 때까지") — 회차 번호는 shared/push.ts questionRepeatId */
export const QUESTION_REPEAT_MS = 5 * 60_000;
/** 알림 사건 번호 — 소리 확인(soundPushKey)과 같은 식을 쓴다. 다시 알릴 때는 질문 번호에 회차가 붙는다(q:대화:질문:r1) */
export const questionEventId = (agentId: string, requestId: string) => `q:${agentId}:${requestId}`;
export const compactEventId = (agentId: string, turnId: string | null) => `c:${agentId}:${turnId ?? Date.now()}`;
/** 소리(sound-v2)의 번호 → 그 알림의 사건 번호. 압축 준비는 [마지막 사람 말 시각, 차례 번호]의 차례 번호로만(없으면 null — 물러서지 않는다) */
export function soundPushKey(agentId: string, kind: "question" | "compact", nativeId: string): string | null {
  if (kind === "question") return questionEventId(agentId, nativeId);
  let turnId: unknown = null;
  try { turnId = (JSON.parse(nativeId) as unknown[])[1]; } catch { /* 형식이 다르면 잇지 않는다 */ }
  return typeof turnId === "string" && turnId ? compactEventId(agentId, turnId) : null;
}
/** 소리 확인(soundEvents createSoundOrigins)에 넘기는 연결 — 직원 데몬은 중앙 경로가 아니다 */
export function soundPushLink(disposition: PushDisposition): SoundPushLink {
  return {
    disposition,
    central: async () => !isTeamDaemon() && (await pushRoute()).mode === "central",
    keyOf: soundPushKey,
    pcWaitCapMs: PC_WAIT_CAP_MS,
  };
}

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

// 직발송(legacy) — 토큰 교환 5초 · 발송 8초(콜택시 gateway fcm.js 와 같게). 코드는 pushCore.mjs createLegacyFcm 한 곳
const fcm = createLegacyFcm({ keyFile: KEY_FILE });

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
    await renameRetry(tmp, TOKENS_FILE);
  }).catch((error: unknown) => log(`token save failed: ${String(error)}`));
  return writing;
}

export async function registerPushToken(token: string): Promise<{ ok: boolean; enabled: boolean }> {
  if (isTeamDaemon()) return { ok: true, enabled: false };
  const enabled = !!(await fcm.readKey());
  const list = await loadTokens();
  const hit = list.find((t) => t.token === token);
  if (hit) hit.at = Date.now();
  await saveTokens(hit ? [...list] : [...list, { token, at: Date.now() }]);
  if (!hit) log(`token registered (${list.length + (hit ? 0 : 1)} on this host, sending ${enabled ? "on" : "off — no key"})`);
  return { ok: true, enabled };
}

/** 직발송 — 보낸 폰 수(Google 이 받은 수). 키·토큰이 없으면 0 */
async function send(message: Message): Promise<number> {
  const list = await loadTokens();
  // 콜택시 gateway/src/services/fcm.js 와 같은 모양(data 만 + 높은 우선순위) — pushCore.mjs createLegacyFcm
  const r = await fcm.send(message, list.map((t) => t.token));
  if (r.skipped) return 0;
  for (const x of r.results) {
    if (x.error !== null) log(`${message.kind} ${message.eventId}: send failed ${x.error}`);
    else if (!x.ok) log(`${message.kind} ${message.eventId}: ${x.status} ${x.code}`);
  }
  // 앱을 지웠거나 토큰이 바뀐 폰(404·UNREGISTERED) — 목록에서 뺀다. 다른 실패(형식·권한)는 남겨 두고 기록만
  if (r.gone.length) await saveTokens((await loadTokens()).filter((t) => !r.gone.includes(t.token)));
  log(`${message.kind} ${message.eventId}: sent ${r.sent}/${r.total}${r.gone.length ? `, dropped ${r.gone.length}` : ""}`);
  return r.sent;
}

// ── 폰이 받았다(10-17 리규형님 — "FCM 으로 보냈으면 원래 자리에서 소리 내지 않기 · 전송이 실패한 경우만 원래 자리에서") ──
// 성공 기준 = 폰 앱이 "받았다"고 답한 것(버튼 답 — Google 이 받기만 한 건 아님). 앱은 알림을 받는 즉시 웹 화면에 paseoshell:push-received 를
// 보내고(폰 앱 대화와 peer_mail 91f222d6 으로 맞춤), 화면 플러그인이 이 데몬에 push.received 로 알린다(ackPush).
// PC 소리는 재생 직전 확인(soundEvents validate)에서 phoneTook 으로 묻는다 — 보낸 뒤 PHONE_ACK_WAIT_MS 안에 답이 오면 PC 는 울리지 않는다.
// 앱이 꺼져 있다가 깨어난 경우는 웹 화면이 없어 답을 못 보낸다 → PC 도 울린다(폰 앱 대화 설명, 리규형님이 고른 "받았다고 답해야 성공")
// 폰 답을 기다리는 시간 PHONE_ACK_WAIT_MS(3초 — 리규형님 10-17 버튼)는 pushCore.mjs 에 두고 위에서 다시 내보낸다(중앙 경로와 같은 값)
// 이 직발송 받음 기록은 legacy 경로에서만 채워진다 — 중앙 경로의 웹 push.received 는 사건 번호만으로 PC 를 막지 않는다(Codex D-4)
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

/** 질문 글 — AskUserQuestion 이면 첫 질문, 여럿이면 개수를 붙인다.
 *  도구 사용 허락(10-21 리규형님 "Paseo 가 띄우는 허락 창도 질문처럼 알려 달라")은 도구 이름과 사람용 설명만 쓴다 — 명령 원문은
 *  구글 FCM 을 거쳐 폰에 남으므로 비밀 값이 섞일 수 있어 싣지 않는다 */
export function questionText(request: PluginLifecycleEvents["agent.permission_requested"]["request"]): string {
  if (request.kind === "plan") return "계획 승인을 기다립니다";
  if (request.kind !== "question") {
    const name = (request as { name?: unknown }).name;
    const about = (request.input as { description?: unknown } | undefined)?.description;
    const tool = typeof name === "string" && name ? name : request.title || "도구";
    const text = `도구 사용 허락을 기다립니다 — ${tool}${typeof about === "string" && about.trim() ? `: ${about.trim()}` : ""}`;
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }
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

/** disposition = 중앙 경로의 내구 판정(soundEvents.ts createPushDisposition — 소리 확인과 같은 것을 index.server.ts 가 넘긴다) */
export function createPush(options: {
  disposition?: PushDisposition;
  /** 시험용 — 다시 알림 간격·시계 */
  repeatMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
} = {}) {
  const { disposition } = options;
  const repeatMs = options.repeatMs ?? QUESTION_REPEAT_MS;
  // unref — 떠 있는 질문의 다시 알림 예약이 프로세스 종료를 붙잡지 않게(10-24 폰 알림 시험이 이 예약에 묶여 끝나지 않았다)
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const open = new Map<string, Message>();
  // 중앙으로 올린 알림 — 해결도 같은 길로 보낸다(그사이 경로 파일이 바뀌어도)
  const openCentral = new Map<string, CentralRoute>();
  // 같은 사건의 중앙 올림·해결을 차례대로
  const order = createEventSerial();
  // 올리는 중(작업 공간 이름을 읽는 사이) — 그사이 지워지면 보내지 않는다
  const raising = new Map<string, Ref>();
  // 체크포인트 보고로 끝난 대화 — 폰엔 안 보내고 목록 아이콘만 켜 둔다(10-24 리규형님 버튼 "폰 알림 없애고 보통 끝남 소리로")
  const quietCompact = new Set<string>();
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
    // 작업 공간 제목 "카테고리 - 이름"을 "이름 - 카테고리"로 — 폰 알림 제목 끝이 잘려도 프로젝트 이름이 보이게(10-21 리규형님)
    if (name) name = flipTitle(name, await labelNameOf(name).catch(() => null));
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

  // 중앙 경로 — 게이트에 올리고, 창(FCM 접수 뒤 3초) 안에 앱 수신이 증명되면 phone 을 내구 저장한 뒤 게이트가 폰에 허락한다. 아니면 pc
  const postCentral = (message: Message, route: CentralRoute, kind: "question" | "compact") => {
    const data = { serverId: message.serverId, workspaceId: message.workspaceId, agentId: message.agentId, title: message.title, body: message.body, path: message.path };
    void deliverCentral({ client: createCentralClient(route), disposition: disposition!, eventId: message.eventId, kind, data, order: (fn) => order(message.eventId, fn), log })
      .catch((error: unknown) => log(`${kind} ${message.eventId}: central failed ${String(error)}`));
  };
  const resolveCentral = (m: Message, route: CentralRoute) => {
    void disposition?.resolve(m.eventId).catch((error: unknown) => log(`resolved ${m.eventId}: disposition ${String(error)}`));
    void order(m.eventId, () => createCentralClient(route).resolve(m.eventId)).then(
      (r) => { if (!r.ok) log(`resolved ${m.eventId}: central ${r.status}`); },
      (error: unknown) => log(`resolved ${m.eventId}: central unreachable ${String(error)}`),
    );
  };

  const resolve = (match: (m: Ref) => boolean) => {
    let compact = false;
    for (const [eventId, ref] of [...raising]) if (match(ref)) raising.delete(eventId);
    for (const [eventId, m] of [...open]) {
      if (m.kind === "resolved" || !match({ eventId, agentId: m.agentId, kind: m.kind })) continue;
      open.delete(eventId);
      if (m.kind === "compact") compact = true;
      const route = openCentral.get(eventId);
      if (route) {
        openCentral.delete(eventId);
        resolveCentral(m, route);
      } else post({ ...m, kind: "resolved" });
    }
    for (const agentId of [...quietCompact]) {
      if (!match({ eventId: `quiet:${agentId}`, agentId, kind: "compact" })) continue;
      quietCompact.delete(agentId);
      compact = true;
    }
    if (compact) changed();
  };

  /** exact = 사건 번호가 소리 번호와 정확히 이어지는가(차례 번호 없는 압축 준비는 아니다 — 중앙 경로는 그런 알림을 보내지 않는다) */
  const raise = async (kind: "question" | "compact", eventId: string, agent: Agent, paseo: PaseoApi, title: string, body: string, exact = true) => {
    if (open.has(eventId) || raising.has(eventId)) return;
    raising.set(eventId, { eventId, agentId: agent.id, kind });
    const route = await pushRoute();
    const central = route.mode === "central" && route.central && disposition ? route.central : null;
    if (route.mode !== "legacy" && !central) {
      raising.delete(eventId);
      return log(`${kind} ${eventId}: push ${route.mode}${route.error ? ` (${route.error})` : ""} — PC sound only`);
    }
    if (central) {
      if (!exact) {
        raising.delete(eventId);
        return log(`${kind} ${eventId}: no turn id — central needs an exact event key, PC sound only`);
      }
      // pending 을 이름 조회보다 먼저 내구 저장한다(Codex D-2) — 새로 만든 것일 때만 보낸다
      const begun = await disposition!.begin(eventId);
      if (begun !== "new") {
        raising.delete(eventId);
        if (begun === "stale") await disposition!.finish(eventId);
        return log(`${kind} ${eventId}: already ${begun}, not sent again`);
      }
    }
    const at = await where(agent, paseo);
    // 이름을 읽는 사이 답·취소로 닫혔으면 보내지 않는다(보내자마자 지우는 헛알림을 막는다) — 확인할 수 있게 기록만
    if (!raising.delete(eventId)) {
      if (central) {
        await disposition!.resolve(eventId);
        await disposition!.finish(eventId);
      }
      return log(`${kind} ${eventId}: closed before sending, skipped`);
    }
    if (!at) {
      if (central) await disposition!.finish(eventId);
      return log(`${kind} ${eventId}: no server id, skipped`);
    }
    const message: Message = { kind, eventId, serverId: at.serverId, workspaceId: at.workspaceId, agentId: at.agentId, title: `${title} — ${at.name}`, body, path: at.path };
    open.set(eventId, message);
    if (kind === "compact") changed();
    if (central) {
      openCentral.set(eventId, central);
      postCentral(message, central, kind);
    } else post(message);
  };

  // 답하지 않은 질문 다시 알리기(10-24 리규형님 — 5분 안에 버튼을 누르지 않으면 누를 때까지 5분마다 폰 알림·PC 질문 소리).
  // 원래 사건 번호(q:대화:질문)마다 회차와 예약 하나. 회차가 오르면 직전 폰 알림을 닫고 새 번호로 다시 올린 뒤, 화면에 알려(changed)
  // 화면이 같은 번호로 질문 소리를 낸다(폰이 받으면 PC 조용 — 처음 알림과 같은 판정). 답·새 차례·차례 끝·보관이면 그친다
  type Repeat = { agentId: string; requestId: string; round: number; timer: unknown; agent: Agent; paseo: PaseoApi; body: string };
  const repeats = new Map<string, Repeat>();
  const rounds = (base: string) => (m: Ref) => m.eventId === base || m.eventId.startsWith(`${base}:r`);
  const dropRepeats = (match: (r: Repeat, base: string) => boolean) => {
    let shown = false;
    for (const [base, r] of [...repeats]) {
      if (!match(r, base)) continue;
      repeats.delete(base);
      if (r.timer !== null) clearTimer(r.timer);
      if (r.round > 0) shown = true;
    }
    if (shown) changed();
  };
  const armRepeat = (base: string, r: Repeat) => {
    r.timer = setTimer(() => {
      void fireRepeat(base, r).catch((error: unknown) => log(`question ${base}: repeat failed ${String(error)}`));
    }, repeatMs);
  };
  const fireRepeat = async (base: string, r: Repeat) => {
    if (repeats.get(base) !== r) return;
    r.timer = null;
    // 답한 알림을 놓쳤을 수 있다 — 질문이 아직 떠 있는지 데몬에 다시 묻는다(못 읽으면 알림 기준으로 계속)
    let still = true;
    try {
      const handle = r.paseo.agents.ref(r.agentId);
      await handle.refresh();
      const now = handle.current();
      still = !!now && !now.archivedAt && (now.pendingPermissions ?? []).some((p: { id: string }) => p.id === r.requestId);
    } catch {
      // 계속 보낸다
    }
    if (repeats.get(base) !== r) return;
    if (!still) {
      log(`question ${base}: no longer open — stopped repeating`);
      dropRepeats((x) => x === r);
      resolve(rounds(base));
      return;
    }
    const previous = r.round === 0 ? base : questionEventId(r.agentId, questionRepeatId(r.requestId, r.round));
    r.round += 1;
    resolve((m) => m.eventId === previous);
    armRepeat(base, r);
    log(`question ${base}: still unanswered after ${Math.round((repeatMs * r.round) / 60_000)} min — sending again (round ${r.round})`);
    try {
      // 새 사건을 먼저 올린다(중앙 경로의 판정 기록이 생긴 뒤에 화면이 소리를 물어야 폰이 받았을 때 PC 가 조용하다)
      await raise("question", questionEventId(r.agentId, questionRepeatId(r.requestId, r.round)), r.agent, r.paseo, "질문", r.body);
    } finally {
      changed();
    }
  };

  const snapshot = () => ({
    rev,
    agentIds: [...new Set([...[...open.values()].filter((m) => m.kind === "compact").map((m) => m.agentId), ...quietCompact])],
    questionRepeats: [...repeats.values()].filter((r) => r.round > 0).map((r) => ({ agentId: r.agentId, nativeId: questionRepeatId(r.requestId, r.round) })),
  });

  return {
    // 허락 요청은 종류와 상관없이 질문으로 알린다 — 질문지·계획 승인뿐 아니라 "매번 묻기" 모드의 도구 사용 허락도
    // (10-21 리규형님: 허락 창이 떴는데 알림이 없어 10~20분 몰랐다 · "똑같이 질문으로")
    onPermissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"], { paseo }: { paseo: PaseoApi }) {
      const base = questionEventId(agent.id, request.id);
      const body = questionText(request);
      if (!repeats.has(base)) {
        const r: Repeat = { agentId: agent.id, requestId: request.id, round: 0, timer: null, agent, paseo, body };
        repeats.set(base, r);
        armRepeat(base, r);
      }
      return raise("question", base, agent, paseo, "질문", body);
    },
    // 답했을 때(버튼·말 모두) · 취소·새 말로 정리됐을 때 데몬이 낸다(agent-manager resolvePendingPermissionsForAgent). 다시 알린 회차도 함께 닫는다
    onPermissionResolved({ agent, requestId }: PluginLifecycleEvents["agent.permission_resolved"]) {
      const base = questionEventId(agent.id, requestId);
      dropRepeats((_r, b) => b === base);
      resolve(rounds(base));
    },
    // 다음 턴이 시작되면(압축 명령 포함) 그 대화의 압축 준비는 처리된 것이다. 질문은 이 턴 안에서만 생기므로 함께 지운다
    onTurnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"]) {
      dropRepeats((r) => r.agentId === agent.id);
      resolve((m) => m.agentId === agent.id);
    },
    onTurnEnded({ agent, turnId, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], { paseo }: { paseo: PaseoApi }) {
      dropRepeats((r) => r.agentId === agent.id);
      resolve((m) => m.agentId === agent.id);
      if (outcome.kind !== "completed" || !endsWithCheckpoint(timeline)) return;
      // 압축 준비 폰 알림은 없앴다(10-24 리규형님 버튼 "폰 알림 없애고 보통 끝남 소리로" — 압축 명령은 autoCompact.ts 가 1분 뒤 대신 넣는다).
      // 목록 아이콘(압축 대기 중 표시)만 켜 둔다 — 새 차례가 시작되거나 보관하면 꺼진다
      quietCompact.add(agent.id);
      changed();
      log(`compact ${compactEventId(agent.id, turnId)}: checkpoint report — icon only, no phone push`);
    },
    onArchived({ agent }: PluginLifecycleEvents["agent.archived"]) {
      dropRepeats((r) => r.agentId === agent.id);
      resolve((m) => m.agentId === agent.id);
    },
    /** 플러그인을 내릴 때 — 다시 알림 예약을 모두 지운다 */
    stop() {
      dropRepeats(() => true);
    },
    /** 압축 준비가 떠 있는 대화(프로젝트 목록 아이콘)와 지금 다시 울릴 질문 — 바뀌거나 25초가 지나면 답한다 */
    async waitCompact(known: number | null): Promise<{ rev: number; agentIds: string[]; questionRepeats: { agentId: string; nativeId: string }[] }> {
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
