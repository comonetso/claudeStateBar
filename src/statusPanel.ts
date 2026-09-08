// Claude Status panel — one webview with tabs for plan usage and lifetime stats.
//
// Deliberately built the way settingsPanel is built, NOT the way workflowPanel /
// codexRescuePanel are: the webview's script and stylesheet live in media/ as real
// files instead of being inlined into a template literal. Those inline panels have
// cost us four separate outages from a stray backtick inside the template (the JS
// compiles fine and then splits in two at runtime). With media/status.js as its own
// file that whole class of bug cannot occur — and the file is a normal .js that an
// editor lints properly.
//
// The panel is a pure viewer: it reads, it never writes. Everything it shows comes
// from claudeStats.ts (local disk) and from the plan-usage snapshot the extension
// already fetches for the status bar.

import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';

export interface StatusPanelCallbacks {
    /** The webview asked for fresh data (first paint, tab switch, or manual refresh). */
    onRefreshRequested: () => void;
}

let panel: vscode.WebviewPanel | null = null;
let callbacks: StatusPanelCallbacks | null = null;
// Last payload pushed. A re-opened panel repaints from this immediately so the user
// never stares at an empty panel while the (cheap, but not instant) rescan runs.
let lastPayload: unknown = null;

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

export function isStatusPanelOpen(): boolean {
    return panel !== null;
}

export function createOrShowStatusPanel(
    context: vscode.ExtensionContext,
    cb: StatusPanelCallbacks
): void {
    callbacks = cb;

    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        // Already open — the user clicked the menu entry again, which reads as
        // "show me the current numbers", so re-scan rather than leaving stale ones.
        callbacks.onRefreshRequested();
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'claudeContextBarStatus',
        'Claude Status',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        }
    );

    panel.webview.html = getHtml(panel.webview, context.extensionUri);

    panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(
        (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'ready') {
                // Send the dictionary first so the first paint is already localised.
                pushLanguage();
                if (lastPayload) panel?.webview.postMessage({ type: 'data', payload: lastPayload });
                callbacks?.onRefreshRequested();
            } else if (msg.type === 'refresh') {
                callbacks?.onRefreshRequested();
            } else if (msg.type === 'openSettings') {
                vscode.commands.executeCommand('claudeContextBar.openSettings');
            }
        },
        null,
        context.subscriptions
    );
}

/** Push a fully-built view model to the panel. No-op when the panel is closed. */
export function pushStatus(payload: unknown): void {
    lastPayload = payload;
    if (!panel) return;
    panel.webview.postMessage({ type: 'data', payload });
}

/** Re-send the dictionary — called on first paint and whenever the language changes. */
export function pushLanguage(): void {
    if (!panel) return;
    panel.webview.postMessage({ type: 'lang', dict: getDict(creds.getLanguage()) });
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'status.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'status.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    // No <script> body lives in this template — only a src= reference — so the
    // backtick hazard that check-webview.js guards against does not apply here.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>Claude Status</title>
</head>
<body>
  <div class="container">
    <h1 data-i18n="cs.panel.title">Claude Status</h1>

    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="usage" data-i18n="cs.tab.usage">Usage</button>
      <button class="tab" data-tab="stats" data-i18n="cs.tab.stats">Stats</button>
    </div>

    <div class="pane" id="pane-usage"></div>
    <div class="pane" id="pane-stats" hidden></div>

    <div class="footer-note">
      <span id="footer-updated"></span>
      <button class="linklike" id="refresh-btn" data-i18n="cs.refresh">Refresh</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
