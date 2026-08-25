# codex_rescue — Getting a Second Opinion from Codex

> This guide covers the `codex_rescue` skill that pairs with claudeStateBar's
> **Codex Runs** panel. The skill is **not bundled** with the extension — the extension
> is the *viewer* for the run records the skill leaves behind.
>
> 한국어: [codex-rescue-guide.ko.md](codex-rescue-guide.ko.md)

`codex_rescue` is a skill for Claude Code. It has **a second AI (Codex) check your code, or
the problem Claude is stuck on.** You ask in plain language; the whole round trip is automatic.

---

## 0. Installing

### Requirements

- **Claude Code** — where the skill runs
- **Codex CLI** — `npm i -g @openai/codex` (this guide is written against `0.145.0`)
- **Git Bash on Windows** — `send.sh` is a POSIX shell script

### Get the skill

```bash
mkdir -p ~/.claude/skills/codex_rescue
BASE=https://raw.githubusercontent.com/comonetso/claudeStateBar/main/skills/codex_rescue
curl -fsSL "$BASE/SKILL.md" -o ~/.claude/skills/codex_rescue/SKILL.md
curl -fsSL "$BASE/send.sh"  -o ~/.claude/skills/codex_rescue/send.sh
chmod +x ~/.claude/skills/codex_rescue/send.sh
```

If you cloned the repo, copying `skills/codex_rescue/` into `~/.claude/skills/` works too.

Reopen Claude Code and `/codex_rescue` becomes available. The extension's progress panel
appears from that point on.

### 🔴 Read this before installing

In the consult and fix modes the skill runs **`codex exec` with `-s workspace-write`** — Codex
operates with write access to your workspace there. That is why it is not bundled with the
extension; installing it is meant to be a deliberate act.

- **Review mode is the exception.** `codex exec review` is read-only by CLI design and does not
  even accept `-s`. The review document is written by `send.sh`, not by Codex
- In consult mode Codex is instructed to write **exactly one file**, the response document, and
  any other change is **measured against the filesystem and reported** (see §6).
- If you want to remove prompt compliance from the equation entirely, run with
  `CR_SANDBOX=read-only`. Codex gets no write access at all and the script saves its final
  message as the response file.
- The mode where Codex edits code directly is **blocked by default**; the script refuses it
  without explicit approval.

---

## 1. Four phrases are all you need

| Say this | What it looks at | Does Codex edit code? | How long |
|---|---|---|---|
| **"review it"** | **everything you changed** (git diff) | No | minutes |
| **"analyse this"** | **one problem you're stuck on** | No | minutes |
| **"ask again"** | **push back on the last analysis** | No | minutes |
| **"analyse and fix it"** | above + edits directly | **Yes** (approval required) | minutes |
| **"talk to Codex"** | the one short question you're asking now | No | **about 10s** |

These are not fixed keywords — **intent is what matters.** "Take a look before I commit"
routes to review; "ask why this isn't working" routes to analysis.

🔴 **The last row is the exception.** Ping-pong is only entered when you ask for it explicitly —
"talk to Codex", "ping-pong this". Existing phrasings like "ask Codex about this" still route to
analysis. Making the light mode the default would be convenient, but then a request meant for
proper consultation quietly turns into a one-line answer.

Claude states **which mode it picked, in one line.** If it guessed wrong, just say so.

---

## 2. Nothing to do by hand

Claude calls Codex directly and reviews the answer when it comes back. There is nothing to
paste, and no "it's done" to report.

**You can keep working while it runs.** A small request takes 1–3 minutes; a broad one can run
20. Either way nothing blocks.

⚠️ Closing the session breaks the automatic pickup. The result files remain, so pointing
Claude at the path next time resumes where it left off.

---

## 2-1. Ping-pong — short exchanges, several of them

The three modes above all work the same way: throw one heavy thing, wait a while. That is far too
much ceremony for asking "Codex, what do you think?" mid-conversation. Ping-pong is for that.

```
✳️ Claude: <what Claude threw>
🔷 Codex:  <the answer, verbatim>
```

Both sides show, so you can follow the exchange and judge it as it goes. Claude relays the answer
without summarising it and adds its own take separately, underneath.

**The same topic keeps going.** It resumes the Codex session, so earlier turns don't need
re-explaining. A new topic starts a new conversation.

### Point at what to look at, and it gets faster (revised 2026-08-25)

File exploration used to be **blocked outright**, on the theory that "letting it explore makes it
slow". **Six combinations measured on a real 320-file repo showed that premise was wrong.**

| Situation | Time | Commands Codex ran |
|---|---|---|
| Exploration open + light question | **7s** | **0** |
| Exploration open + question naming a file | 25s | 1 |
| **File shipped inline** (13KB), same question | **8s** | 0 |
| File shipped inline (56KB) | 12s | 0 |
| Exploration open + broad question with **no target** | **over 240s** | **105** |

What costs time is not permission to explore but **not being told where to look.** That is what
those 16-minute stalls actually were.

**So Claude now picks the files and ships them inline.** Codex doesn't have to find anything.
Measured, this was **both the fastest and the most accurate** — three times faster than making it
search, and it named the exact functions.

- Ask one thing at a time. If it isn't enough, throw another line — that is the point
- **It aborts itself past 60 seconds** (was 120). Only the bottom row above hits that, so if you
  hit it, **the target is what's missing**
- If the question is heavy, "analyse this" was the right mode to begin with. There is nothing to
  gain by forcing it through ping-pong

### What it leaves behind

One file: `docs/codex_rescue/<stamp>_chat_<slug>.md`, with turns appended to it. No run records
under `.log/`, which is why **ping-pong never appears in the Codex progress panel.** The
claudeStateBar extension's **Codex chat panel** reads these documents instead and shows a
conversation on one screen (1.11.0 and later).

Codex is given no write access. The script recovers the answer and writes the document itself.

⚠️ **Conversation documents travel through git; Codex sessions do not.** A conversation started on
another PC cannot be resumed here even with the document present, so it starts a new one. The
document records which machine it began on, so this is detected automatically.

---

## 2-2. Pushing back — analysis is no longer one-shot (new 2026-08-25)

**Why this exists** — the same fault was sent through "analyse this" **three times** without
reaching a conclusion. Then the user talked to Codex **directly for 11 turns** and got one.
**Same model, same reasoning effort.**

Digging through the execution records made the difference obvious.

| | 3rd analysis run | User talking directly |
|---|---|---|
| User turns | **1** (throw the request, done) | **11** |
| Codex reasoning blocks | 59 | **137** |

**The difference was turn count, not the model.** The formal mode wasn't a conversation — it was
a **drop-off**. Codex could offer a mid-way hypothesis and nobody would push back on it.

### What changed

After an answer lands, Claude can ask **"here's how I read you — is that right?"** The same Codex
session continues, so it answers **still holding the code, logs and calculations from turn 1.**

```
Turn 1  Claude → request       → Codex analyses
        Claude → appends ## Claude 검토 to the document
Turn 2  Claude → has Codex read that review back
        Codex  → "you read it as X, but I meant Y"
Turn 3  …as needed (cap: 11)
```

🔴 **The key is that Codex now reads `## Claude 검토`.** Before, Claude could write "rejected" and
it stayed in the document — **Codex never got the chance to argue back.**

### When it pushes back

Claude decides, on these grounds:

- **A Codex point was rejected** ← rejection is itself a reason to ask again. The rejection may be
  wrong, and Codex has no idea it was rejected
- **Codex endorsed Claude's hypothesis wholesale** ← that means no pushback was received
- The core symptom still isn't explained

You can also ask for it: **"ask again"** · "push back on that" · "have it rebut that".

### What it leaves behind

Turns accumulate in the one response document.

```
## Codex 원문              ← turn 1
## Claude 검토             ← becomes the input to the next turn
## 🔁 2턴 — Claude 반박
## 🔷 2턴 — Codex 재답변
```

The rebuttal is kept separately as `<stamp>_followup<N>_<slug>.md`.
**From turn 2 Codex only reads** — the script appends to the document on its behalf.

⚠️ **Documents travel through git; Codex sessions do not.** An analysis started on another machine
cannot be continued here even with the document present. The document records the machine it
started on, so this is detected automatically.

---

## 3. "Review" and "analyse" target different things

Getting this wrong wastes a run.

| | **Review** | **Analyse** |
|---|---|---|
| Target | **everything you changed** | **one problem** Claude is stuck on |
| Requires | **a git repo** | works anywhere |
| Codex receives | the git diff | **absolute paths to the raw sources + "open them yourself"** |
| Use when | before committing / shipping | you've tried several times and it still fails |

**Why analysis is the valuable one** — the request document carries **where the raw evidence
lives, as absolute paths.** Claude's hypothesis goes in too, but **short and near the bottom.**

🔴 **The order was inverted on 2026-08-25.** The hypothesis used to come first, which traps Codex
**inside Claude's field of view.** This actually happened: a recording existed on the server, but
the request listed it as "something I can provide on request" — so Codex ran `find`, saw the file
listed, **never opened it, and finished with "please send me more data."** That file held the answer.

Now:
- **Raw paths first**, hypothesis last and brief
- Written as **"here is what you can open right now"**, not "what I could give you"
- Seeing a file in `ls`/`find` **does not count as having opened it** (checked against the execution log)

⚠️ **Symptoms you saw or heard get asked about.** Audio dropouts, flicker, how often it feels like
it happens — none of that is in the code or the logs; **only a person knows it.** Leaving it out
makes the analysis half-blind. Build failures and compile errors are never asked about — those are
all in files.

Review scope is picked automatically — **uncommitted changes if there are any, otherwise a
diff against the default branch.** You can override it: "review against main", "just review
this commit".

> 💡 **Smaller requests are dramatically faster.** Two runs, each measured once: asking Codex
> to review every uncommitted change made it run a command per file and took **20 minutes**;
> putting just the code in question into a request document took **1 min 25 s**
> (36 commands → 4). When you're in a hurry, narrow it to "just look at this function".

---

## 4. Results are written to files

They accumulate under **`docs/codex_rescue/`** in your project.

```
260817_210036_review_auth-refactor.md        ← code review result
260817_182041_request_fcm-token-null.md      ← the request Claude wrote
260817_182041_response_fcm-token-null.md     ← Codex's answer + Claude's assessment (follow-up turns land here too)
260817_182041_followup2_fcm-token-null.md    ← push-back document (new 2026-08-25)
.log/260817_182041_events.jsonl              ← live run record (what the panel reads)
.scratch/                                    ← Codex's workbench (new 2026-08-25)
```

**`.scratch/` is what Codex made while investigating** — calculation scripts, intermediate data,
parse output. Temporary files used to be forbidden outright, which meant **calculations that need
a file** — waveform alignment, log re-aggregation — could never even start. That was part of why
analysis kept circling. What lands here is **evidence, not a violation**, and you open it when you
want to check how a number in the answer was derived. Like `.log/`, it is auto-excluded from git.

**Codex's text is never edited; Claude appends its assessment below it.** You never lose what
Codex actually said. These files are **meant to be committed**, and once they are, the next
session picks up the thread — but the skill never commits them for you.

**`.log/` excludes itself from git automatically** — the skill drops a `.gitignore` (containing
`*`) inside the directory when it creates it. That content is full command output, MCP tool
arguments and agent messages: both a leak risk and bulky (one measured run: 105 lines / 409 KB).
The request/response `.md` files live one level up, so they are unaffected and still committed.

### How much it accumulates, and cleaning up

How much a run adds **varies a lot with what it did.** The measurements on record: one run came
to 105 lines / 409 KB, other samples had event files of 394–750 KB, and in one 464 KB sample 86%
was captured command output. Read those as **samples, not an average.**
**Nothing is deleted automatically by default.**

With the claudeStateBar extension you have two options:

- **Manual** — the 🗑 button on a run card. It takes the **whole run, documents included, to the
  trash** without asking; the 🗑 at the top of the panel is where you get it back. Only appears
  on finished runs. Whether the documents go too is decided **when you delete for good from the
  trash** — keep them and the run stays visible as a `documents only` card
- **Automatic** — enable `claudeContextBar.codexRunAutoCleanup` and the extension cleans up once
  per activation. Retention is `claudeContextBar.codexRunRetentionDays` (default 7) and whether
  documents go too is `claudeContextBar.codexRunDeleteDocs` (default off). Live or still-locked
  runs are never touched

---

## 5. Watching it work (the claudeStateBar panel)

Codex used to be a black box for the minutes it ran. The extension now shows its activity
**live**.

**Open it** — click the status bar → `Codex runs (N)`, or `Ctrl+Shift+P` →
`claudeStateBar: Show Codex Runs`.

What you see:

| | |
|---|---|
| **says / thinks** | Codex narrating what it's about to do — the most useful line on screen |
| **cmd** | commands it ran, with exit codes |
| **search · file · mcp** | web queries, files touched, tool calls |
| **plan** | shown as `2/5`, only when Codex actually produced a plan |
| **notice** | CLI advisories — **not errors** |

States progress `starting → running → finalizing → done / failed / stopped / unresponsive`.

- **finalizing** exists because Codex's turn ending isn't the run ending: the skill still has
  change detection, response recovery and log preservation to do. Calling that window "done"
  would report a finish that hasn't happened.
- **unresponsive** means the process looks killed. It is never promoted to "done". The verdict
  comes from **the heartbeat file going 30 seconds without an update** — no process is queried,
  so sleep or a slow filesystem can produce it too.
- The **completion chime** only plays for a run the extension **watched while it was live**
  (setting: `claudeContextBar.workflowCompleteBeep`). A run that had already finished before the
  extension started appears silently, and `unresponsive` isn't a finish, so it doesn't chime.
- **A row you can't read in full opens where it is when you click it** (extension 1.9.3+). One
  row at a time. What it shows is what the panel kept: 4,000 characters of a message, 600 of a
  command — past that, read `.log/<stamp>_events.jsonl` itself.
- The panel lists at most the **20 most recent runs per workspace folder**. Older ones are still
  on disk and still subject to cleanup, but they don't appear in the list.
- **A run with documents but no log** still appears, marked `documents only`. There is no activity
  list — nothing to build one from — but the request and response open as usual. That covers runs
  whose raw logs you purged, and documents a teammate committed that you pulled in. No mode chip
  is shown: that value lived in the deleted status file, and guessing it would be worse.

**It works in a Remote-SSH workspace too** — runs you started on the server show up in the same
list. This needs extension **1.9.2 or later**. **The extension itself doesn't go on the server** — it
runs locally and reads the remote files. But **starting a run on that server does require Codex
CLI and this skill to be installed there** (the same requirements as §0). Remotely the activity
list refreshes at most every 5 seconds (status and the chime stay at 2): remote files have no
range read, so a live run's record is fetched whole each time.

⚠️ **No percentage is shown.** Codex doesn't declare how many tool calls remain, so overall
progress genuinely cannot be computed. Elapsed time and activity count are shown instead.

### After a push-back turn (2026-08-25)

**The same card comes back to life.** A push-back reuses the original run's stamp and appends to
its record, so the extension reads that as "it ran again" and revives the frozen card. The mode
chip changes to `FOLLOWUP`.

⚠️ **The activity list, however, is not yet correct.** `codex exec resume` renumbers activities
from `item_0` at the start of every turn, and the extension's parser looks items up by that number
and overwrites them. So an earlier turn's activities are replaced by the later turn's wherever the
numbers collide. In the 2-turn round trip that was measured, 12 of 20 activities (12 in turn 1 plus
8 in turn 2) survived on screen, and one item that got the same number changed kind outright — a
`file change` in turn 1 became a `command execution` in turn 2. Items whose numbers don't collide
survive untouched, so what goes missing isn't consistent either. The status staying at `finalizing`
comes from the same place: the earlier turn's end signal isn't cleared when the next turn starts.

**This is a confirmed problem and a fix is in progress.** What is wrong is the activity list drawn
on the card, and nothing else — the request and response documents and the conversation itself are
unaffected. If you need the exact record, read `.log/<stamp>_events.jsonl` directly: both turns are
there in full.

⚠️ **Deleting isn't complete either** — removing a card with 🗑 **leaves the rebuttal documents
(`_followup<N>_`) and per-turn records (`_t<N>_`) behind.** Both items are written up in
`docs/CODEX_RESCUE_MULTITURN_IMPACT.md`. Until then, remove those by hand.

---

## 6. Codex can't quietly change things

Unless you asked it to fix something, it **doesn't touch your production code** — and that isn't
enforced by the prompt alone. The filesystem is **compared before and after**, and anything beyond
the expected outputs is reported.

Detected changes are **never reverted automatically.** Keeping or undoing them is your call.

🔴 **The boundary was redrawn on 2026-08-25.** It used to be "the response document is the only
file you may write", with **even temporary files forbidden**. But measurement showed the sandbox
already allowed disk reads and temp-directory writes — **what was blocking Codex was the prompt,
not the permissions.** As a result it could never begin any investigation that needed a file, and
kept reasoning in the abstract without reaching a conclusion.

There is now **one** boundary.

| | |
|---|---|
| ❌ **Blocked** | Editing production files — source, config, data. Commands that change git state |
| ✅ **Open** | Disk reads · running calculations and scripts · writing to `.scratch/` · network **reads** |

Network access was opened so Codex can check documentation, issues and release notes directly.
It is **read-only**; uploading anything is forbidden. Turn it off with `CR_NETWORK=false`.

Files appearing in `.scratch/` are reported as **`🧪 investigation traces`, not as a violation.**

Even when you *do* say "fix it", it doesn't start immediately: **the script refuses** until
approved. Previously the "shall I proceed?" question was just a convention Claude could
forget; now code enforces it.

### What change detection cannot catch

"No changes beyond the response file" means **"no net difference within the watched scope"**.
These slip through:

- Inside excluded paths — `.git` · `node_modules` · `build` · `.gradle` · `.dart_tool` ·
  `.venv` · `.next` · `__pycache__`
- Create-then-delete, and restoring an existing file's mtime
- Delayed writes from a child process after the run returns
- **Attribution** — a change from a sync client or another process is indistinguishable

🔴 **Detection only holds inside the project folder.** That is why `CR_SANDBOX=danger-full-access`
is not used — under it, edits outside the folder are **undetectable in principle** while the report
still says "no changes". A watchman closing its eyes and calling it safe. Use it anyway and the
report carries a warning.

For a stronger guarantee use `CR_SANDBOX=read-only`, which denies Codex write access outright.
⚠️ Note that this also blocks `.scratch/`, confining the investigation to pure reasoning — not
recommended for everyday use.

---

## 7. Gotchas

- **Review only works in a git repo.** Elsewhere, ask for analysis instead
- **Don't apply every review finding.** False positives and taste calls are mixed in
- **Scope and focus can't be combined** (a Codex CLI restriction). "Review against main,
  focusing on auth" makes the scope less precise. **If scope matters, drop the focus hint**
- **An answer arriving isn't the same as an answer succeeding** — Codex sometimes replies
  "I couldn't read the file". Claude checks the content, but if a reply looks off, ask for the log
- **Not everything labelled `error` is one** — CLI advisories arrive on the same channel.
  The panel shows those as `notice` (amber) to keep them distinct

### How far each capability has been verified

| Capability | Status |
|---|---|
| Core round trip (consult / review, dispatch, recovery, auto-resume) | ✅ measured |
| Fix mode (Codex editing directly) | ✅ measured — but only one **obvious single-line fix**; multi-file changes untested |
| Progress panel · completion chime · live updates | ✅ measured |
| Running on a Linux server | ✅ measured — but on **one server only**: one review, one analysis (2026-08-21). Others untried |
| Progress panel over Remote-SSH | ✅ measured — needs claudeStateBar **1.9.2 or later** |
| "review against main" / "just this commit" | ❌ dry-run (`CR_DRYRUN`) only; never actually run |
| The panel's **unresponsive** verdict (30 s heartbeat) | ❌ unmeasured — reproducing it means killing the process. The `stale` that `send.sh` reports (response file unchanged) is **a different thing** and that one is measured |
| **Push-back / multi-turn (new 2026-08-25)** | ✅ measured — 6 plumbing paths plus a **real 2-turn round trip**. Context carries over; writes are genuinely blocked from turn 2.<br>❌ 3+ turns, hitting the turn cap, and crash recovery are unverified |
| **Ping-pong targeting + 60 s limit** | ✅ measured — 6 combinations on a 320-file repo (see §2-1).<br>⚠️ That repo is mostly binaries, so **a larger source tree may be slower** |
| **Relaxed permissions (network, `.scratch/`)** | ✅ plumbing measured — network answered "open", and a file in `.scratch/` is reported as `🧪` rather than a violation.<br>❌ **Leak risk is unverified** — disk reads were always open, so opening the network couples reading with transmission. "Read-only" rests on prompt compliance |
| **Whether it actually opens the raw sources** | ❌ **the central question is unverified.** The prohibitions are gone, but "does Codex really open them now" is **only decided by the next real run** |
| The **activity list** after a push-back turn | ❌ **measured to be wrong** — every turn renumbers from `item_0`, so the earlier turn's activities are overwritten (12 of 20 survived). The status also stays at `finalizing`. Fix in progress — see `docs/CODEX_RESCUE_MULTITURN_IMPACT.md` |
| The card reviving after a push-back · `FOLLOWUP` chip | ✅ measured — the frozen card is picked up again and the mode chip changes |

---

## 8. When it doesn't work

| Symptom | Cause / fix |
|---|---|
| "not a git repo" | Review is git-only. Ask for **analysis** instead |
| "nothing to review" | Everything is committed and you're on the default branch. Name a target: "just review this commit" |
| **Codex can't read files** | Windows sandbox account failure (error 1332). The skill works around it with `windows.sandbox=unelevated`; if it persists, check `~/.codex/config.toml` |
| The answer is identical to last time | The response file's content wasn't updated this run. `send.sh` compares the before/after hash and flags it `stale` |
| **"already running"** | The same stamp was launched twice. Wait for the first to finish (this prevents overwriting files) |
| Panel is empty | Nothing has run in this workspace yet. Run it once |
| **Empty on a remote workspace** | If your extension predates 1.9.2, that's the cause — earlier versions couldn't read remote files. On 1.9.3 and still empty, check that the remote `docs/codex_rescue/.log/` holds `*_events.jsonl` and that you can read it |
| No live updates | Your skill copy may predate the live-record feature. Reinstall from §0 |
| `CR_TIMEOUT` is rejected | It was removed — measured not to work on Windows, so the script refuses it |

---

## 9. Environment variables

| Variable | Purpose |
|---|---|
| `CR_MODEL=<model>` | Pick the Codex model |
| `CR_SANDBOX=read-only` | Deny Codex write access entirely (safest) |
| `CR_ALLOW_EDIT=1` | Unlock fix mode — **only after approval** |
| `CR_DRYRUN=1` | Print the assembled command without running Codex. The log/scratch directories and their `.gitignore` may still be created |
| `CR_WIN_SANDBOX=<mode>` | Windows sandbox implementation. Defaults to `unelevated` (the error-1332 workaround); leave it empty to keep whatever `config.toml` says |
| `CR_NETWORK=false` | Block network access (default is **allowed**, read-only) — new 2026-08-25 |
| `CR_CONSULT_MAX_TURN=<n>` | Cap on push-back turns. Default **11** — the measured turn count at which a direct conversation reached its conclusion |
| `CR_CHAT_LIMIT=<seconds>` | Ping-pong time limit. Default **60** (was 120). Opening exploration requires setting this **explicitly** |
| `CR_CHAT_LOOK_MAX=<bytes>` | Cap on the total size of material shipped inline in ping-pong. Default 65536 |

---

## In one line

> Codex is **an auditor, not a worker.**
> Claude and you do the fixing — that's what keeps the context intact.
