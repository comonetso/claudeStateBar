// @ts-nocheck
(function () {
    const vscode = acquireVsCodeApi();
    let dict = {};
    let hasCookie = false;

    // Accept 'en' | 'ko' | 'zh'; collapse anything else to 'en'.
    function normalizeLang(v) {
        return v === 'ko' ? 'ko' : v === 'zh' ? 'zh' : 'en';
    }

    function t(key, ...args) {
        let v = dict[key];
        if (v == null) return key;
        if (typeof v === 'string' && args.length) {
            v = v.replace(/\{(\d+)\}/g, (_, i) => {
                const val = args[Number(i)];
                return val == null ? '' : String(val);
            });
        }
        return v;
    }

    function applyI18n() {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            const v = dict[el.getAttribute('data-i18n')];
            if (typeof v === 'string') el.textContent = v;
        });
        document.querySelectorAll('[data-i18n-html]').forEach((el) => {
            const v = dict[el.getAttribute('data-i18n-html')];
            if (typeof v === 'string') el.innerHTML = v;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            const v = dict[el.getAttribute('data-i18n-placeholder')];
            if (typeof v === 'string') el.setAttribute('placeholder', v);
        });
    }

    const $ = (id) => document.getElementById(id);

    function setStatus(msg, type) {
        const el = $('status');
        el.textContent = msg;
        el.className = `status ${type || ''}`;
    }

    function setTelegramLinkedState(chatId, name) {
        const el = $('telegram-status');
        if (chatId) {
            el.textContent = t('tg.linked', name || chatId);
            el.className = 'telegram-status linked';
            $('telegram-test-btn').disabled = false;
        } else {
            el.textContent = t('tg.notLinked');
            el.className = 'telegram-status';
            $('telegram-test-btn').disabled = true;
        }
    }

    function fillForm(state) {
        hasCookie = !!state.hasCookie;
        // claudeState
        $('orgId').value = state.orgId || '';
        $('refreshInterval').value = state.refreshIntervalSec || 300;
        $('language').value = normalizeLang(state.language);
        if (hasCookie) $('sessionCookie').placeholder = t('state.cookie.saved');
        // telegram
        $('telegramToken').value = state.telegramToken || '';
        setTelegramLinkedState(state.telegramChatId || null, state.telegramChatId || null);
        // claudeContextBar
        const cb = state.cb || {};
        $('cb-autoColor').checked = cb.autoColor !== false;
        $('cb-baseColor').value = cb.baseColor || 'White';
        $('cb-contextLimitDefault').value = cb.contextLimitDefault ?? 200000;
        $('cb-contextLimitOpus').value = cb.contextLimitOpus ?? 1000000;
        $('cb-warningThreshold').value = cb.warningThreshold ?? 50;
        $('cb-dangerThreshold').value = cb.dangerThreshold ?? 75;
        $('cb-refreshInterval').value = cb.refreshInterval ?? 30;
        $('cb-idleTimeout').value = cb.idleTimeout ?? 180;
        $('cb-hideAfter').value = cb.hideAfter ?? 86400;
        $('cb-scope').value = cb.scope || 'workspace';
        $('cb-showModel').checked = cb.showModel !== false;
        $('cb-compactMode').checked = !!cb.compactMode;
        $('sound-warning').value = cb.soundWarning || '';
        $('sound-danger').value = cb.soundDanger || '';
        $('sound-completion').value = cb.soundCompletion || '';
        $('sound-question').value = cb.soundQuestion || '';
        $('sound-workflow').value = cb.soundWorkflow || '';
        $('sound-warning-gain').value = cb.soundWarningGain ?? 100;
        $('sound-danger-gain').value = cb.soundDangerGain ?? 100;
        $('sound-completion-gain').value = cb.soundCompletionGain ?? 100;
        $('sound-question-gain').value = cb.soundQuestionGain ?? 100;
        $('sound-workflow-gain').value = cb.soundWorkflowGain ?? 100;
        $('cb-workflowCompleteBeep').checked = cb.workflowCompleteBeep !== false;
        $('cb-completionBeepSettleMs').value = cb.completionBeepSettleMs ?? 3000;
        $('cb-detectStuckToolUse').checked = !!cb.detectStuckToolUse;
        $('cb-stuckToolUseThresholdSec').value = cb.stuckToolUseThresholdSec ?? 90;
    }

    // --- Outgoing actions ---

    $('language').addEventListener('change', () => {
        const lang = normalizeLang($('language').value);
        vscode.postMessage({ type: 'setLanguage', lang });
    });

    $('save-btn').addEventListener('click', () => {
        const orgId = $('orgId').value.trim();
        const cookie = $('sessionCookie').value.trim();
        const intervalSec = parseInt($('refreshInterval').value, 10);

        // Credentials are optional to save (empty just shows a setup warning in the status
        // bar); only the interval is strictly validated.
        if (!Number.isFinite(intervalSec) || intervalSec < 10 || intervalSec > 3600) {
            setStatus(t('state.err.badInterval'), 'err'); return;
        }

        const payload = {
            orgId,
            sessionCookie: cookie || undefined, // undefined = keep existing
            refreshIntervalSec: intervalSec,
            cb: {
                autoColor: $('cb-autoColor').checked,
                baseColor: $('cb-baseColor').value,
                contextLimitDefault: parseInt($('cb-contextLimitDefault').value, 10) || 200000,
                contextLimitOpus: parseInt($('cb-contextLimitOpus').value, 10) || 1000000,
                warningThreshold: parseInt($('cb-warningThreshold').value, 10) || 50,
                dangerThreshold: parseInt($('cb-dangerThreshold').value, 10) || 75,
                refreshInterval: parseInt($('cb-refreshInterval').value, 10) || 30,
                idleTimeout: parseInt($('cb-idleTimeout').value, 10) || 180,
                hideAfter: parseInt($('cb-hideAfter').value, 10) || 86400,
                scope: $('cb-scope').value,
                showModel: $('cb-showModel').checked,
                compactMode: $('cb-compactMode').checked,
                soundWarning: $('sound-warning').value.trim(),
                soundDanger: $('sound-danger').value.trim(),
                soundCompletion: $('sound-completion').value.trim(),
                soundQuestion: $('sound-question').value.trim(),
                soundWorkflow: $('sound-workflow').value.trim(),
                soundWarningGain: parseInt($('sound-warning-gain').value, 10) || 100,
                soundDangerGain: parseInt($('sound-danger-gain').value, 10) || 100,
                soundCompletionGain: parseInt($('sound-completion-gain').value, 10) || 100,
                soundQuestionGain: parseInt($('sound-question-gain').value, 10) || 100,
                soundWorkflowGain: parseInt($('sound-workflow-gain').value, 10) || 100,
                workflowCompleteBeep: $('cb-workflowCompleteBeep').checked,
                completionBeepSettleMs: parseInt($('cb-completionBeepSettleMs').value, 10) || 1000,
                detectStuckToolUse: $('cb-detectStuckToolUse').checked,
                stuckToolUseThresholdSec: parseInt($('cb-stuckToolUseThresholdSec').value, 10) || 90
            }
        };
        vscode.postMessage({ type: 'save', payload });
        setStatus(t('state.msg.saving'), 'ok');
    });

    $('test-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
        setStatus(t('state.msg.refreshRequested'), 'ok');
    });

    $('telegram-link-btn').addEventListener('click', () => {
        const token = $('telegramToken').value.trim();
        if (!token) { setStatus(t('tg.invalidToken'), 'err'); return; }
        $('telegram-link-btn').disabled = true;
        setStatus(t('tg.linking'), '');
        vscode.postMessage({ type: 'telegramLink', token });
    });

    $('telegram-test-btn').addEventListener('click', () => {
        $('telegram-test-btn').disabled = true;
        vscode.postMessage({ type: 'telegramTest' });
    });

    function inputIdFor(kind) {
        if (kind === 'warning') return 'sound-warning';
        if (kind === 'danger') return 'sound-danger';
        if (kind === 'completion') return 'sound-completion';
        if (kind === 'workflow') return 'sound-workflow';
        return 'sound-question';
    }
    function gainIdFor(kind) {
        return inputIdFor(kind) + '-gain';
    }

    // Preview: play the currently typed path (or default if empty), with the
    // currently typed gain (so the user can A/B the volume before saving)
    document.querySelectorAll('.sound-preview-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = btn.getAttribute('data-kind');
            const customPath = ($(inputIdFor(kind)).value || '').trim();
            const gainPercent = parseInt($(gainIdFor(kind)).value, 10) || 100;
            setStatus(`미리듣기: ${kind} (${customPath || '기본음'}) @ ${gainPercent}%`, 'ok');
            vscode.postMessage({ type: 'testBeep', beepType: kind, customPath, gainPercent });
        });
    });

    // File picker → settingsPanel sends back 'soundFilePicked' with the chosen path
    document.querySelectorAll('.sound-pick-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = btn.getAttribute('data-kind');
            vscode.postMessage({ type: 'pickSoundFile', kind });
        });
    });

    // Reset all four sound paths AND gains to defaults (= empty path, 100% gain)
    const resetBtn = $('sound-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        ['warning', 'danger', 'completion', 'question', 'workflow'].forEach((k) => {
            $(inputIdFor(k)).value = '';
            $(gainIdFor(k)).value = 100;
        });
        setStatus('기본값으로 초기화됨 (저장 버튼을 눌러 적용)', 'ok');
    });

    // --- Incoming messages ---

    window.addEventListener('message', (event) => {
        const m = event.data;
        switch (m.type) {
            case 'init':
                dict = m.dict || {};
                document.documentElement.lang = m.lang;
                applyI18n();
                fillForm(m.state);
                break;
            case 'i18n':
                dict = m.dict || {};
                document.documentElement.lang = m.lang;
                applyI18n();
                if (hasCookie) $('sessionCookie').placeholder = t('state.cookie.saved');
                break;
            case 'status':
                setStatus(m.text, m.kind);
                break;
            case 'telegramLinkResult':
                $('telegram-link-btn').disabled = false;
                if (m.ok) {
                    setTelegramLinkedState(m.chatId, m.name);
                    setStatus(t('tg.linked', m.name || m.chatId), 'ok');
                } else {
                    setStatus(m.error === 'invalid_token' ? t('tg.invalidToken') : t('tg.linkFail'), 'err');
                }
                break;
            case 'telegramTestResult':
                $('telegram-test-btn').disabled = false;
                setStatus(m.ok ? t('tg.testSent') : t('tg.testFail'), m.ok ? 'ok' : 'err');
                break;
            case 'cookieSaved':
                hasCookie = true;
                $('sessionCookie').value = '';
                $('sessionCookie').placeholder = t('state.cookie.saved');
                break;
            case 'soundFilePicked':
                if (m.path) {
                    $(inputIdFor(m.kind)).value = m.path;
                    setStatus(`경로 설정됨: ${m.path} (저장 버튼을 눌러 적용)`, 'ok');
                }
                break;
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
