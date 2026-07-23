import * as vscode from 'vscode';

// Provider-neutral filesystem helper. Reads any URI (local file:// or remote
// vscode-remote://) as a UTF-8 string. Kept free of Claude/Codex specifics so
// both providers' parsers can share it without a back-reference to extension.ts.
export async function readTextFile(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf-8');
}
