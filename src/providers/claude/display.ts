// Claude-specific status-bar display helpers (model name + effort label).

// Shorten a model id like "claude-sonnet-4-5-20250514" → "Sonnet 4.5".
// 1M-context variants get a "1M" suffix. Unknown families fall back to the last token of the id.
//
// `compact` is accepted but does not shorten the model name. An abbreviated form ("S4.5")
// was described in the comment here for a long time but never existed in the code — the
// `abbrev` letters were assigned and then never read. Compact mode shortens project names
// (getShortName), which is what the README documents; model names stay readable in both
// modes. The parameter is kept so callers do not all have to change.
export function getShortModelName(model: string, compact: boolean): string {
    if (!model) return '';
    const lower = model.toLowerCase();
    // Placeholder ids such as "<synthetic>" are not model names. Passing one straight
    // through put a literal "<synthetic>" in the status bar, which reads as a glitch.
    if (lower.charAt(0) === '<') return '';
    let family = '';
    if (lower.includes('opus')) family = 'Opus';
    else if (lower.includes('sonnet')) family = 'Sonnet';
    else if (lower.includes('haiku')) family = 'Haiku';
    else if (lower.includes('fable')) family = 'Fable';
    else if (lower.includes('mythos')) family = 'Mythos';
    else {
        const parts = model.split('-');
        return parts[parts.length - 1] || model;
    }
    // Strip the parts of the id that are not the version before reading it:
    //   - a bracketed variant suffix — "claude-opus-5[1m]" ends in "]", so the
    //     ends-with-digits rule missed the 5 and it displayed as "Opus 1M"
    //   - a trailing release date — "claude-3-opus-20240229" displayed as "Opus 20240229"
    const base = lower.replace(/\[[^\]]*\]$/, '').replace(/-\d{6,}$/, '');
    const verMatch = base.match(/(\d+)-(\d+)(?!\d)/);
    const singleVerMatch = verMatch ? null : base.match(/[^\d](\d+)$/);
    const version = verMatch ? `${verMatch[1]}.${verMatch[2]}` : (singleVerMatch ? singleVerMatch[1] : '');
    // Judged on the original id: the "1m" marker lives in the suffix we just removed.
    const onem = lower.includes('1m') ? '1M' : '';
    const versionPart = version ? ` ${version}` : '';
    const onemPart = onem ? ` ${onem}` : '';
    return `${family}${versionPart}${onemPart}`;
}

// Convert a raw effort value to a display label. Always full names (no abbreviation).
//   low → Low, medium → Medium, high → High, max → Max, ultracode/ultra → 🚀 Ultra
// xhigh → "xHigh⁺": settings.json persists "xhigh" for BOTH plain xhigh AND ultracode
// (= xhigh + runtime dynamic workflows). The ultracode bit itself never persists to disk
// (CLI schema: "interactive toggles never persist it"), so we cannot distinguish them from
// settings.json alone — the ⁺ hints "may be ultracode" without asserting it. The tooltip
// carries the full explanation. (case 'ultracode'/'ultra' stays for a hypothetical future
// build that DOES persist the flag — harmless until then.)
export function getEffortLabel(raw: string): string {
    switch (raw.toLowerCase()) {
        case 'low': return 'Low';
        case 'medium': return 'Medium';
        case 'high': return 'High';
        case 'xhigh': return 'xHigh⁺';
        case 'max': return 'Max';
        case 'ultracode': return '🚀 Ultra';
        case 'ultra': return '🚀 Ultra';  // tolerate abbreviation/typo
        default:
            // Unknown values: prettify by capitalizing the first letter instead of raw passthrough
            return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
    }
}
