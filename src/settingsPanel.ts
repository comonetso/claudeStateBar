import * as vscode from 'vscode';
import { getDict, Lang } from './i18n';
import * as creds from './credentials';
import * as telegram from './telegram';

export interface PanelCallbacks {
    // Called when plan-usage-affecting settings change (enabled/orgId/cookie/interval).
    onPlanSettingsChanged: () => void;
    // Called when the user clicks "Refresh now". Should fetch usage and report back
    // via SettingsPanel.notifyUsage(...).
    onRefreshRequested: () => void;
}

let panel: vscode.WebviewPanel | null = null;
let callbacks: PanelCallbacks | null = null;

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

export function createOrShowSettingsPanel(
    context: vscode.ExtensionContext,
    cb: PanelCallbacks
): void {
    callbacks = cb;

    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'claudeContextBarSettings',
        'claudeStateBar',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        }
    );

    panel.webview.html = getHtml(panel.webview, context.extensionUri);

    panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(
        async (msg) => handleMessage(msg),
        null,
        context.subscriptions
    );
}

// Forward plan-usage fetch results to the open panel (status line feedback).
export function notifyUsage(status: 'ok' | 'auth_expired' | 'error' | 'unconfigured', detail?: string): void {
    if (!panel) return;
    const lang = creds.getLanguage();
    const dict = getDict(lang);
    const fmt = (key: string, arg?: string) => {
        const v = dict[key];
        if (typeof v !== 'string') return key;
        return arg != null ? v.replace('{0}', arg) : v;
    };
    let text = '';
    let kind: 'ok' | 'err' = 'ok';
    if (status === 'ok') { text = fmt('state.msg.ok', detail || ''); kind = 'ok'; }
    else if (status === 'auth_expired') { text = fmt('state.msg.authExpired'); kind = 'err'; }
    else if (status === 'error') { text = fmt('state.msg.err', detail || ''); kind = 'err'; }
    else { text = fmt('state.msg.needSettings'); kind = 'err'; }
    panel.webview.postMessage({ type: 'status', text, kind });
}

async function collectState() {
    const cbCfg = vscode.workspace.getConfiguration('claudeContextBar');
    return {
        orgId: creds.getOrgId(),
        refreshIntervalSec: creds.getRefreshIntervalSec(),
        language: creds.getLanguage(),
        hasCookie: await creds.hasSessionKey(),
        telegramToken: await creds.getTelegramToken(),
        telegramChatId: await creds.getTelegramChatId(),
        telegramNotifyOnReset: creds.getTelegramNotifyOnReset(),
        autoStartBlockOnReset: creds.getAutoStartBlockOnReset(),
        cb: {
            autoColor: cbCfg.get('autoColor', true),
            baseColor: cbCfg.get('baseColor', 'White'),
            contextLimitDefault: cbCfg.get('contextLimitDefault', 200000),
            contextLimitOpus: cbCfg.get('contextLimitOpus', 1000000),
            warningThreshold: cbCfg.get('warningThreshold', 50),
            dangerThreshold: cbCfg.get('dangerThreshold', 75),
            refreshInterval: cbCfg.get('refreshInterval', 30),
            idleTimeout: cbCfg.get('idleTimeout', 180),
            hideAfter: cbCfg.get('hideAfter', 86400),
            scope: cbCfg.get('scope', 'workspace'),
            showModel: cbCfg.get('showModel', true),
            compactMode: cbCfg.get('compactMode', false),
            soundWarning: cbCfg.get('soundWarning', ''),
            soundDanger: cbCfg.get('soundDanger', ''),
            soundCompletion: cbCfg.get('soundCompletion', ''),
            soundQuestion: cbCfg.get('soundQuestion', ''),
            soundWorkflow: cbCfg.get('soundWorkflow', ''),
            soundWarningGain: cbCfg.get('soundWarningGain', 100),
            soundDangerGain: cbCfg.get('soundDangerGain', 100),
            soundCompletionGain: cbCfg.get('soundCompletionGain', 100),
            soundQuestionGain: cbCfg.get('soundQuestionGain', 100),
            soundWorkflowGain: cbCfg.get('soundWorkflowGain', 100),
            workflowCompleteBeep: cbCfg.get('workflowCompleteBeep', true),
            completionBeepSettleMs: cbCfg.get('completionBeepSettleMs', 3000),
            detectStuckToolUse: cbCfg.get('detectStuckToolUse', false),
            stuckToolUseThresholdSec: cbCfg.get('stuckToolUseThresholdSec', 90),
            codexEnabled: cbCfg.get('codex.enabled', true),
            codexHome: cbCfg.get('codex.home', ''),
            codexScanDays: cbCfg.get('codex.scanDays', 3)
        }
    };
}

async function handleMessage(msg: any): Promise<void> {
    if (!panel) return;

    switch (msg.type) {
        case 'ready': {
            const lang = creds.getLanguage();
            panel.webview.postMessage({
                type: 'init',
                lang,
                dict: getDict(lang),
                state: await collectState()
            });
            break;
        }

        case 'setLanguage': {
            const lang: Lang = msg.lang === 'ko' ? 'ko' : 'en';
            await creds.setLanguage(lang);
            panel.webview.postMessage({ type: 'i18n', lang, dict: getDict(lang) });
            break;
        }

        case 'save': {
            const p = msg.payload || {};
            try {
                await creds.setOrgId(p.orgId || '');
                await creds.setRefreshIntervalSec(p.refreshIntervalSec || 300);
                if (typeof p.sessionCookie === 'string' && p.sessionCookie) {
                    await creds.setSessionKey(p.sessionCookie);
                    panel.webview.postMessage({ type: 'cookieSaved' });
                }
                if (typeof p.telegramNotifyOnReset === 'boolean') {
                    await creds.setTelegramNotifyOnReset(p.telegramNotifyOnReset);
                }
                if (typeof p.autoStartBlockOnReset === 'boolean') {
                    await creds.setAutoStartBlockOnReset(p.autoStartBlockOnReset);
                }
                // Persist claudeContextBar settings
                if (p.cb) {
                    const cbCfg = vscode.workspace.getConfiguration('claudeContextBar');
                    const T = vscode.ConfigurationTarget.Global;
                    await cbCfg.update('autoColor', p.cb.autoColor, T);
                    await cbCfg.update('baseColor', p.cb.baseColor, T);
                    await cbCfg.update('contextLimitDefault', p.cb.contextLimitDefault, T);
                    await cbCfg.update('contextLimitOpus', p.cb.contextLimitOpus, T);
                    await cbCfg.update('warningThreshold', p.cb.warningThreshold, T);
                    await cbCfg.update('dangerThreshold', p.cb.dangerThreshold, T);
                    await cbCfg.update('refreshInterval', p.cb.refreshInterval, T);
                    await cbCfg.update('idleTimeout', p.cb.idleTimeout, T);
                    await cbCfg.update('hideAfter', p.cb.hideAfter, T);
                    await cbCfg.update('scope', p.cb.scope, T);
                    await cbCfg.update('showModel', p.cb.showModel, T);
                    await cbCfg.update('compactMode', p.cb.compactMode, T);
                    await cbCfg.update('soundWarning', p.cb.soundWarning ?? '', T);
                    await cbCfg.update('soundDanger', p.cb.soundDanger ?? '', T);
                    await cbCfg.update('soundCompletion', p.cb.soundCompletion ?? '', T);
                    await cbCfg.update('soundQuestion', p.cb.soundQuestion ?? '', T);
                    await cbCfg.update('soundWorkflow', p.cb.soundWorkflow ?? '', T);
                    const clampGain = (v: any) => {
                        const n = Number(v);
                        if (!Number.isFinite(n)) return 100;
                        return Math.max(50, Math.min(5000, Math.round(n)));
                    };
                    await cbCfg.update('soundWarningGain', clampGain(p.cb.soundWarningGain), T);
                    await cbCfg.update('soundDangerGain', clampGain(p.cb.soundDangerGain), T);
                    await cbCfg.update('soundCompletionGain', clampGain(p.cb.soundCompletionGain), T);
                    await cbCfg.update('soundQuestionGain', clampGain(p.cb.soundQuestionGain), T);
                    await cbCfg.update('soundWorkflowGain', clampGain(p.cb.soundWorkflowGain), T);
                    await cbCfg.update('workflowCompleteBeep', !!p.cb.workflowCompleteBeep, T);
                    const clampSettle = (v: any) => {
                        const n = Number(v);
                        if (!Number.isFinite(n)) return 3000;
                        return Math.max(100, Math.min(5000, Math.round(n)));
                    };
                    await cbCfg.update('completionBeepSettleMs', clampSettle(p.cb.completionBeepSettleMs), T);
                    await cbCfg.update('detectStuckToolUse', !!p.cb.detectStuckToolUse, T);
                    const clampStuck = (v: any) => {
                        const n = Number(v);
                        if (!Number.isFinite(n)) return 90;
                        return Math.max(30, Math.min(600, Math.round(n)));
                    };
                    await cbCfg.update('stuckToolUseThresholdSec', clampStuck(p.cb.stuckToolUseThresholdSec), T);
                    await cbCfg.update('codex.enabled', !!p.cb.codexEnabled, T);
                    await cbCfg.update('codex.home', (p.cb.codexHome ?? '').trim(), T);
                    const clampScanDays = (v: any) => {
                        const n = Number(v);
                        if (!Number.isFinite(n)) return 3;
                        return Math.max(1, Math.min(60, Math.round(n)));
                    };
                    await cbCfg.update('codex.scanDays', clampScanDays(p.cb.codexScanDays), T);
                }
                callbacks?.onPlanSettingsChanged();
            } catch (e: any) {
                const lang = creds.getLanguage();
                const dict = getDict(lang);
                const tmpl = dict['state.msg.saveFailed'];
                const text = typeof tmpl === 'string' ? tmpl.replace('{0}', e?.message ?? String(e)) : String(e);
                panel.webview.postMessage({ type: 'status', text, kind: 'err' });
            }
            break;
        }

        case 'refresh': {
            callbacks?.onRefreshRequested();
            break;
        }

        case 'telegramLink': {
            try {
                const link = await telegram.resolveFirstChatId(msg.token);
                await creds.setTelegramToken(msg.token);
                await creds.setTelegramChatId(link.chatId);
                panel.webview.postMessage({
                    type: 'telegramLinkResult',
                    ok: true,
                    chatId: link.chatId,
                    name: link.name
                });
            } catch (e: any) {
                const valid = await telegram.testToken(msg.token);
                panel.webview.postMessage({
                    type: 'telegramLinkResult',
                    ok: false,
                    error: valid ? 'no_messages' : 'invalid_token'
                });
            }
            break;
        }

        case 'testBeep': {
            const gain = (typeof msg.gainPercent === 'number' && Number.isFinite(msg.gainPercent)) ? msg.gainPercent : undefined;
            console.log('[settingsPanel] testBeep received, beepType=', msg.beepType, 'customPath=', msg.customPath, 'gain=', gain);
            vscode.commands.executeCommand('claudeContextBar.playBeep', msg.beepType || 'warning', msg.customPath || undefined, gain);
            break;
        }

        case 'pickSoundFile': {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Select sound file',
                filters: { 'Audio': ['wav', 'mp3'], 'All': ['*'] },
                defaultUri: vscode.Uri.file(process.platform === 'win32' ? 'C:\\Windows\\Media' : '/')
            });
            const filePath = picked && picked[0] ? picked[0].fsPath : '';
            panel.webview.postMessage({ type: 'soundFilePicked', kind: msg.kind, path: filePath });
            break;
        }

        case 'telegramTest': {
            const lang = creds.getLanguage();
            const dict = getDict(lang);
            const token = await creds.getTelegramToken();
            const chatId = await creds.getTelegramChatId();
            const tmpl = dict['tg.resetMsg'];
            const text = typeof tmpl === 'string' ? tmpl.replace('{0}', '—') : 'Claude session reset';
            const ok = await telegram.sendMessage(token, chatId, text);
            panel.webview.postMessage({ type: 'telegramTestResult', ok });
            break;
        }
    }
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'settings.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'settings.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>claudeStateBar</title>
</head>
<body>
  <div class="container">
    <h1 data-i18n="panel.title">Claude Settings</h1>

    <!-- Language toggle (top) -->
    <div class="lang-row">
      <label for="language" data-i18n="lang.label">Language</label>
      <select id="language" style="width:auto; min-width:140px;">
        <option value="en">English</option>
        <option value="ko">한국어</option>
      </select>
    </div>

    <!-- claudeState section -->
    <div class="section">
      <h2 class="section-header" data-i18n="section.claudeState">claudeState — Plan Usage</h2>

      <div class="field">
        <label for="orgId" data-i18n="state.orgId.label">Organization ID</label>
        <input type="text" id="orgId" data-i18n-placeholder="state.orgId.placeholder" autocomplete="off" />
        <p class="hint" data-i18n="state.orgId.hint"></p>
      </div>

      <div class="field">
        <label for="sessionCookie" data-i18n="state.cookie.label">Session Key</label>
        <textarea id="sessionCookie" rows="3" data-i18n-placeholder="state.cookie.placeholder" autocomplete="off"></textarea>
        <p class="hint" data-i18n="state.cookie.hint"></p>
      </div>

      <div class="field">
        <label for="refreshInterval" data-i18n="state.interval.label">Refresh interval (seconds)</label>
        <input type="number" id="refreshInterval" min="10" max="3600" step="10" value="300" />
        <p class="hint" data-i18n="state.interval.hint"></p>
      </div>

      <p class="note" data-i18n="state.note"></p>
    </div>

    <!-- Telegram section -->
    <div class="section">
      <h2 class="section-header" data-i18n="section.telegram">Telegram Notifications</h2>

      <div class="field">
        <label for="telegramToken" data-i18n="tg.token.label">Bot Token</label>
        <input type="text" id="telegramToken" data-i18n-placeholder="tg.token.placeholder" autocomplete="off" />
        <p class="hint" data-i18n="tg.token.hint"></p>
      </div>

      <div class="field">
        <p class="telegram-guide" data-i18n-html="tg.guide"></p>
      </div>

      <div class="field telegram-status-row">
        <span id="telegram-status" class="telegram-status" data-i18n="tg.notLinked">Not linked</span>
        <button id="telegram-link-btn" class="secondary small" data-i18n="tg.link">Link my Telegram</button>
        <button id="telegram-test-btn" class="secondary small" data-i18n="tg.test" disabled>Test</button>
      </div>

      <div class="field" style="margin-top:10px;">
        <label class="checkbox-label">
          <input type="checkbox" id="tg-notifyOnReset" />
          <span data-i18n="tg.notifyOnReset.label">Send a Telegram alert on each 5-hour reset</span>
        </label>
      </div>
      <div class="field">
        <label class="checkbox-label">
          <input type="checkbox" id="st-autoStartBlock" />
          <span data-i18n="st.autoStartBlock.label">Auto-start the next 5-hour block on reset (claude -p)</span>
        </label>
        <p class="hint" data-i18n="st.autoStartBlock.hint"></p>
      </div>
    </div>

    <!-- claudeContextBar section -->
    <div class="section">
      <h2 class="section-header" data-i18n="section.claudeContextBar">claudeContextBar — Context Monitor</h2>

      <div class="grid-2">
        <div class="field">
          <label for="cb-warningThreshold" data-i18n="cb.warningThreshold.label">Warning threshold (%)</label>
          <input type="number" id="cb-warningThreshold" min="0" max="100" />
        </div>
        <div class="field">
          <label for="cb-dangerThreshold" data-i18n="cb.dangerThreshold.label">Danger threshold (%)</label>
          <input type="number" id="cb-dangerThreshold" min="0" max="100" />
        </div>
        <div class="field">
          <label for="cb-contextLimitDefault" data-i18n="cb.contextLimitDefault.label">Context limit — standard</label>
          <input type="number" id="cb-contextLimitDefault" min="1000" step="1000" />
        </div>
        <div class="field">
          <label for="cb-contextLimitOpus" data-i18n="cb.contextLimitOpus.label">Context limit — 1M</label>
          <input type="number" id="cb-contextLimitOpus" min="1000" step="1000" />
        </div>
        <div class="field">
          <label for="cb-refreshInterval" data-i18n="cb.refreshInterval.label">Refresh interval (s)</label>
          <input type="number" id="cb-refreshInterval" min="5" />
        </div>
        <div class="field">
          <label for="cb-idleTimeout" data-i18n="cb.idleTimeout.label">Idle dim timeout (s)</label>
          <input type="number" id="cb-idleTimeout" min="10" />
        </div>
        <div class="field">
          <label for="cb-hideAfter" data-i18n="cb.hideAfter.label">Hide after (s)</label>
          <input type="number" id="cb-hideAfter" min="60" />
        </div>
        <div class="field">
          <label for="cb-scope" data-i18n="cb.scope.label">Session scope</label>
          <select id="cb-scope">
            <option value="workspace" data-i18n="cb.scope.workspace">Current workspace / this window's Codex chat</option>
            <option value="all" data-i18n="cb.scope.all">All recent sessions</option>
          </select>
        </div>
        <div class="field">
          <label for="cb-baseColor" data-i18n="cb.baseColor.label">Base color</label>
          <select id="cb-baseColor">
            <option value="White">White</option>
            <option value="Blue">Blue</option>
            <option value="Purple">Purple</option>
            <option value="Cyan">Cyan</option>
            <option value="Green">Green</option>
            <option value="Yellow">Yellow</option>
            <option value="Orange">Orange</option>
            <option value="Pink">Pink</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label class="checkbox-label">
          <input type="checkbox" id="cb-autoColor" />
          <span data-i18n="cb.autoColor.label">Auto color</span>
        </label>
      </div>
      <div class="field">
        <label class="checkbox-label">
          <input type="checkbox" id="cb-showModel" />
          <span data-i18n="cb.showModel.label">Show model name</span>
        </label>
      </div>
      <div class="field">
        <label class="checkbox-label">
          <input type="checkbox" id="cb-compactMode" />
          <span data-i18n="cb.compactMode.label">Compact mode</span>
        </label>
      </div>

      <p class="note" data-i18n="cb.note"></p>
    </div>

    <!-- Codex provider -->
    <div class="section">
      <h2 class="section-header" data-i18n="section.codex">Codex — Context Monitor</h2>

      <div class="field">
        <label class="checkbox-label">
          <input type="checkbox" id="cb-codexEnabled" />
          <span data-i18n="codex.enabled.label">Enable Codex sessions</span>
        </label>
        <p class="hint" data-i18n="codex.enabled.hint">Read ~/.codex rollout logs and show Codex sessions in the status bar (⬢). No effect if Codex is not installed.</p>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="cb-codexHome" data-i18n="codex.home.label">Codex home directory</label>
          <input type="text" id="cb-codexHome" placeholder="$CODEX_HOME / ~/.codex" />
          <p class="hint" data-i18n="codex.home.hint">Leave empty to auto-detect ($CODEX_HOME, then ~/.codex).</p>
        </div>
        <div class="field">
          <label for="cb-codexScanDays" data-i18n="codex.scanDays.label">Days of history to scan</label>
          <input type="number" id="cb-codexScanDays" min="1" max="60" step="1" />
          <p class="hint" data-i18n="codex.scanDays.hint">Codex stores sessions under sessions/YYYY/MM/DD. Only this many recent day folders are scanned.</p>
        </div>
      </div>
    </div>

    <!-- Sound settings -->
    <div class="section">
      <h2 class="section-header" data-i18n="sound.title">비프음 설정</h2>
      <p class="hint" style="margin-bottom:10px;" data-i18n="sound.hint">WAV / MP3 파일 경로 (비워두면 OS 기본음). 볼륨 50~5000% (WAV만 증폭, MP3는 감쇠만). 300% 이상은 클리핑(왜곡) 발생. 로컬 PC에서 재생되며 Remote-SSH·워크스페이스 무관하게 동일하게 적용됩니다.</p>

      <div class="sound-row" data-kind="warning">
        <label class="sound-label" data-i18n="sound.warning">⚠️ 경고 (1×)</label>
        <input type="text" id="sound-warning" class="sound-input" placeholder="C:\\Windows\\Media\\Windows Notify.wav (기본)" />
        <input type="number" id="sound-warning-gain" class="sound-gain" min="50" max="5000" step="10" value="100" title="볼륨 (%)" />
        <button class="secondary small sound-preview-btn" data-kind="warning" title="미리듣기">▶</button>
        <button class="secondary small sound-pick-btn"    data-kind="warning" title="파일 찾기">📁</button>
      </div>

      <div class="sound-row" data-kind="danger">
        <label class="sound-label" data-i18n="sound.danger">🔴 위험 (2×)</label>
        <input type="text" id="sound-danger" class="sound-input" placeholder="C:\\Windows\\Media\\Windows Critical Stop.wav (기본)" />
        <input type="number" id="sound-danger-gain" class="sound-gain" min="50" max="5000" step="10" value="100" title="볼륨 (%)" />
        <button class="secondary small sound-preview-btn" data-kind="danger" title="미리듣기">▶</button>
        <button class="secondary small sound-pick-btn"    data-kind="danger" title="파일 찾기">📁</button>
      </div>

      <div class="sound-row" data-kind="completion">
        <label class="sound-label" data-i18n="sound.completion">✅ 작업 완료</label>
        <input type="text" id="sound-completion" class="sound-input" placeholder="C:\\Windows\\Media\\tada.wav (기본)" />
        <input type="number" id="sound-completion-gain" class="sound-gain" min="50" max="5000" step="10" value="100" title="볼륨 (%)" />
        <button class="secondary small sound-preview-btn" data-kind="completion" title="미리듣기">▶</button>
        <button class="secondary small sound-pick-btn"    data-kind="completion" title="파일 찾기">📁</button>
      </div>

      <div class="sound-row" data-kind="question">
        <label class="sound-label" data-i18n="sound.question">❓ 질문 대기</label>
        <input type="text" id="sound-question" class="sound-input" placeholder="C:\\Windows\\Media\\Speech On.wav (기본)" />
        <input type="number" id="sound-question-gain" class="sound-gain" min="50" max="5000" step="10" value="100" title="볼륨 (%)" />
        <button class="secondary small sound-preview-btn" data-kind="question" title="미리듣기">▶</button>
        <button class="secondary small sound-pick-btn"    data-kind="question" title="파일 찾기">📁</button>
      </div>

      <div class="sound-row" data-kind="workflow">
        <label class="sound-label" data-i18n="sound.workflow">🔁 워크플로우 완료음</label>
        <input type="text" id="sound-workflow" class="sound-input" placeholder="C:\\Windows\\Media\\Ring06.wav (기본)" />
        <input type="number" id="sound-workflow-gain" class="sound-gain" min="50" max="5000" step="10" value="100" title="볼륨 (%)" />
        <button class="secondary small sound-preview-btn" data-kind="workflow" title="미리듣기">▶</button>
        <button class="secondary small sound-pick-btn"    data-kind="workflow" title="파일 찾기">📁</button>
      </div>

      <div class="field" style="margin-top:6px;">
        <label class="checkbox-label">
          <input type="checkbox" id="cb-workflowCompleteBeep" />
          <span data-i18n="sound.workflowComplete.label">워크플로우/서브에이전트가 모두 완료되면 비프로 알림</span>
        </label>
        <p class="hint" data-i18n="sound.workflowComplete.hint">멀티 에이전트 워크플로우 또는 서브에이전트(Task)가 전부 끝나면 1회 비프합니다.</p>
      </div>

      <p class="hint" style="margin-top:10px;" data-i18n="sound.questionHint">질문 대기 비프는 Claude가 AskUserQuestion 또는 ExitPlanMode 도구로 입력을 요구할 때 발사됩니다. 100% 정확.</p>

      <div class="grid-2" style="margin-top:14px;">
        <div class="field">
          <label for="cb-completionBeepSettleMs" data-i18n="sound.settleMs.label">완료/질문 비프 settle (ms)</label>
          <input type="number" id="cb-completionBeepSettleMs" min="100" max="5000" step="100" />
          <p class="hint" data-i18n="sound.settleMs.hint">end_turn 또는 질문 검출 후 이 시간만큼 대기. 그 사이 새 활동(자동 follow-up, 사용자 즉답)이 발생하면 비프 취소. 0이면 즉시 발사.</p>
        </div>
        <div class="field">
          <label for="cb-stuckToolUseThresholdSec" data-i18n="sound.stuckSec.label">tool_use 멈춤 임계값 (초)</label>
          <input type="number" id="cb-stuckToolUseThresholdSec" min="30" max="600" step="10" />
          <p class="hint" data-i18n="sound.stuckSec.hint">아래 휴리스틱이 켜져 있을 때만 적용.</p>
        </div>
      </div>

      <div class="field" style="margin-top:6px;">
        <label class="checkbox-label">
          <input type="checkbox" id="cb-detectStuckToolUse" />
          <span data-i18n="sound.detectStuck.label">VS Code 권한 팝업 추정 비프 (휴리스틱 — 오탐 위험)</span>
        </label>
        <p class="hint" data-i18n="sound.detectStuck.hint">마지막 assistant 항목이 tool_use(Bash·Edit 등)이고 N초 이상 새 활동 없을 때 질문 비프 발사. npm build 등 정상 장기 작업도 오탐 발사함. 기본 꺼짐.</p>
      </div>

      <div style="margin-top:8px;">
        <button id="sound-reset-btn" class="secondary small" data-i18n="sound.reset">기본값으로 초기화</button>
      </div>
    </div>

    <div class="status" id="status"></div>

    <div class="actions">
      <button id="test-btn" class="secondary" data-i18n="common.refresh">Refresh now</button>
      <button id="save-btn" class="primary" data-i18n="common.save">Save</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
