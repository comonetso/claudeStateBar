import * as vscode from 'vscode';

// "Is it alive?" status-bar item: shows the active session's phase icon + elapsed seconds,
// ticked every second so the counter keeps climbing during Claude's silent thinking (when the
// file watcher never fires). This is the whole feature — no panel, just a live counter.
//
// Provider-neutral: the caller passes a StageInput (a structural subset of SessionInfo, so any
// provider can produce it) and injects an isKorean() language resolver via initStageIndicator().

// Structural signal the orchestrator feeds in — any provider's session can satisfy this shape.
export interface StageInput {
    isFallback?: boolean;
    pendingToolUseAt: Date | null;
    pendingQuestionAt: Date | null;
    lastAssistantEndTurnAt: Date | null;
    lastActivityAt: Date | null;
}

const STAGE_STUCK_SEC = 240;
let stageStatusItem: vscode.StatusBarItem | null = null;
let stageTickInterval: NodeJS.Timeout | null = null;
let stagePhase: 'tool' | 'thinking' | null = null;
let stageBaseAt: number | null = null;
let isKorean: () => boolean = () => false;

// Inject the language resolver (kept out of this module to avoid a core→plan/i18n cycle).
export function initStageIndicator(isKoreanFn: () => boolean): void {
    isKorean = isKoreanFn;
}

function ensureStageItem() {
    if (!stageStatusItem) {
        // priority 5: right of the session items (10..6) and the plan item (8); never collides.
        stageStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 5);
    }
}

// Decide what the active session is doing right now from fields already on the session
// (zero extra disk reads). Only tool/thinking show a live counter; done/waiting/idle hide.
export function updateStageItem(active: StageInput | null) {
    ensureStageItem();
    if (!active || active.isFallback) {
        stagePhase = null; stageBaseAt = null;
    } else if (active.pendingToolUseAt) {
        stagePhase = 'tool'; stageBaseAt = active.pendingToolUseAt.getTime();
    } else if (active.pendingQuestionAt) {
        stagePhase = null; stageBaseAt = null;  // waiting for the user — not "working"
    } else if (active.lastAssistantEndTurnAt && (!active.lastActivityAt || active.lastAssistantEndTurnAt.getTime() >= active.lastActivityAt.getTime())) {
        stagePhase = null; stageBaseAt = null;  // finished a turn (text-bearing end_turn)
    } else if (active.lastActivityAt) {
        stagePhase = 'thinking'; stageBaseAt = active.lastActivityAt.getTime();
    } else {
        stagePhase = null; stageBaseAt = null;
    }
    tickStageItem();
}

// Re-render text/color from the cached marker every second WITHOUT touching disk — this is
// what keeps the counter alive through Claude's long silent thinking.
export function tickStageItem() {
    if (!stageStatusItem) return;
    if (stagePhase == null || stageBaseAt == null) { stageStatusItem.hide(); return; }
    const elapsedSec = Math.max(0, Math.round((Date.now() - stageBaseAt) / 1000));
    const icon = stagePhase === 'tool' ? '🔧' : '🤔';
    stageStatusItem.text = `${icon} ${elapsedSec}s`;
    const stuck = elapsedSec > STAGE_STUCK_SEC;
    stageStatusItem.backgroundColor = stuck ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const ko = isKorean();
    stageStatusItem.tooltip = stuck
        ? (ko ? 'Claude가 비정상적으로 오래 작업 중 — 멈춤 의심' : 'Claude has been working unusually long — possibly stuck')
        : (ko ? 'Claude 작업 중 — 마지막 활동 이후 경과 초 (멈추면 완료/대기)' : 'Claude is working — seconds since last activity (stops when done/idle)');
    stageStatusItem.show();
}

// Start the 1-second tick loop (owns the interval so lifecycle only calls start/dispose).
export function startStageTicker(): void {
    stageTickInterval = setInterval(() => { tickStageItem(); }, 1000);
}

// Tear down the ticker and the status-bar item (single cleanup path). Mirrors the original
// ce1933d cleanup EXACTLY: clear the interval and dispose the item, but do NOT null out
// stageStatusItem. Leaving the (now-disposed) reference non-null keeps ensureStageItem()'s
// `if (!stageStatusItem)` guard from re-creating a fresh item when a late async refresh
// calls updateStageItem() after dispose — a re-creation/leak path the baseline never had.
export function disposeStage(): void {
    if (stageTickInterval) {
        clearInterval(stageTickInterval);
    }
    stageStatusItem?.dispose();
}
