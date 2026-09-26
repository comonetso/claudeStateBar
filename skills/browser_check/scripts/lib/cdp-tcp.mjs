/*
 * Transport C on the browser machine itself (local mode): CDP over loopback TCP — the browser's own
 * `--remote-debugging-port`. Only 127.0.0.1 / ::1 endpoints are accepted; a non-loopback host is refused because
 * CDP has no authentication. On a server this transport is test-only (any local process could reach the port) —
 * use cdp-unix.mjs there.
 */
import { CdpClient } from './cdp-client.mjs';

export function parseEndpoint(endpoint) {
  const u = new URL(endpoint);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('cdp-tcp: only loopback endpoints are allowed (' + host + ')');
  return { host: host === 'localhost' ? '127.0.0.1' : host, port: Number(u.port || 80) };
}

/** Connect to a loopback CDP endpoint (http://127.0.0.1:<port>). opts: { connectTimeoutMs, commandTimeoutMs, log } */
export async function connectTcp(endpoint, opts = {}) {
  return CdpClient.connect(parseEndpoint(endpoint), { ...opts, transport: 'C' });
}
