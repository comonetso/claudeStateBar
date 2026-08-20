// Discovers codex_rescue runs by watching `<workspace>/docs/codex_rescue/.log/` and
// incrementally parsing each run's live event mirror.
//
// Why this directory exists at all: send.sh used to write `--json` events only into a
// randomly-named temp dir outside the workspace and copy them in *after* the run finished,
// so nothing was observable while Codex worked. It now mirrors the stream here live
// (2026-08-19). See `~/.claude/skills/codex_rescue/send.sh`.
//
// 🔴 Everything here goes through `vscode.workspace.fs`, never node `fs`. This extension is
// extensionKind "ui", so it always runs on the local host — over Remote-SSH the workspace
// files live on the remote machine and node `fs` cannot see them at all. VS Code routes
// `workspace.fs` across the SSH connection, which is what makes the panel work in a remote
// window (2026-08-19; the whole feature was silently empty there before). Paths are built
// with `Uri.joinPath`, never `path.join` on `fsPath`: a remote folder's `fsPath` comes back
// with Windows backslashes on a Windows host and would not survive the round trip.
//
// 🔴 These files are non-authoritative UI telemetry. `.log/` sits inside Codex's own
// workspace-write sandbox, so Codex could delete or alter them. Never use them as an audit
// or concurrency source of truth — send.sh keeps its real audit baseline outside the
// workspace on purpose.

import * as vscode from 'vscode';
import { CodexRunState, createRunState, feedExecLine } from './execEvents';

/** Mirrors `.log/<stamp>_status.json` written by send.sh. */
export interface RunStatus {
    schema?: number;
    stamp?: string;
    slug?: string;
    /** Human-readable one-liner from the request's frontmatter. Absent on older runs. */
    subject?: string;
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
    /**
     * What the run is about, in the user's own words, carried in the status sidecar. The slug
     * is an English kebab filename fragment and reads as a symbol, not a sentence. Absent on
     * runs written before send.sh recorded it — the panel falls back to the slug.
     */
    subject?: string;
    mode: string;
    scope?: string;
    phase: RunPhase;
    startedAtMs?: number;
    endedAtMs?: number;
    events: CodexRunState;
    /** URI *string* of the request doc, when the naming convention implies one. */
    requestUri?: string;
    /** URI *string* of the response/review doc, when it exists on disk. */
    resultUri?: string;
    /** Diagnostic surface for a run whose heartbeat went cold. */
    staleForMs?: number;
    /**
     * The run has documents but no event log — its raw records were deleted for good, or the
     * documents were committed by someone else and pulled in. There is no activity to show,
     * but the documents are the part worth keeping, so the card exists to reach them.
     */
    docsOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Incremental parse state — one per events file.
//
// `workspace.fs` has no range read, so unlike the old node-`fs` version this cannot fetch
// just the delta: every refresh transfers the whole file. Parsing stays incremental (only
// the bytes past `parsed` are fed to the parser), which is what actually costs CPU, but the
// transfer does not — hence the remote throttle below.
// ---------------------------------------------------------------------------

interface TailState {
    /** Bytes already handed to the parser. */
    parsed: number;
    /** File size at the last successful read, to detect growth and truncation. */
    lastSize: number;
    /**
     * Bytes after the last newline. Kept as a Buffer, NOT a string: a multi-byte UTF-8
     * character can straddle a read boundary, and decoding the fragment eagerly would
     * corrupt it into replacement chars before the rest of the character ever arrives.
     */
    carry: Buffer;
    state: CodexRunState;
    /** When the body was last actually transferred, for the remote throttle. */
    lastBodyReadMs: number;
}

const tails = new Map<string, TailState>();

/**
 * Runs that reached a terminal phase, keyed the same way as `tails`. Re-reading a few hundred
 * KB of `events.jsonl` every 2s — 20 times over, across SSH — would be pure waste, so a
 * finished run is frozen here. Entries are dropped by `pruneTailCache` when the files
 * disappear.
 *
 * "Finished" is not forever, though: `codex_rescue` reuses a stamp when it re-runs a request
 * that died, which rewrites `events.jsonl` under a key already in this map. So the snapshot
 * of the file is kept alongside the run and re-checked on every hit — without it, a stamp
 * that once went terminal would keep reporting the dead attempt until the window reloaded,
 * even after the retry finished successfully.
 */
interface SettledEntry {
    run: CodexRun;
    /** `events.jsonl` as it stood when the run was frozen. */
    size: number;
    mtime: number;
}
const settled = new Map<string, SettledEntry>();

/** Heartbeat older than this ⇒ the run is reported stale rather than promoted to done.
 *  send.sh refreshes it every 5s, so this is the 6× margin — generous because long model
 *  reasoning legitimately emits nothing for a while. */
const STALE_AFTER_MS = 30_000;

/**
 * Minimum gap between two body transfers of the same live run on a REMOTE workspace.
 *
 * The panel polls every 2s while a run is live. Locally that is free; over SSH each poll
 * would ship the entire events file, and real runs measured 394KB–750KB — roughly 12–22MB
 * per minute for one run. Status and heartbeat are still checked every 2s (a few hundred
 * bytes), so completion detection, the chime and the elapsed clock stay exactly as
 * responsive as before; only the activity list lags by up to this interval.
 *
 * 5s is the user's call (2026-08-19), not a derived number.
 */
const REMOTE_BODY_MIN_INTERVAL_MS = 5_000;

function keyOf(uri: vscode.Uri): string {
    return uri.toString();
}

function isRemote(uri: vscode.Uri): boolean {
    return uri.scheme !== 'file';
}

async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | null> {
    try {
        return await vscode.workspace.fs.stat(uri);
    } catch {
        return null;   // absent, mid-rename, or a permission blip — never fatal
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

/**
 * Bring one events file's parse state up to date, reusing prior state when it only grew.
 * `size` comes from a stat the caller already had to make, so this costs one transfer at most.
 */
async function tailEvents(uri: vscode.Uri, size: number, nowMs: number): Promise<CodexRunState> {
    const key = keyOf(uri);
    const prev = tails.get(key);

    // Shrank or was replaced (send.sh does an atomic rename when the authoritative copy
    // differs) → our offsets are meaningless. Rebuild from scratch.
    if (prev && size < prev.lastSize) tails.delete(key);

    const cur = tails.get(key);
    if (cur) {
        if (size === cur.lastSize) return cur.state;      // nothing appended — no transfer
        if (isRemote(uri) && nowMs - cur.lastBodyReadMs < REMOTE_BODY_MIN_INTERVAL_MS) {
            return cur.state;                            // throttled; status/heartbeat still fresh
        }
    }

    let data: Uint8Array;
    try {
        data = await vscode.workspace.fs.readFile(uri);
    } catch {
        return cur ? cur.state : createRunState();       // transient failure: keep the last view
    }
    const buf = Buffer.from(data);

    // Read the file whole, but only parse what the parser has not seen. The size that
    // matters is what actually arrived, not what stat reported — a live run grows between
    // the two calls.
    if (cur && buf.length >= cur.parsed) {
        const chunk = buf.subarray(cur.parsed);
        const combined = cur.carry.length ? Buffer.concat([cur.carry, chunk]) : chunk;
        const { lines, carry } = splitBuffer(combined);
        for (const line of lines) feedExecLine(cur.state, line, nowMs);
        cur.carry = carry;
        cur.parsed = buf.length;
        cur.lastSize = buf.length;
        cur.lastBodyReadMs = nowMs;
        return cur.state;
    }

    // Cold start / rebuild.
    const state = createRunState();
    const { lines, carry } = splitBuffer(buf);
    for (const line of lines) feedExecLine(state, line, nowMs);
    tails.set(key, { parsed: buf.length, lastSize: buf.length, carry, state, lastBodyReadMs: nowMs });
    return state;
}

async function readStatus(uri: vscode.Uri): Promise<RunStatus | null> {
    try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o as RunStatus : null;
    } catch {
        return null;   // absent, or caught mid-rename — treated as "unknown", never fatal
    }
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

/** `<folder>/docs/codex_rescue`, or null when this project doesn't use the skill. */
export async function codexRescueDocsDir(folderUri: vscode.Uri): Promise<vscode.Uri | null> {
    const dir = vscode.Uri.joinPath(folderUri, 'docs', 'codex_rescue');
    const st = await statOf(dir);
    return st && (st.type & vscode.FileType.Directory) ? dir : null;
}

/** The `.log` directory for a workspace folder, or null when this project doesn't use the skill. */
export async function codexRescueLogDir(folderUri: vscode.Uri): Promise<vscode.Uri | null> {
    const docs = await codexRescueDocsDir(folderUri);
    return docs ? vscode.Uri.joinPath(docs, '.log') : null;
}

async function listNames(dir: vscode.Uri): Promise<string[] | null> {
    try {
        return (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
    } catch {
        return null;
    }
}

export interface DiscoverOptions {
    /**
     * Skip transferring `events.jsonl` bodies. Cleanup only needs each run's phase and
     * timestamps, and a legacy run (no status sidecar) is *always* terminal regardless of
     * what the stream says, so the verdict cleanup acts on is unchanged — but scanning
     * every run ever recorded without this would drag megabytes across SSH.
     */
    skipEventBodies?: boolean;
}

/**
 * Scan one workspace folder for codex_rescue runs, newest first.
 * Returns [] when the project doesn't use the skill — which is how the whole feature
 * stays invisible to ordinary users of this extension.
 */
export async function discoverRuns(folderUri: vscode.Uri, nowMs: number, limit = 20,
                                   opts: DiscoverOptions = {}): Promise<CodexRun[]> {
    const docsDir = await codexRescueDocsDir(folderUri);
    if (!docsDir) return [];
    const logDir = vscode.Uri.joinPath(docsDir, '.log');

    const logNames = (await listNames(logDir)) ?? [];
    const present = new Set(logNames);

    // Sibling docs, used to recover the slug for runs whose status file is absent (either a
    // legacy run, or one whose sidecar was lost) and to resolve the result document without
    // a stat per candidate. The naming convention is enforced by send.sh —
    // `<stamp>_{request,response,review}_<slug>.md` — so this is a read of the contract.
    const docNames = (await listNames(docsDir)) ?? [];
    const docSet = new Set(docNames);
    if (!logNames.length && !docNames.length) return [];

    const eventStamps = new Set(
        logNames.map(n => /^(\d{6}_\d{6})_events\.jsonl$/.exec(n)?.[1])
                .filter((s): s is string => !!s));

    // Documents with no event log behind them. That happens when the raw records were purged
    // from the trash while the documents were kept, and when a teammate's committed documents
    // arrive through git. Listing only what has a log would make those invisible — including,
    // confusingly, a document you just restored yourself.
    const docOnlyStamps = new Map<string, string>();
    for (const n of docNames) {
        const m = /^(\d{6}_\d{6})_(?:request|response|review)_(.+)\.md$/.exec(n);
        if (!m || eventStamps.has(m[1]) || docOnlyStamps.has(m[1])) continue;
        docOnlyStamps.set(m[1], m[2]);
    }

    const stamps = Array.from(new Set([...eventStamps, ...docOnlyStamps.keys()]))
        .sort()
        .reverse()
        .slice(0, limit);

    const runs: CodexRun[] = [];
    for (const stamp of stamps) {
        const docSlug = docOnlyStamps.get(stamp);
        if (docSlug !== undefined) {
            const pick = async (names: string[]): Promise<string | undefined> => {
                for (const name of names) {
                    if (docSet.has(name)) return vscode.Uri.joinPath(docsDir, name).toString();
                }
                return undefined;
            };
            const resultName = [`${stamp}_response_${docSlug}.md`, `${stamp}_review_${docSlug}.md`]
                .find(n => docSet.has(n));
            // The document's own mtime is the only end time available here, and without one the
            // card's clock would count up forever beside a finished badge.
            const endedAtMs = resultName
                ? (await statOf(vscode.Uri.joinPath(docsDir, resultName)))?.mtime
                : undefined;
            runs.push({
                stamp,
                slug: docSlug,
                // Unknown, and not guessable: the mode lived in the status sidecar, which went
                // with the logs. Claiming 'readonly' would mislabel what may have been an edit.
                mode: '',
                phase: 'done',
                docsOnly: true,
                startedAtMs: parseStamp(stamp),
                endedAtMs,
                events: createRunState(),
                requestUri: await pick([`${stamp}_request_${docSlug}.md`]),
                resultUri: resultName ? vscode.Uri.joinPath(docsDir, resultName).toString() : undefined,
            });
            continue;
        }
        const eventsUri = vscode.Uri.joinPath(logDir, `${stamp}_events.jsonl`);
        const cacheKey = keyOf(eventsUri);

        // One stat, reused: it decides whether a frozen run is still valid, and failing that
        // it is the size the tail parser needs anyway.
        const eventsStat = await statOf(eventsUri);

        const cached = settled.get(cacheKey);
        if (cached) {
            if (eventsStat && eventsStat.size === cached.size && eventsStat.mtime === cached.mtime) {
                runs.push(cached.run);
                continue;
            }
            // The file moved under a stamp we had already written off — a re-run. Drop the
            // frozen verdict and the parser offset with it; the new stream starts at 0.
            settled.delete(cacheKey);
            tails.delete(cacheKey);
        }

        // Status first: when it already carries a terminal verdict there is no reason to
        // stat the heartbeat at all.
        const status = present.has(`${stamp}_status.json`)
            ? await readStatus(vscode.Uri.joinPath(logDir, `${stamp}_status.json`))
            : null;
        const terminalStatus = status?.state === 'done' || status?.state === 'failed'
            || status?.state === 'interrupted';

        let heartbeatMs: number | undefined;
        if (!terminalStatus && present.has(`${stamp}_heartbeat`)) {
            const st = await statOf(vscode.Uri.joinPath(logDir, `${stamp}_heartbeat`));
            heartbeatMs = st?.mtime;
        }

        const events = (opts.skipEventBodies || !eventsStat)
            ? (tails.get(cacheKey)?.state ?? createRunState())
            : await tailEvents(eventsUri, eventsStat.size, nowMs);

        const { phase, staleForMs } = decidePhase(status, events, heartbeatMs, nowMs);

        // End time: prefer the sidecar, fall back to the event file's last-write time.
        // Without the fallback a finished run reports no end at all and the panel's clock
        // keeps counting up forever next to a "done" badge — which reads as "still running".
        // Legacy runs (written before the sidecar existed) always hit this path.
        let endedAtMs = parseIso(status?.finished_at ?? undefined);
        if (endedAtMs === undefined && isTerminalPhase(phase)) {
            endedAtMs = eventsStat?.mtime;
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
        let resultUri: string | undefined;
        for (const name of candidates) {
            if (docSet.has(name)) { resultUri = vscode.Uri.joinPath(docsDir, name).toString(); break; }
        }
        const requestName = `${stamp}_request_${slug}.md`;

        const run: CodexRun = {
            stamp,
            slug,
            subject: status?.subject?.trim() || undefined,
            mode: status?.mode || 'readonly',
            scope: status?.scope,
            phase,
            staleForMs,
            startedAtMs: parseIso(status?.started_at) ?? parseStamp(stamp),
            endedAtMs,
            events,
            requestUri: docSet.has(requestName)
                ? vscode.Uri.joinPath(docsDir, requestName).toString() : undefined,
            resultUri,
        };

        // Freeze finished runs so the next poll costs nothing. Only when the bodies were
        // actually read — a cleanup scan must never poison the cache with empty streams —
        // and only with a snapshot to check it against, since a stamp can be re-run.
        if (!opts.skipEventBodies && isTerminalPhase(phase) && eventsStat) {
            settled.set(cacheKey, { run, size: eventsStat.size, mtime: eventsStat.mtime });
        }

        runs.push(run);
    }
    return runs;
}

/** Drop cached state for files that no longer exist (deleted logs, closed folders). */
export function pruneTailCache(keepKeys: Set<string>): void {
    for (const key of Array.from(tails.keys())) {
        if (!keepKeys.has(key)) tails.delete(key);
    }
    for (const key of Array.from(settled.keys())) {
        if (!keepKeys.has(key)) settled.delete(key);
    }
}

/** Cache key for a run, so callers can build the keep-set for `pruneTailCache`. */
export function runCacheKey(logDir: vscode.Uri, stamp: string): string {
    return keyOf(vscode.Uri.joinPath(logDir, `${stamp}_events.jsonl`));
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

async function unlinkCounting(uri: vscode.Uri, res: CleanupResult): Promise<void> {
    const st = await statOf(uri);
    if (!st) return;
    try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
        res.removedFiles++;
        res.freedBytes += st.size;
    } catch {
        /* already gone, locked by AV, or permission — never fatal */
    }
}

/**
 * Delete one run's files. Returns false without touching anything when the run still holds
 * a lock (i.e. send.sh may still be writing).
 */
export async function deleteRun(folderUri: vscode.Uri, stamp: string, slug: string, deleteDocs: boolean,
                                res: CleanupResult): Promise<boolean> {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return false;   // never accept a stamp we didn't parse ourselves
    const docsDir = await codexRescueDocsDir(folderUri);
    if (!docsDir) return false;
    const logDir = vscode.Uri.joinPath(docsDir, '.log');

    // The lock is send.sh's liveness marker; its presence means a run may be mid-write.
    if (await statOf(vscode.Uri.joinPath(logDir, `.${stamp}.lock`))) { res.skippedLive++; return false; }

    for (const name of [`${stamp}_events.jsonl`, `${stamp}_status.json`, `${stamp}_stderr.log`,
                        `${stamp}_last_message.md`, `${stamp}_heartbeat`]) {
        await unlinkCounting(vscode.Uri.joinPath(logDir, name), res);
    }

    if (deleteDocs && slug && slug !== '(unknown)') {
        for (const kind of ['request', 'response', 'review']) {
            await unlinkCounting(vscode.Uri.joinPath(docsDir, `${stamp}_${kind}_${slug}.md`), res);
        }
    }

    const key = runCacheKey(logDir, stamp);
    tails.delete(key);
    settled.delete(key);
    res.removedRuns++;
    return true;
}

/**
 * Remove finished runs older than `retentionDays`. Live, locked and too-recent runs are left
 * alone. Returns what was actually removed so the caller can log or report it.
 */
export async function cleanupOldRuns(folderUri: vscode.Uri, opts: CleanupOptions, nowMs: number)
    : Promise<CleanupResult> {
    const res: CleanupResult = { removedRuns: 0, removedFiles: 0, freedBytes: 0, skippedLive: 0 };
    if (!opts.retentionDays || opts.retentionDays <= 0) return res;
    if (!await codexRescueDocsDir(folderUri)) return res;

    const cutoff = nowMs - opts.retentionDays * 24 * 60 * 60 * 1000;
    // Scan without a display cap — cleanup must reach runs far past the panel's limit, which
    // is exactly where the accumulation everyone worries about lives — but without the event
    // bodies, which is what keeps that unbounded scan cheap on a remote workspace.
    const runs = await discoverRuns(folderUri, nowMs, Number.MAX_SAFE_INTEGER, { skipEventBodies: true });
    for (const run of runs) {
        if (!isTerminalPhase(run.phase)) { res.skippedLive++; continue; }
        const when = run.endedAtMs ?? run.startedAtMs;
        if (when === undefined || when > cutoff) continue;
        await deleteRun(folderUri, run.stamp, run.slug, opts.deleteDocs, res);
    }
    return res;
}

// ---------------------------------------------------------------------------
// Trash
//
// Manual deletion moves files instead of unlinking them, because the two things a run leaves
// behind have no other safety net: `.log/` is gitignored by design, and the request/response
// documents are only recoverable through git once they have actually been committed. A misclick
// on the 🗑 used to be final for both.
//
// Automatic cleanup deliberately does NOT come through here — it exists to reclaim disk, and a
// trash that fills up as fast as cleanup empties the log directory would defeat its own purpose.
//
// Files are moved with fs.rename within the same directory tree, so this stays cheap on a remote
// workspace: nothing is read into the extension host, only renamed on the far side.
// ---------------------------------------------------------------------------

/** One run sitting in the trash, as the panel shows it. */
export interface TrashedRun {
    stamp: string;
    slug: string;
    subject?: string;
    mode?: string;
    deletedAt: number;
    fileCount: number;
    bytes: number;
    /** Whether the request/response documents went in too, or only the raw logs. */
    docsIncluded: boolean;
    /** Raw `.log/` files still present. False once they've been purged on their own. */
    hasLogs: boolean;
    /** Request/response/review documents still present. */
    hasDocs: boolean;
}

/** Where a trashed file came from, so restore can put it back. */
interface TrashEntry {
    /** File name, unchanged. */
    n: string;
    /** Origin directory relative to docs/codex_rescue: '.log' or '.'. */
    d: string;
}

interface TrashMeta {
    schema: 1;
    stamp: string;
    slug: string;
    subject?: string;
    mode?: string;
    deletedAt: number;
    docsIncluded: boolean;
    entries: TrashEntry[];
}

const TRASH_DIR = '.trash';

function trashRoot(docsDir: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(docsDir, TRASH_DIR);
}

/**
 * The trash holds copies of documents that are otherwise tracked, so it must never itself become
 * something git offers to commit — same reasoning (and same mechanism) as `.log/`.
 */
async function ensureTrashDir(docsDir: vscode.Uri): Promise<vscode.Uri> {
    const root = trashRoot(docsDir);
    await vscode.workspace.fs.createDirectory(root);
    const ignore = vscode.Uri.joinPath(root, '.gitignore');
    if (!await statOf(ignore)) {
        try {
            await vscode.workspace.fs.writeFile(ignore, Buffer.from('*\n', 'utf8'));
        } catch { /* the directory still works without it */ }
    }
    return root;
}

async function readTrashMeta(dir: vscode.Uri): Promise<TrashMeta | null> {
    try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'meta.json')));
        const m = JSON.parse(raw.toString('utf8'));
        if (!m || typeof m.stamp !== 'string' || !Array.isArray(m.entries)) return null;
        return m as TrashMeta;
    } catch {
        return null;
    }
}

/**
 * Move one run's files into the trash. Same liveness rule as `deleteRun`: a run still holding
 * its lock is left alone, because send.sh may be mid-write and moving a file out from under it
 * would corrupt the record rather than preserve it.
 *
 * Returns false when nothing was moved (still locked, or no files found).
 */
export async function trashRun(folderUri: vscode.Uri, stamp: string, slug: string,
                               includeDocs: boolean, subject: string | undefined, mode: string | undefined,
                               nowMs: number): Promise<boolean> {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return false;
    const docsDir = await codexRescueDocsDir(folderUri);
    if (!docsDir) return false;
    const logDir = vscode.Uri.joinPath(docsDir, '.log');

    if (await statOf(vscode.Uri.joinPath(logDir, `.${stamp}.lock`))) return false;

    const root = await ensureTrashDir(docsDir);
    const bin = vscode.Uri.joinPath(root, stamp);
    // A run can be trashed, restored and trashed again; start from a clean bin each time so a
    // stale meta.json can never claim files that are no longer there.
    try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* absent */ }
    await vscode.workspace.fs.createDirectory(bin);

    const entries: TrashEntry[] = [];
    const move = async (src: vscode.Uri, name: string, origin: string): Promise<void> => {
        if (!await statOf(src)) return;
        try {
            await vscode.workspace.fs.rename(src, vscode.Uri.joinPath(bin, name), { overwrite: true });
            entries.push({ n: name, d: origin });
        } catch { /* locked by AV or permission — skip, never fatal */ }
    };

    for (const name of [`${stamp}_events.jsonl`, `${stamp}_status.json`, `${stamp}_stderr.log`,
                        `${stamp}_last_message.md`, `${stamp}_heartbeat`]) {
        await move(vscode.Uri.joinPath(logDir, name), name, '.log');
    }
    if (includeDocs && slug && slug !== '(unknown)') {
        for (const kind of ['request', 'response', 'review']) {
            const name = `${stamp}_${kind}_${slug}.md`;
            await move(vscode.Uri.joinPath(docsDir, name), name, '.');
        }
    }

    if (!entries.length) {
        try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* ignore */ }
        return false;
    }

    const meta: TrashMeta = {
        schema: 1, stamp, slug, subject, mode, deletedAt: nowMs,
        docsIncluded: entries.some(e => e.d === '.'), entries,
    };
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(bin, 'meta.json'),
                                        Buffer.from(JSON.stringify(meta), 'utf8'));

    const key = runCacheKey(logDir, stamp);
    tails.delete(key);
    settled.delete(key);
    return true;
}

/** Everything currently in the trash, newest deletion first. */
export async function listTrash(folderUri: vscode.Uri): Promise<TrashedRun[]> {
    const docsDir = await codexRescueDocsDir(folderUri);
    if (!docsDir) return [];
    const root = trashRoot(docsDir);
    let dirs: [string, vscode.FileType][];
    try {
        dirs = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return [];   // no trash yet
    }

    const out: TrashedRun[] = [];
    for (const [name, type] of dirs) {
        if (!(type & vscode.FileType.Directory)) continue;
        const bin = vscode.Uri.joinPath(root, name);
        const meta = await readTrashMeta(bin);
        if (!meta) continue;
        // Count what is actually on disk, not what the metadata once listed: purging the logs
        // on their own leaves the documents behind, and the row has to say so.
        let bytes = 0, fileCount = 0, hasLogs = false, hasDocs = false;
        for (const e of meta.entries) {
            const st = await statOf(vscode.Uri.joinPath(bin, e.n));
            if (!st) continue;
            bytes += st.size;
            fileCount++;
            if (e.d === '.log') hasLogs = true; else hasDocs = true;
        }
        out.push({
            stamp: meta.stamp, slug: meta.slug, subject: meta.subject, mode: meta.mode,
            deletedAt: meta.deletedAt, fileCount, bytes, docsIncluded: meta.docsIncluded,
            hasLogs, hasDocs,
        });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export interface RestoreResult {
    restored: number;
    /** Files left in the trash because something already occupies their original path. */
    conflicts: string[];
    /** Raw `.log/` files put back. Zero means the panel cannot show this run as a card again. */
    restoredLogs: number;
    /** Documents put back under docs/codex_rescue/. */
    restoredDocs: number;
}

/**
 * Put a trashed run back where it came from.
 *
 * An existing file at the destination is never overwritten. codex_rescue re-runs a dead request
 * under the SAME stamp, so the name a trashed file wants can legitimately belong to newer work —
 * silently overwriting it would destroy the very thing the user kept.
 */
export async function restoreTrashed(folderUri: vscode.Uri, stamp: string): Promise<RestoreResult> {
    const res: RestoreResult = { restored: 0, conflicts: [], restoredLogs: 0, restoredDocs: 0 };
    if (!/^\d{6}_\d{6}$/.test(stamp)) return res;
    const docsDir = await codexRescueDocsDir(folderUri);
    if (!docsDir) return res;
    const bin = vscode.Uri.joinPath(trashRoot(docsDir), stamp);
    const meta = await readTrashMeta(bin);
    if (!meta) return res;

    const logDir = vscode.Uri.joinPath(docsDir, '.log');
    await vscode.workspace.fs.createDirectory(logDir);

    for (const e of meta.entries) {
        const src = vscode.Uri.joinPath(bin, e.n);
        if (!await statOf(src)) continue;
        const dst = e.d === '.log' ? vscode.Uri.joinPath(logDir, e.n) : vscode.Uri.joinPath(docsDir, e.n);
        if (await statOf(dst)) { res.conflicts.push(e.n); continue; }
        try {
            await vscode.workspace.fs.rename(src, dst, { overwrite: false });
            res.restored++;
            if (e.d === '.log') res.restoredLogs++; else res.restoredDocs++;
        } catch {
            res.conflicts.push(e.n);
        }
    }

    // Only retire the bin once everything is out; otherwise the conflicting files would be
    // deleted by the cleanup below, which is the opposite of what restore promises.
    if (!res.conflicts.length) {
        try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* ignore */ }
    }
    return res;
}

/**
 * Delete one trashed run for good.
 *
 * With `includeDocs` false only the raw `.log/` files go; the request/response documents stay in
 * the trash on their own. That leaves an orphan — a record with no run behind it — and that is
 * the point: the logs are bulk, the documents are what was actually asked and answered.
 */
export async function purgeTrashed(folderUri: vscode.Uri, stamp: string,
                                   includeDocs: boolean): Promise<boolean> {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return false;
    const docsDir = await codexRescueDocsDir(folderUri);
    if (!docsDir) return false;
    const bin = vscode.Uri.joinPath(trashRoot(docsDir), stamp);

    if (includeDocs) {
        try {
            await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false });
            return true;
        } catch {
            return false;
        }
    }

    const meta = await readTrashMeta(bin);
    if (!meta) return false;
    let removed = 0;
    for (const e of meta.entries) {
        if (e.d !== '.log') continue;
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(bin, e.n), { useTrash: false });
            removed++;
        } catch { /* already gone */ }
    }
    // Nothing but metadata left — keeping an empty bin would show a row that restores nothing.
    const survivors = meta.entries.filter(e => e.d !== '.log');
    if (!survivors.length) {
        try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* ignore */ }
        return removed > 0;
    }
    // Rewrite the manifest so a later restore doesn't look for files that are gone.
    const next: TrashMeta = { ...meta, entries: survivors };
    try {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(bin, 'meta.json'),
                                            Buffer.from(JSON.stringify(next), 'utf8'));
    } catch { /* the stale manifest is tolerated: restore skips missing files */ }
    return removed > 0;
}

/** Empty the trash. Returns how many runs were acted on. */
export async function emptyTrash(folderUri: vscode.Uri, includeDocs: boolean): Promise<number> {
    const items = await listTrash(folderUri);
    let n = 0;
    for (const it of items) {
        if (await purgeTrashed(folderUri, it.stamp, includeDocs)) n++;
    }
    return n;
}
