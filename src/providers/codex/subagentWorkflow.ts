// Pure Codex sub-agent workflow summariser (no vscode import, no disk I/O).
//
// A Codex parent thread can spawn several child threads during one turn. Child completion
// alone is not the whole-workflow terminal marker: sequential batches can leave a short
// interval where every currently known child is done while the parent is about to spawn
// more. Codex's equivalent of `agent-turn-complete` is therefore the parent task_complete.

import { CodexAccumulator, lifecycle } from './rolloutParser';

export type CodexSubagentWorkflowStatus = 'running' | 'settling' | 'completed' | 'failed';

export interface CodexSubagentWorkflowSummary {
    /** Parent task_started timestamp; uniquely identifies this parent turn. */
    startedAt: Date;
    childCount: number;
    completedCount: number;
    activeCount: number;
    failedCount: number;
    status: CodexSubagentWorkflowStatus;
    /** Parent task_complete timestamp, set only for a successful whole-turn completion. */
    completionAt: Date | null;
}

function taskStartMs(acc: CodexAccumulator): number {
    return acc.lastTaskStartedAt?.getTime()
        ?? acc.sessionCreated?.getTime()
        ?? -1;
}

function descendsFrom(
    child: CodexAccumulator,
    parentThreadId: string,
    spawnedById: Map<string, CodexAccumulator>
): boolean {
    let ancestorId = child.subagent?.parentThreadId ?? '';
    const visited = new Set<string>();

    while (ancestorId && !visited.has(ancestorId)) {
        if (ancestorId === parentThreadId) return true;
        visited.add(ancestorId);
        ancestorId = spawnedById.get(ancestorId)?.subagent?.parentThreadId ?? '';
    }
    return false;
}

/**
 * Summarise only child activity belonging to the parent's latest turn.
 *
 * Requiring an explicit parent chain avoids attributing internal guardian agents by
 * cwd/time. Walking that chain includes nested spawned agents, while requiring descendant
 * activity at or after the latest parent task_started prevents historical children from
 * making a later ordinary parent turn look like another agent workflow.
 */
export function summariseCodexSubagentWorkflow(
    parent: CodexAccumulator,
    possibleChildren: CodexAccumulator[]
): CodexSubagentWorkflowSummary | null {
    const parentStartedAt = parent.lastTaskStartedAt?.getTime() ?? -1;
    if (!parent.sessionId || parentStartedAt < 0) return null;

    const spawnedById = new Map(
        possibleChildren
            .filter(child => child.sessionId)
            .map(child => [child.sessionId, child] as const)
    );
    const children = possibleChildren.filter(child =>
        descendsFrom(child, parent.sessionId, spawnedById)
        && taskStartMs(child) >= parentStartedAt
    );
    if (children.length === 0) return null;

    const states = children.map(lifecycle);
    const completedCount = states.filter(state => state === 'completed').length;
    const activeCount = states.filter(state => state === 'active' || state === 'unknown').length;
    const failedCount = states.filter(state => state === 'aborted').length;
    const parentState = lifecycle(parent);

    let status: CodexSubagentWorkflowStatus;
    let completionAt: Date | null = null;

    if (parentState === 'aborted') {
        status = 'failed';
    } else if (parentState !== 'completed') {
        status = 'running';
    } else if (failedCount > 0) {
        status = 'failed';
    } else if (completedCount === children.length) {
        status = 'completed';
        completionAt = parent.lastTaskCompleteAt;
    } else {
        // Parent completion can reach its rollout just before a child's final append. Hold
        // the ordinary completion beep briefly so the next file-system refresh can classify
        // the turn as a workflow and play the distinct workflow sound exactly once.
        status = 'settling';
    }

    return {
        startedAt: parent.lastTaskStartedAt!,
        childCount: children.length,
        completedCount,
        activeCount,
        failedCount,
        status,
        completionAt
    };
}
