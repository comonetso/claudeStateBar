// media/activity.js — the webview half of the "Claude Activity" panel shell (2026-09-30).
//
// The workflow, background-task, Codex progress and Codex chat panels are four tabs of one
// webview now. This script is loaded before every tab script. It owns acquireVsCodeApi() (a
// webview may call it only once — a second call throws), the tab bar and the pane switching, and
// hands each tab script window.ActivityHost:
//
//   api(tab)          { postMessage, getState, setState } — the acquireVsCodeApi() stand-in.
//                     postMessage adds `tab`; each tab's state is stored under its own key.
//   onMessage(tab,fn) host messages addressed to that tab, plus tab-less broadcasts (i18n).
//                     fn gets the message object (e.data). Shell messages (act:*) are not passed.
//   root(tab)         the tab's <section class="act-pane" id="pane-<tab>">.
//   isActive(tab)     whether that tab is the one on screen.
//   onShow(tab, fn)   fn() every time the tab comes on screen, the first time included. Registered
//                     while the tab is already on screen, fn runs once right after the registering
//                     script finishes (a microtask), so it never sees that script half-initialised.
//
// Shell messages: host → webview {type:'act:state', active, visible, badges, select};
// webview → host {type:'act:ready'} and {type:'act:tab', tab}.
(function () {
  'use strict';

  const vscodeApi = acquireVsCodeApi();
  const tabBar = document.querySelector('.act-tabs');
  const top = document.querySelector('.act-top');

  // Only the tabs the host registered have a button (and a pane); keep their order.
  const buttons = {};
  const order = [];
  document.querySelectorAll('.act-tab').forEach(function (b) {
    const tab = b.getAttribute('data-tab');
    if (tab && !buttons[tab]) { buttons[tab] = b; order.push(tab); }
  });

  let dict = {};
  // The shell's own captions before the first i18n message arrives (host fills them from data-state).
  let strings = { 'menu.running': '{0} running' };
  let active = null;
  let visible = {};
  let badges = {};

  function t(key) {
    let v = dict[key];
    if (typeof v !== 'string') v = strings[key];
    if (typeof v !== 'string') return key;
    const args = Array.prototype.slice.call(arguments, 1);
    if (args.length) {
      v = v.replace(/\{(\d+)\}/g, function (_, i) { const val = args[Number(i)]; return val == null ? '' : String(val); });
    }
    return v;
  }

  // ── state storage ─────────────────────────────────────────────────────────────────────────
  // One webview state object for everything: { shell: {...}, tabs: { <tab>: <that tab's state> } }.
  // A tab's getState/setState only ever sees and replaces its own entry.
  function loadAll() {
    const s = vscodeApi.getState();
    return (s && typeof s === 'object') ? s : {};
  }
  function getTabState(tab) {
    const all = loadAll();
    return (all.tabs && Object.prototype.hasOwnProperty.call(all.tabs, tab)) ? all.tabs[tab] : undefined;
  }
  function setTabState(tab, obj) {
    const all = loadAll();
    const tabs = Object.assign({}, all.tabs);
    tabs[tab] = obj;
    vscodeApi.setState(Object.assign({}, all, { tabs: tabs }));
    return obj;
  }
  function setShellState(patch) {
    const all = loadAll();
    vscodeApi.setState(Object.assign({}, all, { shell: Object.assign({}, all.shell, patch) }));
  }

  // ── tab bar ───────────────────────────────────────────────────────────────────────────────
  function paneOf(tab) { return document.getElementById('pane-' + tab); }

  // Keyboard scrolling. Each pane is its own scroll box inside a body that does not scroll, and
  // the browser only scrolls a box the keyboard focus (or the last click) is in — so right after
  // the panel opened, or after a tab button was clicked, PageDown and the arrow keys did nothing
  // until the user clicked into the content. Each pane is made focusable and takes the focus when
  // it comes on screen, and the browser's own key scrolling does the rest. Only while this webview
  // has the focus: taking it otherwise could pull typing away from the editor.
  order.forEach(function (tab) {
    const p = paneOf(tab);
    if (p && !p.hasAttribute('tabindex')) p.setAttribute('tabindex', '-1');
  });
  function focusPane(tab) {
    const p = paneOf(tab);
    if (!p || p.hidden || !document.hasFocus()) return;
    try { p.focus({ preventScroll: true }); } catch (e) { p.focus(); }
  }
  /** The focus is nowhere useful: on the page itself, or inside a pane that is not on screen. */
  function focusLost() {
    const ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return true;
    return order.some(function (x) { const p = paneOf(x); return x !== active && !!p && p.contains(ae); });
  }
  function isShown(tab) { return !!buttons[tab] && visible[tab] !== false; }
  function runningOf(tab) {
    const b = badges[tab];
    const n = b ? Number(b.running) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** The tab to put on screen: `want` if it is shown, else the first shown tab. */
  function effective(want) {
    if (want && isShown(want)) return want;
    for (let i = 0; i < order.length; i++) if (isShown(order[i])) return order[i];
    // Nothing shown at all: keep what was asked for rather than an empty panel.
    return (want && buttons[want]) ? want : (order[0] || null);
  }

  function renderBar() {
    order.forEach(function (tab) {
      const b = buttons[tab];
      const sel = tab === active;
      const n = runningOf(tab);
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.tabIndex = sel ? 0 : -1;
      b.classList.toggle('active', sel);
      b.classList.toggle('running', n > 0);
      // A hidden tab keeps its button only while it is the selected one (nothing else shown).
      b.hidden = !isShown(tab) && !sel;
      const count = b.querySelector('.act-count');
      if (count) count.textContent = n > 0 ? String(n) : '';
      if (n > 0) b.title = t('menu.running', n); else b.removeAttribute('title');
    });
  }

  function selectTab(tab, fromUser) {
    if (!tab || !buttons[tab]) { renderBar(); return; }
    const changed = tab !== active;
    active = tab;
    renderBar();
    order.forEach(function (x) { const p = paneOf(x); if (p) p.hidden = x !== active; });
    if (!changed) return;
    if (focusLost()) focusPane(tab);
    setShellState({ active: tab });
    if (fromUser) vscodeApi.postMessage({ type: 'act:tab', tab: tab });
    fireShow(tab);
  }

  function applyState(s, select) {
    if (!s || typeof s !== 'object') return;
    if (s.visible && typeof s.visible === 'object') visible = Object.assign({}, visible, s.visible);
    if (s.badges && typeof s.badges === 'object') badges = Object.assign({}, badges, s.badges);
    // A badge/visibility refresh (select=false) must not undo a tab the user clicked a moment
    // before the host heard about it; only the host choosing a tab moves the selection.
    let want = active;
    if ((select || !active) && typeof s.active === 'string') want = s.active;
    selectTab(effective(want), false);
  }

  function applyI18n(m) {
    dict = (m.dict && typeof m.dict === 'object') ? m.dict : {};
    if (typeof m.lang === 'string') document.documentElement.lang = m.lang;
    // Only the shell's own elements; every pane translates itself.
    if (top) {
      top.querySelectorAll('[data-i18n]').forEach(function (el) {
        const v = dict[el.getAttribute('data-i18n')]; if (typeof v === 'string') el.textContent = v;
      });
      top.querySelectorAll('[data-i18n-title]').forEach(function (el) {
        const v = dict[el.getAttribute('data-i18n-title')]; if (typeof v === 'string') el.title = v;
      });
    }
    renderBar();
  }

  if (tabBar) {
    tabBar.addEventListener('click', function (e) {
      const b = e.target && e.target.closest ? e.target.closest('.act-tab') : null;
      if (!b) return;
      selectTab(b.getAttribute('data-tab'), true);
      // A click leaves the focus on the button; move it into the content so keys scroll it.
      // Arrow-key switching (below) keeps it on the buttons instead.
      focusPane(active);
    });
    tabBar.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const b = e.target && e.target.closest ? e.target.closest('.act-tab') : null;
      if (!b) return;
      const shown = order.filter(function (x) { return !buttons[x].hidden; });
      if (shown.length < 2) return;
      let i = shown.indexOf(b.getAttribute('data-tab'));
      if (i < 0) i = 0;
      i = (i + (e.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length;
      e.preventDefault();
      selectTab(shown[i], true);
      buttons[shown[i]].focus();
    });
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous shown tab (user's call, 2026-09-30). package.json
  // binds the same keys for when the focus is outside the webview, but a keybinding the user set
  // in keybindings.json always wins over an extension's — this user has Ctrl+Tab bound to
  // workbench.action.nextEditor with no when clause, so the extension binding never ran. With the
  // focus inside the webview the keys are taken here first: VS Code's webview host forwards every
  // keydown to the workbench from a bubble-phase listener on the window, so stopping the event in
  // the capture phase keeps it from also switching editors.
  function cycleTab(delta) {
    const shown = order.filter(function (x) { return !buttons[x].hidden; });
    if (shown.length < 2) return;
    let i = shown.indexOf(active);
    if (i < 0) i = 0;
    selectTab(shown[(i + delta + shown.length) % shown.length], true);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    cycleTab(e.shiftKey ? -1 : 1);
    // A tab button that had the focus is left for the new tab's pane (selectTab moves it when the
    // focus was in the pane now hidden); keep it on the buttons if it was there.
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('.act-tabs')) buttons[active].focus();
  }, true);

  // ── tab hooks ─────────────────────────────────────────────────────────────────────────────
  const messageHandlers = [];
  const showHandlers = [];

  function callShow(h) {
    try { h.fn(); } catch (err) { console.error('[activity] ' + h.tab + ' onShow failed', err); }
  }
  function fireShow(tab) {
    showHandlers.slice().forEach(function (h) { if (h.tab === tab) callShow(h); });
  }

  function dispatch(m) {
    const type = typeof m.type === 'string' ? m.type : '';
    if (type.indexOf('act:') === 0) {
      if (type === 'act:state') applyState(m, !!m.select);
      return;
    }
    if (type === 'i18n') applyI18n(m);
    const target = typeof m.tab === 'string' ? m.tab : null;
    messageHandlers.slice().forEach(function (h) {
      if (target !== null && h.tab !== target) return;
      try { h.fn(m); } catch (err) { console.error('[activity] ' + h.tab + ' message handler failed', err); }
    });
  }

  // Hold host messages until every tab script has run and registered its handlers. VS Code
  // already queues messages until the page has loaded; this makes it independent of that.
  let loaded = document.readyState !== 'loading';
  const pending = [];
  window.addEventListener('message', function (e) {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (!loaded) { pending.push(m); return; }
    dispatch(m);
  });

  window.ActivityHost = Object.freeze({
    api: function (tab) {
      return {
        postMessage: function (msg) { vscodeApi.postMessage(Object.assign({}, msg, { tab: tab })); },
        getState: function () { return getTabState(tab); },
        setState: function (obj) { return setTabState(tab, obj); },
      };
    },
    onMessage: function (tab, fn) {
      if (typeof fn === 'function') messageHandlers.push({ tab: tab, fn: fn });
    },
    root: function (tab) { return paneOf(tab); },
    isActive: function (tab) { return tab === active; },
    onShow: function (tab, fn) {
      if (typeof fn !== 'function') return;
      const h = { tab: tab, fn: fn };
      showHandlers.push(h);
      if (tab === active) {
        const run = function () { if (tab === active) callShow(h); };
        if (typeof queueMicrotask === 'function') queueMicrotask(run); else Promise.resolve().then(run);
      }
    },
  });

  // First state, embedded by the host so the right pane is up before any tab script runs.
  let init = {};
  try { init = JSON.parse(document.body.getAttribute('data-state') || '{}') || {}; } catch (e) { init = {}; }
  if (init.strings && typeof init.strings === 'object') strings = Object.assign({}, strings, init.strings);
  applyState(init, true);

  function onLoaded() {
    loaded = true;
    pending.splice(0).forEach(dispatch);
    if (focusLost()) focusPane(active);
    vscodeApi.postMessage({ type: 'act:ready' });
  }
  // The webview gaining the focus later (the user switches to its editor tab): same thing.
  window.addEventListener('focus', function () { if (focusLost()) focusPane(active); });
  if (loaded) onLoaded(); else document.addEventListener('DOMContentLoaded', onLoaded, { once: true });
})();
