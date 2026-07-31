// Rollout reader with two strategies, chosen by URI scheme.
//
//   local  (file://)          → Node fs byte-range reads. A 14.1MB rollout parses in ~4ms
//                               because we only touch a head and a tail window.
//   remote (vscode-remote://) → vscode.workspace.fs.readFile, i.e. whole-file, because the
//                               VS Code filesystem API has no range read. This is exactly
//                               what the Claude provider already does over Remote-SSH (its
//                               largest session file here is 9.2MB), so the cost profile is
//                               not new — and unlike Claude we additionally skip the read
//                               entirely when mtime+size are unchanged.
//
// Why windowing matters at all (measured on 20 real sessions, 2026-08-01):
//   - session_meta is line #0 and 18–45KB, so identity sits at the very start.
//   - the newest token_count / turn_context / task_complete records are small and cluster
//     at the end, so live state sits at the very end.
//   - the largest single line observed is 3.6MB (a `compacted` record embedding the whole
//     prior conversation), so a 1MB window can land inside one record and yield nothing —
//     hence the widen-once retries.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { CodexAccumulator, createAccumulator, feedLine } from './rolloutParser';
import { CodexRolloutFile } from './discovery';
import { log } from '../../core/logger';

/** Files at or below this size are simply read whole — simpler and still cheap. */
const FULL_READ_LIMIT = 2 * 1024 * 1024;
/**
 * Head window. Must cover session_meta AND the first turn_context, because a session with
 * very few turns keeps its only model/effort record near the start of a huge file.
 * Measured worst case: session_meta 44.9KB, last turn_context at 165KB — 64KB was not
 * enough and left the model blank, so the window starts at 256KB and widens on demand.
 */
const HEAD_BYTES = 256 * 1024;
const HEAD_BYTES_WIDE = 1 * 1024 * 1024;
const TAIL_BYTES = 1 * 1024 * 1024;
/** Retry window when the first tail landed inside one giant record. */
const TAIL_BYTES_WIDE = 5 * 1024 * 1024;
/**
 * Cap on a single incremental append. Beyond this we fall back to a tail window: a jump
 * that large means a huge record (or a compaction) landed, and replaying it wholesale
 * would stall the refresh.
 */
const MAX_INCREMENTAL = 4 * 1024 * 1024;
/**
 * Whole-file ceiling for REMOTE reads only. Claude already streams 9.2MB session files
 * over Remote-SSH, so this is deliberately generous; it exists to stop a pathological
 * rollout from stalling the refresh loop, not to be hit in normal use.
 */
const REMOTE_MAX_BYTES = 32 * 1024 * 1024;

interface TailState {
    key: string;
    /** Byte offset already consumed (local incremental path only). */
    offset: number;
    /** Size at the time of the last read — a shrink means the file was rewritten. */
    lastSize: number;
    /** mtime at the last read — lets the remote path skip unchanged files entirely. */
    lastMtimeMs: number;
    /** Trailing partial line carried into the next read (local incremental path only). */
    carry: string;
    acc: CodexAccumulator;
}

const cache = new Map<string, TailState>();

/** Drop cache entries for files that are no longer in the active set. */
export function pruneCache(keep: Set<string>): void {
    for (const k of [...cache.keys()]) {
        if (!keep.has(k)) cache.delete(k);
    }
}

export function cacheSize(): number {
    return cache.size;
}

/**
 * Parse (or incrementally update) one rollout file and return its accumulator.
 * Returns null only when the file cannot be read at all.
 */
export async function readSession(file: CodexRolloutFile): Promise<CodexAccumulator | null> {
    return file.uri.scheme === 'file'
        ? readLocal(file)
        : readRemote(file);
}

// ---------------------------------------------------------------------------
// Remote: whole-file via vscode.workspace.fs, skipped when nothing changed.
// ---------------------------------------------------------------------------

async function readRemote(file: CodexRolloutFile): Promise<CodexAccumulator | null> {
    const key = file.uri.toString();
    const prev = cache.get(key);

    // Unchanged since the last refresh — reuse the parsed state and issue no read at all.
    if (prev && prev.lastMtimeMs === file.mtimeMs && prev.lastSize === file.sizeBytes) {
        return prev.acc;
    }

    if (file.sizeBytes > REMOTE_MAX_BYTES) {
        log(`[codex] skipping remote rollout above ${Math.round(REMOTE_MAX_BYTES / 1048576)}MB ` +
            `(${Math.round(file.sizeBytes / 1048576)}MB): ${file.uri.path}`);
        return prev?.acc ?? null;
    }

    let text: string;
    try {
        const bytes = await vscode.workspace.fs.readFile(file.uri);
        text = Buffer.from(bytes).toString('utf8');
    } catch (e) {
        log(`[codex] remote read failed: ${e}`);
        return prev?.acc ?? null;
    }

    // Whole-file, so a plain full parse — no windowing needed and none of its edge cases.
    const acc = createAccumulator();
    const { complete } = splitLines(text);
    for (const line of complete) feedLine(acc, line);

    cache.set(key, {
        key,
        offset: file.sizeBytes,
        lastSize: file.sizeBytes,
        lastMtimeMs: file.mtimeMs,
        carry: '',
        acc
    });
    return acc;
}

// ---------------------------------------------------------------------------
// Local: byte-range windows + incremental append.
// ---------------------------------------------------------------------------

function readLocal(file: CodexRolloutFile): CodexAccumulator | null {
    const filePath = file.uri.fsPath;
    const key = file.uri.toString();

    let size: number;
    let mtimeMs: number;
    try {
        const st = fs.statSync(filePath);
        size = st.size;
        mtimeMs = st.mtimeMs;
    } catch {
        cache.delete(key);
        return null;
    }

    const prev = cache.get(key);

    // Fast path: nothing appended since last time.
    if (prev && size === prev.lastSize && prev.offset >= size) {
        return prev.acc;
    }

    // Incremental: the file only grew and we already have parsed state for it.
    if (prev && size >= prev.lastSize && prev.offset <= size) {
        const delta = size - prev.offset;
        if (delta <= MAX_INCREMENTAL) {
            const chunk = readRange(filePath, prev.offset, size);
            if (chunk === null) return prev.acc;
            const text = prev.carry + chunk;
            const { complete, tail } = splitLines(text);
            for (const line of complete) feedLine(prev.acc, line);
            prev.carry = tail;
            prev.offset = size;
            prev.lastSize = size;
            prev.lastMtimeMs = mtimeMs;
            return prev.acc;
        }
        // Too big to replay — rebuild from a tail window instead.
    }

    // Cold start, truncation, or an oversized jump → rebuild.
    const state = buildFresh(filePath, key, size, mtimeMs);
    if (!state) return null;
    cache.set(key, state);
    return state.acc;
}

function buildFresh(filePath: string, key: string, size: number, mtimeMs: number): TailState | null {
    const acc = createAccumulator();

    if (size <= FULL_READ_LIMIT) {
        const text = readRange(filePath, 0, size);
        if (text === null) return null;
        const { complete, tail } = splitLines(text);
        for (const line of complete) feedLine(acc, line);
        return { key, offset: size, lastSize: size, lastMtimeMs: mtimeMs, carry: tail, acc };
    }

    // Head window: identity (session_meta) and the opening turn_context live at the start.
    feedHead(acc, filePath, size, HEAD_BYTES);

    // Tail window: live state (token_count, turn_context, task lifecycle).
    feedTail(acc, filePath, size, TAIL_BYTES);
    if (!acc.last) {
        // The window fell inside one giant record (3.6MB lines exist) — widen once.
        feedTail(acc, filePath, size, TAIL_BYTES_WIDE);
    }
    if (!acc.model) {
        // Few-turn sessions carry their only turn_context far from both ends. Re-reading
        // the head is safe: the parser keeps first-wins identity and last-wins state, so
        // replaying records cannot corrupt the accumulator.
        feedHead(acc, filePath, size, HEAD_BYTES_WIDE);
    }

    // Start incremental tracking from EOF; the skipped middle is historical detail we
    // deliberately do not need (we report current context, not the full transcript).
    return { key, offset: size, lastSize: size, lastMtimeMs: mtimeMs, carry: '', acc };
}

function feedHead(acc: CodexAccumulator, filePath: string, size: number, window: number): void {
    const text = readRange(filePath, 0, Math.min(window, size));
    if (text === null) return;
    // The final line of the window is almost certainly truncated — drop it.
    const { complete } = splitLines(text);
    for (const line of complete) feedLine(acc, line);
}

function feedTail(acc: CodexAccumulator, filePath: string, size: number, window: number): void {
    const start = Math.max(0, size - window);
    const text = readRange(filePath, start, size);
    if (text === null) return;
    const lines = text.split('\n');
    // When we started mid-file the first line is a fragment — discard it.
    if (start > 0) lines.shift();
    for (const line of lines) feedLine(acc, line);
}

function readRange(filePath: string, start: number, end: number): string | null {
    const length = end - start;
    if (length <= 0) return '';
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, start);
        // Decode only what we actually got. A multi-byte UTF-8 character can straddle the
        // boundary; the resulting replacement char lands in a line we either discard (tail
        // fragment) or fail to JSON.parse (counted, never thrown).
        return buf.subarray(0, read).toString('utf8');
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/**
 * Split on newlines, holding back the trailing fragment. Codex may be mid-write, so the
 * last line is only safe to parse once its terminating newline has arrived.
 */
function splitLines(text: string): { complete: string[]; tail: string } {
    const parts = text.split('\n');
    const tail = parts.pop() ?? '';
    return { complete: parts, tail };
}
