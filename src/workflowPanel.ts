import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import { registerActivityTab, showActivityPanel, isActivityPanelOpen, postToActivityTab } from './activityPanel';
import type { AgentActivityItem } from './providers/claude/agentActivity';

// The Workflows tab of the activity panel (activityPanel.ts, 2026-09-30 — it was a panel of its
// own until then). Since 2026-09-19 it lists the whole project's workflows and reads like the
// Codex tab — same cards, same rows, same finished-group and trash — by the user's call. The
// webview's script and stylesheet live in media/workflows.{js,css}, as with the status panel:
// a script inside a host template literal is invisible to tsc, and one stray backtick there has
// broken a panel at runtime four times (see project memory).

export interface WorkflowAgentView {
    /** Handed back when the panel opens the agent; the host checks it against what it sent. */
    akey: string;
    agentId: string;
    status: 'running' | 'done' | 'stopped';
    summary: string;
    durationMs: number;
    /** Epoch ms of the agent's first log entry: a running agent's clock counts from here. */
    startedAt?: number;
    name?: string;
    fullName?: string;
    tokens?: number;
    model?: string;
    phase?: string;
    hasReport: boolean;
}

export interface WorkflowView {
    key: string;
    wfId: string;
    name: string;
    description: string;
    phases: string[];
    startedAt?: number;
    endedAt?: number;
    /** An Agent-tool batch rather than a Workflow run. */
    isTask: boolean;
    /** First eight characters of the session id, for telling sessions apart. */
    session: string;
    /** Whether that session is one this window is showing right now. */
    sessionLive: boolean;
    agents: WorkflowAgentView[];
}

export interface WorkflowTrashView {
    key: string;
    wfId: string;
    name?: string;
    deletedAt: number;
    agentCount: number;
}

export interface WorkflowPanelCallbacks {
    onDelete: (key: string) => void;
    onTrashOpen: () => void;
    onRestore: (key: string) => void;
    onPurge: (key: string) => void;
    onEmptyTrash: () => void;
    /** The panel opened an agent — answer with pushAgentActivity(). */
    onAgentOpen: (akey: string) => void;
}

let callbacks: WorkflowPanelCallbacks | null = null;
// Last payload actually posted. Polling re-pushes the same data every refresh; skipping an
// identical one keeps the webview from rebuilding under the user's hands for nothing.
let lastPushedSignature: string | null = null;
// Null until the first project scan: the tab then opens on its loading line (see createOrShow).
let lastWorkflows: WorkflowView[] | null = null;
// Whether lastWorkflows is the list saved from an earlier window, shown until this window's first
// scan lands (user's call, 2026-10-01). The tab says so above the list.
let lastSaved = false;
// Agents the user has open. Their rows are re-read while they run, so the host needs to know.
const openAgents = new Set<string>();

/** Whether the activity panel (which holds this tab) is open, whichever tab it shows. */
export function isWorkflowPanelOpen(): boolean { return isActivityPanelOpen(); }
export function getOpenAgentKeys(): string[] { return [...openAgents]; }

/**
 * Opens without waiting for the project scan (user's call, 2026-09-25: panels must never open
 * late). Pass what is already known, or null; the caller scans and `pushWorkflows` fills it in.
 */
export function createOrShowWorkflowPanel(
    context: vscode.ExtensionContext,
    workflows: WorkflowView[] | null,
    cb: WorkflowPanelCallbacks
): void {
    attachWorkflowTab(workflows, cb);
    showActivityPanel(context, 'workflows');
}

/**
 * Sets the callbacks and data without creating, revealing or switching to the panel; pushes the
 * data if the panel is already open. The host calls this for every tab when the panel is created.
 */
export function attachWorkflowTab(workflows: WorkflowView[] | null, cb: WorkflowPanelCallbacks): void {
    callbacks = cb;
    if (workflows) { lastWorkflows = workflows; lastSaved = false; }
    if (lastWorkflows) pushWorkflows(lastWorkflows, lastSaved);
}

function handleMessage(msg: any): void {
    const k = typeof msg?.key === 'string' ? msg.key : '';
    const ak = typeof msg?.akey === 'string' ? msg.akey : '';
    switch (msg?.type) {
        case 'ready':
            postToActivityTab('workflows', { type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
            lastPushedSignature = null;
            if (lastWorkflows) pushWorkflows(lastWorkflows, lastSaved);
            break;
        case 'delete': if (k) callbacks?.onDelete(k); break;
        case 'trashOpen': callbacks?.onTrashOpen(); break;
        case 'restore': if (k) callbacks?.onRestore(k); break;
        case 'purge': if (k) callbacks?.onPurge(k); break;
        case 'emptyTrash': callbacks?.onEmptyTrash(); break;
        case 'agentOpen': if (ak) { openAgents.add(ak); callbacks?.onAgentOpen(ak); } break;
        case 'agentClose': if (ak) openAgents.delete(ak); break;
    }
}

function handleDispose(): void {
    lastPushedSignature = null;
    openAgents.clear();
}

/** @param saved the list saved from an earlier window, not yet replaced by this window's scan. */
export function pushWorkflows(workflows: WorkflowView[], saved = false): void {
    lastWorkflows = workflows;
    lastSaved = saved;
    if (!isActivityPanelOpen()) return;
    const sig = (saved ? 'saved:' : '') + JSON.stringify(workflows);
    if (sig === lastPushedSignature) return;
    lastPushedSignature = sig;
    postToActivityTab('workflows', { type: 'workflows', workflows, saved });
}

export function pushWorkflowTrash(items: WorkflowTrashView[]): void {
    postToActivityTab('workflows', { type: 'trash', items });
}

export function pushAgentActivity(akey: string, items: AgentActivityItem[], report: string): void {
    postToActivityTab('workflows', { type: 'activity', akey, items, report });
}

// The pane's markup. The title and workspace-path rows are gone: the shell shows the path once,
// above the tabs. Every id carries the tab's prefix (ids are document-wide across the four tabs).
function bodyHtml(): string {
    return `  <div class="toolbar">
    <button class="fbtn" data-trash="toggle"><span data-i18n="wf.trash.btn">🗑 Trash</span></button>
    <span class="spacer"></span>
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <div class="sub" id="wf-sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="wf-trash" class="trash" style="display:none">
    <div class="trash-head">
      <strong data-i18n="wf.trash.title">Trash</strong>
      <span class="trash-note" data-i18n="wf.trash.note">Deleted workflows stay here until you empty it.</span>
      <span class="spacer"></span>
      <button class="fbtn" data-trash="empty" data-i18n="wf.trash.empty">Empty trash</button>
    </div>
    <div id="wf-trash-list"></div>
  </div>
  <div id="wf-list"><div class="empty" data-i18n="wf.loading">Loading…</div></div>
`;
}

registerActivityTab({
    id: 'workflows',
    css: 'workflows.css',
    js: 'workflows.js',
    bodyHtml,
    onMessage: handleMessage,
    onDispose: handleDispose,
});
