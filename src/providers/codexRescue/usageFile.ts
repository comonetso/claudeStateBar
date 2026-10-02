import * as vscode from 'vscode';

// The disk-use record codex_rescue 1.17.3+ leaves for the Codex progress tab (2026-10-02):
// `<root>/docs/codex_rescue/.log/_usage.json`. The plugin's cleanup-logs.mjs rewrites it after
// every automatic cleanup and after every cleanup started from this tab. The extension never
// measures anything itself — it reads this one file and builds the plugin's own cleanup command
// from it (user's call: the cleanup lives in the plugin, for people who use it without VS Code).
//
// The file is never mistaken for a run: every scanner of `.log/` matches `<stamp>_…` names
// (`\d{6}_\d{6}_`), and the trash only moves names built from a stamp it has validated.
//
// Shape (schema 1; paths written with forward slashes):
//   { "schema": 1, "computed_at": "<ISO>", "root": "<root>",
//     "items": { "scratch"|"log"|"trash"|"codex": { "bytes": n, "count": n } },
//     "clean": { "script": "<…/scripts/cleanup-logs.mjs>", "dir": "<root>/docs/codex_rescue" } }

/** The four things a cleanup can take, in the order the panel and the command list them. */
export const CLEAN_ITEMS = ['scratch', 'log', 'trash', 'codex'] as const;
export type CleanItem = typeof CLEAN_ITEMS[number];

export interface UsageItem {
    bytes: number;
    /** scratch/trash: top-level entries · log: files · codex: conversations (not their sub-agents). */
    count: number;
}

export interface CodexUsage {
    computedAt: number;
    items: Record<CleanItem, UsageItem>;
    clean: { script: string; dir: string };
}

export type UsageRead =
    | { state: 'ok'; usage: CodexUsage }
    | { state: 'missing' }
    | { state: 'broken'; why: string };

/** What the Codex tab draws: sizes already formatted, the clock left to the webview. */
export interface UsageView {
    state: 'ok' | 'missing' | 'broken';
    computedAt?: number;
    total?: string;
    items?: { key: CleanItem; size: string }[];
}

/**
 * The one project whose record the tab shows: this window's own workspace root (user's call,
 * 2026-10-02 — "this window's project"; folders attached from the ledger and other worktrees are
 * left out). In a multi-root window that is the first folder, VS Code's own notion of the root.
 */
export function codexUsageFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

export function usageFileUri(folder: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(folder, 'docs', 'codex_rescue', '.log', '_usage.json');
}

function isCount(n: unknown): n is number {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

// Absolute only. The command runs `node <script>` in a terminal opened at the project root, so a
// relative path would resolve inside the project — never what the plugin writes.
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;

/** Parse the file's text. Anything off the contract reads as broken, which the tab treats like missing. */
export function parseUsage(text: string): UsageRead {
    const broken = (why: string): UsageRead => ({ state: 'broken', why });
    let j: any;
    try { j = JSON.parse(text.replace(/^﻿/, '')); } catch { return broken('json'); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return broken('object');
    if (j.schema !== 1) return broken('schema');
    const at = typeof j.computed_at === 'string' ? Date.parse(j.computed_at) : NaN;
    if (!Number.isFinite(at)) return broken('computed_at');
    const items = {} as Record<CleanItem, UsageItem>;
    for (const k of CLEAN_ITEMS) {
        const it = j.items && typeof j.items === 'object' ? j.items[k] : undefined;
        if (!it || !isCount(it.bytes) || !isCount(it.count)) return broken('items.' + k);
        items[k] = { bytes: it.bytes, count: it.count };
    }
    const script = j.clean && typeof j.clean === 'object' ? j.clean.script : undefined;
    const dir = j.clean && typeof j.clean === 'object' ? j.clean.dir : undefined;
    if (typeof script !== 'string' || !ABSOLUTE.test(script)) return broken('clean.script');
    if (typeof dir !== 'string' || !ABSOLUTE.test(dir)) return broken('clean.dir');
    return { state: 'ok', usage: { computedAt: at, items, clean: { script, dir } } };
}

/**
 * Read `folder`'s record. One read, through workspace.fs, so a Remote-SSH window reads the
 * server's file. Never throws: a file that cannot be read is reported as missing.
 */
export async function readUsage(folder: vscode.Uri): Promise<UsageRead> {
    let raw: Uint8Array;
    try {
        raw = await vscode.workspace.fs.readFile(usageFileUri(folder));
    } catch {
        return { state: 'missing' };
    }
    return parseUsage(Buffer.from(raw).toString('utf8'));
}

/** 1023 B · 4.2 KB · 87 MB · 1.2 GB — binary units, one decimal below 100. */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 1024) return Math.max(0, Math.round(n || 0)) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
    return s + ' ' + units[i];
}

export function usageView(r: UsageRead): UsageView {
    if (r.state !== 'ok') return { state: r.state };
    const u = r.usage;
    const total = CLEAN_ITEMS.reduce((a, k) => a + u.items[k].bytes, 0);
    return {
        state: 'ok',
        computedAt: u.computedAt,
        total: formatBytes(total),
        items: CLEAN_ITEMS.map(key => ({ key, size: formatBytes(u.items[key].bytes) })),
    };
}

// Characters a double-quoted argument cannot carry into a terminal as typed: the quote itself,
// control characters (a line break would submit half the command; a tab triggers completion), and
// what the shells still expand inside double quotes — `$` and the backtick (bash, PowerShell), `%`
// (cmd) and `!` (bash history). Refused rather than escaped, since each shell escapes differently.
const UNQUOTABLE = /["$`%!\u0000-\u001f\u007f]/;

/** The first of the record's two paths that cannot be passed to a terminal safely, if any. */
export function unquotablePath(clean: { script: string; dir: string }): string | undefined {
    return [clean.script, clean.dir].find(p => UNQUOTABLE.test(p));
}

export type CleanCommand = { ok: true; text: string } | { ok: false; badPath: string };

/**
 * The plugin's cleanup command for the picked items, or null when nothing is picked:
 * `node "<script>" --dir "<dir>" --now "<a,b>" --yes --lang "<en|ko>"`. Every argument that varies
 * is double-quoted — PowerShell expands an unquoted `scratch,log` into an array and passes two
 * arguments. `--yes` because the tab has already asked (without it the plugin only previews);
 * `--lang` so the terminal speaks the extension's language (the plugin defaults to English).
 */
export function buildCleanCommand(clean: { script: string; dir: string },
                                  picked: readonly string[], lang: 'en' | 'ko' = 'en'): CleanCommand | null {
    const items = CLEAN_ITEMS.filter(k => picked.includes(k));
    if (!items.length) return null;
    const bad = unquotablePath(clean);
    if (bad !== undefined) return { ok: false, badPath: bad };
    const q = (s: string): string => '"' + s + '"';
    return { ok: true, text: 'node ' + q(clean.script) + ' --dir ' + q(clean.dir) +
                             ' --now ' + q(items.join(',')) + ' --yes --lang ' + q(lang) };
}

/** Comparison key for a URI: Windows local paths ignore case, a server's do not; no trailing slash. */
function pathKey(u: vscode.Uri): string {
    const p = u.path.replace(/\/+$/, '');
    return u.scheme === 'file' && process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Whether the recorded script is the plugin's own cleanup script: `cleanup-logs.mjs` somewhere under
 * that machine's `~/.claude` (`claudeBase`, where Claude Code installs plugins). The usage file is a
 * plain file in the project, so one copied or planted there must not get an arbitrary program run
 * by the Clean up button (user's call, 2026-10-02).
 */
export function isPluginCleanScript(anchor: vscode.Uri, script: string, claudeBase: vscode.Uri | null): boolean {
    if (!claudeBase) return false;
    const s = script.replace(/\\/g, '/');
    if (s.split('/').some(seg => seg === '..' || seg === '.')) return false;
    if (s.slice(s.lastIndexOf('/') + 1) !== 'cleanup-logs.mjs') return false;
    const uri = hostPathUri(anchor, s);
    if (uri.scheme !== claudeBase.scheme || uri.authority !== claudeBase.authority) return false;
    return pathKey(uri).startsWith(pathKey(claudeBase) + '/');
}

/** Whether the record's folder is this window's own `docs/codex_rescue` (a copied project keeps the old one). */
export function isThisProjectsDir(folder: vscode.Uri, dir: string): boolean {
    const want = vscode.Uri.joinPath(folder, 'docs', 'codex_rescue');
    const got = hostPathUri(folder, dir);
    return got.scheme === want.scheme && got.authority === want.authority && pathKey(got) === pathKey(want);
}

/** A path the plugin wrote, as a URI on the same host as `anchor` (local file or remote). */
export function hostPathUri(anchor: vscode.Uri, p: string): vscode.Uri {
    const s = p.replace(/\\/g, '/');
    if (anchor.scheme === 'file') return vscode.Uri.file(s);
    return anchor.with({ path: /^[A-Za-z]:\//.test(s) ? '/' + s : s, query: '', fragment: '' });
}

/** Whether the recorded cleanup script is still there — a plugin update removes the old version's folder. */
export async function cleanScriptExists(anchor: vscode.Uri, script: string): Promise<boolean> {
    try {
        const st = await vscode.workspace.fs.stat(hostPathUri(anchor, script));
        return (st.type & vscode.FileType.File) !== 0;
    } catch {
        return false;
    }
}

/** "14:05" when `ms` is today, else "10/01 14:05" — the same clock the tab's cards use. */
export function formatUsageClock(ms: number, now: Date = new Date()): string {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    return today ? hm : p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + hm;
}
