// Live view of codex_rescue CHAT (핑퐁) conversations — the counterpart to the Codex
// progress tab, for the short back-and-forth mode rather than the long one-shot runs.
//
// The two are deliberately separate surfaces (user's call, 2026-08-22): the progress tab is
// for watching something that takes minutes, this one is for re-reading an exchange whose
// turns already scrolled past in the chat window. Their trash cans are separate too. Since
// 2026-09-30 both are tabs of the one Activity panel (activityPanel.ts), which owns the
// webview; this module is the host half of the 'codexChats' tab, and its script and styles
// live in media/codexchat.js and media/codexchat.css.

import * as vscode from 'vscode';
import * as creds from './credentials';
import { getDict } from './i18n';
import { registerActivityTab, showActivityPanel, isActivityPanelOpen, postToActivityTab } from './activityPanel';

/** One exchange as the panel renders it. Mirrors ChatTurn from chatDiscovery. */
export interface ChatTurnView {
    type: 'turn';
    n: number;
    time?: string;
    claude: string;
    codex: string;
}

/** A discontinuity — why the context changed. Mirrors ChatBreak from chatDiscovery. */
export interface ChatBreakView {
    type: 'break';
    kind: 'broken' | 'superseded';
    time?: string;
    text: string;
}

/** The turn in flight: Claude has spoken, Codex has not answered. Mirrors ChatPending. */
export interface ChatPendingView {
    type: 'pending';
    n: number;
    time?: string;
    claude: string;
}

export type ChatEntryView = ChatTurnView | ChatBreakView | ChatPendingView;

export interface CodexChatView {
    stamp: string;
    slug: string;
    subject?: string;
    origin?: string;
    /** Empty once the thread was discarded — the conversation can no longer be continued. */
    threadId?: string;
    /** URI *string*, not a path: over Remote-SSH only the URI can still address the document. */
    docUri: string;
    lastAtMs?: number;
    live: boolean;
    entries: ChatEntryView[];
    /**
     * Set when the conversation lives in another working tree of this repository rather than
     * a folder this window has open: that tree's folder name, and its full path for the hover.
     */
    tag?: string;
    tagPath?: string;
    /**
     * Part of this session: in flight, or written since the earliest status-bar Claude session of
     * this workspace began (set by the host, 2026-09-30). The tab folds the others into one
     * "earlier" row. Absent reads as true, so a list the host has not marked shows as before.
     */
    current?: boolean;
}

/** One trashed conversation as the drawer lists it. */
export interface ChatTrashView {
    stamp: string;
    slug: string;
    subject?: string;
    deletedAt: number;
    turns: number;
    bytes: number;
}

export interface ChatPanelCallbacks {
    onOpenDoc: (docUri: string) => void;
    /** Delete button on a card — moves it to the trash. No confirmation: it is reversible. */
    onDelete: (stamp: string) => void;
    onTrashOpen: () => void;
    onRestore: (stamp: string) => void;
    /** Destroy for good. The host confirms first — this one is NOT reversible. */
    onPurge: (stamp: string) => void;
    onEmptyTrash: () => void;
}

let callbacks: ChatPanelCallbacks | null = null;
let lastSignature: string | null = null;
/** Latest list handed over, kept across a close so a reopened panel shows it at once. */
let lastChats: CodexChatView[] | null = null;

/** True while the Activity panel is open, whichever tab shows — same as the other three tabs. */
export function isChatPanelOpen(): boolean { return isActivityPanelOpen(); }

/**
 * Cheap change detector, so an unchanged poll costs no postMessage and no re-render.
 * Turn count and the live flag are what actually move; the body text of a turn never
 * changes once written (send.sh only appends).
 */
function signature(chats: CodexChatView[]): string {
    return chats.map(c =>
        c.stamp + ':' + (c.tag || '') + ':' + c.entries.length + ':' + (c.live ? '1' : '0') + ':' + (c.threadId || '-')
        + ':' + (c.current === false ? 'o' : 'c')
    ).join('|');
}

/**
 * Hand over the callbacks and whatever list is already known, without creating, revealing or
 * switching anything. The host calls this for every tab when the Activity panel is created, so
 * this tab works whichever tab the panel was opened on; an open panel gets the list at once.
 */
export function attachChatTab(chats: CodexChatView[] | null, cb: ChatPanelCallbacks): void {
    callbacks = cb;
    if (chats) lastChats = chats;
    if (isActivityPanelOpen() && lastChats) pushChats(lastChats);
}

/**
 * Opens without waiting for a scan (user's call, 2026-09-25: panels must never open late). Pass
 * what is already known, or null; the caller starts a scan and `pushChats` fills the tab in.
 */
export function createOrShowChatPanel(
    context: vscode.ExtensionContext,
    chats: CodexChatView[] | null,
    cb: ChatPanelCallbacks
): void {
    attachChatTab(chats, cb);
    showActivityPanel(context, 'codexChats');
}

/** Hand the trash drawer its contents. Unconditional: the drawer only opens on request. */
export function pushChatTrash(items: ChatTrashView[]): void {
    postToActivityTab('codexChats', { type: 'trash', items });
}

export function pushChats(chats: CodexChatView[]): void {
    lastChats = chats;
    if (!isActivityPanelOpen()) return;
    const sig = signature(chats);
    if (sig === lastSignature) return;
    lastSignature = sig;
    postToActivityTab('codexChats', { type: 'chats', chats });
}

function onMessage(msg: any): void {
    if (msg?.type === 'ready') {
        const lang = creds.getLanguage();
        postToActivityTab('codexChats', { type: 'i18n', dict: getDict(lang), lang });
        lastSignature = null;
        if (lastChats) pushChats(lastChats);
    } else if (msg?.type === 'open' && typeof msg.path === 'string') {
        callbacks?.onOpenDoc(msg.path);
    } else if (msg?.type === 'delete' && typeof msg.stamp === 'string') {
        callbacks?.onDelete(msg.stamp);
    } else if (msg?.type === 'trashOpen') {
        callbacks?.onTrashOpen();
    } else if (msg?.type === 'restore' && typeof msg.stamp === 'string') {
        callbacks?.onRestore(msg.stamp);
    } else if (msg?.type === 'purge' && typeof msg.stamp === 'string') {
        callbacks?.onPurge(msg.stamp);
    } else if (msg?.type === 'emptyTrash') {
        callbacks?.onEmptyTrash();
    }
}

/** The pane's markup. The heading is gone — the shell's tab caption says what this is. */
function bodyHtml(): string {
    return /* html */ `
  <div class="sub" data-i18n="cxc.sub">Short back-and-forth exchanges with Codex.</div>
  <div class="toolbar">
    <button class="fbtn" id="cc-trashBtn" data-i18n="cxc.trash">Trash</button>
  </div>
  <div id="cc-drawer"></div>
  <div id="cc-list"><div class="empty" data-i18n="wf.loading">Loading…</div></div>
  <button class="jump" id="cc-jumpBtn" style="display:none" data-i18n="cxc.newReply">New reply &#8595;</button>
`;
}

registerActivityTab({
    id: 'codexChats',
    css: 'codexchat.css',
    js: 'codexchat.js',
    bodyHtml,
    onMessage,
    // The panel closed: a reopened one starts from scratch and must get the list again.
    onDispose: () => { lastSignature = null; },
});
