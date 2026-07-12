# Changelog

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
