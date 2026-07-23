import * as vscode from 'vscode';
import { readTextFile } from '../../core/fs';

export interface TokenUsage {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    model: string;
    speed: string;          // "standard" | "fast" (Claude Code /fast toggle)
    firstMessage: string;
    sessionCreated: Date | null;
    lastRealTimestamp: Date | null;  // Last timestamp excluding last-prompt entries
    lastActivityAt: Date | null;  // Beep-gate clock: last assistant|user entry (excludes stop_hook/queue-op noise)
    wasCleared: boolean;  // True if session ended with /clear command
    lastAssistantEndTurnAt: Date | null;  // Timestamp of last end_turn assistant entry
    pendingQuestionAt: Date | null;  // See SessionInfo
    pendingToolUseAt: Date | null;
    pendingToolUseName: string | null;
}

export async function getLatestTokenCount(jsonlUri: vscode.Uri): Promise<TokenUsage> {
    const empty: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, model: '', speed: '', firstMessage: '', sessionCreated: null, lastRealTimestamp: null, lastActivityAt: null, wasCleared: false, lastAssistantEndTurnAt: null, pendingQuestionAt: null, pendingToolUseAt: null, pendingToolUseName: null };
    try {
        const stat = await vscode.workspace.fs.stat(jsonlUri);
        if (stat.size === 0) {
            return empty;
        }

        // Read the file (routed to the remote host by VS Code when running over Remote-SSH)
        const content = await readTextFile(jsonlUri);
        const lines = content.trim().split('\n');

            // Scan backwards to find the last /clear command AND check for user activity after it
            let lastClearIndex = -1;
            let userMessagesAfterClear = 0;

            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);

                    // Check for User message
                    if (entry.type === 'user' && entry.message?.content) {
                        const msgContent = entry.message.content;

                        // Check for /clear command
                        if (typeof msgContent === 'string' && msgContent.includes('<command-name>/clear</command-name>')) {
                            lastClearIndex = i;
                            break; // Found the latest clear, stop scanning
                        }

                        // If not clear, it's a user message after the clear point (since we're going backwards)
                        userMessagesAfterClear++;
                    }
                } catch (e) {
                    continue;
                }
            }

            // Determine if session is effectively cleared
            // It is cleared IF:
            // 1. We found a /clear command
            // 2. AND there are NO user messages after it (meaning the user hasn't continued the session yet)
            const wasCleared = (lastClearIndex !== -1 && userMessagesAfterClear === 0);

            // Calculate usage and finding first message starting from AFTER the clear
            const startIndex = lastClearIndex >= 0 ? lastClearIndex + 1 : 0;

            let firstMessage = '';
            let sessionCreated: Date | null = null;
            let lastRealTimestamp: Date | null = null;
            let lastActivityAt: Date | null = null;  // beep-gate clock (assistant|user only)
            let lastAssistantEndTurnAt: Date | null = null;
            let model = '';
            let speed = '';
            let finalUsage = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };

            // Forward pass from start index to find metadata and latest usage
            for (let i = startIndex; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);

                    // Get session creation timestamp (first valid timestamp after clear)
                    if (!sessionCreated && entry.timestamp) {
                        sessionCreated = new Date(entry.timestamp);
                    }
                    // Track last real timestamp (skip last-prompt entries — Claude Code writes
                    // these to the old file when a new session starts, inflating the mtime)
                    if (entry.timestamp && entry.type !== 'last-prompt') {
                        lastRealTimestamp = new Date(entry.timestamp);
                    }
                    // Beep-gate activity clock: only real conversation turns count as
                    // "activity". The codex stop-review-gate-hook writes a
                    // system/stop_hook_summary entry ~0.6s after every completed turn;
                    // counting it (or queue-operation / file-history-snapshot / attachment)
                    // as activity pushes lastActivity past curr+500ms and suppresses the
                    // completion beep on every turn. Restrict to assistant|user.
                    if (entry.timestamp && (entry.type === 'assistant' || entry.type === 'user')) {
                        lastActivityAt = new Date(entry.timestamp);
                    }

                    // Look for first user message (for display)
                    if (!firstMessage && entry.type === 'user' && entry.message?.content) {
                        const msgContent = entry.message.content;
                        // Skip command-related messages
                        if (typeof msgContent === 'string' &&
                            !msgContent.includes('<command-name>') &&
                            !msgContent.includes('<local-command-') &&
                            !msgContent.includes('Caveat:')) {
                            firstMessage = msgContent.substring(0, 60);
                        } else if (Array.isArray(msgContent) && msgContent[0]?.text) {
                            firstMessage = msgContent[0].text.substring(0, 60);
                        }
                    }

                    // Update latest usage/model as we go (capturing the last valid usage report)
                    if (entry.message?.model) {
                        model = entry.message.model;
                    }
                    // Capture speed (standard|fast) — set by Claude Code's /fast toggle
                    if (entry.message?.speed) {
                        speed = entry.message.speed;
                    } else if (entry.speed) {
                        speed = entry.speed;
                    }
                    if (entry.message?.usage || entry.usage) {
                        const u = entry.message?.usage || entry.usage;
                        finalUsage = {
                            inputTokens: u.input_tokens || 0,
                            cacheReadTokens: u.cache_read_input_tokens || 0,
                            cacheCreationTokens: u.cache_creation_input_tokens || 0,
                            totalTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                        };
                    }
                    // Track last complete assistant response (end_turn = tool calls excluded).
                    // IMPORTANT: thinking-enabled responses split ONE turn into a [thinking]-only
                    // line and a [text] line, BOTH carrying stop_reason='end_turn'. The
                    // thinking-only end_turn is an intermediate signal (Claude is still generating
                    // the answer), so treating it as completion fires the beep mid-work. Only count
                    // an end_turn whose content has at least one type==='text' block; ignore
                    // end_turn entries that contain solely thinking/redacted_thinking/tool_use.
                    // (Verified against 60 real sessions: 540 thinking-only end_turns = false
                    // triggers, 994 text end_turns = real completions, 0 missed.)
                    if (entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn' && entry.timestamp) {
                        const c = entry.message?.content;
                        const hasTextBlock = Array.isArray(c)
                            ? c.some((b: any) => b?.type === 'text')
                            : typeof c === 'string' && c.length > 0;
                        if (hasTextBlock) {
                            lastAssistantEndTurnAt = new Date(entry.timestamp);
                        }
                    }
                } catch (e) {
                    continue;
                }
            }

            // --- Pause detection: scan from the end of the file for an unanswered tool_use ---
            //
            // Claude Code's tool flow always looks like:
            //   assistant entry (stop_reason="tool_use", content ends with one or more tool_use blocks)
            //   user entry     (content = tool_result blocks for each tool_use id)
            // While Claude is waiting on the user — either because it explicitly asked
            // (AskUserQuestion / ExitPlanMode) or because VS Code popped a permission
            // prompt for a tool like Bash — the tool_result entry has not been written yet.
            //
            // So: walk backwards from the end skipping empty lines. The first entry we hit
            // wins. If it is an assistant entry whose final content block is `tool_use`, we
            // are paused waiting on the user. The block's `name` tells us whether it's a
            // deliberate question (AskUserQuestion / ExitPlanMode) or any other tool (the
            // optional stuck-tool-use heuristic uses the latter).
            let pendingQuestionAt: Date | null = null;
            let pendingToolUseAt: Date | null = null;
            let pendingToolUseName: string | null = null;
            for (let i = lines.length - 1; i >= 0; i--) {
                const raw = lines[i];
                if (!raw.trim()) continue;
                try {
                    const e = JSON.parse(raw);
                    if (e.type !== 'assistant' && e.type !== 'user') continue;
                    // The newest meaningful entry — answer the pending question:
                    if (e.type === 'assistant' && e.message?.stop_reason === 'tool_use') {
                        const content = e.message?.content;
                        if (Array.isArray(content)) {
                            // Find the last tool_use block in the message
                            let lastTu: any = null;
                            for (let k = content.length - 1; k >= 0; k--) {
                                if (content[k]?.type === 'tool_use') { lastTu = content[k]; break; }
                            }
                            if (lastTu) {
                                const tsRaw = e.timestamp;
                                const ts = tsRaw ? new Date(tsRaw) : null;
                                pendingToolUseAt = ts;
                                pendingToolUseName = typeof lastTu.name === 'string' ? lastTu.name : null;
                                if (lastTu.name === 'AskUserQuestion' || lastTu.name === 'ExitPlanMode') {
                                    pendingQuestionAt = ts;
                                }
                            }
                        }
                    }
                    break; // First non-empty entry decides; stop scanning
                } catch { /* malformed line — skip */ }
            }

            return {
                inputTokens: finalUsage.inputTokens,
                cacheReadTokens: finalUsage.cacheReadTokens,
                cacheCreationTokens: finalUsage.cacheCreationTokens,
                totalTokens: finalUsage.totalTokens,
                model,
                speed,
                firstMessage: firstMessage ? firstMessage + '...' : '',
                sessionCreated,
                lastRealTimestamp,
                lastActivityAt,
                wasCleared,
                lastAssistantEndTurnAt,
                pendingQuestionAt,
                pendingToolUseAt,
                pendingToolUseName
            };
    } catch (e) {
        return empty;
    }
}
