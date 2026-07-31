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
import { CodexUsageSnapshot, CodexUsageWindow } from '../../core/sessionTypes';
import { log } from '../../core/logger';

/** Hard ceiling for one probe. The observed round trip is ~850ms on this machine. */
const PROBE_TIMEOUT_MS = 15000;

interface RawWindow {
    usedPercent?: unknown;
    windowDurationMins?: unknown;
    resetsAt?: unknown;
}

function readWindow(raw: RawWindow | null | undefined): CodexUsageWindow | null {
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
                        primary: readWindow(rl.primary),
                        secondary: readWindow(rl.secondary),
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
