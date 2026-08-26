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

// Diagnostic log (temporary, 1.7.38): each reset appends before/now/future and the primer outcome
// here, so *why* the primer skips can be read back directly at the next reset. The VS Code output
// channel is memory-only and vanishes on reload, so it cannot serve that purpose.
export const DIAG_LOG = path.join(PRIMER_DIR, 'diag.log');
export function appendDiag(line: string): void {
    try {
        fs.mkdirSync(PRIMER_DIR, { recursive: true });
        fs.appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${line}\n`);
    } catch { /* best-effort diagnostics */ }
}

const EXEC_TIMEOUT_MS = 120000;
const LOCK_TTL_MS = 24 * 60 * 60 * 1000;

// Keep the prompt trivial and tool-free: the point is to open the window, not to do work.
const PRIMER_PROMPT = 'Reply with exactly: ok';

type Logger = (msg: string) => void;

// 'fired' means the CLI exited 0 — it does NOT mean a subscription block opened. Anthropic has
// floated billing `claude -p` to the API rather than to the subscription; if that ever lands,
// the call still succeeds while opening no window. The caller must confirm against the usage API.
// 'auth-unreadable' is deliberately separate from 'api-key-present': not being able to read
// auth.json is an absence of evidence, not evidence of an API key. Conflating the two cost a
// full day on 2026-08-26 — a Remote-SSH window handed the primer the server's `/root/.codex`,
// the local read failed with ENOENT, and that turned auto-start off *permanently* in user
// settings. Callers must skip this one reset and leave the setting alone.
export type FireOutcome = 'fired' | 'exec-failed' | 'api-key-present' | 'auth-unreadable';

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

// One-shot gate per reset event. Several VS Code windows (and rapid polls) can all react to the same
// block close; an exclusive create ('wx') is atomic, so exactly one wins and does the Telegram alert
// + prime, the rest see EEXIST and stand down. `eventKey` is a coarse (10-min) time bucket, so
// millisecond resetAt jitter and cross-window timing all collapse to the same key → one lock.
// `provider` namespaces the lock file so the Claude and Codex windows — which close on their own
// independent schedules and can easily land in the same 10-minute bucket — never claim each
// other's reset event.
export function claimResetEvent(eventKey: string, log: Logger, provider = 'claude'): boolean {
    try {
        fs.mkdirSync(PRIMER_DIR, { recursive: true });
        // Sweep here, not only in firePrimer(): with auto-start off the primer never runs, so
        // otherwise nothing would ever clear the day's claim files.
        sweepStaleLocks();
        const lock = path.join(PRIMER_DIR, `event-${provider}-${eventKey}.lock`);
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        return true;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
            log(`[primer] ${provider} reset event ${eventKey} already handled by another window — standing down`);
        } else {
            log(`[primer] ${provider} event lock failed (${code ?? e}) — skipping to stay safe`);
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

// Fire the primer. The caller must have already confirmed the block is CLOSED (session usage 0%)
// and claimed the reset event via claimResetEvent(). There is no "should we fire" logic here — no
// future/skip check (sessionResetAt is unreliable: it stays in the future even when the block is
// closed) — this owns only the act of firing. The caller verifies afterward via session %.
export function firePrimer(
    log: Logger,
    onDone: (outcome: FireOutcome, detail: string) => void
): void {
    const keyVar = apiKeyInEnv();
    if (keyVar) {
        const msg = `${keyVar} is set, so \`claude -p\` would bill API credit instead of the subscription window`;
        log(`[primer] refusing to fire — ${msg}`);
        onDone('api-key-present', msg);
        return;
    }
    sweepStaleLocks();

    log(`[primer] firing \`claude -p\` in ${PRIMER_DIR} to open the new block`);
    const child = cp.exec(
        `claude -p "${PRIMER_PROMPT}"`,
        { cwd: PRIMER_DIR, windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
            if (err) {
                const msg = `${err.message}${stderr?.trim() ? ` — ${stderr.trim()}` : ''}`;
                log(`[primer] failed: ${msg}`);
                onDone('exec-failed', msg);
                return;
            }
            // Exit 0 only means the CLI ran — NOT that a subscription block opened.
            const reply = (stdout || '').trim().slice(0, 80);
            log(`[primer] claude -p exited 0, replied: ${reply}`);
            onDone('fired', `claude -p exited 0, replied: ${reply}`);
        }
    );
    // The CLI waits 3s for piped stdin before giving up. Close it so the primer fires at once.
    child.stdin?.end();
}

// ---------------------------------------------------------------------------
// Codex counterpart — same idea, two differences that matter:
//
//   1. `--ephemeral` keeps the run out of the sessions directory entirely, so no dummy rollout
//      can ever reach the status bar. The Claude side has to filter on PRIMER_MARK instead
//      because `claude -p` always writes a session log.
//   2. The billing check reads auth.json rather than the environment. Codex records
//      `auth_mode: "chatgpt"` when signed in with a plan; an API-key login spends real credit
//      while still exiting 0, which would look exactly like success.
// ---------------------------------------------------------------------------

export const CODEX_PRIMER_MARK = 'claudeStateBar-codex-primer';
export const CODEX_PRIMER_DIR = path.join(os.tmpdir(), CODEX_PRIMER_MARK);

// `auth_mode` as written by a ChatGPT-plan login (verified against a live auth.json).
const CODEX_PLAN_AUTH_MODE = 'chatgpt';

export function defaultCodexHome(): string {
    return (process.env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');
}

// Returns null when the plan login is confirmed, otherwise why firing is unsafe.
//
// `kind` separates the two very different reasons for not firing:
//   'hazard'     — the login really would bill API credit. Confirmed from a file we could read.
//   'unreadable' — we could not tell either way. Still a reason not to fire (never guess about
//                  spending money), but NOT grounds to disable auto-start: the file may simply
//                  belong to another host, or Codex may not be installed here yet.
export type CodexBillingBlock = { kind: 'hazard' | 'unreadable'; reason: string };

export function codexBillingHazard(codexHome: string): CodexBillingBlock | null {
    if ((process.env.OPENAI_API_KEY || '').trim()) {
        return { kind: 'hazard', reason: 'OPENAI_API_KEY is set in the environment' };
    }
    const authPath = path.join(codexHome, 'auth.json');
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code ?? e;
        return { kind: 'unreadable', reason: `could not read ${authPath} (${code})` };
    }
    if (typeof parsed?.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim()) {
        return { kind: 'hazard', reason: 'auth.json carries an OPENAI_API_KEY' };
    }
    if (parsed?.auth_mode !== CODEX_PLAN_AUTH_MODE) {
        return {
            kind: 'hazard',
            reason: `auth.json auth_mode is ${JSON.stringify(parsed?.auth_mode)}, not "${CODEX_PLAN_AUTH_MODE}"`
        };
    }
    return null;
}

// Fire the Codex primer. As with firePrimer(), the caller owns the "should we fire" decision —
// it must already have confirmed the window is closed and claimed the reset event.
//
// 🔴 Takes NO home argument, deliberately — same shape as firePrimer(). It used to accept one,
// and a Remote-SSH window passed in the server's `/root/.codex` on 2026-08-26: the local read
// failed, was misread as a billing hazard, and auto-start stayed off for four and a half hours.
// The primer is a local process spending the local login's window, so the home is never anyone
// else's business to choose.
export function fireCodexPrimer(
    log: Logger,
    onDone: (outcome: FireOutcome, detail: string) => void
): void {
    const codexHome = defaultCodexHome();
    const block = codexBillingHazard(codexHome);
    if (block) {
        log(`[codex-primer] refusing to fire — ${block.reason}`);
        onDone(block.kind === 'hazard' ? 'api-key-present' : 'auth-unreadable', block.reason);
        return;
    }
    sweepStaleLocks();

    try { fs.mkdirSync(CODEX_PRIMER_DIR, { recursive: true }); } catch { /* exec reports it */ }

    // --skip-git-repo-check: the temp dir is deliberately not a repo.
    // --ephemeral: no session file, so nothing to filter out of the status bar later.
    // -s read-only: the prompt asks for no work, so deny writes outright.
    const cmd = `codex exec --skip-git-repo-check --ephemeral -s read-only `
        + `-C "${CODEX_PRIMER_DIR}" "${PRIMER_PROMPT}"`;
    log(`[codex-primer] firing \`codex exec\` in ${CODEX_PRIMER_DIR} to open the new block`);
    const child = cp.exec(
        cmd,
        {
            cwd: CODEX_PRIMER_DIR,
            env: { ...process.env, CODEX_HOME: codexHome },
            windowsHide: true,
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        },
        (err, stdout, stderr) => {
            if (err) {
                const msg = `${err.message}${stderr?.trim() ? ` — ${stderr.trim()}` : ''}`;
                log(`[codex-primer] failed: ${msg}`);
                onDone('exec-failed', msg);
                return;
            }
            // Exit 0 only means the CLI ran — the caller still verifies against resetsAt.
            const reply = (stdout || '').trim().slice(-80);
            log(`[codex-primer] codex exec exited 0, tail: ${reply}`);
            onDone('fired', `codex exec exited 0, tail: ${reply}`);
        }
    );
    child.stdin?.end();
}
