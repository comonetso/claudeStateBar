#!/usr/bin/env node
// cleanup-logs.mjs — 지난 실행 기록을 정리한다 (2026-09-19)
//
// send.sh 가 발동할 때 한 번 부른다. 예전에는 VS Code 확장의 자동 정리(기본 꺼짐)뿐이라
// 확장 없이 쓰거나 그걸 안 켠 곳에서는 기록이 끝없이 쌓였다 — IVR 서버 한 프로젝트에 211MB.
//
// 지우는 것 (보존 기간 = --keep-days. 0 이면 아무것도 안 한다):
//   ① 성공(state=done)으로 끝난 실행의 통신 기록 `<스탬프>_appserver.jsonl` — 기간과 상관없이.
//      끼어들기 경로가 app-server 와 주고받은 원문 전부라 한 실행에 1~7MB 다. 읽는 곳은
//      send.sh 의 한도 판정 하나뿐이고 그건 실행이 끝날 때 이미 끝났다. 감사용 events.jsonl 은 남는다.
//   ② `.log/` 에서 한 스탬프에 딸린 파일 전부 — 그중 가장 최근 수정이 보존 기간보다 오래됐을 때.
//      이벤트 파일 없이 조각만 남은 스탬프도 여기서 같이 간다. 옛 확장의 🗑 가 통신 기록을 빠뜨려
//      생긴 조각이 IVR 에서 63MB 였고, 확장은 이벤트 파일로 실행을 찾아서 그걸 영영 못 봤다.
//   ③ `.scratch/` 의 최상위 항목 — 안쪽까지 가장 최근 수정이 보존 기간보다 오래됐을 때.
//      Codex 가 이름을 제멋대로 지어서 어느 실행 것인지 묶을 수 없으니 날짜로만 판단한다.
//
// 건드리지 않는 것:
//   - 요청서·응답 .md 문서(커밋되는 기록), 휴지통 `.trash/`·`.chat_trash/`
//   - 점으로 시작하는 `.log/` 파일 — 실행 중 잠금 `.<스탬프>.lock`, 복구 표식 `.*.inflight`, `.gitignore`
//   - 잠금이 있는 스탬프 전부, 그리고 --skip-stamp 로 받은 이번 실행의 스탬프
//     (같은 스탬프 재실행은 지난 실패의 stderr 를 먼저 읽어야 한다)
//   - 심볼릭 링크 너머 — 재거나 지울 때 따라가지 않는다. 따라가면 작업 폴더 밖까지 닿는다
//
// 사용법:
//   node cleanup-logs.mjs --dir <…/docs/codex_rescue> --keep-days <N> [--skip-stamp <스탬프>] [--dry-run]
//
// 부가 기능이다. 실패해도 종료 코드 0 으로 끝내고 사유만 stderr 에 남긴다 — 이것 때문에
// 실행을 막으면 안 된다. (인자 오류만 2)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP_RE = /^(\d{6}_\d{6})_/;

function parseArgs(argv) {
    const o = { dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') { o.dryRun = true; continue; }
        if (!a.startsWith('--')) throw new Error(`알 수 없는 인자: ${a}`);
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`${a} 에 값이 없다`);
        o[a.slice(2)] = v;
        i++;
    }
    if (!o.dir) throw new Error('--dir 가 필요하다');
    if (!/^\d+$/.test(o['keep-days'] ?? '')) {
        throw new Error(`보존 기간은 0 이상의 정수(일)여야 한다: ${o['keep-days'] ?? '(없음)'} — CR_KEEP_DAYS 를 확인해라`);
    }
    // 잘못된 인자로 엉뚱한 폴더를 지우지 않게 이름으로 한 번 더 막는다.
    const dir = path.resolve(o.dir);
    if (path.basename(dir) !== 'codex_rescue' || path.basename(path.dirname(dir)) !== 'docs') {
        throw new Error(`docs/codex_rescue 폴더가 아니다: ${dir}`);
    }
    return { dir, keepDays: Number(o['keep-days']), skipStamp: o['skip-stamp'] || '', dryRun: o.dryRun };
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
    try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')).state; } catch { return undefined; }
}

export function cleanup({ dir, keepDays, skipStamp, dryRun }, nowMs = Date.now()) {
    const res = { logFiles: 0, scratchItems: 0, bytes: 0, removed: [], failed: [] };
    if (keepDays <= 0) return res;
    const cutoff = nowMs - keepDays * DAY_MS;

    const drop = (p, bytes, kind) => {
        if (!dryRun) {
            try {
                if (kind === 'scratch') fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
            } catch (e) {
                res.failed.push(`${p} (${e.code || e.message})`);   // 다른 프로그램이 열어 둔 파일 등
                return;
            }
        }
        if (kind === 'scratch') res.scratchItems++; else res.logFiles++;
        res.bytes += bytes;
        res.removed.push(p);
    };

    // ── .log/ ──
    const logDir = path.join(dir, '.log');
    let logNames = [];
    try { logNames = fs.readdirSync(logDir); } catch { /* 아직 한 번도 안 돌았다 */ }
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
        if (stamp === skipStamp || present.has(`.${stamp}.lock`)) continue;
        const newest = Math.max(...files.map(f => f.st.mtimeMs));
        if (newest < cutoff) {
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
    try { scratchNames = fs.readdirSync(scratch); } catch { /* 없으면 할 일 없음 */ }
    for (const n of scratchNames) {
        if (n === '.gitignore') continue;
        const p = path.join(scratch, n);
        const m = measure(p);
        if (m.mtime < cutoff) drop(p, m.bytes, 'scratch');
    }
    return res;
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
    let res;
    try {
        res = cleanup(opts);
    } catch (e) {
        process.stderr.write(`⚠️ 지난 기록 정리 실패 — 실행은 계속한다: ${e.message}\n`);
        return;
    }
    if (opts.dryRun) {
        for (const p of res.removed) process.stdout.write(`(미리보기) ${p}\n`);
    }
    if (res.logFiles || res.scratchItems) {
        const parts = [];
        if (res.logFiles) parts.push(`실행 기록 ${res.logFiles}개`);
        if (res.scratchItems) parts.push(`작업 폴더 ${res.scratchItems}개`);
        const head = opts.dryRun ? '🧹 (미리보기) 지울 지난 기록' : '🧹 지난 기록 정리';
        process.stdout.write(`${head} (보존 ${opts.keepDays}일 · CR_KEEP_DAYS): ${parts.join(' · ')} · ${fmtBytes(res.bytes)}\n`);
    }
    if (res.failed.length) {
        process.stderr.write(`⚠️ 지우지 못한 항목 ${res.failed.length}개 — 다음 발동 때 다시 시도한다:\n`);
        for (const f of res.failed.slice(0, 5)) process.stderr.write(`   ${f}\n`);
    }
}

// 테스트에서 cleanup() 만 가져다 쓸 수 있게, 직접 실행됐을 때만 main 을 돈다.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
