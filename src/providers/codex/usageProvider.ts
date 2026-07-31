// Codex account rate limits, read live from the Codex app-server.
//
// Why this exists: the `rate_limits` snapshot embedded in rollout logs only advances while
// Codex is working, so after a day of not using Codex the status bar would keep showing a
// stale percentage — and the limit is a 7-day rolling window, so the real number drifts
// downward on its own. The app-server queries the account for real, which is the Codex
// counterpart to the claude.ai usage call the plan monitor already makes.
//
// Resolution order (docs §11.2):
//   1. app-server `account/rateLimits/read`   ← this module
//   2. newest `rate_limits` seen in a rollout  ← rolloutParser, used as fallback
//   3. last successful value, marked stale
//   4. unavailable
//
// Process policy (docs §11.3): never let a spawn failure break anything else, never pass
// secrets on the command line, always time out, always reap the child.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CodexUsageSnapshot, CodexUsageWindow } from '../../core/sessionTypes';
import { log } from '../../core/logger';

/** Hard ceiling for one probe. The observed round trip is ~850ms on this machine. */
const PROBE_TIMEOUT_MS = 15000;
const LOCK_STALE_MS = PROBE_TIMEOUT_MS + 5000;
const LOCK_WAIT_MS = PROBE_TIMEOUT_MS + 1000;
const CACHE_VERSION = 1;
export const CODEX_USAGE_CACHE_FILENAME = 'codex-account-usage-v1.json';
const CACHE_LOCK_FILENAME = 'codex-account-usage-v1.lock';

export interface SharedCodexUsageResult {
    snapshot: CodexUsageSnapshot;
    source: 'probe' | 'shared-cache';
}

interface RawAppServerWindow {
    usedPercent?: unknown;
    windowDurationMins?: unknown;
    resetsAt?: unknown;
}

function readAppServerWindow(raw: RawAppServerWindow | null | undefined): CodexUsageWindow | null {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.usedPercent !== 'number') return null;
    return {
        usedPercent: raw.usedPercent,
        windowMinutes: typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : 0,
        // The app-server reports epoch SECONDS, like the rollout snapshot does.
        resetsAt: typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt)
            ? raw.resetsAt * 1000
            : null
    };
}

// Cache snapshots contain the already-normalized CodexUsageWindow shape: windowMinutes and
// epoch MILLISECONDS. Feeding them back through readAppServerWindow() would multiply the
// timestamp by 1000 a second time (turning ~5 days into millions of days) and drop the
// window length because the app-server field has a different name.
function readCachedWindow(raw: any): CodexUsageWindow | null {
    if (!raw || typeof raw !== 'object' || typeof raw.usedPercent !== 'number') return null;
    return {
        usedPercent: raw.usedPercent,
        windowMinutes: typeof raw.windowMinutes === 'number' ? raw.windowMinutes : 0,
        resetsAt: typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt)
            ? raw.resetsAt
            : null
    };
}

function cachePath(cacheDir: string): string {
    return path.join(cacheDir, CODEX_USAGE_CACHE_FILENAME);
}

function lockPath(cacheDir: string): string {
    return path.join(cacheDir, CACHE_LOCK_FILENAME);
}

/** Read the cross-window cache. Invalid, future-dated and over-age data is ignored. */
export function readCachedCodexRateLimits(cacheDir: string, maxAgeMs: number): CodexUsageSnapshot | null {
    if (!cacheDir) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath(cacheDir), 'utf8')) as any;
        if (parsed?.version !== CACHE_VERSION || !parsed.snapshot) return null;
        const observedMs = Date.parse(parsed.snapshot.observedAt);
        const age = Date.now() - observedMs;
        if (!Number.isFinite(observedMs) || age < -60000 || age > maxAgeMs) return null;
        return {
            primary: readCachedWindow(parsed.snapshot.primary),
            secondary: readCachedWindow(parsed.snapshot.secondary),
            planType: typeof parsed.snapshot.planType === 'string' ? parsed.snapshot.planType : null,
            hasCredits: parsed.snapshot.hasCredits === true,
            observedAt: new Date(observedMs)
        };
    } catch {
        return null;
    }
}

function writeCachedCodexRateLimits(cacheDir: string, snapshot: CodexUsageSnapshot): void {
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = cachePath(cacheDir);
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, snapshot }), {
            encoding: 'utf8', flag: 'wx', mode: 0o600
        });
        fs.renameSync(temp, target);
    } finally {
        try { fs.unlinkSync(temp); } catch { /* renamed or never created */ }
    }
}

function removeStaleLock(p: string): void {
    try {
        if (fs.statSync(p).mtimeMs < Date.now() - LOCK_STALE_MS) fs.unlinkSync(p);
    } catch { /* another process removed it, or it disappeared */ }
}

function releaseOwnedLock(p: string, token: string): void {
    try {
        if (fs.readFileSync(p, 'utf8') === token) fs.unlinkSync(p);
    } catch { /* best effort; TTL recovery handles a crashed owner */ }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Fetch one account snapshot across all VS Code windows sharing this extension's
 * globalStorage directory. An exclusive-create lock elects one app-server probe; followers
 * wait for its atomically replaced cache file instead of spawning their own process.
 */
export async function fetchSharedCodexRateLimits(
    cacheDir: string,
    maxAgeMs: number,
    execPath = 'codex'
): Promise<SharedCodexUsageResult | null> {
    const cached = readCachedCodexRateLimits(cacheDir, maxAgeMs);
    if (cached) return { snapshot: cached, source: 'shared-cache' };

    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {
        log(`[codex-usage] shared cache unavailable: ${e}`);
        return null;
    }

    const lock = lockPath(cacheDir);
    const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let ownsLock = false;

    while (Date.now() < deadline) {
        try {
            fs.writeFileSync(lock, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            ownsLock = true;
            break;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
                log(`[codex-usage] shared lock unavailable: ${e}`);
                return null;
            }
            const fresh = readCachedCodexRateLimits(cacheDir, maxAgeMs);
            if (fresh) return { snapshot: fresh, source: 'shared-cache' };
            removeStaleLock(lock);
            await delay(100);
        }
    }

    if (!ownsLock) return null;
    try {
        // A previous owner may have filled the cache immediately before this process won.
        const fresh = readCachedCodexRateLimits(cacheDir, maxAgeMs);
        if (fresh) return { snapshot: fresh, source: 'shared-cache' };

        const snapshot = await fetchCodexRateLimits(execPath);
        if (!snapshot) return null;
        try { writeCachedCodexRateLimits(cacheDir, snapshot); }
        catch (e) { log(`[codex-usage] shared cache write failed: ${e}`); }
        return { snapshot, source: 'probe' };
    } finally {
        releaseOwnedLock(lock, token);
    }
}

/**
 * Ask the Codex app-server for the current account rate limits.
 * Resolves to null on any failure — a missing `codex` binary, a protocol change, a
 * timeout. Callers fall back to the rollout snapshot; nothing else is affected.
 */
export function fetchCodexRateLimits(execPath = 'codex'): Promise<CodexUsageSnapshot | null> {
    return new Promise((resolve) => {
        let child: cp.ChildProcessWithoutNullStreams;
        try {
            child = cp.spawn(execPath, ['app-server'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                // Codex is installed via npm on Windows, so the launcher is a .cmd shim
                // that only resolves through a shell.
                shell: process.platform === 'win32',
                windowsHide: true
            }) as cp.ChildProcessWithoutNullStreams;
        } catch (e) {
            log(`[codex-usage] spawn threw: ${e}`);
            resolve(null);
            return;
        }

        let settled = false;
        let buf = '';

        const finish = (result: CodexUsageSnapshot | null, why: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill(); } catch { /* already gone */ }
            if (!result) log(`[codex-usage] no result: ${why}`);
            resolve(result);
        };

        const timer = setTimeout(() => finish(null, `timeout after ${PROBE_TIMEOUT_MS}ms`), PROBE_TIMEOUT_MS);

        const send = (obj: unknown) => {
            try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* pipe closed */ }
        };

        child.stdout.on('data', (d: Buffer) => {
            buf += d.toString('utf8');
            let i: number;
            // The protocol is newline-delimited JSON; anything unparseable is ignored
            // rather than thrown on, so a future protocol tweak degrades to "unavailable".
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let msg: any;
                try { msg = JSON.parse(line); } catch { continue; }

                if (msg.id === 0 && msg.result !== undefined) {
                    send({ method: 'initialized', params: {} });
                    send({ id: 1, method: 'account/rateLimits/read', params: {} });
                    continue;
                }
                if (msg.id === 1) {
                    if (msg.error) { finish(null, `rpc error: ${JSON.stringify(msg.error).slice(0, 200)}`); return; }
                    const rl = msg.result?.rateLimits;
                    if (!rl || typeof rl !== 'object') { finish(null, 'no rateLimits in response'); return; }
                    finish({
                        primary: readAppServerWindow(rl.primary),
                        secondary: readAppServerWindow(rl.secondary),
                        planType: typeof rl.planType === 'string' ? rl.planType : null,
                        hasCredits: !!(rl.credits && rl.credits.hasCredits),
                        observedAt: new Date()
                    }, '');
                    return;
                }
            }
        });

        // Never echo app-server stderr verbatim into the log: it can carry account context.
        child.stderr.on('data', () => { /* intentionally ignored */ });
        child.on('error', (e) => finish(null, `spawn error: ${e.message}`));
        child.on('exit', (code) => finish(null, `app-server exited early (code ${code})`));

        send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-state-bar', version: '1.8.0' } } });
    });
}
