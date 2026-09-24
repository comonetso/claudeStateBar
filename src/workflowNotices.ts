// Which workflow run or sub-agent each task notification in a Claude Code conversation refers to,
// and the status it carries. Deliberately free of vscode, so it can be checked against real
// conversation files with plain node.
//
// Only real notifications count. The same `<task-notification>` text also turns up quoted —
// queued copies (`queue-operation`), other attachments, and any tool output or reasoning that
// echoed one — and treating those as notices could mark a workflow that is still running as
// stopped. A real one comes in one of two shapes, and its content starts with the notification:
// - a `user` line whose `origin` is `{"kind":"task-notification"}` (checked on a local and a
//   Remote-SSH host on 2026-09-14);
// - when it arrived while Claude was mid-answer, an `attachment` of type `queued_command` with
//   `commandMode: "task-notification"`, the text in `attachment.prompt`. Found on 2026-09-22 while
//   building the background task panel: of 209 notices on this PC none was recorded both ways, and
//   this shape was the more common one for background commands (91 of 152). Reading only the first
//   shape left a workflow whose end notice came this way looking as if it still ran.
//
// A notice names a task, not a run. The launch result maps the task to its run on one line:
// `Workflow launched in background. Task ID: w7ge56jts … Run ID: wf_10a16cfe-09e`, also visible in
// its transcript path. Some "didn't finish before the previous session ended" notices name the run
// themselves as `(run wf_…)`, used when no launch line matched. Later lines win.
//
// A sub-agent (the Agent tool) needs no such mapping: its notice's task id is its agentId, the
// name of its log file. Measured 2026-09-24 on this PC: 23 of 25 sub-agents launched in the last
// 45 days ran asynchronously, and all 23 had a notice naming them that way, every one `completed`
// — no stopped, killed or failed sub-agent notice was on disk to check. Each notice is returned
// with its time, since a sub-agent can be woken again after it stopped.
export interface TaskNotices {
    /** Workflow run id → status of its latest notice. */
    byRun: Map<string, string>;
    /** Task id → status and time of its latest notice. For a sub-agent the task id is its agentId. */
    byTask: Map<string, { status: string; at: number }>;
}

export function parseTaskNotices(text: string): TaskNotices {
    const taskToRun = new Map<string, string>();
    const byRun = new Map<string, string>();
    const byTask = new Map<string, { status: string; at: number }>();
    for (const line of text.split('\n')) {
        if (!line) continue;

        if (line.includes('Task ID:')) {
            const tid = /Task ID: (\w+)/.exec(line);
            const rid = /Run ID: (wf_[A-Za-z0-9-]+)/.exec(line) || /workflows[\\/]+(wf_[A-Za-z0-9-]+)/.exec(line);
            if (tid && rid) taskToRun.set(tid[1], rid[1]);
        }

        if (!line.includes('<task-notification>')) continue;
        if (!line.includes('"kind":"task-notification"') && !line.includes('"commandMode":"task-notification"')) continue;
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        let content: string;
        if (entry?.type === 'user' && entry?.origin?.kind === 'task-notification') {
            const raw = entry.message?.content;
            content = typeof raw === 'string'
                ? raw
                : Array.isArray(raw) ? raw.map((b: any) => (b?.type === 'text' ? b.text || '' : '')).join('') : '';
        } else if (entry?.type === 'attachment' && entry.attachment?.type === 'queued_command'
                   && entry.attachment?.commandMode === 'task-notification') {
            content = typeof entry.attachment.prompt === 'string' ? entry.attachment.prompt : '';
        } else {
            continue;
        }
        if (!content.trimStart().startsWith('<task-notification>')) continue;

        const status = /<status>(\w+)<\/status>/.exec(content)?.[1];
        if (!status) continue;
        const taskId = /<task-id>(\w+)<\/task-id>/.exec(content)?.[1];
        const run = (taskId && taskToRun.get(taskId)) || /\(run (wf_[A-Za-z0-9-]+)\)/.exec(content)?.[1];
        if (run) byRun.set(run, status);
        if (taskId) {
            const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
            byTask.set(taskId, { status, at: Number.isFinite(at) ? at : 0 });
        }
    }
    return { byRun, byTask };
}
