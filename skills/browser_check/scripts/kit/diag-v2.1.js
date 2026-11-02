/*
 * dev-diag — a browser diagnostics recorder for development servers only (version 2.1)
 *
 * What this version changed:
 *  - Masking: key names match by **substring** plus value shape (JWT, Bearer, numeric codes) · forms, URLs and text go through **the same test** · summary and previous-page URLs are masked too
 *  - Pending request count: a **separate counter** from the ring buffer (overflow and clear() do not move it) · synchronous XHR send exceptions cleaned up · Abort is 'aborted'
 *  - Problem storage: **separate** from the noise ring (a problems ring, and first-load problems kept for good) · counts are totals
 *  - Response bodies: cloned only when content-length ≤ 256KB (streams and large responses are not teed — that blocked the app's cancel)
 *  - New channels: EventSource · BroadcastChannel · sendBeacon · Worker load failures · resource status (≥400, CSS backgrounds, fonts, module dependencies)
 *  - WebSocket: Reflect.construct (keeps subclasses) · a call without new is a TypeError · 1005 (closed by the client) is normal
 *  - console: assert failures and trace recorded · bounded previews (cheaper on large objects, shared references not mislabelled as cycles, Map/Set/Event)
 *  - CSP 'inline'/'eval' kept verbatim · SVG <image href> URLs · rejections handled later (rejectionhandled) left out
 *  - Resource timing buffer 250 → 10000
 */
(function () {
  'use strict';
  if (window.__diag && window.__diag.version) return;

  var MAX_EVENTS = 2000;
  var MAX_PROBLEMS = 300;
  var KEEP_FIRST_PROBLEMS = 50;
  var MAX_TEXT = 2000;
  var MAX_BODY_BYTES = 256 * 1024;
  var KEEP_ON_UNLOAD = 300;
  var PREV_KEY = '__diag_prev';
  var ID_HEADERS = ['x-request-id', 'x-correlation-id', 'x-trace-id'];

  /* ── Secret test (one function for JSON, forms, URLs and console alike) ─────────────────── */
  var SECRET_NAME =
    /password|passwd|passphrase|^pass$|pwd|secret|token|ticket|otp|api[-_]?key|^key$|authorization|cookie|session[-_]?id|^sid$|jwt|private[-_]?key|credential|signature|x-amz-/i;
  var NOT_SECRET = /(?:_at|At|_length|_ttl(?:_\w+)?|_sec|_ms|_delivery|_count|_hidden)$|^must_|^has_|^is_/;
  var OTP_KEY = /^(?:code|pin|otp|verification_?code|auth_?code|sms_?code)$/i;
  var JWT_RE = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
  var BEARER_RE = /(Bearer\s+)[\w.~+/-]+=*/gi;
  function isSecret(k, v) {
    k = String(k);
    if (NOT_SECRET.test(k)) return false;
    if (OTP_KEY.test(k)) return typeof v === 'string' && /^\s*\d{4,10}\s*$/.test(v);
    if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number') return false;
    return SECRET_NAME.test(k);
  }
  function redactStr(s) {
    return s.replace(JWT_RE, 'eyJ***').replace(BEARER_RE, '$1***');
  }
  function redactPairs(s) {
    return redactStr(
      s.replace(/(^|[?&;\s,])([^=&?;\s,#"']+)=([^&;\s,#"']*)/g, function (m, p, k, v) {
        var key = k;
        var val = v;
        try {
          key = decodeURIComponent(k.replace(/\+/g, ' '));
          val = decodeURIComponent(v.replace(/\+/g, ' '));
        } catch {
          /* A malformed % encoding is tested as written */
        }
        return isSecret(key, val) ? p + k + '=***' : m;
      }),
    );
  }

  var config = { wsFrames: true, bcFrames: true };
  var events = [];
  var problems = [];
  var firstProblems = [];
  var failed = [];
  var totals = {};
  var kept = typeof WeakSet === 'function' ? new WeakSet() : null;
  var seq = 0;
  var dropped = 0;
  var inflight = 0;

  function now() {
    return Math.round(performance.now());
  }
  function clip(s) {
    s = String(s);
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…(' + s.length + ' chars)' : s;
  }
  function copy(x) {
    return JSON.parse(JSON.stringify(x));
  }
  function push(type, data) {
    var e = { seq: ++seq, t: now(), type: type };
    for (var k in data) if (data[k] !== undefined) e[k] = data[k];
    events.push(e);
    totals[type] = (totals[type] || 0) + 1;
    if (events.length > MAX_EVENTS) {
      events.shift();
      dropped++;
    }
    return e;
  }
  function ring(list, e, max) {
    list.push(e);
    if (list.length > max) list.shift();
  }
  // Problems and failed requests are kept apart from the noise ring (a request classified late is called again at settle)
  function note(e) {
    if (kept && kept.has(e)) return e;
    var p = isProblem(e);
    var f = isFailedRequest(e);
    if (!p && !f) return e;
    if (kept) kept.add(e);
    if (p) {
      ring(problems, e, MAX_PROBLEMS);
      if (firstProblems.length < KEEP_FIRST_PROBLEMS) firstProblems.push(e);
    }
    if (f) ring(failed, e, MAX_PROBLEMS);
    return e;
  }

  /* ── Stringify · mask ─────────────────────────────────────────────────── */

  function preview(v, depth, budget, ancestors) {
    if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
    if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (typeof v === 'bigint') return String(v) + 'n';
    if (typeof v === 'symbol') return String(v);
    if (v === undefined) return '[undefined]';
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) return v.stack || v.name + ': ' + v.message;
    if (typeof Node === 'function' && v instanceof Node) return '[' + (v.nodeName || 'Node') + ']';
    if (typeof Event === 'function' && v instanceof Event)
      return '[' + v.type + ' event' + (v.target && v.target.nodeName ? ' ' + v.target.nodeName : '') + ']';
    if (ancestors.indexOf(v) >= 0) return '[circular]';
    if (depth >= 4 || budget.n <= 0) return Array.isArray(v) ? '[array ' + v.length + ']' : '[object …]';
    var next = ancestors.concat([v]);
    var out;
    var i;
    if (typeof Map === 'function' && v instanceof Map) {
      out = { '[Map]': v.size };
      i = 0;
      v.forEach(function (val, key) {
        if (i++ < 20) {
          budget.n--;
          out[String(key)] = isSecret(key, val) ? '***' : preview(val, depth + 1, budget, next);
        }
      });
      return out;
    }
    if (typeof Set === 'function' && v instanceof Set) {
      out = ['[Set ' + v.size + ']'];
      v.forEach(function (val) {
        if (out.length <= 20) {
          budget.n--;
          out.push(preview(val, depth + 1, budget, next));
        }
      });
      return out;
    }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      out = [];
      for (i = 0; i < Math.min(v.length, 30); i++) {
        budget.n--;
        out.push(preview(v[i], depth + 1, budget, next));
      }
      if (v.length > 30) out.push('…(' + v.length + ' items)');
      return out;
    }
    out = {};
    var keys = Object.keys(v);
    for (i = 0; i < Math.min(keys.length, 30); i++) {
      budget.n--;
      try {
        out[keys[i]] = isSecret(keys[i], v[keys[i]]) ? '***' : preview(v[keys[i]], depth + 1, budget, next);
      } catch {
        out[keys[i]] = '[read error]';
      }
    }
    if (keys.length > 30) out['…'] = keys.length + ' keys';
    return out;
  }
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.name + ': ' + v.message;
    try {
      var p = preview(v, 0, { n: 400 }, []);
      return typeof p === 'string' ? p : JSON.stringify(p);
    } catch {
      return String(v);
    }
  }
  function formatArgs(args) {
    var a = Array.prototype.slice.call(args);
    if (typeof a[0] === 'string' && /%[sdifoOc]/.test(a[0])) {
      var i = 1;
      var head = a[0].replace(/%([sdifoOc])/g, function (m, f) {
        if (i >= a.length) return m;
        var v = a[i++];
        if (f === 'c') return '';
        if (f === 'd' || f === 'i') return String(parseInt(v, 10));
        if (f === 'f') return String(parseFloat(v));
        return fmt(v);
      });
      a = [head].concat(a.slice(i));
    }
    return redactStr(a.map(fmt).join(' '));
  }
  function walk(v) {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      var r = {};
      for (var k in v) r[k] = isSecret(k, v[k]) ? '***' : walk(v[k]);
      return r;
    }
    return typeof v === 'string' ? redactStr(v) : v;
  }
  function redact(text) {
    if (typeof text !== 'string') return text;
    if (text.length > MAX_BODY_BYTES) return '[body omitted, ' + text.length + ' chars]';
    var s = text.trim();
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      try {
        return JSON.stringify(walk(JSON.parse(s)));
      } catch {
        /* Not JSON: fall through */
      }
    }
    return redactPairs(text);
  }
  function redactAny(v) {
    return typeof v === 'string' ? redact(v) : fmt(v);
  }
  function bodyOf(b) {
    if (b == null) return undefined;
    if (typeof b === 'string') return clip(redact(b));
    if (typeof URLSearchParams === 'function' && b instanceof URLSearchParams) return clip(redact(b.toString()));
    if (typeof FormData === 'function' && b instanceof FormData) return '[FormData]';
    if (typeof Blob === 'function' && b instanceof Blob) return '[Blob ' + b.size + 'B]';
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return '[binary ' + b.byteLength + 'B]';
    return '[' + Object.prototype.toString.call(b).slice(8, -1) + ']';
  }
  function redactUrl(u, full) {
    var raw = typeof u === 'object' && u && 'baseVal' in u ? u.baseVal : u; // SVGAnimatedString
    try {
      var x = new URL(String(raw), location.href);
      if (x.protocol === 'blob:' || x.protocol === 'data:') return x.protocol + '…';
      var origin = !full && x.origin === location.origin ? '' : x.protocol + '//' + x.host;
      return origin + x.pathname + (x.search ? redactPairs(x.search) : ''); // 🔴 the hash is dropped (tokens often live there)
    } catch {
      return redactPairs(String(raw));
    }
  }
  function requestIdOf(get) {
    for (var i = 0; i < ID_HEADERS.length; i++) {
      try {
        var v = get(ID_HEADERS[i]);
        if (v) return v;
      } catch {
        /* Cross-origin */
      }
    }
    return undefined;
  }
  function readable(ct) {
    return /json|text|xml|javascript|html/i.test(ct || '') && !/event-stream/i.test(ct || '');
  }
  function construct(Orig, args, nt) {
    if (!nt) throw new TypeError("Failed to construct '" + Orig.name + "': Please use the 'new' operator.");
    return Reflect.construct(Orig, args, nt);
  }
  function wrapCtor(name, Wrapped, Orig) {
    Wrapped.prototype = Orig.prototype;
    for (var k in Orig) if (/^[A-Z_]+$/.test(k)) Wrapped[k] = Orig[k];
    try {
      Object.defineProperty(Wrapped, 'name', { value: name });
    } catch {
      /* Ignore */
    }
    window[name] = Wrapped;
  }

  /* ── Resource timing: raise the default limit of 250 and record failed statuses (≥400) ────────── */
  try {
    performance.setResourceTimingBufferSize(10000);
  } catch {
    /* Not supported */
  }
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (r) {
        if (r.responseStatus >= 400 && r.initiatorType !== 'fetch' && r.initiatorType !== 'xmlhttprequest') {
          note(push('resource-status', { status: r.responseStatus, kind: r.initiatorType, url: redactUrl(r.name) }));
        }
      });
    }).observe({ type: 'resource', buffered: true });
  } catch {
    /* Not supported */
  }

  /* ── Previous-page record ───────────────────────────────────────────── */
  var prev = null;
  try {
    prev = JSON.parse(sessionStorage.getItem(PREV_KEY) || 'null');
    sessionStorage.removeItem(PREV_KEY);
  } catch {
    /* Storage blocked */
  }
  window.addEventListener('pagehide', function () {
    try {
      sessionStorage.setItem(
        PREV_KEY,
        JSON.stringify({
          url: redactUrl(location.href, true),
          at: new Date().toISOString(),
          firstProblems: firstProblems,
          events: events.slice(-KEEP_ON_UNLOAD),
        }),
      );
    } catch {
      /* Over quota */
    }
  });

  /* ── console ──────────────────────────────────────────────────────── */
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      try {
        note(push('console', { level: level, msg: clip(formatArgs(arguments)) }));
      } catch {
        /* So a failed record never breaks the app */
      }
      return orig.apply(console, arguments);
    };
  });
  var origAssert = console.assert;
  if (typeof origAssert === 'function') {
    console.assert = function (cond) {
      if (!cond) {
        try {
          note(push('console', { level: 'error', msg: clip('Assertion failed: ' + formatArgs(Array.prototype.slice.call(arguments, 1))) }));
        } catch {
          /* Ignore */
        }
      }
      return origAssert.apply(console, arguments);
    };
  }

  /* ── Exceptions · resource load failures · CSP ────────────────────────────────── */
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t !== window && t.nodeType === 1) {
        var tag = String(t.tagName).toLowerCase();
        var ev = push('resource-error', { tag: tag, url: redactUrl(t.currentSrc || t.src || t.href || '') });
        if (tag === 'script' && t.type === 'module') ev.hint = 'the module or one of its dependencies — find the 404/500 URL in resource-status';
        note(ev);
        return;
      }
      note(
        push('error', {
          msg: clip(e.message),
          src: e.filename ? redactUrl(e.filename) : undefined,
          line: e.lineno,
          col: e.colno,
          stack: e.error && e.error.stack ? clip(e.error.stack) : undefined,
        }),
      );
    },
    true,
  );
  var rejections = typeof WeakMap === 'function' ? new WeakMap() : null;
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var ev = note(push('rejection', { msg: clip(r && r.stack ? r.stack : fmt(r)) }));
    if (rejections && e.promise) rejections.set(e.promise, ev);
  });
  window.addEventListener('rejectionhandled', function (e) {
    var ev = rejections && e.promise ? rejections.get(e.promise) : null;
    if (ev) ev.handledLater = true;
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    var raw = e.blockedURI || '';
    note(
      push('csp', {
        directive: e.violatedDirective,
        blocked: /^(?:inline|eval|wasm-eval|trusted-types-[\w-]+|data|blob|self)$/.test(raw) ? raw : redactUrl(raw),
        src: e.sourceFile ? redactUrl(e.sourceFile) : undefined,
        line: e.lineNumber || undefined,
      }),
    );
  });

  /* ── fetch ────────────────────────────────────────────────────────── */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var req = typeof Request === 'function' && input instanceof Request ? input : null;
      var method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
      var url = req ? req.url : String(input);
      var start = now();
      var ev = push('fetch', {
        method: method,
        url: redactUrl(url),
        phase: 'pending',
        reqBody: init && init.body != null ? bodyOf(init.body) : req && req.body ? '[Request body]' : undefined,
      });
      var open = true;
      inflight++;
      function settle() {
        if (open) {
          open = false;
          inflight--;
        }
      }
      var p;
      try {
        p = origFetch.apply(this, arguments);
      } catch (err) {
        settle();
        ev.phase = 'failed';
        ev.err = clip(fmt(err));
        note(ev);
        throw err;
      }
      return p.then(
        function (res) {
          settle();
          ev.phase = 'done';
          ev.status = res.status;
          ev.ok = res.ok;
          ev.ms = now() - start;
          ev.rid = requestIdOf(function (h) {
            return res.headers.get(h);
          });
          note(ev);
          var ct = res.headers.get('content-type');
          if (readable(ct)) {
            var lenHeader = res.headers.get('content-length');
            var len = Number(lenHeader);
            // 🔴 Responses of unknown length (streams) and large ones are not cloned — tee keeps pulling even after the app cancels
            //    v2.1: content-length: 0 is a known length too — not recorded as unknown
            if (lenHeader !== null && len <= MAX_BODY_BYTES) {
              res
                .clone()
                .text()
                .then(
                  function (txt) {
                    ev.resBody = clip(redact(txt));
                  },
                  function () {},
                );
            } else {
              ev.resBody = '[body omitted: ' + (lenHeader !== null ? len + 'B' : 'unknown length (may be a stream)') + ']';
            }
          }
          return res;
        },
        function (err) {
          settle();
          ev.phase = err && err.name === 'AbortError' ? 'aborted' : 'failed';
          ev.err = clip(fmt(err));
          ev.ms = now() - start;
          note(ev);
          throw err;
        },
      );
    };
  }

  /* ── XMLHttpRequest ───────────────────────────────────────────────── */
  if (typeof XMLHttpRequest === 'function') {
    var xOpen = XMLHttpRequest.prototype.open;
    var xSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__diag = { method: String(method).toUpperCase(), url: redactUrl(url) };
      return xOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      var d = xhr.__diag || {};
      var start = now();
      var ev = push('xhr', { method: d.method, url: d.url, phase: 'pending', reqBody: bodyOf(body) });
      var open = true;
      var aborted = false;
      function settle() {
        if (open) {
          open = false;
          inflight--;
        }
      }
      inflight++;
      // v2.1: failure cause told apart — timeout / error (network, CORS) / abort
      xhr.addEventListener('abort', function () {
        aborted = true;
        ev.reason = 'abort';
      });
      xhr.addEventListener('timeout', function () {
        ev.reason = 'timeout';
      });
      xhr.addEventListener('error', function () {
        ev.reason = ev.reason || 'error';
      });
      xhr.addEventListener('loadend', function () {
        settle();
        ev.phase = xhr.status ? 'done' : aborted ? 'aborted' : 'failed';
        ev.status = xhr.status;
        ev.ok = xhr.status >= 200 && xhr.status < 300;
        ev.ms = now() - start;
        ev.rid = requestIdOf(function (h) {
          return xhr.getResponseHeader(h);
        });
        try {
          if ((xhr.responseType === '' || xhr.responseType === 'text') && readable(xhr.getResponseHeader('content-type'))) {
            ev.resBody = clip(redact(xhr.responseText));
          }
        } catch {
          /* Unreadable response */
        }
        note(ev);
      });
      try {
        return xSend.apply(this, arguments);
      } catch (err) {
        settle();
        ev.phase = 'failed';
        ev.err = clip(fmt(err));
        note(ev);
        throw err;
      }
    };
  }

  /* ── WebSocket ────────────────────────────────────────────────────── */
  var OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    var wsSeq = 0;
    var wsList = []; // v2.1: the app's socket instances — __diag.sockets() returns them for reconnect tests (no getter interception needed)
    wrapCtor(
      'WebSocket',
      function (url, protocols) {
        var ws = construct(OrigWS, protocols === undefined ? [url] : [url, protocols], new.target);
        var list = [].concat(protocols || []);
        if (list.indexOf('vite-hmr') >= 0 || list.indexOf('vite-ping') >= 0) return ws;
        var id = ++wsSeq;
        var byClient = false;
        wsList.push({ id: id, ws: ws });
        if (wsList.length > 20) wsList.shift();
        push('ws-open', { id: id, url: redactUrl(url), phase: 'connecting' });
        ws.addEventListener('open', function () {
          push('ws-state', { id: id, state: 'open' });
        });
        ws.addEventListener('message', function (m) {
          if (!config.wsFrames) return;
          var data = m.data;
          push('ws-recv', { id: id, data: typeof data === 'string' ? clip(redact(data)) : '[binary ' + (data.byteLength || data.size || 0) + 'B]' });
        });
        ws.addEventListener('close', function (c) {
          var normal = byClient || c.code === 1000 || c.code === 1001; // the app closing a socket itself is not a failure (closing while connecting = 1006 and no code = 1005 included)
          note(push('ws-close', { id: id, code: c.code, reason: c.reason || undefined, clean: c.wasClean, byClient: byClient || undefined, abnormal: !normal || undefined }));
        });
        ws.addEventListener('error', function () {
          note(push('ws-error', { id: id }));
        });
        var send = ws.send;
        ws.send = function (data) {
          if (config.wsFrames)
            push('ws-send', { id: id, data: typeof data === 'string' ? clip(redact(data)) : '[binary ' + (data.byteLength || data.size || 0) + 'B]' });
          return send.apply(ws, arguments);
        };
        var close = ws.close;
        ws.close = function () {
          byClient = true;
          return close.apply(ws, arguments);
        };
        return ws;
      },
      OrigWS,
    );
  }

  /* ── EventSource(SSE) ─────────────────────────────────────────────── */
  var OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    var esSeq = 0;
    wrapCtor(
      'EventSource',
      function (url, opts) {
        var es = construct(OrigES, opts === undefined ? [url] : [url, opts], new.target);
        var id = ++esSeq;
        push('sse-open', { id: id, url: redactUrl(url) });
        es.addEventListener('open', function () {
          push('sse-state', { id: id, state: 'open' });
        });
        es.addEventListener('error', function () {
          note(push('sse-error', { id: id, readyState: es.readyState }));
        });
        return es;
      },
      OrigES,
    );
  }

  /* ── BroadcastChannel (messages between tabs) ───────────────────────────────── */
  var OrigBC = window.BroadcastChannel;
  if (typeof OrigBC === 'function') {
    var bcPost = OrigBC.prototype.postMessage;
    OrigBC.prototype.postMessage = function (msg) {
      if (config.bcFrames) {
        try {
          push('bc-send', { name: this.name, data: clip(redactAny(msg)) });
        } catch {
          /* Ignore */
        }
      }
      return bcPost.apply(this, arguments);
    };
    wrapCtor(
      'BroadcastChannel',
      function (name) {
        var bc = construct(OrigBC, [name], new.target);
        // 🔴 A channel with a message listener is not garbage-collected until close (by the spec) — if the app drops a channel without closing it, this listener keeps it alive
        bc.addEventListener('message', function (m) {
          if (config.bcFrames) push('bc-recv', { name: bc.name, data: clip(redactAny(m.data)) });
        });
        return bc;
      },
      OrigBC,
    );
  }

  /* ── sendBeacon · Worker ──────────────────────────────────────────── */
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      var ok = origBeacon.apply(navigator, arguments);
      push('beacon', { url: redactUrl(url), body: bodyOf(data), queued: ok });
      return ok;
    };
  }
  var OrigWorker = window.Worker;
  if (typeof OrigWorker === 'function') {
    wrapCtor(
      'Worker',
      function (url, opts) {
        var w = construct(OrigWorker, opts === undefined ? [url] : [url, opts], new.target);
        var u = redactUrl(url);
        w.addEventListener('error', function (e) {
          // Exceptions inside a script (ErrorEvent) are reported again on window, so only load failures here
          if (!(typeof ErrorEvent === 'function' && e instanceof ErrorEvent && e.message)) {
            note(push('worker-error', { url: u, msg: 'worker script failed to load (404, MIME or CSP)' }));
          }
        });
        return w;
      },
      OrigWorker,
    );
  }

  /* ── SPA navigation ──────────────────────────────────────────────── */
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      push('nav', { how: k, url: redactUrl(location.href) });
      return r;
    };
  });
  window.addEventListener('popstate', function () {
    push('nav', { how: 'popstate', url: redactUrl(location.href) });
  });

  /* ── Read API ──────────────────────────────────────────────────── */
  function isProblem(e) {
    return (
      e.type === 'error' ||
      (e.type === 'rejection' && !e.handledLater) ||
      e.type === 'resource-error' ||
      e.type === 'resource-status' ||
      e.type === 'csp' ||
      e.type === 'ws-error' ||
      e.type === 'sse-error' ||
      e.type === 'worker-error' ||
      (e.type === 'console' && (e.level === 'error' || e.level === 'warn'))
    );
  }
  function isFailedRequest(e) {
    if (e.type === 'fetch' || e.type === 'xhr') return e.phase === 'failed' || (e.status !== undefined && e.status >= 400);
    return e.type === 'ws-close' && !!e.abnormal;
  }

  window.__diag = {
    version: 2.1,
    startedAt: new Date(performance.timeOrigin || Date.now()).toISOString(),
    config: config,
    prev: prev,
    mark: function (label) {
      return push('mark', { label: String(label) }).seq;
    },
    dump: function (opts) {
      var o = opts || {};
      var since = o.since || 0;
      var types = o.types || null;
      var list = events.filter(function (e) {
        return e.seq > since && (!types || types.indexOf(e.type) >= 0);
      });
      return copy(o.limit ? list.slice(-o.limit) : list);
    },
    // v2.1: WebSocket instances the app created (the real objects — not copied). Reconnect test: sockets()[0].ws.close(3000,'test')
    sockets: function () {
      return (typeof wsList !== 'undefined' ? wsList : []).map(function (x) {
        return { id: x.id, ws: x.ws, readyState: x.ws.readyState, url: redactUrl(x.ws.url) };
      });
    },
    summary: function () {
      var problemCount = problems.filter(isProblem).length;
      return copy({
        url: redactUrl(location.href, true),
        lastSeq: seq,
        kept: events.length,
        dropped: dropped,
        counts: totals,
        pendingRequests: inflight,
        // v2.1: truncation marker — summary shows only the first 10 and the last 20. Everything is in dump
        problemCount: problemCount,
        truncated: problemCount > 30,
        firstProblems: firstProblems.filter(isProblem).slice(0, 10),
        problems: problems.filter(isProblem).slice(-20),
        failedRequests: failed.slice(-20),
        prevPage: prev
          ? { url: prev.url, at: prev.at, problems: (prev.firstProblems || []).concat(prev.events || []).filter(isProblem).slice(-10) }
          : null,
      });
    },
    // 🔴 clear empties the view only — the pending request count (inflight) and the first-load problems (firstProblems) stay
    clear: function () {
      events.length = 0;
      problems.length = 0;
      failed.length = 0;
    },
  };

  if (/[?&]__diag_selftest(?:[=&#]|$)/.test(location.search)) {
    console.error('[dev-diag] selftest console.error');
    console.warn('[dev-diag] selftest %s', 'console.warn format substitution');
    setTimeout(function () {
      throw new Error('[dev-diag] selftest uncaught');
    }, 0);
    Promise.reject(new Error('[dev-diag] selftest rejection'));
    window.fetch('https://dev-diag-selftest.invalid/').catch(function () {});
    document.addEventListener('DOMContentLoaded', function () {
      var img = document.createElement('img');
      img.alt = '';
      img.hidden = true;
      img.src = '/__dev_diag_selftest_missing.png';
      document.body.appendChild(img);
    });
  }
})();
