#!/usr/bin/env node
/*
 * browser-check — single CLI entry point used by the `browser_check` skill.
 *
 *   node browser-check.mjs setup [--remote-host <name>] [--json]
 *                                               first run: look this machine over and write the private config
 *                                               (never overwrites; reports what went in and what a person must do)
 *   node browser-check.mjs doctor [--json]      config + capability probe (read-only, never opens a tab)
 *   node browser-check.mjs run <body.js> [--host] [--out <dir>] [--label <txt>]
 *                                               one-shot Aside repl call: kit/head.js + body, 50 s guard, single-flight lock,
 *                                               @@IMG lines → files, everything else redacted → stdout JSON
 *   node browser-check.mjs unlock               doctor-style stale lock reclaim (never on the hot path)
 *   node browser-check.mjs launch-flags [--apply | --undo] [--json]
 *                                               Windows: does the running Aside have the three flags transport C needs while
 *                                               its windows are covered or minimized? --apply adds them to the Aside shortcuts
 *                                               (old arguments saved), --undo puts them back. Never restarts Aside.
 *   node browser-check.mjs cdp <script.mjs> [--out <dir>] [--url <target-url>]
 *                                               transport C: connect (unix socket on a server / loopback TCP locally),
 *                                               import the script and call its default export (client, helpers) — the
 *                                               script gets a policy-gated CdpClient; every owned target is closed in finally
 *        [--borrow <url-pattern> [--same-window-as <url-pattern>] [--borrow-target <targetId>] [--user-approved] [--no-prep]]
 *                                               opt-in: attach to one of the user's tabs instead (never created, raised or
 *                                               closed; helpers.borrowed) — lent by config sites[].borrow or --user-approved
 *        [--guard-writes [--allow-write <path>]…]
 *                                               opt-in: fail the borrowed tab's non-GET requests except the allowed paths
 *                                               (self-tested first; helpers.guard) — also on with sites[].guardWrites
 *   node browser-check.mjs tabs [--match <url-pattern>] [--same-window-as <url-pattern>] [--json]
 *                                               transport C, read-only: page tabs with their window ids
 *
 * The persistent Aside session driver lives in scripts/session/*. See README for what is still unmeasured.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { load, siteFor, configPath } from './lib/config.mjs';
import { probe, table } from './lib/capabilities.mjs';
import { acquire, release, reclaimStale, heartbeat } from './lib/lock.mjs';
import { redactText, redactUrl } from './lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const optAll = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));

function die(msg, code = 2) { console.error('[browser-check] ' + msg); process.exit(code); }

/** Open transport C the way the config says (unix socket on a server, loopback TCP locally). */
async function connectC(cfg, extra) {
  const { connectUnix } = await import('./lib/cdp-unix.mjs');
  const { connectTcp } = await import('./lib/cdp-tcp.mjs');
  const opts = { connectTimeoutMs: cfg.cdp.connectTimeoutMs, commandTimeoutMs: cfg.cdp.commandTimeoutMs, log: (m) => process.stderr.write('[cdp] ' + m + '\n'), ...extra };
  if (cfg.mode !== 'local' && cfg.cdp.remote.transport === 'unix' && cfg.cdp.remote.socketPath) return { client: await connectUnix(cfg.cdp.remote.socketPath, opts), how: 'C unix' };
  if (cfg.mode !== 'remote' && cfg.cdp.local.endpoint) return { client: await connectTcp(cfg.cdp.local.endpoint, opts), how: 'C tcp-local' };
  if (cfg.cdp.remote.transport === 'tcp' && cfg.cdp.remote.tcpEndpoint) return { client: await connectTcp(cfg.cdp.remote.tcpEndpoint, opts), how: 'C tcp (test-only)' };
  die('no C transport configured (cdp.remote.socketPath or cdp.local.endpoint)');
}

const cfgRes = load();
const dataDir = process.env.CLAUDE_PLUGIN_DATA || (cfgRes.path ? dirname(cfgRes.path) : null);

if (cmd === 'setup') {
  // First run: look the machine over and write the private config (never overwrites). See scripts/lib/setup.mjs.
  const { setup } = await import('./lib/setup.mjs');
  const r = await setup({ configFile: configPath(), remoteHost: opt('--remote-host', null) });
  const lf = await import('./lib/launch-flags.mjs');
  r.launchFlags = await lf.check().catch((e) => ({ supported: true, error: String(e && e.message || e) }));
  if (flag('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(r.status === 'created' || r.status === 'exists' ? 0 : 1); }
  console.log(`setup        ${r.status} ${r.path || ''}`);
  for (const n of r.notes || []) console.log('   ' + n);
  for (const c of r.candidates || []) console.log(`   candidate: ${c.name} (${c.state}) — rerun with --remote-host "${c.name}"`);
  for (const t of r.todo || []) console.log('!  ' + t);
  if (lf.warningFor(r.launchFlags)) console.log('!  ' + lf.warningFor(r.launchFlags));
  if (r.errors && r.errors.length) for (const e of r.errors) console.log('!  written config: ' + e);
  process.exit(r.status === 'created' || r.status === 'exists' ? 0 : 1);
}

if (cmd === 'doctor' || cmd === undefined) {
  const report = { config: { path: cfgRes.path, ok: cfgRes.ok, errors: cfgRes.errors } };
  if (cfgRes.ok) report.capabilities = await probe(cfgRes.config);
  if (!cfgRes.ok && cfgRes.errors.includes('config file not found')) report.next = 'run `browser-check.mjs setup` — it looks this machine over and writes the config';
  // Shells that are not a Claude Code plugin hook/skill (workflow agents, cron, plain ssh) have no CLAUDE_PLUGIN_DATA.
  if (!cfgRes.path) report.next = 'this shell has no CLAUDE_PLUGIN_DATA — set CLAUDE_PLUGIN_DATA=<claude config dir>/plugins/data/browser-check-comonetso (or BROWSER_CHECK_CONFIG=<that dir>/config.json) and run again';
  const lf = await import('./lib/launch-flags.mjs');
  report.launchFlags = await lf.check().catch((e) => ({ supported: true, error: String(e && e.message || e) }));
  if (flag('--json')) { console.log(JSON.stringify(report, null, 1)); process.exit(cfgRes.ok ? 0 : 1); }
  console.log(`config       ${cfgRes.ok ? 'ok' : 'INVALID'} ${cfgRes.path || ''}`);
  for (const e of cfgRes.errors) console.log('!  ' + e);
  if (report.next) console.log('→  ' + report.next);
  if (report.capabilities) console.log(table(report.capabilities));
  if (lf.warningFor(report.launchFlags)) console.log('!  ' + lf.warningFor(report.launchFlags));
  process.exit(cfgRes.ok ? 0 : 1);
}

if (cmd === 'launch-flags') {
  const lf = await import('./lib/launch-flags.mjs');
  const r = flag('--apply') ? await lf.fix({ dataDir }) : flag('--undo') ? await lf.undo({ dataDir }) : await lf.check();
  if (flag('--json') || !r.supported) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  if ('running' in r) console.log(`running Aside  ${!r.running ? 'not running' : r.missing.length ? 'missing ' + r.missing.join(' ') : 'flags on'}`);
  for (const s of r.shortcuts || []) console.log(`shortcut       ${s.missing.length ? 'missing' : 'ok     '} ${s.path}`);
  for (const c of r.changed || []) console.log(`changed        ${c.path}`);
  for (const c of r.restored || []) console.log(`restored       ${c.path}`);
  for (const f of r.failed || []) console.log(`!  failed ${f.path}: ${f.why}`);
  if (r.note) console.log('   ' + r.note);
  if ((r.changed && r.changed.length) || (r.restored && r.restored.length)) console.log('→  ' + r.restart);
  process.exit(r.failed && r.failed.length ? 1 : 0);
}

if (cmd === 'unlock') {
  if (!dataDir) die('no data dir');
  console.log(JSON.stringify(reclaimStale(dataDir)));
  process.exit(0);
}

if (cmd === 'run') {
  if (!cfgRes.ok) die('config invalid: ' + cfgRes.errors.join('; '));
  const cfg = cfgRes.config;
  const bodyPath = args[1];
  if (!bodyPath) die('usage: run <body.js> [--out <dir>] [--label <txt>] [--url <target-url>]');
  const body = readFileSync(resolve(bodyPath), 'utf8');
  const head = readFileSync(join(HERE, 'kit', 'head.js'), 'utf8');
  const code = head + '\n' + body;
  if (/\b(import|require)\s*\(/.test(code)) die('code contains "import(" or "require(" — the repl rejects it before running (comments included)');
  const url = opt('--url', null);
  const site = url ? siteFor(cfg, url) : null;
  const outDir = opt('--out', dataDir ? join(dataDir, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-')) : null);
  if (!outDir) die('no --out and no data dir');
  mkdirSync(outDir, { recursive: true });

  const hostArgs = cfg.aside.remoteHost ? ['--host', cfg.aside.remoteHost] : ['--host', 'local'];
  const lk = acquire(dataDir, opt('--label', 'run'));
  if (!lk.ok) die('another Aside run holds the lock: ' + JSON.stringify(lk.holder) + ' (use `unlock` only from doctor after checking)', 3);
  const hb = setInterval(() => heartbeat(dataDir), 5000);
  const started = Date.now();
  const child = execFile(cfg.aside.bin, ['repl', ...hostArgs, code], { maxBuffer: 64 * 1024 * 1024, timeout: cfg.aside.callTimeoutMs + 5000, env: { ...process.env, ASIDE_CLI_UPDATE_CHECK: '0' } }, (err, stdout, stderr) => {
    clearInterval(hb); release(dataDir);
    const lines = (stdout || '').split('\n');
    const images = [];
    const kept = [];
    for (const l of lines) {
      const m = /^@@IMG (\S+) (\S+)$/.exec(l);
      if (m) { const f = join(outDir, m[1] + '.jpg'); writeFileSync(f, Buffer.from(m[2], 'base64')); images.push(f); continue; }
      kept.push(redactText(l).replace(/\x1b\[[0-9;]*m/g, ''));
    }
    const tail = kept.filter(Boolean).slice(-1)[0] || '';
    const status = /\[ok \|/.test(tail) ? 'ok' : /\[error \|/.test(tail) ? 'code-error' : err ? 'transport-error' : 'unknown';
    const res = { status, ms: Date.now() - started, exit: err && typeof err.code === 'number' ? err.code : 0, transport: cfg.aside.remoteHost ? 'A/B remote' : 'A/B local', url: url ? redactUrl(url) : null, site: site ? { login: site.login, diag: site.diag, darkReader: site.darkReader } : null, images, out: outDir, lines: kept.filter((l) => l.startsWith('@@')), stderr: redactText((stderr || '').slice(0, 2000)), tail };
    if (status === 'transport-error' && /Host RPC timed out/.test(stderr || '')) res.hint = 'exceeded the ~60 s remote limit — split the work; output was lost';
    if (/Too many Remote Control RPCs/.test(stderr || '')) res.hint = 'relay rate limit — retry once after a few seconds, reduce concurrency';
    if (/Remote Control is disabled|Host is offline/.test(stderr || '')) res.hint = 'remote host disabled/offline on the PC — do not try to enable it; report to the owner';
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(res, null, 1));
    console.log(JSON.stringify(res, null, 1));
    process.exit(status === 'ok' ? 0 : 1);
  });
  child.on('error', (e) => { clearInterval(hb); release(dataDir); die('spawn failed: ' + e.message, 1); });
} else if (cmd === 'tabs') {
  // Read-only: the browser's page tabs and their windows (Target.getTargets + Browser.getWindowForTarget). Attaches to nothing.
  if (!cfgRes.ok) die('config invalid: ' + cfgRes.errors.join('; '));
  const { urlMatches } = await import('./lib/policy.mjs');
  let client = null;
  try {
    const c = await connectC(cfgRes.config, {}); client = c.client;
    let tabs = await client.listTabs();
    const m = opt('--match', null); const w = opt('--same-window-as', null);
    if (w) { const wins = new Set(tabs.filter((t) => urlMatches(w, t.url)).map((t) => t.windowId)); tabs = tabs.filter((t) => wins.has(t.windowId)); }
    if (m) tabs = tabs.filter((t) => urlMatches(m, t.url));
    tabs = tabs.map((t) => ({ ...t, url: redactUrl(t.url), title: redactText(t.title || '') }));
    if (flag('--json')) console.log(JSON.stringify({ status: 'ok', transport: c.how, tabs }, null, 1));
    else for (const t of tabs) console.log(`window ${t.windowId ?? '?'}${t.windowState ? ' (' + t.windowState + ')' : ''}  ${t.targetId}  ${t.url}  ${t.title}`);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: String(e && e.message || e).slice(0, 400) }, null, 1));
    process.exitCode = 1;
  } finally { if (client) await client.dispose(); }
} else if (cmd === 'cdp') {
  if (!cfgRes.ok) die('config invalid: ' + cfgRes.errors.join('; '));
  const cfg = cfgRes.config;
  const scriptPath = args[1];
  if (!scriptPath) die('usage: cdp <script.mjs> [--out <dir>] [--url <target-url>] [--borrow <url-pattern> [--same-window-as <url-pattern>] [--borrow-target <targetId>] [--user-approved] [--no-prep]] [--guard-writes] [--allow-write <path>]…');
  const outDir = opt('--out', dataDir ? join(dataDir, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-')) : null);
  if (!outDir) die('no --out and no data dir');
  mkdirSync(outDir, { recursive: true });
  const { redact, redactUrl } = await import('./lib/redact.mjs');
  const { urlMatches } = await import('./lib/policy.mjs');
  // A tab may be lent only if the owner said so for this site in the config, or approved it for this run.
  const borrowGate = (url) => {
    const s = siteFor(cfg, url);
    if (s.borrow) return { ok: true, by: 'config' };
    if (flag('--user-approved')) return { ok: true, by: 'user-approved' };
    return { ok: false, why: 'this site is not lent in the config (sites[].borrow) and the run has no --user-approved — ask the user before borrowing their tab' };
  };
  let client = null; let how = null;
  const started = Date.now();
  try {
    ({ client, how } = await connectC(cfg, { borrowGate }));
    // A bare Windows path ("C:\…") is not a valid ESM specifier; a file:// URL works on every OS
    const mod = await import(pathToFileURL(resolve(scriptPath)).href);
    if (typeof mod.default !== 'function') die('script must export default async (client, helpers) => result');
    const helpers = {
      outDir,
      url: opt('--url', null),
      saveImage: (name, buf) => { const f = join(outDir, name); writeFileSync(f, buf); return f; },
      redact, redactUrl,
      borrowed: null, guard: null,
    };
    let site = null;
    const pattern = opt('--borrow', null);
    // Option mistakes are refused before anything is borrowed (die() exits without the finally that gives the tab back).
    if (flag('--guard-writes') && !pattern) die('--guard-writes needs --borrow (for an own or isolated tab call client.guardWrites(sessionId, { allow }) in the script)');
    if (optAll('--allow-write').length && !flag('--guard-writes') && !pattern) die('--allow-write needs --guard-writes');
    if (pattern) {
      let sameWindowAs = opt('--same-window-as', null);
      if (!sameWindowAs) { const t = (await client.listTabs()).find((x) => urlMatches(pattern, x.url)); const s = t && siteFor(cfg, t.url); if (s && s.borrow && s.borrow.sameWindowAs) sameWindowAs = s.borrow.sameWindowAs; }
      helpers.borrowed = await client.borrowTab({ match: pattern, sameWindowAs, targetId: opt('--borrow-target', undefined), prep: !flag('--no-prep') });
      site = siteFor(cfg, client.borrowed.get(helpers.borrowed.targetId).url);
    }
    const allow = [...((site && site.writeAllow) || []), ...optAll('--allow-write')];
    if (flag('--guard-writes') || (site && site.guardWrites)) helpers.guard = await client.guardWrites(helpers.borrowed.sessionId, { allow });
    else if (optAll('--allow-write').length) throw new Error('--allow-write needs --guard-writes (or sites[].guardWrites) — nothing was run; the tab was given back');
    const result = await mod.default(client, helpers);
    const out = { status: 'ok', transport: how, browser: client.browser, ms: Date.now() - started, out: outDir, result: redact(result === undefined ? null : result) };
    if (helpers.borrowed) {
      out.borrowed = { ...helpers.borrowed, guard: helpers.guard ? { selfTest: helpers.guard.selfTest, allow: helpers.guard.allow, ...helpers.guard.summary() } : null };
      out.borrowed.released = await client.releaseTab(helpers.borrowed.targetId);
    }
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
  } catch (e) {
    const out = { status: 'error', transport: how, ms: Date.now() - started, error: String(e && e.message || e).slice(0, 400) };
    console.log(JSON.stringify(out, null, 1));
    process.exitCode = 1;
  } finally {
    if (client) await client.dispose();
  }
} else if (cmd !== undefined) {
  die('unknown command: ' + cmd);
}
