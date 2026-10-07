import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseBackgroundTasks, type BgTask } from "./backgroundTasks";
import { parseTaskNotices, type TaskNotices } from "./notices";

// 대화 하나에서 "따르릉"(묶음이 모두 끝남) 대상의 지금 상태를 읽는다.
// 규칙은 VS Code 확장(src/extension.ts)의 판정과 같게 옮겨 썼다. 확장 코드는 쓰지 않는다.
//
// 파일 위치 (Claude Code, 2026-10-05 이 PC 실측)
//   <projects>/<폴더>/<sessionId>.jsonl                          대화
//   <projects>/<폴더>/<sessionId>/subagents/agent-<id>.jsonl      서브에이전트(Agent 도구)
//   <projects>/<폴더>/<sessionId>/subagents/workflows/wf_*/       워크플로우 기록(journal.jsonl · agent-<id>.jsonl)
//   <projects>/<폴더>/<sessionId>/workflows/wf_*.json             워크플로우 결과(status completed · failed · killed)

/** running = 아직 돈다 · done = 성공으로 끝 · ended = 실패·중단으로 끝(울리지 않음) · gap = 판단 보류 */
export type ChimeState = "running" | "done" | "ended" | "gap";

export interface ChimeItem {
  key: string;
  state: ChimeState;
  /** 화면 시계 대신 기록의 실행/구성원 번호로 만든 세대 */
  generation: string;
}

export interface ScanResult {
  items: ChimeItem[];
  /** 서브에이전트가 4초 정착을 기다리는 중이면, 다시 볼 때까지 남은 밀리초 */
  recheckAfterMs?: number;
}

// 확장 extension.ts 의 값과 같다
const SETTLE_MS = 4000; // 서브에이전트 마지막 글이 이만큼 조용하면 끝난 것(taskAgentOf)
const BATCH_GAP_MS = 5 * 60 * 1000; // 시작 간격이 이보다 크면 다른 묶음(findTaskAgentBundles)
const LONG_COMMAND_MS = 2 * 60 * 1000; // parseBackgroundTasks 인자(따르릉에는 안 쓰는 일반 명령용)

// 파일마다 마지막 판독 결과(원문은 담지 않는다). 크기·수정 시각이 같으면 다시 읽지 않는다.
const parsedCache = new Map<string, { size: number; mtimeMs: number; value: unknown }>();

async function readParsed<T>(path: string, kind: string, parse: (text: string) => T): Promise<T | null> {
  const key = `${kind}|${path}`;
  try {
    const info = await stat(path);
    const hit = parsedCache.get(key);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.value as T;
    const value = parse(await readFile(path, "utf8"));
    parsedCache.set(key, { size: info.size, mtimeMs: info.mtimeMs, value });
    return value;
  } catch {
    parsedCache.delete(key);
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function timestampOf(line: string | undefined): number {
  if (!line?.trim()) return 0;
  try {
    const e = JSON.parse(line);
    return e.timestamp ? new Date(e.timestamp).getTime() : 0;
  } catch {
    return 0;
  }
}

// activity/labels.ts 의 agentWasInterrupted 와 같다: 사용자 글 블록이 "[Request interrupted" 로 시작할 때만 중단
function wasInterrupted(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf("Request interrupted") === -1) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "user") continue;
      const content = e.message?.content;
      const texts = Array.isArray(content)
        ? content.map((b: { type?: string; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
        : [typeof content === "string" ? content : ""];
      if (texts.some((text) => text.trim().startsWith("[Request interrupted"))) return true;
    } catch {
      /* 건너뜀 */
    }
  }
  return false;
}

const endedStatus = (s: string | undefined) => s === "stopped" || s === "killed" || s === "failed";

// 복사본: 확장 extension.ts 의 parseCompletedWorkflowIds (2026-10-05).
// 실행 줄(Task ID · Run ID 가 한 줄)과 완료 알림(task-id · status completed)을 짝지어 끝난 워크플로우를 찾는다.
function parseCompletedWorkflowIds(content: string): Set<string> {
  const completed = new Set<string>();
  const taskToWf = new Map<string, string>();
  const completedTasks = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    if (line.includes("Task ID:") && line.includes("Run ID:")) {
      const tid = /Task ID: (\w+)/.exec(line);
      const wid = /Run ID: (wf_[A-Za-z0-9-]+)/.exec(line);
      if (tid && wid) taskToWf.set(tid[1], wid[1]);
    }
    if (line.includes("<task-notification>")) {
      const tid = /<task-id>(\w+)<\/task-id>/.exec(line);
      const st = /<status>(\w+)<\/status>/.exec(line);
      if (tid && st && st[1] === "completed") completedTasks.add(tid[1]);
    }
  }
  for (const tid of completedTasks) {
    const wfId = taskToWf.get(tid);
    if (wfId) completed.add(wfId);
  }
  return completed;
}

interface ConversationFacts {
  notices: TaskNotices;
  completedRuns: Set<string>;
  background: BgTask[];
}

function conversationFacts(text: string): ConversationFacts {
  return {
    notices: parseTaskNotices(text),
    completedRuns: parseCompletedWorkflowIds(text),
    background: parseBackgroundTasks(text, LONG_COMMAND_MS),
  };
}

interface JournalFacts {
  started: string[];
  done: Set<string>;
  failed: Set<string>;
}

function journalFacts(text: string): JournalFacts {
  const facts: JournalFacts = { started: [], done: new Set(), failed: new Set() };
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "started" && rec.agentId && !facts.started.includes(rec.agentId)) facts.started.push(rec.agentId);
      else if (rec.type === "result" && rec.agentId) facts.done.add(rec.agentId);
      else if (rec.type === "failed" && rec.agentId) facts.failed.add(rec.agentId);
    } catch {
      /* 건너뜀 */
    }
  }
  return facts;
}

function markerStatus(wfId: string) {
  return (text: string): string | null => {
    const parsed = JSON.parse(text);
    return parsed?.runId === wfId && typeof parsed.status === "string" ? parsed.status : null;
  };
}

/** 워크플로우 실행마다 상태(확장 findWorkflowsForSession + 따르릉 판정부) */
async function scanWorkflows(sessionDir: string, facts: ConversationFacts): Promise<ChimeItem[]> {
  const items: ChimeItem[] = [];
  const workflowsDir = join(sessionDir, "subagents", "workflows");
  for (const wfId of await listDir(workflowsDir)) {
    if (!wfId.startsWith("wf_")) continue;
    const wfDir = join(workflowsDir, wfId);
    const journal = await readParsed(join(wfDir, "journal.jsonl"), "journal", journalFacts);
    if (!journal) continue;
    const statuses: string[] = [];
    for (const id of journal.started) {
      if (journal.done.has(id)) {
        statuses.push("done");
        continue;
      }
      const interrupted = await readParsed(join(wfDir, `agent-${id}.jsonl`), "interrupted", (t) => wasInterrupted(t.trim().split("\n")));
      statuses.push(interrupted || journal.failed.has(id) ? "stopped" : "running");
    }
    // 세션이 끝나 멈춘 실행은 부모 대화의 끝 알림으로만 안다
    if (statuses.includes("running") && endedStatus(facts.notices.byRun.get(wfId))) {
      for (let i = 0; i < statuses.length; i++) if (statuses[i] === "running") statuses[i] = "stopped";
    }

    const key = `wf|${wfId}`;
    const generation = JSON.stringify([...journal.started].sort());
    if (!(statuses.length > 0 && statuses.every((s) => s === "done"))) {
      items.push({ key, generation, state: "running" });
      continue;
    }
    // 묶음 사이 빈틈도 "모두 끝"으로 보이므로 결과 파일이나 부모 완료 알림으로 진짜 끝을 확인한다
    const terminal = await readParsed(join(sessionDir, "workflows", `${wfId}.json`), `marker:${wfId}`, markerStatus(wfId));
    if (terminal === "failed" || terminal === "killed") items.push({ key, generation, state: "ended" });
    else if (terminal === "completed" || facts.completedRuns.has(wfId)) items.push({ key, generation, state: "done" });
    else items.push({ key, generation, state: "gap" });
  }
  return items;
}

interface TaskAgentFacts {
  id: string;
  firstTs: number;
  lastTs: number;
  /** 마지막 응답이 도구 없는 글이고 end_turn 이면 "ended", 끝맺음 표시 없이 글만이면 "text", 그 밖은 "busy" */
  last: "ended" | "text" | "busy";
  interrupted: boolean;
}

function taskAgentFacts(idFromName: string) {
  return (text: string): TaskAgentFacts | null => {
    const lines = text.trim().split("\n");
    if (!lines[0]?.trim()) return null;
    let id = idFromName;
    let firstTs = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (typeof e.agentId === "string" && e.agentId) id = e.agentId;
        if (e.timestamp) {
          firstTs = new Date(e.timestamp).getTime();
          break;
        }
      } catch {
        /* 건너뜀 */
      }
    }
    let lastTs = 0;
    for (let i = lines.length - 1; i >= 0 && !lastTs; i--) lastTs = timestampOf(lines[i]);
    let last: TaskAgentFacts["last"] = "busy";
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: { type?: string; message?: { content?: unknown; stop_reason?: unknown } };
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.type !== "assistant" || !e.message) continue;
      const blocks = Array.isArray(e.message.content) ? (e.message.content as { type?: string; text?: unknown }[]) : [];
      const hasText = blocks.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
      const hasTool = blocks.some((b) => b?.type === "tool_use");
      const sr = e.message.stop_reason;
      if (hasText && !hasTool && sr !== "tool_use") last = sr === "end_turn" ? "ended" : "text";
      break;
    }
    return { id, firstTs, lastTs, last, interrupted: wasInterrupted(lines) };
  };
}

/** 서브에이전트(Agent 도구) 묶음마다 상태(확장 findTaskAgentBundles · taskAgentOf) */
async function scanTaskBundles(sessionDir: string, facts: ConversationFacts, now: number): Promise<{ items: ChimeItem[]; recheckAfterMs?: number }> {
  const subagentsDir = join(sessionDir, "subagents");
  const agents: { id: string; status: string; firstTs: number }[] = [];
  let recheckAfterMs: number | undefined;
  for (const name of await listDir(subagentsDir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const a = await readParsed(join(subagentsDir, name), "task-agent", taskAgentFacts(m[1]));
    if (!a) continue;
    // 끝맺음 표시 없이 글만 남긴 응답은 4초 조용하면 끝(확장 taskAgentOf 의 정착 규칙)
    const quietFor = a.lastTs > 0 ? now - a.lastTs : 0;
    const settled = a.lastTs > 0 && quietFor >= SETTLE_MS;
    let status = a.last === "ended" || (a.last === "text" && settled) ? "done" : a.interrupted ? "stopped" : "running";
    if (a.last === "text" && !settled && a.lastTs > 0) {
      const wait = SETTLE_MS - quietFor;
      recheckAfterMs = recheckAfterMs === undefined ? wait : Math.min(recheckAfterMs, wait);
    }
    if (status === "running") {
      const n = facts.notices.byTask.get(a.id);
      if (n && endedStatus(n.status) && (!a.lastTs || n.at >= a.lastTs)) status = "stopped";
    }
    agents.push({ id: a.id, status, firstTs: a.firstTs });
  }

  agents.sort((x, y) => x.firstTs - y.firstTs);
  const batches: (typeof agents)[] = [];
  let current: typeof agents = [];
  for (const a of agents) {
    if (current.length && a.firstTs - current[current.length - 1].firstTs > BATCH_GAP_MS) {
      batches.push(current);
      current = [];
    }
    current.push(a);
  }
  if (current.length) batches.push(current);

  const items = batches.map((batch) => ({
    key: `tasks|${batch[0].firstTs}`,
    generation: JSON.stringify(batch.map((a) => [a.id, a.firstTs]).sort()),
    state: (batch.every((a) => a.status === "done") ? "done" : "running") as ChimeState,
  }));
  return { items, ...(recheckAfterMs !== undefined ? { recheckAfterMs } : {}) };
}

// codex_rescue 실행 기록: <작업 폴더>/docs/codex_rescue/.log/<시각>_status.json (확장 runDiscovery.ts)
// 대화의 작업 폴더에서 위로 올라가며 찾고, 저장소 루트(.git 이 있는 폴더)에서 멈춘다.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * cwd 에서 위로 올라가며 docs/codex_rescue 폴더를 찾는다(.git 이 있는 폴더에서 멈춘다). 기록 폴더 .log 는 없을 수 있다 —
 * 문서만 git 으로 받아 온 저장소도 읽어야 한다(확장 codexRescueDocsDir 도 문서 폴더만 본다, Codex 검토 10-05).
 */
export async function findCodexDirs(cwd: string): Promise<{ docsDir: string; logDir: string } | null> {
  let dir = cwd;
  for (;;) {
    const docsDir = join(dir, "docs", "codex_rescue");
    if ((await statOrNull(docsDir))?.isDirectory()) return { docsDir, logDir: join(docsDir, ".log") };
    if (await exists(join(dir, ".git"))) return null;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 문서 폴더가 있으면 그 아래 .log 경로(폴더는 없을 수 있다 — 판독은 없는 폴더를 빈 목록으로 읽는다) */
export async function codexLogDir(cwd: string): Promise<string | null> {
  return (await findCodexDirs(cwd))?.logDir ?? null;
}

/** 실행 기록 폴더가 실제로 있을 때만(따르릉은 기록이 있어야 울릴 일이 있다) */
export async function findCodexLogDir(cwd: string): Promise<string | null> {
  const dirs = await findCodexDirs(cwd);
  return dirs && (await exists(dirs.logDir)) ? dirs.logDir : null;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function runState(text: string): string | null {
  const o = JSON.parse(text);
  return o && typeof o.state === "string" ? o.state : null;
}

/**
 * codex_rescue 실행마다 상태. 확장 decidePhase · syncCodexRunsInner 와 같은 기준:
 * send.sh 가 적은 state 가 done · failed · interrupted 면 끝(실패·중단도 울린다), 그 밖은 아직 돈다.
 * 상태 파일이 없는 옛 실행은 다루지 않는다(울릴 일이 없다).
 */
export async function scanCodexRuns(logDir: string): Promise<ChimeItem[]> {
  const items: ChimeItem[] = [];
  for (const name of await listDir(logDir)) {
    const m = /^(\d{6}_\d{6})_status\.json$/.exec(name);
    if (!m) continue;
    const state = await readParsed(join(logDir, name), "codex-status", runState);
    if (!state) continue;
    const key = `codex|${logDir}|${m[1]}`;
    const generation = m[1];
    items.push({ key, generation, state: state === "done" || state === "failed" || state === "interrupted" ? "done" : "running" });
  }
  return items;
}

/** 대화 파일 하나의 따르릉 대상 전부 */
export async function scanSession(sessionFile: string, now = Date.now()): Promise<ScanResult> {
  const sessionDir = sessionFile.replace(/\.jsonl$/, "");
  const facts = (await readParsed(sessionFile, "conversation", conversationFacts)) ?? {
    notices: { byRun: new Map(), byTask: new Map() },
    completedRuns: new Set<string>(),
    background: [],
  };

  const workflows = await scanWorkflows(sessionDir, facts);
  const bundles = await scanTaskBundles(sessionDir, facts, now);

  // 백그라운드 작업: 일반 명령(foreground)은 울리지 않는다. 끝내기 명령(TaskStop)으로 멈춘 것도 울리지 않는다.
  const background: ChimeItem[] = [];
  for (const t of facts.background) {
    if (t.kind === "foreground") continue;
    const key = `bg|${t.taskId}`;
    if (t.status === "running") background.push({ key, generation: String(t.startedAt), state: "running" });
    else if (t.status === "completed" && !t.endedByTaskStop) background.push({ key, generation: String(t.startedAt), state: "done" });
    else background.push({ key, generation: String(t.startedAt), state: "ended" });
  }

  return {
    items: [...workflows, ...bundles.items, ...background],
    ...(bundles.recheckAfterMs !== undefined ? { recheckAfterMs: bundles.recheckAfterMs } : {}),
  };
}
