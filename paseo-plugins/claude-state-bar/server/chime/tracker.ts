import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findCodexLogDir, scanCodexRuns, scanSession, type ChimeItem } from "./scan";

// Claude Code 가 대화 기록을 두는 곳. CLAUDE_CONFIG_DIR 를 쓰면 그 아래다.
function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

// 대화 번호 → 기록 파일. 대화 번호는 폴더가 달라도 겹치지 않는다.
const located = new Map<string, string>();

export async function locateSession(sessionId: string): Promise<string | null> {
  const hit = located.get(sessionId);
  if (hit) {
    try {
      await stat(hit);
      return hit;
    } catch {
      located.delete(sessionId);
    }
  }
  const root = projectsDir();
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = join(root, folder, `${sessionId}.jsonl`);
    try {
      await stat(file);
      located.set(sessionId, file);
      return file;
    } catch {
      /* 다른 폴더 */
    }
  }
  return null;
}

// 확장의 문지기와 같은 규칙(beepGate · seenRunningWorkflowKeys · alertedWorkflowDone · bgSeenRunning · bgAlerted):
// - 처음 본 대화는 기준만 잡고 울리지 않는다
// - 실행 중인 모습을 본 적이 있는 묶음이 성공으로 끝날 때만 한 번 울린다
// - 다시 돌기 시작하면(묶음에 새 에이전트) 다음 끝에 다시 울릴 수 있다
interface Gate {
  seenRunning: Set<string>;
  alerted: Set<string>;
}

// 앱(클라이언트)마다 따로 센다. 휴대폰 앱과 PC 앱이 같은 데몬에 물어도 서로 소리를 가로채지 않게.
const gates = new Map<string, Gate>();

function judge(gate: Gate, items: ChimeItem[], baseline: boolean): number {
  let chimes = 0;
  for (const { key, state } of items) {
    if (state === "running") {
      gate.seenRunning.add(key);
      gate.alerted.delete(key);
      continue;
    }
    if (state === "gap" || gate.alerted.has(key)) continue;
    gate.alerted.add(key);
    if (state === "done" && !baseline && gate.seenRunning.has(key)) chimes += 1;
  }
  return chimes;
}

function gateFor(key: string): { gate: Gate; baseline: boolean } {
  const existing = gates.get(key);
  if (existing) return { gate: existing, baseline: false };
  const gate: Gate = { seenRunning: new Set(), alerted: new Set() };
  gates.set(key, gate);
  return { gate, baseline: true };
}

export async function checkSession(
  clientId: string,
  sessionId: string,
  cwd: string | undefined,
): Promise<{ chimes: number; recheckAfterMs?: number; found: boolean }> {
  let chimes = 0;
  let recheckAfterMs: number | undefined;
  const file = await locateSession(sessionId);
  if (file) {
    const result = await scanSession(file);
    const { gate, baseline } = gateFor(`${clientId}|${sessionId}`);
    chimes += judge(gate, result.items, baseline);
    recheckAfterMs = result.recheckAfterMs;
  }
  // codex_rescue 실행은 대화가 아니라 저장소에 쌓인다. 같은 저장소의 대화가 여럿이어도 한 번만 울리게 앱 단위로 센다.
  const logDir = cwd ? await findCodexLogDir(cwd) : null;
  if (logDir) {
    const { gate, baseline } = gateFor(`${clientId}|codex|${logDir}`);
    chimes += judge(gate, await scanCodexRuns(logDir), baseline);
  }
  return { chimes, found: !!file, ...(recheckAfterMs !== undefined ? { recheckAfterMs } : {}) };
}

/** 앱이 물러날 때 그 앱의 기억을 지운다 */
export function forgetClient(clientId: string): void {
  for (const key of [...gates.keys()]) if (key.startsWith(`${clientId}|`)) gates.delete(key);
}

// 실제 완료 항목으로 화면 사이에 같은 번호를 만든다. 종전의 running 관측/첫 기준 규칙을 유지한다.
function judgeEvents(gate: Gate, items: ChimeItem[], baseline: boolean, scope: string): string[] {
  const events: string[] = [];
  for (const item of items) {
    const nativeId = JSON.stringify([scope, item.key, item.generation]);
    if (item.state === "running") { gate.seenRunning.add(item.key); gate.alerted.delete(nativeId); continue; }
    if (item.state === "gap" || gate.alerted.has(nativeId)) continue;
    gate.alerted.add(nativeId);
    if (item.state === "done" && !baseline && gate.seenRunning.has(item.key)) events.push(nativeId);
  }
  return events;
}

export async function checkSessionV2(clientId: string, sessionId: string, cwd: string | undefined, forceBaseline = false): Promise<{ events: string[]; found: boolean; recheckAfterMs?: number }> {
  const events: string[] = [];
  let recheckAfterMs: number | undefined;
  const file = await locateSession(sessionId);
  if (file) {
    const result = await scanSession(file);
    const { gate, baseline } = gateFor(clientId + "|v2-session|" + sessionId);
    events.push(...judgeEvents(gate, result.items, baseline || forceBaseline, sessionId));
    recheckAfterMs = result.recheckAfterMs;
  }
  const logDir = cwd ? await findCodexLogDir(cwd) : null;
  if (logDir) {
    const { gate, baseline } = gateFor(clientId + "|v2-codex|" + logDir);
    events.push(...judgeEvents(gate, await scanCodexRuns(logDir), baseline || forceBaseline, "codex"));
  }
  return { events, found: !!file, ...(recheckAfterMs !== undefined ? { recheckAfterMs } : {}) };
}
