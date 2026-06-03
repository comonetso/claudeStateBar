# claudeStateBar

**Claude Code context usage + Claude.ai plan usage (5‑hour session & weekly) in your VS Code status bar — with a live Workflow/Agent viewer panel, sound alerts, Remote‑SSH support, Telegram reset alerts, and a bilingual settings panel.**

🇰🇷 한국어 문서: [README.ko.md](README.ko.md)

> **Fork notice.** This extension is a fork of [**claude-context-bar**](https://marketplace.visualstudio.com/items?itemName=ezoosk.claude-context-bar) by **Ed Zisk ([@ezoosk](https://github.com/ezoosk))**, which provides the original context‑monitoring core. It has been extended and is maintained by **Blueming** — adding Claude.ai plan usage, Remote‑SSH support, Telegram notifications, a webview settings panel, workflow/agent viewer, and sound alerts. The marketplace identifier (`ezoosk.claude-context-bar`) and `claudeContextBar.*` setting keys are kept for update compatibility.

---

## Two layers in one status bar

claudeStateBar shows two complementary things, merged into a single hover tooltip with clearly separated sections:

### 🧠 claudeContext — Claude Code context monitor
Reads Claude Code's local session logs (`~/.claude/projects/*.jsonl`) and shows, per active tab:
- **Live context usage %** (tokens used vs. the model's limit)
- **Per‑tab monitoring** — each Claude Code session gets its own status‑bar item
- **Model‑aware limits** — Opus 4.x / models with `1m` in their ID → 1,000,000 tokens; other models → 200,000 (configurable)
- **Model + effort + speed** — e.g. `Opus 4.7 · xHigh⁺ · ⚡fast` (see [Effort display](#-effort-level-display))
- **Color‑coded warnings** — normal / warning (≥50%) / danger (≥75%) backgrounds
- **Two‑tier idle** — sessions dim after `idleTimeout` (default 180s) and fully hide after `hideAfter`
- **Ghost‑session detection** — hides stale sessions after `/clear` or tab close; auto‑unhides on new activity
- **Compact mode & custom short names** — `my-cool-project → MCP`, `typescript → Tscript`

### 📊 claudeState — Claude.ai plan usage
Fetches your **account‑wide plan usage** directly from claude.ai (no SDK, no extra service):
- **5‑hour session limit %** with reset countdown (merged into the first session item)
- **Weekly usage %**, plus per‑model **Sonnet / Opus** breakdown in the tooltip
- **Session‑reset detection** → optional **Telegram** notification when your 5‑hour window resets
- Credentials (Session Key, Bot Token) are stored **encrypted** via VS Code SecretStorage

---

## 🌐 Remote‑SSH support (v1.7.0)

Working over **Remote‑SSH**? claudeStateBar runs as a **UI (local) extension** so it can do both jobs at once:

- **Plan usage** is fetched from your **local machine** via Electron's network stack — this passes Cloudflare's bot challenge. (Plain Node `https` from a remote/headless host gets a Cloudflare `403`, and cloud/datacenter IPs such as AWS EC2 are blocked regardless of TLS fingerprint — so fetching from the local side is the reliable path.)
- **Token counts** are read from the **remote** host's `~/.claude/projects` through `vscode.workspace.fs`, which VS Code transparently routes over the SSH connection. The remote home is auto‑detected (`/root`, else `/home/*`).

**Install once locally — all your Remote‑SSH windows update automatically.** Because this is a `ui`-kind extension, you never need to reinstall it on each server; the local copy serves every remote window.

The result: in a Remote‑SSH window you see **remote session token usage and your plan usage together**, in one place. If a host genuinely can't reach claude.ai, the bar shows an honest "plan usage unavailable here" notice (the Session Key is fine) instead of a misleading "expired" error.

---

## 🎬 Workflow & Task Agent viewer panel (v1.7.7+)

Open the **Workflow Viewer** from the session QuickPick menu to see a live WebView panel of every active Claude Code workflow and Task (Agent tool) sub‑agent:

- **Workflow progress** — each workflow appears as a card with its phases, running/done agents, per‑agent summary, elapsed time, and live activity
- **Full result expand** — long final reports fold into a `▶ summary` toggle so you can read the full output without clutter
- **Role labels** — each agent's role is auto‑extracted from its prompt header (`deriveAgentRoleLabels`), so you see "렌즈A: 버그 탐지" instead of "agent-1"
- **Task (Agent tool) sub‑agents** — sub‑agents spawned via Claude Code's Agent tool are shown separately, grouped into **batches by start time** (5‑minute gap = new batch), with a header like `서브에이전트 14:35 (3마리)`
- **Per‑batch 🗑 cleanup** — delete finished task‑agent logs for a specific batch while keeping any still‑running agents untouched
- **Details-open persistence** — expanded `<details>` panels stay open across live re‑renders
- **Font size control** — `A−` / `A+` buttons adjust the panel text size

---

## 🎚️ Effort level display (v1.5.0+)

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

## 🔔 Sound alerts (v1.7.x)

claudeStateBar plays configurable WAV sounds for key events:

| Event | Default sound | Setting |
|---|---|---|
| Context reaches warning threshold | `Ring01.wav` | `soundWarning` / `soundWarningGain` |
| Context reaches danger threshold | `Ring02.wav` | `soundDanger` / `soundDangerGain` |
| Claude finishes a response (`end_turn`) | `tada.wav` | `soundCompletion` / `soundCompletionGain` |
| Claude pauses to ask a question | `Speech On.wav` | `soundQuestion` / `soundQuestionGain` |
| All workflow / task‑agent sub‑agents complete | `Ring06.wav` | `soundWorkflow` / `soundWorkflowGain` / `workflowCompleteBeep` |

All sound paths can be overridden with your own WAV file. Gain is adjustable from 50% to 5000% (values above ~300% may distort). Use **`claudeStateBar: Test Beep Sound`** from the Command Palette to preview.

**Workflow‑complete beep gate** — the beep fires only when the extension actually watches a workflow transition from running → done in the current session. Stale workflows already done when VS Code starts are baselined silently.

---

## 🖱️ Merged tooltip

Hovering any session item shows one tooltip split into two clearly labelled, colour‑divided sections:

```
sported_new (379508f7)
──────── claudeState ────────      ← plan usage (blue divider)
📊 Session: 30% — 5:40 PM (in 3h 27m)
📅 Weekly: 20% — 3:00 PM (Sat)
Sonnet: 4%  Opus: —%
──────── claudeContext ────────    ← context usage (green divider)
🤖 Model: claude-opus-4-7
🎚️ Effort: xHigh⁺ — xhigh (ultracode면 dynamic workflows 결합, 런타임 전용이라 구분 불가)
📊 Context Usage: 4%
| Cache Read | 8K |  | Cache Creation | 28K |  | Total | 37K / 1.0M |
🕐 Last updated: 2:10:58 PM
Click for menu (hide / restore / settings)
```

---

## ⚙️ Settings panel (webview, EN/KO)

Open **`claudeStateBar: Open Settings Panel`** from the Command Palette for a single panel with a runtime **English / 한국어** toggle. It collects Org ID, Session Key, refresh interval, Telegram Bot Token (auto‑detects your Chat ID), sound settings (with preview), and context‑monitor options. Sensitive values go to encrypted SecretStorage; everything else syncs with the standard VS Code settings.

### How to get your credentials
- **Org ID** — claude.ai → DevTools → Network → any `/api/organizations/{UUID}/…` request
- **Session Key** — claude.ai → DevTools → Application → Cookies → `sessionKey`

---

## 🔔 Telegram session‑reset alerts (optional)

Add a Telegram Bot Token in settings, send your bot any message, click **"Link my Telegram"** (Chat ID auto‑detected), and you'll get a notification every time your Claude 5‑hour session window resets — handy for jumping back in with a full quota.

---

## 🧹 Zombie status‑bar cleanup (v1.7.11)

When VS Code updates the extension while a window is open, the old extension instance's status‑bar items can remain as "zombie" pixels that don't respond to clicks. claudeStateBar handles this two ways:

1. **Version‑change detection** — on activation, if the version changed since last run, a one‑time "Reload window to clear stale items?" notice appears.
2. **QuickPick cleanup** — the session menu always contains a **🗑 Clean up stale/zombie items (Reload Window)** option that reloads the extension host, which is the only reliable way to remove items owned by a dead instance.

---

## Configuration

All keys are prefixed `claudeContextBar.*` (kept for compatibility) or `claudeState.*`.

### Core display

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.autoColor` | `true` | Assign a unique pastel colour per project |
| `claudeContextBar.baseColor` | `White` | Base colour when auto‑colour is off |
| `claudeContextBar.contextLimitDefault` | `200000` | Context limit for standard models |
| `claudeContextBar.contextLimitOpus` | `1000000` | Context limit for 1M‑context models (Opus 4.x) |
| `claudeContextBar.warningThreshold` | `50` | % for yellow warning background |
| `claudeContextBar.dangerThreshold` | `75` | % for red danger background |
| `claudeContextBar.refreshInterval` | `30` | Refresh interval (seconds) |
| `claudeContextBar.idleTimeout` | `180` | Seconds before a session is **dimmed** |
| `claudeContextBar.hideAfter` | `86400` | Seconds before a session is **hidden** (≥ idleTimeout) |
| `claudeContextBar.scope` | `workspace` | `workspace` (current folders only) or `all` |
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
| `claudeContextBar.soundWorkflow` | `""` | WAV path for workflow/all‑agents‑complete beep |
| `claudeContextBar.soundWorkflowGain` | `100` | Workflow complete sound gain % |
| `claudeContextBar.workflowCompleteBeep` | `true` | Fire beep when all workflow/task‑agents complete |
| `claudeContextBar.detectStuckToolUse` | `false` | Heuristic: beep if a tool_use has no follow‑up for `stuckToolUseThresholdSec` |
| `claudeContextBar.stuckToolUseThresholdSec` | `90` | Seconds of tool_use silence before stuck‑tool heuristic fires |

### Plan usage

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeState.orgId` | `""` | claude.ai Organization ID |
| `claudeState.language` | `en` | Settings‑panel language (`en` / `ko`) |
| `claudeState.refreshIntervalSec` | `300` | Plan‑usage poll interval (seconds) |

(Session Key, Bot Token and Chat ID are stored in SecretStorage, not in settings.json.)

---

## Requirements

- VS Code 1.74.0+
- [Claude Code](https://www.anthropic.com/claude-code) running and writing session logs to `~/.claude/projects/`
- For plan usage: a claude.ai account (Org ID + Session Key)

## How it works

No network calls except the optional claude.ai plan‑usage fetch and Telegram. Context monitoring is pure disk reads of Claude Code's JSONL logs via `vscode.workspace.fs` (local or remote). Plan usage calls the claude.ai usage endpoint using Electron's Chromium network stack (to pass Cloudflare) with a plain‑`https` fallback. The workflow viewer reads `~/.claude/projects/<slug>/<uuid>/subagents/workflows/` and `subagents/agent-*.jsonl` directly from disk.

## Credits & fork

- Original **claude-context-bar** core © [Ed Zisk (@ezoosk)](https://github.com/ezoosk) — the context‑monitoring foundation this builds on.
- This fork — plan usage, Remote‑SSH support, Telegram, webview settings, workflow viewer, sound alerts — by **Blueming**.

## License

MIT. Original © 2025 [Ed Zisk](https://github.com/ezoosk); fork additions © 2026 Blueming.
