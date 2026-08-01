// Shared session model. Extracted from extension.ts so provider modules can produce
// sessions without importing the extension entry point (which would be circular).
//
// One SessionInfo drives one status-bar item regardless of which assistant produced it.
// Provider-specific parsing stays in src/providers/<id>/; everything downstream of this
// type — rendering, colours, idle handling, beeps — is shared.

export type ProviderId = 'claude' | 'codex';

/** Account-level usage window (Codex rate limits; the Claude equivalent lives in planUsage.ts). */
export interface CodexUsageWindow {
    usedPercent: number;
    windowMinutes: number;
    resetsAt: number | null;
}

export interface CodexUsageSnapshot {
    primary: CodexUsageWindow | null;
    secondary: CodexUsageWindow | null;
    planType: string | null;
    hasCredits: boolean;
    /**
     * When Codex last wrote this snapshot. Rate limits only refresh while Codex is
     * working, so an idle session's numbers are stale — the tooltip says so rather than
     * presenting them as live.
     */
    observedAt: Date | null;
}

export interface CodexSubagentWorkflowSummary {
    startedAt: Date;
    childCount: number;
    completedCount: number;
    activeCount: number;
    failedCount: number;
    status: 'running' | 'settling' | 'completed' | 'failed';
    completionAt: Date | null;
}

export interface SessionInfo {
    /** Which assistant produced this session. Drives the status-bar icon and capabilities. */
    provider: ProviderId;
    projectName: string;
    projectPath: string;
    sessionId: string;
    sessionFile: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    percentage: number;
    lastUpdated: Date;
    model: string;
    speed: string;
    effortLevel: string;
    contextLimit: number;
    firstMessage: string;
    sessionCreated: Date | null;
    wasCleared: boolean;
    isIdle: boolean;
    isFallback?: boolean;
    // Beep-gate activity clock: timestamp of the last REAL conversation entry
    // (assistant|user only). Unlike lastUpdated/lastRealTimestamp it excludes
    // noise entries (system/stop_hook_summary, queue-operation, …) that get
    // written ~0.6s after a turn completes and would otherwise suppress the beep.
    lastActivityAt: Date | null;
    lastAssistantEndTurnAt: Date | null;
    // Pause-detection signals (for the "question beep"):
    //   pendingQuestionAt — set when the latest assistant entry is an unanswered
    //     AskUserQuestion / ExitPlanMode tool_use (100% reliable signal).
    //   pendingToolUseAt  — set when the latest assistant entry is ANY unanswered
    //     tool_use (used by the optional stuck-tool-use heuristic).
    //   pendingToolUseName — the tool name of that unanswered tool_use (for logs).
    pendingQuestionAt: Date | null;
    pendingToolUseAt: Date | null;
    pendingToolUseName: string | null;

    // --- Codex-only extras (undefined on Claude sessions) ---
    /** Who launched the Codex session — "VS Code", "Desktop", or "Claude Code". */
    /** Account rate limits observed in the rollout; the Codex counterpart to plan usage. */
    codexUsage?: CodexUsageSnapshot | null;
    /** True while a Codex turn is in flight (task_started newer than any terminal event). */
    codexActive?: boolean;
    /** Tokens processed across model calls in this session; not context occupancy or account usage. */
    codexCumulativeTokens?: number;
    /** Spawned children belonging to the latest Codex parent turn, when any exist. */
    codexSubagentWorkflow?: CodexSubagentWorkflowSummary | null;
}

/**
 * Per-provider feature switches. Used instead of scattering `if (provider === …)` through
 * the UI: a capability that is false simply hides its menu entry or skips its scan.
 */
export interface ProviderCapabilities {
    /** Built-in workflow viewer/menu. Codex keeps that UI in its own background-agent panel. */
    workflows: boolean;
    /** Unanswered-tool-use and AskUserQuestion detection. */
    questionSignal: boolean;
    /** The `/clear` + supersession lifecycle. Codex sessions are resumable files instead. */
    clearAndSupersede: boolean;
}

export function capabilitiesFor(provider: ProviderId): ProviderCapabilities {
    if (provider === 'codex') {
        return { workflows: false, questionSignal: false, clearAndSupersede: false };
    }
    return { workflows: true, questionSignal: true, clearAndSupersede: true };
}

/**
 * Status-bar prefix identifying the provider.
 *   ✳ — Claude (mirrors the eight-spoked asterisk of the Claude mark)
 *   ⬢ — Codex  (mirrors the OpenAI hexagonal motif)
 */
export function providerIcon(provider: ProviderId): string {
    // Product icons render at VS Code's native 16 px icon size. The bundled font keeps
    // the established ✳ / ⬢ silhouettes while allowing each provider slot to retain
    // its own fixed foreground colour.
    return provider === 'codex' ? '$(ccb-codex)' : '$(ccb-claude)';
}
