#!/usr/bin/env node
/*
 * browser-check SessionStart hook — stat-only.
 *
 * Rules (Codex consult 2026-09-26, D4):
 *  - never contact the browser, the Aside daemon, `aside host list`, or the network here;
 *  - only: does the private config exist / parse / pass the schema, does the configured
 *    binary exist, and if a Unix socket path is configured, is it a socket with safe mode/owner;
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
    notes.push('no private config yet — on first use of `browser_check`, `scripts/browser-check.mjs setup` inspects this machine and writes it (to write it by hand, see config/example.json)');
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
    if (cfg.schemaVersion !== 1) notes.push('schemaVersion is not 1');
    if (cfg.aside && cfg.aside.enabled && cfg.aside.bin && !existsSync(cfg.aside.bin)) notes.push('no executable at the aside.bin path');
    const sock = cfg.cdp && cfg.cdp.remote && cfg.cdp.remote.socketPath;
    if (sock && existsSync(sock)) {
      const ss = lstatSync(sock);
      if (!ss.isSocket()) notes.push('cdp.remote.socketPath is not a socket');
      else if ((ss.mode & 0o077) !== 0) notes.push('CDP Unix socket permissions are not 0600 (other users could attach)');
      else if (typeof process.getuid === 'function' && ss.uid !== process.getuid()) notes.push('the CDP Unix socket is owned by another user');
    }
  }
  void root;
} catch {
  /* swallow — a hook must never block session start */
}
emit();
process.exit(0);
