#!/usr/bin/env node
/*
 * browser-check — single CLI entry point used by the `browser_check` skill (ego lite, 2026-10-21).
 *
 *   node browser-check.mjs setup [--remote-host <ssh host>] [--migrate] [--json]
 *        first run: look this machine over and write the private config (never overwrites a current one;
 *        --migrate rewrites an old Aside-layout file, site rules kept, old file backed up)
 *   node browser-check.mjs doctor [--json]
 *        config + capability probe (read-only, never opens a tab)
 *   node browser-check.mjs ego <script.mjs> [--url <url>] [--out <dir>] [--timeout <ms>] [--guard-writes [--allow-write <path>]…]
 *        run a script in ego lite: on the PC directly, from a server through the PC relay over ssh. The script is
 *        prefixed with scripts/ego/prelude.mjs (bc.* helpers); @@IMG lines become files, @@OUT lines data.
 *   node browser-check.mjs relay install|status|uninstall [--json]
 *        PC only: the relay servers call (scripts/ego/relay.mjs) — a Task Scheduler entry in the user's own session.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, siteFor, configPath } from './lib/config.mjs';
import { redact, redactText, redactUrl } from './lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const optAll = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
function die(msg, code = 2) { console.error('[browser-check] ' + msg); process.exit(code); }

const cfgRes = load();
const dataDir = process.env.CLAUDE_PLUGIN_DATA || (cfgRes.path ? dirname(cfgRes.path) : null);
const noDataHint = 'this shell has no CLAUDE_PLUGIN_DATA — set CLAUDE_PLUGIN_DATA=<claude config dir>/plugins/data/browser-check-comonetso (or BROWSER_CHECK_CONFIG=<that dir>/config.json) and run again';

if (cmd === 'setup') {
  const { setup } = await import('./lib/setup.mjs');
  const r = await setup({ configFile: configPath(), remoteHost: opt('--remote-host', null), migrate: flag('--migrate') });
  if (r.status === 'no-path') r.todo = [noDataHint];
  if (flag('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(r.status === 'created' || r.status === 'exists' ? 0 : 1); }
  console.log(`setup        ${r.status} ${r.path || ''}`);
  for (const n of r.notes || []) console.log('   ' + n);
  for (const c of r.candidates || []) console.log(`   candidate: ${c} — rerun with --remote-host "${c}"`);
  for (const t of r.todo || []) console.log('!  ' + t);
  if (r.errors && r.errors.length) for (const e of r.errors) console.log('!  written config: ' + e);
  process.exit(r.status === 'created' || r.status === 'exists' ? 0 : 1);
}

if (cmd === 'doctor' || cmd === undefined) {
  const report = { config: { path: cfgRes.path, ok: cfgRes.ok, errors: cfgRes.errors } };
  if (cfgRes.ok) { const { probe } = await import('./lib/capabilities.mjs'); report.capabilities = await probe(cfgRes.config); }
  if (!cfgRes.ok && cfgRes.errors.includes('config file not found')) report.next = 'run `browser-check.mjs setup` — it looks this machine over and writes the config';
  if (cfgRes.oldLayout) report.next = 'run `browser-check.mjs setup --migrate` — the config is the old Aside layout';
  if (!cfgRes.path) report.next = noDataHint;
  if (flag('--json')) { console.log(JSON.stringify(report, null, 1)); process.exit(cfgRes.ok && report.capabilities.ready ? 0 : 1); }
  console.log(`config       ${cfgRes.ok ? 'ok' : 'INVALID'} ${cfgRes.path || ''}`);
  for (const e of cfgRes.errors) console.log('!  ' + e);
  if (report.next) console.log('→  ' + report.next);
  if (report.capabilities) { const { table } = await import('./lib/capabilities.mjs'); console.log(table(report.capabilities)); }
  process.exit(cfgRes.ok && report.capabilities && report.capabilities.ready ? 0 : 1);
}

if (cmd === 'relay') {
  const sub = args[1] || 'status';
  const ri = await import('./lib/relay-install.mjs');
  const r = sub === 'install' ? await ri.install() : sub === 'uninstall' ? await ri.uninstall() : sub === 'status' ? await ri.status() : die('usage: relay install|status|uninstall');
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.supported === false || (sub === 'install' && !(r.health && r.health.ok)) ? 1 : 0);
}

if (cmd === 'ego') {
  if (!cfgRes.ok) die('config invalid: ' + cfgRes.errors.join('; ') + (cfgRes.oldLayout ? ' → run `setup --migrate`' : ''));
  const cfg = cfgRes.config;
  const scriptPath = args[1];
  if (!scriptPath) die('usage: ego <script.mjs> [--url <url>] [--out <dir>] [--timeout <ms>] [--guard-writes [--allow-write <path>]…]');
  const ego = await import('./lib/ego.mjs');
  const url = opt('--url', null);
  const site = url ? siteFor(cfg, url) : null;
  if (optAll('--allow-write').length && !flag('--guard-writes') && !(site && site.guardWrites)) die('--allow-write needs --guard-writes (or sites[].guardWrites)');
  const outDir = opt('--out', dataDir ? join(cfg.artifacts.dir || join(dataDir, 'artifacts'), new Date().toISOString().replace(/[:.]/g, '-')) : null);
  if (!outDir) die('no --out and no data dir');
  mkdirSync(outDir, { recursive: true });
  const timeoutMs = Math.min(Number(opt('--timeout', 0)) || cfg.ego.callTimeoutMs, 1800000);
  const local = !!cfg.ego.bin;
  const guardOn = flag('--guard-writes') || !!(site && site.guardWrites);
  const settings = {
    light: cfg.ego.light,
    settleMs: cfg.ego.settleMs,
    url,
    guard: guardOn ? { allow: [...((site && site.writeAllow) || []), ...optAll('--allow-write')] } : null,
    windowScript: local ? (process.platform === 'win32' ? join(HERE, 'ego', 'window.ps1') : null) : (cfg.ego.relayDir ? cfg.ego.relayDir.replace(/[\\/]+$/, '') + '\\window.ps1' : null),
  };
  let script;
  try { script = ego.buildScript(readFileSync(resolve(scriptPath), 'utf8'), settings); } catch (e) { die(String(e.message)); }
  const started = Date.now();
  const r = local
    ? await ego.runLocal({ bin: cfg.ego.bin, script, timeoutMs })
    : await ego.runRemote({ host: cfg.ego.remoteHost, entry: cfg.ego.relayEntry || ego.DEFAULT_RELAY_ENTRY, script, timeoutMs });
  // ego-browser prints the script's console output on stderr (measured 2026-10-21), so both streams are read.
  const c = ego.collect(String(r.stdout || '') + '\n' + String(r.stderr || ''), outDir);
  const status = r.transportError ? 'transport-error' : r.timedOut ? 'timeout' : r.exit === 0 ? 'ok' : 'script-error';
  const err = String(r.stderr || '') + '\n' + c.tail.join('\n');
  const hints = [];
  if (/running as administrator/.test(err)) hints.push('ego refuses elevated callers — on a server this must go through the PC relay; on the PC run from a non-elevated shell');
  if (/EGO_TASK_SPACE_NAME_IN_USE/.test(err)) hints.push('that task space name belongs to the user — pick another name (never claim theirs without being asked)');
  if (/SyntaxError: await is only valid/.test(err)) hints.push('the shell damaged the script — keep it in the .mjs file this command reads');
  if (/browser_check refuses /.test(err)) hints.push('a refused CDP command (SKILL.md §1) — do it another way or ask the user');
  if (/\[ego-browser:notice\]/.test(r.stdout)) hints.push('an ego lite update is available — tell the user; run `ego-browser upgrade` only with their approval');
  if (r.transportError) hints.push('the PC relay did not run it: ' + redactText(String(r.transportError)).slice(0, 200) + ' — is the PC awake and logged in? (`doctor`)');
  const res = {
    status, where: local ? 'local' : 'remote:' + cfg.ego.remoteHost, ms: Date.now() - started, egoMs: r.egoMs || r.ms,
    url: url ? redactUrl(url) : null, site: site ? { match: site.match, login: site.login, guardWrites: site.guardWrites } : null,
    guard: settings.guard ? (c.outs.GUARD || 'not reported — use bc.run, or call bc.guardWrites yourself') : null,
    images: c.images, out: outDir, outs: redact(c.outs), leftOpen: c.outs.LEFT_OPEN || null, startedEgo: r.startedEgo || null,
    hints, tail: c.tail.slice(-20),
  };
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  process.exit(status === 'ok' ? 0 : 1);
}

if (cmd !== undefined) die('unknown command: ' + cmd + ' (setup · doctor · ego · relay)');
