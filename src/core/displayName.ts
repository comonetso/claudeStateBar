// Provider-neutral compact display-name helpers for the status bar.

// Extract the last syllable from a word for compact naming
// "typescript" → "script", "webpack" → "pack", "frontend" → "tend"
export function extractLastSyllable(word: string): string {
    // Find a consonant cluster followed by vowel(s) followed by optional consonants at the end
    // This captures common syllable patterns like "tron", "script", "pack"
    const match = word.match(/[bcdfghjklmnpqrstvwxz]+[aeiou]+[bcdfghjklmnpqrstvwxz]*$/i);
    if (match) {
        return match[0];
    }
    // Fallback: just return last 3-4 chars
    return word.slice(-Math.min(4, word.length));
}

// Generate a short name for a project
// Multi-word: "my-cool-project" → "MCP" (acronym)
// Single-word: "typescript" → "Tscript" (first letter + last syllable)
// Short names (≤3 chars) are kept as-is
// Session numbers (-2, -3) are preserved
export function getShortName(projectName: string, customNames: Record<string, string>): string {
    // Check custom override first (check both full name and base name)
    if (customNames[projectName]) {
        return customNames[projectName];
    }

    // Extract session number suffix if present (e.g., "my-project-2" → "-2")
    const sessionMatch = projectName.match(/-(\d+)$/);
    const sessionSuffix = sessionMatch ? sessionMatch[0] : '';
    const baseName = sessionMatch ? projectName.slice(0, -sessionSuffix.length) : projectName;

    // Check custom override for base name too
    if (customNames[baseName]) {
        return customNames[baseName] + sessionSuffix;
    }

    // If base name is already short (5 chars or less), don't shorten
    if (baseName.length <= 5) {
        return projectName;
    }

    // Split on common delimiters (dash, underscore, space) or camelCase boundaries
    const words = baseName.split(/[-_\s]|(?=[A-Z])/).filter(w => w.length > 0);

    let shortBase: string;
    if (words.length > 1) {
        // Multi-word: create acronym from first letter of each word
        shortBase = words.map(w => w[0]?.toUpperCase() || '').join('');
    } else {
        // Single-word: first letter uppercase + last syllable
        const lastSyllable = extractLastSyllable(baseName);
        shortBase = baseName[0].toUpperCase() + lastSyllable;
    }

    return shortBase + sessionSuffix;
}
