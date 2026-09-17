#!/usr/bin/env node
// set-thread-name.mjs — 끝난 Codex 대화에 이름을 붙인다 (2026-09-17)
//
// 옛 경로(`codex exec`)는 대화 id 를 실행이 끝난 뒤에야 알아서 send.sh 가 여기서 붙인다.
// 끼어들기 경로는 live-consult.mjs 가 대화를 만들 때 같은 연결로 붙이므로 이걸 쓰지 않는다.
//
// 사용법:
//   node set-thread-name.mjs --thread <id> --request-file <요청서>
//   node set-thread-name.mjs --thread <id> --mode <review|chat> [--subject <s>] [--slug <s>]
//
// 이름 붙이기는 부가 기능이다. 실패해도 종료 코드 0 으로 끝내고 사유만 stderr 에 남긴다 —
// 이미 끝난 실행의 결과를 이것 때문에 실패로 만들면 안 된다. (인자 오류만 2)

import cp from 'node:child_process';
import readline from 'node:readline';
import { threadNameFor, threadNameFromRequest } from './lib/thread-name.mjs';

// app-server 왕복 상한은 중계기와 같은 값을 쓴다 — 여기서 새 숫자를 만들지 않는다.
const { PENDING_DECISION } = await import(new URL('./live-consult.mjs', import.meta.url).href);

function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`알 수 없는 인자: ${a}`);
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`${a} 에 값이 없다`);
        o[a.slice(2)] = v;
        i++;
    }
    if (!o.thread) throw new Error('--thread 가 필요하다');
    return o;
}

// codex-status.mjs 의 stdio 조회와 같은 방식이다(WebSocket 불필요 — Node 20 서버 대응).
function rpc(requestTimeoutMs) {
    const IS_WIN = process.platform === 'win32';
    const args = ['app-server'];
    if (IS_WIN) args.push('-c', 'windows.sandbox=unelevated');
    const child = cp.spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'ignore'], shell: IS_WIN, windowsHide: true, detached: !IS_WIN
    });
    let nextId = 0;
    let dead = null;
    const pending = new Map();
    const failAll = (why) => {
        dead = dead || why;
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(dead)); }
        pending.clear();
    };
    child.on('error', (e) => failAll(`app-server 를 띄우지 못했다: ${e.message}`));
    child.on('exit', (code, sig) => failAll(`app-server 가 먼저 끝났다 (exit ${code ?? sig})`));
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        let j;
        try { j = JSON.parse(line); } catch { return; }
        if (j.id === undefined || !pending.has(j.id)) return;
        const p = pending.get(j.id);
        pending.delete(j.id);
        clearTimeout(p.timer);
        if (j.error) p.reject(new Error(`${j.error.message} (code ${j.error.code})`));
        else p.resolve(j.result);
    });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    return {
        request(method, params) {
            if (dead) return Promise.reject(new Error(dead));
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`${method} 응답이 ${requestTimeoutMs}ms 안에 오지 않았다`));
                }, requestTimeoutMs);
                pending.set(id, { resolve, reject, timer });
                send({ id, method, params });
            });
        },
        notify(method, params) { if (!dead) send({ method, params }); },
        close() {
            failAll('닫힘');
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                if (IS_WIN) cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
            } catch { /* 이미 죽었으면 무시 */ }
        }
    };
}

async function main() {
    let o;
    try { o = parseArgs(process.argv.slice(2)); } catch (e) {
        process.stderr.write(`set-thread-name: ${e.message}\n`);
        return 2;
    }
    const name = o['request-file']
        ? threadNameFromRequest(o['request-file'])
        : threadNameFor({ mode: o.mode, subject: o.subject, slug: o.slug });
    if (!name) {
        process.stderr.write('set-thread-name: 이름을 만들 주제가 없어 건너뛴다\n');
        return 0;
    }
    const conn = rpc(PENDING_DECISION.requestTimeoutMs);
    try {
        await conn.request('initialize', { clientInfo: { name: 'claude-state-bar-thread-name', version: '0.1.0' } });
        conn.notify('initialized', {});
        await conn.request('thread/name/set', { threadId: o.thread, name });
        process.stdout.write(`대화 이름: ${name}\n`);
    } catch (e) {
        process.stderr.write(`set-thread-name: 이름을 못 붙였다 — ${e && e.message}\n`);
    } finally {
        conn.close();
    }
    return 0;
}

main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`set-thread-name: 예상 못 한 오류 — ${e && e.message}\n`);
    process.exit(0);
});
