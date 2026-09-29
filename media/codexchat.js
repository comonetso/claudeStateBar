// media/codexchat.js — the Codex chat tab of the Activity panel (codexChatPanel.ts).
//
// Moved out of the panel's html template. What changed on the way: the shell owns the webview,
// so messages go through window.ActivityHost, ids carry the tab's cc- prefix, and the pane — not
// the window — is the scroll container. A hidden pane measures as zero, so the scroll rule and
// the first-look focus rule wait for ActivityHost.onShow (see the end of this file).
(function () {
  'use strict';
  const vscodeApi = window.ActivityHost.api('codexChats');
  const root = window.ActivityHost.root('codexChats');
  let dict = {};
  let chats = [];
  let collapsed = {};
  let drawerOpen = false;
  // Turn folds, but only the ones the reader set by hand: true is folded, false is open, and an
  // absent key means nobody has touched that turn, so the focus rule below decides it.
  let folded = {};
  // One turn per conversation reads as the current one; everything else folds down to its first
  // line. Which turn that is depends on why you are looking (user's call, 2026-08-23): opening
  // the panel or a past conversation means reading it from the top, so the FIRST turn opens —
  // while a turn arriving in a conversation you are already in means the LAST one opens.
  let focus = {};
  // Entry count per conversation as of the previous message, which is how an arrival is told
  // apart from a re-render carrying the same turns.
  let seenCount = {};

  // How close to the bottom still counts as being at the bottom. There is no principled value
  // here; 80px is roughly a line and a half, enough that a stray wheel notch does not count as
  // 'the reader scrolled away'. Easy to change if it feels wrong in use.
  const BOTTOM_SLACK = 80;
  let lastCount = null;    // total entries last render, to tell an arrival from a re-render
  let jumpShown = false;
  let firstPaint = true;   // consumed by the first render that actually has content, while shown

  // The pane is hidden (display:none) whenever another tab is selected, and a hidden pane reports
  // zero for every size, which atBottom() would read as 'at the bottom'. So while shown, the
  // reader's place is written down here, and while hidden it stands in for a measurement. An
  // empty pane counts as being at the bottom, same as atBottom() says for it.
  let lastAtBottom = true;
  let lastY = 0;
  // Whether this tab has been on screen yet. The panel now opens on whichever tab was asked for
  // and fills all four in the background, so 'opening the panel' for this tab means the first
  // time it is actually shown.
  let everShown = false;
  // Conversations from before this session fold into one row (user's call, 2026-09-30). The host
  // marks each chat (c.current, see markCurrentChats in extension.ts); the row starts closed
  // whenever the panel opens, as the Codex progress tab's finished-runs row does.
  let olderOpen = false;
  function isCurrent(c) { return c.current !== false; }
  /** The conversation that opens by default: the newest one of this session, if any. */
  function newestCurrentStamp() {
    for (let i = 0; i < chats.length; i++) if (isCurrent(chats[i])) return chats[i].stamp;
    return null;
  }

  function scroller() { return root; }
  function measurable() { return root.clientHeight > 0; }
  function atBottom() {
    const el = scroller();
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= BOTTOM_SLACK;
  }
  function remember() {
    if (!measurable()) return;
    lastAtBottom = atBottom();
    lastY = scroller().scrollTop;
  }
  function toBottom() { scroller().scrollTop = scroller().scrollHeight; }
  function showJump(on) {
    jumpShown = on;
    const b = document.getElementById('cc-jumpBtn');
    if (b) b.style.display = on ? '' : 'none';
  }

  function t(key) {
    const v = dict[key];
    return typeof v === 'string' ? v : key;
  }
  function tn(key, n) {
    return t(key).split('{0}').join(String(n));
  }
  function applyStatic() {
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      const v = dict[el.getAttribute('data-i18n')];
      if (typeof v === 'string') el.textContent = v;
    });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function kb(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    return Math.round(n / 1024) + ' KB';
  }

  function firstLine(s) {
    const v = String(s == null ? '' : s).trim();
    if (!v) return '';
    const nl = v.indexOf('\n');
    return nl < 0 ? v : v.slice(0, nl);
  }

  /** Turn number of the first or last exchange in a conversation; null if it has none yet. */
  function edgeTurnNo(c, wantLast) {
    let n = null;
    for (let i = 0; i < c.entries.length; i++) {
      const e = c.entries[i];
      if (e.type !== 'turn' && e.type !== 'pending') continue;
      if (n === null || wantLast) n = e.n;
      if (n !== null && !wantLast) break;
    }
    return n;
  }

  /**
   * Whether a turn draws folded. A hand-set fold always wins — reading an older turn is a
   * deliberate act, and an answer landing elsewhere must not undo it.
   */
  function foldedNow(c, e) {
    const v = folded[c.stamp + '#' + e.n];
    if (v === true || v === false) return v;
    return focus[c.stamp] !== e.n;
  }

  /**
   * Move the focus, once per conversation per message. A conversation seen for the first time
   * focuses its opening turn; one that just grew focuses what arrived.
   */
  function refocus(c) {
    const before = seenCount[c.stamp];
    const now = c.entries.length;
    seenCount[c.stamp] = now;
    if (before === undefined) focus[c.stamp] = edgeTurnNo(c, false);
    else if (now > before) focus[c.stamp] = edgeTurnNo(c, true);
  }

  /**
   * The fold handle. A pending turn keeps the same key as the turn it becomes, so folding one
   * mid-flight does not spring back open the moment the answer lands.
   *
   * The rendered state rides along in data-fold: the click handler has to flip what is on screen,
   * and for an untouched turn that is the focus rule's answer, not anything stored in the map.
   */
  function turnHead(key, e, isFolded) {
    let h = '<div class="turn-head" data-turn="' + esc(key) + '" data-fold="' + (isFolded ? '1' : '0') + '">';
    h += '<span class="tarrow">&#9660;</span>';
    h += '<span class="turn-no">' + tn('cxc.turnNo', e.n) + (e.time ? '  ·  ' + esc(e.time) : '') + '</span>';
    if (isFolded) {
      const peek = firstLine(e.claude);
      if (peek) h += '<span class="turn-peek">' + esc(peek) + '</span>';
    }
    return h + '</div>';
  }

  function turnHtml(c, e) {
    const key = c.stamp + '#' + e.n;
    const isFolded = foldedNow(c, e);
    let h = '<div class="turn' + (isFolded ? ' folded' : '') + '">';
    h += turnHead(key, e, isFolded);
    if (e.claude) {
      h += '<div class="say"><div class="who claude">' + esc(t('cxc.claude')) + '</div>'
         + '<div class="msg">' + esc(e.claude) + '</div></div>';
    }
    if (e.codex) {
      h += '<div class="say"><div class="who codex">' + esc(t('cxc.codex')) + '</div>'
         + '<div class="msg">' + esc(e.codex) + '</div></div>';
    }
    return h + '</div>';
  }

  /** Claude has spoken and Codex has not answered yet — the question shows immediately. */
  function pendingHtml(c, e) {
    const key = c.stamp + '#' + e.n;
    const isFolded = foldedNow(c, e);
    let h = '<div class="turn' + (isFolded ? ' folded' : '') + '">';
    h += turnHead(key, e, isFolded);
    if (e.claude) {
      h += '<div class="say"><div class="who claude">' + esc(t('cxc.claude')) + '</div>'
         + '<div class="msg">' + esc(e.claude) + '</div></div>';
    }
    h += '<div class="say waiting"><div class="who codex">' + esc(t('cxc.codex')) + '</div>'
       + '<div class="msg">' + esc(t('cxc.waiting')) + '<span class="dots">&#8230;</span></div></div>';
    return h + '</div>';
  }

  function breakHtml(e) {
    const isBroken = e.kind === 'broken';
    const cls = isBroken ? 'brk' : 'brk superseded';
    const title = isBroken ? t('cxc.broken') : t('cxc.superseded');
    let h = '<div class="' + cls + '">';
    h += '<div class="brk-title">' + esc(title) + (e.time ? '  ·  ' + esc(e.time) : '') + '</div>';
    if (e.text) h += esc(e.text);
    return h + '</div>';
  }

  function chatHtml(c) {
    const isCollapsed = collapsed[c.stamp] !== false;
    const turns = c.entries.filter(function (e) { return e.type === 'turn'; }).length;
    let h = '<div class="chat' + (isCollapsed ? ' collapsed' : '') + '" data-stamp="' + esc(c.stamp) + '">';
    h += '<div class="chat-head" data-toggle="' + esc(c.stamp) + '">';
    h += '<span class="arrow">&#9660;</span>';
    h += '<span class="chat-name">' + esc(c.subject || c.slug) + '</span>';
    h += '<span class="chip">' + tn('cxc.turns', turns) + '</span>';
    if (c.origin) h += '<span class="chip origin">' + esc(c.origin) + '</span>';
    // Another working tree of this repository. Same outlined chip: where it lives, not a state.
    if (c.tag) h += '<span class="chip origin" title="' + esc(c.tagPath || c.tag) + '">⎇ ' + esc(c.tag) + '</span>';
    h += '<span class="chat-time">' + esc(when(c.lastAtMs)) + '</span>';
    h += '<span class="spacer"></span>';
    if (c.live) {
      h += '<span class="badge live">' + esc(t('cxc.live')) + '</span>';
    } else if (!c.threadId) {
      h += '<span class="badge dead">' + esc(t('cxc.ended')) + '</span>';
    }
    h += '<button class="del-btn" data-del="' + esc(c.stamp) + '" title="' + esc(t('cxc.delete')) + '">&#128465;</button>';
    h += '</div>';

    h += '<div class="chat-body">';
    // A conversation whose first turn is still in flight has no document yet — nothing to link.
    if (c.docUri) {
      h += '<div class="meta"><span class="doclink" data-open="' + esc(c.docUri) + '">'
         + esc(c.stamp) + '_chat_' + esc(c.slug) + '.md</span></div>';
    }
    for (let i = 0; i < c.entries.length; i++) {
      const e = c.entries[i];
      if (e.type === 'turn') h += turnHtml(c, e);
      else if (e.type === 'pending') h += pendingHtml(c, e);
      else h += breakHtml(e);
    }
    h += '</div></div>';
    return h;
  }

  /**
   * Re-render the list, and put the viewport back where the reader had it.
   *
   * The whole list is replaced wholesale, which on its own throws the scroll position away.
   * So: if the reader was at the bottom, follow the conversation down; otherwise restore the
   * exact offset. Nothing else is allowed to move the viewport — a turn arriving while someone
   * reads an older one must not yank the page.
   *
   * The very first paint is the exception. An empty page counts as being at the bottom, so the
   * old rule scrolled the panel down the moment it had content — which now contradicts the point
   * of opening the first turn. Opening the panel leaves you at the top.
   *
   * While the tab is hidden none of this can be measured. The list is still redrawn, so folds and
   * focus are current the moment it shows, but the viewport is left to onShow.
   */
  function render() {
    const stick = atBottom();
    const keepY = scroller().scrollTop;
    const list = document.getElementById('cc-list');
    if (!chats.length) {
      list.innerHTML = '<div class="empty">' + esc(t('cxc.empty')) + '</div>';
      remember();
      return;
    }
    let h = '';
    const older = [];
    for (let i = 0; i < chats.length; i++) {
      if (isCurrent(chats[i])) h += chatHtml(chats[i]);
      else older.push(chatHtml(chats[i]));
    }
    if (older.length) {
      h += '<div class="done-group' + (olderOpen ? '' : ' collapsed') + '">'
         + '<div class="done-head" data-older="1"><span class="arrow">&#9662;</span>'
         + '<span>' + esc(tn('cxc.olderGroup', older.length)) + '</span></div>'
         + '<div class="done-body">' + older.join('') + '</div></div>';
    }
    list.innerHTML = h;
    if (!measurable()) return;
    if (firstPaint) { firstPaint = false; remember(); return; }
    if (stick) { toBottom(); showJump(false); }
    else { scroller().scrollTop = keepY; }
    remember();
  }

  function renderTrash(items) {
    const d = document.getElementById('cc-drawer');
    if (!drawerOpen) { d.innerHTML = ''; return; }
    let h = '<div class="drawer"><div class="drawer-head">';
    h += '<span class="drawer-title">' + esc(t('cxc.trashTitle')) + '</span>';
    h += '<span class="spacer"></span>';
    if (items.length) {
      h += '<button class="tbtn danger" id="cc-emptyBtn">' + esc(t('cxc.emptyTrash')) + '</button>';
    }
    h += '</div>';
    if (!items.length) {
      h += '<div class="tinfo">' + esc(t('cxc.trashEmpty')) + '</div>';
    } else {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        h += '<div class="trow">';
        h += '<span class="tname">' + esc(it.subject || it.slug) + '</span>';
        h += '<span class="tinfo">' + tn('cxc.turns', it.turns) + '  ·  ' + esc(kb(it.bytes))
           + '  ·  ' + esc(when(it.deletedAt)) + '</span>';
        h += '<span class="spacer"></span>';
        h += '<button class="tbtn" data-restore="' + esc(it.stamp) + '">' + esc(t('cxc.restore')) + '</button>';
        h += '<button class="tbtn danger" data-purge="' + esc(it.stamp) + '">' + esc(t('cxc.purge')) + '</button>';
        h += '</div>';
      }
    }
    d.innerHTML = h + '</div>';
  }

  root.addEventListener('click', function (ev) {
    let el = ev.target;
    while (el && el !== root) {
      if (el.hasAttribute && el.hasAttribute('data-del')) {
        vscodeApi.postMessage({ type: 'delete', stamp: el.getAttribute('data-del') });
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-open')) {
        vscodeApi.postMessage({ type: 'open', path: el.getAttribute('data-open') });
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-restore')) {
        vscodeApi.postMessage({ type: 'restore', stamp: el.getAttribute('data-restore') });
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-purge')) {
        vscodeApi.postMessage({ type: 'purge', stamp: el.getAttribute('data-purge') });
        return;
      }
      if (el.id === 'cc-emptyBtn') {
        vscodeApi.postMessage({ type: 'emptyTrash' });
        return;
      }
      if (el.id === 'cc-jumpBtn') {
        toBottom();
        showJump(false);
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-turn')) {
        // Flip what is on screen rather than the stored map — a turn the focus rule folded has
        // no entry there yet, and reading its absence as 'open' would fold it twice.
        folded[el.getAttribute('data-turn')] = el.getAttribute('data-fold') !== '1';
        render();
        return;
      }
      if (el.id === 'cc-trashBtn') {
        drawerOpen = !drawerOpen;
        if (drawerOpen) vscodeApi.postMessage({ type: 'trashOpen' });
        else renderTrash([]);
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-older')) {
        olderOpen = !olderOpen;
        render();
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-toggle')) {
        const st = el.getAttribute('data-toggle');
        collapsed[st] = collapsed[st] === false;
        render();
        return;
      }
      el = el.parentNode;
    }
  });

  // The panel opens before its first scan lands, on a loading line. Rendering the empty initial
  // list when the language arrives would replace that line with "no conversations" too early.
  let gotChats = false;
  window.ActivityHost.onMessage('codexChats', function (m) {
    if (!m) return;
    if (m.type === 'i18n') {
      dict = m.dict || {};
      applyStatic();
      if (gotChats) render();
      return;
    }
    if (m.type === 'chats') {
      gotChats = true;
      const wasAtBottom = measurable() ? atBottom() : lastAtBottom;
      chats = m.chats || [];
      // Newest conversation of this session opens by default; the rest stay folded. Re-reading
      // almost always means the one that just happened.
      const openStamp = newestCurrentStamp();
      let count = 0;
      for (let i = 0; i < chats.length; i++) {
        if (collapsed[chats[i].stamp] === undefined) collapsed[chats[i].stamp] = chats[i].stamp !== openStamp;
        refocus(chats[i]);
        count += chats[i].entries.length;
      }
      // Only an actual arrival raises the button — not the first paint, and not a re-render
      // that happens to carry the same turns.
      const grew = lastCount !== null && count > lastCount;
      lastCount = count;
      render();
      if (grew && !wasAtBottom) showJump(true);
      return;
    }
    if (m.type === 'trash') {
      renderTrash(m.items || []);
      return;
    }
  });

  // Scrolling back down yourself dismisses the button — it has nothing left to offer.
  root.addEventListener('scroll', function () {
    remember();
    if (jumpShown && measurable() && atBottom()) showJump(false);
  });

  // The tab comes on screen. The first time stands in for what opening the panel used to be:
  // whatever arrived while it was hidden was never seen, so the first-message rules are replayed
  // on what is here now — the newest conversation open, every conversation on its FIRST turn,
  // and the viewport at the top (render's first paint). Every later time is a return from another
  // tab: turns that landed meanwhile already moved the focus to the LAST one (refocus needs no
  // measuring), so what is left is the viewport rule render() could not apply while hidden —
  // follow the conversation down if the reader was at the bottom, else put them back.
  window.ActivityHost.onShow('codexChats', function () {
    if (!everShown) {
      everShown = true;
      collapsed = {};
      focus = {};
      seenCount = {};
      const openStamp = newestCurrentStamp();
      for (let i = 0; i < chats.length; i++) {
        collapsed[chats[i].stamp] = chats[i].stamp !== openStamp;
        refocus(chats[i]);
      }
      if (gotChats) render();
      return;
    }
    // The tab was seen with nothing to draw (empty list, or still loading), so the first paint
    // never happened. Conversations that arrived while it was hidden get that first paint now —
    // top of the page — not the follow-down rule, which reads an empty page as "at the bottom".
    if (firstPaint) { if (gotChats && chats.length) render(); return; }
    if (lastAtBottom) { toBottom(); showJump(false); }
    else { scroller().scrollTop = lastY; }
    remember();
  });

  vscodeApi.postMessage({ type: 'ready' });
}());
