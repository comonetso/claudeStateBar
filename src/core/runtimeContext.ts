// Provider-neutral runtime flag. True only when this extension instance itself runs on a
// remote host (e.g. extensionKind=workspace over Remote-SSH). With extensionKind=["ui"]
// (our setting) the extension always runs on the local VS Code UI host even if the
// workspace is remote — so audio works fine and this stays false. Set once in activate().
let runsOnRemote = false;

export function setRunsOnRemote(v: boolean): void {
    runsOnRemote = v;
}

export function getRunsOnRemote(): boolean {
    return runsOnRemote;
}
