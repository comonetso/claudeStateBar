import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import { workspaceLabel } from './codexRescuePanel';

// The background task panel, in the sessions the status bar shows: commands Claude ran with
// `run_in_background` and monitors in one group, ordinary commands that ran long in another. The
// point, in the user's words (2026-09-22), is to see what ran in the background and which commands
// took long. Modelled on the remote-control view's background list minus what that list mixes
// in — workflows keep their own panel, and commands a workflow's agents started are left out. It
// only watches: nothing on disk records a process id, so there is no safe way to stop a task from
// here. The script and stylesheet live in media/bgtasks.{js,css}, for the reason workflowPanel.ts gives.

export interface BgTaskView {
    key: string;
    taskId: string;
    kind: 'command' | 'monitor' | 'foreground';
    description: string;
    command: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
    startedAt: number;
    endedAt?: number;
    exitCode?: number;
    summary?: string;
    /** First eight characters of the session id. */
    session: string;
    eventCount: number;
    /**
     * The output, when it was sent: a running background task always, anything finished once the
     * user opens it. Null when the file is gone. Absent when not sent — and always absent for a
     * running foreground command, whose output is only recorded when it ends.
     */
    output?: string | null;
}

export type BgTaskGroupId = 'background' | 'long';

export interface BgTaskGroup {
    running: BgTaskView[];
    /** Newest first, at most the limit the host applies. */
    finished: BgTaskView[];
    /** Finished tasks there are in all, cleared ones excluded. */
    finishedTotal: number;
}

export interface BgTaskPanelData {
    background: BgTaskGroup;
    long: BgTaskGroup;
    /** How long an ordinary command must run to be listed, in minutes. */
    longMinutes: number;
}

export interface BgTaskPanelCallbacks {
    /** A finished group's trash button: hide that group's finished tasks from the list. */
    onClearFinished: (group: BgTaskGroupId) => void;
    /** The user opened a finished card — answer by pushing its output. */
    onOpen: (key: string) => void;
    onClose: (key: string) => void;
}

let panel: vscode.WebviewPanel | null = null;
let callbacks: BgTaskPanelCallbacks | null = null;
let lastPushedSignature: string | null = null;
const emptyGroup = (): BgTaskGroup => ({ running: [], finished: [], finishedTotal: 0 });
let lastData: BgTaskPanelData = { background: emptyGroup(), long: emptyGroup(), longMinutes: 0 };
const openCards = new Set<string>();

export function isBgTaskPanelOpen(): boolean { return panel !== null; }
export function getOpenBgTaskKeys(): string[] { return [...openCards]; }

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

function panelTitle(): string {
    const v = getDict(creds.getLanguage())['bg.panelTitle'];
    const base = typeof v === 'string' ? v : 'Claude Background Tasks';
    const ws = workspaceLabel();
    return ws ? `${base} · ${ws.short}` : base;
}

export function createOrShowBgTaskPanel(
    context: vscode.ExtensionContext,
    data: BgTaskPanelData,
    cb: BgTaskPanelCallbacks
): void {
    callbacks = cb;
    lastData = data;
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        pushBgTasks(data);
        return;
    }
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel = vscode.window.createWebviewPanel(
        'claudeContextBarBgTasks', panelTitle(), vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] }
    );
    lastPushedSignature = null;
    openCards.clear();
    panel.webview.html = getHtml(panel.webview, context.extensionUri);
    panel.onDidDispose(() => { panel = null; lastPushedSignature = null; openCards.clear(); }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
        const k = typeof msg?.key === 'string' ? msg.key : '';
        switch (msg?.type) {
            case 'ready':
                panel?.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
                lastPushedSignature = null;
                pushBgTasks(lastData);
                break;
            case 'clearFinished':
                if (msg?.group === 'background' || msg?.group === 'long') callbacks?.onClearFinished(msg.group);
                break;
            case 'open': if (k) { openCards.add(k); callbacks?.onOpen(k); } break;
            case 'close': if (k) { openCards.delete(k); callbacks?.onClose(k); } break;
        }
    }, null, context.subscriptions);
}

export function pushBgTasks(data: BgTaskPanelData): void {
    lastData = data;
    if (!panel) return;
    const sig = JSON.stringify(data);
    if (sig === lastPushedSignature) return;
    lastPushedSignature = sig;
    panel.webview.postMessage({ type: 'tasks', data });
}

export function pushBgTaskLanguage(): void {
    if (!panel) return;
    panel.title = panelTitle();
    panel.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
}

function escHtml(s: string): string {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'bgtasks.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'bgtasks.js'));
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
    <span class="spacer"></span>
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <h1 data-i18n="bg.title">⏳ Claude Background Tasks</h1>
${wsRow}  <div class="scope" id="scope"></div>
  <div class="sub" id="sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="list"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
