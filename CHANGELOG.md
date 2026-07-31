# Changelog

## [1.8.0] - 2026-08-01

### Added
- **OpenAI Codex sessions in the status bar.** Claude and Codex now appear side by side, told apart by an icon prefix — **✳ Claude** / **⬢ Codex**. Codex sessions get the same treatment as Claude ones: context percentage, model and effort, idle dimming, `hideAfter` hiding, manual hide/restore with activity-based auto-unhide, threshold colours, and the completion beep. Thresholds and sounds are **shared** — there are no Codex-specific copies to configure.
  - Data comes only from the local rollout logs (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). No network calls, and the Codex app-server is deliberately not used: a separately launched app-server cannot observe threads already loaded by the running Codex client, so it would add a process without adding signal.
  - Context occupancy is `last_token_usage.total_tokens ÷ model_context_window`. The cumulative lifetime total is shown as its own tooltip line and is never divided by the context window — those two numbers differ by orders of magnitude (a session reading 39% had 27.5M cumulative tokens).
  - The completion beep keys off Codex's explicit `task_complete` event rather than a heuristic, and reuses the existing settle-debounce, so a follow-up landing inside the settle window still cancels it.
- **Codex account usage, read live and shared across windows.** Rate limits (`primary`/`secondary` window, plan type, reset time) come from the Codex app-server (`account/rateLimits/read`, ~0.6s round trip), polled on its own slow timer that is separate from the 30-second session poll. A non-secret cache in extension `globalStorage`, protected by an atomic cross-process lock and atomic replacement, lets one window probe while every other local/Remote-SSH window reuses and watches the same value. If no live/shared value has succeeded, the extension falls back to the newest visible rollout snapshot. The context monitor is unaffected by any of these failures.
- **Remote-SSH support for Codex**, the same way Claude already has it: the extension runs locally but reads the remote host's files through `vscode.workspace.fs`, and the remote Codex home is found by probing `/root` and `/home/*` for a real `.codex/sessions` (mirroring how `~/.claude/projects` is located). The file watcher works remotely too, so remote Codex sessions still update within seconds.
  - Read strategy differs by host: locally we read only the byte ranges we need (14.1MB rollout in ~4ms), while remotely the VS Code filesystem API has no range read, so the file is read whole — the same thing Claude already does over Remote-SSH, with the addition that Codex **skips the read entirely when mtime and size are unchanged**. Remote rollouts above 32MB are skipped and logged.
- **Three new settings**: `claudeContextBar.codex.enabled` (default on; a no-op when Codex isn't installed), `claudeContextBar.codex.home` (empty = auto-detect), and `claudeContextBar.codex.scanDays` (default 3). All three are editable from the settings panel.

### Fixed
- **Provider glyph colours no longer follow context usage.** Claude's existing `✳` glyph stays orange and Codex's existing `⬢` glyph stays blue while the adjacent usage text retains its warning/danger/idle colours.
- **Provider glyphs are larger and sit closer to their labels.** The same `✳` / `⬢` silhouettes now use a bundled native-size product-icon font, and their separately coloured status-bar slots are compactly joined to the adjacent usage text.
- **Provider order in the context bar is now stable.** Claude sessions always occupy the left side of the session group and Codex sessions the right, regardless of which provider was updated most recently.
- **Codex model names are no longer abbreviated by compact mode.** The status bar now renders `gpt-5.6-sol` as the readable `gpt 5.6 sol` (separator-only formatting) instead of the ambiguous `G5.6s`; compact project-name behavior is unchanged.
- **Codex now shows the conversation selected by this VS Code window instead of accumulating unrelated windows and stale rollouts.** The default `scope: workspace` previously meant “every recent rollout whose creation `cwd` matches this folder,” so reopening one Codex thread in another project/Remote window could produce `project`, `project-2`, `project-3` across every status bar. Active Codex editor tabs are resolved from their VS Code tab URI; sidebar chats use the window's structural `conversationId` marker. The newest selected UUID is retained when the window loses focus or reloads, because OpenAI also emits `active=false` for ordinary focus loss. Remote‑SSH windows now read the matching remote OpenAI extension-host log, paired by PID or bounded activation time. Only that UUID's rollout is rendered. Explicit `scope: all` keeps the old recent-session list.
- **Shared Codex reset time could explode from days into millions of days.** The app-server's epoch-seconds timestamp was normalized to milliseconds before caching, then multiplied by 1000 again when another window read the cache. App-server and cache window parsers are now separate, preserving both the millisecond reset time and `windowMinutes`.
- **Codex disappeared entirely in a window when no persisted session matched that workspace.** The live account snapshot was available but had no session item to attach to. Such windows now show a standalone `⬢ Codex` account-remaining item and replace it with the normal session item when one becomes discoverable; model/context values are never guessed from another workspace. Standalone Claude plan visibility is now provider-scoped too, so a Codex-only window no longer suppresses it.
- **Codex account percentage was displayed backwards.** The app-server returns consumed usage as `usedPercent`, but the ChatGPT usage screen presents the amount remaining. Status-bar and tooltip account percentages now show `100 - usedPercent` and label the value as remaining (for example, 58% used becomes 42% remaining).
- **Codex weekly usage differed from one session to the next.** Every rollout embeds whatever the rate limit was when *that* session last ran, so reading each session's own snapshot made five sessions report five different weekly figures (observed: 52/30/28/22/19%) for a single account — which makes the number meaningless. Account usage is now account-scoped: one live reading, shared by every Codex item.
- **Different VS Code windows could still disagree on Codex weekly usage.** Each extension host kept its own polling phase and in-memory value, and a newer rollout record could override a fresher account reading merely because its timestamp was later. Windows now coordinate one probe through the shared cache; an available account reading always wins over per-thread rollout snapshots.
- **SQLite canonical Windows paths did not match workspace paths.** `\\?\C:\...` and `\\?\UNC\server\share\...` are now normalized to their ordinary drive/UNC forms without damaging drive or POSIX roots.
- **Reset times on multi-day windows now show the date.** A reset that wasn't today rendered as `PM 4:16 (Wed)` — but on a 7-day cycle "Wed" could be this week's or next week's. It now reads `8/5 (Wed) PM 4:16`. This affects Codex's rate-limit window and **Claude's weekly limit**, which had the same ambiguity; Claude's 5-hour session reset is same-day and still shows just the time.
- **Account usage attached to the wrong provider.** Plan usage was merged into whichever session sorted first overall, so once Codex sessions could reach the top the Claude plan numbers would have been pinned onto a Codex item. Usage is now merged per provider — each provider's leading session carries its own.

### Known limitations
- **A remote window shows the remote host's Codex sessions only** — Codex running on your local machine is not listed there, and vice versa. Claude behaves identically, so the two providers stay consistent.
- **No Codex workflow/sub-agent viewer**, and no question-wait or stuck-tool beeps for Codex — those signals have no Codex equivalent on disk yet. Clicking a Codex item skips the workflow menu entirely rather than offering an always-empty one.
- **Codex sub-agent threads are not shown.** Rollouts whose `source` is a sub-agent are excluded; older ones carry no parent link at all, so listing them would produce unattributable entries.
- **No deletion of Codex logs.**
- **Sidebar current-thread detection depends on an OpenAI log compatibility marker.** Active Codex editor tabs use the stable VS Code tab URI. If the sidebar marker changes in a future OpenAI release, that window safely falls back to account-only usage instead of showing an unrelated rollout.

### Privacy
- Codex rollout logs contain full conversation text. The rollout parser extracts **only** structural fields — token counts, timestamps, model, effort, `cwd` — and never stores or logs message bodies. For sidebar selection, the current window's OpenAI `Codex.log` is scanned only for the exact view-activity marker, boolean, and conversation UUID; all other text is discarded. `auth.json` is never touched.

### Internal
- New `src/providers/codex/` (pure `rolloutParser`, `discovery`, dual-mode `tailReader`, `sessionProvider`, `display`) and a shared `src/core/sessionTypes.ts`. The parser has no VS Code dependency and was validated against all 20 real rollout files on the development machine: 0 parse errors, 0 unknown record types, and a 14.1MB file parsed in ~4ms via head/tail windowing rather than a full read.
- The local (byte-range) and remote (whole-file) read paths were cross-checked against the same rollout data and produce identical results across every session and field, so remote support is not a separate code path with its own behaviour.

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
