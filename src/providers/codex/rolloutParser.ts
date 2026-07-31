// Codex rollout JSONL parser — PURE module (no vscode import, no disk I/O).
//
// Codex writes one rollout file per session under
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
// Each line is a JSON record with a top-level `type` and a `payload`.
//
// Design rules enforced here (see docs/CODEX_ATTACH_ARCHITECTURE_REVIEW.md §10.3, §13):
//  - TOLERANT: unknown record types are counted, never thrown on. Codex ships schema
//    changes frequently — a new record type must never blank out the status bar.
//  - PRIVACY: message/reasoning/tool bodies are NEVER stored on the accumulator. We
//    only keep counts, timestamps and structural fields. The `compacted` record in
//    particular carries the entire replacement conversation history (~15KB of raw user
//    text) and is deliberately reduced to a single timestamp.
//  - INCREMENTAL: `feedLine` is called once per line and mutates the accumulator, so a
//    tail reader can push only the newly appended bytes without re-reading the file.
//    Rollout files reach 14MB on this machine; full re-reads are not an option.

export interface CodexTokenUsage {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
}

export interface CodexRateLimitWindow {
    usedPercent: number;
    windowMinutes: number;
    /** Epoch milliseconds, or null when Codex omitted it. */
    resetsAt: number | null;
}

export interface CodexRateLimits {
    primary: CodexRateLimitWindow | null;
    secondary: CodexRateLimitWindow | null;
    planType: string | null;
    hasCredits: boolean;
    /** When this snapshot was written to the rollout — used to mark the data stale. */
    observedAt: Date | null;
}

export interface CodexAccumulator {
    sessionId: string;
    /** Absolute workspace path Codex reported (`session_meta.cwd`), verbatim. */
    cwd: string;
    /** e.g. "codex_vscode", "codex_work_desktop", or "Claude Code" when Claude spawned it. */
    originator: string;
    /**
     * True when `session_meta.source` is the object form `{subagent:{…}}` rather than a
     * plain string. Sub-agent threads are excluded from the status bar in Phase 1 — they
     * belong to the (unimplemented) agent viewer, and older ones carry no parent link.
     */
    isSubagent: boolean;
    model: string;
    effort: string;
    /** 0 when Codex never reported a window — callers must NOT compute a percentage then. */
    contextLimit: number;

    /** Context occupancy of the most recent model call. THIS is the context gauge. */
    last: CodexTokenUsage | null;
    /** Lifetime cumulative spend. Must never be divided by the context window. */
    total: CodexTokenUsage | null;

    rateLimits: CodexRateLimits | null;

    sessionCreated: Date | null;
    /** Timestamp of the newest record of any kind. */
    lastActivityAt: Date | null;
    lastTaskStartedAt: Date | null;
    lastTaskCompleteAt: Date | null;
    lastTurnAbortedAt: Date | null;
    lastCompactedAt: Date | null;
    /** Newest assistant-visible output — drives the "is it thinking" indicator. */
    lastReasoningAt: Date | null;

    /** Diagnostics only. Never contains user text. */
    unknownEventTypes: Map<string, number>;
    parseErrorCount: number;
    recordCount: number;
}

export function createAccumulator(): CodexAccumulator {
    return {
        sessionId: '',
        cwd: '',
        originator: '',
        isSubagent: false,
        model: '',
        effort: '',
        contextLimit: 0,
        last: null,
        total: null,
        rateLimits: null,
        sessionCreated: null,
        lastActivityAt: null,
        lastTaskStartedAt: null,
        lastTaskCompleteAt: null,
        lastTurnAbortedAt: null,
        lastCompactedAt: null,
        lastReasoningAt: null,
        unknownEventTypes: new Map(),
        parseErrorCount: 0,
        recordCount: 0
    };
}

function toDate(v: unknown): Date | null {
    if (typeof v !== 'string' || !v) return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
}

function newer(current: Date | null, candidate: Date | null): Date | null {
    if (!candidate) return current;
    if (!current) return candidate;
    return candidate.getTime() > current.getTime() ? candidate : current;
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readUsage(raw: any): CodexTokenUsage | null {
    if (!raw || typeof raw !== 'object') return null;
    return {
        inputTokens: num(raw.input_tokens),
        // NOTE: cached input is already *inside* input_tokens. Never add the two together
        // (docs §4.5) — doing so double-counts and inflates the context percentage.
        cachedInputTokens: num(raw.cached_input_tokens),
        outputTokens: num(raw.output_tokens),
        reasoningOutputTokens: num(raw.reasoning_output_tokens),
        totalTokens: num(raw.total_tokens)
    };
}

function readWindow(raw: any): CodexRateLimitWindow | null {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.used_percent !== 'number') return null;
    // Codex reports `resets_at` in epoch SECONDS; the rest of this extension works in ms.
    const resetsAt = typeof raw.resets_at === 'number' && Number.isFinite(raw.resets_at)
        ? raw.resets_at * 1000
        : null;
    return {
        usedPercent: raw.used_percent,
        windowMinutes: num(raw.window_minutes),
        resetsAt
    };
}

/**
 * Consume one raw JSONL line. Malformed lines bump `parseErrorCount` and are otherwise
 * ignored — the tail reader retries them on the next refresh, because a truncated final
 * line usually just means Codex is mid-write.
 */
export function feedLine(acc: CodexAccumulator, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let rec: any;
    try {
        rec = JSON.parse(trimmed);
    } catch {
        acc.parseErrorCount++;
        return;
    }
    if (!rec || typeof rec !== 'object') return;

    acc.recordCount++;
    const ts = toDate(rec.timestamp);
    acc.lastActivityAt = newer(acc.lastActivityAt, ts);

    const payload = rec.payload;

    switch (rec.type) {
        case 'session_meta': {
            if (!payload || typeof payload !== 'object') break;
            // Duplicate session_meta records occur (observed 88 across 20 files, i.e. >1
            // per file). Keep the FIRST id/creation time as the stable identity and let
            // later records only fill in gaps.
            if (!acc.sessionId) {
                acc.sessionId = String(payload.session_id || payload.id || '');
            }
            if (typeof payload.cwd === 'string' && payload.cwd) acc.cwd = payload.cwd;
            if (typeof payload.originator === 'string') acc.originator = payload.originator;
            // `source` is EITHER a plain string ("vscode") OR an object describing a
            // sub-agent: {"subagent":{"other":"guardian"}}. Observed both on this machine.
            if (payload.source && typeof payload.source === 'object') acc.isSubagent = true;
            if (payload.thread_source === 'subagent') acc.isSubagent = true;
            acc.sessionCreated = acc.sessionCreated ?? (toDate(payload.timestamp) ?? ts);
            break;
        }

        case 'turn_context': {
            if (!payload || typeof payload !== 'object') break;
            // Codex can change model/effort per turn, so the LATEST turn wins — unlike
            // Claude, where effort is one global setting shared by every session.
            if (typeof payload.model === 'string' && payload.model) acc.model = payload.model;
            if (typeof payload.effort === 'string' && payload.effort) acc.effort = payload.effort;
            if (typeof payload.cwd === 'string' && payload.cwd && !acc.cwd) acc.cwd = payload.cwd;
            break;
        }

        case 'event_msg': {
            if (!payload || typeof payload !== 'object') break;
            switch (payload.type) {
                case 'task_started':
                    acc.lastTaskStartedAt = newer(acc.lastTaskStartedAt, ts);
                    // task_started carries the window directly, so a session that has not
                    // produced a token_count yet still gets a correct denominator.
                    if (num(payload.model_context_window) > 0) {
                        acc.contextLimit = payload.model_context_window;
                    }
                    break;

                case 'task_complete':
                    acc.lastTaskCompleteAt = newer(acc.lastTaskCompleteAt, ts);
                    break;

                case 'turn_aborted':
                    acc.lastTurnAbortedAt = newer(acc.lastTurnAbortedAt, ts);
                    break;

                case 'token_count': {
                    const info = payload.info;
                    if (info && typeof info === 'object') {
                        const last = readUsage(info.last_token_usage);
                        const total = readUsage(info.total_token_usage);
                        if (last) acc.last = last;
                        if (total) acc.total = total;
                        if (num(info.model_context_window) > 0) {
                            acc.contextLimit = info.model_context_window;
                        }
                    }
                    // Account rate limits ride along on token_count. They only refresh while
                    // Codex is working, so an idle session's snapshot goes stale — callers
                    // surface `observedAt` to say so rather than presenting it as live.
                    const rl = payload.rate_limits;
                    if (rl && typeof rl === 'object') {
                        acc.rateLimits = {
                            primary: readWindow(rl.primary),
                            secondary: readWindow(rl.secondary),
                            planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
                            hasCredits: !!(rl.credits && rl.credits.has_credits),
                            observedAt: ts
                        };
                    }
                    break;
                }

                case 'thread_settings_applied': {
                    // Fallback source for model/effort when no turn_context has landed yet.
                    const s = payload.thread_settings;
                    if (s && typeof s === 'object') {
                        if (!acc.model && typeof s.model === 'string') acc.model = s.model;
                        if (!acc.effort && typeof s.reasoning_effort === 'string') acc.effort = s.reasoning_effort;
                    }
                    break;
                }

                case 'context_compacted':
                    acc.lastCompactedAt = newer(acc.lastCompactedAt, ts);
                    break;

                case 'agent_reasoning':
                    acc.lastReasoningAt = newer(acc.lastReasoningAt, ts);
                    break;

                case 'user_message':
                case 'agent_message':
                case 'patch_apply_end':
                case 'web_search_end':
                case 'mcp_tool_call_end':
                    // Known and intentionally ignored — the timestamp already fed
                    // lastActivityAt above, and we never retain their bodies.
                    break;

                default: {
                    const k = String(payload.type ?? 'unknown');
                    acc.unknownEventTypes.set(k, (acc.unknownEventTypes.get(k) ?? 0) + 1);
                    break;
                }
            }
            break;
        }

        case 'response_item': {
            // Observed payload types: message, reasoning, function_call,
            // function_call_output, custom_tool_call, custom_tool_call_output,
            // tool_search_call, tool_search_output. All bodies are skipped by design;
            // only `reasoning` contributes a timestamp for the thinking indicator.
            if (payload && typeof payload === 'object' && payload.type === 'reasoning') {
                acc.lastReasoningAt = newer(acc.lastReasoningAt, ts);
            }
            break;
        }

        case 'compacted':
            // payload.replacement_history is the FULL prior conversation (~15KB of raw
            // user text). Reduce it to a timestamp and never touch the contents.
            acc.lastCompactedAt = newer(acc.lastCompactedAt, ts);
            break;

        case 'world_state':
            break;

        default: {
            const k = `top:${String(rec.type ?? 'unknown')}`;
            acc.unknownEventTypes.set(k, (acc.unknownEventTypes.get(k) ?? 0) + 1);
            break;
        }
    }
}

export function feedLines(acc: CodexAccumulator, lines: string[]): void {
    for (const l of lines) feedLine(acc, l);
}

/**
 * Context occupancy as a 0-100 integer, or null when Codex has not reported enough to
 * compute one. Returning null (rather than 0) matters: the caller renders "—" instead of
 * claiming an empty context.
 */
export function contextPercentage(acc: CodexAccumulator): number | null {
    if (!acc.last || acc.contextLimit <= 0) return null;
    if (acc.last.totalTokens <= 0) return null;
    return Math.round((acc.last.totalTokens / acc.contextLimit) * 100);
}

/**
 * Lifecycle state derived from the task/turn event ordering (docs §4.6).
 * `active` means a turn is genuinely in flight — the newest task_started is more recent
 * than any terminal event.
 */
export type CodexLifecycle = 'active' | 'completed' | 'aborted' | 'unknown';

export function lifecycle(acc: CodexAccumulator): CodexLifecycle {
    const started = acc.lastTaskStartedAt?.getTime() ?? -1;
    const done = acc.lastTaskCompleteAt?.getTime() ?? -1;
    const aborted = acc.lastTurnAbortedAt?.getTime() ?? -1;
    if (started < 0 && done < 0 && aborted < 0) return 'unknown';
    const terminal = Math.max(done, aborted);
    if (started > terminal) return 'active';
    return aborted > done ? 'aborted' : 'completed';
}

/**
 * Timestamp of the newest completed turn, or null. Feeds the completion beep: the shared
 * debounce in extension.ts treats this exactly like Claude's assistant end_turn marker.
 */
export function completionMarker(acc: CodexAccumulator): Date | null {
    return acc.lastTaskCompleteAt;
}
