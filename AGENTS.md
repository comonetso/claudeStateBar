# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile      # TypeScript compile → out/
npm run watch        # Watch mode compile
npm run lint         # ESLint on src/**/*.ts
npm run package      # Package as .vsix
npm run publish      # Publish to VS Code Marketplace
```

Debug session analysis (manual testing tool):
```bash
npm run compile && node out/debug.js [project-filter]
```

There are no automated tests. Use VS Code Extension Development Host (F5) for runtime testing.

## Architecture

**Single-file extension** — all logic lives in [src/extension.ts](src/extension.ts) (~725 lines). [src/debug.ts](src/debug.ts) is a standalone diagnostic script that replicates core logic for CLI-level troubleshooting.

### What It Does

Reads Codex's session JSONL logs from `~/.Codex/projects/` and displays real-time token usage in the VS Code status bar. No network calls, no SDK — pure disk reads.

### Core Data Flow

1. **`findActiveSessions()`** — scans `~/.Codex/projects/`, filters by idle timeout, applies supersession logic, returns up to 5 sessions
2. **`getLatestTokenCount(jsonlPath)`** — reads JSONL backwards to find `/clear` commands, sums token usage from `assistantCcTokenUsage` entries after the last clear
3. **`refreshAllSessions()`** — orchestrates status bar item creation/update, color assignment, tooltip generation, and click-to-hide registration

### Key Design Decisions

**Supersession detection**: When a session ends with `/clear` and a new session opens for the same project, the old one is hidden as a "ghost". Logic: session is superseded if `wasCleared=true` AND no user messages followed, OR a newer session was created after this session's last update.

**Path decoding (`decodeProjectPath`)**: Codex encodes project paths as directory names using dashes (e.g., `C--Users--foo--project`). The decoder reconstructs paths heuristically — uses the last 3 path segments as the display name. Windows paths (`C:\`) and Unix paths (`/`) are both handled.

**Model-aware context limits (`getContextLimitForModel`)**: Sonnet 4.5 1M gets 1,000,000 token limit; all other models default to 200,000 (or the user's configured `contextLimit`).

**Compact mode (`getShortName`)**: Multi-word names → acronym (my-cool-project → MCP); single long words → first letter + last syllable (typescript → Tscript); short names (≤5 chars) → unchanged. Custom overrides via `shortNames` config.

**Color assignment**: When `autoColor` is on, project names are assigned pastel colors from a fixed palette using their index. Colors are stable within a session lifetime but not persisted across VS Code restarts.

**Auto-unhide**: Sessions hidden via the menu auto-reappear when the JSONL file is modified after the hide timestamp (new activity detected).

**Two-tier idle (1.5.0+)**: `findActiveSessions()` uses two cutoffs — `idleTimeout` (default 180s) marks `isIdle=true` (dimmed display, gray foreground, no warning background, `idle Xm` suffix), while `hideAfter` (default 3600s) is the actual exclusion threshold. `hideAfter` is clamped to ≥ `idleTimeout` so dimming always precedes hiding.

**Model + effort display (1.5.0+)**: `getShortModelName()` maps `Codex-sonnet-4-5-*` → `Sonnet 4.5` (or `S4.5` in compact mode). `getEffortIndicator()` returns `⚡` when `speed !== 'standard'` (Codex `/fast` toggle) and `💭` when any recent assistant message contains a non-empty `thinking` content block. JSONL has no explicit "effort" field — these are the closest available signals.

**Click → QuickPick menu (1.5.0+)**: Status bar items invoke `claudeContextBar.showSessionMenu` instead of hiding directly. The menu offers hide/restore-all/restore-one/open-settings. The legacy `hideSession` command still exists for direct invocation.

### Configuration

All settings are prefixed `claudeContextBar.*`. Key ones:
- `idleTimeout` (default 180s) — when to **dim** an inactive session (not hide)
- `hideAfter` (default 3600s) — when to **fully hide** an inactive session
- `showModel` (default true) — show model name next to percentage
- `warningThreshold` / `dangerThreshold` (50% / 75%) — status bar background color thresholds (suppressed when idle)
- `compactMode` + `shortNames` — compact display with optional custom abbreviations
- `refreshInterval` (default 30s) — polling interval alongside file watcher

### Publishing

CI (`.github/workflows/publish.yml`) auto-publishes to VS Code Marketplace and Open VSX on any `v*` tag push. Requires `VSCE_PAT` and `OVSX_PAT` secrets.

### ⚠️ Documentation must ship with features (IMPORTANT)

This extension is **published to the Marketplace**, so end users read the bundled READMEs as the source of truth. Keep docs accurate on every release:

- **On any user-facing feature addition or behavior change**, update **BOTH** [README.md](README.md) (English) **and** [README.ko.md](README.ko.md) (Korean) in the same change. The two READMEs must stay in sync — never update one without the other.
- **`CHANGELOG.md`** gets an entry **every** release (this is already done reliably).
- **Pure bug-fix patches** with no user-visible feature/behavior change don't need README edits — a `CHANGELOG.md` entry is enough.

Rule of thumb: if a user's mental model of what the extension does would change, both READMEs must reflect it before the tag is pushed.
