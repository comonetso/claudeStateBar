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
