#!/usr/bin/env node
// codex-status.mjs — codex_rescue 실행 전 확인용 조회기 (2026-09-13)
//
// 스킬을 부르기 전에 Claude 가 이걸 돌려 사용자에게 물을 재료를 모은다.
//   ① 계정 한도   — account/rateLimits/read  (5시간 창 · 주간 창)
//   ② 현재 설정   — config/read               (프로필·레이어가 반영된 실제 model / model_reasoning_effort)
//   ③ 모델 목록   — model/list                (모델마다 지원하는 추론 수준)
//   ④ 과거 소모량 — ~/.codex/sessions 의 rollout 에서 요청서 기반 실행 1건당 5시간 창 증가폭
//
// ①~③ 은 모델을 부르지 않는다. 토큰을 쓰지 않는다.
// 조회가 일부 실패해도 나머지는 낸다 — 이 스크립트가 스킬 발동을 막으면 안 된다.
//
// 사용법:
//   node codex-status.mjs [--cwd <프로젝트 루트>] [--days <n>] [--json] [--no-history]
//
// 종료 코드: 0 전부 조회 / 3 일부 실패(출력은 낸다) / 2 인자 오류

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CLIENT_NAME = 'claude-state-bar-codex-status';
const CLIENT_VERSION = '0.1.0';

// 과거 소모량을 볼 기간. 09-13 조사에서 쓴 범위(최근 3주)를 그대로 따른다.
const DEFAULT_DAYS = 21;

// 요청서 기반 실행을 낸 실행기. REVIEW·CHAT 은 요청서가 없어 아래 판정에서 자연히 빠진다.
const REQUEST_ORIGINATORS = new Set(['claude-state-bar-live-consult', 'codex_exec']);

function parseArgs(argv) {
    const o = { cwd: process.cwd(), days: DEFAULT_DAYS, json: false, history: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') o.json = true;
        else if (a === '--no-history') o.history = false;
        else if (a === '--cwd') o.cwd = argv[++i];
        else if (a === '--days') o.days = Number(argv[++i]);
        else if (a === '--help' || a === '-h') o.help = true;
        else throw new Error(`알 수 없는 인자: ${a}`);
    }
    if (!o.cwd) throw new Error('--cwd 에 경로가 없다');
    if (!Number.isFinite(o.days) || o.days <= 0) throw new Error('--days 는 양수여야 한다');
    return o;
}

// ── ①~③ app-server 조회 ────────────────────────────────────────────────
// 🔴 2026-09-16: WebSocket 을 쓰지 않는다. 조회는 연결 하나면 되므로 app-server 기본 전송(stdio)으로
//    직접 NDJSON 을 주고받는다. lib/appserver.mjs 는 전역 WebSocket 이 필요해 Node 20 서버에서
//    20초 재시도 끝에 실패했다(서버 A·서버 B). 끼어들기 경로는 다중 연결이 필요해 여전히 ws 다.
function startStdioServer(cwd, requestTimeoutMs) {
    const IS_WIN = process.platform === 'win32';
    const args = ['app-server'];
    // lib/appserver.mjs 와 같은 Windows 샌드박스 안전망
    if (IS_WIN) args.push('-c', 'windows.sandbox=unelevated');
    // Windows 의 codex 는 npm .cmd shim 이라 shell:true 가 필요하다. 인자에 공백이 없어 인용은 불필요하다.
    const child = cp.spawn('codex', args, {
        cwd, stdio: ['pipe', 'pipe', 'ignore'], shell: IS_WIN, windowsHide: true, detached: !IS_WIN
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
        if (j.id === undefined || !pending.has(j.id)) return;   // 알림은 버린다
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
                send(params === undefined ? { id, method } : { id, method, params });
            });
        },
        notify(method, params) { if (!dead) send({ method, params }); },
        close() {
            failAll('닫힘');
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                // shell:true 라 child.pid 는 cmd.exe 다 — 트리째 죽인다 (lib/appserver.mjs 와 같은 방식)
                if (IS_WIN) cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
            } catch { /* 이미 죽었으면 무시 */ }
        }
    };
}

async function queryAppServer(cwd) {
    const res = { rateLimits: null, config: null, models: null, errors: {} };
    let pending;
    try {
        // RPC 왕복 상한은 중계기와 같은 값을 쓴다 — 여기서 새 숫자를 만들지 않는다.
        ({ PENDING_DECISION: pending } = await import(new URL('./live-consult.mjs', import.meta.url).href));
    } catch (e) {
        res.errors.lib = `모듈을 싣지 못했다: ${e && e.message}`;
        return res;
    }

    let conn = null;
    try {
        conn = startStdioServer(cwd, pending.requestTimeoutMs);
        await conn.request('initialize', { clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION } });
        conn.notify('initialized', {});

        const [rl, cfg, ml] = await Promise.allSettled([
            conn.request('account/rateLimits/read', undefined),
            conn.request('config/read', { cwd, includeLayers: false }),
            listModels(conn)
        ]);
        if (rl.status === 'fulfilled') res.rateLimits = rl.value; else res.errors.rateLimits = msg(rl.reason);
        if (cfg.status === 'fulfilled') res.config = cfg.value && cfg.value.config; else res.errors.config = msg(cfg.reason);
        if (ml.status === 'fulfilled') res.models = ml.value; else res.errors.models = msg(ml.reason);
    } catch (e) {
        res.errors.appServer = msg(e);
    } finally {
        try { if (conn) conn.close(); } catch { /* 이미 죽었을 수 있다 */ }
    }
    return res;
}

async function listModels(conn) {
    const all = [];
    let cursor = null;
    // 페이지가 끝없이 이어지는 응답에 묶이지 않게 쪽수를 제한한다.
    for (let page = 0; page < 20; page++) {
        const r = await conn.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const m of (r && r.data) || []) all.push(m);
        cursor = r && r.nextCursor;
        if (!cursor) break;
    }
    return all;
}

function msg(e) { return String((e && e.message) || e); }

// ── ④ 과거 소모량 ──────────────────────────────────────────────────────
function codexHome() {
    return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function listRollouts(root, sinceMs) {
    const out = [];
    const walk = (dir) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
                try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* 무시 */ }
            }
        }
    };
    walk(root);
    return out;
}

// 한 rollout 을 줄 단위로 읽어 요약한다. 파일이 수십 MB 일 수 있어 통째로 읽지 않는다.
async function summarizeRollout(file) {
    const s = {
        file, originator: null, isRequest: false, startedAt: null,
        model: null, effort: null, first: null, last: null, userSeen: 0
    };
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const p = j.payload || {};
        if (j.type === 'session_meta') {
            s.originator = p.originator || null;
            s.startedAt = p.timestamp || j.timestamp || null;
            if (!REQUEST_ORIGINATORS.has(s.originator)) { rl.close(); break; }
        } else if (j.type === 'turn_context') {
            if (p.model) s.model = p.model;
            if (p.effort || p.reasoning_effort) s.effort = p.effort || p.reasoning_effort;
        } else if (j.type === 'response_item' && p.type === 'message' && p.role === 'user' && s.userSeen < 5) {
            // 요청서 기반 실행은 프롬프트에 `요청서: <경로>_request_<슬러그>.md` 가 들어간다.
            s.userSeen++;
            const text = JSON.stringify(p.content || '');
            if (text.includes('요청서') && text.includes('_request_')) s.isRequest = true;
        } else if (j.type === 'event_msg' && p.type === 'token_count' && p.rate_limits && p.rate_limits.primary) {
            const w = p.rate_limits.primary;
            const snap = { used: Number(w.used_percent), resetsAt: w.resets_at, windowMin: w.window_minutes };
            if (!Number.isFinite(snap.used)) continue;
            if (!s.first) s.first = snap;
            s.last = snap;
        }
    }
    return s;
}

async function collectHistory(days) {
    const root = path.join(codexHome(), 'sessions');
    const files = listRollouts(root, Date.now() - days * 86400_000);
    const runs = [];
    let requestRuns = 0, skippedReset = 0, skippedNoData = 0;
    for (const f of files) {
        const s = await summarizeRollout(f);
        if (!REQUEST_ORIGINATORS.has(s.originator) || !s.isRequest) continue;
        requestRuns++;
        if (!s.first || !s.last || s.first === s.last) { skippedNoData++; continue; }
        // 실행 중에 5시간 창이 리셋되면 증가폭이 음수·왜곡이 된다. 그런 건은 뺀다.
        if (s.first.resetsAt !== s.last.resetsAt) { skippedReset++; continue; }
        runs.push({
            startedAt: s.startedAt, model: s.model, effort: s.effort,
            from: s.first.used, to: s.last.used, delta: +(s.last.used - s.first.used).toFixed(1)
        });
    }
    runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const deltas = runs.map((r) => r.delta).sort((a, b) => a - b);
    const median = deltas.length
        ? (deltas.length % 2 ? deltas[(deltas.length - 1) / 2] : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2)
        : null;
    return {
        days, requestRuns, counted: runs.length, skippedReset, skippedNoData,
        median, max: deltas.length ? deltas[deltas.length - 1] : null, min: deltas.length ? deltas[0] : null,
        runs
    };
}

// ── 출력 ───────────────────────────────────────────────────────────────
function fmtReset(epochSec) {
    if (!Number.isFinite(epochSec)) return '리셋 시각 모름';
    const d = new Date(epochSec * 1000);
    const mins = Math.round((d.getTime() - Date.now()) / 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (mins <= 0) return `리셋 ${when}`;
    const left = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분 후` : `${mins}분 후`;
    return `리셋 ${when} (${left})`;
}

function fmtWindow(label, w) {
    if (!w || !Number.isFinite(w.usedPercent)) return `${label}: 정보 없음`;
    const left = Math.max(0, 100 - w.usedPercent);
    return `${label}: ${w.usedPercent}% 사용 · 남은 여유 ${left}% · ${fmtReset(w.resetsAt)}`;
}

function pickSnapshot(rateLimits) {
    if (!rateLimits) return null;
    // rateLimitsByLimitId 에 여러 한도가 올 수 있다. 기본은 rateLimits(대표값)이다.
    return rateLimits.rateLimits || null;
}

function render(o, st, hist) {
    const L = [];
    L.push('── Codex 현재 상태 ──');

    const cfg = st.config || {};
    const models = st.models || [];
    const def = models.find((m) => m.isDefault);
    const curModel = cfg.model || (def && (def.model || def.id)) || null;
    const curModelInfo = models.find((m) => (m.model || m.id) === curModel);
    const curEffort = cfg.model_reasoning_effort || (curModelInfo && curModelInfo.defaultReasoningEffort) || null;
    if (st.errors.config && !curModel) L.push(`모델/추론 수준: 조회 실패 — ${st.errors.config}`);
    else L.push(`모델/추론 수준: ${curModel || '모름'} / ${curEffort || '모름'}${cfg.model ? '' : '   (설정에 없어 기본값으로 표시)'}`);

    const snap = pickSnapshot(st.rateLimits);
    if (st.errors.rateLimits || st.errors.appServer || st.errors.lib) {
        L.push(`한도: 조회 실패 — ${st.errors.rateLimits || st.errors.appServer || st.errors.lib}`);
    } else if (!snap) {
        L.push('한도: 응답에 한도 정보가 없다');
    } else {
        L.push(fmtWindow('5시간 한도', snap.primary));
        L.push(fmtWindow('주간 한도 ', snap.secondary));
        if (snap.planType) L.push(`플랜: ${snap.planType}`);
        if (snap.rateLimitReachedType) L.push(`🔴 한도 도달 상태: ${snap.rateLimitReachedType}`);
    }

    if (st.errors.models) {
        L.push(`모델 목록: 조회 실패 — ${st.errors.models}`);
    } else if (models.length) {
        L.push('고를 수 있는 모델:');
        for (const m of models) {
            const id = m.model || m.id;
            const efforts = (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e).join('/');
            L.push(`  - ${id}${id === curModel ? ' (현재)' : ''}  [${efforts || '추론 수준 정보 없음'}]`);
        }
    }

    if (hist) {
        if (hist.error) {
            L.push(`과거 1회 소모: 계산 실패 — ${hist.error}`);
        } else if (!hist.counted) {
            L.push(`과거 1회 소모: 최근 ${hist.days}일 요청서 기반 실행 ${hist.requestRuns}건 — 집계할 수 있는 건이 없다`);
        } else {
            L.push(`과거 1회 소모: 최근 ${hist.days}일 요청서 기반 실행 ${hist.counted}건 기준 5시간 창 ` +
                `중간값 +${hist.median}% · 최대 +${hist.max}% · 최소 +${hist.min}%   (되묻기 턴 포함)`);
            if (hist.skippedReset || hist.skippedNoData) {
                L.push(`  (제외: 실행 중 창 리셋 ${hist.skippedReset}건 · 사용률 기록 부족 ${hist.skippedNoData}건)`);
            }
            for (const r of hist.runs.slice(-5)) {
                L.push(`  - ${String(r.startedAt || '').slice(0, 16).replace('T', ' ')}  ${r.model || '?'}/${r.effort || '?'}  ${r.from}% → ${r.to}% (+${r.delta}%)`);
            }
        }
    }
    return L.join('\n');
}

async function main() {
    let o;
    try { o = parseArgs(process.argv.slice(2)); } catch (e) {
        process.stderr.write(`codex-status: ${e.message}\n`);
        return 2;
    }
    if (o.help) {
        process.stdout.write('node codex-status.mjs [--cwd <프로젝트 루트>] [--days <n>] [--json] [--no-history]\n');
        return 0;
    }

    const [st, hist] = await Promise.all([
        queryAppServer(o.cwd),
        o.history ? collectHistory(o.days).catch((e) => ({ error: msg(e) })) : Promise.resolve(null)
    ]);

    if (o.json) {
        // 계정 식별자는 내보내지 않는다.
        const safe = { ...st, rateLimits: st.rateLimits ? { rateLimits: st.rateLimits.rateLimits } : null };
        process.stdout.write(JSON.stringify({ status: safe, history: hist }, null, 2) + '\n');
    } else {
        process.stdout.write(render(o, st, hist) + '\n');
    }
    const failed = Object.keys(st.errors).length > 0 || (hist && hist.error);
    return failed ? 3 : 0;
}

main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`codex-status: 예상 못 한 오류 — ${e && e.stack ? e.stack : e}\n`);
    process.exit(3);
});
