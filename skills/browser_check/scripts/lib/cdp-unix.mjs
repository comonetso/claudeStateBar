/*
 * Transport C on a server: CDP over a reverse-forwarded Unix socket (`ssh -R <socket>:127.0.0.1:<debug-port>` from the
 * browser machine). The socket must be a real socket, not a symlink, mode 0600, owned by us — checked before connecting.
 * 🔴 root:0600 keeps other users out but NOT other root processes on the same host (documented residual risk).
 */
import { lstatSync } from 'node:fs';
import { CdpClient } from './cdp-client.mjs';

export function checkSocket(socketPath) {
  let st;
  try { st = lstatSync(socketPath); } catch { return { ok: false, why: 'socket file absent (tunnel not up?)' }; }
  if (st.isSymbolicLink()) return { ok: false, why: 'symlink refused' };
  if (!st.isSocket()) return { ok: false, why: 'not a socket' };
  if ((st.mode & 0o077) !== 0) return { ok: false, why: 'mode not 0600 — other users could attach' };
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, why: 'owner mismatch' };
  return { ok: true };
}

/** Connect over the Unix socket. opts: { connectTimeoutMs, commandTimeoutMs, log } */
export async function connectUnix(socketPath, opts = {}) {
  const c = checkSocket(socketPath);
  if (!c.ok) throw new Error('cdp-unix: ' + c.why + ' (' + socketPath + ')');
  return CdpClient.connect({ socketPath }, { ...opts, transport: 'C' });
}
