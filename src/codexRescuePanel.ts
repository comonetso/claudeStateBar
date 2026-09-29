import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import type { RunPhase } from './providers/codexRescue/runDiscovery';
import { registerActivityTab, showActivityPanel, isActivityPanelOpen, postToActivityTab } from './activityPanel';

// Live view of codex_rescue runs — the Codex counterpart to the Claude workflow view.
//
// One tab of the shared activity panel (activityPanel.ts); the webview side lives in
// media/codexruns.js and codexruns.css. It is its own tab rather than extra cards in the
// workflow tab because the two model different things: a Claude workflow is a fan-out of
// agents with phases, while a Codex run is one linear turn whose activities are tool calls.

export interface CodexItemView {
    id: string;
    kind: string;                              // agent_message | command_execution | claude_steer | ...
    status: 'running' | 'done' | 'failed' | 'warn';
    label: string;
    body?: string;                             // prose for agent_message / reasoning / error
    /** command_execution only: the wrapped command as it ran. Hover text; label is stripped. */
    raw?: string;
    durationMs?: number;
    /**
     * Which turn of the run produced this item, counting from 1. Optional because a run
     * recorded before turns were tracked has none — the panel reads it as 1. The panel only
     * draws turn headers when some item reports a turn above 1, so single-turn runs look
     * exactly as they did before.
     */
    turn?: number;
}

export interface CodexRunView {
    stamp: string;
    slug: string;
    /** Card heading when present; the slug is the fallback for runs recorded without one. */
    subject?: string;
    /** URI string of the working tree the run lives in — which folder a delete acts on. */
    root?: string;
    /**
     * Set when that tree is not a folder this window has open (another worktree of the same
     * repository): the tree's folder name, shown as a chip, and its full path for the hover.
     */
    tag?: string;
    tagPath?: string;
    mode: string;
    phase: RunPhase;
    startedAt?: number;
    endedAt?: number;
    threadId?: string;
    /** From the Codex rollout's turn_context — the latest turn's, so a follow-up that switched shows the switch. */
    model?: string;
    effort?: string;
    items: CodexItemView[];
    todo?: { text: string; done: boolean }[];
    /** Only known once the turn completes — exec JSONL has no live token counter. */
    totalTokens?: number;
    /**
     * Present when the run's own doc exists on disk; clicking opens it. A URI *string*, not
     * a filesystem path: over Remote-SSH the doc lives on the remote host and only the URI
     * (scheme + authority) can still address it once it reaches the webview and comes back.
     */
    resultUri?: string;
    requestUri?: string;
    /**
     * Multi-turn only. Requests are separate files per turn; the result is one document that
     * every turn appends to, so each entry carries an anchor into it rather than its own URI.
     * startedAt/endedAt are that turn's own clock; either is absent when it could not be read.
     */
    turnDocs?: { turn: number; requestUri?: string; resultAnchor?: string; startedAt?: number; endedAt?: number }[];
    staleForMs?: number;
    /** Documents survive but the event log is gone — the card exists to reach the documents. */
    docsOnly?: boolean;
}

/** One trashed run as the panel lists it. Mirrors TrashedRun from runDiscovery. */
export interface CodexTrashView {
    stamp: string;
    slug: string;
    subject?: string;
    deletedAt: number;
    fileCount: number;
    bytes: number;
    docsIncluded: boolean;
    hasLogs: boolean;
    hasDocs: boolean;
}

export interface CodexPanelCallbacks {
    onOpenDoc: (docUri: string, anchor?: string) => void;
    /** User clicked a run's delete button (confirmation happens on the extension side). */
    onDelete: (stamp: string) => void;
    /** User opened the trash drawer — the host answers with pushTrash(). */
    onTrashOpen: () => void;
    onRestore: (stamp: string) => void;
    onPurge: (stamp: string) => void;
    onEmptyTrash: () => void;
}

let callbacks: CodexPanelCallbacks | null = null;
let lastPushedSignature: string | null = null;
// Latest list handed over, kept across a close so a reopened panel shows it at once. Null until
// the first scan: the tab then opens on its "loading…" line and fills in when one lands.
let lastRuns: CodexRunView[] | null = null;

/** Kept for existing callers. The runs are a tab now, so this is simply "is the panel open". */
export function isCodexPanelOpen(): boolean { return isActivityPanelOpen(); }

// Moved to core/ (2026-09-30) and re-exported so existing imports keep working.
export { workspaceLabel } from './core/workspaceLabel';

// Same dedup contract as the workflow panel: re-pushing identical data would rebuild the
// DOM and snap shut whatever the user expanded. A finished run's signature is stable, so it
// stops re-rendering; a live one keeps changing and keeps updating.
function signature(runs: CodexRunView[]): string {
    return JSON.stringify((runs || []).map(r => ({
        s: r.stamp, g: r.tag || '', p: r.phase, e: r.endedAt || 0, t: r.totalTokens || 0,
        d: r.todo, k: r.staleForMs ? Math.floor(r.staleForMs / 5000) : 0,
        r: !!r.resultUri, m: (r.model || '') + '/' + (r.effort || ''),
        i: r.items.map(i => [i.id, i.status, i.label, i.body, i.durationMs, i.turn || 1]),
        w: (r.turnDocs || []).map(d => [d.startedAt || 0, d.endedAt || 0]),
    })));
}

/**
 * Opens without waiting for a scan (user's call, 2026-09-25: panels must never open late). Pass
 * what is already known, or null; the caller starts a scan and `pushRuns` fills the tab in.
 */
export function createOrShowCodexPanel(
    context: vscode.ExtensionContext,
    runs: CodexRunView[] | null,
    cb: CodexPanelCallbacks
): void {
    attachCodexTab(runs, cb);
    showActivityPanel(context, 'codexRuns');
}

/**
 * Hand the tab its callbacks and whatever is already known, pushing it if the panel is open.
 * Never creates, reveals or switches the panel — the host calls this for every tab.
 */
export function attachCodexTab(runs: CodexRunView[] | null, cb: CodexPanelCallbacks): void {
    callbacks = cb;
    if (runs) lastRuns = runs;
    if (isActivityPanelOpen() && lastRuns) pushRuns(lastRuns);
}

/** Hand the trash drawer its contents. Unconditional: the drawer is only open on request. */
export function pushTrash(items: CodexTrashView[]): void {
    postToActivityTab('codexRuns', { type: 'trash', items });
}

export function pushRuns(runs: CodexRunView[]): void {
    lastRuns = runs;
    if (!isActivityPanelOpen()) return;
    const sig = signature(runs);
    if (sig === lastPushedSignature) return;
    lastPushedSignature = sig;
    postToActivityTab('codexRuns', { type: 'runs', runs });
}

function onMessage(msg: any): void {
    if (msg?.type === 'ready') {
        const lang = creds.getLanguage();
        postToActivityTab('codexRuns', { type: 'i18n', dict: getDict(lang), lang });
        lastPushedSignature = null;
        if (lastRuns) pushRuns(lastRuns);
    } else if (msg?.type === 'open' && typeof msg.path === 'string') {
        callbacks?.onOpenDoc(msg.path, typeof msg.anchor === 'string' ? msg.anchor : undefined);
    } else if (msg?.type === 'delete' && typeof msg.stamp === 'string') {
        callbacks?.onDelete(msg.stamp);
    } else if (msg?.type === 'trashOpen') {
        callbacks?.onTrashOpen();
    } else if (msg?.type === 'restore' && typeof msg.stamp === 'string') {
        callbacks?.onRestore(msg.stamp);
    } else if (msg?.type === 'purge' && typeof msg.stamp === 'string') {
        callbacks?.onPurge(msg.stamp);
    } else if (msg?.type === 'emptyTrash') {
        callbacks?.onEmptyTrash();
    }
}

function onDispose(): void {
    lastPushedSignature = null;
}

// The pane's markup; media/codexruns.js looks its ids up with the cx- prefix. No title and no
// workspace-path row — the shell shows the path once, beside the tab bar.
function bodyHtml(): string {
    return `
  <div class="toolbar">
    <button class="fbtn" data-trash="toggle"><span data-i18n="cx.trash.btn">🗑 Trash</span></button>
    <span class="spacer"></span>
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <div class="sub" id="cx-sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="cx-trash" class="trash" style="display:none">
    <div class="trash-head">
      <strong data-i18n="cx.trash.title">Trash</strong>
      <span class="trash-note" data-i18n="cx.trash.note">Deleted runs are kept here until you empty it.</span>
      <span class="spacer"></span>
      <button class="fbtn" data-trash="empty" data-i18n="cx.trash.empty">Empty trash</button>
    </div>
    <div id="cx-trash-list"></div>
  </div>
  <div id="cx-list"><div class="empty" data-i18n="wf.loading">Loading…</div></div>
`;
}

registerActivityTab({
    id: 'codexRuns',
    css: 'codexruns.css',
    js: 'codexruns.js',
    bodyHtml,
    onMessage,
    onDispose,
});
