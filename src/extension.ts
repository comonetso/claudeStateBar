import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as creds from './credentials';
import { fetchUsage, AuthExpiredError, CloudflareBlockedError, NormalizedUsage, UsageResult, getTransport } from './planUsage';
import * as telegram from './telegram';
import * as blockPrimer from './blockPrimer';
import { createOrShowSettingsPanel, notifyUsage } from './settingsPanel';
import { createOrShowWorkflowPanel, pushWorkflows, pushWorkflowTrash, getTrackedSessionFile, pushLanguage } from './workflowPanel';
import { createOrShowCodexPanel, pushRuns, pushTrash, pushCodexLanguage, isCodexPanelOpen, CodexRunView, CodexTrashView } from './codexRescuePanel';
import { discoverRuns, codexRescueDocsDir, isTerminalPhase, pruneTailCache, runCacheKey, deleteRun, cleanupOldRuns, CleanupResult, RunPhase,
         trashRun, listTrash, restoreTrashed, purgeTrashed, emptyTrash } from './providers/codexRescue/runDiscovery';
import { getDict, Lang } from './i18n';
import { readTextFile } from './core/fs';
import { log, setLogChannel, getLogChannel } from './core/logger';
import { getLatestTokenCount } from './providers/claude/tokenParser';
import { summarizeResultFull } from './core/textFormat';
import { getShortName } from './core/displayName';
import { formatIdleDuration, formatTokens } from './core/format';
import { encodeWorkspacePath, getWorkspaceProjectDirs, projectDirMatchesFolder, decodeProjectPath } from './providers/claude/pathCodec';
import { getContextLimitForModel } from './providers/claude/modelLimits';
import { getShortModelName, getEffortLabel } from './providers/claude/display';
import { setRunsOnRemote } from './core/runtimeContext';
import { SoundKind, getSoundPath, getSoundGain, playSoundFile, playBeep, playCompletionSound, playWorkflowCompleteSound, playQuestionSound } from './core/sound';
import { alertedSessions, lastKnownEndTurnAt, pendingCompletion, lastKnownQuestionAt, pendingQuestion, alertedStuckToolUseAt, alertedWorkflowDone, seenRunningWorkflowKeys, getFirstScan, setFirstScan } from './core/beepGate';
import { updateStageItem, startStageTicker, disposeStage, initStageIndicator } from './core/stageIndicator';
import { SessionInfo, ProviderId, CodexUsageSnapshot, providerIcon, capabilitiesFor } from './core/sessionTypes';
import { findCodexSessions, isCodexEnabled, getCodexHomeUri, resetCodexHome } from './providers/codex/sessionProvider';
import { CODEX_USAGE_CACHE_FILENAME, fetchSharedCodexRateLimits, readCachedCodexRateLimits } from './providers/codex/usageProvider';
import { getCodexModelName, getCodexEffortLabel } from './providers/codex/display';
import { initialiseCurrentCodexThreadTracking } from './providers/codex/currentThread';

// SessionInfo moved to core/sessionTypes.ts so the Codex provider can produce sessions
// without importing this entry point. Re-exported shape is unchanged for Claude.

interface StatusBarEntry {
    item: vscode.StatusBarItem;
    iconItem: vscode.StatusBarItem;
    sessionFile: string;
    priority: number;
    /** Which provider currently owns this item — gates provider-specific menu entries. */
    provider: ProviderId;
}

interface WorkflowAgentInfo {
    agentId: string;
    status: 'running' | 'done' | 'stopped';  // stopped = killed/interrupted (see agentWasInterrupted)
    summary: string;  // final result (done) or current activity (running/stopped) — 160-char preview
    fullSummary?: string;  // untruncated full text (final report / activity) — panel expands it via <details> on done agents
    durationMs: number;  // first→last message span from the agent log; 0 if unknown
    name?: string;  // display label (Task agents: meta.json description); workflow agents leave undefined → "에이전트 N"
    fullName?: string;  // untruncated role/task text (name is capped at 50 chars) — panel shows it as a hover tooltip
}

interface WorkflowInfo {
    wfId: string;
    name: string;
    description: string;
    phases: string[];
    agents: WorkflowAgentInfo[];
    startedAt?: number;  // epoch ms — earliest agent start across the workflow (title clock)
    endedAt?: number;    // epoch ms — latest agent activity; final elapsed = endedAt - startedAt once all done
}

const statusBarItems: Map<string, StatusBarEntry> = new Map();
let statusBarExtensionId = 'blueming.claude-state-bar';
let compactStatusBarFallbackLogged = false;

interface RelativeStatusBarPriority {
    location: { id: string; priority: number };
    alignment: 0 | 1;
    compact: true;
}

/**
 * VS Code already uses relative compact priorities for its own grouped status-bar
 * entries, but the public StatusBarItem type exposes numeric priorities only. Current
 * desktop builds retain the validated priority in this ordinary private field. Set it
 * before the first show/update so our two differently-coloured entries are rendered as
 * one compact pair. If VS Code changes the implementation, the guarded fallback keeps
 * the normal public-API layout instead of breaking the context bar.
 */
function compactIconBesideText(iconItem: vscode.StatusBarItem, textItem: vscode.StatusBarItem, fallbackPriority: number): void {
    const mutableIcon = iconItem as vscode.StatusBarItem & { _priority?: number | RelativeStatusBarPriority };
    if (!Object.prototype.hasOwnProperty.call(mutableIcon, '_priority')) {
        if (!compactStatusBarFallbackLogged) {
            log('[statusbar] compact pair unavailable in this VS Code build; using standard spacing');
            compactStatusBarFallbackLogged = true;
        }
        return;
    }

    mutableIcon._priority = {
        location: {
            id: `${statusBarExtensionId}.${textItem.id}`,
            priority: fallbackPriority
        },
        // Internal status-bar alignment: 0 = place this icon left of the text item.
        alignment: 0,
        compact: true
    };
}

function sessionStatusBarItemId(sessionFile: string, part: 'icon' | 'text'): string {
    const sessionKey = crypto.createHash('sha1').update(sessionFile).digest('hex').slice(0, 16);
    return `context.${sessionKey}.${part}`;
}
// Track manually hidden sessions: sessionFile -> timestamp when hidden
const hiddenSessions: Map<string, number> = new Map();
let refreshInterval: NodeJS.Timeout | null = null;

// --- Plan usage (claudeState) state ---
// Plan usage is merged into the first session status-bar item. When no Claude Code
// session is active, planFallbackItem shows the plan usage on its own.
let planFallbackItem: vscode.StatusBarItem | null = null;
// Account usage remains meaningful even when workspace scope cannot associate the Codex
// webview's selected thread with a persisted rollout.
let codexUsageFallbackItem: vscode.StatusBarItem | null = null;
let planRefreshInterval: NodeJS.Timeout | null = null;
let planTickInterval: NodeJS.Timeout | null = null;

let lastUsage: NormalizedUsage | null = null;
// [diag 1.7.39] Last sessionResetAt state written to diag.log, so each poll only records on change.
let lastPollDiag = '';
// [1.7.43] Wall-clock of the last successful block-close poll. A large gap means the machine slept
// and just woke — used to fire the primer on wake even when there was no live >0%→0% transition.
let lastBlockPollAt = 0;
const WAKE_GAP_MS = 5 * 60 * 1000;
type PlanStatus = 'unconfigured' | 'ok' | 'auth_expired' | 'blocked' | 'error';
let planStatus: PlanStatus = 'unconfigured';

// Scan ~/.vscode/extensions, group by publisher.name, keep highest semver per group,
// delete the rest. Self-protective: never deletes the currently-running version of
// our own extension.
//
// `currentExtDir` is the fsPath of the currently-running extension folder
// (context.extensionUri.fsPath / context.extensionPath). It is excluded from the delete
// candidates so we never remove the folder we are executing from — doing so unregisters
// our own commands and produces "command not found" zombie toasts. Returns the number of
// folders actually deleted.
async function runCleanupOldVersions(opts: { silent: boolean; currentExtDir?: string }): Promise<number> {
    const localExtDir = path.join(os.homedir(), '.vscode', 'extensions');

    // Normalise the running extension folder path for case/separator-insensitive comparison,
    // plus a helper to test "is `dir` the running folder or inside it".
    const normalize = (p: string): string => path.resolve(p).replace(/[/\\]+$/, '').toLowerCase();
    const runningDir = opts.currentExtDir ? normalize(opts.currentExtDir) : '';
    const isProtected = (dir: string): boolean => {
        if (!runningDir) return false;
        const d = normalize(dir);
        return d === runningDir || d.startsWith(runningDir + path.sep.toLowerCase()) || d.startsWith(runningDir + '/');
    };

    const parseSemver = (v: string): number[] => v.split(/[.\-]/).map(p => parseInt(p, 10) || 0);
    const compareSemver = (a: string, b: string): number => {
        const av = parseSemver(a), bv = parseSemver(b);
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            const d = (av[i] ?? 0) - (bv[i] ?? 0);
            if (d !== 0) return d;
        }
        return 0;
    };

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(localExtDir, { withFileTypes: true });
    } catch {
        if (!opts.silent) vscode.window.showErrorMessage(planT('msg.cleanupReadFail'));
        return 0;
    }

    const groups = new Map<string, { version: string; dir: string }[]>();
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Match publisher.name-M.m.p with optional suffix (e.g. -win32-x64, -universal, -blueming)
        const match = entry.name.match(/^(.+?)-(\d+\.\d+\.\d+(?:[.\-][a-zA-Z0-9]+)*)$/);
        if (!match) continue;
        const [, name, version] = match;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push({ version, dir: path.join(localExtDir, entry.name) });
    }

    const toDelete: string[] = [];
    for (const [, versions] of groups) {
        if (versions.length <= 1) continue;
        versions.sort((a, b) => compareSemver(b.version, a.version));
        for (const v of versions.slice(1)) {
            // [핵심 가드] 현재 실행 중인 확장 폴더(또는 그 하위)는 절대 삭제하지 않는다.
            // 이 폴더를 지우면 명령 등록이 깨져 "command not found" 좀비 토스트가 발생한다.
            if (isProtected(v.dir)) {
                log(`[cleanup] skip (running extension folder): ${path.basename(v.dir)}`);
                continue;
            }
            toDelete.push(v.dir);
        }
    }

    if (toDelete.length === 0) {
        if (!opts.silent) vscode.window.showInformationMessage(planT('msg.cleanupNone'));
        else log('[cleanup] no old versions to remove');
        return 0;
    }

    log(`[cleanup] candidates (${toDelete.length}):\n${toDelete.map(d => '  • ' + path.basename(d)).join('\n')}`);

    if (!opts.silent) {
        const deleteBtn = planT('common.delete');
        const answer = await vscode.window.showWarningMessage(
            planT('msg.cleanupConfirm', toDelete.length, toDelete.map(d => '• ' + path.basename(d)).join('\n')),
            { modal: true },
            deleteBtn
        );
        if (answer !== deleteBtn) return 0;
    }

    let deleted = 0;
    const failed: string[] = [];
    for (const dir of toDelete) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            log(`[cleanup] deleted: ${path.basename(dir)}`);
            deleted++;
        } catch (e) {
            failed.push(path.basename(dir));
            log(`[cleanup] failed: ${path.basename(dir)} — ${e}`);
        }
    }

    if (!opts.silent) {
        vscode.window.showInformationMessage(planT('msg.cleanupDone', deleted, failed.length ? planT('msg.cleanupFailedSuffix', failed.length) : ''));
    } else if (deleted > 0) {
        log(`[cleanup] auto-removed ${deleted} old version(s) on activate`);
    }
    return deleted;
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('claudeStateBar');
    setLogChannel(outputChannel);
    context.subscriptions.push(outputChannel);
    log('claudeStateBar activating');
    statusBarExtensionId = context.extension.id.toLowerCase();
    log(`Platform: ${process.platform}, home: ${os.homedir()}, remoteName=${vscode.env.remoteName ?? '(none — local UI host)'}`);
    const runsOnRemote = context.extensionUri.scheme !== 'file';
    setRunsOnRemote(runsOnRemote);
    log(`extensionUri.scheme=${context.extensionUri.scheme}, extensionRunsOnRemote=${runsOnRemote}`);

    // Resolve the conversation displayed by this exact VS Code window. Tab and Codex.log
    // changes trigger a refresh immediately; the normal polling loop remains the fallback.
    initialiseCurrentCodexThreadTracking(context, () => refreshAllSessions());

    // extensionKind=['ui'] keeps this directory on the local UI host, so every local and
    // Remote-SSH window for the same VS Code profile shares one account-usage cache.
    codexUsageCacheDir = context.globalStorageUri.fsPath;
    try { fs.mkdirSync(codexUsageCacheDir, { recursive: true }); }
    catch (e) { log(`[codex-usage] cannot prepare shared cache directory: ${e}`); }
    syncCodexUsageFromSharedCache();

    // Initialise credential store (context.secrets) for the claudeState plan-usage feature
    creds.initCredentials(context);

    // Open the unified settings webview panel
    const openSettingsCmd = vscode.commands.registerCommand('claudeContextBar.openSettings', () => {
        createOrShowSettingsPanel(context, {
            onPlanSettingsChanged: () => { restartPlanPolling(); refreshPlanUsage(); },
            onRefreshRequested: () => { refreshPlanUsage(); }
        });
    });
    context.subscriptions.push(openSettingsCmd);

    // Manual plan-usage refresh
    const refreshPlanCmd = vscode.commands.registerCommand('claudeContextBar.refreshPlanUsage', () => {
        refreshPlanUsage();
    });

    // Internal beep command — called from the settings panel webview.
    // If a customPath is given, play THAT file (preview before saving); otherwise use the saved setting.
    // gainPercent (50–300) is optional and lets the preview reflect the unsaved gain input.
    const playBeepCmd = vscode.commands.registerCommand('claudeContextBar.playBeep', (beepType: string, customPath?: string, gainPercent?: number) => {
        log(`[beep] command received: beepType=${beepType}, customPath="${customPath ?? ''}", gain=${gainPercent ?? '(saved)'}`);
        const kind: SoundKind = beepType === 'danger' ? 'danger'
            : beepType === 'completion' ? 'completion'
            : beepType === 'question' ? 'question'
            : beepType === 'workflow' ? 'workflow'
            : 'warning';
        const trimmed = (customPath || '').trim();
        const repeat = kind === 'danger' ? 2 : 1;
        const gain = (typeof gainPercent === 'number' && Number.isFinite(gainPercent))
            ? Math.max(50, Math.min(300, Math.round(gainPercent)))
            : getSoundGain(kind);
        const soundPath = trimmed || getSoundPath(kind);
        playSoundFile(soundPath, repeat, `${trimmed ? 'preview' : 'beep'}:${kind}`, gain);
    });
    context.subscriptions.push(playBeepCmd);

    // Test beep sounds (Command Palette: "claudeContextBar: Test Beep")
    const testBeepCmd = vscode.commands.registerCommand('claudeContextBar.testBeep', async () => {
        type BeepType = 'warning' | 'danger' | 'completion' | 'question' | 'workflow';
        const pick = await vscode.window.showQuickPick(
            [
                { label: '$(bell) ' + planT('beep.warning'),      description: planT('beep.warningDesc'),    type: 'warning' as BeepType },
                { label: '$(bell) ' + planT('beep.danger'),       description: planT('beep.dangerDesc'),     type: 'danger' as BeepType },
                { label: '$(check) ' + planT('beep.completion'),  description: planT('beep.completionDesc'), type: 'completion' as BeepType },
                { label: '$(question) ' + planT('beep.question'), description: planT('beep.questionDesc'),   type: 'question' as BeepType },
                { label: '$(sync) ' + planT('beep.workflow'),     description: planT('beep.workflowDesc'),   type: 'workflow' as BeepType },
            ],
            { placeHolder: planT('beep.placeholder') }
        );
        if (!pick) return;
        vscode.commands.executeCommand('claudeContextBar.playBeep', pick.type);
    });
    context.subscriptions.push(testBeepCmd);
    context.subscriptions.push(refreshPlanCmd);

    // Show diagnostics: logs workspace dirs, Claude dirs found, matching result
    const diagCommand = vscode.commands.registerCommand('claudeContextBar.showDiagnostics', async () => {
        getLogChannel()?.show(true);
        log('=== DIAGNOSTICS ===');
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            for (const f of folders) {
                const encoded = encodeWorkspacePath(f.uri.fsPath);
                log(`Workspace folder: ${f.uri.fsPath}`);
                log(`  → encoded: ${encoded}`);
            }
        } else {
            log('No workspace folders open');
        }
        const projectsUri = await getClaudeProjectsUri();
        log(`Claude projects dir: ${projectsUri?.toString()}`);
        if (projectsUri) {
            try {
                const dirs = await vscode.workspace.fs.readDirectory(projectsUri);
                log(`Found ${dirs.length} project dirs:`);
                for (const [d] of dirs) {
                    log(`  ${d}`);
                }
            } catch {
                log('Claude projects dir does not exist!');
            }
        }

        await logRemoteFsProbe();

        log('=== END DIAGNOSTICS ===');
        await refreshAllSessions();
    });
    context.subscriptions.push(diagCommand);

    // Direct hide command (kept for completeness; status bar click now opens the menu)
    const hideCommand = vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionFile: string) => {
        if (!sessionFile) return;
        hiddenSessions.set(sessionFile, Date.now());
        log(`[hide] hid ${sessionFile}`);
        refreshAllSessions();
    });
    context.subscriptions.push(hideCommand);

    // Restore a single hidden session
    const restoreOneCommand = vscode.commands.registerCommand('claudeContextBar.restoreHiddenSession', (sessionFile: string) => {
        if (!sessionFile) return;
        hiddenSessions.delete(sessionFile);
        refreshAllSessions();
    });
    context.subscriptions.push(restoreOneCommand);

    // Restore all hidden sessions
    const restoreAllCommand = vscode.commands.registerCommand('claudeContextBar.restoreAllHidden', () => {
        if (hiddenSessions.size === 0) {
            vscode.window.showInformationMessage(planT('msg.noHidden'));
            return;
        }
        hiddenSessions.clear();
        refreshAllSessions();
    });
    context.subscriptions.push(restoreAllCommand);

    // Status bar click → QuickPick menu (hide this / restore hidden / open settings)
    const menuCommand = vscode.commands.registerCommand('claudeContextBar.showSessionMenu', async (sessionFile: string) => {
        type Item = vscode.QuickPickItem & { action?: 'hide' | 'restoreAll' | 'restoreOne' | 'settings' | 'workflows' | 'codexRuns' | 'cleanupGhosts'; sessionFile?: string };
        const items: Item[] = [];

        const clickedEntry = sessionFile ? statusBarItems.get(sessionFile) : undefined;

        // [좀비 클릭 안내] sessionFile이 전달됐는데 현재 statusBarItems 맵에 없으면, 옛/중복
        // 인스턴스가 남긴 좀비 상태바 아이템을 클릭한 것으로 추정한다. 일반 메뉴 대신 창 재로드를
        // 안내해 좀비 아이템을 정리하도록 유도한다.
        // 주의: 명령(showSessionMenu) 자체가 사라진 좀비는 이 핸들러가 아예 호출되지 않고
        // "command not found" 토스트만 뜬다. 그 경우의 주 정리 경로는 커맨드 팔레트의
        // 'claudeContextBar.cleanupGhostItems' 명령이다.
        if (sessionFile && !clickedEntry) {
            const reloadBtn = planT('common.reload');
            const pick = await vscode.window.showWarningMessage(
                planT('menu.staleItem'),
                reloadBtn
            );
            if (pick === reloadBtn) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
            return;
        }

        const clickedLabel = clickedEntry?.item.text || (sessionFile ? path.basename(sessionFile) : 'this session');

        if (sessionFile) {
            items.push({
                label: '$(eye-closed) ' + planT('menu.hide'),
                description: clickedLabel,
                action: 'hide'
            });
        }

        if (hiddenSessions.size > 0) {
            items.push({ label: planT('menu.sepHidden'), kind: vscode.QuickPickItemKind.Separator });
            items.push({
                label: '$(eye) ' + planT('menu.restoreAll', hiddenSessions.size),
                action: 'restoreAll'
            });
            for (const [hiddenPath] of hiddenSessions) {
                const fileName = path.basename(hiddenPath).replace(/\.jsonl$/, '');
                const projectDir = path.basename(path.dirname(hiddenPath));
                items.push({
                    label: '$(eye) ' + planT('menu.restoreOne', fileName.substring(0, 8)),
                    description: projectDir,
                    detail: hiddenPath,
                    action: 'restoreOne',
                    sessionFile: hiddenPath
                });
            }
        }

        // Workflows section — a single entry that opens the live panel (which lists all
        // workflows + their agents). The panel auto-refreshes with the status bar.
        // Skipped for providers without workflow journals (Codex): scanning its rollout
        // path for Claude's subagents/ layout can only ever come back empty, and offering
        // a workflow entry there would promise a feature that provider does not have.
        if (sessionFile && capabilitiesFor(clickedEntry?.provider ?? 'claude').workflows) {
            const workflows = await findWorkflowsForSession(sessionFile);
            items.push({ label: planT('menu.sepWorkflows'), kind: vscode.QuickPickItemKind.Separator });
            if (workflows.length > 0) {
                const runningWf = workflows.filter(w => w.agents.some(a => a.status === 'running')).length;
                const icon = runningWf > 0 ? '$(sync~spin)' : '$(circuit-board)';
                items.push({
                    label: icon + ' ' + planT('menu.viewWorkflows', workflows.length),
                    description: runningWf > 0 ? planT('menu.running', runningWf) : planT('menu.allDone'),
                    detail: planT('menu.viewDetail'),
                    action: 'workflows'
                });
            } else {
                // Still clickable — opens the (empty) panel so the user gets a consistent
                // place to look, instead of the menu just closing on click.
                items.push({
                    label: '$(circuit-board) ' + planT('menu.noWorkflows'),
                    description: '',
                    detail: planT('menu.openPanelDetail'),
                    action: 'workflows'
                });
            }
        }

        // codex_rescue 진행 상황. 스킬이 깔린 머신에서만 나타난다 — 안 쓰는 사용자에게는
        // 항목 자체가 없다. 실행 기록이 아직 없어도(0건) 항목은 보여준다: 패널을 열어
        // "여기서 볼 수 있다"는 걸 알 수 있어야 하기 때문이다.
        if (codexRescueSkillInstalled()) {
            const cxRuns = await collectCodexRuns();
            const cxLive = cxRuns.filter(r => !isTerminalPhase(r.phase)).length;
            items.push({ label: planT('menu.sepCodex'), kind: vscode.QuickPickItemKind.Separator });
            items.push({
                label: (cxLive > 0 ? '$(sync~spin) ' : '$(flame) ') + planT('menu.viewCodexRuns', cxRuns.length),
                description: cxLive > 0 ? planT('menu.running', cxLive) : planT('menu.allDone'),
                detail: planT('menu.codexDetail'),
                action: 'codexRuns'
            });
        }

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        // 좀비(죽은 인스턴스가 남긴) 상태바 항목 정리. 좀비 아이템 자체는 죽은 command라
        // 클릭이 안 먹으므로(command not found), 살아있는 항목의 이 메뉴를 통로로 제공한다.
        // 선택 시 즉시 창을 다시 로드해 좀비를 100% 제거한다.
        items.push({
            label: '$(trash) ' + planT('menu.cleanupGhosts'),
            description: planT('menu.cleanupGhostsDesc'),
            detail: planT('menu.cleanupGhostsDetail'),
            action: 'cleanupGhosts'
        });
        items.push({
            label: '$(gear) ' + planT('menu.openSettings'),
            description: planT('menu.openSettingsDesc'),
            action: 'settings'
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: planT('menu.placeholder')
        });
        if (!picked) return;

        switch (picked.action) {
            case 'hide':
                if (sessionFile) {
                    hiddenSessions.set(sessionFile, Date.now());
                    log(`[hide] hid via menu (${clickedEntry?.provider ?? '?'}) ${sessionFile}`);
                    refreshAllSessions();
                }
                break;
            case 'restoreAll':
                hiddenSessions.clear();
                refreshAllSessions();
                break;
            case 'restoreOne':
                if (picked.sessionFile) {
                    hiddenSessions.delete(picked.sessionFile);
                    refreshAllSessions();
                }
                break;
            case 'settings':
                vscode.commands.executeCommand('claudeContextBar.openSettings');
                break;
            case 'codexRuns':
                vscode.commands.executeCommand('claudeContextBar.showCodexRuns');
                break;
            case 'cleanupGhosts':
                // 죽은 인스턴스가 남긴 좀비 StatusBarItem은 VS Code API로 직접 제거 불가 →
                // extension host 재시작(창 다시 로드)이 유일한 제거 수단. 메뉴에서 선택한 것
                // 자체가 명시적 의도이므로 추가 확인 없이 바로 리로드한다.
                vscode.commands.executeCommand('workbench.action.reloadWindow');
                break;
            case 'workflows':
                if (sessionFile) {
                    const workflows = await findWorkflowsForSession(sessionFile);
                    createOrShowWorkflowPanel(context, sessionFile, workflows, {
                        onDelete: async (wfId: string) => {
                            if (wfId.startsWith('tasks:')) {
                                const cleanupBtn = planT('common.cleanup');
                                const ok = await vscode.window.showWarningMessage(
                                    planT('msg.tasksClearConfirm'),
                                    { modal: true },
                                    cleanupBtn
                                );
                                if (ok !== cleanupBtn) return;
                                const n = await deleteDoneTaskAgents(sessionFile, wfId);
                                log(`[tasks] cleared ${n} completed task-agent log(s) in ${wfId}`);
                                pushWorkflows(await findWorkflowsForSession(sessionFile));
                                return;
                            }
                            const deleteBtn = planT('common.delete');
                            const confirm = await vscode.window.showWarningMessage(
                                planT('msg.wfDeleteConfirm', wfId),
                                { modal: true },
                                deleteBtn
                            );
                            if (confirm !== deleteBtn) return;
                            // Carry the name and agent count into the trash: wf_a1b2c3 tells you
                            // nothing about what you deleted, and the journal that would have
                            // told you is inside the bin you'd have to restore to read.
                            const before = await findWorkflowsForSession(sessionFile);
                            const target = before.find(w => w.wfId === wfId);
                            if (await trashWorkflowDir(sessionFile, wfId, target?.name, target?.agents.length ?? 0)) {
                                vscode.window.setStatusBarMessage(planT('wf.trash.trashed'), 5000);
                            }
                            pushWorkflows(await findWorkflowsForSession(sessionFile));
                            void pushWfTrash(sessionFile);
                        },
                        onTrashOpen: () => { void pushWfTrash(sessionFile); },
                        onRestore: async (wfId: string) => {
                            if (await restoreWorkflow(sessionFile, wfId)) {
                                vscode.window.setStatusBarMessage(planT('wf.trash.restored', wfId), 5000);
                            } else {
                                vscode.window.showWarningMessage(planT('wf.trash.conflict', wfId));
                            }
                            pushWorkflows(await findWorkflowsForSession(sessionFile));
                            void pushWfTrash(sessionFile);
                        },
                        onPurge: async (wfId: string) => {
                            const deleteBtn = planT('common.delete');
                            const ok = await vscode.window.showWarningMessage(
                                planT('wf.trash.purgeConfirm', wfId), { modal: true }, deleteBtn);
                            if (ok !== deleteBtn) return;
                            await purgeWorkflow(sessionFile, wfId);
                            void pushWfTrash(sessionFile);
                        },
                        onEmptyTrash: async () => {
                            const items = await listWorkflowTrash(sessionFile);
                            if (!items.length) return;
                            const emptyBtn = planT('wf.trash.empty');
                            const ok = await vscode.window.showWarningMessage(
                                planT('wf.trash.emptyConfirm', items.length), { modal: true }, emptyBtn);
                            if (ok !== emptyBtn) return;
                            const n = await emptyWorkflowTrash(sessionFile);
                            vscode.window.showInformationMessage(planT('wf.trash.emptied', n));
                            void pushWfTrash(sessionFile);
                        }
                    });
                }
                break;
        }
    });
    context.subscriptions.push(menuCommand);

    // Cleanup old extension versions: scan ~/.vscode/extensions, keep only the
    // highest semver per publisher.name, delete the rest. Runs silently on
    // activate (configurable) and as an interactive command.
    const currentExtDir = context.extensionUri.fsPath || context.extensionPath;

    // [업데이트 직후 좀비 자동 안내] 좀비 상태바 항목은 버전 교체(업데이트) 직후 옛 인스턴스가
    // 정상 deactivate 없이 죽으며 가장 많이 생긴다. 직전 활성 버전과 현재 버전이 다르면(=방금
    // 업데이트됨) 1회 리로드를 권유해, 좀비가 화면에 머무는 시간을 최소화한다. 좀비 픽셀은
    // 창 다시 로드(extension host 재시작)로만 제거 가능하다 (VS Code API 한계).
    const curVer = context.extension?.packageJSON?.version ?? '';
    const lastVer = context.globalState.get<string>('claudeStateBar.lastActivatedVersion');
    if (lastVer && curVer && lastVer !== curVer) {
        const reloadBtn = planT('common.reload');
        vscode.window.showWarningMessage(
            planT('msg.updatedZombie', lastVer, curVer),
            reloadBtn
        ).then(a => { if (a === reloadBtn) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }
    void context.globalState.update('claudeStateBar.lastActivatedVersion', curVer);

    const cleanupCmd = vscode.commands.registerCommand('claudeContextBar.cleanupOldVersions', async () => {
        await runCleanupOldVersions({ silent: false, currentExtDir });
    });
    context.subscriptions.push(cleanupCmd);

    // [유령 항목 정리 — 주 정리 경로]
    // 좀비 상태바 아이템은 옛/중복 인스턴스가 만든 것이라 그 인스턴스의 명령이 현재
    // 레지스트리에 없을 수 있다. 좀비 아이템 클릭은 "command not found" 토스트만 띄우고
    // showSessionMenu 핸들러가 호출되지 않을 수 있으므로, 사용자가 토스트와 무관하게
    // 커맨드 팔레트에서 직접 실행할 수 있는 정리 명령을 제공한다.
    // 동작: 옛 버전 정리 → 모달 확인 후 창 재로드(모든 인스턴스 재기동 → 좀비 아이템 제거).
    const cleanupGhostCmd = vscode.commands.registerCommand('claudeContextBar.cleanupGhostItems', async () => {
        await runCleanupOldVersions({ silent: false, currentExtDir });
        const reloadBtn = planT('common.reload');
        const answer = await vscode.window.showWarningMessage(
            planT('msg.cleanupGhostsConfirm'),
            { modal: true },
            reloadBtn
        );
        if (answer === reloadBtn) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
    context.subscriptions.push(cleanupGhostCmd);

    // codex_rescue live progress panel. The command is registered unconditionally (cheap)
    // but package.json hides it from the palette unless `claudeStateBar.hasCodexRescue` is
    // set, which only happens in a workspace that has docs/codex_rescue/.
    const codexRunsCmd = vscode.commands.registerCommand('claudeContextBar.showCodexRuns', async () => {
        createOrShowCodexPanel(context, await collectCodexRuns(), {
            // A URI string, not a path: `Uri.file` would send a remote workspace's document
            // to a non-existent local path. `Uri.parse` round-trips the remote authority.
            onOpenDoc: (docUri: string) => {
                vscode.workspace.openTextDocument(vscode.Uri.parse(docUri)).then(
                    doc => vscode.window.showTextDocument(doc, { preview: false }),
                    e => log(`[codex-rescue] open failed: ${e}`)
                );
            },
            onDelete: async (stamp: string) => {
                const target = (await collectCodexRuns()).find(r => r.stamp === stamp);
                if (!target) return;
                // Manual deletion asks every time rather than obeying the retention setting:
                // it's an explicit act on one specific run, and whether that run's documents
                // are worth keeping is a per-run judgement. The setting governs auto-cleanup.
                const logsOnly = planT('cx.del.logsOnly');
                const withDocs = planT('cx.del.withDocs');
                const choice = await vscode.window.showWarningMessage(
                    planT('cx.del.ask', target.subject || target.slug), { modal: true }, logsOnly, withDocs
                );
                if (choice !== logsOnly && choice !== withDocs) return;
                let moved = false;
                for (const f of vscode.workspace.workspaceFolders || []) {
                    if (await trashRun(f.uri, stamp, target.slug, choice === withDocs,
                                       target.subject, target.mode, Date.now())) { moved = true; break; }
                }
                if (!moved) {
                    // Either the lock is still held or the files were already gone; the lock is
                    // the case worth naming, since it's the one the user can act on.
                    vscode.window.showWarningMessage(planT('cx.del.skippedLive'));
                } else {
                    log(`[codex-rescue] trashed ${stamp}`);
                    vscode.window.setStatusBarMessage(planT('cx.del.trashed'), 5000);
                }
                void syncCodexRuns();
                void pushCodexTrash();
            },
            onTrashOpen: () => { void pushCodexTrash(); },
            onRestore: async (stamp: string) => {
                for (const f of vscode.workspace.workspaceFolders || []) {
                    const res = await restoreTrashed(f.uri, stamp);
                    if (!res.restored && !res.conflicts.length) continue;
                    if (res.conflicts.length) {
                        vscode.window.showWarningMessage(planT('cx.trash.conflict', res.conflicts.length));
                    } else {
                        vscode.window.setStatusBarMessage(planT('cx.trash.restored', stamp), 5000);
                    }
                    log(`[codex-rescue] restored ${stamp}: ${res.restored} file(s), ${res.conflicts.length} conflict(s)`);
                    break;
                }
                void syncCodexRuns();
                void pushCodexTrash();
            },
            onPurge: async (stamp: string) => {
                const deleteBtn = planT('common.delete');
                const ok = await vscode.window.showWarningMessage(
                    planT('cx.trash.purgeConfirm', stamp), { modal: true }, deleteBtn);
                if (ok !== deleteBtn) return;
                for (const f of vscode.workspace.workspaceFolders || []) {
                    if (await purgeTrashed(f.uri, stamp)) { log(`[codex-rescue] purged ${stamp}`); break; }
                }
                void pushCodexTrash();
            },
            onEmptyTrash: async () => {
                const items = await collectCodexTrash();
                if (!items.length) return;
                const emptyBtn = planT('cx.trash.empty');
                const ok = await vscode.window.showWarningMessage(
                    planT('cx.trash.emptyConfirm', items.length), { modal: true }, emptyBtn);
                if (ok !== emptyBtn) return;
                let n = 0;
                for (const f of vscode.workspace.workspaceFolders || []) n += await emptyTrash(f.uri);
                log(`[codex-rescue] emptied trash: ${n} run(s)`);
                vscode.window.showInformationMessage(planT('cx.trash.emptied', n));
                void pushCodexTrash();
            }
        });
    });
    context.subscriptions.push(codexRunsCmd);

    // Shown only to people who DON'T have the skill: a pointer to the guide, nothing more.
    // The extension never installs the skill itself — it spawns `codex exec` with workspace
    // write access, so that has to be a deliberate act by the user, not a side effect of
    // installing a status-bar extension.
    const codexSetupCmd = vscode.commands.registerCommand('claudeContextBar.setupCodexRescue', async () => {
        const openBtn = planT('cx.setup.open');
        const answer = await vscode.window.showInformationMessage(planT('cx.setup.msg'), openBtn);
        if (answer === openBtn) {
            const doc = planLang() === 'ko' ? 'codex-rescue-guide.ko.md' : 'codex-rescue-guide.md';
            vscode.env.openExternal(vscode.Uri.parse(
                `https://github.com/comonetso/claudeStateBar/blob/main/docs/${doc}`));
        }
    });
    context.subscriptions.push(codexSetupCmd);
    updateCodexContext(codexRescueSkillInstalled());

    // Auto-cleanup on activate (silent, async — doesn't block startup)
    const autoCleanup = vscode.workspace.getConfiguration('claudeContextBar').get<boolean>('autoCleanupOldVersions', true);
    if (autoCleanup) {
        setTimeout(() => {
            runCleanupOldVersions({ silent: true, currentExtDir })
                .then(deleted => {
                    // [삭제 후 재시작 안내] 자동 정리가 실제로 옛 폴더를 삭제했다면, 화면에 남은
                    // 좀비 상태바 아이템은 창을 재로드해야 사라진다. 1회 안내한다.
                    if (deleted > 0) {
                        const reloadBtn = planT('common.reload');
                        vscode.window.showInformationMessage(
                            planT('msg.autoCleanupDone', deleted),
                            reloadBtn
                        ).then(answer => {
                            if (answer === reloadBtn) {
                                vscode.commands.executeCommand('workbench.action.reloadWindow');
                            }
                        });
                    }
                })
                .catch(e => log(`[cleanup] auto error: ${e}`));
        }, 2000);
    }

    // codex_rescue log retention. Runs once per activation — VS Code gets restarted often
    // enough that a timer would add nothing but a way to delete files unexpectedly mid-session.
    // Off by default; only finished, unlocked runs past the retention window are removed.
    setTimeout(async () => {
        const cfg = vscode.workspace.getConfiguration('claudeContextBar');
        if (!cfg.get<boolean>('codexRunAutoCleanup', false)) return;
        const opts = {
            retentionDays: cfg.get<number>('codexRunRetentionDays', 7),
            deleteDocs: cfg.get<boolean>('codexRunDeleteDocs', false),
        };
        for (const f of vscode.workspace.workspaceFolders || []) {
            try {
                const r = await cleanupOldRuns(f.uri, opts, Date.now());
                if (r.removedRuns) {
                    log(`[codex-rescue] auto-cleanup: ${r.removedRuns} run(s), ${r.removedFiles} file(s), `
                        + `${Math.round(r.freedBytes / 1024)}KB freed (older than ${opts.retentionDays}d, docs=${opts.deleteDocs})`);
                }
            } catch (e) {
                log(`[codex-rescue] auto-cleanup error: ${e}`);
            }
        }
    }, 4000);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar.codex.home')) {
            resetCodexHome();  // re-probe on the next refresh
        }
        if (e.affectsConfiguration('claudeContextBar')) {
            refreshAllSessions();
        }
        if (e.affectsConfiguration('claudeState')) {
            restartPlanPolling();
            refreshPlanUsage();
        }
        // Language change: re-localise the open workflow panel + status-bar labels/tooltips live.
        // (The QuickPick menu rebuilds on each click, so it already picks up the new language.)
        if (e.affectsConfiguration('claudeState.language')) {
            pushLanguage();
            pushCodexLanguage();
            refreshAllSessions();
        }
    });
    context.subscriptions.push(configWatcher);

    // Re-filter when workspace folders change (e.g., user opens/closes a folder)
    const wsWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => { resetClaudeBaseUri(); resetCodexHome(); refreshAllSessions(); });
    context.subscriptions.push(wsWatcher);

    // Initial scan
    refreshAllSessions();

    // Set up file watcher. createFileSystemWatcher works for both local (file://) and
    // Remote-SSH (vscode-remote://) hosts — VS Code routes the watch to the right host.
    (async () => {
        const projectsUri = await getClaudeProjectsUri();
        if (!projectsUri) return;
        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(projectsUri, '**/*.jsonl')
            );
            const onChange = () => { refreshAllSessions(); };
            watcher.onDidChange(onChange);
            watcher.onDidCreate(onChange);
            watcher.onDidDelete(onChange);
            context.subscriptions.push(watcher);
        } catch (e) {
            console.error('Failed to set up file watcher:', e);
        }
    })();

    // Codex rollout watcher. Without this, a Codex session would only refresh on the 30s
    // poll; the acceptance criterion is "updates within seconds" (docs §15 Phase 1).
    // Watching the sessions root covers new YYYY/MM/DD folders as days roll over.
    // createFileSystemWatcher handles file:// and vscode-remote:// alike, exactly as the
    // Claude watcher above does.
    (async () => {
        if (!isCodexEnabled()) return;
        const home = await getCodexHomeUri();
        if (!home) {
            log('[codex] no Codex home found on this host — Codex sessions will not be shown');
            return;
        }
        try {
            const sessionsUri = vscode.Uri.joinPath(home, 'sessions');
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(sessionsUri, '**/rollout-*.jsonl')
            );
            const onChange = () => { refreshAllSessions(); };
            watcher.onDidChange(onChange);
            watcher.onDidCreate(onChange);
            watcher.onDidDelete(onChange);
            context.subscriptions.push(watcher);
            log(`[codex] watching ${sessionsUri.toString()}`);
        } catch (e) {
            log(`[codex] watcher setup failed (polling still applies): ${e}`);
        }
    })();

    // A different extension host may win the account-usage probe lock. Watch its atomic
    // cache replacement so this window converges immediately instead of waiting for its
    // independently phased polling timer.
    try {
        const usageWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(context.globalStorageUri, CODEX_USAGE_CACHE_FILENAME)
        );
        const onUsageCacheChange = () => {
            if (syncCodexUsageFromSharedCache()) refreshAllSessions();
        };
        usageWatcher.onDidChange(onUsageCacheChange);
        usageWatcher.onDidCreate(onUsageCacheChange);
        context.subscriptions.push(usageWatcher);
    } catch (e) {
        log(`[codex-usage] shared cache watcher unavailable (polling still applies): ${e}`);
    }

    // Set up periodic refresh
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const intervalSeconds = config.get<number>('refreshInterval', 30);
    refreshInterval = setInterval(refreshAllSessions, intervalSeconds * 1000);

    // Start the claudeState plan-usage polling (no-op until enabled + credentials set)
    restartPlanPolling();
    refreshPlanUsage();

    // Codex account usage: its own slow timer, deliberately separate from the 30s session
    // poll. A shared cache + atomic lock lets only one window spawn the short-lived
    // `codex app-server`; the others reuse that result. The plan-usage interval is clamped
    // to at least a minute.
    {
        const codexUsageSec = Math.max(60, creds.getRefreshIntervalSec());
        codexUsageCacheMaxAgeMs = codexUsageSec * 1000;
        refreshCodexUsage();
        codexUsageInterval = setInterval(refreshCodexUsage, codexUsageSec * 1000);
    }
    // Recompute the "resets in ..." countdown once a minute without re-fetching
    planTickInterval = setInterval(() => { if (lastUsage) refreshAllSessions(); }, 60 * 1000);
    // Tick the "is it alive?" elapsed counter every second (no disk reads — uses cached marker).
    initStageIndicator(() => planLang() === 'ko');
    startStageTicker();

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
            if (planRefreshInterval) {
                clearInterval(planRefreshInterval);
            }
            if (planTickInterval) {
                clearInterval(planTickInterval);
            }
            if (codexUsageInterval) {
                clearInterval(codexUsageInterval);
            }
            for (const [, p] of pendingCompletion) clearTimeout(p.timer);
            pendingCompletion.clear();
            for (const [, p] of pendingQuestion) clearTimeout(p.timer);
            pendingQuestion.clear();
            planFallbackItem?.dispose();
            codexUsageFallbackItem?.dispose();
            disposeStage();
            statusBarItems.forEach(entry => {
                entry.item.dispose();
                entry.iconItem.dispose();
            });
            statusBarItems.clear();
        }
    });
}

// PoC probe: when this extension runs as a UI (local) extension over Remote-SSH, can it
// read the REMOTE ~/.claude/projects via vscode.workspace.fs (which VS Code routes to the
// remote host)? If yes, plan-usage (local Electron) + token counting (remote fs) can both
// live in one local instance. Harmless when not remote (logs a single line).
async function logRemoteFsProbe(): Promise<void> {
    log('--- REMOTE FS PROBE (PoC) ---');
    log(`process.platform=${process.platform}, os.homedir()=${os.homedir()}`);
    const folder0 = vscode.workspace.workspaceFolders?.[0];
    if (folder0) {
        const u = folder0.uri;
        log(`workspace uri: scheme=${u.scheme} authority=${u.authority || '(none)'} path=${u.path}`);
        if (u.scheme === 'vscode-remote' && u.authority) {
            const candidates = ['/root/.claude/projects', '/home'];
            for (const p of candidates) {
                const probe = u.with({ path: p });
                try {
                    const entries = await vscode.workspace.fs.readDirectory(probe);
                    log(`  ✅ read ${u.scheme}://${u.authority}${p} → ${entries.length} entries`);
                    for (const [name] of entries.slice(0, 8)) log(`     ${name}`);
                } catch (e: any) {
                    log(`  ❌ read ${p} failed: ${e?.message ?? e}`);
                }
            }
        } else {
            log('  (workspace uri is not vscode-remote — extension is NOT running locally over Remote-SSH)');
        }
    }
    log('--- END REMOTE FS PROBE ---');
}

export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    if (planRefreshInterval) {
        clearInterval(planRefreshInterval);
    }
    if (planTickInterval) {
        clearInterval(planTickInterval);
    }
    if (codexUsageInterval) {
        clearInterval(codexUsageInterval);
    }
    if (codexFastTimer) {
        clearInterval(codexFastTimer);
        codexFastTimer = null;
    }
    for (const [, p] of pendingCompletion) clearTimeout(p.timer);
    pendingCompletion.clear();
    for (const [, p] of pendingQuestion) clearTimeout(p.timer);
    pendingQuestion.clear();
    planFallbackItem?.dispose();
    codexUsageFallbackItem?.dispose();
    disposeStage();
    statusBarItems.forEach(entry => {
        entry.item.dispose();
        entry.iconItem.dispose();
    });
    statusBarItems.clear();
}

// The base ~/.claude URI for the host this extension is reading from. As a UI (local)
// extension over Remote-SSH, vscode.workspace.fs routes reads to the remote host, so we
// build a vscode-remote URI pointing at the remote home; for a local window we use a
// file:// URI under os.homedir(). Cached and reset when the workspace folders change.
let claudeBaseUri: vscode.Uri | null | undefined; // undefined = unresolved

function resetClaudeBaseUri(): void {
    claudeBaseUri = undefined;
}

async function getClaudeBaseUri(): Promise<vscode.Uri | null> {
    if (claudeBaseUri !== undefined) return claudeBaseUri;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder && folder.uri.scheme === 'vscode-remote' && folder.uri.authority) {
        // Remote host: find the home directory that actually holds .claude/projects.
        const homes = ['/root'];
        try {
            const entries = await vscode.workspace.fs.readDirectory(folder.uri.with({ path: '/home' }));
            for (const [name, ftype] of entries) {
                if (ftype === vscode.FileType.Directory) homes.push(`/home/${name}`);
            }
        } catch { /* /home may not exist */ }
        for (const home of homes) {
            try {
                await vscode.workspace.fs.stat(folder.uri.with({ path: `${home}/.claude/projects` }));
                claudeBaseUri = folder.uri.with({ path: `${home}/.claude` });
                log(`[fs] remote ~/.claude → ${home}/.claude (authority=${folder.uri.authority})`);
                return claudeBaseUri;
            } catch { /* try next candidate */ }
        }
        log('[fs] remote ~/.claude/projects not found under /root or /home/* — defaulting to /root/.claude');
        claudeBaseUri = folder.uri.with({ path: '/root/.claude' });
        return claudeBaseUri;
    }
    // Local window (file scheme or no folder open).
    claudeBaseUri = vscode.Uri.file(path.join(os.homedir(), '.claude'));
    return claudeBaseUri;
}

async function getClaudeProjectsUri(): Promise<vscode.Uri | null> {
    const base = await getClaudeBaseUri();
    return base ? vscode.Uri.joinPath(base, 'projects') : null;
}

// Render a structured result object as readable "key: value" multiline text instead
// of a raw JSON.stringify blob. Nested objects/arrays are JSON-encoded inline.
// Extract the FIRST user-message text from an agent log (agent-<id>.jsonl). This is the
// prompt the orchestrator handed the subagent — it carries the agent's role. Journal-based
// workflow agents record NO label anywhere on disk (journal `started` entries hold only
// {key, agentId}; the meta.json sidecar holds only {agentType:"workflow-subagent"}), so the
// prompt is the only available role signal. Returns '' when no user text is found.
async function getAgentFirstPromptText(wfDirUri: vscode.Uri, agentId: string): Promise<string> {
    try {
        const content = await readTextFile(vscode.Uri.joinPath(wfDirUri, `agent-${agentId}.jsonl`));
        for (const line of content.trim().split('\n')) {
            if (!line.trim()) continue;
            let e: any;
            try { e = JSON.parse(line); } catch { continue; }
            if (e.type !== 'user' || !e.message) continue;
            const c = e.message.content;
            let text = '';
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) {
                for (const b of c) {
                    if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
                }
            }
            if (text.trim()) return text;
        }
    } catch { /* agent log not readable yet */ }
    return '';
}

// Derive a short, deterministic role label for each journal-based workflow agent from its
// first prompt. Workflow subagents in the same workflow share a big boilerplate preamble
// (e.g. "# 프로젝트", "# 출력 형식") and differ only in one task-specific heading (e.g.
// "# 렌즈 A: 비프 오발", "# 너의 단독 작업 (...)"). Strategy:
//   1. collect each agent's markdown `#` headings,
//   2. drop headings shared by ≥2 agents (boilerplate) — the first remaining unique heading
//      is the role,
//   3. if an agent has no unique heading, fall back to its first meaningful prose line.
// Output is deterministic (same logs → same labels) so it never destabilises the panel's
// push-dedup signature. Returns a Map<agentId, label>; agents with no signal are omitted.
function deriveAgentRoleLabels(prompts: Map<string, string>): Map<string, { label: string; full: string }> {
    // Returns both the 50-char display label and the untruncated full text. The panel shows
    // `label` and uses `full` as a hover tooltip so a clipped role/task is still fully readable.
    const clean = (raw: string): { label: string; full: string } => {
        const s = raw.replace(/[★⚠️]/g, '').trim();
        return { label: s.length > 50 ? s.slice(0, 50).trim() + '…' : s, full: s };
    };
    // Keep any trailing parenthetical — it is often the role's distinguishing detail
    // (e.g. "너의 단독 작업 (설정 정의)" vs "너의 단독 작업 (비프 재생)"): dropping it would
    // collapse two distinct roles into one identical label.
    const cleanHeading = (h: string) => clean(h.replace(/^#+\s*/, ''));
    const cleanProse = (line: string) => clean(line.replace(/^[#>\-*\s]+/, ''));

    // Skip the shared preamble (절대규칙/존댓말 lines and any heading) when scanning prose.
    const isPreamble = (t: string): boolean =>
        t.startsWith('⚠️') || /^#{1,6}\s/.test(t) || /절대규칙|존댓말|한국어로 (작성|출력)/.test(t);

    // Per-agent heading lists + a global count of each raw heading. Also count each prose
    // line across agents so the fallback (step 3) can skip lines shared by ≥2 agents.
    const headings = new Map<string, string[]>();
    const headingCount = new Map<string, number>();
    const proseCount = new Map<string, number>();
    for (const [id, text] of prompts) {
        const hs: string[] = [];
        const seenProse = new Set<string>();
        for (const ln of text.split('\n')) {
            const t = ln.trim();
            if (/^#{1,6}\s+\S/.test(t)) { hs.push(t); continue; }
            if (t && !isPreamble(t) && !seenProse.has(t)) {
                seenProse.add(t);
                proseCount.set(t, (proseCount.get(t) || 0) + 1);
            }
        }
        headings.set(id, hs);
        for (const h of new Set(hs)) headingCount.set(h, (headingCount.get(h) || 0) + 1);
    }

    // Role headings usually read like "# 너의 임무", "# 너의 단독 작업", "# 렌즈 A: …",
    // "# 역할". Prefer a unique heading that looks like one of those over a merely-incidental
    // unique heading (e.g. "# 사전 확정 사실") that happens to differ between agents.
    const ROLE_HINT = /너의|임무|작업|렌즈|역할|관점|담당|단독/;
    const labels = new Map<string, { label: string; full: string }>();
    for (const [id, text] of prompts) {
        let label: { label: string; full: string } | null = null;
        const uniqueHeadings = (headings.get(id) || []).filter(h => (headingCount.get(h) || 0) < 2);
        // 1+2. prefer a role-looking unique heading; else the first unique heading.
        const roleHeading = uniqueHeadings.find(h => ROLE_HINT.test(h)) || uniqueHeadings[0];
        if (roleHeading) label = cleanHeading(roleHeading);
        // 3. fallback: first UNIQUE meaningful prose line. Cross-compare like headings —
        // skip lines shared by ≥2 agents (boilerplate) so a fan-out that opens with an
        // identical paragraph doesn't collapse every agent to the same label. If every
        // prose line is shared, leave it unset → the panel's distinct "에이전트 N" beats
        // N identical labels.
        if (!label) {
            for (const ln of text.split('\n')) {
                const t = ln.trim();
                if (!t || isPreamble(t)) continue;
                if ((proseCount.get(t) || 0) >= 2) continue;  // shared boilerplate — skip
                const c = cleanProse(t);
                if (c.label) { label = c; break; }
            }
        }
        if (label && label.label) labels.set(id, label);
    }
    return labels;
}

// Read an agent's log (agent-<id>.jsonl, appended in real time) and extract:
//   - durationMs: span between its first and last message timestamps
//   - activity: what it's doing right now (last tool call / last text) — used for
//     running agents (done agents show their journal result instead)
// Collect EVERY assistant step (tool calls + text blocks) in chronological order from an
// agent's jsonl lines, joined into one report. Used only for a DONE agent's full view so the
// user can see the agent's whole sequence of actions — not just its final message. A running
// agent still shows only its latest activity: the earlier steps aren't reliably all present
// until completion (agent jsonl is appended per finished message, not streamed), and the live
// "what is it doing right now" signal is what matters mid-run. Tool-using agents yield many
// steps; a pure-discussion agent (no tools) yields a single text block — that's a data limit,
// not a bug.
function collectAgentSteps(lines: string[]): string {
    const steps: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let e: any;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (e.type !== 'assistant' || !e.message) continue;
        const content = e.message.content;
        const blocks = Array.isArray(content)
            ? content
            : (typeof content === 'string' && content.trim() ? [{ type: 'text', text: content }] : []);
        for (const b of blocks) {
            if (b?.type === 'tool_use') {
                const arg = b.input?.file_path || b.input?.path || b.input?.command || b.input?.pattern || b.input?.description;
                const argStr = typeof arg === 'string' ? ` — ${arg.replace(/\s+/g, ' ').slice(0, 80)}` : '';
                steps.push(`🔧 ${b.name}${argStr}`);
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                steps.push(b.text.trim());
            }
        }
    }
    return steps.join('\n\n');
}

// Detect a killed/interrupted agent. When the user stops a running Task/workflow agent
// (TaskStop), Claude Code appends a trailing user record to its agent-<id>.jsonl carrying
// the literal text "[Request interrupted by user ...]" — and NO journal `result` / final
// assistant report ever lands. This marker is the explicit kill signal, so we detect it
// directly instead of guessing from elapsed time (a stale timeout would misjudge a long
// single tool call as dead). Verified by killing a live agent AND cross-checking three
// pre-existing dead workflows: every journal-result-less agent had exactly this marker.
function agentWasInterrupted(lines: string[]): boolean {
    for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln || !ln.trim()) continue;
        if (ln.indexOf('Request interrupted') === -1) continue;  // cheap pre-filter before parse
        try {
            const e = JSON.parse(ln);
            if (e.type !== 'user') continue;
            const content = e.message?.content;
            const text = Array.isArray(content)
                ? content.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ')
                : (typeof content === 'string' ? content : '');
            if (text.indexOf('Request interrupted') !== -1) return true;
        } catch { /* skip malformed line */ }
    }
    return false;
}

async function getAgentTiming(wfDirUri: vscode.Uri, agentId: string): Promise<{ durationMs: number; activity: string; fullActivity: string; fullSteps: string; firstTs: number; lastTs: number; interrupted: boolean }> {
    let firstTs = 0;
    let lastTs = 0;
    let activity = planT('wf.working');
    let fullActivity = '';
    let fullSteps = '';
    let interrupted = false;
    try {
        const content = await readTextFile(vscode.Uri.joinPath(wfDirUri, `agent-${agentId}.jsonl`));
        const lines = content.trim().split('\n');
        fullSteps = collectAgentSteps(lines);
        interrupted = agentWasInterrupted(lines);

        // First timestamp = start.
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            try {
                const e = JSON.parse(lines[i]);
                if (e.timestamp) { firstTs = new Date(e.timestamp).getTime(); break; }
            } catch { /* skip */ }
        }

        // Walk backwards for the last timestamp and the latest assistant activity.
        let foundActivity = false;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].trim()) continue;
            try {
                const e = JSON.parse(lines[i]);
                if (e.timestamp && !lastTs) lastTs = new Date(e.timestamp).getTime();
                if (!foundActivity && e.type === 'assistant' && e.message?.content) {
                    const blocks = e.message.content;
                    if (Array.isArray(blocks)) {
                        for (let k = blocks.length - 1; k >= 0; k--) {
                            const b = blocks[k];
                            if (b?.type === 'tool_use') {
                                const arg = b.input?.file_path || b.input?.path || b.input?.command || b.input?.pattern || b.input?.description;
                                const argStr = typeof arg === 'string' ? ` — ${arg.replace(/\s+/g, ' ').slice(0, 60)}` : '';
                                activity = `🔧 ${b.name}${argStr}`;
                                fullActivity = activity;
                                foundActivity = true;
                                break;
                            }
                            if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                                const t = b.text.replace(/\s+/g, ' ').trim();
                                activity = t.length > 140 ? t.slice(0, 140) + '…' : t;
                                fullActivity = b.text.trim();
                                foundActivity = true;
                                break;
                            }
                        }
                    } else if (typeof blocks === 'string' && blocks.trim()) {
                        const t = blocks.replace(/\s+/g, ' ').trim();
                        activity = t.length > 140 ? t.slice(0, 140) + '…' : t;
                        fullActivity = blocks.trim();
                        foundActivity = true;
                    }
                }
                if (lastTs && foundActivity) break;
            } catch { /* skip malformed line */ }
        }
    } catch { /* agent log not readable yet */ }
    const durationMs = (firstTs && lastTs && lastTs >= firstTs) ? lastTs - firstTs : 0;
    return { durationMs, activity, fullActivity, fullSteps, firstTs, lastTs, interrupted };
}

// Parse a single Task-subagent log (subagents/agent-<id>.jsonl + its sibling
// agent-<id>.meta.json) into a WorkflowAgentInfo. These are the agents the user
// launches via the Agent/Task tool — they live directly under subagents/ (NOT under
// subagents/workflows/) and are NOT recorded in any journal.jsonl.
//
// Completion rule: the agent is `done` when its LAST assistant entry is a FINAL text
// report that isn't mid-tool-call. stop_reason 'end_turn' is an explicit completion →
// done immediately. Newer Claude Code also ends a finished agent with sr=null — BUT so
// do mid-tool "explanation" text entries (flushed ~0.6s before the next tool entry).
// They're separated by SETTLE time, not size: a mid-tool text is followed by its tool
// entry within ~0.6s, so once a text-only last assistant entry has stayed idle ≥4s it is
// a final answer. (An earlier version also required ≥1500 chars, but that wrongly missed
// short finals like "핑 완료", leaving completed agents stuck as running.) A killed agent
// instead carries a "[Request interrupted]" marker → stopped (see agentWasInterrupted).
async function parseTaskAgent(
    subagentsDirUri: vscode.Uri,
    jsonlName: string
): Promise<{ agent: WorkflowAgentInfo; mtime: number; firstTs: number; lastTs: number } | null> {
    const idMatch = jsonlName.match(/^agent-(.+)\.jsonl$/);
    if (!idMatch) return null;
    let agentId = idMatch[1];

    let content: string;
    try {
        content = await readTextFile(vscode.Uri.joinPath(subagentsDirUri, jsonlName));
    } catch {
        return null;  // unreadable / vanished
    }
    const lines = content.trim().split('\n');
    if (lines.length === 0 || !lines[0].trim()) return null;

    // Display name from the meta.json sidecar (description preferred, then agentType).
    let displayName = '';
    try {
        const metaRaw = await readTextFile(vscode.Uri.joinPath(subagentsDirUri, jsonlName.replace(/\.jsonl$/, '.meta.json')));
        const meta = JSON.parse(metaRaw);
        if (typeof meta?.description === 'string' && meta.description.trim()) displayName = meta.description.trim();
        else if (typeof meta?.agentType === 'string' && meta.agentType.trim()) displayName = meta.agentType.trim();
    } catch { /* no/invalid meta — fall back below */ }

    // First & last timestamps for duration; recover agentId from the log if needed.
    let firstTs = 0;
    let lastTs = 0;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
            const e = JSON.parse(lines[i]);
            if (typeof e.agentId === 'string' && e.agentId) agentId = e.agentId;
            if (e.timestamp) { firstTs = new Date(e.timestamp).getTime(); break; }
        } catch { /* skip */ }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
            const e = JSON.parse(lines[i]);
            if (e.timestamp) { lastTs = new Date(e.timestamp).getTime(); break; }
        } catch { /* skip */ }
    }

    // Find the last assistant entry; decide done/running and extract its text.
    let isDone = false;
    let fullText = '';
    let activity = planT('wf.working');
    let fullActivity = '';
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        let e: any;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (e.type !== 'assistant' || !e.message) continue;

        const blocks = Array.isArray(e.message.content) ? e.message.content : [];
        const textBlock = blocks.find((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
        const toolUseBlock = blocks.find((b: any) => b?.type === 'tool_use');
        const sr = e.message.stop_reason;
        // See the "Completion rule" comment above. end_turn → done now; sr=null → done once
        // the entry has SETTLED (≥4s idle): a mid-tool "explanation" text is followed by its
        // tool entry within ~0.6s, so a text-only last assistant entry that stays idle ≥4s is
        // a final answer. Size-agnostic — an earlier ≥1500-char gate wrongly missed short
        // finals (e.g. "핑 완료"), leaving completed agents stuck as running.
        const settled = lastTs > 0 && (Date.now() - lastTs) >= 4000;
        if (textBlock && !toolUseBlock && sr !== 'tool_use' && (sr === 'end_turn' || settled)) {
            isDone = true;
            fullText = textBlock.text.trim();
        } else {
            // Still running — surface the latest activity (last tool_use or text).
            for (let k = blocks.length - 1; k >= 0; k--) {
                const b = blocks[k];
                if (b?.type === 'tool_use') {
                    const arg = b.input?.file_path || b.input?.path || b.input?.command || b.input?.pattern || b.input?.description;
                    const argStr = typeof arg === 'string' ? ` — ${arg.replace(/\s+/g, ' ').slice(0, 60)}` : '';
                    activity = `🔧 ${b.name}${argStr}`;
                    fullActivity = activity;
                    break;
                }
                if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                    const t = b.text.replace(/\s+/g, ' ').trim();
                    activity = t.length > 140 ? t.slice(0, 140) + '…' : t;
                    fullActivity = b.text.trim();
                    break;
                }
            }
        }
        break;  // only inspect the latest assistant entry
    }

    const durationMs = (firstTs && lastTs && lastTs >= firstTs) ? lastTs - firstTs : 0;
    const oneLine = fullText.replace(/\s+/g, ' ').trim();
    const preview = oneLine.length > 160 ? oneLine.slice(0, 160) + '…' : oneLine;

    // Not done and carrying a "[Request interrupted]" marker → killed (stopped), not running.
    const interrupted = agentWasInterrupted(lines);
    const status: 'running' | 'done' | 'stopped' = isDone ? 'done' : (interrupted ? 'stopped' : 'running');

    const agent: WorkflowAgentInfo = {
        agentId,
        status,
        summary: status === 'done' ? preview : activity,
        // done/stopped → full chronological steps (every tool call + text) so the user sees the
        // whole run (a killed agent's last actions too), falling back to the final report text.
        // Running → latest activity only.
        fullSummary: status === 'running' ? fullActivity : (collectAgentSteps(lines) || fullText || fullActivity),
        durationMs,
        name: displayName || 'agent',
    };
    let mtime = 0;
    try {
        mtime = (await vscode.workspace.fs.stat(vscode.Uri.joinPath(subagentsDirUri, jsonlName))).mtime;
    } catch { /* ignore */ }
    return { agent, mtime, firstTs, lastTs };
}

// Scan subagents/ for Task-subagent logs (agent-*.jsonl, NOT under workflows/) and
// bundle them into a single pseudo-workflow. wfId = 'tasks' (does NOT start with
// 'wf_'), so the trash path (trashWorkflowDir) naturally refuses it. Returns null
// when there are no Task agents.
// Bundle the flat subagents/agent-*.jsonl logs into ONE pseudo-workflow PER BATCH. Agents
// spun up together (a fan-out) share a near-identical start time; a batch launched later
// (after a gap) becomes its own group with its own header — so the user can tell "the
// agents I just launched" apart from an unrelated batch run an hour ago. Each batch's wfId
// is 'tasks:<batchStartTs>' (unique, starts with 'tasks:' so the panel/delete paths spot it).
async function findTaskAgentBundles(sessionDirUri: vscode.Uri): Promise<{ wf: WorkflowInfo; mtime: number }[]> {
    const subagentsDirUri = vscode.Uri.joinPath(sessionDirUri, 'subagents');
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(subagentsDirUri);
    } catch {
        return [];  // no subagents dir
    }
    const parsed: { agent: WorkflowAgentInfo; mtime: number; firstTs: number; lastTs: number }[] = [];
    for (const [name, ftype] of entries) {
        if (ftype !== vscode.FileType.File) continue;
        if (!/^agent-.+\.jsonl$/.test(name)) continue;  // skip .meta.json, workflows/, etc.
        try {
            const p = await parseTaskAgent(subagentsDirUri, name);
            if (p) parsed.push(p);
        } catch { /* skip this agent */ }
    }
    if (parsed.length === 0) return [];
    // Cluster by start-time gap: consecutive starts >5 min apart begin a new batch.
    parsed.sort((a, b) => a.firstTs - b.firstTs);
    const GAP_MS = 5 * 60 * 1000;
    const batches: { agent: WorkflowAgentInfo; mtime: number; firstTs: number; lastTs: number }[][] = [];
    let cur: { agent: WorkflowAgentInfo; mtime: number; firstTs: number; lastTs: number }[] = [];
    for (const p of parsed) {
        if (cur.length && (p.firstTs - cur[cur.length - 1].firstTs) > GAP_MS) {
            batches.push(cur);
            cur = [];
        }
        cur.push(p);
    }
    if (cur.length) batches.push(cur);
    // One WorkflowInfo per batch, labelled by its start clock so batches are distinguishable.
    return batches.map(batch => {
        const startTs = batch[0].firstTs;
        const endTs = batch.reduce((m, x) => Math.max(m, x.lastTs), 0);
        const newestMtime = batch.reduce((m, x) => Math.max(m, x.mtime), 0);
        const agents = batch.map(x => x.agent).sort((a, b) => a.agentId.localeCompare(b.agentId));
        const d = new Date(startTs);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const wf: WorkflowInfo = {
            wfId: 'tasks:' + startTs,
            name: planT('wf.taskBundle', `${hh}:${mm}`, agents.length),
            description: '',
            phases: [],
            agents,
            ...(startTs ? { startedAt: startTs } : {}),
            ...(endTs ? { endedAt: endTs } : {}),
        };
        return { wf, mtime: newestMtime };
    });
}

function parseWorkflowScriptMeta(js: string): { name: string; description: string; phases: string[] } {
    let name = '';
    let description = '';
    const phases: string[] = [];
    try {
        const nameMatch = js.match(/name\s*:\s*['"]([^'"]+)['"]/);
        if (nameMatch) name = nameMatch[1];
        const descMatch = js.match(/description\s*:\s*['"]([^'"]+)['"]/);
        if (descMatch) description = descMatch[1];
        for (const m of js.matchAll(/title\s*:\s*['"]([^'"]+)['"]/g)) phases.push(m[1]);
    } catch { /* fallback */ }
    return { name, description, phases };
}

async function findWorkflowsForSession(sessionFileUri: string): Promise<WorkflowInfo[]> {
    // Collect with each workflow's journal mtime so we can sort newest-activity-first.
    const wfList: { wf: WorkflowInfo; mtime: number }[] = [];
    try {
        const uri = vscode.Uri.parse(sessionFileUri);
        // The session JSONL lives at projects/<slug>/<session-uuid>.jsonl, while its
        // workflow data lives in the sibling directory projects/<slug>/<session-uuid>/.
        // So the session dir is the JSONL path with its .jsonl extension stripped — NOT
        // the parent folder.
        const sessionDirUri = uri.with({ path: uri.path.replace(/\.jsonl$/, '') });

        const workflowsDirUri = vscode.Uri.joinPath(sessionDirUri, 'subagents', 'workflows');
        let wfDirs: [string, vscode.FileType][] = [];
        try {
            wfDirs = await vscode.workspace.fs.readDirectory(workflowsDirUri);
        } catch {
            // No workflows/ dir — that's fine; Task subagents (below) may still exist.
            wfDirs = [];
        }

        const scriptsDirUri = vscode.Uri.joinPath(sessionDirUri, 'workflows', 'scripts');
        let scriptEntries: [string, vscode.FileType][] = [];
        try {
            scriptEntries = await vscode.workspace.fs.readDirectory(scriptsDirUri);
        } catch { /* no scripts dir */ }

        for (const [wfId, ftype] of wfDirs) {
            if (ftype !== vscode.FileType.Directory || !wfId.startsWith('wf_')) continue;

            const wfDirUri = vscode.Uri.joinPath(workflowsDirUri, wfId);
            const agents: WorkflowAgentInfo[] = [];
            let wfStartedAt = 0;  // earliest agent firstTs; endedAt = latest agent lastTs
            let wfEndedAt = 0;
            try {
                const journalContent = await readTextFile(vscode.Uri.joinPath(wfDirUri, 'journal.jsonl'));
                const startedIds = new Set<string>();
                const doneSummary = new Map<string, { preview: string; full: string }>();
                for (const line of journalContent.trim().split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const rec = JSON.parse(line);
                        if (rec.type === 'started' && rec.agentId) startedIds.add(rec.agentId);
                        else if (rec.type === 'result' && rec.agentId) {
                            doneSummary.set(rec.agentId, summarizeResultFull(rec.result));
                        }
                    } catch { /* skip malformed line */ }
                }
                // Derive per-agent role labels from their first prompts (no label is stored
                // on disk — see deriveAgentRoleLabels). Done once per workflow so unique vs.
                // boilerplate headings can be told apart by cross-comparing the agents.
                const promptTexts = new Map<string, string>();
                for (const id of startedIds) {
                    promptTexts.set(id, await getAgentFirstPromptText(wfDirUri, id));
                }
                const roleLabels = deriveAgentRoleLabels(promptTexts);
                for (const id of startedIds) {
                    const isDone = doneSummary.has(id);
                    const timing = await getAgentTiming(wfDirUri, id);
                    if (timing.firstTs && (!wfStartedAt || timing.firstTs < wfStartedAt)) wfStartedAt = timing.firstTs;
                    if (timing.lastTs > wfEndedAt) wfEndedAt = timing.lastTs;
                    // A journal `result` = completed; else a "[Request interrupted]" marker in the
                    // agent log = killed (stopped); with neither it is genuinely still running.
                    const status: 'running' | 'done' | 'stopped' = isDone ? 'done' : (timing.interrupted ? 'stopped' : 'running');
                    const res = doneSummary.get(id);
                    const summary = status === 'done' ? (res?.preview || '') : timing.activity;
                    // done/stopped → show the agent's full chronological steps (all tool calls +
                    // text), so the user sees everything it did (a killed agent's last actions
                    // included). Fall back to the journal result's full text. Running → latest only.
                    const fullSummary = status === 'running'
                        ? timing.fullActivity
                        : (timing.fullSteps || (status === 'done' ? (res?.full || '') : timing.fullActivity));
                    const role = roleLabels.get(id);  // undefined → panel falls back to "에이전트 N"
                    const name = role?.label;
                    // Only surface fullName when it actually differs (i.e. the label was clipped),
                    // so unchanged labels don't carry a redundant tooltip.
                    const fullName = role && role.full !== role.label ? role.full : undefined;
                    agents.push({ agentId: id, status, summary, fullSummary, durationMs: timing.durationMs, ...(name ? { name } : {}), ...(fullName ? { fullName } : {}) });
                }
            } catch { /* journal unreadable */ }

            let name = wfId;
            let description = '';
            let phases: string[] = [];
            const scriptEntry = scriptEntries.find(([n]) => n.endsWith(`-${wfId}.js`));
            if (scriptEntry) {
                try {
                    const js = await readTextFile(vscode.Uri.joinPath(scriptsDirUri, scriptEntry[0]));
                    const parsed = parseWorkflowScriptMeta(js);
                    name = parsed.name || wfId;
                    description = parsed.description;
                    phases = parsed.phases;
                } catch { /* fallback to wfId */ }
            }

            // Stable agent order (same on every refresh) instead of journal-append order.
            agents.sort((a, b) => a.agentId.localeCompare(b.agentId));

            let mtime = 0;
            try {
                mtime = (await vscode.workspace.fs.stat(vscode.Uri.joinPath(wfDirUri, 'journal.jsonl'))).mtime;
            } catch { /* no journal yet */ }

            wfList.push({ wf: { wfId, name, description, phases, agents, ...(wfStartedAt ? { startedAt: wfStartedAt } : {}), ...(wfEndedAt ? { endedAt: wfEndedAt } : {}) }, mtime });
        }

        // Task subagents (Agent tool) — bundle the flat subagents/agent-*.jsonl logs into
        // one pseudo-workflow PER BATCH (grouped by start-time gap) alongside the journals.
        try {
            const taskBundles = await findTaskAgentBundles(sessionDirUri);
            for (const b of taskBundles) wfList.push(b);
        } catch (e) {
            log(`[workflows] task-agent scan error: ${e}`);
        }
    } catch (e) {
        log(`[workflows] scan error: ${e}`);
    }
    // Newest activity first — the workflow you just launched floats to the top.
    wfList.sort((a, b) => b.mtime - a.mtime);
    return wfList.map(x => x.wf);
}

// Which wf_* workflows have TRULY finished, per the parent session log — not per the
// journal. A workflow's journal.jsonl only holds `started`/`result` lines; it has NO
// "the whole script finished" marker. So when a script runs batches sequentially
// (parallel → then another parallel), the gap between batches momentarily looks
// "all agents done" even though the next batch hasn't spawned yet. The only reliable
// end-of-workflow signal lives in the parent session JSONL: the Workflow tool runs in
// the background and, on completion, a <task-notification> with <status>completed</status>
// is injected. We map each launch (`Task ID: … Run ID: wf_…`, same line) to its wfId, then
// collect the task-ids whose notification says completed. The returned set is the wfIds we
// can safely beep for; anything all-done-in-journal but absent here is a mid-run batch gap.
async function getCompletedWorkflowIds(sessionFileUri: string): Promise<Set<string>> {
    const completed = new Set<string>();
    let content: string;
    try {
        content = await readTextFile(vscode.Uri.parse(sessionFileUri));
    } catch {
        return completed;  // session unreadable → treat as "nothing confirmed done"
    }
    const taskToWf = new Map<string, string>();   // task-id → wfId (from launch tool_result)
    const completedTasks = new Set<string>();      // task-ids whose notification = completed
    // Both the launch result and the task-notification are single JSONL lines, so the
    // Task ID / Run ID pair (and the task-id / status pair) always co-occur on one line.
    for (const line of content.split('\n')) {
        if (!line) continue;
        // Launch: "…Task ID: w68nikq1i…Run ID: wf_4fd355e2-228…"
        if (line.includes('Task ID:') && line.includes('Run ID:')) {
            const tid = /Task ID: (\w+)/.exec(line);
            const wid = /Run ID: (wf_[A-Za-z0-9-]+)/.exec(line);
            // Capture group 1 holds the wfId (there's only one group) — wid[1], NOT wid[2].
            if (tid && wid) taskToWf.set(tid[1], wid[1]);
        }
        // Completion notice: "…<task-id>w68nikq1i</task-id>…<status>completed</status>…"
        if (line.includes('<task-notification>')) {
            const tid = /<task-id>(\w+)<\/task-id>/.exec(line);
            const st = /<status>(\w+)<\/status>/.exec(line);
            if (tid && st && st[1] === 'completed') completedTasks.add(tid[1]);
        }
    }
    for (const tid of completedTasks) {
        const wfId = taskToWf.get(tid);
        if (wfId) completed.add(wfId);
    }
    return completed;
}

// The PRIMARY end-of-workflow signal: <sessionDir>/workflows/<wfId>.json — a per-run result
// record the workflow runtime writes when the whole script terminates. Its top-level `status`
// is "completed" | "failed" | "killed" (the `pass` values some workflows contain live inside
// `result`, not here). Unlike the session JSONL's task-notification, this file's mtime lands
// the instant the run ends, so it's a reliable real-time completion marker. Returns the status
// string, or null when the file is missing / still being written / mid-run (no top-level status
// yet) — in which case the caller falls back to the task-notification parser above.
// NOTE freshness: the caller still gates on seenRunningWorkflowKeys (observedRunning), so a
// stale "completed" marker left by an earlier run (e.g. resumeFromRunId) that we never watched
// go running this runtime is baselined silently rather than beeping.
async function readWorkflowTerminalStatus(sessionFileUri: string, wfId: string): Promise<string | null> {
    try {
        const uri = vscode.Uri.parse(sessionFileUri);
        const sessionDirUri = uri.with({ path: uri.path.replace(/\.jsonl$/, '') });
        const markerUri = vscode.Uri.joinPath(sessionDirUri, 'workflows', `${wfId}.json`);
        const raw = await readTextFile(markerUri);
        const parsed = JSON.parse(raw);
        if (parsed && parsed.runId === wfId && typeof parsed.status === 'string') {
            return parsed.status;
        }
        return null;
    } catch {
        return null;  // missing, or JSON.parse failed because it's being written → retry next poll
    }
}

// Delete a workflow's data directory (.../subagents/workflows/<wfId>/). Used by the
// panel's delete button. Returns true on success.
// --- Workflow trash -------------------------------------------------------
//
// The Codex panel's counterpart, and for the same reason: a workflow's journal and agent logs
// live under ~/.claude and are not in any repository, so the delete button used to be the end
// of them. Trashed workflows move to `workflows/.trash/<wfId>/`, which the discovery loop
// already skips — it only descends into names starting with `wf_`.

export interface TrashedWorkflow {
    wfId: string;
    name?: string;
    deletedAt: number;
    agentCount: number;
}

function workflowsDirOf(sessionFileUri: string): vscode.Uri {
    const uri = vscode.Uri.parse(sessionFileUri);
    const sessionDirUri = uri.with({ path: uri.path.replace(/\.jsonl$/, '') });
    return vscode.Uri.joinPath(sessionDirUri, 'subagents', 'workflows');
}

/** Move a workflow into the trash. Returns false when it isn't there or the move fails. */
async function trashWorkflowDir(sessionFileUri: string, wfId: string,
                                name: string | undefined, agentCount: number): Promise<boolean> {
    if (!wfId.startsWith('wf_')) return false;
    try {
        const wfRoot = workflowsDirOf(sessionFileUri);
        const trashRoot = vscode.Uri.joinPath(wfRoot, '.trash');
        await vscode.workspace.fs.createDirectory(trashRoot);
        const dst = vscode.Uri.joinPath(trashRoot, wfId);
        // Re-trashing the same id would otherwise fail on an existing destination.
        try { await vscode.workspace.fs.delete(dst, { recursive: true, useTrash: false }); } catch { /* absent */ }
        await vscode.workspace.fs.rename(vscode.Uri.joinPath(wfRoot, wfId), dst, { overwrite: true });
        const meta = { schema: 1, wfId, name, agentCount, deletedAt: Date.now() };
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(trashRoot, `${wfId}.json`),
                                            Buffer.from(JSON.stringify(meta), 'utf8'));
        log(`[workflows] trashed ${wfId}`);
        return true;
    } catch (e) {
        log(`[workflows] trash failed for ${wfId}: ${e}`);
        return false;
    }
}

async function listWorkflowTrash(sessionFileUri: string): Promise<TrashedWorkflow[]> {
    const trashRoot = vscode.Uri.joinPath(workflowsDirOf(sessionFileUri), '.trash');
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(trashRoot);
    } catch {
        return [];
    }
    const out: TrashedWorkflow[] = [];
    for (const [name, type] of entries) {
        if (!(type & vscode.FileType.Directory) || !name.startsWith('wf_')) continue;
        let meta: any = null;
        try {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(trashRoot, `${name}.json`)));
            meta = JSON.parse(raw.toString('utf8'));
        } catch { /* metadata is a convenience, not a requirement */ }
        out.push({
            wfId: name,
            name: meta?.name,
            deletedAt: typeof meta?.deletedAt === 'number' ? meta.deletedAt : 0,
            agentCount: typeof meta?.agentCount === 'number' ? meta.agentCount : 0,
        });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Put a trashed workflow back. Refuses when a live workflow already holds that id. */
async function restoreWorkflow(sessionFileUri: string, wfId: string): Promise<boolean> {
    if (!wfId.startsWith('wf_')) return false;
    try {
        const wfRoot = workflowsDirOf(sessionFileUri);
        const dst = vscode.Uri.joinPath(wfRoot, wfId);
        try {
            await vscode.workspace.fs.stat(dst);
            log(`[workflows] restore refused for ${wfId}: id already in use`);
            return false;
        } catch { /* free — proceed */ }
        const trashRoot = vscode.Uri.joinPath(wfRoot, '.trash');
        await vscode.workspace.fs.rename(vscode.Uri.joinPath(trashRoot, wfId), dst, { overwrite: false });
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(trashRoot, `${wfId}.json`), { useTrash: false });
        } catch { /* metadata may not exist */ }
        log(`[workflows] restored ${wfId}`);
        return true;
    } catch (e) {
        log(`[workflows] restore failed for ${wfId}: ${e}`);
        return false;
    }
}

async function purgeWorkflow(sessionFileUri: string, wfId: string): Promise<boolean> {
    if (!wfId.startsWith('wf_')) return false;
    const trashRoot = vscode.Uri.joinPath(workflowsDirOf(sessionFileUri), '.trash');
    let ok = false;
    try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(trashRoot, wfId),
                                         { recursive: true, useTrash: false });
        ok = true;
    } catch (e) {
        log(`[workflows] purge failed for ${wfId}: ${e}`);
    }
    try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(trashRoot, `${wfId}.json`), { useTrash: false });
    } catch { /* metadata may not exist */ }
    return ok;
}

async function pushWfTrash(sessionFileUri: string): Promise<void> {
    pushWorkflowTrash(await listWorkflowTrash(sessionFileUri));
}

async function emptyWorkflowTrash(sessionFileUri: string): Promise<number> {
    let n = 0;
    for (const it of await listWorkflowTrash(sessionFileUri)) {
        if (await purgeWorkflow(sessionFileUri, it.wfId)) n++;
    }
    return n;
}

// Clear the COMPLETED Task-subagent logs (agent-*.jsonl + paired .meta.json) for a
// session's pseudo-workflow ('tasks'). Running agents are kept so we never remove a log
// a live agent is still appending to. Returns the number of agents cleared.
async function deleteDoneTaskAgents(sessionFileUri: string, wfId: string): Promise<number> {
    try {
        const uri = vscode.Uri.parse(sessionFileUri);
        const sessionDirUri = uri.with({ path: uri.path.replace(/\.jsonl$/, '') });
        // Clear only the COMPLETED agents in THIS batch (wfId 'tasks:<startTs>'); running ones
        // and other batches stay untouched.
        const bundles = await findTaskAgentBundles(sessionDirUri);
        const batch = bundles.find(b => b.wf.wfId === wfId);
        if (!batch) return 0;
        const subagentsDirUri = vscode.Uri.joinPath(sessionDirUri, 'subagents');
        let cleared = 0;
        for (const agent of batch.wf.agents) {
            if (agent.status !== 'done') continue;  // keep running agents
            const jsonlName = 'agent-' + agent.agentId + '.jsonl';
            try {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(subagentsDirUri, jsonlName), { useTrash: false });
                cleared++;
            } catch (e) { log(`[tasks] delete failed for ${jsonlName}: ${e}`); }
            try {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(subagentsDirUri, 'agent-' + agent.agentId + '.meta.json'), { useTrash: false });
            } catch { /* meta may not exist */ }
        }
        return cleared;
    } catch (e) {
        log(`[tasks] delete error: ${e}`);
        return 0;
    }
}

// Encode an absolute workspace path into Claude's projects/ directory name format.



async function findActiveSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    let fallbackCandidate: { uri: vscode.Uri, mtime: Date, projectDir: string } | null = null;
    const projectsUri = await getClaudeProjectsUri();
    if (!projectsUri) return sessions;

    try {
        await vscode.workspace.fs.stat(projectsUri);
    } catch {
        return sessions; // ~/.claude/projects doesn't exist on this host
    }

    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const contextLimitDefault = config.get<number>('contextLimitDefault', 200000);
    const contextLimitOpus = config.get<number>('contextLimitOpus', 1000000);
    const idleTimeout = config.get<number>('idleTimeout', 180);
    const hideAfterRaw = config.get<number>('hideAfter', 86400);
    const scope = config.get<string>('scope', 'workspace');  // 'workspace' or 'all'

    // Guarantee hideAfter >= idleTimeout so dimming happens before hiding
    const hideAfter = Math.max(hideAfterRaw, idleTimeout);

    const now = Date.now();
    const idleThreshold = now - (idleTimeout * 1000);  // Older than this → dimmed
    const hideThreshold = now - (hideAfter * 1000);    // Older than this → fully hidden

    // Read global effort level once per refresh — Claude Code stores this in ~/.claude/settings.json
    // and applies the same value to every interactive session on this machine.
    const globalEffortLevel = await getGlobalEffortLevel();

    // Filter to only workspace folders if scope='workspace'
    let workspaceDirs: Set<string> | null = null;
    // Map from encoded dir name → actual folder basename (for exact display name)
    const workspaceNameMap = new Map<string, string>();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (scope === 'workspace') {
        workspaceDirs = getWorkspaceProjectDirs();
        if (workspaceFolders) {
            for (const f of workspaceFolders) {
                const encoded = encodeWorkspacePath(f.uri.fsPath).toLowerCase();
                workspaceNameMap.set(encoded, path.basename(f.uri.fsPath));
                log(`Workspace: ${f.uri.fsPath} → encoded: ${encoded}`);
            }
        } else {
            log('scope=workspace but no workspaceFolders — will show all sessions');
        }
    }

    try {
        const projectEntries = await vscode.workspace.fs.readDirectory(projectsUri);

        for (const [projectDir, ftype] of projectEntries) {
            if (ftype !== vscode.FileType.Directory) continue;
            const projectUri = vscode.Uri.joinPath(projectsUri, projectDir);

            // Skip Claude Memory, plugin directories, and Claude's own .claude config dir
            if (projectDir.includes('claude-plugins') || projectDir.includes('claude-mem')) continue;
            if (projectDir.endsWith('--claude')) continue;  // /path/.claude encoded as --claude suffix
            // Throwaway sessions the block primer creates to anchor the 5-hour window — not real work
            if (projectDir.includes(blockPrimer.PRIMER_MARK)) continue;

            // If scope='workspace', only include projects that match the current workspace folders
            if (workspaceDirs !== null && workspaceFolders) {
                const matched = workspaceFolders.some(f => projectDirMatchesFolder(projectDir, f));
                if (!matched) {
                    log(`Skip (no workspace match): ${projectDir}`);
                    continue;
                }
                log(`Match: ${projectDir}`);
            } else if (workspaceDirs !== null) {
                // No workspace folders open → skip all (scope=workspace with no folder = nothing to show)
                continue;
            }

            // Find JSONL files modified within cutoff time
            const projEntries = await vscode.workspace.fs.readDirectory(projectUri);
            const allJsonl = projEntries
                .filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.jsonl') && !n.startsWith('agent-'))
                .map(([n]) => n);
            log(`  JSONL files in ${projectDir}: ${allJsonl.length}`);
            const fileStats = await Promise.all(allJsonl.map(async (n) => {
                const uri = vscode.Uri.joinPath(projectUri, n);
                let mtime = new Date(0);
                try { mtime = new Date((await vscode.workspace.fs.stat(uri)).mtime); } catch { /* skip unreadable */ }
                return { name: n, uri, mtime };
            }));
            // Track the newest file across all projects regardless of hideThreshold (fallback use)
            if (fileStats.length > 0) {
                const newest = fileStats.reduce((a, b) => a.mtime.getTime() > b.mtime.getTime() ? a : b);
                if (!fallbackCandidate || newest.mtime.getTime() > fallbackCandidate.mtime.getTime()) {
                    fallbackCandidate = { uri: newest.uri, mtime: newest.mtime, projectDir };
                }
            }

            const files = fileStats
                .filter(f => {
                    const ok = f.mtime.getTime() > hideThreshold;
                    if (!ok) log(`  Skip (too old, ${Math.round((Date.now() - f.mtime.getTime()) / 60000)}m ago): ${f.name}`);
                    return ok;
                })
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            if (files.length === 0) { log(`  No recent JSONL files (hideAfter=${hideAfter}s)`); continue; }

            // Get token count from EACH active session file (1 per Claude Code tab)
            for (const file of files) {
                const usage = await getLatestTokenCount(file.uri);
                log(`  ${file.name}: tokens=${usage.totalTokens}, wasCleared=${usage.wasCleared}`);

                if (usage.totalTokens > 0) {
                    const { name, fullPath } = decodeProjectPath(projectDir);
                    // In workspace mode, use the actual folder basename (exact, no heuristic)
                    let displayName = workspaceNameMap.get(projectDir.toLowerCase()) || name;
                    if (scope === 'workspace' && workspaceFolders && displayName === name) {
                        // Fallback: find the matching folder and use its actual basename
                        const matchedFolder = workspaceFolders.find(f => projectDirMatchesFolder(projectDir, f));
                        if (matchedFolder) displayName = path.basename(matchedFolder.uri.fsPath);
                    }
                    // Extract short session ID from filename
                    const sessionId = file.name.replace('.jsonl', '').substring(0, 8);
                    // Auto-detect context limit based on model
                    const sessionContextLimit = getContextLimitForModel(usage.model, contextLimitDefault, contextLimitOpus);
                    sessions.push({
                        provider: 'claude',
                        projectName: displayName,
                        projectPath: fullPath,
                        sessionId,
                        sessionFile: file.uri.toString(),
                        inputTokens: usage.inputTokens,
                        cacheReadTokens: usage.cacheReadTokens,
                        cacheCreationTokens: usage.cacheCreationTokens,
                        totalTokens: usage.totalTokens,
                        percentage: Math.round((usage.totalTokens / sessionContextLimit) * 100),
                        lastUpdated: usage.lastRealTimestamp || file.mtime,
                        model: usage.model,
                        speed: usage.speed,
                        effortLevel: globalEffortLevel,
                        contextLimit: sessionContextLimit,
                        firstMessage: usage.firstMessage,
                        sessionCreated: usage.sessionCreated,
                        wasCleared: usage.wasCleared,
                        isIdle: file.mtime.getTime() <= idleThreshold,
                        lastActivityAt: usage.lastActivityAt,
                        lastAssistantEndTurnAt: usage.lastAssistantEndTurnAt,
                        pendingQuestionAt: usage.pendingQuestionAt,
                        pendingToolUseAt: usage.pendingToolUseAt,
                        pendingToolUseName: usage.pendingToolUseName
                    });
                }
            }
        }
    } catch (e) {
        console.error('Error scanning Claude projects:', e);
    }

    // Group sessions by base project name
    const projectGroups = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
        const base = session.projectName;
        if (!projectGroups.has(base)) {
            projectGroups.set(base, []);
        }
        projectGroups.get(base)!.push(session);
    }

    // Process each project group: filter superseded sessions and apply stable numbering
    const finalSessions: SessionInfo[] = [];
    for (const [baseName, group] of projectGroups) {
        // Sort by session CREATION time (newest first) to identify supersession
        group.sort((a, b) => {
            const aTime = a.sessionCreated?.getTime() || 0;
            const bTime = b.sessionCreated?.getTime() || 0;
            return bTime - aTime;  // Newest first
        });

        // Filter out superseded sessions
        // A session is "superseded" if:
        // 1. A newer session exists that was created AFTER this session's last update
        //    (meaning the user started a new session after abandoning this one)
        // 2. OR it has wasCleared=true (ended with /clear, no activity after)

        const activeSessions: SessionInfo[] = [];

        for (let i = 0; i < group.length; i++) {
            const session = group[i];

            // Check if cleared
            if (session.wasCleared) {
                continue; // Skip cleared sessions
            }

            // Check if superseded by a newer session
            let isSuperseded = false;
            for (let j = 0; j < i; j++) {
                const newerSession = group[j];
                const newerCreated = newerSession.sessionCreated?.getTime() || 0;
                const thisLastUpdated = session.lastUpdated.getTime();

                // If a newer session was CREATED after this session's LAST UPDATE,
                // then this session was abandoned and shouldn't be shown
                if (newerCreated > thisLastUpdated) {
                    isSuperseded = true;
                    break;
                }
            }

            if (!isSuperseded) {
                activeSessions.push(session);
            }
        }

        // Re-sort by creation time for stable numbering (oldest first)
        activeSessions.sort((a, b) => {
            const aTime = a.sessionCreated?.getTime() || 0;
            const bTime = b.sessionCreated?.getTime() || 0;
            return aTime - bTime;
        });

        // Apply stable numbering
        for (let i = 0; i < activeSessions.length; i++) {
            if (i === 0) {
                activeSessions[i].projectName = baseName;
            } else {
                activeSessions[i].projectName = `${baseName}-${i + 1}`;
            }
        }

        finalSessions.push(...activeSessions);
    }

    // Sort by mtime for display order (most recent first)
    finalSessions.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

    // Filter out manually hidden sessions, but auto-unhide if there's new activity
    const visibleSessions = finalSessions.filter(session => {
        const hiddenAt = hiddenSessions.get(session.sessionFile);
        if (hiddenAt) {
            // Check if session was modified after it was hidden
            if (session.lastUpdated.getTime() > hiddenAt) {
                // New activity! Remove from hidden list
                hiddenSessions.delete(session.sessionFile);
                return true; // Show it
            }
            return false; // Still hidden
        }
        return true; // Not hidden
    });

    // No active sessions — show the most recently seen session dimmed (hideAfter exceeded)
    if (visibleSessions.length === 0 && fallbackCandidate) {
        const usage = await getLatestTokenCount(fallbackCandidate.uri);
        if (usage.totalTokens > 0) {
            const { name, fullPath } = decodeProjectPath(fallbackCandidate.projectDir);
            let displayName = name;
            if (scope === 'workspace' && workspaceFolders) {
                const matchedFolder = workspaceFolders.find(f => projectDirMatchesFolder(fallbackCandidate!.projectDir, f));
                if (matchedFolder) displayName = path.basename(matchedFolder.uri.fsPath);
            }
            const sessionId = fallbackCandidate.uri.path.split('/').pop()?.replace('.jsonl', '').substring(0, 8) || '';
            const sessionContextLimit = getContextLimitForModel(usage.model, contextLimitDefault, contextLimitOpus);
            visibleSessions.push({
                provider: 'claude',
                projectName: displayName,
                projectPath: fullPath,
                sessionId,
                sessionFile: fallbackCandidate.uri.toString(),
                inputTokens: usage.inputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                totalTokens: usage.totalTokens,
                percentage: Math.round((usage.totalTokens / sessionContextLimit) * 100),
                lastUpdated: usage.lastRealTimestamp || fallbackCandidate.mtime,
                model: usage.model,
                speed: usage.speed,
                effortLevel: globalEffortLevel,
                contextLimit: sessionContextLimit,
                firstMessage: usage.firstMessage,
                sessionCreated: usage.sessionCreated,
                wasCleared: usage.wasCleared,
                isIdle: true,
                isFallback: true,
                lastActivityAt: usage.lastActivityAt,
                lastAssistantEndTurnAt: usage.lastAssistantEndTurnAt,
                pendingQuestionAt: usage.pendingQuestionAt,
                pendingToolUseAt: usage.pendingToolUseAt,
                pendingToolUseName: usage.pendingToolUseName
            });
        }
    }

    return visibleSessions.slice(0, 5);
}

/**
 * Merge every provider's sessions into the list the status bar renders.
 *
 * Claude discovery is untouched — Codex is gathered independently and appended, so a
 * failure inside the Codex provider can never regress Claude (docs risk register:
 * "one provider crash affects all"). Provider grouping is deliberate: Claude must always
 * occupy the left side of the context-bar group and Codex the right side, regardless of
 * which session was updated most recently.
 */
async function findAllSessions(): Promise<SessionInfo[]> {
    const claude = await findActiveSessions();

    let codex: SessionInfo[] = [];
    try {
        codex = await findCodexSessions();
    } catch (e) {
        log(`[codex] discovery failed (Claude unaffected): ${e}`);
        codex = [];
    }
    if (codex.length === 0) return claude;

    // Codex sessions honour the same manual hide + auto-unhide-on-activity rule as Claude.
    const visibleCodex = codex.filter(session => {
        const hiddenAt = hiddenSessions.get(session.sessionFile);
        if (!hiddenAt) return true;
        if (session.lastUpdated.getTime() > hiddenAt) {
            log(`[hide] auto-unhide (codex) ${session.projectName}: activity ` +
                `${session.lastUpdated.toISOString()} is newer than hide ${new Date(hiddenAt).toISOString()}`);
            hiddenSessions.delete(session.sessionFile);
            return true;
        }
        return false;
    });
    if (hiddenSessions.size > 0) {
        // Any hidden key that matches nothing we just discovered means the key the user hid
        // is not the key we now generate — the session would reappear forever. Logged so a
        // mismatch is diagnosable instead of looking like "hide is broken".
        const known = new Set([...claude, ...codex].map(s => s.sessionFile));
        for (const [k] of hiddenSessions) {
            if (!known.has(k)) log(`[hide] hidden key no longer matches any discovered session: ${k}`);
        }
    }

    // Do not globally sort this array. Status-bar priorities are assigned from this order,
    // and a global lastUpdated sort makes Claude/Codex swap sides whenever activity changes.
    return [...claude, ...visibleCodex];
}

// Read global effort level from ~/.claude/settings.json. Returns lowercase raw value
// like "low" | "medium" | "high" | "xhigh" | "max", or '' on failure.
// Note: Claude Code stores this globally; all interactive sessions share the same effort.
async function getGlobalEffortLevel(): Promise<string> {
    try {
        const base = await getClaudeBaseUri();
        if (!base) return '';
        const raw = await readTextFile(vscode.Uri.joinPath(base, 'settings.json'));
        const parsed = JSON.parse(raw);
        const v = parsed?.effortLevel;
        return typeof v === 'string' ? v.toLowerCase() : '';
    } catch (e) {
        return '';
    }
}

async function refreshAllSessions() {
    const suppressBeep = getFirstScan();
    setFirstScan(false);
    // File watchers are best effort (especially after sleep). The regular refresh also
    // adopts a newer account snapshot written by another extension host.
    syncCodexUsageFromSharedCache();
    const sessions = await findAllSessions();
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const warningThreshold = config.get<number>('warningThreshold', 50);
    const dangerThreshold = config.get<number>('dangerThreshold', 75);
    const baseColor = config.get<string>('baseColor', 'White');
    const compactMode = config.get<boolean>('compactMode', false);
    const shortNames = config.get<Record<string, string>>('shortNames', {});
    const showModel = config.get<boolean>('showModel', true);
    const wfBeepEnabled = config.get<boolean>('workflowCompleteBeep', true);

    // ONE resting colour for every session item.
    //
    // Removed in 1.8.3: the per-project pastel palette (`autoColor`). Colour in this status
    // bar now means exactly one thing — how close a session is to its limit (idle grey,
    // warning yellow, danger red). While each project also carried its own hue, that signal
    // was unreadable in both directions: a healthy 28% session rendered in dusty rose and
    // looked like a warning, and a genuine 78% one could be dismissed as "that project's
    // colour". Sessions are told apart by name, and providers by their icon colour.
    const baseColorHex: Record<string, string> = {
        'White': '#ffffff',
        'Blue': '#a8d8ea',
        'Purple': '#c9b1ff',
        'Cyan': '#a0e7e5',
        'Green': '#b5d8c7',
        'Yellow': '#ffeaa7',
        'Orange': '#ffd6a5',
        'Pink': '#ffc6ff',
    };
    const restingColor = baseColorHex[baseColor] || baseColorHex['White'];

    // Track which sessions we've seen
    const seenPaths = new Set<string>();

    // Pick one account-wide Codex snapshot before rendering, so every Codex item agrees.
    recomputeCodexSnapshotFallback(sessions);

    // Account usage is merged into the FIRST session of each provider, so a Claude and a
    // Codex session shown side by side each carry their own plan numbers. (Before Codex
    // existed this was simply `i === 0`; with two providers that would have pinned the
    // Claude plan onto a Codex item whenever Codex sorted to the top.)
    const providerLeadIndex = new Map<ProviderId, number>();
    for (let i = 0; i < sessions.length; i++) {
        if (sessions[i].isFallback) continue;
        if (!providerLeadIndex.has(sessions[i].provider)) providerLeadIndex.set(sessions[i].provider, i);
    }

    // The array is provider-grouped (Claude first, Codex second). For Right alignment,
    // higher priority is further left, so this makes every Claude item precede every Codex
    // item. Existing StatusBarItem.priority is readonly, so an item is recreated only when
    // its slot changes (for example, when a new Claude session shifts the Codex group right).
    const sessionPriorityBase = 30;
    for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        seenPaths.add(session.sessionFile);

        let entry = statusBarItems.get(session.sessionFile);
        const priority = sessionPriorityBase - (i * 2);

        if (!entry || entry.priority !== priority) {
            entry?.item.dispose();
            entry?.iconItem.dispose();
            // Keep the whole session group ahead of the lower-priority plan/stage items.
            const item = vscode.window.createStatusBarItem(
                sessionStatusBarItemId(session.sessionFile, 'text'),
                vscode.StatusBarAlignment.Right,
                priority
            );
            const iconItem = vscode.window.createStatusBarItem(
                sessionStatusBarItemId(session.sessionFile, 'icon'),
                vscode.StatusBarAlignment.Right,
                priority + 1
            );
            compactIconBesideText(iconItem, item, priority);
            entry = {
                item,
                iconItem,
                sessionFile: session.sessionFile,
                priority,
                provider: session.provider
            };
            statusBarItems.set(session.sessionFile, entry);
        }
        entry.provider = session.provider;

        // Build status bar text in the form:  "{name}: {Model} - {Effort} ({pct}%) · idle Xm"
        // Emoji prefix dropped per user feedback. Effort/model are full names (no abbreviation).
        const isCodex = session.provider === 'codex';
        const displayName = compactMode ? getShortName(session.projectName, shortNames) : session.projectName;
        // Each provider names its models differently, so the label helpers are per-provider.
        const modelLabel = showModel
            ? (isCodex
                ? getCodexModelName(session.model)
                : getShortModelName(session.model, compactMode))
            : '';
        const effortLabel = isCodex
            ? getCodexEffortLabel(session.effortLevel)
            : getEffortLabel(session.effortLevel);

        let infoPart = '';
        if (modelLabel && effortLabel) {
            infoPart = `: ${modelLabel} - ${effortLabel}`;
        } else if (modelLabel) {
            infoPart = `: ${modelLabel}`;
        } else if (effortLabel) {
            infoPart = `: ${effortLabel}`;
        }

        const idleSuffix = session.isIdle ? ` · ${formatIdleDuration(session.lastUpdated)}` : '';
        // Merge account usage into the first item of THIS provider so it isn't duplicated
        // across that provider's sessions. Fallback sessions are dim (no active session) —
        // their usage is shown separately via the standalone plan/usage items.
        const isProviderLead = providerLeadIndex.get(session.provider) === i;
        const planAdd = isProviderLead
            ? (isCodex ? codexUsageTextSuffix(compactMode) : planTextSuffix(compactMode))
            : '';
        // Codex lists conversations per device, not per project, so this window can legitimately
        // be showing a chat created in another repository. That is worth flagging: without it
        // the abbreviated project name ("Cxi" for calltaxi) is the only clue, and the numbers
        // read as if they belonged to the folder currently open.
        const foreignProject = isCodex && !!session.codexForeignProject;
        const foreignMark = foreignProject ? '↗' : '';
        entry.iconItem.text = providerIcon(session.provider);
        // The provider glyph carries its own identity colour, independent of the usage text's
        // warning/danger/idle colour — which is exactly why the foreign-project warning is
        // placed here rather than on the text.
        entry.iconItem.color = foreignProject
            ? new vscode.ThemeColor('editorWarning.foreground')
            : (session.provider === 'codex' ? '#8ecae6' : '#f4a261');
        entry.iconItem.backgroundColor = undefined;
        entry.item.text = `${displayName}${foreignMark}${infoPart} (${session.percentage}%)${planAdd}${idleSuffix}`;

        // We never use backgroundColor — too visually loud. Threshold warnings are shown via foreground color instead.
        entry.item.backgroundColor = undefined;

        if (session.isIdle) {
            // Idle: muted gray foreground regardless of threshold (the session isn't actively burning context)
            entry.item.color = new vscode.ThemeColor('disabledForeground');
        } else if (session.percentage >= dangerThreshold) {
            entry.item.color = new vscode.ThemeColor('errorForeground');
        } else if (session.percentage >= warningThreshold) {
            entry.item.color = new vscode.ThemeColor('editorWarning.foreground');
        } else {
            entry.item.color = restingColor;
        }

        // Threshold crossing beep alerts (suppressed on first scan and for idle sessions)
        if (!suppressBeep && !session.isIdle) {
            const prev = alertedSessions.get(session.sessionFile) ?? { warned: false, dangered: false };
            if (session.percentage >= dangerThreshold && !prev.dangered) {
                playBeep(2);
                alertedSessions.set(session.sessionFile, { warned: true, dangered: true });
            } else if (session.percentage >= warningThreshold && !prev.warned) {
                playBeep(1);
                alertedSessions.set(session.sessionFile, { warned: true, dangered: false });
            } else if (session.percentage < warningThreshold && (prev.warned || prev.dangered)) {
                // Context was cleared / reset — allow alerting again next time
                alertedSessions.set(session.sessionFile, { warned: false, dangered: false });
            }
        }

        // --- Task completion detection (debounced) ---
        // The legacy logic fired the beep the instant a new end_turn timestamp appeared.
        // That produced false positives when a hook or skill auto-injected a follow-up
        // user message right after end_turn (Claude effectively kept working but we'd
        // already beeped). The new logic waits `completionBeepSettleMs`; any new activity
        // for the session inside that window cancels the pending beep.
        const completionSettleMs = config.get<number>('completionBeepSettleMs', 3000);
        // Safety net: never fire the completion beep while the session is waiting on the user
        // (an unanswered tool_use or a deliberate question). In those states only the question
        // beep should sound — the work isn't actually "done".
        const awaitingUser = !!(session.pendingToolUseAt || session.pendingQuestionAt);
        const codexWorkflow = session.provider === 'codex'
            ? session.codexSubagentWorkflow
            : null;
        const codexWorkflowKey = codexWorkflow
            ? `${session.sessionFile}|codex-agent-turn:${codexWorkflow.startedAt.getTime()}`
            : null;
        if (codexWorkflowKey
            && (codexWorkflow?.status === 'running' || codexWorkflow?.status === 'settling')) {
            seenRunningWorkflowKeys.add(codexWorkflowKey);
        }

        if (!awaitingUser && session.lastAssistantEndTurnAt) {
            const curr = session.lastAssistantEndTurnAt.getTime();
            // Use the beep-gate activity clock (assistant|user only), NOT lastUpdated.
            // lastUpdated includes the stop_hook system entry written ~0.6s after the
            // turn, which would falsely count as "newer activity" and suppress the beep.
            const lastActivity = (session.lastActivityAt ?? session.lastUpdated).getTime();
            const prev = lastKnownEndTurnAt.get(session.sessionFile);
            const existing = pendingCompletion.get(session.sessionFile);

            const isCodexWorkflowCompletion = !!(
                wfBeepEnabled
                && codexWorkflowKey
                && codexWorkflow?.status === 'completed'
                && codexWorkflow.completionAt?.getTime() === curr
            );
            // The parent task_complete can be visible one filesystem event before the
            // child's final append. Wait briefly for that append instead of scheduling the
            // ordinary sound and then a second workflow sound. If it never settles, the
            // next regular poll falls back to the ordinary completion path.
            const isFreshCodexWorkflowSettle = !!(
                wfBeepEnabled
                && codexWorkflow?.status === 'settling'
                && Date.now() - curr < Math.max(15_000, completionSettleMs * 3)
            );

            if (suppressBeep && isCodexWorkflowCompletion && codexWorkflowKey) {
                // Extension loaded after the whole turn had already finished.
                alertedWorkflowDone.set(codexWorkflowKey, codexWorkflow!.childCount);
                seenRunningWorkflowKeys.delete(codexWorkflowKey);
                lastKnownEndTurnAt.set(session.sessionFile, curr);
                log(`[codex-wf] baseline (silent, first-scan) ${codexWorkflow!.childCount} subagents`);
            } else if (!suppressBeep && isFreshCodexWorkflowSettle) {
                if (existing) clearTimeout(existing.timer);
                pendingCompletion.delete(session.sessionFile);
                log(`[codex-wf] parent complete but child rollout still settling — defer ordinary beep`);
            } else if (!suppressBeep && isCodexWorkflowCompletion && codexWorkflowKey) {
                const observedRunning = seenRunningWorkflowKeys.has(codexWorkflowKey);
                const alreadyClaimed = alertedWorkflowDone.has(codexWorkflowKey);

                if (alreadyClaimed) {
                    if (existing && lastActivity > existing.markerAt + 500) {
                        log(`[codex-wf] cancelled pending for ${session.projectName} — newer parent activity`);
                        clearTimeout(existing.timer);
                        pendingCompletion.delete(session.sessionFile);
                    }
                } else if (prev === undefined && !observedRunning) {
                    // First observed already complete: stale/before-activation work.
                    alertedWorkflowDone.set(codexWorkflowKey, codexWorkflow.childCount);
                    lastKnownEndTurnAt.set(session.sessionFile, curr);
                    log(`[codex-wf] baseline (silent, never-saw-running) ${codexWorkflow.childCount} subagents`);
                } else if (prev === undefined || curr > prev) {
                    if (existing) clearTimeout(existing.timer);
                    pendingCompletion.delete(session.sessionFile);

                    // Claim synchronously before scheduling so overlapping refreshes cannot
                    // schedule both the ordinary and workflow sounds for the same parent turn.
                    alertedWorkflowDone.set(codexWorkflowKey, codexWorkflow.childCount);
                    seenRunningWorkflowKeys.delete(codexWorkflowKey);
                    lastKnownEndTurnAt.set(session.sessionFile, curr);

                    const newerActivityExists = lastActivity > curr + 500;
                    if (newerActivityExists) {
                        log(`[codex-wf] suppressed for ${session.projectName} — newer activity at ${new Date(lastActivity).toISOString()}`);
                    } else if (completionSettleMs <= 0) {
                        log(`[codex-wf] agent-turn-complete for all ${codexWorkflow.childCount} subagents (settle=0) → beep`);
                        playWorkflowCompleteSound();
                    } else {
                        log(`[codex-wf] scheduled all-${codexWorkflow.childCount}-subagents beep in ${completionSettleMs}ms`);
                        const timer = setTimeout(() => {
                            log(`[codex-wf] agent-turn-complete settled → workflow beep`);
                            playWorkflowCompleteSound();
                            pendingCompletion.delete(session.sessionFile);
                        }, completionSettleMs);
                        pendingCompletion.set(session.sessionFile, { timer, markerAt: curr });
                    }
                }
            } else if (!suppressBeep) {
                // Ordinary Claude/Codex turn completion path.
                if (prev === undefined) {
                    // First time seeing this session — baseline silently
                    lastKnownEndTurnAt.set(session.sessionFile, curr);
                    log(`[done] first seen ${session.projectName} endTurn=${new Date(curr).toISOString()}`);
                } else if (curr > prev) {
                    if (existing) clearTimeout(existing.timer);
                    pendingCompletion.delete(session.sessionFile);
                    // If activity already exists after this end_turn, suppress immediately
                    // (a follow-up landed before we even got here)
                    const newerActivityExists = lastActivity > curr + 500;
                    if (newerActivityExists) {
                        log(`[done] suppressed for ${session.projectName} — newer activity at ${new Date(lastActivity).toISOString()}`);
                        lastKnownEndTurnAt.set(session.sessionFile, curr);
                    } else if (completionSettleMs <= 0) {
                        log(`[done] new end_turn for ${session.projectName} (settle=0): firing immediately`);
                        playCompletionSound();
                        lastKnownEndTurnAt.set(session.sessionFile, curr);
                    } else {
                        log(`[done] scheduled beep for ${session.projectName} in ${completionSettleMs}ms`);
                        const timer = setTimeout(() => {
                            log(`[done] settled → beep for ${session.projectName}`);
                            playCompletionSound();
                            lastKnownEndTurnAt.set(session.sessionFile, curr);
                            pendingCompletion.delete(session.sessionFile);
                        }, completionSettleMs);
                        pendingCompletion.set(session.sessionFile, { timer, markerAt: curr });
                    }
                } else if (existing && lastActivity > existing.markerAt + 500) {
                    // Pending beep but new activity arrived → cancel
                    log(`[done] cancelled pending for ${session.projectName} — new activity at ${new Date(lastActivity).toISOString()}`);
                    clearTimeout(existing.timer);
                    pendingCompletion.delete(session.sessionFile);
                    lastKnownEndTurnAt.set(session.sessionFile, existing.markerAt);
                }
            }
        }

        // --- Question detection (AskUserQuestion / ExitPlanMode) ---
        // Same debounce shape as completion: if the user types a reply within the settle
        // window, no beep. Uses the same completionBeepSettleMs setting.
        if (session.pendingQuestionAt) {
            const curr = session.pendingQuestionAt.getTime();
            // Same beep-gate clock as completion (excludes stop_hook noise).
            const lastActivity = (session.lastActivityAt ?? session.lastUpdated).getTime();
            const prev = lastKnownQuestionAt.get(session.sessionFile);
            const existing = pendingQuestion.get(session.sessionFile);

            if (suppressBeep) {
                // First scan after activate/reload: a question already on screen is treated
                // as stale — baseline it silently so we don't beep for a question the user
                // is already looking at.
                lastKnownQuestionAt.set(session.sessionFile, curr);
            } else if (prev === undefined || curr > prev) {
                // prev===undefined while the extension is already running means we are seeing
                // THIS session's question for the first time at runtime = a brand-new question
                // → it must beep. (Without this, the first question of a session after a reload
                // was silently baselined and never sounded.) curr>prev is a subsequent new question.
                if (existing) clearTimeout(existing.timer);
                pendingQuestion.delete(session.sessionFile);
                const newerActivityExists = lastActivity > curr + 500;
                if (newerActivityExists) {
                    log(`[q] suppressed for ${session.projectName} — newer activity at ${new Date(lastActivity).toISOString()}`);
                    lastKnownQuestionAt.set(session.sessionFile, curr);
                } else if (completionSettleMs <= 0) {
                    log(`[q] new question for ${session.projectName} (${session.pendingToolUseName}): firing immediately`);
                    playQuestionSound();
                    lastKnownQuestionAt.set(session.sessionFile, curr);
                } else {
                    log(`[q] scheduled question beep for ${session.projectName} (${session.pendingToolUseName}) in ${completionSettleMs}ms`);
                    const timer = setTimeout(() => {
                        log(`[q] settled → question beep for ${session.projectName}`);
                        playQuestionSound();
                        lastKnownQuestionAt.set(session.sessionFile, curr);
                        pendingQuestion.delete(session.sessionFile);
                    }, completionSettleMs);
                    pendingQuestion.set(session.sessionFile, { timer, markerAt: curr });
                }
            } else if (existing && lastActivity > existing.markerAt + 500) {
                log(`[q] cancelled pending for ${session.projectName} — new activity at ${new Date(lastActivity).toISOString()}`);
                clearTimeout(existing.timer);
                pendingQuestion.delete(session.sessionFile);
                lastKnownQuestionAt.set(session.sessionFile, existing.markerAt);
            }
        }

        // --- Optional: stuck-tool-use heuristic ---
        // The latest assistant entry is an unanswered tool_use (NOT AskUserQuestion/
        // ExitPlanMode, which the block above handles) AND no new activity has happened
        // for stuckToolUseThresholdSec. The likely cause is a VS Code permission prompt
        // (Bash, Edit, etc.) blocking Claude. This is a heuristic and WILL fire on long-
        // running legitimate tools (npm build, etc.). Off by default.
        const detectStuck = config.get<boolean>('detectStuckToolUse', false);
        if (!suppressBeep && detectStuck && session.pendingToolUseAt && !session.pendingQuestionAt) {
            const stuckThresholdSec = config.get<number>('stuckToolUseThresholdSec', 90);
            const stuckThresholdMs = stuckThresholdSec * 1000;
            const toolUseAt = session.pendingToolUseAt.getTime();
            const ageMs = Date.now() - toolUseAt;
            const alreadyAlerted = alertedStuckToolUseAt.get(session.sessionFile) === toolUseAt;
            if (!alreadyAlerted && ageMs >= stuckThresholdMs) {
                log(`[q-stuck] tool_use stuck for ${Math.round(ageMs / 1000)}s (${session.pendingToolUseName}) — firing heuristic question beep`);
                playQuestionSound();
                alertedStuckToolUseAt.set(session.sessionFile, toolUseAt);
            }
        }
        // Clear stuck marker when the pending tool_use changes (got answered or moved on)
        if (!session.pendingToolUseAt) {
            alertedStuckToolUseAt.delete(session.sessionFile);
        } else if (alertedStuckToolUseAt.has(session.sessionFile)
                   && alertedStuckToolUseAt.get(session.sessionFile) !== session.pendingToolUseAt.getTime()) {
            alertedStuckToolUseAt.delete(session.sessionFile);
        }

        // Detailed tooltip. The first-message line and project path were removed per
        // user request; the claudeState plan-usage block takes their place.
        const effortLineText = effortLabel;
        // xHigh⁺ = persisted "xhigh", which is also what ultracode stores. The "+workflows"
        // half of ultracode is runtime-only and never written to disk, so we can't tell plain
        // xhigh and ultracode apart — the note spells that out. Codex has no such ambiguity.
        const effortNote = (!isCodex && (session.effortLevel || '').toLowerCase() === 'xhigh')
            ? planT('tt.effortXhighNote')
            : '';
        const effortLine = effortLineText ? `🎚️ Effort: \`${effortLineText}\`${effortNote}\n\n` : '';
        // Keep speed only when it's non-standard (i.e., /fast mode active) — otherwise hide noise
        const speedLine = (session.speed && session.speed !== 'standard') ? `⚡ Speed: \`${session.speed}\`\n\n` : '';
        const idleLine = session.isIdle ? `😴 **Idle** — ${formatIdleDuration(session.lastUpdated)}\n\n` : '';

        let md: vscode.MarkdownString;
        if (isCodex) {
            // Codex mirrors the Claude tooltip layout (account usage on top, context below)
            // but with Codex's own token semantics: cached input is a SUBSET of input, and
            // the session-processed total is labelled separately so it is never read as
            // either context occupancy or account-limit usage.
            const cumulative = session.codexCumulativeTokens
                ? `♾️ ${planT('tt.lifetime')}: ${formatTokens(session.codexCumulativeTokens)}\n\n`
                : '';
            // Spelling out the full cwd is the point: the status bar only has room for an
            // abbreviated name, and that abbreviation is what made the mismatch invisible.
            const foreignLine = foreignProject
                ? `⚠️ **${planT('tt.codexForeignProject')}**\n\n\`${session.projectPath}\`\n\n`
                : '';
            md = new vscode.MarkdownString(
                `**${session.projectName}** (${session.sessionId})\n\n` +
                foreignLine +
                idleLine +
                sectionHeader('Codex Usage', '#FF9F6E') +
                (codexUsageTooltipBlock() || (planT('tt.codexUsageUnavailable') + '\n\n')) +
                sectionHeader('Codex Context', '#AED581') +
                `🤖 Model: \`${session.model || 'Unknown'}\`\n\n` +
                effortLine +
                `📊 **Context Usage: ${session.percentage}%**\n\n` +
                `| Type | Tokens |\n|------|--------|\n` +
                `| Input | ${formatTokens(session.inputTokens)} |\n` +
                `| ↳ ${planT('tt.cachedPortion')} | ${formatTokens(session.cacheReadTokens)} |\n` +
                `| **${planT('tt.contextTotal')}** | **${formatTokens(session.totalTokens)}** / ${formatTokens(session.contextLimit)} |\n\n` +
                cumulative +
                `🕐 Last updated: ${session.lastUpdated.toLocaleTimeString()}\n\n` +
                `*Click for menu (hide / restore / settings)*`
            );
        } else {
            const planBlock = planTooltipBlock();
            const stateBody = planBlock || (planT('tt.planUnavailable') + '\n\n');
            md = new vscode.MarkdownString(
                `**${session.projectName}** (${session.sessionId})\n\n` +
                idleLine +
                sectionHeader('claudeState', '#4FC3F7') +
                stateBody +
                sectionHeader('claudeContext', '#AED581') +
                `🤖 Model: \`${session.model || 'Unknown'}\`\n\n` +
                effortLine +
                speedLine +
                `📊 **Context Usage: ${session.percentage}%**\n\n` +
                `| Type | Tokens |\n|------|--------|\n` +
                `| Cache Read | ${formatTokens(session.cacheReadTokens)} |\n` +
                `| Cache Creation | ${formatTokens(session.cacheCreationTokens)} |\n` +
                `| **Total** | **${formatTokens(session.totalTokens)}** / ${formatTokens(session.contextLimit)} |\n\n` +
                `🕐 Last updated: ${session.lastUpdated.toLocaleTimeString()}\n\n` +
                `*Click for menu (hide / restore / settings)*`
            );
        }
        md.supportHtml = true;
        entry.item.tooltip = md;

        // Click opens session menu (hide this / restore hidden / settings)
        entry.item.command = {
            command: 'claudeContextBar.showSessionMenu',
            title: 'Session Menu',
            arguments: [session.sessionFile]
        };

        entry.iconItem.tooltip = md;
        entry.iconItem.command = {
            command: 'claudeContextBar.showSessionMenu',
            title: 'Session Menu',
            arguments: [session.sessionFile]
        };
        entry.item.show();
        entry.iconItem.show();
    }

    // --- Workflow-complete beep (incl. Task pseudo-workflow wfId 'tasks') ---
    // For every tracked session, scan its workflows; when a workflow flips to
    // "all agents done" we fire playWorkflowCompleteSound() exactly once. The
    // user's core ask: "beep me when all the subagents I spun up have finished."
    // First scan / suppressBeep only baselines (silent) so an already-finished
    // workflow that was done before the extension loaded doesn't beep on startup.
    // Cache the tracked session's workflow scan so the panel-sync push below can
    // reuse it instead of hitting disk a second time.
    const trackedSessionFile = getTrackedSessionFile();
    let trackedWorkflowsCache: WorkflowInfo[] | undefined;
    // Only providers that actually have workflow journals on disk are scanned. Codex has
    // no equivalent structure yet (Phase 4), so walking its files here would be pure waste.
    const workflowCapableFiles = new Set(
        sessions.filter(s => capabilitiesFor(s.provider).workflows).map(s => s.sessionFile)
    );
    for (const sessionFile of seenPaths) {
        if (!workflowCapableFiles.has(sessionFile)) continue;
        let workflows: WorkflowInfo[];
        try {
            workflows = await findWorkflowsForSession(sessionFile);
        } catch (e) {
            log(`[wf-done] scan error for session: ${e}`);
            continue;
        }
        if (sessionFile === trackedSessionFile) trackedWorkflowsCache = workflows;
        // Lazily fetched once per session (only when a wf_* workflow reaches journal
        // all-done) — the set of workflows the parent session confirms have truly finished.
        let completedWfIds: Set<string> | null = null;
        for (const wf of workflows) {
            const key = `${sessionFile}|${wf.wfId}`;
            const allDone = wf.agents.length > 0 && wf.agents.every(a => a.status === 'done');
            if (!allDone) {
                // Still running (or no agents yet). Remember we've seen this key running
                // so a later flip to done counts as a real completion. If it had been
                // gated as done but is active again (new agents started), drop the gate
                // so the next completion can beep again.
                seenRunningWorkflowKeys.add(key);
                if (alertedWorkflowDone.has(key)) {
                    alertedWorkflowDone.delete(key);
                    log(`[wf-done] reset gate for ${wf.wfId} — workflow active again`);
                }
                continue;
            }
            const doneCount = wf.agents.length;
            if (alertedWorkflowDone.has(key)) continue; // already handled this completion
            // ★ Batch-gap guard: a real workflow (wf_*) can read as journal-all-done in the
            // lull between sequential batches (batch 1 finished, batch 2 not spawned yet). The
            // journal has no whole-script end marker, so we confirm real termination two ways:
            //   1. PRIMARY — the run's result file workflows/<wfId>.json. status "completed"
            //      means the whole script ended successfully → beep. "failed"/"killed" are
            //      terminal too, but close the gate WITHOUT a success beep.
            //   2. FALLBACK — if that marker isn't there yet (missing/mid-write), fall back to
            //      the session-log task-notification parser.
            // If neither confirms completion, it's a mid-run batch gap: suppress WITHOUT setting
            // the gate so the next batch (or the real completion) can still beep later. Task
            // pseudo-workflows (wfId not "wf_") are exempt and keep the original all-done behavior.
            if (wf.wfId.startsWith('wf_')) {
                const termStatus = await readWorkflowTerminalStatus(sessionFile, wf.wfId);
                if (termStatus === 'failed' || termStatus === 'killed') {
                    alertedWorkflowDone.set(key, doneCount);  // terminal but not a success → no beep
                    log(`[wf-done] ${wf.wfId} ended '${termStatus}' — gate closed, no success beep`);
                    continue;
                }
                if (termStatus !== 'completed') {
                    // No terminal marker yet → fall back to the session-log completion notice.
                    if (completedWfIds === null) completedWfIds = await getCompletedWorkflowIds(sessionFile);
                    if (!completedWfIds.has(wf.wfId)) {
                        log(`[wf-done] ${wf.wfId} journal all-done but no terminal marker/notice yet — batch gap, suppress`);
                        continue;
                    }
                }
            }
            // Race guard: the awaits above can let a second, overlapping refresh reach here for
            // the same key before the first set the gate. Re-check right before we claim it — the
            // has()→set() pair has no await between them, so it's atomic on JS's single thread and
            // exactly one refresh beeps.
            if (alertedWorkflowDone.has(key)) continue;
            // Beep ONLY for a running→done transition we actually observed this runtime.
            // A workflow first seen already-done (first scan, or stale work from another
            // project surfacing later) is baselined silently — it never beeps as if it
            // just finished. Same "don't beep pre-existing completions" guard the
            // task-completion beep uses.
            const observedRunning = seenRunningWorkflowKeys.has(key);
            alertedWorkflowDone.set(key, doneCount);
            if (!suppressBeep && observedRunning && wfBeepEnabled) {
                log(`[wf-done] all ${doneCount} agents done for ${wf.wfId} → beep`);
                playWorkflowCompleteSound();
            } else {
                const why = suppressBeep ? 'first-scan' : !observedRunning ? 'never-saw-running' : 'beep-disabled';
                log(`[wf-done] baseline (silent, ${why}) ${wf.wfId} — ${doneCount} agents done`);
            }
        }
    }

    // Remove status bar items for sessions that are no longer active
    for (const [sessionFile, entry] of statusBarItems) {
        if (!seenPaths.has(sessionFile)) {
            entry.item.dispose();
            entry.iconItem.dispose();
            statusBarItems.delete(sessionFile);
            alertedSessions.delete(sessionFile);
            lastKnownEndTurnAt.delete(sessionFile);
            lastKnownQuestionAt.delete(sessionFile);
            alertedStuckToolUseAt.delete(sessionFile);
            // Drop every workflow-done gate belonging to this vanished session.
            for (const k of [...alertedWorkflowDone.keys()]) {
                if (k.startsWith(`${sessionFile}|`)) alertedWorkflowDone.delete(k);
            }
            for (const k of [...seenRunningWorkflowKeys]) {
                if (k.startsWith(`${sessionFile}|`)) seenRunningWorkflowKeys.delete(k);
            }
            const pc = pendingCompletion.get(sessionFile);
            if (pc) { clearTimeout(pc.timer); pendingCompletion.delete(sessionFile); }
            const pq = pendingQuestion.get(sessionFile);
            if (pq) { clearTimeout(pq.timer); pendingQuestion.delete(sessionFile); }
        }
    }

    // Account-usage fallbacks are provider-scoped. A Codex session must not suppress the
    // standalone Claude plan item (or vice versa), and dim fallback sessions do not count.
    const hasRealClaudeSession = sessions.some(s => s.provider === 'claude' && !s.isFallback);
    const hasRealCodexSession = sessions.some(s => s.provider === 'codex' && !s.isFallback);
    updatePlanFallback(!hasRealClaudeSession);
    updateCodexUsageFallback(!hasRealCodexSession);

    // "Is it alive?" — drive the live elapsed counter from the most recent active session.
    // Codex only qualifies while a turn is genuinely in flight: its stage is decided by the
    // task_started/task_complete ordering, not by "activity newer than the last turn end".
    // Codex writes a trailing thread_settings_applied AFTER task_complete (observed in real
    // sessions), which the shared heuristic would otherwise read as "still thinking".
    updateStageItem(sessions.find(s =>
        !s.isFallback && (s.provider !== 'codex' || s.codexActive === true)
    ) ?? null);

    // Keep the workflow panel (if open) in sync. The workflow-done loop above
    // already scanned the tracked session, so reuse that result instead of hitting
    // disk again. (Fall back to a fresh scan only if the cache somehow missed.)
    if (trackedSessionFile) {
        if (trackedWorkflowsCache !== undefined) {
            try { pushWorkflows(trackedWorkflowsCache); }
            catch (e) { log(`[workflows] push error: ${e}`); }
        } else {
            findWorkflowsForSession(trackedSessionFile).then(pushWorkflows).catch(e => log(`[workflows] push error: ${e}`));
        }
    }

    // codex_rescue runs ride the same refresh tick. No-ops instantly unless this workspace
    // actually uses the skill, so ordinary users pay nothing for it. Deliberately not
    // awaited — the status bar must not wait on a remote filesystem round trip.
    void syncCodexRuns().catch(e => log(`[codex-rescue] sync error: ${e}`));
}

// ============================================================================
// codex_rescue — live run progress
//
// Reads the live event mirror that send.sh writes to <workspace>/docs/codex_rescue/.log/.
// The whole feature is inert unless that directory exists, which is how it stays invisible
// to ordinary users of this extension: no setting to discover, no command in the palette.
// ============================================================================

/** Phase observed on the previous poll, per stamp — the edge the chime fires on. */
const codexRunPhases = new Map<string, RunPhase>();
/**
 * Stamps we actually saw in a live phase during this runtime. Mirrors the workflow-done
 * gate: a run first seen already-finished (extension restart, or an old log directory
 * surfacing) is baselined silently rather than chiming as if it had just completed.
 */
const codexSeenLive = new Set<string>();

/**
 * True when the codex_rescue skill is installed for Claude Code on this machine.
 *
 * This — not "has this project run it before" — is what gates the panel. Keying off the
 * workspace meant the feature stayed invisible until the very first run, so someone who had
 * just installed the skill had no way to discover that a viewer existed at all.
 *
 * The skill itself is NOT shipped with this extension (see docs/codex-rescue-guide.md);
 * it spawns `codex exec` with workspace write access, which users must opt into knowingly.
 */
function codexRescueSkillInstalled(): boolean {
    try {
        return fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'codex_rescue', 'SKILL.md'));
    } catch {
        return false;
    }
}

/** True when any workspace folder has codex_rescue run records to display. */
async function workspaceUsesCodexRescue(): Promise<boolean> {
    for (const f of vscode.workspace.workspaceFolders || []) {
        // Remote folders included: reads go through vscode.workspace.fs, which VS Code
        // routes to the remote host even though this extension itself runs locally
        // (extensionKind "ui"). Restricting this to scheme 'file' is what made the panel
        // report "no runs" in every Remote-SSH window until 2026-08-19.
        if (await codexRescueDocsDir(f.uri)) return true;
    }
    return false;
}

/** Scan every workspace folder — local or remote — and shape the runs for the panel. */
/** Everything in the trash across all open folders, newest deletion first. */
async function collectCodexTrash(): Promise<CodexTrashView[]> {
    const out: CodexTrashView[] = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
        out.push(...await listTrash(f.uri));
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

async function pushCodexTrash(): Promise<void> {
    if (!isCodexPanelOpen()) return;
    pushTrash(await collectCodexTrash());
}

async function collectCodexRuns(): Promise<CodexRunView[]> {
    const now = Date.now();
    const out: CodexRunView[] = [];
    const keepKeys = new Set<string>();

    for (const f of vscode.workspace.workspaceFolders || []) {
        const docsDir = await codexRescueDocsDir(f.uri);
        if (!docsDir) continue;
        const logDir = vscode.Uri.joinPath(docsDir, '.log');
        for (const run of await discoverRuns(f.uri, now)) {
            keepKeys.add(runCacheKey(logDir, run.stamp));
            const usage = run.events.usage;
            out.push({
                stamp: run.stamp,
                slug: run.slug,
                subject: run.subject,
                mode: run.mode,
                phase: run.phase,
                startedAt: run.startedAtMs,
                endedAt: run.endedAtMs,
                threadId: run.events.threadId,
                todo: run.events.todo,
                staleForMs: run.staleForMs,
                requestUri: run.requestUri,
                resultUri: run.resultUri,
                totalTokens: usage ? usage.inputTokens + usage.outputTokens : undefined,
                items: run.events.items.map(i => ({
                    id: i.id,
                    kind: i.kind,
                    status: i.status,
                    label: i.label,
                    body: i.body,
                    raw: i.raw,
                    // Observation-based: exec JSONL carries no timestamps. A run scanned only
                    // after it finished yields 0 here, which the webview renders as blank
                    // rather than a fake "0.0s".
                    durationMs: i.lastSeenMs && i.lastSeenMs > i.firstSeenMs
                        ? i.lastSeenMs - i.firstSeenMs : undefined,
                })),
            });
        }
    }
    out.sort((a, b) => b.stamp.localeCompare(a.stamp));
    pruneTailCache(keepKeys);
    return out;
}

/**
 * Refresh Codex run state: fire the completion chime on a live→terminal edge, then push
 * to the panel if it's open. Called from refreshAllSessions.
 */
let lastCodexContext: boolean | null = null;

/**
 * Publish `claudeStateBar.hasCodexRescue` so package.json can hide the command from the
 * palette everywhere else. Re-checked each tick because the directory appears the first
 * time the user runs the skill — no reload should be needed. Only calls setContext when
 * the value actually flips.
 */
function updateCodexContext(has: boolean): void {
    if (has === lastCodexContext) return;
    lastCodexContext = has;
    vscode.commands.executeCommand('setContext', 'claudeStateBar.hasCodexRescue', has);
    log(`[codex-rescue] context hasCodexRescue=${has}`);
}

/**
 * Guards against overlapping scans. On a remote workspace every read is an RPC round trip
 * and one pass can easily outlast the 2s poll; two passes in flight would double-fire the
 * completion chime and interleave writes to `codexRunPhases`.
 */
let codexSyncInFlight = false;

async function syncCodexRuns(): Promise<void> {
    // Command/menu visibility follows the SKILL install, not this workspace's history.
    updateCodexContext(codexRescueSkillInstalled());
    if (codexSyncInFlight) return;
    codexSyncInFlight = true;
    try {
        await syncCodexRunsInner();
    } finally {
        codexSyncInFlight = false;
    }
}

async function syncCodexRunsInner(): Promise<void> {
    // Scanning only makes sense where run records actually exist.
    if (!await workspaceUsesCodexRescue()) return;

    let runs: CodexRunView[];
    try {
        runs = await collectCodexRuns();
    } catch (e) {
        log(`[codex-rescue] scan error: ${e}`);
        return;
    }

    const beepEnabled = vscode.workspace.getConfiguration('claudeContextBar')
        .get<boolean>('workflowCompleteBeep', true);

    for (const r of runs) {
        const prev = codexRunPhases.get(r.stamp);
        const live = !isTerminalPhase(r.phase);
        if (live) codexSeenLive.add(r.stamp);

        // Chime only on a transition we actually witnessed: the run must have been seen
        // live at some point AND have just crossed into a terminal phase. `stale` is
        // deliberately NOT terminal — a run whose heartbeat died may still be alive.
        if (prev !== undefined && !isTerminalPhase(prev) && isTerminalPhase(r.phase)) {
            if (beepEnabled && codexSeenLive.has(r.stamp)) {
                log(`[codex-rescue] ${r.stamp} ${prev} → ${r.phase} → beep`);
                playWorkflowCompleteSound();
            } else {
                log(`[codex-rescue] ${r.stamp} → ${r.phase} (silent: ${beepEnabled ? 'never-saw-live' : 'beep-disabled'})`);
            }
        }
        codexRunPhases.set(r.stamp, r.phase);
    }

    if (isCodexPanelOpen()) {
        try { pushRuns(runs); }
        catch (e) { log(`[codex-rescue] push error: ${e}`); }
    }

    // A live run needs a much tighter loop than the 30s status-bar tick: at that rate the
    // panel lags visibly and the completion chime could land half a minute late. Note this
    // is NOT gated on the panel being open — the chime has to fire either way.
    ensureCodexFastPolling(runs.some(r => !isTerminalPhase(r.phase)));
}

let codexFastTimer: NodeJS.Timeout | null = null;

/** Run the Codex scan every 2s while anything is live; stop entirely once nothing is. */
function ensureCodexFastPolling(hasLive: boolean): void {
    if (hasLive && !codexFastTimer) {
        log('[codex-rescue] live run detected → 2s polling');
        codexFastTimer = setInterval(() => {
            void syncCodexRuns().catch(e => log(`[codex-rescue] fast poll error: ${e}`));
        }, 2000);
    } else if (!hasLive && codexFastTimer) {
        log('[codex-rescue] no live runs → back to the shared tick');
        clearInterval(codexFastTimer);
        codexFastTimer = null;
    }
}

// ============================================================================
// claudeStateBar — plan usage (5-hour session & 7-day weekly) from claude.ai API
// ============================================================================

function planLang(): Lang {
    return creds.getLanguage();
}

// Lang-aware string lookup with {0} substitution (strings only; arrays use weekdayNames()).
function planT(key: string, ...args: (string | number)[]): string {
    const dict = getDict(planLang());
    let v = dict[key];
    if (typeof v !== 'string') return key;
    if (args.length) {
        v = v.replace(/\{(\d+)\}/g, (_, i) => {
            const val = args[Number(i)];
            return val == null ? '' : String(val);
        });
    }
    return v;
}

function weekdayNames(): string[] {
    const w = getDict(planLang())['sb.weekdays'];
    return Array.isArray(w) ? w : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
}

// Format an ISO reset timestamp like "PM 4:00" (today) or "PM 8:00 (Sat)" (other day).
function resetAtLabel(iso: string | null): string {
    if (!iso) return '--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    const now = new Date();
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    const h = d.getHours();
    const ap = h < 12 ? planT('sb.am') : planT('sb.pm');
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    const timePart = `${ap} ${h12}:${mm}`;
    if (sameDay) return timePart;
    // Not today → lead with the calendar date. A weekday alone ("Wed") is ambiguous on any
    // multi-day window: Codex's rate limit runs on a 7-day cycle and Claude's weekly limit
    // likewise, so "Wed" could be this week's or next week's. M/D is unambiguous in both
    // en (Aug 5) and ko (8월 5일) reading order, and the weekday is kept for at-a-glance use.
    const days = weekdayNames();
    return `${d.getMonth() + 1}/${d.getDate()} (${days[d.getDay()]}) ${timePart}`;
}

// Human "in 2h 14m" style countdown to the reset time.
function untilHuman(iso: string | null): string {
    if (!iso) return '--';
    const diff = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return planT('sb.resetsSoon');
    const mins = Math.floor(diff / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days >= 1) return planT('sb.daysLater', days, hours);
    if (hours >= 1) return planT('sb.hoursLater', hours, m);
    return planT('sb.minsLater', m);
}

function colorForPercent(percent: number | null): vscode.ThemeColor | undefined {
    if (percent == null) return undefined;
    const p = Math.round(percent);
    if (p >= 90) return new vscode.ThemeColor('errorForeground');
    if (p >= 70) return new vscode.ThemeColor('editorWarning.foreground');
    return undefined;
}

// Compact "4h 24m" countdown — language-neutral, no "후/later" suffix.
function untilHumanCompact(iso: string | null): string {
    if (!iso) return '--';
    const diff = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return 'soon';
    const mins = Math.floor(diff / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days >= 1) return `${days}d ${hours}h`;
    if (hours >= 1) return `${hours}h ${m}m`;
    return `${m}m`;
}

// Suffix appended to the first session item, e.g. " - 27% (in 2h 43m)".
// Compact mode drops the label and uses a short time format: " · 27% (4h 24m)".
// Only added when plan usage is OK; setup/error states are surfaced by the dedicated
// warning item (updatePlanFallback) so the user always sees a clear prompt.
function planTextSuffix(compact: boolean): string {
    if (planStatus === 'ok' && lastUsage && lastUsage.sessionPercent != null) {
        const p = Math.round(lastUsage.sessionPercent);
        if (compact) {
            return ` · ${p}% (${untilHumanCompact(lastUsage.sessionResetAt)})`;
        }
        return ` - ${planT('sb.sessionLabel')} ${p}% (${untilHuman(lastUsage.sessionResetAt)})`;
    }
    return '';
}

// ---------------------------------------------------------------------------
// Codex account usage — the Codex counterpart to the claudeState plan block.
//
// Account rate limits come from app-server and are shared across extension hosts. Rollout
// `rate_limits` remains a fallback only: it is a per-thread snapshot and can be stale even
// when its record timestamp is newer than the last account probe.
// ---------------------------------------------------------------------------

/** After this long without a fresh snapshot the numbers are labelled stale. */
const CODEX_USAGE_STALE_MS = 15 * 60 * 1000;

// Live account rate limits from the app-server. This is the PREFERRED source: unlike the
// rollout snapshot it does not freeze when Codex sits idle, which matters because the limit
// is a 7-day rolling window whose real value drifts down on its own. Refreshed on its own
// slow timer, deliberately decoupled from the 30s session poll (docs §11.3).
let codexLiveUsage: CodexUsageSnapshot | null = null;
let codexUsageInterval: NodeJS.Timeout | null = null;
let codexUsageInFlight = false;
let codexUsageCacheDir = '';
let codexUsageCacheMaxAgeMs = 5 * 60 * 1000;

/** Pull a newer value written by another VS Code window into this extension host. */
function syncCodexUsageFromSharedCache(): boolean {
    const cached = readCachedCodexRateLimits(codexUsageCacheDir, CODEX_USAGE_STALE_MS);
    if (!cached?.observedAt) return false;
    if (codexLiveUsage?.observedAt
        && codexLiveUsage.observedAt.getTime() >= cached.observedAt.getTime()) return false;
    codexLiveUsage = cached;
    return true;
}

async function refreshCodexUsage(): Promise<void> {
    if (!isCodexEnabled() || codexUsageInFlight) return;
    // No point probing when Codex isn't installed on this machine.
    if (!(await getCodexHomeUri())) return;
    codexUsageInFlight = true;
    try {
        const result = await fetchSharedCodexRateLimits(codexUsageCacheDir, codexUsageCacheMaxAgeMs);
        if (result) {
            codexLiveUsage = result.snapshot;
            log(`[codex-usage] ${result.source}: primary=${result.snapshot.primary?.usedPercent ?? '--'}% plan=${result.snapshot.planType ?? '?'}`);
            refreshAllSessions();
        }
        // On failure we keep the previous live value; the tooltip ages it into "stale"
        // on its own, and the rollout snapshot still backs it up.
    } catch (e) {
        log(`[codex-usage] refresh failed: ${e}`);
    } finally {
        codexUsageInFlight = false;
    }
}

// Newest rate-limit snapshot across ALL visible Codex sessions, recomputed each refresh.
// This is the fallback used when the live probe is unavailable.
let codexSnapshotFallback: CodexUsageSnapshot | null = null;

function recomputeCodexSnapshotFallback(sessions: SessionInfo[]): void {
    let best: CodexUsageSnapshot | null = null;
    for (const s of sessions) {
        const u = s.codexUsage;
        if (!u || !u.observedAt) continue;
        if (!best || !best.observedAt || u.observedAt.getTime() > best.observedAt.getTime()) best = u;
    }
    codexSnapshotFallback = best;
}

/**
 * Account usage for Codex, in the documented order: live app-server reading first, then the
 * newest rollout snapshot.
 *
 * ACCOUNT-scoped, not session-scoped — and that distinction is the whole point. Every
 * rollout embeds whatever the limit was when THAT session last ran, so reading each
 * session's own snapshot made five sessions report five different weekly numbers
 * (observed: 30/28/22/19/2/48%) for a single account. One account has one limit, so every
 * Codex item now shows the same figure.
 */
function accountCodexUsage(): CodexUsageSnapshot | null {
    const live = codexLiveUsage;
    const snap = codexSnapshotFallback;
    // account/rateLimits/read is the account-authoritative source. A rollout timestamp can
    // be newer while carrying an older per-thread snapshot, so comparing timestamps across
    // those two different sources reintroduced cross-window disagreement.
    return live ?? snap;
}

function isoFromEpoch(ms: number | null): string | null {
    return ms == null ? null : new Date(ms).toISOString();
}

// app-server and rollout snapshots expose consumed usage as `usedPercent`, and that is what
// we show. Both providers therefore read in the same direction — a bigger number always
// means "closer to the limit" — which is why this is no longer inverted (1.8.3): the Claude
// plan block next to it is a consumed figure too, and the two disagreeing was the confusion.
// The ChatGPT usage screen states the complementary "remaining" amount; that difference is
// deliberate, so `47% remaining` there is `53%` here.
function codexUsedPercent(usedPercent: number): number {
    return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

// Suffix appended to the leading Codex session item — mirrors planTextSuffix().
function codexUsageTextSuffix(compact: boolean): string {
    const u = accountCodexUsage();
    if (!u || !u.primary) return '';
    const p = codexUsedPercent(u.primary.usedPercent);
    const iso = isoFromEpoch(u.primary.resetsAt);
    if (compact) {
        return ` · ${p}% (${untilHumanCompact(iso)})`;
    }
    return ` - ${planT('sb.codexLimit')} ${p}% (${untilHuman(iso)})`;
}

// Markdown block describing Codex account usage; inserted into Codex session tooltips.
function codexUsageTooltipBlock(): string {
    const u = accountCodexUsage();
    if (!u || (!u.primary && !u.secondary)) return '';
    const isLive = u === codexLiveUsage;
    let s = '';

    if (u.primary) {
        const iso = isoFromEpoch(u.primary.resetsAt);
        s += `📊 **${planT('sb.codexPrimary')}**: ${codexUsedPercent(u.primary.usedPercent)}%` +
            (iso ? ` — ${resetAtLabel(iso)} (${untilHuman(iso)})` : '') + `\n\n`;
    }
    // Only rendered when Codex actually reports a second window — it is often null.
    if (u.secondary) {
        const iso = isoFromEpoch(u.secondary.resetsAt);
        s += `📅 **${planT('sb.codexSecondary')}**: ${codexUsedPercent(u.secondary.usedPercent)}%` +
            (iso ? ` — ${resetAtLabel(iso)} (${untilHuman(iso)})` : '') + `\n\n`;
    }
    if (u.planType) {
        const plan = u.planType.charAt(0).toUpperCase() + u.planType.slice(1);
        s += `💳 Plan: \`${plan}\`${u.hasCredits ? ` · ${planT('tt.credits')}` : ''}\n\n`;
    }
    if (u.observedAt) {
        const age = Date.now() - u.observedAt.getTime();
        // A live reading is authoritative the moment it is taken, so it is only called
        // stale once it ages out. A rollout snapshot is stale whenever Codex has been idle,
        // which is exactly the failure the live probe exists to avoid.
        const stale = age > CODEX_USAGE_STALE_MS
            ? ` — ⚠️ ${planT(isLive ? 'tt.staleLive' : 'tt.stale')}`
            : '';
        const src = isLive ? planT('tt.srcLive') : planT('tt.srcRollout');
        s += `🕐 ${planT('tt.observed')}: ${u.observedAt.toLocaleTimeString()} (${src})${stale}\n\n`;
    }
    return s;
}

function ensureCodexUsageFallback(): void {
    if (!codexUsageFallbackItem) {
        codexUsageFallbackItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9);
        codexUsageFallbackItem.command = 'claudeContextBar.openSettings';
    }
}

// Account-only Codex item. The OpenAI webview does not expose its selected thread ID to
// other extensions, and reopening a thread in another workspace does not rewrite its cwd.
// We cannot honestly invent session context, but the account limit remains authoritative.
function updateCodexUsageFallback(noCodexSessions: boolean): void {
    ensureCodexUsageFallback();
    const item = codexUsageFallbackItem!;
    const u = accountCodexUsage();
    if (!isCodexEnabled() || !noCodexSessions || !u?.primary) {
        item.hide();
        return;
    }

    const used = codexUsedPercent(u.primary.usedPercent);
    const iso = isoFromEpoch(u.primary.resetsAt);
    const compact = vscode.workspace.getConfiguration('claudeContextBar').get<boolean>('compactMode', false);
    item.text = compact
        ? `${providerIcon('codex')} Codex · ${used}% (${untilHumanCompact(iso)})`
        : `${providerIcon('codex')} Codex - ${planT('sb.codexLimit')} ${used}% (${untilHuman(iso)})`;
    item.color = colorForPercent(u.primary.usedPercent) ?? '#FF9F6E';
    item.backgroundColor = undefined;
    item.tooltip = new vscode.MarkdownString(
        sectionHeader('Codex Usage', '#FF9F6E') +
        codexUsageTooltipBlock() +
        `${planT('tt.codexNoWorkspaceSession')}\n\n` +
        `*${planT('tt.clickSettings')}*`
    );
    item.show();
}

// A coloured section divider for the merged tooltip — visually separates the claudeState
// (plan usage) block from the claudeContext (token) block. Rendered via supportHtml.
function sectionHeader(label: string, color: string): string {
    return `<span style="color:${color};">━━━━━━━━  ${label}  ━━━━━━━━</span>\n\n`;
}

// Markdown block describing plan usage; inserted into session tooltips. Only populated
// when plan usage is OK — setup/error prompts live on the dedicated warning item.
function planTooltipBlock(): string {
    if (planStatus === 'ok' && lastUsage) {
        const n = lastUsage;
        let s = `📊 **${planT('sb.session')}**: ${n.sessionPercent ?? '?'}% — ` +
            `${resetAtLabel(n.sessionResetAt)} (${untilHuman(n.sessionResetAt)})\n\n`;
        const weeklyTime = `${resetAtLabel(n.weeklyResetAt)} (${untilHuman(n.weeklyResetAt)})`;
        s += `📅 **${planT('sb.weekly')} Total**: ${n.weeklyPercent ?? '?'}% — ${weeklyTime}\n\n`;
        // Per-model weekly usage. Only show a model when claude.ai actually returns it
        // (Opus is often null → omit it rather than printing "—%"). The bucket set is not
        // fixed — Fable 5 joined the weekly limits and Sonnet may drop out — so we render
        // whatever models the API reported instead of a hardcoded Sonnet/Opus pair.
        for (const m of n.models ?? []) {
            const modelTime = m.resetAt
                ? `${resetAtLabel(m.resetAt)} (${untilHuman(m.resetAt)})`
                : weeklyTime;
            s += `🧩 **${planT('sb.weekly')} ${m.label}**: ${m.percent}% — ${modelTime}\n\n`;
        }
        return s;
    }
    return '';
}

function ensurePlanFallback() {
    if (!planFallbackItem) {
        planFallbackItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 8);
        planFallbackItem.command = 'claudeContextBar.openSettings';
    }
}

// Dedicated plan-usage item. Two jobs:
//  - OK + no session to merge into → show standalone "S xx% W xx%"
//  - enabled but unconfigured / expired / error → ALWAYS show a coloured warning so the
//    user knows credentials are missing (instead of silently showing nothing)
function updatePlanFallback(noSessions: boolean) {
    ensurePlanFallback();
    const item = planFallbackItem!;

    if (planStatus === 'ok') {
        // When a session item exists, plan usage is merged into it — hide this one.
        if (!noSessions || !lastUsage) {
            item.hide();
            return;
        }
        const sp = lastUsage.sessionPercent != null ? Math.round(lastUsage.sessionPercent) : null;
        const wp = lastUsage.weeklyPercent != null ? Math.round(lastUsage.weeklyPercent) : null;
        const compact = vscode.workspace.getConfiguration('claudeContextBar').get<boolean>('compactMode', false);
        if (compact) {
            item.text = `$(pulse) claudeStateBar S ${sp ?? '--'}% W ${wp ?? '--'}%`;
        } else {
            item.text = `$(pulse) claudeStateBar ${planT('sb.session')} ${sp ?? '--'}% ${planT('sb.weekly')} ${wp ?? '--'}%`;
        }
        item.color = colorForPercent(lastUsage.sessionPercent);
        item.backgroundColor = undefined;
        item.tooltip = new vscode.MarkdownString(planTooltipBlock() + `*Click to open settings*`);
        item.show();
        return;
    }

    // Warning states — always visible (with a coloured background) regardless of sessions.
    item.color = undefined;
    if (planStatus === 'unconfigured') {
        item.text = `$(warning) claudeStateBar — ${planT('sb.unconfigured')}`;
        item.tooltip = planT('sb.tooltip.needSettings');
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (planStatus === 'auth_expired') {
        item.text = `$(alert) claudeStateBar — ${planT('sb.cookieExpired')}`;
        item.tooltip = planT('sb.tooltip.authExpired');
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (planStatus === 'blocked') {
        item.text = `$(cloud) claudeStateBar — ${planT('sb.blocked')}`;
        item.tooltip = new vscode.MarkdownString(planT('sb.tooltip.blocked'));
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        item.text = `$(warning) claudeStateBar — ${planT('sb.error')}`;
        item.tooltip = planT('sb.error');
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    item.show();
}

function restartPlanPolling() {
    if (planRefreshInterval) {
        clearInterval(planRefreshInterval);
        planRefreshInterval = null;
    }
    // Only poll the network when credentials exist; otherwise the status bar just shows
    // the setup warning (refreshPlanUsage handles that on its own).
    if (!creds.getOrgId()) return;
    const sec = creds.getRefreshIntervalSec();
    planRefreshInterval = setInterval(refreshPlanUsage, sec * 1000);
}

// The per-model weekly bucket names are not stable — Sonnet left the weekly limits and
// Fable 5 joined — so when the breakdown comes back empty, log the response shape instead of
// guessing at key names. The usage endpoints carry only utilization numbers and reset times
// (no personal data), so their body is safe to log; the org fallback endpoint is not, and is
// therefore reduced to its key names.
function logUsageSchema(result: UsageResult) {
    const keys = Object.keys(result.raw ?? {});
    log(`[plan] response keys: ${keys.join(', ') || '(none)'}`);
    const models = result.normalized.models;
    log(`[plan] per-model buckets: ` +
        (models.length ? models.map((m) => `${m.key}=${m.percent}%`).join(', ') : '(none)'));
    if (!models.length && /\/usage(_limits)?$/.test(result.source)) {
        log(`[plan] no per-model buckets — raw body: ${JSON.stringify(result.raw)}`);
    }
}

async function refreshPlanUsage() {
    const orgId = creds.getOrgId();
    const sessionKey = await creds.getSessionKey();
    if (!orgId || !sessionKey) {
        planStatus = 'unconfigured';
        lastUsage = null;
        notifyUsage('unconfigured');
        refreshAllSessions();
        return;
    }

    log(`[plan] fetching usage (transport=${getTransport()})`);
    try {
        const result = await fetchUsage(sessionKey, orgId);
        lastUsage = result.normalized;
        planStatus = 'ok';
        log(`[plan] ok: session=${result.normalized.sessionPercent}% weekly=${result.normalized.weeklyPercent}% via ${result.source}`);
        logUsageSchema(result);
        // [diag 1.7.39] Record the live sessionResetAt on every poll (only when it changes) so the
        // current block state — open (future) or closed (past/null) — is readable from diag.log at
        // any moment, without waiting for a reset event.
        const nowReset = result.normalized.sessionResetAt;
        const nowFuture = !!nowReset && new Date(nowReset).getTime() > Date.now();
        const diagKey = `resetAt=${nowReset ?? 'null'} future=${nowFuture ? 'Y' : 'N'}`;
        if (diagKey !== lastPollDiag) {
            blockPrimer.appendDiag(`poll ${diagKey} session=${result.normalized.sessionPercent}%`);
            lastPollDiag = diagKey;
        }
        notifyUsage('ok', result.source);
        await detectBlockClose(result.normalized);
    } catch (e) {
        lastUsage = null;
        if (e instanceof AuthExpiredError) {
            planStatus = 'auth_expired';
            log(`[plan] auth expired (transport=${getTransport()}): ${(e as Error).message}`);
            notifyUsage('auth_expired');
        } else if (e instanceof CloudflareBlockedError) {
            // NOT an expired key — this host's TLS fingerprint is blocked by Cloudflare.
            planStatus = 'blocked';
            log(`[plan] cloudflare blocked (transport=${getTransport()}): ${(e as Error).message} — Session Key is fine; this host cannot reach claude.ai directly`);
            notifyUsage('error', planT('sb.tooltip.blocked'));
        } else {
            const msg = (e as Error)?.message ?? String(e);
            planStatus = 'error';
            log(`[plan] error: ${msg}`);
            notifyUsage('error', msg);
        }
    }
    refreshAllSessions();
}

// Detect a block CLOSE — active session usage falling to 0%. That is the only reliable signal that
// the 5-hour block ended and a fresh one can be opened. sessionResetAt is NOT usable: it stays in
// the future even when the block is closed (it points at midnight/next-day when idle), which is why
// the old reset-time detection never actually primed. On a >0% → 0% transition we send exactly one
// Telegram alert and (when enabled) prime once, gated by an atomic per-event lock so that multiple
// windows or a wake-from-sleep burst cannot duplicate either.
async function detectBlockClose(n: NormalizedUsage) {
    const now = Date.now();
    // A long gap between successful polls means the machine slept and just woke. Use a floor of
    // 5 min but scale with the configured poll interval so a slow interval isn't mistaken for sleep.
    const gap = lastBlockPollAt ? now - lastBlockPollAt : 0;
    const wokeGapMs = Math.max(WAKE_GAP_MS, creds.getRefreshIntervalSec() * 3 * 1000);
    const wokeFromSleep = lastBlockPollAt !== 0 && gap > wokeGapMs;
    lastBlockPollAt = now;

    const prevPct = creds.getLastSessionPercent();
    const curPct = n.sessionPercent;

    // (1) Block just closed: had usage (>0), now exactly 0. globalState carries prevPct across a
    //     sleep gap, so a reset that happened while asleep is caught on the first wake poll.
    // (2) Woke to a closed block: a long poll gap (sleep) AND currently 0% → open it regardless of
    //     the pre-sleep state. This covers "went to sleep AFTER the block had already reset", where
    //     there is no live >0%→0% transition to catch — the case that would otherwise miss on wake.
    const justClosed = prevPct != null && prevPct > 0 && curPct === 0;
    const wokeClosed = wokeFromSleep && curPct === 0;

    if (justClosed || wokeClosed) {
        // Coarse 10-minute bucket → every window/poll reacting to this same close computes the same
        // key, so the atomic lock lets exactly one through. A genuine next reset (5h later) lands in
        // a different bucket and is allowed to fire again.
        const eventKey = String(Math.floor(now / (10 * 60 * 1000)));
        if (blockPrimer.claimResetEvent(eventKey, log)) {
            blockPrimer.appendDiag(`block-closed prevPct=${prevPct} curPct=${curPct} woke=${wokeFromSleep} event=${eventKey} autoStart=${creds.getAutoStartBlockOnReset()}`);
            const token = await creds.getTelegramToken();
            const chatId = await creds.getTelegramChatId();
            if (creds.getTelegramNotifyOnReset() && token && chatId) {
                const weekly = n.weeklyPercent != null ? String(n.weeklyPercent) : '?';
                await telegram.sendMessage(token, chatId, planT('tg.resetMsg', weekly));
            }
            if (creds.getAutoStartBlockOnReset()) {
                primeNewBlock();
            }
        }
    }

    await creds.setLastSessionPercent(curPct);
}

// Verification polling: the resetAt move takes ~1 min to land, so retry a few times.
const PRIMER_VERIFY_INTERVAL_MS = 15000;
const PRIMER_VERIFY_TRIES = 5;
// A freshly opened 5-hour block puts sessionResetAt at ~now+5h. Anything within this bound counts
// as "block open"; the weekly-reset fallback (days away) is well outside it.
const BLOCK_OPEN_MAX_MS = 6 * 60 * 60 * 1000;

// Open the new 5-hour block, once the caller has confirmed the block is closed and claimed the
// event. Deliberately not awaited: the CLI takes a few seconds and the poll should not stall on it.
function primeNewBlock() {
    blockPrimer.firePrimer(
        log,
        (outcome, detail) => { void handlePrimerOutcome(outcome, detail); }
    );
}

async function handlePrimerOutcome(outcome: blockPrimer.FireOutcome, detail: string) {
    blockPrimer.appendDiag(`primer-outcome=${outcome} detail=${detail}`);

    if (outcome === 'api-key-present') {
        // Genuine billing hazard: an API key means `claude -p` bills API credit, not the plan.
        // This is the one case worth stopping + warning over (Telegram + VS Code).
        await disableAutoStart(planT('tg.primerApiKey'));
        return;
    }
    if (outcome === 'exec-failed') {
        // Local fault (CLI missing / not logged in). Record it; leave auto-start on so it retries.
        log('[primer] exec failed — leaving auto-start on');
        return;
    }

    // outcome === 'fired' — CLI exited 0. Confirm a block actually opened. The throwaway prompt is
    // tiny, so session% stays 0 (that's why the old %-based check false-negatived); the real proof
    // is sessionResetAt jumping to ~now+5h (away from the weekly-reset fallback). It takes ~1 min
    // to land, so retry.
    for (let i = 0; i < PRIMER_VERIFY_TRIES; i++) {
        await new Promise((r) => setTimeout(r, PRIMER_VERIFY_INTERVAL_MS));
        await refreshPlanUsage();
        const after = lastUsage?.sessionResetAt;
        const afterMs = after ? new Date(after).getTime() : NaN;
        if (Number.isFinite(afterMs) && afterMs > Date.now() && afterMs <= Date.now() + BLOCK_OPEN_MAX_MS) {
            blockPrimer.appendDiag(`primer-verified resetAt=${after} (block open ~5h)`);
            log(`[primer] verified — block open until ${after}`);
            return;
        }
    }

    // Fired but resetAt never moved into the 5-hour range. Could be a real "headless no longer opens
    // a block" case, or just a slow poll. With no API key set there is NO billing hazard, so do NOT
    // auto-disable here (that misfired on sleep/lag before) — record it and let the next close retry.
    blockPrimer.appendDiag(`primer-unverified resetAt=${lastUsage?.sessionResetAt ?? 'null'} — left auto-start on`);
    log(`[primer] not verified after ${PRIMER_VERIFY_TRIES} tries — left auto-start on`);
}

async function disableAutoStart(message: string) {
    await creds.setAutoStartBlockOnReset(false);
    await notifyTelegram(message);
    void vscode.window.showWarningMessage(message.replace(/<[^>]+>/g, ''));
}

async function notifyTelegram(text: string) {
    const token = await creds.getTelegramToken();
    const chatId = await creds.getTelegramChatId();
    if (token && chatId) await telegram.sendMessage(token, chatId, text);
}
