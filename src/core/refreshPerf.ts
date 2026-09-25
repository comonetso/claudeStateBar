import * as vscode from 'vscode';
import { readTextFile } from './fs';

// Two things for the status-bar refresh, kept together because they meet at the same read.
//
// 1. One refresh pass can read the same conversation file twice: the token parser reads it, and
//    the workflow panel reads it again for the task notifications Claude Code leaves in the parent
//    session. Over Remote-SSH that is a second full transfer of files that reach 15MB. While a pass
//    is open, readShared() hands a second caller the first read. The share is dropped when the pass
//    ends, so every pass still reads fresh — the text is never carried from one pass to the next.
//
//    What IS carried is the parsed result, keyed by the file's size and mtime (cachedParse /
//    storeParse / readParsed). Every refresh used to re-read every conversation touched within
//    `hideAfter` — 24 hours by default — so each session started and closed in a long-lived window
//    added a multi-MB file to every pass: 70-220MB a minute measured in a Remote-SSH window on
//    2026-09-25, while the session menu waited 16-21s behind it. An unchanged file is now read once;
//    only files still being written are transferred again (the remote file API has no range read).
//    The user chose this on 2026-09-25 after declining it on 09-14, before the pile-up was measured.
//
// 2. Numbers for the one-line-a-minute summary. The session menu in a long-running Remote-SSH
//    window opened late or not at all, and the old per-file log lines could not say why. These
//    record how long passes take, how long the shared reads take, how long the token parser keeps
//    the extension host busy parsing (synchronous, so nothing else runs meanwhile), how late the
//    existing 1-second ticker fires (a blocked host shows up as a late tick), and how long the
//    session menu takes from click to showing.

let shared: Map<string, Promise<string>> | null = null;
let sharedStats: Map<string, Promise<vscode.FileStat>> | null = null;

export function beginRefreshShare(): void {
    shared = new Map();
    sharedStats = new Map();
}

export function endRefreshShare(): void {
    shared = null;
    sharedStats = null;
}

/**
 * stat, shared within a pass like readShared. The session scan stats every conversation and the
 * token parser stats the same file again to check its cache — over SSH, one round trip each.
 */
export function statShared(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.toString();
    const hit = sharedStats?.get(key);
    if (hit) return hit;
    const p = Promise.resolve(vscode.workspace.fs.stat(uri));
    if (sharedStats) {
        const table = sharedStats;
        table.set(key, p);
        p.catch(() => { if (table.get(key) === p) table.delete(key); });
    }
    return p;
}

// Parsed results by kind + file, valid while size and mtime match. Conversation files are
// append-only JSONL, so a write that keeps both unchanged does not happen in practice.
const parsed = new Map<string, { size: number; mtime: number; value: unknown }>();

/** The result parsed from this exact file state earlier, if any. */
export function cachedParse<T>(uri: vscode.Uri, kind: string, st: vscode.FileStat): T | undefined {
    const hit = parsed.get(kind + '|' + uri.toString());
    if (hit && hit.size === st.size && hit.mtime === st.mtime) {
        stats.reuses++;
        return hit.value as T;
    }
    return undefined;
}

/** Remember a result for this file state and hand it back. Callers must not mutate it later. */
export function storeParse<T>(uri: vscode.Uri, kind: string, st: vscode.FileStat, value: T): T {
    parsed.set(kind + '|' + uri.toString(), { size: st.size, mtime: st.mtime, value });
    return value;
}

/** cachedParse → otherwise read (shared within the pass) and parse, then storeParse. */
export async function readParsed<T>(uri: vscode.Uri, kind: string, parse: (text: string) => T): Promise<T> {
    const st = await statShared(uri);
    const hit = cachedParse<T>(uri, kind, st);
    if (hit !== undefined) return hit;
    return storeParse(uri, kind, st, parse(await readShared(uri)));
}

/**
 * Drop results for files outside `keep` (URI strings) — called with the files the session scan
 * still covers, so a conversation that aged out of `hideAfter` stops holding memory. A result
 * dropped too eagerly only costs one re-read.
 */
export function pruneParsed(keep: Set<string>): void {
    for (const key of Array.from(parsed.keys())) {
        if (!keep.has(key.slice(key.indexOf('|') + 1))) parsed.delete(key);
    }
}

export function readShared(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const hit = shared?.get(key);
    if (hit) return hit;
    const started = Date.now();
    const p = readTextFile(uri).then(text => {
        const ms = Date.now() - started;
        stats.reads++;
        stats.readChars += text.length;
        if (ms > stats.readMaxMs) { stats.readMaxMs = ms; stats.readMaxChars = text.length; }
        return text;
    });
    if (shared) {
        const table = shared;
        table.set(key, p);
        // A failed read must not be handed to the next caller in the same pass.
        p.catch(() => { if (table.get(key) === p) table.delete(key); });
    }
    return p;
}

const stats = {
    passes: 0, folded: 0, passMaxMs: 0, passTotalMs: 0,
    reads: 0, readChars: 0, readMaxMs: 0, readMaxChars: 0,
    parseMaxMs: 0, parseTotalMs: 0,
    tickLagMaxMs: 0,
    menus: 0, menuMaxMs: 0,
    reuses: 0,
    fills: 0, fillMaxMs: 0,
};

export function recordPass(ms: number): void {
    stats.passes++;
    stats.passTotalMs += ms;
    if (ms > stats.passMaxMs) stats.passMaxMs = ms;
}

export function recordFolded(): void {
    stats.folded++;
}

export function recordParse(ms: number): void {
    stats.parseTotalMs += ms;
    if (ms > stats.parseMaxMs) stats.parseMaxMs = ms;
}

export function recordTickLag(ms: number): void {
    if (ms > stats.tickLagMaxMs) stats.tickLagMaxMs = ms;
}

export function recordMenu(ms: number): void {
    stats.menus++;
    if (ms > stats.menuMaxMs) stats.menuMaxMs = ms;
}

/**
 * How long the menu's counts took to arrive after it was already showing. The menu no longer
 * waits for them, so this is where a slow remote shows up now instead of in `menu`.
 */
export function recordMenuFill(ms: number): void {
    stats.fills++;
    if (ms > stats.fillMaxMs) stats.fillMaxMs = ms;
}

/** One summary line for the last interval, then start counting again. */
export function takeRefreshSummary(): string {
    const mb = (chars: number) => (chars / 1048576).toFixed(1);
    const avg = stats.passes ? Math.round(stats.passTotalMs / stats.passes) : 0;
    const line = `[refresh] passes=${stats.passes} folded=${stats.folded}` +
        ` pass(max=${stats.passMaxMs}ms avg=${avg}ms)` +
        ` reads=${stats.reads} ${mb(stats.readChars)}Mchars(max=${stats.readMaxMs}ms ${mb(stats.readMaxChars)}Mchars)` +
        ` parse(max=${stats.parseMaxMs}ms total=${stats.parseTotalMs}ms)` +
        ` reuse=${stats.reuses}` +
        ` tickLag(max=${stats.tickLagMaxMs}ms)` +
        ` menu(n=${stats.menus} max=${stats.menuMaxMs}ms)` +
        ` menuFill(n=${stats.fills} max=${stats.fillMaxMs}ms)`;
    stats.passes = 0; stats.folded = 0; stats.passMaxMs = 0; stats.passTotalMs = 0;
    stats.reads = 0; stats.readChars = 0; stats.readMaxMs = 0; stats.readMaxChars = 0;
    stats.parseMaxMs = 0; stats.parseTotalMs = 0;
    stats.tickLagMaxMs = 0;
    stats.menus = 0; stats.menuMaxMs = 0;
    stats.reuses = 0;
    stats.fills = 0; stats.fillMaxMs = 0;
    return line;
}
