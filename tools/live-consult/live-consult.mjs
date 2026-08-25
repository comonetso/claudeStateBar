#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// live-consult.mjs — codex app-server 기반 CONSULT 실행기 (CLI 진입점)
//
// 왜 만드는가 — 기존 CONSULT 는 `codex exec` 배치라서 한 번 던지면 끝날 때까지
// 아무것도 끼워 넣을 수 없었다. app-server 의 `turn/steer` 는 실행 중인 턴에
// 새 입력을 같은 turnId 로 밀어 넣을 수 있다(2026-08-25 실측 9/10 통과).
// 이 파일은 그 왕복을 감싸서 **기존 산출물(events.jsonl · last_message.md)을
// 그대로 남기는** 얼굴을 유지한다. send.sh 와 확장(claudeStateBar)이 이미
// 그 두 파일을 읽고 있기 때문에, 전송 방식만 바꾸고 계약은 건드리지 않는다.
//
// 🔴 이 파일은 프로세스 오케스트레이션만 한다.
//    - ws/JSON-RPC 배관       → lib/appserver.mjs
//    - 알림 → exec 이벤트 변환 → lib/bridge.mjs
//    - 권위 상태·steer 큐      → lib/runtime.mjs
//    위 세 모듈은 다른 담당이 만든다. 여기서는 계약대로 부르기만 한다.
// ══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const CLI_NAME = 'live-consult';
const CLI_VERSION = '0.1.0';

// ══════════════════════════════════════════════════════════════════════════
// 1. 종료 코드 — 🔴 실패 경계를 여기서 못 박는다
//
// Codex 자문의 핵심 지적: "turn/start 전"과 "turn/start 후"는 **되돌릴 수 있는지**가
// 다르다. 전이면 Codex 가 아직 아무 일도 안 했으니 `codex exec` 로 되돌아가도 되고,
// 후면 이미 모델이 돌기 시작했으므로 fallback 은 **같은 요청의 이중 실행**이다.
// 그래서 호출자가 종료 코드만 보고 판단할 수 있게 번호대를 갈라 둔다.
//   10번대 = turn/start 이전   → fallback 해도 안전
//   20번대 = turn/start 이후   → 🔴 fallback 금지. 실패로 보고할 것
// ══════════════════════════════════════════════════════════════════════════
const EXIT = {
    OK: 0,
    GENERAL: 1,               // 그 밖의 실패. codex 를 띄우지 않는 서브커맨드 전용
    USAGE: 2,                 // 인자가 틀렸다. 아무것도 실행하지 않았다

    // ── 10번대: turn/start 전에 끝났다 → codex exec 로 fallback 가능 ──
    PRESTART_FAILED: 10,      // 서버 기동·initialize·thread/start 실패
    LIB_MISSING: 11,          // lib/*.mjs 가 없거나 로드 실패

    // ── 20번대: turn/start 후에 끝났다 → 🔴 fallback 금지 ──
    POSTSTART_FAILED: 20,     // 턴이 도는 중 연결이 끊기거나 서버가 죽었다
    TURN_FAILED: 21,          // turn/completed 가 status=failed 로 왔다
    TURN_TIMEOUT: 22,         // --turn-timeout 상한에 걸렸다 (기본은 무제한)

    // ── 30번대: steer 서브커맨드 ──
    STEER_REJECTED: 30,       // turn/steer 가 거부됐다 (사유를 그대로 출력한다)
    NO_RUNTIME: 31,           // 해당 stamp 의 실행이 없거나 이미 끝났다
    STEER_TIMEOUT: 32,        // 큐에 넣었지만 전달 확인을 못 받았다

    // ── 40번대: wait 서브커맨드 ──
    WAIT_TIMEOUT: 40          // 고신호 없이 상한에 도달했다
};

// ══════════════════════════════════════════════════════════════════════════
// 2. 🔴 결정 필요 — 근거 없는 임계치는 여기 모아 두고 README 에 그대로 노출한다
//
// 아래 값들은 사용자가 정한 정책이 아니라 "동작시키려면 뭐라도 필요해서" 넣은
// 잠정치다. 코드 곳곳에 흩어 두면 나중에 근거 있는 값처럼 보이므로 한곳에 모은다.
// 전부 CLI 옵션으로 덮을 수 있다.
// ══════════════════════════════════════════════════════════════════════════
const PENDING_DECISION = {
    // steer 큐를 얼마나 자주 확인할지. 짧으면 반응이 빠르고 디스크를 더 긁는다.
    steerPollMs: 1000,
    // steer 서브커맨드가 "전달됐다"는 확인을 기다리는 상한.
    // 🔴 큐에 넣은 것은 전달이 아니다. run 이 turn/steer 응답을 받아 결과를 남길 때까지 기다린다.
    steerConfirmTimeoutMs: 60_000,
    // wait 이 고신호 없이 버티는 상한. background 로 걸어 두는 용도라 길게 잡았다.
    waitTimeoutMs: 1_800_000,
    // wait / steer 가 결과 파일을 폴링하는 간격.
    // fs.watch 는 Windows 에서 누락이 보고돼 있어 폴링으로 간다.
    filePollMs: 500,
    // 턴 완료 대기 상한. 🔴 기본 0(무제한) — 기존 CONSULT 동작을 보존한다.
    //    send.sh 는 CR_TIMEOUT 을 2026-08-17 에 **제거**했다. Windows 에서 timeout 이
    //    codex 를 죽여도 네이티브 손자가 살아남아 아무것도 해결되지 않았기 때문이다.
    //    그 결론을 여기서 뒤집지 않는다.
    turnTimeoutMs: 0,
    // JSON-RPC 요청 하나의 왕복 상한. appserver.mjs 는 기본값을 지어내지 않고 호출자에게
    // 요구한다(상한 없는 대기 = 조용한 hang). 실측 왕복은 initialize 4ms · thread/start
    // 760ms · turn/start 3ms · turn/steer 2ms 라 여유가 크다.
    // 🔴 이 값은 **턴 길이와 무관하다** — turn/completed 는 알림으로 오지 응답이 아니다.
    requestTimeoutMs: 60_000
};

// ══════════════════════════════════════════════════════════════════════════
// 3. 고신호 이벤트 판정
//
// 🔴 무엇을 "판단이 필요한 순간"으로 볼지는 내가 정할 문제가 아니다. 그래서
//    Codex 자문이 제시한 후보를 **전부** 구현하고, 애매하면 깨우는 쪽으로 기울였다.
//    (놓쳐서 Codex 가 헛다리를 계속 짚는 비용 > 한 번 더 깨어나는 비용)
//    실제로 무엇이 잡히는지는 README 의 "고신호 목록"에 그대로 적혀 있다.
// ══════════════════════════════════════════════════════════════════════════

// 후보 ③ "자료가 없다/확인할 수 없다" 류.
// 🔴 이 목록은 잠정치다 — 사용자가 정한 것이 아니라 흔한 표현을 모은 것이다.
const BLOCKED_PHRASES = [
    // 한국어
    '자료가 없', '자료를 찾을 수 없', '확인할 수 없', '찾을 수 없', '접근할 수 없',
    '권한이 없', '정보가 부족', '자료가 부족', '더 필요', '알 수 없었', '읽을 수 없',
    // 영어
    'cannot find', 'could not find', 'unable to find', 'no such file',
    'unable to access', 'cannot access', 'permission denied', 'access denied',
    'not available', 'insufficient information', 'need more information',
    'i could not', 'i was unable', 'do not have access', "don't have access"
];

// 후보 ⑥ "요청서가 지정한 원본을 건너뛰고 최종화하려는 신호".
// app-server 는 최종 답변을 phase='final_answer' 로 구분해 준다(실측). 최종화가
// 시작되는 순간을 잡으면 "아직 안 봤는데 끝내려 한다"에 개입할 여지가 생긴다.
const FINALIZE_PHASE = 'final_answer';

// ══════════════════════════════════════════════════════════════════════════
// 4. 작은 유틸
// ══════════════════════════════════════════════════════════════════════════

function out(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }

class CliError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new CliError(code, message); }

function nowIso() { return new Date().toISOString(); }

// 부모 디렉토리까지 만들고 append 한다. 로그가 목적이라 실패해도 실행을 멈추지 않는다 —
// 감사 로그를 못 써서 조사 자체를 날리는 것이 더 나쁘다.
function appendLine(file, text) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
    } catch { /* 로그는 best-effort */ }
}

function appendJson(file, obj) {
    if (!file) return;
    appendLine(file, JSON.stringify(obj));
}

// Codex 에 넘기는 경로는 Windows 형식이어야 한다. send.sh 의 winp() 와 같은 처리다
// (`cygpath -m` → 슬래시 형태의 Windows 경로). cygpath 가 없으면 원본을 그대로 쓴다 —
// 이미 Windows 경로로 들어온 경우가 대부분이라 그쪽이 덜 망가진다.
function winPath(p) {
    if (!IS_WIN) return p;
    if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\\/g, '/');
    try {
        const r = cp.execFileSync('cygpath', ['-m', '--', p], { encoding: 'utf8' });
        return r.trim() || p;
    } catch { return p; }
}

// stdin 을 통째로 읽는다. `--input-file -` 용이다.
async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

// 🔴 긴 한글을 argv 로 넘기지 않는 이유 — Windows CreateProcess 는 커맨드라인을
//    32,767자로 자른다(실측: 32,000B 성공 / 32,700B 실패). 한글은 UTF-8 로 3바이트라
//    더 빨리 걸린다. 그래서 steer 본문은 **항상** 파일이나 stdin 으로만 받는다.
async function readTextInput(spec) {
    if (spec === '-') return await readStdin();
    if (!fs.existsSync(spec)) fail(EXIT.USAGE, `입력 파일이 없다: ${spec}`);
    return fs.readFileSync(spec, 'utf8');
}

// 포트 잡기는 appserver.mjs 가 한다(startAppServer 에 port 를 안 주면 알아서 빈 포트를 쓴다).
// 여기서 따로 잡으면 잡아 두고 닫는 사이에 남이 채가는 경쟁만 하나 더 만든다.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════
// 5. lib 로더
//
// 🔴 lib/*.mjs 는 다른 담당이 동시에 만들고 있다. 아직 없을 수 있으므로 **동적으로**
//    싣고, 없으면 --help / --dry-run 만이라도 돌아가게 한다. 실제 실행(run/steer/wait)
//    에서만 없음을 오류로 승격시킨다.
// ══════════════════════════════════════════════════════════════════════════
async function loadLib() {
    const mods = { appserver: null, bridge: null, runtime: null };
    const missing = [];
    for (const name of Object.keys(mods)) {
        const url = new URL(`./lib/${name}.mjs`, import.meta.url).href;
        try {
            mods[name] = await import(url);
        } catch (e) {
            missing.push({ name, reason: e && e.message ? e.message : String(e) });
        }
    }
    return { mods, missing };
}

function requireLib(mods, missing, needed) {
    const gone = needed.filter((n) => !mods[n]);
    if (gone.length === 0) return;
    const detail = missing
        .filter((m) => gone.includes(m.name))
        .map((m) => `  - lib/${m.name}.mjs : ${m.reason}`)
        .join('\n');
    fail(EXIT.LIB_MISSING,
        `필요한 모듈을 싣지 못했다 (${gone.join(', ')}).\n${detail}\n` +
        '아직 만들어지지 않았다면 --help / --dry-run 만 사용할 수 있다.');
}

// runtime.mjs 가 없을 때도 --dry-run 이 경로를 보여줄 수 있게 하는 폴백.
// 🔴 실제 실행에서는 절대 쓰지 않는다 — 권위 경로는 runtime.runtimePath() 하나뿐이고,
//    여기서 추정한 경로로 상태를 쓰면 steer 서브커맨드와 서로 다른 곳을 보게 된다.
function guessRuntimeDir(stamp) {
    // runtime.mjs 의 ROOT_DIRNAME 과 같은 값이다. 어긋나면 dry-run 이 실제와 다른 경로를
    // 보여줘 디버깅을 헷갈리게 한다. 실제 실행에서는 이 함수를 타지 않는다.
    return path.join(os.tmpdir(), 'live-consult', String(stamp));
}

// CLI 가 소유하는 유일한 보조 파일. runtime.mjs 는 상태·steer 큐·전달 결과까지 다루지만
// "무엇이 판단을 요하는 순간인가"는 CLI 의 판정이라 여기서 갖는다.
// 이름에 `cli-` 를 붙여 runtime 소유 파일과 섞이지 않게 한다.
const CLI_FILES = {
    // run 이 고신호로 판정한 이벤트만 추려서 쌓는다. wait 이 이걸 tail 한다.
    signals: (dir) => path.join(dir, 'cli-signals.jsonl')
};

// ══════════════════════════════════════════════════════════════════════════
// 6. 인자 파서 — 아주 단순한 `--key value` 만 받는다
// ══════════════════════════════════════════════════════════════════════════
// 🔴 값을 받지 않는 플래그는 명시해 둔다. 안 그러면 `--dry-run run` 처럼 썼을 때
//    `run` 이 --dry-run 의 "값"으로 먹혀 서브커맨드가 사라진다(도움말만 뜨고 끝난다).
//    사람이 실제로 밟는 함정이라 목록으로 못 박는다.
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'help', 'h', 'version']);

function parseArgs(argv) {
    const opts = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            let key, val;
            if (eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
            else {
                key = a.slice(2);
                const next = argv[i + 1];
                // 불리언으로 선언된 플래그는 다음 토큰을 절대 삼키지 않는다.
                if (BOOLEAN_FLAGS.has(key)) val = true;
                else if (next === undefined || next.startsWith('--')) val = true;
                else { val = next; i++; }
            }
            opts[key] = val;
        } else rest.push(a);
    }
    return { opts, rest };
}

function need(opts, key, code = EXIT.USAGE) {
    const v = opts[key];
    if (v === undefined || v === true || v === '') fail(code, `--${key} 가 필요하다`);
    return String(v);
}

// 🔴 stamp 를 경계에서 먼저 검증한다. runtime.mjs 도 자체 검증을 하지만, 거기서 throw 되면
//    "인자가 틀렸다"가 "예상 못 한 내부 오류"로 둔갑해 엉뚱한 종료 코드가 나간다.
//    (실측: 한글 stamp 를 넣었더니 아무것도 실행 안 했는데 fallback 금지 코드가 나왔다)
//    규칙은 runtime.mjs 와 같게 맞춘다 — 어긋나도 runtime 이 한 번 더 거르므로 안전한 쪽이다.
const STAMP_RE = /^[A-Za-z0-9_-]{1,64}$/;
function needStamp(opts) {
    const s = need(opts, 'stamp');
    if (!STAMP_RE.test(s)) {
        fail(EXIT.USAGE, `--stamp 는 영숫자·밑줄·하이픈 1~64자여야 한다: "${s}"`);
    }
    return s;
}

function numOpt(opts, key, dflt) {
    if (opts[key] === undefined || opts[key] === true) return dflt;
    const n = Number(opts[key]);
    if (!Number.isFinite(n) || n < 0) fail(EXIT.USAGE, `--${key} 는 0 이상의 숫자여야 한다: ${opts[key]}`);
    return n;
}

// ══════════════════════════════════════════════════════════════════════════
// 7. 프롬프트 조립
//
// 🔴 send.sh 의 CONSULT(KIND=doc) 프롬프트를 **그대로** 옮긴 것이다. 전송 방식만
//    바뀌었을 뿐 Codex 에게 주는 지시가 달라지면 그건 다른 기능이다. 문구를 손보고
//    싶으면 send.sh 와 함께 고쳐야 한다 — 한쪽만 바꾸면 두 경로의 결과가 갈린다.
//
// 백틱이 본문에 들어가므로 template literal 대신 배열 + join 으로 쓴다.
// ══════════════════════════════════════════════════════════════════════════
function buildConsultPrompt({ requestPathWin, scratchRel }) {
    return [
        '아래 요청서 파일을 읽고, 그 안에 적힌 지시를 그대로 따라라.',
        '',
        `요청서: ${requestPathWin}`,
        '',
        '너는 이 사건의 **독립 조사자**다. 요청서는 출발점이지 경계가 아니다.',
        'Claude 는 이미 그 안의 자료로 답을 못 찾았다. 같은 자료를 같은 방식으로 읽으면 같은 결론이 나온다.',
        '',
        '🔴 지켜야 할 선은 **하나**다 — 프로덕션 파일을 고치지 마라.',
        '',
        '- **코드를 고치지 마라.** 너는 분석·진단과 수정 방법 제시만 한다. 실제 수정은 Claude 가 한다.',
        '- 네가 쓸 수 있는 곳은 **정확히 두 곳**이다:',
        '    ① 요청서가 지정한 응답 문서',
        `    ② ${scratchRel}/    ← 네 작업대다`,
        '  이 둘 밖의 파일은 만들거나 고치거나 지우지 마라. 저장소 상태를 바꾸는 명령도 금지다',
        '  (git commit·checkout·stash·reset, 패키지 설치, 빌드).',
        '',
        '그 밖의 조사는 **막지 않는다. 끝까지 파라.**',
        '- **원본을 직접 열어라.** 디스크 어디든 읽어도 된다 — 워크스페이스 밖도 읽기는 허용돼 있다.',
        '  요청서에 인용된 조각만 믿지 마라. **요약과 원본이 어긋나면 원본이 이긴다.**',
        '- **계산·정렬·파싱·재집계를 직접 실행해라.** 스크립트를 짜서 돌려도 된다. 수치를 추측하지 말고 뽑아라.',
        '  그 산출물(스크립트·중간 데이터·메모)은 위 작업대에 **마음껏** 만들어라 — 개수·크기 제한이 없고',
        '  지우지 않아도 된다. 남겨 두면 Claude 가 네 계산을 재현할 수 있어 오히려 낫다.',
        '- **네트워크를 써도 된다** — 문서·이슈·릴리스노트를 검색하고 직접 확인해라.',
        '  단 **조회 전용**이다. 어디에도 데이터를 올리지 마라(POST/PUT·git push·publish 금지).',
        '  🔴 **자격증명을 읽지 마라.** SSH 키·`.env`·`credentials`·`auth.json`·토큰·비밀번호가 든 파일은',
        '     조사에 필요하더라도 **내용을 열지 마라.** 존재 여부와 경로까지만 확인해라.',
        '     네트워크가 열려 있으므로 **읽는 순간 나갈 수 있는 상태**가 된다 — 그래서 읽기 쪽을 막는다.',
        '     그런 값이 원인 규명에 꼭 필요하면 **"무엇이 왜 필요한지"만 응답에 적어라.** Claude 가 판단한다.',
        '- Claude 의 가설은 참고 자료다. **틀렸으면 버려라.** 그걸 검증하는 데 시간을 다 쓰지 마라 —',
        '  가설이 통째로 무의미할 수 있다. 원본이 다른 곳을 가리키면 그쪽을 쫓아가라.',
        '- "기존 분석법이 실패했다"는 **"그 데이터를 다시 보지 마라"는 뜻이 아니다.**',
        '  같은 원본을 다른 방법으로 분석하는 것은 언제나 허용이고, 대개 그게 정답이다.',
        '',
        '🔴 **막혔다고 포기하지 마라.** 이 실행에는 승인을 눌러 줄 사람이 없다(approval_policy=never).',
        '   권한이 필요해 보이면 기다리지 말고 위에 허용된 수단으로 우회해 조사를 끝내라.',
        '   그래도 못 하면 **무엇이 막혀 무엇을 확인하지 못했는지**를 응답에 명시해라.',
        '   확인 못 한 것을 확인한 척하지 마라.',
        '',
        '🔴 **지금 열 수 있는 자료를 남겨 둔 채 "자료를 더 달라"로 끝내지 마라.**',
        '   요청서에 경로가 있거나 워크스페이스에서 찾을 수 있는 것은 네가 직접 연다.',
        '   `ls`·`find` 로 목록만 본 것은 연 것이 아니다 — 내용을 읽고 계산까지 해야 연 것이다.',
        '',
        '- 요청서에 응답을 저장할 경로와 파일명이 명시되어 있다. 그 경로에 그 이름 그대로 저장해라.',
        '- 저장이 실패하면 같은 내용을 최종 메시지로 그대로 출력해라. 자동으로 회수된다.',
        '',
        '── 이 실행에만 해당하는 안내 ──────────────────────────────',
        '이 턴은 진행 중에 추가 지시가 들어올 수 있다(사용자가 곁에서 보고 있다).',
        '추가 지시가 도착하면 **지금 하던 명령을 재시작하지 말고** 이어서 반영해라.',
        ''
    ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// 8. 고신호 판정 — 알림 하나를 보고 "깨울 만한가"를 결정한다
//
// 반환: null 이면 평범한 이벤트, 아니면 {kind, summary, detail}
// ══════════════════════════════════════════════════════════════════════════
function classifySignal(note) {
    const m = note && note.method;
    const p = (note && note.params) || {};
    if (!m) return null;

    // ── 후보 ⑦ 턴 종료 ──
    if (m === 'turn/completed') {
        const st = (p.turn && p.turn.status) || 'unknown';
        return { kind: 'turn-ended', summary: `턴이 끝났다 (status=${st})`, detail: { status: st } };
    }

    // ── 후보 ④ waitingOnApproval ──
    // thread/status/changed 의 status.type 또는 activeFlags 에 승인 대기가 실린다.
    if (m === 'thread/status/changed') {
        const st = p.status || {};
        const flags = Array.isArray(st.activeFlags) ? st.activeFlags : [];
        const blob = JSON.stringify(st).toLowerCase();
        if (blob.includes('waitingonapproval') || blob.includes('approval')) {
            return {
                kind: 'waiting-approval',
                summary: '승인 대기 상태로 보인다 — 이 실행에는 승인할 사람이 없다',
                detail: { status: st.type || null, flags }
            };
        }
        return null;
    }

    // ── 아이템 기반 신호 ──
    if (m === 'item/started' || m === 'item/completed') {
        const item = p.item || {};
        const type = String(item.type || '');

        // 후보 ② 새 command 의 대상 경로.
        // item/started 에서만 잡는다 — 시작 시점에 알아야 개입할 여지가 있다.
        if (type === 'commandExecution' && m === 'item/started') {
            const cmd = String(item.command || '').slice(0, 400);
            return {
                kind: 'command-started',
                summary: `명령 실행: ${cmd.slice(0, 160)}`,
                detail: { command: cmd, cwd: item.cwd || null }
            };
        }

        // 후보 ② 확장 — 파일 변경 시도. 후보 목록에는 없지만 "대상 경로" 와 같은 취지고,
        // CONSULT 는 원래 프로덕션 파일을 못 고치게 돼 있으므로 여기서 어긋나면 즉시 알아야 한다.
        if (type === 'fileChange' && m === 'item/started') {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const paths = changes.map((c) => c && c.path).filter(Boolean);
            return {
                kind: 'file-change',
                summary: `파일 변경 시도: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` 외 ${paths.length - 3}건` : ''}`,
                detail: { paths }
            };
        }

        // 후보 ① 조사 계획 발표. app-server 는 계획을 todoList/plan 계열 아이템으로 낸다.
        // 정확한 타입명을 실측하지 못했으므로 이름에 plan/todo 가 들어가면 전부 잡는다(보수적).
        if (m === 'item/completed' && /plan|todo/i.test(type)) {
            return {
                kind: 'plan',
                summary: '조사 계획이 나왔다 — 방향이 맞는지 볼 시점이다',
                detail: { itemType: type, item }
            };
        }

        if (type === 'agentMessage' && m === 'item/completed') {
            const text = String(item.text || '');
            const phase = String(item.phase || '');

            // 후보 ⑥ 최종화 신호. 아직 원본을 안 봤는데 끝내려 하면 여기서 잡힌다.
            if (phase === FINALIZE_PHASE) {
                return {
                    kind: 'finalizing',
                    summary: '최종 답변을 쓰기 시작했다',
                    detail: { preview: text.slice(0, 300) }
                };
            }

            // 후보 ③ "자료가 없다/확인할 수 없다" 류.
            const low = text.toLowerCase();
            const hit = BLOCKED_PHRASES.find((ph) => low.includes(ph.toLowerCase()));
            if (hit) {
                return {
                    kind: 'blocked',
                    summary: `막혔다는 신호("${hit}") — 자료를 더 줄지 판단이 필요하다`,
                    detail: { phrase: hit, preview: text.slice(0, 300) }
                };
            }
        }
        return null;
    }

    return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 9. run — send.sh 가 부르는 본체
// ══════════════════════════════════════════════════════════════════════════
async function cmdRun(opts, lib) {
    const { mods, missing } = lib;

    const requestFile = need(opts, 'request-file');
    const runtimeDirOpt = opts['runtime-dir'];
    const eventsFile = need(opts, 'events-file');
    const lastMessageFile = need(opts, 'last-message-file');
    const appserverLog = need(opts, 'appserver-log');
    const steersLog = need(opts, 'steers-log');
    const stamp = needStamp(opts);
    const cwd = need(opts, 'cwd');

    // 🔴 기본은 read-only 다. 기존 CONSULT 가 Codex 를 자문역으로만 쓰기 때문이고,
    //    값이 안 넘어왔을 때 조용히 쓰기 권한을 주는 쪽으로 기우는 것은 fail-open 이다.
    const sandbox = opts['sandbox'] === undefined || opts['sandbox'] === true
        ? 'read-only' : String(opts['sandbox']);
    if (!['read-only', 'workspace-write'].includes(sandbox)) {
        fail(EXIT.USAGE, `--sandbox 는 read-only 또는 workspace-write 여야 한다: ${sandbox}`);
    }

    const scratchRel = opts['scratch-rel'] === undefined || opts['scratch-rel'] === true
        ? 'docs/codex_rescue/.scratch' : String(opts['scratch-rel']);
    const steerPollMs = numOpt(opts, 'steer-poll-ms', PENDING_DECISION.steerPollMs);
    const turnTimeoutMs = numOpt(opts, 'turn-timeout-ms', PENDING_DECISION.turnTimeoutMs);
    const requestTimeoutMs = numOpt(opts, 'request-timeout-ms', PENDING_DECISION.requestTimeoutMs);
    // UI 미러는 `.log/` **디렉토리**를 받는다 — 파일명은 runtime.writeLiveMirror 가 정한다.
    const logDir = opts['log-dir'] && opts['log-dir'] !== true ? String(opts['log-dir']) : null;

    if (!fs.existsSync(requestFile)) fail(EXIT.USAGE, `요청서가 없다: ${requestFile}`);
    if (!fs.existsSync(cwd)) fail(EXIT.USAGE, `작업 디렉토리가 없다: ${cwd}`);

    // 요청서 frontmatter 에서 카드에 쓸 두 값을 꺼낸다.
    //
    // 🔴 `subject` 가 없으면 확장이 카드 제목에 **slug 를 그대로 노출한다**
    //    (runDiscovery 는 `status.subject` 만 보고, 패널은 `run.subject || run.slug` 로 폴백한다).
    //    slug 는 파일명을 위한 영문 kebab 이라 목록에서 무슨 건인지 읽히지 않는다.
    const reqHead = (() => {
        try {
            const raw = fs.readFileSync(requestFile, 'utf8');
            const end = raw.indexOf('\n---', 3);
            return end > 0 ? raw.slice(0, end) : raw.slice(0, 2048);
        } catch { return ''; }
    })();
    const fmField = (key) => {
        const m = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(reqHead);
        const v = m ? m[1].replace(/\r$/, '').trim() : '';
        return v || '';
    };
    const reqSlug = fmField('slug');
    const reqSubject = fmField('subject');

    const prompt = buildConsultPrompt({ requestPathWin: winPath(requestFile), scratchRel });

    // ── dry-run: codex 를 부르지 않고 조립 결과만 보여준다 ──
    if (opts['dry-run']) {
        const dir = mods.runtime ? mods.runtime.runtimePath(stamp) : guessRuntimeDir(stamp);
        const port = opts['port'] === undefined || opts['port'] === true
            ? '(자동 — 빈 포트를 잡는다)' : Number(opts['port']);
        out('── DRYRUN (run) — codex 를 실행하지 않는다 ──');
        out('서브커맨드   : run');
        out(`스탬프       : ${stamp}`);
        out(`요청서       : ${requestFile}`);
        out(`요청서(win)  : ${winPath(requestFile)}`);
        out(`작업 디렉토리: ${cwd}`);
        out(`샌드박스     : ${sandbox}   (approvalPolicy=never 고정)`);
        out(`포트         : ${port}`);
        out('app-server   : codex app-server --listen ws://127.0.0.1:<port>' +
            (IS_WIN ? ' -c windows.sandbox=unelevated' : ''));
        out(`runtime 디렉토리: ${dir}${mods.runtime ? '' : '   (lib/runtime.mjs 미탑재 — 추정치다)'}`);
        if (mods.runtime) out(`  권위 상태   : ${mods.runtime.statePath(stamp)}`);
        out(`  고신호      : ${CLI_FILES.signals(dir)}`);
        out(`events       : ${eventsFile}`);
        out(`last_message : ${lastMessageFile}`);
        out(`appserver-log: ${appserverLog}`);
        out(`steers-log   : ${steersLog}`);
        out(`UI 미러      : ${logDir ? path.join(logDir, stamp + '_live.json') : '(--log-dir 미지정 — 쓰지 않는다)'}`);
        out(`steer 폴링   : ${steerPollMs}ms`);
        out(`요청 상한    : ${requestTimeoutMs}ms   (턴 길이와 무관 — RPC 왕복 상한이다)`);
        out(`턴 상한      : ${turnTimeoutMs === 0 ? '무제한 (기존 CONSULT 와 동일)' : turnTimeoutMs + 'ms'}`);
        if (runtimeDirOpt && runtimeDirOpt !== true) {
            out(`--runtime-dir 지정: ${runtimeDirOpt}`);
            out('  ⚠ 실제 위치는 runtime.mjs 가 정한다 — 이 값은 기록용이다');
        }
        if (missing.length) {
            out('');
            out('⚠ 아직 없는 모듈:');
            for (const m of missing) out(`  - lib/${m.name}.mjs`);
        }
        out('');
        out('── 프롬프트 ──');
        out(prompt);
        return EXIT.OK;
    }

    requireLib(mods, missing, ['appserver', 'bridge', 'runtime']);
    const { startAppServer } = mods.appserver;
    const bridge = mods.bridge;
    const runtime = mods.runtime;

    const runtimeDir = runtime.runtimePath(stamp);
    const signalsFile = CLI_FILES.signals(runtimeDir);
    fs.mkdirSync(runtimeDir, { recursive: true });

    const nonce = runtime.makeNonce();
    const t0 = Date.now();

    // 권위 상태를 먼저 세운다. steer 서브커맨드는 이 파일이 있어야 대상을 찾는다.
    await runtime.writeState(stamp, {
        schema: runtime.SCHEMA,
        stamp,
        nonce,
        host: os.hostname(),
        pid: process.pid,
        port: 0,
        threadId: null,
        activeTurnId: null,
        phase: 'starting',
        steerSeq: 0,
        startedAt: nowIso()
    });

    let steerCount = 0;
    let lastSteerAt = null;
    // 🔴 UI 미러는 runtime 이 소유한다. 직접 쓰면 비민감 필드 규약(port·pid·nonce 금지)을
    //    두 곳에서 관리하게 되고, 한쪽이 규약을 어기는 순간 제어 정보가 `.log/` 로 샌다.
    const mirror = (active, tid) => {
        if (!logDir) return;
        runtime.writeLiveMirror(logDir, stamp, { active, turnId: tid, steerCount, lastSteerAt })
            .catch(() => { /* 비권위 telemetry — 실패해도 본 작업을 막지 않는다 */ });
    };

    // ── status.json · heartbeat — 확장이 카드를 그리는 근거 ──────────────────
    //
    // 🔴 이 둘이 없으면 확장이 세 가지를 **동시에** 틀린다 (2026-08-25 실측):
    //   ① 카드 제목이 subject 대신 slug 로 뜬다
    //   ② 카드가 `중단됨` 으로 뜬다 — status 도 heartbeat 도 없으면 runDiscovery 가
    //      "텔레메트리 이전의 레거시 실행"으로 보고, events 에 terminal 이 없으니 stopped 로 떨어진다.
    //      실제로는 멀쩡히 도는 중인데 화면만 죽은 것으로 보인다
    //   ③ 모드 칩이 기본값 READONLY 로 뜬다
    //
    // send.sh 의 순서 규약을 그대로 따른다 — **heartbeat 를 status 보다 먼저** 만들고,
    // 후처리가 끝날 때까지 유지한다. 반대로 하면 "status=running 인데 heartbeat 없음"인
    // 찰나가 생기고, 하필 그때 죽으면 판독기가 생사를 영영 판정하지 못한다.
    const statusFile = logDir ? path.join(logDir, `${stamp}_status.json`) : null;
    const heartbeatFile = logDir ? path.join(logDir, `${stamp}_heartbeat`) : null;
    const startedAtIso = new Date(t0).toISOString().replace(/\.\d+Z$/, 'Z');
    let hbTimer = null;

    const writeStatus = (state, extra) => {
        if (!statusFile) return;
        const body = Object.assign({
            schema: 1, stamp, slug: reqSlug,
            mode: 'live', kind: 'consult', state,
            started_at: startedAtIso, finished_at: null, codex_exit: null, tee_exit: null,
        }, reqSubject ? { subject: reqSubject } : {}, extra || {});
        try {
            const tmp = `${statusFile}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
            fs.renameSync(tmp, statusFile);   // 같은 디렉토리 안의 rename 이라 원자적이다
        } catch { /* 비권위 telemetry — 실패해도 본 작업을 막지 않는다 */ }
    };

    const beat = () => { try { fs.writeFileSync(heartbeatFile, ''); } catch { /* ignore */ } };
    const startHeartbeat = () => {
        if (!heartbeatFile) return;
        beat();
        hbTimer = setInterval(beat, 5000);   // send.sh 와 같은 5초. 확장의 stale 판정은 30초다
        if (hbTimer.unref) hbTimer.unref();
    };
    const stopHeartbeat = () => {
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        if (heartbeatFile) { try { fs.rmSync(heartbeatFile, { force: true }); } catch { /* ignore */ } }
    };

    // 중단됐을 때 카드가 `중단됨` 으로 보이게 한다.
    //
    // 🔴 이게 없으면 강제로 끊긴 실행이 status=running 인 채로 굳고, heartbeat 만 멎는다.
    //    그러면 확장은 30초 뒤 `응답 없음`(stale) 으로 표시한다 — "죽었는지 느린지 모르겠다"는
    //    뜻이라, 사람이 직접 끊은 경우까지 그렇게 보이면 원인 판단이 흐려진다.
    //    SIGKILL(작업관리자·Stop-Process -Force)은 여기서도 못 잡는다. 그건 heartbeat stale 이
    //    담당한다 — send.sh 와 같은 이중 구조다.
    let statusSettled = false;
    const markInterrupted = () => {
        if (statusSettled) return;          // finish 가 이미 최종 상태를 썼으면 덮지 않는다
        statusSettled = true;
        stopHeartbeat();
        writeStatus('interrupted', {
            finished_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        });
    };
    // exit 훅은 **동기 코드만** 돈다. writeFileSync·renameSync 라 그 제약 안에서 성립한다.
    process.on('exit', markInterrupted);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        try {
            process.on(sig, () => { markInterrupted(); process.exit(130); });
        } catch { /* 플랫폼이 그 시그널을 모르면 그냥 넘어간다 */ }
    }

    let signalSeq = 0;
    const emitSignal = (sig) => {
        signalSeq += 1;
        appendJson(signalsFile, { seq: signalSeq, at: nowIso(), ms: Date.now() - t0, ...sig });
    };

    let server = null;
    let started = false;          // turn/start 응답을 받았는가 — 실패 경계의 기준점
    let threadId = null;
    let turnId = null;
    let finalText = '';
    let turnStatus = null;
    let steerDelivered = 0;
    let steerRejected = 0;
    let fatalPost = null;         // 턴 시작 후 발생한 치명적 사유

    // 🔴 bridge 의 ctx 는 **실행 내내 같은 객체**여야 한다. 매 호출 새로 만들면 토큰 사용량이
    //    turn.completed 에 실리지 않아 패널의 토큰 표시가 통째로 사라지고, 대기 상태 안내가
    //    중복으로 쌓인다. (bridge.mjs 가 명시적으로 경고하는 함정이다)
    const ctx = { threadId: null, turnId: null, turnSeq: 1 };

    const finish = async (phase, error) => {
        try {
            if (phase === 'failed') await runtime.markFailed(stamp, { error });
            else await runtime.setPhase(stamp, phase, { activeTurnId: null, steerSeq: steerCount });
        } catch { /* 상태 기록 실패가 결과를 바꾸지는 않는다 */ }
        mirror(false, turnId);
        // 🔴 heartbeat 를 **먼저** 멈추고 그다음 최종 status 를 쓴다 (send.sh 와 같은 순서).
        //    반대로 하면 판독기가 "terminal 인데 heartbeat 가 계속 뛴다"를 보게 된다.
        stopHeartbeat();
        statusSettled = true;               // exit 훅이 이 값을 interrupted 로 덮지 못하게 한다
        writeStatus(phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : 'interrupted', {
            finished_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            codex_exit: phase === 'done' ? 0 : null,
        });
        try { if (server) await server.close(); } catch { /* 이미 죽었을 수 있다 */ }
    };

    try {
        // 🔴 heartbeat 를 status 보다 먼저 만든다 — 위 주석의 순서 규약.
        //    서버 기동 전에 걸어 두는 이유는, 기동 자체가 몇 초 걸리는데 그 구간에도
        //    확장이 카드를 그리기 때문이다(events.jsonl 은 아직 비어 있다).
        startHeartbeat();
        writeStatus('running');

        // ── 1) 서버 기동 ── (여기 실패 = PRESTART)
        server = await startAppServer({
            // port 를 비우면 appserver 가 빈 포트를 잡는다. 🔴 고정 포트는 충돌한다.
            port: opts['port'] !== undefined && opts['port'] !== true ? Number(opts['port']) : undefined,
            cwd,
            // 🔴 request 는 timeoutMs 가 없으면 즉시 거부된다(상한 없는 대기 = 조용한 hang).
            //    appserver.mjs 는 기본값을 지어내지 않고 호출자에게 요구한다.
            defaultRequestTimeoutMs: requestTimeoutMs,
            // logSink 는 {kind, ...} 객체를 받는다. 감사용으로 통째로 흘린다.
            logSink: (rec) => appendJson(appserverLog, { at: nowIso(), ms: Date.now() - t0, ...rec })
        });
        await runtime.patchState(stamp, { port: server.port ?? 0, pid: process.pid });

        // ── 2) 알림 수신용 연결 ──
        // 🔴 알림은 **턴을 시작한 연결에만** 간다(실측: conn2 는 turn/started 를 0개 받았다).
        //    그래서 thread/start·turn/start 는 반드시 이 conn 에서 보낸다.
        const conn = await server.connect({ name: 'main' });

        // ── 3) 서버 → 클라이언트 요청 처리 ──
        // 🔴 자동 승인 금지. 무한 대기도 금지. 알 수 없는 요청은 fail-closed 로 거부하고 기록한다.
        //    기존 CONSULT 는 approval_policy=never 라 애초에 승인 요청이 오지 않는 것이 정상이다.
        //    그런데도 왔다면 그 자체가 이상 신호이므로 고신호로 올려 사람이 보게 한다.
        conn.onServerRequest((req) => {
            appendJson(steersLog, {
                at: nowIso(), event: 'server-request-denied',
                method: req && req.method, id: req && req.id
            });
            emitSignal({
                kind: 'server-request',
                summary: `서버가 요청을 보냈다(${req && req.method}) — 자동 승인하지 않고 거부했다`,
                detail: { method: req && req.method }
            });
            try {
                conn.respondError(req.id, -32601,
                    `${CLI_NAME}: 이 실행은 무인이며 승인 주체가 없다(approval_policy=never). 요청을 거부한다.`);
            } catch { /* 응답 실패는 서버 쪽 타임아웃으로 처리된다 */ }
        });

        // ── 4) 알림 → exec 호환 이벤트 ──
        conn.onNotification((note) => {
            // 최종 메시지는 알림에서 직접 건진다. app-server 에는 `-o` 가 없으므로 우리가 모아야 한다.
            if (note.method === 'item/completed') {
                const item = (note.params && note.params.item) || {};
                if (item.type === 'agentMessage' && item.phase === FINALIZE_PHASE && item.text) {
                    finalText = String(item.text);
                }
            }
            if (note.method === 'turn/completed') {
                turnStatus = (note.params && note.params.turn && note.params.turn.status) || 'unknown';
            }

            try {
                const ev = bridge.toExecEvent(note, ctx);
                if (ev) appendJson(eventsFile, ev);
            } catch (e) {
                // 변환 실패로 실행을 죽이지 않는다. 원문은 appserver-log 에 이미 남았다.
                appendJson(appserverLog, {
                    at: nowIso(), kind: 'bridge-error',
                    method: note.method, error: String((e && e.message) || e)
                });
            }

            const sig = classifySignal(note);
            if (sig) emitSignal(sig);
        });

        // ── 5) 핸드셰이크 ──
        await conn.request('initialize', {
            clientInfo: { name: `claude-state-bar-${CLI_NAME}`, version: CLI_VERSION }
        });
        conn.notify('initialized', {});

        // ── 6) thread/start ── (여기까지 실패 = PRESTART)
        const th = await conn.request('thread/start', {
            cwd,
            sandbox,
            // 🔴 기존 CONSULT 의 동작을 보존한다. exec 에서는 never 로 고정돼 있었고,
            //    여기서 완화하면 "승인을 누를 사람이 없는데 승인을 기다리는" 상태가 생긴다.
            approvalPolicy: 'never'
        });
        threadId = (th && th.thread && th.thread.id) || null;
        if (!threadId) fail(EXIT.PRESTART_FAILED, 'thread/start 응답에 threadId 가 없다');
        ctx.threadId = threadId;
        await runtime.patchState(stamp, { threadId });

        // exec 호환 스트림의 첫 줄. 응답이 알림보다 먼저 오므로(실측 760ms) 여기서 내야
        // 순서가 exec 와 같아진다. 알림으로 한 번 더 와도 무해하다(thread_id 덮어쓰기).
        appendJson(eventsFile, bridge.makeThreadStartedEvent(threadId));

        // ── 7) turn/start ──
        // 🔴 이 await 이 성공으로 돌아온 순간부터 fallback 금지 구간이다.
        //    turn/start 응답은 3ms 만에 오고 turnId 가 그 안에 있다(실측). turn/started
        //    알림(1213ms)을 기다릴 필요가 없다.
        let turnRes;
        try {
            turnRes = await conn.request('turn/start', {
                threadId,
                input: [{ type: 'text', text: prompt }]
            });
        } catch (e) {
            // 요청 자체가 거부됐다 = 턴이 시작되지 않았다 → 아직 PRESTART 다.
            fail(EXIT.PRESTART_FAILED, `turn/start 실패: ${(e && e.message) || e}`);
        }
        turnId = (turnRes && turnRes.turn && turnRes.turn.id) || null;
        if (!turnId) fail(EXIT.PRESTART_FAILED, 'turn/start 응답에 turnId 가 없다');

        started = true;
        ctx.turnId = turnId;
        await runtime.setPhase(stamp, 'active', { activeTurnId: turnId });
        mirror(true, turnId);
        err(`→ 턴 시작 (thread=${threadId} turn=${turnId})`);

        // ── 8) steer 전용 연결 ──
        // 실측된 형태를 그대로 따른다: 알림을 받는 연결과 steer 를 보내는 연결을 나눈다.
        let steerConn = null;
        try {
            steerConn = await server.connect({ name: 'steer' });
            await steerConn.request('initialize', {
                clientInfo: { name: `claude-state-bar-${CLI_NAME}-steer`, version: CLI_VERSION }
            });
            steerConn.notify('initialized', {});
        } catch (e) {
            // steer 채널이 없어도 턴 자체는 진행된다. 개입만 못 할 뿐이다.
            steerConn = null;
            appendJson(steersLog, {
                at: nowIso(), event: 'steer-channel-failed', error: String((e && e.message) || e)
            });
            err('⚠ steer 채널을 열지 못했다 — 개입 없이 턴만 진행한다');
        }

        // ── 9) turn/completed 대기 + steer 큐 펌프 ──
        const done = new Promise((resolve) => {
            conn.onNotification((note) => {
                if (note.method === 'turn/completed') resolve('completed');
            });
        });
        const serverDied = new Promise((resolve) => {
            conn.onClose(() => resolve('closed'));
        });

        // 🔴 drainSteer 는 at-least-once 다(표시 전에 죽으면 같은 항목이 다시 나온다).
        //    같은 nonce 를 두 번 전송하면 Codex 가 같은 지시를 두 번 받는다. 여기서 막는다.
        const handled = new Set();

        const deliver = async (item) => {
            if (item.nonce && handled.has(item.nonce)) return;
            if (item.nonce) handled.add(item.nonce);

            const base = {
                at: nowIso(), seq: item.seq, nonce: item.nonce,
                source: item.source || 'unknown', text: item.text, turnId
            };

            if (!steerConn) {
                const message = 'steer 채널이 열려 있지 않다';
                steerRejected += 1;
                appendJson(steersLog, { ...base, accepted: false, error: message });
                await runtime.recordSteerOutcome(stamp, {
                    seq: item.seq, nonce: item.nonce, outcome: 'rejected',
                    text: item.text, error: { message }
                }).catch(() => { });
                appendSteerEvent(bridge, eventsFile, item, false, turnId);
                return;
            }

            try {
                const res = await steerConn.request('turn/steer', {
                    threadId,
                    expectedTurnId: turnId,
                    input: [{ type: 'text', text: item.text }]
                });
                // 🔴 "같은 turnId 를 돌려줬을 때만" 전달로 인정한다. 다른 turnId 가 오면
                //    우리가 겨냥한 턴이 아니다 — 성공으로 위장하지 않는다.
                const ok = !!(res && res.turnId === turnId);
                if (ok) {
                    steerDelivered += 1;
                    steerCount += 1;
                    lastSteerAt = nowIso();
                    await runtime.patchState(stamp, { steerSeq: steerCount }).catch(() => { });
                    mirror(true, turnId);
                } else {
                    steerRejected += 1;
                }
                const message = ok ? null : 'turn/steer 응답의 turnId 가 현재 턴과 다르다';
                appendJson(steersLog, {
                    ...base, accepted: ok, responseTurnId: res ? res.turnId : null, error: message
                });
                await runtime.recordSteerOutcome(stamp, {
                    seq: item.seq, nonce: item.nonce,
                    outcome: ok ? 'delivered' : 'rejected',
                    text: item.text, turnId: res ? res.turnId : null,
                    error: message ? { message } : undefined
                }).catch(() => { });
                appendSteerEvent(bridge, eventsFile, item, ok, turnId);
            } catch (e) {
                // 🔴 거부됐다고 새 turn 을 만들지 않는다. 사유를 그대로 남긴다.
                //    (예: {"code":-32600,"message":"no active turn to steer"})
                const message = (e && e.message) || String(e);
                const code = e && e.code !== undefined ? e.code : null;
                // 🔴 연결이 끊겨 **응답을 못 본 것**은 거부가 아니다 — 전달됐는지 알 수 없다.
                //    모르면 unknown 으로 남긴다. runtime 이 미전달로 취급해 되살릴 수 있게.
                const connLost = !!(e && e.connClosed);
                steerRejected += 1;
                appendJson(steersLog, { ...base, accepted: false, code, error: message });
                await runtime.recordSteerOutcome(stamp, {
                    seq: item.seq, nonce: item.nonce,
                    outcome: connLost ? 'unknown' : 'rejected',
                    text: item.text, error: { code, message }
                }).catch(() => { });
                appendSteerEvent(bridge, eventsFile, item, false, turnId);
            }
        };

        let stop = false;
        const pump = (async () => {
            while (!stop) {
                await sleep(steerPollMs);
                if (stop) break;
                let queued = [];
                try { queued = await runtime.drainSteer(stamp); } catch { queued = []; }
                for (const item of (queued || [])) {
                    if (stop) break;
                    await deliver(item);
                }
            }
        })();

        const races = [done, serverDied];
        if (turnTimeoutMs > 0) races.push(sleep(turnTimeoutMs).then(() => 'timeout'));
        const why = await Promise.race(races);

        stop = true;
        await pump.catch(() => { /* 펌프 종료 시 잔여 오류는 무시 */ });
        try { if (steerConn) steerConn.close(); } catch { /* ignore */ }

        // 🔴 턴이 끝난 뒤 큐에 남은 개입은 영영 전달되지 않는다. 왜 전달 못 했는지를
        //    명시적으로 남긴다. 안 남기면 "기록 없음"으로만 보여 원인을 알 수 없고,
        //    아직 확인을 기다리는 steer 프로세스가 상한까지 헛되이 기다린다.
        try {
            const leftover = await runtime.drainSteer(stamp);
            for (const item of (leftover || [])) {
                if (item.nonce && handled.has(item.nonce)) continue;
                const message = '턴이 이미 끝나 전달하지 못했다';
                steerRejected += 1;
                appendJson(steersLog, {
                    at: nowIso(), seq: item.seq, nonce: item.nonce,
                    source: item.source || 'unknown', text: item.text,
                    turnId, accepted: false, error: message
                });
                await runtime.recordSteerOutcome(stamp, {
                    seq: item.seq, nonce: item.nonce, outcome: 'rejected',
                    text: item.text, error: { message }
                }).catch(() => { });
                appendSteerEvent(bridge, eventsFile, item, false, turnId);
            }
        } catch { /* 잔여 처리 실패가 결과를 바꾸지는 않는다 */ }

        if (why === 'closed') fatalPost = '턴이 도는 중 app-server 연결이 끊겼다';
        else if (why === 'timeout') fatalPost = `턴 상한(${turnTimeoutMs}ms)에 걸렸다`;

        // 알림이 파일 append 를 마칠 여유를 아주 조금 준다. 이벤트 순서가 뒤집히면
        // 확장이 카드를 잘못 그린다.
        await sleep(50);

        // ── 10) 최종 메시지 회수 ──
        await runtime.setPhase(stamp, 'finalizing').catch(() => { });
        // 🔴 turn/completed 는 "Codex 의 턴이 끝났다"이지 "실행이 끝났다"가 아니다.
        //    최종 메시지 회수가 남아 있으므로 여기서 done 을 쓰면 안 된다 — 확장이
        //    `마무리 중` 을 따로 두는 이유가 정확히 이 구간이다. heartbeat 는 계속 뛴다.
        writeStatus('finalizing');

        if (finalText) {
            try {
                fs.mkdirSync(path.dirname(lastMessageFile), { recursive: true });
                fs.writeFileSync(lastMessageFile,
                    finalText.endsWith('\n') ? finalText : finalText + '\n', 'utf8');
            } catch (e) {
                err(`⚠ 최종 메시지 저장 실패: ${(e && e.message) || e}`);
            }
        }

        // 전달하지 못한 개입이 있으면 조용히 삼키지 않는다 — 사용자가 한 말이 사라진 것이다.
        const undelivered = await runtime.listUndeliveredSteer(stamp).catch(() => []);

        if (fatalPost) {
            await finish('failed', { message: fatalPost });
            printRunSummary({
                threadId, turnId, status: 'interrupted', steerDelivered, steerRejected,
                undelivered, lastMessageFile, eventsFile, runtimeDir,
                exitClass: 'poststart-failed', note: fatalPost
            });
            err(`🔴 ${fatalPost} — 🔴 자동 fallback 금지. 같은 요청이 두 번 실행된다.`);
            return why === 'timeout' ? EXIT.TURN_TIMEOUT : EXIT.POSTSTART_FAILED;
        }

        await finish('done');
        printRunSummary({
            threadId, turnId, status: turnStatus || 'unknown', steerDelivered, steerRejected,
            undelivered, lastMessageFile, eventsFile, runtimeDir,
            exitClass: turnStatus === 'completed' ? 'ok' : 'turn-failed'
        });

        if (turnStatus !== 'completed') {
            err(`🔴 턴이 status=${turnStatus} 로 끝났다 — 자동 fallback 금지.`);
            return EXIT.TURN_FAILED;
        }
        return EXIT.OK;

    } catch (e) {
        const msg = (e && e.message) || String(e);
        // 🔴 실패 경계는 `started` 하나로 판정한다. 예외가 어디서 났든 turn/start 응답을
        //    이미 받았다면 Codex 는 돌기 시작한 것이고, 그러면 재실행은 이중 실행이다.
        if (started) {
            await finish('failed', { message: msg });
            const undelivered = await runtime.listUndeliveredSteer(stamp).catch(() => []);
            printRunSummary({
                threadId, turnId, status: 'error', steerDelivered, steerRejected,
                undelivered, lastMessageFile, eventsFile, runtimeDir,
                exitClass: 'poststart-failed', note: msg
            });
            err(`🔴 턴 시작 후 실패: ${msg}`);
            err('🔴 자동 fallback 금지 — 같은 요청이 두 번 실행된다. 실패로 보고해라.');
            return EXIT.POSTSTART_FAILED;
        }
        await finish('failed', { message: msg });
        const code = e instanceof CliError ? e.code : EXIT.PRESTART_FAILED;
        err(`턴 시작 전 실패: ${msg}`);
        if (code === EXIT.PRESTART_FAILED) err('턴이 시작되지 않았다 — codex exec 로 fallback 해도 안전하다.');
        return code;
    }
}

// steer 개입을 진행 패널에 보이게 만든다. 변환 실패가 본 흐름을 막으면 안 되므로 감싼다.
function appendSteerEvent(bridge, eventsFile, item, accepted, turnId) {
    try {
        const ev = bridge.makeSteerEvent({
            seq: item.seq, source: item.source, accepted, text: item.text, turnId
        });
        if (ev) appendJson(eventsFile, ev);
    } catch { /* steers-log 가 정본이다 */ }
}

// send.sh 가 읽는다. 사람이 읽을 수 있으면서 grep 으로도 뽑히게 key=value 로 낸다.
function printRunSummary(s) {
    out('LIVE_CONSULT_RESULT');
    out(`thread_id=${s.threadId || ''}`);
    out(`turn_id=${s.turnId || ''}`);
    out(`status=${s.status || ''}`);
    out(`steer_delivered=${s.steerDelivered}`);
    out(`steer_rejected=${s.steerRejected}`);
    // 🔴 전달 못 한 개입은 반드시 드러낸다. 사용자가 한 말이 조용히 사라지는 것이
    //    이 도구에서 가장 나쁜 실패다. 호출자가 FOLLOWUP 후보로 되살릴 수 있게 원문 경로를 준다.
    const undel = Array.isArray(s.undelivered) ? s.undelivered : [];
    out(`steer_undelivered=${undel.length}`);
    for (const u of undel) {
        out(`steer_undelivered_seq=${u.seq} outcome=${u.outcome || 'no-record'}`);
    }
    out(`last_message=${s.lastMessageFile || ''}`);
    out(`events=${s.eventsFile || ''}`);
    out(`runtime=${s.runtimeDir || ''}`);
    out(`exit_class=${s.exitClass || ''}`);
    if (s.note) out(`note=${String(s.note).replace(/[\r\n]+/g, ' ')}`);
    out('END_LIVE_CONSULT_RESULT');
}

// ══════════════════════════════════════════════════════════════════════════
// 10. steer — 실행 중인 턴에 새 입력을 밀어 넣는다
// ══════════════════════════════════════════════════════════════════════════
async function cmdSteer(opts, lib) {
    const { mods, missing } = lib;
    const stamp = needStamp(opts);
    const inputFile = need(opts, 'input-file');
    const source = opts['source'] === undefined || opts['source'] === true
        ? 'user-via-claude' : String(opts['source']);
    if (!['user-via-claude', 'claude-monitor'].includes(source)) {
        fail(EXIT.USAGE, `--source 는 user-via-claude 또는 claude-monitor 여야 한다: ${source}`);
    }
    const confirmTimeoutMs = numOpt(opts, 'timeout-ms', PENDING_DECISION.steerConfirmTimeoutMs);
    const pollMs = numOpt(opts, 'poll-ms', PENDING_DECISION.filePollMs);

    if (opts['dry-run']) {
        const dir = mods.runtime ? mods.runtime.runtimePath(stamp) : guessRuntimeDir(stamp);
        const text = await readTextInput(inputFile);
        out('── DRYRUN (steer) — 큐에 넣지 않는다 ──');
        out(`스탬프     : ${stamp}`);
        out(`출처       : ${source}`);
        out(`입력       : ${inputFile === '-' ? '(stdin)' : inputFile}`);
        out(`본문 길이  : ${text.length}자 / ${Buffer.byteLength(text, 'utf8')}바이트`);
        out(`runtime    : ${dir}${mods.runtime ? '' : '   (lib/runtime.mjs 미탑재 — 추정치다)'}`);
        out(`확인 상한  : ${confirmTimeoutMs}ms`);
        out('');
        out('── 본문 (앞 500자) ──');
        out(text.slice(0, 500));
        return EXIT.OK;
    }

    requireLib(mods, missing, ['runtime']);
    const runtime = mods.runtime;

    const text = await readTextInput(inputFile);
    if (!text.trim()) fail(EXIT.USAGE, '입력이 비었다 — 빈 steer 는 보내지 않는다');

    const state = await runtime.readState(stamp);
    // 🔴 phase 만 보지 않는다. checkSteerable 은 pid 생존·host 일치·스키마까지 본다 —
    //    임시 디렉토리가 공유되는 환경에서 남의 실행을 조종하는 사고를 막는 장치다.
    //    끝난 실행의 큐에 넣으면 아무도 비우지 않아 영영 대기하므로 여기서 잘라낸다.
    const check = runtime.checkSteerable(state, { stamp });
    if (!check.ok) {
        out(`지금은 개입할 수 없다 (stamp=${stamp})`);
        for (const r of check.reasons) out(`  · ${r}`);
        out('  새 턴을 만들지 않는다.');
        return EXIT.NO_RUNTIME;
    }

    // 🔴 nonce 는 **요청별 멱등 키**다. 실행 nonce(state.nonce)를 넣으면 두 번째 개입부터
    //    duplicate 로 무시되어 조용히 사라진다. 요청마다 새로 만든다.
    const reqNonce = runtime.makeNonce();
    const { seq, duplicate } = await runtime.enqueueSteer(stamp, { text, source, nonce: reqNonce });
    if (duplicate) {
        // 새 nonce 를 만들었으므로 정상 경로에서는 나올 수 없다. 나왔다면 상태가 이상한 것이다.
        out(`이미 큐에 있는 요청이다 · seq=${seq}`);
    }

    // 🔴 여기서 끝내면 안 된다. 큐에 넣은 것은 전달이 아니다.
    //    run 프로세스가 turn/steer 응답을 받아 결과를 남길 때까지 기다린다.
    const deadline = Date.now() + confirmTimeoutMs;
    while (Date.now() < deadline) {
        const outcomes = await runtime.listSteerOutcomes(stamp).catch(() => []);
        const rec = outcomes.find((o) => o && o.nonce === reqNonce);
        if (rec) {
            if (rec.outcome === 'delivered') {
                out(`전달됨 · seq=${seq} · turnId=${rec.turnId} · 출처=${source}`);
                out('  turn/steer 가 같은 turnId 를 응답했다 — 실행 중인 턴에 실제로 들어갔다.');
                return EXIT.OK;
            }
            if (rec.outcome === 'unknown') {
                // 응답을 못 본 채 끊긴 경우다. 전달됐다고 말하지 않는다.
                out(`전달 불명 · seq=${seq}`);
                out(`  사유: ${(rec.error && rec.error.message) || '(사유 없음)'}`);
                out('  전달 여부를 확인하지 못했다 — 전달되지 않았다고 보는 것이 안전하다.');
                return EXIT.STEER_TIMEOUT;
            }
            // 🔴 사유를 가공하지 않고 그대로 낸다.
            out(`거부됨 · seq=${seq}`);
            if (rec.error && rec.error.code !== undefined && rec.error.code !== null) {
                out(`  code: ${rec.error.code}`);
            }
            out(`  사유: ${(rec.error && rec.error.message) || '(사유 없음)'}`);
            out('  새 턴을 만들지 않았다.');
            return EXIT.STEER_REJECTED;
        }
        // 그 사이 실행이 끝났으면 더 기다릴 이유가 없다.
        const cur = await runtime.readState(stamp);
        if (!cur || cur.phase !== 'active') {
            out(`확인 실패 · seq=${seq}`);
            out(`  큐에는 넣었지만 전달 확인 전에 실행이 끝났다 (phase=${cur ? cur.phase : 'none'}).`);
            out('  전달되지 않았다고 보는 것이 안전하다.');
            return EXIT.STEER_TIMEOUT;
        }
        await sleep(pollMs);
    }

    out(`확인 실패 · seq=${seq}`);
    out(`  ${confirmTimeoutMs}ms 안에 전달 확인을 받지 못했다. 큐에는 들어가 있다.`);
    out('  전달 여부는 steers-log 로 사후 확인해라.');
    return EXIT.STEER_TIMEOUT;
}

async function cmdWait(opts, lib) {
    const { mods, missing } = lib;
    const stamp = needStamp(opts);
    const after = numOpt(opts, 'after', 0);
    const timeoutMs = numOpt(opts, 'timeout-ms', PENDING_DECISION.waitTimeoutMs);
    const pollMs = numOpt(opts, 'poll-ms', PENDING_DECISION.filePollMs);

    if (opts['dry-run']) {
        const dir = mods.runtime ? mods.runtime.runtimePath(stamp) : guessRuntimeDir(stamp);
        out('── DRYRUN (wait) — 대기하지 않는다 ──');
        out(`스탬프     : ${stamp}`);
        out(`기준 seq   : ${after} (이 값보다 큰 신호를 기다린다)`);
        out(`신호 파일  : ${CLI_FILES.signals(dir)}${mods.runtime ? '' : '   (lib/runtime.mjs 미탑재 — 추정치다)'}`);
        out(`대기 상한  : ${timeoutMs}ms   🔴 결정 필요(잠정치)`);
        out('');
        out('── 고신호로 보는 것 ──');
        for (const l of SIGNAL_DOC) out(`  ${l}`);
        return EXIT.OK;
    }

    requireLib(mods, missing, ['runtime']);
    const runtime = mods.runtime;

    const state = await runtime.readState(stamp);
    if (!state) fail(EXIT.NO_RUNTIME, `해당 스탬프의 실행 상태가 없다: ${stamp}`);

    const signalsFile = CLI_FILES.signals(runtime.runtimePath(stamp));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const sig = readSignalAfter(signalsFile, after);
        if (sig) {
            out(`신호 seq=${sig.seq} · ${sig.kind}`);
            out(sig.summary || '');
            if (sig.detail) {
                const d = JSON.stringify(sig.detail);
                out(`  상세: ${d.length > 600 ? d.slice(0, 600) + '…' : d}`);
            }
            out(`  다음 대기: --after ${sig.seq}`);
            return EXIT.OK;
        }
        const cur = await runtime.readState(stamp);
        if (!cur || (cur.phase !== 'active' && cur.phase !== 'starting' && cur.phase !== 'finalizing')) {
            // 종료 자체도 고신호라 보통은 위에서 잡힌다. 여기 오는 건 신호 파일을
            // 못 쓰고 끝난 경우이므로 그 사실을 그대로 알린다.
            out(`신호 없음 — 실행이 끝났다 (phase=${cur ? cur.phase : 'none'})`);
            return EXIT.OK;
        }
        await sleep(pollMs);
    }

    out(`대기 상한(${timeoutMs}ms)에 도달했다 — 고신호 없음`);
    return EXIT.WAIT_TIMEOUT;
}

function readSignalAfter(file, after) {
    if (!fs.existsSync(file)) return null;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let rec;
        try { rec = JSON.parse(t); } catch { continue; }
        if (typeof rec.seq === 'number' && rec.seq > after) return rec;
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 12. status — 진단용
// ══════════════════════════════════════════════════════════════════════════
async function cmdStatus(opts, lib) {
    const { mods, missing } = lib;
    const stamp = needStamp(opts);

    if (opts['dry-run']) {
        const dir = mods.runtime ? mods.runtime.runtimePath(stamp) : guessRuntimeDir(stamp);
        out('── DRYRUN (status) ──');
        out(`스탬프  : ${stamp}`);
        out(`runtime : ${dir}${mods.runtime ? '' : '   (lib/runtime.mjs 미탑재 — 추정치다)'}`);
        return EXIT.OK;
    }

    requireLib(mods, missing, ['runtime']);
    const runtime = mods.runtime;
    const state = await runtime.readState(stamp);
    if (!state) {
        out(`실행 상태 없음 (stamp=${stamp})`);
        return EXIT.NO_RUNTIME;
    }

    if (opts['json']) { out(JSON.stringify(state, null, 2)); return EXIT.OK; }

    const dir = runtime.runtimePath(stamp);
    const alive = runtime.isPidAlive(state.pid);
    out(`스탬프    : ${state.stamp}`);
    out(`단계      : ${state.phase}${state.phase === 'active' && !alive ? '  ⚠ pid 가 죽었다 (크래시)' : ''}`);
    out(`호스트/PID: ${state.host} / ${state.pid} (${alive ? '살아 있음' : '없음'})`);
    out(`포트      : ${state.port}`);
    out(`thread    : ${state.threadId || '(없음)'}`);
    out(`활성 턴   : ${state.activeTurnId || '(없음)'}`);
    out(`시작      : ${state.startedAt}`);
    out(`runtime   : ${dir}`);

    // 개입 현황은 state.steerSeq(전달 성공 수)만으로 부족하다. 거부·불명까지 보여야
    // "내가 한 말이 들어갔나"에 답할 수 있다.
    const outcomes = await runtime.listSteerOutcomes(stamp).catch(() => []);
    if (outcomes.length) {
        const tally = { delivered: 0, rejected: 0, unknown: 0 };
        for (const o of outcomes) if (tally[o.outcome] !== undefined) tally[o.outcome] += 1;
        out(`개입      : 전달 ${tally.delivered} · 거부 ${tally.rejected} · 불명 ${tally.unknown}`);
        for (const o of outcomes.slice(-3)) {
            const why = o.error && o.error.message ? ` — ${o.error.message}` : '';
            out(`  seq=${o.seq} ${o.outcome}${why}`);
        }
    } else {
        out('개입      : 없음');
    }

    const undelivered = await runtime.listUndeliveredSteer(stamp).catch(() => []);
    if (undelivered.length) {
        out(`🔴 전달 못 한 개입 ${undelivered.length}건 — 원문이 runtime 에 남아 있다`);
    }

    const sigFile = CLI_FILES.signals(dir);
    if (fs.existsSync(sigFile)) {
        const lines = fs.readFileSync(sigFile, 'utf8').split('\n').filter((l) => l.trim());
        out(`고신호    : ${lines.length}건`);
        for (const l of lines.slice(-3)) {
            try {
                const r = JSON.parse(l);
                out(`  seq=${r.seq} ${r.kind} — ${r.summary}`);
            } catch { /* 깨진 줄은 건너뛴다 */ }
        }
    }
    return EXIT.OK;
}

// ══════════════════════════════════════════════════════════════════════════
// 13. --help
// ══════════════════════════════════════════════════════════════════════════

// README 와 --help 가 같은 문장을 쓰도록 한곳에 둔다.
const SIGNAL_DOC = [
    'plan            조사 계획이 나왔다 (item 타입에 plan/todo 가 들어가면 전부)',
    'command-started 새 명령 실행 시작 — 명령문과 cwd 를 함께 낸다',
    'file-change     파일 변경 시도 — 대상 경로를 낸다 (CONSULT 는 원래 고치면 안 된다)',
    'blocked         "자료가 없다/확인할 수 없다" 류 문구가 최종 아닌 메시지에 나왔다',
    'finalizing      최종 답변(phase=final_answer)을 쓰기 시작했다',
    'waiting-approval 승인 대기로 보이는 상태 — 이 실행에는 승인할 사람이 없다',
    'server-request  서버가 클라이언트에 요청을 보냈다 (거부하고 기록했다)',
    'turn-ended      턴 종료'
];

function printHelp() {
    const H = [
        `${CLI_NAME} ${CLI_VERSION} — codex app-server 기반 CONSULT 실행기`,
        '',
        '기존 CONSULT 는 codex exec 배치라 실행 중 개입이 불가능했다. 이 도구는 app-server 의',
        'turn/steer 로 실행 중인 턴에 새 입력을 밀어 넣으면서, 산출물(events.jsonl ·',
        'last_message.md)은 기존과 같은 모양으로 남긴다.',
        '',
        '사용법:',
        `  node ${CLI_NAME}.mjs <서브커맨드> [옵션]`,
        `  node ${CLI_NAME}.mjs --help`,
        '',
        '  어느 서브커맨드에나 --dry-run 을 붙이면 codex 를 부르지 않고 조립 결과만 낸다.',
        '',
        '───────────────────────────────────────────────────────────────',
        'run   — send.sh 가 부른다. 턴 완료까지 대기하고 기존 호환 결과를 남긴다',
        '',
        '  --request-file <절대경로>     요청서. 프롬프트를 여기서 만든다 (필수)',
        '  --runtime-dir <경로>          권위 상태 디렉토리 (기록용 · 실제 위치는 runtime.mjs 가 정한다)',
        '  --events-file <경로>          기존 events.jsonl (exec 호환) (필수)',
        '  --last-message-file <경로>    기존 last_message.md (필수)',
        '  --appserver-log <경로>        app-server 원문 (감사·디버깅) (필수)',
        '  --steers-log <경로>           개입 기록 (필수)',
        '  --stamp <스탬프>              (필수)',
        '  --cwd <작업 디렉토리>          (필수)',
        '  --sandbox read-only|workspace-write   기본 read-only',
        '  --port <포트>                 생략하면 빈 포트를 자동으로 잡는다 (고정 포트는 충돌한다)',
        '  --scratch-rel <경로>          Codex 작업대. 기본 docs/codex_rescue/.scratch',
        '  --log-dir <경로>              UI 미러를 쓸 .log 디렉토리 (<stamp>_live.json)',
        '  --steer-poll-ms <ms>          steer 큐 확인 간격. 기본 ' + PENDING_DECISION.steerPollMs + '   🔴 결정 필요',
        '  --request-timeout-ms <ms>     RPC 왕복 상한. 기본 ' + PENDING_DECISION.requestTimeoutMs + '   🔴 결정 필요',
        '                                (턴 길이와 무관 — turn/completed 는 알림으로 온다)',
        '  --turn-timeout-ms <ms>        턴 상한. 기본 0 = 무제한 (기존 CONSULT 동작 보존)',
        '',
        '  stdout 으로 LIVE_CONSULT_RESULT 블록을 낸다 (send.sh 가 읽는다):',
        '    thread_id · turn_id · status · steer_delivered · steer_rejected',
        '    steer_undelivered(+seq 목록) · last_message · events · runtime · exit_class',
        '',
        '───────────────────────────────────────────────────────────────',
        'steer — 실행 중인 턴에 새 입력을 전달한다',
        '',
        '  --stamp <스탬프>                                  (필수)',
        '  --input-file <파일|->                             본문. - 이면 stdin (필수)',
        '  --source user-via-claude|claude-monitor           기본 user-via-claude',
        '  --timeout-ms <ms>    전달 확인 상한. 기본 ' + PENDING_DECISION.steerConfirmTimeoutMs + '   🔴 결정 필요',
        '',
        '  🔴 긴 한글을 argv 로 넘기지 마라. Windows CreateProcess 는 32,767자 제한이 있고',
        '     (실측: 32,000B 성공 / 32,700B 실패) 한글은 UTF-8 3바이트라 더 빨리 걸린다.',
        '  🔴 "전달됨"은 turn/steer 가 같은 turnId 를 응답한 뒤에만 출력한다. 큐에 넣기만',
        '     성공한 것은 전달이 아니다. 거부되면 서버가 준 사유를 그대로 낸다.',
        '',
        '───────────────────────────────────────────────────────────────',
        'wait  — 판단이 필요한 고신호가 올 때까지 1회성 대기 (Claude 자율 모니터용)',
        '',
        '  --stamp <스탬프>       (필수)',
        '  --after <seq>          이 seq 보다 큰 신호를 기다린다. 기본 0',
        '  --timeout-ms <ms>      대기 상한. 기본 ' + PENDING_DECISION.waitTimeoutMs + '   🔴 결정 필요',
        '',
        '  고신호로 보는 것 (놓치는 쪽보다 자주 깨우는 쪽으로 기울였다):',
        ...SIGNAL_DOC.map((l) => '    ' + l),
        '',
        '───────────────────────────────────────────────────────────────',
        'status — 현재 상태 조회 (진단용)',
        '',
        '  --stamp <스탬프>   (필수)',
        '  --json             원본 상태 JSON 을 그대로 낸다',
        '',
        '───────────────────────────────────────────────────────────────',
        '종료 코드 — 🔴 실패 경계가 여기 들어 있다',
        '',
        `  ${EXIT.OK}   정상`,
        `  ${EXIT.USAGE}   인자 오류 (아무것도 실행하지 않았다)`,
        '',
        '  ── 10번대: turn/start 이전에 끝났다 → codex exec 로 fallback 해도 안전 ──',
        `  ${EXIT.PRESTART_FAILED}  서버 기동 / initialize / thread/start / turn/start 실패`,
        `  ${EXIT.LIB_MISSING}  lib/*.mjs 를 싣지 못했다`,
        '',
        '  ── 20번대: turn/start 이후에 끝났다 → 🔴 자동 fallback 금지 ──',
        `  ${EXIT.POSTSTART_FAILED}  턴이 도는 중 연결이 끊기거나 서버가 죽었다`,
        `  ${EXIT.TURN_FAILED}  turn/completed 가 status=failed 로 왔다`,
        `  ${EXIT.TURN_TIMEOUT}  --turn-timeout-ms 상한에 걸렸다`,
        '',
        '  ── 30번대: steer ──',
        `  ${EXIT.STEER_REJECTED}  turn/steer 가 거부됐다 (사유를 그대로 출력한다)`,
        `  ${EXIT.NO_RUNTIME}  해당 실행이 없거나 개입할 수 없는 상태다 (거절 사유를 열거한다)`,
        `  ${EXIT.STEER_TIMEOUT}  큐에는 넣었지만 전달 확인을 못 받았다 / 전달 여부 불명`,
        '',
        '  ── 40번대: wait ──',
        `  ${EXIT.WAIT_TIMEOUT}  고신호 없이 상한에 도달했다`,
        '',
        '───────────────────────────────────────────────────────────────',
        '승인 요청 처리',
        '  🔴 자동 승인하지 않는다. 무한 대기도 하지 않는다. 이 실행은 approval_policy=never 로',
        '     돌기 때문에 애초에 승인 요청이 오지 않는 것이 정상이다. 그런데도 서버 요청이 오면',
        '     fail-closed 로 거부하고 steers-log 에 기록한 뒤 고신호로 올린다.',
        ''
    ];
    out(H.join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════
// 14. main
// ══════════════════════════════════════════════════════════════════════════
async function main() {
    const argv = process.argv.slice(2);
    const { opts, rest } = parseArgs(argv);
    const sub = rest[0];

    // 🔴 --version 을 --help 보다 먼저 본다. 순서가 반대면 서브커맨드 없는 `--version` 이
    //    "서브커맨드가 없다"로 걸려 도움말 + 종료코드 2 가 나간다.
    if (opts['version']) { out(`${CLI_NAME} ${CLI_VERSION}`); return EXIT.OK; }
    if (opts['help'] || opts['h'] || !sub) {
        // 서브커맨드가 없으면 도움말이 맞다 — 인자 없이 부르면 뭘 할 수 있는지부터 알아야 한다.
        printHelp();
        return sub || opts['help'] || opts['h'] ? EXIT.OK : EXIT.USAGE;
    }

    const handlers = { run: cmdRun, steer: cmdSteer, wait: cmdWait, status: cmdStatus };
    const handler = handlers[sub];
    if (!handler) {
        err(`알 수 없는 서브커맨드: ${sub}`);
        err('run · steer · wait · status 중 하나여야 한다. --help 를 봐라.');
        return EXIT.USAGE;
    }

    // 🔴 "예상 못 한 오류"를 어떤 코드로 낼지는 서브커맨드마다 다르다.
    //    run 만이 codex 를 띄운다 — 어디서 터졌는지 모르면 턴이 이미 돌고 있었을 수
    //    있으므로 fail-closed(fallback 금지)로 간다. 나머지는 codex 를 아예 띄우지
    //    않으므로 이중 실행 위험이 없고, 거기까지 fail-closed 로 물들이면 호출자가
    //    "아무 일도 없었는데 fallback 금지"라는 잘못된 신호를 받는다.
    const unexpectedCode = sub === 'run' ? EXIT.POSTSTART_FAILED : EXIT.GENERAL;

    const lib = await loadLib();
    try {
        return await handler(opts, lib);
    } catch (e) {
        if (e instanceof CliError) { err(`${CLI_NAME}: ${e.message}`); return e.code; }
        err(`${CLI_NAME}: ${sub} 처리 중 예상 못 한 오류 — ${e && e.stack ? e.stack : e}`);
        return unexpectedCode;
    }
}

// 순수 함수는 밖으로 열어 둔다 — 고신호 판정과 프롬프트 조립은 실제 알림 로그로
// 단위 검증할 수 있어야 한다. codex 를 띄우지 않고 검증할 수 있는 유일한 부분이다.
export {
    classifySignal, buildConsultPrompt, parseArgs, EXIT, SIGNAL_DOC, PENDING_DECISION,
    // 고신호 판독은 wait 의 핵심이라 단위 검증 대상으로 열어 둔다.
    // (steer 전달 판정은 runtime.listSteerOutcomes 가 정본이므로 여기서 갖지 않는다)
    readSignalAfter
};

// 직접 실행됐을 때만 CLI 로 동작한다. import 해서 함수만 쓰는 경우 main 이 돌면 안 된다.
const invokedDirectly = (() => {
    try {
        return process.argv[1] &&
            path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
    } catch { return true; }
})();

if (invokedDirectly) {
    main()
        .then((code) => { process.exitCode = code; })
        .catch((e) => {
            if (e instanceof CliError) {
                err(`${CLI_NAME}: ${e.message}`);
                process.exitCode = e.code;
                return;
            }
            err(`${CLI_NAME}: 예상 못 한 오류 — ${e && e.stack ? e.stack : e}`);
            // 🔴 어디서 터졌는지 모르면 fallback 을 허용하지 않는다. 턴이 이미 돌고 있었을
            //    가능성을 배제할 수 없고, 그 경우 재실행은 이중 실행이다. fail-closed.
            process.exitCode = EXIT.POSTSTART_FAILED;
        });
}
