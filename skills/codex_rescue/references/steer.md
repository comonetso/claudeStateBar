# 8-1. Steering a running job — relay the user's words as they are

This applies **while** a run is going (a CONSULT · EDIT · REVIEW turn or a follow-up started with `CR_LIVE_STEER=1`). A message added to the running turn makes Codex **keep the work it was doing** and take the message in at the next model boundary (the turn count doesn't grow). `codex exec` can't do this, so it works only with `CR_LIVE_STEER=1`.

**Follow-ups the same way.** `--stamp` is **the original case's stamp** — follow-ups create no new stamp. Input left queued by a force-ended previous turn was meant for that turn; it isn't put into the new turn and counts as not delivered.

## How — always pass the body as a file

```
1. Write:  docs/codex_rescue/.log/<stamp>_steer<N>.txt      ← the user's words as they are
2. Bash:
     node "${CLAUDE_SKILL_DIR}/scripts/live-consult.mjs" steer \
       --stamp <stamp> \
       --input-file docs/codex_rescue/.log/<stamp>_steer<N>.txt \
       --source user-via-claude
```

🔴 **Never pass the text as an argv.** Windows CreateProcess caps a command line at 32,767 characters, and non-ASCII text (3 UTF-8 bytes per character) hits it sooner (measured: 32,000 B succeeds, 32,700 B fails). Use a file even when it looks short — measuring the length is one more judgement to get wrong. (`--input-file -` reads stdin.)

**`<stamp>` is the one in the request file name** — you set it yourself when writing the request. **Never guess it or make a new one.** It equals the `conversation key:` value on `send.sh`'s stderr.

## When — only when the user said something

| Situation | Action |
|---|---|
| mid-run the user said something **meant for Codex** (a new fact, a direction, a missed source) | **relay it as is.** Say in one line that you did |
| it reads as **said to you** | don't relay; answer as usual |
| **unclear which** | **ask in one line**: "Shall I pass this to Codex?" |
| anything else | don't relay |

🔴 **Never steer on your own judgement.** The relay has a `wait` (high-signal watch) subcommand; **it is not used** (user decision). Even when Codex seems off track it may be your misjudgement, and acting on it would shake an investigation in progress. If something looks wrong, **tell the user and get a decision.**
🔴 **Never summarize, rephrase or translate the user's words — pass them on as they are.** Once they go through your view, the reason this skill exists is gone (the same logic as not copying sources into a request). If context is needed, add it **below** the user's words; the words themselves stay verbatim at the top.

## Result — by exit code

| Code | Meaning | What to tell the user |
|---|---|---|
| **0** | delivered — outcome `delivered` (same turnId, strict comparison) | "Delivered" |
| **30** | recorded as `rejected` after enqueue | relay the reason as is. **But never say "the server rejected it"** (below) |
| **31** | steerability check failed **before** enqueue — no such run, or it can't take input now | it may have ended already; check `status` and tell the user |
| **32** | enqueued, delivery unconfirmed (`unknown` · phase ended · deadline passed) | 🔴 **never say "delivered".** Say delivery is unclear |
| **1 · 2 · 11** | unexpected error / bad argument or input / lib load failure | **suspect your own call first** |

🔴 **Don't translate `30` as "the server rejected it".** Besides an explicit rejection, 30 covers **no steer channel · turnId mismatch · a queue left after the turn ended · an RPC reply timeout** — the request frame was already sent, so **even "the server got it but replied late" is 30.** Relay the reason string as is, without interpreting it.
🔴 **"Queued" is not "delivered".** The relay counts delivery only after a reply with the same turnId. 32 means unknown; reporting unknown as success makes the user act as if it had been applied.
⚠️ **`exit 0` alone isn't delivery** — `--help`, `--version` and `--dry-run` also exit 0. Judge by the `delivered · seq=N · turnId=…` output together with the code.
⚠️ **Dedicated review and compaction turns can't be steered** (`NonSteerableTurnKind = ["review","compact"]`). That is why the live REVIEW runs as a **normal turn**; a review on the old path (`--review` without `CR_LIVE_STEER`) can't be steered.
⚠️ **Steering an EDIT doesn't undo files already changed**; a new direction applies from then on. If it is stopped (results.md §9 step 6) the code may be half-changed — compare the report's `## 1. 변경한 파일·라인` with `git diff`.
⚠️ **A finished turn can't take input — but it doesn't always return 31.** Finished before the initial check ⇒ 31; finished in a race after passing the check ⇒ **30 or 32** (`-32600 no active turn to steer` comes after enqueue, so it is **30**). Either way it didn't get in — use a follow-up (followup.md).
