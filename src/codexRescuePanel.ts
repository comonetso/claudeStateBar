import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
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
    durationMs?: number;
}

export interface CodexRunView {
    stamp: string;
    slug: string;
    mode: string;
    phase: RunPhase;
    startedAt?: number;
    endedAt?: number;
    threadId?: string;
    items: CodexItemView[];
    todo?: { text: string; done: boolean }[];
    /** Only known once the turn completes — exec JSONL has no live token counter. */
    totalTokens?: number;
    /** Present when the run's own doc exists on disk; clicking opens it. */
    resultPath?: string;
    requestPath?: string;
    staleForMs?: number;
}

export interface CodexPanelCallbacks {
    onOpenDoc: (fsPath: string) => void;
    /** User clicked a run's delete button (confirmation happens on the extension side). */
    onDelete: (stamp: string) => void;
}

let panel: vscode.WebviewPanel | null = null;
let callbacks: CodexPanelCallbacks | null = null;
let lastPushedSignature: string | null = null;

export function isCodexPanelOpen(): boolean { return panel !== null; }

/** Editor-tab caption. Localised like the panel body — the tab is the first thing read. */
function panelTitle(): string {
    const v = getDict(creds.getLanguage())['cx.panelTitle'];
    return typeof v === 'string' ? v : 'Codex Runs';
}

// Same dedup contract as the workflow panel: re-pushing identical data would rebuild the
// DOM and snap shut whatever the user expanded. A finished run's signature is stable, so it
// stops re-rendering; a live one keeps changing and keeps updating.
function signature(runs: CodexRunView[]): string {
    return JSON.stringify((runs || []).map(r => ({
        s: r.stamp, p: r.phase, e: r.endedAt || 0, t: r.totalTokens || 0,
        d: r.todo, k: r.staleForMs ? Math.floor(r.staleForMs / 5000) : 0,
        r: !!r.resultPath,
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
  details.say { margin:3px 0 0 17px; }
  details.say > summary { color: var(--vscode-descriptionForeground); font-size:.92em; line-height:1.45; cursor:pointer; white-space:pre-wrap; word-break:break-word; }
  details.say[open] > summary { color: var(--vscode-foreground); font-weight:600; }
  .full { margin:6px 0 2px 0; padding:8px 10px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); border-radius:4px; white-space:pre-wrap; word-break:break-word; font-family: var(--vscode-editor-font-family); font-size:.88em; line-height:1.5; max-height:420px; overflow:auto; }
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
  <div class="sub" id="sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
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
    vscodeApi.setState(Object.assign({}, vscodeApi.getState(), { fontPx }));
  }
  applyFont();

  let lastRuns = [];
  const userToggled = {};
  const openDetails = {};
  let lastRenderedSig = null;

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtClock(ms) { const d = new Date(ms); return pad2(d.getHours())+':'+pad2(d.getMinutes())+':'+pad2(d.getSeconds()); }
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
    document.querySelectorAll('details.say[data-dkey]').forEach(function (d) {
      openDetails[d.getAttribute('data-dkey')] = d.open;
    });
  }
  function sigOf(runs) {
    return JSON.stringify((runs||[]).map(function (r) {
      return [r.stamp, r.phase, r.endedAt||0, r.totalTokens||0, r.todo, !!r.resultPath,
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

      const items = run.items.length ? '<div class="items">' + run.items.map(function (it) {
          const dur = fmtDur(it.durationMs);
          const durStr = dur ? '<span class="dur">· ' + dur + '</span>' : '';
          const head = '<div class="it-head"><span class="dot ' + esc(it.status) + '"></span>' +
            '<span class="kind k-' + esc(it.kind) + '">' + esc(t('cx.kind.'+it.kind)) + '</span>' +
            '<span class="lbl" title="' + esc(it.label) + '">' + esc(it.label) + '</span>' + durStr + '</div>';
          let bodyHtml = '';
          if (it.body && it.body.length > it.label.length) {
            const dkey = run.stamp + ' ' + it.id;
            const openAttr = openDetails[dkey] ? ' open' : '';
            bodyHtml = '<details class="say" data-dkey="' + esc(dkey) + '"' + openAttr + '><summary>' +
              esc(t('cx.readMore')) + '</summary><div class="full">' + esc(it.body) + '</div></details>';
          }
          return '<div class="it">' + head + bodyHtml + '</div>';
        }).join('') + '</div>'
        : '<div class="empty">' + esc(t('cx.noItems')) + '</div>';

      const links = [];
      if (run.resultPath) links.push('<span class="doclink" data-open="' + esc(run.resultPath) + '">📄 ' + esc(t('cx.openResult')) + '</span>');
      if (run.requestPath) links.push('<span class="doclink" data-open="' + esc(run.requestPath) + '">📝 ' + esc(t('cx.openRequest')) + '</span>');

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
          '<span class="run-name" title="' + esc(run.slug) + '">' + esc(run.slug) + '</span>' +
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
  }

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
    if (d && d.matches && d.matches('details.say[data-dkey]')) openDetails[d.getAttribute('data-dkey')] = d.open;
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
