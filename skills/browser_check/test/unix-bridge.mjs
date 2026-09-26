// Test helper: expose a loopback TCP CDP endpoint as a Unix socket (what `ssh -R <socket>:127.0.0.1:<port>` does on a
// server), so transport C's Unix path can be measured on any machine with a local headless Chromium. Node core only.
//   node test/unix-bridge.mjs <socketPath> <tcpPort>
import net from 'node:net';
import { unlinkSync, chmodSync, existsSync } from 'node:fs';
const [socketPath, port] = process.argv.slice(2);
if (!socketPath || !port) { console.error('usage: unix-bridge.mjs <socketPath> <tcpPort>'); process.exit(2); }
if (existsSync(socketPath)) unlinkSync(socketPath);
const srv = net.createServer((c) => {
  const u = net.connect(Number(port), '127.0.0.1');
  c.pipe(u); u.pipe(c);
  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
});
srv.listen(socketPath, () => { chmodSync(socketPath, 0o600); console.log('bridge ' + socketPath + ' → 127.0.0.1:' + port); });
process.on('SIGTERM', () => { srv.close(); try { unlinkSync(socketPath); } catch { /* gone */ } process.exit(0); });
