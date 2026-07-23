// Provider-neutral beep-gate state. These maps/sets track which sessions have already
// been alerted (threshold / completion / question / stuck-tool / workflow-done) so a
// repeated poll doesn't re-fire, plus the first-scan baseline flag. Access patterns are
// unchanged from the monolith — only the storage moved here. Session-removal GC is still
// performed by the caller (orchestrator); a single disposeForSession() API is deferred to
// the Codex-attach phase where provider-prefixed keys are introduced.

export type PendingBeep = { timer: NodeJS.Timeout; markerAt: number };

export const alertedSessions = new Map<string, { warned: boolean; dangered: boolean }>();
export const lastKnownEndTurnAt = new Map<string, number>();
// Pending completion beep timers — debounced so a hook follow-up or auto-injected
// user message can cancel the beep before it fires.
export const pendingCompletion = new Map<string, PendingBeep>();
// Baseline / pending state for the question beep (AskUserQuestion / ExitPlanMode).
export const lastKnownQuestionAt = new Map<string, number>();
export const pendingQuestion = new Map<string, PendingBeep>();
// Stuck-tool-use heuristic: remember the timestamp of the unanswered tool_use we
// already fired a beep for, so we don't re-fire while it stays unanswered.
export const alertedStuckToolUseAt = new Map<string, number>();
// Workflow-complete beep gate: once a workflow (or the Task pseudo-workflow,
// wfId 'tasks') reaches "all agents done", we beep ONCE and record it here so the
// next polling pass — where the already-finished workflow still reads as done —
// doesn't re-fire. Key: `${sessionFile}|${wfId}`, value: the done agent count
// (a changing count means new agents finished, which is still the same gate event
// but lets us see the latest baseline in logs).
export const alertedWorkflowDone = new Map<string, number>();
// Keys observed in a RUNNING state this runtime. Only a genuine running→done transition
// we actually watched should beep; a workflow first seen already-done (stale work from
// another project, or pre-existing on first scan) is baselined silently so it never
// beeps as if it just finished.
export const seenRunningWorkflowKeys = new Set<string>();

// First-scan baseline flag. Consumed once at the start of the first refreshAllSessions()
// pass so pre-existing completions/questions are baselined silently (no beep on startup).
// Exposed via getter/setter because a re-exported `let` binding can't be reassigned by
// importers.
let firstScan = true;
export function getFirstScan(): boolean {
    return firstScan;
}
export function setFirstScan(v: boolean): void {
    firstScan = v;
}
