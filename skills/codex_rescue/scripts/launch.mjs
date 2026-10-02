#!/usr/bin/env node
// launch.mjs — send.sh 를 Claude 의 Bash 명령과 떼어서 띄운다 (2026-10-02 사용자 결정 — 항상 분리 실행)
//
// 왜 필요한가 — Claude 의 백그라운드 명령은 기본 30분·최대 2시간에 강제 종료되고, 창 재로드에도 같이
// 끊긴다(2시간 정각에 끊긴 실측이 있다). send.sh 가 그 명령의 자식이면 Codex 실행도 같이 죽는다.
// 그래서 send.sh 를 떼어서 띄우고, Claude 는 이 런처가 알려 주는 감시 명령(wait-run.mjs)으로 결과를 받는다.
//
// 떼는 방법: Node `spawn(bash, …, { detached: true, windowsHide: true, stdio: ['ignore', 파일, 파일] })` + `unref()`.
// 이 PC(Windows + Git Bash)에서 부모 Bash 명령이 시간 제한으로 강제 종료돼도 살아남는 것을 실측했다(2026-10-02).
// setsid·nohup 에 기대지 않고 세 OS 모두 이 경로 하나로 간다(macOS 에는 setsid 가 없다).
// bash 는 런처를 부른 셸의 `$BASH` 를 받는다 — 그 셸과 같은 bash 로 send.sh 가 돈다.
//
// 사용법 (Claude 는 동기 Bash 로 부른다 — 몇 초 안에 끝난다):
//   node launch.mjs --bash "$BASH" <send.sh 에 넘길 인자 그대로>
//     <요청서 경로>                    CONSULT · EDIT · RESUME
//     --review --slug <슬러그> […]     REVIEW — 스탬프는 이 런처가 정해 CR_STAMP 로 넘긴다
//     --followup <반박서 경로>          FOLLOWUP
//   환경변수(CR_* · CLAUDE_CODE_SESSION_ID)는 그대로 물려준다. CHAT 은 동기 실행이라 받지 않는다.
//
// .log/ 에 남기는 파일 (스탬프 묶음 이름 — 정리기·확장이 `^\d{6}_\d{6}_` 로 묶는다):
//   <접두>_launch.out   send.sh 표준 출력 = Claude 가 받던 결과 보고
//   <접두>_launch.err   send.sh 표준 오류
//   <접두>_launch.exit  send.sh 종료 코드. 감싸는 셸이 send.sh 가 **완전히** 끝난 뒤 rename 으로 만든다
//                       (status.json 의 done 은 마지막 출력보다 먼저 쓰일 수 있어 완료 표시로 부족하다)
//   <접두>_reported     결과를 Claude 에게 넘겼다는 표식 — wait-run.mjs 가 쓴다
//   접두 = 첫 턴 `<스탬프>`, 되묻기 턴 N `<스탬프>_t<N>`. 같은 접두로 새로 띄울 때는 옛 launch·reported 를 먼저 지운다.
//
// 종료 코드:
//   0  떼어서 띄웠다(잠금 확인) — 감시 명령을 출력한다
//   N  send.sh 가 시작 전에 끝났다(거부·인자 오류·DRYRUN) — 그 출력을 그대로 보여 주고 send.sh 종료 코드로 끝낸다
//   2  런처 인자 오류 · 같은 스탬프가 이미 실행 중(잠금 있음 — 감시 명령만 알려 준다) · 같은 초의 REVIEW 충돌
//   1  띄우기 자체가 실패했다

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    STALE_AFTER_MS, STAMP_RE, slash, logDirOf, launchPrefix, launchFiles, watchCommand,
    mtimeOf, readExitCode, writeReported
} from './wait-run.mjs';
// 파일을 폴링하는 간격은 중계기(wait / steer)와 같은 값을 쓴다 — 여기서 새 숫자를 만들지 않는다.
import { PENDING_DECISION } from './live-consult.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEND_SH = path.join(SCRIPTS_DIR, '..', 'send.sh');
const IS_WIN = process.platform === 'win32';
// send.sh 를 시작하고 잠금을 잡을 때까지 기다리는 상한 — 확장의 '응답 없음' 기준을 그대로 쓴다(2026-10-02 결정).
const START_WAIT_MS = STALE_AFTER_MS;

// send.sh 가 `.log/` 에 두는 것과 같은 내용이다. send.sh 가 시작 전에 거부하면 그쪽이 만들 기회가 없어
// launch 파일이 git 에 잡힌다 — 그래서 런처도 없을 때만 같은 파일을 만든다.
const LOG_GITIGNORE = '# codex_rescue raw run logs — never commit these.\n' +
    '# They contain full command output, MCP arguments/results and agent messages.\n' +
    '# The request/response .md files live one level up and ARE meant to be committed.\n*\n';

class LaunchError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, msg) => { throw new LaunchError(code, msg); };
const say = (s = '') => process.stdout.write(s + '\n');

// send.sh 의 fmf 와 같은 규칙 — 첫 줄 `---` 부터 다음 `---` 까지에서 `key:` 첫 값(\r 만 뺀다).
function frontmatter(file, key) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { fail(2, `cannot read ${file}: ${e.code || e.message}`); }
    const lines = text.split('\n');
    if (lines[0].replace(/\r$/, '') !== '---') fail(2, `the first line is not '---': ${file}`);
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (line === '---') break;
        const m = new RegExp(`^${key}:[ \\t]*(.*)$`).exec(line);
        if (m) return m[1];
    }
    if (!lines.slice(1).some((l) => l.replace(/\r$/, '') === '---')) fail(2, `the frontmatter has no closing '---': ${file}`);
    return '';
}

// send.sh 와 같은 루트 규칙 — 경로에 `/docs/codex_rescue/` 가 있으면 그 앞, 없으면 현재 폴더.
function rootOf(absFile) {
    const s = slash(absFile);
    const i = s.lastIndexOf('/docs/codex_rescue/');
    return i >= 0 ? s.slice(0, i) : null;
}

function localStamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// `$BASH` 는 Git Bash 에서 `/usr/bin/bash` 이고, node 에는 `C:/Program Files/Git/usr/bin/bash` 로 바뀌어 온다
// (.exe 없음). `cygpath -w` 형도 받는다.
function resolveBash(raw) {
    if (!raw) fail(2, '--bash needs the bash path — pass --bash "$BASH" from the shell that runs this');
    const cands = [raw];
    if (IS_WIN && !/\.exe$/i.test(raw)) cands.push(raw + '.exe');
    for (const c of cands) {
        try { if (fs.statSync(c).isFile()) return c; } catch { /* 다음 후보 */ }
    }
    fail(2, `bash not found: ${raw}\n  Pass --bash "$BASH" from Git Bash / bash (on Windows, cygpath -w "$BASH" also works).`);
}

function parse(argv) {
    let bash;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (rest.length === 0 && argv[i] === '--bash') { bash = argv[i + 1]; i++; continue; }
        rest.push(argv[i]);
    }
    if (rest.length === 0) {
        fail(2, 'usage: node launch.mjs --bash "$BASH" <request path> | --review --slug <slug> […] | --followup <follow-up path>');
    }
    const cwd = process.cwd();
    const first = rest[0];
    let stamp, turn, root, kind;
    const env = { ...process.env };

    if (first === '--chat') {
        fail(2, 'CHAT runs synchronously — call send.sh --chat directly, not through the launcher.');
    } else if (first === '--followup') {
        kind = 'followup';
        if (rest.length !== 2) fail(2, '--followup takes exactly one follow-up file path');
        const abs = path.resolve(cwd, rest[1]);
        if (!fs.existsSync(abs)) fail(2, `follow-up file not found: ${rest[1]}`);
        root = rootOf(abs);
        if (!root) fail(2, `the follow-up file must be under docs/codex_rescue/: ${rest[1]}`);
        stamp = frontmatter(abs, 'stamp');
        const t = frontmatter(abs, 'turn');
        if (!/^\d+$/.test(t) || Number(t) < 2) fail(2, `turn in the follow-up frontmatter must be a whole number of 2 or more: '${t}'`);
        turn = Number(t);
    } else if (first === '--review') {
        kind = 'review';
        root = slash(cwd);
        if (env.CR_STAMP !== undefined && env.CR_STAMP !== '') {
            if (!STAMP_RE.test(env.CR_STAMP)) fail(2, `CR_STAMP must be ymd_His: ${env.CR_STAMP}`);
            stamp = env.CR_STAMP;
        } else {
            stamp = localStamp();
        }
        env.CR_STAMP = stamp;   // send.sh 가 같은 스탬프를 쓰게 넘긴다
    } else {
        kind = 'request';
        const abs = path.resolve(cwd, first);
        if (!fs.existsSync(abs)) fail(2, `request file not found: ${first}`);
        root = rootOf(abs) ?? slash(cwd);
        stamp = frontmatter(abs, 'stamp');
    }
    if (!STAMP_RE.test(stamp)) fail(2, `the stamp must be ymd_His (from date "+%y%m%d_%H%M%S"): '${stamp}'`);
    return { bash: resolveBash(bash), args: rest, cwd, env, stamp, turn, root: slash(path.resolve(root)), kind };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function printBlock(title, text) {
    if (!text) return;
    say(`── ${title} ──`);
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

async function launch(o) {
    const logDir = logDirOf(o.root);
    const prefix = launchPrefix(o.stamp, o.turn);
    const files = launchFiles(logDir, prefix);
    const lock = path.join(logDir, `.${o.stamp}.lock`);
    const watch = watchCommand(o.root, o.stamp, o.turn);
    const turnNote = o.turn ? ` (turn ${o.turn})` : '';

    try { fs.mkdirSync(logDir, { recursive: true }); }
    catch (e) { fail(1, `cannot create the log directory ${slash(logDir)}: ${e.code || e.message}`); }
    try { fs.writeFileSync(path.join(logDir, '.gitignore'), LOG_GITIGNORE, { flag: 'wx' }); } catch { /* 이미 있다 */ }

    // 같은 스탬프가 이미 돌고 있으면 새로 띄우지 않는다 — 응답과 로그가 서로 덮인다.
    if (mtimeOf(lock) !== undefined) {
        process.stderr.write(`codex_rescue launch: the same stamp (${o.stamp}) is already running — not starting another one.\n` +
            `  lock: ${slash(lock)}\n` +
            '  If it is running, watch it instead (Bash(run_in_background: true, timeout: 7200000)):\n' +
            `    ${watch}\n` +
            '  If it was left over from an abnormal exit (old lock mtime, no codex process), delete the lock file and launch again.\n');
        return 2;
    }

    // 같은 접두의 옛 launch·reported 는 지난 실행 것이다 — 섞이지 않게 먼저 지운다(REVIEW 는 새 스탬프라 해당 없음).
    if (o.kind !== 'review') {
        for (const f of [files.out, files.err, files.exit, files.reported]) {
            try { fs.unlinkSync(f); } catch (e) {
                if (e.code !== 'ENOENT') fail(1, `cannot remove the previous launch file ${slash(f)}: ${e.code || e.message}`);
            }
        }
    }

    let outFd, errFd;
    try {
        outFd = fs.openSync(files.out, 'wx');
        errFd = fs.openSync(files.err, 'wx');
    } catch (e) {
        if (outFd !== undefined) fs.closeSync(outFd);
        if (e.code === 'EEXIST') {
            fail(2, `a run with the same stamp (${prefix}) was launched at the same moment — retry in a second.`);
        }
        fail(1, `cannot create the launch output files in ${slash(logDir)}: ${e.code || e.message}`);
    }

    // send.sh 를 감싸는 셸 — send.sh 가 완전히 끝난 뒤 종료 코드를 임시 파일에 쓰고 rename 한다.
    // 감시기는 이 파일 하나로 "끝났다"를 판정한다.
    const wrapper = 's=$1; x=$2; shift 2\n' +
        '"$BASH" "$s" "$@"\n' +
        'rc=$?\n' +
        'printf \'%s\\n\' "$rc" > "$x.tmp.$$" && mv -f -- "$x.tmp.$$" "$x"\n' +
        'exit "$rc"\n';
    let child;
    try {
        child = cp.spawn(o.bash, ['-c', wrapper, 'codex-rescue-launch', slash(SEND_SH), slash(files.exit), ...o.args], {
            cwd: o.cwd, env: o.env, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd]
        });
    } catch (e) {
        fail(1, `could not start bash (${o.bash}): ${e.message}`);
    } finally {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
    }
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; });
    child.unref();

    // 잠금(= send.sh 가 검증을 통과하고 실행에 들어갔다)과 종료 표시 중 먼저 오는 것을 기다린다.
    const t0 = Date.now();
    for (;;) {
        if (spawnError) fail(1, `could not start bash (${o.bash}): ${spawnError.message}`);
        const code = readExitCode(files.exit);
        if (code !== undefined) {
            // send.sh 가 시작 전에 끝났다(거부·인자 오류·DRYRUN) — Claude 가 바로 알아야 한다.
            say(`codex_rescue launch: send.sh ended right away — ${prefix}${turnNote} · exit ${code}. Nothing is running.`);
            printBlock(`send.sh stderr (${slash(files.err)})`, readText(files.err));
            printBlock(`send.sh stdout (${slash(files.out)})`, readText(files.out));
            writeReported(files.reported, { result: 'done', exit: code, via: 'launch' });
            return code;
        }
        if (mtimeOf(lock) !== undefined) break;
        if (Date.now() - t0 >= START_WAIT_MS) {
            say(`⚠️ send.sh has not taken its lock after ${START_WAIT_MS / 1000}s — it may still be checking. It was started; watch it below.`);
            break;
        }
        await sleep(PENDING_DECISION.filePollMs);
    }

    say(`codex_rescue launch: started — detached from this command`);
    say(`  stamp  : ${o.stamp}${turnNote}`);
    say(`  root   : ${o.root}`);
    say(`  pid    : ${child.pid ?? '?'}   (the wrapping bash)`);
    say(`  stdout : ${slash(files.out)}   (the result report lands here)`);
    say(`  stderr : ${slash(files.err)}`);
    say(`  exit   : ${slash(files.exit)}   (appears when send.sh has fully ended)`);
    say('');
    say('Next — run this watch command with Bash(run_in_background: true, timeout: 7200000). It ends with the result:');
    say(`  ${watch}`);
    say('If it ends with "still running", run the same watch command again. Never launch the run again.');
    return 0;
}

async function main() {
    try {
        return await launch(parse(process.argv.slice(2)));
    } catch (e) {
        if (e instanceof LaunchError) { process.stderr.write(`codex_rescue launch: ${e.message}\n`); return e.code; }
        process.stderr.write(`codex_rescue launch: unexpected error — ${e && e.stack ? e.stack : e}\n`);
        return 1;
    }
}

process.exitCode = await main();
