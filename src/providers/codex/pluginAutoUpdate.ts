import * as vscode from 'vscode';
import { readTextFile } from '../../core/fs';

// Auto-update for the codex_rescue plugin (2026-09-17 user decision).
//
// Claude Code leaves background auto-update off for marketplaces outside Anthropic's own, so a
// `comonetso` install never updates unless `extraKnownMarketplaces.comonetso.autoUpdate` is true in
// ~/.claude/settings.json. Every function here takes the ~/.claude base URI of the host the window
// points at (a file:// URI locally, vscode-remote:// over Remote-SSH), so one code path covers the
// local PC and each server.

export const CODEX_PLUGIN_ID = 'codex-rescue@comonetso';
const MARKETPLACE = 'comonetso';
const MARKETPLACE_SOURCE = { source: 'github', repo: 'comonetso/claudeStateBar' };

/**
 * off     — plugin installed, auto-update not on (entry missing or flag not true)
 * on      — already on
 * absent  — plugin not installed on this host; nothing to offer
 * unknown — settings.json unreadable as JSON; we never write in that case
 */
export type AutoUpdateState = 'off' | 'on' | 'absent' | 'unknown';

function settingsUri(base: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(base, 'settings.json');
}

/** installed_plugins.json names the plugin and its installPath still holds SKILL.md. */
async function pluginInstalled(base: vscode.Uri): Promise<boolean> {
    let data: any;
    try {
        data = JSON.parse(await readTextFile(vscode.Uri.joinPath(base, 'plugins', 'installed_plugins.json')));
    } catch {
        return false;
    }
    const entries: unknown = data?.plugins?.[CODEX_PLUGIN_ID];
    if (!Array.isArray(entries)) return false;
    for (const e of entries) {
        if (typeof e?.installPath !== 'string') continue;
        // The recorded path belongs to the host that wrote it: a Windows path locally, a POSIX path
        // on a server. Resolve it against the same scheme/authority as base.
        const p = e.installPath.replace(/\\/g, '/');
        const dir = base.scheme === 'file' ? vscode.Uri.file(e.installPath) : base.with({ path: p });
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, 'SKILL.md'));
            return true;
        } catch { /* try the next entry */ }
    }
    return false;
}

export async function readAutoUpdateState(base: vscode.Uri): Promise<AutoUpdateState> {
    if (!(await pluginInstalled(base))) return 'absent';
    let raw: string;
    try {
        raw = await readTextFile(settingsUri(base));
    } catch {
        return 'off'; // no settings.json yet — enabling creates it
    }
    let json: any;
    try { json = JSON.parse(raw); } catch { return 'unknown'; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown';
    return json.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate === true ? 'on' : 'off';
}

function detectIndent(raw: string): string {
    const m = /\r?\n([ \t]+)\S/.exec(raw);
    return m ? m[1] : '  ';
}

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export type EnableResult =
    | { ok: true; backup: vscode.Uri | null; created: boolean }
    | { ok: false; reason: string };

/**
 * Sets `extraKnownMarketplaces.comonetso.autoUpdate = true`, creating the marketplace entry (and
 * settings.json) when missing — user decision. Keeps key order, the file's indent, its line
 * endings and its trailing newline. Backs the file up first and reads it back after writing;
 * if the read-back fails, the backup is restored.
 */
export async function enableAutoUpdate(base: vscode.Uri): Promise<EnableResult> {
    const uri = settingsUri(base);
    let raw: string | null = null;
    try { raw = await readTextFile(uri); } catch { /* missing file */ }

    let json: any = {};
    if (raw !== null) {
        try { json = JSON.parse(raw); } catch (e) { return { ok: false, reason: `settings.json is not valid JSON: ${e}` }; }
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
            return { ok: false, reason: 'settings.json is not a JSON object' };
        }
    }

    const markets = json.extraKnownMarketplaces;
    if (markets !== undefined && (typeof markets !== 'object' || markets === null || Array.isArray(markets))) {
        return { ok: false, reason: 'extraKnownMarketplaces is not an object' };
    }
    let created = false;
    if (!markets) json.extraKnownMarketplaces = {};
    const entry = json.extraKnownMarketplaces[MARKETPLACE];
    if (entry === undefined) {
        json.extraKnownMarketplaces[MARKETPLACE] = { source: { ...MARKETPLACE_SOURCE }, autoUpdate: true };
        created = true;
    } else if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { ok: false, reason: `extraKnownMarketplaces.${MARKETPLACE} is not an object` };
    } else {
        entry.autoUpdate = true;
    }

    const eol = raw !== null && raw.includes('\r\n') ? '\r\n' : '\n';
    let out = JSON.stringify(json, null, raw !== null ? detectIndent(raw) : '  ');
    if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
    if (raw === null || /\r?\n$/.test(raw)) out += eol;

    let backup: vscode.Uri | null = null;
    if (raw !== null) {
        backup = vscode.Uri.joinPath(base, `settings.json.bak_autoupdate_${stamp()}`);
        try {
            await vscode.workspace.fs.copy(uri, backup, { overwrite: false });
        } catch (e) {
            return { ok: false, reason: `backup failed: ${e}` };
        }
    }

    try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(out, 'utf-8'));
        const check = JSON.parse(await readTextFile(uri));
        if (check?.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate !== true) throw new Error('read-back mismatch');
    } catch (e) {
        if (backup) {
            try { await vscode.workspace.fs.copy(backup, uri, { overwrite: true }); } catch { /* reported below */ }
        }
        return { ok: false, reason: `write failed, original restored: ${e}` };
    }
    return { ok: true, backup, created };
}
