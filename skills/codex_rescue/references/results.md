# Results — review, completion gate, end decision, RESUME, response file, failures

## 9. Automatic wake-up → review

When the run ends, the watcher (`scripts/wait-run.mjs`, SKILL.md §3) ends too and you are **woken automatically** with its output; the user doesn't need to tell you. It starts with `codex_rescue watch: finished — <stamp>[_t<N>] · send.sh exit <code>`, then `send.sh`'s stderr, then **`send.sh`'s report (its stdout)** — read the report as before. Other ways the watcher ends:

- `⏳ still running — re-arm: <command>` — not a result. Run that same command again with `Bash(run_in_background: true, timeout: 7200000)`; never launch the run again.
- `codex_rescue watch: STALE — …` — no result and no sign of life (troubleshooting.md "The watcher reported STALE").

A watcher you re-armed after a reload (the session-start hook's list) may print a result you already had before the reload — it prints the finished report again every time it is run. Review it once.

Then:

1. If the report has 🔴 **changes outside the response file**, **report them to the user first** — the skill's premise broke, and that comes before the review. **Never revert them yourself** — the user decides.
   (`🧪 N item(s) left in the Codex workbench` is **normal** — investigation traces in `.scratch/`, not a violation. `🧹 old records cleaned up …` is **normal** too — old records unrelated to this run were cleaned; relay it in one line. `⚠️ … items could not be deleted` is retried next time; mention it only if the same item keeps appearing.)
2. Read `response_path`. **Never edit Codex's text.** Append a `## Claude 검토` section at the end.
3. It is done only after passing the **completion gate** below. Otherwise don't report it as done.
4. Report the review (adopt / hold / reject, each with its reason, and the plan to apply) and get the user's decision.
5. If there is no response file, read `.log/<stamp>_events.jsonl` and `_stderr.log` and report the cause to the user.
6. **`⚠️ partial save arrived` means it isn't finished.** The response frontmatter has `status: partial` and `stop_reason` — `limit` (usage-limit traces) · `interrupted` (stopped by a person or signal — exit 130, or the turn-aborted event in the rollout) · `other` (unknown).
   - Trust only the plan and the confirmed facts; a conclusion section may be half-written
   - Write `미완성 — <stopped value>` as the first line of `## Claude 검토` and sum up what is confirmed and what remains
   - Report to the user: the cause (`stop_reason`), what is confirmed, what remains. Unless it is `limit`, don't call it a limit problem
   - **The user decides whether to continue.** If so, once the limit resets, send a follow-up (followup.md) saying "continue the remaining items of your investigation plan". Follow-ups are read-only, so that turn has no partial saves — if it is cut again, nothing of it remains
   - Continuing a limit-cut turn hasn't been done for real yet; the first attempt is the first verification

## Completion gate — judged from the execution log, not self-report

**Don't trust "I opened it directly" in the response.** `.log/<stamp>_events.jsonl` records every command Codex ran. Measure with it:

```bash
L=docs/codex_rescue/.log/<stamp>_events.jsonl
# ① how many commands were run
grep '"type":"item.started"' "$L" | grep -c '"command_execution"'
# ② the commands in full
grep '"type":"item.started"' "$L" | grep '"command_execution"' \
  | sed -E 's/.*"command":"//; s/","aggregated_output.*//'
# ③ did each item of the request's source table appear in a command — repeat per item
grep '"type":"item.started"' "$L" | grep -c '<file name or case ID>'
```

🔴 **Only `item.started` lines.** Grepping the whole file matches everything: the command that read the request carries **the whole request** in its `aggregated_output` (false positives).
🔴 **Never grep by full path.** Path separators inside commands are JSON-escaped (`\\\\` on Windows). Search **distinctive tokens** only — a file name or case ID.
🔴 **A file name appearing in a command doesn't prove it was read** — `echo <file>` passes, and opening via variables or globs isn't caught. Check **both**:

1. **The command actually finished** — `item.completed` with `exit_code: 0`
2. **The response contains values that could only come from that source** — numbers, comparison results, `.scratch/` output paths

| Measured | Verdict |
|---|---|
| 0 `command_execution` | ❌ **opened nothing, only reasoned** |
| **no** item of the source table appears in any command | ❌ **sources not opened** |
| only `ls` / `find`, no actual reading or computing command (`cat`, `python`, `node`, `ffprobe` …) | ❌ **only listed them** |
| commands exist but **no value from that source in the response** | ❌ **said it opened them, didn't use them** |
| an item of the request's source table appears under "data not accessible from this machine" | ❌ **escape-hatch abuse** |
| all of the above passed | ✅ the sources were seen → end decision below |

🔴 **Never pass on a response that only says "more measurement is needed".** If sources you can open remain, **open them yourself** — that is the point of this gate.

## 10. End decision — top to bottom; the first matching row decides

🔴 **Don't agonize** over "is there more to ask" — that is what drags the round trips out. Scan the table **in order** and stop at the first matching row.

| # | Condition | Action |
|---|---|---|
| 1 | the turn limit is reached (`CR_CONSULT_MAX_TURN`, default 11) | **end.** Raise the remaining issues to the user |
| 2 | **no new information** compared to the previous turn (the same things rearranged) | **end.** More asking won't produce it |
| 3 | the log verdict above is ❌ but **you can open it yourself** | **don't follow up — open it yourself.** It's faster |
| 4 | one of the **follow-up reasons** below applies | follow up (followup.md) |
| 5 | anything else | **end.** Go to adopt / hold / reject |

🔴 **Row 5 is the default.** A follow-up is an exception that needs a reason.

Follow-up reasons — only these three:

| Reason | Why |
|---|---|
| **the key symptom isn't explained** | the very reason for asking is unresolved |
| **you rejected a Codex point but couldn't confirm your rejection with code or logs** | your rejection may be wrong, and **Codex doesn't know it was rejected** |
| **the response has a plain factual error** | everything built on it becomes shaky |

⚠️ "Codex agreed with my hypothesis" is not a reason — agreement isn't weakness.
⚠️ **One follow-up is the default.** A second or more only with **new information** (a user observation, new logs, a new measurement). Turns don't produce the answer; **new information** does.
⚠️ The turn limit of 11 doesn't mean "11 turns will solve it" — it is a hard safety cap taken from a real multi-turn case. The end table decides almost always before it; reaching it signals "this isn't a problem for more Codex calls".

## RESUME — the argument is a request file path

Don't write a new request; this reruns an existing one. (`_followup<N>_` and `_response_` arguments: SKILL.md §0.)

1. Read that path. If it doesn't exist, list similar names in `docs/codex_rescue/` and stop.
2. Read frontmatter `response_path`.
3. **The response exists** ⇒ read it, review and report (as §9).
4. **Not yet** ⇒ first check it isn't still running: if `.log/.<stamp>.lock` exists, or `.log/<stamp>_launch.out` exists without `.log/<stamp>_launch.exit`, **don't rerun** — watch it with `node "${CLAUDE_SKILL_DIR}/scripts/wait-run.mjs" --root <project root> --stamp <stamp>` (SKILL.md §3 step 2). Otherwise rerun it (preflight.md, then consult.md step 8 — the detached launch). If `.log/<stamp>_stderr.log` or `.log/<stamp>_launch.err` exists, read it first — **understand the last failure and don't repeat it.** Relaunching the same request replaces its old `_launch.*` files.
5. Don't dump the request into the chat — the file is canonical.

RESUME of a `mode: edit` request carries EDIT's risk — the EDIT gate applies.

## Response file — Codex's text and your review stay apart

Whether Codex saved it or `send.sh` saved the final message for it, the final shape is the same:

```markdown
---
type: codex_response
mode: <readonly|edit>
stamp: <same as the request>
slug: <same as the request>
author: <codex | codex-via-stdout>
---

# Codex 응답 — <title>

## Codex 원문
(as received — no summarizing or polishing; raw material for later review)

## Claude 검토     ← appended later by you
- adopt / hold / reject, each with its reason
- if Codex rejected your hypothesis, the result of re-checking that with code
- the actual plan
```

**`send.sh` adds these frontmatter fields — never edit them by hand:**
- `thread_id` — the Codex session. **The conversation's lifeline**: if it is empty, follow-ups break
- `origin` — the machine that started it. Documents travel between machines via git; Codex sessions don't
- `turns` — the number of turns so far; the check for the next follow-up's `turn`
- `status: partial` · `stopped: exit <code>` · `stop_reason: limit|interrupted|other` — only on a partial save (§9 step 6)

A multi-turn document grows like this:

```
## Codex 원문              ← turn 1 (Codex)
## Claude 검토             ← yours · **the next turn's input**
## 🔁 2턴 — Claude 반박    ← send.sh inserts the follow-up body
## 🔷 2턴 — Codex 재답변   ← send.sh inserts the -o capture
## Claude 검토 (2턴) …
```

🔴 **Never edit Codex's text; the review always goes in new sections below it.** Mixing them loses "what Codex actually said". Codex reads your review in the next turn, so write it carefully.

- `author: codex-via-stdout` ⇒ **Codex couldn't write the file.** Check `.log/<stamp>_stderr.log` — the content may itself be a "couldn't read the request" failure report, in which case there is nothing to review. **"Arrived" isn't "succeeded"** — always read the content.
- Reported `stale` ⇒ the response is byte-identical to before the run: **nothing was written this run; the file is an older result.** Don't take it for this run's, and don't overwrite or delete it — ask the user.

## Change detection — what the report means

Codex runs with `-s workspace-write` (it needs it to save the response), so it *could* write other files; `send.sh` checks the file system instead of trusting the prompt. Before the run it records a marker time and the full path list; afterwards newer mtimes = created/modified and missing paths = deleted. Everything except the response, `.log/` and `.scratch/` counts as a **change in the production area** and is reported with 🔴 — you **must** report it to the user and **never revert it** on your own. `.git`, `node_modules`, `build`, `.gradle`, `.dart_tool`, `.venv`, `.next` and `__pycache__` aren't scanned. "No changes outside the response file" means **no final-state difference within the watched scope** — never claim more (limits: troubleshooting.md).

`.log/<stamp>_events.jsonl` is written live — read it to answer "how is it going" mid-run (`_status.json` `state`: `running` / `finalizing` / `done` / `failed` / `interrupted`). The Claude State Bar extension draws its progress panel from these two files; the script only preserves them.

## Failure — exit code 11 is the only automatic fallback

The code is `send.sh`'s: the watcher's `finished — … · send.sh exit <code>` line (the watcher exits with it too), or the launcher's exit code when it printed `send.sh ended right away`. The launcher's own refusals (bad launcher arguments, the same stamp already running) also exit 2 and say so.

| Code | What happened | Action |
|---|---|---|
| **11** | couldn't load the required `lib/*.mjs` | ✅ **the only safe automatic fallback.** The check runs **before** the server starts and no module top level sends `turn/start`, so Codex provably didn't start. Retry once with `CR_LIVE_STEER=0` (a new detached launch, SKILL.md §3) and **say in one line that you fell back** |
| **10** | failure before `turn/start` — **or sent, outcome unknown** | 🔴 **no automatic fallback** |
| **20** | failure mid-turn — **can also happen before the turn starts** | 🔴 **no automatic fallback** |
| **21 · 22** | `turn/completed` not `completed` / turn limit | 🔴 **no automatic fallback** — the turn really ran |
| **130** | killed by SIGINT / SIGTERM / SIGHUP / SIGBREAK | 🔴 **no automatic fallback** — happens both before and after the turn starts |
| **2** | argument error — nothing ran | not a fallback case. **Your call was wrong**; fix it and rerun |
| **1** | any other unexpected error | read the logs and report to the user |

🔴 **Never read `10` as "it didn't start".** `Conn.request()` waits for the reply **after sending** the `turn/start` frame, so reply timeouts, lost connections and replies without a turnId all end up as 10 — the code can't tell "the server started the turn but the reply was lost". A fallback would run the same investigation twice and burn double the limit.
🔴 **No "it failed, just rerun it".** For anything but 11, read `.log/<stamp>_appserver.jsonl` and `_stderr.log`, report the cause and **get the user's decision.** Rerunning is the user's call.

**A non-zero exit with a changed response file is a partial save**: `send.sh` announces `⚠️ partial save arrived` and writes `status: partial` into the frontmatter. The request tells Codex to write as it investigates, so facts confirmed before a limit cut remain. Handle it by §9 step 6.
