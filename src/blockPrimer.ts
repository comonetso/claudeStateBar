import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Fires a throwaway `claude -p` right where the Telegram reset alert goes out, so the next
// 5-hour block is anchored to the reset instead of to whenever the user next types.
//
// The primer runs in its own working directory. Claude Code encodes the cwd into the
// ~/.claude/projects/<encoded> directory name, so every primer session lands in a directory
// whose name contains PRIMER_MARK — that is what findActiveSessions() filters on to keep
// these dummy sessions out of the status bar.
export const PRIMER_MARK = 'claudeStateBar-primer';
export const PRIMER_DIR = path.join(os.tmpdir(), PRIMER_MARK);

const EXEC_TIMEOUT_MS = 120000;
const LOCK_TTL_MS = 24 * 60 * 60 * 1000;

// Keep the prompt trivial and tool-free: the point is to open the window, not to do work.
const PRIMER_PROMPT = 'Reply with exactly: ok';

type Logger = (msg: string) => void;

// 'fired' means the CLI exited 0 — it does NOT mean a subscription block opened. Anthropic has
// floated billing `claude -p` to the API rather than to the subscription; if that ever lands,
// the call still succeeds while opening no window. The caller must confirm against the usage
// API. 'skipped' means no call was made at all, so there is nothing to verify or charge.
export type FireOutcome = 'fired' | 'exec-failed' | 'api-key-present' | 'skipped';

// The primer is only ever meant to spend the *subscription* window. If the CLI is authenticated
// with an API key instead, the same call bills real API credit and still exits 0 — it would look
// like a success while quietly costing money on every reset. Refuse to fire rather than guess.
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

function apiKeyInEnv(): string | null {
    for (const v of API_KEY_VARS) {
        if ((process.env[v] || '').trim()) return v;
    }
    return null;
}

// Cross-window guard. Several VS Code windows each run their own copy of this extension and
// would all fire for the same reset. An exclusive create ('wx') is atomic, so exactly one
// window wins the race; the rest see EEXIST and stand down.
function claimFiring(resetAt: string, log: Logger): boolean {
    try {
        fs.mkdirSync(PRIMER_DIR, { recursive: true });
        const lock = path.join(PRIMER_DIR, `fired-${new Date(resetAt).getTime()}.lock`);
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        return true;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
            log('[primer] another window already fired for this reset — standing down');
        } else {
            log(`[primer] lock failed (${code ?? e}) — skipping to stay safe`);
        }
        return false;
    }
}

function sweepStaleLocks(): void {
    try {
        const cutoff = Date.now() - LOCK_TTL_MS;
        for (const name of fs.readdirSync(PRIMER_DIR)) {
            if (!name.endsWith('.lock')) continue;
            const p = path.join(PRIMER_DIR, name);
            if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        }
    } catch { /* best-effort cleanup */ }
}

// Called from the session-reset handler, alongside the Telegram alert.
//
// `resetAtNow` is the reset timestamp claude.ai reports at this moment. If it is already in the
// future, a block is open *right now* — priming would neither open anything nor be verifiable,
// so we skip. That check also protects the caller's verification step, which reads "the window
// did not move" as evidence that headless runs stopped drawing on the subscription.
export function fireOnReset(
    resetAtNow: string | null,
    log: Logger,
    onDone: (outcome: FireOutcome) => void
): void {
    const openUntil = resetAtNow ? new Date(resetAtNow).getTime() : NaN;
    if (Number.isFinite(openUntil) && openUntil > Date.now()) {
        log(`[primer] a block is already open until ${resetAtNow} — nothing to prime, skipping`);
        onDone('skipped');
        return;
    }

    const keyVar = apiKeyInEnv();
    if (keyVar) {
        log(`[primer] refusing to fire — ${keyVar} is set, so \`claude -p\` would bill API credit instead of the subscription window`);
        onDone('api-key-present');
        return;
    }

    const lockKey = resetAtNow ?? new Date().toISOString();
    if (!claimFiring(lockKey, log)) {
        onDone('skipped');
        return;
    }
    sweepStaleLocks();

    log(`[primer] firing \`claude -p\` in ${PRIMER_DIR} to open the new block`);
    const child = cp.exec(
        `claude -p "${PRIMER_PROMPT}"`,
        { cwd: PRIMER_DIR, windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
            if (err) {
                log(`[primer] failed: ${err.message}${stderr?.trim() ? ` — ${stderr.trim()}` : ''}`);
                onDone('exec-failed');
                return;
            }
            // Exit 0 only means the CLI ran — NOT that a subscription block opened.
            log(`[primer] claude -p exited 0, replied: ${(stdout || '').trim().slice(0, 80)}`);
            onDone('fired');
        }
    );
    // The CLI waits 3s for piped stdin before giving up. Close it so the primer fires at once.
    child.stdin?.end();
}
