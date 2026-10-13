#!/usr/bin/env node
// wait-run.mjs — 따로 띄운 send.sh 실행이 끝날 때까지 지켜보고, 끝나면 결과 보고를 넘긴다 (2026-10-02)
//
// 왜 필요한가 — send.sh 를 Claude 의 Bash 명령 안에서 돌리면 그 명령의 시간 제한(기본 30분·최대 2시간)과
// 창 재로드에 실행이 같이 끊긴다(2시간 정각에 끊긴 실측이 있다). 그래서 launch.mjs 가 send.sh 를 Claude
// 명령과 떼어서 띄우고, Claude 는 이 감시 명령을 백그라운드로 걸어 결과를 받는다.
// 감시가 끊겨도 실행은 계속 돈다 — 감시만 다시 걸면 된다.
//
// 사용법:
//   node wait-run.mjs --root <프로젝트 루트> --stamp <ymd_His> [--turn <N>] [--poll-ms <ms>] [--limit-ms <ms>]
//     --turn     되묻기 턴 번호(2 이상). 첫 턴은 생략한다
//     --poll-ms  상태 확인 간격 — 시험용. 기본 15초
//     --limit-ms 대기 상한 — 시험용. 기본 110분
//
// 끝나는 경우는 셋이다:
//   ① send.sh 가 완전히 끝났다(`_launch.exit` 있음) → stderr·stdout(결과 보고)을 그대로 출력하고
//      `_reported` 를 남긴다. 종료 코드는 send.sh 종료 코드 그대로다(실패 표는 results.md 에 있다).
//      이미 끝났고 `_reported` 가 있어도 다시 출력한다 — Claude 가 다시 물을 수 있게.
//   ② 멈춘 것 같다(stale) — 끝났다는 표시가 없고 살아 있다는 신호의 수정 시각이 30초 넘게 멈춘 상태를
//      두 번 연속 봤다 → 상태와 로그 위치를 출력하고 `_reported` 에 stale 을 남긴다. 종료 코드 1.
//   ③ 대기 상한 → "still running" 과 같은 감시 명령을 출력한다. 종료 코드 0. Claude 가 감시만 다시 건다.
//   인자 오류·launch 파일 없음은 종료 코드 2.
//
// 🔴 실행을 다시 돌리지 않는다. 감시기는 읽고 알리기만 한다(사용자 결정 — 같은 실행 자동 재실행 금지).
// 🔴 `.log/<스탬프>_events.jsonl`·`_status.json`·`_heartbeat` 는 읽기만 한다 — 확장과의 계약이다.
//
// 이름 규칙의 정본은 이 파일이다. launch.mjs·reattach.mjs 가 여기서 가져다 쓴다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 확장 진행 패널의 '응답 없음' 기준과 같은 값이다(claudeStateBar src/providers/codexRescue/runDiscovery.ts
// STALE_AFTER_MS). send.sh 가 heartbeat 를 5초마다 갱신하니 6배 여유다. 새 숫자를 만들지 않는다.
export const STALE_AFTER_MS = 30_000;
// 상태 확인 간격 — 상담 응답(10–30초)의 범위 안에서 정한 값(2026-10-02 결정).
const DEFAULT_POLL_MS = 15_000;
// Claude 명령 최대 시간(2시간)보다 먼저 스스로 끝난다(2026-10-02 결정).
const DEFAULT_LIMIT_MS = 110 * 60_000;
// 멈춤 판정을 몇 번 연속 봐야 하는지(2026-10-02 결정).
const STALE_HITS = 2;

export const STAMP_RE = /^\d{6}_\d{6}$/;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Windows 경로도 슬래시로 통일한다 — Git Bash 에 붙여 넣어도 백슬래시가 해석되지 않는다.
export function slash(p) { return String(p).replace(/\\/g, '/'); }

// 셸에 그대로 붙일 수 있게 작은따옴표로 감싼다.
export function shq(s) {
    const v = String(s);
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

export function logDirOf(root) { return path.join(root, 'docs', 'codex_rescue', '.log'); }

// 첫 턴은 `<스탬프>_launch.*`, 되묻기 턴 N 은 `<스탬프>_t<N>_launch.*`.
// 2차 정리기와 확장은 `^\d{6}_\d{6}_` 로 시작하는 파일을 스탬프 묶음으로 본다 — 이 이름이 그 형식을 따른다.
export function launchPrefix(stamp, turn) {
    return turn && Number(turn) >= 2 ? `${stamp}_t${Number(turn)}` : stamp;
}

export function launchFiles(logDir, prefix) {
    return {
        out: path.join(logDir, `${prefix}_launch.out`),
        err: path.join(logDir, `${prefix}_launch.err`),
        exit: path.join(logDir, `${prefix}_launch.exit`),
        reported: path.join(logDir, `${prefix}_reported`)
    };
}

// Claude 가 그대로 붙일 감시 명령 한 줄.
export function watchCommand(root, stamp, turn, extra = []) {
    const parts = ['node', shq(slash(path.join(SCRIPTS_DIR, 'wait-run.mjs'))),
        '--root', shq(slash(root)), '--stamp', stamp];
    if (turn && Number(turn) >= 2) parts.push('--turn', String(Number(turn)));
    return parts.concat(extra).join(' ');
}

export function mtimeOf(p) {
    try { return fs.statSync(p).mtimeMs; } catch { return undefined; }
}

function readText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 결과를 넘겼다는 표식. 임시 파일 + rename 이라 반쯤 쓰인 표식이 남지 않는다.
export function writeReported(file, record) {
    const tmp = `${file}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n');
        fs.renameSync(tmp, file);
        return true;
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* 임시 파일만 정리 */ }
        return false;
    }
}

export function readExitCode(file) {
    const raw = readText(file);
    if (raw === null) return undefined;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(n) ? n : 1;
}

function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`${a} needs a value`);
        o[a.slice(2)] = v;
        i++;
    }
    for (const k of Object.keys(o)) {
        if (!['root', 'stamp', 'turn', 'poll-ms', 'limit-ms'].includes(k)) throw new Error(`unknown option: --${k}`);
    }
    if (!o.root) throw new Error('--root is required');
    if (!o.stamp || !STAMP_RE.test(o.stamp)) throw new Error(`--stamp must be ymd_His: ${o.stamp ?? '(none)'}`);
    let turn;
    if (o.turn !== undefined) {
        if (!/^\d+$/.test(o.turn) || Number(o.turn) < 1) throw new Error(`--turn must be a whole number: ${o.turn}`);
        turn = Number(o.turn);
    }
    const ms = (k, def) => {
        if (o[k] === undefined) return def;
        if (!/^\d+$/.test(o[k]) || Number(o[k]) < 1) throw new Error(`--${k} must be a positive whole number of ms: ${o[k]}`);
        return Number(o[k]);
    };
    const extra = [];
    if (o['poll-ms'] !== undefined) extra.push('--poll-ms', o['poll-ms']);
    if (o['limit-ms'] !== undefined) extra.push('--limit-ms', o['limit-ms']);
    return { root: path.resolve(o.root), stamp: o.stamp, turn,
             pollMs: ms('poll-ms', DEFAULT_POLL_MS), limitMs: ms('limit-ms', DEFAULT_LIMIT_MS), extra };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => process.stdout.write(s + '\n');

function statusState(statusFile) {
    const raw = readText(statusFile);
    if (raw === null) return '(no status file)';
    try { return String(JSON.parse(raw).state ?? '(no state)'); } catch { return '(unreadable status)'; }
}

// 살아 있다는 신호 — heartbeat, 없으면 잠금, 없으면 status (2026-10-02 결정).
// 셋 다 없으면(send.sh 가 아직 잠금을 만들기 전이거나 아주 이른 단계) launch 출력 파일로 본다.
function liveness(logDir, stamp, files) {
    const order = [
        ['heartbeat', path.join(logDir, `${stamp}_heartbeat`)],
        ['lock', path.join(logDir, `.${stamp}.lock`)],
        ['status', path.join(logDir, `${stamp}_status.json`)]
    ];
    for (const [name, p] of order) {
        const m = mtimeOf(p);
        if (m !== undefined) return { name, file: p, mtime: m };
    }
    const m = Math.max(mtimeOf(files.out) ?? 0, mtimeOf(files.err) ?? 0);
    return { name: 'launch output', file: files.err, mtime: m || undefined };
}

function printFinished(o, files, code) {
    const prefix = launchPrefix(o.stamp, o.turn);
    say(`codex_rescue watch: finished — ${prefix} · send.sh exit ${code}`);
    say('');
    const err = readText(files.err);
    say(`── send.sh stderr (${slash(files.err)}) ──`);
    process.stdout.write(err === null ? '(missing)\n' : (err.endsWith('\n') || err === '' ? err : err + '\n'));
    say('');
    const out = readText(files.out);
    say(`── send.sh report — stdout (${slash(files.out)}) ──`);
    process.stdout.write(out === null ? '(missing)\n' : (out.endsWith('\n') || out === '' ? out : out + '\n'));
    say('');
    say(`── end of result (send.sh exit ${code}). Handle it by the codex_rescue skill's references/results.md. ──`);
}

async function watch(o) {
    const logDir = logDirOf(o.root);
    const prefix = launchPrefix(o.stamp, o.turn);
    const files = launchFiles(logDir, prefix);
    const cmd = watchCommand(o.root, o.stamp, o.turn, o.extra);

    if (mtimeOf(files.out) === undefined && mtimeOf(files.err) === undefined && mtimeOf(files.exit) === undefined) {
        process.stderr.write(`codex_rescue watch: no launch files for ${prefix} in ${slash(logDir)}\n` +
            '  Wrong --root / --stamp / --turn, or this run was not started by launch.mjs (nothing to watch).\n');
        return 2;
    }

    const started = Date.now();
    let staleHits = 0;
    for (;;) {
        const code = readExitCode(files.exit);
        if (code !== undefined) {
            printFinished(o, files, code);
            if (!writeReported(files.reported, { result: 'done', exit: code })) {
                say(`⚠️ could not write ${slash(files.reported)} — the session-start hook may announce this run again.`);
            }
            return code;
        }

        const live = liveness(logDir, o.stamp, files);
        const now = Date.now();
        const age = live.mtime === undefined ? Infinity : now - live.mtime;
        staleHits = age > STALE_AFTER_MS ? staleHits + 1 : 0;
        if (staleHits >= STALE_HITS) {
            const statusFile = path.join(logDir, `${o.stamp}_status.json`);
            say(`codex_rescue watch: STALE — ${prefix}`);
            say(`  No exit mark yet, and the ${live.name} file has not changed for ${Math.round(age / 1000)}s` +
                ` (checked ${STALE_HITS} times in a row; limit ${STALE_AFTER_MS / 1000}s).`);
            say(`  status   : ${statusState(statusFile)}   (${slash(statusFile)})`);
            say(`  liveness : ${slash(live.file)}`);
            say(`  events   : ${slash(path.join(logDir, `${o.stamp}_events.jsonl`))}`);
            say(`  stderr   : ${slash(files.err)}`);
            say(`  stdout   : ${slash(files.out)}`);
            say('  The run may have died (hard kill, crash, machine sleep) — or it is alive but stalled.');
            say('  Tell the user, with the paths above. Do not rerun it on your own — rerunning is the user\'s call.');
            say('  If the user wants to keep waiting, run the same watch command again:');
            say(`    ${cmd}`);
            if (!writeReported(files.reported, { result: 'stale', liveness: live.name, age_ms: Number.isFinite(age) ? Math.round(age) : null })) {
                say(`⚠️ could not write ${slash(files.reported)}`);
            }
            return 1;
        }

        if (now - started >= o.limitMs) {
            say(`⏳ still running — re-arm: ${cmd}`);
            say(`   (${prefix} · status: ${statusState(path.join(logDir, `${o.stamp}_status.json`))} · ` +
                `${live.name} touched ${Number.isFinite(age) ? Math.round(age / 1000) + 's' : '?'} ago)`);
            say('   Codex keeps running. Run that exact command again with Bash(run_in_background: true, timeout: 7200000).');
            say('   Do not start the run again — only the watcher.');
            return 0;
        }
        await sleep(Math.min(o.pollMs, Math.max(1, o.limitMs - (now - started))));
    }
}

async function main() {
    let o;
    try { o = parseArgs(process.argv.slice(2)); }
    catch (e) {
        process.stderr.write(`codex_rescue watch: ${e.message}\n` +
            'usage: node wait-run.mjs --root <project root> --stamp <ymd_His> [--turn <N>] [--poll-ms <ms>] [--limit-ms <ms>]\n');
        return 2;
    }
    return watch(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    process.exitCode = await main();
}
