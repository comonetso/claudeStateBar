// Which workflow run each task notification in a Claude Code conversation refers to, and the
// status it carries. Deliberately free of vscode, so it can be checked against real
// conversation files with plain node.
//
// Only real notifications count. The same `<task-notification>` text also turns up quoted —
// queued copies (`queue-operation`), attachments, and any tool output or reasoning that echoed
// one — and treating those as notices could mark a workflow that is still running as stopped.
// A real one, checked on both a local and a Remote-SSH host on 2026-09-14, is a `user` line whose
// `origin` is `{"kind":"task-notification"}` and whose content starts with the notification.
//
// A notice names a task, not a run. The launch result maps the task to its run on one line:
// `Workflow launched in background. Task ID: w7ge56jts … Run ID: wf_10a16cfe-09e`, also visible in
// its transcript path. Some "didn't finish before the previous session ended" notices name the run
// themselves as `(run wf_…)`, used when no launch line matched. Later lines win.
export function parseWorkflowNotices(text: string): Map<string, string> {
    const taskToRun = new Map<string, string>();
    const byRun = new Map<string, string>();
    for (const line of text.split('\n')) {
        if (!line) continue;

        if (line.includes('Task ID:')) {
            const tid = /Task ID: (\w+)/.exec(line);
            const rid = /Run ID: (wf_[A-Za-z0-9-]+)/.exec(line) || /workflows[\\/]+(wf_[A-Za-z0-9-]+)/.exec(line);
            if (tid && rid) taskToRun.set(tid[1], rid[1]);
        }

        if (!line.includes('"kind":"task-notification"') || !line.includes('<task-notification>')) continue;
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry?.type !== 'user' || entry?.origin?.kind !== 'task-notification') continue;
        const raw = entry.message?.content;
        const content = typeof raw === 'string'
            ? raw
            : Array.isArray(raw) ? raw.map((b: any) => (b?.type === 'text' ? b.text || '' : '')).join('') : '';
        if (!content.trimStart().startsWith('<task-notification>')) continue;

        const status = /<status>(\w+)<\/status>/.exec(content)?.[1];
        if (!status) continue;
        const taskId = /<task-id>(\w+)<\/task-id>/.exec(content)?.[1];
        const run = (taskId && taskToRun.get(taskId)) || /\(run (wf_[A-Za-z0-9-]+)\)/.exec(content)?.[1];
        if (run) byRun.set(run, status);
    }
    return byRun;
}
