import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentRow, BgCard, WorkflowCard } from "../../shared/activity";
import { exitCodeFromOutputTail, parseBackgroundTasks } from "../chime/backgroundTasks";
import { getShortModelName } from "./modelName";
import { addCleared, clearedFor } from "./bgCleared";
import { parseSessionFacts, pickOpenSessions, pickOpenSessionsDetailed, type SessionFile } from "./openSessions";
import { parseTaskNotices, type TaskNotices } from "../chime/notices";
import { parseAgentActivity, type AgentActivityItem } from "./agentActivity";
import { agentTimingOf, deriveAgentRoleLabels, firstPromptOf, type AgentTiming } from "./labels";
import { summarizeResultFull } from "./textFormat";
import { parseWorkflowScript, placeAgents, type ParsedScript } from "./workflowPhases";

// 작업 폴더의 Claude 대화에서 워크플로우·서브에이전트 묶음·백그라운드 작업을 읽는다.
// 규칙은 확장 extension.ts 의 findWorkflowsForSession · findTaskAgentBundles · scanBackgroundTasks 와 같게 옮겨 썼다.

// 확장 값과 같다
const HIDE_AFTER_MS = 86_400_000; // hideAfter 기본(24시간): 이보다 오래 멈춘 대화는 보이지 않는다
const SETTLE_MS = 4000;
const BATCH_GAP_MS = 5 * 60 * 1000;
const LONG_COMMAND_MS = 2 * 60 * 1000;

function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

// 확장 pathCodec.encodeWorkspacePath 와 같다(비교는 대소문자 무시)
function encodeWorkspacePath(p: string): string {
  let result = p;
  if (/^[a-zA-Z]:/.test(result)) result = result[0].toLowerCase() + result.slice(1);
  return result.replace(/[:\\/\s_.]|[^\x00-\x7F]|[^a-zA-Z0-9-]/g, "-");
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

// 판독 결과 캐시: 크기·수정 시각이 같으면 다시 읽지 않는다(원문은 담지 않음)
const cache = new Map<string, { size: number; mtimeMs: number; value: unknown }>();
// 열린 대화의 두 판독은 같은 본문에서 계산한다. 진행 중 Promise에는 판독 결과만 남기고 원문은 버린다.
const conversationReads = new Map<string, { size: number; mtimeMs: number; promise: Promise<{
  facts: ReturnType<typeof parseSessionFacts>;
  conversation: ConversationFacts;
}> }>();

async function readParsed<T>(path: string, kind: string, parse: (text: string) => T): Promise<T | null> {
  const key = `${kind}|${path}`;
  try {
    const info = await stat(path);
    const hit = cache.get(key);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.value as T;
    if (kind === "session-facts" || kind === "conversation") {
      let pending = conversationReads.get(path);
      if (!pending || pending.size !== info.size || pending.mtimeMs !== info.mtimeMs) {
        const promise: Promise<{ facts: ReturnType<typeof parseSessionFacts>; conversation: ConversationFacts }> =
          readFile(path, "utf8").then((text) => {
            const value = { facts: parseSessionFacts(text), conversation: conversationFacts(text) };
            if (conversationReads.get(path)?.promise === promise) {
              cache.set(`session-facts|${path}`, { size: info.size, mtimeMs: info.mtimeMs, value: value.facts });
              cache.set(`conversation|${path}`, { size: info.size, mtimeMs: info.mtimeMs, value: value.conversation });
            }
            return value;
          }).finally(() => {
            if (conversationReads.get(path)?.promise === promise) conversationReads.delete(path);
          });
        pending = { size: info.size, mtimeMs: info.mtimeMs, promise };
        conversationReads.set(path, pending);
      }
      const value = await pending.promise;
      return (kind === "session-facts" ? value.facts : value.conversation) as T;
    }
    const value = parse(await readFile(path, "utf8"));
    cache.set(key, { size: info.size, mtimeMs: info.mtimeMs, value });
    return value;
  } catch {
    cache.delete(key);
    return null;
  }
}

async function findProjectDir(cwd: string): Promise<string | null> {
  const want = encodeWorkspacePath(cwd.replace(/[\\/]+$/, "")).toLowerCase();
  const root = projectsDir();
  const hit = (await listDir(root)).find((n) => n.toLowerCase() === want);
  return hit ? join(root, hit) : null;
}

const endedStatus = (s: string | undefined) => s === "stopped" || s === "killed" || s === "failed";

interface Journal {
  started: string[];
  meta: Map<string, { label?: string; phase?: string }>;
  results: Map<string, { preview: string; full: string }>;
  failed: Set<string>;
}

function parseJournal(text: string): Journal {
  const j: Journal = { started: [], meta: new Map(), results: new Map(), failed: new Set() };
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "started" && rec.agentId) {
        if (!j.started.includes(rec.agentId)) j.started.push(rec.agentId);
        const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : undefined;
        const phase = typeof rec.phase === "string" && rec.phase.trim() ? rec.phase.trim() : undefined;
        if ((label || phase) && !j.meta.has(rec.agentId)) j.meta.set(rec.agentId, { label, phase });
      } else if (rec.type === "result" && rec.agentId) j.results.set(rec.agentId, summarizeResultFull(rec.result));
      else if (rec.type === "failed" && rec.agentId) j.failed.add(rec.agentId);
    } catch {
      /* 건너뜀 */
    }
  }
  return j;
}

const agentLog = (text: string) => ({ prompt: firstPromptOf(text), timing: agentTimingOf(text) });

function markerStatus(wfId: string) {
  return (text: string): string | null => {
    const parsed = JSON.parse(text);
    return parsed?.runId === wfId && typeof parsed.status === "string" ? parsed.status : null;
  };
}

// 워크플로우 스크립트가 늘 에이전트 옆에 있지는 않다(확장 listStrayScriptDirs · resolveScript 와 같은 규칙).
// Claude Code 는 스크립트를 띄울 때의 작업 폴더 칸에 두고, 에이전트 기록은 대화가 시작한 칸에 둔다. 그래서 대화 중에
// cd 하면 둘이 갈린다(확장 실측: 서버 27건 중 7건). 대화 번호는 칸이 달라도 유일하니 다른 칸에서 같은 번호를 찾는다.
// 찾은 위치는 기억한다(스크립트는 한 번 쓰이고 옮겨지지 않는다). 못 찾은 것은 실행 기록이 바뀔 때까지만 기억한다.
const strayScriptCache = new Map<string, { path?: string; journalMtime?: number }>();

async function listStrayScriptDirs(sessionDir: string): Promise<{ dir: string; entries: string[] }[]> {
  const projectDir = dirname(sessionDir);
  const root = dirname(projectDir);
  const own = basename(projectDir);
  const sessionId = basename(sessionDir);
  const out: { dir: string; entries: string[] }[] = [];
  for (const slug of await listDir(root)) {
    if (slug === own) continue;
    const dir = join(root, slug, sessionId, "workflows", "scripts");
    const entries = await listDir(dir);
    if (entries.length) out.push({ dir, entries });
  }
  return out;
}

async function readWorkflows(sessionId: string, sessionDir: string, notices: TaskNotices, sessionActivity: number): Promise<WorkflowCard[]> {
  const cards: WorkflowCard[] = [];
  const workflowsDir = join(sessionDir, "subagents", "workflows");
  const scriptsDir = join(sessionDir, "workflows", "scripts");
  const scripts = await listDir(scriptsDir);
  // 자기 칸 먼저. 다른 칸 목록은 자기 칸에 없는 실행이 있을 때 한 번만 읽는다
  let strayDirs: { dir: string; entries: string[] }[] | undefined;
  const resolveScript = async (wfId: string, journalMtime: number): Promise<string | undefined> => {
    const ownName = scripts.find((n) => n.endsWith(`-${wfId}.js`));
    if (ownName) return join(scriptsDir, ownName);
    const key = `${sessionDir}|${wfId}`;
    const hit = strayScriptCache.get(key);
    if (hit?.path) return hit.path;
    if (hit && hit.journalMtime === journalMtime) return undefined;
    if (!strayDirs) strayDirs = await listStrayScriptDirs(sessionDir);
    for (const { dir, entries } of strayDirs) {
      const name = entries.find((n) => n.endsWith(`-${wfId}.js`));
      if (!name) continue;
      strayScriptCache.set(key, { path: join(dir, name) });
      return join(dir, name);
    }
    strayScriptCache.set(key, { journalMtime });
    return undefined;
  };
  for (const wfId of await listDir(workflowsDir)) {
    if (!wfId.startsWith("wf_")) continue;
    const wfDir = join(workflowsDir, wfId);
    const journalPath = join(wfDir, "journal.jsonl");
    // 기록을 아직 못 읽어도(막 띄운 직후) 에이전트 0개 카드로 낸다(확장과 같음)
    const journal = (await readParsed(journalPath, "journal", parseJournal)) ?? parseJournal("");
    let activityAt = 0;
    try {
      activityAt = (await stat(journalPath)).mtimeMs;
    } catch {
      activityAt = sessionActivity;
    }
    const prompts = new Map<string, string>();
    const timings = new Map<string, AgentTiming>();
    for (const id of journal.started) {
      const log = await readParsed(join(wfDir, `agent-${id}.jsonl`), "wf-agent", agentLog);
      prompts.set(id, log?.prompt ?? "");
      timings.set(id, log?.timing ?? agentTimingOf(null));
    }
    const roles = deriveAgentRoleLabels(prompts);
    let parsed: ParsedScript | null = null;
    const scriptPath = await resolveScript(wfId, activityAt);
    if (scriptPath) parsed = await readParsed(scriptPath, "script", parseWorkflowScript);
    const placement = parsed ? placeAgents(parsed, prompts) : new Map();
    let phases = parsed?.phases ?? [];

    let startedAt = 0;
    let endedAt = 0;
    const agents: AgentRow[] = journal.started.map((id, i) => {
      const timing = timings.get(id)!;
      if (timing.firstTs && (!startedAt || timing.firstTs < startedAt)) startedAt = timing.firstTs;
      if (timing.lastTs > endedAt) endedAt = timing.lastTs;
      const result = journal.results.get(id);
      const status: AgentRow["status"] = result ? "done" : timing.interrupted || journal.failed.has(id) ? "stopped" : "running";
      // 이름: 기록(journal) > 스크립트 > 프롬프트 제목 > 순번 (확장과 같은 우선순위)
      const meta = journal.meta.get(id);
      const place = placement.get(id);
      const role = roles.get(id);
      const name = meta?.label || place?.label || role?.label || `에이전트 ${i + 1}`;
      const phase = meta?.phase || place?.phase;
      if (meta?.phase && !phases.includes(meta.phase)) phases = [...phases, meta.phase];
      return {
        id,
        name,
        ...(!meta?.label && !place?.label && role && role.full !== role.label ? { fullName: role.full } : {}),
        ...(phase ? { phase } : {}),
        status,
        summary: status === "done" ? (result?.preview ?? "") : timing.activity,
        durationMs: timing.durationMs,
        ...(timing.firstTs ? { startedAt: timing.firstTs } : {}),
        ...(timing.tokens ? { tokens: timing.tokens } : {}),
        ...(timing.model && getShortModelName(timing.model) ? { model: getShortModelName(timing.model) } : {}),
      };
    });
    // 세션이 끝나 멈춘 실행은 부모 대화의 끝 알림으로만 안다
    if (agents.some((a) => a.status === "running") && endedStatus(notices.byRun.get(wfId))) {
      for (const a of agents) if (a.status === "running") a.status = "stopped";
    }
    const terminal = await readParsed(join(sessionDir, "workflows", `${wfId}.json`), `marker:${wfId}`, markerStatus(wfId));
    const allDone = agents.length > 0 && agents.every((a) => a.status === "done");
    const state: WorkflowCard["state"] =
      terminal === "completed" ? "done" : terminal === "failed" ? "failed" : terminal === "killed" ? "stopped"
        : agents.some((a) => a.status === "running") ? "running"
          : allDone ? (notices.byRun.get(wfId) === "completed" ? "done" : "gap")
            : "stopped";
    cards.push({
      key: `${sessionId}|${wfId}`,
      sessionId,
      wfId,
      kind: "workflow",
      name: parsed?.name || wfId,
      description: parsed?.description ?? "",
      phases,
      agents,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      state,
      activityAt,
    });
  }
  return cards;
}

interface TaskAgent {
  id: string;
  name: string;
  firstTs: number;
  lastTs: number;
  /** 마지막 응답: end_turn 글 = ended · 끝맺음 없는 글 = text · 그 밖 = busy */
  last: "ended" | "text" | "busy";
  finalText: string;
  /** 마지막 응답 하나에서 고른 지금 하는 일(확장 taskAgentOf — 생각만 있는 응답이면 '작업 중…') */
  activity: string;
  interrupted: boolean;
  timing: AgentTiming;
  /** 기록 파일 수정 시각(묶음 정렬 기준, 확장과 같음) */
  mtimeMs: number;
}

function parseTaskAgent(idFromName: string) {
  return (text: string): Omit<TaskAgent, "name" | "mtimeMs"> | null => {
    const lines = text.trim().split("\n");
    if (!lines[0]?.trim()) return null;
    let id = idFromName;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (typeof e.agentId === "string" && e.agentId) id = e.agentId;
        if (e.timestamp) break;
      } catch {
        /* 건너뜀 */
      }
    }
    const timing = agentTimingOf(text);
    let last: TaskAgent["last"] = "busy";
    let finalText = "";
    let activity = "작업 중…";
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: { type?: string; message?: { content?: unknown; stop_reason?: unknown } };
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.type !== "assistant" || !e.message) continue;
      const blocks = Array.isArray(e.message.content) ? (e.message.content as { type?: string; text?: unknown; name?: unknown; input?: any }[]) : [];
      const textBlock = blocks.find((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
      const hasTool = blocks.some((b) => b?.type === "tool_use");
      const sr = e.message.stop_reason;
      if (textBlock && !hasTool && sr !== "tool_use") {
        last = sr === "end_turn" ? "ended" : "text";
        finalText = String(textBlock.text).trim();
      }
      // 아직 도는 중이면 그 응답의 마지막 도구 호출이나 글(확장 taskAgentOf 와 같은 모양)
      for (let k = blocks.length - 1; k >= 0; k--) {
        const b = blocks[k];
        if (b?.type === "tool_use") {
          const arg = b.input?.file_path || b.input?.path || b.input?.command || b.input?.pattern || b.input?.description;
          activity = `🔧 ${String(b.name)}${typeof arg === "string" ? ` — ${arg.replace(/\s+/g, " ").slice(0, 60)}` : ""}`;
          break;
        }
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          const t = b.text.replace(/\s+/g, " ").trim();
          activity = t.length > 140 ? `${t.slice(0, 140)}…` : t;
          break;
        }
      }
      break; // 마지막 응답 하나만 본다
    }
    return { id, firstTs: timing.firstTs, lastTs: timing.lastTs, last, finalText, activity, interrupted: timing.interrupted, timing };
  };
}

async function readTaskBundles(sessionId: string, sessionDir: string, notices: TaskNotices, now: number): Promise<WorkflowCard[]> {
  const dir = join(sessionDir, "subagents");
  const agents: TaskAgent[] = [];
  for (const name of await listDir(dir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const a = await readParsed(join(dir, name), "task-agent", parseTaskAgent(m[1]));
    if (!a) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(join(dir, name))).mtimeMs;
    } catch {
      mtimeMs = a.lastTs;
    }
    let display = "";
    const meta = await readParsed(join(dir, name.replace(/\.jsonl$/, ".meta.json")), "task-meta", (t) => JSON.parse(t) as { description?: unknown; agentType?: unknown });
    if (typeof meta?.description === "string" && meta.description.trim()) display = meta.description.trim();
    else if (typeof meta?.agentType === "string" && meta.agentType.trim()) display = meta.agentType.trim();
    agents.push({ ...a, name: display || "agent", mtimeMs });
  }
  agents.sort((x, y) => x.firstTs - y.firstTs);
  const batches: TaskAgent[][] = [];
  let current: TaskAgent[] = [];
  for (const a of agents) {
    if (current.length && a.firstTs - current[current.length - 1].firstTs > BATCH_GAP_MS) {
      batches.push(current);
      current = [];
    }
    current.push(a);
  }
  if (current.length) batches.push(current);

  return batches.map((batch) => {
    const rows: AgentRow[] = batch.map((a) => {
      const settled = a.lastTs > 0 && now - a.lastTs >= SETTLE_MS;
      let status: AgentRow["status"] = a.last === "ended" || (a.last === "text" && settled) ? "done" : a.interrupted ? "stopped" : "running";
      if (status === "running") {
        const n = notices.byTask.get(a.id);
        if (n && endedStatus(n.status) && (!a.lastTs || n.at >= a.lastTs)) status = "stopped";
      }
      const oneLine = a.finalText.replace(/\s+/g, " ").trim();
      return {
        id: a.id,
        name: a.name,
        status,
        summary: status === "done" ? (oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine) : a.activity,
        durationMs: a.timing.durationMs,
        ...(a.firstTs ? { startedAt: a.firstTs } : {}),
        ...(a.timing.tokens ? { tokens: a.timing.tokens } : {}),
        ...(a.timing.model && getShortModelName(a.timing.model) ? { model: getShortModelName(a.timing.model) } : {}),
      };
    });
    const startedAt = batch[0].firstTs;
    const endedAt = batch.reduce((m, a) => Math.max(m, a.lastTs), 0);
    const newestMtime = batch.reduce((m, a) => Math.max(m, a.mtimeMs), 0);
    const state: WorkflowCard["state"] = rows.some((r) => r.status === "running") ? "running" : rows.every((r) => r.status === "done") ? "done" : "stopped";
    return {
      key: `${sessionId}|tasks:${startedAt}`,
      sessionId,
      wfId: `tasks:${startedAt}`,
      kind: "tasks" as const,
      // 화면이 시작 시각으로 "서브에이전트 HH:MM (N마리)"를 다시 만든다(데몬 시간대가 보는 기기와 다를 수 있다)
      name: `서브에이전트 (${rows.length}마리)`,
      description: "",
      phases: [],
      agents: rows,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      state,
      activityAt: newestMtime || endedAt || startedAt,
    };
  });
}

interface ConversationFacts {
  notices: TaskNotices;
  background: ReturnType<typeof parseBackgroundTasks>;
}

function conversationFacts(text: string): ConversationFacts {
  return { notices: parseTaskNotices(text), background: parseBackgroundTasks(text, LONG_COMMAND_MS) };
}

// 확장 PROJECT_WF_LIMIT: 워크플로우 탭은 프로젝트 전체에서 최근 20장(기간 제한 없음)
const PROJECT_WF_LIMIT = 20;
const NO_NOTICES: TaskNotices = { byRun: new Map(), byTask: new Map() };

type ActivityList = { projectDir: string | null; sessions: number; workflows: WorkflowCard[]; background: BgCard[] };

export async function listActivity(cwd: string, now = Date.now()): Promise<ActivityList> {
  return (await collectActivity(cwd, now)).list;
}

/**
 * 백그라운드 한 묶음(백그라운드 · 오래 걸린 명령)의 끝난 작업을 목록에서 치운다(확장 onClearFinished — 묻지 않는다,
 * 지우는 것이 없고 목록에서만 빠진다). 치운 수를 돌려준다.
 */
export async function clearFinishedBg(cwd: string, group: "background" | "long"): Promise<number> {
  const { list, bgSessions } = await collectActivity(cwd, Date.now());
  if (!list.projectDir) return 0;
  const keys = list.background.filter((b) => b.status !== "running" && (b.kind === "foreground") === (group === "long")).map((b) => b.key);
  await addCleared(list.projectDir, keys, bgSessions);
  return keys.length;
}

/** 대화 파일, 최신순. 옛 형식 에이전트 기록(agent-*.jsonl)은 대화가 아니다(확장과 같이 뺀다) */
async function sessionFilesOf(projectDir: string): Promise<SessionFile[]> {
  const files: SessionFile[] = [];
  for (const name of await listDir(projectDir)) {
    if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
    try {
      files.push({ id: name.replace(/\.jsonl$/, ""), mtimeMs: (await stat(join(projectDir, name))).mtimeMs });
    } catch {
      /* 읽을 수 없는 파일은 건너뜀 */
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const factsReader = (projectDir: string) => (id: string) => readParsed(join(projectDir, `${id}.jsonl`), "session-facts", parseSessionFacts);

/** 이번 세션 시작(확장 currentChatSince) — 채팅 탭이 이 뒤로 턴이 없는 대화를 "지난 대화"로 접는다. 열린 대화가 없으면 null */
export async function currentSessionSince(cwd: string, now = Date.now()): Promise<number | null> {
  const projectDir = await findProjectDir(cwd);
  if (!projectDir) return null;
  return (await pickOpenSessionsDetailed(await sessionFilesOf(projectDir), factsReader(projectDir), now, HIDE_AFTER_MS)).since;
}

/**
 * 머리줄 단추의 워크플로우·백그라운드 수(확장 activityCounts). 진행 중 에이전트는 열린 대화에만 남으므로
 * 열린 대화만 읽는다 — 확장도 상태바가 매번 읽는 열린 대화 목록(lastWorkflowsBySession)에서 센다.
 */
export async function countRunning(cwd: string, now = Date.now()): Promise<{ workflows: number; background: number }> {
  const { list } = await collectActivity(cwd, now, true);
  let workflows = 0;
  for (const wf of list.workflows) for (const a of wf.agents) if (a.status === "running") workflows++;
  return { workflows, background: list.background.filter((b) => b.status === "running").length };
}

async function collectActivity(cwd: string, now: number, openOnly = false): Promise<{ list: ActivityList; bgSessions: Set<string> }> {
  const projectDir = await findProjectDir(cwd);
  if (!projectDir) return { list: { projectDir: null, sessions: 0, workflows: [], background: [] }, bgSessions: new Set() };
  const files = await sessionFilesOf(projectDir);
  // 열려 있는 대화 = 확장 상태바에 보일 대화(리규형님 10-05 결정, openSessions.ts)
  const open = await pickOpenSessions(files, factsReader(projectDir), now, HIDE_AFTER_MS);

  // 워크플로우 탭(확장 findWorkflowsForProject): 최신 대화부터 훑어 20장이 차면 멈춘다. 열린 대화가 아니면
  // 하위 에이전트를 돌린 적이 있을 때만 읽고, 진행 중으로 남은 에이전트는 중단으로 본다(워크플로우는 자기를 띄운
  // 대화보다 오래 살 수 없다). 끝 알림은 열린 대화에서만 읽는다 — 아닌 대화는 어차피 진행 중이 남지 않는다.
  // openOnly(수 세기)는 열린 대화만, 장 수 제한 없이 읽는다(확장 activityCounts 는 열린 대화의 에이전트를 다 센다)
  const workflows: WorkflowCard[] = [];
  for (const f of files) {
    if (!openOnly && workflows.length >= PROJECT_WF_LIMIT) break;
    const live = open.has(f.id);
    if (openOnly && !live) continue;
    const sessionDir = join(projectDir, f.id);
    if (!live && !(await isDir(join(sessionDir, "subagents")))) continue;
    const notices = live ? ((await readParsed(join(projectDir, `${f.id}.jsonl`), "conversation", conversationFacts))?.notices ?? NO_NOTICES) : NO_NOTICES;
    const cards = [...(await readWorkflows(f.id, sessionDir, notices, f.mtimeMs)), ...(await readTaskBundles(f.id, sessionDir, notices, now))];
    for (const card of cards) {
      card.sessionLive = live;
      if (!live) for (const a of card.agents) if (a.status === "running") a.status = "stopped";
    }
    workflows.push(...cards);
  }

  // 백그라운드 탭: 열린 대화만(확장 09-22 결정 "상태바 세션만"). 치운 끝난 작업은 뺀다
  const background: BgCard[] = [];
  const cleared = await clearedFor(projectDir);
  // 백그라운드 작업이 있는 대화(치우기 전 기준) — 치운 목록에서 남길 키의 기준(확장 lastBgTasks 의 세션들)
  const bgSessions = new Set<string>();
  for (const sessionId of open) {
    const file = join(projectDir, `${sessionId}.jsonl`);
    const facts = await readParsed(file, "conversation", conversationFacts);
    if (!facts) continue;
    if (facts.background.length) bgSessions.add(sessionId);
    for (const t of facts.background) {
      // 일반 명령은 2분 넘게 걸린 것만(돌고 있으면 시작한 지 2분 넘은 것만)
      if (t.kind === "foreground" && t.status === "running" && now - t.startedAt < LONG_COMMAND_MS) continue;
      let { status, endedAt, exitCode } = t;
      // 확장 computeBgViews: 끝 알림이 없어도 출력이 "[exited with code N]"으로 끝났으면 끝난 것이다(리규형님이 정한 규칙).
      // 끝난 시각은 출력 파일 수정 시각
      if (status === "running" && t.kind !== "foreground" && t.outputFile && OUTPUT_PATH_RE.test(t.outputFile)) {
        const tail = await outputTail(t.outputFile);
        if (tail && tail.code !== undefined) {
          status = tail.code === 0 ? "completed" : "failed";
          exitCode = tail.code;
          endedAt = tail.mtimeMs || undefined;
        }
      }
      if (status !== "running" && cleared.has(`${sessionId}|${t.taskId}`)) continue;
      background.push({
        key: `${sessionId}|${t.taskId}`,
        sessionId,
        taskId: t.taskId,
        kind: t.kind,
        description: t.description,
        command: t.command,
        status,
        startedAt: t.startedAt,
        ...(endedAt ? { endedAt } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(t.summary ? { summary: t.summary } : {}),
        ...(t.endedByTaskStop ? { endedByTaskStop: true } : {}),
        ...(t.events.length ? { eventCount: t.events.length } : {}),
        hasOutput: !!t.outputFile || !!t.output || t.events.length > 0,
      });
    }
  }
  workflows.sort((a, b) => b.activityAt - a.activityAt);
  // 확장과 같다: 실행 중은 시작 시각, 끝난 것은 끝난 시각(없으면 시작 시각) 최신순
  background.sort((a, b) => (b.status === "running" ? b.startedAt : (b.endedAt ?? b.startedAt)) - (a.status === "running" ? a.startedAt : (a.endedAt ?? a.startedAt)));
  return { list: { projectDir, sessions: open.size, workflows: openOnly ? workflows : workflows.slice(0, PROJECT_WF_LIMIT), background }, bgSessions };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// Claude Code 자기 작업 출력(…/tasks/<id>.output)처럼 생긴 경로만 연다(확장 bgOutputUri)
const OUTPUT_PATH_RE = /[\\/]tasks[\\/][A-Za-z0-9_-]+\.output$/;

/** 출력 끝의 종료 코드. 크기·수정 시각이 같으면 다시 읽지 않는다 */
async function outputTail(path: string): Promise<{ code: number | undefined; mtimeMs: number } | null> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
  const code = await readParsed(path, "bg-tail", (text) => exitCodeFromOutputTail(text) ?? -1);
  return code === null ? null : { code: code === -1 ? undefined : code, mtimeMs };
}

/**
 * 에이전트 기록을 활동 줄로. 워크플로우 에이전트는 subagents/workflows/<wfId>/, 서브에이전트는 subagents/ 바로 아래.
 * 끝난(done) 에이전트에는 보고(결과 전문)를 붙인다 — 확장 readAgentActivity 의 fullSummary:
 * 워크플로우는 journal result 를 summarizeResultFull 로 바꾼 전문, 서브에이전트는 마지막 응답의 첫 글 블록.
 */
export async function readAgentActivity(
  cwd: string,
  sessionId: string,
  wfId: string,
  agentId: string,
  status: "running" | "done" | "stopped",
): Promise<{ items: AgentActivityItem[]; report?: string }> {
  const projectDir = await findProjectDir(cwd);
  if (!projectDir || !/^[\w-]+$/.test(sessionId) || !/^[\w-]+$/.test(agentId)) return { items: [] };
  const sessionDir = join(projectDir, sessionId);
  let file: string;
  let report: string | undefined;
  if (wfId.startsWith("tasks:")) {
    file = join(sessionDir, "subagents", `agent-${agentId}.jsonl`);
    if (status === "done") report = (await readParsed(file, "task-agent", parseTaskAgent(agentId)))?.finalText || undefined;
  } else if (/^wf_[A-Za-z0-9-]+$/.test(wfId)) {
    file = join(sessionDir, "subagents", "workflows", wfId, `agent-${agentId}.jsonl`);
    if (status === "done") report = (await readParsed(join(sessionDir, "subagents", "workflows", wfId, "journal.jsonl"), "journal", parseJournal))?.results.get(agentId)?.full || undefined;
  } else return { items: [] };
  try {
    const items = parseAgentActivity((await readFile(file, "utf8")).trim().split("\n"), status === "running");
    return { items, ...(report ? { report } : {}) };
  } catch {
    return { items: [], ...(report ? { report } : {}) };
  }
}

/**
 * 백그라운드 작업 출력(확장 computeBgViews · readBgOutput 과 같은 규칙). gone=true 면 출력 파일이 지워졌거나 열 수 없는 경로다.
 * 모니터는 출력 파일 경로가 끝 알림에만 들어오므로, 경로가 없거나 파일이 지워졌으면 대화에 들어온 이벤트를 출력으로 보여 준다.
 */
export async function readBgOutput(cwd: string, sessionId: string, taskId: string): Promise<{ text: string; gone: boolean }> {
  const projectDir = await findProjectDir(cwd);
  if (!projectDir || !/^[\w-]+$/.test(sessionId)) return { text: "", gone: true };
  const facts = await readParsed(join(projectDir, `${sessionId}.jsonl`), "conversation", conversationFacts);
  const task = facts?.background.find((t) => t.taskId === taskId);
  if (!task) return { text: "", gone: true };
  if (task.kind === "foreground") return { text: task.output ?? "", gone: false };
  const events = task.kind === "monitor" && task.events.length ? task.events.join("\n") : null;
  if (task.kind === "monitor" && !task.outputFile) return { text: task.events.join("\n"), gone: false };
  if (!task.outputFile || !OUTPUT_PATH_RE.test(task.outputFile)) return { text: "", gone: true };
  try {
    return { text: await readFile(task.outputFile, "utf8"), gone: false };
  } catch {
    return events !== null ? { text: events, gone: false } : { text: "", gone: true };
  }
}
