import * as vscode from 'vscode';
import * as creds from './credentials';
import { t } from './i18n';
import { log } from './core/logger';
import {
    CLEAN_ITEMS, CleanItem, readUsage, unquotablePath, buildCleanCommand, cleanScriptExists,
    formatBytes, formatUsageClock, isPluginCleanScript, isThisProjectsDir,
} from './providers/codexRescue/usageFile';

// The Codex tab's "Clean up" button (codex_rescue 1.17.3, user's call 2026-10-02): pick items,
// confirm once, then run the plugin's own cleanup command in a VS Code terminal opened at the
// project root. In a Remote-SSH window that terminal opens on the server, where the files are.
// Nothing is deleted from here — the plugin does it, and rewrites _usage.json when it is done,
// which the tab's next scan picks up.

function tr(key: string, ...args: (string | number)[]): string {
    return t(creds.getLanguage(), key, ...args);
}

interface ItemPick extends vscode.QuickPickItem {
    key: CleanItem;
}

/** `claudeBase` is the window host's `~/.claude` (getClaudeBaseUri) — only a script under it is run. */
export async function runCodexCleanNow(folder: vscode.WorkspaceFolder, claudeBase: vscode.Uri | null): Promise<void> {
    // Read afresh rather than trusting the line on screen: it can be a scan old, and the plugin
    // may have been updated (and moved) since.
    const read = await readUsage(folder.uri);
    if (read.state !== 'ok') {
        void vscode.window.showInformationMessage(tr('cx.clean.noUsage'));
        return;
    }
    const u = read.usage;

    // Every refusal comes before the picker, so nobody chooses items only to be told no.
    const bad = unquotablePath(u.clean);
    if (bad !== undefined) {
        void vscode.window.showWarningMessage(tr('cx.clean.badPath', bad));
        return;
    }
    if (!isPluginCleanScript(folder.uri, u.clean.script, claudeBase)) {
        log(`[codex-rescue] cleanup script refused (not under ~/.claude): ${u.clean.script}`);
        void vscode.window.showWarningMessage(tr('cx.clean.notPluginScript', u.clean.script));
        return;
    }
    if (!isThisProjectsDir(folder.uri, u.clean.dir)) {
        log(`[codex-rescue] cleanup refused: usage file names ${u.clean.dir}, window is ${folder.uri.toString()}`);
        void vscode.window.showWarningMessage(tr('cx.clean.dirMismatch', u.clean.dir));
        return;
    }
    if (!await cleanScriptExists(folder.uri, u.clean.script)) {
        log(`[codex-rescue] cleanup script missing: ${u.clean.script}`);
        void vscode.window.showWarningMessage(tr('cx.clean.noScript', u.clean.script));
        return;
    }

    const at = formatUsageClock(u.computedAt);
    // Nothing starts ticked (user's call): every item here deletes for good.
    const picks: ItemPick[] = CLEAN_ITEMS.map(key => ({
        key,
        label: tr('cx.usage.' + key),
        description: formatBytes(u.items[key].bytes) + ' · ' + tr('cx.clean.count.' + key, u.items[key].count),
        detail: tr('cx.clean.detail.' + key),
        picked: false,
    }));
    const chosen = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        title: tr('cx.clean.pickTitle', folder.name),
        placeHolder: tr('cx.clean.pickHolder', at),
    });
    if (!chosen || !chosen.length) return;
    const keys = CLEAN_ITEMS.filter(k => chosen.some(c => c.key === k));

    const cmd = buildCleanCommand(u.clean, keys, creds.getLanguage());
    if (!cmd) return;
    if (!cmd.ok) {
        void vscode.window.showWarningMessage(tr('cx.clean.badPath', cmd.badPath));
        return;
    }

    // The question says which project, what goes and roughly how much, before the button.
    const sum = keys.reduce((a, k) => a + u.items[k].bytes, 0);
    const list = keys.map(k => tr('cx.usage.' + k) + ' ' + formatBytes(u.items[k].bytes)).join(', ');
    const lines = [
        tr('cx.clean.confirm', folder.name),
        tr('cx.clean.confirmItems', list, formatBytes(sum), at),
        tr('cx.clean.irreversible'),
    ];
    if (keys.includes('codex')) lines.push(tr('cx.clean.noFollowup'));
    lines.push(tr('cx.clean.keepLive'), tr('cx.clean.viaTerminal'));
    const go = tr('cx.clean.go');
    const answer = await vscode.window.showWarningMessage(lines.join('\n\n'), { modal: true }, go);
    if (answer !== go) return;

    const term = vscode.window.createTerminal({ name: tr('cx.clean.terminal'), cwd: folder.uri });
    term.show();
    term.sendText(cmd.text, true);
    log(`[codex-rescue] cleanup sent to a terminal (${keys.join(',')}) in ${folder.uri.toString()}`);
}
