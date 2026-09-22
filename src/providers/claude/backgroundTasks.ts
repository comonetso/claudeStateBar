// The background tasks a Claude Code conversation launched: Bash commands run with
// `run_in_background`, and Monitor watches. Deliberately free of vscode, so it can be checked
// against real conversation files with plain node.
//
// What the conversation file holds for each, measured 2026-09-22 on this PC (158 commands) and on
// AI_IVR_Server-Gabia:
// - The launch is an assistant `tool_use` (Bash with `run_in_background: true`, or Monitor) and
//   its `tool_result` carries the task id — `toolUseResult.backgroundTaskId` for a command,
//   `toolUseResult.taskId` for a monitor. A command's result text also names its output file.
// - The end is a task notification with a `<status>` (completed · failed; anything else is read as
//   stopped) and, for a command, the exit code in its summary. It arrives in one of two shapes,
//   never both (209 of 209 checked): a `user` line with `origin.kind: task-notification`, or — when
//   it landed while Claude was mid-answer — an `attachment` of type `queued_command` with
//   `commandMode: task-notification`. The queued shape was the more common one (91 of 152), so
//   reading only the first, as the workflow notice parser does, would miss most endings.
// - A monitor's events arrive as notifications with an `<event>` and no `<status>`.
// Commands started by a workflow's agents are logged in those agents' files, not here, so they
// stay out of this list by construction — which is what the user asked for.
//
// Ordinary (foreground) Bash commands that took long are listed too, as their own group (user's
// call, 2026-09-22: the point is to see what ran long, not only what ran in the background). One
// ends when its `tool_result` lands: an error flag means it failed, with `Exit code N` leading the
// text. Of 6,636 on this PC none was left without a result except the one running at the time,
// so a command stuck as "running" is not a real risk.

export type BgTaskKind = 'command' | 'monitor' | 'foreground';

// A background call to codex_rescue (`bash …/codex-rescue/<version>/send.sh …`, or the older
// `…/skills/codex_rescue/send.sh`) is left out (user's call, 2026-09-22): the Codex progress panel
// and its status-bar dot already show that run, and counting the call as well made one Codex run
// read as an extra background task.
const CODEX_RESCUE_CALL = /codex[-_]rescue[\\/][^\s"']*send\.sh/;
export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BgTask {
    taskId: string;
    kind: BgTaskKind;
    description: string;
    /** The shell command, or a monitor's WebSocket URL. */
    command: string;
    startedAt: number;
    /** Absolute path on the machine that ran it. Temporary — often gone later (64 of 117 were). */
    outputFile?: string;
    status: BgTaskStatus;
    endedAt?: number;
    exitCode?: number;
    /** The notification's summary line, e.g. `Background command "…" failed with exit code 1`. */
    summary?: string;
    /** A monitor's event texts in arrival order. */
    events: string[];
    /** A foreground command's result text, which the conversation itself holds. */
    output?: string;
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b: any) => (b?.type === 'text' ? b.text || '' : '')).join('');
    return '';
}

function timeOf(ts: unknown): number {
    const n = typeof ts === 'string' ? Date.parse(ts) : NaN;
    return Number.isFinite(n) ? n : 0;
}

function tag(text: string, name: string): string | undefined {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
    return m ? m[1] : undefined;
}

/**
 * @param longCommandMs a foreground command that finished is kept only if it took at least this
 *   long. One still running is always kept, with no result yet — the caller decides by its age.
 */
export function parseBackgroundTasks(text: string, longCommandMs: number): BgTask[] {
    const launches = new Map<string, { kind: BgTaskKind; description: string; command: string; startedAt: number }>();
    const foreground = new Map<string, BgTask>();
    const byId = new Map<string, BgTask>();
    const order: BgTask[] = [];

    for (const line of text.split('\n')) {
        if (!line) continue;
        // A long conversation is mostly lines none of this concerns; skip them before parsing.
        const maybeLaunch = line.includes('"run_in_background":true') || line.includes('"name":"Monitor"')
            || line.includes('"name":"Bash"');
        const maybeResult = line.includes('"backgroundTaskId"') || line.includes('"taskId"')
            || (foreground.size > 0 && line.includes('"tool_use_id"'));
        const maybeNotice = line.includes('task-notification');
        if (!maybeLaunch && !maybeResult && !maybeNotice) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        const content = e?.message?.content;

        if (e?.type === 'assistant' && Array.isArray(content)) {
            for (const b of content) {
                if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
                const input = b.input || {};
                if (b.name === 'Bash' && input.run_in_background === true) {
                    if (CODEX_RESCUE_CALL.test(String(input.command || ''))) continue;
                    launches.set(b.id, { kind: 'command', description: String(input.description || ''),
                        command: String(input.command || ''), startedAt: timeOf(e.timestamp) });
                } else if (b.name === 'Bash') {
                    foreground.set(b.id, { taskId: b.id, kind: 'foreground', description: String(input.description || ''),
                        command: String(input.command || ''), startedAt: timeOf(e.timestamp), status: 'running', events: [] });
                } else if (b.name === 'Monitor') {
                    launches.set(b.id, { kind: 'monitor', description: String(input.description || ''),
                        command: String(input.command || input.ws?.url || ''), startedAt: timeOf(e.timestamp) });
                }
            }
            continue;
        }

        if (e?.type === 'user' && Array.isArray(content)) {
            for (const b of content) {
                if (b?.type !== 'tool_result') continue;
                const fg = foreground.get(b.tool_use_id);
                if (fg) {
                    foreground.delete(b.tool_use_id);
                    const endedAt = timeOf(e.timestamp);
                    if (!endedAt || !fg.startedAt || endedAt - fg.startedAt < longCommandMs) continue;
                    const out = textOf(b.content);
                    const r = e.toolUseResult;
                    fg.endedAt = endedAt;
                    fg.output = out;
                    if (r && typeof r === 'object' && r.interrupted === true) {
                        fg.status = 'stopped';
                    } else if (b.is_error === true) {
                        fg.status = 'failed';
                        const code = /^Exit code (\d+)/.exec(out)?.[1];
                        if (code !== undefined) fg.exitCode = Number(code);
                    } else {
                        fg.status = 'completed';
                    }
                    order.push(fg);
                    continue;
                }
                const launch = launches.get(b.tool_use_id);
                if (!launch) continue;
                launches.delete(b.tool_use_id);
                const r = e.toolUseResult || {};
                const taskId = typeof r.backgroundTaskId === 'string' ? r.backgroundTaskId
                    : typeof r.taskId === 'string' ? r.taskId : undefined;
                if (!taskId || byId.has(taskId)) continue;   // refused or failed to start
                const out = /Output is being written to: (.+?\.output)/.exec(textOf(b.content))?.[1];
                const task: BgTask = { taskId, ...launch, status: 'running', events: [],
                    ...(out ? { outputFile: out } : {}) };
                byId.set(taskId, task);
                order.push(task);
            }
        }

        let notice: string | null = null;
        let at = 0;
        if (e?.type === 'user' && e.origin?.kind === 'task-notification') {
            notice = textOf(content);
            at = timeOf(e.timestamp);
        } else if (e?.type === 'attachment' && e.attachment?.type === 'queued_command'
                   && e.attachment?.commandMode === 'task-notification') {
            notice = typeof e.attachment.prompt === 'string' ? e.attachment.prompt : '';
            at = timeOf(e.attachment.timestamp) || timeOf(e.timestamp);
        }
        if (!notice || !notice.trimStart().startsWith('<task-notification>')) continue;
        const task = byId.get(tag(notice, 'task-id') ?? '');
        if (!task) continue;   // a workflow, or a task this file never launched
        const status = tag(notice, 'status');
        if (!status) {
            const ev = tag(notice, 'event');
            if (ev !== undefined) task.events.push(ev);
            continue;
        }
        // The first ending stands. A workflow once had a `stopped` notice attached a day after it
        // had completed, when Claude Code reopened the session (see workflowNotices.ts).
        if (task.status !== 'running') continue;
        task.status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped';
        if (at) task.endedAt = at;
        const summary = tag(notice, 'summary');
        if (summary) {
            task.summary = summary;
            const code = /exit code (\d+)/.exec(summary)?.[1];
            if (code !== undefined) task.exitCode = Number(code);
        }
        const out = tag(notice, 'output-file');
        if (out) task.outputFile = out;
    }
    // Foreground commands still waiting for a result: Claude is blocked on them right now.
    for (const fg of foreground.values()) if (fg.startedAt) order.push(fg);
    return order;
}

/** `[exited with code N]` closing an output file, or undefined while the task still writes. */
export function exitCodeFromOutputTail(output: string): number | undefined {
    const m = /\[exited with code (\d+)\]\s*$/.exec(output);
    return m ? Number(m[1]) : undefined;
}
