#!/usr/bin/env node
/*
 * browser_check ego relay — runs on the PC, in the user's own non-elevated logon session (Task Scheduler, RunLevel
 * Limited). Why it exists (measured 2026-10-21): ego lite has no network port (a Mojo pipe only) and refuses any
 * elevated caller — "ego lite closed the connection because ego-browser is running as administrator" — and an
 * administrator's SSH session on Windows is always elevated. So a server can reach the PC over SSH but cannot run
 * ego-browser there itself; it hands the script to this relay through entry.cmd instead.
 *
 * Listens on 127.0.0.1 only (random port, written to ./port). Every request needs the token in ./token.
 *   POST /run     body = the complete ego-browser script → { exit, ms, timedOut, stdout, stderr }
 *                 header x-bc-timeout = ms (default 300000, max 1800000)
 *   GET  /health  → { ok, version, pid, dir, ego: { bin, running } }
 * Before a run it starts ego (minimized) if ego is not running, so ego's own auto-start does not throw a window
 * onto the screen. At most 3 runs at a time; the rest wait. The log keeps time, ms, exit and sizes — never scripts.
 * A second copy exits at once if one already answers /health (the scheduler starts it every minute).
 *
 * Stalled ego (2026-10-25): ego stayed up and its windows answered, but one tab held the agent channel and every run,
 * even help(), timed out with no output for 2.5 h until ego was restarted by hand. So after STALL_RUNS timed-out runs
 * in a row the relay asks ego for its task-space list (a round trip of ~0.1 s on a healthy ego); if that fails too it
 * restarts ego (window.ps1 restart: polite close, force only if ego stays, profile kept) and does not restart again
 * within RESTART_GAP_MS. New runs wait while this happens. /health shows the state.
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

export const RELAY_VERSION = 2;
const DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(DIR, 'token');
const PORT_FILE = join(DIR, 'port');
const LOG_FILE = join(DIR, 'relay.log');
const MAX_BODY = 16 * 1024 * 1024;
const MAX_OUT = 96 * 1024 * 1024;
const MAX_PARALLEL = 3;
const STALL_RUNS = 3;                      // timed-out runs in a row before ego is probed
const PROBE_MS = 30000;
const RESTART_GAP_MS = 15 * 60 * 1000;     // at most one restart per 15 min, so a broken ego is not restarted in a loop
const PROBE_SCRIPT = "const s = await listTaskSpaces(); console.log('bc-probe ' + s.length);\n";

const log = (m) => { try { appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + m + '\n'); } catch { /* disk */ } };

/** ego-browser.exe: $EGO_BROWSER, the link ego keeps to its active version, then the newest installed version. */
export function findEgoBrowser(env = process.env, home = homedir()) {
  const c = [];
  if (env.EGO_BROWSER) c.push(env.EGO_BROWSER);
  c.push(join(home, '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe'));
  const app = join(env.ProgramFiles || 'C:\\Program Files', 'Citro Labs', 'ego lite', 'Application');
  try {
    const vers = readdirSync(app).filter((d) => /^\d+(\.\d+)+$/.test(d)).sort((a, b) => b.split('.').map(Number).reduce((r, n, i) => r || n - (a.split('.').map(Number)[i] || 0), 0));
    for (const v of vers) c.push(join(app, v, 'ego-browser.exe'));
  } catch { /* not installed there */ }
  return c.find((p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } }) || null;
}

function egoRunning() {
  return new Promise((res) => execFile('tasklist.exe', ['/FI', 'IMAGENAME eq ego.exe', '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 5000 }, (e, out) => res(!e && /"ego\.exe"/i.test(String(out)))));
}
function windowPs(action, ms) {
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(DIR, 'window.ps1'), action], { windowsHide: true, timeout: ms }, (e, out) => {
    try { res(JSON.parse(String(out).trim().split(/\r?\n/).pop())); } catch { res({ ok: false, why: e ? String(e.message).slice(0, 120) : 'no output' }); }
  }));
}
const ensureWindow = () => windowPs('ensure', 25000);

function readToken() {
  if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function alreadyRunning(token) {
  if (!existsSync(PORT_FILE)) return false;
  const port = Number(readFileSync(PORT_FILE, 'utf8').trim());
  if (!port) return false;
  return new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', headers: { 'x-bc-token': token }, timeout: 2000 }, (resp) => { resp.resume(); res(resp.statusCode === 200); });
    r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
  });
}

let running = 0; const queue = [];
const slot = () => new Promise((res) => { if (running < MAX_PARALLEL) { running++; res(); } else queue.push(res); });
const free = () => { const n = queue.shift(); if (n) n(); else running--; };

function runEgo(bin, body, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(bin, ['nodejs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let size = 0; let timedOut = false;
    const cap = (d, which) => { size += d.length; if (size > MAX_OUT) { child.kill(); return; } if (which === 'o') out += d; else err += d; };
    child.stdout.on('data', (d) => cap(d, 'o'));
    child.stderr.on('data', (d) => cap(d, 'e'));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: -1, ms: Date.now() - t0, timedOut, stdout: out, stderr: err + '\n[relay] spawn failed: ' + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, ms: Date.now() - t0, timedOut, stdout: out, stderr: err }); });
    child.stdin.end(body);
  });
}

let stallStreak = 0; let lastRestartAt = 0; let healing = null;
/** Probe ego after a run of timeouts; restart it only when the probe fails too (a long script that hit its own limit is not a stall). */
async function heal(bin) {
  const streak = stallStreak;
  const p = await runEgo(bin, Buffer.from(PROBE_SCRIPT), PROBE_MS);
  const probe = `${p.timedOut ? 'timeout' : 'exit=' + p.exit} ms=${p.ms}`;
  stallStreak = 0;
  if (!p.timedOut && p.exit === 0) { log(`heal probe ok ${probe} after ${streak} timeouts - ego answers, no restart`); return; }
  const since = Date.now() - lastRestartAt;
  if (lastRestartAt && since < RESTART_GAP_MS) { log(`heal probe ${probe} after ${streak} timeouts - restart skipped, last restart ${Math.round(since / 1000)}s ago`); return; }
  lastRestartAt = Date.now();
  const r = await windowPs('restart', 60000);
  log(`heal probe ${probe} after ${streak} timeouts - restarted ego ok=${r.ok} stopped=${r.stopped ?? '-'}${r.why ? ' why=' + r.why : ''}`);
}
function noteRun(bin, r) {
  if (r.timedOut) stallStreak++; else stallStreak = 0;
  if (stallStreak >= STALL_RUNS && !healing) healing = heal(bin).catch((e) => log('heal failed ' + e.message)).finally(() => { healing = null; });
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const token = readToken();
  if (await alreadyRunning(token)) process.exit(0);
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-bc-token'] !== token) { send(403, { ok: false, why: 'bad token' }); req.resume(); return; }
    if (req.method === 'GET' && req.url === '/health') {
      egoRunning().then((up) => send(200, { ok: true, version: RELAY_VERSION, pid: process.pid, dir: DIR, ego: { bin: findEgoBrowser(), running: up },
        heal: { timeoutsInARow: stallStreak, healing: !!healing, lastRestart: lastRestartAt ? new Date(lastRestartAt).toISOString() : null } }));
      req.resume(); return;
    }
    if (req.method !== 'POST' || req.url !== '/run') { send(404, { ok: false, why: 'unknown' }); req.resume(); return; }
    const chunks = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > MAX_BODY) { send(413, { ok: false, why: 'script too large' }); req.destroy(); } else chunks.push(d); });
    req.on('end', async () => {
      if (n > MAX_BODY) return;
      const timeoutMs = Math.min(Math.max(Number(req.headers['x-bc-timeout']) || 300000, 5000), 1800000);
      const bin = findEgoBrowser();
      if (!bin) { send(500, { ok: false, why: 'ego-browser.exe not found on this PC' }); return; }
      if (healing) await healing;
      await slot();
      try {
        let started = null;
        if (!(await egoRunning())) started = await ensureWindow();
        const r = await runEgo(bin, Buffer.concat(chunks), timeoutMs);
        log(`run exit=${r.exit} ms=${r.ms} in=${n} out=${r.stdout.length}${r.timedOut ? ' TIMEOUT' : ''}${started ? ' started-ego' : ''}`);
        noteRun(bin, r);
        send(200, { ok: true, ...r, startedEgo: started });
      } catch (e) { log('run failed ' + e.message); send(500, { ok: false, why: String(e.message).slice(0, 200) }); }
      finally { free(); }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    writeFileSync(PORT_FILE, String(port) + '\n');
    log(`listening 127.0.0.1:${port} pid=${process.pid} v${RELAY_VERSION}`);
  });
}

const norm = (p) => resolve(p).toLowerCase();
if (process.argv[1] && norm(fileURLToPath(import.meta.url)) === norm(process.argv[1])) main();
