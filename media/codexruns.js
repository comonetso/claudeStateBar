// media/codexruns.js — the Codex progress tab of the activity panel (codexRescuePanel.ts).
//
// Moved out of the panel's template literal (2026-09-30) when the panel became a tab. Runs
// alongside the other tabs' scripts in one webview, so it talks to the host through
// window.ActivityHost, prefixes its ids with cx- and keeps its queries inside its own pane.
(function () {
  'use strict';
  const vscodeApi = window.ActivityHost.api('codexRuns');
  // This tab's <section>. Queries and listeners stay inside it: the other tabs share the document.
  const root = window.ActivityHost.root('codexRuns');
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
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      const v = dict[el.getAttribute('data-i18n')]; if (typeof v === 'string') el.textContent = v;
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      const v = dict[el.getAttribute('data-i18n-title')]; if (typeof v === 'string') el.title = v;
    });
  }

  const savedState = vscodeApi.getState() || {};
  let fontPx = savedState.fontPx || 15;
  function applyFont() {
    root.style.fontSize = fontPx + 'px';
    // Bigger text clips more labels, smaller text clips fewer — re-measure after every change.
    markClipped();
    vscodeApi.setState(Object.assign({}, vscodeApi.getState(), { fontPx }));
  }
  applyFont();

  let lastRuns = [];
  const userToggled = {};
  const openDetails = {};
  // Turns start open and only close when clicked. Unlike the run cards above, a turn is
  // already a chosen scope — the user opened this card to read it — so hiding it by default
  // would just add a second click to reach what they asked for.
  const foldedTurns = {};
  let lastRenderedSig = null;
  // The finished-runs group starts closed every time the panel opens (user's call, 2026-09-19):
  // the list is opened to see what is running, and the finished ones are what got in the way.
  let doneGroupOpen = false;
  // Runs this panel has seen while they were still going. They stay out of the finished group
  // until the panel is closed (user's call, 2026-09-19): the finish chime brings you here to read
  // the result, and the card folding away at that moment would undo the reason you came.
  const watchedLive = {};

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
  function fmtHM(ms) {
    const d = new Date(ms);
    return pad2(d.getHours())+':'+pad2(d.getMinutes());
  }
  // Same short form as the workflow tab's agent tokens (7.1M, 256k); the exact count is on hover.
  function trimZero(x) { const v = x.toFixed(1); return v.slice(-2) === '.0' ? v.slice(0, -2) : v; }
  function fmtTok(n) {
    if (!n || n <= 0) return '';
    if (n >= 1000000) return trimZero(n / 1000000) + 'M';
    if (n >= 1000) return trimZero(n / 1000) + 'k';
    return String(n);
  }
  function isOver(r) { return r.phase === 'done' || r.phase === 'failed' || r.phase === 'stopped'; }
  // "model - effort · tokens" in small print under a card's title, so a folded card says what ran
  // and how much it used (user's request, 2026-10-01). It sits on its own line rather than in the
  // head: on the head line it crowded the title and left a long one nowhere to go (user's call,
  // same day). Tokens are the thread's running total with cached input included (user's call) —
  // the same figure the expanded card has always shown. A live run gets the count while it works
  // only on codex_rescue 1.17.3+; before that it appears at the end.
  function runStat(run) {
    const parts = [];
    if (run.model) parts.push(run.model + (run.effort ? ' - ' + run.effort : ''));
    if (run.totalTokens) parts.push(fmtTok(run.totalTokens));
    if (!parts.length) return '';
    const hover = run.totalTokens ? t('cx.tokens', run.totalTokens.toLocaleString()) : '';
    return '<div class="run-sub"' + (hover ? ' title="' + esc(hover) + '"' : '') + '>' + esc(parts.join(' · ')) + '</div>';
  }
  // Independent 1s ticker so a running run's clock advances even when its data is unchanged.
  function tick() {
    const now = Date.now();
    root.querySelectorAll('.run-time[data-started]').forEach(function (el) {
      const started = Number(el.getAttribute('data-started'));
      if (!started) return;
      const doneEnd = el.getAttribute('data-done');
      const elapsed = doneEnd ? (Number(doneEnd) - started) : (now - started);
      const label = doneEnd ? t('wf.took') : t('wf.elapsed');
      let text = '🕘 ' + fmtClock(started) + ' · ' + label + fmtElapsed(elapsed);
      // Multi-turn only: the wall clock above includes the gaps between turns, when Claude was
      // reading and rewriting, so the time Codex itself spent is shown beside it.
      const work = el.getAttribute('data-work');
      if (work !== null) {
        const wlive = Number(el.getAttribute('data-wlive')) || 0;
        text += ' (' + t('cx.workSum') + fmtElapsed(Number(work) + (wlive ? now - wlive : 0)) + ')';
      }
      el.textContent = text;
    });
    // Per-turn clock: time of day only, since the card clock right above already has the date.
    root.querySelectorAll('.turn-time[data-started]').forEach(function (el) {
      const started = Number(el.getAttribute('data-started'));
      if (!started) return;
      const doneEnd = el.getAttribute('data-done');
      const elapsed = doneEnd ? (Number(doneEnd) - started) : (now - started);
      const label = doneEnd ? t('wf.took') : t('wf.elapsed');
      el.textContent = fmtHM(started) + ' · ' + label + fmtElapsed(elapsed);
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
    root.querySelectorAll('details[data-dkey]').forEach(function (d) {
      openDetails[d.getAttribute('data-dkey')] = d.open;
    });
  }
  function sigOf(runs) {
    return JSON.stringify((runs||[]).map(function (r) {
      return [r.stamp, r.tag||'', r.groupKey||'', r.phase, r.endedAt||0, r.totalTokens||0, r.todo, !!r.resultUri, (r.model||'') + '/' + (r.effort||''),
        r.items.map(function (i) { return [i.id,i.status,i.label,i.body,i.durationMs,i.turn||1]; }),
        (r.turnDocs||[]).map(function (d) { return [d.startedAt||0, d.endedAt||0]; })];
    }));
  }

  // The latest thing said inside ONE turn — Codex narrating its plan, or Claude cutting in.
  //
  // A multi-turn run used to show a single narration for the whole card, which meant turn 2's
  // sentence sat above turn 1's activities and read as if it belonged to them. Scoping it per
  // turn keeps each turn's own words with that turn, and a finished turn keeps the last thing
  // it said instead of going blank the moment the next one starts.
  //
  // A steer counts as speech on purpose: an interruption is the one line a reader most needs
  // to see, and the row itself can be too short to expand.
  function narrationOfTurn(items, turn) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.turn || 1) !== turn) continue;
      if (it.kind === 'agent_message' || it.kind === 'reasoning' || it.kind === 'claude_steer') {
        return { text: it.body || it.label, steer: it.kind === 'claude_steer' };
      }
    }
    return null;
  }

  // Nothing once the run is over. The last agent_message of a finished run is the whole answer
  // document (26 KB in the reference run) and showing its frontmatter as "current activity" is
  // noise — the result doc link covers that. Multi-turn applies the same rule per turn, in
  // turnHead(): a turn stops narrating the moment a later turn begins.
  function narrationOf(run) {
    if (run.phase === 'done' || run.phase === 'failed' || run.phase === 'stopped') return null;
    // 🔴 Multi-turn draws one of these under every turn header. Drawing a card-level one too
    // renders turn 1's sentence twice — once at the top and once under its own header.
    let maxT = 1;
    run.items.forEach(function (it) { const n = it.turn || 1; if (n > maxT) maxT = n; });
    if (maxT >= 2) return null;
    return narrationOfTurn(run.items, 1);
  }

  function render(runs, force) {
    const incoming = runs || [];
    const sig = sigOf(incoming);
    if (!force && sig === lastRenderedSig) { lastRuns = incoming; return; }
    lastRenderedSig = sig;
    captureOpenDetails();
    lastRuns = incoming;
    const list = document.getElementById('cx-list');
    const sub = document.getElementById('cx-sub');
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

    const cards = lastRuns.map(function (run, index) {
      const phase = run.phase;
      const badgeCls = (phase==='starting'||phase==='finalizing') ? 'running' : phase;
      const badge = '<span class="badge ' + esc(badgeCls) + '">' + esc(t('cx.phase.'+phase)) + '</span>';

      // Says-block markup, shared by the card-level one (single turn) and the per-turn ones.
      // A steer gets the Claude orange so the eye lands on it without reading the text.
      function saysBlock(n) {
        if (!n || !n.text) return '';
        return '<div class="now' + (n.steer ? ' steer' : '') + '">' + esc(n.text) + '</div>';
      }

      // Only drawn on a single-turn run — a multi-turn one puts one of these under each turn
      // header instead, so having a card-level block too would duplicate turn 1's sentence.
      const narration = narrationOf(run);
      const nowBlock = saysBlock(narration);

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
          const rowCls = it.kind === 'claude_steer' ? 'it steer' : 'it';
          return '<div class="' + rowCls + '"><details class="row' + (hasFull ? ' hasfull' : '') +
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
        let bucket = null, bucketKind = null, bucketTurn = 0;
        list.forEach(function (it) {
          const turn = it.turn || 1;
          const can = GROUPABLE[it.kind] && it.status === 'done';
          // A group must never straddle a turn boundary: folding the last commands of one
          // turn together with the first of the next would swallow the very seam the turn
          // headers exist to show, and the header could then only land above the whole group.
          if (can && it.kind === bucketKind && turn === bucketTurn) {
            bucket.push(it);
          } else if (can) {
            bucket = [it]; bucketKind = it.kind; bucketTurn = turn;
            out.push({ cmds: bucket, kind: it.kind, turn: turn });
          } else {
            bucket = null; bucketKind = null; bucketTurn = 0;
            out.push({ one: it, turn: turn });
          }
        });
        return out;
      }

      // Headers are for follow-up runs only. A run that never got a second question must look
      // exactly as it did before, so nothing is drawn unless some item reports a turn above 1 —
      // and once one does, numbering starts at turn 1, since a header appearing first at turn 2
      // leaves everything above it unlabelled.
      let maxTurn = 1;
      run.items.forEach(function (it) { const n = it.turn || 1; if (n > maxTurn) maxTurn = n; });
      let shownTurn = 0;
      // A turn is over once a later turn exists, or once the whole run has stopped moving.
      // Nothing else marks the boundary: there is no per-turn terminal event to read.
      const runOver = run.phase === 'done' || run.phase === 'failed' || run.phase === 'stopped';
      function turnFinished(turn) { return turn < maxTurn || runOver; }

      // Per-turn document links. The request is a file of its own for every turn; the result
      // is the one response document, so each turn points at it with an anchor and the opener
      // scrolls there. Without the anchor a turn-3 link would drop you at turn 1 every time.
      function turnEntry(turn) {
        const docs = run.turnDocs || [];
        for (let i = 0; i < docs.length; i++) { if (docs[i].turn === turn) return docs[i]; }
        return null;
      }
      function turnLinks(turn) {
        const entry = turnEntry(turn);
        const out = [];
        if (run.resultUri) {
          const anchor = entry && entry.resultAnchor
            ? ' data-anchor="' + esc(entry.resultAnchor) + '"' : '';
          out.push('<span class="doclink" data-open="' + esc(run.resultUri) + '"' + anchor + '">📄 '
                 + esc(t('cx.openResult')) + '</span>');
        }
        if (entry && entry.requestUri) {
          out.push('<span class="doclink" data-open="' + esc(entry.requestUri) + '">📝 '
                 + esc(t('cx.openRequest')) + '</span>');
        }
        return out.length ? '<span class="turn-links">' + out.join('') + '</span>' : '';
      }

      // Only the turn still running says anything. A finished turn's last message is its whole
      // answer document, and pinning that under the header buries the run in one enormous
      // block — the single-turn rule in narrationOf(), applied per turn. The answer is not
      // lost: it is one click away under this turn's own result link.
      function turnSays(turn) {
        return turnFinished(turn) ? '' : saysBlock(narrationOfTurn(run.items, turn));
      }

      // A finished turn with no end on record gets nothing: a start with no duration beside it
      // would read as a turn still running. Only the turn actually in flight counts up.
      function turnTime(turn) {
        const e = turnEntry(turn);
        if (!e || !e.startedAt) return '';
        if (!e.endedAt && turnFinished(turn)) return '';
        return '<span class="turn-time" data-started="' + e.startedAt + '" data-done="' + (e.endedAt || '') + '"></span>';
      }

      function turnHead(turn) {
        if (maxTurn < 2 || turn === shownTurn) return '';
        shownTurn = turn;
        const fkey = run.stamp + ':' + turn;
        const folded = !!foldedTurns[fkey];
        return '<div class="turn-hd' + (folded ? ' folded' : '') + '" data-tfold="' + esc(fkey) + '">' +
                 '<span class="turn-fold">▾</span>' +
                 '<span class="turn-no">' + esc(t('cx.turnHeader', turn)) + '</span>' +
                 turnTime(turn) +
                 turnLinks(turn) +
               '</div>';
      }

      // Codex's own time across all turns, for the card clock. Only when every turn is timed:
      // a sum with a turn missing would be wrong, and it is shown as a fact. The turn in flight
      // is passed as its start so the ticker can keep the sum moving.
      function workClock() {
        const docs = run.turnDocs;
        if (!docs || docs.length < 2) return null;
        let sum = 0, live = 0;
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i];
          if (!d.startedAt) return null;
          if (d.endedAt) sum += d.endedAt - d.startedAt;
          else if (i === docs.length - 1 && !runOver) live = d.startedAt;
          else return null;
        }
        return { sum: sum, live: live };
      }

      function renderNode(node) {
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
      }

      // A multi-turn run wraps each turn's nodes so the header can collapse them. A single-turn
      // one emits exactly what it did before: turnHead() returns nothing and no wrapper opens,
      // so the markup is byte-identical to the pre-turn-header version.
      function renderNodes(nodes) {
          let out = '';
          let openTurn = 0;
          nodes.forEach(function (node) {
            const tn = node.turn || 1;
            if (maxTurn >= 2 && tn !== openTurn) {
              if (openTurn) out += '</div>';
              const fkey = run.stamp + ':' + tn;
              // The says-block lives inside the body so one class toggle hides the whole turn.
              out += turnHead(tn)
                   + '<div class="turn-body' + (foldedTurns[fkey] ? ' folded' : '') + '">'
                   + turnSays(tn);
              openTurn = tn;
            }
            out += renderNode(node);
          });
          if (openTurn) out += '</div>';
          return out;
      }

      const items = run.items.length
        ? '<div class="items">' + renderNodes(groupRuns(run.items)) + '</div>'
        : '<div class="empty">' + esc(t(run.docsOnly ? 'cx.docsOnly.note' : 'cx.noItems')) + '</div>';

      // Card-level links belong to a single-turn run. A multi-turn one moves them next to each
      // turn header instead: one document pair per turn is what you actually want to open, and
      // a single pair at the top can only point at the whole file.
      const links = [];
      if (!run.turnDocs) {
        if (run.resultUri) links.push('<span class="doclink" data-open="' + esc(run.resultUri) + '">📄 ' + esc(t('cx.openResult')) + '</span>');
        if (run.requestUri) links.push('<span class="doclink" data-open="' + esc(run.requestUri) + '">📝 ' + esc(t('cx.openRequest')) + '</span>');
      }

      const tokenLine = run.totalTokens ? '<br>' + esc(t('cx.tokens', run.totalTokens.toLocaleString())) : '';
      const staleLine = (phase === 'stale')
        ? '<div class="warn">' + esc(t('cx.staleHint', Math.round((run.staleForMs||0)/1000))) + '</div>' : '';

      const finished = (phase==='done'||phase==='failed'||phase==='stopped');
      // The work attributes appear on multi-turn runs only, so a single-turn card's markup is
      // unchanged.
      const wc = workClock();
      const timeHtml = run.startedAt
        ? '<span class="run-time" data-started="' + run.startedAt + '" data-done="' + (finished && run.endedAt ? run.endedAt : '') + '"' +
          (wc ? ' data-work="' + wc.sum + '" data-wlive="' + (wc.live || '') + '"' : '') + '></span>'
        : '';

      return '<div class="run' + (isExpanded(run.stamp)?'':' collapsed') + '" data-id="' + esc(run.stamp) + '">' +
        '<div class="run-head">' +
          '<span class="arrow">▾</span>' +
          // Prefer the subject: the slug is a filename fragment and reads as a symbol. Either
          // way the slug stays in the hover, since it is what the files on disk are named.
          '<span class="run-name" title="' + esc(run.subject ? run.subject + '\n' + run.slug : run.slug) + '">' +
            esc(run.subject || run.slug) + '</span>' +
          (run.mode ? '<span class="mode-chip">' + esc(run.mode.toUpperCase()) + '</span>' : '') +
          // How many turns a follow-up run took, readable with the card folded. Single-turn
          // cards get nothing, so their header is unchanged.
          (maxTurn >= 2 ? '<span class="mode-chip">' + esc(t('cx.turnCount', maxTurn)) + '</span>' : '') +
          (run.tag ? '<span class="mode-chip tree-chip" title="' + esc(run.tagPath || run.tag) + '">⎇ ' + esc(run.tag) + '</span>' : '') +
          (run.docsOnly ? '<span class="mode-chip docs-chip">' + esc(t('cx.docsOnly.badge')) + '</span>' : '') +
          timeHtml + '<span class="spacer"></span>' + badge +
          // Only finished runs get a delete button — deleting mid-write would race send.sh.
          (finished ? '<button class="del-btn" data-del="' + esc(run.stamp) + '" title="' + esc(t('common.delete')) + '">🗑</button>' : '') +
        '</div>' +
        // Outside run-body, so it stays visible on a folded card.
        runStat(run) +
        '<div class="run-body">' +
          '<div class="meta">' + esc(run.stamp) +
            (run.threadId ? ' · thread ' + esc(run.threadId.slice(0,8)) : '') +
            (run.model ? ' · ' + esc(run.model) + (run.effort ? ' / ' + esc(run.effort) : '') : '') + tokenLine +
            (links.length ? '<br>' + links.join(' &nbsp; ') : '') +
          '</div>' +
          staleLine + nowBlock + plan + items +
        '</div>' +
      '</div>';
    });

    // Runs Claude started together — same batch name from the same conversation, carried in
    // groupKey — draw as one group card (user's call, 2026-10-01). A key only one run holds stays
    // a plain card, the same rule as the command groups inside a card. The list is newest first,
    // so a group sits where its newest run would have.
    const keyCount = {};
    lastRuns.forEach(function (r) { if (r.groupKey) keyCount[r.groupKey] = (keyCount[r.groupKey] || 0) + 1; });
    const units = [];
    const unitAt = {};
    lastRuns.forEach(function (r, i) {
      const k = (r.groupKey && keyCount[r.groupKey] >= 2) ? r.groupKey : null;
      if (!k) { units.push({ idx: [i] }); return; }
      if (!(k in unitAt)) { unitAt[k] = units.length; units.push({ key: k, idx: [] }); }
      units[unitAt[k]].idx.push(i);
    });

    function groupCard(u, rs) {
      const gid = 'g:' + u.key;
      const nLiveG = rs.filter(function (r) { return r.phase==='running'||r.phase==='starting'||r.phase==='finalizing'; }).length;
      const nStaleG = rs.filter(function (r) { return r.phase === 'stale'; }).length;
      const nDoneG = rs.filter(function (r) { return r.phase === 'done'; }).length;
      const nFailG = rs.filter(function (r) { return r.phase === 'failed'; }).length;
      const nStopG = rs.filter(function (r) { return r.phase === 'stopped'; }).length;
      const allOver = rs.every(isOver);
      // Open while anything in it is still going, folded once it is all over (user's call,
      // 2026-10-01). A click overrides that and sticks, like a run card's.
      const open = (gid in userToggled) ? userToggled[gid] : !allOver;
      // The worst state inside wins the badge, so a failure is visible with the group folded.
      const state = nLiveG ? 'running' : nStaleG ? 'stale' : nFailG ? 'failed' : nStopG ? 'stopped' : 'done';
      const badge = '<span class="badge ' + state + '">' + esc(t('cx.phase.' + state)) + '</span>';
      const counts = [t('cx.grp.progress', nDoneG, rs.length)];
      if (nFailG) counts.push(t('cx.nFailed', nFailG));
      if (nStopG) counts.push(t('cx.nStopped', nStopG));
      // The combined count goes under the title in small print, the same place a run card puts
      // its own. Only the count: runs in one group can use different models.
      const tok = rs.reduce(function (a, r) { return a + (r.totalTokens || 0); }, 0);
      const tokHtml = tok
        ? '<div class="run-sub" title="' + esc(t('cx.grp.tokens', tok.toLocaleString())) + '">' + esc(fmtTok(tok)) + '</div>'
        : '';
      // First start to last end. Left out when a finished group lacks an end on record: a start
      // with nothing to stop it would count up forever, as if the group were still running.
      const starts = rs.map(function (r) { return r.startedAt || 0; }).filter(Boolean);
      const ends = rs.map(function (r) { return r.endedAt || 0; }).filter(Boolean);
      let timeHtml = '';
      if (starts.length && (!allOver || ends.length === rs.length)) {
        timeHtml = '<span class="run-time" data-started="' + Math.min.apply(null, starts) +
          '" data-done="' + (allOver ? Math.max.apply(null, ends) : '') + '"></span>';
      }
      return '<div class="grp' + (open ? '' : ' collapsed') + '">' +
        '<div class="grp-head" data-gid="' + esc(gid) + '" data-gopen="' + (open ? '1' : '0') + '">' +
          '<span class="arrow">▾</span>' +
          '<span class="grp-name" title="' + esc(rs[0].group || '') + '">' + esc(rs[0].group || '') + '</span>' +
          '<span class="grp-count">' + esc(counts.join(' · ')) + '</span>' +
          timeHtml + '<span class="spacer"></span>' + badge +
        '</div>' + tokHtml +
        '<div class="grp-body">' + u.idx.map(function (i) { return cards[i]; }).join('') + '</div>' +
      '</div>';
    }

    // Live and not-yet-settled runs stay on top; finished ones go into the group below them.
    // 'stale' is not finished: it is the one state that asks the user to go and look. A group
    // card moves as one: it stays up while any run in it does.
    const liveCards = [], overCards = [];
    let gFail = 0, gStop = 0, overRuns = 0;
    lastRuns.forEach(function (r) { if (!isOver(r)) watchedLive[r.stamp] = true; });
    units.forEach(function (u) {
      const rs = u.idx.map(function (i) { return lastRuns[i]; });
      const html1 = u.key ? groupCard(u, rs) : cards[u.idx[0]];
      const stayUp = rs.some(function (r) { return !isOver(r) || watchedLive[r.stamp]; });
      if (stayUp) { liveCards.push(html1); return; }
      overCards.push(html1);
      overRuns += rs.length;
      rs.forEach(function (r) {
        if (r.phase === 'failed') gFail++;
        if (r.phase === 'stopped') gStop++;
      });
    });
    let html = liveCards.join('');
    if (overCards.length) {
      // A failure folded away unseen is the one thing this group must not do, so the head
      // names failures and stops even while closed. Counted from the group itself: a watched
      // run left outside is already in plain view.
      const extra = [];
      if (gFail) extra.push(t('cx.nFailed', gFail));
      if (gStop) extra.push(t('cx.nStopped', gStop));
      html += '<div class="done-group' + (doneGroupOpen ? '' : ' collapsed') + '">' +
        '<div class="done-head" data-dgroup="1">' +
          '<span class="arrow">▾</span>' +
          // Counts runs, not cards: a group card inside holds several.
          '<span>' + esc(t('cx.doneGroup', overRuns)) + '</span>' +
          (extra.length ? '<span>· ' + esc(extra.join(' · ')) + '</span>' : '') +
        '</div>' +
        '<div class="done-body">' + overCards.join('') + '</div>' +
      '</div>';
    }
    list.innerHTML = html;
    tick();
    markClipped();
  }

  // Whether a row is worth opening is a layout question: the same label fits at one panel
  // width and is cut at another, so it can only be answered after the browser has laid the
  // list out. Rows with nothing more to reveal get '.plain' and stop responding to clicks —
  // a row that opens onto the text you were already reading is worse than no affordance.
  // Open rows are skipped: their label is wrapped or hidden, so it would measure as "fits".
  function markClipped() {
    root.querySelectorAll('details.row').forEach(function (d) {
      if (d.open) return;
      const lbl = d.querySelector('.lbl');
      const clipped = !!lbl && lbl.scrollWidth > lbl.clientWidth + 1;
      d.classList.toggle('plain', d.getAttribute('data-more') !== '1' && !clipped);
    });
  }
  window.addEventListener('resize', markClipped);
  // A hidden tab lays nothing out, so every label measures 0 wide and nothing reads as clipped.
  // Renders and resizes that land while the tab is hidden are corrected when it comes back.
  window.ActivityHost.onShow('codexRuns', markClipped);

  // --- Trash drawer -------------------------------------------------------
  let trashOpen = false;
  function toggleTrash() {
    trashOpen = !trashOpen;
    document.getElementById('cx-trash').style.display = trashOpen ? '' : 'none';
    // Ask on every open rather than caching: the host is the only thing that knows what is
    // actually on disk, and a run can be deleted from another window between two opens.
    if (trashOpen) vscodeApi.postMessage({ type: 'trashOpen' });
  }
  function renderTrash(items) {
    const box = document.getElementById('cx-trash-list');
    if (!items.length) {
      box.innerHTML = '<div class="empty">' + esc(t('cx.trash.none')) + '</div>';
      return;
    }
    box.innerHTML = items.map(function (it) {
      const kb = Math.max(1, Math.round((it.bytes||0)/1024));
      // Three states, not two: purging the logs on their own leaves the documents orphaned here.
      const docsOnly = it.hasDocs && !it.hasLogs;
      const both = it.hasDocs && it.hasLogs;
      const what = both ? t('cx.trash.withDocs')
                 : docsOnly ? t('cx.trash.docsOnly')
                 : t('cx.trash.logsOnly');
      const whatCls = docsOnly ? 'what docs-only' : both ? 'what both' : 'what';
      const purgeCls = docsOnly ? 'tbtn danger' : both ? 'tbtn warn' : 'tbtn';
      return '<div class="trash-row">' +
        '<span class="trash-name" title="' + esc(it.slug) + '">' + esc(it.subject || it.slug) + '</span>' +
        '<span class="' + whatCls + '">' + esc(what) + '</span>' +
        '<span class="trash-meta">' + esc(it.stamp) + ' · ' +
          esc(t('cx.trash.files', it.fileCount, kb)) + '</span>' +
        '<span class="spacer"></span>' +
        '<span class="trash-meta">' + esc(t('cx.trash.deletedAt', fmtClock(it.deletedAt))) + '</span>' +
        '<button class="tbtn" data-restore="' + esc(it.stamp) + '">' + esc(t('cx.trash.restore')) + '</button>' +
        '<button class="' + purgeCls + '" data-purge="' + esc(it.stamp) + '">' + esc(t('cx.trash.purge')) + '</button>' +
      '</div>';
    }).join('');
  }

  root.addEventListener('click', e => {
    const fb = e.target.closest('[data-font]');
    if (fb) {
      fontPx = fb.getAttribute('data-font')==='inc' ? Math.min(28,fontPx+1) : Math.max(10,fontPx-1);
      applyFont(); return;
    }
    const tt = e.target.closest('[data-trash]');
    if (tt) {
      const act = tt.getAttribute('data-trash');
      if (act === 'toggle') toggleTrash();
      else if (act === 'empty') vscodeApi.postMessage({ type: 'emptyTrash' });
      return;
    }
    const rs = e.target.closest('[data-restore]');
    if (rs) { vscodeApi.postMessage({ type: 'restore', stamp: rs.getAttribute('data-restore') }); return; }
    const pg = e.target.closest('[data-purge]');
    if (pg) { vscodeApi.postMessage({ type: 'purge', stamp: pg.getAttribute('data-purge') }); return; }
    const op = e.target.closest('[data-open]');
    if (op) {
      // The anchor rides along only for per-turn result links: every turn appends to the same
      // response document, so the click has to say which part of it to land on.
      vscodeApi.postMessage({ type:'open', path: op.getAttribute('data-open'),
                              anchor: op.getAttribute('data-anchor') || undefined });
      return;
    }
    // Turn header toggles its own body. Checked after the doc links above, since those sit
    // inside this header and their click must open a file rather than collapse the turn.
    const tf = e.target.closest('[data-tfold]');
    if (tf) {
      const fkey = tf.getAttribute('data-tfold');
      foldedTurns[fkey] = !foldedTurns[fkey];
      // Flip what is drawn instead of re-rendering: the 2s poll can land between the click
      // and the repaint, and a re-render here would race it.
      tf.classList.toggle('folded', !!foldedTurns[fkey]);
      let body = tf.nextElementSibling;
      while (body && !body.classList.contains('turn-body')) body = body.nextElementSibling;
      if (body) body.classList.toggle('folded', !!foldedTurns[fkey]);
      return;
    }
    const dg = e.target.closest('[data-dgroup]');
    if (dg) { doneGroupOpen = !doneGroupOpen; render(lastRuns, true); return; }
    // Group card head. The run cards inside have heads of their own, which this does not match.
    const gh = e.target.closest('.grp-head');
    if (gh) {
      userToggled[gh.getAttribute('data-gid')] = gh.getAttribute('data-gopen') !== '1';
      render(lastRuns, true);
      return;
    }
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
  root.addEventListener('toggle', e => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details[data-dkey]')) return;
    openDetails[d.getAttribute('data-dkey')] = d.open;
    if (d.open) {
      // Accordion: an opened row is a wall of text, and two of them side by side leave no
      // list to navigate by. Command groups are containers, not text, so they are exempt.
      if (d.matches('details.row')) {
        root.querySelectorAll('details.row[open]').forEach(function (other) {
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

  // The panel opens before any scan finishes, on its loading line. Rendering the empty initial
  // list when the language arrives would swap that line for "no runs" while they are still coming.
  let gotRuns = false;
  window.ActivityHost.onMessage('codexRuns', m => {
    if (m && m.type === 'i18n') { dict = m.dict || {}; applyI18n(); if (gotRuns) render(lastRuns, true); }
    else if (m && m.type === 'runs') { gotRuns = true; render(m.runs); }
    else if (m && m.type === 'trash') renderTrash(m.items || []);
  });
  vscodeApi.postMessage({ type: 'ready' });
})();
