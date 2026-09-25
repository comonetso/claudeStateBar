import * as vscode from 'vscode';

// Where codex_rescue records can live, beyond the folders the window has open.
//
// The skill writes under the git root it ran in, so a run started in a linked worktree
// (`git worktree add`) lands in that worktree's docs/codex_rescue — not in the folder the
// window shows. On 2026-09-25 three runs in /home/yeogi_callcrew_wt/basic-missed never reached
// a window opened on /home/yeogi_callcrew and read as lost. So the Codex panels scan every
// working tree of the repository each window folder belongs to — the whole repository, from
// whichever tree the window has open (user's call).
//
// Read from the git dir's own files rather than `git worktree list`: this extension runs on
// the UI side, and a Remote-SSH folder is reachable only through workspace.fs, with no process
// to spawn there.

export interface CodexRoot {
    uri: vscode.Uri;
    /**
     * Set only for a tree that is not itself an open window folder: the folder name its cards
     * are tagged with, so a run from another tree is never mistaken for one from this window.
     */
    tag?: string;
    /** Full path for the tag's hover. */
    tagPath?: string;
}

interface RepoEntry {
    /** mtime of the window folder's `.git`, whose kind and contents decide `commonDir`. */
    dotGitMtime: number;
    commonDir: vscode.Uri;
    /** mtime of `<commonDir>/worktrees`, 0 when absent — it moves when a tree is added or removed. */
    worktreesMtime: number;
    trees: vscode.Uri[];
}

// Keyed by window folder. Every poll costs two stats per folder (its `.git`, and the worktrees
// directory); the files behind them are re-read only when one of those moved. Over SSH each
// read is a round trip, and this runs on the status-bar refresh even with no panel open.
const repoCache = new Map<string, RepoEntry>();

async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | null> {
    try { return await vscode.workspace.fs.stat(uri); } catch { return null; }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
    try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { return null; }
}

/**
 * A path as git wrote it, into a URI on the same host as `anchor`. Absolute paths are the
 * usual case; `git worktree add --relative-paths` writes relative ones, resolved against the
 * directory of the file that held them.
 */
function resolvePath(anchor: vscode.Uri, raw: string, relativeTo: vscode.Uri): vscode.Uri {
    const p = raw.trim().replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(p)) {
        return anchor.scheme === 'file' ? vscode.Uri.file(p) : anchor.with({ path: '/' + p });
    }
    if (p.startsWith('/')) return anchor.with({ path: p });
    return vscode.Uri.joinPath(relativeTo, p);
}

function parentOf(uri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(uri, '..');
}

function baseName(uri: vscode.Uri): string {
    const parts = uri.path.split('/').filter(Boolean);
    return parts[parts.length - 1] || uri.path;
}

// Windows paths compare case-insensitively; a remote Linux host's do not.
function sameKey(uri: vscode.Uri): string {
    const s = uri.toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Every working tree of the repository `folder` is the root of, `folder` included. */
async function treesOf(folder: vscode.Uri): Promise<vscode.Uri[]> {
    const dotGit = vscode.Uri.joinPath(folder, '.git');
    const st = await statOf(dotGit);
    if (!st) { repoCache.delete(folder.toString()); return []; }

    const key = folder.toString();
    const hit = repoCache.get(key);
    let commonDir: vscode.Uri;
    if (hit && hit.dotGitMtime === st.mtime) {
        commonDir = hit.commonDir;
    } else if (st.type & vscode.FileType.Directory) {
        commonDir = dotGit;
    } else {
        // A linked worktree: `.git` is a file pointing at <common>/worktrees/<name>, and that
        // directory's `commondir` points back at the shared git dir.
        const m = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? '');
        if (!m) return [];
        const ownGitDir = resolvePath(folder, m[1], folder);
        const common = (await readText(vscode.Uri.joinPath(ownGitDir, 'commondir')))?.trim();
        commonDir = common ? resolvePath(folder, common, ownGitDir) : parentOf(parentOf(ownGitDir));
    }

    const worktreesDir = vscode.Uri.joinPath(commonDir, 'worktrees');
    const wst = await statOf(worktreesDir);
    const worktreesMtime = wst?.mtime ?? 0;
    if (hit && hit.dotGitMtime === st.mtime && hit.worktreesMtime === worktreesMtime) return hit.trees;

    const trees: vscode.Uri[] = [];
    // The main working tree holds the common dir as its `.git`; a bare repository has none.
    if (baseName(commonDir) === '.git') trees.push(parentOf(commonDir));
    if (wst) {
        let names: [string, vscode.FileType][] = [];
        try { names = await vscode.workspace.fs.readDirectory(worktreesDir); } catch { /* raced a removal */ }
        for (const [name, type] of names) {
            if (!(type & vscode.FileType.Directory)) continue;
            const entryDir = vscode.Uri.joinPath(worktreesDir, name);
            const gitdir = (await readText(vscode.Uri.joinPath(entryDir, 'gitdir')))?.trim();
            // `gitdir` names the tree's own `.git` file; the tree is the directory holding it.
            if (gitdir) trees.push(parentOf(resolvePath(folder, gitdir, entryDir)));
        }
    }
    repoCache.set(key, { dotGitMtime: st.mtime, commonDir, worktreesMtime, trees });
    return trees;
}

/**
 * The open window folders, then every other working tree of their repositories, each once.
 * A tree git still lists but whose directory is gone is returned anyway — the caller's own
 * lookup of docs/codex_rescue finds nothing there and skips it.
 */
export async function codexRoots(): Promise<CodexRoot[]> {
    const folders = vscode.workspace.workspaceFolders || [];
    const seen = new Set<string>();
    const out: CodexRoot[] = [];
    for (const f of folders) {
        seen.add(sameKey(f.uri));
        out.push({ uri: f.uri });
    }
    for (const f of folders) {
        let trees: vscode.Uri[] = [];
        try { trees = await treesOf(f.uri); } catch { /* not a repository this host lets us read */ }
        for (const t of trees) {
            const k = sameKey(t);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ uri: t, tag: baseName(t), tagPath: t.scheme === 'file' ? t.fsPath : t.path });
        }
    }
    // Drop entries for folders no longer open.
    const open = new Set(folders.map(f => f.uri.toString()));
    for (const k of Array.from(repoCache.keys())) if (!open.has(k)) repoCache.delete(k);
    return out;
}
