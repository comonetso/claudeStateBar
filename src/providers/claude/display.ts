// Claude-specific status-bar display helpers (model name + effort label).

// Shorten a model id like "claude-sonnet-4-5-20250514" → "Sonnet 4.5" (or "S4.5" in compact mode).
// 1M-context variants get a "1M" suffix. Unknown families fall back to the last token of the id.
export function getShortModelName(model: string, compact: boolean): string {
    if (!model) return '';
    const lower = model.toLowerCase();
    let family = '';
    let abbrev = '';
    if (lower.includes('opus')) { family = 'Opus'; abbrev = 'O'; }
    else if (lower.includes('sonnet')) { family = 'Sonnet'; abbrev = 'S'; }
    else if (lower.includes('haiku')) { family = 'Haiku'; abbrev = 'H'; }
    else if (lower.includes('fable')) { family = 'Fable'; abbrev = 'F'; }
    else {
        const parts = model.split('-');
        return parts[parts.length - 1] || model;
    }
    const verMatch = lower.match(/(\d+)-(\d+)/);
    const singleVerMatch = verMatch ? null : lower.match(/[^\d](\d+)$/);
    const version = verMatch ? `${verMatch[1]}.${verMatch[2]}` : (singleVerMatch ? singleVerMatch[1] : '');
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
