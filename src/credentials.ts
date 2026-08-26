import * as vscode from 'vscode';
import { Lang } from './i18n';

// Secret keys (stored encrypted via context.secrets / OS keychain).
const SECRET_SESSION_KEY = 'claudeState.sessionKey';
const SECRET_TG_TOKEN = 'claudeState.telegramBotToken';
const SECRET_TG_CHAT = 'claudeState.telegramChatId';

// globalState key for session-reset detection.
const STATE_LAST_RESET = 'claudeState.lastSessionResetAt';
// Codex primary (5-hour) window state. Codex never reports a closed window as null the way
// claude.ai does — instead a CLOSED window reports resetsAt as "now + 300 min" on every poll
// (so the value keeps moving), while an OPEN one reports a fixed timestamp. Both measured.
// So the close signal is "the value stopped standing still", which needs the previous reading
// plus whether the window had been confirmed open. Usage % is not involved: an open window
// that simply isn't being used also reads 0%, which is what produced a false reset alert.
const STATE_LAST_CODEX_RESETS_AT = 'claudeState.lastCodexResetsAt';
const STATE_CODEX_WINDOW_OPEN = 'claudeState.codexWindowWasOpen';
// The reading's own timestamp. fetchSharedCodexRateLimits() serves a cached snapshot whenever the
// cache is younger than its TTL, and both TTL and poll interval are 60s — so timer jitter or a
// second VS Code window makes the same snapshot come back twice. Without this the repeated value
// reads as "resetsAt held still", i.e. a running timer, and a real close is missed entirely.
const STATE_LAST_CODEX_OBSERVED_AT = 'claudeState.lastCodexObservedAt';
// Whether the Claude 5-hour timer was last seen STOPPED. Replaces the old percent-only tracking:
// usage sitting at 0% cannot tell a stopped timer from a running one nobody is using, and that
// ambiguity fired a false reset alert on 2026-08-26.
const STATE_CLAUDE_TIMER_STOPPED = 'claudeState.claudeTimerStopped';

let ctx: vscode.ExtensionContext | null = null;

export function initCredentials(context: vscode.ExtensionContext) {
    ctx = context;
}

function cfg() {
    return vscode.workspace.getConfiguration('claudeState');
}

// --- Non-sensitive settings (settings.json) ---

export function getOrgId(): string {
    return (cfg().get<string>('orgId', '') || '').trim();
}

export async function setOrgId(orgId: string): Promise<void> {
    await cfg().update('orgId', orgId.trim(), vscode.ConfigurationTarget.Global);
}

export function getRefreshIntervalSec(): number {
    const v = cfg().get<number>('refreshIntervalSec', 300);
    if (typeof v === 'number' && v >= 10 && v <= 3600) return v;
    return 300;
}

export async function setRefreshIntervalSec(sec: number): Promise<void> {
    const n = Math.max(10, Math.min(3600, Math.round(sec)));
    await cfg().update('refreshIntervalSec', n, vscode.ConfigurationTarget.Global);
}

export function getAutoStartBlockOnReset(): boolean {
    return cfg().get<boolean>('autoStartBlockOnReset', false) === true;
}

export async function setAutoStartBlockOnReset(on: boolean): Promise<void> {
    await cfg().update('autoStartBlockOnReset', on, vscode.ConfigurationTarget.Global);
}

// Whether to send the Telegram alert when the 5-hour block resets. Default true, matching the prior
// behavior (an alert was always sent whenever a bot token + chat were configured).
export function getTelegramNotifyOnReset(): boolean {
    return cfg().get<boolean>('telegramNotifyOnReset', true) !== false;
}

export async function setTelegramNotifyOnReset(on: boolean): Promise<void> {
    await cfg().update('telegramNotifyOnReset', on, vscode.ConfigurationTarget.Global);
}

// Codex counterparts. Kept as separate keys rather than reusing the Claude ones so that
// running only one of the two CLIs does not force the other's alerts on you.
export function getCodexAutoStartBlockOnReset(): boolean {
    return cfg().get<boolean>('codexAutoStartBlockOnReset', false) === true;
}

export async function setCodexAutoStartBlockOnReset(on: boolean): Promise<void> {
    await cfg().update('codexAutoStartBlockOnReset', on, vscode.ConfigurationTarget.Global);
}

export function getCodexTelegramNotifyOnReset(): boolean {
    return cfg().get<boolean>('codexTelegramNotifyOnReset', true) !== false;
}

export async function setCodexTelegramNotifyOnReset(on: boolean): Promise<void> {
    await cfg().update('codexTelegramNotifyOnReset', on, vscode.ConfigurationTarget.Global);
}

export function getLanguage(): Lang {
    const v = cfg().get<string>('language', 'en');
    return v === 'ko' ? 'ko' : 'en';
}

export async function setLanguage(lang: Lang): Promise<void> {
    await cfg().update('language', lang === 'ko' ? 'ko' : 'en', vscode.ConfigurationTarget.Global);
}

// --- Sensitive secrets (context.secrets) ---

export async function getSessionKey(): Promise<string> {
    if (!ctx) return '';
    return (await ctx.secrets.get(SECRET_SESSION_KEY)) || '';
}

export async function setSessionKey(key: string): Promise<void> {
    if (!ctx) return;
    const trimmed = (key || '').trim();
    if (trimmed) {
        await ctx.secrets.store(SECRET_SESSION_KEY, trimmed);
    } else {
        await ctx.secrets.delete(SECRET_SESSION_KEY);
    }
}

export async function hasSessionKey(): Promise<boolean> {
    return (await getSessionKey()).length > 0;
}

export async function getTelegramToken(): Promise<string> {
    if (!ctx) return '';
    return (await ctx.secrets.get(SECRET_TG_TOKEN)) || '';
}

export async function setTelegramToken(token: string): Promise<void> {
    if (!ctx) return;
    const trimmed = (token || '').trim();
    if (trimmed) {
        await ctx.secrets.store(SECRET_TG_TOKEN, trimmed);
    } else {
        await ctx.secrets.delete(SECRET_TG_TOKEN);
    }
}

export async function getTelegramChatId(): Promise<string> {
    if (!ctx) return '';
    return (await ctx.secrets.get(SECRET_TG_CHAT)) || '';
}

export async function setTelegramChatId(chatId: string): Promise<void> {
    if (!ctx) return;
    const trimmed = (chatId || '').trim();
    if (trimmed) {
        await ctx.secrets.store(SECRET_TG_CHAT, trimmed);
    } else {
        await ctx.secrets.delete(SECRET_TG_CHAT);
    }
}

// --- Session-reset tracking (globalState) ---

export function getLastSessionResetAt(): string | null {
    if (!ctx) return null;
    const v = ctx.globalState.get<string>(STATE_LAST_RESET);
    return typeof v === 'string' && v ? v : null;
}

export async function setLastSessionResetAt(iso: string | null): Promise<void> {
    if (!ctx) return;
    await ctx.globalState.update(STATE_LAST_RESET, iso || undefined);
}

export function getLastCodexResetsAt(): number | null {
    if (!ctx) return null;
    const v = ctx.globalState.get<number>(STATE_LAST_CODEX_RESETS_AT);
    return typeof v === 'number' ? v : null;
}

export async function setLastCodexResetsAt(ms: number | null): Promise<void> {
    if (!ctx) return;
    await ctx.globalState.update(STATE_LAST_CODEX_RESETS_AT, typeof ms === 'number' ? ms : undefined);
}

export function getClaudeTimerStopped(): boolean {
    if (!ctx) return false;
    return ctx.globalState.get<boolean>(STATE_CLAUDE_TIMER_STOPPED) === true;
}

export async function setClaudeTimerStopped(stopped: boolean): Promise<void> {
    if (!ctx) return;
    await ctx.globalState.update(STATE_CLAUDE_TIMER_STOPPED, stopped === true);
}

export function getLastCodexObservedAt(): number | null {
    if (!ctx) return null;
    const v = ctx.globalState.get<number>(STATE_LAST_CODEX_OBSERVED_AT);
    return typeof v === 'number' ? v : null;
}

export async function setLastCodexObservedAt(ms: number | null): Promise<void> {
    if (!ctx) return;
    await ctx.globalState.update(STATE_LAST_CODEX_OBSERVED_AT, typeof ms === 'number' ? ms : undefined);
}

export function getCodexWindowWasOpen(): boolean {
    if (!ctx) return false;
    return ctx.globalState.get<boolean>(STATE_CODEX_WINDOW_OPEN) === true;
}

export async function setCodexWindowWasOpen(open: boolean): Promise<void> {
    if (!ctx) return;
    await ctx.globalState.update(STATE_CODEX_WINDOW_OPEN, open === true);
}
