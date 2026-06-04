import * as vscode from 'vscode';

// A workflow agent's live state, mirrored from journal.jsonl (started/result records).
export interface WorkflowAgentView {
    agentId: string;
    status: 'running' | 'done';
    summary: string;        // 160-char preview
    fullSummary?: string;   // untruncated full text — expandable via <details> on done agents
    durationMs: number;
    name?: string;          // display label (Task agents); undefined → "에이전트 N"
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

export interface WorkflowPanelCallbacks {
    // Called when the user clicks a workflow's delete button (after they confirm).
    onDelete: (wfId: string) => void;
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
        a: wf.agents.map(a => [a.agentId, a.status, a.summary, a.fullSummary, a.durationMs, a.name]),
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
        // render, so force that render through even if the signature would otherwise dedup.
        if (msg?.type === 'ready') { lastPushedSignature = null; pushWorkflows(workflows); }
        else if (msg?.type === 'delete' && typeof msg.wfId === 'string') callbacks?.onDelete(msg.wfId);
    }, null, context.subscriptions);
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
  .del-btn { flex-shrink: 0; background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 1em; padding: 2px 6px; border-radius: 4px; }
  .del-btn:hover { background: var(--vscode-statusBarItem-errorBackground); color: #fff; }
  .wf-body { margin-top: 8px; }
  .wf.collapsed .wf-body { display: none; }
  .wf-id { color: var(--vscode-descriptionForeground); font-size: 0.8em; font-family: var(--vscode-editor-font-family); }
  .wf-desc { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin: 4px 0 8px 0; }
  .phases { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  .phase-chip { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; padding: 1px 7px; margin-right: 4px; }
  .agents { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
  .agent { padding: 2px 0; font-size: 0.9em; }
  .agent-head { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot.running { background: #e3b341; animation: pulse 1.2s ease-in-out infinite; }
  .dot.done { background: #3fb950; }
  .label { font-weight: 600; }
  .dur { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .summary { color: var(--vscode-descriptionForeground); margin: 3px 0 0 17px; line-height: 1.45; font-size: 0.92em; white-space: pre-wrap; word-break: break-word; }
  details.summary-wrap { margin: 3px 0 0 17px; }
  details.summary-wrap > summary { color: var(--vscode-descriptionForeground); line-height: 1.45; font-size: 0.92em; cursor: pointer; list-style: revert; white-space: pre-wrap; word-break: break-word; }
  details.summary-wrap > summary::marker { color: var(--vscode-descriptionForeground); }
  details.summary-wrap[open] > summary { color: var(--vscode-foreground); font-weight: 600; }
  .full { margin: 6px 0 2px 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.88em; line-height: 1.5; max-height: 420px; overflow: auto; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="flabel">글자 크기</span>
    <button class="fbtn" data-font="dec" title="작게">A−</button>
    <button class="fbtn" data-font="inc" title="크게">A+</button>
  </div>
  <h1>⚡ Claude 워크플로우</h1>
  <div class="sub" id="sub">상태바와 함께 자동 갱신 중…</div>
  <div id="list"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
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
        wf.agents.map(function (a) { return [a.agentId, a.status, a.summary, a.fullSummary, a.durationMs, a.name]; })];
    }));
  }
  function detailsKey(wfId, agentId) { return wfId + ' ' + agentId; }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function fmtDur(ms) {
    if (!ms || ms <= 0) return '';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return m + 'm ' + rem + 's';
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
      const label = doneEnd ? '소요 ' : '경과 ';
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
      list.innerHTML = '<div class="empty">이 세션에 아직 워크플로우가 없습니다.</div>';
      sub.textContent = '';
      return;
    }
    const runningWf = lastWorkflows.filter(w => w.agents.some(a => a.status === 'running')).length;
    sub.textContent = '워크플로우 ' + lastWorkflows.length + '개 · 진행 중 ' + runningWf + '개 · 자동 갱신';
    list.innerHTML = lastWorkflows.map((wf, index) => {
      const done = wf.agents.filter(a => a.status === 'done').length;
      const total = wf.agents.length;
      const running = wf.agents.some(a => a.status === 'running');
      const badge = running
        ? '<span class="badge running">' + done + '/' + total + ' 진행 중</span>'
        : '<span class="badge done">' + done + '/' + total + ' 완료</span>';
      const phases = (wf.phases && wf.phases.length)
        ? '<div class="phases">' + wf.phases.map(p => '<span class="phase-chip">' + esc(p) + '</span>').join('') + '</div>'
        : '';
      // Count agents sharing each label so identical labels (e.g. role names that
      // truncate to the same 50 chars) get a number appended to stay distinguishable.
      const labelCounts = {};
      wf.agents.forEach(a => { const k = (a.name && a.name.trim()) || ''; if (k) labelCounts[k] = (labelCounts[k] || 0) + 1; });
      const agents = wf.agents.length
        ? '<div class="agents">' + wf.agents.map((a, i) => {
            const dur = fmtDur(a.durationMs);
            const durStr = dur ? ' <span class="dur">· ' + (a.status === 'running' ? '경과 ' : '') + dur + '</span>' : '';
            const nm = (a.name && a.name.trim()) || '';
            const labelText = nm ? (labelCounts[nm] > 1 ? nm + ' (' + (i + 1) + ')' : nm) : ('에이전트 ' + (i + 1));
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
              '<span class="label">' + esc(labelText) + '</span>' + durStr + '</div>' +
              summaryHtml +
            '</div>';
          }).join('') + '</div>'
        : '<div class="empty">아직 시작된 에이전트가 없습니다.</div>';
      const expanded = isExpanded(wf.wfId, index);
      // Real workflows (wf_*) delete their whole dir; the Task pseudo-bundle ('tasks')
      // clears its COMPLETED agent logs (running ones are kept).
      const delBtn = wf.wfId.indexOf('wf_') === 0
        ? '<button class="del-btn" data-del="' + esc(wf.wfId) + '" title="삭제">🗑</button>'
        : wf.wfId.indexOf('tasks:') === 0
        ? '<button class="del-btn" data-del="' + esc(wf.wfId) + '" title="이 묶음의 완료된 Task 정리">🗑</button>'
        : '';
      // Title-row clock: start time (H:i:s) + elapsed (i:s). While running, a 1s timer
      // (tickElapsed) counts up from data-started; once all agents are done, data-done holds
      // the final endedAt so the elapsed freezes at the total run time.
      const allDone = wf.agents.length > 0 && wf.agents.every(a => a.status === 'done');
      const timeHtml = wf.startedAt
        ? '<span class="wf-time" data-started="' + wf.startedAt + '" data-clock="' + esc(fmtClock(wf.startedAt)) + '" data-done="' + (allDone && wf.endedAt ? wf.endedAt : '') + '"></span>'
        : '';
      return '<div class="wf' + (expanded ? '' : ' collapsed') + '" data-wfid="' + esc(wf.wfId) + '">' +
        '<div class="wf-head">' +
          '<span class="arrow">▾</span>' +
          '<span class="wf-name">' + esc(wf.name) + '</span>' +
          timeHtml +
          '<span class="wf-spacer"></span>' +
          badge +
          delBtn +
        '</div>' +
        '<div class="wf-body">' +
          (wf.wfId.indexOf('wf_') === 0 ? '<div class="wf-id">' + esc(wf.wfId) + '</div>' : '') +
          (wf.description ? '<div class="wf-desc">' + esc(wf.description) + '</div>' : '') +
          phases + agents +
        '</div>' +
      '</div>';
    }).join('');
    tickElapsed();  // fill the title clocks immediately instead of waiting for the next tick
  }

  document.addEventListener('click', e => {
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
    if (m && m.type === 'workflows') render(m.workflows);
  });
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
