# Changelog

All notable changes to the Claude Context Bar extension will be documented in this file.

## [1.7.0] - 2026-05-21

### Added
- **Remote-SSH support — plan usage AND token counts in one remote window.** The extension now runs as a UI (local) extension (`extensionKind: ["ui"]`). Plan usage is fetched on the local machine via Electron (which passes Cloudflare), while session token counts are read from the **remote** host's `~/.claude/projects` through `vscode.workspace.fs` (VS Code routes the reads over SSH). Previously, on a remote host plan usage hit a Cloudflare block and token counting scanned the wrong (local) home.

### Changed
- All `~/.claude` access moved from synchronous Node `fs` to async `vscode.workspace.fs`, so it works on both local and Remote-SSH hosts. The remote home is auto-detected (`/root`, else `/home/*` containing `.claude/projects`). File watching now uses `vscode.workspace.createFileSystemWatcher` (remote-capable) instead of `fs.watch`.
- `claudeStateBar: Show Diagnostics` logs a remote-fs probe (workspace URI scheme/authority + whether `~/.claude/projects` is reachable), useful for diagnosing remote setups.

## [1.6.1] - 2026-05-21

### Fixed
- **Remote-SSH "Session Key expired" false alarm**: On a remote/headless extension host, the plan-usage request falls back to plain Node `https`, which Cloudflare blocks with an HTTP 403 bot challenge (or the connection fails outright on some networks). The code used to misreport this as an expired Session Key. A Cloudflare challenge is now distinguished from a genuine auth failure.

### Added
- New status-bar state **"Plan usage unavailable here"** (warning background) with a tooltip clarifying the host can't reach claude.ai (Cloudflare block / connection failure) and that the Session Key is fine. Plan usage works on desktop VS Code; cloud/datacenter remote hosts (AWS EC2, etc.) can't fetch it regardless of TLS fingerprint — confirmed empirically, so the previously-attempted bundled `curl-impersonate` workaround was dropped.

## [1.6.0] - 2026-05-20

### Added
- **Claude.ai plan usage in the status bar**: 5-hour session and weekly utilization, fetched from claude.ai (no SDK), merged into the first session item with a tooltip breakdown.
- **Webview settings panel** with runtime EN/KO language toggle; Session Key / Org ID / Bot Token at the top. Sensitive values stored encrypted via SecretStorage.
- **Telegram session-reset notifications**.
- **Cloudflare bypass via Electron `net`** on the desktop (Chromium network stack passes the TLS-fingerprint challenge that blocks plain Node `https`).
- Display name unified to **claudeStateBar** (identifier and `claudeContextBar.*` setting keys kept for compatibility).

## [1.5.1] - 2026-05-03

### Fixed
- **Linux workspace matching**: Added fallback path comparison so sessions are detected even when Claude's directory encoding differs from the computed encoding. Primary match is exact encoded-path comparison; fallback decodes the Claude dir name and compares normalised paths; second fallback checks the last two path segments.
- **Diagnostics output channel**: Added `Claude Context Bar` output channel with per-refresh logging (workspace folders, encoded paths, Claude dirs found, match/skip decisions). Run `Claude Context Bar: Show Diagnostics` from the command palette to open the channel and trigger a fresh scan.

### Added
- **New command**: `Claude Context Bar: Show Diagnostics` — opens the output channel and runs a full diagnostic scan, logging workspace paths, their encoded forms, and all Claude project directories found.

## [1.5.0] - 2026-05-03

### Added
- **Context Menu (QuickPick)**: Clicking a status bar item now opens a menu instead of immediately hiding the session.
  - Hide this session
  - Restore all hidden sessions
  - Restore a specific hidden session
  - Open settings
- **Model Display**: The currently used model is shown next to the percentage (e.g., `🧠 Project: 45% · Sonnet 4.5`). Compact mode produces shorter labels (`S4.5`, `O4.7`, `H4.5`).
- **Effort Indicators**: ⚡ for `/fast` mode, 💭 when extended thinking is detected in recent assistant output.
- **Two-Tier Idle Behavior**: Idle sessions are no longer hidden immediately.
  - After `idleTimeout` (default 180s) → session is **dimmed** (grayscale, no warning background) and shows `idle Xm` indicator.
  - After `hideAfter` (default 3600s / 1 hour) → session is fully hidden.
- **New Settings**:
  - `claudeContextBar.showModel` (default `true`)
  - `claudeContextBar.hideAfter` (default `3600`)
- **New Commands** (palette):
  - `Claude Context Bar: Restore All Hidden Sessions`

### Changed
- `idleTimeout` now controls **dimming**, not hiding. Maximum raised to 7200s.
- Tooltip now shows speed, extended-thinking detection, and idle status when applicable.

## [1.4.1] - 2025-12-29

### Fixed
- Added compact mode documentation to README

## [1.4.0] - 2025-12-29

### Added
- **Compact Mode**: Shorten project names to save status bar space
  - Multi-word names become acronyms (my-cool-project → MCP)
  - Single words become abbreviated (typescript → Tscript)
  - Names 5 characters or less stay unchanged
  - Session numbers preserved (MCP-2, MCP-3)
- **Custom Short Names**: Define your own abbreviations via `shortNames` setting
- **Instant Settings Refresh**: All settings now apply immediately without waiting for next refresh cycle

## [1.3.0] - 2025-12-24

### Added
- **Click to Hide**: Click any status bar item to temporarily hide it
  - Hidden sessions automatically reappear when there's new activity
  - Great for dismissing stale sessions you're not actively using
- **Configurable Idle Timeout**: New `idleTimeout` setting (default: 180 seconds / 3 minutes)
  - Sessions inactive longer than this are automatically hidden
  - Reduced from previous hardcoded 5 minutes
  - Range: 10-600 seconds

### Fixed
- **Project Name Display**: Fixed deeply nested paths showing full folder chain
  - Now correctly shows last 3 path segments (e.g., "claude-context-bar" instead of "Tools-extensions-vscode-claude-context-bar")

## [1.2.2] - 2025-12-23

### Fixed
- Documentation updates

## [1.2.1] - 2025-12-23

### Fixed
- **Project Name Display**: Fixed issue where parent folder (e.g., "dev") was incorrectly included in project names
  - Now correctly shows "my-project" instead of "dev-my-project"
- **Tooltip Cleanup**: Removed confusing "New Input" row (always showed ~8 tokens)

## [1.2.0] - 2025-12-22

### Added
- **Smart Session Detection**: Automatically detects and hides "ghost" sessions
  - Sessions are hidden immediately when superseded by a newer session
  - Properly handles `/clear` command scenarios
  - No more lingering status bar items from closed tabs
- **First Message in Tooltip**: Shows the first message of each session to help identify which Claude Code tab it corresponds to

### Fixed
- Ghost sessions no longer appear after running `/clear` and continuing work
- Improved session lifecycle tracking using creation timestamps

## [1.1.3] - 2025-12-22

### Added
- **Fuzzy Emoji Matching**: Icons automatically match project type based on name keywords
  - Music projects (🎵), games (🎮), web (🌐), mobile (📱), AI (🤖), and more
- `showEmoji` setting to toggle emoji display on/off (default: on)

## [1.1.2] - 2025-12-22

### Added
- Now available on [Open VSX Registry](https://open-vsx.org/extension/ezoosk/claude-context-bar) for Antigravity, VSCodium, and other VS Code forks
- Automated dual-publishing to both VS Code Marketplace and Open VSX

## [1.1.0] - 2025-12-22

### Added
- **Auto Color Mode**: Pastel color palette assigns different colors to each project automatically
- **Base Color Selection**: When auto-color is off, choose a base color with subtle variations per project
- **Auto Context Limit Detection**: Automatically detects model (Sonnet 4.5 1M vs others) and adjusts context limit
- Model name now displayed in tooltip

### Changed
- Color palette changed to softer pastel colors for better readability

## [1.0.0] - 2025-12-22

### Added
- Real-time context window usage monitoring for Claude Code sessions
- Status bar indicators for each active Claude Code tab
- Color-coded warnings: yellow at 50%, red at 75%
- Detailed tooltip with token breakdown (cache read, cache creation, new input)
- Configurable context limit, thresholds, and refresh interval
- Auto-refresh on file changes and periodic polling
- Automatic cleanup of stale sessions (5-minute timeout)
- Excludes Claude Memory background processes from display
