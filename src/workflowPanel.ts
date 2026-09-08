import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';

// A workflow agent's live state, mirrored from journal.jsonl (started/result records).
export interface WorkflowAgentView {
    agentId: string;
    status: 'running' | 'done' | 'stopped';  // stopped = killed/interrupted
    summary: string;        // 160-char preview
    fullSummary?: string;   // untruncated full text — expandable via <details> on done agents
    durationMs: number;
    name?: string;          // display label (Task agents); undefined → "에이전트 N"
    fullName?: string;      // untruncated role/task text — shown as a hover tooltip on the label
    tokens?: number;        // tokens this agent used (Claude Code's own totalTokens definition)
    model?: string;         // raw model id, e.g. claude-opus-5
    phase?: string;         // phase recovered from the script; undefined → not grouped
}

export interface WorkflowView {
    wfId: string;
    name: string;
    description: string;
    phases: string[];
    agents: WorkflowAgentView[];
    startedAt?: number;  // epoch ms — workflow start clock shown next to the title
    endedAt?: number;    // epoch ms — final elapsed (endedAt - startedAt) once all agents are done
}

/** One trashed workflow as the panel lists it. */
export interface WorkflowTrashView {
    wfId: string;
    name?: string;
    deletedAt: number;
    agentCount: number;
}

export interface WorkflowPanelCallbacks {
    // Called when the user clicks a workflow's delete button (after they confirm).
    onDelete: (wfId: string) => void;
    /** User opened the trash drawer — the host answers with pushWorkflowTrash(). */
    onTrashOpen: () => void;
    onRestore: (wfId: string) => void;
    onPurge: (wfId: string) => void;
    onEmptyTrash: () => void;
}

let panel: vscode.WebviewPanel | null = null;
let callbacks: WorkflowPanelCallbacks | null = null;
// The session whose workflows the panel is currently showing. extension.ts reads this
// each refresh so it knows which session to re-scan and push.
let trackedSessionFile: string | null = null;
// Signature of the last payload actually posted to the webview. Polling re-pushes the
// same data every refresh; for a finished workflow the data never changes, so re-rendering
// would needlessly collapse whatever the user expanded. We skip the postMessage when the
// signature is unchanged — only genuinely changed data (a running workflow advancing,
// or a workflow finishing) reaches the webview and triggers a re-render.
let lastPushedSignature: string | null = null;

// Build a content signature that captures every field the webview renders. If two scans
// produce the same signature the rendered DOM would be identical, so the push is skipped.
// A still-running workflow's summary / duration keeps changing → its signature changes →
// it keeps updating. Only data that is byte-for-byte stable (i.e. finished, no longer
// mutating) collapses to a stable signature and stops re-rendering.
function workflowsSignature(workflows: WorkflowView[]): string {
    return JSON.stringify((workflows || []).map(wf => ({
        i: wf.wfId,
        n: wf.name,
        d: wf.description,
        p: wf.phases,
        s: wf.startedAt || 0,
        // endedAt only matters once finished; the running→done status flip already changes the
        // signature, so we don't include endedAt here (avoids re-render churn while running).
        // Include summary/duration: a RUNNING agent's live activity must keep updating in the
        // panel — that's what the user watches mid-run (more important than mid-run expand).
        // A finished agent stops changing → its signature stabilises → no re-render → an
        // expanded report stays open. So running = live updates, done = stable & expandable.
        a: wf.agents.map(a => [a.agentId, a.status, a.summary, a.fullSummary, a.durationMs, a.name, a.fullName, a.tokens, a.model, a.phase]),
    })));
}

export function getTrackedSessionFile(): string | null {
    return panel ? trackedSessionFile : null;
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

// Open (or reveal) the workflow panel for a given session and render the initial data.
export function createOrShowWorkflowPanel(
    context: vscode.ExtensionContext,
    sessionFile: string,
    workflows: WorkflowView[],
    cb: WorkflowPanelCallbacks
): void {
    trackedSessionFile = sessionFile;
    callbacks = cb;

    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        // The webview already holds rendered state, so the normal dedup applies — only push
        // if the data actually changed since the last push.
        pushWorkflows(workflows);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'claudeContextBarWorkflows',
        'Claude Workflows',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    // Brand-new webview: clear the dedup baseline so the very first push always lands,
    // even if the data matches what a previous (now-disposed) panel last showed.
    lastPushedSignature = null;
    panel.webview.html = getHtml(panel.webview);
    panel.onDidDispose(() => { panel = null; trackedSessionFile = null; lastPushedSignature = null; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
        // The webview signals 'ready' once its script loads; its DOM is empty until the first
        // render, so send the i18n dict first, then force that render through.
        if (msg?.type === 'ready') {
            panel?.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
            lastPushedSignature = null; pushWorkflows(workflows);
        }
        else if (msg?.type === 'delete' && typeof msg.wfId === 'string') callbacks?.onDelete(msg.wfId);
        else if (msg?.type === 'trashOpen') callbacks?.onTrashOpen();
        else if (msg?.type === 'restore' && typeof msg.wfId === 'string') callbacks?.onRestore(msg.wfId);
        else if (msg?.type === 'purge' && typeof msg.wfId === 'string') callbacks?.onPurge(msg.wfId);
        else if (msg?.type === 'emptyTrash') callbacks?.onEmptyTrash();
    }, null, context.subscriptions);
}

/** Hand the trash drawer its contents. Unconditional: the drawer is only open on request. */
export function pushWorkflowTrash(items: WorkflowTrashView[]): void {
    if (!panel) return;
    panel.webview.postMessage({ type: 'trash', items });
}

// Push fresh workflow data into the open panel. No-op when the panel is closed or when
// the data is identical to what was last pushed (see lastPushedSignature). The dedup is the
// primary fix for "auto-refresh collapses the card I just expanded": a finished workflow
// re-scanned every poll yields the same signature, so the webview never re-renders and the
// user's expand/collapse state survives untouched.
export function pushWorkflows(workflows: WorkflowView[]): void {
    if (!panel) return;
    const sig = workflowsSignature(workflows);
    if (sig === lastPushedSignature) return;  // unchanged data → don't disturb the webview
    lastPushedSignature = sig;
    panel.webview.postMessage({ type: 'workflows', workflows });
}

// Push the current language's dictionary to an open panel (called when the user changes
// the language setting so the panel re-localises live without needing a reopen).
export function pushLanguage(): void {
    if (!panel) return;
    panel.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
}

function getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  .toolbar { display: flex; align-items: center; gap: 6px; justify-content: flex-end; margin-bottom: 10px; }
  .flabel { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-right: 2px; }
  .fbtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 2px 11px; cursor: pointer; font-size: 1em; line-height: 1.4; }
  .fbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  h1 { font-size: 1.2em; margin: 0 0 4px 0; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 16px; }
  .wf { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
  .wf-head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .arrow { flex-shrink: 0; width: 12px; color: var(--vscode-descriptionForeground); transition: transform 0.12s; }
  .wf.collapsed .arrow { transform: rotate(-90deg); }
  .wf-name { font-weight: 600; font-size: 1.05em; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-time { flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 0.8em; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .wf-spacer { flex: 1 1 auto; }
  .badge { font-size: 0.8em; padding: 2px 9px; border-radius: 10px; white-space: nowrap; flex-shrink: 0; }
  .badge.running { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
  .badge.done { background: var(--vscode-testing-iconPassed, #3fb950); color: #fff; }
  .badge.stopped { background: var(--vscode-descriptionForeground, #8b949e); color: var(--vscode-editor-background, #1e1e1e); }
  .del-btn { flex-shrink: 0; background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 1em; padding: 2px 6px; border-radius: 4px; }
  .del-btn:hover { background: var(--vscode-statusBarItem-errorBackground); color: #fff; }
  .wf-body { margin-top: 8px; }
  .wf.collapsed .wf-body { display: none; }
  .wf-id { color: var(--vscode-descriptionForeground); font-size: 0.8em; font-family: var(--vscode-editor-font-family); }
  .wf-desc { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin: 4px 0 8px 0; }
  .phases { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  .phase-chip { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; padding: 1px 7px; margin-right: 4px; }
  .wf-meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 3px 0 6px 0; }
  .phase-group { margin: 10px 0 0 0; }
  .phase-head { display: flex; align-items: center; gap: 8px; padding-bottom: 3px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  .phase-title { font-weight: 700; font-size: 0.88em; }
  .phase-spacer { flex: 1; }
  .phase-count { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-variant-numeric: tabular-nums; }
  .agent-spacer { flex: 1; }
  .a-model { color: var(--vscode-descriptionForeground); font-size: 0.82em; white-space: nowrap; }
  .a-tok { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .agents { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
  .agent { padding: 2px 0; font-size: 0.9em; }
  .agent-head { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot.running { background: #e3b341; animation: pulse 1.2s ease-in-out infinite; }
  .dot.done { background: #3fb950; }
  .dot.stopped { background: #8b949e; }
  .label { font-weight: 600; }
  .dur { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .stopped-tag { color: #d29922; font-size: 0.85em; font-weight: 600; }
  .summary { color: var(--vscode-descriptionForeground); margin: 3px 0 0 17px; line-height: 1.45; font-size: 0.92em; white-space: pre-wrap; word-break: break-word; }
  details.summary-wrap { margin: 3px 0 0 17px; }
  details.summary-wrap > summary { color: var(--vscode-descriptionForeground); line-height: 1.45; font-size: 0.92em; cursor: pointer; list-style: revert; white-space: pre-wrap; word-break: break-word; }
  details.summary-wrap > summary::marker { color: var(--vscode-descriptionForeground); }
  details.summary-wrap[open] > summary { color: var(--vscode-foreground); font-weight: 600; }
  .full { margin: 6px 0 2px 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.88em; line-height: 1.5; max-height: 420px; overflow: auto; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* Trash drawer — the same shape as the Codex panel's, since it answers the same question. */
  .tspacer { flex:1 1 auto; }
  .trash { border:1px dashed var(--vscode-panel-border); border-radius:6px;
    padding:10px 14px; margin-bottom:14px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.06)); }
  .trash-head { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
  .trash-note { color: var(--vscode-descriptionForeground); font-size:.8em; }
  .trash-row { display:flex; align-items:baseline; gap:8px; padding:5px 0;
    border-top:1px solid var(--vscode-panel-border); }
  .trash-row:first-child { border-top:none; }
  .trash-name { font-weight:600; flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .trash-meta { color: var(--vscode-descriptionForeground); font-size:.8em; white-space:nowrap; }
  .tbtn { background:transparent; color: var(--vscode-textLink-foreground); border:1px solid var(--vscode-panel-border);
    border-radius:4px; padding:1px 9px; cursor:pointer; font-size:.85em; flex-shrink:0; }
  .tbtn:hover { background: var(--vscode-list-hoverBackground); }
  .tbtn.danger { color: var(--vscode-statusBarItem-errorBackground, #f85149); }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="fbtn" data-trash="toggle"><span data-i18n="wf.trash.btn">🗑 Trash</span></button>
    <span class="tspacer"></span>
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <h1 data-i18n="wf.title">⚡ Claude Workflows</h1>
  <div class="sub" id="sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="trash" class="trash" style="display:none">
    <div class="trash-head">
      <strong data-i18n="wf.trash.title">Trash</strong>
      <span class="trash-note" data-i18n="wf.trash.note">Deleted workflows stay here until you empty it.</span>
      <span class="tspacer"></span>
      <button class="fbtn" data-trash="empty" data-i18n="wf.trash.empty">Empty trash</button>
    </div>
    <div id="trash-list"></div>
  </div>
  <div id="list"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  // i18n: dict is pushed from the extension (settings webview pattern). t() mirrors i18n.ts t().
  // NOTE: this whole script lives inside a host template literal — the {0} substitution regex
  // MUST use doubled backslashes (\\{ \\d \\}) so the compiled webview JS gets a valid /\{(\d+)\}/g.
  let dict = {};
  let lang = 'en';
  function t(key) {
    let v = dict[key];
    if (v == null) return key;
    const args = Array.prototype.slice.call(arguments, 1);
    if (typeof v === 'string' && args.length) {
      v = v.replace(/\\{(\\d+)\\}/g, function (_, i) { const val = args[Number(i)]; return val == null ? '' : String(val); });
    }
    return v;
  }
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const v = dict[el.getAttribute('data-i18n')]; if (typeof v === 'string') el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      const v = dict[el.getAttribute('data-i18n-title')]; if (typeof v === 'string') el.title = v;
    });
  }
  // Font size — adjustable via the +/- toolbar, persisted across reloads via webview state.
  // Default 15px (≈ +2 over the VS Code 13px default) since the user finds the base too small.
  const savedState = vscodeApi.getState() || {};
  let fontPx = savedState.fontPx || 15;
  function applyFont() {
    document.body.style.fontSize = fontPx + 'px';
    vscodeApi.setState(Object.assign({}, vscodeApi.getState(), { fontPx }));
  }
  applyFont();

  let lastWorkflows = [];
  // wfId -> true(expanded)/false(collapsed); only set when the user clicks. Default
  // expansion (top one open, rest collapsed) applies when a wfId isn't in here.
  const userToggled = {};
  // Open per-agent report <details> elements, keyed "wfId agentId". innerHTML rebuilds
  // lose native <details open> state, so we record which ones are open and reapply after each
  // render — otherwise auto-refresh would snap shut the report a user expanded to read.
  const openDetails = {};
  // Signature of the data the webview last actually rendered. A second guard behind the
  // extension-side dedup: if an identical payload still arrives, skip the DOM rebuild.
  let lastRenderedSig = null;
  function sigOf(workflows) {
    return JSON.stringify((workflows || []).map(function (wf) {
      return [wf.wfId, wf.name, wf.description, wf.phases, wf.startedAt || 0,
        // Mirror workflowsSignature: include summary/duration so a running agent's live
        // activity keeps refreshing. Done agents are stable, so their expanded report stays open.
        wf.agents.map(function (a) { return [a.agentId, a.status, a.summary, a.fullSummary, a.durationMs, a.name, a.fullName, a.tokens, a.model, a.phase]; })];
    }));
  }
  function detailsKey(wfId, agentId) { return wfId + ' ' + agentId; }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function fmtDur(ms) {
    if (!ms || ms <= 0) return '';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + t('wf.unitSec');
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return m + t('wf.unitMin') + ' ' + rem + t('wf.unitSec');
  }

  function trimZero(x) { const v = x.toFixed(1); return v.slice(-2) === '.0' ? v.slice(0, -2) : v; }

  // Per-agent figure. Deliberately k/M in every language: that is what the remote-control
  // view shows, and these sit in a narrow column where a localised unit would wrap.
  function fmtTok(n) {
    if (!n || n <= 0) return '';
    if (n >= 1000000) return trimZero(n / 1000000) + 'M';
    if (n >= 1000) return trimZero(n / 1000) + 'k';
    return String(n);
  }

  // Workflow total. Korean groups by 10,000 (만), so 1,032,500 reads as 103만.
  function fmtTokTotal(n) {
    if (!n || n <= 0) return '';
    if (lang === 'ko') {
      if (n >= 10000) return Math.round(n / 10000).toLocaleString() + t('wf.unitMan');
      return n.toLocaleString();
    }
    return fmtTok(n);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  // Start clock H:i:s for the title row.
  function fmtClock(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  // Elapsed i:s (mm:ss; adds h: prefix past an hour).
  function fmtElapsed(ms) {
    if (!ms || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
  }
  // Update every .wf-time span once a second. Running workflows count up from data-started;
  // finished ones (data-done set) freeze at the final run time. Runs independently of render,
  // so the clock ticks even when the workflow data itself hasn't changed.
  function tickElapsed() {
    const now = Date.now();
    document.querySelectorAll('.wf-time[data-started]').forEach(function (el) {
      const started = Number(el.getAttribute('data-started'));
      if (!started) return;
      const clock = el.getAttribute('data-clock') || '';
      const doneEnd = el.getAttribute('data-done');
      const elapsed = doneEnd ? (Number(doneEnd) - started) : (now - started);
      const label = doneEnd ? t('wf.took') : t('wf.elapsed');
      el.textContent = '🕘 ' + clock + ' · ' + label + fmtElapsed(elapsed);
    });
  }
  setInterval(tickElapsed, 1000);

  function isExpanded(wfId, index) {
    if (wfId in userToggled) return userToggled[wfId];
    return index === 0;  // default: newest (top) expanded, rest collapsed
  }

  // Record which report <details> are currently open so we can restore them after the
  // innerHTML rebuild below wipes their native open state.
  function captureOpenDetails() {
    document.querySelectorAll('details.summary-wrap[data-dkey]').forEach(function (d) {
      openDetails[d.getAttribute('data-dkey')] = d.open;
    });
  }
  // force=true bypasses the unchanged-data skip (used for local toggle clicks, where the
  // workflow data is the same but userToggled changed).
  function render(workflows, force) {
    const incoming = workflows || [];
    const sig = sigOf(incoming);
    if (!force && sig === lastRenderedSig) { lastWorkflows = incoming; return; }
    lastRenderedSig = sig;
    // Snapshot open report panels before we blow away the DOM.
    captureOpenDetails();
    lastWorkflows = incoming;
    const list = document.getElementById('list');
    const sub = document.getElementById('sub');
    if (!lastWorkflows.length) {
      list.innerHTML = '<div class="empty">' + esc(t('wf.empty')) + '</div>';
      sub.textContent = '';
      return;
    }
    const runningWf = lastWorkflows.filter(w => w.agents.some(a => a.status === 'running')).length;
    sub.textContent = t('wf.summary', lastWorkflows.length, runningWf);
    list.innerHTML = lastWorkflows.map((wf, index) => {
      const done = wf.agents.filter(a => a.status === 'done').length;
      const stopped = wf.agents.filter(a => a.status === 'stopped').length;
      const total = wf.agents.length;
      const running = wf.agents.some(a => a.status === 'running');
      // Running takes priority (workflow still live). Once nothing is running, if any agent was
      // killed show "N done · M stopped"; otherwise the plain all-done badge.
      const badge = running
        ? '<span class="badge running">' + done + '/' + total + ' ' + esc(t('wf.running')) + '</span>'
        : stopped > 0
          ? '<span class="badge stopped">' + esc(t('wf.doneStopped', done, stopped)) + '</span>'
          : '<span class="badge done">' + done + '/' + total + ' ' + esc(t('wf.done')) + '</span>';
      // Count agents sharing each label so identical labels (e.g. role names that
      // truncate to the same 50 chars) get a number appended to stay distinguishable.
      const labelCounts = {};
      wf.agents.forEach(a => { const k = (a.name && a.name.trim()) || ''; if (k) labelCounts[k] = (labelCounts[k] || 0) + 1; });

      // Keep each agent's position in the whole workflow, so grouping does not renumber
      // the "agent N" fallback labels.
      const indexed = wf.agents.map((a, i) => ({ a: a, i: i }));
      const placedCount = wf.agents.filter(a => a.phase).length;
      // Group only when the script declared real phases AND we placed most of the agents.
      // A box holding one agent above nine loose ones is worse than no boxes at all.
      const useGroups = !!(wf.phases && wf.phases.length >= 2) && wf.agents.length > 0
        && placedCount * 2 >= wf.agents.length;

      const renderAgent = (a, i) => {
        const dur = fmtDur(a.durationMs);
        const durStr = dur ? '<span class="dur">' + (a.status === 'running' ? esc(t('wf.elapsed')) : '') + dur + '</span>' : '';
        // Killed agent - a "stopped" tag next to the label so it reads as intentionally
        // ended, not still working (the whole point of the stopped state).
        const stoppedTag = a.status === 'stopped' ? '<span class="stopped-tag">' + esc(t('wf.stopped')) + '</span>' : '';
        const nm = (a.name && a.name.trim()) || '';
        const labelText = nm ? (labelCounts[nm] > 1 ? nm + ' (' + (i + 1) + ')' : nm) : t('wf.agentN', i + 1);
        // Hover tooltip on the (50-char-clipped) label so the full role/task is readable.
        const labelTitle = (a.fullName && a.fullName.trim()) ? a.fullName : labelText;
        const modelStr = a.model ? '<span class="a-model">' + esc(a.model) + '</span>' : '';
        const tokStr = a.tokens
          ? '<span class="a-tok" title="' + esc(t('wf.tokensExact', a.tokens.toLocaleString())) + '">' + esc(fmtTok(a.tokens)) + '</span>'
          : '';
        // Full report expander: when fullSummary is meaningfully longer than the
        // 160-char preview, wrap it in <details> so the user can read the whole thing.
        let summaryHtml = '';
        const full = a.fullSummary;
        if (a.summary && full && full.length > a.summary.length) {
          const dkey = detailsKey(wf.wfId, a.agentId);
          const openAttr = openDetails[dkey] ? ' open' : '';
          summaryHtml = '<details class="summary-wrap" data-dkey="' + esc(dkey) + '"' + openAttr + '><summary>' + esc(a.summary) +
            '</summary><div class="full">' + esc(full) + '</div></details>';
        } else if (a.summary) {
          summaryHtml = '<div class="summary">' + esc(a.summary) + '</div>';
        }
        return '<div class="agent">' +
          '<div class="agent-head"><span class="dot ' + a.status + '"></span>' +
          '<span class="label" title="' + esc(labelTitle) + '">' + esc(labelText) + '</span>' + stoppedTag +
          '<span class="agent-spacer"></span>' + modelStr + tokStr + durStr + '</div>' +
          summaryHtml +
        '</div>';
      };

      // The phase chips are the flat-layout stand-in for grouping; with real groups on
      // screen they would just repeat the group headers.
      const phases = (!useGroups && wf.phases && wf.phases.length)
        ? '<div class="phases">' + wf.phases.map(p => '<span class="phase-chip">' + esc(p) + '</span>').join('') + '</div>'
        : '';

      let agents;
      if (!wf.agents.length) {
        agents = '<div class="empty">' + esc(t('wf.noAgents')) + '</div>';
      } else if (!useGroups) {
        agents = '<div class="agents">' + indexed.map(x => renderAgent(x.a, x.i)).join('') + '</div>';
      } else {
        const groups = [];
        // Script order, not start order: the order the author declared is the one the
        // user has in mind.
        wf.phases.forEach(p => {
          const mem = indexed.filter(x => x.a.phase === p);
          if (mem.length) groups.push({ title: p, items: mem });
        });
        // Anything unplaced goes last, with no icon or warning colour - it is not the
        // user's doing and there is nothing for them to act on.
        const rest = indexed.filter(x => !x.a.phase || wf.phases.indexOf(x.a.phase) < 0);
        if (rest.length) groups.push({ title: t('wf.phaseOther'), items: rest });
        agents = groups.map(g => {
          const doneN = g.items.filter(x => x.a.status === 'done').length;
          // No status-dot strip on the header: every agent row below already carries its
          // own dot, and the done/total counter says the same thing in less space.
          return '<div class="phase-group">' +
            '<div class="phase-head">' +
              '<span class="phase-title">' + esc(g.title) + '</span>' +
              '<span class="phase-spacer"></span>' +
              '<span class="phase-count">' + doneN + '/' + g.items.length + '</span>' +
            '</div>' +
            '<div class="agents">' + g.items.map(x => renderAgent(x.a, x.i)).join('') + '</div>' +
          '</div>';
        }).join('');
      }

      // Head line: how many agents and how many tokens they have used between them.
      const totalTok = wf.agents.reduce((acc, a) => acc + (a.tokens || 0), 0);
      const metaLine = wf.agents.length
        ? '<div class="wf-meta">' + esc(t('wf.headAgents', wf.agents.length)) +
          (totalTok ? ' \u00b7 ' + esc(t('wf.headTokens', fmtTokTotal(totalTok))) : '') + '</div>'
        : '';
      const expanded = isExpanded(wf.wfId, index);
      // Real workflows (wf_*) delete their whole dir; the Task pseudo-bundle ('tasks')
      // clears its COMPLETED agent logs (running ones are kept).
      const delBtn = wf.wfId.indexOf('wf_') === 0
        ? '<button class="del-btn" data-del="' + esc(wf.wfId) + '" title="' + esc(t('common.delete')) + '">🗑</button>'
        : wf.wfId.indexOf('tasks:') === 0
        ? '<button class="del-btn" data-del="' + esc(wf.wfId) + '" title="' + esc(t('wf.clearTasks')) + '">🗑</button>'
        : '';
      // Title-row clock: start time (H:i:s) + elapsed (i:s). While running, a 1s timer
      // (tickElapsed) counts up from data-started; once all agents are done, data-done holds
      // the final endedAt so the elapsed freezes at the total run time.
      // "Finished" = nothing still running (done OR stopped). A killed agent ends the
      // workflow too, so the elapsed clock must freeze on stopped as well, not only all-done.
      const allFinished = wf.agents.length > 0 && wf.agents.every(a => a.status !== 'running');
      const timeHtml = wf.startedAt
        ? '<span class="wf-time" data-started="' + wf.startedAt + '" data-clock="' + esc(fmtClock(wf.startedAt)) + '" data-done="' + (allFinished && wf.endedAt ? wf.endedAt : '') + '"></span>'
        : '';
      // Title tooltip: hovering the (possibly ellipsis-truncated) name floats the full name,
      // plus the description so a collapsed card still reveals what the workflow is on hover.
      const wfTitle = esc(wf.name) + (wf.description ? '\\n' + esc(wf.description) : '');
      return '<div class="wf' + (expanded ? '' : ' collapsed') + '" data-wfid="' + esc(wf.wfId) + '">' +
        '<div class="wf-head">' +
          '<span class="arrow">▾</span>' +
          '<span class="wf-name" title="' + wfTitle + '">' + esc(wf.name) + '</span>' +
          timeHtml +
          '<span class="wf-spacer"></span>' +
          badge +
          delBtn +
        '</div>' +
        '<div class="wf-body">' +
          (wf.wfId.indexOf('wf_') === 0 ? '<div class="wf-id">' + esc(wf.wfId) + '</div>' : '') +
          metaLine +
          (wf.description ? '<div class="wf-desc">' + esc(wf.description) + '</div>' : '') +
          phases + agents +
        '</div>' +
      '</div>';
    }).join('');
    tickElapsed();  // fill the title clocks immediately instead of waiting for the next tick
  }

  // --- Trash drawer -------------------------------------------------------
  let trashOpen = false;
  function toggleTrash() {
    trashOpen = !trashOpen;
    document.getElementById('trash').style.display = trashOpen ? '' : 'none';
    if (trashOpen) vscodeApi.postMessage({ type: 'trashOpen' });
  }
  function renderTrash(items) {
    const box = document.getElementById('trash-list');
    if (!items.length) {
      box.innerHTML = '<div class="empty">' + esc(t('wf.trash.none')) + '</div>';
      return;
    }
    box.innerHTML = items.map(function (it) {
      const when = it.deletedAt ? t('wf.trash.deletedAt', fmtClock(it.deletedAt)) : '';
      return '<div class="trash-row">' +
        '<span class="trash-name" title="' + esc(it.wfId) + '">' + esc(it.name || it.wfId) + '</span>' +
        '<span class="trash-meta">' + esc(t('wf.trash.agents', it.agentCount || 0)) + '</span>' +
        '<span class="tspacer"></span>' +
        '<span class="trash-meta">' + esc(when) + '</span>' +
        '<button class="tbtn" data-restore="' + esc(it.wfId) + '">' + esc(t('wf.trash.restore')) + '</button>' +
        '<button class="tbtn danger" data-purge="' + esc(it.wfId) + '">' + esc(t('wf.trash.purge')) + '</button>' +
      '</div>';
    }).join('');
  }

  document.addEventListener('click', e => {
    const tt = e.target.closest('[data-trash]');
    if (tt) {
      const act = tt.getAttribute('data-trash');
      if (act === 'toggle') toggleTrash();
      else if (act === 'empty') vscodeApi.postMessage({ type: 'emptyTrash' });
      return;
    }
    const rs = e.target.closest('[data-restore]');
    if (rs) { vscodeApi.postMessage({ type: 'restore', wfId: rs.getAttribute('data-restore') }); return; }
    const pg = e.target.closest('[data-purge]');
    if (pg) { vscodeApi.postMessage({ type: 'purge', wfId: pg.getAttribute('data-purge') }); return; }
    const fb = e.target.closest('[data-font]');
    if (fb) {
      fontPx = fb.getAttribute('data-font') === 'inc' ? Math.min(28, fontPx + 1) : Math.max(10, fontPx - 1);
      applyFont();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      vscodeApi.postMessage({ type: 'delete', wfId: del.getAttribute('data-del') });
      return;  // don't also toggle
    }
    const head = e.target.closest('.wf-head');
    if (head) {
      const card = head.closest('.wf');
      const id = card.getAttribute('data-wfid');
      const index = lastWorkflows.findIndex(w => w.wfId === id);
      userToggled[id] = !isExpanded(id, index);
      render(lastWorkflows, true);  // data unchanged but toggle state changed → force
    }
  });

  // Native <details> fire 'toggle' on open/close; remember the state so the next
  // auto-refresh render restores it instead of snapping the report shut.
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (d && d.matches && d.matches('details.summary-wrap[data-dkey]')) {
      openDetails[d.getAttribute('data-dkey')] = d.open;
    }
  }, true);

  window.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'i18n') { dict = m.dict || {}; lang = m.lang || 'en'; applyI18n(); render(lastWorkflows, true); }
    else if (m && m.type === 'workflows') render(m.workflows);
    else if (m && m.type === 'trash') renderTrash(m.items || []);
  });
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
