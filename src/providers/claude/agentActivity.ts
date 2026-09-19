// What one workflow (or Task) agent actually did, as rows for the workflow panel.
//
// The workflow panel used to show a finished agent's steps as one block of text. The Codex panel
// shows a run as rows — a command, a file, a search, each with its own success or failure — and the
// two panels are meant to read alike (user's call, 2026-09-19). This turns an agent's own log
// (agent-<id>.jsonl, Claude Code's standard transcript) into those rows.
//
// Measured on a real agent log: the same assistant message is written across several lines, one
// content block per line, but no block is repeated — 50 tool_use blocks with 50 distinct ids,
// 20 text blocks all distinct. So tool calls are keyed by their id and paired with the
// tool_result that carries the same id; text is kept once per message and text.

export type AgentActivityKind =
    | 'command_execution'   // Bash, PowerShell
    | 'file_read'           // Read
    | 'file_change'         // Edit, Write, MultiEdit, NotebookEdit
    | 'code_search'         // Grep, Glob
    | 'web_search'          // WebSearch, WebFetch
    | 'agent_message'       // the agent talking
    | 'tool';               // anything else (Skill, Agent, MCP tools…)

export interface AgentActivityItem {
    id: string;
    kind: AgentActivityKind;
    /** One line for the row. */
    label: string;
    /** What opening the row shows: the full command or message, and a failure's own output. */
    body?: string;
    /** 'warn' = the call never got a result and the agent is no longer running — it was cut off. */
    status: 'running' | 'done' | 'failed' | 'warn';
    durationMs?: number;
}

const LABEL_MAX = 200;
// A failure's output is the part worth reading, but a whole build log in a panel row is not.
const FAIL_OUTPUT_MAX = 2000;

function oneLine(s: string): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX) + '…' : t;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

function kindOf(name: string): AgentActivityKind {
    switch (name) {
        case 'Bash': case 'PowerShell': return 'command_execution';
        case 'Read': return 'file_read';
        case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return 'file_change';
        case 'Grep': case 'Glob': return 'code_search';
        case 'WebSearch': case 'WebFetch': return 'web_search';
        default: return 'tool';
    }
}

/** Row label and hover/body text for one tool call. */
function describe(name: string, input: any): { label: string; body?: string } {
    const inp = input && typeof input === 'object' ? input : {};
    switch (kindOf(name)) {
        case 'command_execution': {
            const cmd = str(inp.command);
            const desc = str(inp.description);
            // The command itself is the row, as in the Codex panel — it is what ran. The author's
            // one-line description goes on top of the body, where it explains without replacing.
            const body = desc ? '# ' + desc + '\n' + cmd : cmd;
            return { label: oneLine(cmd || desc || name), body: body !== oneLine(cmd) ? body : undefined };
        }
        case 'file_read': {
            const p = str(inp.file_path);
            const range = (typeof inp.offset === 'number' || typeof inp.limit === 'number')
                ? ':' + (inp.offset ?? 1) + (typeof inp.limit === 'number' ? '+' + inp.limit : '') : '';
            return { label: oneLine(p + range) };
        }
        case 'file_change':
            return { label: oneLine(str(inp.file_path) || str(inp.notebook_path)) };
        case 'code_search': {
            const where = str(inp.path) || str(inp.glob);
            return { label: oneLine(str(inp.pattern) + (where ? '  — ' + where : '')) };
        }
        case 'web_search':
            return { label: oneLine(str(inp.query) || str(inp.url)) };
        default: {
            // Name first: for the catch-all kind the tool is the only thing that says what happened.
            const arg = str(inp.description) || str(inp.skill) || str(inp.prompt) || str(inp.query)
                || str(inp.file_path) || str(inp.command);
            return { label: oneLine(name + (arg ? ' — ' + arg : '')) };
        }
    }
}

function resultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n');
    }
    return '';
}

function tsOf(e: any): number {
    const t = e && e.timestamp ? Date.parse(e.timestamp) : NaN;
    return Number.isFinite(t) ? t : 0;
}

/**
 * Rows for one agent, oldest first.
 * @param agentRunning whether the agent is still working. A call with no result yet is 'running'
 *   while it is, and 'warn' once it is not — the agent was stopped mid-call.
 */
export function parseAgentActivity(lines: string[], agentRunning: boolean): AgentActivityItem[] {
    const items: AgentActivityItem[] = [];
    const byToolId = new Map<string, { item: AgentActivityItem; startedAt: number }>();
    const seenText = new Set<string>();

    for (const line of lines) {
        if (!line || !line.trim()) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        const content = e?.message?.content;
        if (!Array.isArray(content)) continue;

        if (e.type === 'assistant') {
            const msgId = str(e.message.id) || String(items.length);
            for (const b of content) {
                if (b?.type === 'tool_use' && typeof b.id === 'string') {
                    if (byToolId.has(b.id)) continue;
                    const d = describe(str(b.name), b.input);
                    const item: AgentActivityItem = {
                        id: b.id, kind: kindOf(str(b.name)), label: d.label || str(b.name),
                        ...(d.body ? { body: d.body } : {}),
                        status: 'running',
                    };
                    byToolId.set(b.id, { item, startedAt: tsOf(e) });
                    items.push(item);
                } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                    const key = msgId + ':' + b.text.length + ':' + b.text.slice(0, 80);
                    if (seenText.has(key)) continue;
                    seenText.add(key);
                    const text = b.text.trim();
                    const label = oneLine(text);
                    items.push({
                        id: 'm' + items.length, kind: 'agent_message', label, status: 'done',
                        ...(text !== label ? { body: text } : {}),
                    });
                }
            }
        } else if (e.type === 'user') {
            for (const b of content) {
                if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
                const rec = byToolId.get(b.tool_use_id);
                if (!rec) continue;
                rec.item.status = b.is_error ? 'failed' : 'done';
                const end = tsOf(e);
                if (rec.startedAt && end >= rec.startedAt) rec.item.durationMs = end - rec.startedAt;
                if (b.is_error) {
                    let out = resultText(b.content).trim();
                    if (out.length > FAIL_OUTPUT_MAX) out = out.slice(0, FAIL_OUTPUT_MAX) + '\n…';
                    if (out) rec.item.body = (rec.item.body ? rec.item.body + '\n\n' : '') + '── ' + out;
                }
            }
        }
    }

    if (!agentRunning) {
        for (const { item } of byToolId.values()) {
            if (item.status === 'running') item.status = 'warn';
        }
    }
    return items;
}
