/*
 * Single-flight lock for Aside CLI runs on this machine (Codex consult D6).
 * Why: the CLI refreshes its auth token without a file lock (two concurrent CLIs near expiry can race), and the
 * remote relay rate-limits the whole account. Default concurrency is 1. Lock = atomic mkdir under the plugin data dir.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 10 * 60 * 1000; // a repl call is ≤ 60 s; a persistent session heartbeat refreshes the stamp

export function lockDir(dataDir) {
  return join(dataDir, 'lock', 'aside');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** Try to take the lock. Returns { ok, holder } — never spins; the caller decides to wait or report. */
export function acquire(dataDir, label) {
  const dir = lockDir(dataDir);
  mkdirSync(join(dataDir, 'lock'), { recursive: true });
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), label: String(label || ''), at: new Date().toISOString() }));
    return { ok: true };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    const holder = readOwner(dir);
    return { ok: false, holder };
  }
}

export function readOwner(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch { return null; }
}

export function heartbeat(dataDir) {
  const f = join(lockDir(dataDir), 'owner.json');
  try { const o = JSON.parse(readFileSync(f, 'utf8')); o.at = new Date().toISOString(); writeFileSync(f, JSON.stringify(o)); } catch { /* lock gone */ }
}

export function release(dataDir) {
  const dir = lockDir(dataDir);
  const o = readOwner(dir);
  if (o && o.pid !== process.pid) return false; // never remove someone else's lock
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Doctor-only stale reclaim: same host, owner pid not alive OR stamp older than STALE_MS. Never called on the hot path.
 */
export function reclaimStale(dataDir) {
  const dir = lockDir(dataDir);
  if (!existsSync(dir)) return { reclaimed: false, why: 'no lock' };
  const o = readOwner(dir);
  const age = Date.now() - (o && o.at ? Date.parse(o.at) : statSync(dir).mtimeMs);
  const sameHost = o && o.host === hostname();
  if (sameHost && o.pid && alive(o.pid) && age < STALE_MS) return { reclaimed: false, why: 'holder alive', holder: o };
  if (!sameHost) return { reclaimed: false, why: 'other host — refuse', holder: o };
  rmSync(dir, { recursive: true, force: true });
  return { reclaimed: true, holder: o, ageMs: age };
}
