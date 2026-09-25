// media/bgtasks.js — the background task panel's webview script.
//
// Two groups, by the user's call (2026-09-22): what Claude ran in the background (commands and
// monitors), and ordinary commands that ran long. Inside each, laid out like the remote-control
// view's background list, which the user pointed at: a running task shows its command and output
// straight away; finished ones fold into one row with a trash button. Group headers are the
// workflow panel's phase headers; the cards are its cards.
(function () {
  const vscodeApi = acquireVsCodeApi();
  let dict = {};
  function t(key) {
    let v = dict[key];
    if (v == null) return key;
    const args = Array.prototype.slice.call(arguments, 1);
    if (typeof v === 'string' && args.length) {
      v = v.replace(/\{(\d+)\}/g, function (_, i) { const val = args[Number(i)]; return val == null ? '' : String(val); });
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
    vscodeApi.setState(Object.assign({}, vscodeApi.getState(), { fontPx: fontPx }));
  }

  function emptyGroup() { return { running: [], finished: [], finishedTotal: 0 }; }
  let last = { background: emptyGroup(), long: emptyGroup(), longMinutes: 0 };
  let gotTasks = false;
  let lastSig = null;
  // Open/closed is remembered only while the panel is open, as in the other panels. A card in the
  // upper list starts open (the remote-control view shows a running task's output at once); one in
  // a finished row starts closed.
  const closedUpper = {};
  const openLower = {};
  const doneGroupOpen = {};   // group id -> finished row open
  const foldedGroups = {};    // group id -> whole group folded
  // Cards seen running stay in the upper list until the panel closes, so a task that ends while you
  // watch it does not fold itself away under your eyes.
  const watchedLive = {};
  // Finished cards whose output has been asked for, so the host is asked once per opening.
  const asked = {};
  const outScroll = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtClock(ms) {
    const d = new Date(ms);
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtElapsed(ms) {
    if (!ms || ms < 0) ms = 0;
    const tt = Math.floor(ms / 1000), h = Math.floor(tt / 3600), m = Math.floor((tt % 3600) / 60), s = tt % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
  }

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

  function badge(tk) {
    if (tk.status === 'running') return '<span class="badge running">' + esc(t('bg.running')) + '</span>';
    if (tk.status === 'completed') return '<span class="badge done">' + esc(t('bg.completed')) + '</span>';
    if (tk.status === 'failed') {
      const label = tk.exitCode != null ? t('bg.failed', tk.exitCode) : t('bg.failedNoCode');
      return '<span class="badge failed">' + esc(label) + '</span>';
    }
    return '<span class="badge stopped">' + esc(t('bg.stopped')) + '</span>';
  }

  function outputHtml(tk) {
    if (tk.kind === 'foreground' && tk.status === 'running') return '<div class="empty">' + esc(t('bg.waiting')) + '</div>';
    if (tk.output === undefined) return '<div class="empty">' + esc(t('wf.loading')) + '</div>';
    if (tk.output === null) return '<div class="empty">' + esc(t('bg.outputGone')) + '</div>';
    if (!tk.output.trim()) return '<div class="empty">' + esc(t('bg.outputEmpty')) + '</div>';
    return '<pre class="out" data-okey="' + esc(tk.key) + '">' + esc(tk.output) + '</pre>';
  }

  function isOpen(tk, upper) { return upper ? !closedUpper[tk.key] : !!openLower[tk.key]; }

  function renderCard(tk, upper) {
    const open = isOpen(tk, upper);
    const finished = tk.status !== 'running';
    const name = tk.description || tk.command;
    const timeHtml = tk.startedAt
      ? '<span class="run-time" data-started="' + tk.startedAt + '" data-done="' + (finished && tk.endedAt ? tk.endedAt : '') + '"></span>'
      : '';
    // The group already says a card is a long ordinary command; inside the background group the
    // chip tells a command from a monitor.
    const chip = tk.kind === 'foreground' ? ''
      : '<span class="mode-chip kind-' + esc(tk.kind) + '">' + esc(t('bg.kind.' + tk.kind)) + '</span>';
    let body = '';
    if (open) {
      const meta = [];
      if (tk.kind !== 'foreground') meta.push(esc(t('bg.taskId', tk.taskId)));
      if (tk.session) meta.push(esc(t('wf.session', tk.session)));
      if (tk.kind === 'monitor' && tk.eventCount) meta.push(esc(t('bg.events', tk.eventCount)));
      body = '<div class="meta">' + meta.join(' · ') + '</div>' +
        (finished && tk.summary ? '<div class="summary">' + esc(tk.summary) + '</div>' : '') +
        (tk.command ? '<pre class="cmd">' + esc('$ ' + tk.command) + '</pre>' : '') +
        outputHtml(tk);
    }
    return '<div class="run' + (open ? '' : ' collapsed') + '" data-id="' + esc(tk.key) + '" data-upper="' + (upper ? '1' : '0') + '">' +
      '<div class="run-head"><span class="arrow">▾</span>' +
        '<span class="dot ' + esc(tk.status) + '"></span>' +
        '<span class="run-name" title="' + esc(name) + '">' + esc(name) + '</span>' + chip +
        timeHtml + '<span class="spacer"></span>' + badge(tk) +
      '</div>' +
      '<div class="run-body">' + body + '</div>' +
    '</div>';
  }

  // An output box keeps its place across repaints: at the bottom it follows new lines, as the
  // remote-control view does; scrolled up, it stays where the reader left it.
  function captureScroll() {
    document.querySelectorAll('pre.out[data-okey]').forEach(function (el) {
      outScroll[el.getAttribute('data-okey')] = {
        top: el.scrollTop,
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4
      };
    });
  }
  function restoreScroll() {
    document.querySelectorAll('pre.out[data-okey]').forEach(function (el) {
      const s = outScroll[el.getAttribute('data-okey')];
      el.scrollTop = (!s || s.atBottom) ? el.scrollHeight : s.top;
    });
  }

  function renderGroup(id, title, g, doneKey, shown) {
    const upper = [], lower = [];
    g.running.forEach(function (tk) { watchedLive[tk.key] = true; upper.push(tk); });
    g.finished.forEach(function (tk) { (watchedLive[tk.key] ? upper : lower).push(tk); });
    upper.forEach(function (tk) { shown.push({ tk: tk, upper: true }); });
    lower.forEach(function (tk) { shown.push({ tk: tk, upper: false }); });
    const folded = !!foldedGroups[id];
    const head = '<div class="grp-hd' + (folded ? ' folded' : '') + '" data-gfold="' + esc(id) + '">' +
      '<span class="grp-fold">▾</span><span class="grp-name">' + esc(title) + '</span>' +
      '<span class="dur">' + esc(t('bg.groupCounts', g.running.length, g.finishedTotal)) + '</span></div>';
    let body;
    if (!upper.length && !lower.length) {
      body = '<div class="empty">' + esc(t('bg.groupEmpty')) + '</div>';
    } else {
      body = upper.map(function (tk) { return renderCard(tk, true); }).join('');
      if (lower.length) {
        const more = g.finishedTotal > g.finished.length
          ? '<span>· ' + esc(t('bg.doneGroupMore', g.finished.length, g.finishedTotal)) + '</span>'
          : '';
        body += '<div class="done-group' + (doneGroupOpen[id] ? '' : ' collapsed') + '">' +
          '<div class="done-head" data-dgroup="' + esc(id) + '"><span class="arrow">▾</span>' +
            '<span>' + esc(t(doneKey, lower.length)) + '</span>' + more +
            '<span class="spacer"></span>' +
            '<button class="del-btn" data-clear="' + esc(id) + '" title="' + esc(t('bg.clearDone')) + '">🗑</button>' +
          '</div>' +
          '<div class="done-body">' + lower.map(function (tk) { return renderCard(tk, false); }).join('') + '</div></div>';
      }
    }
    return head + '<div class="grp-body' + (folded ? ' folded' : '') + '">' + body + '</div>';
  }

  function askOutputs(shown) {
    shown.forEach(function (x) {
      const tk = x.tk;
      if (tk.status === 'running' || !isOpen(tk, x.upper) || asked[tk.key]) return;
      asked[tk.key] = true;
      vscodeApi.postMessage({ type: 'open', key: tk.key });
    });
  }

  function render(data, force) {
    const incoming = data || { background: emptyGroup(), long: emptyGroup(), longMinutes: 0 };
    const sig = JSON.stringify(incoming);
    if (!force && sig === lastSig) { last = incoming; return; }
    lastSig = sig;
    captureScroll();
    last = incoming;
    const list = document.getElementById('list');
    const sub = document.getElementById('sub');
    document.getElementById('scope').textContent = last.longMinutes ? t('bg.scope', last.longMinutes) : '';
    const bg = last.background, lg = last.long;
    if (!bg.running.length && !bg.finished.length && !lg.running.length && !lg.finished.length) {
      list.innerHTML = '<div class="empty">' + esc(t('bg.empty')) + '</div>';
      sub.textContent = t('cx.autoRefresh');
      return;
    }
    const parts = [];
    const nDone = bg.finishedTotal + lg.finishedTotal;
    if (nDone) parts.push(t('bg.nFinished', nDone));
    parts.push(t('bg.nRunning', bg.running.length + lg.running.length));
    parts.push(t('cx.autoRefresh'));
    sub.textContent = parts.join(' · ');

    const shown = [];
    list.innerHTML =
      renderGroup('background', t('bg.group.background'), bg, 'bg.doneGroup', shown) +
      renderGroup('long', t('bg.group.long', last.longMinutes), lg, 'bg.doneGroupLong', shown);
    restoreScroll();
    tick();
    askOutputs(shown);
  }

  document.addEventListener('click', function (e) {
    const fb = e.target.closest('[data-font]');
    if (fb) {
      fontPx = fb.getAttribute('data-font') === 'inc' ? Math.min(28, fontPx + 1) : Math.max(10, fontPx - 1);
      applyFont(); return;
    }
    const clr = e.target.closest('[data-clear]');
    if (clr) { vscodeApi.postMessage({ type: 'clearFinished', group: clr.getAttribute('data-clear') }); return; }
    const dg = e.target.closest('[data-dgroup]');
    if (dg) { const id = dg.getAttribute('data-dgroup'); doneGroupOpen[id] = !doneGroupOpen[id]; render(last, true); return; }
    const gf = e.target.closest('[data-gfold]');
    if (gf) { const id = gf.getAttribute('data-gfold'); foldedGroups[id] = !foldedGroups[id]; render(last, true); return; }
    const head = e.target.closest('.run-head');
    if (!head) return;
    const card = head.closest('.run');
    const key = card.getAttribute('data-id');
    const upper = card.getAttribute('data-upper') === '1';
    if (upper) closedUpper[key] = !closedUpper[key];
    else openLower[key] = !openLower[key];
    const nowOpen = upper ? !closedUpper[key] : !!openLower[key];
    if (!nowOpen) {
      delete asked[key];
      vscodeApi.postMessage({ type: 'close', key: key });
    }
    render(last, true);
  });

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (!m) return;
    // Before the first list lands the panel shows its loading line; re-rendering the empty initial
    // groups here would swap it for "nothing here" while the tasks are still being read.
    if (m.type === 'i18n') { dict = m.dict || {}; applyI18n(); if (gotTasks) render(last, true); }
    else if (m.type === 'tasks') { gotTasks = true; render(m.data); }
  });

  applyFont();
  vscodeApi.postMessage({ type: 'ready' });
})();
