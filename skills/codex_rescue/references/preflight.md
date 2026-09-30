# §2-1 Pre-run confirmation — check Codex's state and ask every time

Ask before every CONSULT · EDIT · FOLLOWUP · REVIEW · RESUME run, and before the first `--start` turn of a CHAT (not for `--resume-stamp` or `--close-stamp`). One run can use a large share of a limited plan's 5-hour window (real case: 52% → 96%), so starting half-used means being cut off midway. Never quote usage numbers from memory — query every time.

🔴 `send.sh` refuses those runs without `CR_CONFIRMED=1`. **Add it only after the user has answered** — adding it is the statement "I asked and got an answer" (the same idea as the EDIT gate).

## ① Query (synchronous, a few seconds; calls no model and spends no tokens)

```
node "${CLAUDE_SKILL_DIR}/scripts/codex-status.mjs" --cwd <project root>
```

It shows the current model and reasoning level (Codex's own config), 5-hour and weekly limits, the selectable models and reasoning levels **with their official descriptions**, the **limit baseline** (by limit shape), the per-turn usage of request-based runs over the last 21 days (overall and **per combination**, checked against the baseline), and the last 5 turns' task name, duration and tool-call count.

- Past usage is **per turn** (a follow-up turn may switch models). Usage is recorded in 1% steps; on weekly-only plans one turn shows as +0–2% and combinations blur.
- Some plans have no 5-hour window (e.g. Pro Lite — the output shows `plan: prolite`, weekly only). The tool tells windows apart **by length (300 / 10080 minutes), not by position**, prints `5-hour limit: none on this plan`, and past usage switches to the same plan's weekly window (those lines are marked `weekly window`). A reset date days away means it is the weekly window.
- Also check the install style here (see "Old install notice" below).

## ② Prepare the questions — model, reasoning, depth

🔴 **The model and reasoning level start from Codex's own config** (user decision, 2026-09-30). The current values go in the first slot as the recommendation. Don't recommend a different combination by difficulty and don't lower it for limits — other values are the user's choice. **Depth is the one thing you judge.**

Which runs get which questions:

| Run | Questions |
|---|---|
| CONSULT · EDIT · REVIEW · FOLLOWUP | model · reasoning · depth |
| RESUME · CHAT `--start` | model · reasoning only — a RESUME reruns the original request as it is, and a CHAT has exploration blocked by default, so depth means nothing there |

1. **Model — 4 slots.** First: the current model, `(recommended)`. Fill the other three from the query output's selectable models **by their official descriptions**, one per role: the latest general-purpose ("workhorse") model · the one for the most demanding work · the fast, affordable one. Skip the current model and models marked for retirement (⚠️). If a role has no model or repeats one already placed, take the next unused model from the top of the list. Never invent a ranking. Each option's description is the official description; the current one also says "your Codex config". Other models go through "Other".
2. **Reasoning — 4 slots.** First: the current level, `(recommended)`. Then one level lower, one higher, two lower, in the query output's listed order. At an end of the list, fill from the other side (current `low` ⇒ low / medium / high / xhigh). 🔴 **Never put `ultra` in a slot** (maximum reasoning with automatic task delegation) — it is reachable only through "Other". Descriptions are the official ones.
3. **Depth — shallow / normal / deep.** Put your judgement first, `(recommended)`, with a one-line reason in the question:
   - **shallow**: confirmation questions · the files to look at can be named · a narrow diff review
   - **normal**: everything else. EDIT is normal by default
   - **deep**: unknown cause · the previous turn went in circles · design trade-offs · refutation · a pre-release check · the user asked for care ("꼼꼼히", "확실히", "검증", "놓치지 말고", "carefully", "make sure")

   Each description says what that depth makes Codex do (the texts are in request-template.md "조사 깊이 문안").
4. **Limit warning, never an automatic change.** If the line of the combination about to run shows `→ over the baseline` in the query output, put one warning line at the top of the model question (e.g. "this combination once used +5%, more than today's share of 3.1%"). Limit already reached ⇒ say so at the top of the model question. No record, query failed, or no windows ⇒ no warning line.

Limit baseline by **which windows exist**, not by plan name (the tool computes it under `── limit baseline`):

| Limit shape | Check |
|---|---|
| 5-hour + weekly (Plus etc.) | ① 5-hour headroom vs the 5-hour window's largest past single use · ② weekly daily share vs the weekly window's largest past single use — exceeding either counts |
| Weekly only (Pro Lite etc.) | weekly daily share vs the same plan's weekly largest past single use |
| No windows · query failed | no warning |

Daily share = weekly headroom ÷ days until reset (less than a day counts as 1). Only past records from the same plan count.

## ③ Ask the user once

Use the host's choice UI (`AskUserQuestion`): **all questions in one call**, `multiSelect: false`, in the user's language. A choice UI hides the text above it, so everything needed to decide goes **inside** the questions and option descriptions. There is no "stop" slot — the user types it in "Other".

```
Q1  header "Model"      "Which Codex model? [⚠️ limit warning line, if any]"
    gpt-6-sol (recommended)   your Codex config · Previous generation workhorse model.
    gpt-6.1-sol               Latest workhorse model for coding and everyday work.
    gpt-6-astra               Frontier intelligence for the most demanding work.
    gpt-6-luna                Fast and affordable model for easier tasks.
Q2  header "Reasoning"  "Which reasoning level?"
    xhigh (recommended)       your Codex config · Extra high reasoning depth for complex problems
    high · max · medium       (official descriptions)
Q3  header "Depth"      "How deep should Codex dig? Recommended normal — <one-line reason>"
    normal (recommended)      reads the core of the relevant sources, cites file and line, marks low confidence
    shallow                   one or two sources, a short conclusion; stops and names what is missing if unresolved
    deep                      follows call paths and edge cases, tries to refute its own conclusions
```

(The model names above are an example — always fill from the current query output.)

- Without a choice UI, ask the same questions as text, one line per question with numbered options.
- Ask even if the query failed. A failed query never blocks the run.
- If the sensory-observation question (consult.md) also applies, **put both in the same message.** Never make two round trips.
- Old install ⇒ append the notice below on the first run of the conversation.

## ④ Apply the answer

🔴 **No answer ⇒ don't run. Never proceed on a guess — ask again.** The same when the answer is off-topic or it's unclear which option was meant. Go on without a pick only when the user **said** so — "up to you" / "알아서" = every recommended value · "keep it" / "그대로" = the config values and the recommended depth.

| Answer | Apply |
|---|---|
| Model or reasoning = the config value | add nothing — Codex's own config applies |
| Model or reasoning = another value | `CR_MODEL=<model>` · `CR_EFFORT=<level>` — only the one that differs |
| Depth | CONSULT · EDIT: put that depth's `## 조사 깊이 — …` section into the request (request-template.md) · FOLLOWUP: into the follow-up file (followup.md) · REVIEW: append that depth's line to the focus instruction (review.md) |
| "stop" / "중단" in Other | write no request; end |

Both variables work on the live-steer path (passed as `--model` / `--effort`) and the old exec path (`-m` / `-c`).

## Old install notice

The skill folder is `${CLAUDE_SKILL_DIR}`. It is an old-style install (a copied folder) when **both** hold:

- the path ends with `/.claude/skills/codex_rescue` (plugin installs live under `/.claude/plugins/`)
- `test -f "${CLAUDE_SKILL_DIR}/.no_plugin_notice"` is false (that file marks the machine where the skill is edited)

Then, **only on the first run of this conversation**, append this (in the user's language) at the end of the ③ question; in HELP mode, at the end of the help output. Plugin install or marker file present ⇒ say nothing.

```
⚠️ This skill is installed the old way (a copied folder), so updates don't arrive automatically. Switching to the plugin is strongly recommended.
   /plugin marketplace add comonetso/claudeStateBar
   /plugin install codex-rescue@comonetso
   After installing, the old copy isn't needed: delete ~/.claude/skills/codex_rescue/ and reopen Claude Code (two skills with the same name get confused).
```

🔴 **Never delete the old folder yourself** — the skill that is running is that folder. Tell the user; they do it.
