/*
 * First-run config (owner decision 2026-09-26): when browser_check finds no private config it runs `setup`, which
 * looks this machine over, writes ${CLAUDE_PLUGIN_DATA}/config.json and reports what went in, so the user sees it
 * before anything else happens.
 *
 * It only reads: candidate Aside CLI paths · the running Aside's own ports (the DevTools port from the main
 * process's --remote-debugging-port, the daemon's from the port it listens on — no port number is written into
 * this public code) · /json/version and /health on them · the standard reverse-tunnel socket · `aside host list`.
 * It never overwrites an existing config and never touches the browser, Aside or system settings.
 *
 * What it will not guess: which remote PC to drive when Aside lists more than one (status choose-host — the user
 * picks, then `setup --remote-host <name>`), and site rules (left empty — login classes and data-mutation approval
 * are the owner's call, and the defaults are the safe side). When nothing usable is found it writes nothing and
 * says what a person has to do (status not-ready), so the next run tries again.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpGet, probeCdp } from './capabilities.mjs';
import { checkSocket } from './cdp-unix.mjs';
import { load } from './config.mjs';

const execFileP = promisify(execFile);

export const loopback = (port) => 'http://127.0.0.1:' + port;
export const TUNNEL_SOCKET = join(homedir(), '.local', 'state', 'browser-check', 'cdp.sock'); // server side of the PC → server tunnel

/** Where the Aside CLI is usually installed, in the order to try. PATH comes first. */
export function asideCandidates(platform = process.platform, env = process.env, home = homedir()) {
  const exe = platform === 'win32' ? 'aside.exe' : 'aside';
  const fromPath = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((d) => join(d, exe));
  const known = platform === 'win32'
    ? [join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Aside', 'CLI', 'current', 'aside.exe')]
    : [join(home, '.local', 'bin', 'aside'), '/usr/local/bin/aside', '/usr/bin/aside'];
  return [...new Set([...fromPath, ...known])];
}

function findAside() {
  for (const p of asideCandidates()) {
    try { accessSync(p, constants.X_OK); if (existsSync(p)) return p; } catch { /* next */ }
  }
  return null;
}

/**
 * The running Aside's ports on this machine: { cdp, daemon } (numbers or null). The DevTools port is on the main
 * Aside process's command line; the daemon's command line has none, so its listening loopback port is asked for.
 * Windows only for the daemon; elsewhere the DevTools port is read from `ps`.
 */
export function parseDebugPort(commandLines) {
  for (const c of commandLines) {
    if (/--type=/.test(c)) continue; // helper processes repeat the flag; the main process has no --type
    const m = /--remote-debugging-port[=\s]+(\d+)/.exec(c);
    if (m) return Number(m[1]);
  }
  return null;
}

async function findLocalPorts() {
  if (process.platform === 'win32') {
    const ps = [
      "$c = @(Get-CimInstance Win32_Process -Filter \"Name='Aside.exe'\" | ForEach-Object { [string]$_.CommandLine })",
      "$d = Get-Process -Name 'aside-daemon' -ErrorAction SilentlyContinue | Select-Object -First 1",
      "$p = if ($d) { Get-NetTCPConnection -OwningProcess $d.Id -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1 -ExpandProperty LocalPort } else { $null }",
      "@{ lines = $c; daemon = $p } | ConvertTo-Json -Compress",
    ].join('; ');
    try {
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000, windowsHide: true });
      const j = JSON.parse(stdout.trim() || '{}');
      const lines = Array.isArray(j.lines) ? j.lines : j.lines ? [j.lines] : [];
      return { cdp: parseDebugPort(lines), daemon: Number.isInteger(j.daemon) ? j.daemon : null };
    } catch { return { cdp: null, daemon: null }; }
  }
  try {
    const { stdout } = await execFileP('ps', ['-eo', 'args'], { timeout: 5000 });
    return { cdp: parseDebugPort(stdout.split('\n').filter((l) => /aside/i.test(l))), daemon: null };
  } catch { return { cdp: null, daemon: null }; }
}

/**
 * Parse `aside host list`. Lines look like (measured 2026-09-26, the default host starred):
 *   * local                                        (this machine)
 *     remote:<uuid>  <PC name>                 online
 */
export function parseHostList(text) {
  const remotes = [];
  let local = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*\*?\s*/, '');
    if (/^local\b/.test(line)) { local = true; continue; }
    const m = /^remote:(\S+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const st = /^(.*?)\s+(online|offline|disabled)$/.exec(m[2]);
    remotes.push({ id: m[1], name: (st ? st[1] : m[2]).trim(), state: st ? st[2] : 'unknown' });
  }
  return { local, remotes };
}

async function hostList(bin) {
  try {
    const { stdout } = await execFileP(bin, ['host', 'list'], { timeout: 8000, env: { ...process.env, ASIDE_CLI_UPDATE_CHECK: '0' } });
    return { ok: true, ...parseHostList(stdout) };
  } catch (e) {
    return { ok: false, why: String((e && (e.stderr || e.message)) || e).split('\n')[0].slice(0, 160), local: false, remotes: [] };
  }
}

export const defaultDeps = {
  findAside,
  findLocalPorts,
  probeLocalCdp: (port) => probeCdp(loopback(port), 1000),
  probeDaemon: async (port) => { const r = await httpGet(loopback(port), '/health', 1000); return { ok: !r.error && r.status === 200 }; },
  socket: () => (process.platform === 'win32' ? { ok: false, why: 'not a server' } : checkSocket(TUNNEL_SOCKET)),
  hostList,
  isWindows: () => process.platform === 'win32',
};

/**
 * Decide the config from what was found. Pure (the tests drive it directly).
 * found = { asideBin, ports:{cdp,daemon}, localCdp:{ok,browser,reason}, daemon:{ok}, socket:{ok,why},
 *           hosts:{ok,why,remotes[]}, isWindows }
 * Returns { status: 'created'|'choose-host'|'not-ready', config?, candidates?, notes[], todo[] }.
 */
export function decide(found, wantHost) {
  const notes = [];
  const todo = [];
  const ports = found.ports || {};
  const localBrowser = !!(ports.cdp && found.localCdp && found.localCdp.ok);
  const cfg = { schemaVersion: 1, mode: 'auto', aside: { enabled: !!found.asideBin }, cdp: { enabled: true }, sites: [] };
  if (found.asideBin) { cfg.aside.bin = found.asideBin; notes.push('Aside CLI: ' + found.asideBin); } else notes.push('Aside CLI: not found');

  if (localBrowser) {
    // The browser is on this machine (the PC): drive it directly; no remote host needed.
    cfg.cdp.local = { endpoint: loopback(ports.cdp) };
    notes.push('browser on this machine: DevTools port ' + loopback(ports.cdp) + (found.localCdp.browser ? ' (' + found.localCdp.browser + ')' : ''));
    if (ports.daemon && found.daemon && found.daemon.ok) { cfg.cdp.local.daemonEndpoint = loopback(ports.daemon); notes.push('Aside daemon: ' + loopback(ports.daemon)); }
    return { status: 'created', config: cfg, notes, todo };
  }

  if (found.isWindows) {
    // Windows is the PC, whose own Aside also shows up as a remote host — guessing "server" here would make the PC
    // drive itself remotely. A PC with no DevTools port just has the Aside browser closed.
    todo.push('start the Aside browser on this PC, then run setup again');
    return { status: 'not-ready', notes: [...notes, 'no Aside browser DevTools port here (' + ((found.localCdp && found.localCdp.reason) || 'no answer') + ')'], todo };
  }

  // No browser here — a server. Two ways to reach the PC's browser: Aside remote (A/B) and the tunnel socket (C).
  let remoteOk = false;
  if (found.asideBin) {
    const hosts = found.hosts || { ok: false, remotes: [] };
    if (!hosts.ok) {
      notes.push('aside host list failed: ' + (hosts.why || 'unknown'));
      todo.push('Aside CLI is installed but not usable here — a person runs `aside login` on this machine');
    } else if (wantHost) {
      const h = hosts.remotes.find((r) => r.name === wantHost);
      if (!h) return { status: 'choose-host', candidates: hosts.remotes, notes: [...notes, 'no remote host named "' + wantHost + '"'], todo };
      cfg.aside.remoteHost = h.name; remoteOk = true; notes.push('remote PC (chosen): ' + h.name + ' — ' + h.state);
    } else if (hosts.remotes.length === 1) {
      const h = hosts.remotes[0];
      cfg.aside.remoteHost = h.name; remoteOk = true; notes.push('remote PC: ' + h.name + ' — ' + h.state);
      if (h.state !== 'online') todo.push('the remote PC is ' + h.state + ' — a person turns Aside Remote Control on there');
    } else if (hosts.remotes.length > 1) {
      return { status: 'choose-host', candidates: hosts.remotes, notes, todo };
    } else {
      notes.push('Aside lists no remote PC');
    }
  }
  // Always record the standard socket path on a server, so a tunnel set up later works without redoing setup.
  cfg.cdp.remote = { transport: 'unix', socketPath: TUNNEL_SOCKET };
  notes.push('tunnel socket: ' + TUNNEL_SOCKET + ' — ' + (found.socket && found.socket.ok ? 'present' : (found.socket && found.socket.why) || 'absent'));
  const tunnelOk = !!(found.socket && found.socket.ok);
  if (!remoteOk && !tunnelOk) {
    if (!found.asideBin) todo.push('install the Aside CLI and run `aside login` here (a person), for Aside remote control of the PC');
    todo.push('or open a PC → server tunnel to ' + TUNNEL_SOCKET + ' (README, Install step 4)');
    return { status: 'not-ready', notes, todo };
  }
  return { status: 'created', config: cfg, notes, todo };
}

/** Look the machine over and write the config if there is none. `configFile` is where load() will read it. */
export async function setup({ configFile, remoteHost } = {}, deps = defaultDeps) {
  if (!configFile) return { status: 'no-path', notes: ['no CLAUDE_PLUGIN_DATA and no BROWSER_CHECK_CONFIG'], todo: [] };
  if (existsSync(configFile)) return { status: 'exists', path: configFile, notes: ['a config is already there — left as it is'], todo: [] };
  const asideBin = deps.findAside();
  const ports = await deps.findLocalPorts();
  const localCdp = ports.cdp ? await deps.probeLocalCdp(ports.cdp) : { ok: false, reason: 'no running Aside browser with a DevTools port' };
  const found = {
    asideBin,
    ports,
    localCdp,
    daemon: localCdp.ok && ports.daemon ? await deps.probeDaemon(ports.daemon) : { ok: false },
    socket: deps.socket(),
    hosts: asideBin && !localCdp.ok ? await deps.hostList(asideBin) : null,
    isWindows: deps.isWindows(),
  };
  const d = decide(found, remoteHost);
  if (d.status !== 'created') return { ...d, path: configFile };
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(configFile), 0o700); } catch { /* not ours to change — load() reports it */ }
  writeFileSync(configFile, JSON.stringify(d.config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const check = load();
  return { ...d, path: configFile, valid: check.ok, errors: check.errors };
}
