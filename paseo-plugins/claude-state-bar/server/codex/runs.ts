import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { RunCard, RunItem, RunPhase } from "../../shared/codex";
import { codexLogDir } from "../chime/scan";
import { createRunState, feedExecLine, type CodexRunState } from "./execEvents";

// codex_rescue 실행 기록을 카드로 읽는다. 규칙은 확장 src/providers/codexRescue/runDiscovery.ts 와 같게 옮겨 썼다.
//   <저장소>/docs/codex_rescue/<시각>_{request,response,review}_<slug>.md   문서
//   <저장소>/docs/codex_rescue/.log/<시각>_events.jsonl · _status.json · _heartbeat   실행 기록

// 맥박 파일이 이보다 오래되면 멈춤으로 본다(확장 STALE_AFTER_MS, send.sh 는 5초마다 갱신)
const STALE_AFTER_MS = 30_000;

interface RunStatus {
  slug?: string;
  subject?: string;
  mode?: string;
  kind?: string;
  state?: string;
  group?: string;
  group_session?: string;
  started_at?: string;
  finished_at?: string | null;
}

// 이벤트 파일마다 이어 읽은 위치와 판독 상태
interface Tail {
  parsed: number;
  carry: Buffer;
  state: CodexRunState;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
  prefix: Buffer;
}
const tails = new Map<string, Tail>();
const tailReads = new Map<string, Promise<CodexRunState>>();

// 여러 턴 실행의 턴별 시각(이벤트 파일 경로 기준). 한 번 읽은 경계는 다시 안 바뀌어 남겨 두고,
// 아직 파일이 없는 경계(진행 중인 턴)만 다음 갱신에 다시 본다(확장 turnClock).
const turnClock = new Map<string, Map<number, { startedAtMs?: number; endedAtMs?: number }>>();

/** 휴지통에 넣거나 꺼낸 실행의 판독 상태를 버린다(다시 나타나면 처음부터 읽는다) */
export function forgetRun(eventsPath: string): void {
  tails.delete(eventsPath);
  turnClock.delete(eventsPath);
}

async function statOf(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function splitLines(buf: Buffer): { lines: string[]; carry: Buffer } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  return { lines, carry: buf.subarray(start) };
}

/** 경로별로 이어 읽기를 직렬화한다. 교체된 기록은 처음부터, 정상 append는 늘어난 만큼만 읽는다. */
async function tailEvents(path: string, size: number, nowMs: number): Promise<CodexRunState> {
  const previous = tailReads.get(path) ?? Promise.resolve();
  const reading = previous.catch(() => {}).then(async () => {
    let tail = tails.get(path);
    if (!tail) {
      tail = { parsed: 0, carry: Buffer.alloc(0), state: createRunState(), prefix: Buffer.alloc(0) };
      tails.set(path, tail);
    }
    const parsed = tail.parsed;
    const handle = await open(path, "r");
    try {
      // 호출 전에 받은 크기는 대기 중 낡을 수 있으므로, 실제 열린 파일에서 다시 확인한다.
      const info = await handle.stat();
      size = info.size;
      const head = Buffer.alloc(Math.min(size, 256));
      const { bytesRead: headBytes } = await handle.read(head, 0, head.length, 0);
      const prefix = head.subarray(0, headBytes);
      if (tails.get(path) !== tail || tail.parsed !== parsed) return tails.get(path)?.state ?? createRunState();
      if (size < parsed || (tail.dev !== undefined && (tail.dev !== info.dev || tail.ino !== info.ino)) ||
          (size === parsed && tail.mtimeMs !== undefined && tail.mtimeMs !== info.mtimeMs) ||
          !prefix.subarray(0, tail.prefix.length).equals(tail.prefix)) {
        turnClock.delete(path);
        tail = { parsed: 0, carry: Buffer.alloc(0), state: createRunState(), prefix: Buffer.alloc(0) };
        tails.set(path, tail);
      }
      const start = tail.parsed;
      if (size !== start) {
        const length = size - start;
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, start);
        // 휴지통 이동 등으로 판독 세대가 바뀐 사이 도착한 결과는 반영하지 않는다.
        if (tails.get(path) !== tail || tail.parsed !== start) return tails.get(path)?.state ?? createRunState();
        const combined = Buffer.concat([tail.carry, chunk.subarray(0, bytesRead)]);
        const { lines, carry } = splitLines(combined);
        for (const line of lines) feedExecLine(tail.state, line, nowMs);
        tail.carry = carry;
        tail.parsed += bytesRead;
      }
      tail.mtimeMs = info.mtimeMs;
      tail.dev = info.dev;
      tail.ino = info.ino;
      tail.prefix = Buffer.from(prefix.subarray(0, tail.parsed));
      return tail.state;
    } finally {
      await handle.close();
    }
  }).finally(() => {
    if (tailReads.get(path) === reading) tailReads.delete(path);
  });
  tailReads.set(path, reading);
  return reading;
}

function parseIso(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function parseStamp(stamp: string): number | undefined {
  const m = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return undefined;
  const t = new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : undefined;
}

// 확장 decidePhase 와 같은 순서
function decidePhase(status: RunStatus | null, events: CodexRunState, heartbeatMs: number | undefined, nowMs: number): { phase: RunPhase; staleForMs?: number } {
  const state = status?.state;
  if (state === "done") return { phase: "done" };
  if (state === "failed") return { phase: "failed" };
  if (state === "interrupted") return { phase: "stopped" };
  if (!status && heartbeatMs === undefined) {
    if (events.terminal === "completed") return { phase: "done" };
    if (events.terminal === "failed") return { phase: "failed" };
    return { phase: "stopped" };
  }
  if (heartbeatMs === undefined) return { phase: "stale" };
  const age = nowMs - heartbeatMs;
  if (age > STALE_AFTER_MS) return { phase: "stale", staleForMs: age };
  if (state === "finalizing") return { phase: "finalizing" };
  if (events.terminal !== "none") return { phase: "finalizing" };
  if (!events.turnStarted && !events.items.length) return { phase: "starting" };
  return { phase: "running" };
}

export const isTerminal = (p: RunPhase) => p === "done" || p === "failed" || p === "stopped";

// 모델·추론은 Codex 자기 기록(~/.codex/sessions/연/월/일/rollout-…-<스레드>.jsonl)의 turn_context 줄에만 있다.
// 스레드 번호(UUIDv7)에 만든 시각이 들어 있어 그 날짜 폴더 앞뒤 하루만 본다(확장 findRolloutBySessionId).
const models = new Map<string, { size: number; model: string; effort: string }>();

function dateFromUuidV7(id: string): Date | null {
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex) || id[14] !== "7") return null;
  const ms = parseInt(hex, 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

async function findRollout(threadId: string): Promise<string | null> {
  const created = dateFromUuidV7(threadId);
  if (!created) return null;
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const dates = new Set<string>();
  for (let delta = -1; delta <= 1; delta++) {
    const d = new Date(created.getTime() + delta * 86_400_000);
    dates.add(`${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`);
    dates.add(`${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`);
  }
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  for (const date of dates) {
    const dir = join(home, "sessions", ...date.split("/"));
    const hit = (await listNames(dir)).find((n) => n.toLowerCase().endsWith(suffix));
    if (hit) return join(dir, hit);
  }
  return null;
}

async function modelOf(threadId: string): Promise<{ model: string; effort: string } | undefined> {
  const file = await findRollout(threadId);
  if (!file) return undefined;
  const info = await statOf(file);
  if (!info) return undefined;
  const hit = models.get(threadId);
  if (hit && hit.size === info.size) return hit;
  let model = "";
  let effort = "";
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type !== "turn_context") continue;
      if (typeof o.payload?.model === "string") model = o.payload.model;
      if (typeof o.payload?.effort === "string") effort = o.payload.effort;
    } catch {
      /* 건너뜀 */
    }
  }
  const entry = { size: info.size, model, effort };
  models.set(threadId, entry);
  return entry;
}

function toItems(state: CodexRunState): RunItem[] {
  return state.items.map((i) => ({
    id: i.id,
    turn: i.turn || 1,
    kind: i.kind,
    status: i.status,
    label: i.label,
    ...(i.body ? { body: i.body } : {}),
    ...(i.raw ? { raw: i.raw } : {}),
    ...(i.lastSeenMs && i.lastSeenMs > i.firstSeenMs ? { durationMs: i.lastSeenMs - i.firstSeenMs } : {}),
  }));
}

export async function listRuns(cwd: string, limit = 20, nowMs = Date.now()): Promise<{ logDir: string | null; runs: RunCard[]; older: number }> {
  const logDir = await codexLogDir(cwd);
  if (!logDir) return { logDir: null, runs: [], older: 0 };
  const docsDir = dirname(logDir);
  const logNames = await listNames(logDir);
  const present = new Set(logNames);
  const docNames = await listNames(docsDir);
  const docSet = new Set(docNames);

  const eventStamps = new Set(logNames.map((n) => /^(\d{6}_\d{6})_events\.jsonl$/.exec(n)?.[1]).filter((s): s is string => !!s));
  // 기록 없이 문서만 남은 실행(휴지통에서 기록만 지웠거나 남이 커밋한 문서)
  const docOnly = new Map<string, string>();
  for (const n of docNames) {
    const m = /^(\d{6}_\d{6})_(?:request|response|review)_(.+)\.md$/.exec(n);
    if (!m || eventStamps.has(m[1]) || docOnly.has(m[1])) continue;
    docOnly.set(m[1], m[2]);
  }
  const all = [...new Set([...eventStamps, ...docOnly.keys()])].sort().reverse();
  const stamps = all.slice(0, limit);

  const runs: RunCard[] = [];
  for (const stamp of stamps) {
    const docSlug = docOnly.get(stamp);
    if (docSlug !== undefined) {
      const resultName = [`${stamp}_response_${docSlug}.md`, `${stamp}_review_${docSlug}.md`].find((n) => docSet.has(n));
      const endedAt = resultName ? (await statOf(join(docsDir, resultName)))?.mtimeMs : undefined;
      runs.push({
        stamp,
        slug: docSlug,
        mode: "",
        phase: "done",
        docsOnly: true,
        turns: 1,
        itemCount: 0,
        ...(parseStamp(stamp) !== undefined ? { startedAt: parseStamp(stamp) } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(docSet.has(`${stamp}_request_${docSlug}.md`) ? { requestPath: join(docsDir, `${stamp}_request_${docSlug}.md`) } : {}),
        ...(resultName ? { resultPath: join(docsDir, resultName) } : {}),
      });
      continue;
    }

    const eventsPath = join(logDir, `${stamp}_events.jsonl`);
    const eventsStat = await statOf(eventsPath);
    let status: RunStatus | null = null;
    if (present.has(`${stamp}_status.json`)) {
      try {
        status = JSON.parse(await readFile(join(logDir, `${stamp}_status.json`), "utf8"));
      } catch {
        status = null;
      }
    }
    const terminalStatus = status?.state === "done" || status?.state === "failed" || status?.state === "interrupted";
    const heartbeatMs = !terminalStatus && present.has(`${stamp}_heartbeat`) ? (await statOf(join(logDir, `${stamp}_heartbeat`)))?.mtimeMs : undefined;
    const events = eventsStat ? await tailEvents(eventsPath, eventsStat.size, nowMs) : createRunState();
    const { phase, staleForMs } = decidePhase(status, events, heartbeatMs, nowMs);

    let endedAt = parseIso(status?.finished_at);
    if (endedAt === undefined && isTerminal(phase)) endedAt = eventsStat?.mtimeMs;

    let slug = status?.slug || "";
    if (!slug) {
      const re = new RegExp(`^${stamp}_(?:request|response|review)_(.+)\\.md$`);
      for (const n of docNames) {
        const m = re.exec(n);
        if (m) {
          slug = m[1];
          break;
        }
      }
    }
    if (!slug) slug = "(unknown)";
    const isReview = status?.kind === "review" || status?.mode === "review";
    const candidates = isReview ? [`${stamp}_review_${slug}.md`, `${stamp}_response_${slug}.md`] : [`${stamp}_response_${slug}.md`, `${stamp}_review_${slug}.md`];
    const resultName = candidates.find((n) => docSet.has(n));
    const requestName = `${stamp}_request_${slug}.md`;
    const turns = events.items.reduce((n, i) => Math.max(n, i.turn || 1), 1);

    // 턴별 시각(확장 discoverRuns 와 같은 규칙). status.json 은 턴마다 다시 써져 시작 시각이 마지막 턴 것이라
    // 턴마다 남긴 파일로 잰다 — 시작: 1턴은 실행 번호, N턴은 _followupN_ 문서 저장 시각(호출 몇 초 전) ·
    // 끝: _stderr.log / _tN_stderr.log(Codex 가 끝나는 순간 send.sh 가 복사). 마지막 턴만 status.json 의
    // 정확한 시작으로 바꾸되 앞뒤 경계 사이에 들어갈 때만. 순서가 안 맞는 경계는 비워 둔다(틀리게 쓰지 않는다).
    let turnDocs: RunCard["turnDocs"];
    if (turns < 2) {
      turnClock.delete(eventsPath);
    } else {
      let clock = turnClock.get(eventsPath);
      if (!clock) {
        clock = new Map();
        turnClock.set(eventsPath, clock);
      }
      turnDocs = [];
      let prevEnd: number | undefined;
      for (let turn = 1; turn <= turns; turn++) {
        const name = turn === 1 ? requestName : `${stamp}_followup${turn}_${slug}.md`;
        const errName = turn === 1 ? `${stamp}_stderr.log` : `${stamp}_t${turn}_stderr.log`;
        const known = clock.get(turn) ?? {};
        const fileStart =
          known.startedAtMs ?? (turn === 1 ? parseStamp(stamp) : docSet.has(name) ? (await statOf(join(docsDir, name)))?.mtimeMs : undefined);
        const fileEnd = known.endedAtMs ?? (present.has(errName) ? (await statOf(join(logDir, errName)))?.mtimeMs : undefined);
        clock.set(turn, { startedAtMs: fileStart, endedAtMs: fileEnd });

        let turnStart = fileStart;
        let turnEnd = fileEnd;
        if (turn === turns) {
          const exact = parseIso(status?.started_at);
          if (exact !== undefined && exact >= (prevEnd ?? 0) && (turnEnd === undefined || exact <= turnEnd)) turnStart = exact;
          // 중단된 턴은 send.sh 가 stderr 를 복사하기 전에 멈출 수 있다
          if (turnEnd === undefined && isTerminal(phase)) turnEnd = endedAt;
        }
        if (turnStart !== undefined && ((prevEnd !== undefined && turnStart < prevEnd) || (turnEnd !== undefined && turnStart > turnEnd))) {
          turnStart = undefined;
        }
        prevEnd = turnEnd;
        turnDocs.push({
          turn,
          ...(docSet.has(name) ? { requestPath: join(docsDir, name) } : {}),
          ...(turn === 1 ? {} : { resultAnchor: `<!-- codex_rescue:consult-turn ${turn} -->` }),
          ...(turnStart !== undefined ? { startedAt: turnStart } : {}),
          ...(turnEnd !== undefined ? { endedAt: turnEnd } : {}),
        });
      }
    }

    const isFollowup = turns >= 2 || docSet.has(`${stamp}_followup2_${slug}.md`);
    const startedAt = isFollowup ? (parseStamp(stamp) ?? parseIso(status?.started_at)) : (parseIso(status?.started_at) ?? parseStamp(stamp));
    const usage = events.usage;
    const model = events.threadId ? await modelOf(events.threadId) : undefined;
    // 확장 narrationOfTurn: 그 턴의 마지막 말·생각·클로드 끼어듦(끼어듦은 가장 먼저 봐야 할 줄이라 일부러 넣는다)
    let latest: (typeof events.items)[number] | undefined;
    for (let i = events.items.length - 1; i >= 0; i--) {
      const it = events.items[i];
      if ((it.turn || 1) !== turns) continue;
      if (it.kind === "agent_message" || it.kind === "reasoning" || it.kind === "claude_steer") {
        latest = it;
        break;
      }
    }

    runs.push({
      stamp,
      slug,
      ...(status?.subject?.trim() ? { subject: status.subject.trim() } : {}),
      mode: status?.mode || "readonly",
      phase,
      ...(staleForMs !== undefined ? { staleForMs } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(model?.model ? { model: model.model } : {}),
      ...(model?.effort ? { effort: model.effort } : {}),
      // 확장 카드와 같은 합계: 입력(캐시 포함) + 출력
      ...(usage ? { totalTokens: usage.inputTokens + usage.outputTokens } : {}),
      turns,
      itemCount: events.items.length,
      // 이름표(label)는 200자에서 잘린 한 줄이라 말이 "…습니…"로 끊겼다 — 확장처럼 전문(body)을 보낸다(리규형님 10-09 "말은 모두 볼 수 있어야")
      ...(latest ? { latest: latest.body || latest.label, ...(latest.kind === "claude_steer" ? { latestSteer: true } : {}) } : {}),
      ...(events.failureMessage ? { failureMessage: events.failureMessage } : {}),
      ...(events.todo?.length ? { todo: events.todo } : {}),
      ...(docSet.has(requestName) ? { requestPath: join(docsDir, requestName) } : {}),
      ...(resultName ? { resultPath: join(docsDir, resultName) } : {}),
      ...(turnDocs ? { turnDocs } : {}),
      ...(status?.group?.trim() ? { group: status.group.trim(), groupKey: JSON.stringify([status.group_session || "", status.group.trim()]) } : {}),
    });
  }
  return { logDir, runs, older: Math.max(0, all.length - stamps.length) };
}

export async function runItems(cwd: string, stamp: string): Promise<RunItem[]> {
  if (!/^\d{6}_\d{6}$/.test(stamp)) return [];
  const logDir = await codexLogDir(cwd);
  if (!logDir) return [];
  const eventsPath = join(logDir, `${stamp}_events.jsonl`);
  const info = await statOf(eventsPath);
  if (!info) return [];
  return toItems(await tailEvents(eventsPath, info.size, Date.now()));
}

/** 그 저장소 codex_rescue 문서 폴더 안의 .md 만 읽어 준다 */
export async function readDoc(cwd: string, path: string): Promise<string> {
  const logDir = await codexLogDir(cwd);
  if (!logDir) throw new Error("codex_rescue 기록 폴더가 없습니다");
  const docsDir = resolve(dirname(logDir));
  const target = resolve(path);
  if (dirname(target) !== docsDir || !basename(target).endsWith(".md") || target.includes(`${sep}..${sep}`)) {
    throw new Error("읽을 수 없는 경로입니다");
  }
  return readFile(target, "utf8");
}
