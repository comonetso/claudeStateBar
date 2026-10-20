/*
 * First-run config (owner decision 2026-09-26): when browser_check finds no private config it runs `setup`, which
 * looks this machine over, writes ${CLAUDE_PLUGIN_DATA}/config.json and reports what went in, so the user sees it
 * before anything else happens. It never overwrites a current config.
 *
 * ego lite layout (2026-10-21):
 *  - PC (ego lite installed here): ego.bin = ego-browser.exe. Servers can use it once `relay install` ran here.
 *  - server: every Host in ~/.ssh/config is asked, in parallel, whether it is a PC with the browser_check relay
 *    (`entry.cmd health`). One answer → ego.remoteHost; several → choose-host (the user picks, never guessed);
 *    none → not-ready with what a person has to do.
 *  - `--migrate` turns an old Aside (schemaVersion 1) file into this layout: site rules kept, old file backed up.
 * Site rules are never guessed (left as they were, or empty — the safe defaults).
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load, migrateSites } from './config.mjs';
import { findEgoBrowser, remoteHealth, DEFAULT_RELAY_ENTRY } from './ego.mjs';

const execFileP = promisify(execFile);

/** Host names in an ssh config (wildcards and negations skipped). */
export function parseSshHosts(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

export const defaultDeps = {
  isWindows: () => process.platform === 'win32',
  findEgo: () => findEgoBrowser(),
  egoVersion: async (bin) => { try { const { stdout, stderr } = await execFileP(bin, ["--version"], { timeout: 8000, windowsHide: true }); return [stdout, stderr].join('\n').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null; } catch { return null; } },
  sshHosts: () => { try { return parseSshHosts(readFileSync(join(homedir(), '.ssh', 'config'), 'utf8')); } catch { return []; } },
  health: (host) => remoteHealth({ host, timeoutMs: 12000 }),
};

/**
 * Decide the config from what was found. Pure (the tests drive it directly).
 * found = { isWindows, egoBin, egoVersion, pcs: [{ host, health }] }
 * Returns { status: 'created'|'choose-host'|'not-ready', config?, candidates?, notes[], todo[] }.
 */
export function decide(found, wantHost, sites = []) {
  const notes = []; const todo = [];
  const cfg = { schemaVersion: 2, ego: {}, sites };
  if (found.egoBin) {
    cfg.ego.bin = found.egoBin;
    notes.push('ego lite on this machine: ' + found.egoBin + (found.egoVersion ? ' (' + found.egoVersion + ')' : ''));
    if (found.isWindows) notes.push('servers can use this PC once `browser-check relay install` has run here');
    return { status: 'created', config: cfg, notes, todo };
  }
  if (found.isWindows) {
    todo.push('install ego lite on this PC (https://lite.ego.app/) and finish its first-run setup, then run setup again');
    return { status: 'not-ready', notes: ['ego-browser.exe not found here'], todo };
  }
  const ok = (found.pcs || []).filter((p) => p.health && p.health.ok);
  for (const p of found.pcs || []) notes.push('ssh ' + p.host + ': ' + (p.health && p.health.ok ? 'browser_check relay v' + p.health.version + ' (ego ' + (p.health.ego && p.health.ego.running ? 'running' : 'not running') + ')' : 'no relay (' + ((p.health && p.health.why) || 'no answer') + ')'));
  let pick = null;
  if (wantHost) {
    pick = ok.find((p) => p.host === wantHost);
    if (!pick) return { status: 'choose-host', candidates: ok.map((p) => p.host), notes: [...notes, 'no PC relay answered on "' + wantHost + '"'], todo };
  } else if (ok.length === 1) pick = ok[0];
  else if (ok.length > 1) return { status: 'choose-host', candidates: ok.map((p) => p.host), notes, todo };
  if (!pick) {
    todo.push('on the PC run `browser-check relay install` (ego lite installed there)');
    todo.push('this server needs an ssh Host for the PC with key login (a person sets it up)');
    return { status: 'not-ready', notes, todo };
  }
  cfg.ego.remoteHost = pick.host;
  cfg.ego.relayEntry = DEFAULT_RELAY_ENTRY;
  if (pick.health.dir) cfg.ego.relayDir = pick.health.dir;
  notes.push('PC: ' + pick.host + ' — relay at ' + (pick.health.dir || '?'));
  return { status: 'created', config: cfg, notes, todo };
}

/** Look the machine over and write the config if there is none (or, with migrate, replace an old-layout one). */
export async function setup({ configFile, remoteHost, migrate = false } = {}, deps = defaultDeps) {
  if (!configFile) return { status: 'no-path', notes: ['no CLAUDE_PLUGIN_DATA and no BROWSER_CHECK_CONFIG'], todo: [] };
  let sites = []; let backup = null;
  if (existsSync(configFile)) {
    let raw = null; try { raw = JSON.parse(readFileSync(configFile, 'utf8')); } catch { /* unreadable */ }
    if (!raw || raw.schemaVersion !== 1) return { status: 'exists', path: configFile, notes: ['a config is already there — left as it is'], todo: [] };
    if (!migrate) return { status: 'old-layout', path: configFile, notes: ['the config is the old Aside layout (schemaVersion 1)'], todo: ['run `setup --migrate` — it keeps the site rules and backs the old file up'] };
    sites = migrateSites(raw.sites);
    backup = configFile.replace(/\.json$/, '') + '.v1-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  }
  const isWindows = deps.isWindows();
  const egoBin = deps.findEgo();
  const found = { isWindows, egoBin, egoVersion: egoBin ? await deps.egoVersion(egoBin) : null, pcs: [] };
  if (!egoBin && !isWindows) {
    const hosts = deps.sshHosts().filter((h) => !/^(github\.com|gitlab\.com|bitbucket\.org)$/i.test(h));
    found.pcs = await Promise.all(hosts.map(async (host) => ({ host, health: await deps.health(host) })));
  }
  const d = decide(found, remoteHost, sites);
  if (d.status !== 'created') return { ...d, path: configFile };
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(configFile), 0o700); } catch { /* not ours to change — load() reports it */ }
  if (backup) { copyFileSync(configFile, backup); d.notes.push('old config backed up: ' + backup + (sites.length ? ' · ' + sites.length + ' site rule(s) kept' : '')); }
  writeFileSync(configFile, JSON.stringify(d.config, null, 2) + '\n', { mode: 0o600, flag: backup ? 'w' : 'wx' });
  const check = load();
  return { ...d, path: configFile, migrated: !!backup, valid: check.ok, errors: check.errors };
}
