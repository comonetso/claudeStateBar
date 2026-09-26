/*
 * dev-diag — 개발 서버 전용 브라우저 진단 기록기 (R5 수정안 · 원본 apps/web/vite/dev-diag.js 기준)
 *
 * R5 수정 요지(각 항목의 재현·검증은 docs/.plan/results/ASIDE-R5.md):
 *  - 가림: 키 이름 **부분 일치** + 값 모양(JWT·Bearer·숫자 인증번호) · 폼/주소/텍스트도 **같은 판정 함수** · summary/prev 주소도 가림
 *  - 대기 요청 수: 링 버퍼와 **분리된 카운터**(넘침·clear() 에 안 흔들림) · XHR send 동기 예외 정리 · Abort 는 'aborted'
 *  - 문제 보관: 소음 링과 **분리**(problems 링 + 첫 로딩 문제 고정 보존) · counts 는 누계
 *  - 응답 본문: content-length ≤ 256KB 일 때만 복제(스트림·큰 응답은 tee 하지 않음 — 앱의 cancel 이 막히던 문제)
 *  - 새 통로: EventSource · BroadcastChannel · sendBeacon · Worker 로드 실패 · 자원 상태(≥400, CSS 배경·폰트·모듈 의존)
 *  - WebSocket: Reflect.construct(상속 클래스 보존) · new 없는 호출은 TypeError · 1005(클라가 닫음)는 정상
 *  - console: assert 실패·trace 기록 · 제한된 미리보기(큰 객체 비용↓, 공유 참조를 순환으로 오표기하지 않음, Map/Set/Event)
 *  - CSP 'inline'/'eval' 원문 유지 · SVG <image href> 주소 · rejectionhandled 로 나중 처리된 거절 제외
 *  - 자원 타이밍 버퍼 250 → 10000
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

  /* ── 비밀 판정(하나의 함수로 JSON·폼·주소·console 전부) ─────────────────── */
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
          /* 잘못된 % 인코딩은 원문으로 판정 */
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
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…(' + s.length + '자)' : s;
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
  // 문제·실패 요청은 소음 링과 따로 보관한다(분류가 늦게 정해지는 요청도 settle 때 다시 부른다)
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

  /* ── 문자열화 · 가림 ─────────────────────────────────────────────────── */

  function preview(v, depth, budget, ancestors) {
    if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
    if (typeof v === 'function') return '[함수 ' + (v.name || '익명') + ']';
    if (typeof v === 'bigint') return String(v) + 'n';
    if (typeof v === 'symbol') return String(v);
    if (v === undefined) return '[undefined]';
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) return v.stack || v.name + ': ' + v.message;
    if (typeof Node === 'function' && v instanceof Node) return '[' + (v.nodeName || 'Node') + ']';
    if (typeof Event === 'function' && v instanceof Event)
      return '[' + v.type + ' 이벤트' + (v.target && v.target.nodeName ? ' ' + v.target.nodeName : '') + ']';
    if (ancestors.indexOf(v) >= 0) return '[순환]';
    if (depth >= 4 || budget.n <= 0) return Array.isArray(v) ? '[배열 ' + v.length + ']' : '[객체 …]';
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
      if (v.length > 30) out.push('…(' + v.length + '개)');
      return out;
    }
    out = {};
    var keys = Object.keys(v);
    for (i = 0; i < Math.min(keys.length, 30); i++) {
      budget.n--;
      try {
        out[keys[i]] = isSecret(keys[i], v[keys[i]]) ? '***' : preview(v[keys[i]], depth + 1, budget, next);
      } catch {
        out[keys[i]] = '[읽기 오류]';
      }
    }
    if (keys.length > 30) out['…'] = keys.length + '개 키';
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
    if (text.length > MAX_BODY_BYTES) return '[본문 생략 ' + text.length + '자]';
    var s = text.trim();
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      try {
        return JSON.stringify(walk(JSON.parse(s)));
      } catch {
        /* JSON 이 아니면 아래로 */
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
      return origin + x.pathname + (x.search ? redactPairs(x.search) : ''); // 🔴 hash 는 버린다(토큰이 흔히 산다)
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
        /* 교차 출처 */
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
      /* 무시 */
    }
    window[name] = Wrapped;
  }

  /* ── 자원 타이밍: 기본 250 상한을 올리고, 실패 상태(≥400)를 기록 ────────── */
  try {
    performance.setResourceTimingBufferSize(10000);
  } catch {
    /* 미지원 */
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
    /* 미지원 */
  }

  /* ── 이전 페이지 기록 ─────────────────────────────────────────────── */
  var prev = null;
  try {
    prev = JSON.parse(sessionStorage.getItem(PREV_KEY) || 'null');
    sessionStorage.removeItem(PREV_KEY);
  } catch {
    /* 저장소 차단 */
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
      /* 용량 초과 */
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
        /* 기록 실패가 앱을 깨지 않게 */
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
          /* 무시 */
        }
      }
      return origAssert.apply(console, arguments);
    };
  }

  /* ── 예외 · 자원 로드 실패 · CSP ──────────────────────────────────── */
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t !== window && t.nodeType === 1) {
        var tag = String(t.tagName).toLowerCase();
        var ev = push('resource-error', { tag: tag, url: redactUrl(t.currentSrc || t.src || t.href || '') });
        if (tag === 'script' && t.type === 'module') ev.hint = '모듈 또는 그 하위 의존 중 하나 — resource-status 에서 404/500 주소를 보라';
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
        reqBody: init && init.body != null ? bodyOf(init.body) : req && req.body ? '[Request 본문]' : undefined,
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
            // 🔴 길이를 모르는 응답(스트림)·큰 응답은 복제하지 않는다 — tee 는 앱이 cancel 해도 끝까지 당긴다
            //    v2.1: content-length: 0 도 "알려진 길이"다 — 길이 미상으로 적지 않는다(Codex D5 잔결함 보정)
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
              ev.resBody = '[본문 생략: ' + (lenHeader !== null ? len + 'B' : '길이 미상(스트림일 수 있음)') + ']';
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
      // v2.1: 실패 원인 구분 — timeout / error(네트워크·CORS) / abort (Codex D5·T3 조각)
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
          /* 읽을 수 없는 응답 */
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
    var wsList = []; // v2.1: 앱 소켓 인스턴스 목록 — __diag.sockets() 로 꺼내 재연결 시험에 쓴다(게터 가로채기 불필요)
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
          var normal = byClient || c.code === 1000 || c.code === 1001; // 앱이 스스로 닫은 것(연결 중 닫기=1006·코드 없음=1005 포함)은 실패가 아니다
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

  /* ── BroadcastChannel(탭 간 통신) ─────────────────────────────────── */
  var OrigBC = window.BroadcastChannel;
  if (typeof OrigBC === 'function') {
    var bcPost = OrigBC.prototype.postMessage;
    OrigBC.prototype.postMessage = function (msg) {
      if (config.bcFrames) {
        try {
          push('bc-send', { name: this.name, data: clip(redactAny(msg)) });
        } catch {
          /* 무시 */
        }
      }
      return bcPost.apply(this, arguments);
    };
    wrapCtor(
      'BroadcastChannel',
      function (name) {
        var bc = construct(OrigBC, [name], new.target);
        // 🔴 message 리스너가 있는 채널은 close 전까지 GC 되지 않는다(스펙) — 앱이 close 없이 버리는 채널이면 이 리스너가 붙잡는다
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
          // 스크립트 안 예외(ErrorEvent)는 window 로 다시 보고되므로 여기선 로드 실패만
          if (!(typeof ErrorEvent === 'function' && e instanceof ErrorEvent && e.message)) {
            note(push('worker-error', { url: u, msg: '워커 스크립트를 불러오지 못함(404·MIME·CSP)' }));
          }
        });
        return w;
      },
      OrigWorker,
    );
  }

  /* ── SPA 화면 이동 ────────────────────────────────────────────────── */
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

  /* ── 읽는 창구 ────────────────────────────────────────────────────── */
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
    // v2.1: 앱이 만든 WebSocket 인스턴스(실제 객체 — copy 하지 않는다). 재연결 시험: sockets()[0].ws.close(3000,'test')
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
        // v2.1: 잘림 표시 — summary 는 앞 10 + 뒤 20 만 보여 준다. 전체는 dump 로(Codex D5·T3)
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
    // 🔴 clear 는 보기 창만 비운다 — 대기 요청 수(inflight)·첫 로딩 문제(firstProblems)는 유지
    clear: function () {
      events.length = 0;
      problems.length = 0;
      failed.length = 0;
    },
  };

  if (/[?&]__diag_selftest(?:[=&#]|$)/.test(location.search)) {
    console.error('[dev-diag] selftest console.error');
    console.warn('[dev-diag] selftest %s', 'console.warn 형식 치환');
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
