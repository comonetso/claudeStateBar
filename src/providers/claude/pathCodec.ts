import * as vscode from 'vscode';

// Claude-specific project-path encoding/decoding. Claude Code stores session logs under
// ~/.claude/projects/<encoded-dir>, where the workspace absolute path is dash-encoded.
// Codex records cwd verbatim in session_meta, so it does NOT need this heuristic.

// Example: "F:\\workspace\\Etc Project\\foo" → "f--workspace-Etc-Project-foo"
//          "/Users/me/my project"            → "-Users-me-my-project"
export function encodeWorkspacePath(p: string): string {
    let result = p;
    // Lowercase drive letter on Windows so it matches Claude's lowercase encoding
    if (/^[a-zA-Z]:/.test(result)) {
        result = result[0].toLowerCase() + result.slice(1);
    }
    // Each colon, slash, backslash, or whitespace becomes a single dash
    // Claude Code encodes all non-alphanumeric ASCII chars and all non-ASCII (Korean, etc.) as '-'
    return result.replace(/[:\\/\s_.]|[^\x00-\x7F]|[^a-zA-Z0-9\-]/g, '-');
}

// Returns lowercase encoded directory names for the currently open workspace folders,
// or null if there are no workspace folders (single-file window).
export function getWorkspaceProjectDirs(): Set<string> | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const dirs = new Set<string>();
    for (const f of folders) {
        dirs.add(encodeWorkspacePath(f.uri.fsPath).toLowerCase());
    }
    return dirs;
}

// Check if a Claude project directory name matches a given workspace folder.
// Primary: exact encoded-path match.
// Fallback: decode the Claude dir and compare normalised paths (handles encoding edge-cases on Linux).
export function projectDirMatchesFolder(projectDir: string, f: vscode.WorkspaceFolder): boolean {
    const encoded = encodeWorkspacePath(f.uri.fsPath).toLowerCase();
    if (projectDir.toLowerCase() === encoded) return true;

    // Fallback: decode Claude's dir name and compare to the workspace path
    const { fullPath } = decodeProjectPath(projectDir);
    const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
    if (norm(fullPath) === norm(f.uri.fsPath)) return true;

    // Second fallback: last path segment(s) match
    const wsParts = f.uri.fsPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const claudeParts = projectDir.replace(/^-/, '').split('-').filter(Boolean);
    if (wsParts.length > 0 && claudeParts.length > 0) {
        const wsLast = wsParts[wsParts.length - 1].toLowerCase();
        const claudeLast = claudeParts[claudeParts.length - 1].toLowerCase();
        if (wsLast === claudeLast && wsParts.length >= 2 && claudeParts.length >= 2) {
            // Also check the parent segment for more confidence
            const wsParent = wsParts[wsParts.length - 2].toLowerCase();
            const claudeParent = claudeParts[claudeParts.length - 2].toLowerCase();
            if (wsParent === claudeParent) return true;
        }
    }

    return false;
}

export function decodeProjectPath(encodedName: string): { name: string; fullPath: string } {
    // Claude encodes paths like: C--dev-my-cool-project or -Users-name-work-my-project
    // The double-dash after drive letter represents the colon (C: -> C--)
    // Single dashes represent path separators, BUT folder names can also contain dashes
    //
    // Strategy: Detect OS from the pattern and reconstruct path
    let decoded = encodedName;

    // Remove leading dash if present
    if (decoded.startsWith('-')) {
        decoded = decoded.substring(1);
    }

    // Split by dashes and filter out empty strings (from double-dashes)
    const parts = decoded.split('-').filter(p => p.length > 0);
    let fullPath: string;
    let projectName: string;

    // Check if Windows pattern (first part is single drive letter like 'c', 'd', etc.)
    if (parts.length > 0 && parts[0].length === 1 && /[a-zA-Z]/.test(parts[0])) {
        // Windows path: C:\dev\my-cool-project
        // Claude typically encodes as: C--dev-my-cool-project
        // After filtering empty strings: ['C', 'dev', 'my', 'cool', 'project']
        fullPath = parts[0].toUpperCase() + ':\\' + parts.slice(1).join('\\');

        // Project name: use last few segments only (not full path chain)
        // For C:\dev\webapp -> parts = ['C', 'dev', 'webapp'] -> projectName = 'webapp'
        // For C:\dev\tools\extensions\vscode\my-extension -> use last 3 parts -> 'my-extension'
        if (parts.length >= 3) {
            // Skip drive letter and first folder, but limit to last 3 segments for deeply nested paths
            const startIndex = Math.max(2, parts.length - 3);
            const projectParts = parts.slice(startIndex);
            projectName = projectParts.join('-');
        } else {
            projectName = parts[parts.length - 1] || 'Unknown';
        }
    } else {
        // Unix path: /Users/Ed/work/my-project
        fullPath = '/' + parts.join('/');

        // Similar heuristic for Unix
        if (parts.length >= 3) {
            // Skip common prefixes like Users, home, etc.
            const projectParts = parts.slice(Math.max(2, parts.length - 3));
            projectName = projectParts.join('-');
        } else {
            projectName = parts[parts.length - 1] || 'Unknown';
        }
    }

    return { name: projectName, fullPath };
}
