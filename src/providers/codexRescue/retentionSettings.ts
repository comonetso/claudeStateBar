import * as vscode from 'vscode';

// How long the codex-rescue plugin keeps old run history (2026-10-01).
//
// The plugin cleans up on every run and reads its retention from <home>/.claude/codex_rescue/
// settings.json on the machine it runs on — that file is the one source of truth (owner's
// decision). This module only reads and writes it for the settings panel; there is no
// claudeContextBar.* setting behind it, and the old codexRunAutoCleanup settings stay removed.
//
// The contract, mirrored from the plugin's scripts/cleanup-logs.mjs readRetention():
//   { "scratchDays": 1, "logDays": 7 } — whole numbers, 0 or more; 0 turns that cleanup off.
//   A missing file or key means the default below. Unknown keys are ignored by the plugin and
//   kept by us when saving. A file that is not JSON, not an object, or holds a bad value makes
//   the plugin skip the whole cleanup for that run, so the panel calls it broken.
//   The plugin reads the file at its next run, so a change applies from then.
//
// The host is whichever one getClaudeBaseUri() resolves: the local home for a local window, the
// server's home for a Remote-SSH window (vscode.workspace.fs routes the reads and writes there).

/** The plugin's own defaults (cleanup-logs.mjs readRetention). Change them only together. */
export const RETENTION_DEFAULTS = { scratchDays: 1, logDays: 7 } as const;
export type RetentionKey = keyof typeof RETENTION_DEFAULTS;
const KEYS: RetentionKey[] = ['scratchDays', 'logDays']; // the plugin checks them in this order

export type RetentionWhy = 'json' | 'object' | 'value';

export interface RetentionView {
    /** ok = file read · missing = no file (defaults apply) · broken = the plugin skips cleanup ·
     *  unreadable = the read itself failed (we will not overwrite it) · unavailable = no ~/.claude */
    status: 'ok' | 'missing' | 'broken' | 'unreadable' | 'unavailable';
    scratchDays: number;
    logDays: number;
    /** false = the key is absent, so the plugin uses the default (shown as "default"). */
    scratchFromFile: boolean;
    logFromFile: boolean;
    /** Why a broken file is broken; whyKey names the first bad key for 'value'. */
    why?: RetentionWhy;
    whyKey?: string;
    /** The read error for 'unreadable'. */
    error?: string;
    /** The file as the user would name it: a local path, or "<host>: /home/x/..." for a server. */
    path: string;
}

interface Judged {
    why?: RetentionWhy;
    whyKey?: string;
    /** The parsed object when the text is a JSON object (even with a bad value), else null. */
    obj: Record<string, unknown> | null;
    values: Record<RetentionKey, number>;
    fromFile: Record<RetentionKey, boolean>;
}

function validDays(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function asObject(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/**
 * Judge the file text the way the plugin does. The text is decoded without stripping a BOM,
 * because the plugin's readFileSync(..., 'utf8') keeps it and JSON.parse then fails — a file the
 * plugin calls broken must look broken here too. Bad keys fall back to the default for display.
 */
export function judgeRetentionText(text: string): Judged {
    const values = { ...RETENTION_DEFAULTS } as Record<RetentionKey, number>;
    const fromFile = { scratchDays: false, logDays: false };
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return { why: 'json', obj: null, values, fromFile }; }
    const obj = asObject(parsed);
    if (!obj) return { why: 'object', obj: null, values, fromFile };
    let why: RetentionWhy | undefined;
    let whyKey: string | undefined;
    for (const key of KEYS) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        if (validDays(obj[key])) { values[key] = obj[key] as number; fromFile[key] = true; }
        else if (!why) { why = 'value'; whyKey = key; }
    }
    return { why, whyKey, obj, values, fromFile };
}

function settingsUris(base: vscode.Uri): { dir: vscode.Uri; file: vscode.Uri } {
    const dir = vscode.Uri.joinPath(base, 'codex_rescue');
    return { dir, file: vscode.Uri.joinPath(dir, 'settings.json') };
}

/** Remote-SSH authorities are `ssh-remote+<host>` or `ssh-remote+<hex of {"hostName":...}>`
 *  (same decoding as core/workspaceLabel.ts, which keeps its copy private). */
function hostOf(authority: string): string {
    const plus = authority.indexOf('+');
    let host = plus >= 0 ? authority.slice(plus + 1) : authority;
    if (/^(?:[0-9a-f]{2})+$/i.test(host)) {
        try {
            const decoded = JSON.parse(Buffer.from(host, 'hex').toString('utf8'));
            if (typeof decoded?.hostName === 'string') host = decoded.hostName;
        } catch { /* not the JSON form — keep the authority as-is */ }
    }
    return host;
}

function displayPath(uri: vscode.Uri): string {
    if (uri.scheme === 'file') return uri.fsPath;
    const host = hostOf(uri.authority);
    return host ? `${host}: ${uri.path}` : uri.path;
}

function isNotFound(e: unknown): boolean {
    const err = e as { code?: unknown; name?: unknown } | null;
    if (!err) return false;
    if (err.code === 'FileNotFound' || err.code === 'ENOENT') return true;
    return typeof err.name === 'string' && /EntryNotFound|FileNotFound/.test(err.name);
}

function viewFrom(judged: Judged, path: string): RetentionView {
    return {
        status: judged.why ? 'broken' : 'ok',
        scratchDays: judged.values.scratchDays,
        logDays: judged.values.logDays,
        scratchFromFile: judged.fromFile.scratchDays,
        logFromFile: judged.fromFile.logDays,
        why: judged.why,
        whyKey: judged.whyKey,
        path,
    };
}

function defaultView(status: RetentionView['status'], path: string, error?: string): RetentionView {
    return {
        status, path, error,
        scratchDays: RETENTION_DEFAULTS.scratchDays, logDays: RETENTION_DEFAULTS.logDays,
        scratchFromFile: false, logFromFile: false,
    };
}

/** One read of the file on this window's host. Never throws — failures come back as a status. */
export async function readRetentionSettings(base: vscode.Uri | null): Promise<RetentionView> {
    if (!base) return defaultView('unavailable', '');
    const { file } = settingsUris(base);
    const path = displayPath(file);
    let bytes: Uint8Array;
    try { bytes = await vscode.workspace.fs.readFile(file); }
    catch (e) {
        if (isNotFound(e)) return defaultView('missing', path);
        return defaultView('unreadable', path, (e as Error)?.message ?? String(e));
    }
    return viewFrom(judgeRetentionText(Buffer.from(bytes).toString('utf8')), path);
}

/**
 * Write both values to this window's host. The file is read again first so keys added since the
 * panel opened are kept; a file that cannot be read at all (not missing — say, a permission
 * error) is left alone and the error is thrown. A broken file is rewritten: its other keys are
 * kept when it is still a JSON object (a BOM is tolerated for that), otherwise it starts empty.
 * The new text goes to a temporary file in the same folder and is renamed over the old one, so
 * the plugin never reads half a file.
 */
export async function writeRetentionSettings(
    base: vscode.Uri,
    next: Record<RetentionKey, unknown>
): Promise<RetentionView> {
    for (const key of KEYS) {
        if (!validDays(next[key])) throw new Error(`${key} must be a whole number of days, 0 or more`);
    }
    const { dir, file } = settingsUris(base);
    let obj: Record<string, unknown> = {};
    try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        const judged = judgeRetentionText(text);
        if (judged.obj) obj = judged.obj;
        else if (judged.why === 'json' && text.charCodeAt(0) === 0xfeff) {
            try { obj = asObject(JSON.parse(text.slice(1))) ?? {}; } catch { /* rewrite from scratch */ }
        }
    } catch (e) {
        if (!isNotFound(e)) throw e;
    }
    for (const key of KEYS) obj[key] = next[key];

    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* exists — the write below decides */ }
    const tmp = vscode.Uri.joinPath(dir, `.settings.json.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    const out = JSON.stringify(obj, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(tmp, Buffer.from(out, 'utf8'));
    try {
        await vscode.workspace.fs.rename(tmp, file, { overwrite: true });
    } catch (e) {
        try { await vscode.workspace.fs.delete(tmp); } catch { /* best effort */ }
        throw e;
    }
    return viewFrom(judgeRetentionText(out), displayPath(file));
}
