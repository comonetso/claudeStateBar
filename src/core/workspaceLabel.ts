import * as vscode from 'vscode';
import { getShortName } from './displayName';

/**
 * Which project a panel is showing, since its contents come from the open workspace folders.
 * Every window's tab reads the same caption otherwise, so with two windows open there is no way
 * to tell which project's panel is in front. Abbreviated with the same rule (and the same
 * `shortNames` overrides) the status bar uses, so one project reads the same in both places.
 *
 * Lived in codexRescuePanel.ts until the activity panel needed it too (2026-09-30); importing it
 * from there would have tied the panel shell and a tab module into an import cycle.
 */
export function workspaceLabel(): { short: string; full: string } | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const shortNames = vscode.workspace.getConfiguration('claudeContextBar')
        .get<Record<string, string>>('shortNames', {});
    // A remote folder's fsPath comes back with Windows separators and is meaningless, but the
    // raw URI is no better: VS Code encodes an SSH target as `ssh-remote+<hex>`, where the hex
    // is `{"hostName":"..."}` — 68 characters of gibberish on screen. Decode it back to the
    // host alias, which is what the user actually calls that machine.
    const locate = (f: vscode.WorkspaceFolder): string => {
        if (f.uri.scheme === 'file') return f.uri.fsPath;
        const auth = f.uri.authority;
        const plus = auth.indexOf('+');
        let host = plus >= 0 ? auth.slice(plus + 1) : auth;
        if (/^(?:[0-9a-f]{2})+$/i.test(host)) {
            try {
                const decoded = JSON.parse(Buffer.from(host, 'hex').toString('utf8'));
                if (typeof decoded?.hostName === 'string') host = decoded.hostName;
            } catch { /* not the JSON form — fall through with the authority as-is */ }
        }
        return host ? `${host}: ${f.uri.path}` : f.uri.path;
    };
    return {
        short: folders.map(f => getShortName(f.name, shortNames)).join(' + '),
        full: folders.map(locate).join('\n'),
    };
}
