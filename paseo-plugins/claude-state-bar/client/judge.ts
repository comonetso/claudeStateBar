import type { SoundKind } from "../shared/sound";

export interface JudgeConfig { settleMs: number; warningPercent: number; dangerPercent: number }
const QUESTION_KINDS = new Set(["question", "plan"]);
export interface AgentView {
  id: string; status: string; lastUserMessageAt?: string | null;
  pendingPermissions: readonly { id: string; kind: string }[];
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
}
interface AgentMemory { agent: AgentView; questionIds: Set<string>; level: 0 | 1 | 2 }
export interface Judge {
  observe(agent: AgentView, initial: boolean): void;
  remove(agentId: string): void;
  isCurrent(kind: SoundKind, agentId: string, nativeId: string): boolean;
  dispose(): void;
}
function contextPercent(agent: AgentView): number | undefined {
  const used = agent.lastUsage?.contextWindowUsedTokens, max = agent.lastUsage?.contextWindowMaxTokens;
  return used === undefined || !max ? undefined : used / max * 100;
}
function levelOf(percent: number | undefined, config: JudgeConfig): 0 | 1 | 2 {
  return percent === undefined ? 0 : percent >= config.dangerPercent ? 2 : percent >= config.warningPercent ? 1 : 0;
}

export function createJudge(play: (kind: SoundKind, agentId: string, nativeId: string) => void, log: (message: string) => void, config: () => JudgeConfig): Judge {
  const memory = new Map<string, AgentMemory>();
  const timers = new Map<string, { agentId: string; timer: ReturnType<typeof setTimeout> }>();
  const cancel = (key: string, reason: string) => {
    const old = timers.get(key); if (!old) return;
    clearTimeout(old.timer); timers.delete(key); log(`${key}: cancelled (${reason})`);
  };
  const remove = (agentId: string) => {
    for (const [key, value] of timers) if (value.agentId === agentId) cancel(key, "baseline/remove");
    memory.delete(agentId);
  };
  const isCurrent = (kind: SoundKind, id: string, nativeId: string) => {
    const m = memory.get(id); if (!m) return false;
    if (kind === "question") return m.questionIds.has(nativeId);
    if (kind === "completion") return !!nativeId && m.agent.status === "idle" && m.agent.lastUserMessageAt === nativeId && !m.questionIds.size;
    if (kind === "warning" || kind === "danger") return (contextPercent(m.agent) ?? -1) >= (kind === "danger" ? config().dangerPercent : config().warningPercent);
    return true;
  };
  const schedule = (key: string, kind: SoundKind, agent: AgentView, nativeId: string) => {
    cancel(key, "replace");
    const timer = setTimeout(() => { timers.delete(key); if (isCurrent(kind, agent.id, nativeId)) play(kind, agent.id, nativeId); }, config().settleMs);
    timers.set(key, { agentId: agent.id, timer });
  };
  return {
    observe(agent, initial) {
      const questionIds = new Set(agent.pendingPermissions.filter((p) => QUESTION_KINDS.has(p.kind)).map((p) => p.id));
      const percent = contextPercent(agent), previous = memory.get(agent.id);
      if (!previous || initial) { remove(agent.id); memory.set(agent.id, { agent, questionIds, level: levelOf(percent, config()) }); return; }
      let level = previous.level;
      const nextLevel = levelOf(percent, config());
      if (percent !== undefined) level = nextLevel === 0 ? 0 : Math.max(level, nextLevel) as 0 | 1 | 2;
      memory.set(agent.id, { agent, questionIds, level }); // 콜백 전에 최신 상태를 넣는다.
      const doneKey = `completion ${agent.id}`;
      if (agent.status === "running" || questionIds.size) cancel(doneKey, "running/question");
      if (previous.agent.status !== agent.status) {
        log(`agent ${agent.id}: ${previous.agent.status} -> ${agent.status}`);
        if (previous.agent.status === "running" && agent.status === "idle" && !questionIds.size) {
          if (agent.lastUserMessageAt) schedule(doneKey, "completion", agent, agent.lastUserMessageAt);
          else log(`completion ${agent.id}: skipped (source turn identity missing)`);
        }
      }
      for (const id of questionIds) if (!previous.questionIds.has(id)) schedule(`question ${agent.id} ${id}`, "question", agent, id);
      for (const id of previous.questionIds) if (!questionIds.has(id)) cancel(`question ${agent.id} ${id}`, "answered");
      if (percent !== undefined) {
        if (nextLevel === 2 && previous.level < 2) play("danger", agent.id, "");
        else if (nextLevel === 1 && previous.level < 1) play("warning", agent.id, "");
      }
    },
    remove, isCurrent,
    dispose() { for (const v of timers.values()) clearTimeout(v.timer); timers.clear(); memory.clear(); },
  };
}
