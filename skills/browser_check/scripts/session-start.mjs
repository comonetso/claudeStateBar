#!/usr/bin/env node
/*
 * browser-check SessionStart hook — stat-only.
 *
 * Rules (Codex consult 2026-09-26, D4):
 *  - never contact the browser, ego, the PC relay, or the network here;
 *  - only: does the private config exist / parse / have the current layout (schemaVersion 2 — ego lite),
 *    and does the configured ego-browser exist;
 *  - hard 500 ms budget, every exception swallowed, exit 0 always;
 *  - silent when everything is fine — print one line of additionalContext only on a problem.
 *
 * Output contract (Claude Code hook JSON on stdout):
 *   { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }
 */
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const deadline = Date.now() + 500;
const notes = [];

function emit() {
  if (notes.length === 0) return;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '[browser-check] ' + notes.join(' · '),
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  const root = process.env.CLAUDE_PLUGIN_ROOT || resolve(new URL('..', import.meta.url).pathname);
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || '';
  const configPath = process.env.BROWSER_CHECK_CONFIG || (dataDir ? resolve(dataDir, 'config.json') : '');

  if (!configPath || !existsSync(configPath)) {
    notes.push('no private config yet — on first use of `browser_check`, `browser-check setup` inspects this machine and writes it (to write it by hand, see config/example.json)');
    emit();
    process.exit(0);
  }

  const st = lstatSync(configPath);
  if (st.isSymbolicLink()) notes.push('the config file is a symbolic link (refused)');
  // No POSIX mode bits on Windows (always reads 0o666) — skipped there, same as scripts/lib/config.mjs
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) notes.push('config file permissions are not 0600');

  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    notes.push('config JSON parse failed: ' + (e && e.message ? e.message : String(e)).slice(0, 80));
  }

  if (cfg && Date.now() < deadline) {
    // light schema check — the full validator lives in scripts/lib/config.mjs (used by doctor)
    if (cfg.schemaVersion === 1) notes.push('the config is the old Aside layout — before using browser_check run `browser-check setup --migrate` (keeps the site rules, backs the old file up)');
    else if (cfg.schemaVersion !== 2) notes.push('schemaVersion is not 2');
    else if (cfg.ego && cfg.ego.bin && !existsSync(cfg.ego.bin)) notes.push('no ego-browser at the ego.bin path (ego lite moved or uninstalled?)');
  }
  void root;
} catch {
  /* swallow — a hook must never block session start */
}
emit();
process.exit(0);
