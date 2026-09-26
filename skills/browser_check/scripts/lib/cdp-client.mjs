/*
 * CDP client used by transport C (direct DevTools protocol — local TCP on the browser machine, or a reverse-forwarded
 * Unix socket on a server). This is the *broker* the Codex consult required: every command passes the policy
 * allow/deny list, targets are owned per run, screenshots never use fromSurface:false, events and results go through
 * the central redactor before they reach the caller, and everything created is closed in finally.
 */
import { connect } from './cdp-ws.mjs';
import { cdpAllowed } from './policy.mjs';
import { redact } from './redact.mjs';

export class CdpClient {
  /** target: { socketPath } | { host, port } · browserWsPath from /json/version · opts.commandTimeoutMs */
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map(); // method → Set<fn>
    this.owned = new Set();     // targetIds this run created
    this.sessions = new Map();  // targetId → sessionId
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
    offs.push(this.on('Runtime.consoleAPICalled', (e) => { if (e.sessionId === sessionId) keep('console', { level: e.params.type, args: (e.params.args || []).map((a) => a.value !== undefined ? a.value : a.description).slice(0, 8), stack: (e.params.stackTrace && e.params.stackTrace.callFrames || []).slice(0, 1).map((f) => f.url + ':' + f.lineNumber) }); }));
    offs.push(this.on('Runtime.exceptionThrown', (e) => { if (e.sessionId === sessionId) { const d = e.params.exceptionDetails || {}; keep('exception', { text: d.text, description: d.exception && d.exception.description, url: d.url, line: d.lineNumber }); } }));
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
