// Discovers codex_rescue runs by watching `<workspace>/docs/codex_rescue/.log/` and
// incrementally tailing each run's live event mirror.
//
// Why this directory exists at all: send.sh used to write `--json` events only into a
// randomly-named temp dir outside the workspace and copy them in *after* the run finished,
// so nothing was observable while Codex worked. It now mirrors the stream here live
// (2026-08-19). See `~/.claude/skills/codex_rescue/send.sh`.
//
// 🔴 These files are non-authoritative UI telemetry. `.log/` sits inside Codex's own
// workspace-write sandbox, so Codex could delete or alter them. Never use them as an audit
// or concurrency source of truth — send.sh keeps its real audit baseline outside the
// workspace on purpose.

import * as fs from 'fs';
import * as path from 'path';
import { CodexRunState, createRunState, feedExecLine } from './execEvents';

/** Mirrors `.log/<stamp>_status.json` written by send.sh. */
export interface RunStatus {
    schema?: number;
    stamp?: string;
    slug?: string;
    mode?: string;
    kind?: string;
    scope?: string;
    state?: 'running' | 'finalizing' | 'done' | 'failed' | 'interrupted' | string;
    started_at?: string;
    finished_at?: string | null;
    codex_exit?: number | null;
    tee_exit?: number | null;
}

/** What the panel renders: one codex_rescue invocation. */
export type RunPhase = 'starting' | 'running' | 'finalizing' | 'done' | 'failed' | 'stopped' | 'stale';

export interface CodexRun {
    stamp: string;
    slug: string;
    mode: string;
    scope?: string;
    phase: RunPhase;
    startedAtMs?: number;
    endedAtMs?: number;
    events: CodexRunState;
    /** Absolute path to the request doc, when the naming convention implies one. */
    requestPath?: string;
    /** Absolute path to the response/review doc, when it exists on disk. */
    resultPath?: string;
    /** Diagnostic surface for a run whose heartbeat went cold. */
    staleForMs?: number;
}

// ---------------------------------------------------------------------------
// Incremental tail state — one per events file.
// ---------------------------------------------------------------------------

interface TailState {
    offset: number;
    lastSize: number;
    /**
     * Bytes after the last newline. Kept as a Buffer, NOT a string: a multi-byte UTF-8
     * character can straddle a read boundary, and decoding the fragment eagerly would
     * corrupt it into replacement chars before the rest of the character ever arrives.
     */
    carry: Buffer;
    state: CodexRunState;
}

const tails = new Map<string, TailState>();

/** Heartbeat older than this ⇒ the run is reported stale rather than promoted to done.
 *  send.sh refreshes it every 5s, so this is the 6× margin — generous because long model
 *  reasoning legitimately emits nothing for a while. */
const STALE_AFTER_MS = 30_000;

/** Guard against replaying an unbounded delta after a long VS Code sleep. */
const MAX_INCREMENTAL = 8 * 1024 * 1024;

function readRange(filePath: string, start: number, end: number): Buffer | null {
    const length = end - start;
    if (length <= 0) return Buffer.alloc(0);
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, start);
        return buf.subarray(0, read);
    } catch {
        return null;   // mid-rename / AV lock / permission blip — retry next poll
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
}

/**
 * Split a buffer on newlines, returning decoded complete lines plus the trailing
 * fragment as raw bytes. The fragment is held back because the writer may be mid-write.
 */
function splitBuffer(buf: Buffer): { lines: string[]; carry: Buffer } {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
            lines.push(buf.subarray(start, i).toString('utf8'));
            start = i + 1;
        }
    }
    return { lines, carry: buf.subarray(start) };
}

/** Tail one events file, reusing prior parse state when it only grew. */
function tailEvents(filePath: string, nowMs: number): CodexRunState {
    let size = 0;
    try {
        size = fs.statSync(filePath).size;
    } catch {
        tails.delete(filePath);
        return createRunState();
    }

    const prev = tails.get(filePath);

    // Shrank or was replaced (send.sh does an atomic rename when the authoritative copy
    // differs) → our offsets are meaningless. Rebuild from scratch.
    if (prev && size < prev.lastSize) tails.delete(filePath);

    const cur = tails.get(filePath);
    if (cur) {
        if (size === cur.lastSize) return cur.state;      // nothing appended
        if (size - cur.offset <= MAX_INCREMENTAL) {
            const chunk = readRange(filePath, cur.offset, size);
            if (chunk === null) return cur.state;          // transient failure: keep last view
            const combined = cur.carry.length ? Buffer.concat([cur.carry, chunk]) : chunk;
            const { lines, carry } = splitBuffer(combined);
            for (const line of lines) feedExecLine(cur.state, line, nowMs);
            cur.carry = carry;
            cur.offset = size;
            cur.lastSize = size;
            return cur.state;
        }
        tails.delete(filePath);
    }

    // Cold start / rebuild.
    const whole = readRange(filePath, 0, size);
    if (whole === null) return createRunState();
    const state = createRunState();
    const { lines, carry } = splitBuffer(whole);
    for (const line of lines) feedExecLine(state, line, nowMs);
    tails.set(filePath, { offset: size, lastSize: size, carry, state });
    return state;
}

function readStatus(filePath: string): RunStatus | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o as RunStatus : null;
    } catch {
        return null;   // absent, or caught mid-rename — treated as "unknown", never fatal
    }
}

function mtimeMs(filePath: string): number | undefined {
    try { return fs.statSync(filePath).mtimeMs; } catch { return undefined; }
}

/**
 * Decide the run's display phase.
 *
 * The ordering matters and encodes two findings from the 0.145.0 investigation:
 *   1. `turn.completed` means "Codex's turn succeeded", NOT "the run is over" — send.sh
 *      still has change detection, response recovery and log preservation to do. Treating
 *      it as done would flash a premature "finished" for that whole window.
 *   2. An interrupted turn emits NO terminal JSON event at all, so liveness cannot be
 *      inferred from the stream. That is what the heartbeat file is for.
 */
function decidePhase(status: RunStatus | null, events: CodexRunState, heartbeatMs: number | undefined, nowMs: number)
    : { phase: RunPhase; staleForMs?: number } {

    const state = status?.state;

    // send.sh reached its end and recorded a verdict — that is authoritative.
    if (state === 'done') return { phase: 'done' };
    if (state === 'failed') return { phase: 'failed' };
    if (state === 'interrupted') return { phase: 'stopped' };

    // Legacy run: written by a send.sh predating the telemetry sidecars, so there is
    // neither a status file nor a heartbeat. Absence of BOTH means there is no evidence of
    // life at all — a currently-running invocation would have created both before spawning
    // Codex. So resolve it from the event stream and never leave it spinning.
    if (!status && heartbeatMs === undefined) {
        if (events.terminal === 'completed') return { phase: 'done' };
        if (events.terminal === 'failed') return { phase: 'failed' };
        return { phase: 'stopped' };   // ended without a terminal event ⇒ it was interrupted
    }

    // Still claiming to run: cross-check liveness against the heartbeat.
    //
    // A live `state` with NO heartbeat file cannot happen legitimately — send.sh creates the
    // heartbeat *before* writing the status, precisely so this combination is unambiguous.
    // Seeing it means the file was removed or never made it to disk. Treat it as stale
    // rather than leaving the run spinning forever with no evidence either way.
    if (heartbeatMs === undefined) return { phase: 'stale' };

    const age = nowMs - heartbeatMs;
    if (age > STALE_AFTER_MS) {
        return { phase: 'stale', staleForMs: age };
    }

    if (state === 'finalizing') return { phase: 'finalizing' };
    if (events.terminal !== 'none') return { phase: 'finalizing' };
    if (!events.turnStarted && !events.items.length) return { phase: 'starting' };
    return { phase: 'running' };
}

function parseIso(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : undefined;
}

/** `260819_140840` → epoch ms. Fallback when status.json is missing or unreadable. */
function parseStamp(stamp: string): number | undefined {
    const m = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
    if (!m) return undefined;
    const [, yy, mo, dd, hh, mi, ss] = m;
    const d = new Date(2000 + +yy, +mo - 1, +dd, +hh, +mi, +ss);
    const t = d.getTime();
    return Number.isFinite(t) ? t : undefined;
}

/** The `.log` directory for a workspace folder, or null when this project doesn't use the skill. */
export function codexRescueLogDir(workspaceFsPath: string): string | null {
    const dir = path.join(workspaceFsPath, 'docs', 'codex_rescue');
    try {
        return fs.statSync(dir).isDirectory() ? path.join(dir, '.log') : null;
    } catch {
        return null;
    }
}

/**
 * Scan one workspace folder for codex_rescue runs, newest first.
 * Returns [] when the project doesn't use the skill — which is how the whole feature
 * stays invisible to ordinary users of this extension.
 */
export function discoverRuns(workspaceFsPath: string, nowMs: number, limit = 20): CodexRun[] {
    const logDir = codexRescueLogDir(workspaceFsPath);
    if (!logDir) return [];

    let names: string[];
    try {
        names = fs.readdirSync(logDir);
    } catch {
        return [];   // .log/ not created yet — no run has ever started here
    }

    const docsDir = path.join(workspaceFsPath, 'docs', 'codex_rescue');
    const stamps = names
        .map(n => /^(\d{6}_\d{6})_events\.jsonl$/.exec(n)?.[1])
        .filter((s): s is string => !!s)
        .sort()
        .reverse()
        .slice(0, limit);

    // Sibling docs, used to recover the slug for runs whose status file is absent (either a
    // legacy run, or one whose sidecar was lost). The naming convention is enforced by
    // send.sh — `<stamp>_{request,response,review}_<slug>.md` — so this is a read of the
    // contract, not a guess.
    let docNames: string[] = [];
    try { docNames = fs.readdirSync(docsDir); } catch { /* docs dir unreadable — skip */ }

    const runs: CodexRun[] = [];
    for (const stamp of stamps) {
        const eventsPath = path.join(logDir, `${stamp}_events.jsonl`);
        const status = readStatus(path.join(logDir, `${stamp}_status.json`));
        const hb = mtimeMs(path.join(logDir, `${stamp}_heartbeat`));
        const events = tailEvents(eventsPath, nowMs);
        const { phase, staleForMs } = decidePhase(status, events, hb, nowMs);

        // End time: prefer the sidecar, fall back to the event file's last-write time.
        // Without the fallback a finished run reports no end at all and the panel's clock
        // keeps counting up forever next to a "done" badge — which reads as "still running".
        // Legacy runs (written before the sidecar existed) always hit this path.
        let endedAtMs = parseIso(status?.finished_at ?? undefined);
        if (endedAtMs === undefined && isTerminalPhase(phase)) {
            endedAtMs = mtimeMs(eventsPath);
        }

        let slug = status?.slug || '';
        if (!slug) {
            const re = new RegExp(`^${stamp}_(?:request|response|review)_(.+)\\.md$`);
            for (const n of docNames) {
                const m = re.exec(n);
                if (m) { slug = m[1]; break; }
            }
        }
        if (!slug) slug = '(unknown)';
        const isReview = (status?.kind === 'review') || status?.mode === 'review';
        // Probe both names: a legacy run has no status file, so `isReview` is only a hint.
        // REVIEW produces `_review_`, CONSULT/EDIT produce `_response_`; try the likely one first.
        const candidates = isReview
            ? [`${stamp}_review_${slug}.md`, `${stamp}_response_${slug}.md`]
            : [`${stamp}_response_${slug}.md`, `${stamp}_review_${slug}.md`];
        let resultPath: string | undefined;
        for (const name of candidates) {
            const p = path.join(docsDir, name);
            if (fs.existsSync(p)) { resultPath = p; break; }
        }
        const requestPath = path.join(docsDir, `${stamp}_request_${slug}.md`);

        runs.push({
            stamp,
            slug,
            mode: status?.mode || 'readonly',
            scope: status?.scope,
            phase,
            staleForMs,
            startedAtMs: parseIso(status?.started_at) ?? parseStamp(stamp),
            endedAtMs,
            events,
            requestPath: fs.existsSync(requestPath) ? requestPath : undefined,
            resultPath,
        });
    }
    return runs;
}

/** Drop cached tail state for files that no longer exist (deleted logs, closed folders). */
export function pruneTailCache(keepPaths: Set<string>): void {
    for (const key of Array.from(tails.keys())) {
        if (!keepPaths.has(key)) tails.delete(key);
    }
}

/** True once a run has reached a terminal phase — the edge the completion chime fires on. */
export function isTerminalPhase(p: RunPhase): boolean {
    return p === 'done' || p === 'failed' || p === 'stopped';
}

// ---------------------------------------------------------------------------
// Cleanup
//
// Two rules govern everything below, because this deletes files:
//   1. A run that is not in a terminal phase is NEVER touched, and neither is one whose
//      lock file still exists — the lock is send.sh's "I am running" marker.
//   2. The raw logs under .log/ are disposable; the request/response/review .md documents
//      are the actual record of what was asked and answered, so they are only removed when
//      the user explicitly opts in.
// ---------------------------------------------------------------------------

export interface CleanupOptions {
    /** Delete runs older than this. 0 or less disables age-based cleanup entirely. */
    retentionDays: number;
    /** Also delete the request/response/review .md documents. */
    deleteDocs: boolean;
}

export interface CleanupResult {
    removedRuns: number;
    removedFiles: number;
    freedBytes: number;
    /** Stamps skipped because the run was still live or locked. */
    skippedLive: number;
}

function unlinkCounting(p: string, res: CleanupResult): void {
    try {
        const size = fs.statSync(p).size;
        fs.unlinkSync(p);
        res.removedFiles++;
        res.freedBytes += size;
    } catch {
        /* already gone, locked by AV, or permission — never fatal */
    }
}

/**
 * Delete one run's files. Returns false without touching anything when the run still holds
 * a lock (i.e. send.sh may still be writing).
 */
export function deleteRun(workspaceFsPath: string, stamp: string, slug: string, deleteDocs: boolean,
                          res: CleanupResult): boolean {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return false;   // never accept a stamp we didn't parse ourselves
    const logDir = codexRescueLogDir(workspaceFsPath);
    if (!logDir) return false;

    // The lock is send.sh's liveness marker; its presence means a run may be mid-write.
    if (fs.existsSync(path.join(logDir, `.${stamp}.lock`))) { res.skippedLive++; return false; }

    for (const name of [`${stamp}_events.jsonl`, `${stamp}_status.json`, `${stamp}_stderr.log`,
                        `${stamp}_last_message.md`, `${stamp}_heartbeat`]) {
        const p = path.join(logDir, name);
        if (fs.existsSync(p)) unlinkCounting(p, res);
    }

    if (deleteDocs && slug && slug !== '(unknown)') {
        const docsDir = path.join(workspaceFsPath, 'docs', 'codex_rescue');
        for (const kind of ['request', 'response', 'review']) {
            const p = path.join(docsDir, `${stamp}_${kind}_${slug}.md`);
            if (fs.existsSync(p)) unlinkCounting(p, res);
        }
    }

    tails.delete(path.join(logDir, `${stamp}_events.jsonl`));
    res.removedRuns++;
    return true;
}

/**
 * Remove finished runs older than `retentionDays`. Live, locked and too-recent runs are left
 * alone. Returns what was actually removed so the caller can log or report it.
 */
export function cleanupOldRuns(workspaceFsPath: string, opts: CleanupOptions, nowMs: number): CleanupResult {
    const res: CleanupResult = { removedRuns: 0, removedFiles: 0, freedBytes: 0, skippedLive: 0 };
    if (!opts.retentionDays || opts.retentionDays <= 0) return res;
    if (!codexRescueLogDir(workspaceFsPath)) return res;

    const cutoff = nowMs - opts.retentionDays * 24 * 60 * 60 * 1000;
    // Scan without a cap: cleanup must be able to reach runs far past the display limit,
    // which is exactly where the accumulation everyone worries about lives.
    for (const run of discoverRuns(workspaceFsPath, nowMs, Number.MAX_SAFE_INTEGER)) {
        if (!isTerminalPhase(run.phase)) { res.skippedLive++; continue; }
        const when = run.endedAtMs ?? run.startedAtMs;
        if (when === undefined || when > cutoff) continue;
        deleteRun(workspaceFsPath, run.stamp, run.slug, opts.deleteDocs, res);
    }
    return res;
}
