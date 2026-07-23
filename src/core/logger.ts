import * as vscode from 'vscode';

// Provider-neutral logger. The OutputChannel is created by activate() and injected
// once via setLogChannel(), so every module can `import { log }` without a back-
// reference to extension.ts. Before injection (or if it fails) log() is a silent
// no-op — preserving the original optional-chaining contract.
let outputChannel: vscode.OutputChannel | null = null;

export function setLogChannel(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

export function getLogChannel(): vscode.OutputChannel | null {
    return outputChannel;
}

export function log(msg: string): void {
    outputChannel?.appendLine(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
}
