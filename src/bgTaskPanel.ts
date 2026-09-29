import * as vscode from 'vscode';
import { getDict } from './i18n';
import * as creds from './credentials';
import { registerActivityTab, showActivityPanel, isActivityPanelOpen, postToActivityTab } from './activityPanel';

// The Background tab of the activity panel (activityPanel.ts, 2026-09-30 — it was a panel of its
// own until then), in the sessions the status bar shows: commands Claude ran with
// `run_in_background` and monitors in one group, ordinary commands that ran long in another. The
// point, in the user's words (2026-09-22), is to see what ran in the background and which commands
// took long. Modelled on the remote-control view's background list minus what that list mixes
// in — workflows keep their own tab, and commands a workflow's agents started are left out. It
// only watches: nothing on disk records a process id, so there is no safe way to stop a task from
// here. The script and stylesheet live in media/bgtasks.{js,css}, for the reason workflowPanel.ts gives.

export interface BgTaskView {
    key: string;
    taskId: string;
    kind: 'command' | 'monitor' | 'foreground';
    description: string;
    command: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
    startedAt: number;
    endedAt?: number;
    exitCode?: number;
    summary?: string;
    /** First eight characters of the session id. */
    session: string;
    eventCount: number;
    /**
     * The output, when it was sent: a running background task always, anything finished once the
     * user opens it. Null when the file is gone. Absent when not sent — and always absent for a
     * running foreground command, whose output is only recorded when it ends.
     */
    output?: string | null;
}

export type BgTaskGroupId = 'background' | 'long';

export interface BgTaskGroup {
    running: BgTaskView[];
    /** Newest first, at most the limit the host applies. */
    finished: BgTaskView[];
    /** Finished tasks there are in all, cleared ones excluded. */
    finishedTotal: number;
}

export interface BgTaskPanelData {
    background: BgTaskGroup;
    long: BgTaskGroup;
    /** How long an ordinary command must run to be listed, in minutes. */
    longMinutes: number;
}

export interface BgTaskPanelCallbacks {
    /** A finished group's trash button: hide that group's finished tasks from the list. */
    onClearFinished: (group: BgTaskGroupId) => void;
    /** The user opened a finished card — answer by pushing its output. */
    onOpen: (key: string) => void;
    onClose: (key: string) => void;
}

let callbacks: BgTaskPanelCallbacks | null = null;
let lastPushedSignature: string | null = null;
// Null until the first scan: the tab then opens on its loading line (see createOrShow).
let lastData: BgTaskPanelData | null = null;
const openCards = new Set<string>();

/** Whether the activity panel (which holds this tab) is open, whichever tab it shows. */
export function isBgTaskPanelOpen(): boolean { return isActivityPanelOpen(); }
export function getOpenBgTaskKeys(): string[] { return [...openCards]; }

/**
 * Opens without waiting for a scan (user's call, 2026-09-25: panels must never open late). Pass
 * what is already known, or null; the caller scans and `pushBgTasks` fills the tab in.
 */
export function createOrShowBgTaskPanel(
    context: vscode.ExtensionContext,
    data: BgTaskPanelData | null,
    cb: BgTaskPanelCallbacks
): void {
    attachBgTaskTab(data, cb);
    showActivityPanel(context, 'background');
}

/**
 * Sets the callbacks and data without creating, revealing or switching to the panel; pushes the
 * data if the panel is already open. The host calls this for every tab when the panel is created.
 */
export function attachBgTaskTab(data: BgTaskPanelData | null, cb: BgTaskPanelCallbacks): void {
    callbacks = cb;
    if (data) lastData = data;
    if (lastData) pushBgTasks(lastData);
}

function handleMessage(msg: any): void {
    const k = typeof msg?.key === 'string' ? msg.key : '';
    switch (msg?.type) {
        case 'ready':
            postToActivityTab('background', { type: 'i18n', dict: getDict(creds.getLanguage()), lang: creds.getLanguage() });
            lastPushedSignature = null;
            if (lastData) pushBgTasks(lastData);
            break;
        case 'clearFinished':
            if (msg?.group === 'background' || msg?.group === 'long') callbacks?.onClearFinished(msg.group);
            break;
        case 'open': if (k) { openCards.add(k); callbacks?.onOpen(k); } break;
        case 'close': if (k) { openCards.delete(k); callbacks?.onClose(k); } break;
    }
}

function handleDispose(): void {
    lastPushedSignature = null;
    openCards.clear();
}

export function pushBgTasks(data: BgTaskPanelData): void {
    lastData = data;
    if (!isActivityPanelOpen()) return;
    const sig = JSON.stringify(data);
    if (sig === lastPushedSignature) return;
    lastPushedSignature = sig;
    postToActivityTab('background', { type: 'tasks', data });
}

// The pane's markup. The title and workspace-path rows are gone: the shell shows the path once,
// above the tabs. Every id carries the tab's prefix (ids are document-wide across the four tabs).
function bodyHtml(): string {
    return `  <div class="toolbar">
    <span class="spacer"></span>
    <span class="flabel" data-i18n="wf.fontSize">Font size</span>
    <button class="fbtn" data-font="dec" data-i18n-title="wf.fontSmaller" title="Smaller">A−</button>
    <button class="fbtn" data-font="inc" data-i18n-title="wf.fontLarger" title="Larger">A+</button>
  </div>
  <div class="scope" id="bg-scope"></div>
  <div class="sub" id="bg-sub" data-i18n="wf.autoRefreshing">Auto-refreshing with the status bar…</div>
  <div id="bg-list"><div class="empty" data-i18n="wf.loading">Loading…</div></div>
`;
}

registerActivityTab({
    id: 'background',
    css: 'bgtasks.css',
    js: 'bgtasks.js',
    bodyHtml,
    onMessage: handleMessage,
    onDispose: handleDispose,
});
