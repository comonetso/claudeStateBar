// codex-sessions.mjs — codex_rescue 가 만든 Codex 대화 기록을 찾고 공식 명령으로 지운다 (2026-10-02)
//
// cleanup-logs.mjs(용량 계산·즉시 정리)와 prune-codex-sessions.mjs(뒤에서 도는 자동 삭제)가 같이 쓴다.
//
// 식별 (사용자 결정 — codex_rescue 가 만든 것만 건드린다):
//   - `$CODEX_HOME/sessions`(없으면 `~/.codex/sessions`) 아래 `.jsonl` 의 첫 줄(session_meta)만 읽는다.
//     첫 줄은 앞 64KB 안에서 첫 줄바꿈까지다. 못 읽거나 JSON 이 아니면 그 파일은 건너뛴다.
//   - rescue 본 기록 = `payload.originator === "claude-state-bar-live-consult"` 이고 하위 에이전트가 아닌 것.
//   - 하위 에이전트 기록은 `payload.source.subagent.thread_spawn.parent_thread_id` 로 부모에 연결된다.
//     실측(10-02, 이 PC 기록 199개)에서 `source.subagent` 는 thread_spawn 말고도 `"review"`·`{other:"guardian"}`
//     모양이 있었고, 그때도 `payload.parent_thread_id` 가 최상위에 있었다. 그래서 연결은 thread_spawn 을 먼저,
//     없으면 최상위 parent_thread_id 를 본다. 하위 표시(source.subagent·thread_source "subagent"·부모 id)가 하나라도
//     있으면 본 기록으로 치지 않는다 — 하위만 따로 지우지 않는다.
//   - 부모를 공식 명령으로 지우면 하위 기록·연결까지 Codex 가 같이 지운다(10-02 사본 홈 실측). 그래서 지울 때는
//     본 기록 id 만 넘긴다.
//
// 지우는 방법은 `codex delete --force <UUID>` 하나뿐이다. 파일만 지우면 Codex 내부 DB 와 어긋난다.
//   - 비대화형은 `--force` 가 없으면 거부된다(rc=1). 성공 rc=0, 없는 id rc=1.
//   - Windows 의 codex 는 npm `.cmd` shim 이라 셸을 거쳐야 한다. 인자를 배열로 주면서 shell 을 켜면
//     새 Node 가 경고(DEP0190)를 내므로, Windows 에서는 UUID 검사를 통과한 id 로 명령 한 줄을 만든다.
//   - Windows 의 cmd 는 "명령 없음"에도 종료 코드 1 을 돌려준다(실측 — "없는 id" 와 구분이 안 된다).
//     그래서 지우기 전에 PATH 에서 codex 를 직접 찾는다.
//   - 환경(CODEX_HOME)은 그대로 물려준다 — 훑은 홈과 지우는 홈이 같다.
//
// 기기 잠금 `<홈>/.claude/codex_rescue/.codex-prune.lock` (홈 = Node os.homedir()):
//   `wx` 로 만들고 `{pid, started_at}` 을 적는다. 이미 있으면 그 pid 가 살아 있는지 보고, 살아 있으면 못 잡은 것,
//   죽었거나 내용이 깨졌으면 넘겨받는다. 푸는 쪽은 내용이 아직 내 것일 때만 지운다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';

export const RESCUE_ORIGINATOR = 'claude-state-bar-live-consult';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_LINE_MAX = 64 * 1024;
const IS_WIN = process.platform === 'win32';

function lstat(p) {
    try { return fs.lstatSync(p); } catch { return null; }
}

/** Codex 홈. CODEX_HOME 이 비어 있지 않으면 그것, 아니면 `<os.homedir()>/.codex`. */
export function codexHome(env = process.env) {
    const v = env.CODEX_HOME;
    return v ? path.resolve(v) : path.join(os.homedir(), '.codex');
}

export function sessionsDir(env = process.env) {
    return path.join(codexHome(env), 'sessions');
}

/** 기기 잠금·결과 로그 경로. 홈은 Node os.homedir() 기준이다(CLAUDE_CONFIG_DIR 은 따르지 않는다). */
export function machinePaths(home = os.homedir()) {
    const dir = path.join(home, '.claude', 'codex_rescue');
    return { dir, lock: path.join(dir, '.codex-prune.lock'), log: path.join(dir, 'codex-prune.log') };
}

/** 경로 비교용 정규화 — 구분자를 `/` 로, 끝 슬래시 제거, Windows 는 대소문자 무시. */
export function normPath(p, platform = process.platform) {
    let s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (platform === 'win32') s = s.toLowerCase();
    return s;
}

export function samePath(a, b, platform = process.platform) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    return normPath(a, platform) === normPath(b, platform);
}

/** 파일 첫 줄(앞 64KB 안에서 첫 줄바꿈까지)을 JSON 으로. 못 읽으면 null. */
export function readFirstLine(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        // 실측 첫 줄은 20KB 안팎이다. 16KB 씩 읽다가 줄바꿈을 만나면 멈춘다(매 실행 전체를 훑으므로).
        const buf = Buffer.alloc(FIRST_LINE_MAX);
        let n = 0, nl = -1;
        while (n < FIRST_LINE_MAX) {
            const got = fs.readSync(fd, buf, n, Math.min(16 * 1024, FIRST_LINE_MAX - n), n);
            if (got <= 0) break;
            nl = buf.subarray(n, n + got).indexOf(0x0a);
            if (nl >= 0) { nl += n; break; }
            n += got;
        }
        if (nl < 0) return null;
        const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        return JSON.parse(line);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 이미 닫혔다 */ } }
    }
}

/** session_meta 한 줄에서 필요한 값만 뽑는다. session_meta 가 아니면 null. */
export function metaOf(first) {
    if (!first || typeof first !== 'object' || first.type !== 'session_meta') return null;
    const p = first.payload;
    if (!p || typeof p !== 'object') return null;
    const src = p.source && typeof p.source === 'object' ? p.source : null;
    const spawn = src && src.subagent && typeof src.subagent === 'object' ? src.subagent.thread_spawn : null;
    const spawnParent = spawn && typeof spawn === 'object' ? spawn.parent_thread_id : undefined;
    const parentId = typeof spawnParent === 'string' && spawnParent ? spawnParent
        : (typeof p.parent_thread_id === 'string' && p.parent_thread_id ? p.parent_thread_id : null);
    const isSub = !!parentId || p.thread_source === 'subagent' || !!(src && Object.hasOwn(src, 'subagent'));
    return {
        id: typeof p.id === 'string' ? p.id : null,
        originator: typeof p.originator === 'string' ? p.originator : null,
        cwd: typeof p.cwd === 'string' ? p.cwd : null,
        parentId,
        isSub,
    };
}

/**
 * sessions 폴더 아래 `.jsonl` 기록을 모두 훑는다. 링크는 따라가지 않는다.
 * @returns {{file:string, bytes:number, mtimeMs:number, id:string|null, originator:string|null,
 *            cwd:string|null, parentId:string|null, isSub:boolean}[]}
 */
export function scanSessions(dir = sessionsDir()) {
    const out = [];
    const walk = (p) => {
        const st = lstat(p);
        if (!st) return;
        if (st.isDirectory()) {
            let names;
            try { names = fs.readdirSync(p); } catch { return; }
            for (const n of names) walk(path.join(p, n));
            return;
        }
        if (!st.isFile() || !p.endsWith('.jsonl')) return;
        const meta = metaOf(readFirstLine(p));
        if (!meta) return;
        out.push({ file: p, bytes: st.size, mtimeMs: st.mtimeMs, ...meta });
    };
    if (lstat(dir)?.isDirectory()) walk(dir);
    return out;
}

/**
 * rescue 본 기록과 하위 기록을 묶는다.
 * 본 기록마다 `totalBytes` = 자기 크기 + 하위(하위의 하위 포함) 크기.
 * `subOf` 는 하위 기록 id → 그 위의 본 기록 id (보호 판정에 쓴다).
 */
export function indexRescue(records) {
    const children = new Map();
    const byId = new Map();
    for (const r of records) {
        if (r.id) byId.set(r.id, r);
        if (r.parentId) {
            if (!children.has(r.parentId)) children.set(r.parentId, []);
            children.get(r.parentId).push(r);
        }
    }
    const mains = [];
    const subOf = new Map();
    for (const r of records) {
        if (r.originator !== RESCUE_ORIGINATOR || r.isSub || !r.id || !UUID_RE.test(r.id)) continue;
        let total = r.bytes;
        const seen = new Set([r.file]);
        const stack = [...(children.get(r.id) || [])];
        while (stack.length) {
            const c = stack.pop();
            if (seen.has(c.file)) continue;   // 고리·중복 방어
            seen.add(c.file);
            total += c.bytes;
            if (c.id) {
                if (!subOf.has(c.id)) subOf.set(c.id, r.id);
                stack.push(...(children.get(c.id) || []));
            }
        }
        mains.push({ ...r, totalBytes: total, subCount: seen.size - 1 });
    }
    return { mains, subOf, byId };
}

/** 이 프로젝트(root)에서 만든 rescue 본 기록. cwd 를 root 와 비교한다. */
export function projectMains(index, root, platform = process.platform) {
    return index.mains.filter(m => samePath(m.cwd, root, platform));
}

/** events 파일에서 Codex 대화 번호(thread.started 의 thread_id)를 모두 모은다. 못 읽으면 빈 배열. */
export function threadIdsFromEvents(file) {
    let text;
    try {
        if (!lstat(file)?.isFile()) return [];
        text = fs.readFileSync(file, 'utf8');
    } catch { return []; }
    const ids = new Set();
    for (const line of text.split('\n')) {
        if (!line.includes('thread.started')) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        // live-consult(bridge.makeThreadStartedEvent) 와 `codex exec --json` 둘 다
        // `{"type":"thread.started","thread_id":"<id>"}` 모양이다.
        if (j && j.type === 'thread.started' && typeof j.thread_id === 'string' && j.thread_id) ids.add(j.thread_id);
    }
    return [...ids];
}

/** PATH 에서 명령을 찾는다. Windows 는 PATHEXT 확장자를 붙여 본다. */
export function commandOnPath(name, env = process.env) {
    const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const exts = IS_WIN ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    for (const d of dirs) {
        for (const e of exts) {
            const st = (() => { try { return fs.statSync(path.join(d, name + e)); } catch { return null; } })();
            if (st && st.isFile()) return true;
        }
    }
    return false;
}

// 한 건이 이보다 오래 걸리면 그 건만 포기하고 다음으로 간다(사용자 결정 10-02, 실측 한 건 1.2~6초).
// 안 두면 멈춘 한 건이 기기 잠금을 계속 쥐어 이후 자동 삭제가 전부 건너뛰어진다.
export const DELETE_TIMEOUT_MS = 2 * 60 * 1000;

// 시간 초과로 끊은 뒤 남은 삭제 프로세스를 끈다. Windows 는 셸을 거쳐 띄우므로 셸만 죽고 codex 는 남을 수 있다.
// 명령줄에 그 UUID 가 든 프로세스만 고른다 — UUID 는 위에서 형식 검사를 했고 대화마다 다르다.
function killLeftover(id) {
    const needle = `delete --force ${id}`;
    const opts = { windowsHide: true, stdio: 'ignore', timeout: 30_000 };
    try {
        if (IS_WIN) {
            cp.spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.ProcessId -ne $PID } | ` +
                `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], opts);
        } else {
            cp.spawnSync('pkill', ['-f', needle], opts);
        }
    } catch { /* 못 끄면 그대로 둔다 — 다음 건은 계속 간다 */ }
}

/**
 * `codex delete --force <id>` 한 번. 동기로 기다리되 timeoutMs 를 넘기면 끊는다.
 * @returns {{ok:boolean, missing?:boolean, timedOut?:boolean, detail?:string}}  missing=true 면 codex 명령이 없다.
 */
export function codexDelete(id, { timeoutMs = DELETE_TIMEOUT_MS } = {}) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return { ok: false, detail: 'not a UUID' };
    const opts = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs };
    const r = IS_WIN
        ? cp.spawnSync(`codex delete --force ${id}`, { ...opts, shell: true })
        : cp.spawnSync('codex', ['delete', '--force', id], opts);
    if (r.error && r.error.code === 'ETIMEDOUT') {
        killLeftover(id);
        return { ok: false, timedOut: true, detail: `no answer within ${Math.round(timeoutMs / 1000)}s — skipped, retried next time` };
    }
    if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', detail: String(r.error.code || r.error.message) };
    if (r.status === 0) return { ok: true };
    // 임시 폴더 홈 같은 경우 Codex 가 경고를 먼저 찍는다 — 마지막 줄이 실제 사유다.
    const lines = `${r.stderr || ''}\n${r.stdout || ''}`.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const text = lines.filter(s => !/^WARNING:/.test(s)).pop() || lines.pop();
    return { ok: false, missing: r.status === 127, detail: (text || `exit ${r.status ?? r.signal}`).slice(0, 200) };
}

function readText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 잠금 파일을 읽어 주인 pid 가 살아 있는지. 없으면 null. */
export function lockHolder(lockFile) {
    const raw = readText(lockFile);
    if (raw === null) return null;
    let pid = null;
    try { pid = JSON.parse(raw).pid; } catch { /* 깨진 내용 */ }
    const alive = Number.isInteger(pid) && pid > 0 && pidAlive(pid);
    return { raw, pid, alive };
}

/**
 * 기기 잠금을 잡는다.
 * @returns {{ok:true, release:()=>void} | {ok:false, pid:number|null}}
 */
export function acquireMachineLock(lockFile) {
    const content = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
    const create = () => {
        const fd = fs.openSync(lockFile, 'wx');
        try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
    };
    const mine = () => ({
        ok: true,
        release() {
            // 그 사이 다른 프로세스가 넘겨받았으면 남의 잠금이다 — 내 내용일 때만 지운다.
            if (readText(lockFile) === content) { try { fs.unlinkSync(lockFile); } catch { /* 이미 없다 */ } }
        }
    });
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    try { create(); return mine(); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const h = lockHolder(lockFile);
    if (h && h.alive) return { ok: false, pid: h.pid };
    // 주인이 죽었거나 내용이 깨졌다 — 넘겨받는다. 읽은 내용이 그대로일 때만 지운다.
    if (h && readText(lockFile) === h.raw) { try { fs.unlinkSync(lockFile); } catch { /* 다른 쪽이 먼저 지웠다 */ } }
    try { create(); return mine(); } catch (e) {
        if (e.code === 'EEXIST') return { ok: false, pid: lockHolder(lockFile)?.pid ?? null };
        throw e;
    }
}

export function fmtSize(b) {
    if (!b || b <= 0) return '0KB';
    if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
    if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
    return `${Math.max(1, Math.round(b / 1024))}KB`;
}
