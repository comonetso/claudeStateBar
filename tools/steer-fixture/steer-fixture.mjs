#!/usr/bin/env node
//
// steer-fixture.mjs — codex app-server `turn/steer` 실측 픽스처 (Phase 0)
//
// 목적: codex_rescue 를 `codex exec`(배치)에서 `codex app-server`(JSON-RPC)로 옮길 수 있는지
//       판단하는 데 필요한 10가지를 **실제로 돌려서** 확인한다. 추측을 코드에 남기지 않기 위한
//       도구이므로, 확인되지 않은 것은 ⬜(미판정)로 남기고 절대 ✅ 로 올리지 않는다.
//
// 🔴 이 스크립트는 실제 Codex 세션을 만든다. 다른 Codex 작업과 겹치지 않는 때에 돌려라.
//    격리된 임시 디렉토리에서만 동작하며 이 저장소를 cwd 로 쓰지 않는다.
//
// 사용법은 같은 디렉토리의 README.md 를 봐라. `--dry-run` 은 codex 를 부르지 않는다.
//
// ── 구현 근거 (전부 이 저장소·실측에서 온 것이며, 지어낸 값이 아니다) ──────────────
//  · NDJSON(줄바꿈 구분 JSON). LSP 식 `Content-Length` 헤더가 없다.
//    → src/providers/codex/usageProvider.ts 190~265행에서 마켓 배포본이 쓰는 방식.
//  · initialize 응답 → `initialized` 알림 → 다음 요청.
//  · Windows 는 npm `.cmd` shim 때문에 `shell: true` 가 필요하다.
//  · stderr 는 계정 정보가 섞일 수 있어 통째로 버린다 (바이트 수만 센다).
//  · `codex exec resume <id> --skip-git-repo-check --json -c sandbox_mode=read-only -o <file>`
//    → skills/codex_rescue/send.sh 359~369행. resume 에는 `-s` 도 `-C` 도 없다(cwd 의존).
//  · turn/steer 파라미터·응답, NonSteerableTurnKind 는
//    `codex app-server generate-json-schema --experimental` 로 뽑아 확인했다 (codex-cli 0.145.0).
//    turn/steer 는 experimental 게이팅 밖이라 `capabilities.experimentalApi` 없이도 노출된다.
//  · `--ws-auth` 도움말이 "non-loopback listeners" 라고 못박으므로 127.0.0.1 리슨은 무인증이다.
//
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const IS_WIN = process.platform === 'win32';

// ══════════════════════════════════════════════════════════════════════════
// 1. 옵션
// ══════════════════════════════════════════════════════════════════════════

// 기본값에 대한 태도: 정책성 수치는 전부 옵션으로 빼고, 여기 적힌 기본값이 어디서 왔는지
// 한 줄씩 남긴다. 근거 없는 숫자를 조용히 박아 두지 않기 위해서다.
const DEFAULTS = {
    transport: 'ws',        // 요구사항이 "두 번째 연결에서 steer" 라서. stdio 는 연결이 하나뿐이다
    port: 45871,            // 임의의 사용 안 하는 루프백 포트. 충돌하면 --port 로 바꿔라
    busySeconds: 45,        // 요구사항 "30초 이상". 여유를 두고 45
    sandbox: 'read-only',   // send.sh 가 CONSULT 첫 턴에 쓰는 값과 같게 맞췄다
    approval: 'never',      // 사람이 없는 자동 픽스처라 승인 요청이 오면 그대로 멈춘다
    winSandbox: 'unelevated', // send.sh 의 CR_WIN_SANDBOX 기본값과 같게 (win32 에서만)
    turnTimeout: 300,       // busySeconds 45 + 모델 사고 시간. 넉넉히 5분
    resumeTimeout: 300,
    wsReadyTimeout: 20,     // ws 리슨이 열릴 때까지 재시도할 상한(초)
    wsRetryMs: 200,
    steerAfterMaxMs: 20000  // 명령 item 알림이 안 오면 이 시간 뒤 강제로 steer 를 쏜다(임의 상한)
};

const HELP = `
steer-fixture — codex app-server turn/steer 실측 픽스처 (Phase 0)

  node tools/steer-fixture/steer-fixture.mjs [옵션]

옵션
  --dry-run                 codex 를 부르지 않고, 조립될 명령줄과 JSON-RPC 원문만 출력한다
  --transport <ws|stdio>    기본 ${DEFAULTS.transport}
                            ws    : app-server 를 ws://127.0.0.1:<port> 로 띄우고 연결 2개를 연다
                                    (요구사항 4번 "두 번째 연결에서 steer" 를 진짜로 검증)
                            stdio : 연결이 하나뿐이라 4번은 ⬜ 로 남는다
  --port <n>                ws 포트 (기본 ${DEFAULTS.port})
  --busy-seconds <n>        1턴에서 유도할 장시간 명령의 길이 (기본 ${DEFAULTS.busySeconds})
  --codex <path>            codex 실행 파일 (기본 codex)
  --model <name>            thread/start 에 넘길 모델. 미지정이면 codex 설정값
  --sandbox <mode>          read-only | workspace-write | danger-full-access (기본 ${DEFAULTS.sandbox})
  --approval <mode>         untrusted | on-request | never (기본 ${DEFAULTS.approval})
  --win-sandbox <mode>      -c windows.sandbox=<mode> (win32 전용, 기본 ${DEFAULTS.winSandbox})
                            빈 문자열이면 붙이지 않는다
  --out <dir>               로그·판정 출력 디렉토리 (기본 임시폴더 아래 새 디렉토리)
  --turn-timeout <sec>      turn/completed 대기 상한 (기본 ${DEFAULTS.turnTimeout})
  --resume-timeout <sec>    codex exec resume 대기 상한 (기본 ${DEFAULTS.resumeTimeout})
  --ws-ready-timeout <sec>  ws 리슨이 열릴 때까지 재시도할 상한 (기본 ${DEFAULTS.wsReadyTimeout})
  --steer-after-max-ms <ms> 명령 item 알림을 못 받았을 때 steer 를 강제 전송할 시각 (기본 ${DEFAULTS.steerAfterMaxMs})
  --skip-resume             9·10번(=exec resume)을 건너뛴다
  --no-control              10번의 대조군(workspace-write resume)을 돌리지 않는다
  --experimental-api        initialize 에 capabilities.experimentalApi=true 를 넣는다
  --help                    이 도움말

나오는 것
  <out>/rpc.jsonl        모든 JSON-RPC 송수신 원문
  <out>/timeline.jsonl   단계별 타임스탬프
  <out>/verdict.json     10개 항목 판정(기계 판독용)
  <out>/report.txt       사람이 읽는 판정표
  <out>/work/            격리된 작업 디렉토리 (codex 의 cwd)
`;

function parseArgs(argv) {
    const o = {
        dryRun: false,
        transport: DEFAULTS.transport,
        port: DEFAULTS.port,
        busySeconds: DEFAULTS.busySeconds,
        codex: 'codex',
        model: null,
        sandbox: DEFAULTS.sandbox,
        approval: DEFAULTS.approval,
        winSandbox: IS_WIN ? DEFAULTS.winSandbox : '',
        out: null,
        turnTimeout: DEFAULTS.turnTimeout,
        resumeTimeout: DEFAULTS.resumeTimeout,
        wsReadyTimeout: DEFAULTS.wsReadyTimeout,
        steerAfterMaxMs: DEFAULTS.steerAfterMaxMs,
        skipResume: false,
        control: true,
        experimentalApi: false,
        help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) die(`${a} 에 값이 없다`);
            return v;
        };
        switch (a) {
            case '--dry-run': o.dryRun = true; break;
            case '--transport': o.transport = next(); break;
            case '--port': o.port = Number(next()); break;
            case '--busy-seconds': o.busySeconds = Number(next()); break;
            case '--codex': o.codex = next(); break;
            case '--model': o.model = next(); break;
            case '--sandbox': o.sandbox = next(); break;
            case '--approval': o.approval = next(); break;
            case '--win-sandbox': o.winSandbox = next(); break;
            case '--out': o.out = next(); break;
            case '--turn-timeout': o.turnTimeout = Number(next()); break;
            case '--resume-timeout': o.resumeTimeout = Number(next()); break;
            case '--ws-ready-timeout': o.wsReadyTimeout = Number(next()); break;
            case '--steer-after-max-ms': o.steerAfterMaxMs = Number(next()); break;
            case '--skip-resume': o.skipResume = true; break;
            case '--no-control': o.control = false; break;
            case '--experimental-api': o.experimentalApi = true; break;
            case '--help': case '-h': o.help = true; break;
            default: die(`모르는 옵션: ${a}`);
        }
    }
    if (o.transport !== 'ws' && o.transport !== 'stdio') die(`--transport 는 ws 또는 stdio (지금: ${o.transport})`);
    if (!Number.isFinite(o.port) || o.port <= 0) die(`--port 가 이상하다: ${o.port}`);
    if (!Number.isFinite(o.busySeconds) || o.busySeconds < 1) die(`--busy-seconds 가 이상하다: ${o.busySeconds}`);
    // 숫자 옵션이 NaN 인 채로 흘러가면 대기 루프가 조용히 0초가 되어 "연결 실패"로 위장한다.
    for (const k of ['turnTimeout', 'resumeTimeout', 'wsReadyTimeout', 'steerAfterMaxMs']) {
        if (!Number.isFinite(o[k]) || o[k] <= 0) die(`${k} 값이 이상하다: ${o[k]}`);
    }
    return o;
}

function die(msg) {
    process.stderr.write(`steer-fixture: ${msg}\n`);
    process.exit(2);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 판정표 — 요구사항 10개를 그대로 옮겼다
// ══════════════════════════════════════════════════════════════════════════

const CHECK_TITLES = {
    1: 'app-server initialize 성공',
    2: 'thread/start 성공 · threadId 획득',
    3: `turn/start 로 ${'{busy}'}초 이상 걸리는 명령 유도`,
    4: '실행 중일 때 두 번째 연결에서 turn/steer 전송',
    5: '같은 turnId(expectedTurnId)로 수락',
    6: '완료 응답이 steer 문장을 실제로 언급  ← 완료 조건',
    7: 'steer 이후 새 turn/started 알림이 생기지 않음',
    8: '턴 완료 뒤 같은 expectedTurnId 로 steer 하면 거부',
    9: 'app-server 종료 후 codex exec resume 으로 맥락이 이어짐  ← 최대 관문',
    10: 'resume 을 -c sandbox_mode=read-only 로 돌리면 권한 경계 재현'
};

class Checks {
    constructor(busySeconds) {
        this.items = new Map();
        for (const k of Object.keys(CHECK_TITLES)) {
            this.items.set(Number(k), {
                n: Number(k),
                title: CHECK_TITLES[k].replace('{busy}', String(busySeconds)),
                state: 'UNKNOWN',
                evidence: []
            });
        }
    }
    pass(n, ev) { this._set(n, 'PASS', ev); }
    fail(n, ev) { this._set(n, 'FAIL', ev); }
    unknown(n, ev) { this._set(n, 'UNKNOWN', ev); }
    note(n, ev) { this.items.get(n).evidence.push(ev); }
    _set(n, state, ev) {
        const it = this.items.get(n);
        it.state = state;
        if (ev) it.evidence.push(ev);
    }
    symbol(state) { return state === 'PASS' ? '✅' : state === 'FAIL' ? '❌' : '⬜'; }
    render() {
        const lines = [];
        for (const it of this.items.values()) {
            lines.push(`${String(it.n).padStart(2, ' ')}. ${this.symbol(it.state)} ${it.title}`);
            if (it.evidence.length === 0) lines.push('      · (근거 없음)');
            for (const e of it.evidence) lines.push(`      · ${e}`);
        }
        return lines.join('\n');
    }
    toJSON() {
        return [...this.items.values()].map((it) => ({
            n: it.n, title: it.title, state: it.state, evidence: it.evidence
        }));
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. 로그
// ══════════════════════════════════════════════════════════════════════════

class Log {
    constructor(outDir, dryRun) {
        this.t0 = Date.now();
        this.outDir = outDir;
        this.dryRun = dryRun;
        this.rpcPath = path.join(outDir, 'rpc.jsonl');
        this.timelinePath = path.join(outDir, 'timeline.jsonl');
        this.marks = [];
    }
    ms() { return Date.now() - this.t0; }
    // JSON-RPC 원문을 그대로 남긴다. 나중에 대조하려면 파싱본이 아니라 원문이어야 한다.
    rpc(dir, conn, raw) {
        const rec = { ms: this.ms(), at: new Date().toISOString(), dir, conn, raw };
        if (!this.dryRun) fs.appendFileSync(this.rpcPath, JSON.stringify(rec) + '\n');
    }
    mark(name, extra) {
        const rec = { ms: this.ms(), at: new Date().toISOString(), mark: name, ...(extra || {}) };
        this.marks.push(rec);
        if (!this.dryRun) fs.appendFileSync(this.timelinePath, JSON.stringify(rec) + '\n');
        say(`[${String(rec.ms).padStart(7, ' ')}ms] ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`);
    }
    renderTimeline() {
        return this.marks.map((m) => `${String(m.ms).padStart(8, ' ')}ms  ${m.mark}`).join('\n');
    }
}

function say(s) { process.stdout.write(s + '\n'); }

// ══════════════════════════════════════════════════════════════════════════
// 4. 프로세스 — Windows 손자 프로세스까지 확실히 죽인다
// ══════════════════════════════════════════════════════════════════════════

// MSYS 의 kill 은 네이티브 손자 프로세스에 닿지 않는다(실측). shell:true 로 띄우면 child.pid 는
// cmd.exe 의 것이고 진짜 codex 는 그 아래에 있으므로, Windows 에서는 taskkill /T /F 로 트리째 죽인다.
const LIVE = new Set();

function spawnTracked(file, args, opts) {
    const child = cp.spawn(file, args, opts);
    LIVE.add(child);
    child.on('exit', () => LIVE.delete(child));
    return child;
}

function killTree(child) {
    if (!child) return;
    try {
        if (IS_WIN && child && child.pid) {
            cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        }
    } catch { /* 이미 죽었으면 taskkill 이 1을 뱉는다 — 정상 */ }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    LIVE.delete(child);
}

function killAll() {
    for (const c of [...LIVE]) killTree(c);
}

// 어떤 경로로 끝나든 좀비를 남기지 않는다.
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAll(); process.exit(130); });
}
process.on('uncaughtException', (e) => {
    process.stderr.write(`steer-fixture: uncaught ${e && e.stack ? e.stack : e}\n`);
    killAll();
    process.exit(1);
});

// Windows 에서 shell:true 로 띄우면 Node 는 인자를 공백으로 이어 붙여 cmd 에 넘긴다.
// 경로에 공백이 있으면 거기서 깨지므로 우리가 먼저 인용한다.
function quoteForShell(a) {
    if (!IS_WIN) return a;
    return /[\s"^&|<>()]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a);
}

function renderCommand(file, args) {
    return [file, ...args].map(quoteForShell).join(' ');
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 연결 — stdio(NDJSON)와 WebSocket 을 같은 인터페이스로
// ══════════════════════════════════════════════════════════════════════════

class Conn extends EventEmitter {
    constructor(name, log) {
        super();
        this.name = name;
        this.log = log;
        this.buf = '';
        this.stderrBytes = 0;
    }
    // ws 는 프레임 하나가 통째로 JSON 일 수 있고, stdio 는 줄바꿈으로 끊긴다. 둘 다 받는다.
    ingest(text) {
        const whole = text.trim();
        if (whole && this.buf === '' && whole.indexOf('\n') < 0) {
            try {
                const msg = JSON.parse(whole);
                this.log.rpc('recv', this.name, whole);
                this.emit('message', msg);
                return;
            } catch { /* 조각이다 — 아래 줄 단위 처리로 넘어간다 */ }
        }
        this.buf += text;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            this.log.rpc('recv', this.name, line);
            let msg;
            try { msg = JSON.parse(line); } catch { this.emit('unparsable', line); continue; }
            this.emit('message', msg);
        }
    }
    send(obj) {
        const raw = JSON.stringify(obj);
        this.log.rpc('send', this.name, raw);
        this._write(raw);
    }
}

class StdioConn extends Conn {
    constructor(name, child, log) {
        super(name, log);
        this.child = child;
        child.stdout.on('data', (d) => this.ingest(d.toString('utf8')));
        // 🔴 stderr 는 계정 정보가 섞일 수 있어 통째로 버린다. 바이트 수만 센다.
        child.stderr.on('data', (d) => { this.stderrBytes += d.length; });
        child.on('exit', (code, sig) => this.emit('closed', { code, sig }));
    }
    _write(raw) {
        try { this.child.stdin.write(raw + '\n'); } catch { /* pipe closed */ }
    }
    close() { try { this.child.stdin.end(); } catch { /* ignore */ } }
}

class WsConn extends Conn {
    constructor(name, ws, log) {
        super(name, log);
        this.ws = ws;
        ws.addEventListener('message', (ev) => {
            const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
            this.ingest(data);
        });
        ws.addEventListener('close', (ev) => this.emit('closed', { code: ev.code }));
        ws.addEventListener('error', () => this.emit('closed', { code: -1 }));
    }
    _write(raw) {
        try { this.ws.send(raw); } catch { /* closed */ }
    }
    close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function connectWs(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
        const t = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('ws 연결 타임아웃')); }, timeoutMs);
        ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws 연결 실패')); });
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 6. JSON-RPC 클라이언트
// ══════════════════════════════════════════════════════════════════════════

class Rpc {
    constructor(conn, log) {
        this.conn = conn;
        this.log = log;
        this.nextId = 0;
        this.pending = new Map();
        this.serverRequests = [];
        conn.on('message', (msg) => this._route(msg));
        conn.on('closed', () => {
            for (const [, p] of this.pending) p.reject(new Error(`${conn.name} 연결이 끊겼다`));
            this.pending.clear();
        });
    }
    _route(msg) {
        if (msg.id !== undefined && msg.method === undefined) {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                p.resolve({ result: msg.result, error: msg.error, at: this.log.ms() });
            }
            return;
        }
        if (msg.method !== undefined && msg.id !== undefined) {
            // 서버 → 클라 요청(승인 요청 등). 응답 형태가 메서드마다 달라 일반 거부를 만들 수 없으므로
            // 기록만 하고 답하지 않는다. approvalPolicy=never 면 애초에 오지 않아야 한다.
            this.serverRequests.push({ ms: this.log.ms(), method: msg.method, id: msg.id });
            this.conn.emit('serverRequest', msg);
            return;
        }
        if (msg.method !== undefined) this.conn.emit('notification', msg);
    }
    // 에러도 reject 가 아니라 resolve 로 돌려준다 — 에러 자체가 판정 근거이기 때문이다.
    request(method, params, timeoutMs) {
        const id = this.nextId++;
        const payload = { id, method, params: params === undefined ? {} : params };
        const sentAt = this.log.ms();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ result: undefined, error: { code: -1, message: `타임아웃 ${timeoutMs}ms` }, at: this.log.ms(), timedOut: true, sentAt });
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve({ ...v, sentAt }); },
                reject: (e) => { clearTimeout(timer); reject(e); }
            });
            this.conn.send(payload);
        });
    }
    notify(method, params) {
        this.conn.send({ method, params: params === undefined ? {} : params });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 7. 프롬프트 조립
// ══════════════════════════════════════════════════════════════════════════

function buildTexts(opt) {
    const rnd = () => crypto.randomBytes(4).toString('hex').toUpperCase();
    const sentinel = `MEMO-${rnd()}`;         // 9번 판정용. resume 프롬프트에는 절대 넣지 않는다
    const steerToken = `STEER-${rnd()}`;      // 6번 판정용. steer 로만 전달되므로 지어낼 수 없다
    const busyMs = Math.round(opt.busySeconds * 1000);

    // 1턴: 센티넬을 기억시키고, 오래 걸리는 명령을 돌리게 한다.
    // sleep 대신 node 를 쓰는 이유: Windows·Linux 어디서든 같은 방식으로 도는 것이 node 뿐이고,
    // busy-wait 가 아니라 실제로 잠들기 때문에 CPU 를 먹지 않는다.
    const turn1 = [
        'This is an automated protocol fixture. Follow these steps literally. Do not ask questions.',
        '',
        `Step 1. Memorize this memo word and keep it for the rest of this conversation: ${sentinel}`,
        '',
        'Step 2. Run exactly this shell command in the current directory and wait for it to finish.',
        `        It sleeps for about ${opt.busySeconds} seconds; that is expected and required.`,
        '        Do not shorten it, do not skip it, do not run anything else instead:',
        '',
        `          node -e "setTimeout(function(){console.log('FIXTURE_BUSY_DONE')}, ${busyMs})"`,
        '',
        'Step 3. Only after that command has finished, reply with one short final message that',
        '        contains the memo word from Step 1 exactly as written.'
    ].join('\n');

    // steer: 6번의 완료 조건. "토큰을 최종 메시지에 넣어라" 외에는 아무것도 요구하지 않는다.
    // 새 턴을 만들지 말라는 말도 굳이 넣지 않는다 — 그건 우리가 알림으로 판정할 몫이다(7번).
    const steer = [
        'Additional instruction, sent while your current command is still running.',
        `When you write your final message for this turn, it must also contain this exact token: ${steerToken}`,
        'Do not restart the command. Just finish what you are doing and include the token.'
    ].join('\n');

    // resume #1 — 9번(맥락 유지). 🔴 센티넬 값을 여기에 절대 쓰지 않는다.
    const resumeAsk = [
        'Earlier in this same conversation I asked you to memorize a memo word.',
        'Reply with just that memo word and nothing else. If you do not have it, reply exactly: NO_MEMO'
    ].join('\n');

    // resume #2 — 10번(권한 경계). 파일이 실제로 생겼는지로 판정한다.
    const probeReadonlyName = 'probe-readonly.txt';
    const resumeWrite = [
        `Create a file named ${probeReadonlyName} in the current working directory containing the single word WROTE.`,
        'If you cannot create it, say why in one sentence. Do not try to work around the restriction.'
    ].join('\n');

    // resume #3 — 10번의 대조군. 이게 없으면 "못 썼다"가 권한 때문인지 모델이 안 한 것인지 못 가린다.
    const probeControlName = 'probe-control.txt';
    const resumeControl = [
        `Create a file named ${probeControlName} in the current working directory containing the single word WROTE.`,
        'If you cannot create it, say why in one sentence.'
    ].join('\n');

    return { sentinel, steerToken, turn1, steer, resumeAsk, resumeWrite, resumeControl, probeReadonlyName, probeControlName };
}

// ══════════════════════════════════════════════════════════════════════════
// 8. codex 명령 조립
// ══════════════════════════════════════════════════════════════════════════

function appServerArgs(opt) {
    // stdio 일 때는 아무 스위치도 붙이지 않는다 — 옵션 없는 `codex app-server` 가 마켓 배포본
    // (usageProvider.ts)이 실제로 쓰는 형태이고, 그것이 유일하게 실측된 조합이다.
    const args = ['app-server'];
    if (opt.transport === 'ws') args.push('--listen', `ws://127.0.0.1:${opt.port}`);
    if (IS_WIN && opt.winSandbox) args.push('-c', `windows.sandbox=${opt.winSandbox}`);
    return args;
}

// resume 산출물 파일명. dry-run 과 실제 실행이 반드시 같은 값을 써야 한다 —
// 어긋나면 "미리 본 명령"과 "실제로 돈 명령"이 달라져 픽스처의 뜻이 없어진다.
const RESUME_FILES = {
    ask: (label) => `resume-ask-${label}-last.txt`,
    askEvents: (label) => `resume-ask-${label}-events.jsonl`,
    writeRo: 'resume-write-readonly-last.txt',
    writeRoEvents: 'resume-write-readonly-events.jsonl',
    control: 'resume-write-control-last.txt',
    controlEvents: 'resume-write-control-events.jsonl'
};

// send.sh 359~369행과 같은 조합. 프롬프트는 `-` 로 stdin 에 넣는다 —
// Windows 에서 shell:true 로 띄우면 공백·개행이 든 인자가 그대로 깨지기 때문이다.
function execResumeArgs(opt, threadId, sandboxMode, lastMsgPath) {
    const args = ['exec', 'resume', threadId, '--skip-git-repo-check', '--json'];
    if (sandboxMode) args.push('-c', `sandbox_mode=${sandboxMode}`);
    if (IS_WIN && opt.winSandbox) args.push('-c', `windows.sandbox=${opt.winSandbox}`);
    args.push('-o', lastMsgPath);
    args.push('-'); // PROMPT 를 stdin 에서 읽는다
    return args;
}

// ══════════════════════════════════════════════════════════════════════════
// 9. dry-run
// ══════════════════════════════════════════════════════════════════════════

function dryRun(opt, texts, outDir, workDir) {
    const sep = (t) => `\n──────── ${t} ────────`;
    say('steer-fixture --dry-run — codex 를 부르지 않고 조립 결과만 보여준다.\n');
    say(`플랫폼      : ${process.platform} (shell:true ${IS_WIN ? '사용' : '미사용'})`);
    say(`transport   : ${opt.transport}${opt.transport === 'ws' ? ` (ws://127.0.0.1:${opt.port})` : ''}`);
    say(`출력 디렉토리: ${outDir}   ← 실제 실행 시 생성`);
    say(`작업 디렉토리: ${workDir}   ← codex 의 cwd. 저장소는 건드리지 않는다`);
    say(`센티넬      : ${texts.sentinel}   (9번 판정용)`);
    say(`steer 토큰  : ${texts.steerToken}   (6번 판정용)`);

    say(sep('띄울 명령'));
    say(`  ${renderCommand(opt.codex, appServerArgs(opt))}`);

    say(sep('conn1 — 초기화'));
    dumpMsg({ id: 0, method: 'initialize', params: initializeParams(opt) });
    dumpMsg({ method: 'initialized', params: {} });

    say(sep('conn1 — thread/start'));
    dumpMsg({ id: 1, method: 'thread/start', params: threadStartParams(opt, workDir) });

    say(sep('conn1 — turn/start (1턴)'));
    dumpMsg({ id: 2, method: 'turn/start', params: turnStartParams('<threadId>', texts.turn1) });

    say(sep(`conn2 — 초기화 (${opt.transport === 'ws' ? '두 번째 WebSocket 연결' : 'stdio 라 두 번째 연결 없음 — conn1 재사용'})`));
    dumpMsg({ id: 0, method: 'initialize', params: initializeParams(opt) });
    dumpMsg({ method: 'initialized', params: {} });

    say(sep('conn2 — turn/steer (명령 실행 중)'));
    dumpMsg({ id: 1, method: 'turn/steer', params: steerParams('<threadId>', '<turnId>', texts.steer) });

    say(sep('conn2 — steer 가 거부될 때만 시도하는 rejoin'));
    say('  (thread 가 conn1 에 묶여 있으면 별도 연결에서 바로 steer 가 안 될 수 있다. 그때만 보낸다)');
    dumpMsg({ id: 2, method: 'thread/resume', params: { threadId: '<threadId>' } });

    say(sep('conn2 — 8번: 턴 완료 뒤 같은 expectedTurnId 로 재전송 (거부되어야 한다)'));
    dumpMsg({ id: 3, method: 'turn/steer', params: steerParams('<threadId>', '<turnId>', '(same steer text)') });

    say(sep('app-server 종료 뒤 — 9번 (threadId 로 먼저, 실패하면 sessionId 로 한 번 더)'));
    say(`  ${renderCommand(opt.codex, execResumeArgs(opt, '<threadId>', 'read-only', path.join(outDir, RESUME_FILES.ask('threadId'))))}`);
    say('  stdin ↓');
    say(indent(texts.resumeAsk, '    '));

    say(sep('10번 — read-only 쓰기 시도'));
    say(`  ${renderCommand(opt.codex, execResumeArgs(opt, '<threadId>', 'read-only', path.join(outDir, RESUME_FILES.writeRo)))}`);
    say('  stdin ↓');
    say(indent(texts.resumeWrite, '    '));

    if (opt.control) {
        say(sep('10번 대조군 — workspace-write 쓰기 시도 (이쪽은 실제로 써져야 대조가 성립한다)'));
        say(`  ${renderCommand(opt.codex, execResumeArgs(opt, '<threadId>', 'workspace-write', path.join(outDir, RESUME_FILES.control)))}`);
        say('  stdin ↓');
        say(indent(texts.resumeControl, '    '));
    } else {
        say(sep('10번 대조군 — --no-control 로 꺼져 있다'));
    }

    say(sep('1턴 프롬프트 원문'));
    say(indent(texts.turn1, '    '));
    say(sep('steer 문장 원문'));
    say(indent(texts.steer, '    '));

    const checks = new Checks(opt.busySeconds);
    for (const n of Object.keys(CHECK_TITLES)) checks.unknown(Number(n), 'dry-run — 실제로 돌리지 않았다');
    say(sep('판정표 형식 (dry-run 이라 전부 미판정)'));
    say(checks.render());
}

function dumpMsg(o) { say(indent(JSON.stringify(o, null, 2), '  ')); }
function indent(s, pad) { return s.split('\n').map((l) => pad + l).join('\n'); }

// ══════════════════════════════════════════════════════════════════════════
// 10. 파라미터 조립 (dry-run 과 실행이 같은 함수를 쓴다 — 어긋나면 픽스처의 뜻이 없다)
// ══════════════════════════════════════════════════════════════════════════

function initializeParams(opt) {
    const p = { clientInfo: { name: 'claude-state-bar-steer-fixture', version: '0.1.0' } };
    // turn/steer 는 experimental 게이팅 밖이라 기본은 끈다. 다른 experimental 필드를 볼 때만 켠다.
    if (opt.experimentalApi) p.capabilities = { experimentalApi: true };
    return p;
}

function threadStartParams(opt, workDir) {
    const p = { cwd: workDir, sandbox: opt.sandbox, approvalPolicy: opt.approval };
    if (opt.model) p.model = opt.model;
    return p;
}

function turnStartParams(threadId, text) {
    return { threadId, input: [{ type: 'text', text }] };
}

function steerParams(threadId, expectedTurnId, text) {
    return { threadId, expectedTurnId, input: [{ type: 'text', text }] };
}

// ══════════════════════════════════════════════════════════════════════════
// 11. 실행 본체
// ══════════════════════════════════════════════════════════════════════════

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    if (opt.help) { say(HELP); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = opt.out ? path.resolve(opt.out) : path.join(os.tmpdir(), 'codex-steer-fixture', stamp);
    const workDir = path.join(outDir, 'work');
    const texts = buildTexts(opt);

    if (opt.dryRun) { dryRun(opt, texts, outDir, workDir); return; }

    fs.mkdirSync(workDir, { recursive: true });
    const log = new Log(outDir, false);
    const checks = new Checks(opt.busySeconds);

    say(`출력 : ${outDir}`);
    say(`작업 : ${workDir}`);
    say(`센티넬 ${texts.sentinel} · steer 토큰 ${texts.steerToken}\n`);

    // codex 는 git 레포 밖을 꺼린다. exec 쪽은 --skip-git-repo-check 로 넘기지만 app-server 에는
    // 그 스위치가 없으므로 작업 디렉토리를 레포로 만들어 두고 시작한다.
    try {
        cp.execFileSync('git', ['init', '-q'], { cwd: workDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(workDir, 'README.txt'), 'codex steer fixture workspace\n');
    } catch (e) {
        say(`⚠️ git init 실패 — 레포가 아닌 디렉토리에서 돈다: ${e && e.message}`);
    }

    let server = null;
    let conn1 = null, conn2 = null;
    let aborted = null;
    const state = {
        threadId: null,
        sessionId: null,
        turnIdFromResponse: null,
        turnIdFromNotification: null,
        turnStartedCount: 0,
        turnStartedAfterSteer: 0,
        conn2TurnStarted: 0,
        conn2TurnCompleted: 0,
        turnCompleted: null,
        serverExited: null,
        agentMessages: [],
        firstItemMs: null,
        firstCommandItemMs: null,
        steerSentMs: null,
        turnStartedMs: null,
        turnStartRespMs: null,
        steerAcceptedTurnId: null,
        rejoined: false
    };

    try {
        // ── 서버 기동 ──────────────────────────────────────────────
        const args = appServerArgs(opt);
        log.mark('app-server spawn', { cmd: renderCommand(opt.codex, args) });
        server = spawnTracked(
            IS_WIN ? quoteForShell(opt.codex) : opt.codex,
            IS_WIN ? args.map(quoteForShell) : args,
            { stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true }
        );
        // 🔴 stderr 는 통째로 버린다 (계정 정보가 섞일 수 있다).
        let serverStderrBytes = 0;
        server.stderr.on('data', (d) => { serverStderrBytes += d.length; });
        // 콜백 안에서 throw 하면 uncaughtException 으로 새 버리므로 상태로만 남기고 아래에서 본다.
        server.on('error', (e) => { state.serverExited = `spawn 실패: ${e.message}`; });
        server.on('exit', (code, sig) => {
            if (state.serverExited === null) state.serverExited = `code=${code} sig=${sig}`;
            log.mark('app-server 종료 감지', { code, sig });
        });

        if (opt.transport === 'ws') {
            const url = `ws://127.0.0.1:${opt.port}`;
            // ws 리슨은 stdout 에 준비 신호를 안 줄 수 있어, 붙어질 때까지 재시도한다.
            // 서버가 죽어 버렸으면 상한까지 기다리지 않고 바로 끝낸다.
            const deadline = Date.now() + opt.wsReadyTimeout * 1000;
            let ws = null, lastErr = null;
            while (Date.now() < deadline && state.serverExited === null) {
                try { ws = await connectWs(url, 2000); break; }
                catch (e) { lastErr = e; await delay(DEFAULTS.wsRetryMs); }
            }
            if (!ws) {
                const why = state.serverExited !== null
                    ? `app-server 가 먼저 죽었다 (${state.serverExited})`
                    : `${lastErr && lastErr.message}`;
                throw new Error(`ws 리슨에 붙지 못했다 (${url}): ${why}. --transport stdio 로 다시 돌려라`);
            }
            conn1 = new WsConn('conn1', ws, log);
            log.mark('conn1 ws 연결됨');
        } else {
            conn1 = new StdioConn('conn1', server, log);
            log.mark('conn1 stdio 연결됨');
        }

        const rpc1 = new Rpc(conn1, log);
        wireNotifications(conn1, log, state, opt);

        // ── 1. initialize ─────────────────────────────────────────
        log.mark('initialize 전송');
        const init = await rpc1.request('initialize', initializeParams(opt), 30000);
        log.mark('initialize 응답', { ok: !init.error });
        if (init.error) {
            checks.fail(1, `initialize 에러: ${JSON.stringify(init.error).slice(0, 300)}`);
            throw new Error('initialize 실패 — 이후 단계는 의미가 없다');
        }
        checks.pass(1, `왕복 ${init.at - init.sentAt}ms · result 키: ${Object.keys(init.result || {}).join(',') || '(없음)'}`);
        rpc1.notify('initialized', {});

        // ── 2. thread/start ───────────────────────────────────────
        log.mark('thread/start 전송');
        const ts = await rpc1.request('thread/start', threadStartParams(opt, workDir), 60000);
        log.mark('thread/start 응답', { ok: !ts.error });
        if (ts.error || !ts.result || !ts.result.thread) {
            checks.fail(2, `thread/start 실패: ${JSON.stringify(ts.error || ts.result).slice(0, 300)}`);
            throw new Error('thread/start 실패');
        }
        state.threadId = ts.result.thread.id;
        state.sessionId = ts.result.thread.sessionId;
        checks.pass(2, `threadId=${state.threadId} · sessionId=${state.sessionId} · 왕복 ${ts.at - ts.sentAt}ms`);
        checks.note(2, `model=${ts.result.model} · sandbox=${JSON.stringify(ts.result.sandbox)} · cwd=${ts.result.cwd}`);
        if (state.threadId !== state.sessionId) {
            checks.note(2, '🔴 threadId 와 sessionId 가 다르다 — 9번에서 둘 다 resume 해 본다');
        }

        // ── 3~4. turn/start 후 명령 실행 중에 steer ────────────────
        // turn/start 응답과 turn/started 알림 중 어느 쪽이 먼저 오는지 측정한다 (스키마로는 확정 불가).
        let turnStartResp = null;
        const turnPromise = rpc1.request('turn/start', turnStartParams(state.threadId, texts.turn1), opt.turnTimeout * 1000);
        log.mark('turn/start 전송');
        // 🔴 이 프로미스를 await 로 잡지 않는다. turn/start 응답이 "턴 시작 즉시" 오는 형태라면
        //    그걸 종료 신호로 쓰는 순간 45초짜리 턴을 안 기다리고 판정해 버린다.
        //    종료는 turn/completed 알림, 또는 응답에 실린 turn.status 가 inProgress 가 아닐 때로만 본다.
        turnPromise.then((r) => {
            turnStartResp = r;
            state.turnStartRespMs = log.ms();
            if (r.result && r.result.turn) state.turnIdFromResponse = r.result.turn.id;
            log.mark('turn/start 응답', {
                turnId: state.turnIdFromResponse,
                status: r.result && r.result.turn && r.result.turn.status,
                error: r.error ? JSON.stringify(r.error).slice(0, 200) : undefined
            });
        }).catch((e) => { log.mark('turn/start 실패', { error: String(e && e.message ? e.message : e) }); });

        // turnId 는 요구사항대로 turn/started 알림에서 잡는다.
        const turnId = await waitFor(() => state.turnIdFromNotification || state.turnIdFromResponse, 60000, 50);
        if (!turnId) {
            checks.fail(3, 'turn/started 알림도 turn/start 응답도 60초 안에 turnId 를 주지 않았다');
            throw new Error('turnId 를 잡지 못했다');
        }
        const orderNote = state.turnStartedMs !== null && state.turnStartRespMs !== null
            ? (state.turnStartedMs < state.turnStartRespMs
                ? `turn/started 알림이 먼저 (${state.turnStartedMs}ms) → turn/start 응답 (${state.turnStartRespMs}ms)`
                : `turn/start 응답이 먼저 (${state.turnStartRespMs}ms) → turn/started 알림 (${state.turnStartedMs}ms)`)
            : (state.turnStartedMs !== null
                ? `turn/started 알림만 도착 (${state.turnStartedMs}ms) — turn/start 응답은 아직 (턴이 끝난 뒤 오는 형태로 보인다)`
                : `turn/start 응답만 도착 (${state.turnStartRespMs}ms)`);
        checks.note(3, `순서: ${orderNote}`);
        log.mark('turnId 확보', { turnId, from: state.turnIdFromNotification ? 'turn/started' : 'turn/start 응답' });

        // 두 번째 연결은 **미리** 열어 둔다. 명령이 돌기 시작한 뒤에 연결·initialize 까지 하면
        // 그 왕복 시간만큼 steer 가 늦어져, "실행 중에 끼어들었다"는 측정이 흐려진다.
        let rpc2 = null;
        if (opt.transport === 'ws') {
            const ws2 = await connectWs(`ws://127.0.0.1:${opt.port}`, 10000);
            conn2 = new WsConn('conn2', ws2, log);
            rpc2 = new Rpc(conn2, log);
            wireNotifications(conn2, log, state, opt, true);
            log.mark('conn2 ws 연결됨');
            const init2 = await rpc2.request('initialize', initializeParams(opt), 30000);
            if (init2.error) throw new Error(`conn2 initialize 실패: ${JSON.stringify(init2.error).slice(0, 200)}`);
            rpc2.notify('initialized', {});
            log.mark('conn2 initialize 완료 (steer 대기 중)');
        } else {
            rpc2 = rpc1;
            checks.unknown(4, 'transport=stdio — 연결이 하나뿐이라 "두 번째 연결" 자체를 검증하지 못했다 (같은 연결에서 steer 를 보냈다)');
        }

        // 명령이 실제로 돌기 시작할 때까지 기다린다 — "실행 중에" 끼어드는 것이 요구사항이다.
        const gotCmd = await waitFor(() => state.firstCommandItemMs !== null, opt.steerAfterMaxMs, 50);
        if (gotCmd) {
            checks.note(4, `명령 item 이 ${state.firstCommandItemMs}ms 에 시작된 뒤 steer 를 보냈다`);
        } else {
            checks.note(4, `⚠️ 명령 item 알림을 ${opt.steerAfterMaxMs}ms 안에 못 봐서 상한에 걸려 steer 를 보냈다 — 실행 중이었는지 불확실하다`);
        }

        state.steerSentMs = log.ms();
        log.mark('turn/steer 전송', { expectedTurnId: turnId, conn: opt.transport === 'ws' ? 'conn2' : 'conn1' });
        let steerRes = await rpc2.request('turn/steer', steerParams(state.threadId, turnId, texts.steer), 60000);
        log.mark('turn/steer 응답', { ok: !steerRes.error, turnId: steerRes.result && steerRes.result.turnId });

        // 별도 연결이 그 thread 를 모를 수도 있다. 그때만 rejoin 하고 다시 쏜다.
        // (폴백 정책이 아니라 실측 항목이다 — 둘 다 결과를 남긴다)
        if (steerRes.error && opt.transport === 'ws') {
            checks.note(5, `1차 steer 거부: ${JSON.stringify(steerRes.error).slice(0, 300)}`);
            log.mark('conn2 thread/resume 시도 (rejoin)');
            const rj = await rpc2.request('thread/resume', { threadId: state.threadId }, 60000);
            log.mark('conn2 thread/resume 응답', { ok: !rj.error });
            if (!rj.error) {
                state.rejoined = true;
                state.steerSentMs = log.ms();
                log.mark('turn/steer 재전송 (rejoin 후)');
                steerRes = await rpc2.request('turn/steer', steerParams(state.threadId, turnId, texts.steer), 60000);
                log.mark('turn/steer 재전송 응답', { ok: !steerRes.error });
            } else {
                checks.note(5, `rejoin 도 실패: ${JSON.stringify(rj.error).slice(0, 300)}`);
            }
        }

        if (opt.transport === 'ws') {
            checks.pass(4, `conn2(별도 WebSocket)에서 turn/steer 를 ${state.steerSentMs}ms 에 보냈다${state.rejoined ? ' (thread/resume 으로 rejoin 한 뒤)' : ' (rejoin 없이 바로)'}`);
        }

        // 🔴 타임아웃을 "거부"로 읽지 않는다. 무응답과 거부는 전혀 다른 결론이다.
        if (steerRes.timedOut) {
            checks.unknown(5, 'turn/steer 에 60초 동안 응답이 없었다 — 거부인지 무응답인지 가릴 수 없다');
        } else if (steerRes.error) {
            checks.fail(5, `steer 거부: ${JSON.stringify(steerRes.error).slice(0, 400)}`);
        } else if (steerRes.result && steerRes.result.turnId === turnId) {
            state.steerAcceptedTurnId = steerRes.result.turnId;
            checks.pass(5, `수락 · 응답 turnId=${steerRes.result.turnId} = expectedTurnId · 왕복 ${steerRes.at - steerRes.sentAt}ms`);
        } else {
            state.steerAcceptedTurnId = steerRes.result && steerRes.result.turnId;
            checks.fail(5, `수락됐지만 turnId 가 다르다: 응답=${steerRes.result && steerRes.result.turnId} vs 기대=${turnId}`);
        }
        const steerMark = log.ms();

        // ── 6~7. 턴 완료 대기 ─────────────────────────────────────
        const finishedRespTurn = () => {
            const t = turnStartResp && turnStartResp.result && turnStartResp.result.turn;
            return t && t.status && t.status !== 'inProgress' ? t : null;
        };
        const ended = await waitFor(
            () => (state.turnCompleted !== null ? 'turn/completed 알림' : (finishedRespTurn() ? 'turn/start 응답(status 종료)' : null)),
            opt.turnTimeout * 1000,
            200
        );
        log.mark('턴 종료 감지', { via: ended || '타임아웃' });
        // 알림과 응답 중 늦게 오는 쪽이 있을 수 있어 잠깐 더 흘려 보낸다.
        await waitFor(() => state.turnCompleted !== null, 15000, 200);

        const turnObj = state.turnCompleted || finishedRespTurn() || null;
        const finalText = collectFinalText(state, turnObj);
        if (turnObj) {
            const dur = turnObj.durationMs !== null && turnObj.durationMs !== undefined
                ? turnObj.durationMs
                : (turnObj.completedAt && turnObj.startedAt ? (turnObj.completedAt - turnObj.startedAt) * 1000 : null);
            checks.note(3, `turn.status=${turnObj.status}${dur !== null ? ` · durationMs=${dur}` : ''}`);
            const longEnough = (dur !== null && dur >= opt.busySeconds * 1000) ||
                (state.turnStartedMs !== null && log.ms() - state.turnStartedMs >= opt.busySeconds * 1000);
            if (longEnough) checks.pass(3, `턴이 ${opt.busySeconds}초 이상 돌았고 steer 는 그 사이(${steerMark}ms)에 나갔다`);
            else checks.fail(3, `턴이 ${opt.busySeconds}초를 못 채웠다 — 명령을 안 돌렸거나 즉시 끝냈다. 프롬프트를 확인해라`);
        } else {
            checks.fail(3, 'turn/completed 를 못 봤다 (타임아웃)');
        }

        if (finalText === null) {
            checks.fail(6, '최종 assistant 메시지를 못 잡았다 — rpc.jsonl 의 item/completed 를 직접 봐라');
        } else if (finalText.toUpperCase().includes(texts.steerToken)) {
            checks.pass(6, `최종 메시지에 steer 토큰 ${texts.steerToken} 이 그대로 들어 있다`);
        } else {
            checks.fail(6, `최종 메시지에 ${texts.steerToken} 이 없다 — RPC 는 성공했지만 모델에는 안 닿았다는 뜻이다`);
        }
        if (finalText !== null) {
            checks.note(6, `최종 메시지 ${finalText.length}자 · 앞 200자: ${JSON.stringify(finalText.slice(0, 200))}`);
        }

        if (state.turnStartedAfterSteer === 0) {
            checks.pass(7, `conn1 기준 steer 이후 turn/started 알림 0개 (전체 ${state.turnStartedCount}개)`);
        } else {
            checks.fail(7, `steer 이후 turn/started 알림이 ${state.turnStartedAfterSteer}개 더 왔다 — 새 턴이 생겼다는 뜻이다`);
        }
        if (opt.transport === 'ws') {
            checks.note(7, `conn2 도 turn/started 를 ${state.conn2TurnStarted}개 받았다 (${state.conn2TurnStarted > 0 ? '알림은 연결마다 브로드캐스트된다' : '알림은 시작한 연결에만 간다'}) — 집계에는 넣지 않았다`);
        }

        // ── 8. 완료된 턴에 다시 steer ─────────────────────────────
        log.mark('완료 후 turn/steer 재전송 (거부 기대)');
        const late = await rpc2.request('turn/steer', steerParams(state.threadId, turnId, texts.steer), 30000);
        log.mark('완료 후 turn/steer 응답', { ok: !late.error });
        if (late.timedOut) checks.unknown(8, '재전송에 응답이 없었다(타임아웃) — 거부인지 무응답인지 못 가린다');
        else if (late.error) checks.pass(8, `기대대로 거부: ${JSON.stringify(late.error).slice(0, 300)}`);
        else checks.fail(8, `거부되지 않고 수락됐다: ${JSON.stringify(late.result).slice(0, 300)} — expectedTurnId 가 방어선이 아니라는 뜻이다`);

        // 서버 stderr 는 버렸지만 "왔는지"는 남긴다.
        if (serverStderrBytes > 0) checks.note(1, `app-server stderr ${serverStderrBytes}바이트 — 내용은 계정 정보 우려로 버렸다`);

    } catch (e) {
        aborted = String(e && e.message ? e.message : e);
        say(`\n🔴 중단: ${aborted}`);
        log.mark('중단', { error: aborted });
    } finally {
        try { if (conn2) conn2.close(); } catch { /* */ }
        try { if (conn1) conn1.close(); } catch { /* */ }
        if (server) { killTree(server); log.mark('app-server 종료(killTree)'); }
    }

    // ── 9~10. app-server 를 죽인 뒤 exec resume ───────────────────
    if (opt.skipResume) {
        checks.unknown(9, '--skip-resume 으로 건너뛰었다');
        checks.unknown(10, '--skip-resume 으로 건너뛰었다');
    } else if (!state.threadId) {
        checks.unknown(9, 'threadId 가 없어 resume 을 시도조차 못 했다');
        checks.unknown(10, '위와 같음');
    } else {
        await runResumePhase(opt, texts, state, checks, log, outDir, workDir);
    }

    // ── 보고 ─────────────────────────────────────────────────────
    const report = [
        '════════════ steer-fixture 판정 ════════════',
        `codex        : ${opt.codex}`,
        `transport    : ${opt.transport}${opt.transport === 'ws' ? ` ws://127.0.0.1:${opt.port}` : ''}`,
        `threadId     : ${state.threadId || '(없음)'}`,
        `sessionId    : ${state.sessionId || '(없음)'}`,
        `센티넬       : ${texts.sentinel}`,
        `steer 토큰   : ${texts.steerToken}`,
        `작업 디렉토리: ${workDir}`,
        aborted ? `🔴 중간에 끊겼다  : ${aborted}` : '완주        : 예외 없이 끝까지 돌았다',
        '',
        checks.render(),
        '',
        '──────── 타임라인 ────────',
        log.renderTimeline(),
        '',
        `원문 로그: ${log.rpcPath}`
    ].join('\n');

    fs.writeFileSync(path.join(outDir, 'report.txt'), report + '\n');
    fs.writeFileSync(path.join(outDir, 'verdict.json'), JSON.stringify({
        at: new Date().toISOString(),
        options: opt,
        aborted,
        threadId: state.threadId,
        sessionId: state.sessionId,
        sentinel: texts.sentinel,
        steerToken: texts.steerToken,
        checks: checks.toJSON(),
        timeline: log.marks
    }, null, 2) + '\n');

    say('\n' + report);
    say(`\n판정 저장: ${path.join(outDir, 'verdict.json')}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 12. 알림 처리
// ══════════════════════════════════════════════════════════════════════════

// 🔴 isSecond=true(conn2)는 **집계에 넣지 않는다.** app-server 가 알림을 두 연결 모두에
//    브로드캐스트하면 turn/started 가 두 번 세어져 7번이 그냥 오판된다. conn2 쪽 알림은
//    별도 카운터에 담아 "브로드캐스트인지"만 사실로 남긴다.
function wireNotifications(conn, log, state, opt, isSecond) {
    conn.on('notification', (msg) => {
        const p = msg.params || {};
        if (isSecond) {
            if (msg.method === 'turn/started') {
                state.conn2TurnStarted++;
                log.mark('turn/started 알림 (conn2 · 집계 제외)', { turnId: p.turn && p.turn.id, n: state.conn2TurnStarted });
            } else if (msg.method === 'turn/completed') {
                state.conn2TurnCompleted++;
                log.mark('turn/completed 알림 (conn2 · 집계 제외)', { status: p.turn && p.turn.status });
            }
            return;
        }
        switch (msg.method) {
            case 'turn/started': {
                state.turnStartedCount++;
                if (state.steerSentMs !== null) state.turnStartedAfterSteer++;
                if (!state.turnIdFromNotification && p.turn && p.turn.id) {
                    state.turnIdFromNotification = p.turn.id;
                    state.turnStartedMs = log.ms();
                }
                log.mark(`turn/started 알림 (${conn.name})`, { turnId: p.turn && p.turn.id, n: state.turnStartedCount });
                break;
            }
            case 'turn/completed': {
                if (!state.turnCompleted) state.turnCompleted = p.turn || null;
                log.mark(`turn/completed 알림 (${conn.name})`, { turnId: p.turn && p.turn.id, status: p.turn && p.turn.status });
                break;
            }
            case 'item/started': {
                if (state.firstItemMs === null) {
                    state.firstItemMs = log.ms();
                    log.mark('첫 item 알림', { type: p.item && p.item.type });
                }
                const t = p.item && p.item.type;
                if ((t === 'commandExecution' || t === 'sleep') && state.firstCommandItemMs === null) {
                    state.firstCommandItemMs = log.ms();
                    log.mark('명령 item 시작', { type: t, command: p.item && p.item.command });
                }
                break;
            }
            case 'item/completed': {
                if (p.item && p.item.type === 'agentMessage' && typeof p.item.text === 'string') {
                    state.agentMessages.push(p.item.text);
                }
                if (p.item && p.item.type === 'commandExecution') {
                    log.mark('명령 item 완료', { exitCode: p.item.exitCode, durationMs: p.item.durationMs });
                }
                break;
            }
            case 'thread/tokenUsage/updated':
            case 'item/agentMessage/delta':
            case 'item/reasoning/textDelta':
            case 'item/reasoning/summaryTextDelta':
            case 'item/commandExecution/outputDelta':
                break; // 잡음. 원문은 rpc.jsonl 에 다 있다
            case 'error':
                log.mark(`error 알림 (${conn.name})`, { message: String(p.message || '').slice(0, 200) });
                break;
            default:
                break;
        }
    });
    conn.on('serverRequest', (msg) => {
        // approvalPolicy=never 인데도 오면 그 자체가 발견이다.
        log.mark(`⚠️ 서버 요청 도착 (${conn.name}) — 응답하지 않는다`, { method: msg.method, id: msg.id });
    });
}

function collectFinalText(state, turnObj) {
    if (state.agentMessages.length > 0) return state.agentMessages[state.agentMessages.length - 1];
    if (turnObj && Array.isArray(turnObj.items)) {
        const msgs = turnObj.items.filter((i) => i && i.type === 'agentMessage' && typeof i.text === 'string');
        if (msgs.length > 0) return msgs[msgs.length - 1].text;
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 13. resume 단계 (9·10번)
// ══════════════════════════════════════════════════════════════════════════

async function runResumePhase(opt, texts, state, checks, log, outDir, workDir) {
    // 9번 — 센티넬 회수. threadId 로 먼저 하고, 실패하면 sessionId 로도 해 본다.
    // (Thread 스키마상 id 와 sessionId 가 별개라, exec 가 어느 쪽을 받는지는 실측해야 안다)
    const candidates = [];
    candidates.push({ label: 'threadId', id: state.threadId });
    if (state.sessionId && state.sessionId !== state.threadId) candidates.push({ label: 'sessionId', id: state.sessionId });

    let ok = false;
    // 10번도 "이어지는 게 확인된 id" 로 돌려야 한다. 9번이 sessionId 로만 됐는데 10번을 threadId 로
    // 돌리면, 실패가 권한 때문인지 id 때문인지 못 가린다.
    let resumeId = state.threadId;
    for (const c of candidates) {
        const lastPath = path.join(outDir, RESUME_FILES.ask(c.label));
        const evPath = path.join(outDir, RESUME_FILES.askEvents(c.label));
        log.mark(`exec resume 시작 (${c.label})`, { id: c.id });
        const r = await runExec(opt, execResumeArgs(opt, c.id, 'read-only', lastPath), texts.resumeAsk, workDir, evPath, opt.resumeTimeout * 1000);
        log.mark(`exec resume 종료 (${c.label})`, { code: r.code, timedOut: r.timedOut });

        const last = readIfExists(lastPath);
        const evThread = extractThreadId(readIfExists(evPath) || '');
        if (r.code !== 0 || last === null) {
            checks.note(9, `${c.label}(${c.id}) 로 resume: exit=${r.code}${r.timedOut ? ' (타임아웃)' : ''} · 최종 메시지 ${last === null ? '없음' : '있음'}`);
            continue;
        }
        checks.note(9, `${c.label} resume exit=0 · exec 이벤트의 thread_id=${evThread || '(못 잡음)'}`);
        if (last.toUpperCase().includes(texts.sentinel)) {
            checks.pass(9, `${c.label}(${c.id}) 로 resume 했더니 센티넬 ${texts.sentinel} 을 그대로 답했다 — 맥락이 이어진다`);
            checks.note(9, `최종 메시지: ${JSON.stringify(last.trim().slice(0, 200))}`);
            ok = true;
            resumeId = c.id;
            break;
        }
        checks.note(9, `${c.label} 응답에 센티넬이 없다: ${JSON.stringify(last.trim().slice(0, 200))}`);
    }
    if (!ok && checks.items.get(9).state !== 'PASS') {
        checks.fail(9, '🔴 어떤 id 로도 센티넬을 회수하지 못했다 — app-server 로 시작한 스레드는 codex exec resume 으로 이어지지 않는다');
    }

    // 10번 — read-only 로 쓰기가 막히는지 + 대조군
    const roLast = path.join(outDir, RESUME_FILES.writeRo);
    const roEv = path.join(outDir, RESUME_FILES.writeRoEvents);
    log.mark('exec resume 쓰기 시도 (read-only)', { id: resumeId });
    const ro = await runExec(opt, execResumeArgs(opt, resumeId, 'read-only', roLast), texts.resumeWrite, workDir, roEv, opt.resumeTimeout * 1000);
    const roFile = fs.existsSync(path.join(workDir, texts.probeReadonlyName));
    log.mark('exec resume 쓰기 종료 (read-only)', { code: ro.code, created: roFile });
    checks.note(10, `read-only resume(id=${resumeId}): exit=${ro.code} · ${texts.probeReadonlyName} ${roFile ? '생성됨(🔴 경계가 깨졌다)' : '미생성'}`);
    if (!ok) checks.note(10, '⚠️ 9번이 실패한 상태라 이 턴이 같은 대화를 이어받았는지부터 불확실하다');

    let controlWrote = null;
    if (opt.control) {
        const cLast = path.join(outDir, RESUME_FILES.control);
        const cEv = path.join(outDir, RESUME_FILES.controlEvents);
        log.mark('exec resume 쓰기 시도 (workspace-write 대조군)');
        const ct = await runExec(opt, execResumeArgs(opt, resumeId, 'workspace-write', cLast), texts.resumeControl, workDir, cEv, opt.resumeTimeout * 1000);
        controlWrote = fs.existsSync(path.join(workDir, texts.probeControlName));
        log.mark('exec resume 쓰기 종료 (대조군)', { code: ct.code, created: controlWrote });
        checks.note(10, `대조군(workspace-write): exit=${ct.code} · ${texts.probeControlName} ${controlWrote ? '생성됨' : '미생성'}`);
    }

    if (roFile) {
        checks.fail(10, 'read-only 를 줬는데도 파일이 생겼다 — resume 에 권한 경계가 안 걸린다');
    } else if (opt.control && controlWrote === true) {
        checks.pass(10, 'read-only 는 못 쓰고 workspace-write 는 썼다 — 대조군까지 성립');
    } else if (opt.control && controlWrote === false) {
        checks.unknown(10, '대조군에서도 파일이 안 생겼다 — 모델이 시도를 안 했을 수 있어 "권한 때문"이라고 단정할 수 없다');
    } else {
        checks.unknown(10, '--no-control 이라 대조군이 없다 — 파일이 없는 이유가 권한인지 모델 판단인지 못 가린다');
    }
}

function runExec(opt, args, promptStdin, cwd, eventsPath, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawnTracked(
            IS_WIN ? quoteForShell(opt.codex) : opt.codex,
            IS_WIN ? args.map(quoteForShell) : args,
            { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true }
        );
        let out = '';
        let stderrBytes = 0;
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            killTree(child);
            if (eventsPath) fs.writeFileSync(eventsPath, out);
            resolve({ code: -1, timedOut: true, stderrBytes });
        }, timeoutMs);

        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        // 🔴 stderr 는 여기서도 버린다.
        child.stderr.on('data', (d) => { stderrBytes += d.length; });
        child.on('error', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code: -2, timedOut: false, stderrBytes });
        });
        child.on('exit', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (eventsPath) fs.writeFileSync(eventsPath, out);
            resolve({ code, timedOut: false, stderrBytes });
        });

        try {
            child.stdin.write(promptStdin);
            child.stdin.end();
        } catch { /* pipe closed */ }
    });
}

// send.sh 452~456행과 같은 패턴 — 공백을 허용한다.
function extractThreadId(text) {
    const m = /"thread_id"\s*:\s*"([^"]+)"/.exec(text);
    return m ? m[1] : null;
}

function readIfExists(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeoutMs, stepMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() >= deadline) return null;
        await delay(stepMs);
    }
}

main().catch((e) => {
    process.stderr.write(`steer-fixture: ${e && e.stack ? e.stack : e}\n`);
    killAll();
    process.exit(1);
});
