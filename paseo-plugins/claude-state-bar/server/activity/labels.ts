// 복사본: VS Code 확장 src/extension.ts 의 unwrapHarnessPrompt · firstPromptOf · deriveAgentRoleLabels · agentWasInterrupted · agentTimingOf (2026-10-05). 플러그인은 확장과 별개로 둔다(리규형님 원칙).
// 확장 쪽을 고치면 여기도 같이 고쳐야 한다.

export function unwrapHarnessPrompt(text: string): string | null {
    const m = /^\[Workflow harness\s*\S\s*([^\]]+)\]/.exec(text);
    if (!m) return text;
    if (m[1] === 'user request') return null;
    if (m[1] !== 'computed task') return text;
    const marker = 'The computed task text follows:';
    const at = text.indexOf(marker);
    const body = at >= 0 ? text.slice(at + marker.length) : text.slice(text.indexOf('\n') + 1);
    return body.replace(/^ {2}/gm, '').replace(/^\n+/, '');
}

export function firstPromptOf(content: string): string {
    try {
        for (const line of content.trim().split('\n')) {
            if (!line.trim()) continue;
            let e: any;
            try { e = JSON.parse(line); } catch { continue; }
            if (e.type !== 'user' || !e.message) continue;
            const c = e.message.content;
            let text = '';
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) {
                for (const b of c) {
                    if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
                }
            }
            if (!text.trim()) continue;
            const task = unwrapHarnessPrompt(text);
            if (task !== null && task.trim()) return task;
        }
    } catch { /* malformed log */ }
    return '';
}

export function deriveAgentRoleLabels(prompts: Map<string, string>): Map<string, { label: string; full: string }> {
    // Returns both the 50-char display label and the untruncated full text. The panel shows
    // `label` and uses `full` as a hover tooltip so a clipped role/task is still fully readable.
    const clean = (raw: string): { label: string; full: string } => {
        const s = raw.replace(/[★⚠️]/g, '').trim();
        return { label: s.length > 50 ? s.slice(0, 50).trim() + '…' : s, full: s };
    };
    // Keep any trailing parenthetical — it is often the role's distinguishing detail
    // (e.g. "너의 단독 작업 (설정 정의)" vs "너의 단독 작업 (비프 재생)"): dropping it would
    // collapse two distinct roles into one identical label.
    const cleanHeading = (h: string) => clean(h.replace(/^#+\s*/, ''));
    const cleanProse = (line: string) => clean(line.replace(/^[#>\-*\s]+/, ''));

    // Skip the shared preamble (절대규칙/존댓말 lines and any heading) when scanning prose.
    const isPreamble = (t: string): boolean =>
        t.startsWith('⚠️') || /^#{1,6}\s/.test(t) || /절대규칙|존댓말|한국어로 (작성|출력)/.test(t);

    // Per-agent heading lists + a global count of each raw heading. Also count each prose
    // line across agents so the fallback (step 3) can skip lines shared by ≥2 agents.
    const headings = new Map<string, string[]>();
    const headingCount = new Map<string, number>();
    const proseCount = new Map<string, number>();
    for (const [id, text] of prompts) {
        const hs: string[] = [];
        const seenProse = new Set<string>();
        for (const ln of text.split('\n')) {
            const t = ln.trim();
            if (/^#{1,6}\s+\S/.test(t)) { hs.push(t); continue; }
            if (t && !isPreamble(t) && !seenProse.has(t)) {
                seenProse.add(t);
                proseCount.set(t, (proseCount.get(t) || 0) + 1);
            }
        }
        headings.set(id, hs);
        for (const h of new Set(hs)) headingCount.set(h, (headingCount.get(h) || 0) + 1);
    }

    // Role headings usually read like "# 너의 임무", "# 너의 단독 작업", "# 렌즈 A: …",
    // "# 역할". Prefer a unique heading that looks like one of those over a merely-incidental
    // unique heading (e.g. "# 사전 확정 사실") that happens to differ between agents.
    const ROLE_HINT = /너의|임무|작업|렌즈|역할|관점|담당|단독/;
    const labels = new Map<string, { label: string; full: string }>();
    for (const [id, text] of prompts) {
        let label: { label: string; full: string } | null = null;
        const uniqueHeadings = (headings.get(id) || []).filter(h => (headingCount.get(h) || 0) < 2);
        // 1+2. prefer a role-looking unique heading; else the first unique heading.
        const roleHeading = uniqueHeadings.find(h => ROLE_HINT.test(h)) || uniqueHeadings[0];
        if (roleHeading) label = cleanHeading(roleHeading);
        // 3. fallback: first UNIQUE meaningful prose line. Cross-compare like headings —
        // skip lines shared by ≥2 agents (boilerplate) so a fan-out that opens with an
        // identical paragraph doesn't collapse every agent to the same label. If every
        // prose line is shared, leave it unset → the panel's distinct "에이전트 N" beats
        // N identical labels.
        if (!label) {
            for (const ln of text.split('\n')) {
                const t = ln.trim();
                if (!t || isPreamble(t)) continue;
                if ((proseCount.get(t) || 0) >= 2) continue;  // shared boilerplate — skip
                const c = cleanProse(t);
                if (c.label) { label = c; break; }
            }
        }
        if (label && label.label) labels.set(id, label);
    }
    return labels;
}

export function agentWasInterrupted(lines: string[]): boolean {
    for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln || !ln.trim()) continue;
        if (ln.indexOf('Request interrupted') === -1) continue;  // cheap pre-filter before parse
        try {
            const e = JSON.parse(ln);
            if (e.type !== 'user') continue;
            // 플러그인만 다른 점(10-05): 확장은 글자가 "들어 있으면" 중단으로 봤다. 그러면 지시문(첫 사용자 메시지)에
            // 이 글자를 적은 에이전트가 시작하자마자 중단으로 보인다(실측: 이 판정을 대조하던 조사 에이전트 다섯이 전부).
            // 실제 중단 표식은 텍스트 블록이 통째로 "[Request interrupted by user]"(…" for tool use]")라 그 시작만 본다.
            const content = e.message?.content;
            const texts: string[] = Array.isArray(content)
                ? content.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
                : [typeof content === 'string' ? content : ''];
            if (texts.some(t => t.trim().startsWith('[Request interrupted'))) return true;
        } catch { /* skip malformed line */ }
    }
    return false;
}

export type AgentTiming = { durationMs: number; activity: string; firstTs: number; lastTs: number; interrupted: boolean; tokens: number; model: string };

export function agentTimingOf(content: string | null): AgentTiming {
    let firstTs = 0;
    let lastTs = 0;
    let activity = '작업 중…';
    let interrupted = false;
    // Token total for the agent = the LAST usage record, not a sum of them.
    //
    // Verified 2026-09-08 against Claude Code's own bookkeeping: a Task result carries
    // `totalTokens`, and input + cache_creation + cache_read + output of the final usage
    // record reproduces it exactly (92,754 on the sample checked). Summing instead would
    // double-count, because each request writes 2-4 streaming snapshots that all repeat
    // the same cache figures — 36 assistant entries for 11 distinct requests in one log.
    // The value grows monotonically, so the last record is also the largest.
    let tokens = 0;
    let tokensFound = false;
    let model = '';
    if (content !== null) try {
        const lines = content.trim().split('\n');
        interrupted = agentWasInterrupted(lines);

        // First timestamp = start.
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            try {
                const e = JSON.parse(lines[i]);
                if (e.timestamp) { firstTs = new Date(e.timestamp).getTime(); break; }
            } catch { /* skip */ }
        }

        // Walk backwards for the last timestamp and the latest assistant activity.
        let foundActivity = false;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].trim()) continue;
            try {
                const e = JSON.parse(lines[i]);
                if (e.timestamp && !lastTs) lastTs = new Date(e.timestamp).getTime();
                if (!tokensFound && e.type === 'assistant' && e.message?.usage) {
                    const u = e.message.usage;
                    tokens = (u.input_tokens || 0)
                        + (u.cache_creation_input_tokens || 0)
                        + (u.cache_read_input_tokens || 0)
                        + (u.output_tokens || 0);
                    // `usage.iterations` is a duplicate of these same four fields (checked
                    // across 30k records: 4,209 present, 0 that differed) — never add it.
                    if (typeof e.message.model === 'string') model = e.message.model;
                    tokensFound = true;
                }
                if (!foundActivity && e.type === 'assistant' && e.message?.content) {
                    const blocks = e.message.content;
                    if (Array.isArray(blocks)) {
                        for (let k = blocks.length - 1; k >= 0; k--) {
                            const b = blocks[k];
                            if (b?.type === 'tool_use') {
                                const arg = b.input?.file_path || b.input?.path || b.input?.command || b.input?.pattern || b.input?.description;
                                const argStr = typeof arg === 'string' ? ` — ${arg.replace(/\s+/g, ' ').slice(0, 60)}` : '';
                                activity = `🔧 ${b.name}${argStr}`;
                                foundActivity = true;
                                break;
                            }
                            if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                                const t = b.text.replace(/\s+/g, ' ').trim();
                                activity = t.length > 140 ? t.slice(0, 140) + '…' : t;
                                foundActivity = true;
                                break;
                            }
                        }
                    } else if (typeof blocks === 'string' && blocks.trim()) {
                        const t = blocks.replace(/\s+/g, ' ').trim();
                        activity = t.length > 140 ? t.slice(0, 140) + '…' : t;
                        foundActivity = true;
                    }
                }
                if (lastTs && foundActivity) break;
            } catch { /* skip malformed line */ }
        }
    } catch { /* malformed log */ }
    const durationMs = (firstTs && lastTs && lastTs >= firstTs) ? lastTs - firstTs : 0;
    return { durationMs, activity, firstTs, lastTs, interrupted, tokens, model };
}
