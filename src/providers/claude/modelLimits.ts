// Determine context limit based on model id.
// 1M-context models (use limitOpus):
//   - Opus 4+ (claude-opus-4-5 / 4-6 / 4-7 / 4-8, claude-opus-5, ...) — confirmed 1M context.
//     Matched by version like Sonnet below, NOT by a hardcoded "4": the rule used to be
//     /opus[-_]?4/, which silently dropped claude-opus-5 to the 200k default and could show
//     a session past 400% (a real opus-5 log here reached 913,411 tokens).
//   - Fable / Mythos family (claude-fable-5, claude-mythos-5) — confirmed 1M context
//   - Sonnet 4.6+ / Sonnet 5+ (claude-sonnet-4-6, claude-sonnet-5, ...) — 1M by default,
//     unlike Sonnet 4.5 and earlier which need the "1m" opt-in suffix below
//   - Any model with "1m" in the id (e.g., "claude-sonnet-4-5-1m")
// All others (Opus 3 and earlier, Sonnet 4.5 and earlier, Haiku, etc.) use limitDefault.
export function getContextLimitForModel(model: string, limitDefault: number, limitOpus: number): number {
    const m = model.toLowerCase();
    if (m.includes('1m')) return limitOpus;
    // (?!\d) stops the date in a legacy id from passing as a version: claude-3-opus-20240229
    // would otherwise read as "opus 20" and get 1M, when Opus 3 is a 200k model.
    const opusVer = m.match(/opus[-_]?(\d{1,2})(?!\d)/);
    if (opusVer && parseInt(opusVer[1], 10) >= 4) return limitOpus;
    if (m.includes('fable') || m.includes('mythos')) return limitOpus;
    // Same (?!\d) guard as Opus above: without it claude-3-sonnet-20240229 read as
    // "sonnet 20" and was handed the 1M limit, when Sonnet 3 is a 200k model.
    const sonnetVer = m.match(/sonnet[-_](\d{1,2})(?!\d)(?:[-_](\d{1,2})(?!\d))?/);
    if (sonnetVer) {
        const major = parseInt(sonnetVer[1], 10);
        const minor = sonnetVer[2] ? parseInt(sonnetVer[2], 10) : 0;
        if (major >= 5 || (major === 4 && minor >= 6)) return limitOpus;
    }
    return limitDefault;
}
