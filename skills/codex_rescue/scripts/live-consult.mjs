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
import { threadNameFromRequest } from './lib/thread-name.mjs';

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
    if (!fs.existsSync(spec)) fail(EXIT.USAGE, `input file not found: ${spec}`);
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
        `could not load required modules (${gone.join(', ')}).\n${detail}\n` +
        'If they do not exist yet, only --help / --dry-run can be used.');
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
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'help', 'h', 'version', 'network']);

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
    if (v === undefined || v === true || v === '') fail(code, `--${key} is required`);
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
        fail(EXIT.USAGE, `--stamp must be 1–64 letters, digits, _ or -: "${s}"`);
    }
    return s;
}

function numOpt(opts, key, dflt) {
    if (opts[key] === undefined || opts[key] === true) return dflt;
    const n = Number(opts[key]);
    if (!Number.isFinite(n) || n < 0) fail(EXIT.USAGE, `--${key} must be a number, 0 or more: ${opts[key]}`);
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
        'Read the request file below and follow the instructions in it exactly.',
        '',
        `Request: ${requestPathWin}`,
        '',
        'You are the **independent investigator** of this case. The request is a starting point, not a boundary.',
        'Claude already failed to find the answer with the material in it. Reading the same material the same way gives the same conclusion.',
        '',
        '🔴 There is **one** line to hold — do not modify production files.',
        '',
        '- **Do not edit code.** You only analyze, diagnose and propose fixes. Claude does the actual fixing.',
        '- You may write in **exactly two places**:',
        '    ① the response document the request names',
        `    ② ${scratchRel}/    ← your workbench`,
        '  Do not create, modify or delete files outside these two. Commands that change repository state are forbidden too',
        '  (git commit, checkout, stash, reset, package installs, builds).',
        '',
        'Any other investigation is **not restricted. Dig to the end.**',
        '- **Open the sources yourself.** You may read anywhere on disk — reading outside the workspace is allowed too.',
        '  Do not trust only the excerpts quoted in the request. **When a summary and the source disagree, the source wins.**',
        '- **Run the calculations, sorting, parsing and re-aggregation yourself.** You may write and run scripts. Do not guess numbers — extract them.',
        '  Put their outputs (scripts, intermediate data, notes) on the workbench above **freely** — there is no limit on count or size,',
        '  and you do not need to delete them. Leaving them lets Claude reproduce your calculations, which is better.',
        '- **You may use the network** — search docs, issues and release notes and check them yourself.',
        '  But it is **read-only.** Never upload data anywhere (no POST/PUT, git push, publish).',
        '  🔴 **You may read credentials when the investigation needs them. But never copy their values.** (user decision, 2026-09-16)',
        '     Connecting to a DB with the settings in `.env` and the like to query the source is allowed — prefer the commands the request gives',
        '     (ways that load values without showing them, like `node -r dotenv/config`).',
        '     Never leave passwords, tokens or key values **in the response document, the workbench or command output.** The response document goes to a remote via git.',
        '     Do not use commands that print values (`cat .env`, `echo $DB_PASSWORD` etc.); if unavoidable, mask them.',
        "- Claude's hypotheses are reference material. **Drop them if wrong.** Do not spend all your time verifying them —",
        '  a hypothesis may be meaningless altogether. If the source points elsewhere, follow it there.',
        '- "The existing analysis method failed" **does not mean "do not look at that data again."**',
        '  Analyzing the same source a different way is always allowed, and usually that is the answer.',
        '',
        '🔴 **Do not give up when blocked.** Nobody is here to press approve in this run (approval_policy=never).',
        '   If it looks like you need permission, do not wait — work around it with the allowed means above and finish the investigation.',
        '   If you still cannot, state in the response **what was blocked and what you could not confirm.**',
        '   Never pretend to have checked what you did not.',
        '',
        '🔴 **Do not end with "please send more material" while material you can open now is left unopened.**',
        '   Anything with a path in the request, or findable in the workspace, you open yourself.',
        '   Only listing with `ls` or `find` is not opening — it counts as opened once you have read the content and done the calculations.',
        '',
        '- The request names the path and file name for the response. Save it at that path under that exact name.',
        '- If saving fails, print the same content as your final message. It is collected automatically.',
        '- 🔴 **Create the response document when you start the investigation, and fill it as you go.** This run can be cut off midway by the usage limit.',
        '  Written only once at the end, the whole investigation vanishes the moment it is cut.',
        '  ① Before opening any source, save the frontmatter and `## 0. 조사 계획` (what you will open, in what order) first',
        '  ② Each time you open and check a source, append the confirmed facts right away under `## 1. 내가 직접 연 원본`',
        '  ③ Write the remaining sections (the conclusions: cause, verdict, fix and so on) last, after the investigation.',
        '     Do not write conclusions before the facts — a conclusion written first drags the investigation along.',
        '- Keep the section headings the request asks for exactly as written; write everything else in the language the request itself is written in (not that of any quoted code or logs).',
        '',
        '── note for this run only ─────────────────────────────────────',
        'Extra instructions may arrive while this turn runs (the user is watching).',
        'When one arrives, **do not restart the command you were running** — carry on and apply it.',
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
        return { kind: 'turn-ended', summary: `the turn ended (status=${st})`, detail: { status: st } };
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
                summary: 'looks like it is waiting for approval — nobody can approve in this run',
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
                summary: `command: ${cmd.slice(0, 160)}`,
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
                summary: `file change attempt: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`,
                detail: { paths }
            };
        }

        // 후보 ① 조사 계획 발표. app-server 는 계획을 todoList/plan 계열 아이템으로 낸다.
        // 정확한 타입명을 실측하지 못했으므로 이름에 plan/todo 가 들어가면 전부 잡는다(보수적).
        if (m === 'item/completed' && /plan|todo/i.test(type)) {
            return {
                kind: 'plan',
                summary: 'the investigation plan is out — time to check the direction',
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
                    summary: 'started writing the final answer',
                    detail: { preview: text.slice(0, 300) }
                };
            }

            // 후보 ③ "자료가 없다/확인할 수 없다" 류.
            const low = text.toLowerCase();
            const hit = BLOCKED_PHRASES.find((ph) => low.includes(ph.toLowerCase()));
            if (hit) {
                return {
                    kind: 'blocked',
                    summary: `a blocked signal ("${hit}") — decide whether to give more material`,
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
        fail(EXIT.USAGE, `--sandbox must be read-only or workspace-write: ${sandbox}`);
    }

    // 실행 전 확인에서 사용자가 고른 모델·추론 수준 (2026-09-13). 없으면 codex 설정값을 쓴다.
    // 허용값은 모델마다 달라(스키마: "모델이 알려주는 비어 있지 않은 문자열") 목록으로 막지 않고
    // 인자에 섞이면 안 되는 문자만 거른다.
    const strOpt = (key) => {
        const v = opts[key];
        if (v === undefined) return null;
        if (v === true || !/^[A-Za-z0-9._-]+$/.test(String(v))) fail(EXIT.USAGE, `--${key} has an invalid value: ${v}`);
        return String(v);
    };
    const model = strOpt('model');
    const effort = strOpt('effort');

    // 되묻기(FOLLOWUP) 이어받기 (2026-09-17). 주면 thread/start 대신 thread/resume 으로 기존 대화를 잇는다.
    // 옛 되묻기는 `codex exec resume`(배치)이라 도중에 끼어들 수 없었다.
    // turn-seq 는 진행 패널의 항목 id 접두사 판정용이다(bridge.mjs itemIdFor — 2 이상이면 turnId 접두사).
    const resumeThread = strOpt('resume-thread');
    const turnSeqRaw = opts['turn-seq'];
    let turnSeq = 1;
    if (turnSeqRaw !== undefined) {
        if (turnSeqRaw === true || !/^[0-9]+$/.test(String(turnSeqRaw)) || Number(turnSeqRaw) < 1) {
            fail(EXIT.USAGE, `--turn-seq must be an integer of 1 or more: ${turnSeqRaw}`);
        }
        turnSeq = Number(turnSeqRaw);
    }
    // 🔴 짝을 강제한다. 이어받는데 turn-seq 가 1 이면 되묻기 턴 항목이 1턴 항목과 같은 id 가 되고,
    //    반대로 새 대화인데 2 이상이면 없는 턴 접두사가 붙는다. 둘 다 조용히 패널을 망가뜨린다.
    if (resumeThread && turnSeq < 2) fail(EXIT.USAGE, '--resume-thread needs --turn-seq of 2 or more with it');
    if (!resumeThread && turnSeqRaw !== undefined) fail(EXIT.USAGE, '--turn-seq is only used with --resume-thread');

    const scratchRel = opts['scratch-rel'] === undefined || opts['scratch-rel'] === true
        ? 'docs/codex_rescue/.scratch' : String(opts['scratch-rel']);
    const steerPollMs = numOpt(opts, 'steer-poll-ms', PENDING_DECISION.steerPollMs);
    const turnTimeoutMs = numOpt(opts, 'turn-timeout-ms', PENDING_DECISION.turnTimeoutMs);
    const requestTimeoutMs = numOpt(opts, 'request-timeout-ms', PENDING_DECISION.requestTimeoutMs);
    // UI 미러는 `.log/` **디렉토리**를 받는다 — 파일명은 runtime.writeLiveMirror 가 정한다.
    const logDir = opts['log-dir'] && opts['log-dir'] !== true ? String(opts['log-dir']) : null;

    if (!fs.existsSync(requestFile)) fail(EXIT.USAGE, `request file not found: ${requestFile}`);
    if (!fs.existsSync(cwd)) fail(EXIT.USAGE, `working directory not found: ${cwd}`);

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

    // 프롬프트는 send.sh 가 만들어 파일로 넘긴다 (2026-09-15). CONSULT·EDIT·REVIEW 가 모두 이 경로를 타면서
    // 프롬프트를 한 곳(send.sh)에서만 관리하려는 것이다. 파일이 없을 때만 예전 CONSULT 프롬프트를 쓴다.
    const promptFile = opts['prompt-file'] && opts['prompt-file'] !== true ? String(opts['prompt-file']) : null;
    if (promptFile && !fs.existsSync(promptFile)) fail(EXIT.USAGE, `prompt file not found: ${promptFile}`);
    const prompt = promptFile
        ? fs.readFileSync(promptFile, 'utf8')
        : buildConsultPrompt({ requestPathWin: winPath(requestFile), scratchRel });
    if (!prompt.trim()) fail(EXIT.USAGE, 'the prompt is empty');

    // 네트워크 해금 (2026-09-15). exec 경로의 `-c sandbox_workspace_write.network_access=true` 와 같은 효과를
    // turn/start 의 sandboxPolicy 로 준다. workspaceWrite 정책은 cwd 를 항상 쓰기 루트에 넣는다(codex-rs protocol.rs).
    // read-only 에는 붙이지 않는다 — send.sh 와 같은 이유로, 효력 없이 "허용" 인상만 남긴다.
    const network = opts['network'] === true && sandbox === 'workspace-write';
    if (opts['network'] === true && !network) fail(EXIT.USAGE, '--network is only for --sandbox workspace-write');

    // ── dry-run: codex 를 부르지 않고 조립 결과만 보여준다 ──
    if (opts['dry-run']) {
        const dir = mods.runtime ? mods.runtime.runtimePath(stamp) : guessRuntimeDir(stamp);
        const port = opts['port'] === undefined || opts['port'] === true
            ? '(auto — takes a free port)' : Number(opts['port']);
        out('── DRYRUN (run) — codex is not run ──');
        out('subcommand   : run');
        out(`stamp        : ${stamp}`);
        out(`request      : ${requestFile}`);
        out(`request (win): ${winPath(requestFile)}`);
        out(`working dir  : ${cwd}`);
        out(`thread       : ${resumeThread ? `resume thread/resume ${resumeThread} (turn ${turnSeq})` : 'new thread/start'}`);
        out(`sandbox      : ${sandbox}${network ? ' +net (turn/start sandboxPolicy.networkAccess)' : ''}   (approvalPolicy=never, fixed)`);
        out(`prompt       : ${promptFile ? promptFile + '   (file made by send.sh)' : 'built-in CONSULT prompt (no --prompt-file)'}`);
        out(`model        : ${model || '(codex config)'}`);
        out(`reasoning    : ${effort || '(codex config)'}`);
        out(`port         : ${port}`);
        out('app-server   : codex app-server --listen ws://127.0.0.1:<port>' +
            (IS_WIN ? ' -c windows.sandbox=unelevated' : ''));
        out(`runtime dir  : ${dir}${mods.runtime ? '' : '   (lib/runtime.mjs not loaded — an estimate)'}`);
        if (mods.runtime) out(`  state (authority): ${mods.runtime.statePath(stamp)}`);
        out(`  signals     : ${CLI_FILES.signals(dir)}`);
        out(`events       : ${eventsFile}`);
        out(`last_message : ${lastMessageFile}`);
        out(`appserver-log: ${appserverLog}`);
        out(`steers-log   : ${steersLog}`);
        out(`UI mirror    : ${logDir ? path.join(logDir, stamp + '_live.json') : '(no --log-dir — not written)'}`);
        out(`steer poll   : ${steerPollMs}ms`);
        out(`request cap  : ${requestTimeoutMs}ms   (not the turn length — an RPC round-trip cap)`);
        out(`turn cap     : ${turnTimeoutMs === 0 ? 'unlimited (same as classic CONSULT)' : turnTimeoutMs + 'ms'}`);
        if (runtimeDirOpt && runtimeDirOpt !== true) {
            out(`--runtime-dir given: ${runtimeDirOpt}`);
            out('  ⚠ runtime.mjs decides the real location — this value is only recorded');
        }
        if (missing.length) {
            out('');
            out('⚠ modules not present yet:');
            for (const m of missing) out(`  - lib/${m.name}.mjs`);
        }
        out('');
        out('── prompt ──');
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

    // 병렬 묶음(2026-10-01) — send.sh 가 다듬어 export 한 값을 그대로 쓴다. 여기서 다르게 다듬으면
    // send.sh 가 쓴 status 와 값이 어긋나 카드가 쓸 때마다 묶음을 오간다.
    const group = process.env.CR_GROUP || '';
    const groupSession = process.env.CR_GROUP_SESSION || '';
    const groupFields = group ? Object.assign({ group }, groupSession ? { group_session: groupSession } : {}) : {};

    const writeStatus = (state, extra) => {
        if (!statusFile) return;
        const body = Object.assign({
            schema: 1, stamp, slug: reqSlug,
            mode: 'live', kind: 'consult', state,
            started_at: startedAtIso, finished_at: null, codex_exit: null, tee_exit: null,
        }, reqSubject ? { subject: reqSubject } : {}, groupFields, extra || {});
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
    const ctx = { threadId: null, turnId: null, turnSeq };
    const pendingNotes = [];
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    // 이어받기면 같은 스탬프에 앞 턴의 개입 기록이 남아 있다. 이번 실행 요약에는 이번 턴 것만 보인다 —
    // 안 그러면 1턴에서 이미 보고된 미전달이 "이번에 말이 안 들어갔다"로 다시 찍힌다.
    const priorSteerNonces = new Set();
    const listUndeliveredThisRun = async () => {
        const all = await runtime.listUndeliveredSteer(stamp).catch(() => []);
        return all.filter((it) => !priorSteerNonces.has(it.nonce));
    };

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
                summary: `the server sent a request (${req && req.method}) — refused, not auto-approved`,
                detail: { method: req && req.method }
            });
            try {
                conn.respondError(req.id, -32601,
                    `${CLI_NAME}: this run is unattended and has no approver (approval_policy=never). Request refused.`);
            } catch { /* 응답 실패는 서버 쪽 타임아웃으로 처리된다 */ }
        });

        // ── 4) 알림 → exec 호환 이벤트 ──
        const consumeNotification = (note) => {
            // turn/start 응답 전에는 보류한다. 응답 id 와 일치한 알림만 본 상태에 넣는다.
            const ownership = bridge.notificationOwnership(note, ctx);
            if (ownership === 'pending') {
                pendingNotes.push(note);
                return;
            }
            if (ownership !== 'owned' && ownership !== 'global') {
                const meta = bridge.makeSubagentEvent(note, ctx);
                if (meta) appendJson(eventsFile, meta);
                return;
            }
            // 최종 메시지는 알림에서 직접 건진다. app-server 에는 `-o` 가 없으므로 우리가 모아야 한다.
            if (note.method === 'item/completed') {
                const item = (note.params && note.params.item) || {};
                if (item.type === 'agentMessage' && item.phase === FINALIZE_PHASE && item.text) {
                    finalText = String(item.text);
                }
            }
            if (note.method === 'turn/completed') {
                turnStatus = (note.params && note.params.turn && note.params.turn.status) || 'unknown';
                resolveDone('completed');
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
        };
        conn.onNotification(consumeNotification);

        // ── 5) 핸드셰이크 ──
        await conn.request('initialize', {
            clientInfo: { name: `claude-state-bar-${CLI_NAME}`, version: CLI_VERSION }
        });
        conn.notify('initialized', {});

        // ── 6) thread/start 또는 thread/resume ── (여기까지 실패 = PRESTART)
        let th;
        if (resumeThread) {
            // 되묻기 (2026-09-17). 🔴 sandbox·approvalPolicy 를 **반드시 명시한다.**
            //    `codex exec resume` 은 첫 턴의 샌드박스를 상속하지 않았다(2026-08-22 CHAT 실측 — 쓰기가 뚫렸다).
            //    resume 도 값을 안 주면 각 머신 config.toml 기본값으로 떨어질 수 있다고 보고 막는다.
            // excludeTurns — 지난 턴 기록을 응답에 싣지 않는다. 우리는 그 기록을 쓰지 않고, 긴 대화면 응답만 커진다.
            th = await conn.request('thread/resume', {
                threadId: resumeThread,
                cwd,
                sandbox,
                approvalPolicy: 'never',
                excludeTurns: true
            });
        } else {
            th = await conn.request('thread/start', {
                cwd,
                sandbox,
                // 🔴 기존 CONSULT 의 동작을 보존한다. exec 에서는 never 로 고정돼 있었고,
                //    여기서 완화하면 "승인을 누를 사람이 없는데 승인을 기다리는" 상태가 생긴다.
                approvalPolicy: 'never'
            });
        }
        threadId = (th && th.thread && th.thread.id) || null;
        if (!threadId) fail(EXIT.PRESTART_FAILED, `${resumeThread ? 'thread/resume' : 'thread/start'} response has no threadId`);
        // 🔴 다른 대화가 돌아오면 턴을 시작하지 않는다. 맥락 없는 답이 "되묻기 답"으로 문서에 붙는다.
        if (resumeThread && threadId !== resumeThread) {
            fail(EXIT.PRESTART_FAILED, `thread/resume returned a different thread (asked ${resumeThread} · got ${threadId})`);
        }
        if (resumeThread) {
            // 서버가 실제로 적용한 값을 남긴다 — 샌드박스가 요청대로 됐는지 사후에 대조하는 근거다.
            const applied = {
                sandbox: th.sandbox ?? null, approvalPolicy: th.approvalPolicy ?? null,
                model: th.model ?? null, reasoningEffort: th.reasoningEffort ?? null, cwd: th.cwd ?? null
            };
            appendJson(appserverLog, { at: nowIso(), ms: Date.now() - t0, kind: 'resume-applied', threadId, ...applied });
            err(`→ thread resumed (thread=${threadId} · turn ${turnSeq}) server applied: ${JSON.stringify(applied)}`);
        }
        ctx.threadId = threadId;
        await runtime.patchState(stamp, { threadId });

        // 새 대화에 이름을 붙인다 (2026-09-17). 이름이 없으면 Codex 앱·CLI 목록이 첫 메시지
        // "아래 요청서 파일을 읽고…"로만 보여 구분이 안 된다. 되묻기는 1턴의 이름을 그대로 둔다.
        // 부가 기능이라 실패해도 턴은 시작한다.
        if (!resumeThread) {
            const threadName = threadNameFromRequest(winPath(requestFile));
            if (threadName) {
                try {
                    await conn.request('thread/name/set', { threadId, name: threadName });
                    err(`→ thread name: ${threadName}`);
                } catch (e) {
                    err(`⚠️ could not set the thread name (the run continues): ${e && e.message}`);
                }
            }
        }

        // 🔴 이어받기면 앞 실행이 남긴 끼어들기 요청을 이번 턴에 넣지 않는다.
        //    정상 종료한 실행은 턴이 끝날 때 큐를 비우므로(아래 9) 잔여 처리) 여기 남는 것은
        //    앞 턴이 강제 종료됐을 때뿐이다. 그 말은 앞 턴을 향한 것이라 새 턴에 들어가면 엉뚱한 지시가 된다.
        if (resumeThread) {
            for (const it of await runtime.listUndeliveredSteer(stamp).catch(() => [])) priorSteerNonces.add(it.nonce);
            try {
                const stale = await runtime.drainSteer(stamp);
                for (const item of (stale || [])) {
                    const message = 'the intervention targeted an earlier turn, so it was not put into this one';
                    appendJson(steersLog, {
                        at: nowIso(), seq: item.seq, nonce: item.nonce,
                        source: item.source || 'unknown', text: item.text, accepted: false, error: message
                    });
                    await runtime.recordSteerOutcome(stamp, {
                        seq: item.seq, nonce: item.nonce, outcome: 'rejected',
                        text: item.text, error: { message }
                    }).catch(() => { });
                    err(`⚠ ${message}: #${item.seq}`);
                }
            } catch { /* 잔여 정리 실패가 턴 시작을 막지는 않는다 */ }
        }

        // exec 호환 스트림의 첫 줄. 응답이 알림보다 먼저 오므로(실측 760ms) 여기서 내야
        // 순서가 exec 와 같아진다. 알림으로 한 번 더 와도 무해하다(thread_id 덮어쓰기).
        appendJson(eventsFile, bridge.makeThreadStartedEvent(threadId));

        // ── 7) turn/start ──
        // 🔴 이 await 이 성공으로 돌아온 순간부터 fallback 금지 구간이다.
        //    turn/start 응답은 3ms 만에 오고 turnId 가 그 안에 있다(실측). turn/started
        //    알림(1213ms)을 기다릴 필요가 없다.
        let turnRes;
        try {
            // 모델·추론 수준은 실행 전 확인에서 사용자가 바꾼 경우에만 넘어온다(2026-09-13).
            // 안 넘어오면 필드를 아예 빼서 codex 설정값을 그대로 쓴다.
            turnRes = await conn.request('turn/start', {
                threadId,
                input: [{ type: 'text', text: prompt }],
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(network ? { sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } } : {})
            });
        } catch (e) {
            // 요청 자체가 거부됐다 = 턴이 시작되지 않았다 → 아직 PRESTART 다.
            fail(EXIT.PRESTART_FAILED, `turn/start failed: ${(e && e.message) || e}`);
        }
        turnId = (turnRes && turnRes.turn && turnRes.turn.id) || null;
        if (!turnId) fail(EXIT.PRESTART_FAILED, 'turn/start response has no turnId');

        started = true;
        ctx.turnId = turnId;
        for (const note of pendingNotes.splice(0)) consumeNotification(note);
        await runtime.setPhase(stamp, 'active', { activeTurnId: turnId });
        mirror(true, turnId);
        err(`→ turn started (thread=${threadId} turn=${turnId})`);

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
            err('⚠ could not open the steer channel — the turn runs without interventions');
        }

        // ── 9) turn/completed 대기 + steer 큐 펌프 ──
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
                const message = 'the steer channel is not open';
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
                const message = ok ? null : 'the turnId in the turn/steer response differs from the current turn';
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
                const message = 'the turn had already ended, so it was not delivered';
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

        if (why === 'closed') fatalPost = 'the app-server connection closed while the turn was running';
        else if (why === 'timeout') fatalPost = `hit the turn cap (${turnTimeoutMs}ms)`;

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
                err(`⚠ saving the final message failed: ${(e && e.message) || e}`);
            }
        }

        // 전달하지 못한 개입이 있으면 조용히 삼키지 않는다 — 사용자가 한 말이 사라진 것이다.
        const undelivered = await listUndeliveredThisRun();

        if (fatalPost) {
            await finish('failed', { message: fatalPost });
            printRunSummary({
                threadId, turnId, status: 'interrupted', steerDelivered, steerRejected,
                undelivered, lastMessageFile, eventsFile, runtimeDir,
                exitClass: 'poststart-failed', note: fatalPost
            });
            err(`🔴 ${fatalPost} — 🔴 no automatic fallback. The same request would run twice.`);
            return why === 'timeout' ? EXIT.TURN_TIMEOUT : EXIT.POSTSTART_FAILED;
        }

        await finish('done');
        printRunSummary({
            threadId, turnId, status: turnStatus || 'unknown', steerDelivered, steerRejected,
            undelivered, lastMessageFile, eventsFile, runtimeDir,
            exitClass: turnStatus === 'completed' ? 'ok' : 'turn-failed'
        });

        if (turnStatus !== 'completed') {
            err(`🔴 the turn ended with status=${turnStatus} — no automatic fallback.`);
            return EXIT.TURN_FAILED;
        }
        return EXIT.OK;

    } catch (e) {
        const msg = (e && e.message) || String(e);
        // 🔴 실패 경계는 `started` 하나로 판정한다. 예외가 어디서 났든 turn/start 응답을
        //    이미 받았다면 Codex 는 돌기 시작한 것이고, 그러면 재실행은 이중 실행이다.
        if (started) {
            await finish('failed', { message: msg });
            const undelivered = await listUndeliveredThisRun();
            printRunSummary({
                threadId, turnId, status: 'error', steerDelivered, steerRejected,
                undelivered, lastMessageFile, eventsFile, runtimeDir,
                exitClass: 'poststart-failed', note: msg
            });
            err(`🔴 failed after the turn started: ${msg}`);
            err('🔴 no automatic fallback — the same request would run twice. Report it as a failure.');
            return EXIT.POSTSTART_FAILED;
        }
        await finish('failed', { message: msg });
        const code = e instanceof CliError ? e.code : EXIT.PRESTART_FAILED;
        err(`failed before the turn started: ${msg}`);
        if (code === EXIT.PRESTART_FAILED) err('exit 10: the turn probably did not start, but a lost turn/start reply looks the same — no automatic fallback (only exit 11 is safe).');
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
        fail(EXIT.USAGE, `--source must be user-via-claude or claude-monitor: ${source}`);
    }
    const confirmTimeoutMs = numOpt(opts, 'timeout-ms', PENDING_DECISION.steerConfirmTimeoutMs);
    const pollMs = numOpt(opts, 'poll-ms', PENDING_DECISION.filePollMs);

    if (opts['dry-run']) {
        const dir = mods.runtime ? mods.runtime.runtimePath(stamp) : guessRuntimeDir(stamp);
        const text = await readTextInput(inputFile);
        out('── DRYRUN (steer) — not queued ──');
        out(`stamp      : ${stamp}`);
        out(`source     : ${source}`);
        out(`input      : ${inputFile === '-' ? '(stdin)' : inputFile}`);
        out(`body length: ${text.length} chars / ${Buffer.byteLength(text, 'utf8')} bytes`);
        out(`runtime    : ${dir}${mods.runtime ? '' : '   (lib/runtime.mjs not loaded — an estimate)'}`);
        out(`confirm cap: ${confirmTimeoutMs}ms`);
        out('');
        out('── body (first 500 chars) ──');
        out(text.slice(0, 500));
        return EXIT.OK;
    }

    requireLib(mods, missing, ['runtime']);
    const runtime = mods.runtime;

    const text = await readTextInput(inputFile);
    if (!text.trim()) fail(EXIT.USAGE, 'the input is empty — an empty steer is not sent');

    const state = await runtime.readState(stamp);
    // 🔴 phase 만 보지 않는다. checkSteerable 은 pid 생존·host 일치·스키마까지 본다 —
    //    임시 디렉토리가 공유되는 환경에서 남의 실행을 조종하는 사고를 막는 장치다.
    //    끝난 실행의 큐에 넣으면 아무도 비우지 않아 영영 대기하므로 여기서 잘라낸다.
    const check = runtime.checkSteerable(state, { stamp });
    if (!check.ok) {
        out(`cannot intervene now (stamp=${stamp})`);
        for (const r of check.reasons) out(`  · ${r}`);
        out('  no new turn is created.');
        return EXIT.NO_RUNTIME;
    }

    // 🔴 nonce 는 **요청별 멱등 키**다. 실행 nonce(state.nonce)를 넣으면 두 번째 개입부터
    //    duplicate 로 무시되어 조용히 사라진다. 요청마다 새로 만든다.
    const reqNonce = runtime.makeNonce();
    const { seq, duplicate } = await runtime.enqueueSteer(stamp, { text, source, nonce: reqNonce });
    if (duplicate) {
        // 새 nonce 를 만들었으므로 정상 경로에서는 나올 수 없다. 나왔다면 상태가 이상한 것이다.
        out(`already in the queue · seq=${seq}`);
    }

    // 🔴 여기서 끝내면 안 된다. 큐에 넣은 것은 전달이 아니다.
    //    run 프로세스가 turn/steer 응답을 받아 결과를 남길 때까지 기다린다.
    const deadline = Date.now() + confirmTimeoutMs;
    while (Date.now() < deadline) {
        const outcomes = await runtime.listSteerOutcomes(stamp).catch(() => []);
        const rec = outcomes.find((o) => o && o.nonce === reqNonce);
        if (rec) {
            if (rec.outcome === 'delivered') {
                out(`delivered · seq=${seq} · turnId=${rec.turnId} · source=${source}`);
                out('  turn/steer answered with the same turnId — it really went into the running turn.');
                return EXIT.OK;
            }
            if (rec.outcome === 'unknown') {
                // 응답을 못 본 채 끊긴 경우다. 전달됐다고 말하지 않는다.
                out(`delivery unknown · seq=${seq}`);
                out(`  reason: ${(rec.error && rec.error.message) || '(no reason)'}`);
                out('  delivery could not be confirmed — safest to assume it was not delivered.');
                return EXIT.STEER_TIMEOUT;
            }
            // 🔴 사유를 가공하지 않고 그대로 낸다.
            out(`refused · seq=${seq}`);
            if (rec.error && rec.error.code !== undefined && rec.error.code !== null) {
                out(`  code: ${rec.error.code}`);
            }
            out(`  reason: ${(rec.error && rec.error.message) || '(no reason)'}`);
            out('  no new turn was created.');
            return EXIT.STEER_REJECTED;
        }
        // 그 사이 실행이 끝났으면 더 기다릴 이유가 없다.
        const cur = await runtime.readState(stamp);
        if (!cur || cur.phase !== 'active') {
            out(`confirmation failed · seq=${seq}`);
            out(`  queued, but the run ended before delivery was confirmed (phase=${cur ? cur.phase : 'none'}).`);
            out('  safest to assume it was not delivered.');
            return EXIT.STEER_TIMEOUT;
        }
        await sleep(pollMs);
    }

    out(`confirmation failed · seq=${seq}`);
    out(`  no delivery confirmation within ${confirmTimeoutMs}ms. It is in the queue.`);
    out('  check delivery afterwards in the steers log.');
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
        out('── DRYRUN (wait) — not waiting ──');
        out(`stamp      : ${stamp}`);
        out(`after seq  : ${after} (waits for signals above this)`);
        out(`signal file: ${CLI_FILES.signals(dir)}${mods.runtime ? '' : '   (lib/runtime.mjs not loaded — an estimate)'}`);
        out(`wait cap   : ${timeoutMs}ms   🔴 decision needed (provisional)`);
        out('');
        out('── counted as high signals ──');
        for (const l of SIGNAL_DOC) out(`  ${l}`);
        return EXIT.OK;
    }

    requireLib(mods, missing, ['runtime']);
    const runtime = mods.runtime;

    const state = await runtime.readState(stamp);
    if (!state) fail(EXIT.NO_RUNTIME, `no run state for this stamp: ${stamp}`);

    const signalsFile = CLI_FILES.signals(runtime.runtimePath(stamp));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const sig = readSignalAfter(signalsFile, after);
        if (sig) {
            out(`signal seq=${sig.seq} · ${sig.kind}`);
            out(sig.summary || '');
            if (sig.detail) {
                const d = JSON.stringify(sig.detail);
                out(`  detail: ${d.length > 600 ? d.slice(0, 600) + '…' : d}`);
            }
            out(`  next wait: --after ${sig.seq}`);
            return EXIT.OK;
        }
        const cur = await runtime.readState(stamp);
        if (!cur || (cur.phase !== 'active' && cur.phase !== 'starting' && cur.phase !== 'finalizing')) {
            // 종료 자체도 고신호라 보통은 위에서 잡힌다. 여기 오는 건 신호 파일을
            // 못 쓰고 끝난 경우이므로 그 사실을 그대로 알린다.
            out(`no signal — the run ended (phase=${cur ? cur.phase : 'none'})`);
            return EXIT.OK;
        }
        await sleep(pollMs);
    }

    out(`wait cap (${timeoutMs}ms) reached — no high signal`);
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
        out(`stamp   : ${stamp}`);
        out(`runtime : ${dir}${mods.runtime ? '' : '   (lib/runtime.mjs not loaded — an estimate)'}`);
        return EXIT.OK;
    }

    requireLib(mods, missing, ['runtime']);
    const runtime = mods.runtime;
    const state = await runtime.readState(stamp);
    if (!state) {
        out(`no run state (stamp=${stamp})`);
        return EXIT.NO_RUNTIME;
    }

    if (opts['json']) { out(JSON.stringify(state, null, 2)); return EXIT.OK; }

    const dir = runtime.runtimePath(stamp);
    const alive = runtime.isPidAlive(state.pid);
    out(`stamp     : ${state.stamp}`);
    out(`phase     : ${state.phase}${state.phase === 'active' && !alive ? '  ⚠ pid is dead (crash)' : ''}`);
    out(`host/PID  : ${state.host} / ${state.pid} (${alive ? 'alive' : 'gone'})`);
    out(`port      : ${state.port}`);
    out(`thread    : ${state.threadId || '(none)'}`);
    out(`active turn: ${state.activeTurnId || '(none)'}`);
    out(`started   : ${state.startedAt}`);
    out(`runtime   : ${dir}`);

    // 개입 현황은 state.steerSeq(전달 성공 수)만으로 부족하다. 거부·불명까지 보여야
    // "내가 한 말이 들어갔나"에 답할 수 있다.
    const outcomes = await runtime.listSteerOutcomes(stamp).catch(() => []);
    if (outcomes.length) {
        const tally = { delivered: 0, rejected: 0, unknown: 0 };
        for (const o of outcomes) if (tally[o.outcome] !== undefined) tally[o.outcome] += 1;
        out(`steers    : delivered ${tally.delivered} · refused ${tally.rejected} · unknown ${tally.unknown}`);
        for (const o of outcomes.slice(-3)) {
            const why = o.error && o.error.message ? ` — ${o.error.message}` : '';
            out(`  seq=${o.seq} ${o.outcome}${why}`);
        }
    } else {
        out('steers    : none');
    }

    const undelivered = await runtime.listUndeliveredSteer(stamp).catch(() => []);
    if (undelivered.length) {
        out(`🔴 ${undelivered.length} steers not delivered — their text is kept in the runtime`);
    }

    const sigFile = CLI_FILES.signals(dir);
    if (fs.existsSync(sigFile)) {
        const lines = fs.readFileSync(sigFile, 'utf8').split('\n').filter((l) => l.trim());
        out(`signals   : ${lines.length}`);
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
    'plan            an investigation plan appeared (any item type containing plan/todo)',
    'command-started a new command started — with the command line and cwd',
    'file-change     a file change attempt — with the target paths (CONSULT must not edit)',
    'blocked         a "no material / cannot confirm" style phrase in a non-final message',
    'finalizing      started writing the final answer (phase=final_answer)',
    'waiting-approval looks like waiting for approval — nobody can approve in this run',
    'server-request  the server sent the client a request (refused and recorded)',
    'turn-ended      the turn ended'
];

function printHelp() {
    const H = [
        `${CLI_NAME} ${CLI_VERSION} — CONSULT runner on codex app-server`,
        '',
        'Classic CONSULT ran codex exec as a batch, so no intervention was possible. This tool uses app-server',
        'turn/steer to push new input into the running turn, while leaving its outputs (events.jsonl ·',
        'last_message.md) in the same shape as before.',
        '',
        'Usage:',
        `  node ${CLI_NAME}.mjs <subcommand> [options]`,
        `  node ${CLI_NAME}.mjs --help`,
        '',
        '  Add --dry-run to any subcommand to print what would be assembled without calling codex.',
        '',
        '───────────────────────────────────────────────────────────────',
        'run   — called by send.sh. Waits for the turn to finish and leaves compatible results',
        '',
        '  --request-file <abs path>     request file; the prompt is built from it (required)',
        '  --runtime-dir <path>          authoritative state dir (recorded only · runtime.mjs decides the real location)',
        '  --events-file <path>          events.jsonl (exec compatible) (required)',
        '  --last-message-file <path>    last_message.md (required)',
        '  --appserver-log <path>        raw app-server log (audit, debugging) (required)',
        '  --steers-log <path>           steer record (required)',
        '  --stamp <stamp>              (required)',
        '  --cwd <working dir>          (required)',
        '  --sandbox read-only|workspace-write   default read-only',
        '  --prompt-file <path>          prompt body; send.sh builds it per mode',
        '                                (omitted: built-in CONSULT prompt — for older callers)',
        '  --network                     allow network (turn/start sandboxPolicy). workspace-write only',
        '  --port <port>                 omitted: a free port is taken (fixed ports collide)',
        '  --scratch-rel <path>          Codex workbench. default docs/codex_rescue/.scratch',
        '  --log-dir <path>              .log dir for the UI mirror (<stamp>_live.json)',
        '  --steer-poll-ms <ms>          steer queue poll interval. default ' + PENDING_DECISION.steerPollMs + '   🔴 decision needed',
        '  --request-timeout-ms <ms>     RPC round-trip cap. default ' + PENDING_DECISION.requestTimeoutMs + '   🔴 decision needed',
        '                                (not the turn length — turn/completed arrives as a notification)',
        '  --turn-timeout-ms <ms>        turn cap. default 0 = unlimited (keeps classic CONSULT behavior)',
        '  --model <model>               model for this turn. omitted: codex config',
        '  --effort <level>              reasoning level for this turn (low, medium, high...). omitted: codex config',
        '  --resume-thread <id>          follow-up: continue this thread with thread/resume instead of a new one',
        '  --turn-seq <N>                follow-up turn number (2 or more). Always with --resume-thread',
        '',
        '  prints a LIVE_CONSULT_RESULT block on stdout (send.sh reads it):',
        '    thread_id · turn_id · status · steer_delivered · steer_rejected',
        '    steer_undelivered (+seq list) · last_message · events · runtime · exit_class',
        '',
        '───────────────────────────────────────────────────────────────',
        'steer — delivers new input to the running turn',
        '',
        '  --stamp <stamp>                                  (required)',
        '  --input-file <file|->                             body; - means stdin (required)',
        '  --source user-via-claude|claude-monitor           default user-via-claude',
        '  --timeout-ms <ms>    delivery confirmation cap. default ' + PENDING_DECISION.steerConfirmTimeoutMs + '   🔴 decision needed',
        '',
        '  🔴 Do not pass long non-ASCII text as argv. Windows CreateProcess has a 32,767-char limit',
        '     (measured: 32,000 B ok / 32,700 B failed), and Korean hits it sooner at 3 bytes per char in UTF-8.',
        '  🔴 "delivered" is printed only after turn/steer answers with the same turnId. Only queueing',
        '     it is not delivery. When refused, the reason from the server is printed as is.',
        '',
        '───────────────────────────────────────────────────────────────',
        'wait  — one-shot wait for a high signal that needs a decision (for Claude as a monitor)',
        '',
        '  --stamp <stamp>       (required)',
        '  --after <seq>          waits for signals above this seq. default 0',
        '  --timeout-ms <ms>      wait cap. default ' + PENDING_DECISION.waitTimeoutMs + '   🔴 decision needed',
        '',
        '  counted as high signals (biased toward waking too often rather than missing one):',
        ...SIGNAL_DOC.map((l) => '    ' + l),
        '',
        '───────────────────────────────────────────────────────────────',
        'status — current state (diagnostics)',
        '',
        '  --stamp <stamp>   (required)',
        '  --json             prints the raw state JSON',
        '',
        '───────────────────────────────────────────────────────────────',
        'Exit codes — 🔴 the failure boundary lives here',
        '',
        `  ${EXIT.OK}   ok`,
        `  ${EXIT.USAGE}   argument error (nothing was run)`,
        '',
        '  ── 10–19: ended before turn/start was confirmed ──',
        `  ${EXIT.PRESTART_FAILED}  server start / initialize / thread/start / turn/start failed — turn/start may still have been sent: 🔴 no automatic fallback`,
        `  ${EXIT.LIB_MISSING}  could not load lib/*.mjs — nothing was sent: the only safe automatic fallback to codex exec`,
        '',
        '  ── 20–29: ended after turn/start → 🔴 no automatic fallback ──',
        `  ${EXIT.POSTSTART_FAILED}  the connection closed or the server died while the turn was running`,
        `  ${EXIT.TURN_FAILED}  turn/completed arrived with status=failed`,
        `  ${EXIT.TURN_TIMEOUT}  hit the --turn-timeout-ms cap`,
        '',
        '  ── 30–39: steer ──',
        `  ${EXIT.STEER_REJECTED}  turn/steer was refused (the reason is printed as is)`,
        `  ${EXIT.NO_RUNTIME}  no such run, or it cannot take interventions (the reasons are listed)`,
        `  ${EXIT.STEER_TIMEOUT}  queued but no delivery confirmation / delivery unknown`,
        '',
        '  ── 40–49: wait ──',
        `  ${EXIT.WAIT_TIMEOUT}  reached the cap with no high signal`,
        '',
        '───────────────────────────────────────────────────────────────',
        'Approval requests',
        '  🔴 Never auto-approved, and never waited on forever. This run uses approval_policy=never,',
        '     so normally no approval request arrives at all. If a server request comes anyway,',
        '     it is refused fail-closed, recorded in the steers log and raised as a high signal.',
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
        err(`unknown subcommand: ${sub}`);
        err('It must be one of run, steer, wait, status. See --help.');
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
        err(`${CLI_NAME}: unexpected error while handling ${sub} — ${e && e.stack ? e.stack : e}`);
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
            err(`${CLI_NAME}: unexpected error — ${e && e.stack ? e.stack : e}`);
            // 🔴 어디서 터졌는지 모르면 fallback 을 허용하지 않는다. 턴이 이미 돌고 있었을
            //    가능성을 배제할 수 없고, 그 경우 재실행은 이중 실행이다. fail-closed.
            process.exitCode = EXIT.POSTSTART_FAILED;
        });
}
