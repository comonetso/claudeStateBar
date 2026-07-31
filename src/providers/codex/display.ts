// Codex-specific status-bar display helpers (model name + effort label).
//
// Kept separate from the Claude helpers on purpose: the two providers share a status bar
// but not a vocabulary. Notably `xhigh` means different things — for Claude it is the
// ambiguous ultracode marker rendered "xHigh⁺", for Codex it is a plain effort tier.

/**
 * Shorten a Codex model id for the status bar.
 *   gpt-5.6-sol   → "GPT-5.6 Sol"  (compact: "G5.6s")
 *   gpt-5.5       → "GPT-5.5"      (compact: "G5.5")
 *   codex-auto-review → "Auto Review" (compact: "AutoRev")
 * Unknown ids fall back to the raw value so a new model never renders as blank.
 */
export function getShortCodexModelName(model: string, compact: boolean): string {
    if (!model) return '';
    const lower = model.toLowerCase();

    // Internal review model Codex runs on its own — not a user-selected tier.
    if (lower.includes('auto-review')) return compact ? 'AutoRev' : 'Auto Review';

    const m = lower.match(/gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?/);
    if (m) {
        const version = m[1];
        const variant = m[2] ?? '';
        if (compact) {
            return `G${version}${variant ? variant.charAt(0) : ''}`;
        }
        const variantPart = variant ? ` ${variant.charAt(0).toUpperCase()}${variant.slice(1)}` : '';
        return `GPT-${version}${variantPart}`;
    }

    return model;
}

/**
 * Convert a raw Codex effort value to a display label.
 * Observed on disk: low, medium, high, xhigh. The Codex automation schema also documents
 * none, minimal, max and ultra, so all eight are handled.
 */
export function getCodexEffortLabel(raw: string): string {
    switch ((raw || '').toLowerCase()) {
        case 'none': return 'None';
        case 'minimal': return 'Minimal';
        case 'low': return 'Low';
        case 'medium': return 'Medium';
        case 'high': return 'High';
        // Plain tier for Codex — no ultracode ambiguity to flag, so no "⁺".
        case 'xhigh': return 'xHigh';
        case 'max': return 'Max';
        case 'ultra': return 'Ultra';
        default:
            return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
    }
}

/**
 * Human label for who started the session. Codex records `originator`; when Claude Code
 * spawns a Codex session (the codex_rescue flow) it shows up as "Claude Code", which is
 * worth surfacing in the tooltip so two same-project entries are tellable apart.
 */
export function getOriginatorLabel(originator: string): string {
    switch ((originator || '').toLowerCase()) {
        case 'codex_vscode': return 'VS Code';
        case 'codex_work_desktop': return 'Desktop';
        case 'codex_cli': return 'CLI';
        case 'claude code': return 'Claude Code';
        default: return originator || 'Unknown';
    }
}
