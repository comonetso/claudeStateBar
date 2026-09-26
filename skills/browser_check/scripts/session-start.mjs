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
    notes.push('비공개 설정 없음 — `browser_check` 를 쓰려면 `${CLAUDE_PLUGIN_DATA}/config.json` 을 만들어야 합니다 (예시: config/example.json)');
    emit();
    process.exit(0);
  }

  const st = lstatSync(configPath);
  if (st.isSymbolicLink()) notes.push('설정 파일이 심볼릭 링크입니다 (거부)');
  // No POSIX mode bits on Windows (always reads 0o666) — skipped there, same as scripts/lib/config.mjs
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) notes.push('설정 파일 권한이 0600 이 아닙니다');

  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    notes.push('설정 JSON 파싱 실패: ' + (e && e.message ? e.message : String(e)).slice(0, 80));
  }

  if (cfg && Date.now() < deadline) {
    // light schema check — the full validator lives in scripts/lib/config.mjs (used by doctor)
    if (cfg.schemaVersion !== 1) notes.push('schemaVersion 이 1 이 아닙니다');
    if (cfg.aside && cfg.aside.enabled && cfg.aside.bin && !existsSync(cfg.aside.bin)) notes.push('aside.bin 경로에 실행 파일이 없습니다');
    const sock = cfg.cdp && cfg.cdp.remote && cfg.cdp.remote.socketPath;
    if (sock && existsSync(sock)) {
      const ss = lstatSync(sock);
      if (!ss.isSocket()) notes.push('cdp.remote.socketPath 가 소켓이 아닙니다');
      else if ((ss.mode & 0o077) !== 0) notes.push('CDP 유닉스 소켓 권한이 0600 이 아닙니다 (다른 사용자가 붙을 수 있음)');
      else if (typeof process.getuid === 'function' && ss.uid !== process.getuid()) notes.push('CDP 유닉스 소켓 소유자가 현재 사용자와 다릅니다');
    }
  }
  void root;
} catch {
  /* swallow — a hook must never block session start */
}
emit();
process.exit(0);
