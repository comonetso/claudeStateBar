/*
 * CDP client used by transport C (direct DevTools protocol — local TCP on the browser machine, or a reverse-forwarded
 * Unix socket on a server). This is the *broker* the Codex consult required: every command passes the policy
 * allow/deny list, targets are owned per run, screenshots never use fromSurface:false, events and results go through
 * the central redactor before they reach the caller, and everything created is closed in finally.
 */
import { connect } from './cdp-ws.mjs';
import { cdpAllowed } from './policy.mjs';
import { redact } from './redact.mjs';

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
    const gate = (method === 'Page.navigate' || method === 'Page.close') && this.transport === 'C' && ownSession ? { ok: true } : cdpAllowed(method, this.transport, params, this.owned);
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

  /** Close every owned target, then the connection. Safe to call twice. */
  async dispose() {
    for (const id of [...this.owned]) { try { await this.closeTarget(id); } catch (e) { this.log('close ' + id + ' ' + e.message); } }
    try { this.ws.close(); } catch { /* already closed */ }
    this.closed = true;
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
