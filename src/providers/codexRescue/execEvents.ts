// Parser for `codex exec --json` event streams (the codex_rescue live event mirror).
//
// This is NOT the rollout parser. Rollout records are `{timestamp, type, payload}`;
// exec JSONL records are `{type, ...}` with no timestamp at all. Feeding one to the other
// silently yields empty state, so the two live in separate modules on purpose.
//
// Contract source: openai/codex tag rust-v0.145.0 `exec/src/exec_events.rs`, cross-checked
// against a real 105-line / 409 KB run captured on 2026-08-19 (stamp 260819_140840).
// Everything here is tolerant: unknown top-level types and unknown item types are counted,
// never thrown, so a CLI upgrade degrades the panel instead of breaking it.
//
// Pure module — no vscode, no disk I/O — so it stays trivially testable.

/**
 * Lifecycle state of a single item within a run.
 *
 * `warn` exists because an `error` item is NOT necessarily a failure: 0.145.0 emits
 * advisory notices through the same channel (e.g. "clamping SessionEnd hook timeout to 3s",
 * "Skill descriptions were shortened to fit the 2% skills context budget"). Painting those
 * red made two perfectly healthy runs look broken at a glance.
 */
export type ItemStatus = 'running' | 'done' | 'failed' | 'warn';

/**
 * One displayable activity. Deliberately narrow: we keep a short label and an optional
 * body, and we DROP `aggregated_output` entirely — in the reference run a single command's
 * output was 63 KB, and 105 lines totalled 409 KB. Holding that in memory (and pushing it
 * through postMessage every poll) would sink the panel for zero display value.
 */
export interface CodexRunItem {
    id: string;
    /** Raw `item.type`, kept verbatim so unknown kinds can still be shown generically. */
    kind: string;
    status: ItemStatus;
    /** Single-line summary for the collapsed row. */
    label: string;
    /** Full text for agent_message / reasoning / error — the part worth reading. */
    body?: string;
    /**
     * Observation timestamps. exec JSONL carries NO timestamps (verified against the
     * 0.145.0 contract), so these are when *we* first/last saw the item — good enough for
     * relative durations, and never presented as authoritative event times.
     */
    firstSeenMs: number;
    lastSeenMs?: number;
}

export interface CodexUsage {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

/** Terminal signal seen in the event stream itself (NOT the same as "send.sh finished"). */
export type TurnTerminal = 'none' | 'completed' | 'failed';

export interface CodexRunState {
    threadId?: string;
    turnStarted: boolean;
    /**
     * `turn.completed` / `turn.failed` only. A top-level `error` event is NOT terminal —
     * the 0.145.0 mapper keeps the turn Running after emitting one, so treating it as the
     * end would mark still-working runs as finished.
     */
    terminal: TurnTerminal;
    /** Set by `turn.failed`. */
    failureMessage?: string;
    /** Only ever present on `turn.completed`; there is no live token counter in exec JSONL. */
    usage?: CodexUsage;
    /** Insertion-ordered activities. */
    items: CodexRunItem[];
    /** Latest `todo_list` contents, when the run happens to emit a plan (it's optional). */
    todo?: { text: string; done: boolean }[];
    /** Lines we could not parse or types we did not recognise — surfaced as a diagnostic. */
    unknownTypes: number;
    badLines: number;
}

export function createRunState(): CodexRunState {
    return { turnStarted: false, terminal: 'none', items: [], unknownTypes: 0, badLines: 0 };
}

/** Collapse whitespace and clip, so one row can never blow up the layout. */
function oneLine(s: unknown, max = 200): string {
    if (typeof s !== 'string') return '';
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Keep full text readable but bounded — a pathological agent_message shouldn't be unbounded. */
function clipBody(s: unknown, max = 4000): string | undefined {
    if (typeof s !== 'string') return undefined;
    const t = s.trim();
    if (!t) return undefined;
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Build the collapsed-row label for an item. Per-kind because the interesting field
 * differs, and because `command_execution` must show the command WITHOUT its output.
 */
function labelFor(item: any): string {
    const kind = String(item?.type ?? '');
    switch (kind) {
        case 'agent_message':
        case 'reasoning':
            return oneLine(item.text) || kind;
        case 'command_execution': {
            const cmd = oneLine(item.command, 160);
            const code = item.exit_code;
            return code === null || code === undefined ? cmd : `${cmd}  (exit ${code})`;
        }
        case 'file_change': {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const paths = changes.map((c: any) => oneLine(c?.path, 80)).filter(Boolean);
            if (!paths.length) return 'file change';
            return paths.length === 1 ? paths[0] : `${paths[0]} 외 ${paths.length - 1}건`;
        }
        case 'web_search':
            // `action` is a version-dependent shape; in the reference run it was a bare
            // {"type":"other"} with no payload, so it is useless as display material.
            return oneLine(item.query, 160) || 'web search';
        case 'mcp_tool_call':
            return `${oneLine(item.server, 40)} · ${oneLine(item.tool, 60)}`;
        case 'collab_tool_call':
            return oneLine(item.tool, 120) || 'collab';
        case 'todo_list': {
            const items = Array.isArray(item.items) ? item.items : [];
            const done = items.filter((t: any) => t?.completed).length;
            return `계획 ${done}/${items.length}`;
        }
        case 'error':
            return oneLine(item.message, 200) || 'error';
        default:
            return kind || 'unknown';
    }
}

/**
 * Map an item's own `status` field onto our tri-state. `command_execution` and
 * `mcp_tool_call` carry `in_progress | completed | failed | declined`; others may carry
 * nothing, in which case the event kind (started vs completed) decides.
 */
function statusFor(item: any, completed: boolean): ItemStatus {
    const raw = typeof item?.status === 'string' ? item.status : '';
    if (raw === 'failed' || raw === 'declined') return 'failed';
    if (raw === 'in_progress') return 'running';
    if (item?.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0) {
        return 'failed';
    }
    // Advisory, not fatal — see ItemStatus. Real failures surface as turn.failed, a
    // non-zero command exit_code, or a file_change with status "failed".
    if (item?.type === 'error') return 'warn';
    return completed ? 'done' : 'running';
}

function upsert(st: CodexRunState, item: any, completed: boolean, nowMs: number): void {
    const id = typeof item?.id === 'string' && item.id ? item.id : `anon_${st.items.length}`;
    const kind = String(item?.type ?? 'unknown');
    const existing = st.items.find(i => i.id === id);
    const label = labelFor(item);
    const body = (kind === 'agent_message' || kind === 'reasoning' || kind === 'error')
        ? clipBody(item.text ?? item.message)
        : undefined;
    const status = statusFor(item, completed);

    if (existing) {
        existing.kind = kind;
        existing.status = status;
        if (label) existing.label = label;
        if (body) existing.body = body;
        if (completed) existing.lastSeenMs = nowMs;
    } else {
        st.items.push({ id, kind, status, label, body, firstSeenMs: nowMs, lastSeenMs: completed ? nowMs : undefined });
    }

    if (kind === 'todo_list' && Array.isArray(item.items)) {
        st.todo = item.items.map((t: any) => ({ text: oneLine(t?.text, 120), done: !!t?.completed }));
    }
}

/**
 * Feed one raw JSONL line. Never throws: malformed lines are counted, not propagated,
 * because the writer may be mid-flush and a torn line is expected, not exceptional.
 */
export function feedExecLine(st: CodexRunState, line: string, nowMs: number): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: any;
    try {
        ev = JSON.parse(trimmed);
    } catch {
        st.badLines++;
        return;
    }
    if (!ev || typeof ev !== 'object') { st.badLines++; return; }

    switch (ev.type) {
        case 'thread.started':
            if (typeof ev.thread_id === 'string') st.threadId = ev.thread_id;
            return;
        case 'turn.started':
            st.turnStarted = true;
            return;
        case 'item.started':
            upsert(st, ev.item, false, nowMs);
            return;
        case 'item.updated':
            upsert(st, ev.item, false, nowMs);
            return;
        case 'item.completed':
            upsert(st, ev.item, true, nowMs);
            return;
        case 'turn.completed': {
            st.terminal = 'completed';
            const u = ev.usage;
            if (u && typeof u === 'object') {
                st.usage = {
                    inputTokens: Number(u.input_tokens) || 0,
                    cachedInputTokens: Number(u.cached_input_tokens) || 0,
                    cacheWriteInputTokens: Number(u.cache_write_input_tokens) || 0,
                    outputTokens: Number(u.output_tokens) || 0,
                    reasoningOutputTokens: Number(u.reasoning_output_tokens) || 0,
                };
            }
            return;
        }
        case 'turn.failed':
            st.terminal = 'failed';
            st.failureMessage = oneLine(ev.error?.message, 300) || undefined;
            return;
        case 'error':
            // Explicitly NOT terminal (see CodexRunState.terminal). Recorded as an activity
            // so the user can see it, without ending the run.
            upsert(st, { id: `err_${st.items.length}`, type: 'error', message: ev.message }, true, nowMs);
            return;
        default:
            st.unknownTypes++;
            return;
    }
}

/**
 * The last item worth showing as "what Codex is doing right now". Prefers the newest
 * agent_message / reasoning — those are Codex narrating its own plan in prose, which is
 * what a human actually wants — and falls back to the newest activity of any kind.
 */
export function latestNarration(st: CodexRunState): CodexRunItem | undefined {
    for (let i = st.items.length - 1; i >= 0; i--) {
        const it = st.items[i];
        if (it.kind === 'agent_message' || it.kind === 'reasoning') return it;
    }
    return st.items.length ? st.items[st.items.length - 1] : undefined;
}
