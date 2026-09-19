import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import { workspaceLabel } from './codexRescuePanel';
import type { AgentActivityItem } from './providers/claude/agentActivity';

// The workflow panel. Since 2026-09-19 it lists the whole project's workflows and reads like the
// Codex panel — same cards, same rows, same finished-group and trash — by the user's call. The
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

let panel: vscode.WebviewPanel | null = null;
let callbacks: WorkflowPanelCallbacks | null = null;
// Last payload actually posted. Polling re-pushes the same data every refresh; skipping an
// identical one keeps the webview from rebuilding under the user's hands for nothing.
let lastPushedSignature: string | null = null;
let lastWorkflows: WorkflowView[] = [];
// Agents the user has open. Their rows are re-read while they run, so the host needs to know.
const openAgents = new Set<string>();

export function isWorkflowPanelOpen(): boolean { return panel !== null; }
export function getOpenAgentKeys(): string[] { return [...openAgents]; }

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

function panelTitle(): string {
    const v = getDict(creds.getLanguage())['wf.panelTitle'];
    const base = typeof v === 'string' ? v : 'Claude Workflows';
    const ws = workspaceLabel();
    return ws ? `${base} · ${ws.short}` : base;
}

export function createOrShowWorkflowPanel(
    context: vscode.ExtensionContext,
    workflows: WorkflowView[],
    cb: WorkflowPanelCallbacks
): void {
    callbacks = cb;
    lastWorkflows = workflows;
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        pushWorkflows(workflows);
        return;
    }
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel = vscode.window.createWebviewPanel(
        'claudeContextBarWorkflows', panelTitle(), vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] }
    );
    lastPushedSignature = null;
    openAgents.clear();
    panel.webview.html = getHtml(panel.webview, context.extensionUri);
    panel.onDidDispose(() => { panel = null; lastPushedSignature = null; openAgents.clear(); }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
        const k = typeof msg?.key === 'string' ? msg.key : '';
        const ak = typeof msg?.akey === 'string' ? msg.akey : '';
        switch (msg?.type) {
            case 'ready':
                panel?.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
                lastPushedSignature = null;
                pushWorkflows(lastWorkflows);
                break;
            case 'delete': if (k) callbacks?.onDelete(k); break;
            case 'trashOpen': callbacks?.onTrashOpen(); break;
            case 'restore': if (k) callbacks?.onRestore(k); break;
            case 'purge': if (k) callbacks?.onPurge(k); break;
            case 'emptyTrash': callbacks?.onEmptyTrash(); break;
            case 'agentOpen': if (ak) { openAgents.add(ak); callbacks?.onAgentOpen(ak); } break;
            case 'agentClose': if (ak) openAgents.delete(ak); break;
        }
    }, null, context.subscriptions);
}

export function pushWorkflows(workflows: WorkflowView[]): void {
    lastWorkflows = workflows;
    if (!panel) return;
    const sig = JSON.stringify(workflows);
    if (sig === lastPushedSignature) return;
    lastPushedSignature = sig;
    panel.webview.postMessage({ type: 'workflows', workflows });
}

export function pushWorkflowTrash(items: WorkflowTrashView[]): void {
    panel?.webview.postMessage({ type: 'trash', items });
}

export function pushAgentActivity(akey: string, items: AgentActivityItem[], report: string): void {
    panel?.webview.postMessage({ type: 'activity', akey, items, report });
}

export function pushLanguage(): void {
    if (!panel) return;
    panel.title = panelTitle();
    panel.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
}

function escHtml(s: string): string {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'workflows.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'workflows.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const ws = workspaceLabel();
    const wsRow = ws
        ? `  <div class="wspath" title="${escHtml(ws.full)}">${escHtml(ws.full.replace(/\n/g, '   ·   '))}</div>\n`
        : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="toolbar">
    <button class="fbtn" data-trash="toggle"><span data-i18n="wf.trash.btn">🗑 Trash</span></button>
    <span class="spacer"></span>
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <h1 data-i18n="wf.title">⚡ Claude Workflows</h1>
${wsRow}  <div class="sub" id="sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="trash" class="trash" style="display:none">
    <div class="trash-head">
      <strong data-i18n="wf.trash.title">Trash</strong>
      <span class="trash-note" data-i18n="wf.trash.note">Deleted workflows stay here until you empty it.</span>
      <span class="spacer"></span>
      <button class="fbtn" data-trash="empty" data-i18n="wf.trash.empty">Empty trash</button>
    </div>
    <div id="trash-list"></div>
  </div>
  <div id="list"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
