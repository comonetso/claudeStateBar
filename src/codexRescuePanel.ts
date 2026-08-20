import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import { getShortName } from './core/displayName';
import type { RunPhase } from './providers/codexRescue/runDiscovery';

// Live view of codex_rescue runs — the Codex counterpart to the Claude workflow panel.
//
// Kept as a SEPARATE panel rather than extra cards in workflowPanel because the two model
// different things: a Claude workflow is a fan-out of agents with phases, while a Codex run
// is one linear turn whose activities are tool calls. Sharing a panel would have forced a
// lowest-common-denominator card that served neither.

export interface CodexItemView {
    id: string;
    kind: string;                              // agent_message | command_execution | ...
    status: 'running' | 'done' | 'failed' | 'warn';
    label: string;
    body?: string;                             // prose for agent_message / reasoning / error
    /** command_execution only: the wrapped command as it ran. Hover text; label is stripped. */
    raw?: string;
    durationMs?: number;
}

export interface CodexRunView {
    stamp: string;
    slug: string;
    /** Card heading when present; the slug is the fallback for runs recorded without one. */
    subject?: string;
    mode: string;
    phase: RunPhase;
    startedAt?: number;
    endedAt?: number;
    threadId?: string;
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
    staleForMs?: number;
}

export interface CodexPanelCallbacks {
    onOpenDoc: (docUri: string) => void;
    /** User clicked a run's delete button (confirmation happens on the extension side). */
    onDelete: (stamp: string) => void;
}

let panel: vscode.WebviewPanel | null = null;
let callbacks: CodexPanelCallbacks | null = null;
let lastPushedSignature: string | null = null;

export function isCodexPanelOpen(): boolean { return panel !== null; }

/** Editor-tab caption. Localised like the panel body — the tab is the first thing read. */
/**
 * Which project this panel is showing, since the runs come from the open workspace folders.
 * Every window's tab reads "Codex Runs" otherwise, so with two windows open there is no way
 * to tell which project's panel is in front. Abbreviated with the same rule (and the same
 * `shortNames` overrides) the status bar uses, so one project reads the same in both places.
 */
function workspaceLabel(): { short: string; full: string } | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const shortNames = vscode.workspace.getConfiguration('claudeContextBar')
        .get<Record<string, string>>('shortNames', {});
    // A remote folder's fsPath comes back with Windows separators and is meaningless, but the
    // raw URI is no better: VS Code encodes an SSH target as `ssh-remote+<hex>`, where the hex
    // is `{"hostName":"..."}` — 68 characters of gibberish on screen. Decode it back to the
    // host alias, which is what the user actually calls that machine.
    const locate = (f: vscode.WorkspaceFolder): string => {
        if (f.uri.scheme === 'file') return f.uri.fsPath;
        const auth = f.uri.authority;
        const plus = auth.indexOf('+');
        let host = plus >= 0 ? auth.slice(plus + 1) : auth;
        if (/^(?:[0-9a-f]{2})+$/i.test(host)) {
            try {
                const decoded = JSON.parse(Buffer.from(host, 'hex').toString('utf8'));
                if (typeof decoded?.hostName === 'string') host = decoded.hostName;
            } catch { /* not the JSON form — fall through with the authority as-is */ }
        }
        return host ? `${host}: ${f.uri.path}` : f.uri.path;
    };
    return {
        short: folders.map(f => getShortName(f.name, shortNames)).join(' + '),
        full: folders.map(locate).join('\n'),
    };
}

function panelTitle(): string {
    const v = getDict(creds.getLanguage())['cx.panelTitle'];
    const base = typeof v === 'string' ? v : 'Codex Runs';
    const ws = workspaceLabel();
    return ws ? `${base} · ${ws.short}` : base;
}

// Same dedup contract as the workflow panel: re-pushing identical data would rebuild the
// DOM and snap shut whatever the user expanded. A finished run's signature is stable, so it
// stops re-rendering; a live one keeps changing and keeps updating.
function signature(runs: CodexRunView[]): string {
    return JSON.stringify((runs || []).map(r => ({
        s: r.stamp, p: r.phase, e: r.endedAt || 0, t: r.totalTokens || 0,
        d: r.todo, k: r.staleForMs ? Math.floor(r.staleForMs / 5000) : 0,
        r: !!r.resultUri,
        i: r.items.map(i => [i.id, i.status, i.label, i.body, i.durationMs]),
    })));
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

export function createOrShowCodexPanel(
    context: vscode.ExtensionContext,
    runs: CodexRunView[],
    cb: CodexPanelCallbacks
): void {
    callbacks = cb;
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        pushRuns(runs);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'claudeContextBarCodexRescue',
        panelTitle(),
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    lastPushedSignature = null;
    panel.webview.html = getHtml(panel.webview);
    panel.onDidDispose(() => { panel = null; lastPushedSignature = null; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
            panel?.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()) });
            lastPushedSignature = null; pushRuns(runs);
        } else if (msg?.type === 'open' && typeof msg.path === 'string') {
            callbacks?.onOpenDoc(msg.path);
        } else if (msg?.type === 'delete' && typeof msg.stamp === 'string') {
            callbacks?.onDelete(msg.stamp);
        }
    }, null, context.subscriptions);
}

export function pushRuns(runs: CodexRunView[]): void {
    if (!panel) return;
    const sig = signature(runs);
    if (sig === lastPushedSignature) return;
    lastPushedSignature = sig;
    panel.webview.postMessage({ type: 'runs', runs });
}

export function pushCodexLanguage(): void {
    if (!panel) return;
    panel.title = panelTitle();   // the tab caption is host-side, so it needs its own update
    panel.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()) });
}

function getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    // Folder locations are baked in at panel creation. They only change if the user adds or
    // removes a workspace folder, which reloads the window anyway.
    const ws = workspaceLabel();
    const escHtml = (s: string) =>
        s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const wsRow = ws
        ? `  <div class="wspath" title="${escHtml(ws.full)}">${escHtml(ws.full.replace(/\n/g, '   ·   '))}</div>\n`
        : '';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  .toolbar { display:flex; align-items:center; gap:6px; justify-content:flex-end; margin-bottom:10px; }
  .flabel { color: var(--vscode-descriptionForeground); font-size:.8em; margin-right:2px; }
  .fbtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none; border-radius:4px; padding:2px 11px; cursor:pointer; font-size:1em; line-height:1.4; }
  .fbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  h1 { font-size:1.2em; margin:0 0 4px 0; }
  .wspath { color: var(--vscode-descriptionForeground); font-size:.8em; margin:0 0 2px 0; opacity:.75;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sub { color: var(--vscode-descriptionForeground); font-size:.85em; margin-bottom:16px; }

  .run { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:10px 14px; margin-bottom:12px; }
  .run-head { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
  .arrow { flex-shrink:0; width:12px; color: var(--vscode-descriptionForeground); transition: transform .12s; }
  .run.collapsed .arrow { transform: rotate(-90deg); }
  .run-name { font-weight:600; font-size:1.05em; flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mode-chip { font-size:.72em; padding:1px 7px; border-radius:4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); flex-shrink:0; letter-spacing:.3px; }
  .run-time { flex-shrink:0; color: var(--vscode-descriptionForeground); font-size:.8em; white-space:nowrap; font-variant-numeric: tabular-nums; }
  .spacer { flex:1 1 auto; }
  .badge { font-size:.8em; padding:2px 9px; border-radius:10px; white-space:nowrap; flex-shrink:0; }
  .badge.running, .badge.starting, .badge.finalizing { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
  .badge.done    { background: var(--vscode-testing-iconPassed, #3fb950); color:#fff; }
  .badge.failed  { background: var(--vscode-statusBarItem-errorBackground, #f85149); color:#fff; }
  .badge.stopped { background: var(--vscode-descriptionForeground, #8b949e); color: var(--vscode-editor-background, #1e1e1e); }
  .badge.stale   { background:#d29922; color:#1e1e1e; }
  .del-btn { flex-shrink:0; background:transparent; border:none; color: var(--vscode-descriptionForeground); cursor:pointer; font-size:1em; padding:2px 6px; border-radius:4px; }
  .del-btn:hover { background: var(--vscode-statusBarItem-errorBackground, #f85149); color:#fff; }
  .run-body { margin-top:8px; }
  .run.collapsed .run-body { display:none; }
  .meta { color: var(--vscode-descriptionForeground); font-size:.78em; font-family: var(--vscode-editor-font-family); margin-bottom:8px; line-height:1.6; }
  .doclink { color: var(--vscode-textLink-foreground); cursor:pointer; text-decoration:none; }
  .doclink:hover { text-decoration:underline; }
  .now { margin:2px 0 10px 0; padding:8px 11px; border-left:2px solid var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); border-radius:0 4px 4px 0; line-height:1.5; font-size:.93em; white-space:pre-wrap; word-break:break-word; }
  .plan { font-size:.82em; color: var(--vscode-descriptionForeground); margin-bottom:8px; }
  .plan-chip { display:inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius:4px; padding:1px 7px; margin:0 4px 3px 0; }
  .plan-chip.on { opacity:.55; text-decoration:line-through; }

  .items { display:flex; flex-direction:column; gap:6px; margin-top:6px; }
  .it { font-size:.9em; }
  .it-head { display:flex; align-items:baseline; gap:8px; }
  .dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; position:relative; top:1px; }
  .dot.running { background:#e3b341; animation: pulse 1.2s ease-in-out infinite; }
  .dot.done { background:#3fb950; }
  .dot.failed { background:#f85149; }
  /* Advisory notice — visible but clearly not a failure. */
  .dot.warn { background:#d29922; }
  .kind { font-size:.78em; padding:0 6px; border-radius:3px; flex-shrink:0; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .kind.k-agent_message, .kind.k-reasoning { background:#3a3f5c; color:#c3caff; }
  .kind.k-command_execution { background:#4a4030; color:#f0d9a8; }
  .kind.k-web_search { background:#2f4a3a; color:#a8e6bf; }
  .kind.k-file_change { background:#4a3050; color:#e6b3f0; }
  .kind.k-error { background:#4a3f22; color:#f0d9a8; }
  .lbl { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family: var(--vscode-editor-font-family); font-size:.92em; }
  .dur { color: var(--vscode-descriptionForeground); font-size:.82em; flex-shrink:0; }
  details.cmdgroup { margin:0; }
  /* The summary lines up with ordinary rows — no leading marker, no indent on the rows it
     reveals — so a collapsed group reads as one of the list rather than a nested block. */
  details.cmdgroup > summary { display:flex; align-items:center; gap:7px; cursor:pointer;
    padding:3px 0; list-style:none; color: var(--vscode-descriptionForeground); }
  details.cmdgroup > summary::-webkit-details-marker { display:none; }
  details.cmdgroup > summary:hover { color: var(--vscode-foreground); }
  details.cmdgroup .gcount { font-size:.9em; }
  details.cmdgroup > .it { margin-left:0; }
  /* Affordance sits after the count, where the eye already is. */
  .ghint { font-size:.82em; opacity:.8; padding:0 6px; border-radius:4px;
    border:1px solid var(--vscode-panel-border); white-space:nowrap; }
  details.cmdgroup > summary:hover .ghint { opacity:1; border-color: var(--vscode-focusBorder); }
  .ghint::before { content:'▸'; display:inline-block; margin-right:4px; font-size:.9em;
    transition:transform .12s; }
  details.cmdgroup[open] .ghint::before { transform:rotate(90deg); }
  details.cmdgroup[open] .gh-open { display:none; }
  details.cmdgroup:not([open]) .gh-close { display:none; }
  /* A row whose label doesn't fit opens in place: the one-line summary is replaced by the
     wrapped full text. '.plain' marks rows with nothing more to show — see markClipped(). */
  details.row { margin:0; }
  details.row > summary { list-style:none; }
  details.row > summary::-webkit-details-marker { display:none; }
  details.row:not(.plain) > summary { cursor:pointer; }
  details.row:not(.plain) > summary:hover { background: var(--vscode-list-hoverBackground); border-radius:4px; }
  details.row.plain > summary { cursor:default; }
  /* No body block: unwrap the label itself so the tail that was clipped becomes readable. */
  details.row[open] > summary .lbl { white-space:pre-wrap; word-break:break-word; overflow:visible; text-overflow:clip; }
  /* With a body block the label would just repeat its first line. */
  details.row.hasfull[open] > summary .lbl { display:none; }
  .full { margin:6px 0 2px 17px; padding:8px 10px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); border-radius:4px; white-space:pre-wrap; word-break:break-word; font-family: var(--vscode-editor-font-family); font-size:.88em; line-height:1.5; max-height:420px; overflow:auto; }
  .empty { color: var(--vscode-descriptionForeground); font-style:italic; }
  .warn { color:#d29922; font-size:.85em; margin-top:6px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <h1 data-i18n="cx.title">🔶 Codex Runs</h1>
${wsRow}  <div class="sub" id="sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="list"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  let dict = {};
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

  const savedState = vscodeApi.getState() || {};
  let fontPx = savedState.fontPx || 15;
  function applyFont() {
    document.body.style.fontSize = fontPx + 'px';
    // Bigger text clips more labels, smaller text clips fewer — re-measure after every change.
    markClipped();
    vscodeApi.setState(Object.assign({}, vscodeApi.getState(), { fontPx }));
  }
  applyFont();

  let lastRuns = [];
  const userToggled = {};
  const openDetails = {};
  let lastRenderedSig = null;

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  // The date is part of the clock here, unlike the workflow panel: retention is 7 days, so a
  // card can be several days old and a bare 10:13 reads as this morning when it was not.
  // No year (a week never spans one that matters) and no seconds (nobody reads them off a
  // start time) — the elapsed figure beside it is where sub-minute detail belongs.
  function fmtClock(ms) {
    const d = new Date(ms);
    return pad2(d.getMonth()+1)+'/'+pad2(d.getDate())+' '+pad2(d.getHours())+':'+pad2(d.getMinutes());
  }
  function fmtElapsed(ms) {
    if (!ms || ms < 0) ms = 0;
    const tt = Math.floor(ms/1000), h = Math.floor(tt/3600), m = Math.floor((tt%3600)/60), s = tt%60;
    return h > 0 ? h+':'+pad2(m)+':'+pad2(s) : pad2(m)+':'+pad2(s);
  }
  function fmtDur(ms) {
    if (!ms || ms <= 0) return '';
    const s = ms/1000;
    if (s < 60) return s.toFixed(1)+'s';
    return Math.floor(s/60)+'m '+Math.round(s%60)+'s';
  }
  // Independent 1s ticker so a running run's clock advances even when its data is unchanged.
  function tick() {
    const now = Date.now();
    document.querySelectorAll('.run-time[data-started]').forEach(function (el) {
      const started = Number(el.getAttribute('data-started'));
      if (!started) return;
      const doneEnd = el.getAttribute('data-done');
      const elapsed = doneEnd ? (Number(doneEnd) - started) : (now - started);
      const label = doneEnd ? t('wf.took') : t('wf.elapsed');
      el.textContent = '🕘 ' + fmtClock(started) + ' · ' + label + fmtElapsed(elapsed);
    });
  }
  setInterval(tick, 1000);

  // Everything starts collapsed. Unlike the workflow panel (where the newest card auto-opens),
  // a Codex run can hold 50+ activities, so auto-expanding the top one buries the rest of the
  // list below a wall of commands before the user has chosen anything to look at.
  function isExpanded(id) {
    return (id in userToggled) ? userToggled[id] : false;
  }
  function captureOpenDetails() {
    document.querySelectorAll('details[data-dkey]').forEach(function (d) {
      openDetails[d.getAttribute('data-dkey')] = d.open;
    });
  }
  function sigOf(runs) {
    return JSON.stringify((runs||[]).map(function (r) {
      return [r.stamp, r.phase, r.endedAt||0, r.totalTokens||0, r.todo, !!r.resultUri,
        r.items.map(function (i) { return [i.id,i.status,i.label,i.body,i.durationMs]; })];
    }));
  }

  // Live runs lead with what Codex just said; finished ones don't, because the final
  // agent_message is the whole answer document (26 KB in the reference run) and showing its
  // frontmatter as "current activity" is noise. The result doc link covers that case.
  function narrationOf(run) {
    if (run.phase === 'done' || run.phase === 'failed' || run.phase === 'stopped') return '';
    for (let i = run.items.length - 1; i >= 0; i--) {
      const it = run.items[i];
      if (it.kind === 'agent_message' || it.kind === 'reasoning') return it.body || it.label;
    }
    return '';
  }

  function render(runs, force) {
    const incoming = runs || [];
    const sig = sigOf(incoming);
    if (!force && sig === lastRenderedSig) { lastRuns = incoming; return; }
    lastRenderedSig = sig;
    captureOpenDetails();
    lastRuns = incoming;
    const list = document.getElementById('list');
    const sub = document.getElementById('sub');
    if (!lastRuns.length) {
      list.innerHTML = '<div class="empty">' + esc(t('cx.empty')) + '</div>';
      sub.textContent = '';
      return;
    }
    // Report every bucket that actually has runs in it. Saying only "0 live" leaves the
    // remainder unaccounted for — with one finished run the honest line is "완료 1건".
    const nLive = lastRuns.filter(r => r.phase==='running'||r.phase==='starting'||r.phase==='finalizing').length;
    const nDone = lastRuns.filter(r => r.phase==='done').length;
    const nFail = lastRuns.filter(r => r.phase==='failed').length;
    const nStop = lastRuns.filter(r => r.phase==='stopped').length;
    const nStale = lastRuns.filter(r => r.phase==='stale').length;
    const parts = [];
    if (nDone)  parts.push(t('cx.nDone', nDone));
    if (nFail)  parts.push(t('cx.nFailed', nFail));
    if (nStop)  parts.push(t('cx.nStopped', nStop));
    if (nStale) parts.push(t('cx.nStale', nStale));
    // Live count is always shown, even at zero: "is anything running right now?" is the
    // question this line exists to answer, and omitting it leaves that unanswered.
    parts.push(t('cx.nLive', nLive));
    parts.push(t('cx.autoRefresh'));
    sub.textContent = parts.join(' · ');

    list.innerHTML = lastRuns.map(function (run, index) {
      const phase = run.phase;
      const badgeCls = (phase==='starting'||phase==='finalizing') ? 'running' : phase;
      const badge = '<span class="badge ' + esc(badgeCls) + '">' + esc(t('cx.phase.'+phase)) + '</span>';

      const narration = narrationOf(run);
      const nowBlock = narration ? '<div class="now">' + esc(narration) + '</div>' : '';

      const plan = (run.todo && run.todo.length)
        ? '<div class="plan">' + run.todo.map(function (x) {
            return '<span class="plan-chip' + (x.done?' on':'') + '">' + esc(x.text) + '</span>'; }).join('') + '</div>'
        : '';

      function renderItem(it) {
          const dur = fmtDur(it.durationMs);
          const durStr = dur ? '<span class="dur">· ' + dur + '</span>' : '';
          // Commands hover the command as it actually ran, wrapper and all — the row shows
          // the unwrapped form, but that is not what you would paste to reproduce it.
          const hover = it.raw && it.raw !== it.label ? it.raw : it.label;
          const head = '<summary class="it-head"><span class="dot ' + esc(it.status) + '"></span>' +
            '<span class="kind k-' + esc(it.kind) + '">' + esc(t('cx.kind.'+it.kind)) + '</span>' +
            '<span class="lbl" title="' + esc(hover) + '">' + esc(it.label) + '</span>' + durStr + '</summary>';
          // What opening the row reveals: the full message text for a message, and for a
          // command the wrapped form — what you would actually paste to re-run it.
          const full = it.body || it.raw || '';
          const hasFull = !!full && full !== it.label;
          // A label the parser itself truncated is known-clipped without measuring. Everything
          // else depends on the panel's width, so markClipped() decides after layout.
          const more = !!(it.body && it.body.length > it.label.length);
          const dkey = run.stamp + ' ' + it.id;
          const openAttr = openDetails[dkey] ? ' open' : '';
          return '<div class="it"><details class="row' + (hasFull ? ' hasfull' : '') +
            '" data-dkey="' + esc(dkey) + '" data-more="' + (more ? '1' : '0') + '"' + openAttr + '>' +
            head + (hasFull ? '<div class="full">' + esc(full) + '</div>' : '') +
            '</details></div>';
      }

      // Runs are dominated by routine tool calls — 76% of the rows in a measured EDIT run were
      // commands, and a research-heavy run adds a dozen searches on top. Consecutive
      // *successful* ones of the SAME kind collapse into a single line; mixing kinds would
      // hide what a run actually spent its time on. A failure never joins a group: those are
      // the rows worth reading, and burying them is the one thing this must not do. A group
      // of one stays a plain row.
      const GROUPABLE = { command_execution: 'cx.cmdGroup', web_search: 'cx.searchGroup' };
      function groupRuns(list) {
        const out = [];
        let bucket = null, bucketKind = null;
        list.forEach(function (it) {
          const can = GROUPABLE[it.kind] && it.status === 'done';
          if (can && it.kind === bucketKind) {
            bucket.push(it);
          } else if (can) {
            bucket = [it]; bucketKind = it.kind;
            out.push({ cmds: bucket, kind: it.kind });
          } else {
            bucket = null; bucketKind = null;
            out.push({ one: it });
          }
        });
        return out;
      }

      const items = run.items.length ? '<div class="items">' + groupRuns(run.items).map(function (node) {
          if (node.one) return renderItem(node.one);
          if (node.cmds.length === 1) return renderItem(node.cmds[0]);
          const gkey = run.stamp + ' g' + node.cmds[0].id;
          const openAttr = openDetails[gkey] ? ' open' : '';
          return '<details class="cmdgroup" data-dkey="' + esc(gkey) + '"' + openAttr + '><summary>' +
            '<span class="dot done"></span><span class="kind k-' + esc(node.kind) + '">' +
            esc(t('cx.kind.' + node.kind)) + '</span><span class="gcount">' +
            esc(t(GROUPABLE[node.kind], node.cmds.length)) + '</span>' +
            '<span class="ghint"><span class="gh-open">' + esc(t('cx.expand')) + '</span>' +
            '<span class="gh-close">' + esc(t('cx.collapse')) + '</span></span></summary>' +
            node.cmds.map(renderItem).join('') + '</details>';
        }).join('') + '</div>'
        : '<div class="empty">' + esc(t('cx.noItems')) + '</div>';

      const links = [];
      if (run.resultUri) links.push('<span class="doclink" data-open="' + esc(run.resultUri) + '">📄 ' + esc(t('cx.openResult')) + '</span>');
      if (run.requestUri) links.push('<span class="doclink" data-open="' + esc(run.requestUri) + '">📝 ' + esc(t('cx.openRequest')) + '</span>');

      const tokenLine = run.totalTokens ? '<br>' + esc(t('cx.tokens', run.totalTokens.toLocaleString())) : '';
      const staleLine = (phase === 'stale')
        ? '<div class="warn">' + esc(t('cx.staleHint', Math.round((run.staleForMs||0)/1000))) + '</div>' : '';

      const finished = (phase==='done'||phase==='failed'||phase==='stopped');
      const timeHtml = run.startedAt
        ? '<span class="run-time" data-started="' + run.startedAt + '" data-done="' + (finished && run.endedAt ? run.endedAt : '') + '"></span>'
        : '';

      return '<div class="run' + (isExpanded(run.stamp)?'':' collapsed') + '" data-id="' + esc(run.stamp) + '">' +
        '<div class="run-head">' +
          '<span class="arrow">▾</span>' +
          // Prefer the subject: the slug is a filename fragment and reads as a symbol. Either
          // way the slug stays in the hover, since it is what the files on disk are named.
          // The newline is escaped twice on purpose: this line lives inside the getHtml
          // template literal, where one backslash would become a real newline and split the
          // JS string in two. Backticks are forbidden here for the same reason.
          '<span class="run-name" title="' + esc(run.subject ? run.subject + '\\n' + run.slug : run.slug) + '">' +
            esc(run.subject || run.slug) + '</span>' +
          '<span class="mode-chip">' + esc(run.mode.toUpperCase()) + '</span>' +
          timeHtml + '<span class="spacer"></span>' + badge +
          // Only finished runs get a delete button — deleting mid-write would race send.sh.
          (finished ? '<button class="del-btn" data-del="' + esc(run.stamp) + '" title="' + esc(t('common.delete')) + '">🗑</button>' : '') +
        '</div>' +
        '<div class="run-body">' +
          '<div class="meta">' + esc(run.stamp) +
            (run.threadId ? ' · thread ' + esc(run.threadId.slice(0,8)) : '') + tokenLine +
            (links.length ? '<br>' + links.join(' &nbsp; ') : '') +
          '</div>' +
          staleLine + nowBlock + plan + items +
        '</div>' +
      '</div>';
    }).join('');
    tick();
    markClipped();
  }

  // Whether a row is worth opening is a layout question: the same label fits at one panel
  // width and is cut at another, so it can only be answered after the browser has laid the
  // list out. Rows with nothing more to reveal get '.plain' and stop responding to clicks —
  // a row that opens onto the text you were already reading is worse than no affordance.
  // Open rows are skipped: their label is wrapped or hidden, so it would measure as "fits".
  function markClipped() {
    document.querySelectorAll('details.row').forEach(function (d) {
      if (d.open) return;
      const lbl = d.querySelector('.lbl');
      const clipped = !!lbl && lbl.scrollWidth > lbl.clientWidth + 1;
      d.classList.toggle('plain', d.getAttribute('data-more') !== '1' && !clipped);
    });
  }
  window.addEventListener('resize', markClipped);

  document.addEventListener('click', e => {
    const fb = e.target.closest('[data-font]');
    if (fb) {
      fontPx = fb.getAttribute('data-font')==='inc' ? Math.min(28,fontPx+1) : Math.max(10,fontPx-1);
      applyFont(); return;
    }
    const op = e.target.closest('[data-open]');
    if (op) { vscodeApi.postMessage({ type:'open', path: op.getAttribute('data-open') }); return; }
    const del = e.target.closest('[data-del]');
    if (del) { vscodeApi.postMessage({ type:'delete', stamp: del.getAttribute('data-del') }); return; }
    // A fully-visible row has nothing to open; swallow the click so it doesn't flicker.
    const plain = e.target.closest('details.row.plain > summary');
    if (plain) { e.preventDefault(); return; }
    const head = e.target.closest('.run-head');
    if (head) {
      const card = head.closest('.run');
      const id = card.getAttribute('data-id');
      userToggled[id] = !isExpanded(id);
      render(lastRuns, true);
    }
  });
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details[data-dkey]')) return;
    openDetails[d.getAttribute('data-dkey')] = d.open;
    if (d.open) {
      // Accordion: an opened row is a wall of text, and two of them side by side leave no
      // list to navigate by. Command groups are containers, not text, so they are exempt.
      if (d.matches('details.row')) {
        document.querySelectorAll('details.row[open]').forEach(function (other) {
          if (other === d) return;
          other.open = false;
          openDetails[other.getAttribute('data-dkey')] = false;
        });
      }
    } else {
      // Closing restores the one-line label, which is measurable again.
      markClipped();
    }
  }, true);

  window.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'i18n') { dict = m.dict || {}; applyI18n(); render(lastRuns, true); }
    else if (m && m.type === 'runs') render(m.runs);
  });
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
