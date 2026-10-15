/*
 * CDP client used by transport C (direct DevTools protocol — local TCP on the browser machine, or a reverse-forwarded
 * Unix socket on a server). This is the *broker* the Codex consult required: every command passes the policy
 * allow/deny list, targets are owned per run, screenshots never use fromSurface:false, events and results go through
 * the central redactor before they reach the caller, and everything created is closed in finally.
 */
import { connect } from './cdp-ws.mjs';
import { cdpAllowed, BORROWED_DENY, SAFE_HTTP_METHODS, writeAllowed, urlMatches } from './policy.mjs';
import { redact, redactUrl } from './redact.mjs';

// The same page-side scan and lock as kit/head.js K.scan / K.prep. Transport C has no repl, so they go over as
// Runtime.evaluate expressions. Keep the two in step.
const INJECTED_TEST = "t.startsWith('deepl-') || t === 'aside-inline-menu' || (e.classList && e.classList.contains('bro-field-icon'))";
const SCAN_JS = `(() => {
  const inj = [];
  for (const e of document.querySelectorAll('*')) { const t = e.tagName.toLowerCase(); if (${INJECTED_TEST}) inj.push(t); }
  return {
    darkReader: document.documentElement.hasAttribute('data-darkreader-mode') || !!document.querySelector('style.darkreader'),
    injected: Array.from(new Set(inj)),
    vis: performance.getEntriesByType('visibility-state').map((x) => x.name + '@' + Math.round(x.startTime)),
    dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight, cw: document.documentElement.clientWidth, href: location.href,
  };
})()`;
const LOCK_JS = `(async () => {
  if (!document.querySelector('meta[name="darkreader-lock"]')) { const m = document.createElement('meta'); m.name = 'darkreader-lock'; document.head.appendChild(m); }
  for (const e of document.querySelectorAll('*')) { const t = e.tagName.toLowerCase(); if (${INJECTED_TEST}) e.style.setProperty('display', 'none', 'important'); }
  const t0 = Date.now();
  while (document.documentElement.hasAttribute('data-darkreader-mode') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
  return true;
})()`;
// A borrowed tab is the user's, so its prep must be undoable and must outlive one scan: the injected UI that caused the
// 2026-10-15 near-miss (an Aside autofill menu over a radio label) appeared after the page had been prepped. So a
// stylesheet plus an observer keep hiding it, every hidden element remembers its old inline display, and BORROW_UNDO_JS
// puts all of it back. It is also registered for new documents (navigation inside the borrowed tab).
const BORROW_PREP_JS = `(() => {
  if (window.__bcBorrow) return { already: true };
  const inj = (e) => { const t = e.tagName.toLowerCase(); return ${INJECTED_TEST}; };
  const hide = (e) => { if (!e.hasAttribute('data-browser-check-hidden')) e.setAttribute('data-browser-check-hidden', e.style.getPropertyValue('display') + '|' + e.style.getPropertyPriority('display')); e.style.setProperty('display', 'none', 'important'); };
  const root = document.head || document.documentElement;
  let meta = null;
  if (!document.querySelector('meta[name="darkreader-lock"]')) { meta = document.createElement('meta'); meta.name = 'darkreader-lock'; meta.setAttribute('data-browser-check', '1'); root.appendChild(meta); }
  const style = document.createElement('style'); style.setAttribute('data-browser-check', '1');
  style.textContent = 'aside-inline-menu, .bro-field-icon { display: none !important; }';
  root.appendChild(style);
  const seen = new Set();
  const sweep = (n) => { if (n.nodeType !== 1) return; if (inj(n)) { hide(n); seen.add(n.tagName.toLowerCase()); } for (const e of n.querySelectorAll('*')) if (inj(e)) { hide(e); seen.add(e.tagName.toLowerCase()); } };
  sweep(document.documentElement);
  const obs = new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'attributes') { if (inj(m.target) && m.target.style.getPropertyValue('display') !== 'none') hide(m.target); } else for (const n of m.addedNodes) sweep(n); } });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  window.__bcBorrow = { obs, seen };
  return { injected: Array.from(seen) };
})()`;
const BORROW_PREP_ON_NEW_DOC = `(() => { const go = () => { try { ${BORROW_PREP_JS}; } catch (e) {} }; if (document.documentElement) go(); else document.addEventListener('readystatechange', go, { once: true }); })()`;
const BORROW_UNDO_JS = `(() => {
  const b = window.__bcBorrow; if (b) { b.obs.disconnect(); delete window.__bcBorrow; }
  for (const e of document.querySelectorAll('[data-browser-check]')) e.remove();
  let n = 0;
  for (const e of document.querySelectorAll('[data-browser-check-hidden]')) {
    const [v, p] = e.getAttribute('data-browser-check-hidden').split('|');
    if (v) e.style.setProperty('display', v, p || ''); else e.style.removeProperty('display');
    e.removeAttribute('data-browser-check-hidden'); n++;
  }
  return { restored: n };
})()`;
// Emulation set on a borrowed tab is undone when it is released (and by the detach that follows, which ends the
// DevTools session the overrides belong to). These are the ones with an explicit reset.
const EMU_RESET = {
  'Emulation.setDeviceMetricsOverride': ['Emulation.clearDeviceMetricsOverride', {}],
  'Emulation.setEmulatedMedia': ['Emulation.setEmulatedMedia', { media: '', features: [] }],
  'Emulation.setLocaleOverride': ['Emulation.setLocaleOverride', {}],
  'Emulation.setTimezoneOverride': ['Emulation.setTimezoneOverride', { timezoneId: '' }],
  'Emulation.setCPUThrottlingRate': ['Emulation.setCPUThrottlingRate', { rate: 1 }],
  'Emulation.setTouchEmulationEnabled': ['Emulation.setTouchEmulationEnabled', { enabled: false }],
  'Emulation.setEmulatedVisionDeficiency': ['Emulation.setEmulatedVisionDeficiency', { type: 'none' }],
  'Emulation.setGeolocationOverride': ['Emulation.clearGeolocationOverride', {}],
  'Emulation.setAutoDarkModeOverride': ['Emulation.setAutoDarkModeOverride', {}],
  'Emulation.setScriptExecutionDisabled': ['Emulation.setScriptExecutionDisabled', { value: false }],
};
const GUARD_PROBE = '/__browser_check_guard_selftest__/';
const WARN_DARK = 'DARK_READER_ON: Dark Reader is active on this site — colours and captures are altered. The owner keeps it OFF on sites under development; report this before trusting any colour/contrast result.';

export class CdpClient {
  /** target: { socketPath } | { host, port } · browserWsPath from /json/version · opts.commandTimeoutMs */
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map(); // method → Set<fn>
    this.owned = new Set();     // targetIds this run created
    this.sessions = new Map();  // targetId → sessionId
    this.awake = new Map();     // sessionId → Promise of the capture that painted its current document (see send)
    this.borrowed = new Map();  // targetId → { sessionId, url, windowId, emu:Set, prepScript, prepped } — the user's tabs lent to this run
    this.isolated = new Map();  // browserContextId → Set<targetId> — throwaway profiles for test accounts (see openIsolatedWindow)
    this.guards = new Map();    // sessionId → write guard (see guardWrites)
    // Borrowing is off unless the caller (the `cdp` command) says this tab may be lent: config sites[].borrow or the
    // user's approval for this run. A script cannot widen it.
    this.borrowGate = opts.borrowGate || (() => ({ ok: false, why: 'borrowing is off — needs sites[].borrow in the config or --user-approved for this run' }));
    this.commandTimeoutMs = opts.commandTimeoutMs || 10000;
    this.transport = opts.transport || 'C';
    this.log = opts.log || (() => {});
    this.closed = false;
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => { this.closed = true; for (const [, p] of this.pending) p.reject(new Error('cdp connection closed')); this.pending.clear(); });
    ws.on('error', (e) => this.log('ws error ' + e.message));
  }

  static async connect(target, opts = {}) {
    const ver = await CdpClient.version(target, opts.connectTimeoutMs || 1000);
    const wsUrl = new URL(ver.webSocketDebuggerUrl);
    const ws = await connect(target, wsUrl.pathname, { timeoutMs: opts.connectTimeoutMs || 3000 });
    const c = new CdpClient(ws, opts);
    c.browser = ver.Browser;
    return c;
  }

  /** GET /json/version over TCP or a Unix socket without any dependency. */
  static version(target, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const opts = target.socketPath ? { socketPath: target.socketPath, path: '/json/version', headers: { Host: '127.0.0.1' } } : { host: target.host, port: target.port, path: '/json/version' };
        const req = request(opts, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('bad /json/version')); } }); });
        req.on('error', reject); req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('version timeout')); }); req.end();
      });
    });
  }

  _onMessage(raw) {
    let d; try { d = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
    if (d.id !== undefined && this.pending.has(d.id)) {
      const p = this.pending.get(d.id); this.pending.delete(d.id); clearTimeout(p.timer);
      if (d.error) p.reject(Object.assign(new Error(d.error.message || 'cdp error'), { code: d.error.code, method: p.method }));
      else p.resolve(d.result);
      return;
    }
    if (d.method) {
      // A new top-level document is unpainted again (see send). Both events arrive for script and page navigations.
      if (d.sessionId && ((d.method === 'Page.frameNavigated' && !(d.params && d.params.frame && d.params.frame.parentId)) || d.method === 'Runtime.executionContextsCleared')) this.awake.delete(d.sessionId);
      const set = this.listeners.get(d.method); const any = this.listeners.get('*');
      const ev = { method: d.method, sessionId: d.sessionId, params: d.params };
      if (set) for (const fn of set) { try { fn(ev); } catch (e) { this.log('listener error ' + e.message); } }
      if (any) for (const fn of any) { try { fn(ev); } catch (e) { this.log('listener error ' + e.message); } }
    }
  }

  /** Send a command. Policy-gated. sessionId targets a page session (flatten mode). */
  send(method, params = {}, sessionId) {
    // Page.navigate/close are denied in general (they bypass Aside's access checks on transport B); on C they are the
    // only way to drive OUR OWN target, so allow them solely on a session this run created.
    const ownSession = sessionId !== undefined && [...this.sessions.values()].includes(sessionId);
    // A borrowed tab may navigate (it is the only way to reach another screen there) but is never closed or raised.
    // An isolated window is ours, yet raising it would cover the user's screen, so the same deny applies to it.
    const lent = sessionId !== undefined ? this._borrowedBySession(sessionId) : null;
    const isoTarget = sessionId !== undefined && this._isolatedTargetOf(sessionId);
    if ((lent || isoTarget) && BORROWED_DENY.includes(method)) return Promise.reject(new Error('policy: ' + (lent ? 'borrowed tab' : 'isolated window') + ' — never raised or closed (' + method + ')'));
    if (lent && method.startsWith('Emulation.')) lent.emu.add(method);
    const gate = (method === 'Page.navigate' || method === 'Page.close') && this.transport === 'C' && (ownSession || (lent && method === 'Page.navigate')) ? { ok: true } : cdpAllowed(method, this.transport, params, this.owned, new Set(this.borrowed.keys()));
    if (!gate.ok) return Promise.reject(new Error('policy: ' + gate.why + ' (' + method + ')'));
    if (this.closed) return Promise.reject(new Error('cdp connection closed'));
    if (sessionId !== undefined) {
      // Our targets are background tabs, and one that has never painted drops mouse and key input without an error.
      // Measured 2026-09-26 (Windows, Chrome 153): clicks and keyDown were lost until one capture, insertText and
      // mouseMoved got through; one capture (70–90 ms) painted it, and that held across emulation changes and 8 s idle
      // but not across a navigation. So input waits for one capture per document; later input reuses it, in order.
      if (method === 'Page.navigate' || method === 'Page.reload') this.awake.delete(sessionId);
      if (/^Input\.dispatch(Mouse|Key|Touch|Drag)Event$/.test(method)) {
        if (!this.awake.has(sessionId)) this._markAwake(sessionId, this._dispatch('Page.captureScreenshot', { format: 'jpeg', quality: 1 }, sessionId));
        // If the capture failed (one timed out once in the 2026-09-26 runs), sending would be dropped silently — fail loudly.
        return this.awake.get(sessionId).then((painted) => painted ? this._dispatch(method, params, sessionId) : Promise.reject(new Error('input not sent: could not paint the background target first (wake capture failed), so the browser would have dropped it — retry')));
      }
      if (method === 'Page.captureScreenshot') {
        const p = this._dispatch(method, params, sessionId);
        if (!this.awake.has(sessionId)) this._markAwake(sessionId, p);
        return p;
      }
    }
    return this._dispatch(method, params, sessionId);
  }

  /** Record that `capture` paints this session's document (resolves true/false). A failed one is forgotten, so the next input retries. */
  _markAwake(sessionId, capture) {
    const w = capture.then(() => true, (e) => { if (this.awake.get(sessionId) === w) this.awake.delete(sessionId); this.log('wake capture failed: ' + e.message); return false; });
    this.awake.set(sessionId, w);
  }

  _dispatch(method, params, sessionId) {
    if (this.closed) return Promise.reject(new Error('cdp connection closed'));
    const id = ++this.id;
    const msg = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, new Set()); this.listeners.get(method).add(fn); return () => this.listeners.get(method).delete(fn); }

  /** Create OUR OWN background target and attach (flatten). Returns { targetId, sessionId }. */
  async openTarget(url = 'about:blank', { background = true } = {}) {
    const t = await this.send('Target.createTarget', { url, background });
    this.owned.add(t.targetId);
    const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    this.sessions.set(t.targetId, a.sessionId);
    return { targetId: t.targetId, sessionId: a.sessionId };
  }

  /** Close a target this run created. Never closes anything else (policy refuses unknown ids). */
  async closeTarget(targetId) {
    if (!this.owned.has(targetId)) throw new Error('not owned: ' + targetId);
    try { await this.send('Target.closeTarget', { targetId }); } finally { this.owned.delete(targetId); this.sessions.delete(targetId); }
  }

  /**
   * Give back every borrowed tab (undo, never close), close every owned target, throw away every isolated profile,
   * then the connection. Safe to call twice.
   */
  async dispose() {
    for (const id of [...this.borrowed.keys()]) { try { await this.releaseTab(id); } catch (e) { this.log('release ' + id + ' ' + e.message); } }
    for (const id of [...this.owned]) { try { await this.closeTarget(id); } catch (e) { this.log('close ' + id + ' ' + e.message); } }
    for (const ctx of [...this.isolated.keys()]) { try { await this.closeIsolatedWindow(ctx); } catch (e) { this.log('dispose context ' + e.message); } }
    this.guards.clear(); // guards on owned tabs ended with their targets
    try { this.ws.close(); } catch { /* already closed */ }
    this.closed = true;
  }

  _borrowedBySession(sessionId) { for (const b of this.borrowed.values()) if (b.sessionId === sessionId) return b; return null; }
  _isolatedTargetOf(sessionId) {
    for (const ids of this.isolated.values()) for (const id of ids) if (this.sessions.get(id) === sessionId) return id;
    return null;
  }

  /**
   * Read-only: every page tab with its window. Nothing is attached or changed. `owned`/`borrowed` mark this run's own.
   * Each tab costs one Browser.getWindowForTarget; a tab whose window can't be read has windowId null.
   */
  async listTabs() {
    const { targetInfos = [] } = await this.send('Target.getTargets', {});
    const out = [];
    for (const t of targetInfos) {
      if (t.type !== 'page') continue;
      let windowId = null, windowState = null;
      try { const w = await this.send('Browser.getWindowForTarget', { targetId: t.targetId }); windowId = w.windowId; windowState = (w.bounds && w.bounds.windowState) || null; } catch (e) { this.log('window of ' + t.targetId + ': ' + e.message); }
      out.push({ targetId: t.targetId, url: t.url, title: t.title, windowId, windowState, browserContextId: t.browserContextId || null, owned: this.owned.has(t.targetId), borrowed: this.borrowed.has(t.targetId) });
    }
    return out;
  }

  /**
   * Borrow one of the user's tabs: the tab whose URL matches `match` and — with `sameWindowAs` — sits in the same
   * window as a tab matching that pattern (e.g. the Mesa tab in the JANDI window). `targetId` picks one when several
   * match. It is never created, raised or closed: no match ⇒ an error asking the person to open one in that window;
   * several ⇒ an error listing them (a person picks). Injected UI is hidden by default (prep:false to skip) and every
   * change made here is undone by releaseTab()/dispose().
   * Returns { targetId, sessionId, windowId, url, injected }.
   */
  async borrowTab({ match, sameWindowAs, targetId, prep = true } = {}) {
    if (this.transport !== 'C') throw new Error('borrowTab: transport C only');
    if (!match) throw new Error('borrowTab: match (URL pattern) is required');
    const tabs = await this.listTabs();
    let cands = tabs.filter((t) => !t.owned && urlMatches(match, t.url));
    if (sameWindowAs) {
      const anchors = tabs.filter((t) => urlMatches(sameWindowAs, t.url) && t.windowId !== null);
      if (!anchors.length) throw Object.assign(new Error('borrowTab: no tab matching "' + sameWindowAs + '" is open, so its window cannot be found — ask the person to open it'), { code: 'no-anchor' });
      const wins = new Set(anchors.map((t) => t.windowId));
      cands = cands.filter((t) => wins.has(t.windowId));
    }
    if (targetId) cands = cands.filter((t) => t.targetId === targetId);
    const brief = (t) => ({ targetId: t.targetId, url: redactUrl(t.url), title: t.title, windowId: t.windowId });
    if (!cands.length) throw Object.assign(new Error('borrowTab: no tab matches "' + match + '"' + (sameWindowAs ? ' in the window of "' + sameWindowAs + '"' : '') + ' — a new tab is not created; ask the person to open one there'), { code: 'no-tab' });
    if (cands.length > 1) throw Object.assign(new Error('borrowTab: ' + cands.length + ' tabs match — pass targetId (a person picks): ' + JSON.stringify(cands.map(brief))), { code: 'several', candidates: cands.map(brief) });
    const t = cands[0];
    const gate = this.borrowGate(t.url);
    if (!gate.ok) throw Object.assign(new Error('borrowTab: ' + gate.why), { code: 'not-lent' });
    if (this.borrowed.has(t.targetId)) return this._borrowInfo(t.targetId);
    const entry = { sessionId: null, url: t.url, windowId: t.windowId, emu: new Set(), prepScript: null, prepped: false, injected: [] };
    this.borrowed.set(t.targetId, entry);
    try {
      const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      entry.sessionId = a.sessionId;
      if (prep) {
        await this.send('Page.enable', {}, a.sessionId);
        const s = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: BORROW_PREP_ON_NEW_DOC }, a.sessionId);
        entry.prepScript = s && s.identifier;
        const r = await this.evaluate(a.sessionId, BORROW_PREP_JS);
        entry.prepped = true; entry.injected = (r && r.injected) || [];
      }
    } catch (e) {
      try { await this.releaseTab(t.targetId); } catch { /* best effort */ }
      throw e;
    }
    return this._borrowInfo(t.targetId);
  }

  _borrowInfo(targetId) { const b = this.borrowed.get(targetId); return { targetId, sessionId: b.sessionId, windowId: b.windowId, url: redactUrl(b.url), injected: b.injected }; }

  /** Give a borrowed tab back: stop its write guard, undo emulation and prep, detach. The tab stays open. */
  async releaseTab(targetId) {
    const b = this.borrowed.get(targetId);
    if (!b) return { released: false };
    const s = b.sessionId; const undone = [];
    try {
      if (s) {
        if (this.guards.has(s)) { await this.guards.get(s).stop(); undone.push('write guard'); }
        for (const m of b.emu) { const r = EMU_RESET[m]; if (r) { try { await this._dispatch(r[0], r[1], s); undone.push(m); } catch (e) { this.log('reset ' + m + ' ' + e.message); } } }
        if (b.prepScript) { try { await this._dispatch('Page.removeScriptToEvaluateOnNewDocument', { identifier: b.prepScript }, s); } catch (e) { this.log('remove prep script ' + e.message); } }
        if (b.prepped) { try { const r = await this.evaluate(s, BORROW_UNDO_JS); undone.push('prep (' + ((r && r.restored) || 0) + ' elements shown again)'); } catch (e) { this.log('undo prep ' + e.message); } }
      }
    } finally {
      if (s) { try { await this._dispatch('Target.detachFromTarget', { sessionId: s }); } catch (e) { this.log('detach ' + e.message); } }
      this.borrowed.delete(targetId); this.awake.delete(s);
    }
    return { released: true, undone };
  }

  /**
   * Write guard for one session (borrowed, owned or isolated): every request that is not GET/HEAD/OPTIONS is failed
   * before it leaves the browser, unless its path is in `allow` (keep-alive / auth refresh — see writeAllowed). Both
   * outcomes are logged. With selfTest (default) it immediately POSTs to a path that does not exist and refuses to go
   * on unless that POST was blocked and logged. Not covered: WebSocket frames, and requests a service/shared worker
   * sends by itself (they are other targets) — say so when reporting.
   * Returns { log(), summary(), stop(), selfTest }.
   */
  async guardWrites(sessionId, { allow = [], selfTest = true } = {}) {
    if (this.guards.has(sessionId)) return this.guards.get(sessionId);
    const log = [];
    const off = this.on('Fetch.requestPaused', (e) => {
      if (e.sessionId !== sessionId) return;
      const id = e.params.requestId; const r = e.params.request || {}; const m = String(r.method || 'GET').toUpperCase();
      if (SAFE_HTTP_METHODS.includes(m)) { this._dispatch('Fetch.continueRequest', { requestId: id }, sessionId).catch((x) => this.log('guard continue ' + x.message)); return; }
      const pass = writeAllowed(allow, r.url);
      log.push({ t: Date.now(), action: pass ? 'passed' : 'blocked', method: m, url: redactUrl(r.url), resourceType: e.params.resourceType, probe: String(r.url || '').includes(GUARD_PROBE) || undefined });
      const p = pass ? this._dispatch('Fetch.continueRequest', { requestId: id }, sessionId) : this._dispatch('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }, sessionId);
      p.catch((x) => this.log('guard ' + (pass ? 'continue ' : 'fail ') + x.message));
    });
    // Fetch.* stays denied for scripts (policy); the guard is the one place that uses it, through _dispatch.
    try { await this._dispatch('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId); } catch (e) { off(); throw e; }
    const guard = {
      sessionId, allow: allow.slice(), selfTest: null,
      log: () => log.slice(),
      summary: () => ({ blocked: log.filter((l) => l.action === 'blocked' && !l.probe).length, passed: log.filter((l) => l.action === 'passed').length, entries: log.filter((l) => !l.probe).slice(-50) }),
      stop: async () => { off(); this.guards.delete(sessionId); try { await this._dispatch('Fetch.disable', {}, sessionId); } catch (x) { this.log('guard disable ' + x.message); } },
    };
    this.guards.set(sessionId, guard);
    if (selfTest) {
      const n0 = log.length;
      let result;
      try { result = await this.evaluate(sessionId, '(async () => { try { const r = await fetch(' + JSON.stringify(GUARD_PROBE) + ' + Date.now(), { method: "POST", body: "x", cache: "no-store" }); return "reached " + r.status; } catch (e) { return "blocked " + e.name; } })()'); } catch (e) { result = 'error ' + e.message; }
      const logged = log.slice(n0).some((l) => l.probe && l.action === 'blocked');
      guard.selfTest = { result, logged, ok: /^blocked/.test(String(result)) && logged };
      if (!guard.selfTest.ok) { await guard.stop(); throw Object.assign(new Error('guardWrites: self-test failed (' + result + ', logged ' + logged + ') — the guard is off; do not go on'), { code: 'guard-self-test' }); }
    }
    return guard;
  }

  /**
   * A throwaway browser profile in its own (minimized by default) window, for test accounts: cookies and logins never
   * mix with the user's. Thrown away by closeIsolatedWindow()/dispose(), and by the browser if this connection drops
   * (disposeOnDetach). Returns { targetId, sessionId, browserContextId, windowState }.
   */
  async openIsolatedWindow(url = 'about:blank', { minimized = true } = {}) {
    if (this.transport !== 'C') throw new Error('openIsolatedWindow: transport C only');
    const { browserContextId } = await this._dispatch('Target.createBrowserContext', { disposeOnDetach: true });
    this.isolated.set(browserContextId, new Set());
    const t = await this._dispatch('Target.createTarget', { url, newWindow: true, background: true, browserContextId, ...(minimized ? { windowState: 'minimized' } : {}) });
    this.owned.add(t.targetId); this.isolated.get(browserContextId).add(t.targetId);
    const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    this.sessions.set(t.targetId, a.sessionId);
    let windowState = null;
    try { const w = await this.send('Browser.getWindowForTarget', { targetId: t.targetId }); windowState = (w.bounds && w.bounds.windowState) || null; } catch (e) { this.log('isolated window state ' + e.message); }
    return { targetId: t.targetId, sessionId: a.sessionId, browserContextId, windowState };
  }

  /** Put cookies into an isolated profile (never the user's). Values are not returned or logged. */
  async setIsolatedCookies(browserContextId, cookies) {
    if (!this.isolated.has(browserContextId)) throw new Error('setIsolatedCookies: not an isolated profile of this run');
    if (!Array.isArray(cookies) || !cookies.length) throw new Error('setIsolatedCookies: cookies[] required');
    await this._dispatch('Storage.setCookies', { cookies, browserContextId });
    return { count: cookies.length, names: cookies.map((c) => c.name) };
  }

  /** Close an isolated profile's windows and throw the profile (cookies, storage) away. */
  async closeIsolatedWindow(browserContextId) {
    const ids = this.isolated.get(browserContextId);
    if (!ids) return { disposed: false };
    try { for (const id of [...ids]) { if (this.owned.has(id)) { try { await this.closeTarget(id); } catch (e) { this.log('close isolated ' + e.message); } } } }
    finally { this.isolated.delete(browserContextId); await this._dispatch('Target.disposeBrowserContext', { browserContextId }); }
    return { disposed: true };
  }

  /**
   * Event recorder for a session: collects console / exception / network / log events with redaction.
   * Returns { stop(), events(), summary() }.
   */
  record(sessionId, { network = true, body = false } = {}) {
    const events = [];
    const offs = [];
    const keep = (type, data) => events.push({ ...redact(data), t: Date.now(), type }); // type last so payload keys never override it
    // Extensions run content scripts in isolated worlds of the same page, so their errors arrive with the page's.
    // Measured 2026-09-26 on example.com: 2 of 3 exceptions came from the DeepL extension. They are kept as
    // ext-console / ext-exception with the extension's name and stay out of summary().problems. A context created
    // before record() started is not in the map, so a chrome-extension:// (or chrome://) top frame also counts.
    const isolated = new Map(); // executionContextId → extension name or origin
    const extOf = (ctxId, frames) => {
      if (isolated.has(ctxId)) return isolated.get(ctxId);
      const u = (frames && frames[0] && frames[0].url) || '';
      return /^chrome(-extension)?:\/\//.test(u) ? u.split('/').slice(0, 3).join('/') : null;
    };
    offs.push(this.on('Runtime.executionContextCreated', (e) => { if (e.sessionId === sessionId) { const c = e.params.context || {}; if (c.auxData && c.auxData.type === 'isolated') isolated.set(c.id, c.name || c.origin); } }));
    offs.push(this.on('Runtime.consoleAPICalled', (e) => {
      if (e.sessionId !== sessionId) return;
      const frames = (e.params.stackTrace && e.params.stackTrace.callFrames) || [];
      const ext = extOf(e.params.executionContextId, frames);
      keep(ext ? 'ext-console' : 'console', { ...(ext ? { extension: ext } : {}), level: e.params.type, args: (e.params.args || []).map((a) => a.value !== undefined ? a.value : a.description).slice(0, 8), stack: frames.slice(0, 1).map((f) => f.url + ':' + f.lineNumber) });
    }));
    offs.push(this.on('Runtime.exceptionThrown', (e) => {
      if (e.sessionId !== sessionId) return;
      const d = e.params.exceptionDetails || {};
      const ext = extOf(d.executionContextId, d.stackTrace && d.stackTrace.callFrames);
      keep(ext ? 'ext-exception' : 'exception', { ...(ext ? { extension: ext } : {}), text: d.text, description: d.exception && d.exception.description, url: d.url, line: d.lineNumber });
    }));
    offs.push(this.on('Log.entryAdded', (e) => { if (e.sessionId === sessionId) keep('log', { level: e.params.entry.level, source: e.params.entry.source, text: e.params.entry.text, url: e.params.entry.url }); }));
    if (network) {
      offs.push(this.on('Network.requestWillBeSent', (e) => { if (e.sessionId === sessionId) keep('request', { id: e.params.requestId, method: e.params.request.method, url: e.params.request.url, resourceType: e.params.type, headers: e.params.request.headers, body: body ? e.params.request.postData : undefined }); }));
      offs.push(this.on('Network.responseReceived', (e) => { if (e.sessionId === sessionId) keep('response', { id: e.params.requestId, status: e.params.response.status, url: e.params.response.url, mime: e.params.response.mimeType, headers: e.params.response.headers, protocol: e.params.response.protocol }); }));
      offs.push(this.on('Network.loadingFailed', (e) => { if (e.sessionId === sessionId) keep('failed', { id: e.params.requestId, error: e.params.errorText, canceled: e.params.canceled, blocked: e.params.blockedReason }); }));
      offs.push(this.on('Network.webSocketFrameReceived', (e) => { if (e.sessionId === sessionId) keep('ws-recv', { id: e.params.requestId, data: String(e.params.response.payloadData).slice(0, 500) }); }));
      offs.push(this.on('Network.webSocketFrameSent', (e) => { if (e.sessionId === sessionId) keep('ws-send', { id: e.params.requestId, data: String(e.params.response.payloadData).slice(0, 500) }); }));
    }
    return {
      stop: () => offs.forEach((f) => f()),
      events: () => events.slice(),
      summary: () => { const c = {}; for (const e of events) c[e.type] = (c[e.type] || 0) + 1; return { counts: c, problems: events.filter((e) => e.type === 'exception' || e.type === 'failed' || (e.type === 'console' && /error|warning/.test(e.level)) || (e.type === 'response' && e.status >= 400)).slice(-30) }; },
    };
  }

  /**
   * Environment prep for transport C, in the owner's fixed order (same as kit/head.js K.prep): DETECT → WARN → only
   * then lock Dark Reader in OUR target and hide injected UI (DeepL, Aside, password-manager icons), so captures show
   * the page and not the extensions. opts.darkReader: 'must-be-off-warn' (default) | 'tolerate' | 'lock-silently'.
   * Returns { before, after, warnings[] } — report the warnings; `before.injected` lists what was hidden.
   */
  async prep(sessionId, opts = {}) {
    const mode = opts.darkReader || 'must-be-off-warn';
    const before = await this.evaluate(sessionId, SCAN_JS);
    const warnings = [];
    if (before.darkReader && mode === 'must-be-off-warn') warnings.push(WARN_DARK);
    if (before.injected.length) warnings.push('INJECTED_UI: ' + before.injected.join(',') + ' (hidden for capture; excluded from axe)');
    if (mode !== 'tolerate') await this.evaluate(sessionId, LOCK_JS);
    const after = await this.evaluate(sessionId, SCAN_JS);
    return { before, after, warnings };
  }

  /** Enable the usual domains for a session. */
  async enable(sessionId, domains = ['Page', 'Runtime', 'Log', 'Network']) {
    for (const d of domains) await this.send(d + '.enable', {}, sessionId);
  }

  /** Evaluate an expression in the page main world, returning the value (JSON-serialisable). */
  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }

  /** Screenshot (never fromSurface:false — policy blocks it). Returns a Buffer. */
  async screenshot(sessionId, { format = 'jpeg', quality = 60, clip } = {}) {
    const r = await this.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}), ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId);
    return Buffer.from(r.data, 'base64');
  }
}
