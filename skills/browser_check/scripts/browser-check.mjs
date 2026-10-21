#!/usr/bin/env node
/*
 * browser-check — the one CLI of the `browser_check` skill (ego lite). On the Bash tool's PATH as `browser-check`
 * (the plugin's bin/), or `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs"`.
 *
 *   browser-check look <url> [steps…] [options]     open, act, read, capture, report — no script (lib/look.mjs)
 *   browser-check run <script.mjs | -> [--url <url>] [--timeout <ms>] [--guard-writes [--allow-write <path>]…]
 *        run a script in ego lite (`-` reads it from stdin). Alias: `ego`. The script is prefixed with
 *        scripts/ego/prelude.mjs (bc.* helpers); @@IMG lines become files, @@OUT lines data.
 *   browser-check api [name or part]                what a script can call (bc.* here, ego's own from its help())
 *   browser-check setup [--remote-host <ssh host>] [--migrate] [--json]
 *   browser-check doctor [--json]
 *   browser-check relay install|status|uninstall    PC only: the relay servers call (scripts/ego/relay.mjs)
 *
 * look/run/api check the config themselves and answer `status: "not-ready"` with the reason and what to do next,
 * so there is no separate doctor step before them. Everything they print is JSON.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, siteFor, configPath, dataDirGuess } from './lib/config.mjs';
import { redact, redactText, redactUrl } from './lib/redact.mjs';
import { guardHints, undoMsysPath } from './lib/guardHints.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const optAll = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
function die(msg, code = 2) { console.error('[browser-check] ' + msg); process.exit(code); }
const print = (o) => console.log(JSON.stringify(o, null, 1));

const USAGE = `browser-check — look at and operate web pages in ego lite (PC directly, or from a server through the PC relay)

  browser-check look <url>                                open · page text · capture · errors · requests sent
  browser-check look <url> --click "text=Search" --fill "#q" "hello" --press Enter --wait ".results"
        steps run in the order given: --click <sel> · --fill <sel> <text> · --select <sel> <value> ·
        --press <key> · --wait <sel> · --wait-ms <ms>
        options: --width 390 (mobile; 390x700 sets the height) · --dark · --full (whole page) · --no-shot ·
                 --name <space> · --guard-writes [--allow-write <path>] · --timeout <ms> · --text-max <chars>
  browser-check run <script.mjs>   |   browser-check run - <<'EOF' … EOF       anything else, as a script
  browser-check api [name or part]                        what a script can call, e.g. \`api click\`, \`api bc.shot\`
  browser-check setup | doctor | relay install|status|uninstall

Selectors: @12 / ref=12 from the page text · text=… · loc=role:button[name='Save'] · loc=css:… · raw CSS.
Results are JSON: images are files — look at them with the image tool.`;

if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(0); }

const cfgRes = load();
const dataDir = dataDirGuess();

function notReady() {
  const why = cfgRes.errors || [];
  let next = 'run `browser-check doctor` and tell the user what it says';
  if (why.includes('config file not found')) next = 'run `browser-check setup`, show the user the values it set (notes), then run this again';
  if (cfgRes.oldLayout) next = 'run `browser-check setup --migrate` (keeps the site rules, backs the old file up), show the user, then run this again';
  print({ status: 'not-ready', config: cfgRes.path || configPath(), why, next });
  process.exit(1);
}

/** Send one script to ego (PC directly or the relay) and collect what it printed. */
async function execute(userScript, { url = null, guardFlag = false, allow = [], outDir = null, timeout = 0 } = {}) {
  const cfg = cfgRes.config;
  const ego = await import('./lib/ego.mjs');
  const site = url ? siteFor(cfg, url) : null;
  const out = outDir || join(cfg.artifacts.dir || join(dataDir, 'artifacts'), new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  const timeoutMs = Math.min(Number(timeout) || cfg.ego.callTimeoutMs, 1800000);
  const local = !!cfg.ego.bin;
  const guardOn = guardFlag || !!(site && site.guardWrites);
  const settings = {
    light: cfg.ego.light,
    settleMs: cfg.ego.settleMs,
    url,
    guard: guardOn ? { allow: [...((site && site.writeAllow) || []), ...allow] } : null,
    windowScript: local ? (process.platform === 'win32' ? join(HERE, 'ego', 'window.ps1') : null) : (cfg.ego.relayDir ? cfg.ego.relayDir.replace(/[\\/]+$/, '') + '\\window.ps1' : null),
  };
  const script = ego.buildScript(userScript, settings);
  const started = Date.now();
  const r = local
    ? await ego.runLocal({ bin: cfg.ego.bin, script, timeoutMs })
    : await ego.runRemote({ host: cfg.ego.remoteHost, entry: cfg.ego.relayEntry || ego.DEFAULT_RELAY_ENTRY, script, timeoutMs });
  // ego-browser prints the script's console output on stderr (measured 2026-10-21), so both streams are read.
  const c = ego.collect(String(r.stdout || '') + '\n' + String(r.stderr || ''), out);
  const status = r.transportError ? 'transport-error' : r.timedOut ? 'timeout' : r.exit === 0 ? 'ok' : 'script-error';
  const err = String(r.stderr || '') + '\n' + c.tail.join('\n');
  const hints = [];
  if (/running as administrator/.test(err)) hints.push('ego refuses elevated callers — on a server this must go through the PC relay; on the PC run from a non-elevated shell');
  if (/EGO_TASK_SPACE_NAME_IN_USE/.test(err)) hints.push('that task space name belongs to the user — pick another name (never claim theirs without being asked)');
  if (/SyntaxError: await is only valid/.test(err)) hints.push('the shell damaged the script — keep it in a .mjs file or a quoted heredoc (<<\'EOF\')');
  if (/browser_check refuses /.test(err)) hints.push('a refused CDP command (SKILL.md §1) — do it another way or ask the user');
  if (/is not a function|is not defined/.test(err)) hints.push('a name the script used does not exist — `browser-check api <part of the name>` lists what does');
  if (/\[ego-browser:notice\]/.test(r.stdout)) hints.push('an ego lite update is available — tell the user; run `ego-browser upgrade` only with their approval');
  if (r.transportError) hints.push('the PC relay did not run it: ' + redactText(String(r.transportError)).slice(0, 200) + ' — is the PC awake and logged in? (`browser-check doctor`)');
  // write guard ↔ login refresh (10-21): name a blocked refresh and the --allow-write that fixes it, right in the result
  for (const h of guardHints({ outs: c.outs, guardOn, site, allow, url })) hints.push(redactText(h));
  const res = {
    status, where: local ? 'local' : 'remote:' + cfg.ego.remoteHost, ms: Date.now() - started, egoMs: r.egoMs || r.ms,
    url: url ? redactUrl(url) : null, site: site ? { match: site.match, login: site.login, guardWrites: site.guardWrites } : null,
    guard: settings.guard ? (c.outs.GUARD || 'not reported — use bc.run, or call bc.guardWrites yourself') : null,
    images: c.images, out, outs: redact(c.outs), leftOpen: c.outs.LEFT_OPEN || null, startedEgo: r.startedEgo || null,
    hints, tail: c.tail.slice(-20),
  };
  writeFileSync(join(out, 'result.json'), JSON.stringify(res, null, 1));
  return res;
}

if (cmd === 'setup') {
  const { setup } = await import('./lib/setup.mjs');
  const r = await setup({ configFile: configPath(), remoteHost: opt('--remote-host', null), migrate: flag('--migrate') });
  if (flag('--json')) { print(r); process.exit(r.status === 'created' || r.status === 'exists' ? 0 : 1); }
  console.log(`setup        ${r.status} ${r.path || ''}`);
  for (const n of r.notes || []) console.log('   ' + n);
  for (const c of r.candidates || []) console.log(`   candidate: ${c} — rerun with --remote-host "${c}"`);
  for (const t of r.todo || []) console.log('!  ' + t);
  if (r.errors && r.errors.length) for (const e of r.errors) console.log('!  written config: ' + e);
  process.exit(r.status === 'created' || r.status === 'exists' ? 0 : 1);
}

if (cmd === 'doctor') {
  const report = { config: { path: cfgRes.path, ok: cfgRes.ok, errors: cfgRes.errors } };
  if (cfgRes.ok) { const { probe } = await import('./lib/capabilities.mjs'); report.capabilities = await probe(cfgRes.config); }
  if (!cfgRes.ok && cfgRes.errors.includes('config file not found')) report.next = 'run `browser-check setup` — it looks this machine over and writes the config';
  if (cfgRes.oldLayout) report.next = 'run `browser-check setup --migrate` — the config is the old Aside layout';
  if (flag('--json')) { print(report); process.exit(cfgRes.ok && report.capabilities.ready ? 0 : 1); }
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
  print(r);
  process.exit(r.supported === false || (sub === 'install' && !(r.health && r.health.ok)) ? 1 : 0);
}

if (cmd === 'look') {
  const { parseLook, buildLookScript, shapeLook, LOOK_USAGE } = await import('./lib/look.mjs');
  const p = parseLook(args.slice(1));
  if (!p.ok) { print({ status: 'usage', error: p.error, usage: 'browser-check ' + LOOK_USAGE }); process.exit(2); }
  if (!cfgRes.ok) notReady();
  const res = await execute(buildLookScript(p.spec), { url: p.spec.url, guardFlag: p.spec.guard, allow: p.spec.allow, outDir: p.spec.out, timeout: p.spec.timeout });
  const shaped = shapeLook(res);
  writeFileSync(join(res.out, 'look.json'), JSON.stringify(shaped, null, 1));
  print(shaped);
  process.exit(res.status === 'ok' ? 0 : 1);
}

if (cmd === 'run' || cmd === 'ego') {
  const scriptPath = args[1];
  if (!scriptPath || scriptPath.startsWith('--')) { print({ status: 'usage', usage: "browser-check run <script.mjs | -> [--url <url>] [--timeout <ms>] [--guard-writes [--allow-write <path>]…]   (`-` = the script on stdin, e.g. <<'EOF')" }); process.exit(2); }
  if (optAll('--allow-write').length && !flag('--guard-writes')) { const url0 = opt('--url', null); const s0 = url0 && cfgRes.ok ? siteFor(cfgRes.config, url0) : null; if (!(s0 && s0.guardWrites)) die('--allow-write needs --guard-writes (or sites[].guardWrites)'); }
  if (!cfgRes.ok) notReady();
  let user;
  try { user = scriptPath === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(scriptPath), 'utf8'); } catch (e) { die('cannot read the script: ' + e.message); }
  if (!user.trim()) die('the script is empty');
  let res;
  try { res = await execute(user, { url: opt('--url', null), guardFlag: flag('--guard-writes'), allow: optAll('--allow-write').map(undoMsysPath), outDir: opt('--out', null), timeout: opt('--timeout', 0) }); }
  catch (e) { die(String(e.message)); }
  print(res);
  process.exit(res.status === 'ok' ? 0 : 1);
}

if (cmd === 'api') {
  const api = await import('./lib/api.mjs');
  const kitNames = api.kits(join(HERE, 'kit'));
  let blocks = null; let why = null;
  if (cfgRes.ok) {
    try {
      const res = await execute(api.HELP_SCRIPT, { timeout: 60000 });
      const h = res.outs && res.outs.HELP && res.outs.HELP[0];
      if (typeof h === 'string') blocks = api.parseHelp(h); else why = res.status + ': ' + (res.hints[0] || res.tail.slice(-1)[0] || 'no help text');
    } catch (e) { why = String(e.message).slice(0, 200); }
  } else why = 'not set up: ' + (cfgRes.errors || []).join('; ');
  const a = api.answer(args.slice(1).filter((x) => !x.startsWith('--')).join(' '), blocks, kitNames);
  if (why) a.egoNote = "ego's own functions could not be listed — " + why;
  print(a);
  process.exit(0);
}

die('unknown command: ' + cmd + ' — `browser-check help`');
