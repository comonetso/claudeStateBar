# claudeStateBar

**Claude Code context usage + Claude.ai plan usage (5‑hour session & weekly) in your VS Code status bar — with Remote‑SSH support, Telegram reset alerts, and a bilingual settings panel.**

🇰🇷 한국어 문서: [README.ko.md](README.ko.md)

> **Fork notice.** This extension is a fork of [**claude-context-bar**](https://marketplace.visualstudio.com/items?itemName=ezoosk.claude-context-bar) by **Ed Zisk ([@ezoosk](https://github.com/ezoosk))**, which provides the original context‑monitoring core. It has been extended and is maintained by **Blueming** — adding Claude.ai plan usage, Remote‑SSH support, Telegram notifications, and a webview settings panel. The marketplace identifier (`ezoosk.claude-context-bar`) and `claudeContextBar.*` setting keys are kept for update compatibility.

---

## Two layers in one status bar

claudeStateBar shows two complementary things, merged into a single hover tooltip with clearly separated sections:

### 🧠 claudeContext — Claude Code context monitor
Reads Claude Code's local session logs (`~/.claude/projects/*.jsonl`) and shows, per active tab:
- **Live context usage %** (tokens used vs. the model's limit)
- **Per‑tab monitoring** — each Claude Code session gets its own status‑bar item
- **Model‑aware limits** — Sonnet 4.5 **1M** → 1,000,000 tokens; other models → 200,000 (configurable)
- **Model + effort + speed** — e.g. `Opus 4.7 · High · ⚡fast`
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

The result: in a Remote‑SSH window you see **remote session token usage and your plan usage together**, in one place. If a host genuinely can't reach claude.ai, the bar shows an honest "plan usage unavailable here" notice (the Session Key is fine) instead of a misleading "expired" error.

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
🎚️ Effort: High
📊 Context Usage: 4%
| Cache Read | 8K |  | Cache Creation | 28K |  | Total | 37K / 1.0M |
🕐 Last updated: 2:10:58 PM
Click for menu (hide / restore / settings)
```

---

## ⚙️ Settings panel (webview, EN/KO)

Open **`claudeStateBar: Open Settings`** from the Command Palette for a single panel with a runtime **English / 한국어** toggle. It collects Org ID, Session Key, refresh interval, Telegram Bot Token (auto‑detects your Chat ID), and the context‑monitor options. Sensitive values go to encrypted SecretStorage; everything else syncs with the standard VS Code settings.

### How to get your credentials
- **Org ID** — claude.ai → DevTools → Network → any `/api/organizations/{UUID}/…` request
- **Session Key** — claude.ai → DevTools → Application → Cookies → `sessionKey`

---

## 🔔 Telegram session‑reset alerts (optional)

Add a Telegram Bot Token in settings, send your bot any message, click **"Link my Telegram"** (Chat ID auto‑detected), and you'll get a notification every time your Claude 5‑hour session window resets — handy for jumping back in with a full quota.

---

## Configuration

All keys are prefixed `claudeContextBar.*` (kept for compatibility) or `claudeState.*`.

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.autoColor` | `true` | Assign a unique pastel colour per project |
| `claudeContextBar.baseColor` | `White` | Base colour when auto‑colour is off |
| `claudeContextBar.contextLimitDefault` | `200000` | Context limit for standard models |
| `claudeContextBar.contextLimitOpus` | `1000000` | Context limit for 1M‑context models |
| `claudeContextBar.warningThreshold` | `50` | % for yellow warning background |
| `claudeContextBar.dangerThreshold` | `75` | % for red danger background |
| `claudeContextBar.refreshInterval` | `30` | Refresh interval (seconds) |
| `claudeContextBar.idleTimeout` | `180` | Seconds before a session is **dimmed** |
| `claudeContextBar.hideAfter` | `3600` | Seconds before a session is **hidden** |
| `claudeContextBar.scope` | `workspace` | `workspace` (current folders only) or `all` |
| `claudeContextBar.showModel` | `true` | Show model name next to the percentage |
| `claudeContextBar.compactMode` | `false` | Shorten project names |
| `claudeContextBar.shortNames` | `{}` | Custom short names, e.g. `{"my-project":"MP"}` |
| `claudeState.orgId` | `""` | claude.ai Organization ID |
| `claudeState.language` | `en` | Settings‑panel language (`en` / `ko`) |
| `claudeState.refreshInterval` | `300` | Plan‑usage poll interval (seconds) |

(Session Key, Bot Token and Chat ID are stored in SecretStorage, not in settings.json.)

## Requirements

- VS Code 1.74.0+
- [Claude Code](https://www.anthropic.com/claude-code) running and writing session logs to `~/.claude/projects/`
- For plan usage: a claude.ai account (Org ID + Session Key)

## How it works

No network calls except the optional claude.ai plan‑usage fetch and Telegram. Context monitoring is pure disk reads of Claude Code's JSONL logs via `vscode.workspace.fs` (local or remote). Plan usage calls the claude.ai usage endpoint using Electron's Chromium network stack (to pass Cloudflare) with a plain‑`https` fallback.

## Credits & fork

- Original **claude-context-bar** core © [Ed Zisk (@ezoosk)](https://github.com/ezoosk) — the context‑monitoring foundation this builds on.
- This fork — plan usage, Remote‑SSH support, Telegram, webview settings — by **Blueming**.

## License

MIT. Original © 2025 [Ed Zisk](https://github.com/ezoosk); fork additions © 2026 Blueming.
