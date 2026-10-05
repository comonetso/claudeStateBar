import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 작업 폴더에서 돈 Claude 대화들의 워크플로우·서브에이전트 묶음·백그라운드 작업.
// 확장 작업 현황 패널의 워크플로우 탭·백그라운드 탭에서 첫 판에 쓰는 것만.

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string().optional(),
  phase: z.string().optional(),
  status: z.enum(["running", "done", "stopped"]),
  /** 끝났으면 결과 앞부분, 돌고 있으면 지금 하는 일 */
  summary: z.string(),
  durationMs: z.number(),
  startedAt: z.number().optional(),
  tokens: z.number().optional(),
  model: z.string().optional(),
});
export type AgentRow = z.infer<typeof agentSchema>;

const workflowSchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  wfId: z.string(),
  kind: z.enum(["workflow", "tasks"]),
  name: z.string(),
  description: z.string(),
  phases: z.array(z.string()),
  agents: z.array(agentSchema),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** running · done(성공) · failed · stopped · gap(에이전트는 다 끝났는데 끝 표시가 아직 없음) */
  state: z.enum(["running", "done", "failed", "stopped", "gap"]),
  activityAt: z.number(),
  /** 이 카드를 띄운 대화가 열려 있다(확장 상태바에 보일 대화 — 데몬이 같은 규칙으로 고른다) */
  sessionLive: z.boolean().optional(),
});
export type WorkflowCard = z.infer<typeof workflowSchema>;

const bgSchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  /** command·monitor = 백그라운드, foreground = 2분 넘게 걸린 일반 명령 */
  kind: z.enum(["command", "monitor", "foreground"]),
  description: z.string(),
  command: z.string(),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().optional(),
  summary: z.string().optional(),
  endedByTaskStop: z.boolean().optional(),
  /** 모니터가 대화에 보낸 이벤트 수 */
  eventCount: z.number().optional(),
  hasOutput: z.boolean(),
});
export type BgCard = z.infer<typeof bgSchema>;

export const activityList = defineRpc({
  name: "activity.list",
  input: z.object({ cwd: z.string() }),
  output: z.object({
    projectDir: z.string().nullable(),
    sessions: z.number(),
    workflows: z.array(workflowSchema),
    background: z.array(bgSchema),
  }),
});

/** 에이전트 하나가 한 일(확장 워크플로우 탭의 에이전트 활동 줄) */
export const agentActivity = defineRpc({
  name: "activity.agent",
  input: z.object({ cwd: z.string(), sessionId: z.string(), wfId: z.string(), agentId: z.string(), status: z.enum(["running", "done", "stopped"]) }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string(),
        body: z.string().optional(),
        status: z.enum(["running", "done", "failed", "warn"]),
        durationMs: z.number().optional(),
      }),
    ),
    /** 끝난 에이전트의 결과 전문(확장 fullSummary — 활동 줄 맨 아래 "보고") */
    report: z.string().optional(),
  }),
});

/** 백그라운드 한 묶음의 끝난 작업을 목록에서 치운다(파일은 그대로). 치운 수 */
export const bgClear = defineRpc({
  name: "activity.bg_clear",
  input: z.object({ cwd: z.string(), group: z.enum(["background", "long"]) }),
  output: z.object({ count: z.number() }),
});

/** 백그라운드 작업 출력. gone 이면 출력 파일이 지워졌다(Claude Code 가 임시 폴더에 둔다) */
export const bgOutput = defineRpc({
  name: "activity.bg_output",
  input: z.object({ cwd: z.string(), sessionId: z.string(), taskId: z.string() }),
  output: z.object({ text: z.string(), gone: z.boolean() }),
});

/**
 * 작업 공간 머리줄 단추의 "돌고 있는 것 수"(확장 activityCounts — 탭 숫자·세션 메뉴와 같은 규칙):
 * 워크플로우 = 열린 대화의 진행 중 에이전트(서브에이전트 묶음 포함) · 백그라운드 = 두 묶음의 실행 중 ·
 * Codex 진행 = 끝나지 않은 실행 · Codex 채팅 = 대화 중
 */
export const activityCounts = defineRpc({
  name: "activity.counts",
  input: z.object({ cwd: z.string() }),
  output: z.object({ workflows: z.number(), background: z.number(), codexRuns: z.number(), codexChats: z.number() }),
});
export type ActivityCounts = z.infer<typeof activityCounts.output>;
