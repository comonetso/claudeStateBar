// Codex session discovery — locating CODEX_HOME and the recent rollout files.
//
// Works on BOTH local and Remote-SSH hosts. Everything goes through vscode.workspace.fs,
// which VS Code routes to the remote host when the workspace is remote — the same
// mechanism the Claude provider already relies on. `tailReader` then picks its read
// strategy from the URI scheme (byte-range on local, whole-file on remote).

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export interface CodexRolloutFile {
    /** file:// on a local window, vscode-remote:// over Remote-SSH. */
    uri: vscode.Uri;
    mtimeMs: number;
    sizeBytes: number;
}

/** Remote home candidates, mirroring how the Claude provider locates ~/.claude. */
async function remoteHomeCandidates(folder: vscode.WorkspaceFolder): Promise<string[]> {
    const homes = ['/root'];
    try {
        const entries = await vscode.workspace.fs.readDirectory(folder.uri.with({ path: '/home' }));
        for (const [name, ftype] of entries) {
            if (ftype === vscode.FileType.Directory) homes.push(`/home/${name}`);
        }
    } catch { /* /home may not exist */ }
    return homes;
}

async function isDir(uri: vscode.Uri): Promise<boolean> {
    try {
        const st = await vscode.workspace.fs.stat(uri);
        return st.type === vscode.FileType.Directory
            || (st.type & vscode.FileType.Directory) === vscode.FileType.Directory;
    } catch {
        return false;
    }
}

/**
 * Resolve the Codex state directory as a URI.
 *
 * Local:  explicit setting → $CODEX_HOME → ~/.codex
 * Remote: explicit setting (absolute remote path) → the remote home that actually
 *         contains .codex/sessions, probed under /root and /home/*.
 *
 * An explicit setting is authoritative: if it does not resolve we return null rather than
 * silently reading a different directory than the one the user typed.
 */
export async function resolveCodexHomeUri(configured: string): Promise<vscode.Uri | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const isRemote = !!(folder && folder.uri.scheme === 'vscode-remote' && folder.uri.authority);

    if (configured && configured.trim()) {
        const raw = configured.trim();
        // On a remote window an absolute POSIX path is interpreted on the remote host;
        // anything else is treated as a local path.
        const uri = isRemote && raw.startsWith('/')
            ? folder!.uri.with({ path: raw })
            : vscode.Uri.file(raw);
        return (await isDir(uri)) ? uri : null;
    }

    if (isRemote) {
        for (const home of await remoteHomeCandidates(folder!)) {
            const candidate = folder!.uri.with({ path: `${home}/.codex/sessions` });
            if (await isDir(candidate)) {
                return folder!.uri.with({ path: `${home}/.codex` });
            }
        }
        return null;
    }

    // Local window.
    if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
        const fromEnv = vscode.Uri.file(process.env.CODEX_HOME.trim());
        if (await isDir(fromEnv)) return fromEnv;
    }
    const fallback = vscode.Uri.file(path.join(os.homedir(), '.codex'));
    return (await isDir(fallback)) ? fallback : null;
}

/**
 * List rollout files worth parsing.
 *
 * Codex stores sessions as sessions/YYYY/MM/DD/rollout-*.jsonl. Re-walking that whole tree
 * every refresh is explicitly forbidden (docs §18.5), so we descend only into the most
 * recent `days` date directories — which matters far more on a remote host, where every
 * readDirectory is a round trip. Directory names sort lexicographically in chronological
 * order, so "newest N" is a cheap sort.
 */
export async function listRecentRollouts(
    codexHome: vscode.Uri,
    cutoffMs: number,
    days = 3
): Promise<CodexRolloutFile[]> {
    const sessionsRoot = vscode.Uri.joinPath(codexHome, 'sessions');
    const dateDirs = await collectRecentDateDirs(sessionsRoot, days);
    const out: CodexRolloutFile[] = [];

    for (const dir of dateDirs) {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dir);
        } catch {
            continue;
        }
        const names = entries
            .filter(([n, t]) => t === vscode.FileType.File && n.startsWith('rollout-') && n.endsWith('.jsonl'))
            .map(([n]) => n);

        // stat in parallel — on a remote host these are round trips and serialising them
        // would visibly stall the refresh.
        const stats = await Promise.all(names.map(async (n) => {
            const uri = vscode.Uri.joinPath(dir, n);
            try {
                const st = await vscode.workspace.fs.stat(uri);
                return { uri, mtimeMs: st.mtime, sizeBytes: st.size };
            } catch {
                return null;  // vanished between readDirectory and stat
            }
        }));

        for (const s of stats) {
            if (s && s.mtimeMs > cutoffMs) out.push(s);
        }
    }

    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
}

/** Walk sessions/YYYY/MM/DD three levels deep and return the newest `days` leaf dirs. */
async function collectRecentDateDirs(sessionsRoot: vscode.Uri, days: number): Promise<vscode.Uri[]> {
    const leaves: vscode.Uri[] = [];
    const years = (await subDirs(sessionsRoot)).sort().reverse();

    for (const y of years) {
        const yearUri = vscode.Uri.joinPath(sessionsRoot, y);
        const months = (await subDirs(yearUri)).sort().reverse();
        for (const m of months) {
            const monthUri = vscode.Uri.joinPath(yearUri, m);
            const dayList = (await subDirs(monthUri)).sort().reverse();
            for (const d of dayList) {
                leaves.push(vscode.Uri.joinPath(monthUri, d));
                if (leaves.length >= days) return leaves;
            }
        }
        if (leaves.length >= days) break;
    }
    return leaves;
}

async function subDirs(uri: vscode.Uri): Promise<string[]> {
    try {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        return entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n);
    } catch {
        return [];
    }
}

/**
 * Does a Codex session's cwd belong to one of the open workspace folders?
 *
 * Codex records `cwd` verbatim (e.g. "F:\\workspace\\proj" locally, "/home/me/proj" on a
 * server), so unlike Claude there is no encoded-directory heuristic to undo. We normalise
 * separators and case, since Windows paths differ in drive-letter case and slash direction
 * between VS Code and Codex.
 *
 * On a remote window the workspace folder's fsPath is the REMOTE path, which is exactly
 * what the remote Codex wrote — so the same comparison works on both hosts.
 */
export function cwdMatchesFolder(cwd: string, folderFsPath: string): boolean {
    const a = normalisePath(cwd);
    const b = normalisePath(folderFsPath);
    if (!a || !b) return false;
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function normalisePath(p: string): string {
    if (!p) return '';
    let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    // A drive letter means a Windows path regardless of which host we are running on:
    // a local Windows VS Code can be reading a remote Linux path and vice versa.
    const looksWindows = /^[a-zA-Z]:/.test(s);
    if (looksWindows || process.platform === 'darwin') s = s.toLowerCase();
    return s;
}
