// Provider-neutral text formatting for workflow / Task-agent result display.

export function serializeResultObject(obj: Record<string, any>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
        if (v == null) continue;
        let val: string;
        if (typeof v === 'string') val = v;
        else if (typeof v === 'number' || typeof v === 'boolean') val = String(v);
        else val = JSON.stringify(v);
        parts.push(`${k}: ${val}`);
    }
    return parts.join('\n');
}

// Turn an agent's journal `result` (a string for plain agents, an object for
// schema-validated ones) into both a 160-char preview and the untruncated full text.
//   full    — complete report (newlines preserved) for the expandable panel <details>
//   preview — single-line, whitespace-collapsed, 160-char cap (legacy display)
export function summarizeResultFull(result: any): { preview: string; full: string } {
    if (result == null) return { preview: '', full: '' };
    let full: string;
    if (typeof result === 'string') {
        full = result;
    } else {
        // Structured output — prefer a human-ish field if present, else a readable
        // key: value serialization (NOT a raw JSON.stringify blob).
        const obj = result as Record<string, any>;
        const pick = obj.summary ?? obj.title ?? obj.description ?? obj.reason
            ?? obj.verdict ?? obj.recommendation ?? obj.rootCause ?? obj.evidence;
        full = typeof pick === 'string' ? pick : serializeResultObject(obj);
        if (!full) full = JSON.stringify(result);
    }
    full = full.trim();
    const oneLine = full.replace(/\s+/g, ' ').trim();
    const preview = oneLine.length > 160 ? oneLine.slice(0, 160) + '…' : oneLine;
    return { preview, full };
}
