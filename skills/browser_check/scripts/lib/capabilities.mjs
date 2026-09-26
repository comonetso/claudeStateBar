/*
 * Capability probe — decides which transports are available on THIS machine, in the documented order
 * (Codex consult D4-b). Probes are read-only and short; they never start repl/exec, never open a tab,
 * never call /json/list (it would expose the user's tab URLs), never change settings.
 *
 * Transports:  A = Aside repl standard API  ·  B = raw CDP inside repl (page._sendToTarget)
 *              C = direct CDP (local TCP on the browser machine, or a reverse-forwarded Unix socket on a server)
 */
import { existsSync, lstatSync, accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function httpGet(endpointOrSocket, path, timeoutMs) {
  return new Promise((resolve) => {
    const opts = endpointOrSocket.startsWith('/')
      ? { socketPath: endpointOrSocket, path, method: 'GET', headers: { Host: '127.0.0.1' } }
      : (() => { const u = new URL(endpointOrSocket); return { host: u.hostname, port: u.port, path, method: 'GET' }; })();
    const req = httpRequest(opts, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

async function probeCdp(endpointOrSocket, timeoutMs) {
  const r = await httpGet(endpointOrSocket, '/json/version', timeoutMs);
  if (r.error) return { ok: false, reason: r.error };
  try {
    const v = JSON.parse(r.body);
    return { ok: true, browser: v.Browser, protocol: v['Protocol-Version'], wsUrl: v.webSocketDebuggerUrl ? '(present)' : '(missing)' };
  } catch { return { ok: false, reason: 'non-JSON /json/version (status ' + r.status + ')' }; }
}

function probeSocketFile(p) {
  if (!p) return { ok: false, reason: 'not configured' };
  if (!existsSync(p)) return { ok: false, reason: 'socket file absent (tunnel not up?)' };
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink refused' };
  if (!st.isSocket()) return { ok: false, reason: 'not a socket' };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'mode not 0600' };
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, reason: 'owner mismatch' };
  return { ok: true };
}

async function probeAside(cfg, timeoutMs) {
  if (!cfg.enabled) return { ok: false, reason: 'disabled in config' };
  if (!cfg.bin) return { ok: false, reason: 'aside.bin not configured' };
  try { accessSync(cfg.bin, constants.X_OK); } catch { return { ok: false, reason: 'binary not executable: ' + cfg.bin }; }
  try {
    const { stdout } = await execFileP(cfg.bin, ['host', 'list'], { timeout: timeoutMs, env: { ...process.env, ASIDE_CLI_UPDATE_CHECK: '0' } });
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const local = lines.find((l) => /\blocal\b/.test(l) && /this machine/.test(l));
    const remote = cfg.remoteHost ? lines.find((l) => l.includes(cfg.remoteHost)) : null;
    const state = remote ? (/\bonline\b/.test(remote) ? 'online' : /\bdisabled\b/.test(remote) ? 'disabled' : /\boffline\b/.test(remote) ? 'offline' : 'unknown') : 'not-listed';
    return { ok: true, localListed: !!local, remoteState: state };
  } catch (e) {
    return { ok: false, reason: (e.stderr || e.message || '').toString().split('\n')[0].slice(0, 120) };
  }
}

/**
 * Probe everything and build the capability matrix. Returns
 * { platform, node, python, pillow, cdpLocal, daemonLocal, cdpRemote, aside, transports:{A,B,C}, mode, chosen, reasons[] }
 */
export async function probe(config) {
  const out = { platform: process.platform, node: process.version, reasons: [] };
  const t = config.cdp.connectTimeoutMs || 1000;

  // 2. runtime capabilities (no side effects)
  // Windows usually has `python` or the `py` launcher rather than `python3`. The first name that imports Pillow wins;
  // pythonCmd tells the caller which command to run scripts/image/*.py with.
  out.python = false; out.pillow = null; out.pythonCmd = null;
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    try { const { stdout } = await execFileP(cmd[0], [...cmd.slice(1), '-c', 'import PIL,sys;print(PIL.__version__)'], { timeout: 3000 }); out.python = true; out.pillow = stdout.trim(); out.pythonCmd = cmd.join(' '); break; } catch { /* try the next name */ }
  }

  // 3. local browser (only meaningful when mode is local/auto and we are on the browser machine)
  out.cdpLocal = { ok: false, reason: 'not configured' };
  out.daemonLocal = { ok: false, reason: 'not configured' };
  if (config.mode !== 'remote' && config.cdp.enabled) {
    if (config.cdp.local.endpoint) out.cdpLocal = await probeCdp(config.cdp.local.endpoint, t);
    if (config.cdp.local.daemonEndpoint) {
      const r = await httpGet(config.cdp.local.daemonEndpoint, '/health', t);
      out.daemonLocal = r.error ? { ok: false, reason: r.error } : { ok: r.status === 200, status: r.status };
    }
  }

  // 4. remote Unix socket (server side): lstat → /json/version over UDS
  out.cdpRemote = { ok: false, reason: 'not configured' };
  if (config.mode !== 'local' && config.cdp.enabled && config.cdp.remote.transport === 'unix') {
    const f = probeSocketFile(config.cdp.remote.socketPath);
    out.cdpRemote = f.ok ? await probeCdp(config.cdp.remote.socketPath, t) : f;
  } else if (config.mode !== 'local' && config.cdp.enabled && config.cdp.remote.transport === 'tcp' && config.cdp.remote.tcpEndpoint) {
    out.cdpRemote = await probeCdp(config.cdp.remote.tcpEndpoint, t);
    out.reasons.push('cdp.remote.transport=tcp is test-only (any local process can reach it)');
  }

  // 5. Aside CLI: binary + `host list` only
  out.aside = await probeAside(config.aside, 8000);

  // 6. matrix
  const localBrowser = out.cdpLocal.ok || out.daemonLocal.ok;
  const A = out.aside.ok && (localBrowser ? true : out.aside.remoteState === 'online');
  const B = A; // confirmed at run time via typeof tab._sendToTarget
  const C = out.cdpLocal.ok || out.cdpRemote.ok;
  out.transports = { A, B: B ? 'runtime-check' : false, C };
  out.mode = config.mode === 'auto' ? (localBrowser ? 'local' : 'remote') : config.mode;
  out.chosen = A && C ? 'A+B+C' : A ? 'A+B' : C ? 'C-only' : 'none';
  if (!A && out.aside.ok && out.aside.remoteState !== 'online') out.reasons.push('Aside remote host is ' + out.aside.remoteState + ' — cannot enable it from here; ask the owner');
  if (out.chosen === 'none') out.reasons.push('no transport available — see doctor table');
  return out;
}

/** Human table for doctor output. */
export function table(p) {
  const row = (cap, r) => `${cap.padEnd(12)} ${r.ok ? 'ok ' : 'NO '} ${r.ok ? Object.entries(r).filter(([k]) => k !== 'ok').map(([k, v]) => k + '=' + v).join(' ') : (r.reason || '')}`;
  return [
    `platform     ${p.platform} node=${p.node} python=${p.pythonCmd || false} pillow=${p.pillow || '-'}`,
    row('cdp.local', p.cdpLocal), row('daemon.local', p.daemonLocal), row('cdp.remote', p.cdpRemote), row('aside', p.aside),
    `transports   A=${p.transports.A} B=${p.transports.B} C=${p.transports.C}  → mode=${p.mode} chosen=${p.chosen}`,
    ...p.reasons.map((r) => '!  ' + r),
  ].join('\n');
}
