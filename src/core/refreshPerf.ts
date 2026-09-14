import * as vscode from 'vscode';
import { readTextFile } from './fs';

// Two things for the status-bar refresh, kept together because they meet at the same read.
//
// 1. One refresh pass can read the same conversation file twice: the token parser reads it, and
//    the workflow panel reads it again for the task notifications Claude Code leaves in the parent
//    session. Over Remote-SSH that is a second full transfer of files that reach 15MB. While a pass
//    is open, readShared() hands a second caller the first read. The share is dropped when the pass
//    ends, so every pass still reads fresh — nothing is carried from one pass to the next.
//
// 2. Numbers for the one-line-a-minute summary. The session menu in a long-running Remote-SSH
//    window opened late or not at all, and the old per-file log lines could not say why. These
//    record how long passes take, how long the shared reads take, how long the token parser keeps
//    the extension host busy parsing (synchronous, so nothing else runs meanwhile), how late the
//    existing 1-second ticker fires (a blocked host shows up as a late tick), and how long the
//    session menu takes from click to showing.

let shared: Map<string, Promise<string>> | null = null;

export function beginRefreshShare(): void {
    shared = new Map();
}

export function endRefreshShare(): void {
    shared = null;
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

/** One summary line for the last interval, then start counting again. */
export function takeRefreshSummary(): string {
    const mb = (chars: number) => (chars / 1048576).toFixed(1);
    const avg = stats.passes ? Math.round(stats.passTotalMs / stats.passes) : 0;
    const line = `[refresh] passes=${stats.passes} folded=${stats.folded}` +
        ` pass(max=${stats.passMaxMs}ms avg=${avg}ms)` +
        ` reads=${stats.reads} ${mb(stats.readChars)}Mchars(max=${stats.readMaxMs}ms ${mb(stats.readMaxChars)}Mchars)` +
        ` parse(max=${stats.parseMaxMs}ms total=${stats.parseTotalMs}ms)` +
        ` tickLag(max=${stats.tickLagMaxMs}ms)` +
        ` menu(n=${stats.menus} max=${stats.menuMaxMs}ms)`;
    stats.passes = 0; stats.folded = 0; stats.passMaxMs = 0; stats.passTotalMs = 0;
    stats.reads = 0; stats.readChars = 0; stats.readMaxMs = 0; stats.readMaxChars = 0;
    stats.parseMaxMs = 0; stats.parseTotalMs = 0;
    stats.tickLagMaxMs = 0;
    stats.menus = 0; stats.menuMaxMs = 0;
    return line;
}
