import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { cutFromRuns, type BoundaryReason, type BoundaryState } from "../../shared/presentation/thinkingBoundary";
import { baseOf } from "../account";
import { locateSession } from "./chime/tracker";

// 생각 상자에서 Claude 의 말을 꺼낼 자리를 Claude 원본 기록(jsonl)으로 찾는다(10-09, 까닭은 shared/presentation/thinkingBoundary.ts).
// 대화 번호 → Paseo 가 아는 Claude 세션 번호(persistence.sessionId) → 기록 파일. 기록은 처음 한 번 끝까지 읽고 그 뒤로는
// 늘어난 만큼만 이어 읽는다. 응답(message.id)마다 내용 칸 순서를 모아 이어진 생각 칸 묶음을 만든다.
// 압축 때 같은 줄(uuid)이 다시 적히므로 uuid 로 거른다. 빈 생각 칸은 Paseo 도 버리므로 뺀다.

// 서버 0.10.3 은 @getpaseo/client 를 가져오면 빌드를 거절한다 — 서버 SDK 문맥 타입에서 꺼낸다(soundEvents.ts 와 같이)
type PaseoApi = PluginHandlerContext["paseo"];

// clipped = 기록 앞부분을 읽지 않았다(끝 TAIL 만 읽었거나 KEEP_MESSAGES 를 넘겨 오래된 응답을 버렸다) — 못 찾은 지난 상자를
// "아직 없음"이 아니라 "범위 밖일 수 있음(history_truncated)"으로 알리는 데만 쓴다(10-18 C3). 메모리 보호 자체는 그대로다
type Index = { size: number; rest: string; decoder: StringDecoder; seen: Set<string>; messages: Map<string, (string | null)[]>; partial: boolean; clipped: boolean };
const indexes = new Map<string, Index>();
const sessions = new Map<string, string>();
const CHUNK = 4 * 1024 * 1024;
// 처음 읽을 때 파일 끝에서 이만큼만 읽는다 — 10-18 콜어드민 Mesa 대화 기록이 1GB 를 넘어, 처음부터 읽으며 생각 글을 다 쌓다
// 플러그인이 메모리 초과로 죽었다(JavaScript heap out of memory, 하루 55번). 화면에 그려지는 상자는 최근 응답이라 끝부분이면 된다.
// 더 오래된 상자는 경계를 못 찾아 통째로 남는다(못 찾을 때와 같은 동작)
const TAIL = 32 * 1024 * 1024;
// 쌓아 두는 응답 수 상한 — 대화가 계속 길어져도 다시 불지 않게, 넘치면 오래된 것부터 버린다
const KEEP_MESSAGES = 2000;
const KEEP_SEEN = KEEP_MESSAGES * 10;

type Line = { type?: string; uuid?: string; isSidechain?: boolean; message?: { id?: string; content?: unknown } };

function addLine(ix: Index, line: string): void {
  if (!line.includes('"assistant"')) return;
  let o: Line;
  try {
    o = JSON.parse(line) as Line;
  } catch {
    return;
  }
  if (o.type !== "assistant" || o.isSidechain || !o.message?.id || !Array.isArray(o.message.content)) return;
  if (o.uuid) {
    if (ix.seen.has(o.uuid)) return;
    ix.seen.add(o.uuid);
    if (ix.seen.size > KEEP_SEEN) ix.seen.delete(ix.seen.values().next().value!);
  }
  if (!ix.messages.has(o.message.id) && ix.messages.size >= KEEP_MESSAGES) {
    ix.messages.delete(ix.messages.keys().next().value!);
    ix.clipped = true;
  }
  const seq = ix.messages.get(o.message.id) ?? [];
  for (const block of o.message.content as { type?: string; thinking?: unknown }[]) {
    if (block?.type === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking.replace(/\r/g, "") : "";
      if (text) seq.push(text);
    } else seq.push(null);
  }
  ix.messages.set(o.message.id, seq);
}

// 같은 파일을 여러 요청이 동시에 이어 읽으면 읽은 자리·끊긴 줄이 꼬인다 — 파일마다 한 줄로 세운다
const loading = new Map<string, Promise<Index>>();
function load(file: string): Promise<Index> {
  const next = (loading.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => loadNow(file));
  loading.set(file, next);
  void next.finally(() => { if (loading.get(file) === next) loading.delete(file); }).catch(() => undefined);
  return next;
}

async function loadNow(file: string): Promise<Index> {
  const { size } = await stat(file);
  let ix = indexes.get(file);
  if (!ix || size < ix.size) {
    const start = Math.max(0, size - TAIL);
    ix = { size: start, rest: "", decoder: new StringDecoder("utf8"), seen: new Set(), messages: new Map(), partial: start > 0, clipped: start > 0 };
    indexes.set(file, ix);
  }
  if (size === ix.size) return ix;
  const handle = await open(file, "r");
  try {
    while (ix.size < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - ix.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, ix.size);
      if (bytesRead <= 0) break;
      ix.size += bytesRead;
      const lines = (ix.rest + ix.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      ix.rest = lines.pop() ?? "";
      // 끝에서부터 읽기 시작했으면 첫 줄은 중간부터라 버린다
      if (ix.partial && lines.length) {
        lines.shift();
        ix.partial = false;
      }
      for (const line of lines) addLine(ix, line);
    }
  } finally {
    await handle.close();
  }
  return ix;
}

/** 응답마다 이어진 생각 칸 묶음(오래된 것 → 새것) */
export function runsOf(messages: Iterable<(string | null)[]>): string[][] {
  const runs: string[][] = [];
  for (const seq of messages) {
    let run: string[] = [];
    for (const item of seq) {
      if (item === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(item);
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

type SessionLookup = { file: string } | { reason: "unsupported" | "no_session" };

async function sessionLookup(paseo: PaseoApi, agentId: string, fresh = false): Promise<SessionLookup> {
  const known = fresh ? undefined : sessions.get(agentId);
  if (known) {
    const file = await locateSession(known);
    if (file) return { file };
    sessions.delete(agentId);
  }
  const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
  if (!agent) return { reason: "no_session" };
  // 개인 claude 와 그것을 이어받은 팀 공급자(claude-yeogiaen·claude-hrg 등, Paseo 설정 extends === "claude") 모두 — 10-18 전엔 이름이
  // 정확히 "claude" 일 때만 찾아서 팀 대화의 진행 글이 늘 상자에 갇혔다. 기록은 모두 같은 projects 폴더에 쌓인다(PC 는 팀 폴더가 정션, 서버는 열쇠 방식)
  if (!baseOf(agent.provider)) return { reason: "unsupported" };
  const sessionId = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId;
  if (!sessionId) return { reason: "no_session" };
  sessions.set(agentId, sessionId);
  const file = await locateSession(sessionId);
  return file ? { file } : { reason: "no_session" };
}

async function sessionFile(paseo: PaseoApi, agentId: string, fresh = false): Promise<string | null> {
  const found = await sessionLookup(paseo, agentId, fresh);
  return "file" in found ? found.file : null;
}

/** 데몬 플러그인 요청 제한(30초) 안 — 설정 맞추기 기다림(25초)과 같은 값 */
const WAIT_MS = 25_000;

type Growth = "grown" | "timeout" | "watch_failed" | "gone";
/** 파일이 size 보다 커지면 grown, 시간이 다 되면 timeout. 지켜보기를 못 걸거나 지켜보기가 깨지면 watch_failed, 파일이 없어지면 gone */
function waitForGrowth(file: string, size: number, ms: number): Promise<Growth> {
  return new Promise((resolve) => {
    let done = false;
    let watcher: FSWatcher | undefined;
    const finish = (result: Growth) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher?.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), ms);
    const check = () => {
      stat(file).then((s) => { if (s.size > size) finish("grown"); }, () => finish("gone"));
    };
    try {
      watcher = watch(file, check);
      // 지켜보기 오류를 받는 곳이 없으면 오류가 데몬 플러그인 밖으로 던져진다(10-18) — 실패로 돌려준다
      watcher.on("error", () => finish("watch_failed"));
    } catch {
      finish("watch_failed");
      return;
    }
    check(); // 지켜보기를 걸기 직전에 이미 늘었을 수도 있다
  });
}

// 진단(10-18 밤 리규형님 "하루 진단 뒤 마지막 문단만 자동", docs/paseo-plugin-tools/THINKING_PROGRESS_TEXT_PLAN.md) — 글 내용은 남기지 않고
// 숫자만. (1) 찾은 상자: 그 응답의 생각 칸 수 · 칸마다 문단 수 · 마지막 칸의 마지막 문단 글자 수 · 응답이 끝났는지(그 칸 묶음 뒤에 본문·도구
// 칸이 기록됐는지). 응답·끝남 여부마다 한 번. (2) 못 찾은 상자: 상자 글 앞부분이 기록의 어느 칸 묶음 중간에 들어 있는지(그 위치) —
// 기록이 늦게 적힌 것인지, 상자 글이 생각 중간부터 잘려 들어온 것인지 가른다
const SHAPE_KEEP = 2000;
const shapeSeen = new Set<string>();
const paragraphs = (s: string) => s.split(/\n\s*\n/).filter((p) => p.trim()).length;
function logShape(agentId: string, ix: Index, clean: string, cut: number | null): void {
  const entries = [...ix.messages.entries()];
  for (let i = entries.length - 1; i >= 0; i--) {
    const [id, seq] = entries[i];
    let run: string[] = [];
    let hit: { blocks: string[]; closed: boolean } | null = null;
    for (let k = 0; k <= seq.length; k++) {
      const item = k < seq.length ? seq[k] : null;
      if (item !== null) { run.push(item); continue; }
      if (run.length && cutFromRuns([run], clean).matched) hit = { blocks: run, closed: k < seq.length };
      run = [];
    }
    if (!hit) continue;
    const key = `${id}:${hit.closed ? 1 : 0}`;
    if (shapeSeen.has(key)) return;
    shapeSeen.add(key);
    if (shapeSeen.size > SHAPE_KEEP) shapeSeen.delete(shapeSeen.values().next().value!);
    const last = hit.blocks[hit.blocks.length - 1].split(/\n\s*\n/).filter((p) => p.trim()).pop() ?? "";
    console.log(`[thinking-shape] agent=${agentId.slice(0, 8)} blocks=${hit.blocks.length} paras=${hit.blocks.map(paragraphs).join(",")} lastPara=${last.trim().length} closed=${hit.closed ? 1 : 0} cut=${cut === null ? "none" : "y"}`);
    return;
  }
}
/** 못 찾은 상자 글의 앞 64자가 기록 칸 묶음 안 어디에 있나 — "위치/묶음 칸 수", 없으면 -1 */
function insideOf(ix: Index, clean: string): string {
  const head = clean.slice(0, 64);
  if (head.length < 16) return "short";
  for (const run of runsOf(ix.messages.values()).reverse()) {
    const at = run.join("").indexOf(head);
    if (at >= 0) return `${at}/${run.length}`;
  }
  return "-1";
}

type BoundaryResult = { cut: number | null; state: BoundaryState; reason?: BoundaryReason };
const unavailable = (reason: BoundaryReason): BoundaryResult => ({ cut: null, state: "unavailable", reason });

/**
 * 상자 글에서 꺼낼 자리와 답의 상태(10-18 C3, shared/presentation/thinkingBoundary.ts). wait 이면(화면이 지금 턴 상자라고 본 것) 기록에서
 * 못 찾았을 때 기록 파일이 늘어날 때마다 다시 찾는다 — 생각이 다 들어온 순간엔 Claude Code 가 아직 그 칸을 적지 않았을 수 있다
 * (10-09 실측: 두 칸이 툴 호출 직전에 함께 적힘). 그래도 WAIT_MS 안에 못 찾으면 pending.
 * wait 가 아니면 기다리지 않는다 — 못 찾았을 때 기록 앞부분을 읽지 않은 상태면 history_truncated, 다 읽은 상태면 pending.
 */
export async function thinkingBoundaryOf(paseo: PaseoApi, agentId: string, text: string, wait = false, waitMs = WAIT_MS): Promise<BoundaryResult> {
  let lookup: SessionLookup;
  try {
    lookup = await sessionLookup(paseo, agentId);
  } catch {
    return unavailable("read_failed");
  }
  if (!("file" in lookup)) return unavailable(lookup.reason);
  let file = lookup.file;
  const clean = text.replace(/\r/g, "");
  const started = Date.now();
  const deadline = started + waitMs;
  let rechecked = false;
  let waited = false;
  for (;;) {
    let ix: Index;
    try {
      ix = await load(file);
    } catch {
      return unavailable("read_failed");
    }
    const found = cutFromRuns(runsOf(ix.messages.values()), clean);
    if (found.matched) {
      // 기다렸다 찾은 경우 — 생각이 다 들어온 뒤 기록에 늦게 적히는 일이 얼마나 잦은지 본다(10-09)
      if (waited) console.log(`[thinking] boundary found after ${Date.now() - started}ms wait agent=${agentId.slice(0, 8)} cut=${found.cut ?? "none"}`);
      try { logShape(agentId, ix, clean, found.cut); } catch { /* 진단이 답을 막지 않게 */ }
      return { cut: found.cut, state: "matched" };
    }
    // 못 찾으면 대화 정보를 한 번 다시 묻는다 — /clear 등으로 세션이 바뀌었는데 예전 기록 파일을 보고 있을 수 있다(10-09)
    if (!rechecked) {
      rechecked = true;
      const latest = await sessionFile(paseo, agentId, true).catch(() => null);
      if (latest && latest !== file) {
        file = latest;
        continue;
      }
    }
    if (!wait) return ix.clipped ? unavailable("history_truncated") : { cut: null, state: "pending" };
    const left = deadline - Date.now();
    const growth: Growth = left > 0 ? await waitForGrowth(file, ix.size, left) : "timeout";
    if (growth === "watch_failed") {
      console.log(`[thinking] boundary watch failed agent=${agentId.slice(0, 8)}`);
      return unavailable("watch_failed");
    }
    if (growth === "gone") return unavailable("read_failed");
    if (growth === "timeout") {
      // 실패 신호 — 기록에서 끝내 못 찾았다(상자에 말이 남는다). 글 내용은 남기지 않고, 화면 글이 기록의 어느 묶음과 앞에서부터
      // 몇 글자까지 같았는지만 — 늦게 적힘(0에 가까움)인지 글이 달라서(중간까지 같음)인지 가른다
      let best = 0;
      for (const run of runsOf(ix.messages.values())) {
        const joined = run.join("");
        let k = 0;
        while (k < joined.length && k < clean.length && joined.charCodeAt(k) === clean.charCodeAt(k)) k++;
        if (k > best) best = k;
      }
      let inside = "?";
      try { inside = insideOf(ix, clean); } catch { /* 진단이 답을 막지 않게 */ }
      console.log(`[thinking] boundary not found after wait agent=${agentId.slice(0, 8)} len=${clean.length} samePrefix=${best} inside=${inside}${ix.clipped ? " clipped" : ""}`);
      return { cut: null, state: "pending" };
    }
    waited = true;
  }
}

/** 옛 부르기(숫자만) — 꺼낼 자리, 없거나 못 찾으면 null(10-09 시험·옛 판과 같은 값) */
export async function thinkingCut(paseo: PaseoApi, agentId: string, text: string, wait = false, waitMs = WAIT_MS): Promise<number | null> {
  return (await thinkingBoundaryOf(paseo, agentId, text, wait, waitMs)).cut;
}
