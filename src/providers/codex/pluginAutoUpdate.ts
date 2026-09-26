import * as vscode from 'vscode';
import { readTextFile } from '../../core/fs';

// Auto-update for the plugins in this repo's `comonetso` marketplace — codex_rescue (2026-09-17
// user decision), peer_req (2026-09-19: "a user who installed the plugin should get updates,
// the same way as codex_rescue") and browser_check (2026-09-26, user decision).
//
// Claude Code leaves background auto-update off for marketplaces outside Anthropic's own, so a
// `comonetso` install never updates unless `extraKnownMarketplaces.comonetso.autoUpdate` is true in
// ~/.claude/settings.json. The switch is per marketplace, so turning it on covers every plugin from
// it. Every function here takes the ~/.claude base URI of the host the window points at (a file://
// URI locally, vscode-remote:// over Remote-SSH), so one code path covers the local PC and each server.

export const CODEX_PLUGIN_ID = 'codex-rescue@comonetso';
const MARKETPLACE = 'comonetso';
const MARKETPLACE_SOURCE = { source: 'github', repo: 'comonetso/claudeStateBar' };
/** Plugins from the marketplace, with the name users know them by. */
const MARKETPLACE_PLUGINS: { id: string; label: string }[] = [
    { id: CODEX_PLUGIN_ID, label: 'codex_rescue' },
    { id: 'peer-req@comonetso', label: 'peer_req' },
    { id: 'browser-check@comonetso', label: 'browser_check' },
];

/**
 * off     — a marketplace plugin is installed, auto-update not on (entry missing or flag not true)
 * on      — already on
 * absent  — none of its plugins is installed on this host; nothing to offer
 * unknown — settings.json unreadable as JSON; we never write in that case
 */
export type AutoUpdateState = 'off' | 'on' | 'absent' | 'unknown';

/** Labels of the marketplace plugins found by the last readAutoUpdateState call. */
let lastInstalled: string[] = [];
export function installedPluginLabels(): string[] {
    return lastInstalled.slice();
}

function settingsUri(base: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(base, 'settings.json');
}

/**
 * Which marketplace plugins installed_plugins.json names with an installPath that still exists.
 * Checks `.claude-plugin/plugin.json`, which every plugin has — SKILL.md sits at the root only for
 * codex_rescue (peer_req keeps it under skills/).
 */
async function installedPlugins(base: vscode.Uri): Promise<string[]> {
    let data: any;
    try {
        data = JSON.parse(await readTextFile(vscode.Uri.joinPath(base, 'plugins', 'installed_plugins.json')));
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const plugin of MARKETPLACE_PLUGINS) {
        const entries: unknown = data?.plugins?.[plugin.id];
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
            if (typeof e?.installPath !== 'string') continue;
            // The recorded path belongs to the host that wrote it: a Windows path locally, a POSIX path
            // on a server. Resolve it against the same scheme/authority as base.
            const p = e.installPath.replace(/\\/g, '/');
            const dir = base.scheme === 'file' ? vscode.Uri.file(e.installPath) : base.with({ path: p });
            try {
                await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, '.claude-plugin', 'plugin.json'));
                found.push(plugin.label);
                break;
            } catch { /* try the next entry */ }
        }
    }
    return found;
}

export async function readAutoUpdateState(base: vscode.Uri): Promise<AutoUpdateState> {
    lastInstalled = await installedPlugins(base);
    if (lastInstalled.length === 0) return 'absent';
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
