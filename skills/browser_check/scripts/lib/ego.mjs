/*
 * Run a browser_check script in ego lite and collect what it printed.
 *   PC (ego installed here)  → ego-browser nodejs, script on stdin.
 *   server                   → ssh <pc> "<relay entry.cmd>" with the script on stdin; the PC relay runs ego-browser
 *                              in the user's non-elevated session (an elevated caller is refused by ego — relay.mjs).
 * The script sent is: prelude (bc.* helpers, this run's settings, the kits the script names) + the user's script.
 * Output contract: @@IMG <name> <base64> → a file in outDir · @@OUT <tag> <json> → result.outs[tag][] ·
 * everything else is redacted and kept as the log tail.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { redactText } from './redact.mjs';
export { findEgoBrowser } from '../ego/relay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EGO_DIR = join(HERE, '..', 'ego');
export const KIT_DIR = join(HERE, '..', 'kit');
export const DEFAULT_RELAY_ENTRY = '%LOCALAPPDATA%\\browser-check\\relay\\entry.cmd';
export const CONTROL_DIR = join(homedir(), '.local', 'state', 'browser-check');

/** Names the script passes to bc.kit(page, '<name>') — only those kits travel with it. */
export function kitsNamed(src) {
  const names = new Set();
  for (const m of String(src).matchAll(/bc\.kit(?:Source)?\(\s*[^,()]+,\s*['"]([\w.-]+)['"]/g)) names.add(m[1]);
  return [...names];
}

/** prelude + settings + user script. `settings` = { windowScript, light, settleMs, url, guard } */
export function buildScript(user, settings = {}, { kitDir = KIT_DIR, prelude = readFileSync(join(EGO_DIR, 'prelude.mjs'), 'utf8') } = {}) {
  const kit = {};
  for (const n of kitsNamed(user)) {
    const f = join(kitDir, n.endsWith('.js') ? n : n + '.js');
    if (!existsSync(f)) throw new Error('unknown kit: ' + n + ' (scripts/kit/' + n + '.js)');
    kit[n] = readFileSync(f, 'utf8');
  }
  const cfg = { windowScript: null, light: true, settleMs: 15000, url: null, guard: null, ...settings, kit };
  const marker = /\/\*__BC_CFG__\*\/[^\n]*;/;
  if (!marker.test(prelude)) throw new Error('prelude has no settings marker');
  return prelude.replace(marker, () => '/*__BC_CFG__*/ ' + JSON.stringify(cfg) + ';') + '\n' + user + '\n';
}

function spawnCollect(cmd, args, input, timeoutMs, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: -1, ms: Date.now() - t0, timedOut, stdout: out, stderr: err + '\nspawn failed: ' + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, ms: Date.now() - t0, timedOut, stdout: out, stderr: err }); });
    child.stdin.end(input);
  });
}

export function runLocal({ bin, script, timeoutMs = 300000 }) {
  return spawnCollect(bin, ['nodejs'], script, timeoutMs + 5000);
}

/** ssh options: batch, quiet, and one master connection kept 2 minutes (a fresh SSH login cost ~1-1.5 s per call). */
export function sshArgs(host, remoteCommand, { controlDir = CONTROL_DIR } = {}) {
  return ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10',
    '-o', 'ControlMaster=auto', '-o', 'ControlPath=' + join(controlDir, 'cm-%C'), '-o', 'ControlPersist=120',
    host, remoteCommand];
}

export async function runRemote({ host, entry = DEFAULT_RELAY_ENTRY, script, timeoutMs = 300000, controlDir = CONTROL_DIR }) {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const r = await spawnCollect('ssh', sshArgs(host, `"${entry}" ${timeoutMs}`, { controlDir }), script, timeoutMs + 20000, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
  const raw = r.stdout.trim();
  let j = null; try { j = JSON.parse(raw); } catch { /* not JSON */ }
  if (!j || j.ok === false) return { exit: -1, ms: r.ms, timedOut: r.timedOut, transportError: (j && j.why) || (r.stderr || raw).slice(0, 400) || 'no answer from the PC relay', stdout: '', stderr: r.stderr };
  return { exit: j.exit, ms: r.ms, egoMs: j.ms, timedOut: j.timedOut, stdout: j.stdout || '', stderr: j.stderr || '', startedEgo: j.startedEgo || null };
}

export async function remoteHealth({ host, entry = DEFAULT_RELAY_ENTRY, controlDir = CONTROL_DIR, timeoutMs = 15000 }) {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const r = await spawnCollect('ssh', sshArgs(host, `"${entry}" health`, { controlDir }), '', timeoutMs, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
  try { const j = JSON.parse(r.stdout.trim()); return j && j.ok ? j : { ok: false, why: (j && j.why) || 'relay said no' }; }
  catch { return { ok: false, why: (r.stderr || r.stdout || 'no answer').split('\n').filter(Boolean)[0]?.slice(0, 200) || 'no answer' }; }
}

/** Split the script's output into images, data lines and a redacted log tail. */
export function collect(stdout, outDir) {
  const images = []; const outs = {}; const lines = [];
  for (const l of String(stdout).split(/\r?\n/)) {
    const im = /^@@IMG (\S+) (\S+)$/.exec(l);
    if (im) { mkdirSync(outDir, { recursive: true }); const f = join(outDir, im[1]); writeFileSync(f, Buffer.from(im[2], 'base64')); images.push(f); continue; }
    const o = /^@@OUT (\S+) (.*)$/.exec(l);
    if (o) { let v; try { v = JSON.parse(o[2]); } catch { v = o[2]; } (outs[o[1]] = outs[o[1]] || []).push(v); continue; }
    if (l.trim()) lines.push(redactText(l).replace(/\x1b\[[0-9;]*m/g, ''));
  }
  return { images, outs, tail: lines.slice(-60) };
}
