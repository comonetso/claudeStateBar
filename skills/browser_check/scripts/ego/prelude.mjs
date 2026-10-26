// browser_check ego prelude — `browser-check run` (and `look`) puts this in front of every script it sends to ego-browser.
// It runs inside ego-browser's own Node runtime on the PC (top-level await works; taskSpace/listTaskSpaces/help are
// ego globals). The script after it uses `bc.*`. The line below is replaced with this run's settings.
const __bcCfg = /*__BC_CFG__*/ { windowScript: null, kit: {}, light: true, settleMs: 15000, url: null, guard: null };
const __bcFs = await import('node:fs');
const __bcCp = await import('node:child_process');

// Commands a browser_check script must not send (each from a rule or a measurement): clearing cookies, cache or
// storage reaches the user's whole ego profile · closing the browser · window bounds/state (on 2026-10-21 a "minimize
// my space's window" call minimized the user's own window — the space's tab belongs to it) · Fetch interception
// (deadlocks in ego: the paused request waits on a page command queued behind it) · creating or closing targets
// outside ego's task-space API. Wrapped once on the first TaskSpace/Page seen.
const __bcDeny = /^(Storage\.|Network\.(clearBrowserCookies|clearBrowserCache|deleteCookies|setCookies?$|getCookies$|getAllCookies$)|Browser\.(close|setWindowBounds|crash|resetPermissions|grantPermissions|setDownloadBehavior)|Fetch\.|Target\.(closeTarget|createTarget|createBrowserContext|disposeBrowserContext)|Page\.(close|crash|setDownloadBehavior)|Debugger\.pause)/;
const __bcWrap = (obj) => {
  const proto = obj && Object.getPrototypeOf(obj);
  if (!proto || proto.__bcWrapped || typeof proto.cdp !== 'function') return;
  const orig = proto.cdp;
  proto.cdp = function (method, ...rest) { if (__bcDeny.test(String(method))) throw new Error('browser_check refuses ' + method + ' (SKILL.md §1)'); return orig.call(this, method, ...rest); };
  proto.__bcWrapped = true;
};
try { const __origTask = globalThis.taskSpace; if (typeof __origTask === 'function') globalThis.taskSpace = async (...a) => { const t = await __origTask(...a); __bcWrap(t); try { __bcWrap(t.page('p1')); } catch { /* no p1 */ } return t; }; } catch { /* read-only global — bc.run still wraps */ }

// In-page hooks, installed before the page's own scripts on every document (Page.addScriptToEvaluateOnNewDocument)
// and once into the current document. __bcInflight counts fetch/XHR still open — the same idea as Aside's
// K.safeClose (counting CDP network events missed long requests and stayed above 0, measured 2026-10-21).
// __bcGuard, when on, rejects non-GET fetch/XHR/sendBeacon and form submits unless the path is allowed.
const __bcHook = `(() => {
  const w = window; if (w.__bcHooked) return; w.__bcHooked = 1; w.__bcInflight = 0; w.__bcInflightWrite = 0;
  w.__bcGuard = w.__bcGuard || null;
  const safe = (m) => !m || /^(GET|HEAD|OPTIONS)$/i.test(m);
  const allowed = (u) => { const g = w.__bcGuard; if (!g) return true; try { const x = new URL(u, location.href); return g.allow.some((a) => x.pathname === a || x.pathname.startsWith(a.endsWith('/') ? a : a + '/') || x.href === a); } catch (e) { return false; } };
  const note = (kind, m, u) => { const g = w.__bcGuard; if (!g) return; const b = { kind, method: String(m || ''), url: String(u || '').slice(0, 200) }; g.blocked.push(b); try { console.info('[bc-guard] blocked ' + JSON.stringify(b)); } catch (e) { /* console replaced */ } };
  const of = w.fetch;
  if (of) w.fetch = function (input, init) {
    const m = (init && init.method) || (input && input.method) || 'GET'; const u = (input && input.url) || String(input);
    if (w.__bcGuard && !safe(m) && !allowed(u)) { note('fetch', m, u); return Promise.reject(new TypeError('bc-guard: blocked ' + m)); }
    const wr = !safe(m); w.__bcInflight++; if (wr) w.__bcInflightWrite++;
    return of.apply(this, arguments).finally(() => { w.__bcInflight--; if (wr) w.__bcInflightWrite--; });
  };
  const X = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
  if (X) {
    const oo = X.open, os = X.send;
    X.open = function (m, u) { this.__bcM = m; this.__bcU = u; return oo.apply(this, arguments); };
    X.send = function () {
      if (w.__bcGuard && !safe(this.__bcM) && !allowed(this.__bcU)) { note('xhr', this.__bcM, this.__bcU); throw new TypeError('bc-guard: blocked ' + this.__bcM); }
      const wr = !safe(this.__bcM); w.__bcInflight++; if (wr) w.__bcInflightWrite++;
      let done = false; const end = () => { if (!done) { done = true; w.__bcInflight--; if (wr) w.__bcInflightWrite--; } };
      this.addEventListener('loadend', end); return os.apply(this, arguments);
    };
  }
  if (navigator.sendBeacon) { const ob = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function (u, d) { if (w.__bcGuard && !allowed(u)) { note('beacon', 'POST', u); return false; } return ob(u, d); }; }
  document.addEventListener('submit', (e) => { const f = e.target; const m = (f && f.method) || 'GET'; if (w.__bcGuard && !safe(m) && !allowed(f.action)) { e.preventDefault(); e.stopImmediatePropagation(); note('form', m, f.action); } }, true);
})();`;

const bc = {
  /** The --url this run was given (or null). */
  url: __bcCfg.url,
  /** One line the runner keeps as data: @@OUT <tag> <json>. */
  out(tag, value) { console.log('@@OUT ' + tag + ' ' + JSON.stringify(value === undefined ? null : value)); },
  /** One image the runner saves as a file: @@IMG <name> <base64>. */
  img(name, buf) { console.log('@@IMG ' + String(name).replace(/[^\w.-]/g, '_') + ' ' + Buffer.from(buf).toString('base64')); },

  /**
   * Open (or resume) a task space, run fn({ task, page }), and always close the space afterwards — even when fn
   * throws (a dead script otherwise left the space open, Mesa run 2026-10-21). Closing waits until the page has no
   * request in flight; if it never settles the space is left open and reported, never forced (Aside rule).
   */
  async run(name, fn, { prep = true } = {}) {
    const task = await taskSpace(name);
    const page = task.page('p1');
    __bcWrap(task); __bcWrap(page);
    let result; let error = null;
    try {
      if (prep) await bc.prep(page);
      if (__bcCfg.guard) bc.out('GUARD', await bc.guardWrites(page, { allow: __bcCfg.guard.allow || [] }));
      result = await fn({ task, page });
    } catch (e) { error = e; }
    // What the guard refused — on a logged-in site this shows the token-refresh POST if it was not allowed
    // (Mesa fell to its login screen with the guard on, 2026-10-21; nothing reached the server, the login survived).
    if (__bcCfg.guard) { try { bc.out('GUARD_BLOCKED', await bc.guardReport(page)); } catch { /* page gone */ } }
    const closed = await bc.finish(task, page);
    if (error) throw error;
    return { result, closed };
  },

  /** Hooks for in-flight counting (and the write guard), light colour scheme, extension UI detected. */
  async prep(page, { light = __bcCfg.light } = {}) {
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: __bcHook }, { timeout: 5000 });
    try { await page.evaluate(__bcHook); } catch { /* about:blank before the first navigation */ }
    if (light) await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, { timeout: 5000 });
    const viewport = await bc.fixViewport(page);
    return { light, viewport };
  },

  /**
   * A tab opened in a minimized ego window that was never shown has a 0x0 page (measured 2026-10-26: innerWidth 0,
   * windowState "minimized") — nothing paints, so screencast gets no frame and the page text is only "root". Such a
   * page gets its window's size (else 1280x800) through device metrics, the way --width does; the window itself is
   * not touched. A page that already has a size is left alone.
   */
  async fixViewport(page) {
    let size;
    try { size = await page.evaluate(() => [innerWidth, innerHeight]); } catch (e) { return { fixed: false, why: String(e && e.message || e).slice(0, 120) }; }
    if (size[0] > 0 && size[1] > 0) return { fixed: false, size };
    let width = 1280, height = 800;
    try {
      const w = await page.cdp('Browser.getWindowForTarget', {}, { timeout: 5000 }); const b = w && w.bounds;
      if (b && b.width > 200 && b.height > 200) { width = b.width; height = b.height; }
    } catch { /* default size */ }
    await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, { timeout: 5000 });
    return { fixed: true, size, width, height };
  },

  /** Wait until no fetch/XHR is open and the resource count is stable for 5 checks 500 ms apart. */
  async settle(page, maxMs = __bcCfg.settleMs) {
    const t0 = Date.now(); let ok = 0; let lastN = -1; let s = null;
    while (Date.now() - t0 < maxMs) {
      try { s = await page.evaluate(() => ({ p: typeof window.__bcInflight === 'number' ? window.__bcInflight : null, w: typeof window.__bcInflightWrite === 'number' ? window.__bcInflightWrite : null, n: performance.getEntriesByType('resource').length, url: location.href })); }
      catch (e) { s = { p: null, err: String(e && e.message || e).slice(0, 120) }; }
      if (s.url === 'about:blank') return { settled: true, ms: Date.now() - t0, s };
      if (s.p === 0 && s.n === lastN) { if (++ok >= 5) return { settled: true, ms: Date.now() - t0, s }; } else ok = 0;
      lastN = s.n;
      await page.waitForTimeout(500);
    }
    return { settled: false, ms: Date.now() - t0, s };
  },

  /**
   * Close the task space only after the page settles; otherwise leave it open and say so.
   * A page that never settles with only read requests open (no POST/PUT/… in flight) is blanked first, then closed:
   * live pages keep a GET waiting forever — Paseo web holds /__gate/screen/wait open — so every space that looked at
   * one stayed open and piled up in ego (2026-10-26, six spaces; owner decision). Cutting a GET changes nothing; an
   * open write (a token refresh, say) still leaves the space open, as before.
   */
  async finish(task, page) {
    const st = page ? await bc.settle(page) : { settled: true };
    if (!st.settled && st.s && st.s.w === 0) {
      try {
        // The last sample is up to 500 ms old — a write started since then must keep the space open (10-26 Codex review)
        const w = await page.evaluate(() => (typeof window.__bcInflightWrite === 'number' ? window.__bcInflightWrite : null));
        if (w !== 0) throw new Error(`write in flight (${w})`);
        await page.goto('about:blank');
        await task.finish({ keep: [] });
        return { closed: true, settle: { ms: st.ms, cut: 'read requests only', state: st.s } };
      } catch (e) { st.cutError = String(e && e.message || e).slice(0, 120); }
    }
    if (!st.settled) { bc.out('LEFT_OPEN', { space: task.name, why: 'requests still in flight', state: st.s }); return { closed: false, settle: st }; }
    await task.finish({ keep: [] });
    return { closed: true, settle: { ms: st.ms } };
  },

  /**
   * A capture that also works while the ego window is minimized or closed with X:
   * 1. page.screenshot — refused by the browser itself while minimized ("Cannot capture a screenshot while the
   *    window is minimized", chrome.dll), and times out in a never-painted hidden window;
   * 2. screencast — keeps painting while minimized; frames are acked and the last one after a short wait is used,
   *    because the first frame can be the one painted before the latest change (measured 2026-10-21);
   * 3. no frame at all = every ego window was closed with X (ego hides them and stops painting): reopen the ego
   *    window and minimize it at once (owner decision 2026-10-21), then screencast again.
   */
  async shot(page, name = 'shot', { fullPage = false, timeoutMs = 8000 } = {}) {
    const t0 = Date.now();
    try {
      const p = await bc.__guardTime(page.screenshot({ fullPage }), timeoutMs);
      const buf = __bcFs.readFileSync(p); try { __bcFs.unlinkSync(p); } catch { /* temp file */ }
      bc.img(name + '.png', buf); return { ok: true, via: 'screenshot', ms: Date.now() - t0 };
    } catch (e) {
      const why = String(e && e.message || e);
      // A painting window answers within a few hundred ms; 1.5 s without a frame means nothing is painting.
      let frame = await bc.__cast(page, { waitMs: 1500 });
      let reopened = null, viewport;
      // A 0x0 page (a page this run opened itself, not through bc.run) paints once it has a size.
      if (!frame) { viewport = await bc.fixViewport(page); if (viewport.fixed) frame = await bc.__cast(page); }
      if (!frame && __bcCfg.windowScript) { reopened = bc.ensureWindow(); frame = await bc.__cast(page); }
      if (!frame) return { ok: false, ms: Date.now() - t0, why: why.slice(0, 160), reopened, viewport };
      bc.img(name + '.png', Buffer.from(frame, 'base64'));
      return { ok: true, via: 'screencast', ms: Date.now() - t0, firstTry: why.slice(0, 80), reopened, viewport: viewport && viewport.fixed ? viewport : undefined, fullPage: fullPage ? 'not available on screencast' : undefined };
    }
  },
  async __guardTime(p, ms) { let t; try { return await Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(new Error('timeout ' + ms + 'ms')), ms); })]); } finally { clearTimeout(t); } },
  async __cast(page, { waitMs = 3000, settleMs = 600 } = {}) {
    let last = null; let firstAt = 0;
    const pull = async () => { for (const e of await bc.events(page, { keep: (x) => x.method !== 'Page.screencastFrame' })) if (e.method === 'Page.screencastFrame') { last = e.params.data; if (!firstAt) firstAt = Date.now(); await page.cdp('Page.screencastFrameAck', { sessionId: e.params.sessionId }, { timeout: 3000 }); } };
    await page.cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, { timeout: 5000 });
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) { await pull(); if (firstAt && Date.now() - firstAt >= settleMs) break; await page.waitForTimeout(100); }
    } finally { try { await page.cdp('Page.stopScreencast', {}, { timeout: 5000 }); } catch { /* page gone */ } }
    return last;
  },

  /** Reopen ego's window and minimize it at once when every ego window was closed with X (PC helper script). */
  ensureWindow() {
    if (!__bcCfg.windowScript) return { ok: false, why: 'no window helper' };
    try {
      const out = __bcCp.execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', __bcCfg.windowScript, 'ensure'], { timeout: 20000, windowsHide: true, encoding: 'utf8' });
      return JSON.parse(out.trim().split(/\r?\n/).pop() || '{}');
    } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 160) }; }
  },

  /** Console, exceptions, log and network events. Call before the step you want to watch. */
  async watch(page) {
    for (const d of ['Runtime', 'Network', 'Log']) await page.cdp(d + '.enable', {}, { timeout: 5000 });
    await bc.events(page);
    return true;
  },
  /** Pull ego's event buffer (reading it empties it) and keep it per page so helpers can share it. */
  async events(page, { keep = () => true } = {}) {
    const got = await page.events();
    const k = page.label || 'p1';
    bc.__ev[k] = bc.__ev[k] || [];
    for (const e of got) if (keep(e)) { bc.__ev[k].push(e); if (bc.__ev[k].length > 20000) bc.__ev[k].shift(); }
    return got;
  },
  __ev: {},
  /** Only what matters: errors, failed or 4xx/5xx requests — browser-extension noise kept apart. */
  async problems(page) {
    await bc.events(page);
    const ev = bc.__ev[page.label || 'p1'] || [];
    const isExt = (u) => /^(chrome|moz)-extension:\/\//.test(String(u || ''));
    const reqUrl = {}; for (const e of ev) if (e.method === 'Network.requestWillBeSent') reqUrl[e.params.requestId] = e.params.request.url;
    const out = { console: [], exceptions: [], log: [], failed: [], http: [], ext: [] };
    for (const e of ev) {
      const p = e.params || {};
      if (e.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
        const u = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0] && p.stackTrace.callFrames[0].url;
        const item = { type: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300), url: u || '' };
        (isExt(u) ? out.ext : out.console).push(item);
      } else if (e.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {}; const u = d.url || (d.stackTrace && d.stackTrace.callFrames && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || '';
        const item = { text: String((d.exception && d.exception.description) || d.text || '').slice(0, 300), url: u };
        (isExt(u) ? out.ext : out.exceptions).push(item);
      } else if (e.method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
        (isExt(p.entry.url) ? out.ext : out.log).push({ source: p.entry.source, text: String(p.entry.text).slice(0, 300), url: p.entry.url || '' });
      } else if (e.method === 'Network.loadingFailed' && !p.canceled) {
        out.failed.push({ url: String(reqUrl[p.requestId] || '').slice(0, 200), error: p.errorText, blockedReason: p.blockedReason || undefined });
      } else if (e.method === 'Network.responseReceived' && p.response && p.response.status >= 400) {
        out.http.push({ status: p.response.status, url: String(p.response.url).slice(0, 200), type: p.type });
      }
    }
    out.summary = { console: out.console.length, exceptions: out.exceptions.length, log: out.log.length, failed: out.failed.length, http: out.http.length, ext: out.ext.length };
    return out;
  },

  /**
   * What the page sent that could change something: every request other than GET/HEAD/OPTIONS seen since bc.watch,
   * with its response status (null = no answer yet), oldest first. `since` = an index from bc.mark(page) to see only
   * what one step sent. A click that saved or sent something shows up here.
   */
  async sent(page, { since = 0 } = {}) {
    await bc.events(page);
    const ev = (bc.__ev[page.label || 'p1'] || []).slice(since);
    const list = []; const byId = {};
    for (const e of ev) {
      const p = e.params || {};
      if (e.method === 'Network.requestWillBeSent' && p.request && !/^(GET|HEAD|OPTIONS)$/i.test(p.request.method)) {
        const item = { method: p.request.method, url: String(p.request.url).slice(0, 200), type: p.type, status: null };
        list.push(item); byId[p.requestId] = item;
      } else if (e.method === 'Network.responseReceived' && byId[p.requestId]) byId[p.requestId].status = p.response.status;
      else if (e.method === 'Network.loadingFailed' && byId[p.requestId]) byId[p.requestId].status = 'failed: ' + (p.blockedReason || p.errorText);
    }
    return list;
  },
  /** A position in this page's event record, for bc.sent(page, { since }). */
  async mark(page) { await bc.events(page); return (bc.__ev[page.label || 'p1'] || []).length; },

  /**
   * Opt-in write guard for this page: non-GET fetch/XHR/sendBeacon and form submits are refused in the page unless
   * their path is in `allow`. It self-tests first (a POST to a non-existent path must be refused) and throws
   * otherwise. Not covered: WebSocket messages, requests a service/shared worker sends itself, and top-level
   * navigations that POST without a form submit event. (Browser-level interception, the old transport-C guard,
   * deadlocks in ego: a request paused by Fetch waits on a page command queued behind it — measured 2026-10-21.)
   */
  async guardWrites(page, { allow = [] } = {}) {
    const set = `window.__bcGuard = { allow: ${JSON.stringify(allow)}, blocked: [] };`;
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: set }, { timeout: 5000 });
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: __bcHook }, { timeout: 5000 });
    await page.evaluate(set + __bcHook);
    const r = await page.evaluate(async () => { try { await fetch('/__bc_guard_selftest', { method: 'POST', body: 'x' }); return 'sent'; } catch (e) { return String(e && e.message || e); } });
    if (!/bc-guard: blocked/.test(r)) throw Object.assign(new Error('guard-self-test failed: ' + r), { code: 'guard-self-test' });
    await page.evaluate(() => { const g = window.__bcGuard; if (g) g.blocked = g.blocked.filter((b) => !/__bc_guard_selftest/.test(b.url)); });
    return { selfTest: 'passed', allow };
  },
  async guardReport(page) {
    const here = await page.evaluate(() => (window.__bcGuard ? { blocked: window.__bcGuard.blocked, allow: window.__bcGuard.allow } : null));
    // A page that moves to another document (a failed login refresh redirecting to /login) starts that document's list
    // empty — the console marks every block leaves are collected too, so what was refused survives the move (10-21).
    await bc.events(page);
    const seen = new Set(); const blocked = [];
    const add = (b) => { if (!b || /__bc_guard_selftest/.test(String(b.url))) return; const key = b.kind + ' ' + b.method + ' ' + b.url; if (!seen.has(key)) { seen.add(key); blocked.push(b); } };
    for (const e of bc.__ev[page.label || 'p1'] || []) {
      if (e.method !== 'Runtime.consoleAPICalled') continue;
      const a = e.params && e.params.args && e.params.args[0];
      const s = a && typeof a.value === 'string' ? a.value : '';
      if (s.startsWith('[bc-guard] blocked ')) { try { add(JSON.parse(s.slice('[bc-guard] blocked '.length))); } catch { /* not ours */ } }
    }
    for (const b of (here && here.blocked) || []) add(b);
    if (!here && !blocked.length) return null;
    return { blocked, allow: here ? here.allow : null };
  },

  /** Run one of the plugin's in-page kits (scripts/kit/*.js), sent along with this script. */
  async kit(page, name) { return page.evaluate(bc.kitSource(name)); },
  /** A kit's source text — e.g. for first-load injection: page.cdp('Page.addScriptToEvaluateOnNewDocument', { source }).
   *  The runner sends only kits named as bc.kit(page, '<name>') or bc.kitSource(page, '<name>'). */
  kitSource(pageOrName, maybeName) {
    const name = maybeName === undefined ? pageOrName : maybeName;
    const src = __bcCfg.kit[name];
    if (!src) throw new Error('kit not sent: ' + name + " (write bc.kit(page, '" + name + "') or bc.kitSource(page, '" + name + "') in the script so the runner includes it)");
    return src;
  },
};
// ---- end of browser_check prelude; the user script follows ----
