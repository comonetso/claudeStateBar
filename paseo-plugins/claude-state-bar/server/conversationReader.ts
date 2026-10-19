import { createJsonlReader } from "./jsonlReader";
import { addSessionFact, createSessionFacts } from "./activity/openSessions";
import { createTaskNoticeState, addTaskNoticeLines, taskNoticesOf } from "./chime/notices";
import { createBackgroundTaskState, addBackgroundTaskLines, backgroundTasksOf } from "./chime/backgroundTasks";

// 작업 현황과 소리 판정이 같은 대화 판독·진행 중 읽기를 공유한다. 판정 규칙과 2분 기준은 기존 그대로다.
const LONG_COMMAND_MS = 2 * 60 * 1000;
export const readConversation = createJsonlReader({
  create: () => ({ facts: createSessionFacts(), notices: createTaskNoticeState(), background: createBackgroundTaskState(),
    taskToWf: new Map<string, string>(), completedTasks: new Set<string>() }),
  add(state, line) {
    addSessionFact(state.facts, line);
    addTaskNoticeLines(line, state.notices);
    addBackgroundTaskLines(line, LONG_COMMAND_MS, state.background);
    // scan.ts의 기존 완료 짝 규칙은 실제 알림 필터와 다르다. 이 수리에서 정책을 바꾸지 않는다.
    if (line.includes("Task ID:") && line.includes("Run ID:")) {
      const tid = /Task ID: (\w+)/.exec(line), wid = /Run ID: (wf_[A-Za-z0-9-]+)/.exec(line);
      if (tid && wid) state.taskToWf.set(tid[1], wid[1]);
    }
    if (line.includes("<task-notification>")) {
      const tid = /<task-id>(\w+)<\/task-id>/.exec(line), status = /<status>(\w+)<\/status>/.exec(line);
      if (tid && status?.[1] === "completed") state.completedTasks.add(tid[1]);
    }
  },
  value(state) {
    const completedRuns = new Set<string>();
    for (const tid of state.completedTasks) { const run = state.taskToWf.get(tid); if (run) completedRuns.add(run); }
    return { facts: state.facts, notices: taskNoticesOf(state.notices), completedRuns,
      background: backgroundTasksOf(state.background) };
  },
});
