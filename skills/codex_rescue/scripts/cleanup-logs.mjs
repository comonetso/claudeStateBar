#!/usr/bin/env node
// cleanup-logs.mjs — 지난 실행 기록을 정리한다 (2026-09-19 · 2026-10-02 용량 기록·즉시 정리·Codex 대화 기록)
//
// send.sh 가 발동할 때 한 번 부른다. 예전에는 VS Code 확장의 자동 정리(기본 꺼짐)뿐이라
// 확장 없이 쓰거나 그걸 안 켠 곳에서는 기록이 끝없이 쌓였다 — IVR 서버 한 프로젝트에 211MB.
// 자동 정리는 전부 이 플러그인이 한다(확장 없이 쓰는 사용자가 있다). 확장은 용량 표시와 즉시 정리 버튼만 더한다.
//
// ── 자동 정리 (--now 없이 부를 때) ──
// 보존 기간은 홈의 `.claude/codex_rescue/settings.json` 을 읽는다(scratchDays=1, logDays=7).
// 명시한 --keep-days 는 두 기간을 덮어쓴다. 0 은 해당 대상만 끈다.
// 설정이 깨졌거나 값이 잘못됐으면 이번 정리는 전부 건너뛴다(용량 기록 ⑥은 그래도 쓴다). 설정 파일은 쓰지 않는다.
// 지우는 것:
//   ① 성공(state=done)으로 끝난 실행의 통신 기록 `<스탬프>_appserver.jsonl` — 기간과 상관없이.
//      끼어들기 경로가 app-server 와 주고받은 원문 전부라 한 실행에 1~7MB 다. 읽는 곳은
//      send.sh 의 한도 판정 하나뿐이고 그건 실행이 끝날 때 이미 끝났다. 감사용 events.jsonl 은 남는다.
//   ② `.log/` 에서 한 스탬프에 딸린 파일 전부 — 그중 가장 최근 수정이 보존 기간보다 오래됐을 때.
//      이벤트 파일 없이 조각만 남은 스탬프도 여기서 같이 간다. 옛 확장의 🗑 가 통신 기록을 빠뜨려
//      생긴 조각이 IVR 에서 63MB 였고, 확장은 이벤트 파일로 실행을 찾아서 그걸 영영 못 봤다.
//   ③ `.scratch/<스탬프>/` — 잠금과 이번 실행을 빼고, 안쪽까지 최신 수정이 scratchDays 를 넘었을 때.
//      그 밖의 공용 최상위 항목도 같은 기간으로 정리한다(.gitignore 제외).
//      다른 실행이 살아 있어도 정리한다. 공용 자리에 둔 오래된 자료는 보호되지 않는다(사용자 결정).
//   ④ 홈의 `.claude/codex_rescue/runs/<대화 id>/*.json` — 수정이 logDays 를 넘었을 때. 빈 대화 폴더도 지운다.
//   ⑤ codex_rescue 가 만든 Codex 대화 기록(`$CODEX_HOME/sessions`, 기본 `~/.codex/sessions`) — logDays 를 넘은 것.
//      여기서 직접 지우지 않고, 끝에서 prune-codex-sessions.mjs 를 **따로 떼어 띄운다**(Codex 실행은 기다리지 않음).
//      설정이 정상이고 logDays > 0 이고 dry-run 이 아닐 때만 띄운다. 이 기기 전체(모든 프로젝트)가 대상이고,
//      공식 명령 `codex delete --force` 로 한 건씩 지운다. 규칙은 그 파일과 lib/codex-sessions.mjs 머리말.
//      띄우기 실패는 경고 한 줄이고 실행은 계속한다.
//   ⑥ 용량 기록 `.log/_usage.json` 을 다시 계산해 쓴다(임시 파일 → 이름 바꾸기) — 정리를 건너뛴 회차에도.
//      확장은 이 파일 하나만 읽는다. dry-run 은 쓰지 않는다. 형식은 아래 writeUsage() 위 주석.
//
// ── 즉시 정리 (--now) ── 확장의 [정리] 버튼이 터미널에서 부른다. 사람이 보고 있다.
//   --now <scratch,log,trash,codex 중 하나 이상(쉼표)> — 모르는 이름이면 인자 오류(종료 2).
//   --yes 가 없으면 미리보기만 한다(아무것도 안 지우고 종료 0). --yes 가 있으면 지운다.
//   기간과 상관없이 고른 항목을 전부 지운다. 설정 파일은 읽지 않는다 — 깨져 있어도 한다.
//   진행 중인 실행(`.log/.<스탬프>.lock` 이 있는 스탬프)의 것은 남긴다:
//     log     — 그 스탬프 파일들, 점으로 시작하는 파일(잠금·.gitignore·.inflight), `_usage.json`(마지막에 새로 쓴다)
//     scratch — `.scratch/<그 스탬프>/` 와 `.gitignore`
//     codex   — 그 스탬프 `<스탬프>_events.jsonl` 의 thread.started 에서 찾은 대화. 하나라도 못 찾으면
//               그 사실을 출력하고 codex 항목 전체를 건너뛴다(시각 기준 같은 임의 판정을 하지 않는다).
//   trash   — `.trash/`·`.chat_trash/` 안을 비운다. 폴더와 그 안 `.gitignore` 는 남긴다.
//   codex   — 이 프로젝트(cwd 가 root 와 같은) rescue 본 기록을 `codex delete --force` 로 한 건씩, 진행 표시와
//             함께 동기로 지운다. 실패는 건너뛰고 끝에 모아 보인다. 기기 잠금을 다른 정리가 잡고 있으면
//             codex 항목만 건너뛴다. 지우는 동안은 이 명령이 잠금을 잡는다(뒤의 자동 삭제와 겹치지 않게).
//   끝에 무엇을 얼마나 지웠는지 요약하고 `_usage.json` 을 새로 쓴다. 미리보기는 쓰지 않는다.
//
// 건드리지 않는 것 (자동 정리):
//   - 요청서·응답 .md 문서(커밋되는 기록), 휴지통 `.trash/`·`.chat_trash/`
//   - 점으로 시작하는 `.log/` 파일 — 실행 중 잠금 `.<스탬프>.lock`, 복구 표식 `.*.inflight`, `.gitignore`
//   - `.log/_usage.json` — 스탬프 규칙(`\d{6}_\d{6}_`)에 안 걸린다
//   - 잠금이 있는 스탬프 전부, 그리고 --skip-stamp 로 받은 이번 실행의 스탬프
//     (같은 스탬프 재실행은 지난 실패의 stderr 를 먼저 읽어야 한다)
//     --skip-lock 은 옛 핑퐁 호출과의 인자 호환을 위해 받지만 더는 필요하지 않다.
//   - 심볼릭 링크 너머 — 재거나 지울 때 따라가지 않는다. 따라가면 작업 폴더 밖까지 닿는다
//   - 다른 프로그램이 만든 Codex 대화 기록, 하위 에이전트 기록 단독(부모를 지우면 Codex 가 같이 지운다)
//
// 사용법:
//   node cleanup-logs.mjs --dir <…/docs/codex_rescue> [--keep-days <N>] [--settings <파일>] [--ledger-dir <폴더>] [--skip-stamp <스탬프>] [--skip-lock <잠금 파일 이름>] [--keep-thread <대화 UUID>] [--dry-run]
//   node cleanup-logs.mjs --dir <…/docs/codex_rescue> --now <항목,항목> [--yes] [--lang en|ko]
//     --keep-thread: 되묻기가 이어받는 Codex 대화 — 이번 회차 자동 삭제(prune)에서 뺀다
//     --lang: 즉시 정리 출력 언어(기본 en). 확장의 [정리] 버튼은 자기 언어 설정을 넘긴다
//     즉시 정리는 잠금이 있는 실행과, Codex 는 끝났지만 결과를 Claude 가 아직 안 받은 실행(_launch.exit 있고
//     _reported 가 done 아님)을 남긴다(사용자 결정 10-02)
//
// 부가 기능이다. 실패해도 종료 코드 0 으로 끝내고 사유만 stderr 에 남긴다 — 이것 때문에
// 실행을 막으면 안 된다. (인자 오류만 2)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
    sessionsDir, machinePaths, scanSessions, indexRescue, projectMains, threadIdsFromEvents,
    acquireMachineLock, lockHolder, codexDelete, commandOnPath, fmtSize, UUID_RE, DELETE_TIMEOUT_MS
} from './lib/codex-sessions.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP_RE = /^(\d{6}_\d{6})_/;
const RUN_STAMP_RE = /^\d{6}_\d{6}$/;
const LOCK_RE = /^\.(\d{6}_\d{6})\.lock$/;
const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const CONFIG_DIR = path.join(os.homedir(), '.claude', 'codex_rescue');
const SCRIPT = fileURLToPath(import.meta.url);
const USAGE_NAME = '_usage.json';
const NOW_ITEMS = ['scratch', 'log', 'trash', 'codex'];
const FAILED_SHOWN = 5;

function parseArgs(argv) {
    const o = { dryRun: false, yes: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') { o.dryRun = true; continue; }
        if (a === '--yes') { o.yes = true; continue; }
        if (!a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`${a} needs a value`);
        o[a.slice(2)] = v;
        i++;
    }
    if (!o.dir) throw new Error('--dir is required');
    let now;
    if (o.now !== undefined) {
        const names = String(o.now).split(',').map(s => s.trim()).filter(Boolean);
        if (!names.length) throw new Error(`--now needs one or more of: ${NOW_ITEMS.join(', ')}`);
        const unknown = names.filter(n => !NOW_ITEMS.includes(n));
        if (unknown.length) throw new Error(`unknown --now item: ${unknown.join(', ')} (use ${NOW_ITEMS.join(', ')})`);
        now = NOW_ITEMS.filter(n => names.includes(n));
    } else if (o.yes) {
        throw new Error('--yes works only with --now');
    }
    if (o['keep-days'] !== undefined &&
        (!/^\d+$/.test(o['keep-days']) || !Number.isInteger(Number(o['keep-days'])))) {
        throw new Error(`the retention period must be a whole number of days, 0 or more: ${o['keep-days'] ?? '(none)'} — check CR_KEEP_DAYS`);
    }
    // 되묻기가 이어받는 Codex 대화 — 이번 회차 자동 삭제에서 뺀다(사용자 결정 10-02). 비어 있으면 없음.
    const keepThread = o['keep-thread'] || '';
    if (keepThread && !UUID_RE.test(keepThread)) throw new Error(`--keep-thread needs a Codex conversation id (UUID): ${keepThread}`);
    // 즉시 정리 출력 언어 — 확장은 자기 언어 설정을 넘기고, 사람이 직접 치면 영어다(사용자 결정 10-02).
    const lang = o.lang === undefined ? 'en' : o.lang;
    if (!Object.hasOwn(NOW_TEXT, lang)) throw new Error(`--lang must be one of: ${Object.keys(NOW_TEXT).join(', ')}`);
    // 잘못된 인자로 엉뚱한 폴더를 지우지 않게 이름으로 한 번 더 막는다.
    const dir = path.resolve(o.dir);
    if (path.basename(dir) !== 'codex_rescue' || path.basename(path.dirname(dir)) !== 'docs') {
        throw new Error(`not a docs/codex_rescue folder: ${dir}`);
    }
    return { dir, keepDays: o['keep-days'] === undefined ? undefined : Number(o['keep-days']),
             settings: o.settings || path.join(CONFIG_DIR, 'settings.json'),
             ledgerDir: path.resolve(o['ledger-dir'] || path.join(CONFIG_DIR, 'runs')),
             skipStamp: o['skip-stamp'] || '', dryRun: o.dryRun, now, yes: o.yes, keepThread, lang };
}

// 명시 override 가 있어도 깨진 설정에서는 삭제하지 않는다. 키마다 기본값과 출처를 구분한다.
export function readRetention({ settings = path.join(CONFIG_DIR, 'settings.json'), keepDays } = {}) {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(settings, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('settings must be a JSON object');
    }
    const result = {};
    for (const [key, fallback] of [['scratchDays', 1], ['logDays', 7]]) {
        const supplied = Object.hasOwn(config, key);
        if (supplied && (!Number.isInteger(config[key]) || config[key] < 0)) {
            throw new Error(`${key} must be a whole number of days, 0 or more`);
        }
        result[key] = keepDays === undefined ? (supplied ? config[key] : fallback) : keepDays;
        result[`${key}Source`] = keepDays !== undefined ? 'CR_KEEP_DAYS' : (supplied ? 'settings file' : 'defaults');
    }
    return result;
}

function lstat(p) {
    try { return fs.lstatSync(p); } catch { return null; }
}

// 항목 하나의 가장 최근 수정 시각과 전체 크기. 디렉토리는 안쪽까지 본다.
// 안을 못 읽으면 "방금 수정됨"으로 친다 — 모르는 것을 오래됐다고 판정해 지우지 않는다.
function measure(p) {
    const st = lstat(p);
    if (!st) return { mtime: Infinity, bytes: 0 };
    if (!st.isDirectory()) return { mtime: st.mtimeMs, bytes: st.size };
    let names;
    try { names = fs.readdirSync(p); } catch { return { mtime: Infinity, bytes: 0 }; }
    let mtime = st.mtimeMs, bytes = 0;
    for (const n of names) {
        const m = measure(path.join(p, n));
        if (m.mtime > mtime) mtime = m.mtime;
        bytes += m.bytes;
    }
    return { mtime, bytes };
}

function stateOf(statusFile) {
    if (!lstat(statusFile)?.isFile()) return undefined;
    try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')).state; } catch { return undefined; }
}

export function cleanup({ dir, scratchDays = 1, logDays = 7, ledgerDir = path.join(CONFIG_DIR, 'runs'),
                          skipStamp, dryRun }, nowMs = Date.now()) {
    const res = { logFiles: 0, scratchItems: 0, ledgerFiles: 0, ledgerDirs: 0, bytes: 0, removed: [], failed: [] };
    const logCutoff = nowMs - logDays * DAY_MS;
    const scratchCutoff = nowMs - scratchDays * DAY_MS;

    const drop = (p, bytes, kind) => {
        if (!dryRun) {
            try {
                if (kind === 'scratch') fs.rmSync(p, { recursive: true, force: true });
                else if (kind === 'ledgerDir') fs.rmdirSync(p);
                else fs.unlinkSync(p);
            } catch (e) {
                res.failed.push(`${p} (${e.code || e.message})`);   // 다른 프로그램이 열어 둔 파일 등
                return;
            }
        }
        if (kind === 'scratch') res.scratchItems++;
        else if (kind === 'ledger') res.ledgerFiles++;
        else if (kind === 'ledgerDir') res.ledgerDirs++;
        else res.logFiles++;
        res.bytes += bytes;
        res.removed.push(p);
    };

    // ── .log/ ──
    const logDir = path.join(dir, '.log');
    let logNames = [];
    try { if (lstat(logDir)?.isDirectory()) logNames = fs.readdirSync(logDir); } catch { /* 아직 한 번도 안 돌았다 */ }
    const present = new Set(logNames);
    const groups = new Map();
    for (const n of logNames) {
        const m = STAMP_RE.exec(n);   // 점으로 시작하는 이름은 여기서 걸러진다
        if (!m) continue;
        const st = lstat(path.join(logDir, n));
        if (!st || !st.isFile()) continue;
        if (!groups.has(m[1])) groups.set(m[1], []);
        groups.get(m[1]).push({ name: n, st });
    }
    for (const [stamp, files] of groups) {
        if (logDays <= 0) break;
        if (stamp === skipStamp || present.has(`.${stamp}.lock`)) continue;
        const newest = Math.max(...files.map(f => f.st.mtimeMs));
        if (newest < logCutoff) {
            for (const f of files) drop(path.join(logDir, f.name), f.st.size, 'log');
            continue;
        }
        const as = files.find(f => f.name === `${stamp}_appserver.jsonl`);
        if (as && stateOf(path.join(logDir, `${stamp}_status.json`)) === 'done') {
            drop(path.join(logDir, as.name), as.st.size, 'log');
        }
    }

    // ── .scratch/ ──
    const scratch = path.join(dir, '.scratch');
    let scratchNames = [];
    try { if (scratchDays > 0 && lstat(scratch)?.isDirectory()) scratchNames = fs.readdirSync(scratch); } catch { /* 없으면 할 일 없음 */ }
    for (const n of scratchNames) {
        if (n === '.gitignore') continue;
        const p = path.join(scratch, n);
        if (RUN_STAMP_RE.test(n) && lstat(p)?.isDirectory() &&
            (n === skipStamp || present.has(`.${n}.lock`))) continue;
        const m = measure(p);
        if (m.mtime < scratchCutoff) drop(p, m.bytes, 'scratch');
    }

    // ── 실행 장부 ── 폴더와 파일 모두 lstat 으로 링크를 따라가지 않는다.
    let sessions = [];
    try { if (logDays > 0 && lstat(ledgerDir)?.isDirectory()) sessions = fs.readdirSync(ledgerDir); } catch { /* 없으면 할 일 없음 */ }
    for (const session of sessions) {
        if (!SESSION_RE.test(session)) continue;
        const folder = path.join(ledgerDir, session);
        if (!lstat(folder)?.isDirectory()) continue;
        let names;
        try { names = fs.readdirSync(folder); } catch { continue; }
        const removed = new Set();
        for (const n of names) {
            const p = path.join(folder, n);
            const st = lstat(p);
            if (!n.endsWith('.json') || !st?.isFile() || st.mtimeMs >= logCutoff) continue;
            drop(p, st.size, 'ledger');
            if (res.removed.includes(p)) removed.add(n);
        }
        if (dryRun) {
            if (names.every(n => removed.has(n))) drop(folder, 0, 'ledgerDir');
        } else {
            try { if (fs.readdirSync(folder).length === 0) drop(folder, 0, 'ledgerDir'); } catch { /* 다른 실행이 바꿨으면 다음 회차 */ }
        }
    }
    return res;
}

// ── 용량 기록 ──────────────────────────────────────────────────────────────
// `<dir>/.log/_usage.json` (확장과의 약속 — 모양을 바꾸지 마라):
//   { schema: 1, computed_at, root, items: { scratch|log|trash|codex: { bytes, count } },
//     clean: { script: <이 파일>, dir: <docs/codex_rescue> } }
//   경로는 모두 `/`. root 는 dir 의 두 단계 위.
//   scratch = `.scratch/` 안 전부(.gitignore 제외), count 는 최상위 항목 수
//   log     = `.log/` 안 파일 전부(_usage.json 자신 제외), count 는 파일 수
//   trash   = `.trash/`·`.chat_trash/` 안 전부, count 는 최상위 항목 수
//   codex   = 이 프로젝트의 rescue 본 기록(cwd == root) + 그 하위 기록 크기, count 는 본 기록 수
// 크기는 링크를 따라가지 않는다(measure() 와 같은 원칙). 장부(runs/)는 기기 전체라 넣지 않는다.

const slash = p => String(p).replace(/\\/g, '/');
const rootOf = dir => path.dirname(path.dirname(dir));

function listNames(p) {
    try { return lstat(p)?.isDirectory() ? fs.readdirSync(p) : []; } catch { return []; }
}

// 파일 수와 크기. 디렉토리는 안쪽까지, 링크는 따라가지 않고 링크 자신을 한 개로 센다.
function countFiles(p) {
    const st = lstat(p);
    if (!st) return { count: 0, bytes: 0 };
    if (!st.isDirectory()) return { count: 1, bytes: st.size };
    let count = 0, bytes = 0;
    for (const n of listNames(p)) {
        const c = countFiles(path.join(p, n));
        count += c.count; bytes += c.bytes;
    }
    return { count, bytes };
}

export function computeUsage(dir, { env = process.env, nowMs = Date.now() } = {}) {
    const items = {
        scratch: { bytes: 0, count: 0 }, log: { bytes: 0, count: 0 },
        trash: { bytes: 0, count: 0 }, codex: { bytes: 0, count: 0 },
    };
    const scratch = path.join(dir, '.scratch');
    for (const n of listNames(scratch)) {
        if (n === '.gitignore') continue;
        items.scratch.count++;
        items.scratch.bytes += measure(path.join(scratch, n)).bytes;
    }
    // `.gitignore` 는 세지 않는다 — 비운 뒤에도 "휴지통 2개·4B" 로 보이면 안 지워진 것처럼 읽힌다.
    const logDir = path.join(dir, '.log');
    for (const n of listNames(logDir)) {
        if (n === USAGE_NAME || n === '.gitignore') continue;
        const c = countFiles(path.join(logDir, n));
        items.log.count += c.count; items.log.bytes += c.bytes;
    }
    for (const t of ['.trash', '.chat_trash']) {
        const td = path.join(dir, t);
        for (const n of listNames(td)) {
            if (n === '.gitignore') continue;
            items.trash.count++;
            items.trash.bytes += measure(path.join(td, n)).bytes;
        }
    }
    const root = rootOf(dir);
    for (const m of projectMains(indexRescue(scanSessions(sessionsDir(env))), root)) {
        items.codex.count++;
        items.codex.bytes += m.totalBytes;
    }
    return {
        schema: 1,
        computed_at: new Date(nowMs).toISOString(),
        root: slash(root),
        items,
        clean: { script: slash(SCRIPT), dir: slash(dir) },
    };
}

// `.log/` 가 진짜 폴더일 때만 쓴다(링크면 작업 폴더 밖에 쓰게 된다). 실패해도 경고 한 줄.
export function writeUsage(dir, opts) {
    const logDir = path.join(dir, '.log');
    if (!lstat(logDir)?.isDirectory()) return false;
    const target = path.join(logDir, USAGE_NAME);
    const tmp = `${target}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(computeUsage(dir, opts), null, 2) + '\n');
        fs.renameSync(tmp, target);
        return true;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 안 만들어졌다 */ }
        process.stderr.write(`⚠️ could not write the usage file ${slash(target)}: ${e.code || e.message}\n`);
        return false;
    }
}

// ⑤ Codex 대화 기록 정리기를 떼어 띄운다. cwd 를 홈으로 둔다 — Windows 에서 프로세스의 현재 폴더는
// 그 폴더를 지우거나 옮기지 못하게 붙잡는다(첫 정리는 수십 분 걸린다).
function spawnPrune(days, keepThread) {
    const prune = path.join(path.dirname(SCRIPT), 'prune-codex-sessions.mjs');
    const warn = (why) => process.stderr.write(`⚠️ could not start the Codex conversation cleanup — the run continues: ${why}\n`);
    try {
        if (!lstat(prune)?.isFile()) { warn(`missing ${slash(prune)}`); return; }
        const args = [prune, '--days', String(days)];
        if (keepThread) args.push('--skip-thread', keepThread);
        const child = cp.spawn(process.execPath, args, {
            cwd: os.homedir(), detached: true, windowsHide: true, stdio: 'ignore'
        });
        child.on('error', e => warn(e.code || e.message));
        child.unref();
    } catch (e) {
        warn(e.code || e.message);
    }
}

// ── 즉시 정리 ──────────────────────────────────────────────────────────────

const LAUNCH_EXIT_RE = /^(\d{6}_\d{6})(?:_t(\d+))?_launch\.exit$/;

// 즉시 정리가 남길 실행 — 잠금이 있는 것(Codex 가 도는 중)과, Codex 는 끝났지만 감시기가 결과를 아직
// Claude 에게 넘기지 않은 것(가장 최근 턴의 `_launch.exit` 는 있는데 `_reported` 가 done 이 아니다).
// 뒤의 것을 지우면 Claude 는 그 결과를 영영 못 받는다(사용자 결정 10-02). 판정은 reattach.mjs 와 같다.
function busyStamps(logDir) {
    const out = new Set();
    const lastTurn = new Map();
    for (const n of listNames(logDir)) {
        const m = LOCK_RE.exec(n);
        if (m) { out.add(m[1]); continue; }
        const e = LAUNCH_EXIT_RE.exec(n);
        if (e) {
            const t = e[2] === undefined ? 1 : Number(e[2]);
            if (!lastTurn.has(e[1]) || t > lastTurn.get(e[1])) lastTurn.set(e[1], t);
        }
    }
    for (const [stamp, turn] of lastTurn) {
        // 되묻기 턴이 더 있는데 그 턴의 exit 가 아직 없으면 위 잠금이 잡는다 — 여기서는 끝난 턴만 본다.
        const reported = path.join(logDir, `${stamp}${turn >= 2 ? `_t${turn}` : ''}_reported`);
        let result;
        try { result = JSON.parse(fs.readFileSync(reported, 'utf8'))?.result; } catch { result = undefined; }
        if (result !== 'done') out.add(stamp);
    }
    return out;
}

// 항목별 지울 목록을 만든다. 아무것도 지우지 않는다.
export function planNow(dir, items, { env = process.env } = {}) {
    const logDir = path.join(dir, '.log');
    const locked = busyStamps(logDir);
    const plan = {};
    const entry = (p) => ({ path: p, bytes: measure(p).bytes });
    if (items.includes('scratch')) {
        const scratch = path.join(dir, '.scratch');
        const del = [], kept = [];
        for (const n of listNames(scratch)) {
            if (n === '.gitignore') continue;
            const p = path.join(scratch, n);
            if (RUN_STAMP_RE.test(n) && locked.has(n) && lstat(p)?.isDirectory()) { kept.push(n); continue; }
            del.push(entry(p));
        }
        plan.scratch = { del, kept };
    }
    if (items.includes('log')) {
        const del = [], kept = [];
        for (const n of listNames(logDir)) {
            const m = STAMP_RE.exec(n);
            if (n.startsWith('.') || n === USAGE_NAME || (m && locked.has(m[1]))) { kept.push(n); continue; }
            del.push(entry(path.join(logDir, n)));
        }
        plan.log = { del, kept };
    }
    if (items.includes('trash')) {
        const del = [];
        for (const t of ['.trash', '.chat_trash']) {
            const td = path.join(dir, t);
            for (const n of listNames(td)) if (n !== '.gitignore') del.push(entry(path.join(td, n)));
        }
        plan.trash = { del, kept: [] };
    }
    if (items.includes('codex')) {
        const unresolved = [];
        const protectedIds = new Set();
        for (const s of [...locked].sort()) {
            const ids = threadIdsFromEvents(path.join(logDir, `${s}_events.jsonl`));
            if (!ids.length) unresolved.push(s);
            for (const id of ids) protectedIds.add(id);
        }
        if (unresolved.length) {
            // skip 문구는 영어 기본값이고, runNow 가 skipStamps 로 고른 언어의 문구를 다시 만든다.
            plan.codex = { del: [], kept: [], skipStamps: unresolved,
                           skip: `in-progress run(s) ${unresolved.join(', ')}: their Codex conversation id is not in the events file yet` };
        } else {
            const index = indexRescue(scanSessions(sessionsDir(env)));
            // 보호 id 가 하위 기록이면 그 위의 본 기록을 보호한다(본 기록을 지우면 하위도 같이 간다).
            for (const id of [...protectedIds]) if (index.subOf.has(id)) protectedIds.add(index.subOf.get(id));
            const del = [], kept = [];
            for (const m of projectMains(index, rootOf(dir)).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
                if (protectedIds.has(m.id)) { kept.push(m.id); continue; }
                del.push({ id: m.id, bytes: m.totalBytes });
            }
            plan.codex = { del, kept };
        }
    }
    return plan;
}

// 즉시 정리는 사람이 터미널에서 직접 보는 화면이라 언어를 고른다(--lang, 기본 영어 · 확장은 자기 언어 설정).
const NOW_TEXT = {
    en: {
        label: { scratch: 'workbench (.scratch)', log: 'run logs (.log)', trash: 'trash (.trash · .chat_trash)', codex: 'Codex conversations' },
        unit: { scratch: 'items', log: 'files', trash: 'items', codex: 'conversations' },
        count: (n, u) => `${n} ${u}`,
        previewHead: '🧹 clean-now preview — nothing has been deleted (add --yes to delete)',
        willSkip: (l, why) => `${l}: will be skipped — ${why}`,
        bgRunning: ' (a background cleanup is running now — this item would be skipped)',
        kept: (n, isLog) => ` · kept ${n} (in-progress runs or results not yet received${isLog ? ', dot files, the usage file' : ''})`,
        warn: '⚠️ Deleting cannot be undone.',
        warnCodex: ' Runs whose Codex conversation is deleted can no longer be followed up (FOLLOWUP).',
        inProgress: (stamps) => `in-progress run(s) ${stamps}: their Codex conversation id is not in the events file yet`,
        skipped: (why) => `⏭ Codex conversations skipped — ${why}`,
        lockFail: (p, e) => `could not take the machine lock ${p} (${e})`,
        bgNow: (pid) => `a background cleanup is running now${pid ? ` (pid ${pid})` : ''}; try again later`,
        ok: 'ok', failed: 'failed', stopped: 'stopped — codex command not found',
        timedOut: (s) => `no answer within ${s}s — skipped, try again later`,
        notFound: (n) => `codex: codex command not found — ${n} conversation(s) not deleted`,
        itemSkipped: (l) => `${l} skipped`,
        cleaned: (parts) => `🧹 cleaned now: ${parts}`,
        couldNot: (n) => `⚠️ ${n} could not be deleted:`,
    },
    ko: {
        label: { scratch: '작업폴더(.scratch)', log: '실행 기록(.log)', trash: '휴지통(.trash · .chat_trash)', codex: 'Codex 대화 기록' },
        unit: { scratch: '개', log: '개 파일', trash: '개', codex: '건' },
        count: (n, u) => `${n}${u}`,
        previewHead: '🧹 지금 정리 미리보기 — 아직 아무것도 지우지 않았습니다(지우려면 --yes 를 붙이세요)',
        willSkip: (l, why) => `${l}: 건너뜀 — ${why}`,
        bgRunning: ' (지금 뒤에서 자동 정리가 돌고 있어 이 항목은 건너뜁니다)',
        kept: (n, isLog) => ` · ${n}개 남김(진행 중이거나 결과를 아직 안 받은 실행${isLog ? ', 점 파일, 용량 파일' : ''})`,
        warn: '⚠️ 지우면 되돌릴 수 없습니다.',
        warnCodex: ' Codex 대화 기록을 지운 실행은 되묻기(FOLLOWUP)를 할 수 없습니다.',
        inProgress: (stamps) => `진행 중인 실행 ${stamps} 의 Codex 대화 번호가 아직 이벤트 기록에 없습니다`,
        skipped: (why) => `⏭ Codex 대화 기록 건너뜀 — ${why}`,
        lockFail: (p, e) => `기기 잠금 ${p} 을 잡지 못했습니다(${e})`,
        bgNow: (pid) => `지금 뒤에서 자동 정리가 돌고 있습니다${pid ? `(pid ${pid})` : ''}. 나중에 다시 하세요`,
        ok: '완료', failed: '실패', stopped: '중단 — codex 명령이 없습니다',
        timedOut: (s) => `${s}초 안에 응답이 없어 건너뜀 — 나중에 다시 하세요`,
        notFound: (n) => `codex: codex 명령이 없어 ${n}건을 지우지 못했습니다`,
        itemSkipped: (l) => `${l} 건너뜀`,
        cleaned: (parts) => `🧹 지금 정리 끝: ${parts}`,
        couldNot: (n) => `⚠️ ${n}개를 지우지 못했습니다:`,
    },
};
const sum = arr => arr.reduce((a, x) => a + x.bytes, 0);

function runNow(opts) {
    const out = s => process.stdout.write(s + '\n');
    const T = NOW_TEXT[opts.lang] || NOW_TEXT.en;
    const L = T.label;
    const plan = planNow(opts.dir, opts.now);
    if (plan.codex?.skipStamps) plan.codex.skip = T.inProgress(plan.codex.skipStamps.join(', '));
    const machine = machinePaths();
    if (!opts.yes || opts.dryRun) {   // --dry-run 이 섞이면 지우지 않는 쪽으로
        out(T.previewHead);
        out(`   ${slash(opts.dir)}`);
        for (const k of opts.now) {
            const p = plan[k];
            let line = `   ${L[k]}: ${T.count(p.del.length, T.unit[k])} · ${fmtSize(sum(p.del))}`;
            if (p.skip) line = `   ${T.willSkip(L[k], p.skip)}`;
            else if (k === 'codex' && lockHolder(machine.lock)?.alive) line += T.bgRunning;
            if (!p.skip && p.kept.length && k !== 'trash') line += T.kept(p.kept.length, k === 'log');
            out(line);
        }
        out(`${T.warn}${opts.now.includes('codex') ? T.warnCodex : ''}`);
        return;
    }

    const done = {};
    const failed = [];
    const rm = (p, k) => {
        try {
            const st = lstat(p);
            if (st?.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
            else if (st) fs.unlinkSync(p);
            return true;
        } catch (e) {
            failed.push(`${k}: ${slash(p)} (${e.code || e.message})`);
            return false;
        }
    };
    for (const k of ['scratch', 'log', 'trash']) {
        if (!plan[k]) continue;
        done[k] = { count: 0, bytes: 0 };
        for (const e of plan[k].del) if (rm(e.path, k)) { done[k].count++; done[k].bytes += e.bytes; }
    }
    if (plan.codex) {
        done.codex = { count: 0, bytes: 0, of: plan.codex.del.length };
        if (plan.codex.skip) {
            out(T.skipped(plan.codex.skip));
            done.codex.skipped = true;
        } else if (plan.codex.del.length) {
            let lock;
            try { lock = acquireMachineLock(machine.lock); } catch (e) { lock = { ok: false, error: e.code || e.message }; }
            if (lock.error) {
                out(T.skipped(T.lockFail(slash(machine.lock), lock.error)));
                done.codex.skipped = true;
            } else if (!lock.ok) {
                out(T.skipped(T.bgNow(lock.pid)));
                done.codex.skipped = true;
            } else {
                try {
                    const total = plan.codex.del.length;
                    let i = 0;
                    for (const t of plan.codex.del) {
                        i++;
                        const head = `[${i}/${total}] ${t.id} ${fmtSize(t.bytes)}`;
                        const r = commandOnPath('codex') ? codexDelete(t.id) : { ok: false, missing: true };
                        if (r.ok) { out(`${head} ${T.ok}`); done.codex.count++; done.codex.bytes += t.bytes; continue; }
                        if (r.missing) {
                            out(`${head} ${T.stopped}`);
                            failed.push(T.notFound(total - i + 1));
                            break;
                        }
                        out(`${head} ${T.failed}`);
                        const why = r.timedOut ? T.timedOut(Math.round(DELETE_TIMEOUT_MS / 1000)) : (r.detail || T.failed);
                        failed.push(`codex: ${t.id} (${why})`);
                    }
                } finally {
                    lock.release();
                }
            }
        }
    }
    const parts = [];
    for (const k of opts.now) {
        const d = done[k];
        if (!d) continue;
        if (d.skipped) { parts.push(T.itemSkipped(L[k])); continue; }
        parts.push(k === 'codex' ? `${L[k]} ${d.count}/${d.of} · ${fmtSize(d.bytes)}`
                                 : `${L[k]} ${d.count} · ${fmtSize(d.bytes)}`);
    }
    out(T.cleaned(parts.join(' · ')));
    if (failed.length) {
        out(T.couldNot(failed.length));
        for (const f of failed) out(`   ${f}`);
    }
    writeUsage(opts.dir);
}

function fmtBytes(b) {
    if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
    return `${Math.max(1, Math.round(b / 1024))}KB`;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(`cleanup-logs: ${e.message}\n`);
        process.exit(2);
    }
    if (opts.now) {
        try { runNow(opts); } catch (e) {
            process.stderr.write(`⚠️ clean-now failed: ${String(e && e.message || e).replace(/[\r\n]+/g, ' ')}\n`);
        }
        return;
    }
    let res;
    try {
        Object.assign(opts, readRetention(opts));
    } catch (e) {
        process.stderr.write(`⚠️ invalid cleanup settings — nothing deleted: ${String(e.message).replace(/[\r\n]+/g, ' ')}\n`);
        if (!opts.dryRun) writeUsage(opts.dir);   // ⑥ 설정이 깨진 회차에도 용량은 쓴다
        return;
    }
    try {
        res = cleanup(opts);
    } catch (e) {
        process.stderr.write(`⚠️ cleaning up old records failed — the run continues: ${e.message}\n`);
        if (!opts.dryRun) writeUsage(opts.dir);
        return;
    }
    if (opts.dryRun) {
        for (const p of res.removed) process.stdout.write(`(preview) ${p}\n`);
    }
    if (res.logFiles || res.scratchItems || res.ledgerFiles || res.ledgerDirs) {
        const parts = [];
        if (res.logFiles) parts.push(`${res.logFiles} run logs`);
        if (res.scratchItems) parts.push(`${res.scratchItems} workbench items`);
        if (res.ledgerFiles) parts.push(`${res.ledgerFiles} run ledger files`);
        if (res.ledgerDirs) parts.push(`${res.ledgerDirs} empty conversation folders`);
        const head = opts.dryRun ? '🧹 (preview) old records to delete' : '🧹 old records cleaned up';
        process.stdout.write(`${head} (scratch ${opts.scratchDays} days · ${opts.scratchDaysSource}; logs/ledger ${opts.logDays} days · ${opts.logDaysSource}): ${parts.join(' · ')} · ${fmtBytes(res.bytes)}\n`);
    }
    if (res.failed.length) {
        process.stderr.write(`⚠️ ${res.failed.length} items could not be deleted — retried on the next run:\n`);
        for (const f of res.failed.slice(0, FAILED_SHOWN)) process.stderr.write(`   ${f}\n`);
    }
    if (opts.dryRun) return;
    writeUsage(opts.dir);                                  // ⑥
    if (opts.logDays > 0) spawnPrune(opts.logDays, opts.keepThread);   // ⑤ 맨 끝에 — 떼어 띄우고 기다리지 않는다
}

// 테스트에서 cleanup() 만 가져다 쓸 수 있게, 직접 실행됐을 때만 main 을 돈다.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
