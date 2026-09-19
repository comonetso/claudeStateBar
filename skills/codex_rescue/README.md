# codex_rescue

A skill that gets Codex to take a second look when Claude is stuck.

Writing the request, calling Codex, collecting the answer and reviewing it are all automatic. There is nothing to copy and paste, and nothing to tell it once Codex has finished.

## What it does

Claude writes the problem up as a single document and hands it to the Codex CLI. The request carries the real paths of the source material and an instruction to open them directly. Claude's own hypothesis goes at the back, kept short — put it up front and Codex ends up reasoning inside Claude's blind spot.

When Codex writes its answer to a file, Claude wakes up on its own, reads it and reviews it. You can keep giving Claude other work while the analysis runs — Claude decides whether what you said is work for it or a message for Codex, and asks in one line when that isn't clear.

Codex acts as an adviser and does not modify code, except in edit mode. It does have write permission, though, so the script walks the filesystem afterwards and reports what changed besides the response file. If something was touched that shouldn't have been, Claude tells you and waits for instructions rather than reverting it on its own.

## Using it

Just say what you want. It reads intent rather than fixed keywords.

```
/codex_rescue                     works out what you're stuck on and asks
/codex_rescue 분석해줘             Codex argues against Claude's hypothesis (no code changes)
/codex_rescue 리뷰시켜             reviews changed code (based on git diff)
/codex_rescue 분석하고 수정시켜     Codex edits the code itself (asks once first)
/codex_rescue 코덱스와 대화해       short back-and-forth; speed tracks how heavy the question is
/codex_rescue 다시 물어봐           follow up on the previous analysis
/codex_rescue help                help
```

One answer isn't the end of it. After reviewing the reply you can ask again, and if Claude read the problem too narrowly Codex will correct that — up to eleven turns.

## You can cut in while it's running

Say something while the analysis is in progress and it goes straight to Codex. Codex doesn't throw away what it was doing; it carries on and folds your point in.

```
"oh, that file is on the server too"
→ passed through as-is → Codex keeps investigating with that in mind
```

You don't need to turn it on beforehand — **analysis, code review, edit and follow-ups** always have it on. It can't be used on work that has already finished; that's what "다시 물어봐" (ask again) is for. Interrupting an edit doesn't undo files already changed; the new instruction applies from that point on. Only the short back-and-forth mode doesn't have it.

Code review writes its own request file and runs on Codex's official review guidelines. If it stops at a usage limit, the findings written so far are kept, and you can ask follow-up questions about the result. Saying "예전 방식으로" (the old way) runs Codex's dedicated reviewer instead, which has no interrupting, partial saving or follow-ups.

After an edit comes back, saying "이것도 고쳐" (fix this too) continues the same conversation and makes further changes. It asks for confirmation once per turn.

## Requirements

The Codex CLI must be installed and signed in.

**Node 20 or newer is needed for cutting in** — not for the skill as a whole. Node 22 and above work as they are; Node 20 needs a launch flag that the script adds for you; Node 18 cannot do it. The script checks this itself rather than trusting the version number. If it isn't available only cutting in stops working, and you are told before the run starts.

## Where files land

Under `docs/codex_rescue/`, paired by timestamp and slug. The directory is created if it isn't there.

```
260726_014119_request_mms-jar-encoding.md    written by Claude
260726_014119_response_mms-jar-encoding.md   written by Codex
260726_014119_edit2_mms-jar-encoding.md      change log for turn 2 of an edit follow-up
260726_014119_review_auth-refactor.md        code review result (old way)
.log/260726_014119_events.jsonl              full record of what Codex actually did
```

The short back-and-forth mode anchors to the project root; everything else is relative to the current directory.

Old records clean themselves up. Each time the skill runs, it removes from that project the app-server transcript of runs that finished successfully (often several MB each) and anything in `.log/` and `.scratch/` last touched more than 7 days ago. Request/response documents, the trash and a run that is still going are never touched. `.scratch/` is skipped altogether while another run in the same project is still going, since runs share it. Set `CR_KEEP_DAYS` to change the 7 days, or `0` to turn cleanup off — for every session, put it in the `env` block of `~/.claude/settings.json`.

## Installing

Install it as a Claude Code plugin. Inside Claude Code, run `/plugin marketplace add comonetso/claudeStateBar`, then `/plugin install codex-rescue@comonetso`, and reopen Claude Code. Plugin updates come through `claude plugin update codex-rescue@comonetso`, or automatically once you turn on auto-update for the `comonetso` marketplace (off by default for marketplaces outside Anthropic's own; see the [installation guide](https://github.com/comonetso/claudeStateBar/blob/main/docs/codex-rescue-guide.md#0-installation)).

Every Codex conversation the skill opens is named `rescue · <mode> · <subject>`, so the Codex app and `codex resume` list them by topic instead of by the identical first prompt.

Copying this folder to `~/.claude/skills/codex_rescue/` still works, but that copy never updates by itself, so it is no longer recommended. If you have such a copy, install the plugin and then delete the folder; keeping both leaves two skills with the same name. Requirements (Codex CLI, Node version) and the manual file list are in the [installation guide](https://github.com/comonetso/claudeStateBar/blob/main/docs/codex-rescue-guide.md#0-installation).

`/skill_cp_install deploy` is a *different*, separate skill some setups use to push their local `~/.claude/skills/` and `~/.claude/commands/` to their own remote servers over SSH. It has nothing to do with getting `codex_rescue` in the first place, and most installs will never touch it.

## If writes fail on Windows

If `Failed to write file ...` repeats and it only happens in **one particular folder** of an otherwise working project, check that folder's owner.

```powershell
Get-Acl -LiteralPath "<folder>" | Select-Object Owner
```

If it says `BUILTIN\Administrators`, that's the cause. It fails even when the permission list grants write access. Repair it from an elevated prompt.

```
takeown /F "<folder>" /R /D Y
icacls "<folder>" /reset /T /C
```

⚠️ Both lines apply **recursively**, and `icacls /reset` returns explicitly-set permissions to whatever is inherited. Anything you granted by hand on that folder goes away, so back it up first with `icacls <folder> /save` if it matters. Whether `takeown` alone is enough has not been tested — the pair above is what actually repaired it.

Spaces in the path, `.gitignore` status and directory depth are not the cause — that was settled by controlled comparison.

The full write-up, along with the other traps, is in the troubleshooting section of `SKILL.md`.
