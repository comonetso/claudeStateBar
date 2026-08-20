# Claude Code & Codex Status Bar

**Claude Code and OpenAI Codex, side by side in your VS Code status bar** — per‑session context usage, model and effort, task‑complete beeps, and account limits (Claude.ai 5‑hour session & weekly, Codex weekly usage), with a live Workflow/Agent viewer panel, Remote‑SSH support, Telegram reset alerts, and a bilingual settings panel.

[![GitHub stars](https://img.shields.io/github/stars/comonetso/claudeStateBar?style=social)](https://github.com/comonetso/claudeStateBar)

> ### ⭐ Star the repo, please
> Plenty of people install this. Almost nobody stars it.
> A star is the only signal that tells me anyone actually uses this thing — and it's what decides whether I keep building it.
> It takes two seconds: **[github.com/comonetso/claudeStateBar](https://github.com/comonetso/claudeStateBar)**

🇰🇷 한국어 문서: [README.ko.md](README.ko.md)

---

## Two layers in one status bar

Claude Code & Codex Status Bar shows two complementary things, merged into a single hover tooltip with clearly separated sections:

### 🧠 claudeContext — Claude Code context monitor
Reads Claude Code's local session logs (`~/.claude/projects/*.jsonl`) and shows, per active session:
- **Live context usage %** (tokens used vs. the model's limit)
- **Per‑session monitoring** — each Claude Code session gets its own status‑bar item
- **Model‑aware limits** — Opus 4.x, Fable/Mythos, Sonnet 4.6+/5+, or models with `1m` in their ID → 1,000,000 tokens; others (Sonnet ≤4.5, Haiku, etc.) → 200,000 (configurable)
- **Model + effort + speed** — e.g. `Opus 4.7 · xHigh⁺ · ⚡fast` (see [Effort display](#️-effort-level-display))
- **Color‑coded warnings** — normal / warning (≥50%) / danger (≥75%) backgrounds
- **Two‑tier idle** — sessions dim after `idleTimeout` (default 180s) and fully hide after `hideAfter`
- **Ghost‑session detection** — hides stale sessions after `/clear` or tab close; auto‑unhides on new activity
- **Compact mode & custom short names** — project names such as `my-cool-project → MCP`; Codex model names stay fully readable
- **Live activity indicator** — shows elapsed seconds while Claude is thinking (🤔) or responding

### 📊 claudeState — Claude.ai plan usage
Fetches your **account‑wide plan usage** directly from claude.ai (no SDK, no extra service):
- **5‑hour session limit %** with reset countdown (merged into the first session item)
- **Weekly usage %**, plus a per‑model breakdown in the tooltip (**Fable / Opus / Sonnet** — whichever models claude.ai currently reports)
- **Session‑reset detection** → optional **Telegram** notification when your 5‑hour window resets
- Credentials (Session Key, Bot Token) are stored **encrypted** via VS Code SecretStorage

Both layers describe **Claude** sessions, which are prefixed **✳** in the status bar. Codex sessions are prefixed **⬢** — see [OpenAI Codex session monitoring](#-openai-codex-session-monitoring-phase-1).

---

## ⬢ OpenAI Codex session monitoring (Phase 1)

The status bar now shows **Claude sessions and OpenAI Codex sessions at the same time**. An icon prefix tells them apart:

- **✳** — Claude session
- **⬢** — Codex session

Codex **context** data comes from files only: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — on your local machine, or on the remote host in a Remote‑SSH window. No network calls. **Account usage** is a separate path: it is queried live from the Codex app‑server (see below).

With the default `scope: workspace`, Codex shows **the conversation UUID last selected in this VS Code window**. The extension first reads the stable URI of an active Codex editor tab; sidebar chats fall back to structural `conversationId` markers in this window's OpenAI `Codex.log`. Losing window focus or reloading VS Code does not erase that per-window UUID. Only that UUID's rollout is opened, even if the chat was created in another project or reopened in a Remote‑SSH window. It never substitutes another recent rollout. If no UUID can be resolved, only the account-usage item is shown. Set `scope: all` explicitly to restore the machine/host-wide list of up to five recent sessions.

**Codex lists conversations per device, not per project.** Reopening VS Code restores whatever chat you last viewed — often one created in a different repository — and the status bar honestly reports that chat, because it really is the one this window is showing. To keep that from reading as your current folder's context, a conversation whose `cwd` is not a folder open in this window is marked: the **`⬢` glyph turns warning-coloured**, an **`↗`** follows the project name, and the tooltip states the conversation's full path. Starting a new conversation clears the mark.

Within the context-bar group, **Claude sessions are always on the left and Codex sessions are always on the right**. Activity timestamps never reorder one provider across the other.

The provider glyph is the identity cue: **Claude's `✳` is orange** and **Codex's `⬢` is blue**. The original silhouettes are bundled as larger native-size product icons, and their separate colour slots are compactly joined to the usage text. Because the glyph owns its own colour slot, the text is free to signal the usage threshold without wasting status-bar space. The glyph changes colour for exactly one reason: a Codex conversation belonging to another project (above).

### What a Codex item shows

- **Context usage %** — the latest `last_token_usage.total_tokens` ÷ `model_context_window`
- **Model name** — e.g. `gpt-5.6-sol` → `gpt 5.6 sol`; only separators are made readable, and Codex model names are never shortened by compact mode
- **Effort** — Low / Medium / High / xHigh, etc.
- **Idle dimming & `hideAfter` hiding** — exactly the same rules as Claude
- **Completion beep** — driven by Codex's `task_complete` event. It **shares Claude's completion sound and threshold settings** — there is no separate Codex sound setting.
- **Tooltip** — Codex weekly/secondary limits (used percentage, reset times, plan type) + context token breakdown + the session's cumulative processed tokens

### Codex account usage (rate limits)

Read **live from the Codex app‑server**. The extension briefly spawns a `codex app-server` process and asks it for `account/rateLimits/read` over JSON‑RPC — a measured round trip of about **0.6–0.9 s**.

The app-server reports a consumed `usedPercent`, and that consumed figure is what the status bar and tooltip show — the same direction as the Claude plan block right next to it, so a bigger number always means "closer to the limit". Note that the ChatGPT usage screen states the complementary amount still available: what it calls **42% remaining** appears here as **58%** used.

The tooltip’s **Session processed total** comes from rollout `total_token_usage.total_tokens`. It is the cumulative token volume processed across model calls in this conversation (including cached input), not the current context size and not the account’s weekly-limit usage.

This runs on its **own slow timer, separate from the 30‑second session refresh**. It shares the `claudeState.refreshIntervalSec` value but is clamped to a **minimum of 60 seconds**, so no process is spawned on every 30‑second poll. This is exactly symmetric with how Claude polls the claude.ai usage API.

**Why live instead of the log?** Codex limits use a **7‑day rolling window**, so the real numbers go down on their own even when you aren't using Codex. Reading only a log snapshot would freeze the value whenever you don't touch Codex for a few days.

**Fallback order:**

1. Live app‑server query, coordinated through one cross-window shared cache
2. If no live/shared value has ever succeeded, the newest `rate_limits` snapshot available from the visible rollout logs
3. If a previous shared live value exists, keep it and mark it as a **stale value** when it ages out
4. If there is nothing at all, usage is not shown

The tooltip shows the **source next to the observation time** — `live`, or `from session log`.

> The old "only refreshes while Codex is actually working" caveat now applies **only to the fallback** (step 2): a rollout snapshot is written while Codex works, so an idle session's snapshot goes stale.

All VS Code windows in the same local profile use a small, non-secret file in the extension's `globalStorage`. An atomic `wx` lock elects one window to run `account/rateLimits/read`; the others consume the atomically replaced cache and watch it for changes. This avoids one app-server process per window and prevents a newer-but-stale rollout snapshot from overriding the account-authoritative live value.

If the current window has no recorded Codex conversation UUID or its rollout is unavailable, account usage is still shown as a standalone **`⬢ Codex`** item. This is intentionally account-only: the extension does not attach another window's model or context figures by guesswork. Once a UUID is resolved, the standalone item is replaced by that conversation's normal session item.

Codex account usage is a **separate concept** from Claude's 5‑hour / weekly plan usage. Each provider's usage is merged only into that provider's own first session item.

### Codex settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.codex.enabled` | `true` | Show Codex sessions on/off. If Codex isn't installed this is an immediate no‑op, so it costs nothing. |
| `claudeContextBar.codex.home` | `""` | Codex state directory. Leave empty for auto‑detection (`$CODEX_HOME` → `~/.codex`). **If you set it explicitly and the path doesn't exist, there is no fallback — nothing is shown and the reason is written to the log.** |
| `claudeContextBar.codex.scanDays` | `3` | How many recent `sessions/YYYY/MM/DD` folders to scan in `scope: all`. Current-chat mode locates the selected UUID directly, including an older reopened chat. |

Everything else is **shared between Claude and Codex** — warning/danger thresholds, sounds, `compactMode`, `idleTimeout`, `hideAfter`, `scope`, and so on. There are no Codex‑specific threshold or sound settings.

### Known limitations (Phase 1)

- **Current-chat mode follows the Codex UI, not host ownership.** A Remote‑SSH window can run the Codex webview on the local UI host, so the selected conversation may live in local `CODEX_HOME`; it can also refer to a rollout in the configured/remote Codex home. The exact selected UUID is tried against the configured host first and the local UI home only when no explicit `codex.home` override forbids fallback.
- **No Codex workflow / sub‑agent viewer in this extension** — clicking a Codex session does not open the Claude workflow menu. Explicit spawned-agent links are read only for the all-agents-complete sound; Codex's own background-agent panel remains the place to inspect or open individual threads.
- **Codex sub‑agent sessions are not shown as status-bar items** — spawned-agent rollouts are aggregated under their parent turn for the completion sound, while internal guardian rollouts remain excluded.
- **No Codex question‑pause beep or stuck detection yet.**
- **No deletion of Codex rollout/session logs.** (The Codex Runs panel does delete `codex_rescue` run records, but only when you ask it to — see that section.)
- **Account usage is queried from your *local* `codex`, even in a Remote‑SSH window** — the live query runs the **local** `codex` executable, so the figures reflect your local account. With the same ChatGPT account the numbers are identical; with a different account they can differ. (Context monitoring is unaffected — it reads the remote files correctly.)
- **If `codex` isn't available or the app‑server query fails, the context monitor keeps working normally** — only usage falls back to the log snapshot. The query has a **15‑second timeout**, and the helper process is cleaned up every time (verified in practice: no process leaks).
- **Sidebar selection uses an internal OpenAI log marker as a compatibility fallback.** Active Codex editor tabs use the stable VS Code tab URI. The newest `active=true` UUID is retained per window because `active=false` also means ordinary window focus loss. On Remote‑SSH, the local window is matched to its remote OpenAI extension-host log by process ID, with activation time as a bounded fallback. A future OpenAI log-format change can temporarily reduce a sidebar-only window to the account-only item. `scope: all` intentionally remains a recent-session list.

### Privacy

Codex rollout logs contain the full text of your conversations, but the rollout parser extracts **only structural fields** — token/rate-limit counts, timestamps, model/effort, `cwd`, task lifecycle, and explicit spawned-agent parent/thread IDs. To identify a sidebar chat, the matching local or remote OpenAI `Codex.log` is scanned for the exact `thread_stream_view_activity_changed` marker, its boolean, and its UUID; all other log text is discarded immediately. Message bodies are never stored or written to this extension's log. `auth.json` is never accessed.

---

## 🌐 Remote‑SSH support

Working over **Remote‑SSH**? Claude Code & Codex Status Bar runs as a **UI (local) extension** so it can do both jobs at once:

- **Plan usage** is fetched from your **local machine** via Electron's network stack — this passes Cloudflare's bot challenge. (Plain Node `https` from a remote/headless host gets a Cloudflare `403`, and cloud/datacenter IPs such as AWS EC2 are blocked regardless of TLS fingerprint.)
- **Token counts** are read from the **remote** host's `~/.claude/projects` through `vscode.workspace.fs`, which VS Code transparently routes over the SSH connection. The remote home is auto‑detected (`/root`, else `/home/*`).

**Install once locally — all your Remote‑SSH windows update automatically.** Because this is a `ui`-kind extension, you never need to reinstall it on each server.

In a Remote‑SSH window you see **remote session token usage and your plan usage together**, in one place. If a host genuinely can't reach claude.ai, the bar shows an honest "plan usage unavailable here" notice instead of a misleading "expired" error.

### Codex over Remote‑SSH

**Codex is covered too.** With `scope: all`, the extension reads the **remote** host's recent rollout files through `vscode.workspace.fs`; the remote home is found by probing `/root` and `/home/*` for a directory that actually contains `.codex/sessions`. With the default `scope: workspace`, it first resolves the exact conversation shown by this VS Code window and looks for that UUID on the remote host. If no explicit `codex.home` is set, it can then check the local UI host's Codex home because the Codex webview may own a local conversation even inside a Remote‑SSH window.

**One read‑path difference (performance note):** locally the extension reads only the byte range it needs, so even a 14.1 MB rollout takes a few milliseconds. Over Remote‑SSH the VS Code file API has no range read, so the **whole file** is read. This is the same thing Claude already does remotely (the largest Claude session file on this dev machine is 9.2 MB), and Codex adds an optimisation Claude doesn't have: **if a rollout's mtime and size are unchanged, the read is skipped entirely**. As a safeguard, remote rollout files **larger than 32 MB are skipped and logged**.

Local and remote read paths were verified to produce identical parsed results — 5 sessions × 12 fields, all matching, on the same rollout data.

⚠️ An explicit `codex.home` remains authoritative and never falls back. In `scope: all`, a remote window lists only the remote host's recent Codex sessions; the local UI fallback applies only to the exact selected conversation in the default current-chat mode.

⚠️ **Account usage is the one exception:** the live rate‑limit query runs your **local** `codex`, so even in a remote window the usage figures come from your **local** account. Same ChatGPT account → identical numbers; a different account → possibly different. Context monitoring is unaffected.

---

## 🎬 Workflow & Task Agent viewer panel

Open the **Workflow Viewer** from the session QuickPick menu to see a live WebView panel of every active Claude Code workflow and Task (Agent tool) sub‑agent:

- **Workflow progress** — each workflow appears as a card with its phases, running/done agents, per‑agent summary, elapsed time, and live activity
- **Full result expand** — long final reports fold into a `▶ summary` toggle so you can read the full output without clutter
- **Role labels** — each agent's role is auto‑extracted from its prompt header, so you see "Lens A: Bug Detection" instead of "agent-1"
- **Task (Agent tool) sub‑agents** — sub‑agents spawned via Claude Code's Agent tool are shown separately, grouped into **batches by start time** (5‑minute gap = new batch)
- **Per‑batch 🗑 cleanup** — delete finished task‑agent logs for a specific batch while keeping any still‑running agents untouched
- **Trash** — deleting a workflow moves it aside instead of destroying it. Open 🗑 at the top of the panel to restore it or delete it for good
- **Details-open persistence** — expanded `<details>` panels stay open across live re‑renders
- **Font size control** — `A−` / `A+` buttons adjust the panel text size
- **Bilingual UI** — full EN / 한국어 toggle, same as the settings panel

---

## 🔶 Codex progress panel (optional)

When Claude Code hands a problem to Codex for a second opinion, Codex runs for minutes with nothing on screen. You only see the result at the end, and until then you can't tell whether it's working or stuck. This panel looks inside that gap.

It needs the [`codex_rescue`](skills/codex_rescue/) skill for Claude Code, which is not bundled with this extension — the skill runs `codex exec` with write access to your workspace, and that shouldn't arrive as a side effect of installing a status-bar extension. Installation and usage are in [the guide](docs/codex-rescue-guide.md) ([한국어](docs/codex-rescue-guide.ko.md)).

With the skill installed, open it from the status-bar menu or `claudeStateBar: Show Codex Runs`. Each run is one card:

- **What Codex just said** — its own narration of what it's about to do, far more useful than a spinner
- **Commands, searches, file changes, MCP calls** — colour-coded by kind, commands with their exit code. Runs of consecutive successful commands or searches fold into one line you can expand; **failures never fold**, so they stay visible
- **Clipped rows open in place** — a row too wide for the panel expands where it is, wrapped, when you click it. One row stays open at a time. What you get is what the panel kept: messages up to 4,000 characters, a command's wrapped form up to 600. Past that, read the raw event log
- **A title you can read** — the request's `subject` heads the card, not the English slug. Requires a `codex_rescue` build from 2026-08-19 or later; older runs show the slug
- **Plan** — shown as `2/5`, but only when Codex actually produced one
- **Elapsed time and activity count** — no percentage. Codex never declares how many tool calls remain, so a progress bar would be fiction
- **Completion chime** — for runs the extension watched while they were live, using the same `claudeContextBar.workflowCompleteBeep` setting as workflow completion. A run that finished before the extension started appears silently

States run `starting → running → finalizing → done / failed / stopped / unresponsive`. `finalizing` is separate because Codex's turn ending isn't the run ending — the skill still has change detection and response recovery to do, and calling that window "done" would report a finish that hasn't happened. A killed run stays `unresponsive` instead of being promoted to done.

### What it creates in your project

The first run creates `docs/codex_rescue/` inside your project. The panel reads only this directory — no network calls.

- `<stamp>_request_*.md` · `<stamp>_response_*.md` — what was asked and what Codex answered. **These are meant to be committed**; the next session picks up the thread from them
- `.log/` — raw run records. Full command output lands here, so size varies a lot by run (measured samples: 409 KB for one run, 394–750 KB for others); the skill drops its own `.gitignore` in this directory to **keep it out of git**

Logs are never deleted by default. Manage them with the 🗑 button on a card (it asks each time whether to remove the documents too) or by enabling automatic cleanup — see [settings](#codex-run-logs-codex_rescue).

Deleting from a card doesn't destroy anything: it moves the run into a **trash** you open with 🗑 at the top of the panel, where you can put it back or delete it for good. The trash keeps things until you empty it. Two exceptions worth knowing — automatic cleanup deletes outright (it exists to reclaim disk, and a trash that fills as fast as cleanup empties would defeat that), and restoring never overwrites a file that has since taken the same name.

Works over Remote-SSH. Run records are read from the remote workspace through `vscode.workspace.fs` — the same path the extension already uses for Claude and Codex session files — so the extension itself doesn't go on the server. Starting a run there is a separate matter: that needs Codex CLI and the `codex_rescue` skill installed on the server. One difference: the VS Code file API has no range read, so a live run's event file is transferred whole instead of by delta. Status and the completion chime still refresh every 2 seconds; the activity list refreshes at most every 5 seconds, which keeps a few hundred KB off the wire on most of those ticks.

## 🎚️ Effort level display

The status bar and tooltip show Claude Code's current effort level:

| `effortLevel` value | Status bar | Meaning |
|---|---|---|
| `xhigh` | `xHigh⁺` | xhigh persisted to disk. If ultracode (`/ultracode`) was active, its dynamic‑workflows component is runtime‑only and indistinguishable from plain xhigh — the `⁺` marks this approximation. |
| `ultracode` / `ultra` | `🚀 Ultra` | Shown when the session‑scoped ultracode flag is detected at runtime. |
| `high` / `medium` / `low` / `max` | displayed as‑is | Standard effort levels |

Additional speed indicators:
- **⚡** — `/fast` mode is active
- **💭** — the most recent response contained a `thinking` block (extended thinking)

---

## 🔔 Sound alerts

Claude Code & Codex Status Bar plays configurable WAV sounds for key events:

| Event | Default sound | Setting |
|---|---|---|
| Context reaches warning threshold | `Ring01.wav` | `soundWarning` / `soundWarningGain` |
| Context reaches danger threshold | `Ring02.wav` | `soundDanger` / `soundDangerGain` |
| Claude finishes a response (`end_turn`) | `tada.wav` | `soundCompletion` / `soundCompletionGain` |
| Claude pauses to ask a question | `Speech On.wav` | `soundQuestion` / `soundQuestionGain` |
| All Claude workflow/task agents or Codex spawned agents complete | `Ring06.wav` | `soundWorkflow` / `soundWorkflowGain` / `workflowCompleteBeep` |

All sound paths can be overridden with your own WAV file. Gain is adjustable from 50% to 5000% (values above ~300% may distort). Use **`claudeStateBar: Test Beep Sound`** from the Command Palette to preview.

**Codex shares these sounds.** An ordinary Codex turn's completion beep (fired from `task_complete`) uses `soundCompletion`. When that parent turn spawned agents, its final all-agents completion is routed to `soundWorkflow` instead, so the ordinary and workflow sounds do not both fire. There are no Codex-specific sound settings. Codex question-pause and stuck-detection beeps are not implemented yet.

**Workflow‑complete beep gate** — the beep fires only when the extension watched a workflow go running → done in the current session. For Claude workflows (`wf_*`) it waits for the run's completion record (`workflows/<wfId>.json`, `status: "completed"`). For Codex it follows explicit `source.subagent.thread_spawn.parent_thread_id` links (including nested descendants) from the latest parent `task_started`, then requires both every linked spawned-agent rollout to finish and the parent `task_complete` — the same terminal boundary as `agent-turn-complete`. Sequential batches therefore beep **once at the very end**, not during a gap between batches. Failed/aborted runs do not fire the workflow-success sound, and stale work already complete when VS Code starts is baselined silently.

---

## 🖱️ Merged tooltip

Hovering any session item shows one tooltip split into two clearly labelled, colour‑divided sections:

```
my-project (a1b2c3d4)
──────── claudeState ────────
📊 Session: 30% — 5:40 PM (in 3h 27m)
📅 Weekly: 20% — 3:00 PM (Sat)
Fable: 12%  Opus: 4%
──────── claudeContext ────────
🤖 Model: claude-opus-4-7
🎚️ Effort: xHigh⁺
📊 Context Usage: 4%
| Cache Read | 8K |  | Cache Creation | 28K |  | Total | 37K / 1.0M |
🕐 Last updated: 2:10:58 PM
Click for menu (hide / restore / settings)
```

---

## ⚙️ Settings panel (webview, EN/KO)

Open **`claudeStateBar: Open Settings Panel`** from the Command Palette for a single panel with a runtime **English / 한국어** toggle. It collects Org ID, Session Key, refresh interval, Telegram Bot Token (auto‑detects your Chat ID), sound settings (with preview), and context‑monitor options. Sensitive values go to encrypted SecretStorage; everything else syncs with VS Code settings.

### How to get your credentials
- **Org ID** — claude.ai → DevTools → Network → any `/api/organizations/{UUID}/…` request
- **Session Key** — claude.ai → DevTools → Application → Cookies → `sessionKey`

---

## 🔔 Telegram session‑reset alerts (optional)

Add a Telegram Bot Token in settings, send your bot any message, click **"Link my Telegram"** (Chat ID auto‑detected), and you'll get a notification every time your Claude 5‑hour session window resets.

---

## 🚀 Auto‑start the next block once a reset is detected (optional, off by default)

A 5‑hour block is an **anchor model**: it starts from your **first message** and resets exactly 5 hours later — it does **not** auto‑cycle on a fixed schedule. So if a block resets while you're away, nothing opens until you next type.

Turn on **`claudeState.autoStartBlockOnReset`** and the extension fires a throwaway `claude -p` prompt **the moment it detects the block has closed** (session usage drops to 0%), opening the next block for you. The primer runs in its own temp directory, and those dummy sessions are filtered out of the status bar.

- **Fires once per reset** — even across multiple VS Code windows or a wake‑from‑sleep burst — via an atomic 10‑minute event lock.
- **Wake‑from‑sleep:** if the machine slept through a reset, the primer fires on the first poll after you wake, so you **wake up to an already‑started block**. While awake it fires on the **first successful plan‑usage poll after the block closes** — every 5 minutes by default (`claudeState.refreshIntervalSec`), so the new block anchors at detection, not at the reset instant.
- ⚠️ The new window starts counting down immediately — including while you sleep. That's the point, but know it.
- Requires the `claude` CLI on your PATH and VS Code running. While the machine is fully asleep, polling is paused — so the primer fires on **wake**, not at the exact reset instant. For reset‑instant firing you'd need an OS scheduler.

Toggle this and the Telegram reset alert from the **settings panel** (Telegram section).

### Billing safety

The primer only makes sense while headless `claude -p` runs draw on your **subscription**. Anthropic has floated billing them to the **API** instead, so:

- **It refuses to fire** when `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set in the environment (that call would bill API credit, not your plan), and turns the setting off with a warning.
- **It verifies** afterwards that a block actually opened by checking `sessionResetAt` moved to ~5 hours out — the tiny dummy prompt doesn't move session %, so resetAt is the real signal. With no API key there is no billing hazard, so a failed verification is logged but does **not** disable the feature.

---

## 🧹 Zombie status‑bar cleanup

When VS Code updates the extension while a window is open, the old instance's status‑bar items can remain as unresponsive "zombie" pixels. Claude Code & Codex Status Bar handles this two ways:

1. **Version‑change detection** — on activation, if the version changed since last run, a one‑time "Reload window to clear stale items?" notice appears.
2. **QuickPick cleanup** — the session menu always contains a **🗑 Clean up stale/zombie items (Reload Window)** option.

---

## Configuration

All keys are prefixed `claudeContextBar.*` or `claudeState.*`.

### Core display

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.baseColor` | `White` | Resting text colour, shared by every session. Colour otherwise means only the usage threshold |
| `claudeContextBar.contextLimitDefault` | `200000` | Context limit for standard models |
| `claudeContextBar.contextLimitOpus` | `1000000` | Context limit for 1M‑context models (Opus 4.x, Fable/Mythos, Sonnet 4.6+/5+) |
| `claudeContextBar.warningThreshold` | `50` | % for yellow warning background |
| `claudeContextBar.dangerThreshold` | `75` | % for red danger background |
| `claudeContextBar.refreshInterval` | `30` | Refresh interval (seconds) |
| `claudeContextBar.idleTimeout` | `180` | Seconds before a session is **dimmed** |
| `claudeContextBar.hideAfter` | `86400` | Seconds before a session is **hidden** (≥ idleTimeout) |
| `claudeContextBar.scope` | `workspace` | `workspace`: current folders for Claude and this window's last selected conversation UUID for Codex; `all`: recent sessions across projects/windows |
| `claudeContextBar.showModel` | `true` | Show model name next to the percentage |
| `claudeContextBar.compactMode` | `false` | Shorten project names |
| `claudeContextBar.shortNames` | `{}` | Custom short names, e.g. `{"my-project":"MP"}` |
| `claudeContextBar.autoCleanupOldVersions` | `true` | Auto‑delete older installed versions on activate |

### Sound alerts

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.soundWarning` | `""` | WAV path for warning threshold alert (empty = built‑in) |
| `claudeContextBar.soundWarningGain` | `100` | Warning sound gain % (50–5000) |
| `claudeContextBar.soundDanger` | `""` | WAV path for danger threshold alert |
| `claudeContextBar.soundDangerGain` | `100` | Danger sound gain % |
| `claudeContextBar.soundCompletion` | `""` | WAV path for response‑complete (`end_turn`) beep |
| `claudeContextBar.soundCompletionGain` | `100` | Completion sound gain % |
| `claudeContextBar.completionBeepSettleMs` | `3000` | Settle window (ms) before firing completion beep |
| `claudeContextBar.soundQuestion` | `""` | WAV path for question‑pause beep |
| `claudeContextBar.soundQuestionGain` | `100` | Question sound gain % |
| `claudeContextBar.soundWorkflow` | `""` | WAV path for Claude workflow/task-agent or Codex spawned-agent all-complete beep |
| `claudeContextBar.soundWorkflowGain` | `100` | Workflow complete sound gain % |
| `claudeContextBar.workflowCompleteBeep` | `true` | Fire the workflow sound when Claude workflow/task agents or Codex spawned agents all complete |
| `claudeContextBar.detectStuckToolUse` | `false` | Heuristic: beep if a tool_use has no follow‑up for `stuckToolUseThresholdSec` |
| `claudeContextBar.stuckToolUseThresholdSec` | `90` | Seconds of tool_use silence before stuck‑tool heuristic fires |

### Plan usage

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeState.orgId` | `""` | claude.ai Organization ID |
| `claudeState.language` | `en` | Settings‑panel language (`en` / `ko`) |
| `claudeState.refreshIntervalSec` | `300` | Plan‑usage poll interval (seconds). Also used for the Codex account‑usage query, clamped to a minimum of 60 s. |

(Session Key, Bot Token and Chat ID are stored in SecretStorage, not in settings.json.)

### Codex

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.codex.enabled` | `true` | Show Codex sessions on/off (immediate no‑op if Codex isn't installed) |
| `claudeContextBar.codex.home` | `""` | Codex state directory; empty = auto‑detect (`$CODEX_HOME` → `~/.codex`). An explicit path that doesn't exist shows nothing and is logged — no fallback. |
| `claudeContextBar.codex.scanDays` | `3` | How many recent date folders to scan in `scope: all`; current-chat mode locates the selected UUID directly |

### Codex run logs (codex_rescue)

Run logs vary a lot in size — measured samples run from **409 KB to 750 KB per run**, and in one
464 KB sample about 86% was captured command output. They are never deleted unless you opt in.

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.codexRunAutoCleanup` | `false` | Delete old run logs once per activation. Off by default because it deletes files. Runs that are still live, or still holding a lock, are never touched. |
| `claudeContextBar.codexRunRetentionDays` | `7` | How many days to keep, when auto-cleanup is on |
| `claudeContextBar.codexRunDeleteDocs` | `false` | Whether **automatic** cleanup also deletes the request/response/review `.md` documents. Off by default: those are the record of what was asked and answered, and are normally committed. Manual deletion ignores this and asks each time. |

Deleting a run from the panel (🗑) always asks whether to remove the documents too, and the
button only appears on finished runs. Whichever you pick, the files go to the panel's trash
rather than being unlinked — automatic cleanup is the only path that deletes outright.

All other settings — thresholds, sounds, `compactMode`, `idleTimeout`, `hideAfter`, `scope` — are shared by Claude and Codex.

---

## Requirements

- VS Code 1.74.0+
- [Claude Code](https://www.anthropic.com/claude-code) running and writing session logs to `~/.claude/projects/`
- For plan usage: a claude.ai account (Org ID + Session Key)
- For Codex sessions (optional): OpenAI Codex writing rollout logs to `~/.codex/sessions/` — on the **local** machine, or on the **remote host** in a Remote‑SSH window

## How it works

Context monitoring makes no network calls at all. The network paths that do exist are optional and separate: the claude.ai plan‑usage fetch, Telegram, and the Codex account‑usage probe described below. Context monitoring is pure disk reads of Claude Code's JSONL logs via `vscode.workspace.fs` (local or remote). Plan usage calls the claude.ai usage endpoint using Electron's Chromium network stack (to pass Cloudflare) with a plain‑`https` fallback. The workflow viewer reads `~/.claude/projects/<slug>/<uuid>/subagents/` directly from disk. Codex **context and spawned-agent completion** monitoring is likewise pure disk reads of `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` via `vscode.workspace.fs` (local or remote) — no network calls, and only structural fields are parsed. Codex **account usage** is read live from a short‑lived local `codex app-server` process over JSON‑RPC, on its own timer (≥ 60 s), falling back to the rollout log's `rate_limits` snapshot. When several VS Code windows are open, only **one** of them runs that probe — the result goes into a non‑secret cache in the extension's `globalStorage`, guarded by an atomic cross‑process lock, and every other window reads and watches that same value, so all windows always show the identical number.

---

## ⭐ Found this useful?

**Star the repo.** That's it — that's the whole ask.

Downloads tell me a number. A star tells me a person. If this has saved you from blowing through a context window or a weekly limit even once, please spend the two seconds:

**→ [github.com/comonetso/claudeStateBar](https://github.com/comonetso/claudeStateBar)**

Bug reports and feature requests are welcome in [Issues](https://github.com/comonetso/claudeStateBar/issues).

---

## Credits

Original context‑monitoring core by [Ed Zisk (@ezoosk)](https://github.com/ezoosk). This extension builds on that foundation, adding Claude.ai plan usage, Remote‑SSH support, Telegram notifications, a webview settings panel, workflow/agent viewer, sound alerts, and more — maintained by **Blueming**.

## License

MIT © 2026 Blueming. Original core © 2025 Ed Zisk.
