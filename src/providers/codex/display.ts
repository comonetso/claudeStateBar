// Codex-specific status-bar display helpers (model name + effort label).
//
// Kept separate from the Claude helpers on purpose: the two providers share a status bar
// but not a vocabulary. Notably `xhigh` means different things — for Claude it is the
// ambiguous ultracode marker rendered "xHigh⁺", for Codex it is a plain effort tier.

/**
 * Make a Codex model id readable without shortening or renaming it.
 *
 * `gpt-5.6-sol` becomes `gpt 5.6 sol`: only separators are changed. Codex model names
 * are intentionally unaffected by compactMode, and unknown ids use the same rule.
 */
export function getCodexModelName(model: string): string {
    if (!model) return '';
    return model.trim().replace(/[-_]+/g, ' ');
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
