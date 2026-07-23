// Determine context limit based on model id.
// 1M-context models (use limitOpus):
//   - Opus 4.x family (claude-opus-4-5 / 4-6 / 4-7 / 4-8) — confirmed 1M context
//   - Fable / Mythos family (claude-fable-5, claude-mythos-5) — confirmed 1M context
//   - Sonnet 4.6+ / Sonnet 5+ (claude-sonnet-4-6, claude-sonnet-5, ...) — 1M by default,
//     unlike Sonnet 4.5 and earlier which need the "1m" opt-in suffix below
//   - Any model with "1m" in the id (e.g., "claude-sonnet-4-5-1m")
// All others (Sonnet 4.5 and earlier, Haiku, etc.) use limitDefault.
export function getContextLimitForModel(model: string, limitDefault: number, limitOpus: number): number {
    const m = model.toLowerCase();
    if (m.includes('1m')) return limitOpus;
    if (/opus[-_]?4/.test(m)) return limitOpus;
    if (m.includes('fable') || m.includes('mythos')) return limitOpus;
    const sonnetVer = m.match(/sonnet-(\d{1,2})(?:-(\d{1,2})(?!\d))?/);
    if (sonnetVer) {
        const major = parseInt(sonnetVer[1], 10);
        const minor = sonnetVer[2] ? parseInt(sonnetVer[2], 10) : 0;
        if (major >= 5 || (major === 4 && minor >= 6)) return limitOpus;
    }
    return limitDefault;
}
