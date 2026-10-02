import * as vscode from 'vscode';

// The codex_rescue run ledger — which Claude conversation started which run, and in which folder.
//
// A run's records land under the folder it ran in (`<root>/docs/codex_rescue/.log/`), so a run that
// this window's Claude conversation started in another folder — another repository, or no
// repository at all — never reached this window's Codex progress tab. Since 1.17.3 the plugin
// (send.sh, cr_write_ledger) also records each run on the host it ran on:
//
//   <home>/.claude/codex_rescue/runs/<conversation id>/<stamp>_<12 hex of sha256(root)>.json
//   {"schema":1,"session":"<id>","stamp":"<stamp>","root":"<run folder>","started_at":"…","mode":"…","kind":"…"}
//
// The conversation id is Claude Code's session id, the `<id>.jsonl` name under ~/.claude/projects.
// `root` is "C:/Users/…" on Windows and an absolute path elsewhere. Unknown fields are ignored. A
// follow-up turn rewrites the same file atomically with the same session, stamp and root, so a
// record read once stays valid; the writer's `<name>.tmp.*` files never match RECORD_RE.
//
// Only this window's own conversations are looked up (user's call): a run another
// conversation started elsewhere stays out of this window. Only `~/.claude` on the window's host
// is read — the PC for a local window, the server for a Remote-SSH one.
//
// Cost: the listing only changes when a run starts, so it is re-read when the host marks it stale
// (once per status-bar pass), never on the 2s Codex poll; each record is read once and kept.

export interface LedgerRun {
    /** The Claude conversation that started the run (its folder name in the ledger). */
    session: string;
    stamp: string;
    /** The run's folder as the plugin wrote it. */
    root: string;
}

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const STAMP_RE = /^\d{6}_\d{6}$/;
const RECORD_RE = /^(\d{6}_\d{6})_[0-9a-f]{12}\.json$/;

/**
 * Records already read, by URI string; null for one read whole but not usable (another schema,
 * fields that do not match its name), so it is not fetched again each pass. Dropped once the
 * file leaves the listing.
 */
const records = new Map<string, LedgerRun | null>();

let listing: { key: string; runs: LedgerRun[] } | null = null;
let stale = true;
let reading: Promise<LedgerRun[]> | null = null;

/** The next readLedger lists the directories again. */
export function markLedgerStale(): void {
    stale = true;
}

function isNotFound(e: unknown): boolean {
    return e instanceof vscode.FileSystemError && e.code === 'FileNotFound';
}

/** undefined: could not be read or parsed — tried again on the next listing. null: not usable. */
async function readRecord(uri: vscode.Uri, session: string, stamp: string): Promise<LedgerRun | null | undefined> {
    let o: any;
    try {
        o = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
    } catch {
        return undefined;
    }
    if (!o || typeof o !== 'object' || o.schema !== 1) return null;
    if (o.session !== session || o.stamp !== stamp || !STAMP_RE.test(stamp)) return null;
    if (typeof o.root !== 'string' || !o.root) return null;
    return { session, stamp, root: o.root };
}

/**
 * The runs `sessions` started, from the ledger directory `runsDir` (`<home>/.claude/codex_rescue/runs`).
 * Answers from the last listing until markLedgerStale; calls landing while a read is in flight
 * share it. A listing that fails for any reason other than "not there" keeps what it had, so a
 * remote hiccup does not drop the cards for a pass.
 */
export function readLedger(runsDir: vscode.Uri, sessions: ReadonlySet<string>): Promise<LedgerRun[]> {
    const key = runsDir.toString() + '\n' + [...sessions].sort().join(',');
    if (!stale && listing && listing.key === key) return Promise.resolve(listing.runs);
    if (reading) return reading;
    stale = false;
    const prev = listing?.runs ?? [];
    reading = (async () => {
        try {
            const runs = await readAll(runsDir, sessions, prev);
            listing = { key, runs };
            return runs;
        } finally {
            reading = null;
        }
    })();
    return reading;
}

async function readAll(runsDir: vscode.Uri, sessions: ReadonlySet<string>, prev: LedgerRun[]): Promise<LedgerRun[]> {
    if (!sessions.size) return [];
    let folders: [string, vscode.FileType][];
    try {
        folders = await vscode.workspace.fs.readDirectory(runsDir);
    } catch (e) {
        return isNotFound(e) ? [] : prev.filter(r => sessions.has(r.session));
    }
    const out: LedgerRun[] = [];
    const seen = new Set<string>();
    for (const [session, type] of folders) {
        if (!(type & vscode.FileType.Directory) || !sessions.has(session) || !SESSION_RE.test(session)) continue;
        const dir = vscode.Uri.joinPath(runsDir, session);
        let names: [string, vscode.FileType][];
        try {
            names = await vscode.workspace.fs.readDirectory(dir);
        } catch (e) {
            if (!isNotFound(e)) out.push(...prev.filter(r => r.session === session));
            continue;
        }
        for (const [name, ft] of names) {
            const m = RECORD_RE.exec(name);
            if (!m || !(ft & vscode.FileType.File)) continue;
            const uri = vscode.Uri.joinPath(dir, name);
            const k = uri.toString();
            let rec = records.get(k);
            if (rec === undefined) {
                rec = await readRecord(uri, session, m[1]);
                if (rec === undefined) continue;
                records.set(k, rec);
            }
            seen.add(k);
            if (rec) out.push(rec);
        }
    }
    for (const k of [...records.keys()]) if (!seen.has(k)) records.delete(k);
    return out;
}

/**
 * The run folder as a URI on the same host as `home` (the window's `~/.claude`). Null for a path
 * the contract does not allow (relative or empty).
 */
export function ledgerRootUri(home: vscode.Uri, root: string): vscode.Uri | null {
    const p = root.trim().replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(p)) {
        return home.scheme === 'file' ? vscode.Uri.file(p) : home.with({ path: '/' + p });
    }
    if (p.startsWith('/')) {
        return home.scheme === 'file' ? vscode.Uri.file(p) : home.with({ path: p });
    }
    return null;
}

/**
 * A folder's identity for "is this one of the window's own trees": trailing slashes dropped, and
 * case folded where paths are case-insensitive (local Windows; a remote Linux host's are not —
 * the same rule as repoRoots.ts).
 */
export function folderKey(uri: vscode.Uri): string {
    const trimmed = uri.path.replace(/\/+$/, '');
    const s = (trimmed && trimmed !== uri.path ? uri.with({ path: trimmed }) : uri).toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? s.toLowerCase() : s;
}

/** The folder's own name, for the card's chip. */
export function folderName(uri: vscode.Uri): string {
    const parts = uri.path.split('/').filter(Boolean);
    return parts[parts.length - 1] || uri.path;
}
