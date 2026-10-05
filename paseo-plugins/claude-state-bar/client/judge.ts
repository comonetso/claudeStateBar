import type { SoundKind } from "../shared/sound";

// 설정 화면의 값(기본값은 확장과 같다: 대기 3000 · 경고 50 · 위험 75)
export interface JudgeConfig {
  settleMs: number;
  warningPercent: number;
  dangerPercent: number;
}

// 확장의 질문음 대상(AskUserQuestion · ExitPlanMode)에 맞는 권한 요청 종류
const QUESTION_KINDS = new Set(["question", "plan"]);

export interface AgentView {
  id: string;
  status: string;
  pendingPermissions: readonly { id: string; kind: string }[];
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
}

interface AgentMemory {
  status: string;
  questionIds: Set<string>;
  // 0 = 아직 안 울림 · 1 = 경고 울림 · 2 = 위험 울림
  level: 0 | 1 | 2;
}

export interface Judge {
  observe(agent: AgentView, initial: boolean): void;
  dispose(): void;
}

function contextPercent(agent: AgentView): number | undefined {
  const used = agent.lastUsage?.contextWindowUsedTokens;
  const max = agent.lastUsage?.contextWindowMaxTokens;
  if (!used || !max) return undefined;
  return (used / max) * 100;
}

function levelOf(percent: number | undefined, config: JudgeConfig): 0 | 1 | 2 {
  if (percent === undefined) return 0;
  if (percent >= config.dangerPercent) return 2;
  if (percent >= config.warningPercent) return 1;
  return 0;
}

// 호스트 하나의 대화 상태 변화를 보고 소리를 정한다
export function createJudge(
  play: (kind: SoundKind, agentId: string) => void,
  log: (message: string) => void,
  config: () => JudgeConfig,
): Judge {
  const memory = new Map<string, AgentMemory>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (key: string, fire: () => void) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fire();
      }, config().settleMs),
    );
  };

  const cancel = (key: string, reason: string) => {
    const existing = timers.get(key);
    if (!existing) return;
    clearTimeout(existing);
    timers.delete(key);
    log(`${key}: cancelled (${reason})`);
  };

  const questionIdsOf = (agent: AgentView) =>
    new Set(agent.pendingPermissions.filter((p) => QUESTION_KINDS.has(p.kind)).map((p) => p.id));

  return {
    observe(agent, initial) {
      const questionIds = questionIdsOf(agent);
      const percent = contextPercent(agent);
      const previous = memory.get(agent.id);

      // 처음 본 대화는 기준값만 잡는다(확장의 첫 스캔과 같다)
      if (!previous || initial) {
        memory.set(agent.id, { status: agent.status, questionIds, level: levelOf(percent, config()) });
        return;
      }

      const doneKey = `completion ${agent.id}`;
      if (previous.status !== agent.status) {
        const shown = percent === undefined ? "?" : percent.toFixed(1);
        log(`agent ${agent.id}: ${previous.status} -> ${agent.status} (context ${shown}%)`);
        if (agent.status === "running") cancel(doneKey, "running again");
        if (previous.status === "running" && agent.status === "idle" && questionIds.size === 0) {
          schedule(doneKey, () => play("completion", agent.id));
        }
      }

      for (const id of questionIds) {
        if (previous.questionIds.has(id)) continue;
        schedule(`question ${agent.id} ${id}`, () => play("question", agent.id));
      }
      for (const id of previous.questionIds) {
        if (!questionIds.has(id)) cancel(`question ${agent.id} ${id}`, "answered");
      }

      let level = previous.level;
      const nextLevel = levelOf(percent, config());
      if (percent !== undefined) {
        if (nextLevel === 2 && level < 2) play("danger", agent.id);
        else if (nextLevel === 1 && level < 1) play("warning", agent.id);
        // 컨텍스트가 비워지면 다음에 다시 울릴 수 있게 한다
        level = nextLevel < level && nextLevel === 0 ? 0 : (Math.max(level, nextLevel) as 0 | 1 | 2);
      }

      memory.set(agent.id, { status: agent.status, questionIds, level });
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      memory.clear();
    },
  };
}
