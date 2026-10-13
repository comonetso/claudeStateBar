#!/usr/bin/env node
// prune-codex-sessions.mjs — codex_rescue 가 만든 Codex 대화 기록 중 오래된 것을 공식 명령으로 지운다 (2026-10-02)
//
// cleanup-logs.mjs 의 자동 정리 끝에서 따로 떼어 띄운다(Codex 실행은 이걸 기다리지 않는다).
// 설정이 정상이고 logDays > 0 이고 dry-run 이 아닐 때만 띄운다 — 그 판단은 부르는 쪽이 한다.
// 한 건에 약 6초(대부분 Codex 기동)라 첫 정리는 오래 걸린다(서버 한 대에서 173개 ≈ 17분).
//
// 하는 일 (사용자 결정, 2026-10-02):
//   1. 기기 잠금 `<홈>/.claude/codex_rescue/.codex-prune.lock` 을 잡는다. 살아 있는 다른 정리가 잡고 있으면 조용히 끝.
//      주인이 죽었으면 넘겨받는다. 끝나면(오류 포함) 푼다.
//   2. `$CODEX_HOME/sessions`(없으면 `~/.codex/sessions`) 를 훑어 rescue 본 기록 중 파일 수정 시각이
//      --days 일보다 오래된 것을 오래된 순으로 `codex delete --force <id>` 한다. 하위 기록은 따로 지우지 않는다
//      (부모를 지우면 Codex 가 같이 지운다). 식별·삭제 규칙은 lib/codex-sessions.mjs 머리말.
//      --skip-thread 로 받은 대화(되묻기가 이어받는 대화)는 빼고, 지우기 직전 수정 시각을 다시 봐서 그사이
//      이어받아 기간 안으로 들어온 대화도 건너뛴다(사용자 결정 10-02).
//   3. codex 명령이 없으면 첫 건에서 멈춘다. 다른 실패는 건너뛰고 계속한다. 한 건이 2분을 넘기면 그 건만 포기한다
//      (lib/codex-sessions.mjs DELETE_TIMEOUT_MS, 사용자 결정 10-02).
//   4. 결과를 `<홈>/.claude/codex_rescue/codex-prune.log` 에 덮어쓴다(시작·끝 시각, 대상 수, 지운 수·바이트, 실패 앞 몇 개).
//
// 건드리지 않는 것: 다른 프로그램(originator)이 만든 기록, 하위 기록 단독, 기간 안의 기록, Codex 내부 DB 압축.
//
// 사용법:
//   node prune-codex-sessions.mjs --days <N> [--skip-thread <UUID> ...]      N 은 1 이상의 정수
//
// 부가 기능이다. 무엇이 실패해도 조용히 끝난다 — 실행을 막지 않는다. (인자 오류만 종료 2)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    sessionsDir, machinePaths, scanSessions, indexRescue, acquireMachineLock,
    codexDelete, commandOnPath, fmtSize, UUID_RE
} from './lib/codex-sessions.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILED_SHOWN = 5;   // 실패 목록은 앞 몇 개만 — cleanup-logs.mjs 의 실패 출력과 같은 수

function parseArgs(argv) {
    let days;
    const skip = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--days' && argv[i + 1] !== undefined) { days = argv[++i]; continue; }
        if (argv[i] === '--skip-thread' && argv[i + 1] !== undefined) {
            const id = argv[++i];
            if (!UUID_RE.test(id)) throw new Error(`--skip-thread needs a Codex conversation id (UUID): ${id}`);
            skip.push(id);
            continue;
        }
        throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (days === undefined || !/^\d+$/.test(days) || Number(days) < 1) throw new Error('--days must be a whole number of 1 or more');
    return { days: Number(days), skip };
}

/** 대상 고르기 — 오래된 rescue 본 기록만, 오래된 순. skip 은 되묻기로 이어받는 대화(사용자 결정 10-02). */
export function pruneTargets(records, days, nowMs = Date.now(), skip = []) {
    const cutoff = nowMs - days * DAY_MS;
    const keep = new Set(skip.map(s => s.toLowerCase()));
    return indexRescue(records).mains
        .filter(m => m.mtimeMs < cutoff && !keep.has(m.id.toLowerCase()))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// 지우기 직전에 다시 본다 — 목록을 만든 뒤 되묻기가 그 대화를 이어받았으면 기록 파일이 새로 쓰여 기간 안으로 들어온다.
function stillOld(t, cutoff) {
    try { return fs.statSync(t.file).mtimeMs < cutoff; } catch { return false; }
}

export function prune({ days, home, env = process.env, nowMs = Date.now(), skip = [], timeoutMs }) {
    const paths = machinePaths(home);
    const lock = acquireMachineLock(paths.lock);
    if (!lock.ok) return { skipped: true, holder: lock.pid };
    const res = {
        started_at: new Date().toISOString(), finished_at: null, days, sessions: sessionsDir(env),
        targets: 0, deleted: 0, bytes: 0, failed: [], stopped: null
    };
    try {
        const targets = pruneTargets(scanSessions(res.sessions), days, nowMs, skip);
        const cutoff = nowMs - days * DAY_MS;
        res.targets = targets.length;
        for (const t of targets) {
            if (!stillOld(t, cutoff)) { res.targets--; continue; }
            if (!commandOnPath('codex', env)) { res.stopped = 'codex command not found'; break; }
            const r = codexDelete(t.id, timeoutMs ? { timeoutMs } : undefined);
            if (r.ok) { res.deleted++; res.bytes += t.totalBytes; continue; }
            if (r.missing) { res.stopped = 'codex command not found'; break; }
            res.failed.push(`${t.id} ${r.detail || 'failed'}`);
        }
    } catch (e) {
        res.stopped = `error: ${String(e && e.message || e).replace(/[\r\n]+/g, ' ')}`;
    } finally {
        res.finished_at = new Date().toISOString();
        writeLog(paths.log, res);
        lock.release();
    }
    return res;
}

function writeLog(file, r) {
    const lines = [
        `codex_rescue — Codex conversation cleanup (rescue-made only, official delete command)`,
        `started  : ${r.started_at}`,
        `finished : ${r.finished_at}`,
        `older than: ${r.days} days · sessions: ${r.sessions.replace(/\\/g, '/')}`,
        `targets  : ${r.targets} · deleted: ${r.deleted} (${fmtSize(r.bytes)}) · failed: ${r.failed.length}`,
    ];
    if (r.stopped) lines.push(`stopped  : ${r.stopped}`);
    if (r.failed.length) {
        lines.push(`failed (first ${Math.min(FAILED_SHOWN, r.failed.length)} of ${r.failed.length}):`);
        for (const f of r.failed.slice(0, FAILED_SHOWN)) lines.push(`  ${f}`);
    }
    try { fs.writeFileSync(file, lines.join('\n') + '\n'); } catch { /* 기록 실패도 조용히 */ }
}

function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
        try { process.stderr.write(`prune-codex-sessions: ${e.message}\n`); } catch { /* 출력이 없을 수 있다 */ }
        process.exitCode = 2;
        return;
    }
    try { prune(opts); } catch { /* 조용히 끝난다 */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main();
}
