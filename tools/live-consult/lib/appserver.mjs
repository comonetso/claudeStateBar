//
// lib/appserver.mjs — codex app-server 기동 + WebSocket JSON-RPC 클라이언트
//
// 이 모듈이 지는 책임은 **배관뿐**이다. codex_rescue 의 도메인 규칙(CONSULT/REVIEW/EDIT 구분,
// 프롬프트 조립, 응답 파일 배치, steer 정책)은 여기 들어오지 않는다. 프로토콜이 바뀌었을 때
// 고칠 곳을 한 군데로 묶어 두려는 것이다.
//
// ── 여기 박힌 사실들은 전부 2026-08-25 실측에서 왔다 (추측 아님) ─────────────────────
// 원문 로그: %TEMP%\codex-steer-fixture\2026-08-25T12-11-27-190Z\rpc.jsonl
// 검증 스크립트: tools/steer-fixture/steer-fixture.mjs (10항목 중 9 통과)
//
//  · 기동: `codex app-server --listen ws://127.0.0.1:<port> -c windows.sandbox=unelevated`
//  · 🔴 Windows 에서 **다중 연결의 유일한 경로가 ws** 다. unix:// 는 안 되고 stdio:// 는
//    두 번째 연결 자체가 불가능하다. steer 를 별도 연결에서 쏘려면 ws 여야 한다.
//  · 전송은 NDJSON. LSP 식 `Content-Length` 헤더가 **없다**. `jsonrpc:"2.0"` 필드도
//    주고받은 적이 없다(서버 응답에도 없다) — 실측 형식을 그대로 따른다.
//  · 핸드셰이크: `{id:0, method:'initialize', params:{clientInfo:{name,version}}}` 응답을 받은 뒤
//    `{method:'initialized', params:{}}`(id 없음)를 보내야 다음 요청이 먹는다.
//  · 🔴 알림은 **턴을 시작한 연결에만** 간다. steer 를 보낸 conn2 는 turn/started 를 0개 받았다.
//    → 진행 상황을 보려면 turn/start 를 쏜 그 Conn 에서 onNotification 을 걸어야 한다.
//  · 알림 메시지는 `emittedAtMs` 를 params **바깥** 최상위에 달고 온다.
//  · 에러 응답 형식: `{"error":{"code":-32600,"message":"no active turn to steer"},"id":2}`
//    → code 를 보존해야 "완료된 턴에 steer" 를 판별할 수 있다. RpcError.code 로 살려 둔다.
//  · stderr 는 계정 정보가 섞일 수 있어 **통째로 버린다**(실측 779바이트 나왔다). 바이트 수만 센다.
//  · 프로세스 트리 종료는 Windows 에서 `taskkill /T /F`. MSYS `kill` 은 네이티브 손자에 안 닿는다.
//
import cp from 'node:child_process';
import net from 'node:net';

const IS_WIN = process.platform === 'win32';

// ══════════════════════════════════════════════════════════════════════════
// 상수 — 값의 출처를 전부 남긴다. 출처 없는 숫자는 여기 두지 않는다.
// ══════════════════════════════════════════════════════════════════════════

// ws 리슨이 열릴 때까지 재시도하는 상한/간격. steer-fixture 가 이 값으로 실제로 붙었다
// (DEFAULTS.wsReadyTimeout=20초, wsRetryMs=200). 옵션으로 덮어쓸 수 있다.
const WS_READY_TIMEOUT_MS = 20000;
const WS_RETRY_INTERVAL_MS = 200;
// 재시도 1회당 상한. fixture 의 connectWs(url, 2000) 과 같다.
const WS_ATTEMPT_TIMEOUT_MS = 2000;

// Windows 샌드박스 구현 방식. skills/codex_rescue/send.sh 514행 `CR_WIN_SANDBOX-unelevated`
// 와 같은 기본값이다. 빈 문자열이면 `-c` 를 아예 붙이지 않아 config.toml 값을 쓴다.
const WIN_SANDBOX_DEFAULT = 'unelevated';

// ══════════════════════════════════════════════════════════════════════════
// 에러 타입 — "조용히 hang" 대신 무엇이 어디서 틀어졌는지 남긴다
// ══════════════════════════════════════════════════════════════════════════

/** 서버가 JSON-RPC error 를 돌려준 경우. code/message/data 를 그대로 보존한다. */
export class RpcError extends Error {
    constructor(code, message, data, method) {
        super(`JSON-RPC 에러 (${method || '?'}): ${message} [code=${code}]`);
        this.name = 'RpcError';
        this.code = code;
        this.rpcMessage = message;
        this.data = data;
        this.method = method;
    }
}

/** 프로세스 기동·연결·타임아웃 등 배관 쪽 실패. */
export class AppServerError extends Error {
    constructor(message, extra) {
        super(message);
        this.name = 'AppServerError';
        if (extra) Object.assign(this, extra);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 좀비 방지 — 이 모듈이 띄운 프로세스는 어떤 경로로 끝나든 반드시 죽인다
// ══════════════════════════════════════════════════════════════════════════
//
// 🔴 2026-08-25 이 프로젝트에서 실제로 codex.exe 가 살아남아 작업관리자로 죽여야 했다.
//    그래서 라이브러리 주제에 process 훅을 건다. 좀비를 남기는 쪽이 더 나쁘다.
//
const LIVE_SERVERS = new Set();
// 🔴 두 플래그를 따로 둔다. 하나로 합치면 "먼저 만들어진 서버가 시그널 핸들러를 껐다"는 이유로
//    나중 서버까지 무방비가 된다 — 좀비 사고가 재현되는 정확한 경로다.
let exitHookInstalled = false;
let signalHooksInstalled = false;

function installExitGuard(withSignals) {
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        // 'exit' 은 동기 훅이라 execFileSync 밖에 못 쓴다. taskkill 이 동기인 이유가 이것이다.
        process.on('exit', () => { for (const s of [...LIVE_SERVERS]) s._killSync(); });
    }
    if (!withSignals || signalHooksInstalled) return;
    signalHooksInstalled = true;
    // 시그널에 리스너가 없으면 Node 는 프로세스를 즉시 끝내고 'exit' 훅을 돌리지 않는다.
    // → Ctrl+C 한 번에 좀비가 남는다. 그래서 직접 잡고 기본 동작(128+signo)을 흉내낸다.
    const SIGNOS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
    for (const sig of Object.keys(SIGNOS)) {
        process.on(sig, () => {
            for (const s of [...LIVE_SERVERS]) s._killSync();
            process.exit(128 + SIGNOS[sig]);
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════════════════════════════════

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// logSink 가 터져도 배관이 멈추면 안 된다. 삼킨다.
//
// ⚠️ logSink 의 시그니처는 모듈 간 계약에 없었다. 이쪽은 **구조화된 객체**를 넘긴다
//    (`{kind, ...}`) — 그래야 호출자가 kind 로 걸러 감사 로그를 만들 수 있다.
//    그런데 호출부가 "문자열 한 줄"로 가정하고 `String(rec)` 을 하면 `[object Object]` 만
//    남아 로그가 통째로 무의미해진다. 실제로 live-consult.mjs 가 그렇게 가정하고 있어
//    레코드에 열거 불가 toString 을 달아 둔다. JSON.stringify 결과에는 섞이지 않으므로
//    객체로 쓰는 쪽도 그대로 동작한다. 양쪽 가정을 모두 살리기 위한 것이다.
function emit(logSink, rec) {
    if (typeof logSink !== 'function') return;
    try {
        Object.defineProperty(rec, 'toString', {
            value: function () { try { return JSON.stringify(this); } catch { return '[unserializable log record]'; } },
            enumerable: false
        });
    } catch { /* 프리즈된 객체면 그냥 넘어간다 */ }
    try { logSink(rec); } catch { /* 로깅 실패는 무시 */ }
}

// Windows 에서 shell:true 로 띄우면 Node 가 인자를 공백으로 이어 붙여 cmd 에 넘긴다.
// 경로에 공백이 있으면 거기서 깨지므로 우리가 먼저 인용한다. (fixture 288행과 같은 처리)
function quoteForShell(a) {
    if (!IS_WIN) return String(a);
    return /[\s"^&|<>()]/.test(String(a)) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a);
}

/**
 * 비어 있는 loopback 포트를 하나 잡아 돌려준다.
 * 🔴 고정 포트는 충돌한다. 그리고 0.0.0.0 이 아니라 127.0.0.1 로만 확인한다 —
 *    "비어 있다"의 기준이 외부 인터페이스가 되면 실제 리슨과 어긋날 수 있다.
 * 잡았다 놓는 사이에 남이 채갈 수 있는 경합이 이론적으로 남지만, 임시 포트 범위에서는
 * 이게 표준적인 방법이고 실패하면 connect 단계에서 명확한 에러로 드러난다.
 */
export function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', (e) => reject(new AppServerError(`빈 포트를 잡지 못했다: ${e.message}`)));
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = addr && typeof addr === 'object' ? addr.port : null;
            srv.close((err) => {
                if (err) reject(new AppServerError(`포트 탐색용 소켓을 닫지 못했다: ${err.message}`));
                else if (!port) reject(new AppServerError('포트 번호를 읽지 못했다'));
                else resolve(port);
            });
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════
// Conn — ws 연결 하나에 얹은 JSON-RPC 클라이언트
// ══════════════════════════════════════════════════════════════════════════

export class Conn {
    /**
     * 직접 만들지 말고 `AppServer.connect()` 또는 `connectRpc()` 를 써라.
     * @param {WebSocket} ws 이미 open 된 소켓
     */
    constructor(ws, opts = {}) {
        this.ws = ws;
        this.name = opts.name || 'conn';
        this.logSink = opts.logSink;
        // 🔴 기본 타임아웃을 여기서 지어내지 않는다. 호출자가 startAppServer/connect 에서
        //    넘기거나 request 마다 넘겨야 한다. 둘 다 없으면 request 가 즉시 에러를 낸다.
        this.defaultRequestTimeoutMs = opts.defaultRequestTimeoutMs;

        this._nextId = 0;
        this._pending = new Map();          // id → {resolve, reject, timer, method}
        this._notificationHandlers = [];
        this._serverRequestHandlers = [];
        this._closeHandlers = [];
        this._buf = '';
        this._closed = false;
        this._closeReason = null;
        /** 아무도 받지 않은 서버 요청. 남아 있으면 그 턴은 영원히 안 끝난다. */
        this.unhandledServerRequests = [];

        ws.addEventListener('message', (ev) => {
            const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
            this._ingest(data);
        });
        ws.addEventListener('close', (ev) => this._onClosed(`ws close (code=${ev && ev.code})`));
        ws.addEventListener('error', () => this._onClosed('ws error'));
    }

    get isOpen() { return !this._closed; }
    get closeReason() { return this._closeReason; }

    // ── 수신 ──────────────────────────────────────────────────────────
    //
    // ws 프레임 하나가 통째로 JSON 일 수도, 여러 줄이 붙어 올 수도, 반쪽만 올 수도 있다.
    // fixture 에서 검증된 처리를 그대로 옮겼다: 먼저 "한 덩어리 JSON" 을 시도하고,
    // 아니면 줄 단위 버퍼링으로 넘긴다.
    _ingest(text) {
        const whole = text.trim();
        if (whole && this._buf === '' && whole.indexOf('\n') < 0) {
            try {
                const msg = JSON.parse(whole);
                emit(this.logSink, { kind: 'rpc-recv', conn: this.name, raw: whole });
                this._route(msg);
                return;
            } catch { /* 조각이다 — 아래 줄 단위 처리로 */ }
        }
        this._buf += text;
        let i;
        while ((i = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, i).trim();
            this._buf = this._buf.slice(i + 1);
            if (!line) continue;
            emit(this.logSink, { kind: 'rpc-recv', conn: this.name, raw: line });
            let msg;
            try { msg = JSON.parse(line); }
            catch { emit(this.logSink, { kind: 'warn', conn: this.name, message: 'JSON 파싱 실패', raw: line.slice(0, 400) }); continue; }
            this._route(msg);
        }
    }

    _route(msg) {
        // id 는 0 일 수 있으므로 falsy 검사를 쓰면 안 된다 (initialize 가 id=0 이다).
        const hasId = msg && msg.id !== undefined && msg.id !== null;
        const hasMethod = msg && msg.method !== undefined;

        if (hasId && !hasMethod) { this._resolveResponse(msg); return; }

        if (hasId && hasMethod) {
            // 서버 → 클라이언트 **요청**. 승인 요청류가 여기로 온다:
            //   item/commandExecution/requestApproval · item/fileChange/requestApproval
            //   item/permissions/requestApproval     · mcpServer/elicitation/request
            //
            // 🔴🔴 응답하지 않으면 그 턴은 **영구 대기**한다. 모델은 승인 답을 기다리며 멈추고,
            //      turn/completed 는 영영 오지 않는다. onServerRequest 를 반드시 걸고
            //      respond()/respondError() 로 답해라. approvalPolicy='never' 로 시작하면
            //      원칙적으로 오지 않지만, 그 전제에 목숨을 걸지 마라(MCP elicitation 은 별개다).
            const req = { id: msg.id, method: msg.method, params: msg.params || {} };
            if (this._serverRequestHandlers.length === 0) {
                this.unhandledServerRequests.push(req);
                emit(this.logSink, {
                    kind: 'warn', conn: this.name,
                    message: `🔴 서버 요청 ${msg.method} 을(를) 받을 핸들러가 없다 — 응답하지 않으면 턴이 영구 대기한다`,
                    id: msg.id
                });
                return;
            }
            for (const fn of this._serverRequestHandlers) {
                try { fn(req); }
                catch (e) { emit(this.logSink, { kind: 'warn', conn: this.name, message: `onServerRequest 핸들러 예외: ${e && e.message}` }); }
            }
            return;
        }

        if (hasMethod) {
            // 알림. emittedAtMs 는 params 바깥에 온다(실측) — 버리지 않고 같이 넘긴다.
            const note = { method: msg.method, params: msg.params || {}, emittedAtMs: msg.emittedAtMs };
            for (const fn of this._notificationHandlers) {
                try { fn(note); }
                catch (e) { emit(this.logSink, { kind: 'warn', conn: this.name, message: `onNotification 핸들러 예외: ${e && e.message}` }); }
            }
            return;
        }

        emit(this.logSink, { kind: 'warn', conn: this.name, message: '해석 불가 메시지', raw: JSON.stringify(msg).slice(0, 400) });
    }

    _resolveResponse(msg) {
        const p = this._pending.get(msg.id);
        if (!p) {
            // 타임아웃으로 이미 버린 요청의 늦은 응답. 버리되 사실은 남긴다.
            emit(this.logSink, { kind: 'warn', conn: this.name, message: `모르는 id 의 응답 ${msg.id} (타임아웃 뒤 도착했을 가능성)` });
            return;
        }
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
            const e = msg.error;
            p.reject(new RpcError(e.code, e.message, e.data, p.method));
        } else {
            p.resolve(msg.result);
        }
    }

    _onClosed(reason) {
        if (this._closed) return;
        this._closed = true;
        this._closeReason = reason;
        // 🔴 대기 중인 요청을 그냥 두면 호출자가 영원히 await 한다. 전부 깨운다.
        for (const [, p] of this._pending) {
            clearTimeout(p.timer);
            p.reject(new AppServerError(`${this.name} 연결이 끊겼다 (${reason}) — 요청 ${p.method} 이(가) 미완으로 끝났다`, { connClosed: true }));
        }
        this._pending.clear();
        emit(this.logSink, { kind: 'conn-close', conn: this.name, reason });
        for (const fn of this._closeHandlers) {
            try { fn({ reason }); } catch { /* 무시 */ }
        }
    }

    // ── 송신 ──────────────────────────────────────────────────────────

    _send(obj) {
        const raw = JSON.stringify(obj);
        // ⚠️ raw 에는 프롬프트 전문이 실린다. logSink 를 파일에 붙일 때 어디에 쓰는지 신경 써라.
        emit(this.logSink, { kind: 'rpc-send', conn: this.name, raw });
        try {
            // 실측에서 개행 없이 프레임 하나에 JSON 하나로 보냈고 그대로 동작했다.
            // ws 는 프레임 경계가 있으므로 NDJSON 의 개행이 필요 없다.
            this.ws.send(raw);
        } catch (e) {
            throw new AppServerError(`${this.name} 전송 실패: ${e && e.message}`);
        }
    }

    /**
     * 요청을 보내고 result 를 돌려준다. 서버가 error 를 주면 RpcError 를 throw 한다.
     * @param {string} method
     * @param {object} params
     * @param {{timeoutMs?: number}} [opts] timeoutMs 는 여기서든 생성 시점에서든 **반드시** 와야 한다.
     */
    request(method, params, opts = {}) {
        const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : this.defaultRequestTimeoutMs;
        // 🔴 상한 없는 대기는 조용한 hang 이 된다. 지어낸 기본값을 넣는 대신 대놓고 실패시킨다.
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return Promise.reject(new AppServerError(
                `request('${method}') 에 timeoutMs 가 없다. ` +
                `호출부에서 request(m, p, {timeoutMs}) 로 주거나 ` +
                `startAppServer({defaultRequestTimeoutMs}) / connect({defaultRequestTimeoutMs}) 로 정해라. ` +
                `기본값을 임의로 정하지 않는다.`
            ));
        }
        if (this._closed) {
            return Promise.reject(new AppServerError(`${this.name} 이(가) 이미 닫혔다 (${this._closeReason}) — ${method} 를 보낼 수 없다`));
        }

        const id = this._nextId++;
        const sentAt = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new AppServerError(
                    `${method} 응답이 ${timeoutMs}ms 안에 오지 않았다 (id=${id})`,
                    { timedOut: true, method, timeoutMs }
                ));
            }, timeoutMs);
            this._pending.set(id, {
                method,
                resolve: (v) => { resolve(v); emit(this.logSink, { kind: 'rpc-roundtrip', conn: this.name, method, ms: Date.now() - sentAt, ok: true }); },
                reject: (e) => { reject(e); emit(this.logSink, { kind: 'rpc-roundtrip', conn: this.name, method, ms: Date.now() - sentAt, ok: false }); },
                timer
            });
            try {
                this._send({ id, method, params: params === undefined ? {} : params });
            } catch (e) {
                this._pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    /** 응답이 없는 알림. `initialized` 처럼 id 를 붙이면 안 되는 것에 쓴다. */
    notify(method, params) {
        if (this._closed) {
            emit(this.logSink, { kind: 'warn', conn: this.name, message: `닫힌 연결에 notify(${method}) — 버린다` });
            return;
        }
        this._send({ method, params: params === undefined ? {} : params });
    }

    /** 알림 수신 콜백. fn({method, params, emittedAtMs}) */
    onNotification(fn) { this._notificationHandlers.push(fn); }

    /**
     * 서버 → 클라이언트 요청 수신 콜백. fn({id, method, params})
     * 🔴 콜백 안에서 **반드시** respond() 또는 respondError() 를 불러라. 안 부르면 턴이 영구 대기한다.
     */
    onServerRequest(fn) {
        this._serverRequestHandlers.push(fn);
        // 핸들러가 늦게 붙었는데 그 사이 요청이 쌓였다면 지금 흘려준다 —
        // 안 그러면 그 요청들은 영원히 답을 못 받는다.
        if (this.unhandledServerRequests.length > 0) {
            const backlog = this.unhandledServerRequests.splice(0);
            for (const req of backlog) {
                try { fn(req); }
                catch (e) { emit(this.logSink, { kind: 'warn', conn: this.name, message: `밀린 서버 요청 처리 중 예외: ${e && e.message}` }); }
            }
        }
    }

    /** 연결이 끊길 때 호출된다. fn({reason}) */
    onClose(fn) {
        this._closeHandlers.push(fn);
        if (this._closed) { try { fn({ reason: this._closeReason }); } catch { /* 무시 */ } }
    }

    /** 서버 요청에 성공 응답. 실측 형식: {id, result} */
    respond(id, result) {
        if (this._closed) {
            emit(this.logSink, { kind: 'warn', conn: this.name, message: `닫힌 연결에 respond(${id}) — 서버 쪽 턴이 멈춰 있을 수 있다` });
            return;
        }
        this._send({ id, result: result === undefined ? {} : result });
    }

    /** 서버 요청에 에러 응답. 실측 형식: {id, error:{code,message}} */
    respondError(id, code, message) {
        if (this._closed) {
            emit(this.logSink, { kind: 'warn', conn: this.name, message: `닫힌 연결에 respondError(${id}) — 서버 쪽 턴이 멈춰 있을 수 있다` });
            return;
        }
        this._send({ id, error: { code, message: String(message) } });
    }

    /**
     * 편의 메서드 — initialize → initialized 순서를 대신 지켜 준다.
     * 이 순서를 놓치면 뒤 요청이 먹지 않는다(실측). 직접 request('initialize') 를 써도 된다.
     */
    async initialize({ clientInfo, capabilities, timeoutMs } = {}) {
        const params = { clientInfo: clientInfo || { name: 'live-consult', version: '0.1.0' } };
        // capabilities.experimentalApi 는 turn/steer 에 **불필요**하다(게이트 밖, 실측).
        // 다른 experimental 필드를 볼 때만 넘겨라.
        if (capabilities) params.capabilities = capabilities;
        const result = await this.request('initialize', params, { timeoutMs });
        this.notify('initialized', {});
        return result;
    }

    close() {
        // _onClosed 는 ws 의 close 이벤트로도 불리므로 여기서는 소켓만 닫고 상태 정리는 맡긴다.
        try { this.ws.close(); } catch { /* 이미 닫힘 */ }
        this._onClosed('close() 호출');
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ws 연결
// ══════════════════════════════════════════════════════════════════════════

// Node 22 의 전역 WebSocket 을 쓴다. `ws` npm 모듈은 이 저장소에 없고, fixture 도 전역
// WebSocket 으로 실측을 통과했다. 없는 런타임이면 여기서 명확히 실패시킨다.
function openWs(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (typeof WebSocket === 'undefined') {
            reject(new AppServerError('이 Node 에는 전역 WebSocket 이 없다 (Node 22+ 필요)'));
            return;
        }
        let ws;
        try { ws = new WebSocket(url); }
        catch (e) { reject(new AppServerError(`ws 생성 실패 (${url}): ${e && e.message}`)); return; }
        let settled = false;
        const t = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch { /* 무시 */ }
            reject(new AppServerError(`ws 연결 타임아웃 ${timeoutMs}ms (${url})`));
        }, timeoutMs);
        ws.addEventListener('open', () => {
            if (settled) return;
            settled = true; clearTimeout(t); resolve(ws);
        });
        ws.addEventListener('error', () => {
            if (settled) return;
            settled = true; clearTimeout(t);
            reject(new AppServerError(`ws 연결 실패 (${url})`));
        });
    });
}

/**
 * 이미 떠 있는 app-server 에 ws 로 붙어 Conn 을 만든다.
 * (프로세스를 우리가 안 띄웠을 때 · 가짜 서버로 배관을 시험할 때 쓴다)
 *
 * @param {string} url ws://127.0.0.1:<port> — 🔴 loopback 만 쓴다
 * @param {{name?:string, logSink?:Function, defaultRequestTimeoutMs?:number,
 *          readyTimeoutMs?:number, retryIntervalMs?:number, isDead?:Function}} [opts]
 *   isDead() → truthy 를 돌려주면 재시도를 즉시 그만둔다 (프로세스가 죽은 경우).
 */
export async function connectRpc(url, opts = {}) {
    const readyTimeoutMs = opts.readyTimeoutMs !== undefined ? opts.readyTimeoutMs : WS_READY_TIMEOUT_MS;
    const retryMs = opts.retryIntervalMs !== undefined ? opts.retryIntervalMs : WS_RETRY_INTERVAL_MS;
    const deadline = Date.now() + readyTimeoutMs;
    let lastErr = null;

    for (;;) {
        // 🔴 프로세스가 이미 죽었으면 상한까지 기다리지 않는다. 조용한 hang 을 만드는 지점이다.
        const dead = typeof opts.isDead === 'function' ? opts.isDead() : null;
        if (dead) {
            throw new AppServerError(`app-server 가 먼저 죽었다 (${dead}) — ws 에 붙을 수 없다`, { processDead: true });
        }
        try {
            const ws = await openWs(url, WS_ATTEMPT_TIMEOUT_MS);
            emit(opts.logSink, { kind: 'connect', conn: opts.name || 'conn', url });
            return new Conn(ws, {
                name: opts.name,
                logSink: opts.logSink,
                defaultRequestTimeoutMs: opts.defaultRequestTimeoutMs
            });
        } catch (e) {
            lastErr = e;
        }
        if (Date.now() >= deadline) {
            throw new AppServerError(
                `${readyTimeoutMs}ms 안에 ws 리슨에 붙지 못했다 (${url}): ${lastErr && lastErr.message}`,
                { url }
            );
        }
        await delay(retryMs);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// AppServer — 프로세스 소유권은 이쪽에 있다
// ══════════════════════════════════════════════════════════════════════════

export class AppServer {
    constructor(child, cfg = {}) {
        this.child = child;
        this.port = cfg.port;
        this.url = `ws://127.0.0.1:${cfg.port}`;
        this.logSink = cfg.logSink;
        this.defaultRequestTimeoutMs = cfg.defaultRequestTimeoutMs;
        this.readyTimeoutMs = cfg.readyTimeoutMs;
        this.retryIntervalMs = cfg.retryIntervalMs;

        this.exitInfo = null;       // 죽었으면 사람이 읽을 수 있는 사유 문자열
        this.stderrBytes = 0;       // 🔴 내용은 버린다. 바이트 수만 남긴다
        this._conns = new Set();
        this._connSeq = 0;
        this._closed = false;
        this._exitWaiters = [];

        // 🔴 프로세스 배선은 생성자에서 끝낸다. 호출자가 이걸 따로 걸어 주길 기대하면
        //    한 군데만 빠뜨려도 exitInfo 가 영영 갱신되지 않아 close() 가 hang 된다.
        installExitGuard(cfg.installSignalHandlers !== false);
        LIVE_SERVERS.add(this);

        // 🔴 stderr 는 통째로 버린다 — 계정 정보가 섞일 수 있다(실측 779바이트).
        //    그래도 파이프를 소비는 해야 한다. 안 읽으면 버퍼가 차서 프로세스가 멈춘다.
        if (child.stderr) child.stderr.on('data', (d) => { this.stderrBytes += d.length; });
        // stdout 은 ws 모드에서 JSON-RPC 통로가 아니다. 진단용으로만 흘려보낸다.
        if (child.stdout) child.stdout.on('data', (d) => emit(this.logSink, { kind: 'stdout', text: d.toString('utf8') }));

        // spawn 실패(파일 없음 등)를 콜백에서 throw 하면 uncaughtException 으로 샌다. 상태로만 남긴다.
        child.on('error', (e) => this._markExit(`spawn 실패: ${e.message}`));
        child.on('exit', (code, sig) => {
            this._markExit(`code=${code} sig=${sig}`);
            emit(this.logSink, { kind: 'exit', pid: child.pid, code, sig, stderrBytes: this.stderrBytes });
        });
    }

    get pid() { return this.child.pid; }
    /** 프로세스가 아직 살아 있나 */
    get alive() { return this.exitInfo === null; }

    /**
     * ws 연결을 하나 연다. 여러 번 불러도 된다 — steer 전용 연결을 따로 여는 게 이 구조의 목적이다.
     * 🔴 단, **알림은 턴을 시작한 연결에만** 온다(실측). 진행 상황을 볼 연결과 steer 를 쏠 연결을
     *    헷갈리지 마라. turn/start 를 보낸 Conn 에 onNotification 을 걸어야 한다.
     * @returns {Promise<Conn>}
     */
    async connect(opts = {}) {
        if (this._closed) throw new AppServerError('이미 close() 된 AppServer 다');
        const name = opts.name || `conn${++this._connSeq}`;
        const conn = await connectRpc(this.url, {
            name,
            logSink: this.logSink,
            defaultRequestTimeoutMs: opts.defaultRequestTimeoutMs !== undefined ? opts.defaultRequestTimeoutMs : this.defaultRequestTimeoutMs,
            readyTimeoutMs: opts.readyTimeoutMs !== undefined ? opts.readyTimeoutMs : this.readyTimeoutMs,
            retryIntervalMs: opts.retryIntervalMs !== undefined ? opts.retryIntervalMs : this.retryIntervalMs,
            // stderr 내용은 버렸지만 "얼마나 나왔는지"는 원인 추적에 도움이 된다.
            isDead: () => (this.exitInfo === null ? null : `${this.exitInfo}, stderr ${this.stderrBytes}바이트(내용은 계정 정보 우려로 버렸다)`)
        });
        this._conns.add(conn);
        conn.onClose(() => this._conns.delete(conn));
        return conn;
    }

    // 동기 강제 종료. 'exit' 훅에서 불리므로 async 를 쓸 수 없다.
    _killSync() {
        const c = this.child;
        LIVE_SERVERS.delete(this);
        if (!c || !c.pid) return;
        // 🔴 이미 죽은 프로세스의 PID 로 taskkill 하면 재사용된 남의 PID 를 죽일 수 있다.
        if (c.exitCode !== null || c.signalCode !== null) return;
        try {
            if (IS_WIN) {
                // shell:true 로 띄웠으므로 child.pid 는 cmd.exe 다. 진짜 codex 는 그 아래에 있다.
                // MSYS kill 은 네이티브 손자에 안 닿는다(실측) — taskkill /T 로 트리째 죽인다.
                cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
                // detached:true 로 띄웠으니 pgid === pid 다. 음수 pid 는 그룹 전체를 뜻한다.
                try { process.kill(-c.pid, 'SIGKILL'); } catch { c.kill('SIGKILL'); }
            }
        } catch { /* 이미 죽었으면 taskkill 이 1을 뱉는다 — 정상 */ }
        try { c.kill('SIGKILL'); } catch { /* 무시 */ }
    }

    /**
     * 연결을 모두 닫고 **프로세스 트리까지** 죽인다. 좀비를 남기지 않는 것이 이 함수의 유일한 목적이다.
     *
     * @param {{graceMs?: number}} [opts]
     *   graceMs 를 주면 POSIX 에서 그룹에 TERM 을 먼저 보내고 그만큼 기다렸다가 KILL 한다.
     *   🔴 안 주면 유예 없이 곧바로 강제 종료한다. 근거 없는 유예값을 지어내느니 확실히 죽인다 —
     *      steer-fixture 9번에서 강제 종료(taskkill /T /F) 뒤에도 `codex exec resume` 으로
     *      대화 맥락이 그대로 이어졌다. graceful 종료가 상태 보존의 전제가 아니라는 뜻이다.
     *   Windows 는 graceMs 를 무시한다. 콘솔 앱에 /F 없는 taskkill 은 잘 먹지 않아
     *   "유예를 준 척"만 하게 되기 때문이다(미실측 동작을 흉내내지 않는다).
     */
    async close(opts = {}) {
        if (this._closed) return;
        this._closed = true;

        for (const conn of [...this._conns]) {
            try { conn.close(); } catch { /* 무시 */ }
        }
        this._conns.clear();

        const c = this.child;
        LIVE_SERVERS.delete(this);
        if (!c || !c.pid || c.exitCode !== null || c.signalCode !== null) {
            emit(this.logSink, { kind: 'close', pid: c && c.pid, alreadyExited: true });
            return;
        }

        const exited = this._waitExit();

        const graceMs = opts.graceMs;
        if (!IS_WIN && Number.isFinite(graceMs) && graceMs > 0) {
            try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* 무시 */ } }
            const won = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)]);
            if (won) { emit(this.logSink, { kind: 'close', pid: c.pid, via: 'SIGTERM' }); return; }
        }

        this._killSync();
        // taskkill /F · SIGKILL 은 OS 가 종료를 보장하므로 여기서 상한 없이 기다려도 안전하다.
        // (이미 죽어 있었다면 위에서 걸러졌고, exit 이벤트는 반드시 온다)
        await exited;
        emit(this.logSink, { kind: 'close', pid: c.pid, via: IS_WIN ? 'taskkill /T /F' : 'SIGKILL' });
    }

    _waitExit() {
        if (this.exitInfo !== null) return Promise.resolve();
        return new Promise((resolve) => this._exitWaiters.push(resolve));
    }

    _markExit(reason) {
        if (this.exitInfo === null) this.exitInfo = reason;
        LIVE_SERVERS.delete(this);
        const waiters = this._exitWaiters.splice(0);
        for (const r of waiters) r();
    }
}

/**
 * codex app-server 를 띄운다. 프로세스 소유권은 반환된 AppServer 에 있다 —
 * 반드시 `await server.close()` 로 끝내라 (try/finally 로 감싸라).
 *
 * @param {object} opts
 * @param {number}   [opts.port]      비우면 빈 loopback 포트를 자동으로 잡는다. 🔴 고정 포트는 충돌한다
 * @param {string}   [opts.cwd]       app-server 프로세스의 작업 디렉토리.
 *                                    ⚠️ 대화의 cwd 는 thread/start 의 params.cwd 로 따로 준다
 * @param {Function} [opts.logSink]   fn({kind, ...}) — 진단 이벤트. 미지정이면 아무것도 안 남는다
 * @param {string}   [opts.codexBin]  기본 'codex'
 * @param {string}   [opts.winSandbox] Windows 의 -c windows.sandbox=<값>. 빈 문자열이면 안 붙인다
 * @param {string[]} [opts.extraConfig] 추가 `-c key=value` 목록
 * @param {number}   [opts.defaultRequestTimeoutMs] 이 서버에서 만든 Conn 의 request 기본 상한
 * @param {number}   [opts.readyTimeoutMs] ws 리슨을 기다릴 상한
 * @param {number}   [opts.retryIntervalMs] ws 재시도 간격
 * @param {boolean}  [opts.installSignalHandlers] 기본 true — SIGINT/SIGTERM/SIGHUP 에서 트리를 죽인다.
 *                   CLI 가 자체 정리를 하려면 false 로 두고 **직접 close() 를 보장해라**
 * @returns {Promise<AppServer>}
 *
 * ⚠️ Windows 에서 codex 가 없거나 기동에 실패하면 이 함수가 아니라 **첫 connect() 에서** 드러난다
 *    (shell:true 라 cmd.exe 가 먼저 뜨고 spawn 자체는 성공하기 때문이다). 어느 쪽이든 에러는
 *    명확하게 나오고 hang 하지 않는다.
 */
export async function startAppServer(opts = {}) {
    const port = Number.isFinite(opts.port) && opts.port > 0 ? opts.port : await findFreePort();
    const codexBin = opts.codexBin || 'codex';
    const winSandbox = opts.winSandbox !== undefined ? opts.winSandbox : WIN_SANDBOX_DEFAULT;

    // 🔴 반드시 127.0.0.1. 외부 인터페이스에 바인드하면 무인증 RPC 가 노출된다
    //    (codex 의 --ws-auth 도움말이 인증을 "non-loopback listeners" 로 한정한다).
    const args = ['app-server', '--listen', `ws://127.0.0.1:${port}`];
    if (IS_WIN && winSandbox) args.push('-c', `windows.sandbox=${winSandbox}`);
    for (const kv of (opts.extraConfig || [])) args.push('-c', String(kv));

    const child = cp.spawn(
        // Windows 의 codex 는 npm .cmd shim 이라 shell:true 가 필요하다. 그래서 인용도 우리가 한다.
        IS_WIN ? quoteForShell(codexBin) : codexBin,
        IS_WIN ? args.map(quoteForShell) : args,
        {
            cwd: opts.cwd,
            // stdin 은 쓰지 않지만 'ignore'(=즉시 EOF) 로 두지 않는다. app-server 가 stdin 을 보는
            // 구현이면 EOF 를 종료 신호로 읽을 수 있다. 열어만 두고 아무것도 안 쓴다.
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: IS_WIN,
            windowsHide: true,
            // POSIX: 프로세스 그룹 리더로 만들어야 손자까지 그룹 시그널로 정리할 수 있다.
            // Windows 에서는 shell:true 와 조합이 검증되지 않아 쓰지 않는다(taskkill /T 로 충분).
            detached: !IS_WIN
        }
    );

    const server = new AppServer(child, {
        port,
        logSink: opts.logSink,
        defaultRequestTimeoutMs: opts.defaultRequestTimeoutMs,
        readyTimeoutMs: opts.readyTimeoutMs,
        retryIntervalMs: opts.retryIntervalMs,
        installSignalHandlers: opts.installSignalHandlers
    });

    emit(opts.logSink, { kind: 'spawn', pid: child.pid, port, cmd: [codexBin, ...args].map(quoteForShell).join(' ') });

    // spawn 이 즉시 실패하면(POSIX 의 ENOENT 등) 'error' 가 다음 틱에 온다. 한 번 걸러 주면
    // 호출자가 "연결 타임아웃" 이라는 엉뚱한 증상 대신 진짜 원인을 본다.
    //
    // ⚠️ Windows 는 shell:true 라 cmd.exe 가 먼저 뜬다. 실행파일이 없어도 spawn 은 **성공**하고
    //    cmd 가 뒤늦게 exit=1 로 죽는다(실측). 그래서 이 검사만으로는 못 잡는다.
    //    → 그 경우는 connect() 가 isDead 를 보고 "app-server 가 먼저 죽었다" 로 즉시 드러낸다.
    //      조용한 hang 은 어느 경로에서도 생기지 않는다.
    await delay(0);
    if (server.exitInfo !== null) {
        // 실패로 빠져나갈 때도 좀비를 남기지 않는다. 호출자는 이 시점에 close() 할 핸들이 없다.
        server._killSync();
        throw new AppServerError(`app-server 를 띄우지 못했다: ${server.exitInfo}`, { processDead: true });
    }

    return server;
}
