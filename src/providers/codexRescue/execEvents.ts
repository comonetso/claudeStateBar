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
    /**
     * Unique within the run, which is not the same as the id Codex sent: a followup turn
     * starts counting from `item_0` again, so items from turn 2 onwards are prefixed
     * `t<N>:`. Turn 1 keeps the raw id, so single-turn runs are unchanged.
     */
    id: string;
    /**
     * 1-based turn this item belongs to, copied from `CodexRunState.turnSeq` when the item is
     * first seen and never rewritten — the same id arrives twice (started → completed) within
     * one turn, and a later update must not drag the item into whatever turn is current then.
     *
     * The panel draws a turn header wherever this changes, and draws none at all when every
     * item is turn 1, so single-turn runs (most of the corpus) look exactly as they did.
     */
    turn: number;
    /** Raw `item.type`, kept verbatim so unknown kinds can still be shown generically. */
    kind: string;
    status: ItemStatus;
    /** Single-line summary for the collapsed row. */
    label: string;
    /** Full text for agent_message / reasoning / error / claude_steer — the part worth reading. */
    body?: string;
    /**
     * `command_execution` only: the command as it actually ran, shell wrapper included.
     * `label` shows the unwrapped form; this is what you need to reproduce it by hand.
     */
    raw?: string;
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
     * `turn.completed` / `turn.failed` only, and only for the turn currently in flight —
     * a followup turn resets it back to `none`, because the run is working again.
     *
     * A top-level `error` event is NOT terminal — the 0.145.0 mapper keeps the turn Running
     * after emitting one, so treating it as the end would mark still-working runs as finished.
     */
    terminal: TurnTerminal;
    /** Set by `turn.failed` of the turn in flight; cleared when a later turn starts. */
    failureMessage?: string;
    /**
     * 1-based turn counter. A followup (`codex exec resume`) appends to the SAME events file
     * and restarts item ids at `item_0`, so ids are only unique *within* a turn — see
     * `openTurnIfPending`. Stays 1 for the single-turn runs that make up most of the corpus.
     */
    turnSeq: number;
    /**
     * Set the moment a turn goes terminal: the next sign of activity belongs to a new turn.
     * See `openTurnIfPending` for why the boundary is detected here and not at `turn.started`.
     */
    pendingTurnBreak: boolean;
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
    return {
        turnStarted: false, terminal: 'none', items: [],
        turnSeq: 1, pendingTurnBreak: false,
        unknownTypes: 0, badLines: 0,
    };
}

/** Collapse whitespace and clip, so one row can never blow up the layout. */
function oneLine(s: unknown, max = 200): string {
    if (typeof s !== 'string') return '';
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Drop the shell Codex runs everything through, so the row starts with the actual command.
 *
 * Every `command_execution` arrives wrapped: `/bin/bash -lc "…"` on Linux, and on Windows
 * `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "…"` — 48 characters of identical
 * prefix on every row, which pushed the real command off the end of the line.
 *
 * The wrapper is kept as `raw` on the item, since it is what actually ran.
 */
function stripShellWrapper(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const s = raw.trim();
    const posix = /^(?:[^\s"]*[/\\])?(?:bash|sh|zsh|dash)\s+-[A-Za-z]*c\s+([\s\S]+)$/.exec(s);
    const win = posix ? null
        : /^(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|[^\s"]*(?:pwsh|powershell)(?:\.exe)?)\s+-Command\s+([\s\S]+)$/i.exec(s);
    const inner = (posix ?? win)?.[1];
    if (!inner) return s;
    // The wrapped command is itself quoted; peel one balanced layer, never more.
    const t = inner.trim();
    const first = t[0];
    if ((first === '"' || first === "'") && t.length >= 2 && t[t.length - 1] === first) {
        return t.slice(1, -1).trim() || s;
    }
    return t;
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
            const cmd = oneLine(stripShellWrapper(item.command), 160);
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
        // Not a Codex item type: the app-server bridge synthesises this one so a steer
        // (Claude interrupting a running turn) is visible in the activity list. It carries its
        // text in `message`, like `error` does — hence the shared arm.
        case 'claude_steer':
            return oneLine(item.message, 200) || kind;
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
    // A steer is a deliberate intervention, not a problem: it is always `done`, checked before
    // anything else so no stray `status` field on the synthesised item can downgrade it to
    // warn/failed. Unlike `error` below, it must never be painted as a fault.
    if (item?.type === 'claude_steer') return 'done';
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
    const rawId = typeof item?.id === 'string' && item.id ? item.id : `anon_${st.items.length}`;
    // Namespace by turn so a followup's `item_0` cannot land on turn 1's `item_0`. Turn 1 is
    // left bare on purpose: every single-turn run keeps the exact ids it had before, and the
    // panel's `stamp + ' ' + id` details key stays stable across the fix.
    const id = st.turnSeq > 1 ? `t${st.turnSeq}:${rawId}` : rawId;
    const kind = String(item?.type ?? 'unknown');
    const existing = st.items.find(i => i.id === id);
    const label = labelFor(item);
    // `claude_steer` is included because a steer can be a long paragraph: without a body the
    // row would be clipped at 200 chars with no way to read the rest.
    const body = (kind === 'agent_message' || kind === 'reasoning' || kind === 'error' || kind === 'claude_steer')
        ? clipBody(item.text ?? item.message)
        : undefined;
    const status = statusFor(item, completed);
    const raw = kind === 'command_execution' ? oneLine(item.command, 600) || undefined : undefined;

    if (existing) {
        existing.kind = kind;
        existing.status = status;
        if (label) existing.label = label;
        if (body) existing.body = body;
        if (raw) existing.raw = raw;
        if (completed) existing.lastSeenMs = nowMs;
    } else {
        // `turn` is set here and only here — see CodexRunItem.turn for why an update must not
        // touch it.
        st.items.push({ id, turn: st.turnSeq, kind, status, label, body, raw, firstSeenMs: nowMs, lastSeenMs: completed ? nowMs : undefined });
    }

    if (kind === 'todo_list' && Array.isArray(item.items)) {
        st.todo = item.items.map((t: any) => ({ text: oneLine(t?.text, 120), done: !!t?.completed }));
    }
}

/**
 * Event types that prove a turn is producing something. Unknown types are excluded: they are
 * no evidence that a new turn began, and rolling over on one would strand the real first item.
 */
const TURN_OPENING_TYPES = new Set([
    'thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'error',
]);

/**
 * Whether an event that is otherwise turn-opening should actually open a turn.
 *
 * `claude_steer` is the one exception, and the asymmetry is the point:
 *
 * - A steer is by definition pushed into a turn that is *already running*, so it can never be
 *   a turn's first event. But the bridge emits it as `item.completed`, and one caller flushes
 *   leftover steers after `turn.completed` has already been written ("the turn had already
 *   ended, so this never reached Codex"). Counted as turn-opening, a single-turn run grows a
 *   phantom turn 2 holding nothing but that one rejection card, and the panel — which draws
 *   headers as soon as any item reports a turn above 1 — starts numbering a run that only
 *   ever had one question.
 * - An advisory `error`, by contrast, is measured to arrive *before* `turn.started` on both
 *   the exec and app-server paths, so it has to stay turn-opening or the real first item of
 *   the new turn lands in the turn that just ended.
 */
function opensTurn(ev: any): boolean {
    if (!TURN_OPENING_TYPES.has(ev.type)) return false;
    return ev.item?.type !== 'claude_steer';
}

/**
 * Start the next turn if the previous one already went terminal.
 *
 * A followup (`codex exec resume`) appends to the SAME events file and restarts item ids at
 * `item_0`, so without a turn boundary the second turn overwrote the first through `upsert`'s
 * id lookup — activities vanished, and an id reused for a different item type even flipped the
 * surviving row's kind.
 *
 * The boundary is taken from the *previous* turn's terminal event rather than from
 * `turn.started`, because `turn.started` is not the first line of a turn: measured runs emit an
 * advisory `error` item as `item_0` just before it, which would then be filed under the turn
 * that had already ended.
 *
 * A single-turn run never reaches this — its terminal event is the last line of the file — so
 * the state it produces is identical to what it was before turns existed.
 */
function openTurnIfPending(st: CodexRunState): void {
    if (!st.pendingTurnBreak) return;
    st.pendingTurnBreak = false;
    st.turnSeq++;
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

    if (opensTurn(ev)) openTurnIfPending(st);

    switch (ev.type) {
        case 'thread.started':
            if (typeof ev.thread_id === 'string') st.threadId = ev.thread_id;
            return;
        case 'turn.started':
            st.turnStarted = true;
            // A followup is working again, so the previous turn's verdict no longer describes
            // the run. Leaving it set kept `decidePhase` on "finalizing" for the whole rerun,
            // even though send.sh had already flipped its status back to running.
            st.terminal = 'none';
            st.failureMessage = undefined;
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
            st.pendingTurnBreak = true;
            // NOT accumulated: `usage` on a followup's `turn.completed` is already the running
            // session total (measured: 293,443 → 546,777 input tokens), so summing double-counts.
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
            st.pendingTurnBreak = true;
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
