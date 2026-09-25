// media/workflows.js — the workflow panel's webview script.
//
// It reads like the Codex panel on purpose (user's call, 2026-09-19): the card, the rows, the
// folding of routine commands, the finished-runs group and the trash all follow
// codexRescuePanel.ts. The one level a Codex run does not have is the agent — a workflow is
// several agents working at once — so an agent opens the way the Codex panel's command group
// does, and holds its own rows. Those rows are fetched only when the agent is opened: an agent
// log runs to hundreds of KB, and over Remote-SSH every read crosses the wire.
(function () {
  const vscodeApi = acquireVsCodeApi();
  let dict = {};
  let lang = 'en';
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
    markClipped();
    vscodeApi.setState(Object.assign({}, vscodeApi.getState(), { fontPx: fontPx }));
  }

  let lastWfs = [];
  let gotWfs = false;
  let lastRenderedSig = null;
  // Everything starts collapsed and is remembered only while the panel is open — the Codex
  // panel's rule. userToggled holds the cards the user opened.
  const userToggled = {};
  const openDetails = {};   // row / command-group key -> open
  const openAgents = {};    // agent key -> open
  const activity = {};      // agent key -> { items, report }, filled when the host answers
  const foldedPhases = {};  // card key + ' ' + phase -> folded
  let doneGroupOpen = false;
  // Cards seen while still running stay out of the finished group until the panel closes, so
  // the finish chime does not send you to a card that has just folded itself away.
  const watchedLive = {};

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
  function fmtDur(ms) {
    if (!ms || ms <= 0) return '';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  }
  function trimZero(x) { const v = x.toFixed(1); return v.slice(-2) === '.0' ? v.slice(0, -2) : v; }
  function fmtTok(n) {
    if (!n || n <= 0) return '';
    if (n >= 1000000) return trimZero(n / 1000000) + 'M';
    if (n >= 1000) return trimZero(n / 1000) + 'k';
    return String(n);
  }
  function fmtTokTotal(n) {
    if (!n || n <= 0) return '';
    if (lang === 'ko') return n >= 10000 ? Math.round(n / 10000).toLocaleString() + t('wf.unitMan') : n.toLocaleString();
    return fmtTok(n);
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

  function captureOpenDetails() {
    document.querySelectorAll('details[data-dkey]').forEach(function (d) {
      openDetails[d.getAttribute('data-dkey')] = d.open;
    });
  }

  // A workflow is running while any agent is, and a card with no agent yet is one that has
  // just started — unless its session is gone, in which case nothing will ever start.
  function stateOf(wf) {
    if (!wf.agents.length) return wf.sessionLive ? 'running' : 'stopped';
    if (wf.agents.some(function (a) { return a.status === 'running'; })) return 'running';
    if (wf.agents.some(function (a) { return a.status === 'stopped'; })) return 'stopped';
    return 'done';
  }

  function badgeOf(wf, st) {
    const done = wf.agents.filter(function (a) { return a.status === 'done'; }).length;
    const stopped = wf.agents.filter(function (a) { return a.status === 'stopped'; }).length;
    const total = wf.agents.length;
    if (st === 'running') return '<span class="badge running">' + done + '/' + total + ' ' + esc(t('wf.running')) + '</span>';
    if (st === 'stopped') return '<span class="badge stopped">' + esc(t('wf.doneStopped', done, stopped)) + '</span>';
    return '<span class="badge done">' + done + '/' + total + ' ' + esc(t('wf.done')) + '</span>';
  }

  // --- Rows: the Codex panel's markup, one to one ------------------------------------------

  function renderItem(it, scope) {
    const dur = fmtDur(it.durationMs);
    const durStr = dur ? '<span class="dur">· ' + dur + '</span>' : '';
    const head = '<summary class="it-head"><span class="dot ' + esc(it.status) + '"></span>' +
      '<span class="kind k-' + esc(it.kind) + '">' + esc(t('wf.kind.' + it.kind)) + '</span>' +
      '<span class="lbl" title="' + esc(it.label) + '">' + esc(it.label) + '</span>' + durStr + '</summary>';
    const full = it.body || '';
    const hasFull = !!full && full !== it.label;
    const more = !!(it.body && it.body.length > it.label.length);
    const dkey = scope + ' ' + it.id;
    const openAttr = openDetails[dkey] ? ' open' : '';
    return '<div class="it"><details class="row' + (hasFull ? ' hasfull' : '') +
      '" data-dkey="' + esc(dkey) + '" data-more="' + (more ? '1' : '0') + '"' + openAttr + '>' +
      head + (hasFull ? '<div class="full">' + esc(full) + '</div>' : '') + '</details></div>';
  }

  // Consecutive successful rows of the same routine kind fold into one line, as in the Codex
  // panel. A failure never joins a group — those are the rows worth reading.
  const GROUPABLE = {
    command_execution: 'wf.group.command_execution', file_read: 'wf.group.file_read',
    code_search: 'wf.group.code_search', web_search: 'wf.group.web_search'
  };
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
  function renderNode(node, scope) {
    if (node.one) return renderItem(node.one, scope);
    if (node.cmds.length === 1) return renderItem(node.cmds[0], scope);
    const gkey = scope + ' g' + node.cmds[0].id;
    const openAttr = openDetails[gkey] ? ' open' : '';
    return '<details class="cmdgroup" data-dkey="' + esc(gkey) + '"' + openAttr + '><summary>' +
      '<span class="dot done"></span><span class="kind k-' + esc(node.kind) + '">' +
      esc(t('wf.kind.' + node.kind)) + '</span><span class="gcount">' +
      esc(t(GROUPABLE[node.kind], node.cmds.length)) + '</span>' +
      '<span class="ghint"><span class="gh-open">' + esc(t('cx.expand')) + '</span>' +
      '<span class="gh-close">' + esc(t('cx.collapse')) + '</span></span></summary>' +
      node.cmds.map(function (it) { return renderItem(it, scope); }).join('') + '</details>';
  }

  // The agent's final report, as the last row: the Codex panel's result-document link, drawn
  // in place because there is no document to open.
  function renderReport(akey, report) {
    const first = report.replace(/\s+/g, ' ').trim();
    const dkey = akey + ' report';
    const openAttr = openDetails[dkey] ? ' open' : '';
    return '<div class="it"><details class="row hasfull" data-dkey="' + esc(dkey) + '" data-more="1"' + openAttr + '>' +
      '<summary class="it-head"><span class="dot done"></span><span class="kind k-report">' + esc(t('wf.kind.report')) + '</span>' +
      '<span class="lbl">' + esc(first) + '</span></summary><div class="full">' + esc(report) + '</div></details></div>';
  }

  function agentBody(a) {
    if (!openAgents[a.akey]) return '';
    const act = activity[a.akey];
    if (!act) return '<div class="empty">' + esc(t('wf.loading')) + '</div>';
    const rows = act.items && act.items.length
      ? groupRuns(act.items).map(function (n) { return renderNode(n, a.akey); }).join('')
      : '<div class="empty">' + esc(t('cx.noItems')) + '</div>';
    const report = act.report ? renderReport(a.akey, act.report) : '';
    return '<div class="items">' + rows + report + '</div>';
  }

  function renderAgent(a, label, title) {
    const dur = fmtDur(a.durationMs);
    const durStr = dur ? '<span class="dur">' + (a.status === 'running' ? esc(t('wf.elapsed')) : '') + dur + '</span>' : '';
    const stoppedTag = a.status === 'stopped' ? '<span class="stopped-tag">' + esc(t('wf.stopped')) + '</span>' : '';
    const model = a.model ? '<span class="a-model">' + esc(a.model) + '</span>' : '';
    const tok = a.tokens
      ? '<span class="a-tok" title="' + esc(t('wf.tokensExact', a.tokens.toLocaleString())) + '">' + esc(fmtTok(a.tokens)) + '</span>'
      : '';
    const open = !!openAgents[a.akey];
    return '<details class="agent" data-akey="' + esc(a.akey) + '"' + (open ? ' open' : '') + '><summary>' +
      '<div class="agent-head"><span class="dot ' + esc(a.status) + '"></span>' +
      '<span class="aname" title="' + esc(title) + '">' + esc(label) + '</span>' + stoppedTag +
      '<span class="spacer"></span>' + model + tok + durStr +
      '<span class="ghint"><span class="gh-open">' + esc(t('cx.expand')) + '</span>' +
      '<span class="gh-close">' + esc(t('cx.collapse')) + '</span></span></div>' +
      (a.summary ? '<div class="agent-sub">' + esc(a.summary) + '</div>' : '') +
      '</summary><div class="agent-body">' + agentBody(a) + '</div></details>';
  }

  function renderCard(wf) {
    const st = stateOf(wf);
    // Identical labels (roles that clip to the same text) get their position appended.
    const labelCounts = {};
    wf.agents.forEach(function (a) { const k = (a.name && a.name.trim()) || ''; if (k) labelCounts[k] = (labelCounts[k] || 0) + 1; });
    function agentHtml(a, i) {
      const nm = (a.name && a.name.trim()) || '';
      const label = nm ? (labelCounts[nm] > 1 ? nm + ' (' + (i + 1) + ')' : nm) : t('wf.agentN', i + 1);
      return renderAgent(a, label, (a.fullName && a.fullName.trim()) || label);
    }
    const indexed = wf.agents.map(function (a, i) { return { a: a, i: i }; });
    const placed = wf.agents.filter(function (a) { return a.phase; }).length;
    // Group only when the script declared real phases and most agents were placed — a phase
    // holding one agent above nine loose ones is worse than no phases at all.
    const useGroups = !!(wf.phases && wf.phases.length >= 2) && wf.agents.length > 0 && placed * 2 >= wf.agents.length;

    let agents;
    if (!wf.agents.length) {
      agents = '<div class="empty">' + esc(t('wf.noAgents')) + '</div>';
    } else if (!useGroups) {
      agents = '<div class="agents">' + indexed.map(function (x) { return agentHtml(x.a, x.i); }).join('') + '</div>';
    } else {
      const groups = [];
      wf.phases.forEach(function (p) {
        const mem = indexed.filter(function (x) { return x.a.phase === p; });
        if (mem.length) groups.push({ title: p, items: mem });
      });
      const rest = indexed.filter(function (x) { return !x.a.phase || wf.phases.indexOf(x.a.phase) < 0; });
      if (rest.length) groups.push({ title: t('wf.phaseOther'), items: rest });
      // A phase is drawn the way the Codex panel draws a turn: boxed name, a rule off it,
      // click to fold. Open by default, as a turn is.
      agents = groups.map(function (g) {
        const fkey = wf.key + ' ' + g.title;
        const folded = !!foldedPhases[fkey];
        const doneN = g.items.filter(function (x) { return x.a.status === 'done'; }).length;
        return '<div class="turn-hd' + (folded ? ' folded' : '') + '" data-pfold="' + esc(fkey) + '">' +
            '<span class="turn-fold">▾</span><span class="turn-no">' + esc(g.title) + '</span>' +
            '<span class="dur">' + doneN + '/' + g.items.length + '</span></div>' +
          '<div class="turn-body' + (folded ? ' folded' : '') + '"><div class="agents">' +
            g.items.map(function (x) { return agentHtml(x.a, x.i); }).join('') + '</div></div>';
      }).join('');
    }

    const totalTok = wf.agents.reduce(function (acc, a) { return acc + (a.tokens || 0); }, 0);
    const meta = [];
    if (!wf.isTask) meta.push(esc(wf.wfId));
    if (wf.session) meta.push(esc(t(wf.sessionLive ? 'wf.sessionLive' : 'wf.session', wf.session)));
    if (wf.agents.length) meta.push(esc(t('wf.headAgents', wf.agents.length)));
    if (totalTok) meta.push(esc(t('wf.headTokens', fmtTokTotal(totalTok))));

    const finished = st !== 'running';
    const timeHtml = wf.startedAt
      ? '<span class="run-time" data-started="' + wf.startedAt + '" data-done="' + (finished && wf.endedAt ? wf.endedAt : '') + '"></span>'
      : '';
    // Only finished cards get a delete button, as in the Codex panel — moving a workflow's
    // folder out from under a running agent would corrupt it rather than keep it. A batch of
    // sub-agents goes to the same trash (2026-09-24), so the button reads the same.
    const delBtn = finished
      ? '<button class="del-btn" data-del="' + esc(wf.key) + '" title="' + esc(t('common.delete')) + '">🗑</button>'
      : '';
    const title = wf.name + (wf.description ? '\n' + wf.description : '');
    return '<div class="run' + (userToggled[wf.key] ? '' : ' collapsed') + '" data-id="' + esc(wf.key) + '">' +
      '<div class="run-head"><span class="arrow">▾</span>' +
        '<span class="run-name" title="' + esc(title) + '">' + esc(wf.name) + '</span>' +
        (wf.isTask ? '<span class="mode-chip task-chip">' + esc(t('wf.taskChip')) + '</span>' : '') +
        timeHtml + '<span class="spacer"></span>' + badgeOf(wf, st) + delBtn +
      '</div>' +
      '<div class="run-body">' +
        '<div class="meta">' + meta.join(' · ') + '</div>' +
        (wf.description ? '<div class="wf-desc">' + esc(wf.description) + '</div>' : '') +
        agents +
      '</div>' +
    '</div>';
  }

  function render(wfs, force) {
    const incoming = wfs || [];
    const sig = JSON.stringify(incoming);
    if (!force && sig === lastRenderedSig) { lastWfs = incoming; return; }
    lastRenderedSig = sig;
    captureOpenDetails();
    lastWfs = incoming;
    const list = document.getElementById('list');
    const sub = document.getElementById('sub');
    if (!lastWfs.length) {
      list.innerHTML = '<div class="empty">' + esc(t('wf.empty')) + '</div>';
      sub.textContent = '';
      return;
    }
    let nLive = 0, nDone = 0, nStop = 0;
    const liveCards = [], overCards = [];
    let gStop = 0;
    lastWfs.forEach(function (wf) {
      const st = stateOf(wf);
      if (st === 'running') nLive++; else if (st === 'stopped') nStop++; else nDone++;
      if (st === 'running') watchedLive[wf.key] = true;
      const html = renderCard(wf);
      if (st === 'running' || watchedLive[wf.key]) { liveCards.push(html); return; }
      overCards.push(html);
      if (st === 'stopped') gStop++;
    });
    const parts = [];
    if (nDone) parts.push(t('cx.nDone', nDone));
    if (nStop) parts.push(t('cx.nStopped', nStop));
    parts.push(t('cx.nLive', nLive));
    parts.push(t('cx.autoRefresh'));
    sub.textContent = parts.join(' · ');

    let html = liveCards.join('');
    if (overCards.length) {
      html += '<div class="done-group' + (doneGroupOpen ? '' : ' collapsed') + '">' +
        '<div class="done-head" data-dgroup="1"><span class="arrow">▾</span>' +
          '<span>' + esc(t('wf.doneGroup', overCards.length)) + '</span>' +
          (gStop ? '<span>· ' + esc(t('cx.nStopped', gStop)) + '</span>' : '') +
        '</div>' +
        '<div class="done-body">' + overCards.join('') + '</div></div>';
    }
    list.innerHTML = html;
    tick();
    markClipped();
  }

  // Same as the Codex panel: a row is only worth opening if its label is actually cut off, and
  // that can only be measured after layout.
  function markClipped() {
    document.querySelectorAll('details.row').forEach(function (d) {
      if (d.open) return;
      const lbl = d.querySelector('.lbl');
      const clipped = !!lbl && lbl.scrollWidth > lbl.clientWidth + 1;
      d.classList.toggle('plain', d.getAttribute('data-more') !== '1' && !clipped);
    });
  }
  window.addEventListener('resize', markClipped);

  // --- Trash ----------------------------------------------------------------------------
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
      return '<div class="trash-row">' +
        '<span class="trash-name" title="' + esc(it.wfId) + '">' + esc(it.name || it.wfId) + '</span>' +
        '<span class="trash-meta">' + esc(t('wf.trash.agents', it.agentCount || 0)) + '</span>' +
        '<span class="spacer"></span>' +
        '<span class="trash-meta">' + esc(it.deletedAt ? t('wf.trash.deletedAt', fmtClock(it.deletedAt)) : '') + '</span>' +
        '<button class="tbtn" data-restore="' + esc(it.key) + '">' + esc(t('wf.trash.restore')) + '</button>' +
        '<button class="tbtn danger" data-purge="' + esc(it.key) + '">' + esc(t('wf.trash.purge')) + '</button>' +
      '</div>';
    }).join('');
  }

  document.addEventListener('click', function (e) {
    const fb = e.target.closest('[data-font]');
    if (fb) {
      fontPx = fb.getAttribute('data-font') === 'inc' ? Math.min(28, fontPx + 1) : Math.max(10, fontPx - 1);
      applyFont(); return;
    }
    const tt = e.target.closest('[data-trash]');
    if (tt) {
      if (tt.getAttribute('data-trash') === 'toggle') toggleTrash();
      else vscodeApi.postMessage({ type: 'emptyTrash' });
      return;
    }
    const rs = e.target.closest('[data-restore]');
    if (rs) { vscodeApi.postMessage({ type: 'restore', key: rs.getAttribute('data-restore') }); return; }
    const pg = e.target.closest('[data-purge]');
    if (pg) { vscodeApi.postMessage({ type: 'purge', key: pg.getAttribute('data-purge') }); return; }
    const pf = e.target.closest('[data-pfold]');
    if (pf) {
      const k = pf.getAttribute('data-pfold');
      foldedPhases[k] = !foldedPhases[k];
      // Flip what is drawn rather than re-rendering: a poll can land between click and repaint.
      pf.classList.toggle('folded', foldedPhases[k]);
      const body = pf.nextElementSibling;
      if (body && body.classList.contains('turn-body')) body.classList.toggle('folded', foldedPhases[k]);
      return;
    }
    const dg = e.target.closest('[data-dgroup]');
    if (dg) { doneGroupOpen = !doneGroupOpen; render(lastWfs, true); return; }
    const del = e.target.closest('[data-del]');
    if (del) { vscodeApi.postMessage({ type: 'delete', key: del.getAttribute('data-del') }); return; }
    const plain = e.target.closest('details.row.plain > summary');
    if (plain) { e.preventDefault(); return; }
    const head = e.target.closest('.run-head');
    if (head) {
      const id = head.closest('.run').getAttribute('data-id');
      userToggled[id] = !userToggled[id];
      render(lastWfs, true);
    }
  });

  document.addEventListener('toggle', function (e) {
    const d = e.target;
    if (!d || !d.matches) return;
    if (d.matches('details.agent[data-akey]')) {
      const ak = d.getAttribute('data-akey');
      if (d.open === !!openAgents[ak]) return;   // our own re-render restoring the state
      if (d.open) {
        openAgents[ak] = true;
        // Ask every time: a finished agent's rows are cached host-side, a running one's are not.
        vscodeApi.postMessage({ type: 'agentOpen', akey: ak });
        if (!activity[ak]) d.querySelector('.agent-body').innerHTML = agentBody({ akey: ak });
      } else {
        delete openAgents[ak];
        vscodeApi.postMessage({ type: 'agentClose', akey: ak });
      }
      return;
    }
    if (!d.matches('details[data-dkey]')) return;
    openDetails[d.getAttribute('data-dkey')] = d.open;
    if (d.open) {
      // Accordion, as in the Codex panel: two opened rows side by side leave no list to read by.
      if (d.matches('details.row')) {
        document.querySelectorAll('details.row[open]').forEach(function (other) {
          if (other === d) return;
          other.open = false;
          openDetails[other.getAttribute('data-dkey')] = false;
        });
      }
    } else {
      markClipped();
    }
  }, true);

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (!m) return;
    // Before the first list lands the panel shows its loading line; re-rendering the empty initial
    // list here would swap it for "no workflows" while they are still being read.
    if (m.type === 'i18n') { dict = m.dict || {}; lang = m.lang || 'en'; applyI18n(); if (gotWfs) render(lastWfs, true); }
    else if (m.type === 'workflows') { gotWfs = true; render(m.workflows); }
    else if (m.type === 'trash') renderTrash(m.items || []);
    else if (m.type === 'activity') {
      activity[m.akey] = { items: m.items || [], report: m.report || '' };
      if (openAgents[m.akey]) render(lastWfs, true);
    }
  });

  applyFont();
  vscodeApi.postMessage({ type: 'ready' });
})();
