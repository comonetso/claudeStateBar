#!/usr/bin/env node
// codex-status.mjs — codex_rescue 실행 전 확인용 조회기 (2026-09-13)
//
// 스킬을 부르기 전에 Claude 가 이걸 돌려 사용자에게 물을 재료를 모은다.
//   ① 계정 한도   — account/rateLimits/read  (5시간 창 · 주간 창)
//   ② 현재 설정   — config/read               (프로필·레이어가 반영된 실제 model / model_reasoning_effort)
//   ③ 모델 목록   — model/list                (모델마다 지원하는 추론 수준 · 공식 설명)
//   ④ 과거 소모량 — ~/.codex/sessions 의 rollout 에서 요청서 기반 실행의 턴 1개당 창 증가폭(조합별)
//   ⑤ 한도 기준   — 한도 모양별 기준(5시간 남은 여유 · 주간 하루 몫)과 조합별 대조 (2026-09-19)
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

// 🔴 2026-09-17: 한도 창은 자리(primary/secondary)가 아니라 길이로 가른다.
//    Plus 는 primary=300분·secondary=10080분인데 Pro Lite 는 primary=10080분·secondary=null 이다.
//    자리로 읽으면 Pro Lite 의 주간 1% 가 "5시간 한도 1%"로 나왔다. claudeState 위젯 src/codex.js 와 같은 기준.
const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10080;

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

// 도구 호출 줄. 코덱스 버전마다 이름이 다르다 — 09-19 실측: custom_tool_call(exec) · function_call(exec_command).
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

// 한 rollout 을 턴 단위로 요약한다. 파일이 수십 MB 일 수 있어 통째로 읽지 않는다.
// 🔴 2026-09-19: 실행이 아니라 턴 단위로 센다. 되묻기 턴에서 모델·추론 수준을 바꾸는 일이 있어서
//    (09-14 luna/high → sol/low) 실행 단위로는 조합별 소모를 가를 수 없고, 턴 사이의 대기 동안
//    다른 곳에서 쓴 양까지 1회 소모로 섞인다.
async function summarizeRollout(file) {
    const s = {
        file, originator: null, isRequest: false, startedAt: null, slug: null,
        planType: null, turns: [], userSeen: 0
    };
    let cur = null;
    const startTurn = (turnId, at) => {
        cur = { turnId: turnId || null, startedAt: at, endedAt: null, lastAt: at, model: null, effort: null, windows: {}, calls: 0 };
        s.turns.push(cur);
    };
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const p = j.payload || {};
        const at = j.timestamp || null;
        if (cur && at) cur.lastAt = at;
        if (j.type === 'session_meta') {
            s.originator = p.originator || null;
            s.startedAt = p.timestamp || at;
            if (!REQUEST_ORIGINATORS.has(s.originator)) { rl.close(); break; }
        } else if (j.type === 'event_msg' && p.type === 'task_started') {
            startTurn(p.turn_id, at);
        } else if (j.type === 'turn_context') {
            // task_started 없이 오는 기록에 대비해 턴이 없거나 turn_id 가 바뀌면 새 턴으로 본다.
            if (!cur || (p.turn_id && cur.turnId && p.turn_id !== cur.turnId)) startTurn(p.turn_id, at);
            if (!cur.turnId && p.turn_id) cur.turnId = p.turn_id;
            if (p.model) cur.model = p.model;
            if (p.effort || p.reasoning_effort) cur.effort = p.effort || p.reasoning_effort;
        } else if (j.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
            if (cur) cur.endedAt = at;
        } else if (j.type === 'response_item' && TOOL_CALL_TYPES.has(p.type)) {
            if (cur) cur.calls++;
        } else if (j.type === 'response_item' && p.type === 'message' && p.role === 'user' && s.userSeen < 5) {
            // 요청서 기반 실행은 프롬프트에 `요청서: <경로>_request_<슬러그>.md` 가 들어간다.
            s.userSeen++;
            const text = JSON.stringify(p.content || '');
            if (text.includes('요청서') && text.includes('_request_')) s.isRequest = true;
            const m = !s.slug && text.match(/_request_([^\s"'`\\/]+?)\.md/);
            if (m) s.slug = m[1];
        } else if (j.type === 'event_msg' && p.type === 'token_count' && p.rate_limits) {
            const rl = p.rate_limits;
            if (rl.plan_type) s.planType = rl.plan_type;
            if (!cur) startTurn(null, at);
            for (const w of [rl.primary, rl.secondary]) {
                if (!w) continue;
                const mins = Number(w.window_minutes);
                if (mins !== FIVE_HOUR_MINS && mins !== WEEKLY_MINS) continue;
                const snap = { used: Number(w.used_percent), resetsAt: w.resets_at };
                if (!Number.isFinite(snap.used)) continue;
                const t = cur.windows[mins] || (cur.windows[mins] = { first: null, last: null });
                if (!t.first) t.first = snap;
                t.last = snap;
            }
        }
    }
    return s;
}

// 요청서 기반 실행의 rollout 요약만 모은다. 창별 집계는 현재 플랜을 안 뒤(tally)에 한다.
async function collectRequestRuns(days) {
    const root = path.join(codexHome(), 'sessions');
    const files = listRollouts(root, Date.now() - days * 86400_000);
    const sums = [];
    for (const f of files) {
        const s = await summarizeRollout(f);
        if (REQUEST_ORIGINATORS.has(s.originator) && s.isRequest) sums.push(s);
    }
    return sums;
}

function stats(deltas) {
    const d = [...deltas].sort((a, b) => a - b);
    if (!d.length) return { median: null, max: null, min: null };
    const median = d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
    return { median: +median.toFixed(1), max: d[d.length - 1], min: d[0] };
}

function comboKey(model, effort) { return `${model || '?'}/${effort || '?'}`; }

// 한 창(길이 mins)의 턴 1개당 증가폭을 센다. 조합(모델/추론 수준)별 묶음도 함께 낸다.
function tally(sums, mins) {
    const runs = [];
    let skippedReset = 0, skippedNoData = 0;
    for (const s of sums) {
        s.turns.forEach((t, i) => {
            const w = t.windows[mins];
            if (!w || !w.first || w.first === w.last) { skippedNoData++; return; }
            // 턴 도중에 창이 리셋되면 증가폭이 음수·왜곡이 된다. 그런 건은 뺀다.
            if (w.first.resetsAt !== w.last.resetsAt) { skippedReset++; return; }
            const end = t.endedAt || t.lastAt;
            const durSec = t.startedAt && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(t.startedAt)) / 1000)) : null;
            runs.push({
                startedAt: t.startedAt || s.startedAt, slug: s.slug, turn: i + 1, turns: s.turns.length,
                model: t.model, effort: t.effort, durationSec: Number.isFinite(durSec) ? durSec : null, calls: t.calls,
                from: w.first.used, to: w.last.used, delta: +(w.last.used - w.first.used).toFixed(1)
            });
        });
    }
    runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const groups = new Map();
    for (const r of runs) {
        const k = comboKey(r.model, r.effort);
        if (!groups.has(k)) groups.set(k, { model: r.model, effort: r.effort, deltas: [] });
        groups.get(k).deltas.push(r.delta);
    }
    const byCombo = [...groups.values()].map((g) => ({ model: g.model, effort: g.effort, count: g.deltas.length, ...stats(g.deltas) }));
    return { windowMins: mins, counted: runs.length, skippedReset, skippedNoData, ...stats(runs.map((r) => r.delta)), byCombo, runs };
}

// 🔴 2026-09-19 사용자 결정: 플랜 이름이 아니라 **한도 모양**(어떤 창이 있나)으로 가른다.
//    5시간+주간 → 두 창 모두 · 한쪽만 → 그 창 · 창이 없거나 조회 실패 → 과거 소모는 참고로만(5시간 창).
//    과거 기록은 같은 플랜 것만 센다 — 플랜마다 한도 크기가 달라 섞으면 틀어진다.
function limitShape(snap) {
    if (!snap) return 'unknown';
    const five = !!pickWindow(snap, FIVE_HOUR_MINS), weekly = !!pickWindow(snap, WEEKLY_MINS);
    return five && weekly ? 'five+weekly' : five ? 'five' : weekly ? 'weekly' : 'none';
}

function buildHistory(days, sums, snap) {
    const shape = limitShape(snap);
    const plan = (snap && snap.planType) || null;
    const same = plan ? sums.filter((s) => s.planType === plan) : sums;
    const base = { days, requestRuns: sums.length, plan, skippedPlan: sums.length - same.length, shape };
    const windows = {};
    if (shape === 'five+weekly' || shape === 'five') windows[FIVE_HOUR_MINS] = tally(same, FIVE_HOUR_MINS);
    if (shape === 'five+weekly' || shape === 'weekly') windows[WEEKLY_MINS] = tally(same, WEEKLY_MINS);
    if (shape === 'unknown' || shape === 'none') windows[FIVE_HOUR_MINS] = tally(same, FIVE_HOUR_MINS);
    return { ...base, windows };
}

// ── 한도 기준 (권장 조합을 낮출지 가르는 선) ─────────────────────────────
// 🔴 2026-09-19 사용자 결정: 난이도로 고른 조합의 **과거 1회 최대 소모**가 기준을 넘으면 권장을 낮춘다.
//    5시간 창 기준 = 5시간 남은 여유 · 주간 창 기준 = 하루 몫(주간 남은 여유 ÷ 리셋까지 남은 날수).
//    두 창이 다 있으면 둘 다 본다(더 빠듯한 쪽이 걸린다). 판정은 여기서 표시만 하고 권장은 SKILL.md § 2-1 이 정한다.
function buildCriteria(snap, now) {
    const shape = limitShape(snap);
    const c = { shape, reached: (snap && snap.rateLimitReachedType) || null };
    const five = pickWindow(snap, FIVE_HOUR_MINS), weekly = pickWindow(snap, WEEKLY_MINS);
    if (five && Number.isFinite(five.usedPercent)) c.fiveLeft = Math.max(0, 100 - five.usedPercent);
    if (weekly && Number.isFinite(weekly.usedPercent)) {
        const left = Math.max(0, 100 - weekly.usedPercent);
        // 리셋까지 하루가 안 남았으면 남은 여유를 오늘 다 쓸 수 있다 — 1일로 나눈다(하루 몫이 여유보다 커지지 않게).
        const days = Number.isFinite(weekly.resetsAt) ? (weekly.resetsAt * 1000 - now) / 86400_000 : null;
        c.weeklyLeft = left;
        c.daysLeft = days === null ? null : +Math.max(0, days).toFixed(1);
        c.dailyShare = days === null ? null : +(left / Math.max(days, 1)).toFixed(1);
    }
    return c;
}

// 조합 하나를 기준과 대조한다. over: 기준 초과 · within: 이내 · none: 기록 없음(판정 불가)
function judgeCombo(hist, crit, model, effort) {
    const k = comboKey(model, effort);
    const pick = (mins) => {
        const w = hist && hist.windows && hist.windows[mins];
        return w ? w.byCombo.find((g) => comboKey(g.model, g.effort) === k) || null : null;
    };
    const f = pick(FIVE_HOUR_MINS), w = pick(WEEKLY_MINS);
    const checks = [];
    if (crit.fiveLeft !== undefined && f) checks.push(f.max > crit.fiveLeft);
    if (crit.dailyShare !== undefined && crit.dailyShare !== null && w) checks.push(w.max > crit.dailyShare);
    return { five: f, weekly: w, verdict: !checks.length ? 'none' : checks.some(Boolean) ? 'over' : 'within' };
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

// 스냅샷에서 길이가 mins 인 창을 고른다. 없으면 null.
function pickWindow(snap, mins) {
    if (!snap) return null;
    return [snap.primary, snap.secondary].find((w) => w && Number(w.windowDurationMins) === mins) || null;
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
        const five = pickWindow(snap, FIVE_HOUR_MINS);
        const weekly = pickWindow(snap, WEEKLY_MINS);
        L.push(!five && weekly ? '5시간 한도: 5시간 제한 미적용' : fmtWindow('5시간 한도', five));
        L.push(fmtWindow('주간 한도 ', weekly));
        if (snap.planType) L.push(`플랜: ${snap.planType}`);
        if (snap.rateLimitReachedType) L.push(`🔴 한도 도달 상태: ${snap.rateLimitReachedType}`);
    }

    if (st.errors.models) {
        L.push(`모델 목록: 조회 실패 — ${st.errors.models}`);
    } else if (models.length) {
        // 공식 설명을 함께 낸다 — 난이도에 맞는 조합을 고를 때 지어낸 서열 대신 이 문구를 근거로 쓴다(§ 2-1).
        L.push('고를 수 있는 모델 (공식 설명):');
        const effortDesc = new Map();
        for (const m of models) {
            const id = m.model || m.id;
            const efforts = (m.supportedReasoningEfforts || []).map((e) => {
                const name = e.reasoningEffort || e;
                if (e.description && !effortDesc.has(name)) effortDesc.set(name, e.description);
                return name;
            }).join('/');
            const retire = m.upgradeInfo && m.upgradeInfo.migrationMarkdown ? `  ⚠️ ${m.upgradeInfo.migrationMarkdown}` : '';
            L.push(`  - ${id}${id === curModel ? ' (현재)' : ''}  [${efforts || '추론 수준 정보 없음'}]  ${m.description || ''}${retire}`);
        }
        if (effortDesc.size) {
            L.push('추론 수준 (공식 설명):');
            for (const [name, d] of effortDesc) L.push(`  - ${name}: ${d}`);
        }
    }

    const crit = buildCriteria(snap, Date.now());
    L.push('── 한도 기준 (난이도로 고른 조합의 과거 1회 최대 소모가 넘으면 권장을 낮춘다) ──');
    if (crit.reached) L.push(`🔴 한도 도달 상태: ${crit.reached}`);
    if (crit.shape === 'unknown') L.push('한도를 조회하지 못했다 → 난이도만 보고 권장한다');
    else if (crit.shape === 'none') L.push('한도 창이 없다 → 난이도만 보고 권장한다');
    if (crit.fiveLeft !== undefined) L.push(`5시간 창 기준: 남은 여유 ${crit.fiveLeft}%`);
    if (crit.weeklyLeft !== undefined) {
        L.push(crit.dailyShare === null
            ? `주간 창 기준: 리셋 시각을 몰라 하루 몫을 못 낸다 (남은 여유 ${crit.weeklyLeft}%)`
            : `주간 창 기준: 하루 몫 ${crit.dailyShare}% (남은 여유 ${crit.weeklyLeft}% ÷ 리셋까지 ${crit.daysLeft}일${crit.daysLeft < 1 ? ', 하루 미만이라 1일로 계산' : ''})`);
    }

    if (hist) {
        if (hist.error) {
            L.push(`과거 1회 소모: 계산 실패 — ${hist.error}`);
        } else {
            const scope = hist.plan ? `${hist.plan} 플랜 ` : '';
            const other = hist.skippedPlan ? ` · 다른 플랜 기록 ${hist.skippedPlan}건 제외` : '';
            L.push(`── 과거 1회 소모 (최근 ${hist.days}일 ${scope}요청서 기반 실행의 턴 단위${other}) ──`);
            const wins = [FIVE_HOUR_MINS, WEEKLY_MINS].filter((m) => hist.windows[m]);
            const label = (m) => (m === FIVE_HOUR_MINS ? '5시간 창' : '주간 창');
            if (!wins.some((m) => hist.windows[m].counted)) {
                L.push(`집계할 수 있는 턴이 없다 (요청서 기반 실행 ${hist.requestRuns}건)`);
            } else {
                for (const m of wins) {
                    const h = hist.windows[m];
                    L.push(`${label(m)} 전체: ${h.counted}턴 · 중간값 +${h.median}% · 최대 +${h.max}% · 최소 +${h.min}%` +
                        (h.skippedReset || h.skippedNoData ? `   (제외: 턴 중 창 리셋 ${h.skippedReset} · 사용률 기록 부족 ${h.skippedNoData})` : ''));
                }
                // 조합별 — 두 창의 조합을 합쳐 한 줄씩. 판정은 위 기준과 대조한 결과다.
                const keys = new Map();
                for (const m of wins) for (const g of hist.windows[m].byCombo) keys.set(comboKey(g.model, g.effort), g);
                L.push('조합별:');
                const verdictText = { over: '→ 기준 초과', within: '→ 기준 이내', none: '' };
                for (const g of keys.values()) {
                    const j = judgeCombo(hist, crit, g.model, g.effort);
                    const parts = [];
                    if (j.five) parts.push(`5시간 ${j.five.count}턴 중간값 +${j.five.median}% 최대 +${j.five.max}%`);
                    if (j.weekly) parts.push(`주간 ${j.weekly.count}턴 중간값 +${j.weekly.median}% 최대 +${j.weekly.max}%`);
                    L.push(`  - ${comboKey(g.model, g.effort).padEnd(20)} ${parts.join(' · ')}  ${verdictText[j.verdict]}`.trimEnd());
                }
                L.push('  (여기 없는 조합은 기록 없음 — 판정 못 한다)');
                // 최근 턴 — 이번 작업과 규모를 견줄 재료(작업 이름·걸린 시간·도구 호출 수)
                const main = hist.windows[wins.find((m) => hist.windows[m].counted)];
                L.push(`최근 턴 (${label(main.windowMins)}):`);
                for (const r of main.runs.slice(-5)) {
                    const when = String(r.startedAt || '').slice(0, 16).replace('T', ' ');
                    const name = `${r.slug || '?'}${r.turns > 1 ? ` ${r.turn}/${r.turns}턴` : ''}`;
                    L.push(`  - ${when}  ${comboKey(r.model, r.effort)}  ${name}  ${fmtDur(r.durationSec)} · 도구 ${r.calls}회  ${r.from}% → ${r.to}% (+${r.delta}%)`);
                }
            }
        }
    }
    return L.join('\n');
}

function fmtDur(sec) {
    if (!Number.isFinite(sec)) return '시간 모름';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}분 ${s}초` : `${s}초`;
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

    const [st, sums] = await Promise.all([
        queryAppServer(o.cwd),
        o.history ? collectRequestRuns(o.days).catch((e) => ({ error: msg(e) })) : Promise.resolve(null)
    ]);
    // 어느 창을 셀지는 현재 플랜의 한도 모양에 달려 있어 조회가 끝난 뒤 집계한다.
    const hist = !sums ? null : sums.error ? sums : buildHistory(o.days, sums, pickSnapshot(st.rateLimits));

    if (o.json) {
        // 계정 식별자는 내보내지 않는다.
        const safe = { ...st, rateLimits: st.rateLimits ? { rateLimits: st.rateLimits.rateLimits } : null };
        const criteria = buildCriteria(pickSnapshot(st.rateLimits), Date.now());
        process.stdout.write(JSON.stringify({ status: safe, history: hist, criteria }, null, 2) + '\n');
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
