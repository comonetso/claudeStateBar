#!/usr/bin/env node
/*
 * browser-check — single CLI entry point used by the `browser_check` skill.
 *
 *   node browser-check.mjs doctor [--json]      config + capability probe (read-only, never opens a tab)
 *   node browser-check.mjs run <body.js> [--host] [--out <dir>] [--label <txt>]
 *                                               one-shot Aside repl call: kit/head.js + body, 50 s guard, single-flight lock,
 *                                               @@IMG lines → files, everything else redacted → stdout JSON
 *   node browser-check.mjs unlock               doctor-style stale lock reclaim (never on the hot path)
 *   node browser-check.mjs cdp <script.mjs> [--out <dir>] [--url <target-url>]
 *                                               transport C: connect (unix socket on a server / loopback TCP locally),
 *                                               import the script and call its default export (client, helpers) — the
 *                                               script gets a policy-gated CdpClient; every owned target is closed in finally
 *
 * The persistent Aside session driver lives in scripts/session/*. See README for what is still unmeasured.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { load, siteFor } from './lib/config.mjs';
import { probe, table } from './lib/capabilities.mjs';
import { acquire, release, reclaimStale, heartbeat } from './lib/lock.mjs';
import { redactText, redactUrl } from './lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

function die(msg, code = 2) { console.error('[browser-check] ' + msg); process.exit(code); }

const cfgRes = load();
const dataDir = process.env.CLAUDE_PLUGIN_DATA || (cfgRes.path ? dirname(cfgRes.path) : null);

if (cmd === 'doctor' || cmd === undefined) {
  const report = { config: { path: cfgRes.path, ok: cfgRes.ok, errors: cfgRes.errors } };
  if (cfgRes.ok) report.capabilities = await probe(cfgRes.config);
  if (flag('--json')) { console.log(JSON.stringify(report, null, 1)); process.exit(cfgRes.ok ? 0 : 1); }
  console.log(`config       ${cfgRes.ok ? 'ok' : 'INVALID'} ${cfgRes.path || ''}`);
  for (const e of cfgRes.errors) console.log('!  ' + e);
  if (report.capabilities) console.log(table(report.capabilities));
  process.exit(cfgRes.ok ? 0 : 1);
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
} else if (cmd === 'cdp') {
  if (!cfgRes.ok) die('config invalid: ' + cfgRes.errors.join('; '));
  const cfg = cfgRes.config;
  const scriptPath = args[1];
  if (!scriptPath) die('usage: cdp <script.mjs> [--out <dir>] [--url <target-url>]');
  const outDir = opt('--out', dataDir ? join(dataDir, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-')) : null);
  if (!outDir) die('no --out and no data dir');
  mkdirSync(outDir, { recursive: true });
  const { connectUnix } = await import('./lib/cdp-unix.mjs');
  const { connectTcp } = await import('./lib/cdp-tcp.mjs');
  const { redact, redactUrl } = await import('./lib/redact.mjs');
  const opts = { connectTimeoutMs: cfg.cdp.connectTimeoutMs, commandTimeoutMs: cfg.cdp.commandTimeoutMs, log: (m) => process.stderr.write('[cdp] ' + m + '\n') };
  let client = null; let how = null;
  const started = Date.now();
  try {
    if (cfg.mode !== 'local' && cfg.cdp.remote.transport === 'unix' && cfg.cdp.remote.socketPath) { client = await connectUnix(cfg.cdp.remote.socketPath, opts); how = 'C unix'; }
    else if (cfg.mode !== 'remote' && cfg.cdp.local.endpoint) { client = await connectTcp(cfg.cdp.local.endpoint, opts); how = 'C tcp-local'; }
    else if (cfg.cdp.remote.transport === 'tcp' && cfg.cdp.remote.tcpEndpoint) { client = await connectTcp(cfg.cdp.remote.tcpEndpoint, opts); how = 'C tcp (test-only)'; }
    else die('no C transport configured (cdp.remote.socketPath or cdp.local.endpoint)');
    const mod = await import(resolve(scriptPath));
    if (typeof mod.default !== 'function') die('script must export default async (client, helpers) => result');
    const helpers = {
      outDir,
      url: opt('--url', null),
      saveImage: (name, buf) => { const f = join(outDir, name); writeFileSync(f, buf); return f; },
      redact, redactUrl,
    };
    const result = await mod.default(client, helpers);
    const out = { status: 'ok', transport: how, browser: client.browser, ms: Date.now() - started, out: outDir, result: redact(result === undefined ? null : result) };
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
