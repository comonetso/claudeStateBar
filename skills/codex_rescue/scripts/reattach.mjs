#!/usr/bin/env node
// reattach.mjs — 대화가 시작·재개·압축될 때 이 대화가 띄운 Codex 실행 중 결과를 아직 안 받은 것을 알린다 (2026-10-02)
//
// 플러그인 훅(hooks/hooks.json 의 SessionStart)이 부른다. 창을 다시 불러오거나 대화가 압축되면 Claude 가
// 걸어 둔 감시 명령(wait-run.mjs)은 사라지지만, 따로 띄운 send.sh 는 계속 돈다. 그대로 두면 결과가
// 아무에게도 전달되지 않는다. 그래서 이 대화의 실행 장부(send.sh 의 cr_write_ledger 가 쓰는
// `<홈>/.claude/codex_rescue/runs/<대화 id>/*.json`)를 보고, 감시를 다시 걸라고 Claude 에게 알린다.
//
// 알리는 대상 — 장부의 실행마다 그 루트의 `.log/` 에서 가장 최근 launch 접두(되묻기 턴이 가장 큰 것)를 보고:
//   · `_launch.exit` 가 없고 `_reported` 도 없다  → 아직 돌고 있거나 멈췄다(감시기가 가려낸다)
//   · `_launch.exit` 는 있고 `_reported` 가 없다  → 끝났지만 결과를 Claude 가 아직 안 받았다
//   · `_launch.exit` 는 있고 `_reported` 가 stale → 감시기가 멈춤으로 알린 뒤 실제로는 끝났다. 결과를 아무도
//                                                   안 받았으니 알린다(사용자 결정 10-02). 다시 감시를 걸면
//                                                   감시기가 결과를 넘기고 `_reported` 를 done 으로 덮어쓴다
//   알리지 않는 것 — `_reported` 가 done(결과를 이미 넘김), 또는 `_launch.exit` 가 없는데 `_reported` 가 있다
//   (감시기가 멈춤으로 이미 한 번 알렸다 — 대화를 열 때마다 되풀이하지 않는다, 사용자 결정 10-02).
//   launch 파일이 하나도 없는 실행(런처 이전 방식)은 건너뛴다. 알릴 것이 없으면 아무것도 출력하지 않는다.
//
// 🔴 실행을 다시 돌리지 않는다 — 감시 명령만 알려 준다(사용자 결정).
// 🔴 대화 시작을 붙잡으면 안 된다 — 장부 폴더가 없으면 바로 끝내고, 무엇이 실패해도 조용히 0 으로 끝낸다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const LAUNCH_RE = /^(\d{6}_\d{6})(?:_t(\d+))?_launch\.(?:out|err|exit)$/;

function readStdin() {
    if (process.stdin.isTTY) return '';
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// 그 스탬프의 가장 최근 launch 접두 — 첫 턴은 1, 되묻기 턴 N 은 N.
function latestTurn(names, stamp) {
    let best;
    for (const n of names) {
        const m = LAUNCH_RE.exec(n);
        if (!m || m[1] !== stamp) continue;
        const t = m[2] === undefined ? 1 : Number(m[2]);
        if (best === undefined || t > best) best = t;
    }
    return best;
}

// 감시기가 `_reported` 에 남긴 결과 — 'done'(결과 넘김) · 'stale'(멈춤으로 알림) · 'other'(읽었지만 모르는 내용)
// · undefined(파일 없음). 감시기는 임시 파일 뒤 이름 바꾸기로 쓰므로 반쯤 쓴 파일은 보지 않는다.
function reportedResult(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    try {
        const r = JSON.parse(raw)?.result;
        return r === 'done' || r === 'stale' ? r : 'other';
    } catch { return 'other'; }
}

function collect(sessionId) {
    const folder = path.join(os.homedir(), '.claude', 'codex_rescue', 'runs', sessionId);
    let entries;
    try { entries = fs.readdirSync(folder); } catch { return []; }
    const pending = [];
    const seen = new Set();
    const listing = new Map();   // 루트마다 .log/ 를 한 번만 읽는다
    for (const name of entries.sort()) {
        if (!name.endsWith('.json')) continue;   // 쓰다 만 임시 파일(.json.tmp.*)은 거른다
        let rec;
        try { rec = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')); } catch { continue; }
        if (!rec || typeof rec !== 'object' || typeof rec.root !== 'string' || typeof rec.stamp !== 'string') continue;
        if (!STAMP_RE.test(rec.stamp) || !rec.root) continue;
        const key = `${rec.root}\n${rec.stamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const logDir = logDirOf(rec.root);
        if (!listing.has(logDir)) {
            let names = [];
            try { names = fs.readdirSync(logDir); } catch { /* 폴더가 없으면 알릴 것도 없다 */ }
            listing.set(logDir, names);
        }
        const turn = latestTurn(listing.get(logDir), rec.stamp);
        if (turn === undefined) continue;   // 런처 이전 방식으로 띄운 실행
        const files = launchFiles(logDir, launchPrefix(rec.stamp, turn));
        const exited = mtimeOf(files.exit) !== undefined;
        const reported = reportedResult(files.reported);
        let state;
        if (exited) {
            if (reported === undefined) state = 'finished — result not received yet';
            else if (reported === 'stale') state = 'finished after the watcher reported it stalled — result not received yet';
            else continue;   // 결과를 이미 넘겼다
        } else {
            if (reported !== undefined) continue;   // 멈춤으로 이미 알렸다 — 끝나면 위 갈래에서 다시 잡힌다
            state = 'no exit mark — still running, or stalled';
        }
        pending.push({
            stamp: rec.stamp, turn, root: rec.root, mode: rec.mode, state,
            cmd: watchCommand(rec.root, rec.stamp, turn)
        });
    }
    return pending;
}

function main() {
    let input;
    try { input = JSON.parse(readStdin() || '{}'); } catch { return; }
    const sessionId = input && typeof input.session_id === 'string' ? input.session_id : '';
    if (!SESSION_RE.test(sessionId)) return;
    const pending = collect(sessionId);
    if (pending.length === 0) return;

    const lines = [
        `codex_rescue: this conversation has ${pending.length} Codex run(s) whose result you have not received yet.`,
        'Their watchers were lost (window reload, resume or compaction); the runs themselves are detached and keep going.',
        'Re-arm the watcher for each one now: run its command below with Bash(run_in_background: true, timeout: 7200000).',
        'When a watcher ends with the result, handle it by the codex_rescue skill\'s references/results.md. If it ends with',
        '"still running", run the same command again. Never launch these runs again. Tell the user in one line that you re-attached.',
        ''
    ];
    for (const p of pending) {
        lines.push(`- ${p.stamp}${p.turn >= 2 ? ` (turn ${p.turn})` : ''}${p.mode ? ` · ${p.mode}` : ''} · ${p.state} · root: ${p.root}`);
        lines.push(`  ${p.cmd}`);
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') }
    }) + '\n');
}

// 이름 규칙은 wait-run.mjs 가 정본이다. 그 파일을 못 읽어도 대화 시작을 막지 않게 동적으로 불러온다.
let STAMP_RE, logDirOf, launchPrefix, launchFiles, watchCommand, mtimeOf;
try {
    ({ STAMP_RE, logDirOf, launchPrefix, launchFiles, watchCommand, mtimeOf } =
        await import(new URL('./wait-run.mjs', import.meta.url).href));
    main();
} catch { /* 대화 시작을 막지 않는다 */ }
process.exitCode = 0;
