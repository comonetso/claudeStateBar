// Live view of codex_rescue CHAT (핑퐁) conversations — the counterpart to the Codex
// progress panel, for the short back-and-forth mode rather than the long one-shot runs.
//
// The two panels are deliberately separate surfaces (user's call, 2026-08-22): the progress
// panel is for watching something that takes minutes, this one is for re-reading an exchange
// whose turns already scrolled past in the chat window. Their trash cans are separate too.
//
// 🔴 The script below lives inside the `return /* html */` template literal, which tsc only
// ever sees as a string. A stray backtick — INCLUDING one inside a comment or a CSS rule —
// terminates the literal early and splits the generated JS in two: the panel then renders
// its static HTML and nothing else works, in English, with no cards. Use single quotes and
// string concatenation only, write newlines as a doubled escape, and after ANY edit run:
//     node tools/check-webview.js out/codexChatPanel.js

import * as vscode from 'vscode';
import * as creds from './credentials';
import { getDict } from './i18n';

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

let panel: vscode.WebviewPanel | null = null;
let callbacks: ChatPanelCallbacks | null = null;
let lastSignature: string | null = null;

export function isChatPanelOpen(): boolean { return panel !== null; }

function panelTitle(): string {
    const v = getDict(creds.getLanguage())['cxc.panelTitle'];
    return typeof v === 'string' ? v : 'Codex Chat';
}

/**
 * Cheap change detector, so an unchanged poll costs no postMessage and no re-render.
 * Turn count and the live flag are what actually move; the body text of a turn never
 * changes once written (send.sh only appends).
 */
function signature(chats: CodexChatView[]): string {
    return chats.map(c =>
        c.stamp + ':' + c.entries.length + ':' + (c.live ? '1' : '0') + ':' + (c.threadId || '-')
    ).join('|');
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

export function createOrShowChatPanel(
    context: vscode.ExtensionContext,
    chats: CodexChatView[],
    cb: ChatPanelCallbacks
): void {
    callbacks = cb;
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        pushChats(chats);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'claudeContextBarCodexChat',
        panelTitle(),
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    lastSignature = null;
    panel.webview.html = getHtml(panel.webview);
    panel.onDidDispose(() => { panel = null; lastSignature = null; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
            panel?.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()) });
            lastSignature = null; pushChats(chats);
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
    }, null, context.subscriptions);
}

/** Hand the trash drawer its contents. Unconditional: the drawer only opens on request. */
export function pushChatTrash(items: ChatTrashView[]): void {
    if (!panel) return;
    panel.webview.postMessage({ type: 'trash', items });
}

export function pushChats(chats: CodexChatView[]): void {
    if (!panel) return;
    const sig = signature(chats);
    if (sig === lastSignature) return;
    lastSignature = sig;
    panel.webview.postMessage({ type: 'chats', chats });
}

export function pushChatLanguage(): void {
    if (!panel) return;
    panel.title = panelTitle();   // the tab caption is host-side, so it needs its own update
    panel.webview.postMessage({ type: 'i18n', dict: getDict(creds.getLanguage()) });
}

function getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  .toolbar { display:flex; align-items:center; gap:6px; justify-content:flex-end; margin-bottom:10px; }
  .fbtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none; border-radius:4px; padding:2px 11px; cursor:pointer; font-size:1em; line-height:1.4; }
  .fbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  h1 { font-size:1.2em; margin:0 0 4px 0; }
  .sub { color: var(--vscode-descriptionForeground); font-size:.85em; margin-bottom:16px; }
  .empty { color: var(--vscode-descriptionForeground); padding:24px 0; text-align:center; }

  .chat { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:10px 14px; margin-bottom:12px; }
  .chat-head { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
  .arrow { flex-shrink:0; width:12px; color: var(--vscode-descriptionForeground); transition: transform .12s; }
  .chat.collapsed .arrow { transform: rotate(-90deg); }
  .chat-name { font-weight:600; font-size:1.05em; flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip { font-size:.72em; padding:1px 7px; border-radius:4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); flex-shrink:0; letter-spacing:.3px; }
  /* Started on another machine: the thread cannot be resumed here, so it reads as a note,
     not as a state. Outlined rather than filled. */
  .chip.origin { background:transparent; color: var(--vscode-descriptionForeground); border:1px solid var(--vscode-panel-border); }
  .chat-time { flex-shrink:0; color: var(--vscode-descriptionForeground); font-size:.8em; white-space:nowrap; font-variant-numeric: tabular-nums; }
  .spacer { flex:1 1 auto; }
  .badge { font-size:.8em; padding:2px 9px; border-radius:10px; white-space:nowrap; flex-shrink:0; }
  .badge.live { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
  .badge.dead { background: var(--vscode-descriptionForeground, #8b949e); color: var(--vscode-editor-background, #1e1e1e); }
  .del-btn { flex-shrink:0; background:transparent; border:none; color: var(--vscode-descriptionForeground); cursor:pointer; font-size:1em; padding:2px 6px; border-radius:4px; }
  .del-btn:hover { background: var(--vscode-statusBarItem-errorBackground, #f85149); color:#fff; }
  .chat-body { margin-top:8px; }
  .chat.collapsed .chat-body { display:none; }
  .meta { color: var(--vscode-descriptionForeground); font-size:.78em; font-family: var(--vscode-editor-font-family); margin-bottom:10px; line-height:1.6; }
  .doclink { color: var(--vscode-textLink-foreground); cursor:pointer; text-decoration:none; }
  .doclink:hover { text-decoration:underline; }

  .turn { margin:0 0 14px 0; }
  /* The whole header line is the fold handle, not just the arrow — a 12px target for something
     used this often is a nuisance. */
  .turn-head { display:flex; align-items:baseline; gap:7px; cursor:pointer; user-select:none; margin-bottom:5px; }
  .turn-head:hover .turn-no { color: var(--vscode-foreground); }
  .tarrow { flex-shrink:0; width:9px; font-size:.6em; color: var(--vscode-descriptionForeground); transition: transform .12s; }
  .turn.folded .tarrow { transform: rotate(-90deg); }
  .turn-no { color: var(--vscode-descriptionForeground); font-size:.75em; font-variant-numeric: tabular-nums; flex-shrink:0; }
  /* Only shown while folded: the first line of the question, so a folded turn still says what
     it was about. Clipped rather than wrapped — the fold exists to keep it to one line. */
  .turn-peek { color: var(--vscode-descriptionForeground); font-size:.8em; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.8; }
  .turn.folded .say { display:none; }
  .say { display:flex; gap:8px; margin-bottom:7px; align-items:flex-start; }
  .who { flex-shrink:0; font-size:.85em; font-weight:600; width:66px; padding-top:1px; }
  /* Same colours as the status bar provider glyphs and the chat-window prefixes:
     orange is Claude, blue is Codex. Reading who spoke should not need the label. */
  .who.claude { color:#d98b45; }
  .who.codex  { color:#5aa9e6; }
  .msg { flex:1 1 auto; min-width:0; white-space:pre-wrap; word-break:break-word; line-height:1.55; font-size:.93em; }
  /* The answer that has not arrived yet. Dimmed and italic so it never reads as something
     Codex actually said. */
  .say.waiting .msg { color: var(--vscode-descriptionForeground); font-style:italic; }
  .dots { display:inline-block; animation: blink 1.2s steps(1,end) infinite; }
  @keyframes blink { 0%,60% { opacity:1; } 61%,100% { opacity:.25; } }

  /* Only appears when a new turn landed while the reader was scrolled up. Clicking it is the
     only thing that moves the viewport in that case. */
  .jump { position:fixed; right:22px; bottom:22px; z-index:20; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; border-radius:14px; padding:6px 15px; cursor:pointer; font-size:.85em; box-shadow:0 2px 8px rgba(0,0,0,.35); }
  .jump:hover { background: var(--vscode-button-hoverBackground); }

  .brk { margin:0 0 14px 0; padding:8px 11px; border-left:2px solid #d29922; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); border-radius:0 4px 4px 0; font-size:.85em; line-height:1.5; white-space:pre-wrap; }
  .brk.superseded { border-left-color: var(--vscode-descriptionForeground); }
  .brk-title { font-weight:600; margin-bottom:3px; }

  .drawer { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:10px 14px; margin-bottom:14px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.06)); }
  .drawer-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .drawer-title { font-weight:600; }
  .trow { display:flex; align-items:center; gap:8px; padding:5px 0; border-top:1px solid var(--vscode-panel-border); font-size:.9em; }
  .trow:first-of-type { border-top:none; }
  .tname { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tinfo { color: var(--vscode-descriptionForeground); font-size:.8em; flex-shrink:0; }
  .tbtn { flex-shrink:0; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none; border-radius:4px; padding:2px 9px; cursor:pointer; font-size:.85em; }
  .tbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tbtn.danger:hover { background: var(--vscode-statusBarItem-errorBackground, #f85149); color:#fff; }
</style>
</head>
<body>
  <h1 data-i18n="cxc.heading">Codex chat</h1>
  <div class="sub" data-i18n="cxc.sub">Short back-and-forth exchanges with Codex.</div>
  <div class="toolbar">
    <button class="fbtn" id="trashBtn" data-i18n="cxc.trash">Trash</button>
  </div>
  <div id="drawer"></div>
  <div id="list"></div>
  <button class="jump" id="jumpBtn" style="display:none" data-i18n="cxc.newReply">New reply &#8595;</button>

<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  let dict = {};
  let chats = [];
  let collapsed = {};
  let drawerOpen = false;
  // Turn folds, but only the ones the reader set by hand: true is folded, false is open, and an
  // absent key means nobody has touched that turn, so the focus rule below decides it.
  let folded = {};
  // One turn per conversation reads as the current one; everything else folds down to its first
  // line. Which turn that is depends on why you are looking (user's call, 2026-08-23): opening
  // the panel or a past conversation means reading it from the top, so the FIRST turn opens —
  // while a turn arriving in a conversation you are already in means the LAST one opens.
  let focus = {};
  // Entry count per conversation as of the previous message, which is how an arrival is told
  // apart from a re-render carrying the same turns.
  let seenCount = {};

  // How close to the bottom still counts as being at the bottom. There is no principled value
  // here; 80px is roughly a line and a half, enough that a stray wheel notch does not count as
  // 'the reader scrolled away'. Easy to change if it feels wrong in use.
  const BOTTOM_SLACK = 80;
  let lastCount = null;    // total entries last render, to tell an arrival from a re-render
  let jumpShown = false;
  let firstPaint = true;   // consumed by the first render that actually has content

  function scroller() { return document.documentElement; }
  function atBottom() {
    const el = scroller();
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= BOTTOM_SLACK;
  }
  function toBottom() { window.scrollTo(0, scroller().scrollHeight); }
  function showJump(on) {
    jumpShown = on;
    const b = document.getElementById('jumpBtn');
    if (b) b.style.display = on ? '' : 'none';
  }

  function t(key) {
    const v = dict[key];
    return typeof v === 'string' ? v : key;
  }
  function tn(key, n) {
    return t(key).split('{0}').join(String(n));
  }
  function applyStatic() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const v = dict[el.getAttribute('data-i18n')];
      if (typeof v === 'string') el.textContent = v;
    });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function kb(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    return Math.round(n / 1024) + ' KB';
  }

  function firstLine(s) {
    const v = String(s == null ? '' : s).trim();
    if (!v) return '';
    const nl = v.indexOf('\\n');
    return nl < 0 ? v : v.slice(0, nl);
  }

  /** Turn number of the first or last exchange in a conversation; null if it has none yet. */
  function edgeTurnNo(c, wantLast) {
    let n = null;
    for (let i = 0; i < c.entries.length; i++) {
      const e = c.entries[i];
      if (e.type !== 'turn' && e.type !== 'pending') continue;
      if (n === null || wantLast) n = e.n;
      if (n !== null && !wantLast) break;
    }
    return n;
  }

  /**
   * Whether a turn draws folded. A hand-set fold always wins — reading an older turn is a
   * deliberate act, and an answer landing elsewhere must not undo it.
   */
  function foldedNow(c, e) {
    const v = folded[c.stamp + '#' + e.n];
    if (v === true || v === false) return v;
    return focus[c.stamp] !== e.n;
  }

  /**
   * Move the focus, once per conversation per message. A conversation seen for the first time
   * focuses its opening turn; one that just grew focuses what arrived.
   */
  function refocus(c) {
    const before = seenCount[c.stamp];
    const now = c.entries.length;
    seenCount[c.stamp] = now;
    if (before === undefined) focus[c.stamp] = edgeTurnNo(c, false);
    else if (now > before) focus[c.stamp] = edgeTurnNo(c, true);
  }

  /**
   * The fold handle. A pending turn keeps the same key as the turn it becomes, so folding one
   * mid-flight does not spring back open the moment the answer lands.
   *
   * The rendered state rides along in data-fold: the click handler has to flip what is on screen,
   * and for an untouched turn that is the focus rule's answer, not anything stored in the map.
   */
  function turnHead(key, e, isFolded) {
    let h = '<div class="turn-head" data-turn="' + esc(key) + '" data-fold="' + (isFolded ? '1' : '0') + '">';
    h += '<span class="tarrow">&#9660;</span>';
    h += '<span class="turn-no">' + tn('cxc.turnNo', e.n) + (e.time ? '  ·  ' + esc(e.time) : '') + '</span>';
    if (isFolded) {
      const peek = firstLine(e.claude);
      if (peek) h += '<span class="turn-peek">' + esc(peek) + '</span>';
    }
    return h + '</div>';
  }

  function turnHtml(c, e) {
    const key = c.stamp + '#' + e.n;
    const isFolded = foldedNow(c, e);
    let h = '<div class="turn' + (isFolded ? ' folded' : '') + '">';
    h += turnHead(key, e, isFolded);
    if (e.claude) {
      h += '<div class="say"><div class="who claude">' + esc(t('cxc.claude')) + '</div>'
         + '<div class="msg">' + esc(e.claude) + '</div></div>';
    }
    if (e.codex) {
      h += '<div class="say"><div class="who codex">' + esc(t('cxc.codex')) + '</div>'
         + '<div class="msg">' + esc(e.codex) + '</div></div>';
    }
    return h + '</div>';
  }

  /** Claude has spoken and Codex has not answered yet — the question shows immediately. */
  function pendingHtml(c, e) {
    const key = c.stamp + '#' + e.n;
    const isFolded = foldedNow(c, e);
    let h = '<div class="turn' + (isFolded ? ' folded' : '') + '">';
    h += turnHead(key, e, isFolded);
    if (e.claude) {
      h += '<div class="say"><div class="who claude">' + esc(t('cxc.claude')) + '</div>'
         + '<div class="msg">' + esc(e.claude) + '</div></div>';
    }
    h += '<div class="say waiting"><div class="who codex">' + esc(t('cxc.codex')) + '</div>'
       + '<div class="msg">' + esc(t('cxc.waiting')) + '<span class="dots">&#8230;</span></div></div>';
    return h + '</div>';
  }

  function breakHtml(e) {
    const isBroken = e.kind === 'broken';
    const cls = isBroken ? 'brk' : 'brk superseded';
    const title = isBroken ? t('cxc.broken') : t('cxc.superseded');
    let h = '<div class="' + cls + '">';
    h += '<div class="brk-title">' + esc(title) + (e.time ? '  ·  ' + esc(e.time) : '') + '</div>';
    if (e.text) h += esc(e.text);
    return h + '</div>';
  }

  function chatHtml(c) {
    const isCollapsed = collapsed[c.stamp] !== false;
    const turns = c.entries.filter(function (e) { return e.type === 'turn'; }).length;
    let h = '<div class="chat' + (isCollapsed ? ' collapsed' : '') + '" data-stamp="' + esc(c.stamp) + '">';
    h += '<div class="chat-head" data-toggle="' + esc(c.stamp) + '">';
    h += '<span class="arrow">&#9660;</span>';
    h += '<span class="chat-name">' + esc(c.subject || c.slug) + '</span>';
    h += '<span class="chip">' + tn('cxc.turns', turns) + '</span>';
    if (c.origin) h += '<span class="chip origin">' + esc(c.origin) + '</span>';
    h += '<span class="chat-time">' + esc(when(c.lastAtMs)) + '</span>';
    h += '<span class="spacer"></span>';
    if (c.live) {
      h += '<span class="badge live">' + esc(t('cxc.live')) + '</span>';
    } else if (!c.threadId) {
      h += '<span class="badge dead">' + esc(t('cxc.ended')) + '</span>';
    }
    h += '<button class="del-btn" data-del="' + esc(c.stamp) + '" title="' + esc(t('cxc.delete')) + '">&#128465;</button>';
    h += '</div>';

    h += '<div class="chat-body">';
    // A conversation whose first turn is still in flight has no document yet — nothing to link.
    if (c.docUri) {
      h += '<div class="meta"><span class="doclink" data-open="' + esc(c.docUri) + '">'
         + esc(c.stamp) + '_chat_' + esc(c.slug) + '.md</span></div>';
    }
    for (let i = 0; i < c.entries.length; i++) {
      const e = c.entries[i];
      if (e.type === 'turn') h += turnHtml(c, e);
      else if (e.type === 'pending') h += pendingHtml(c, e);
      else h += breakHtml(e);
    }
    h += '</div></div>';
    return h;
  }

  /**
   * Re-render the list, and put the viewport back where the reader had it.
   *
   * The whole list is replaced wholesale, which on its own throws the scroll position away.
   * So: if the reader was at the bottom, follow the conversation down; otherwise restore the
   * exact offset. Nothing else is allowed to move the viewport — a turn arriving while someone
   * reads an older one must not yank the page.
   *
   * The very first paint is the exception. An empty page counts as being at the bottom, so the
   * old rule scrolled the panel down the moment it had content — which now contradicts the point
   * of opening the first turn. Opening the panel leaves you at the top.
   */
  function render() {
    const stick = atBottom();
    const keepY = window.scrollY;
    const list = document.getElementById('list');
    if (!chats.length) {
      list.innerHTML = '<div class="empty">' + esc(t('cxc.empty')) + '</div>';
      return;
    }
    let h = '';
    for (let i = 0; i < chats.length; i++) h += chatHtml(chats[i]);
    list.innerHTML = h;
    if (firstPaint) { firstPaint = false; return; }
    if (stick) { toBottom(); showJump(false); }
    else { window.scrollTo(0, keepY); }
  }

  function renderTrash(items) {
    const d = document.getElementById('drawer');
    if (!drawerOpen) { d.innerHTML = ''; return; }
    let h = '<div class="drawer"><div class="drawer-head">';
    h += '<span class="drawer-title">' + esc(t('cxc.trashTitle')) + '</span>';
    h += '<span class="spacer"></span>';
    if (items.length) {
      h += '<button class="tbtn danger" id="emptyBtn">' + esc(t('cxc.emptyTrash')) + '</button>';
    }
    h += '</div>';
    if (!items.length) {
      h += '<div class="tinfo">' + esc(t('cxc.trashEmpty')) + '</div>';
    } else {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        h += '<div class="trow">';
        h += '<span class="tname">' + esc(it.subject || it.slug) + '</span>';
        h += '<span class="tinfo">' + tn('cxc.turns', it.turns) + '  ·  ' + esc(kb(it.bytes))
           + '  ·  ' + esc(when(it.deletedAt)) + '</span>';
        h += '<span class="spacer"></span>';
        h += '<button class="tbtn" data-restore="' + esc(it.stamp) + '">' + esc(t('cxc.restore')) + '</button>';
        h += '<button class="tbtn danger" data-purge="' + esc(it.stamp) + '">' + esc(t('cxc.purge')) + '</button>';
        h += '</div>';
      }
    }
    d.innerHTML = h + '</div>';
  }

  document.addEventListener('click', function (ev) {
    let el = ev.target;
    while (el && el !== document.body) {
      if (el.hasAttribute && el.hasAttribute('data-del')) {
        vscodeApi.postMessage({ type: 'delete', stamp: el.getAttribute('data-del') });
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-open')) {
        vscodeApi.postMessage({ type: 'open', path: el.getAttribute('data-open') });
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-restore')) {
        vscodeApi.postMessage({ type: 'restore', stamp: el.getAttribute('data-restore') });
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-purge')) {
        vscodeApi.postMessage({ type: 'purge', stamp: el.getAttribute('data-purge') });
        return;
      }
      if (el.id === 'emptyBtn') {
        vscodeApi.postMessage({ type: 'emptyTrash' });
        return;
      }
      if (el.id === 'jumpBtn') {
        toBottom();
        showJump(false);
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-turn')) {
        // Flip what is on screen rather than the stored map — a turn the focus rule folded has
        // no entry there yet, and reading its absence as 'open' would fold it twice.
        folded[el.getAttribute('data-turn')] = el.getAttribute('data-fold') !== '1';
        render();
        return;
      }
      if (el.id === 'trashBtn') {
        drawerOpen = !drawerOpen;
        if (drawerOpen) vscodeApi.postMessage({ type: 'trashOpen' });
        else renderTrash([]);
        return;
      }
      if (el.hasAttribute && el.hasAttribute('data-toggle')) {
        const st = el.getAttribute('data-toggle');
        collapsed[st] = collapsed[st] === false;
        render();
        return;
      }
      el = el.parentNode;
    }
  });

  window.addEventListener('message', function (ev) {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'i18n') {
      dict = m.dict || {};
      applyStatic();
      render();
      return;
    }
    if (m.type === 'chats') {
      const wasAtBottom = atBottom();
      chats = m.chats || [];
      // Newest conversation opens by default; the rest stay folded. Re-reading almost always
      // means the one that just happened.
      let count = 0;
      for (let i = 0; i < chats.length; i++) {
        if (collapsed[chats[i].stamp] === undefined) collapsed[chats[i].stamp] = i !== 0;
        refocus(chats[i]);
        count += chats[i].entries.length;
      }
      // Only an actual arrival raises the button — not the first paint, and not a re-render
      // that happens to carry the same turns.
      const grew = lastCount !== null && count > lastCount;
      lastCount = count;
      render();
      if (grew && !wasAtBottom) showJump(true);
      return;
    }
    if (m.type === 'trash') {
      renderTrash(m.items || []);
      return;
    }
  });

  // Scrolling back down yourself dismisses the button — it has nothing left to offer.
  window.addEventListener('scroll', function () {
    if (jumpShown && atBottom()) showJump(false);
  });

  vscodeApi.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
