import * as vscode from 'vscode';
import { Lang } from './i18n';

// Secret keys (stored encrypted via context.secrets / OS keychain).
const SECRET_SESSION_KEY = 'claudeState.sessionKey';
const SECRET_TG_TOKEN = 'claudeState.telegramBotToken';
const SECRET_TG_CHAT = 'claudeState.telegramChatId';

// globalState key for session-reset detection.
const STATE_LAST_RESET = 'claudeState.lastSessionResetAt';
// Last observed session usage %, for block-close detection (>0 → 0 transition survives sleep gaps).
const STATE_LAST_PERCENT = 'claudeState.lastSessionPercent';

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

// Shared across all VS Code windows (globalState is machine-wide), so whichever window polls first
// records the new %; the others then read it and see no fresh transition — the first line of defense
// against duplicate fires. The atomic event lock is the second.
export function getLastSessionPercent(): number | null {
    if (!ctx) return null;
    const v = ctx.globalState.get<number>(STATE_LAST_PERCENT);
    return typeof v === 'number' ? v : null;
}

export async function setLastSessionPercent(pct: number | null): Promise<void> {
    if (!ctx) return;
    await ctx.globalState.update(STATE_LAST_PERCENT, typeof pct === 'number' ? pct : undefined);
}
