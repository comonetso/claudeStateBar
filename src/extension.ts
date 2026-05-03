import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface SessionInfo {
    projectName: string;
    projectPath: string;
    sessionId: string;
    sessionFile: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    percentage: number;
    lastUpdated: Date;
    model: string;
    speed: string;
    effortLevel: string;
    contextLimit: number;
    firstMessage: string;
    sessionCreated: Date | null;
    wasCleared: boolean;
    isIdle: boolean;
}

interface StatusBarEntry {
    item: vscode.StatusBarItem;
    sessionFile: string;
}

const statusBarItems: Map<string, StatusBarEntry> = new Map();
// Track manually hidden sessions: sessionFile -> timestamp when hidden
const hiddenSessions: Map<string, number> = new Map();
let fileWatcher: fs.FSWatcher | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel | null = null;

function log(msg: string) {
    outputChannel?.appendLine(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Claude Context Bar');
    context.subscriptions.push(outputChannel);
    log('Claude Context Bar activating');
    log(`Platform: ${process.platform}, home: ${os.homedir()}`);

    // Show diagnostics: logs workspace dirs, Claude dirs found, matching result
    const diagCommand = vscode.commands.registerCommand('claudeContextBar.showDiagnostics', async () => {
        outputChannel?.show(true);
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
        const claudeDir = getClaudeProjectsDir();
        log(`Claude projects dir: ${claudeDir}`);
        if (fs.existsSync(claudeDir)) {
            const dirs = fs.readdirSync(claudeDir);
            log(`Found ${dirs.length} project dirs:`);
            for (const d of dirs) {
                log(`  ${d}`);
            }
        } else {
            log('Claude projects dir does not exist!');
        }
        log('=== END DIAGNOSTICS ===');
        await refreshAllSessions();
    });
    context.subscriptions.push(diagCommand);

    // Direct hide command (kept for completeness; status bar click now opens the menu)
    const hideCommand = vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionFile: string) => {
        if (!sessionFile) return;
        hiddenSessions.set(sessionFile, Date.now());
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
            vscode.window.showInformationMessage('Claude Context Bar: no hidden sessions to restore.');
            return;
        }
        hiddenSessions.clear();
        refreshAllSessions();
    });
    context.subscriptions.push(restoreAllCommand);

    // Status bar click → QuickPick menu (hide this / restore hidden / open settings)
    const menuCommand = vscode.commands.registerCommand('claudeContextBar.showSessionMenu', async (sessionFile: string) => {
        type Item = vscode.QuickPickItem & { action?: 'hide' | 'restoreAll' | 'restoreOne' | 'settings'; sessionFile?: string };
        const items: Item[] = [];

        const clickedEntry = sessionFile ? statusBarItems.get(sessionFile) : undefined;
        const clickedLabel = clickedEntry?.item.text || (sessionFile ? path.basename(sessionFile) : 'this session');

        if (sessionFile) {
            items.push({
                label: '$(eye-closed) Hide this session',
                description: clickedLabel,
                action: 'hide'
            });
        }

        if (hiddenSessions.size > 0) {
            items.push({ label: 'Hidden sessions', kind: vscode.QuickPickItemKind.Separator });
            items.push({
                label: `$(eye) Restore all hidden (${hiddenSessions.size})`,
                action: 'restoreAll'
            });
            for (const [hiddenPath] of hiddenSessions) {
                const fileName = path.basename(hiddenPath).replace(/\.jsonl$/, '');
                const projectDir = path.basename(path.dirname(hiddenPath));
                items.push({
                    label: `$(eye) Restore: ${fileName.substring(0, 8)}`,
                    description: projectDir,
                    detail: hiddenPath,
                    action: 'restoreOne',
                    sessionFile: hiddenPath
                });
            }
        }

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(gear) Open settings…',
            action: 'settings'
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Claude Context Bar — choose action'
        });
        if (!picked) return;

        switch (picked.action) {
            case 'hide':
                if (sessionFile) {
                    hiddenSessions.set(sessionFile, Date.now());
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
                vscode.commands.executeCommand('workbench.action.openSettings', 'claudeContextBar');
                break;
        }
    });
    context.subscriptions.push(menuCommand);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar')) {
            refreshAllSessions();
        }
    });
    context.subscriptions.push(configWatcher);

    // Re-filter when workspace folders change (e.g., user opens/closes a folder)
    const wsWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAllSessions());
    context.subscriptions.push(wsWatcher);

    // Initial scan
    refreshAllSessions();

    // Set up file watcher
    const claudeProjectsDir = getClaudeProjectsDir();
    if (fs.existsSync(claudeProjectsDir)) {
        try {
            fileWatcher = fs.watch(claudeProjectsDir, { recursive: true }, (_event, filename) => {
                if (filename?.endsWith('.jsonl')) {
                    refreshAllSessions();
                }
            });
        } catch (e) {
            console.error('Failed to set up file watcher:', e);
        }
    }

    // Set up periodic refresh
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const intervalSeconds = config.get<number>('refreshInterval', 30);
    refreshInterval = setInterval(refreshAllSessions, intervalSeconds * 1000);

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (fileWatcher) {
                fileWatcher.close();
            }
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
            statusBarItems.forEach(entry => entry.item.dispose());
            statusBarItems.clear();
        }
    });
}

export function deactivate() {
    if (fileWatcher) {
        fileWatcher.close();
    }
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    statusBarItems.forEach(entry => entry.item.dispose());
    statusBarItems.clear();
}

function getClaudeProjectsDir(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.claude', 'projects');
}

// Encode an absolute workspace path into Claude's projects/ directory name format.
// Example: "F:\\workspace\\Etc Project\\foo" → "f--workspace-Etc-Project-foo"
//          "/Users/me/my project"            → "-Users-me-my-project"
function encodeWorkspacePath(p: string): string {
    let result = p;
    // Lowercase drive letter on Windows so it matches Claude's lowercase encoding
    if (/^[a-zA-Z]:/.test(result)) {
        result = result[0].toLowerCase() + result.slice(1);
    }
    // Each colon, slash, backslash, or whitespace becomes a single dash
    return result.replace(/[:\\/\s_.]/g, '-');
}

// Returns lowercase encoded directory names for the currently open workspace folders,
// or null if there are no workspace folders (single-file window).
function getWorkspaceProjectDirs(): Set<string> | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const dirs = new Set<string>();
    for (const f of folders) {
        dirs.add(encodeWorkspacePath(f.uri.fsPath).toLowerCase());
    }
    return dirs;
}

// Check if a Claude project directory name matches a given workspace folder.
// Primary: exact encoded-path match.
// Fallback: decode the Claude dir and compare normalised paths (handles encoding edge-cases on Linux).
function projectDirMatchesFolder(projectDir: string, f: vscode.WorkspaceFolder): boolean {
    const encoded = encodeWorkspacePath(f.uri.fsPath).toLowerCase();
    if (projectDir.toLowerCase() === encoded) return true;

    // Fallback: decode Claude's dir name and compare to the workspace path
    const { fullPath } = decodeProjectPath(projectDir);
    const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
    if (norm(fullPath) === norm(f.uri.fsPath)) return true;

    // Second fallback: last path segment(s) match
    const wsParts = f.uri.fsPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const claudeParts = projectDir.replace(/^-/, '').split('-').filter(Boolean);
    if (wsParts.length > 0 && claudeParts.length > 0) {
        const wsLast = wsParts[wsParts.length - 1].toLowerCase();
        const claudeLast = claudeParts[claudeParts.length - 1].toLowerCase();
        if (wsLast === claudeLast && wsParts.length >= 2 && claudeParts.length >= 2) {
            // Also check the parent segment for more confidence
            const wsParent = wsParts[wsParts.length - 2].toLowerCase();
            const claudeParent = claudeParts[claudeParts.length - 2].toLowerCase();
            if (wsParent === claudeParent) return true;
        }
    }

    return false;
}

function decodeProjectPath(encodedName: string): { name: string; fullPath: string } {
    // Claude encodes paths like: C--dev-my-cool-project or -Users-name-work-my-project
    // The double-dash after drive letter represents the colon (C: -> C--)
    // Single dashes represent path separators, BUT folder names can also contain dashes
    // 
    // Strategy: Detect OS from the pattern and reconstruct path
    let decoded = encodedName;

    // Remove leading dash if present
    if (decoded.startsWith('-')) {
        decoded = decoded.substring(1);
    }

    // Split by dashes and filter out empty strings (from double-dashes)
    const parts = decoded.split('-').filter(p => p.length > 0);
    let fullPath: string;
    let projectName: string;

    // Check if Windows pattern (first part is single drive letter like 'c', 'd', etc.)
    if (parts.length > 0 && parts[0].length === 1 && /[a-zA-Z]/.test(parts[0])) {
        // Windows path: C:\dev\my-cool-project
        // Claude typically encodes as: C--dev-my-cool-project
        // After filtering empty strings: ['C', 'dev', 'my', 'cool', 'project']
        fullPath = parts[0].toUpperCase() + ':\\' + parts.slice(1).join('\\');

        // Project name: use last few segments only (not full path chain)
        // For C:\dev\webapp -> parts = ['C', 'dev', 'webapp'] -> projectName = 'webapp'
        // For C:\dev\tools\extensions\vscode\my-extension -> use last 3 parts -> 'my-extension'
        if (parts.length >= 3) {
            // Skip drive letter and first folder, but limit to last 3 segments for deeply nested paths
            const startIndex = Math.max(2, parts.length - 3);
            const projectParts = parts.slice(startIndex);
            projectName = projectParts.join('-');
        } else {
            projectName = parts[parts.length - 1] || 'Unknown';
        }
    } else {
        // Unix path: /Users/Ed/work/my-project
        fullPath = '/' + parts.join('/');

        // Similar heuristic for Unix
        if (parts.length >= 3) {
            // Skip common prefixes like Users, home, etc.
            const projectParts = parts.slice(Math.max(2, parts.length - 3));
            projectName = projectParts.join('-');
        } else {
            projectName = parts[parts.length - 1] || 'Unknown';
        }
    }

    return { name: projectName, fullPath };
}

interface TokenUsage {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    model: string;
    speed: string;          // "standard" | "fast" (Claude Code /fast toggle)
    firstMessage: string;
    sessionCreated: Date | null;
    wasCleared: boolean;  // True if session ended with /clear command
}

// Determine context limit based on model id.
// 1M-context models (use limitOpus):
//   - Opus 4.x family (claude-opus-4-5 / 4-6 / 4-7) — confirmed 1M context
//   - Any model with "1m" in the id (e.g., "claude-sonnet-4-5-1m")
// All others (Sonnet, Haiku, etc.) use limitDefault.
function getContextLimitForModel(model: string, limitDefault: number, limitOpus: number): number {
    const m = model.toLowerCase();
    if (m.includes('1m')) return limitOpus;
    if (/opus[-_]?4/.test(m)) return limitOpus;
    return limitDefault;
}

// Extract the last syllable from a word for compact naming
// "typescript" → "script", "webpack" → "pack", "frontend" → "tend"
function extractLastSyllable(word: string): string {
    // Find a consonant cluster followed by vowel(s) followed by optional consonants at the end
    // This captures common syllable patterns like "tron", "script", "pack"
    const match = word.match(/[bcdfghjklmnpqrstvwxz]+[aeiou]+[bcdfghjklmnpqrstvwxz]*$/i);
    if (match) {
        return match[0];
    }
    // Fallback: just return last 3-4 chars
    return word.slice(-Math.min(4, word.length));
}

// Generate a short name for a project
// Multi-word: "my-cool-project" → "MCP" (acronym)
// Single-word: "typescript" → "Tscript" (first letter + last syllable)
// Short names (≤3 chars) are kept as-is
// Session numbers (-2, -3) are preserved
function getShortName(projectName: string, customNames: Record<string, string>): string {
    // Check custom override first (check both full name and base name)
    if (customNames[projectName]) {
        return customNames[projectName];
    }

    // Extract session number suffix if present (e.g., "my-project-2" → "-2")
    const sessionMatch = projectName.match(/-(\d+)$/);
    const sessionSuffix = sessionMatch ? sessionMatch[0] : '';
    const baseName = sessionMatch ? projectName.slice(0, -sessionSuffix.length) : projectName;

    // Check custom override for base name too
    if (customNames[baseName]) {
        return customNames[baseName] + sessionSuffix;
    }

    // If base name is already short (5 chars or less), don't shorten
    if (baseName.length <= 5) {
        return projectName;
    }

    // Split on common delimiters (dash, underscore, space) or camelCase boundaries
    const words = baseName.split(/[-_\s]|(?=[A-Z])/).filter(w => w.length > 0);

    let shortBase: string;
    if (words.length > 1) {
        // Multi-word: create acronym from first letter of each word
        shortBase = words.map(w => w[0]?.toUpperCase() || '').join('');
    } else {
        // Single-word: first letter uppercase + last syllable
        const lastSyllable = extractLastSyllable(baseName);
        shortBase = baseName[0].toUpperCase() + lastSyllable;
    }

    return shortBase + sessionSuffix;
}

async function getLatestTokenCount(jsonlPath: string): Promise<TokenUsage> {
    return new Promise((resolve) => {
        try {
            const stats = fs.statSync(jsonlPath);
            if (stats.size === 0) {
                resolve({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, model: '', speed: '', firstMessage: '', sessionCreated: null, wasCleared: false });
                return;
            }

            // Read the file
            const content = fs.readFileSync(jsonlPath, 'utf-8');
            const lines = content.trim().split('\n');

            // Scan backwards to find the last /clear command AND check for user activity after it
            let lastClearIndex = -1;
            let userMessagesAfterClear = 0;

            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);

                    // Check for User message
                    if (entry.type === 'user' && entry.message?.content) {
                        const msgContent = entry.message.content;

                        // Check for /clear command
                        if (typeof msgContent === 'string' && msgContent.includes('<command-name>/clear</command-name>')) {
                            lastClearIndex = i;
                            break; // Found the latest clear, stop scanning
                        }

                        // If not clear, it's a user message after the clear point (since we're going backwards)
                        userMessagesAfterClear++;
                    }
                } catch (e) {
                    continue;
                }
            }

            // Determine if session is effectively cleared
            // It is cleared IF:
            // 1. We found a /clear command
            // 2. AND there are NO user messages after it (meaning the user hasn't continued the session yet)
            const wasCleared = (lastClearIndex !== -1 && userMessagesAfterClear === 0);

            // Calculate usage and finding first message starting from AFTER the clear
            const startIndex = lastClearIndex >= 0 ? lastClearIndex + 1 : 0;

            let firstMessage = '';
            let sessionCreated: Date | null = null;
            let model = '';
            let speed = '';
            let finalUsage = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };

            // Forward pass from start index to find metadata and latest usage
            for (let i = startIndex; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);

                    // Get session creation timestamp (first valid timestamp after clear)
                    if (!sessionCreated && entry.timestamp) {
                        sessionCreated = new Date(entry.timestamp);
                    }

                    // Look for first user message (for display)
                    if (!firstMessage && entry.type === 'user' && entry.message?.content) {
                        const msgContent = entry.message.content;
                        // Skip command-related messages
                        if (typeof msgContent === 'string' &&
                            !msgContent.includes('<command-name>') &&
                            !msgContent.includes('<local-command-') &&
                            !msgContent.includes('Caveat:')) {
                            firstMessage = msgContent.substring(0, 60);
                        } else if (Array.isArray(msgContent) && msgContent[0]?.text) {
                            firstMessage = msgContent[0].text.substring(0, 60);
                        }
                    }

                    // Update latest usage/model as we go (capturing the last valid usage report)
                    if (entry.message?.model) {
                        model = entry.message.model;
                    }
                    // Capture speed (standard|fast) — set by Claude Code's /fast toggle
                    if (entry.message?.speed) {
                        speed = entry.message.speed;
                    } else if (entry.speed) {
                        speed = entry.speed;
                    }
                    if (entry.message?.usage || entry.usage) {
                        const u = entry.message?.usage || entry.usage;
                        finalUsage = {
                            inputTokens: u.input_tokens || 0,
                            cacheReadTokens: u.cache_read_input_tokens || 0,
                            cacheCreationTokens: u.cache_creation_input_tokens || 0,
                            totalTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                        };
                    }
                } catch (e) {
                    continue;
                }
            }

            resolve({
                inputTokens: finalUsage.inputTokens,
                cacheReadTokens: finalUsage.cacheReadTokens,
                cacheCreationTokens: finalUsage.cacheCreationTokens,
                totalTokens: finalUsage.totalTokens,
                model,
                speed,
                firstMessage: firstMessage ? firstMessage + '...' : '',
                sessionCreated,
                wasCleared
            });

        } catch (e) {
            resolve({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, model: '', speed: '', firstMessage: '', sessionCreated: null, wasCleared: false });
        }
    });
}

async function findActiveSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    const claudeDir = getClaudeProjectsDir();

    if (!fs.existsSync(claudeDir)) {
        return sessions;
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
    const globalEffortLevel = getGlobalEffortLevel();

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
        const projectDirs = fs.readdirSync(claudeDir);

        for (const projectDir of projectDirs) {
            const projectPath = path.join(claudeDir, projectDir);
            const stat = fs.statSync(projectPath);

            if (!stat.isDirectory()) continue;

            // Skip Claude Memory, plugin directories, and Claude's own .claude config dir
            if (projectDir.includes('claude-plugins') || projectDir.includes('claude-mem')) continue;
            if (projectDir.endsWith('--claude')) continue;  // /path/.claude encoded as --claude suffix

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
            const allJsonl = fs.readdirSync(projectPath)
                .filter(f => f.endsWith('.jsonl'))
                .filter(f => !f.startsWith('agent-'));
            log(`  JSONL files in ${projectDir}: ${allJsonl.length}`);
            const files = allJsonl
                .map(f => ({
                    name: f,
                    path: path.join(projectPath, f),
                    mtime: fs.statSync(path.join(projectPath, f)).mtime
                }))
                .filter(f => {
                    const ok = f.mtime.getTime() > hideThreshold;
                    if (!ok) log(`  Skip (too old, ${Math.round((Date.now() - f.mtime.getTime()) / 60000)}m ago): ${f.name}`);
                    return ok;
                })
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            if (files.length === 0) { log(`  No recent JSONL files (hideAfter=${hideAfter}s)`); continue; }

            // Get token count from EACH active session file (1 per Claude Code tab)
            for (const file of files) {
                const usage = await getLatestTokenCount(file.path);
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
                        projectName: displayName,
                        projectPath: fullPath,
                        sessionId,
                        sessionFile: file.path,
                        inputTokens: usage.inputTokens,
                        cacheReadTokens: usage.cacheReadTokens,
                        cacheCreationTokens: usage.cacheCreationTokens,
                        totalTokens: usage.totalTokens,
                        percentage: Math.round((usage.totalTokens / sessionContextLimit) * 100),
                        lastUpdated: file.mtime,
                        model: usage.model,
                        speed: usage.speed,
                        effortLevel: globalEffortLevel,
                        contextLimit: sessionContextLimit,
                        firstMessage: usage.firstMessage,
                        sessionCreated: usage.sessionCreated,
                        wasCleared: usage.wasCleared,
                        isIdle: file.mtime.getTime() <= idleThreshold
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

    return visibleSessions.slice(0, 5);
}

// Shorten a model id like "claude-sonnet-4-5-20250514" → "Sonnet 4.5" (or "S4.5" in compact mode).
// 1M-context variants get a "1M" suffix. Unknown families fall back to the last token of the id.
function getShortModelName(model: string, compact: boolean): string {
    if (!model) return '';
    const lower = model.toLowerCase();
    let family = '';
    let abbrev = '';
    if (lower.includes('opus')) { family = 'Opus'; abbrev = 'O'; }
    else if (lower.includes('sonnet')) { family = 'Sonnet'; abbrev = 'S'; }
    else if (lower.includes('haiku')) { family = 'Haiku'; abbrev = 'H'; }
    else {
        const parts = model.split('-');
        return parts[parts.length - 1] || model;
    }
    const verMatch = lower.match(/(\d+)-(\d+)/);
    const version = verMatch ? `${verMatch[1]}.${verMatch[2]}` : '';
    const onem = lower.includes('1m') ? '1M' : '';
    if (compact) {
        return `${abbrev}${version}${onem}`;
    }
    const versionPart = version ? ` ${version}` : '';
    const onemPart = onem ? ` ${onem}` : '';
    return `${family}${versionPart}${onemPart}`;
}

// Read global effort level from ~/.claude/settings.json. Returns lowercase raw value
// like "low" | "medium" | "high" | "xhigh" | "max", or '' on failure.
// Note: Claude Code stores this globally; all interactive sessions share the same effort.
function getGlobalEffortLevel(): string {
    try {
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const v = parsed?.effortLevel;
        return typeof v === 'string' ? v.toLowerCase() : '';
    } catch (e) {
        return '';
    }
}

// Convert a raw effort value to a display label. Always full names (no abbreviation).
//   low → Low, medium → Medium, high → High, xhigh → xHigh, max → Max
function getEffortLabel(raw: string): string {
    switch (raw.toLowerCase()) {
        case 'low': return 'Low';
        case 'medium': return 'Medium';
        case 'high': return 'High';
        case 'xhigh': return 'xHigh';
        case 'max': return 'Max';
        default: return raw;  // Unknown values pass through as-is
    }
}

function formatIdleDuration(lastUpdated: Date): string {
    const ms = Date.now() - lastUpdated.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'idle';
    if (min < 60) return `idle ${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (remMin === 0) return `idle ${hr}h`;
    return `idle ${hr}h${remMin}m`;
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
        return (tokens / 1000000).toFixed(1) + 'M';
    } else if (tokens >= 1000) {
        return Math.round(tokens / 1000) + 'K';
    }
    return tokens.toString();
}

async function refreshAllSessions() {
    const sessions = await findActiveSessions();
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const warningThreshold = config.get<number>('warningThreshold', 50);
    const dangerThreshold = config.get<number>('dangerThreshold', 75);
    const autoColor = config.get<boolean>('autoColor', true);
    const baseColor = config.get<string>('baseColor', 'White');
    const compactMode = config.get<boolean>('compactMode', false);
    const shortNames = config.get<Record<string, string>>('shortNames', {});
    const showModel = config.get<boolean>('showModel', true);

    // Pastel color palette for auto-coloring
    const pastelPalette = [
        '#a8d8ea', // Soft blue
        '#d4a5a5', // Dusty rose
        '#b5d8c7', // Sage green
        '#e8d5b7', // Warm beige
        '#c9b1ff', // Lavender
        '#ffd6a5', // Peach
        '#caffbf', // Mint
        '#bdb2ff', // Periwinkle
        '#ffc6ff', // Pink
    ];

    // Base color variations (subtle shifts from user's chosen color)
    const baseColorVariations: Record<string, string[]> = {
        'White': ['#ffffff', '#f5f5f5', '#ebebeb', '#e0e0e0', '#d5d5d5'],
        'Blue': ['#a8d8ea', '#9ecfe0', '#94c6d6', '#8abccc', '#80b2c2'],
        'Purple': ['#c9b1ff', '#bfa7f5', '#b59deb', '#ab93e1', '#a189d7'],
        'Cyan': ['#a0e7e5', '#96ddd9', '#8cd3cd', '#82c9c1', '#78bfb5'],
        'Green': ['#b5d8c7', '#abcebd', '#a1c4b3', '#97baa9', '#8db09f'],
        'Yellow': ['#ffeaa7', '#f5e09d', '#ebd693', '#e1cc89', '#d7c27f'],
        'Orange': ['#ffd6a5', '#f5cc9b', '#ebc291', '#e1b887', '#d7ae7d'],
        'Pink': ['#ffc6ff', '#f5bcf5', '#ebb2eb', '#e1a8e1', '#d79ed7'],
    };

    // Track project names to assign consistent colors
    const projectColorMap = new Map<string, string>();
    let colorIndex = 0;

    if (autoColor) {
        // Auto mode: use pastel palette
        for (const session of sessions) {
            if (!projectColorMap.has(session.projectName)) {
                projectColorMap.set(session.projectName, pastelPalette[colorIndex % pastelPalette.length]);
                colorIndex++;
            }
        }
    } else {
        // Manual mode: use variations of the base color
        const variations = baseColorVariations[baseColor] || baseColorVariations['White'];
        for (const session of sessions) {
            if (!projectColorMap.has(session.projectName)) {
                projectColorMap.set(session.projectName, variations[colorIndex % variations.length]);
                colorIndex++;
            }
        }
    }

    // Track which sessions we've seen
    const seenPaths = new Set<string>();

    // Sessions are sorted newest-first, so reverse for oldest-left display
    // For Left alignment: higher priority = further left
    for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        seenPaths.add(session.sessionFile);

        let entry = statusBarItems.get(session.sessionFile);

        if (!entry) {
            // Right-aligned: higher priority = more left. Use a small positive value
            // so we sit RIGHT of editor option items (line/col, encoding, language ≈ 100)
            // but LEFT of low-priority extension items (Antigravity, etc.).
            const priority = 10 - i;
            const item = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right,
                priority
            );
            entry = { item, sessionFile: session.sessionFile };
            statusBarItems.set(session.sessionFile, entry);
        }

        // Build status bar text in the form:  "{name}: {Model} - {Effort} ({pct}%) · idle Xm"
        // Emoji prefix dropped per user feedback. Effort/model are full names (no abbreviation).
        const displayName = compactMode ? getShortName(session.projectName, shortNames) : session.projectName;
        const modelLabel = showModel ? getShortModelName(session.model, compactMode) : '';
        const effortLabel = getEffortLabel(session.effortLevel);

        let infoPart = '';
        if (modelLabel && effortLabel) {
            infoPart = `: ${modelLabel} - ${effortLabel}`;
        } else if (modelLabel) {
            infoPart = `: ${modelLabel}`;
        } else if (effortLabel) {
            infoPart = `: ${effortLabel}`;
        }

        const idleSuffix = session.isIdle ? ` · ${formatIdleDuration(session.lastUpdated)}` : '';
        entry.item.text = `${displayName}${infoPart} (${session.percentage}%)${idleSuffix}`;

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
            entry.item.color = projectColorMap.get(session.projectName) || '#ffffff';
        }

        // Detailed tooltip with full token breakdown and first message
        const firstMsgLine = session.firstMessage ? `💬 *"${session.firstMessage}"*\n\n` : '';
        const effortLineText = session.effortLevel ? getEffortLabel(session.effortLevel) : '';
        const effortLine = effortLineText ? `🎚️ Effort: \`${effortLineText}\`\n\n` : '';
        // Keep speed only when it's non-standard (i.e., /fast mode active) — otherwise hide noise
        const speedLine = (session.speed && session.speed !== 'standard') ? `⚡ Speed: \`${session.speed}\`\n\n` : '';
        const idleLine = session.isIdle ? `😴 **Idle** — ${formatIdleDuration(session.lastUpdated)}\n\n` : '';
        entry.item.tooltip = new vscode.MarkdownString(
            `**${session.projectName}** (${session.sessionId})\n\n` +
            idleLine +
            firstMsgLine +
            `📁 \`${session.projectPath}\`\n\n` +
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

        // Click opens session menu (hide this / restore hidden / settings)
        entry.item.command = {
            command: 'claudeContextBar.showSessionMenu',
            title: 'Session Menu',
            arguments: [session.sessionFile]
        };

        entry.item.show();
    }

    // Remove status bar items for sessions that are no longer active
    for (const [sessionFile, entry] of statusBarItems) {
        if (!seenPaths.has(sessionFile)) {
            entry.item.dispose();
            statusBarItems.delete(sessionFile);
        }
    }
}
