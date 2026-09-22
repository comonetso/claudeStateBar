import * as vscode from 'vscode';

// Status-bar dots for work running behind the conversation (user's call, 2026-09-22): orange while
// a workflow runs, grey while a background task does, blue while a Codex run from the progress
// panel does. A status-bar item takes a single colour, so each dot is its own item; each shows
// only while its kind runs and disappears when it ends, and all three show at once when all three
// run. They sit at the very front of this extension's items, left of the first session, where the
// user pointed. Hovering lists what is running; a click opens that kind's panel.

export type DotKind = 'workflow' | 'background' | 'codex';

export interface DotSpec {
    /** Bold first line of the tooltip. */
    title: string;
    /** One per running thing: its name, then a detail in plain text. */
    lines: { label: string; detail?: string }[];
    /** Last line of the tooltip: what a click does. */
    hint: string;
    /** Name shown in the status bar's own right-click list of items. */
    name: string;
    command: string;
}

const ORDER: DotKind[] = ['workflow', 'background', 'codex'];

// This extension's own colours (package.json `contributes.colors`), so every theme kind gets a
// shade that stands out on the status bar and a user can override each one in
// `workbench.colorCustomizations`. Background is grey (user's call, 2026-09-22: green and blue
// were hard to tell apart, and background work is background).
//
// The first version borrowed `charts.orange` and `disabledForeground`, which a Codex review the
// same day showed are not meant for the status bar. Measured against the status-bar background of
// the six default themes: `charts.orange` is a translucent find-highlight colour underneath
// (#EA5C0055) and came out 1.59:1 on Dark Modern, 1.49:1 on Light Modern and 2.83:1 on 2026 Light,
// with no value at all in high contrast; `disabledForeground` was 1.84–2.34:1 on the 2026 themes
// and Light Modern (3:1 is the usual floor for a graphic). The defaults now used (user's call,
// 2026-09-22, following VS Code's own colour tokens) all measure 5:1 or more: orange #CD861A on
// dark (what the 2026 dark theme already gives `charts.orange`), #895503 on light and
// `editorWarning.foreground` in high contrast; grey `descriptionForeground`; blue `charts.blue`,
// which already measured 5.02–8.10:1 and is only registered so it can be overridden too.
const COLOR: Record<DotKind, vscode.ThemeColor> = {
    workflow: new vscode.ThemeColor('claudeContextBar.workflowDot'),
    background: new vscode.ThemeColor('claudeContextBar.backgroundDot'),
    codex: new vscode.ThemeColor('claudeContextBar.codexDot'),
};

// Right-aligned items: a higher priority sits further left. The first session group takes 30
// (text) and 31 (its icon), so the dots land just left of it.
const PRIORITY = 32;

// The dots sit as close as VS Code allows (user's call, 2026-09-22: a gap per item left no room for
// three). VS Code drops the facing margins of an item placed relative to another with `compact`
// — the private `_priority` form compactIconBesideText in extension.ts already uses for a session's
// icon. It is not public API (a Codex check of the 1.126 declarations the same day): if VS Code
// drops the field, attach fails and the dots fall back to ordinary spacing.
//
// What VS Code's workbench CSS does with it, read the same day: an item's label normally has 3px
// margins and 5px padding on each side; a `compact-left`/`compact-right` side loses its margin and
// the padding drops to 3px. An item carries `compact-left` when something attaches to its left and
// `compact-right` when something attaches to its right, so only the anchor gets both. Attaching two
// dots to the rightmost one left 11px between the first two against 6px between the last two —
// which the user spotted. So the middle dot is the anchor, one dot attaches to each side, and every
// gap is 6px. With one attached item per side there is also no ordering question: several items
// attached to one side are ordered by registration, since their secondary priority is a hash of
// the extension id and so the same for all of them. The dots don't attach to the session's ✳ —
// that icon registered first and would stay left of them — so the gap to it stays ordinary.
interface RelativePriority { location: { id: string; priority: number }; alignment: number; compact: boolean }
let compactUnavailable = false;

/** @param side internal status-bar alignment: 0 = left of the anchor, 1 = right of it. */
function attach(item: vscode.StatusBarItem, anchorFullId: string, side: 0 | 1): boolean {
    const mutable = item as vscode.StatusBarItem & { _priority?: number | RelativePriority };
    if (!Object.prototype.hasOwnProperty.call(mutable, '_priority')) return false;
    mutable._priority = { location: { id: anchorFullId, priority: PRIORITY }, alignment: side, compact: true };
    return true;
}

const items = new Map<DotKind, vscode.StatusBarItem>();
let layout = '';

/** @param extensionId this extension's id in lower case — VS Code keys status-bar entries by it. */
export function updateActivityDots(specs: Partial<Record<DotKind, DotSpec>>, extensionId: string): void {
    const visible = ORDER.filter(kind => (specs[kind]?.lines.length ?? 0) > 0);
    const nextLayout = visible.join(',');
    if (nextLayout !== layout) {
        for (const item of items.values()) item.dispose();
        items.clear();
        layout = nextLayout;
        if (visible.length) {
            // Three dots: the middle one. Two: the left one, with the other on its right.
            const anchorIdx = Math.floor((visible.length - 1) / 2);
            const anchorKind = visible[anchorIdx];
            items.set(anchorKind, vscode.window.createStatusBarItem(`activity.${anchorKind}`, vscode.StatusBarAlignment.Right, PRIORITY));
            visible.forEach((kind, i) => {
                if (i === anchorIdx) return;
                const item = vscode.window.createStatusBarItem(`activity.${kind}`, vscode.StatusBarAlignment.Right, PRIORITY);
                if (!compactUnavailable && !attach(item, `${extensionId}.activity.${anchorKind}`, i < anchorIdx ? 0 : 1)) {
                    compactUnavailable = true;
                }
                items.set(kind, item);
            });
        }
    }
    // The anchor registers first, so the others find it when VS Code places them.
    const anchorKind = visible[Math.floor((visible.length - 1) / 2)];
    const showOrder = visible.length ? [anchorKind, ...visible.filter(k => k !== anchorKind)] : [];
    for (const kind of showOrder) {
        const spec = specs[kind]!;
        const item = items.get(kind)!;
        item.name = spec.name;
        // The codicon, not a text dot: U+25CF in the status-bar font was narrower but the user found
        // it too small (2026-09-22), so the dots keep the codicon's size and the gap it brings.
        item.text = '$(circle-filled)';
        item.color = COLOR[kind];
        item.command = spec.command;
        // appendText escapes Markdown, so a workflow or command name cannot break the tooltip.
        const md = new vscode.MarkdownString();
        md.appendMarkdown('**');
        md.appendText(spec.title);
        md.appendMarkdown('**\n\n');
        for (const line of spec.lines) {
            md.appendMarkdown('- ');
            md.appendText(line.label);
            if (line.detail) md.appendText(` · ${line.detail}`);
            md.appendMarkdown('\n');
        }
        md.appendMarkdown('\n_');
        md.appendText(spec.hint);
        md.appendMarkdown('_');
        item.tooltip = md;
        item.show();
    }
}

export function disposeActivityDots(): void {
    for (const item of items.values()) item.dispose();
    items.clear();
    layout = '';
}
