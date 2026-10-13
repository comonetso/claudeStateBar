import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import { workspaceLabel } from './core/workspaceLabel';
import { ACTIVITY_ICONS } from './activityIcons';
import { log } from './core/logger';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The "Claude Activity" panel shell (2026-09-30). The workflow, background-task, Codex progress
// and Codex chat panels used to be four webview panels; they are now four tabs of this one. The
// shell owns the WebviewPanel, the tab bar and the workspace caption; each tab module keeps its
// own cards, messages and state and plugs in through registerActivityTab(). The webview half of
// the shell is media/activity.js (window.ActivityHost), loaded before every tab script.
//
// The exported signatures are a contract shared with the tab modules and extension.ts — do not
// rename, remove or change the parameters/return types of any export here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Tab order is display order, left to right. */
export type ActivityTabId = 'workflows' | 'background' | 'codexRuns' | 'codexChats';
export const ACTIVITY_TABS: readonly ActivityTabId[] = ['workflows', 'background', 'codexRuns', 'codexChats'];

/** Element-id prefix each tab must use for every id inside its pane (ids are document-wide). */
export const ACTIVITY_ID_PREFIX: Record<ActivityTabId, string> = {
    workflows: 'wf-',
    background: 'bg-',
    codexRuns: 'cx-',
    codexChats: 'cc-',
};

export interface ActivityTabModule {
    id: ActivityTabId;
    /** File names under media/ for this tab's stylesheet and script, e.g. 'workflows.css'. */
    css: string;
    js: string;
    /**
     * The pane's inner HTML (toolbar, sub line, lists…) — no <html>/<body>/<script>/<link>, no h1
     * title and no workspace-path row (the shell shows the path once, above the tabs). Every id
     * must start with ACTIVITY_ID_PREFIX[id].
     */
    bodyHtml(webview: vscode.Webview): string;
    /** A message the pane sent, with the shell's `tab` field removed. `{type:'ready'}` arrives here too. */
    onMessage(msg: any): void;
    /** The panel was closed: drop per-panel state (open cards, last pushed signature…). Keep cached data. */
    onDispose(): void;
}

export interface ActivityBadge {
    /** What is running now. 0 = nothing (tab shows its normal icon, no number). */
    running: number;
}

// ── shell state ───────────────────────────────────────────────────────────────────────────────

const VIEW_TYPE = 'claudeContextBarActivity';
/** workspaceState key: the tab the user last looked at in this workspace. */
const LAST_TAB_KEY = 'claudeContextBar.activityLastTab';

/** English captions, for a dictionary that does not have the act.* keys (yet). */
const FALLBACK: Record<string, string> = {
    'act.panelTitle': 'Claude Activity',
    'act.tab.workflows': 'Workflows',
    'act.tab.background': 'Background',
    'act.tab.codexRuns': 'Codex progress',
    'act.tab.codexChats': 'Codex chat',
    'menu.running': '{0} running',
};

const modules = new Map<ActivityTabId, ActivityTabModule>();
const createdHandlers = new Set<() => void>();
const tabChangedHandlers = new Set<(tab: ActivityTabId) => void>();
const shownHandlers = new Set<(tab: ActivityTabId) => void>();

let panel: vscode.WebviewPanel | null = null;
/** The context the open panel was created with — for workspaceState writes from webview messages. */
let panelContext: vscode.ExtensionContext | null = null;
let active: ActivityTabId | null = null;
/**
 * True while the panel is being created and the onActivityPanelCreated handlers run. A handler
 * that ends up in showActivityPanel() again (createOrShowXxx = attach + show) must not select its
 * own tab: the outer call, which knows what the user asked for, selects and reveals afterwards.
 */
let creating = false;
/**
 * The tab that was on screen when setActivityTabVisible hid it. If it is shown again before the
 * user or the host picks another tab, the panel goes back to it: a momentary misread of the
 * install state (installed_plugins.json read mid-write, say) must not leave the user on another
 * tab. The old separate Codex panel stayed open through such a flip.
 */
let bumpedFrom: ActivityTabId | null = null;

const badges: Record<ActivityTabId, number> = { workflows: 0, background: 0, codexRuns: 0, codexChats: 0 };
const visible: Record<ActivityTabId, boolean> = { workflows: true, background: true, codexRuns: true, codexChats: true };

function isTabId(v: unknown): v is ActivityTabId {
    return typeof v === 'string' && (ACTIVITY_TABS as readonly string[]).includes(v);
}

/** A tab the webview actually has a button for, and the host has not hidden. */
function isShown(tab: ActivityTabId): boolean {
    return modules.has(tab) && visible[tab];
}

function firstShownTab(): ActivityTabId | null {
    return ACTIVITY_TABS.find(isShown) ?? null;
}

function str(key: string): string {
    const v = getDict(creds.getLanguage())[key];
    return typeof v === 'string' ? v : (FALLBACK[key] ?? key);
}

function panelTitle(): string {
    const base = str('act.panelTitle');
    const ws = workspaceLabel();
    return ws ? `${base} · ${ws.short}` : base;
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * The tab to show: the requested one if it has a pane, else the last one the user saw (if it is
 * still shown), else the first shown tab.
 */
function resolveTab(context: vscode.ExtensionContext, tab?: ActivityTabId): ActivityTabId | null {
    if (tab && modules.has(tab)) return tab;
    const last = lastActivityTab(context);
    if (last && isShown(last)) return last;
    return firstShownTab() ?? ACTIVITY_TABS.find(t => modules.has(t)) ?? null;
}

function saveLastTab(context: vscode.ExtensionContext | null, tab: ActivityTabId): void {
    if (!context) return;
    void Promise.resolve(context.workspaceState.update(LAST_TAB_KEY, tab)).catch(() => { /* best effort */ });
}

function stateSnapshot(select: boolean): Record<string, unknown> {
    const b: Record<string, ActivityBadge> = {};
    for (const t of ACTIVITY_TABS) b[t] = { running: badges[t] };
    return {
        active,
        visible: { ...visible },
        badges: b,
        // Not in the contract's message shape; read only by media/activity.js. true = the host is
        // choosing the tab (open, reveal, a hidden tab fallback); false = a badge/visibility
        // refresh, which must not undo a tab the user clicked a moment before the host heard it.
        select,
    };
}

function postState(select: boolean): void {
    panel?.webview.postMessage({ type: 'act:state', ...stateSnapshot(select) });
}

function postI18n(): void {
    if (!panel) return;
    const lang = creds.getLanguage();
    panel.webview.postMessage({ type: 'i18n', dict: getDict(lang), lang });
}

// ── registration ──────────────────────────────────────────────────────────────────────────────

/** Called by each tab module once, at module load. */
export function registerActivityTab(mod: ActivityTabModule): void {
    if (!mod || !isTabId(mod.id)) return;
    // The panel HTML is built from the modules registered at creation time. A module that loads
    // later only appears the next time the panel is created (rebuilding the HTML would reload
    // every tab and lose its state).
    if (panel && !modules.has(mod.id)) log(`activityPanel: tab "${mod.id}" registered while the panel is open; it appears after reopening`);
    modules.set(mod.id, mod);
}

/**
 * Fires right after the panel is CREATED (not on a mere reveal), before any tab is shown. The host
 * uses it to attach every tab's callbacks and start filling every tab, so all four tabs work no
 * matter which one the panel was opened on.
 */
export function onActivityPanelCreated(fn: () => void): vscode.Disposable {
    createdHandlers.add(fn);
    return new vscode.Disposable(() => { createdHandlers.delete(fn); });
}

/** Fires when the user switches tabs in the panel (not when the host selects one). */
export function onActivityTabChanged(fn: (tab: ActivityTabId) => void): vscode.Disposable {
    tabChangedHandlers.add(fn);
    return new vscode.Disposable(() => { tabChangedHandlers.delete(fn); });
}

/**
 * Fires when the open panel comes back on screen after another editor tab covered it, with the tab
 * it shows. The host reads only the tab on screen (user's call, 2026-09-30), so it reads it here.
 */
export function onActivityPanelShown(fn: (tab: ActivityTabId) => void): vscode.Disposable {
    shownHandlers.add(fn);
    return new vscode.Disposable(() => { shownHandlers.delete(fn); });
}

// ── panel ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create the panel if needed, select a tab and reveal it (ViewColumn.Active, never waiting on a
 * scan). `tab` given → that tab (made visible even if hidden). `tab` omitted → the last tab the
 * user selected in this workspace (workspaceState), else the first visible tab.
 */
export function showActivityPanel(context: vscode.ExtensionContext, tab?: ActivityTabId): void {
    // Re-entered from an onActivityPanelCreated handler: the outer call selects and reveals.
    if (creating) return;
    const want = isTabId(tab) ? tab : undefined;
    // An explicit request shows the tab even if the host had hidden it.
    if (want && modules.has(want)) visible[want] = true;

    if (panel) {
        bumpedFrom = null;
        const next = resolveTab(context, want);
        if (next) { active = next; saveLastTab(context, next); }
        panel.reveal(vscode.ViewColumn.Active);
        postState(true);
        return;
    }

    creating = true;
    try {
        panelContext = context;
        // Pre-select so the first paint already shows the right pane; re-resolved below, after
        // the handlers had their chance to change visibility.
        active = resolveTab(context, want);
        const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
        const created = vscode.window.createWebviewPanel(
            VIEW_TYPE, panelTitle(), vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] }
        );
        panel = created;
        created.webview.html = getHtml(created.webview, context.extensionUri);
        created.onDidDispose(() => {
            // A panel that was replaced cannot reach here (there is only ever one), but a stale
            // dispose must never clear the state of a newer panel.
            if (panel !== created) return;
            panel = null;
            panelContext = null;
            active = null;
            bumpedFrom = null;
            for (const mod of modules.values()) {
                try { mod.onDispose(); } catch (e) { log(`activityPanel: ${mod.id}.onDispose failed: ${String(e)}`); }
            }
        }, null, context.subscriptions);
        created.webview.onDidReceiveMessage((msg) => onWebviewMessage(created, msg), null, context.subscriptions);
        let wasVisible = created.visible;
        created.onDidChangeViewState(e => {
            const now = e.webviewPanel.visible;
            const back = now && !wasVisible;
            wasVisible = now;
            if (!back || panel !== created || !active) return;
            const tab = active;
            for (const fn of Array.from(shownHandlers)) {
                try { fn(tab); } catch (e2) { log(`activityPanel: onActivityPanelShown handler failed: ${String(e2)}`); }
            }
        }, null, context.subscriptions);

        for (const fn of Array.from(createdHandlers)) {
            if (panel !== created) break;   // a handler closed it
            try { fn(); } catch (e) { log(`activityPanel: onActivityPanelCreated handler failed: ${String(e)}`); }
        }
    } finally {
        creating = false;
    }
    if (!panel) return;

    const next = resolveTab(context, want);
    if (next) { active = next; saveLastTab(context, next); }
    postState(true);
}

function onWebviewMessage(from: vscode.WebviewPanel, msg: any): void {
    if (from !== panel || !msg || typeof msg !== 'object') return;
    const type = typeof msg.type === 'string' ? msg.type : '';
    // Shell messages first: act:tab carries a `tab` field too.
    if (type.startsWith('act:')) {
        if (type === 'act:ready') {
            // The webview may have missed what was sent before it was listening.
            postState(true);
            postI18n();
        } else if (type === 'act:tab') {
            const tab = msg.tab;
            if (!isTabId(tab) || !modules.has(tab)) return;
            active = tab;
            bumpedFrom = null;
            saveLastTab(panelContext, tab);
            for (const fn of Array.from(tabChangedHandlers)) {
                try { fn(tab); } catch (e) { log(`activityPanel: onActivityTabChanged handler failed: ${String(e)}`); }
            }
        }
        return;
    }
    const tab = msg.tab;
    if (!isTabId(tab)) return;
    const mod = modules.get(tab);
    if (!mod) return;
    const { tab: _drop, ...rest } = msg;
    void _drop;
    try { mod.onMessage(rest); } catch (e) { log(`activityPanel: ${tab}.onMessage(${type}) failed: ${String(e)}`); }
}

export function isActivityPanelOpen(): boolean {
    return panel !== null;
}

/** Open and on screen — not behind another editor tab in its group. */
export function isActivityPanelVisible(): boolean {
    return panel !== null && panel.visible;
}

/** The tab currently selected in the open panel; null when the panel is closed. */
export function activeActivityTab(): ActivityTabId | null {
    return panel ? active : null;
}

/** The last tab selected in this workspace, or null if none was ever stored. */
export function lastActivityTab(context: vscode.ExtensionContext): ActivityTabId | null {
    const v = context.workspaceState.get<string>(LAST_TAB_KEY);
    return isTabId(v) ? v : null;
}

/**
 * Post a message to one tab's pane script. The shell adds `tab`. Returns false (and drops the
 * message) when the panel is not open.
 */
export function postToActivityTab(tab: ActivityTabId, msg: Record<string, unknown>): boolean {
    if (!panel) return false;
    panel.webview.postMessage({ ...msg, tab });
    return true;
}

/** Merge new running counts into the tab bar. Cached, so they apply when the panel opens later. */
export function setActivityBadges(next: Partial<Record<ActivityTabId, ActivityBadge>>): void {
    let changed = false;
    for (const t of ACTIVITY_TABS) {
        const b = next?.[t];
        if (!b) continue;
        const n = Number.isFinite(b.running) ? Math.max(0, Math.floor(b.running)) : 0;
        if (badges[t] !== n) { badges[t] = n; changed = true; }
    }
    if (changed) postState(false);
}

/** Show/hide tabs (e.g. the two Codex tabs when codex_rescue is not installed). Cached like badges. */
export function setActivityTabVisible(next: Partial<Record<ActivityTabId, boolean>>): void {
    let changed = false;
    for (const t of ACTIVITY_TABS) {
        const v = next?.[t];
        if (typeof v !== 'boolean') continue;
        if (visible[t] !== v) { visible[t] = v; changed = true; }
    }
    if (!changed || !panel) return;
    // The tab on screen was hidden: fall back to the first shown one. Not stored as the last
    // tab — the user did not pick it, and resolveTab already skips a hidden last tab.
    if (active && !isShown(active)) {
        const first = firstShownTab();
        if (first) { bumpedFrom = bumpedFrom ?? active; active = first; postState(true); return; }
    }
    // The tab this fallback moved away from is back: return to it (see bumpedFrom).
    if (bumpedFrom && isShown(bumpedFrom)) {
        const back = bumpedFrom;
        bumpedFrom = null;
        if (active !== back) { active = back; postState(true); return; }
    }
    postState(false);
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab (user's call, 2026-09-30): the next or previous shown tab, wrapping
 * round. Counts as the user switching tabs — stored as the last tab and announced through
 * onActivityTabChanged, so the host reads the new tab as it does for a click.
 */
export function cycleActivityTab(delta: number): void {
    if (!panel) return;
    const shown = ACTIVITY_TABS.filter(isShown);
    if (shown.length < 2) return;
    let i = active ? shown.indexOf(active) : -1;
    if (i < 0) i = 0;
    const next = shown[(i + (delta < 0 ? -1 : 1) + shown.length) % shown.length];
    active = next;
    bumpedFrom = null;
    saveLastTab(panelContext, next);
    postState(true);
    for (const fn of Array.from(tabChangedHandlers)) {
        try { fn(next); } catch (e) { log(`activityPanel: onActivityTabChanged handler failed: ${String(e)}`); }
    }
}

/** Language changed: retitle the panel and broadcast `{type:'i18n', dict, lang}` to the shell and every tab. */
export function pushActivityLanguage(): void {
    if (!panel) return;
    panel.title = panelTitle();
    postI18n();
}

// ── html ──────────────────────────────────────────────────────────────────────────────────────

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const lang = creds.getLanguage();
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)).toString();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';`;
    const tabs = ACTIVITY_TABS.filter(t => modules.has(t));

    const buttons = tabs.map(t => {
        const sel = t === active;
        // Hidden/selected/running state is applied by activity.js from data-state before any tab
        // script runs; the attributes here only spare the first paint a flash.
        return `      <button class="act-tab" type="button" role="tab" id="act-tab-${t}" data-tab="${t}"`
            + ` aria-controls="pane-${t}" aria-selected="${sel ? 'true' : 'false'}" tabindex="${sel ? '0' : '-1'}"${isShown(t) || sel ? '' : ' hidden'}>`
            + `<span class="act-ico"><span class="act-ico-idle">${ACTIVITY_ICONS[t]}</span><span class="act-ico-run">${ACTIVITY_ICONS.running}</span></span>`
            + `<span class="act-label" data-i18n="act.tab.${t}">${escHtml(str(`act.tab.${t}`))}</span>`
            + `<span class="act-count"></span></button>`;
    }).join('\n');

    const panes = tabs.map(t => {
        const mod = modules.get(t) as ActivityTabModule;
        let body = '';
        try { body = mod.bodyHtml(webview); } catch (e) { log(`activityPanel: ${t}.bodyHtml failed: ${String(e)}`); }
        return `  <section class="act-pane" id="pane-${t}" data-tab="${t}" role="tabpanel" aria-labelledby="act-tab-${t}"${t === active ? '' : ' hidden'}>\n${body}\n  </section>`;
    }).join('\n');

    const links = [`<link rel="stylesheet" href="${media('activity.css')}">`]
        .concat(tabs.map(t => `<link rel="stylesheet" href="${media((modules.get(t) as ActivityTabModule).css)}">`))
        .join('\n');
    const scripts = [`<script nonce="${nonce}" src="${media('activity.js')}"></script>`]
        .concat(tabs.map(t => `<script nonce="${nonce}" src="${media((modules.get(t) as ActivityTabModule).js)}"></script>`))
        .join('\n');

    const ws = workspaceLabel();
    const wsRow = ws
        ? `    <div class="act-ws" title="${escHtml(ws.full)}">${escHtml(ws.short)}</div>\n`
        : '';

    // The first state, so activity.js can set up the tab bar before the host's act:state (sent
    // once the webview reports act:ready) arrives. `strings` carries the shell's own captions
    // until the first i18n message.
    const init = {
        ...stateSnapshot(true),
        lang,
        strings: { 'menu.running': str('menu.running') },
    };

    // No inline <script> here, only src= references, so the template-literal hazard that
    // tools/check-webview.js guards against does not apply.
    return [
        '<!DOCTYPE html>',
        `<html lang="${lang}">`,
        '<head>',
        '<meta charset="UTF-8">',
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        links,
        '</head>',
        `<body class="act" data-state="${escHtml(JSON.stringify(init))}">`,
        '  <div class="act-top">',
        '    <nav class="act-tabs" role="tablist">',
        buttons,
        '    </nav>',
        wsRow + '  </div>',
        panes,
        scripts,
        '</body>',
        '</html>',
    ].join('\n');
}
