# CONSULT / EDIT — request-based procedure (in this order)

1. **Confirm the intent** (SKILL.md §0). If the user wants Codex to fix it directly ⇒ EDIT (**get a one-line confirmation first**, below); otherwise CONSULT (default). Text left after removing the mode words is the problem to focus on.

2. **Identify the problem** — ★ being triggered with no problem text is the normal case. Don't ask the user; identify it from the conversation. What was tried and where it got stuck is recorded more precisely in your history than in the user's memory.

   Priority: ① what is stuck right now — the attempt that just failed, an unresolved error or symptom ② repeated failure — tried two or more different ways and still failing ③ where the user recently showed frustration ("still not working", "why is it doing this") ④ otherwise the latest unresolved task of this session.

   With two or more candidates, **don't stop** — take the highest priority, and after writing the request say in one line: "I wrote it about `<problem A>`. Tell me if you meant something else." Only if nothing at all is stuck, ask what to ask about.

   Fill in **your own hypothesis** as well — what you think the cause is and what you tried is your history. Write it yourself; don't ask the user.

   ### Exception — always ask for what exists only in the user's senses

   "Don't ask" is right only for **code, logs, DBs and your own history** — you read those faster and more accurately. **Physical-world observations are the opposite** — no search will find them; they exist only in the user's ears, eyes and memory.

   > One-line test: is the original of this information in the file system, or in the user's senses? In a file ⇒ open it. In the senses ⇒ **ask, or you will never get it.**

   | What | Where the original is | How |
   |---|---|---|
   | code · error text · logs · file locations · versions | file system | **read it.** Don't ask |
   | what was tried and why it failed | your conversation history | **write it.** Don't ask |
   | cause hypotheses | yours | **form them yourself.** Don't make the user diagnose |
   | **direct observation** — something heard or seen | **the user's senses** | 🔴 **ask** |
   | **felt frequency / reproduction rate** — "about three in ten" | **the user's memory** | 🔴 **ask** |
   | **contrast observation** — two paths observed separately and compared | **the user's senses** | 🔴 **ask** |
   | **directions already tried and rejected** (in other sessions, at work) | **the user's memory** | 🔴 **ask** |

   Ask only when at least one of these holds; otherwise don't:
   - the symptom was reported **through human senses** (sound, screen, calls, printing, perceived speed, vibration, heat)
   - **measurements and the user's experience disagree** ← the gap itself is the key clue
   - the user already said "I listened", "I tried it", "it feels like" → dig around that remark

   🔴 **Not for build failures, compile errors, test failures, refactors or config errors** — all of that is in files; asking there only interrupts.

   Keep it from becoming a barrage:
   - **One batch, once.** 3–5 questions. Never a second round
   - **Don't ask from a blank page.** Fill in what you know first: "This is how I understood it — is that right? Please fill in only these"
   - **Proceed without an answer.** "Don't know" / "just do it" ⇒ write `미확인` (unconfirmed) in that slot and send. This must never become a gate
   - Put the answers into the request **verbatim**. Summarizing kills the information

   > Evidence: a case that stayed unsolved after three requests carrying only metrics turned around as soon as one line of the user's felt reproduction rate was added. The metric said 0.2%, the user felt 30% — **the user was right.** That number was in no code, log or DB; only asking got it.

   **2-1. Pre-run confirmation** — `${CLAUDE_SKILL_DIR}/references/preflight.md`. If the sensory question above also applies, ask both in the same message.

3. **Stamp** — actually run `date "+%y%m%d_%H%M%S"`. Never guess.

4. **Directory** — `mkdir -p docs/codex_rescue`.

5. **Gather the material** for the problem from step 2. **This order is the order of the request.**
   - **What the user observed directly** ← first, if there is any. Verbatim. Don't mix in your interpretation
   - **Measurements** — if any. If they disagree with the observation, **write down that they disagree**
   - **One representative case + one normal control** — if any. Better than summary statistics
   - **Sources that can be opened right now** ← **absolute paths** of logs, recordings, dumps, DB rows
   - **Symptom** — what diverges, and how
   - **Your current hypothesis and its basis** — something to review, not a starting point. **Short**
   - **Failure history in 3 kinds** — hypothesis refuted / analysis method failed / not enough data
   - **Environment** — language, framework, versions, devices, toolchain

   🔴 **Verify each source path exists** (`ls` / `find`) before listing it. A missing path makes Codex end with "file not found". A case with no observed symptom (a build failure etc.) folds the first three into one line: `해당 없음` (n/a).

6. **Actually Read the relevant code and quote it** — no guessing. The request alone should be enough to judge from.

   🔴 **But never copy source data into the request.** Give the path and let Codex open it — once you summarize it, it is data **seen through your eyes**, and the reason this skill exists is gone. Quotes are a starting point; **the original is canonical.** Always say where the original is.

   🔴 **Never reintroduce "write it self-contained".** That wording made Codex treat the request as the edge of the world: it listed a recording on a server with `find`, never opened it, and ended with "send more data". (`workspace-write` can read the whole disk.)

7. **Write the request file** from `${CLAUDE_SKILL_DIR}/references/request-template.md`. Put the **complete real path** in frontmatter `response_path` — `send.sh` reads it and stops without it. `subject` is a one-line title of about 20 characters, in the user's language; the Claude State Bar progress panel shows it as the card title (without it the card shows the slug).

8. **Launch `send.sh` detached, then watch it** — this is the handoff. Never make the user paste anything.

   ```
   ① Bash (synchronous — returns within seconds):
     CR_CONFIRMED=1 CR_LIVE_STEER=1 node "${CLAUDE_SKILL_DIR}/scripts/launch.mjs" --bash "$BASH" docs/codex_rescue/<stamp>_request_<slug>.md
   ② Bash(run_in_background: true, timeout: 7200000):
     <the watch command ① printed, exactly as printed>
   ```

   - Prefix the values chosen in §2-1 ④ (only those differing from the current settings): `CR_MODEL=<model> CR_EFFORT=<level> CR_CONFIRMED=1 CR_LIVE_STEER=1 node …`.
   - 🔴 **Never drop `CR_LIVE_STEER=1`.** Without it the run goes through the old `codex exec` and **can't be steered** mid-run. Drop it only when the user asked for "the old way".
   - **EDIT the same way** — after approval: `CR_CONFIRMED=1 CR_ALLOW_EDIT=1 CR_LIVE_STEER=1 node …`. While it runs, something like "leave that file, fix only this" can be passed via steer.md.
   - **If ① says `send.sh ended right away`**, nothing is running: the output is `send.sh`'s refusal (missing `CR_CONFIRMED`, the EDIT gate, a bad argument) and the exit code is `send.sh`'s. Handle it as that refusal says; don't start a watcher.
   - **If ① says the same stamp is already running**, don't launch again and don't delete the lock — watch it with the command it printed.
   - **Always `run_in_background: true, timeout: 7200000` for the watcher.** The default background limit is 30 minutes and the maximum 2 hours; they end only the watcher, never the run. The watcher ends by itself before 2 hours with `⏳ still running — re-arm: <command>` — run that same command again the same way. **Never launch the run again.**
   - Right after ①, post only the short output (SKILL.md §3). If you picked the problem yourself, say which in one line.

   **Confirm that live steering is on.** The run's stderr goes to `docs/codex_rescue/.log/<stamp>_launch.err`; read that file once shortly after launching (the line comes after the pre-run file snapshot, usually within seconds). This line must appear:

   ```
   → running on the live-steer path (app-server) — conversation key: <stamp>
   ```

   **If it is missing, the run went the old way.** Tell the user as soon as you notice — nothing they say mid-run can be passed on.

   - The live path needs Node's **global WebSocket**: built into Node 22 / 24 · Node 20.18 / 20.19 need `--experimental-websocket` · Node 18.20 can't. `send.sh` **measures the capability, never the version string** (backports differ per distribution) to decide on the flag; if nothing works it falls back to the old exec path and says so on stderr (`<stamp>_launch.err`). Relay that warning — **tell the user up front that this run can't be steered**. If `scripts/live-consult.mjs` is missing, `send.sh` stops with that reason — reinstall the skill.
   - Exit codes and what to do on failure: results.md "Failure".

## Artifacts

| Item | Rule |
|---|---|
| Directory | `docs/codex_rescue/` — **relative to the current working directory** for CONSULT · REVIEW · EDIT; **CHAT uses the project (git) root** (chat.md). Never hard-code absolute paths (used across projects and machines) |
| Missing | `mkdir -p docs/codex_rescue` — create it without asking |
| Stamp | `ymd_His` (e.g. `260726_014119`) — **only from running `date "+%y%m%d_%H%M%S"`. Never invent a time** |
| Slug | English kebab-case, 2–4 words (e.g. `mms-jar-encoding`, `fcm-token-null`) |
| Request | `docs/codex_rescue/<stamp>_request_<slug>.md` — **you write it** (CONSULT · EDIT; REVIEW's is generated by `send.sh`) |
| Response | `docs/codex_rescue/<stamp>_response_<slug>.md` — **Codex writes it** (`send.sh` does when Codex couldn't). Same stamp and slug as the request |
| Run logs | `docs/codex_rescue/.log/<stamp>_events.jsonl` (every Codex event, **written live**) · `_status.json` (progress) · `_heartbeat` (every 5 s) · `_last_message.md` · `_stderr.log` · from the detached launch (SKILL.md §3): `_launch.out` (`send.sh`'s stdout — the report) · `_launch.err` (its stderr) · `_launch.exit` (its exit code, written once it has fully ended) · `_reported` (the watcher handed the result over); a follow-up turn N uses `<stamp>_t<N>_launch.*` and `<stamp>_t<N>_reported`. `.log/` gets a `.gitignore` (`*`) and is never committed. Each trigger reads `<home>/.claude/codex_rescue/settings.json` via Node `os.homedir()` (ignores `CLAUDE_CONFIG_DIR`): `{"scratchDays":1,"logDays":7}`. Missing file/keys use defaults; each `0` disables that target; only nonnegative integers are valid. Unknown keys are ignored. Explicit `CR_KEEP_DAYS` overrides both periods; malformed settings skip all cleanup with one warning even with an override. A set `CR_KEEP_DAYS` that is not a whole number of days, empty included, stops the cleanup with an argument error: nothing is cleaned, `_usage.json` is not rewritten and no Codex conversation cleanup starts (one line on stderr). The plugin never writes settings. With log cleanup enabled, a finished (`done`) run's `_appserver.jsonl` goes right away; other logs age by the stamp group's newest modification. Workbench: `docs/codex_rescue/.scratch/<stamp>/`, aged by its newest nested modification. Locked/current run folders are protected; other old folders and legacy shared items are cleaned even while another run is alive (`.gitignore` stays). Codex conversations: with valid settings, `logDays > 0` and not a dry run, the cleanup ends by starting `scripts/prune-codex-sessions.mjs` detached (the run never waits for it). It deletes, oldest first and one at a time per machine (lock `<home>/.claude/codex_rescue/.codex-prune.lock`), the Codex conversations codex_rescue created on this machine (session file's first line has `originator` `claude-state-bar-live-consult` — live-steering runs only; CHAT and runs on the old `codex exec` route are recorded by Codex as `codex_exec`, can't be told apart from other tools' conversations, and are never cleaned or counted; any project) whose file is older than `logDays`, only with Codex's official `codex delete --force <id>` — never by deleting files. A parent's deletion takes its sub-agent conversations with it, so sub-agents are never deleted on their own. The conversation a follow-up is resuming is left out (`send.sh` passes it as `--keep-thread`, which becomes the prune's `--skip-thread`); each candidate's modification time is checked again right before its delete, so one resumed meanwhile is skipped; a single delete that takes over 2 minutes is abandoned for that conversation only and its leftover `codex delete` process is killed. Result: `<home>/.claude/codex_rescue/codex-prune.log` (overwritten). A case whose Codex conversation is gone can no longer be followed up. Requests, responses, trash and conversations other tools created are never touched automatically. Every cleanup (even one skipped for malformed settings; not a dry run) rewrites `.log/_usage.json`: `{schema:1, computed_at, root, items:{scratch,log,trash,codex:{bytes,count}}, clean:{script,dir}}` — `codex` is this project's rescue conversations (`cwd` = root) plus their sub-agents. Clean now (what the VS Code panel's clean button runs): `node <clean.script> --dir <clean.dir> --now "<scratch,log,trash,codex>" [--yes] [--lang en|ko]` — without `--yes` it only previews; with it, it deletes every chosen item regardless of age, keeps what belongs to in-progress (locked) runs and to runs whose result has not been handed to Claude yet (the latest turn's `_launch.exit` exists but its `_reported` is not `done`), skips `codex` when the conversation id of any kept run (in progress, or finished with its result not handed over yet) isn't in its events file yet, or when the machine lock is held, empties trash but keeps the folders and their `.gitignore`, and rewrites `_usage.json`; unknown item names exit 2. `--lang` (default `en`) is the language of its output, which a person reads in the terminal; the panel passes its own language. For a valid `CLAUDE_CODE_SESSION_ID`, non-CHAT, non-dry runs atomically write `<home>/.claude/codex_rescue/runs/<session>/<stamp>_<root-hash>.json` to attach the run to its Claude conversation; ledger files age by `logDays` and empty session folders are removed. Full rules in `scripts/cleanup-logs.mjs`'s header |

**You choose the response file name and put it into the request's `response_path`.** Letting Codex name it breaks the pair (invented stamps, mismatched slugs).

## EDIT confirmation and gate

Before an EDIT run, get one line of confirmation: "Codex will edit the code directly — changes I don't know about will break my context. If you have uncommitted work, commit it first. Go ahead?" Intent detection can misfire and code changes are costly to undo. After the run, check the changes yourself with `git diff` and record them in the response file.

🔴 `send.sh` **refuses EDIT by default**; run it only after approval:

```bash
CR_CONFIRMED=1 CR_ALLOW_EDIT=1 CR_LIVE_STEER=1 node "${CLAUDE_SKILL_DIR}/scripts/launch.mjs" --bash "$BASH" <request>
```

(then watch it as in step 8 ②)

**Never add `CR_ALLOW_EDIT=1` without approval** — adding it means "the user approved"; without that, the gate is pointless.

## Security

- Never put PATs, API keys, tokens, passwords or private notes into a request. File paths, function names and versions are fine; mask secret values found in code as `<REDACTED>`.
- The request goes out to Codex **and is committed to git** — keep out anything that must not leak.
- **Codex may read credentials** (user decision). It may read them and connect, on the condition that it **never leaves values in the response, `.scratch/` or command output**. So for DB rows in a request, write a command that **uses the value without revealing it** (e.g. `node -r dotenv/config …`) instead of the password. When reviewing a response, check for leaked secret values; if there are any, tell the user before committing.
- Don't ask another Claude session (e.g. a peer on a server) to run codex_rescue for you — the response would stay on that machine and you would only get its stdout. Ask it for facts and consult Codex locally. A user running codex_rescue directly on a server is fine.
