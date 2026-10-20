/*
 * Capability probe for `doctor` — read-only and short. It never opens a tab or a task space, never reads cookies,
 * never changes a setting or a window.
 *   PC     : ego-browser.exe · its version · ego running · ego's windows (a capture needs one that is not closed
 *            with X — minimized is fine) · the relay servers call (scripts/ego/relay.mjs)
 *   server : the PC relay's /health over ssh
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { remoteHealth } from './ego.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

async function python() {
  // Windows usually has `python` or the `py` launcher rather than `python3`. The first name that imports Pillow wins;
  // pythonCmd tells the caller which command to run scripts/image/*.py with.
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    try { const { stdout } = await execFileP(cmd[0], [...cmd.slice(1), '-c', 'import PIL,sys;print(PIL.__version__)'], { timeout: 3000, windowsHide: true }); return { python: true, pillow: stdout.trim(), pythonCmd: cmd.join(' ') }; } catch { /* next */ }
  }
  return { python: false, pillow: null, pythonCmd: null };
}

async function localEgo(bin) {
  if (!bin || !existsSync(bin)) return { ok: false, reason: 'ego-browser not found: ' + (bin || '(no ego.bin)') };
  const r = { ok: true, bin };
  try { const { stdout, stderr } = await execFileP(bin, ["--version"], { timeout: 8000, windowsHide: true }); r.version = [stdout, stderr].join('\n').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null; } catch (e) { r.version = null; r.versionError = String(e.message).slice(0, 80); }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, '..', 'ego', 'window.ps1'), 'list'], { timeout: 15000, windowsHide: true });
      const w = JSON.parse(stdout.trim().split(/\r?\n/).pop());
      r.running = w.running; r.windows = w.visible + ' visible (' + w.minimized + ' minimized) of ' + w.windows;
      if (w.running && w.visible === 0) r.note = 'every ego window is closed with X — a capture will reopen one minimized (about 0.1-0.2 s on screen)';
    } catch (e) { r.running = null; r.windowsError = String(e.message).slice(0, 80); }
  }
  return r;
}

/** { platform, node, python, pillow, pythonCmd, where, ego, relay?, ready, reasons[] } */
export async function probe(config) {
  const out = { platform: process.platform, node: process.version, reasons: [], ...(await python()) };
  const e = config.ego;
  if (!e.enabled) { out.where = 'off'; out.ego = { ok: false, reason: 'ego.enabled is false' }; out.ready = false; return out; }
  if (e.bin) {
    out.where = 'local';
    out.ego = await localEgo(e.bin);
    if (process.platform === 'win32') {
      const { status } = await import('./relay-install.mjs');
      const s = await status();
      out.relay = s.health && s.health.ok ? { ok: true, version: s.health.version, dir: s.dir } : { ok: false, reason: (s.task && s.task.exists === false ? 'not installed' : (s.health && s.health.why) || 'not answering') + ' — servers cannot use this PC until `relay install`' };
    }
  } else {
    out.where = 'remote';
    const h = await remoteHealth({ host: e.remoteHost, entry: e.relayEntry });
    out.ego = h.ok ? { ok: true, host: e.remoteHost, relay: 'v' + h.version, running: h.ego && h.ego.running, bin: h.ego && h.ego.bin } : { ok: false, host: e.remoteHost, reason: h.why };
    if (!h.ok) out.reasons.push('the PC relay did not answer — is the PC awake and logged in? (on the PC: `browser-check.mjs relay status`)');
    else if (h.ego && !h.ego.bin) out.reasons.push('the PC relay answered but found no ego-browser.exe there');
  }
  out.ready = !!(out.ego && out.ego.ok);
  return out;
}

/** Human table for doctor output. */
export function table(p) {
  const row = (cap, r) => `${cap.padEnd(12)} ${r && r.ok ? 'ok ' : 'NO '} ${r ? (r.ok ? Object.entries(r).filter(([k]) => k !== 'ok').map(([k, v]) => k + '=' + v).join(' ') : (r.reason || '')) : ''}`;
  return [
    `platform     ${p.platform} node=${p.node} python=${p.pythonCmd || false} pillow=${p.pillow || '-'}`,
    row('ego.' + p.where, p.ego),
    ...(p.relay ? [row('relay', p.relay)] : []),
    `ready        ${p.ready}`,
    ...p.reasons.map((r) => '!  ' + r),
  ].join('\n');
}
