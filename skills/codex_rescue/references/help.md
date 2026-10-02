# help — in HELP mode print this and nothing else

Print the block below **translated into the user's language** (keep commands, paths and variable names as they are; the command examples may use the user's own phrasing). Then add one line: "To ask right away, just type `/codex_rescue`." On an old-style install, the notice from preflight.md goes at the end.

```
codex_rescue — get a second view from Codex when Claude is stuck (fully automatic)

[What]    I (Claude) write the problem I'm stuck on into a request file → call the codex CLI directly
          → Codex reads and analyzes it and saves a response file → I pick it up automatically, review it and decide what to apply
          ★ No pasting, and no need to tell me "it's done". Hands off.

[Round trip]
          1. Claude → writes docs/codex_rescue/<stamp>_request_<slug>.md
          2. Claude → starts send.sh detached from my own command (calls Codex) and watches it in the background
          3. Codex  → reads the request, analyzes → saves <stamp>_response_<slug>.md
                      (if saving is blocked, the script recovers the final message with -o and saves it)
          4. Claude → wakes up automatically when Codex ends, reads and reviews the response → reports what to apply
          You can keep giving me other work while it runs.
          ★ A long run isn't cut by my 2-hour command limit or by reloading the window — only my watcher is,
            and I re-attach to it (after a reload or compaction, automatically).
          ★ You can also interject while it runs — see [Interject].

[Safety]  Codex doesn't change code (except in edit mode) — that would break my context.
          It can write files, though, so send.sh checks the file system and forces a report of anything
          changed besides the response file. If that premise was broken I report it to you and wait for
          your decision — I never revert on my own.

[Key]     The request carries **real paths to the original data and an instruction to open them**.
          My hypothesis comes late and short — up front it would trap Codex inside my view.
          ★ Symptoms you confirmed with your own ears or eyes (stutter, flicker, how often it happens): **I'll ask you.**
            They are in no code or log — only you know them — and without them the analysis is half done.

[Follow-up] It isn't one-shot. After reviewing Codex's answer I can **ask again.**
          If I read it too narrowly, Codex corrects me (up to 11 turns). The same failure went unsolved
          through three one-shot questions and was solved in a long back-and-forth — that structure is built in.

[Commands] ★ Just say it. I understand meaning, not fixed keywords.
  /codex_rescue                          ★ most common. I identify what's stuck myself
  /codex_rescue analyze it · consult     Codex refutes my hypothesis           (no code changes)
  /codex_rescue review it                Codex reviews the changed code        (no code changes)
  /codex_rescue review it, focus on auth ↑ + where to focus
  /codex_rescue analyze and fix it       Codex edits the code directly         (I confirm once first)
  /codex_rescue talk with codex          ★ ping-pong — ask short, get short    (about 10 s)
  /codex_rescue ask again                ★ follow up on the last analysis (check my reading)
  /codex_rescue <request path>           review it if answered, rerun it if not
  /codex_rescue help                     this help

[Interject] ★ Say something while an analysis runs and it goes to Codex as you said it.
          Codex keeps its work and takes it in (it doesn't start over).
            You: "oh, that file is on the server too"
            → I pass it on as is → Codex continues with that fact
          ★ No need to switch it on — analyze · review · fix always have it (it can't be switched on after start).
          ★ If it's unclear whether you're talking to me or to Codex, I'll ask in one line.
          ★ A finished analysis can't take it — that is "ask again" (follow-up).
          ★ Interjecting during a fix doesn't undo files already changed; it applies from then on.
          ★ Ping-pong doesn't have it.

[Ping-pong] "talk with codex" switches to short round trips. Unlike the round trip above
          (request → analysis → document), it happens **right here in the chat**:
            ✳️ Claude: <what I asked>
            🔷 Codex: <the answer as is>
          Both sides show, so you can judge as it goes.
          Record: <project root>/docs/codex_rescue/<stamp>_chat_<slug>.md
          ★ Calling from a subfolder continues the same file (same slug, same conversation).
          Not shown in the Codex progress panel (that is for watching long-running jobs).
          ★ Heavy questions are slower — heavy ones belong in "analyze" (a full consult).
          ★ File exploration is blocked by default, and it stops itself after 60 seconds.

[Review]  "review it" works on the git diff — **only in git repositories**.
          - uncommitted changes → reviews those
          - clean working tree   → compares with the default branch (main etc.)
          - for a specific base just say it: "review against main" / "review just this commit"
          ★ The request is generated automatically; the criteria are Codex's official review rubric.
          ★ If a limit cuts it, the points found so far remain, and you can follow up on the result.
          ★ "review the old way" runs Codex's dedicated review (no interjecting, partial saves or follow-ups).

[Fix follow-up] After a fix, "fix this too" continues the same conversation. ★ I confirm once per turn.

[Files]   docs/codex_rescue/  (created if missing; ping-pong uses the project root, everything else the current folder)
          260726_014119_request_mms-jar-encoding.md    ← written by Claude (review requests are generated)
          260726_014119_response_mms-jar-encoding.md   ← written by Codex (same stamp and slug)
          260726_014119_edit2_mms-jar-encoding.md      ← edit record of fix follow-up turn 2
          260726_014119_review_auth-refactor.md        ← result of an old-way review (no request)
          .log/260726_014119_events.jsonl              ← full record of what Codex actually did

[Limits]  Before calling I check Codex's limits and ask three things at once: the model and the reasoning level
          (your Codex config is the recommended first choice) and how deep Codex should dig (shallow / normal / deep,
          my pick first). If that combination once used more than today's share of the limit, I warn you.
          To stop, type "stop" in Other. If a limit cuts a run midway, what Codex **wrote down while investigating** remains.

[Env]     CR_MODEL=<model>     Codex model          CR_EFFORT=<level>   reasoning level
          CR_SANDBOX=<mode>    permission level
          CR_ALLOW_EDIT=1      unlock edit (after approval)   CR_DRYRUN=1   check without running
          CR_LIVE_STEER=1      interject path (default for analyze · review · fix · follow-up; without it, the old way)
          CR_CONFIRMED=1       marks that the pre-run check was answered (runs are refused without it)
          CR_GROUP=<name>      group name for runs started together (one group card in the progress panel)
```

## All environment variables (reference — print only if asked)

| Variable | Meaning |
|---|---|
| `CR_MODEL` · `CR_EFFORT` | Codex model and reasoning level (from §2-1) |
| `CR_CONFIRMED=1` | the pre-run question was answered; required for runs and CHAT `--start` |
| `CR_ALLOW_EDIT=1` | unlocks EDIT and EDIT follow-ups, after approval only |
| `CR_LIVE_STEER` | `1` = live-steer path (default for CONSULT · EDIT · REVIEW · FOLLOWUP); `0` = old exec path |
| `CR_SANDBOX` | Codex sandbox; REVIEW and FOLLOWUP are fixed to read-only. Never `danger-full-access` |
| `CR_WIN_SANDBOX` | Windows sandbox mode override |
| `CR_NETWORK` | network allowed by default under workspace-write; `false` blocks it (proxy-based on Windows — troubleshooting.md) |
| `CR_DRYRUN=1` | check everything without running Codex |
| `CR_GROUP=<name>` | runs started together share it; the progress panel groups runs with the same name from the same Claude conversation. A follow-up keeps its run's group |
| `CR_CONSULT_MAX_TURN` | follow-up turn limit, default 11 |
| `CR_CHAT_LIMIT` | CHAT time limit in seconds, default 60; required with `--explore` |
| `CR_CHAT_LOOK_MAX` | CHAT `--look` total size in bytes, default 65536 |
| `CR_KEEP_DAYS` | only when explicitly set, overrides both retention periods for this call (`0` = off). A set `CR_KEEP_DAYS` that is not a whole number of days, empty included, stops the cleanup with an argument error: nothing is cleaned, `_usage.json` is not rewritten and no Codex conversation cleanup starts (one line on stderr). Otherwise reads `<home>/.claude/codex_rescue/settings.json` via Node `os.homedir()` (ignores `CLAUDE_CONFIG_DIR`): `{"scratchDays":1,"logDays":7}`. Missing file/keys use these defaults; each `0` disables that target. Only nonnegative integers are valid; malformed settings skip all cleanup with one warning, even with an override. Unknown keys are ignored. The plugin only reads settings; it never creates or edits them. `logDays` also covers the Codex conversations codex_rescue's live-steering runs created on this machine (any project; CHAT and runs on the old `codex exec` route are recorded by Codex as `codex_exec`, can't be told apart from other tools' conversations, and are never cleaned or counted): after each run's cleanup, a detached `scripts/prune-codex-sessions.mjs` deletes the ones older than `logDays` in the background with Codex's official `codex delete --force` (one at a time per machine; result in `<home>/.claude/codex_rescue/codex-prune.log`). The conversation a follow-up resumes is left out, a conversation touched again since the scan is skipped, and a single delete that takes over 2 minutes is abandoned for that conversation only. Conversations other tools created and the trash are never cleaned automatically. Each run also rewrites the usage file `docs/codex_rescue/.log/_usage.json`. Clean now: `node "${CLAUDE_SKILL_DIR}/scripts/cleanup-logs.mjs" --dir docs/codex_rescue --now "scratch,log,trash,codex"` previews; add `--yes` to delete; `--lang en|ko` picks its output language (the panel passes its own). Runs in progress and runs whose result Claude has not received yet keep their files (see consult.md "Run logs") |
| `CR_TIMEOUT` | removed (didn't work on Windows); the script refuses it |
