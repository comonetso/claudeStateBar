import * as vscode from 'vscode';

// Conversations started from Paseo (a desktop/mobile front end for Claude Code and Codex that
// runs a daemon on each host). Where this repository's Paseo plugin claude-state-bar runs, it
// plays the completion, question, warning and danger chimes for them, so the extension stays
// quiet for those four or the user hears each one twice (user's call, 2026-10-05).
//
// What is on disk, measured 2026-10-05 on this PC (Paseo 0.11.0-beta.3) and Calladmin-Gabia
// (0.10.3): one file per conversation at ~/.paseo/agents/<folder>/<agentId>.json, holding the
// provider's session id in persistence.sessionId (and runtimeInfo.sessionId) — for Claude the
// name of the conversation's jsonl. The jsonl itself carries nothing Paseo-specific: its
// entrypoint is `sdk-cli`, which `claude -p` writes too, and the paseo MCP tools and the
// PASEO_* hook appear in ordinary conversations as well once Paseo is installed.
//
// Read only when a chime is about to sound, never on the regular pass, so a Remote-SSH window
// pays the round trips a few times an hour at most. Not cached: a resumed conversation can be
// given a new session id in the same file.

async function readJson(uri: vscode.Uri): Promise<unknown> {
    try {
        return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
    } catch {
        return null;
    }
}

function sessionIdsOf(agent: unknown): string[] {
    if (!agent || typeof agent !== 'object') return [];
    const a = agent as { persistence?: { sessionId?: unknown }; runtimeInfo?: { sessionId?: unknown } };
    return [a.persistence?.sessionId, a.runtimeInfo?.sessionId]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Session ids of every conversation Paseo keeps on the host behind `paseoBase` (~/.paseo). */
export async function readPaseoSessionIds(paseoBase: vscode.Uri): Promise<Set<string>> {
    const ids = new Set<string>();
    const agentsDir = vscode.Uri.joinPath(paseoBase, 'agents');
    let folders: [string, vscode.FileType][];
    try {
        folders = await vscode.workspace.fs.readDirectory(agentsDir);
    } catch {
        return ids; // Paseo is not installed on this host
    }
    for (const [folder, type] of folders) {
        if (type !== vscode.FileType.Directory) continue;
        let files: [string, vscode.FileType][];
        try {
            files = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(agentsDir, folder));
        } catch {
            continue;
        }
        const reads = files
            .filter(([name, t]) => t === vscode.FileType.File && name.endsWith('.json'))
            .map(([name]) => readJson(vscode.Uri.joinPath(agentsDir, folder, name)));
        for (const agent of await Promise.all(reads)) {
            for (const id of sessionIdsOf(agent)) ids.add(id);
        }
    }
    return ids;
}

// The plugin's install id. Paseo records it in ~/.paseo/config.json as plugins.<id>, beside the
// host-wide pluginsEnabled switch (absent = off, as found on Calladmin-Gabia before it was turned on).
const PLUGIN_ID = 'claude-state-bar';

/** Whether the plugin is installed and running on the host behind `paseoBase`. */
export async function isPluginActive(paseoBase: vscode.Uri): Promise<boolean> {
    const config = await readJson(vscode.Uri.joinPath(paseoBase, 'config.json')) as
        { pluginsEnabled?: unknown; plugins?: Record<string, { enabled?: unknown } | undefined> } | null;
    if (!config || config.pluginsEnabled !== true) return false;
    const entry = config.plugins?.[PLUGIN_ID];
    return !!entry && entry.enabled !== false;
}

/**
 * Whether the plugin sounds for the conversation in `sessionFile` (a URI string): it was started
 * from Paseo and the plugin runs there. Without the plugin a Paseo conversation keeps the
 * extension's chimes, since nothing would double them. A Claude file is named <sessionId>.jsonl;
 * a Codex rollout ends with its thread id, hence the suffix test.
 */
export async function pluginSoundsFor(sessionFile: string, paseoBase: vscode.Uri): Promise<boolean> {
    const name = (vscode.Uri.parse(sessionFile).path.split('/').pop() ?? '').replace(/\.jsonl$/, '');
    if (!name) return false;
    if (!await isPluginActive(paseoBase)) return false;
    const ids = await readPaseoSessionIds(paseoBase);
    if (ids.has(name)) return true;
    for (const id of ids) if (name.endsWith(id)) return true;
    return false;
}
