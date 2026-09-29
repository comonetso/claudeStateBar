# §2-1 Pre-run confirmation — check Codex's state and ask every time

Ask before every CONSULT · EDIT · FOLLOWUP · REVIEW · RESUME run, and before the first `--start` turn of a CHAT (not for `--resume-stamp` or `--close-stamp`). One run can use a large share of a limited plan's 5-hour window (real case: 52% → 96%), so starting half-used means being cut off midway. Never quote usage numbers from memory — query every time.

🔴 `send.sh` refuses those runs without `CR_CONFIRMED=1`. **Add it only after the user has answered** — adding it is the statement "I asked and got an answer" (the same idea as the EDIT gate).

## ① Query (synchronous, a few seconds; calls no model and spends no tokens)

```
node "${CLAUDE_SKILL_DIR}/scripts/codex-status.mjs" --cwd <project root>
```

It shows the current model and reasoning level, 5-hour and weekly limits, the selectable models and reasoning levels **with their official descriptions**, the **limit baseline** (by limit shape), the per-turn usage of request-based runs over the last 21 days (overall and **per combination**, checked against the baseline), and the last 5 turns' task name, duration and tool-call count.

- Past usage is **per turn** (a follow-up turn may switch models). Usage is recorded in 1% steps; on weekly-only plans one turn shows as +0–2% and combinations blur — compare the recent turns' duration and tool calls to size this job.
- Some plans have no 5-hour window (e.g. Pro Lite — the output shows `plan: prolite`, weekly only). The tool tells windows apart **by length (300 / 10080 minutes), not by position**, prints `5-hour limit: none on this plan`, and past usage switches to the same plan's weekly window (those lines are marked `weekly window`). A reset date days away means it is the weekly window.
- Also check the install style here (see "Old install notice" below).

## ② Choose the recommendation — difficulty and limits together

1. **Estimate the difficulty** — light / medium / heavy, with a one-line reason, stated as your estimate.
   - Heavy: many or large sources to open · server/DB queries · cross-file analysis · unknown cause · design trade-offs · the previous turn went in circles
   - Light: the files to look at can be named · confirmation questions · a narrow diff review
   - You may cite a similar recent turn from the query output ("about the size of the earlier X job").
2. **Pick the combination for that difficulty** by matching the **official description text** in the query output. Never invent a model ranking. (E.g. reasoning `medium` = "everyday tasks", `high` = "complex problems", `max` = "hardest problems"; models likewise — "complex, demanding work" is the heavy side, "everyday tasks" / "fast and affordable" the light side.) Don't recommend models marked for retirement (⚠️).
3. **Check it against the limit baseline** — if that combination's **largest past single-turn usage** exceeds the baseline (its line in the query output shows `→ over the baseline`), **step down one level**: one reasoning level lower in the listed order, or a lighter model by official description. Choose which by the difficulty and say why. If neither works, add "narrow scope" to the recommendation. If the lowered one still exceeds, weigh it once more. When lowered, say in the question "by difficulty it would be X; lowered because it exceeds the baseline". No record for the combination ⇒ write "no record" and recommend by difficulty alone.

Limit baseline by **which windows exist**, not by plan name (the tool computes it under `── limit baseline`):

| Limit shape | Check |
|---|---|
| 5-hour + weekly (Plus etc.) | ① 5-hour headroom vs the 5-hour window's largest past single use · ② weekly daily share vs the weekly window's largest past single use — exceeding either counts |
| Weekly only (Pro Lite etc.) | weekly daily share vs the same plan's weekly largest past single use |
| No windows · query failed | recommend by difficulty only; the limit line gives the reason |
| Limit already reached | say so at the very top of the question |

Daily share = weekly headroom ÷ days until reset (less than a day counts as 1). Only past records from the same plan count.

## ③ Ask the user once

Don't recite usage numbers — the user can already see them. Use only the numbers behind your judgement. Ask with the host's choice UI if there is one, otherwise as text, following the user's standing preference.

```
Codex recommendation: <model> / <reasoning>[ · narrow scope]   (current: <model> / <reasoning>)
Difficulty: <light/medium/heavy> — <one-line reason> (my estimate)
Limits: <one-line baseline> · this combination's largest past single use <value or "no record"> [· why it was lowered]
1. As recommended (<model>/<reasoning>)
2. Keep current settings (<model>/<reasoning>)
3. Narrow scope (<recommended combination>)
4. Choose model/reasoning myself — <selectable models>
5. Stop
```

- If the recommendation equals the current settings, merge 1 and 2 into "1. Go ahead (recommended = current)". If the recommendation already includes narrow scope, drop 3.
- As buttons, mark option 1 "(recommended)". Buttons hold at most 4 options, so take "choose myself" as free input.
- Limit-line examples — weekly only: "weekly daily share 13.7% (65% left ÷ 4.8 days) · largest past single use for this combination +2%"; 5-hour + weekly: "5-hour headroom 45% · weekly daily share 23% · largest past single use 5-hour +50% → over the 5-hour baseline, lowered from high to medium"; query failed: "limit query failed (<reason>) — recommended by difficulty only".
- Ask even if the query failed. A failed query never blocks the run.
- If the sensory-observation question (consult.md) also applies, **put both in the same message.** Never make two round trips.
- Old install ⇒ append the notice below on the first run of the conversation.

## ④ Apply the answer

🔴 **No answer ⇒ don't run. Never proceed on a guess — ask again.** The same when the answer is off-topic or it's unclear which option was meant. Go on without a number only when the user **said** so — "up to you" = 1 · "keep it" = 2.

| Choice | Apply |
|---|---|
| 1. As recommended | add as `CR_MODEL` / `CR_EFFORT` **only the values that differ from the current settings**. If the recommendation includes narrow scope, apply 3 as well |
| 2. Keep current | add nothing |
| 3. Narrow scope | add the recommended combination as in 1, and put `## 조사 범위 — 이번엔 좁게` into the request (request-template.md). For REVIEW, narrow with the focus instruction |
| 4. Choose myself | `CR_MODEL=<model>` · `CR_EFFORT=<level>` |
| 5. Stop | write no request; end |

Both variables work on the live-steer path (passed as `--model` / `--effort`) and the old exec path (`-m` / `-c`). Don't add values equal to the current settings — then Codex's own config applies.

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
