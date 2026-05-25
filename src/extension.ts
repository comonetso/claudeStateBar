import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as creds from './credentials';
import { fetchUsage, AuthExpiredError, CloudflareBlockedError, NormalizedUsage, getTransport } from './planUsage';
import * as telegram from './telegram';
import { createOrShowSettingsPanel, notifyUsage } from './settingsPanel';
import { getDict, Lang } from './i18n';

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
    isFallback?: boolean;
    lastAssistantEndTurnAt: Date | null;
    // Pause-detection signals (for the "question beep"):
    //   pendingQuestionAt — set when the latest assistant entry is an unanswered
    //     AskUserQuestion / ExitPlanMode tool_use (100% reliable signal).
    //   pendingToolUseAt  — set when the latest assistant entry is ANY unanswered
    //     tool_use (used by the optional stuck-tool-use heuristic).
    //   pendingToolUseName — the tool name of that unanswered tool_use (for logs).
    pendingQuestionAt: Date | null;
    pendingToolUseAt: Date | null;
    pendingToolUseName: string | null;
}

interface StatusBarEntry {
    item: vscode.StatusBarItem;
    sessionFile: string;
}

const statusBarItems: Map<string, StatusBarEntry> = new Map();
// Track manually hidden sessions: sessionFile -> timestamp when hidden
const hiddenSessions: Map<string, number> = new Map();
const alertedSessions = new Map<string, { warned: boolean; dangered: boolean }>();
const lastKnownEndTurnAt = new Map<string, number>();
// Pending completion beep timers — debounced so a hook follow-up or auto-injected
// user message can cancel the beep before it fires.
type PendingBeep = { timer: NodeJS.Timeout; markerAt: number };
const pendingCompletion = new Map<string, PendingBeep>();
// Baseline / pending state for the question beep (AskUserQuestion / ExitPlanMode).
const lastKnownQuestionAt = new Map<string, number>();
const pendingQuestion = new Map<string, PendingBeep>();
// Stuck-tool-use heuristic: remember the timestamp of the unanswered tool_use we
// already fired a beep for, so we don't re-fire while it stays unanswered.
const alertedStuckToolUseAt = new Map<string, number>();
let isFirstScan = true;
let refreshInterval: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel | null = null;

// --- Plan usage (claudeState) state ---
// Plan usage is merged into the first session status-bar item. When no Claude Code
// session is active, planFallbackItem shows the plan usage on its own.
let planFallbackItem: vscode.StatusBarItem | null = null;
let planRefreshInterval: NodeJS.Timeout | null = null;
let planTickInterval: NodeJS.Timeout | null = null;
let lastUsage: NormalizedUsage | null = null;
type PlanStatus = 'unconfigured' | 'ok' | 'auth_expired' | 'blocked' | 'error';
let planStatus: PlanStatus = 'unconfigured';

function log(msg: string) {
    outputChannel?.appendLine(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('claudeStateBar');
    context.subscriptions.push(outputChannel);
    log('claudeStateBar activating');
    log(`Platform: ${process.platform}, home: ${os.homedir()}, remoteName=${vscode.env.remoteName ?? '(none — local UI host)'}`);

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
        type BeepType = 'warning' | 'danger' | 'completion' | 'question';
        const pick = await vscode.window.showQuickPick(
            [
                { label: '$(bell) Warning beep (1×)',     description: 'warningThreshold 도달 시',     type: 'warning' as BeepType },
                { label: '$(bell) Danger beep (2×)',      description: 'dangerThreshold 도달 시',      type: 'danger' as BeepType },
                { label: '$(check) 작업 완료 알림',       description: 'Claude end_turn 감지 시 (settle 적용)', type: 'completion' as BeepType },
                { label: '$(question) 질문 대기 알림',     description: 'AskUserQuestion / ExitPlanMode 감지 시',    type: 'question' as BeepType },
            ],
            { placeHolder: '테스트할 비프 종류를 선택하세요' }
        );
        if (!pick) return;
        vscode.commands.executeCommand('claudeContextBar.playBeep', pick.type);
    });
    context.subscriptions.push(testBeepCmd);
    context.subscriptions.push(refreshPlanCmd);

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
            vscode.window.showInformationMessage('claudeStateBar: no hidden sessions to restore.');
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
            description: 'claudeState + claudeContextBar',
            action: 'settings'
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'claudeStateBar — choose action'
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
                vscode.commands.executeCommand('claudeContextBar.openSettings');
                break;
        }
    });
    context.subscriptions.push(menuCommand);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar')) {
            refreshAllSessions();
        }
        if (e.affectsConfiguration('claudeState')) {
            restartPlanPolling();
            refreshPlanUsage();
        }
    });
    context.subscriptions.push(configWatcher);

    // Re-filter when workspace folders change (e.g., user opens/closes a folder)
    const wsWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => { resetClaudeBaseUri(); refreshAllSessions(); });
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

    // Set up periodic refresh
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const intervalSeconds = config.get<number>('refreshInterval', 30);
    refreshInterval = setInterval(refreshAllSessions, intervalSeconds * 1000);

    // Start the claudeState plan-usage polling (no-op until enabled + credentials set)
    restartPlanPolling();
    refreshPlanUsage();
    // Recompute the "resets in ..." countdown once a minute without re-fetching
    planTickInterval = setInterval(() => { if (lastUsage) refreshAllSessions(); }, 60 * 1000);

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
            for (const [, p] of pendingCompletion) clearTimeout(p.timer);
            pendingCompletion.clear();
            for (const [, p] of pendingQuestion) clearTimeout(p.timer);
            pendingQuestion.clear();
            planFallbackItem?.dispose();
            statusBarItems.forEach(entry => entry.item.dispose());
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

// Play N beeps using OS-native commands (non-blocking, errors silently ignored).
// count=1: warning (single tone), count=2: danger (two ascending tones).
function playBeep(count: number): void {
    const kind = count === 1 ? 'warning' : 'danger';
    const soundPath = getSoundPath(kind);
    const gain = getSoundGain(kind);
    playSoundFile(soundPath, count, `beep:${kind}`, gain);
}

type SoundKind = 'warning' | 'danger' | 'completion' | 'question';

// Default WAV paths per platform — used when the user setting is empty.
const DEFAULT_WAVS: Record<SoundKind, string> = {
    warning: process.platform === 'win32' ? 'C:\\Windows\\Media\\Windows Notify.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Glass.aiff' : '',
    danger:  process.platform === 'win32' ? 'C:\\Windows\\Media\\Windows Critical Stop.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Glass.aiff' : '',
    completion: process.platform === 'win32' ? 'C:\\Windows\\Media\\tada.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Hero.aiff' : '',
    question: process.platform === 'win32' ? 'C:\\Windows\\Media\\Speech On.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Ping.aiff' : ''
};

function getSoundPath(kind: SoundKind): string {
    const cfg = vscode.workspace.getConfiguration('claudeContextBar');
    const key = kind === 'warning' ? 'soundWarning'
        : kind === 'danger' ? 'soundDanger'
        : kind === 'completion' ? 'soundCompletion'
        : 'soundQuestion';
    const user = cfg.get<string>(key, '').trim();
    return user || DEFAULT_WAVS[kind];
}

function getSoundGain(kind: SoundKind): number {
    const cfg = vscode.workspace.getConfiguration('claudeContextBar');
    const key = kind === 'warning' ? 'soundWarningGain'
        : kind === 'danger' ? 'soundDangerGain'
        : kind === 'completion' ? 'soundCompletionGain'
        : 'soundQuestionGain';
    const raw = cfg.get<number>(key, 100);
    // Clamp to documented range
    if (!Number.isFinite(raw)) return 100;
    return Math.max(50, Math.min(300, Math.round(raw)));
}

// Amplify a WAV file by gainPercent (50–300) by parsing the PCM data chunk and
// scaling each sample. Returns a path to a cached temp file. Falls back to the
// original path if anything goes wrong (unsupported format, parse error, etc.).
//
// Cache key: source file mtime + size + gain. The cache lives in
// %TEMP%/claudeContextBar/amplified/ and is invalidated when the source file
// changes (different mtime/size produces a different key).
//
// Supported PCM formats: 16-bit signed, 8-bit unsigned, 32-bit IEEE float.
// Other formats (24-bit, ADPCM, etc.) fall back to the original file.
function amplifyWavToTemp(srcPath: string, gainPercent: number): string {
    if (gainPercent === 100) return srcPath;
    try {
        const stat = fs.statSync(srcPath);
        const cacheDir = path.join(os.tmpdir(), 'claudeContextBar', 'amplified');
        const keyMaterial = `${srcPath}|${stat.mtimeMs}|${stat.size}|${gainPercent}`;
        const hash = crypto.createHash('sha1').update(keyMaterial).digest('hex').slice(0, 16);
        const base = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(cacheDir, `${base}_g${gainPercent}_${hash}.wav`);
        if (fs.existsSync(outPath)) return outPath;

        const buf = fs.readFileSync(srcPath);
        // Minimum RIFF/WAVE header sanity
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
            log(`[amp] not a RIFF/WAVE file, skipping: ${srcPath}`);
            return srcPath;
        }

        // Walk chunks to find "fmt " and "data"
        let fmtOffset = -1, fmtSize = 0;
        let dataOffset = -1, dataSize = 0;
        let p = 12;
        while (p + 8 <= buf.length) {
            const id = buf.toString('ascii', p, p + 4);
            const size = buf.readUInt32LE(p + 4);
            if (id === 'fmt ') { fmtOffset = p + 8; fmtSize = size; }
            else if (id === 'data') { dataOffset = p + 8; dataSize = size; break; }
            p += 8 + size + (size % 2);  // chunks are 2-byte aligned
        }
        if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) {
            log(`[amp] missing fmt/data chunks: ${srcPath}`);
            return srcPath;
        }

        const audioFormat = buf.readUInt16LE(fmtOffset);          // 1 = PCM, 3 = IEEE float
        const bitsPerSample = buf.readUInt16LE(fmtOffset + 14);
        const out = Buffer.from(buf);  // copy
        const dataEnd = Math.min(dataOffset + dataSize, out.length);
        const gain = gainPercent / 100;

        if (audioFormat === 1 && bitsPerSample === 16) {
            for (let i = dataOffset; i + 2 <= dataEnd; i += 2) {
                const s = out.readInt16LE(i);
                let v = Math.round(s * gain);
                if (v > 32767) v = 32767;
                else if (v < -32768) v = -32768;
                out.writeInt16LE(v, i);
            }
        } else if (audioFormat === 1 && bitsPerSample === 8) {
            // 8-bit PCM is unsigned, centred at 128
            for (let i = dataOffset; i < dataEnd; i++) {
                const s = out.readUInt8(i) - 128;
                let v = Math.round(s * gain) + 128;
                if (v > 255) v = 255;
                else if (v < 0) v = 0;
                out.writeUInt8(v, i);
            }
        } else if (audioFormat === 3 && bitsPerSample === 32) {
            for (let i = dataOffset; i + 4 <= dataEnd; i += 4) {
                let v = out.readFloatLE(i) * gain;
                if (v > 1) v = 1;
                else if (v < -1) v = -1;
                out.writeFloatLE(v, i);
            }
        } else {
            log(`[amp] unsupported WAV format (audioFormat=${audioFormat}, bits=${bitsPerSample}), skipping: ${srcPath}`);
            return srcPath;
        }

        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(outPath, out);
        log(`[amp] cached ${outPath} (gain=${gainPercent}%, ${bitsPerSample}-bit fmt=${audioFormat})`);
        return outPath;
    } catch (e: any) {
        log(`[amp] failed for ${srcPath}: ${e?.message ?? e}`);
        return srcPath;
    }
}

// Play a sound file by absolute path. Supports .wav (SoundPlayer.PlaySync — fast & sync)
// and .mp3 / other formats (WPF MediaPlayer — async, sleeps for media duration).
//
// Guard: if this extension instance is running on a remote host (Remote-SSH/WSL/etc.),
// sounds would play on the REMOTE server's audio device — which the user can't hear.
// Skip in that case. The local UI instance (where extensionKind=ui places this extension)
// is the one that should produce audio. See package.json "extensionKind": ["ui"].
function playSoundFile(soundPath: string, repeat: number = 1, label: string = 'beep', gainPercent: number = 100): void {
    if (vscode.env.remoteName) {
        log(`[${label}] skipped — running in remote (${vscode.env.remoteName}); sound only plays on local UI host`);
        return;
    }
    if (!soundPath) {
        log(`[${label}] empty soundPath, skipping`);
        return;
    }
    const isWav = soundPath.toLowerCase().endsWith('.wav');
    // WAV gets in-memory PCM amplification (can go above 100%, real volume boost).
    // MP3/other formats can only be ATTENUATED via the media player's Volume property
    // (0–1 range); we can't amplify them without re-encoding.
    let effectivePath = soundPath;
    if (isWav && gainPercent !== 100) {
        effectivePath = amplifyWavToTemp(soundPath, gainPercent);
    }
    log(`[${label}] playSoundFile path="${effectivePath}" repeat=${repeat} gain=${gainPercent}% platform=${process.platform}`);
    if (process.platform === 'win32') {
        const escaped = effectivePath.replace(/'/g, "''");
        let single: string;
        if (isWav) {
            single = `(New-Object System.Media.SoundPlayer '${escaped}').PlaySync()`;
        } else {
            // WPF MediaPlayer for MP3/other formats. Volume is 0–1 (no amplification possible).
            // For gain > 100, we fall back to original volume; for gain < 100, attenuate.
            const volume = Math.min(1, Math.max(0, gainPercent / 100));
            single = `Add-Type -AssemblyName presentationCore; $p = [System.Windows.Media.MediaPlayer]::new(); $p.Volume = ${volume.toFixed(3)}; $p.Open([System.Uri]::new('${escaped}')); $i = 0; while(-not $p.NaturalDuration.HasTimeSpan -and $i -lt 30){Start-Sleep -Milliseconds 50; $i++}; $p.Play(); $dur = if($p.NaturalDuration.HasTimeSpan){[Math]::Min($p.NaturalDuration.TimeSpan.TotalMilliseconds + 200, 10000)}else{5000}; Start-Sleep -Milliseconds $dur`;
        }
        const cmd = Array.from({ length: repeat }, () => single).join('; ');
        const full = `powershell -NoProfile -NonInteractive -c "${cmd}"`;
        log(`[${label}] exec (${isWav ? 'wav' : 'mp3/other'}): ${full.substring(0, 200)}${full.length > 200 ? '...' : ''}`);
        cp.exec(full, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
            if (err) log(`[${label}] exec error: ${err.message}`);
            if (stderr?.trim()) log(`[${label}] stderr: ${stderr.trim()}`);
            else log(`[${label}] exec completed`);
        });
    } else if (process.platform === 'darwin') {
        // afplay supports WAV, MP3, AIFF, AAC etc. natively. --volume 0..2.
        // For WAV we already amplified the file; pass volume 1.0. For MP3, pass gain/100 capped at 2.
        const escaped = effectivePath.replace(/"/g, '\\"');
        const afVol = isWav ? 1 : Math.min(2, Math.max(0, gainPercent / 100));
        const single = `afplay --volume ${afVol.toFixed(3)} "${escaped}"`;
        const cmd = Array.from({ length: repeat }, () => single).join(' && sleep 0.3 && ');
        cp.exec(cmd, (err) => { if (err) log(`[${label}] afplay error: ${err.message}`); });
    } else {
        // Linux: try paplay (WAV/OGG) → mpg123/ffplay (MP3) → aplay → fallback bell.
        // paplay has --volume (0–65536, 65536 = 100%); for gain > 100 we cap at ~200%.
        const esc = effectivePath.replace(/"/g, '\\"');
        const paVolStr = isWav ? '' : ` --volume=${Math.round(Math.min(2, Math.max(0, gainPercent / 100)) * 65536)}`;
        const playOne = soundPath
            ? `paplay${paVolStr} "${esc}" 2>/dev/null || mpg123 -q "${esc}" 2>/dev/null || ffplay -nodisp -autoexit -loglevel quiet "${esc}" 2>/dev/null || aplay -q "${esc}" 2>/dev/null || true`
            : 'paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || beep 2>/dev/null || true';
        const cmd = Array.from({ length: repeat }, () => playOne).join('; sleep 0.3; ');
        cp.exec(cmd, { shell: '/bin/bash' }, (err) => { if (err) log(`[${label}] linux error: ${err.message}`); });
    }
}

// 3-note ascending arpeggio (600→800→1000 Hz) — "Claude finished" positive signal,
// distinct from warning (single) and danger (double ascending pair).
function playCompletionSound(): void {
    playSoundFile(getSoundPath('completion'), 1, 'beep:completion', getSoundGain('completion'));
}

// Distinct chime for "Claude is paused waiting on the user" (AskUserQuestion /
// ExitPlanMode / optional stuck-tool-use heuristic). Default Speech On.wav on
// Windows — a short, clearly different tone from tada.wav.
function playQuestionSound(): void {
    playSoundFile(getSoundPath('question'), 1, 'beep:question', getSoundGain('question'));
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
    for (const [, p] of pendingCompletion) clearTimeout(p.timer);
    pendingCompletion.clear();
    for (const [, p] of pendingQuestion) clearTimeout(p.timer);
    pendingQuestion.clear();
    planFallbackItem?.dispose();
    statusBarItems.forEach(entry => entry.item.dispose());
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

async function readTextFile(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf-8');
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
    // Claude Code encodes all non-alphanumeric ASCII chars and all non-ASCII (Korean, etc.) as '-'
    return result.replace(/[:\\/\s_.]|[^\x00-\x7F]|[^a-zA-Z0-9\-]/g, '-');
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
    lastRealTimestamp: Date | null;  // Last timestamp excluding last-prompt entries
    wasCleared: boolean;  // True if session ended with /clear command
    lastAssistantEndTurnAt: Date | null;  // Timestamp of last end_turn assistant entry
    pendingQuestionAt: Date | null;  // See SessionInfo
    pendingToolUseAt: Date | null;
    pendingToolUseName: string | null;
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

async function getLatestTokenCount(jsonlUri: vscode.Uri): Promise<TokenUsage> {
    const empty: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, model: '', speed: '', firstMessage: '', sessionCreated: null, lastRealTimestamp: null, wasCleared: false, lastAssistantEndTurnAt: null, pendingQuestionAt: null, pendingToolUseAt: null, pendingToolUseName: null };
    try {
        const stat = await vscode.workspace.fs.stat(jsonlUri);
        if (stat.size === 0) {
            return empty;
        }

        // Read the file (routed to the remote host by VS Code when running over Remote-SSH)
        const content = await readTextFile(jsonlUri);
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
            let lastRealTimestamp: Date | null = null;
            let lastAssistantEndTurnAt: Date | null = null;
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
                    // Track last real timestamp (skip last-prompt entries — Claude Code writes
                    // these to the old file when a new session starts, inflating the mtime)
                    if (entry.timestamp && entry.type !== 'last-prompt') {
                        lastRealTimestamp = new Date(entry.timestamp);
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
                    // Track last complete assistant response (end_turn = tool calls excluded)
                    if (entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn' && entry.timestamp) {
                        lastAssistantEndTurnAt = new Date(entry.timestamp);
                    }
                } catch (e) {
                    continue;
                }
            }

            // --- Pause detection: scan from the end of the file for an unanswered tool_use ---
            //
            // Claude Code's tool flow always looks like:
            //   assistant entry (stop_reason="tool_use", content ends with one or more tool_use blocks)
            //   user entry     (content = tool_result blocks for each tool_use id)
            // While Claude is waiting on the user — either because it explicitly asked
            // (AskUserQuestion / ExitPlanMode) or because VS Code popped a permission
            // prompt for a tool like Bash — the tool_result entry has not been written yet.
            //
            // So: walk backwards from the end skipping empty lines. The first entry we hit
            // wins. If it is an assistant entry whose final content block is `tool_use`, we
            // are paused waiting on the user. The block's `name` tells us whether it's a
            // deliberate question (AskUserQuestion / ExitPlanMode) or any other tool (the
            // optional stuck-tool-use heuristic uses the latter).
            let pendingQuestionAt: Date | null = null;
            let pendingToolUseAt: Date | null = null;
            let pendingToolUseName: string | null = null;
            for (let i = lines.length - 1; i >= 0; i--) {
                const raw = lines[i];
                if (!raw.trim()) continue;
                try {
                    const e = JSON.parse(raw);
                    if (e.type !== 'assistant' && e.type !== 'user') continue;
                    // The newest meaningful entry — answer the pending question:
                    if (e.type === 'assistant' && e.message?.stop_reason === 'tool_use') {
                        const content = e.message?.content;
                        if (Array.isArray(content)) {
                            // Find the last tool_use block in the message
                            let lastTu: any = null;
                            for (let k = content.length - 1; k >= 0; k--) {
                                if (content[k]?.type === 'tool_use') { lastTu = content[k]; break; }
                            }
                            if (lastTu) {
                                const tsRaw = e.timestamp;
                                const ts = tsRaw ? new Date(tsRaw) : null;
                                pendingToolUseAt = ts;
                                pendingToolUseName = typeof lastTu.name === 'string' ? lastTu.name : null;
                                if (lastTu.name === 'AskUserQuestion' || lastTu.name === 'ExitPlanMode') {
                                    pendingQuestionAt = ts;
                                }
                            }
                        }
                    }
                    break; // First non-empty entry decides; stop scanning
                } catch { /* malformed line — skip */ }
            }

            return {
                inputTokens: finalUsage.inputTokens,
                cacheReadTokens: finalUsage.cacheReadTokens,
                cacheCreationTokens: finalUsage.cacheCreationTokens,
                totalTokens: finalUsage.totalTokens,
                model,
                speed,
                firstMessage: firstMessage ? firstMessage + '...' : '',
                sessionCreated,
                lastRealTimestamp,
                wasCleared,
                lastAssistantEndTurnAt,
                pendingQuestionAt,
                pendingToolUseAt,
                pendingToolUseName
            };
    } catch (e) {
        return empty;
    }
}

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
                lastAssistantEndTurnAt: usage.lastAssistantEndTurnAt,
                pendingQuestionAt: usage.pendingQuestionAt,
                pendingToolUseAt: usage.pendingToolUseAt,
                pendingToolUseName: usage.pendingToolUseName
            });
        }
    }

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
    const versionPart = version ? ` ${version}` : '';
    const onemPart = onem ? ` ${onem}` : '';
    return `${family}${versionPart}${onemPart}`;
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
    const suppressBeep = isFirstScan;
    isFirstScan = false;
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
        // Merge plan usage (claudeState) into the first (most recent) session item only,
        // so it isn't duplicated across multiple sessions.
        // Fallback sessions are dim (no active Claude) — claudeState shown separately via planFallbackItem
        const planAdd = i === 0 && !session.isFallback ? planTextSuffix(compactMode) : '';
        entry.item.text = `${displayName}${infoPart} (${session.percentage}%)${planAdd}${idleSuffix}`;

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
        if (!suppressBeep && session.lastAssistantEndTurnAt) {
            const curr = session.lastAssistantEndTurnAt.getTime();
            const lastActivity = session.lastUpdated.getTime();
            const prev = lastKnownEndTurnAt.get(session.sessionFile);
            const existing = pendingCompletion.get(session.sessionFile);

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

        // --- Question detection (AskUserQuestion / ExitPlanMode) ---
        // Same debounce shape as completion: if the user types a reply within the settle
        // window, no beep. Uses the same completionBeepSettleMs setting.
        if (!suppressBeep && session.pendingQuestionAt) {
            const curr = session.pendingQuestionAt.getTime();
            const lastActivity = session.lastUpdated.getTime();
            const prev = lastKnownQuestionAt.get(session.sessionFile);
            const existing = pendingQuestion.get(session.sessionFile);

            if (prev === undefined) {
                lastKnownQuestionAt.set(session.sessionFile, curr);
                log(`[q] first seen ${session.projectName} question=${session.pendingToolUseName} at=${new Date(curr).toISOString()}`);
            } else if (curr > prev) {
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
        const effortLineText = session.effortLevel ? getEffortLabel(session.effortLevel) : '';
        const effortLine = effortLineText ? `🎚️ Effort: \`${effortLineText}\`\n\n` : '';
        // Keep speed only when it's non-standard (i.e., /fast mode active) — otherwise hide noise
        const speedLine = (session.speed && session.speed !== 'standard') ? `⚡ Speed: \`${session.speed}\`\n\n` : '';
        const idleLine = session.isIdle ? `😴 **Idle** — ${formatIdleDuration(session.lastUpdated)}\n\n` : '';
        const planBlock = planTooltipBlock();
        const stateBody = planBlock || (planLang() === 'ko'
            ? '_이 호스트에선 플랜 사용량을 가져올 수 없습니다_\n\n'
            : '_Plan usage unavailable on this host_\n\n');
        const md = new vscode.MarkdownString(
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
        md.supportHtml = true;
        entry.item.tooltip = md;

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
            alertedSessions.delete(sessionFile);
            lastKnownEndTurnAt.delete(sessionFile);
            lastKnownQuestionAt.delete(sessionFile);
            alertedStuckToolUseAt.delete(sessionFile);
            const pc = pendingCompletion.get(sessionFile);
            if (pc) { clearTimeout(pc.timer); pendingCompletion.delete(sessionFile); }
            const pq = pendingQuestion.get(sessionFile);
            if (pq) { clearTimeout(pq.timer); pendingQuestion.delete(sessionFile); }
        }
    }

    // claudeState fallback: show standalone plan item when no real session exists.
    // Fallback (dim) context sessions don't count — claudeState must stay bright separately.
    const hasRealSession = sessions.some(s => !s.isFallback);
    updatePlanFallback(!hasRealSession);
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
    const days = weekdayNames();
    return `${timePart} (${days[d.getDay()]})`;
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
        // (Opus is often null → omit it rather than printing "—%").
        if (n.sonnetPercent != null) s += `🧩 **${planT('sb.weekly')} Sonnet**: ${n.sonnetPercent}% — ${weeklyTime}\n\n`;
        if (n.opusPercent != null) s += `🧩 **${planT('sb.weekly')} Opus**: ${n.opusPercent}% — ${weeklyTime}\n\n`;
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
        notifyUsage('ok', result.source);
        await detectSessionReset(result.normalized);
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

// Detect a session reset: the previously-stored reset time has elapsed AND the new
// reset time differs. Fires a Telegram notification when configured.
async function detectSessionReset(n: NormalizedUsage) {
    const prev = creds.getLastSessionResetAt();
    const current = n.sessionResetAt;
    if (prev && current && prev !== current) {
        const prevTime = new Date(prev).getTime();
        if (Number.isFinite(prevTime) && prevTime <= Date.now()) {
            const token = await creds.getTelegramToken();
            const chatId = await creds.getTelegramChatId();
            if (token && chatId) {
                const weekly = n.weeklyPercent != null ? String(n.weeklyPercent) : '?';
                await telegram.sendMessage(token, chatId, planT('tg.resetMsg', weekly));
            }
        }
    }
    if (current) {
        await creds.setLastSessionResetAt(current);
    }
}
