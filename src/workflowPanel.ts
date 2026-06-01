import * as vscode from 'vscode';

// A workflow agent's live state, mirrored from journal.jsonl (started/result records).
export interface WorkflowAgentView {
    agentId: string;
    status: 'running' | 'done';
    summary: string;
    durationMs: number;
}

export interface WorkflowView {
    wfId: string;
    name: string;
    description: string;
    phases: string[];
    agents: WorkflowAgentView[];
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
        pushWorkflows(workflows);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'claudeContextBarWorkflows',
        'Claude Workflows',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getHtml(panel.webview);
    panel.onDidDispose(() => { panel = null; trackedSessionFile = null; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
        // The webview signals 'ready' once its script loads; only then can it receive data.
        if (msg?.type === 'ready') pushWorkflows(workflows);
        else if (msg?.type === 'delete' && typeof msg.wfId === 'string') callbacks?.onDelete(msg.wfId);
    }, null, context.subscriptions);
}

// Push fresh workflow data into the open panel. No-op when the panel is closed.
export function pushWorkflows(workflows: WorkflowView[]): void {
    if (!panel) return;
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
  .wf-name { font-weight: 600; font-size: 1.05em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .summary { color: var(--vscode-descriptionForeground); margin: 3px 0 0 17px; line-height: 1.45; font-size: 0.92em; }
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

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function fmtDur(ms) {
    if (!ms || ms <= 0) return '';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return m + 'm ' + rem + 's';
  }

  function isExpanded(wfId, index) {
    if (wfId in userToggled) return userToggled[wfId];
    return index === 0;  // default: newest (top) expanded, rest collapsed
  }

  function render(workflows) {
    lastWorkflows = workflows || [];
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
      const agents = wf.agents.length
        ? '<div class="agents">' + wf.agents.map((a, i) => {
            const dur = fmtDur(a.durationMs);
            const durStr = dur ? ' <span class="dur">· ' + (a.status === 'running' ? '경과 ' : '') + dur + '</span>' : '';
            return '<div class="agent">' +
              '<div class="agent-head"><span class="dot ' + a.status + '"></span>' +
              '<span class="label">에이전트 ' + (i + 1) + '</span>' + durStr + '</div>' +
              (a.summary ? '<div class="summary">' + esc(a.summary) + '</div>' : '') +
            '</div>';
          }).join('') + '</div>'
        : '<div class="empty">아직 시작된 에이전트가 없습니다.</div>';
      const expanded = isExpanded(wf.wfId, index);
      return '<div class="wf' + (expanded ? '' : ' collapsed') + '" data-wfid="' + esc(wf.wfId) + '">' +
        '<div class="wf-head">' +
          '<span class="arrow">▾</span>' +
          '<span class="wf-name">' + esc(wf.name) + '</span>' +
          badge +
          '<button class="del-btn" data-del="' + esc(wf.wfId) + '" title="삭제">🗑</button>' +
        '</div>' +
        '<div class="wf-body">' +
          '<div class="wf-id">' + esc(wf.wfId) + '</div>' +
          (wf.description ? '<div class="wf-desc">' + esc(wf.description) + '</div>' : '') +
          phases + agents +
        '</div>' +
      '</div>';
    }).join('');
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
      render(lastWorkflows);
    }
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'workflows') render(m.workflows);
  });
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
