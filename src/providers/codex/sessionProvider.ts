// Codex session provider — turns rollout files into the shared SessionInfo model.
//
// Deliberately independent of findActiveSessions() (docs §18.1): Claude discovery keeps its
// encoded-directory scan and /clear supersession, Codex uses cwd matching and task
// lifecycle. They meet only at SessionInfo, which the shared renderer consumes.
//
// Works on local and Remote-SSH windows alike. Discovery goes through vscode.workspace.fs
// (routed to the remote host by VS Code), and tailReader picks byte-range vs whole-file
// reads from the URI scheme.

import * as vscode from 'vscode';
import * as path from 'path';
import { SessionInfo } from '../../core/sessionTypes';
import { log } from '../../core/logger';
import {
    resolveCodexHomeUri,
    resolveLocalCodexHomeUri,
    listRecentRollouts,
    findRolloutBySessionId,
    cwdMatchesFolder,
    CodexRolloutFile
} from './discovery';
import { readSession, pruneCache } from './tailReader';
import { contextPercentage, lifecycle, completionMarker, CodexAccumulator } from './rolloutParser';
import { getOriginatorLabel } from './display';
import { resolveCurrentCodexThread } from './currentThread';

/** Matches the Claude side: at most five sessions compete for status-bar space. */
const MAX_CODEX_SESSIONS = 5;

export function isCodexEnabled(): boolean {
    return vscode.workspace.getConfiguration('claudeContextBar').get<boolean>('codex.enabled', true);
}

// Resolving the home probes /root and /home/* on a remote host, which is several round
// trips — cache it like the Claude provider caches its base URI. Reset when the workspace
// folders or the codex.home setting change.
let cachedHome: vscode.Uri | null | undefined; // undefined = unresolved

export function resetCodexHome(): void {
    cachedHome = undefined;
}

/**
 * Locate the Codex state directory for whichever host we are reading from.
 * Returns null when Codex is not installed there — the caller then does nothing at all,
 * which is why leaving the feature enabled by default costs nothing on non-Codex machines.
 */
export async function getCodexHomeUri(): Promise<vscode.Uri | null> {
    if (cachedHome !== undefined) return cachedHome;
    const configured = vscode.workspace.getConfiguration('claudeContextBar').get<string>('codex.home', '');
    const home = await resolveCodexHomeUri(configured);
    if (!home && configured && configured.trim()) {
        // Loud on purpose: a typo'd override would otherwise look identical to "Codex not
        // installed", and the user would have no idea their setting was the cause.
        log(`[codex] configured codex.home does not exist — no Codex sessions will be shown: ${configured}`);
    } else if (home) {
        log(`[codex] home resolved → ${home.toString()}`);
    }
    cachedHome = home;
    return home;
}

export async function findCodexSessions(): Promise<SessionInfo[]> {
    if (!isCodexEnabled()) return [];

    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const idleTimeout = config.get<number>('idleTimeout', 180);
    const hideAfterRaw = config.get<number>('hideAfter', 86400);
    const hideAfter = Math.max(hideAfterRaw, idleTimeout);
    const scope = config.get<string>('scope', 'workspace');
    const selected = scope === 'workspace' ? await resolveCurrentCodexThread() : null;

    // `workspace` is the default user-facing mode. For Codex it means the conversation
    // displayed by this VS Code window, not every historical rollout whose creation cwd
    // happens to match the folder. No unambiguous selection means no guessed context item.
    if (scope === 'workspace' && !selected) return [];

    const now = Date.now();
    const idleThreshold = now - idleTimeout * 1000;
    const hideThreshold = now - hideAfter * 1000;

    const folders = vscode.workspace.workspaceFolders;
    const home = await getCodexHomeUri();
    let files: CodexRolloutFile[] = [];

    if (scope === 'workspace' && selected) {
        const found = home
            ? await findRolloutBySessionId(home, selected.conversationId)
            : null;
        if (found) {
            files = [found];
        } else {
            // This extension is a UI extension. In a Remote-SSH window the OpenAI Codex
            // webview can still run on the local UI host and persist its selected thread in
            // the local CODEX_HOME. Only try this compatibility path when codex.home was not
            // explicitly pinned; an explicit override remains authoritative.
            const configuredHome = config.get<string>('codex.home', '').trim();
            const localHome = !configuredHome ? await resolveLocalCodexHomeUri() : null;
            const sameHome = !!(home && localHome && home.toString() === localHome.toString());
            const localFound = localHome && !sameHome
                ? await findRolloutBySessionId(localHome, selected.conversationId)
                : null;
            if (localFound) files = [localFound];
        }
        if (files.length === 0) {
            log(`[codex-current] selected conversation rollout not found: ${selected.conversationId}`);
            return [];
        }
    } else {
        if (!home) return [];
        // Explicit `scope: all` preserves the historical machine-wide recent-session view.
        const scanDays = config.get<number>('codex.scanDays', 3);
        files = await listRecentRollouts(home, hideThreshold, scanDays);
    }
    if (files.length === 0) return [];

    const sessions: SessionInfo[] = [];
    const keepInCache = new Set<string>();

    for (const f of files) {
        const acc = await readSession(f);
        if (!acc) continue;
        keepInCache.add(f.uri.toString());

        // Sub-agent threads (source = {subagent:{…}}) belong to the agent viewer, not the
        // session bar. Older ones carry no parent link at all, so showing them would put
        // an unattributable entry next to the real session.
        if (acc.isSubagent) continue;

        const pct = contextPercentage(acc);
        // No usable token report yet (brand-new session, or Codex omitted the window).
        // Skipping mirrors the Claude side's `totalTokens > 0` gate instead of rendering 0%.
        if (pct === null || !acc.last) continue;

        const lastUpdated = acc.lastActivityAt ?? new Date(f.mtimeMs);
        const state = lifecycle(acc);

        sessions.push(toSessionInfo(acc, f.uri, pct, lastUpdated, state === 'active', idleThreshold, folders));
    }

    pruneCache(keepInCache);

    sessions.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
    if (scope === 'workspace') return sessions.slice(0, 1);
    applyStableNumbering(sessions);
    return sessions.slice(0, MAX_CODEX_SESSIONS);
}

function toSessionInfo(
    acc: CodexAccumulator,
    uri: vscode.Uri,
    percentage: number,
    lastUpdated: Date,
    active: boolean,
    idleThreshold: number,
    folders: readonly vscode.WorkspaceFolder[] | undefined
): SessionInfo {
    // Prefer the open folder's basename so Claude and Codex entries for the same project
    // render with an identical name (and therefore an identical colour).
    let displayName = acc.cwd ? basenameOf(acc.cwd) : 'codex';
    if (folders) {
        const match = folders.find(folder => cwdMatchesFolder(acc.cwd, folder.uri.fsPath));
        if (match) displayName = path.basename(match.uri.fsPath);
    }

    const usage = acc.rateLimits
        ? {
            primary: acc.rateLimits.primary,
            secondary: acc.rateLimits.secondary,
            planType: acc.rateLimits.planType,
            hasCredits: acc.rateLimits.hasCredits,
            observedAt: acc.rateLimits.observedAt
        }
        : null;

    return {
        provider: 'codex',
        projectName: displayName,
        projectPath: acc.cwd,
        sessionId: (acc.sessionId || basenameOf(uri.path)).substring(0, 8),
        // The URI string keys the status bar, hide/restore map and beep gates, exactly as
        // the Claude sessionFile does.
        sessionFile: uri.toString(),
        // Codex reports cached input as a subset of input_tokens — echoing it into the
        // "cache read" slot would double-count in the tooltip table, so it stays separate.
        inputTokens: acc.last?.inputTokens ?? 0,
        cacheReadTokens: acc.last?.cachedInputTokens ?? 0,
        cacheCreationTokens: 0,
        totalTokens: acc.last?.totalTokens ?? 0,
        percentage,
        lastUpdated,
        model: acc.model,
        speed: '',
        effortLevel: acc.effort,
        contextLimit: acc.contextLimit,
        // Never surface Codex prompt text: rollouts contain full user messages.
        firstMessage: '',
        sessionCreated: acc.sessionCreated,
        wasCleared: false,
        isIdle: lastUpdated.getTime() <= idleThreshold,
        lastActivityAt: acc.lastActivityAt,
        // task_complete is a far cleaner completion signal than Claude's end_turn
        // heuristic; feeding it into the same field reuses the existing debounce as-is.
        lastAssistantEndTurnAt: completionMarker(acc),
        pendingQuestionAt: null,
        pendingToolUseAt: null,
        pendingToolUseName: null,
        codexOriginator: getOriginatorLabel(acc.originator),
        codexUsage: usage,
        codexActive: active,
        codexCumulativeTokens: acc.total?.totalTokens ?? 0
    };
}

/**
 * Last path segment for either separator style. path.basename alone is wrong here: a
 * Windows cwd read from a remote rollout (or vice versa) uses the other host's separator.
 */
function basenameOf(p: string): string {
    const cleaned = p.replace(/[\\/]+$/, '');
    const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
    return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Suffix duplicate project names (project, project-2, …) exactly like the Claude grouping
 * does. Numbering is per-provider, so one Claude and one Codex session in the same folder
 * both render as "project" and are told apart by their icon.
 */
function applyStableNumbering(sessions: SessionInfo[]): void {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
        const list = groups.get(s.projectName) ?? [];
        list.push(s);
        groups.set(s.projectName, list);
    }
    for (const [base, list] of groups) {
        if (list.length < 2) continue;
        list.sort((a, b) => (a.sessionCreated?.getTime() ?? 0) - (b.sessionCreated?.getTime() ?? 0));
        for (let i = 0; i < list.length; i++) {
            list[i].projectName = i === 0 ? base : `${base}-${i + 1}`;
        }
    }
}
