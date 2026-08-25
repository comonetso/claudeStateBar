# Changelog

## [1.14.0] - 2026-08-26

> **You can cut in while Codex is still working.**
> A consultation used to be a throw and a wait. You wrote the request, Codex went away for several
> minutes, and if it started down the wrong path there was nothing to do but watch it finish and then
> ask again from the top — paying for the whole detour twice.

Codex's app-server protocol has a call for this, `turn/steer`, and it turns out to do exactly what
the name suggests: a message sent mid-turn joins the work already in progress instead of restarting
it. We measured it. A command that had 40 seconds left to run kept running, and the token thrown in
at second 25 showed up in the final answer alongside the original one. Codex said so itself in the
transcript — *"the command is not being restarted, I am still waiting on the same run."*

The panel now shows those interruptions inline. They carry a **Claude** chip in the same orange the
chat panel uses for Claude, plus a rail down the left edge of the row, so an interruption is not
mistaken for the CLI advisories that share the row style. That confusion was real: the notices Codex
prints at the start of every turn (`clamping SessionEnd hook timeout to 3s`) looked identical to a
human cutting in.

The plumbing lives in `tools/live-consult/`. It is deliberately narrow — it owns the app-server
connection and translates its notifications into the event format the panel already reads, and
nothing else. Everything the skill does around a run (request validation, the lock, change detection,
the edit gate, response recovery) stays in `send.sh` where it was proven.

### Follow-up turns are legible now

Asking Codex a second question reuses the same stamp and appends to the same event log, so both turns
land in one card. That was the intent. What actually happened was worse than nobody noticed:

`codex exec resume` numbers each turn's activities from `item_0` again, and the panel keyed
activities by that id alone. Turn 2's `item_0` overwrote turn 1's. In a real two-turn run, twenty
activities came out as twelve — and not the last twelve. Whichever ids happened to collide were
replaced, so the loss was scattered through the list. One row had been a **file change** in turn 1
and came back as a **command** in turn 2, keeping its old position: the activity had not disappeared,
it had turned into a different activity.

Activities are now namespaced per turn, and the card draws a header where one turn ends and the next
begins. Single-turn runs are untouched — no header, identical markup, verified byte for byte against
the previous build.

The status badge was wrong too. `turn.completed` from turn 1 left the run marked as terminal, so the
whole of turn 2 displayed as **Finalizing** while it was plainly still working. That flag now resets
when a new turn opens.

### What Codex is saying, per turn

The narration block at the top of a card — the sentence where Codex explains what it is about to do —
was the most useful thing on screen and the first thing to break in a multi-turn run. There was one
block per card showing the most recent sentence, which meant turn 2's words sat above turn 1's
activities and read as though they belonged to them.

Each turn now has its own. It keeps the last thing said in that turn even after the turn is over, so
a finished conversation still reads in order. Interruptions count as speech here: if the last thing
in a turn was Claude cutting in, that is what the block shows, with the border in Claude's orange.

### Deleting a run now takes the whole run

Follow-ups leave files the cleanup never knew about: the rebuttal documents
(`<stamp>_followup2_<slug>.md`) and per-turn logs (`<stamp>_t2_stderr.log`). Both the delete and the
trash path worked from a fixed list of five names, so those stayed on disk forever — you deleted a
run and it was still there. The turn count is open-ended, so the fix scans the directory by pattern
rather than adding names to a list.

In-flight markers are deliberately still excluded. They are how the skill recovers from a run that
died mid-write, and removing one would make the next run resume a broken session in silence.

### Codex usage limits were labelled backwards

The status bar read **Weekly** and showed a five-hour figure. The app-server reports two windows and
we had them the wrong way round: `primary` is the 5-hour window (300 minutes) and `secondary` is the
weekly one (10,080). Confirmed against a live query.

The numbers were always right — only the names lied. The status bar now says **Session**, matching
the wording Claude sessions already use, and the tooltip reads **5-hour limit** and **Weekly limit**.

### Context tooltip

The token breakdown put the total at the bottom of the table, under two rows that looked like
competing answers to the same question: `Input 220K` and `Context total 221K`. Used and capacity are
now the headline — **Context 221K / 828K (27%)** — and the table below it is just the breakdown.
Applied to both providers.

### Requires the updated `codex_rescue` skill

Live steering needs the app-server bridge, which ships with the skill rather than the extension. The
panel changes are safe without it: runs recorded by an older skill keep displaying exactly as before.

## [1.13.0] - 2026-08-23

> **The chat panel keeps one turn open at a time.**
> Folding turns arrived in 1.12.0 as something you did by hand. In actual use that was the wrong
> default: every turn stayed open, so a conversation a few exchanges long meant scrolling past
> answers already read to reach the one that just landed.

So the panel now decides which turn is the current one, and folds the rest down to the first line
of their question. Which turn that is depends on why you are looking at the conversation, and the
two cases pull in opposite directions.

Opening the panel, or opening a conversation you have not looked at this session, opens its
**first** turn — a past conversation is read from the top. A turn arriving in a conversation you
are already watching opens that **last** turn instead. Anything you opened or folded yourself is
left alone from then on, so reading an older turn while an answer lands elsewhere no longer costs
you your place.

Opening the panel also no longer jumps to the bottom. That was reasonable when everything was
expanded; with the first turn open it would have pointed you away from the turn just opened.
Following new answers down is unchanged.

## [1.12.0] - 2026-08-22

> **The chat panel shows the question before the answer arrives.**
> A ping-pong turn takes seven to thirteen seconds. Until now the panel showed nothing at all during
> that window — the line Claude threw appeared only once Codex had answered, so the panel sat there
> looking stuck on the one occasion you were actually watching it.

The reason was in the plumbing, not the panel. `send.sh` writes a turn to the conversation document
only after it has the answer in hand, and the panel reads that document. So the fix went into the
marker the script already drops before calling Codex: it now carries the question itself, along with
the conversation's stamp and slug. The panel reads that and draws a **waiting for an answer** turn
straight away. The document is still left alone until the answer is real — a failed turn should not
leave half a turn in the record.

This also covers the case that looked worst: the very first turn of a conversation, where no document
existed yet and the panel had nothing at all to show. That now gets a card too.

### Following the conversation, and folding it

The panel never touched the scroll position, so a long exchange simply ran off the bottom. It now
follows new turns down **when you are already at the bottom**. If you have scrolled up to reread
something it leaves the page where it is and raises a **New reply ↓** button instead — losing your
place is worse than missing a notification.

Turns fold. Click a turn's number line and it collapses to one line that keeps the first line of the
question, so a conversation with several long answers can be skimmed like a table of contents.
Everything starts expanded; folding is something you reach for, not a state to undo.

### Requires the updated `codex_rescue` skill

The waiting turn is drawn from the marker, so it needs the `send.sh` that writes the question into
it. An older skill will simply behave as before — the panel stays blank during a turn. Nothing breaks.

## [1.11.0] - 2026-08-22

> **A second Codex panel, for the conversations that are too short for the first one.**
> `codex_rescue` gained a ping-pong mode: instead of writing a request and waiting minutes, you
> throw one line at Codex and get an answer in about ten seconds. Those answers land in the Claude
> Code chat window, where a few turns quickly scatter between everything else that was said.

The new **Codex chat panel** puts one conversation back on one screen. It sits directly below the
progress panel in the status-bar menu, and appears under the same condition — the `codex_rescue`
skill installed on this machine.

One conversation is one card, newest expanded, because re-reading almost always means the exchange
that just happened. Claude's lines are orange and Codex's are blue, matching the provider glyphs in
the status bar, so who spoke reads as colour before it reads as a label.

Two things the panel deliberately shows rather than hides. **Breaks** — where a run died and the
thread was discarded, or where a new conversation replaced the old one — because otherwise there is
no way to tell why the context suddenly changed halfway down. And the **machine a conversation
started on**: these documents travel through git, but Codex sessions do not, so a conversation
begun on another PC cannot be continued here.

While a turn is in flight the card shows **talking**. That lasts seven to thirteen seconds, which is
brief but is also the only window in which the panel would look frozen.

Ping-pong turns never appear in the progress panel. That one exists to watch work that takes
minutes; ten-second exchanges accumulating there would only get in the way.

### The chat trash is a separate can

It uses its own directory rather than sharing the progress panel's. Neither panel can list or
destroy the other's items, and a conversation and a run may carry the same stamp without colliding.

Deleting from a card goes to the trash with no prompt — it is reversible, so a question there only
stands between you and something you can undo. The confirmation is at **delete-for-good** and
**empty**, the one point of no return. There is no automatic cleanup: run logs are bulk and worth
reclaiming, but a conversation is the record itself, and age is not a reason to destroy it.

### The status-bar menu is one line per item again

Every entry had grown a second line of explanatory text, and with workflows, Codex runs and the
cleanup entry all carrying one, the menu had become something to read rather than something to pick
from. The second lines are gone. Where an entry needed its detail to make sense, it moved into the
label — "View workflows" is now "Workflow panel", so it says what it opens without a caption
underneath. The stale-item entry keeps one short note that it reloads the window, since a window
reloading unannounced is worth a warning.

## [1.10.1] - 2026-08-21

> **The "documents too?" question moved to the end.** 1.10.0 asked it on the way into the trash,
> where it protected nothing — whatever you chose, you could take it back. It now asks at the
> point of no return instead.

Clicking 🗑 on a card takes the whole run — raw logs and the request/response documents together —
straight to the trash. No question, no confirmation dialog. The workflow panel behaves the same way.

Deleting an item out of the trash, or emptying it, is where you now choose: **logs only**, or
**logs and documents**. Keeping the documents leaves them sitting in the trash on their own, with
no run behind them, and the list says so — a row reads `logs + documents`, `logs only` or
`documents only` depending on what is actually left. That orphan is the point: the logs are bulk,
while the documents are the record of what was asked and answered.

When there is nothing to choose between it stops offering a choice, which is what made the old
version feel like it was asking twice. With only documents left the dialog says so plainly:
this click ends the last of that run.

How much is at stake is now visible before you click. The **Delete for good** button is red when
documents are all that remain, amber when the logs are still there to give up first, and neutral
when only logs are left. The contents label on the row is coloured to match.

### A run with documents but no log is now a card

Keeping the documents while purging the logs used to make a run vanish from the panel entirely.
The files were on disk and restoring them worked, but the list is built from event logs, so
there was nothing left to draw — and "Restore" looked like it had failed.

Those runs now appear as cards marked **documents only**. There is no activity list, because
there is no log to build one from; the card exists to open the request and response. Its mode
chip is left off rather than guessed, since the mode lived in the status file that went with the
logs — a purged `edit` run would otherwise have been labelled `READONLY`.

This also covers a case that never worked: `docs/codex_rescue/` documents committed by someone
else and pulled in through git. There were no logs on your machine, so the panel showed nothing.
Now they are listed.

Automatic cleanup is unchanged, and `claudeContextBar.codexRunDeleteDocs` still governs whether it
takes documents along. Manual deletion always does, but only as far as the trash.

## [1.10.0] - 2026-08-21

> **Deleting a run or a workflow no longer destroys it.** Both panels now delete into a trash you
> can open and take things back out of. Until now the 🗑 button unlinked the files immediately —
> not even to the OS recycle bin — and a modal confirmation was the only thing between a misclick
> and a permanently lost record.

### The trash

Open it with 🗑 at the top of either panel. Each entry shows what it was, how much it holds, and
when you deleted it, with **Restore** and **Delete for good** beside it. Nothing leaves on a timer;
the trash keeps what you put in it until you empty it.

Deleted files move next to where they came from — `docs/codex_rescue/.trash/` for Codex runs, and
a `.trash/` inside the session's workflow directory for workflows. They are moved, not copied, so
this stays cheap on a Remote-SSH workspace: nothing crosses the wire. The Codex trash writes its
own `.gitignore`, the same way the skill does for `.log/`, so trashed documents never show up as
something to commit.

Two behaviours are worth knowing about.

- **Automatic cleanup still deletes outright.** It exists to reclaim disk, and a trash that fills
  up as fast as cleanup empties the log directory would defeat the point of running it.
- **Restoring never overwrites.** codex_rescue re-runs a dead request under the same stamp, so a
  name a trashed file wants can legitimately belong to newer work. Those files stay in the trash
  and are reported instead of replacing anything.

A run that still holds its lock is refused, as before — send.sh may be mid-write, and moving a
file out from under it would corrupt the record rather than preserve it.

### Documentation

Codex audited the READMEs and the codex_rescue guide against the actual source, and most of what
it found was real. The corrections that matter to what you'd do differently:

- The skill was described as running everything with workspace write access. Review mode doesn't —
  `codex exec review` is read-only by CLI design and doesn't even accept the flag, and the review
  document is written by the skill's own script rather than by Codex.
- The auto-cleanup settings were written without their `claudeContextBar.` prefix, so copying them
  into settings.json produced keys that do nothing.
- "Fires within seconds of the reset" was wrong for the block primer: it runs on the next
  successful plan-usage poll, which is every 5 minutes by default.
- "Nothing to install on the server" conflated two things. The extension doesn't go on the server;
  starting a run there still needs Codex CLI and the skill installed on that machine.
- The 1.9.3 expand-a-clipped-row feature was described as showing the full text. The parser keeps
  4,000 characters of a message and 600 of a command, and the raw event log is the rest.
- Size figures were presented as typical when they came from single samples, and the panel's
  20-runs-per-folder display limit wasn't documented anywhere.

## [1.9.3] - 2026-08-21

> **Rows that were cut off now open where they are.** A message wider than the panel ended in an
> ellipsis and stayed there. Reading it meant spotting a separate "show full text" line
> underneath — and rows that weren't messages didn't get one at all.

### Click the row

Any activity row whose label doesn't fit opens in place, wrapped across as many lines as it
needs. Messages and reasoning open onto the whole message. A command opens onto the form that
actually ran, shell wrapper and all, which is what you would paste to reproduce it.

Rows that already fit don't respond to the click and their cursor doesn't change. Whether a
label is cut depends on how wide the panel happens to be, so it's measured once the list is laid
out, and measured again when you resize the window or change the font size.

Only one row stays open at a time — opening a second closes the first. An expanded message runs
a paragraph or more, and two of them at once leave no list to navigate by. Command groups are
not affected; they hold rows rather than text.

The separate "show full text" line is gone.

## [1.9.2] - 2026-08-19

> **The Codex progress panel works over Remote-SSH.** Since 1.9.0 it had been telling every
> remote window there was nothing to show, while the runs it was looking for sat on the server
> the whole time.

### Remote workspaces

Open a folder over Remote-SSH, run `codex_rescue` there, and the panel lists those runs — live,
with the same activity feed and completion chime as a local run. Until now every remote window
reported "no runs recorded in this workspace" no matter how many there were.

The logs were never the problem; they were on the server all along. The extension runs on your
own machine and was reading them with Node's file calls, which have no way to reach a path that
lives on the server. It now reads them the way it already read Claude and Codex session files.
Nothing has to be installed on the server.

### What a live run costs over SSH

Reading a remote file through VS Code cannot fetch just the new bytes, so a running Codex run's
event file comes across whole each time instead of as a delta. Three things keep that in check.

- Status and the completion chime still poll every 2 seconds. They read a 220-byte status file,
  not the event log, so the chime is as prompt as it ever was.
- The activity list refreshes at most every 5 seconds on a remote workspace. Local workspaces
  are unchanged at 2 seconds.
- A finished run is read once and then cached, and the retention scan never reads event bodies
  at all.

### Opening a run's documents

The request and response links on a card open the real file on the server. They used to build a
local path, which pointed nowhere when the document lived on a remote host.

### Which project, and which day

The tab now names the project it is showing — `Codex Runs · CCB` — and the full folder path sits
under the heading. With two windows open, both tabs used to read `Codex Runs` and nothing told
you which was which. The abbreviation follows the same rule as the status bar, including any
`shortNames` overrides you have set, so a project reads the same in both places.

Cards carry the date as well. A card read `17:46:27`, which looks like this morning even when
the run was two days ago, and logs are kept for a week. It now reads `08/19 17:46` — no year,
since a week rarely spans one, and no seconds, since the elapsed time beside it is where that
detail belongs.

### Cards say what the run was about

A card was headed by its slug — `poi-cache-namespace-latency` — which is a filename fragment
rather than a sentence, and in a list of four it told you very little. The request's new
`subject` line heads the card instead, with the slug moved to the hover since that is still
what the files are named. Runs recorded before this keep showing the slug.

The subject travels in the status sidecar the panel already reads every couple of seconds, so
it costs no extra transfer, not even over SSH. It does mean the **`codex_rescue` skill has to
be updated alongside the extension** — the skill is what writes the field, and on a remote host
it is the server's copy that writes it.

### Routine tool calls fold away

An expanded run was mostly noise. In one measured run 76% of the rows were commands — greps and
file reads nobody inspects — and a research-heavy one added a dozen searches on top. Runs of
consecutive successful calls of the same kind now collapse to one line, `commands 10` or
`searches 6`, with an expand control on the row. That run went from 57 rows to 30.

**A failure never folds.** Those are the rows worth reading, and a group ends the moment one
appears, so a failed command still sits in the list at full width with its exit code.

Commands also read as commands now. Codex runs everything through a shell, so every row began
with the same 48 characters — `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "` on Windows,
`/bin/bash -lc "` on Linux — which pushed the actual command off the end of the line. The
wrapper is stripped for display and kept on hover, since that is what you would need to
reproduce the call by hand.

### Renamed on the marketplace

The extension is now listed as **Claude Code & Codex Status Bar**. Searching `claude code` did
not turn it up: it ranked 347th, below extensions with three installs sitting in the top 40,
because the old name never contained the phrase people search for. Long-tail queries like
`claude token` and `codex usage` were already matching, so the tags were doing their job — the
title wasn't.

Only the display name changed. The extension id is the same, so updates and settings carry over
untouched.

## [1.9.1] - 2026-08-19

The marketplace icon now shows both tools. The extension is Claude-first and the icon said
only that, even though it has read Codex sessions for several releases. The Claude star is
still the subject; OpenAI's mark sits in the bottom-right corner as a badge.

Icon only. No code, settings or behaviour changed.

## [1.9.0] - 2026-08-19

> **Codex is no longer a black box while it works.** When Claude Code sends a problem to Codex
> for a second opinion, that run could take twenty minutes, and the only sign it was still
> alive was that Claude hadn't come back yet. A new panel shows what Codex is doing as it
> happens, and a chime tells you when it's finished.

### ⬢ Codex progress panel

Open it from the status-bar menu or `claudeStateBar: Show Codex Runs`. Each run is one card.

- **What Codex just said** is the headline of a running card — its own narration of what it's about to do next. That turned out to be far more informative than any spinner.
- Commands, searches, file changes and MCP calls are listed as they happen, colour-coded by kind, commands with their exit code.
- A plan appears as `2/5` when Codex produced one. It doesn't always, so it's shown only when present.
- **No percentage.** Codex never declares how many tool calls are left, so a progress bar would be an invented number. Elapsed time and activity count are shown instead.
- A run ends with the **workflow completion chime**, using the existing `claudeContextBar.workflowCompleteBeep` setting.

A run passes through `starting → running → finalizing → done / failed / stopped / unresponsive`. `finalizing` exists because Codex finishing its turn is not the run finishing — bookkeeping continues afterwards, and reporting "done" during that window would be wrong. A killed run settles on `unresponsive` rather than being promoted to done.

### The skill it reads is not bundled

The panel reads records left by **`codex_rescue`**, a skill for Claude Code. That skill is **not shipped inside the extension**: it runs `codex exec` with write access to your workspace, which shouldn't arrive as a side effect of installing a status-bar extension. It lives in this repository under `skills/codex_rescue/`, with a full guide in [English](docs/codex-rescue-guide.md) and [Korean](docs/codex-rescue-guide.ko.md).

Nothing changes for anyone who doesn't use it. Without the skill installed there is no panel and no menu entry — only a single command that points at the guide.

### Run records, and clearing them

The first run creates `docs/codex_rescue/` in your project. The request and response documents there are meant to be committed; the raw logs under `.log/` are not, and the skill now writes its own `.gitignore` there so they can't be committed by accident. They hold full command output and run roughly 300 KB per run.

Nothing is deleted unless you ask for it.

- The 🗑 button on a finished card removes one run, **asking each time** whether to delete its documents as well as its logs. Running cards don't have the button.
- `claudeContextBar.codexRunAutoCleanup` (off by default) clears old runs once per startup, keeping `claudeContextBar.codexRunRetentionDays` (7) days. Live or still-locked runs are never touched.
- `claudeContextBar.codexRunDeleteDocs` (off) controls whether *automatic* cleanup also removes the documents. Manual deletion ignores it and asks.

### Note

Not available over Remote-SSH: the extension runs on the local host, so it can't read a remote workspace's files.

## [1.8.3] - 2026-08-03

> **Numbers and colours now mean one thing each.** Three separate ways the status bar could be
> misread are fixed: usage running in opposite directions, colour that looked like a warning
> but wasn't, and another project's conversation quietly posing as this one's.

### Codex account usage reads the same direction as Claude's

It used to show how much was *left*, right next to a Claude figure showing how much was *used* — two adjacent numbers running opposite ways.

- Codex weekly and secondary limits now show the **consumed** percentage. A bigger number means closer to the limit, on both providers.
- Applies everywhere the figure appears: the status bar item, its tooltip, and the standalone `⬢ Codex` item shown when no session is resolved.
- Labels follow: `Remaining` → `Weekly` (`남음` → `주간한도`).
- **Heads up:** the ChatGPT usage screen still states the amount remaining. What it calls *42% remaining* now appears here as *58%*.

### Colour now means one thing: the usage threshold

**Removed: `claudeContextBar.autoColor` (per-project rainbow).** Every session item rests at your `baseColor`, and colour changes only for **idle**, **warning (50%)** and **danger (75%)**.

The palette overlapped the warning colours, so colour was unreadable in both directions: a healthy 28% session rendered in dusty rose and looked like a warning, and a genuine 78% one could be waved off as "that project's colour". Sessions are told apart by name, providers by their icon colour.

- The **Auto color** checkbox is gone from the settings panel; the colour picker is now labelled *Session text colour*.
- If you had `"claudeContextBar.autoColor"` in your settings.json, the line no longer does anything and can be deleted. VS Code will flag it as an unknown setting until you do.

### A conversation from another project is now marked

Codex lists conversations **per device, not per project**, so reopening VS Code restores whatever chat you last viewed — often one from a different repository. Its context was reported as if it belonged to the folder you have open, with only an abbreviated project name as the clue.

- When the conversation's `cwd` is not a folder open in this window, the **`⬢` glyph turns warning-coloured** and an **`↗`** follows the project name.
- The tooltip spells out the conversation's full path.
- Starting a new conversation clears the mark.

## [1.8.2] - 2026-08-02

Marketplace metadata only — **no functional change**. Identical behaviour to 1.8.1.

- Search tags reworked so the extension is findable by what it actually does — queries like `claude token usage` or `codex context usage` now match directly.
- Added to the **AI** category.

## [1.8.1] - 2026-08-01

Documentation only — no code changes. Identical behaviour to 1.8.0.

- **The 1.8.0 changelog is rewritten to be readable.** It had grown into dense paragraphs of implementation detail; it is now grouped under headings, one line per change, with internals removed.
- README feature list and "How it works" reworded to match, in both English and Korean.

## [1.8.0] - 2026-08-01

> **OpenAI Codex support.** Claude and Codex now sit side by side in the status bar with the same
> context monitoring, completion beeps, and idle behaviour. The extension is renamed to
> **Claude & Codex State Bar** — your existing install updates in place and keeps all settings.

### Added

#### ⬢ Codex sessions in the status bar

Claude and Codex are told apart by an icon prefix — **✳ Claude** / **⬢ Codex**.

- Codex sessions get everything Claude sessions get: context %, model and effort, idle dimming, `hideAfter` hiding, hide/restore, threshold colours, and the completion beep.
- Thresholds and sounds are **shared** — there is nothing Codex-specific to configure.
- Read from your local rollout logs only (`~/.codex/sessions/`). No network calls.
- The completion beep uses Codex's own `task_complete` event rather than guessing.

#### Codex account usage — the same number in every window

- Weekly limit, plan type and reset time are read live from the Codex app-server.
- **One window runs the probe; every other window reads a shared cache**, so all windows agree.
- Falls back to the newest rollout snapshot when the live reading is unavailable. Context monitoring never depends on it.

#### Codex spawned-agent completion sound

- The workflow sound fires **once**, only after every spawned agent *and* the parent turn have finished. Sequential batches can no longer beep early.

#### Remote-SSH support for Codex

- Works like Claude's: the extension runs locally and reads the remote host's files. The remote Codex home is auto-detected.
- Remote reads are skipped entirely when the file's mtime and size are unchanged. Rollouts over 32MB are skipped.

#### Three new settings

| Setting | Default |
|---|---|
| `codex.enabled` | on — a no-op when Codex isn't installed |
| `codex.home` | empty = auto-detect |
| `codex.scanDays` | 3 |

All three are editable from the settings panel.

### Changed

- **Renamed to "Claude & Codex State Bar."**
  Only the display name, README titles and description changed. The extension ID (`blueming.claude-state-bar`), every command ID, and all `claudeContextBar.*` setting keys are untouched — existing installs update in place and keep their configuration.
- **Marketplace description rewritten** around both providers; `codex` / `openai` / `chatgpt` added to search keywords.
- **Command palette entries unified under the `claudeStateBar:` prefix.** One command used a different prefix and split the palette results.

### Fixed

#### Codex account usage

- **The percentage was backwards.** The app-server reports usage *consumed*; the ChatGPT usage screen shows what's *left*. The status bar now shows **remaining**, matching the web (58% used → **42% remaining**).
- **Sessions disagreed with each other.** Every rollout stores whatever the limit was when *that* session last ran, so five sessions reported five different weekly figures for one account. Usage is now account-scoped — one reading, shared by every Codex item.
- **Windows disagreed with each other.** Each window polled on its own schedule and kept its own copy. Windows now coordinate a single probe through a shared cache.
- **Reset time could read `2064963d 23h`.** An epoch-seconds value was converted to milliseconds twice.

#### Which conversation gets shown

- **Codex showed other windows' conversations.** Reopening one thread elsewhere could scatter `project`, `project-2`, `project-3` across every status bar. Each window now shows the thread it actually has open. `scope: all` keeps the old behaviour.
- **Codex vanished in a window with no matching session.** That window now shows a standalone `⬢ Codex` item with the account figure and swaps in the real session item once one appears. Model and context values are never borrowed from another workspace.

#### Display

- **Model names were unreadable in compact mode** — `G5.6s` now renders as `gpt 5.6 sol`.
- **Provider glyphs** no longer take their colour from context usage (`✳` stays orange, `⬢` stays blue), are larger, sit closer to their labels, and Claude always sorts left of Codex.
- **Multi-day reset times now show the date.** `PM 4:16 (Wed)` was ambiguous on a 7-day cycle; it now reads `8/5 (Wed) PM 4:16`. Also applies to Claude's weekly limit.
- **Plan usage could attach to the wrong provider.** Each provider's leading session now carries its own.
- **Windows extended-length paths** (`\\?\C:\...`, `\\?\UNC\...`) failed to match workspace folders. Now normalized.

### Known limitations

- A remote window lists the **remote host's** Codex sessions only, and a local window the local ones. Claude behaves the same way.
- **No Codex workflow/sub-agent viewer**, and no question-wait or stuck-tool beeps for Codex yet. Codex's own background-agent panel remains the viewer.
- Codex sub-agent threads aren't shown as separate status-bar items — they're only aggregated for the all-complete sound.
- No deletion of Codex logs.
- Sidebar thread detection relies on an OpenAI log marker. If a future Codex release changes it, that window falls back to account-only usage rather than showing an unrelated session.

### Privacy

Codex rollout logs contain full conversation text. **The parser reads only structural fields** — token and rate-limit counts, timestamps, model, effort, `cwd`, task lifecycle, and spawned-agent IDs. Message bodies are never stored or logged, and `auth.json` is never touched.

### Internal

- New `src/providers/codex/` (parser, discovery, dual-mode tail reader, session provider, display) plus a shared `src/core/sessionTypes.ts`. The parser has no VS Code dependency.
- Validated against all 20 real rollout files on the dev machine: 0 parse errors, 0 unknown record types, 14.1MB file parsed in ~4ms via head/tail windowing.
- Local (byte-range) and remote (whole-file) read paths were cross-checked on the same data and produce identical results, so remote isn't a separate behaviour.

## [1.7.48] - 2026-07-24

### Fixed
- **Workflow‑complete beep no longer fires once per batch.** A workflow that runs its agents in *sequential batches* (e.g. 4 agents, then 2, then a final verification pass) used to beep at the end of **every** batch. Cause: a workflow's `journal.jsonl` only records per‑agent `started` / `result` lines — there is no "the whole script finished" marker — so the lull between batches (batch 1 done, batch 2 not spawned yet) momentarily reads as "all agents done." The beep now gates on the real end‑of‑workflow signal — the run's result file `workflows/<wfId>.json` (top‑level `status: "completed"`), with the session‑log completion notice as a fallback — so it fires **exactly once, when the whole workflow actually finishes**. Failed/killed runs close the gate silently (no success beep). Running all agents at once was never affected — only the sequential‑batch pattern misfired. Task (Agent‑tool) pseudo‑workflows keep their existing behavior.

### Internal
- Extracted 13 pure‑function modules out of the monolithic `extension.ts` into `src/core/` and `src/providers/claude/` — a **behavior‑preserving refactor** and groundwork for multi‑provider support. No user‑facing change; cross‑verified for behavioral equivalence against the previous release.

## [1.7.43] - 2026-07-21

### Fixed
- **Primer verification no longer false-negatives.** The throwaway `claude -p` prompt is tiny, so session usage stays at 0% — the old %-based check wrongly reported "unverified" even when the block had actually opened. Verification now checks the real signal: **`sessionResetAt` jumping to ~now+5h** (away from the weekly-reset value that shows while idle), retried for up to ~75s since the move takes about a minute to land. This was confirmed against a live reset: the primer fired, resetAt moved to exactly +5h, but session% stayed 0.

### Added
- **Wake-from-sleep primer fire.** If polling was paused a long time (machine slept) and the block is closed (session 0%) on the first poll after waking, the primer now fires even without a live >0%→0% transition. Previously it only fired when the block was still open when you fell asleep; now a block that reset overnight is opened as soon as you wake, so "wake up to an already-started block" works regardless of the pre-sleep state.

### Notes
- Confirmed the 5-hour block is an **anchor model**: it starts from your first message (or the primer's fire) and resets exactly 5 hours later — it does not auto-cycle on a fixed grid. When awake, the primer fires within seconds of the reset, so the new block is anchored essentially at the reset time.

## [1.7.41] - 2026-07-21

### Added
- **Two reset-behavior toggles in the settings panel** (Telegram section, right above the Context Monitor):
  - **Send a Telegram alert on each 5-hour reset** (`claudeState.telegramNotifyOnReset`, default on) — previously the alert always fired whenever a bot was linked; it can now be turned off without unlinking the bot.
  - **Auto-start the next 5-hour block on reset — `claude -p`** (`claudeState.autoStartBlockOnReset`) — the block primer, now toggleable from the UI instead of only via `settings.json`.

## [1.7.40] - 2026-07-21

### Fixed
- **Block primer now actually fires — trigger switched from reset-time to session-usage.** Root cause, confirmed from the reset-moment trace: the primer keyed off `sessionResetAt` *changing*, but that value stays in the **future** even when the block is closed (it points at next-day midnight while idle), so `fireOnReset` always read "a block is already open" and skipped — 7 days, 0 fires. It now fires on the reliable signal: **active session usage falling to 0%** (= block closed).
  - The `>0% → 0%` transition is read from `lastSessionPercent` in globalState, so a reset that happens **while the machine is asleep** is still caught on the first wake poll (pre-sleep % vs 0%).
  - **Exactly one Telegram alert and one prime per reset**, even across multiple windows or a wake-from-sleep burst: an atomic per-event lock keyed to a coarse 10-minute bucket lets exactly one poll through (shared globalState is the first line of defense, the lock the second). This also fixes the duplicate reset alerts (e.g. 3 identical messages on wake).
  - Verification switched to **session usage rising above 0%** after the fire. If it can't be verified, auto-start is **no longer auto-disabled** unless an API key is present (the only real billing hazard) — sleep/lag false-negatives used to wrongly turn it off.

### Diagnostics
- diag.log now records `block-closed` / `primer-outcome` / `primer-verified` lines; the per-poll `sessionResetAt` logging from 1.7.39 is retained.

## [1.7.39] - 2026-07-20

### Diagnostics
- **The block primer has been silently skipping every reset — this release instruments why (firing logic unchanged).** Disk evidence shows 7 days with 0 fires while `autoStartBlockOnReset` stayed on: by the time a reset is *detected*, `sessionResetAt` has already moved into the future, which `fireOnReset` reads as "a block is already open" and skips. To confirm that against live API behavior **without waiting for a reset**:
  - Every usage poll now records the live `sessionResetAt` to a disk diag log (`<tmp>/claudeStateBar-primer/diag.log`) whenever it changes — `resetAt` / `future=Y|N` / `session%`. So the current block state (open = future, closed = past/null) is readable at any moment right after a reload, no reset event required.
  - Each reset also appends `before` / `now` / `future` / `autoStart` and the primer outcome with its reason (**including every `skipped`**). Unlike the output channel (memory-only, lost on reload), this file survives so the cause can be read back directly.
  - The Telegram reset alert carries the same one-shot `[diag]` line for at-a-glance confirmation on the phone.
  - Nothing about when or whether `claude -p` fires was changed. These additions are meant to be removed or tuned once the cause is confirmed.

## [1.7.36] - 2026-07-13

### Added
- **Auto-start the next 5-hour block on reset (`claudeState.autoStartBlockOnReset`, default off)** — a 5-hour block is anchored to your *first message*, not to the reset, so a 04:00 reset plus an 08:00 first prompt yields an 08:00–13:00 block. When enabled, a throwaway `claude -p` prompt is fired **from the same spot that sends the Telegram reset alert**, so the alert and the prime always agree. Anchors the new block to the reset instead of to whenever you next type.
  - The primer runs in its own temp working directory (`<tmp>/claudeStateBar-primer`), and `findActiveSessions()` filters out sessions from that directory — the dummy sessions never reach the status bar.
  - Multiple VS Code windows each run their own copy of the extension and would all fire for the same reset; an atomic `wx` lock file keyed to the reset timestamp lets exactly one window win.
  - Skips entirely when `sessionResetAt` is already in the future — a block is open, so there is nothing to prime (and firing would make the verification below misjudge).
  - Telegram reports the result when configured (`tg.primerFired` / `tg.primerFailed`), and the usage numbers are refreshed right after a successful fire.
  - Requires the `claude` CLI on PATH and VS Code running. ⚠️ The new window starts counting down immediately — including while you sleep.

### Safety (billing)
- **The primer never trusts `exit 0` as proof that a subscription block opened.** Anthropic has floated billing headless `claude -p` runs to the API rather than to the subscription. If that ever lands, the call would still succeed while opening no 5-hour window — a silent *charge*, not a silent failure. Three guards make that non-catastrophic:
  - **Pre-flight refusal** — if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present in the environment, the primer does not fire at all, since the call would draw on API credit instead of the plan window.
  - **Post-fire verification** — after the prompt returns, the extension re-reads claude.ai usage and confirms `sessionResetAt` actually moved into the future. That is what proves a subscription window opened; the CLI's exit code does not.
  - **Automatic self-disable** — if verification fails, `claudeState.autoStartBlockOnReset` is switched OFF (with a Telegram + VS Code warning) instead of retrying on every reset. Worst case is one stray call, not four a day forever.

---

## [1.7.33] - 2026-07-13

### Fixed
- **Per-model weekly usage gone from the tooltip (Fable missing, Sonnet/Opus blank)** — claude.ai moved per-model weekly caps out of the `seven_day_<model>` buckets (now all `null`) and into a new `limits` array, where each cap is a `weekly_scoped` entry naming its model in `scope.model.display_name` (e.g. `Fable`). The extension only read the old buckets, so the model breakdown silently disappeared. It now reads the `limits` array — rendering every `weekly_scoped` entry under whatever model name it carries — while still reading the legacy buckets as a fallback. No model name is hardcoded, so the tooltip follows the plan line-up as models come and go. Session/weekly totals also fall back to the `limits` array if the top-level buckets ever go null.
- **Session and weekly totals** now fall back to the `limits` array (`session` / `weekly_all`) when the legacy `five_hour` / `seven_day` buckets are absent.

### Added
- **Usage schema logging** — the `claudeStateBar` output channel now logs the usage response's top-level keys and the per-model buckets it found, plus the raw body when no per-model cap is detected. Makes the next claude.ai schema change diagnosable from the log instead of guesswork.

---

## [1.7.30] - 2026-07-03

### Fixed
- **Sonnet 5 / 4.6 context limit** — `claude-sonnet-5` and `claude-sonnet-4-6` now use the 1M token context limit instead of the default 200K (Sonnet 4.5 and earlier are unaffected and still default to 200K). Also recognizes `claude-mythos-5` (Fable-equivalent) as 1M.

---

## [1.7.29] - 2026-07-01

### Fixed
- **Killed agents stuck as "running"** — a TaskStop-killed workflow/Task agent kept showing as running forever, so the whole workflow stayed "N/M running" indefinitely. It's now detected via the `[Request interrupted]` marker left in the agent log (an explicit signal, not a time-based/stale heuristic) and shown as a distinct **stopped** state: gray dot, "stopped" tag, and an "N done · M stopped" badge. Applies to both Task subagents and journal-based (`wf_*`) workflows; stopped agents no longer count toward the "running" total.
- **Short final answers stuck as "running"** — a completed Task agent whose final reply was short (under ~1500 chars) and ended with `stop_reason:null` was never recognized as done and stayed "running" indefinitely. Completion detection is now settle-based (a text-only last assistant entry idle ≥4s counts as final) and size-agnostic, so short completions like "핑 완료" register as done.
- **Title elapsed clock never froze when an agent was stopped** — the workflow's title-row elapsed time kept counting up if any agent was `stopped`, because it only froze when *every* agent was `done`. It now freezes once nothing is running (done or stopped), showing the final "took" duration.

---

## [1.7.28] - 2026-06-10

### Fixed
- **Fable 5 context limit** — `claude-fable-5` now uses 1M token context limit instead of the default 200K.

---

## [1.7.27] - 2026-06-10

### Fixed
- **Fable 5 model name display** — model `claude-fable-5` now correctly shows as "Fable 5" (compact: "F5") in the status bar instead of just "5".

---

## [1.7.26] - 2026-06-09

### Changed
- **Publisher rebranding** — extension identifier changed from `ezoosk.claude-context-bar` to `blueming.claude-state-bar`; display name updated to "Claude State Bar".
- **README and changelog rewrite** — fork notice moved to a single Credits line at the bottom; pre-1.5.0 changelog entries collapsed to one line.
- **Configuration descriptions** — remaining Korean-language descriptions in `contributes.configuration` converted to English for Marketplace consistency.

---

## [1.7.25] - 2026-06-07

### Added
- **Live activity indicator in status bar** — a separate status-bar item shows elapsed seconds while Claude is actively thinking (🤔) or processing, giving a real-time "alive" signal without requiring a separate panel.

### Notes
- Attempted a full activity panel (timeline + current activity) and rolled it back after confirming it only mirrored the chat window output — the elapsed-seconds indicator is the genuine value-add since it shows information not visible in the chat.

---

## [1.7.24] - 2026-06-06

### Added
- **Status bar tooltip full i18n** — all tooltip labels (effort note, plan unavailable notice, model/context lines) now respect the EN/KO language toggle.

---

## [1.7.23] - 2026-06-06

### Added
- **Full i18n across all UI surfaces** — Workflow viewer panel, session QuickPick menu, toast messages, modals, and data labels all respect the EN/KO language toggle. Previously only the settings panel was bilingual.
- **Real-time language switching** — changing the language setting updates all UI immediately without requiring a panel reopen (config watcher added for `claudeState.language`).

### Fixed
- Modal confirmation buttons now compare against the same `planT()` result as the button label, preventing an "always cancel" bug when i18n keys are active.

---

## [1.7.22] - 2026-06-06

### Added
- **Agent label tooltips** — agent mission labels that overflow with `…` now show the full text on hover (`title` attribute). Completes the tooltip coverage started in v1.7.20.

---

## [1.7.21] - 2026-06-06

### Fixed
- **Workflow panel crash on `\n` in title** — newline characters inside a JS string literal within a backtick template literal compiled to real line breaks, breaking the webview script with a SyntaxError. Escaped to `\\n`. Same fix applies to regex special characters inside template literals.

---

## [1.7.20] - 2026-06-06

### Added
- **Workflow card title tooltip** — hovering the workflow name shows the full title + description as a floating tooltip.
- **Completed agent full step list** — finished agents now show every assistant step (tool calls + text) in chronological order. Running agents still show only the current step.

---

## [1.7.19] - 2026-06-04

### Added
- **Workflow card elapsed time** — start time and live elapsed counter displayed next to each workflow card title. Updates every second while the workflow is running.

---

## [1.7.16] - 2026-06-04

### Added
- README fully rewritten to reflect Claude State Bar feature set.

---

## [1.7.14] - 2026-06-02

### Added
- **ultracode display approximation** — status bar shows `xHigh⁺` when `effortLevel=xhigh` is detected on disk, with a tooltip note that ultracode's dynamic-workflows component is runtime-only and indistinguishable from plain xhigh.

---

## [1.7.11] - 2026-05-25

### Added
- **Zombie status-bar cleanup** — on activation, if the extension version changed since last run, a one-time "Reload window?" notice appears. The session QuickPick menu always includes a 🗑 cleanup option that reloads the extension host.
- **Ghost item cleanup command** — `claudeStateBar: 유령/오래된 상태바 항목 정리` available from the Command Palette.

---

## [1.7.7] - 2026-05-25

### Added
- **Workflow & Task Agent viewer panel** — WebView panel accessible from the session QuickPick menu showing live progress of all active Claude Code workflows and Task (Agent tool) sub-agents.
  - Workflow cards with phases, agent summaries, elapsed time, and live activity
  - Role labels auto-extracted from agent prompt headers
  - Task sub-agents grouped into batches by start time
  - Per-batch log cleanup while preserving running agents
  - `<details>` open-state persistence across live re-renders
  - `A−` / `A+` font size controls

---

## [1.7.3] - 2026-05-24

### Added
- **Sound alerts** — configurable WAV sounds for warning threshold, danger threshold, response completion (`end_turn`), question pause, and workflow/agent completion.
- Gain control (50–5000%) per event with in-memory amplification for WAV files.
- **`claudeStateBar: Test Beep Sound`** command for previewing sounds.
- **Stuck-tool-use heuristic** — optional beep if a `tool_use` entry has no follow-up activity for `stuckToolUseThresholdSec` seconds (off by default).

---

## [1.7.0] - 2026-05-21

### Added
- **Remote-SSH support** — extension now runs as a `ui`-kind (local) extension. Plan usage is fetched via Electron on the local machine (passes Cloudflare); token counts are read from the remote host's `~/.claude/projects` via `vscode.workspace.fs` (VS Code routes reads over SSH). Install once locally — all Remote-SSH windows update automatically.

### Changed
- All `~/.claude` access moved from synchronous Node `fs` to async `vscode.workspace.fs`. Remote home auto-detected (`/root`, else `/home/*` containing `.claude/projects`). File watching moved to `vscode.workspace.createFileSystemWatcher`.

---

## [1.6.1] - 2026-05-21

### Fixed
- **"Session Key expired" false alarm on Remote-SSH** — Cloudflare `403` (bot challenge) on a remote/headless host is now distinguished from a genuine auth failure. Shows a "plan usage unavailable here" notice instead.

---

## [1.6.0] - 2026-05-20

### Added
- **Claude.ai plan usage in status bar** — 5-hour session and weekly utilization, fetched from claude.ai (no SDK), merged into the first session item with tooltip breakdown.
- **Webview settings panel** with runtime EN/KO language toggle. Session Key / Org ID / Bot Token at the top; sensitive values stored encrypted via SecretStorage.
- **Telegram session-reset notifications**.
- **Cloudflare bypass via Electron `net`** — Chromium network stack passes the TLS-fingerprint challenge that blocks plain Node `https`.
- Display name unified to **Claude State Bar** (identifier and `claudeContextBar.*` setting keys kept for compatibility).

---

## [1.5.1] - 2026-05-03

### Fixed
- **Linux workspace matching** — added fallback path comparison for cases where Claude's directory encoding differs from the computed encoding.
- **Diagnostics output channel** — added `Claude State Bar` output channel with per-refresh logging.

---

## [1.5.0] - 2026-05-03

### Added
- **Context Menu (QuickPick)** — clicking a status-bar item opens a menu (hide / restore all / restore one / open settings) instead of hiding immediately.
- **Model display** — model name shown next to the percentage (e.g. `Opus 4.7 · 45%`).
- **Effort indicators** — ⚡ for `/fast` mode, 💭 when extended thinking is detected.
- **Two-tier idle** — sessions dim (`idleTimeout`, default 180s) before fully hiding (`hideAfter`).

---

## [Before 1.5.0]

Original context-monitoring core by Ed Zisk (@ezoosk) — real-time status-bar token usage, color-coded thresholds, ghost-session detection, compact mode, and auto-color. This fork begins at v1.5.0.
