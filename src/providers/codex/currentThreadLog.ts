// Pure parsers for identifying the Codex conversation displayed by the current VS Code
// window. Kept free of vscode/fs imports so the recorded-log cases can be replayed with
// plain Node after compilation.

export const CODEX_CONVERSATION_SCHEME = 'openai-codex';
export const CODEX_CONVERSATION_AUTHORITY = 'route';
export const CODEX_CONVERSATION_VIEW_TYPE = 'chatgpt.conversationEditor';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW_ACTIVITY_RE = /thread_stream_view_activity_changed\b[^\r\n]*\bactive=(true|false)\b[^\r\n]*\bconversationId=([0-9a-f-]{36})\b/i;

export interface CodexLogSelection {
    conversationId: string | null;
    /** Most recently selected conversation in this VS Code window, across focus/reloads. */
    lastConversationId: string | null;
    activeConversationIds: string[];
    ambiguous: boolean;
}

/** Parse an openai-codex://route/(local|remote)/<conversation-id> editor URI. */
export function conversationIdFromCodexUri(
    scheme: string,
    authority: string,
    uriPath: string,
    viewType?: string
): string | null {
    if (viewType && viewType !== CODEX_CONVERSATION_VIEW_TYPE) return null;
    if (scheme !== CODEX_CONVERSATION_SCHEME || authority !== CODEX_CONVERSATION_AUTHORITY) return null;

    const parts = uriPath.replace(/^\/+/, '').split('/');
    if (parts.length < 2 || (parts[0] !== 'local' && parts[0] !== 'remote')) return null;
    return UUID_RE.test(parts[1]) ? parts[1].toLowerCase() : null;
}

/**
 * Reconstruct the visible Codex webview state from one window's Codex.log.
 *
 * A log can survive extension-host reloads. Only activity after the newest activation
 * marker is relevant; otherwise an unmatched active=true from the previous host would
 * resurrect a stale conversation. Multiple distinct active ids are deliberately reported
 * as ambiguous rather than guessed.
 */
export function selectionFromCodexLog(text: string): CodexLogSelection {
    const activationMarker = 'Activating Codex extension';
    const lastActivation = text.lastIndexOf(activationMarker);
    const relevant = lastActivation >= 0 ? text.slice(lastActivation) : text;

    // `active=false` is also emitted when the whole VS Code window loses focus. It does
    // not mean that the conversation disappeared from that window. Preserve the newest
    // active=true UUID across extension-host reloads as the window's last selection.
    let lastConversationId: string | null = null;
    for (const line of text.split(/\r?\n/)) {
        const match = VIEW_ACTIVITY_RE.exec(line);
        if (!match || match[1].toLowerCase() !== 'true') continue;
        const id = match[2].toLowerCase();
        if (UUID_RE.test(id)) lastConversationId = id;
    }

    const active = new Map<string, number>();
    let order = 0;
    for (const line of relevant.split(/\r?\n/)) {
        const match = VIEW_ACTIVITY_RE.exec(line);
        if (!match) continue;
        const id = match[2].toLowerCase();
        if (!UUID_RE.test(id)) continue;
        order++;
        if (match[1].toLowerCase() === 'true') active.set(id, order);
        else active.delete(id);
    }

    const ids = [...active.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
    return {
        conversationId: ids.length === 1 ? ids[0] : null,
        lastConversationId,
        activeConversationIds: ids,
        ambiguous: ids.length > 1
    };
}

/** UUIDv7 embeds its Unix-millisecond timestamp in the first 48 bits. */
export function dateFromUuidV7(id: string): Date | null {
    if (!UUID_RE.test(id) || id[14] !== '7') return null;
    const hex = id.replace(/-/g, '').slice(0, 12);
    const millis = Number.parseInt(hex, 16);
    if (!Number.isSafeInteger(millis)) return null;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
}
