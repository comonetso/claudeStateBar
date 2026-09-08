// Recover a workflow's phase structure from its script.
//
// Nothing on disk says which phase an agent belonged to. journal.jsonl carries only
// {type, key, agentId, result}; agent-<id>.meta.json carries only {agentType,
// spawnDepth, model}. The phone's remote-control view can group agents by phase
// because the running process still holds that in memory — we cannot.
//
// What IS on disk is the script itself, under workflows/scripts/<name>-<wfId>.js,
// and it declares both the phase list and (usually) each agent() call's phase. So we
// parse the script and match agents to call sites by their prompt text.
//
// Measured on 2026-09-08 across 11 scripts / 10 runs / 52 agents: every agent was
// placed, with no misassignment. That sample is all one author's scripts, so treat
// 100% as an optimistic ceiling — which is why every step below fails soft. A script
// we cannot read produces no phases, and the panel then draws exactly what it drew
// before this file existed.

/** One agent() call site, or one element of a task array feeding such a call. */
export interface ScriptUnit {
    /** Literal `label:` if the script gave one. */
    label?: string;
    /** Literal `phase:`, or the lexically preceding phase() call. */
    phase?: string;
    /** Distinctive static text from this unit's prompt, normalised. */
    fingerprints: string[];
    /** True for call sites whose prompt is a variable we could not resolve. */
    opaque: boolean;
}

export interface ParsedScript {
    name: string;
    description: string;
    phases: string[];
    units: ScriptUnit[];
}

export interface AgentPlacement {
    phase?: string;
    label?: string;
}

/** Fingerprints shorter than this collide by chance across unrelated prompts. */
const MIN_FINGERPRINT = 40;

// ── source scanning ─────────────────────────────────────────────────────────

interface StringSpan {
    /** Static text pieces (a template literal contributes one piece per gap between ${}). */
    parts: string[];
    /** Range of the whole literal, used to attribute it to an enclosing construct. */
    start: number;
    end: number;
}

interface Scan {
    /** code[i] is true when byte i is executable source, false inside a string or comment. */
    code: boolean[];
    spans: StringSpan[];
}

/**
 * Classify every byte as code or not, and collect string literals.
 *
 * The one subtlety is template interpolation: for `${`, only the `$` is marked
 * non-code and the `{` stays code, so it pairs with its closing `}`. Marking both
 * breaks brace balance — an object scan then terminates early (observed truncating
 * a 723-byte meta block to 51 bytes).
 */
function scanSource(src: string): Scan {
    const code: boolean[] = new Array(src.length).fill(true);
    const spans: StringSpan[] = [];
    let i = 0;

    const markRange = (from: number, to: number) => {
        for (let k = from; k < to && k < code.length; k++) code[k] = false;
    };

    while (i < src.length) {
        const c = src[i];

        if (c === '/' && src[i + 1] === '/') {
            const end = src.indexOf('\n', i);
            const stop = end < 0 ? src.length : end;
            markRange(i, stop);
            i = stop;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length : end + 2;
            markRange(i, stop);
            i = stop;
            continue;
        }
        if (c === '\'' || c === '"') {
            const start = i;
            let j = i + 1;
            let text = '';
            while (j < src.length) {
                if (src[j] === '\\') { text += src[j + 1] ?? ''; j += 2; continue; }
                if (src[j] === c) break;
                if (src[j] === '\n') break;   // unterminated — bail rather than run away
                text += src[j];
                j++;
            }
            markRange(start, Math.min(j + 1, src.length));
            spans.push({ parts: [text], start, end: j });
            i = j + 1;
            continue;
        }
        if (c === '`') {
            const start = i;
            let j = i + 1;
            let piece = '';
            const parts: string[] = [];
            while (j < src.length) {
                if (src[j] === '\\') {
                    const nx = src[j + 1];
                    piece += nx === 'n' ? '\n' : nx === 't' ? '\t' : (nx ?? '');
                    code[j] = false; code[j + 1] = false;
                    j += 2;
                    continue;
                }
                if (src[j] === '`') { code[j] = false; break; }
                if (src[j] === '$' && src[j + 1] === '{') {
                    parts.push(piece);
                    piece = '';
                    code[j] = false;          // only the '$' — the '{' stays code
                    j += 2;
                    // Skip the interpolation, keeping its braces balanced.
                    let depth = 1;
                    while (j < src.length && depth > 0) {
                        if (src[j] === '{') depth++;
                        else if (src[j] === '}') depth--;
                        j++;
                    }
                    continue;
                }
                piece += src[j];
                code[j] = false;
                j++;
            }
            parts.push(piece);
            code[start] = false;
            spans.push({ parts, start, end: j });
            i = j + 1;
            continue;
        }
        i++;
    }

    return { code, spans };
}

/** Index of the delimiter closing the one at `openIdx`, counting only code bytes. */
function matchBracket(src: string, code: boolean[], openIdx: number): number {
    const open = src[openIdx];
    const close = open === '{' ? '}' : open === '[' ? ']' : ')';
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (!code[i]) continue;
        if (src[i] === open) depth++;
        else if (src[i] === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function normalise(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Pull `key: 'literal'` out of a source slice, code positions only. */
function literalField(slice: string, key: string): string | undefined {
    const re = new RegExp('\\b' + key + '\\s*:\\s*([\'"`])([\\s\\S]*?)\\1');
    const m = re.exec(slice);
    if (!m) return undefined;
    const v = m[2];
    // A value carrying an interpolation is not a usable literal.
    if (v.indexOf('${') >= 0) return undefined;
    return v.trim() || undefined;
}

// ── script parsing ──────────────────────────────────────────────────────────

export function parseWorkflowScript(src: string): ParsedScript {
    const result: ParsedScript = { name: '', description: '', phases: [], units: [] };
    if (!src) return result;

    let scan: Scan;
    try {
        scan = scanSource(src);
    } catch {
        return result;
    }
    const { code } = scan;

    // ── meta block ──
    // Restricted to the meta object on purpose. The previous implementation ran
    // /title:\s*'...'/ over the whole file, which a JSON schema's `title` property or
    // a prompt containing a schema example would quietly poison.
    const metaMatch = /export\s+const\s+meta\s*=\s*\{/.exec(src);
    if (metaMatch) {
        const braceIdx = src.indexOf('{', metaMatch.index);
        const close = braceIdx >= 0 ? matchBracket(src, code, braceIdx) : -1;
        if (close > braceIdx) {
            const meta = src.slice(braceIdx, close + 1);
            result.name = literalField(meta, 'name') || '';
            result.description = literalField(meta, 'description') || '';

            const phasesIdx = meta.search(/\bphases\s*:\s*\[/);
            if (phasesIdx >= 0) {
                const bracketIdx = meta.indexOf('[', phasesIdx);
                // Re-scan the slice; positions from the outer scan do not apply here.
                const inner = scanSource(meta);
                const end = matchBracket(meta, inner.code, bracketIdx);
                if (end > bracketIdx) {
                    const arr = meta.slice(bracketIdx, end + 1);
                    for (const m of arr.matchAll(/\btitle\s*:\s*(['"`])([\s\S]*?)\1/g)) {
                        const t = m[2].trim();
                        if (t && result.phases.indexOf(t) < 0) result.phases.push(t);
                    }
                }
            }
        }
    }

    // ── phase() calls, in source order ──
    // A phase() with no meta entry still becomes its own group at runtime, so these
    // are unioned in rather than validated against meta.
    const phaseCalls: { at: number; title: string }[] = [];
    for (const m of src.matchAll(/(?:^|[^.\w])phase\s*\(\s*(['"])([\s\S]*?)\1\s*\)/g)) {
        const at = m.index ?? 0;
        if (!code[at + 1]) continue;
        const title = m[2].trim();
        if (!title) continue;
        phaseCalls.push({ at, title });
        if (result.phases.indexOf(title) < 0) result.phases.push(title);
    }

    // ── agent() call sites ──
    const callRanges: { from: number; to: number }[] = [];
    for (const m of src.matchAll(/(?:^|[^.\w])agent\s*\(/g)) {
        const at = m.index ?? 0;
        const parenIdx = src.indexOf('(', at);
        if (parenIdx < 0 || !code[parenIdx]) continue;
        const close = matchBracket(src, code, parenIdx);
        if (close < 0) continue;
        callRanges.push({ from: parenIdx, to: close });

        const argsSrc = src.slice(parenIdx + 1, close);
        const unit: ScriptUnit = { fingerprints: [], opaque: true };

        unit.label = literalField(argsSrc, 'label');
        let phase = literalField(argsSrc, 'phase');
        if (!phase) {
            // Fall back to the phase() that lexically precedes this call.
            for (const pc of phaseCalls) {
                if (pc.at < at) phase = pc.title; else break;
            }
        }
        unit.phase = phase;
        if (phase && result.phases.indexOf(phase) < 0) result.phases.push(phase);

        // Where the first argument ends — options follow the first top-level comma.
        let depth = 0;
        let firstComma = -1;
        for (let k = parenIdx + 1; k < close; k++) {
            if (!code[k]) continue;
            const ch = src[k];
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            else if (ch === ',' && depth === 0) { firstComma = k; break; }
        }
        const firstArgEnd = firstComma < 0 ? close : firstComma;

        // Prompt fingerprints, when the first argument is a literal we can see.
        for (const span of scan.spans) {
            if (span.start <= parenIdx || span.end >= firstArgEnd) continue;
            for (const part of span.parts) {
                const n = normalise(part);
                if (n.length >= MIN_FINGERPRINT) { unit.fingerprints.push(n); unit.opaque = false; }
            }
        }

        // One level of indirection: agent(synthesisPrompt, {...}) is common, and without
        // resolving it a two-phase script has two opaque call sites, which disables the
        // residual pass and leaves every agent ungrouped.
        if (unit.opaque) {
            const firstArg = src.slice(parenIdx + 1, firstArgEnd).trim();
            if (/^[A-Za-z_$][\w$]*$/.test(firstArg)) {
                const def = new RegExp('(?:const|let|var)\\s+' + firstArg + '\\s*=').exec(src);
                if (def) {
                    const from = def.index;
                    for (const span of scan.spans) {
                        if (span.start < from) continue;
                        // The literal that opens the definition, not one further down.
                        if (normalise(src.slice(from, span.start)).replace(/^[^=]*=\s*/, '')) break;
                        for (const part of span.parts) {
                            const n = normalise(part);
                            if (n.length >= MIN_FINGERPRINT) { unit.fingerprints.push(n); unit.opaque = false; }
                        }
                        break;
                    }
                }
            }
        }

        result.units.push(unit);
    }

    // ── task-array elements ──
    // The common shape is TASKS = [{label, prompt}] fed to agent(t.prompt, {...}).
    // The call site then has no visible prompt, so the element itself becomes the unit
    // that carries the fingerprints and the author's intended label.
    for (const m of src.matchAll(/\blabel\s*:\s*['"`]/g)) {
        const at = m.index ?? 0;
        if (!code[at + 1]) continue;
        if (callRanges.some(r => at > r.from && at < r.to)) continue;   // that's a call site

        // Walk back to the brace opening the object this label sits in.
        let depth = 0;
        let objStart = -1;
        for (let i = at; i >= 0; i--) {
            if (!code[i]) continue;
            if (src[i] === '}') depth++;
            else if (src[i] === '{') {
                if (depth === 0) { objStart = i; break; }
                depth--;
            }
        }
        if (objStart < 0) continue;
        const objEnd = matchBracket(src, code, objStart);
        if (objEnd < 0) continue;

        const objSrc = src.slice(objStart, objEnd + 1);
        const unit: ScriptUnit = { fingerprints: [], opaque: true };
        unit.label = literalField(objSrc, 'label');
        unit.phase = literalField(objSrc, 'phase');
        for (const span of scan.spans) {
            if (span.start <= objStart || span.end >= objEnd) continue;
            for (const part of span.parts) {
                const n = normalise(part);
                if (n.length >= MIN_FINGERPRINT) { unit.fingerprints.push(n); unit.opaque = false; }
            }
        }
        if (!unit.opaque) result.units.push(unit);
    }

    return result;
}

// ── agent placement ─────────────────────────────────────────────────────────

/**
 * Assign each agent to a phase (and, when the script named it, a label).
 *
 * Order of attack:
 *   1. One phase in the whole script → everyone belongs to it. Covered 6 of the 10
 *      runs measured, and skips all text matching.
 *   2. Fingerprint match against the script's prompt literals.
 *   3. Residual: agents that matched nothing go to the single call site whose prompt
 *      was a variable we could not read — the standard "array fan-out + one
 *      synthesis agent" shape.
 *
 * Anything still unplaced is left unplaced. Guessing a group is worse than no group.
 */
export function placeAgents(
    script: ParsedScript,
    prompts: Map<string, string>
): Map<string, AgentPlacement> {
    const out = new Map<string, AgentPlacement>();
    if (!script.phases.length && !script.units.length) return out;

    const single = script.phases.length === 1 ? script.phases[0] : undefined;

    // Fingerprints shared by two or more units are boilerplate (a common preamble) and
    // match everything, so they are dropped before scoring.
    const seen = new Map<string, number>();
    for (const u of script.units) {
        for (const f of new Set(u.fingerprints)) seen.set(f, (seen.get(f) || 0) + 1);
    }
    const distinctive = script.units.map(u => u.fingerprints.filter(f => (seen.get(f) || 0) === 1));

    const opaqueUnits = script.units
        .map((u, i) => ({ u, i }))
        .filter(x => x.u.opaque);

    const unmatched: string[] = [];

    for (const [agentId, rawPrompt] of prompts) {
        const hay = normalise(rawPrompt || '');
        let bestIdx = -1;
        let bestScore = 0;
        let tie = false;

        if (hay) {
            for (let i = 0; i < script.units.length; i++) {
                let score = 0;
                for (const f of distinctive[i]) if (hay.indexOf(f) >= 0) score++;
                if (score > bestScore) { bestScore = score; bestIdx = i; tie = false; }
                else if (score > 0 && score === bestScore) tie = true;
            }
        }

        if (bestIdx >= 0 && !tie) {
            const u = script.units[bestIdx];
            out.set(agentId, { phase: u.phase || single, label: u.label });
            // A task-array element gives us the author's label but carries no phase of
            // its own — the phase lives on the call site that consumes the array. Send
            // it through the residual pass so the group still gets filled in.
            if (!u.phase && !single) unmatched.push(agentId);
        } else if (single) {
            out.set(agentId, { phase: single });
        } else {
            unmatched.push(agentId);
        }
    }

    // Residual pass — only safe when exactly one call site could have produced them.
    if (unmatched.length && opaqueUnits.length === 1) {
        const u = opaqueUnits[0].u;
        for (const id of unmatched) {
            const prev = out.get(id) || {};
            out.set(id, { phase: prev.phase || u.phase, label: prev.label });
        }
    }

    return out;
}
