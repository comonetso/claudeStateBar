// Discovers codex_rescue CHAT (핑퐁) conversations by reading the `*_chat_*.md` documents
// under `<workspace>/docs/codex_rescue/`.
//
// Why this reads documents and not `.log/`: the CHAT mode deliberately writes NO event
// stream. It is a synchronous 7–13s round trip whose whole point is to land in the chat
// window, so putting cards in the progress panel would only clutter it (user's call,
// 2026-08-22). The conversation document IS the record — so this panel parses that.
//
// 🔴 Everything goes through `vscode.workspace.fs`, never node `fs`. This extension is
// extensionKind "ui" and always runs on the local host; over Remote-SSH the workspace files
// live on the remote machine and node `fs` cannot see them at all. Paths are built with
// `Uri.joinPath`, never `path.join` on `fsPath` — a remote folder's `fsPath` comes back with
// Windows backslashes on a Windows host and would not survive the round trip.

import * as vscode from 'vscode';

/** One exchange: what Claude threw and what Codex threw back. */
export interface ChatTurn {
    type: 'turn';
    n: number;
    /** `HH:MM:SS` as send.sh recorded it. Absent on a malformed heading. */
    time?: string;
    claude: string;
    codex: string;
}

/**
 * A discontinuity in the conversation. These matter as much as the turns: without them a
 * reader cannot tell why the context suddenly changed, only that it did.
 *   broken     — the run died and send.sh discarded the thread
 *   superseded — `--new` closed this generation on purpose
 */
export interface ChatBreak {
    type: 'break';
    kind: 'broken' | 'superseded';
    time?: string;
    text: string;
}

export type ChatEntry = ChatTurn | ChatBreak;

export interface CodexChat {
    stamp: string;
    slug: string;
    /** Card heading. Falls back to the slug, which reads as a symbol rather than a sentence. */
    subject?: string;
    /** Machine the conversation started on. Absent on documents written before it was recorded. */
    origin?: string;
    /** Empty once the thread has been discarded — that is how a dead conversation looks. */
    threadId?: string;
    /** URI *string* of the document, so the webview can send it back to be opened. */
    docUri: string;
    /** Newest activity, for sorting and for the card's timestamp. */
    lastAtMs?: number;
    /**
     * A turn is in flight right now: send.sh drops `.log/.chat_<slug>.inflight` before calling
     * codex and removes it once the turn is safely in the document. CHAT is synchronous and
     * short, so this is usually true for only a few seconds — but that is exactly the window
     * where the panel would otherwise look frozen.
     */
    live: boolean;
    entries: ChatEntry[];
}

async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | null> {
    try {
        return await vscode.workspace.fs.stat(uri);
    } catch {
        return null;   // absent, mid-rename, or a permission blip — never fatal
    }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
        return null;
    }
}

async function listNames(dir: vscode.Uri): Promise<string[] | null> {
    try {
        return (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
    } catch {
        return null;
    }
}

/** `<folder>/docs/codex_rescue`, or null when this project doesn't use the skill. */
async function docsDir(folderUri: vscode.Uri): Promise<vscode.Uri | null> {
    const dir = vscode.Uri.joinPath(folderUri, 'docs', 'codex_rescue');
    const st = await statOf(dir);
    return st && (st.type & vscode.FileType.Directory) ? dir : null;
}

/** `260822_140040` → epoch ms. Used when the document carries no better timestamp. */
function parseStamp(stamp: string): number | undefined {
    const m = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
    if (!m) return undefined;
    const [, yy, mo, dd, hh, mi, ss] = m;
    const t = new Date(2000 + +yy, +mo - 1, +dd, +hh, +mi, +ss).getTime();
    return Number.isFinite(t) ? t : undefined;
}

/** Read one frontmatter key. Tolerates CRLF, which a Windows checkout can introduce. */
function fm(text: string, key: string): string | undefined {
    const end = text.indexOf('\n---', 3);
    const head = end > 0 ? text.slice(0, end) : text;
    const re = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm');
    const m = re.exec(head);
    const v = m ? m[1].replace(/\r$/, '').trim() : '';
    return v || undefined;
}

/**
 * Split the body into turns and breaks.
 *
 * Sections are found by `^## ` headings rather than by the `<!-- codex_rescue:turn N -->`
 * marker, even though the marker is the more robust signal: documents written before the
 * marker existed (2026-08-22, same day) have only the heading, and they are still worth
 * reading. The marker is an HTML comment, so it is simply skipped as content.
 */
function parseEntries(body: string): ChatEntry[] {
    const out: ChatEntry[] = [];
    // Keep the headings: split on a lookahead so each chunk starts with its own `## `.
    const chunks = body.split(/^(?=## )/m);

    for (const chunk of chunks) {
        const nl = chunk.indexOf('\n');
        const heading = (nl < 0 ? chunk : chunk.slice(0, nl)).replace(/\r$/, '').trim();
        if (!heading.startsWith('## ')) continue;
        const title = heading.slice(3).trim();
        const rest = nl < 0 ? '' : chunk.slice(nl + 1);

        const broken = /^⚠️\s*스레드 끊김(?:\s*·\s*(\S+))?/.exec(title);
        if (broken) {
            out.push({ type: 'break', kind: 'broken', time: broken[1], text: stripMarkers(rest).trim() });
            continue;
        }
        const superseded = /^⏹\s*새 대화로 전환(?:\s*·\s*(\S+))?/.exec(title);
        if (superseded) {
            out.push({ type: 'break', kind: 'superseded', time: superseded[1], text: stripMarkers(rest).trim() });
            continue;
        }

        const turn = /^(\d+)턴(?:\s*·\s*(\S+))?/.exec(title);
        if (!turn) continue;

        // Bodies are separated by the speaker lines send.sh writes. Splitting on them keeps
        // the message text byte-for-byte, which matters: this is the record of what was said.
        const text = stripMarkers(rest);
        const c = findSpeaker(text, '✳️', '클로드');
        const x = findSpeaker(text, '🔷', '코덱스');
        let claude = '', codex = '';
        if (c && x && x.at > c.at) {
            claude = text.slice(c.at + c.len, x.at).trim();
            codex = text.slice(x.at + x.len).trim();
        } else {
            // A document someone hand-edited, or a future format change. Show it rather than
            // dropping the turn — a visible oddity beats a silently missing exchange.
            codex = text.trim();
        }
        out.push({ type: 'turn', n: +turn[1], time: turn[2], claude, codex });
    }
    return out;
}

/** Drop the turn marker comment; it is bookkeeping for send.sh, not content. */
function stripMarkers(s: string): string {
    return s.replace(/^<!-- codex_rescue:turn \d+ -->\s*$/gm, '');
}

/**
 * Locate a speaker line, with or without its emoji.
 *
 * The emoji prefixes were added a few hours after CHAT shipped (2026-08-22), so the first
 * conversations recorded that day carry a bare `**클로드**`. Without this fallback those
 * documents parse as one undivided blob attributed to Codex — the whole exchange still shows,
 * but with the wrong speaker, which is worse than not showing it.
 */
function findSpeaker(text: string, emoji: string, name: string): { at: number; len: number } | null {
    const withEmoji = emoji + ' **' + name + '**';
    const at = text.indexOf(withEmoji);
    if (at >= 0) return { at, len: withEmoji.length };
    const plain = '**' + name + '**';
    const p = text.indexOf(plain);
    return p >= 0 ? { at: p, len: plain.length } : null;
}

/**
 * Scan one workspace folder for CHAT conversations, newest first.
 * Returns [] when the project has no conversations — which is how the panel stays empty
 * rather than wrong for projects that only ever used CONSULT/REVIEW.
 */
export async function discoverChats(folderUri: vscode.Uri, limit = 50): Promise<CodexChat[]> {
    const docs = await docsDir(folderUri);
    if (!docs) return [];
    const names = (await listNames(docs)) ?? [];

    const found: { stamp: string; slug: string; name: string }[] = [];
    for (const n of names) {
        const m = /^(\d{6}_\d{6})_chat_(.+)\.md$/.exec(n);
        if (m) found.push({ stamp: m[1], slug: m[2], name: n });
    }
    if (!found.length) return [];

    // Stamps are `ymd_His`, so lexical order is chronological.
    found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

    const logDir = vscode.Uri.joinPath(docs, '.log');
    const logNames = (await listNames(logDir)) ?? [];
    const inflight = new Set(
        logNames.map(n => /^\.chat_(.+)\.inflight$/.exec(n)?.[1]).filter((s): s is string => !!s));

    const out: CodexChat[] = [];
    for (const f of found.slice(0, limit)) {
        const uri = vscode.Uri.joinPath(docs, f.name);
        const text = await readText(uri);
        if (text === null) continue;
        const st = await statOf(uri);

        out.push({
            stamp: f.stamp,
            slug: fm(text, 'slug') || f.slug,
            subject: fm(text, 'subject'),
            origin: fm(text, 'origin'),
            threadId: fm(text, 'thread_id'),
            docUri: uri.toString(),
            lastAtMs: st?.mtime ?? parseStamp(f.stamp),
            // The marker is per-slug, not per-document: send.sh locks and marks by slug.
            live: inflight.has(f.slug),
            entries: parseEntries(text),
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Trash
//
// Same shape and same reasoning as the progress panel's trash (see runDiscovery): manual
// deletion MOVES the file instead of unlinking it, because a conversation document has no
// other safety net until it has actually been committed.
//
// 🔴 This is a SEPARATE directory from the progress panel's `.trash/` (user's call,
// 2026-08-22: "완전히 나눈다"). Sharing one directory would have worked with a name prefix,
// but keeping them apart means neither panel can ever surface or destroy the other's items —
// and a CHAT document and a CONSULT run can legitimately carry the same stamp.
//
// There is deliberately NO automatic cleanup here. The progress panel auto-deletes old run
// logs because those are bulk telemetry; a conversation is the record itself, and age is no
// reason to destroy it (user's call, same date).
// ---------------------------------------------------------------------------

const TRASH_DIR = '.chat_trash';

export interface TrashedChat {
    stamp: string;
    slug: string;
    subject?: string;
    deletedAt: number;
    turns: number;
    bytes: number;
}

interface ChatTrashMeta {
    schema: 1;
    kind: 'chat';
    stamp: string;
    slug: string;
    subject?: string;
    turns: number;
    deletedAt: number;
    /** File name, unchanged, so restore can put it back where it came from. */
    name: string;
}

async function ensureTrashDir(docs: vscode.Uri): Promise<vscode.Uri> {
    const root = vscode.Uri.joinPath(docs, TRASH_DIR);
    await vscode.workspace.fs.createDirectory(root);
    const ignore = vscode.Uri.joinPath(root, '.gitignore');
    if (!await statOf(ignore)) {
        try {
            await vscode.workspace.fs.writeFile(ignore, Buffer.from('*\n', 'utf8'));
        } catch { /* the directory still works without it */ }
    }
    return root;
}

async function readMeta(bin: vscode.Uri): Promise<ChatTrashMeta | null> {
    const raw = await readText(vscode.Uri.joinPath(bin, 'meta.json'));
    if (raw === null) return null;
    try {
        const m = JSON.parse(raw);
        return m && m.kind === 'chat' && typeof m.name === 'string' ? m as ChatTrashMeta : null;
    } catch {
        return null;
    }
}

/** Move one conversation into the trash. Returns false when there was nothing to move. */
export async function trashChat(folderUri: vscode.Uri, stamp: string, nowMs: number): Promise<boolean> {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return false;   // never accept a stamp we didn't parse ourselves
    const docs = await docsDir(folderUri);
    if (!docs) return false;

    const names = (await listNames(docs)) ?? [];
    const name = names.find(n => new RegExp('^' + stamp + '_chat_.+\\.md$').test(n));
    if (!name) return false;

    const src = vscode.Uri.joinPath(docs, name);
    const text = await readText(src);
    const root = await ensureTrashDir(docs);
    const bin = vscode.Uri.joinPath(root, stamp);
    // A conversation can be trashed, restored and trashed again; start clean so a stale
    // meta.json can never claim a file that is no longer there.
    try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* absent */ }
    await vscode.workspace.fs.createDirectory(bin);

    try {
        await vscode.workspace.fs.rename(src, vscode.Uri.joinPath(bin, name), { overwrite: true });
    } catch {
        try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* ignore */ }
        return false;
    }

    const meta: ChatTrashMeta = {
        schema: 1, kind: 'chat', stamp,
        slug: (text && fm(text, 'slug')) || (/^\d{6}_\d{6}_chat_(.+)\.md$/.exec(name)?.[1] ?? ''),
        subject: text ? fm(text, 'subject') : undefined,
        turns: text ? parseEntries(text).filter(e => e.type === 'turn').length : 0,
        deletedAt: nowMs, name,
    };
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(bin, 'meta.json'),
                                        Buffer.from(JSON.stringify(meta), 'utf8'));
    return true;
}

/** Everything in the chat trash, newest deletion first. */
export async function listChatTrash(folderUri: vscode.Uri): Promise<TrashedChat[]> {
    const docs = await docsDir(folderUri);
    if (!docs) return [];
    const root = vscode.Uri.joinPath(docs, TRASH_DIR);
    let dirs: [string, vscode.FileType][];
    try {
        dirs = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return [];   // no trash yet
    }

    const out: TrashedChat[] = [];
    for (const [name, type] of dirs) {
        if (!(type & vscode.FileType.Directory)) continue;
        const bin = vscode.Uri.joinPath(root, name);
        const meta = await readMeta(bin);
        if (!meta) continue;
        const st = await statOf(vscode.Uri.joinPath(bin, meta.name));
        if (!st) continue;   // purged on its own; a row that restores nothing helps no one
        out.push({
            stamp: meta.stamp, slug: meta.slug, subject: meta.subject,
            deletedAt: meta.deletedAt, turns: meta.turns, bytes: st.size,
        });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export interface ChatRestoreResult {
    restored: boolean;
    /** Set when something already occupies the original path. */
    conflict?: string;
}

/**
 * Put a trashed conversation back.
 *
 * An existing file at the destination is never overwritten: codex_rescue reuses a stamp when
 * it re-runs, so the name a trashed file wants can legitimately belong to newer work.
 */
export async function restoreChat(folderUri: vscode.Uri, stamp: string): Promise<ChatRestoreResult> {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return { restored: false };
    const docs = await docsDir(folderUri);
    if (!docs) return { restored: false };
    const bin = vscode.Uri.joinPath(docs, TRASH_DIR, stamp);
    const meta = await readMeta(bin);
    if (!meta) return { restored: false };

    const src = vscode.Uri.joinPath(bin, meta.name);
    if (!await statOf(src)) return { restored: false };
    const dst = vscode.Uri.joinPath(docs, meta.name);
    if (await statOf(dst)) return { restored: false, conflict: meta.name };

    try {
        await vscode.workspace.fs.rename(src, dst, { overwrite: false });
    } catch {
        return { restored: false, conflict: meta.name };
    }
    try { await vscode.workspace.fs.delete(bin, { recursive: true, useTrash: false }); } catch { /* ignore */ }
    return { restored: true };
}

/** Delete one trashed conversation for good. */
export async function purgeChat(folderUri: vscode.Uri, stamp: string): Promise<boolean> {
    if (!/^\d{6}_\d{6}$/.test(stamp)) return false;
    const docs = await docsDir(folderUri);
    if (!docs) return false;
    try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(docs, TRASH_DIR, stamp),
                                         { recursive: true, useTrash: false });
        return true;
    } catch {
        return false;
    }
}

/** Empty the chat trash. Returns how many conversations were destroyed. */
export async function emptyChatTrash(folderUri: vscode.Uri): Promise<number> {
    let n = 0;
    for (const it of await listChatTrash(folderUri)) {
        if (await purgeChat(folderUri, it.stamp)) n++;
    }
    return n;
}
