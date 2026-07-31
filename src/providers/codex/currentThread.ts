// Resolve the Codex conversation selected in THIS VS Code window.
//
// Preferred signal: VS Code's stable tabGroups API exposes the UUID in Codex custom-editor
// tabs. Sidebar chats fall back to the OpenAI extension log belonging to this exact local
// or remote extension host. Only structural activity markers and UUIDs are retained.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readTextFile } from '../../core/fs';
import { log } from '../../core/logger';
import {
    CODEX_CONVERSATION_VIEW_TYPE,
    conversationIdFromCodexUri,
    selectionFromCodexLog
} from './currentThreadLog';

export type CurrentCodexThreadSource =
    | 'active-tab'
    | 'visible-tab'
    | 'codex-log'
    | 'remote-codex-log';

export interface CurrentCodexThread {
    conversationId: string;
    source: CurrentCodexThreadSource;
}

interface RemoteLogCandidate {
    codexLogUri: vscode.Uri;
    extensionHostPid: number | null;
    activationKey: string;
    activationMs: number | null;
    mtimeMs: number;
}

let trackerContext: vscode.ExtensionContext | null = null;
let trackerStartedAtMs = 0;
let codexLogUriPromise: Promise<vscode.Uri | null> | null = null;
let cachedLogMtimeMs = -1;
let cachedLogSize = -1;
let cachedLogConversationId: string | null = null;
let lastReportedKey = '';

/** Configure the per-window log and refresh when the selected UUID changes. */
export function initialiseCurrentCodexThreadTracking(
    context: vscode.ExtensionContext,
    onSelectionMayHaveChanged: () => void
): void {
    trackerContext = context;
    trackerStartedAtMs = Date.now();
    codexLogUriPromise = null;
    invalidateLogCache();

    let timer: NodeJS.Timeout | null = null;
    let lastObservedConversationId: string | null = null;
    const observe = async () => {
        invalidateLogCache();
        try {
            const nextConversationId = (await resolveCurrentCodexThread())?.conversationId ?? null;
            if (nextConversationId !== lastObservedConversationId) {
                lastObservedConversationId = nextConversationId;
                onSelectionMayHaveChanged();
            }
        } catch (e) {
            log(`[codex-current] selection refresh failed: ${e}`);
        }
    };
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void observe();
        }, 150);
    };

    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(schedule));
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(schedule));
    context.subscriptions.push(vscode.window.onDidChangeWindowState(schedule));
    context.subscriptions.push({ dispose: () => { if (timer) clearTimeout(timer); } });

    // Remote discovery can take a few seconds because the remote OpenAI extension host is
    // launched after the local UI extension host. Resolve it asynchronously, then attach a
    // watcher to that exact exthost directory and refresh immediately.
    void ensureCodexLogUri().then(uri => {
        if (!uri) return;
        registerLogWatcher(context, uri, schedule);
        schedule();
    }).catch(e => log(`[codex-current] log discovery failed: ${e}`));
}

export async function resolveCurrentCodexThread(): Promise<CurrentCodexThread | null> {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const activeTabId = conversationIdFromTab(activeTab);
    if (activeTabId) {
        return report({ conversationId: activeTabId, source: 'active-tab' });
    }

    // A focused Codex "new conversation" editor has no UUID yet and is stronger than an
    // older log marker. Sidebar new-chat state has no public VS Code representation; there
    // the last selected UUID remains until Codex emits a new UUID after the first message.
    if (isCodexCustomEditorTab(activeTab)) return report(null);

    const logId = await resolveFromWindowLog();
    if (logId) {
        const uri = await ensureCodexLogUri();
        const source: CurrentCodexThreadSource = uri?.scheme === 'vscode-remote'
            ? 'remote-codex-log'
            : 'codex-log';
        return report({ conversationId: logId, source });
    }

    const visibleTabId = resolveUniqueVisibleTab();
    if (visibleTabId) {
        return report({ conversationId: visibleTabId, source: 'visible-tab' });
    }
    return report(null);
}

function resolveUniqueVisibleTab(): string | null {
    const visible = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
        const id = conversationIdFromTab(group.activeTab);
        if (id) visible.add(id);
    }
    return visible.size === 1 ? [...visible][0] : null;
}

function isCodexCustomEditorTab(tab: vscode.Tab | undefined): boolean {
    return !!tab
        && tab.input instanceof vscode.TabInputCustom
        && tab.input.viewType === CODEX_CONVERSATION_VIEW_TYPE;
}

function conversationIdFromTab(tab: vscode.Tab | undefined): string | null {
    if (!tab || !(tab.input instanceof vscode.TabInputCustom)) return null;
    const input = tab.input;
    return conversationIdFromCodexUri(
        input.uri.scheme,
        input.uri.authority,
        input.uri.path,
        input.viewType
    );
}

async function resolveFromWindowLog(): Promise<string | null> {
    const uri = await ensureCodexLogUri();
    if (!uri) return null;

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.mtime === cachedLogMtimeMs && stat.size === cachedLogSize) {
            return cachedLogConversationId;
        }

        // Codex.log can include prompt text in unrelated diagnostics. The pure parser
        // extracts only activity booleans and UUIDs; the full text is discarded here.
        const parsed = selectionFromCodexLog(await readTextFile(uri));
        cachedLogMtimeMs = stat.mtime;
        cachedLogSize = stat.size;
        // `active=false` also means window blur. The newest active=true UUID is therefore
        // the durable per-window selection and survives focus changes and host reloads.
        cachedLogConversationId = parsed.conversationId ?? parsed.lastConversationId;
        if (parsed.ambiguous) {
            log(`[codex-current] multiple active markers; using last window selection ${parsed.lastConversationId ?? '(none)'}`);
        }
        return cachedLogConversationId;
    } catch {
        invalidateLogCache();
        return null;
    }
}

async function ensureCodexLogUri(): Promise<vscode.Uri | null> {
    if (codexLogUriPromise) return codexLogUriPromise;
    if (!trackerContext) return null;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.uri.scheme === 'vscode-remote' && folder.uri.authority) {
        log(`[codex-current] discovering remote OpenAI exthost log (authority=${folder.uri.authority})`);
        codexLogUriPromise = discoverRemoteCodexLogUri(trackerContext, folder);
    } else {
        const extensionHostLogDir = path.dirname(trackerContext.logUri.fsPath);
        const uri = vscode.Uri.file(path.join(extensionHostLogDir, 'openai.chatgpt', 'Codex.log'));
        log(`[codex-current] local window log: ${uri.fsPath}`);
        codexLogUriPromise = Promise.resolve(uri);
    }
    return codexLogUriPromise;
}

async function discoverRemoteCodexLogUri(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder
): Promise<vscode.Uri | null> {
    let fallback: RemoteLogCandidate | null = null;

    // The remote OpenAI extension normally activates a few seconds after this local UI
    // extension. Retry briefly so we do not bind to the previous remote exthost on reload.
    for (let attempt = 0; attempt < 12; attempt++) {
        const remotePid = readRemoteExtensionHostPidHint(context);
        const candidates = await scanRemoteLogCandidates(folder);
        if (candidates.length > 0) {
            fallback = chooseNewestRemoteCandidate(candidates);
            const pidMatch = remotePid == null
                ? null
                : candidates.find(candidate => candidate.extensionHostPid === remotePid) ?? null;
            if (pidMatch) {
                log(`[codex-current] remote log matched extension-host pid ${remotePid}: ${pidMatch.codexLogUri.path}`);
                return pidMatch.codexLogUri;
            }

            const fresh = candidates
                .filter(candidate => candidate.activationMs != null
                    && Math.abs(candidate.activationMs - trackerStartedAtMs) <= 120_000)
                .sort((a, b) => b.activationKey.localeCompare(a.activationKey))[0];
            if (fresh) {
                log(`[codex-current] remote log matched activation time: ${fresh.codexLogUri.path}`);
                return fresh.codexLogUri;
            }
        }
        if (attempt < 11) await delay(1000);
    }

    if (fallback) {
        log(`[codex-current] remote pid/time match unavailable; using newest activation: ${fallback.codexLogUri.path}`);
        return fallback.codexLogUri;
    }
    log('[codex-current] no remote OpenAI Codex.log found');
    return null;
}

async function scanRemoteLogCandidates(folder: vscode.WorkspaceFolder): Promise<RemoteLogCandidate[]> {
    const roots = await remoteServerLogRoots(folder);
    const candidates: RemoteLogCandidate[] = [];

    for (const logsRoot of roots) {
        const sessions = (await readDirectories(logsRoot)).sort().reverse().slice(0, 4);
        for (const sessionName of sessions) {
            const sessionUri = vscode.Uri.joinPath(logsRoot, sessionName);
            const exthosts = (await readDirectories(sessionUri))
                .filter(name => /^exthost\d+$/.test(name))
                .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));

            for (const exthost of exthosts) {
                const exthostUri = vscode.Uri.joinPath(sessionUri, exthost);
                const codexLogUri = vscode.Uri.joinPath(exthostUri, 'openai.chatgpt', 'Codex.log');
                let stat: vscode.FileStat;
                try {
                    stat = await vscode.workspace.fs.stat(codexLogUri);
                } catch {
                    continue;
                }

                let activationKey = '';
                try {
                    activationKey = latestActivationKey(await readTextFile(codexLogUri));
                } catch { /* candidate remains usable by mtime */ }

                let extensionHostPid: number | null = null;
                try {
                    const hostLog = await readTextFile(vscode.Uri.joinPath(exthostUri, 'remoteexthost.log'));
                    const match = /Extension host with pid (\d+) started/.exec(hostLog);
                    if (match) extensionHostPid = Number(match[1]);
                } catch { /* older layouts may omit this file */ }

                const activationMs = activationKey
                    ? Date.parse(activationKey.replace(' ', 'T'))
                    : Number.NaN;
                candidates.push({
                    codexLogUri,
                    extensionHostPid,
                    activationKey,
                    activationMs: Number.isNaN(activationMs) ? null : activationMs,
                    mtimeMs: stat.mtime
                });
            }
        }
    }
    return candidates;
}

async function remoteServerLogRoots(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    const homes = ['/root'];
    try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folder.uri.with({ path: '/home' }))) {
            if ((type & vscode.FileType.Directory) === vscode.FileType.Directory) homes.push(`/home/${name}`);
        }
    } catch { /* /home may not be readable */ }

    const roots: vscode.Uri[] = [];
    for (const home of homes) {
        for (const serverDir of ['.vscode-server', '.vscode-server-insiders']) {
            const uri = folder.uri.with({ path: `${home}/${serverDir}/data/logs` });
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) roots.push(uri);
            } catch { /* not this remote user's server home */ }
        }
    }
    return roots;
}

async function readDirectories(uri: vscode.Uri): Promise<string[]> {
    try {
        return (await vscode.workspace.fs.readDirectory(uri))
            .filter(([, type]) => (type & vscode.FileType.Directory) === vscode.FileType.Directory)
            .map(([name]) => name);
    } catch {
        return [];
    }
}

function chooseNewestRemoteCandidate(candidates: RemoteLogCandidate[]): RemoteLogCandidate {
    return [...candidates].sort((a, b) =>
        b.activationKey.localeCompare(a.activationKey) || b.mtimeMs - a.mtimeMs)[0];
}

function latestActivationKey(text: string): string {
    const regex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}).*Activating Codex extension/gm;
    let latest = '';
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) latest = match[1];
    return latest;
}

function readRemoteExtensionHostPidHint(context: vscode.ExtensionContext): number | null {
    try {
        const extensionHostLogDir = path.dirname(context.logUri.fsPath);
        const rendererLog = path.join(path.dirname(extensionHostLogDir), 'renderer.log');
        const text = readLocalFileTail(rendererLog, 2 * 1024 * 1024);
        const lastStart = text.lastIndexOf('Started local extension host with pid ');
        const relevant = lastStart >= 0 ? text.slice(lastStart) : text;
        const localMatch = /Started local extension host with pid (\d+)/.exec(relevant);
        const localPid = localMatch ? Number(localMatch[1]) : null;
        const remotePids: number[] = [];
        for (const match of relevant.matchAll(/\[Extension Host\] \(node:(\d+)\)/g)) {
            const pid = Number(match[1]);
            if (pid !== localPid) remotePids.push(pid);
        }
        return remotePids.at(-1) ?? null;
    } catch {
        return null;
    }
}

function readLocalFileTail(filePath: string, maxBytes: number): string {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function registerLogWatcher(
    context: vscode.ExtensionContext,
    logUri: vscode.Uri,
    schedule: () => void
): void {
    try {
        const exthostUri = logUri.with({ path: path.posix.dirname(path.posix.dirname(logUri.path)) });
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(exthostUri, 'openai.chatgpt/Codex.log')
        );
        watcher.onDidChange(schedule);
        watcher.onDidCreate(schedule);
        watcher.onDidDelete(schedule);
        context.subscriptions.push(watcher);
    } catch (e) {
        log(`[codex-current] Codex.log watcher unavailable; periodic refresh remains active: ${e}`);
    }
}

function invalidateLogCache(): void {
    cachedLogMtimeMs = -1;
    cachedLogSize = -1;
    cachedLogConversationId = null;
}

function report(value: CurrentCodexThread | null): CurrentCodexThread | null {
    const key = value ? `${value.source}:${value.conversationId}` : 'none';
    if (key !== lastReportedKey) {
        lastReportedKey = key;
        log(value
            ? `[codex-current] selected ${value.conversationId} via ${value.source}`
            : '[codex-current] no Codex conversation UUID resolved for this window');
    }
    return value;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
