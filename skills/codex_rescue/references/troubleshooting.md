# Troubleshooting — symptom → check → fix

## Codex can't read files and answers that it couldn't read the request (Windows)

`.log/<stamp>_stderr.log` repeats:

```
windows sandbox: helper_sid_resolve_failed:
  resolve SID for offline user CodexSandboxOffline failed:
  LookupAccountNameW failed for CodexSandboxOffline: 1332
```

`1332` = `ERROR_NONE_MAPPED` — the local account Codex isolates with doesn't exist. `[windows] sandbox = "elevated"` isolates with the `CodexSandboxOffline` account; when `~/.codex/.sandbox/setup_marker.json` claims setup is done, Codex doesn't recreate the account and only looks up its SID. Then **nothing can be read, whatever `-s` is.**

- Fix: set `sandbox = "unelevated"` in the global `~/.codex/config.toml` (back it up first). Recreating the account needs admin rights; don't restore the marker — it is the false "the account exists" claim that caused this.
- Linux servers are unaffected (seccomp / landlock).
- `send.sh` passes `-c windows.sandbox=unelevated` as a safety net, so this skill keeps working even if it recurs.

## `apply_patch` fails even to create files: `Failed to write file ...` (Windows only)

With `-s workspace-write` even **adds** fail every time, and retrying doesn't help. The sign is **asymmetry** — in the same project only **certain subfolders** fail while the root or `node_modules` work.

**Cause: that folder's Owner is `BUILTIN\Administrators`.** Not the ACL — it fails even with Modify granted in `FileSystemRights`; the owner field itself is the cause.

```powershell
Get-Acl -LiteralPath "<suspect folder>" | Select-Object Owner
```

`BUILTIN\Administrators` ⇒ this case. A normal folder shows `<computer>\<user>`.

- Fix (admin rights, UAC):
  ```
  takeown /F "<folder>" /R /D Y
  icacls "<folder>" /reset /T /C
  ```
  Verified: `apply_patch` succeeded at the same path afterwards (codex-cli 0.145.0 · `[windows] sandbox = "unelevated"`).
  🔴 **Know what these two lines change.** `/R` and `/T` recurse into everything below, and `icacls /reset` resets explicitly set DACLs to inherited ones — hand-set permissions in that folder are lost. The diagnosis points at the owner alone, but the fix is broader, so success doesn't prove the owner was the only cause. `takeown` alone (without `icacls`) is untested. For a folder whose permissions matter, back them up with `icacls <folder> /save` first.
- 🔴 **Ruled out by controlled experiments — don't suspect them again:** spaces in the path · `.gitignore` · directory depth · junctions. It reproduced even with every space removed from the workspace name.
- Why the owner had changed is unknown (probably a tool once run as admin; not confirmed).

## An existing `C:\tmp` can also block `apply_patch` (openai/codex#30712)

Not the cause above, but as prevention the global `~/.codex/config.toml` can carry the following (back it up first, e.g. `~/.codex/_backup_<date>_repair/config.toml.bak`). With `RUST_LOG="codex_sandboxing=trace"` the writable roots shrink from `[workdir, $TMPDIR]` to `[workdir]`.

```toml
sandbox_mode = "workspace-write"     # a top-level key, above every [section]

[sandbox_workspace_write]
exclude_slash_tmp = true
exclude_tmpdir_env_var = true

[windows]
sandbox = "unelevated"
```

## The response was saved as `author: codex-via-stdout`

The plumbing worked but Codex couldn't write the file — the sandbox issue above or a path permission (on Windows, check the folder-owner item first; that item is Windows-only). Read the content to tell a failure report from a real analysis.

## The response was reported as `stale`

The response file is byte-identical to before the run: **Codex wrote nothing this run; the file is an older result.** Don't take it for this run's, and don't overwrite or delete it — ask the user.

## The watcher reported `STALE`

`codex_rescue watch: STALE — <stamp>` means `send.sh` has not finished (no `.log/<stamp>[_t<N>]_launch.exit`) and its sign of life — `.log/<stamp>_heartbeat`, else the lock `.log/.<stamp>.lock`, else `_status.json` — hasn't changed for over 30 seconds, seen twice in a row (the same 30 seconds the progress panel uses for "not responding"). The run was probably killed hard (Task Manager, `kill -9`, a crash, the machine sleeping); a hard kill skips `send.sh`'s signal handler, so the status still says `running` and the lock stays. Rarely it is alive but stalled — the heartbeat only starts after the pre-run file snapshot, so a very slow snapshot can look like this.

- Tell the user, with the paths the watcher printed (`_status.json`, `_events.jsonl`, `_launch.err`). **Don't rerun it yourself** — rerunning is the user's call.
- If the user wants to keep waiting, run the same watch command again.
- If the user wants it run again, check that no `codex` process is left for it, then delete the lock `.log/.<stamp>.lock` and launch again (results.md "RESUME"). Until then the launcher refuses the stamp as "already running".
- The session-start hook does not list a run the watcher already reported as `STALE` again — the user has been told once. If that run later finishes after all (an exit mark appears), the hook lists it once as "finished after the watcher reported it stalled — result not received yet"; watch it and hand the result over.

## Re-arming after a reload, resume or compaction

A window reload or a context compaction ends your background watcher, but not the detached run. When a session starts, resumes, is cleared or compacted, the plugin's `SessionStart` hook (`scripts/reattach.mjs`) reads this conversation's run ledger (`<home>/.claude/codex_rescue/runs/<session id>/`) and lists every run whose latest launch has no exit mark and no `_reported` mark, or has an exit mark but no `_reported` mark or a `_reported` that says `stale` (the result never reached you). For each, run the watch command it gives with `Bash(run_in_background: true, timeout: 7200000)` and handle the result by results.md. It never relaunches anything. Runs started before the launcher existed (no `_launch.*` files) are not listed. The hook prints nothing when there is nothing to re-arm, and stays silent on any error — if you expected a run in the list, re-arm it by hand: `node "${CLAUDE_SKILL_DIR}/scripts/wait-run.mjs" --root <project root> --stamp <stamp> [--turn <N>]`.

## The launcher refused, or returned right away

- `send.sh ended right away — … exit <code>. Nothing is running.` — `send.sh` stopped before starting (no `CR_CONFIRMED`, the EDIT gate, a bad request or follow-up file, not a git repository for a review). The launcher shows its stderr and stdout as they are and exits with its code. Fix what it says and launch again — there is nothing to watch.
- `the same stamp (<stamp>) is already running` — the lock `.log/.<stamp>.lock` exists. If it really runs, watch it with the printed command. If it is left over from a killed run (old lock mtime, no `codex` process), see "The watcher reported STALE" above.
- `bash not found` — pass `--bash "$BASH"` from the bash you are running (on Windows Git Bash, `cygpath -w "$BASH"` also works).
- `send.sh has not taken its lock after 30s` — it was started but is still checking (a slow disk); watch it as usual.

## Network on Windows

The Windows (unelevated) sandbox blocks the network through **proxy environment variables**. Programs that ignore proxies (e.g. Node's default `https`) still get through with `CR_NETWORK=false` — **never treat the network block as a security boundary.** Also, `curl.exe` may fail HTTPS inside the sandbox (`SEC_E_NO_CREDENTIALS`) even when the network is open; judge with plain http or node instead.

## Limits of change detection — what it can't catch

"No changes outside the response file" means **no final-state difference within the watched scope.** These pass unnoticed; never claim beyond that:

- inside the excluded folders — `.git`, `node_modules`, `build`, `.gradle`, `.dart_tool`, `.venv`, `.next`, `__pycache__` (a deliberate trade-off for speed; `.git` internals included)
- files created and deleted during the run
- existing files changed with their mtime restored (`find -newer` only looks at mtime; **new** files are still caught by the path-list difference)
- a file deleted and recreated at the same path with the same mtime
- delayed changes by child processes Codex left behind after `codex exec` returned
- directories and metadata — empty directories, permissions/ACLs, NTFS ADS, symlinks/junctions
- file names containing newlines (line-based processing splits them)
- attribution — OneDrive sync or other processes can't be told apart from Codex; compare with `.log/<stamp>_events.jsonl`

The threat model is "a Codex that ignores the prompt", not deliberate concealment such as restoring mtimes. To rule out writes entirely, use `CR_SANDBOX=read-only`: Codex gets no write access and the script saves the `-o` final message as the response — no code change, only the variable.

🔴 `CR_SANDBOX=danger-full-access` is never used: detection runs `find .` inside the cwd, so it can't see writes outside the cwd while still printing "no changes" (the report warns if it is used).
