/*
 * Minimal WebSocket client for CDP over a Unix socket or loopback TCP — zero dependencies.
 *
 * Why not the global WebSocket: it only accepts ws:// URLs (TCP) and cannot dial a Unix socket. Transport C on a
 * server is a reverse-forwarded Unix socket (root 0600), so we speak HTTP/1.1 Upgrade + RFC 6455 framing ourselves.
 * Scope is deliberately small: text frames (CDP is JSON), client-side masking, fragmentation, ping/pong, close.
 * Binary frames are delivered as Buffers; extensions/compression are not negotiated.
 */
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Build the HTTP Upgrade request. Exported for tests. */
export function handshakeRequest(path, hostHeader, key) {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n');
}

export function expectedAccept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one client→server frame (masked, as RFC 6455 requires for clients). opcode: 1 text · 2 binary · 8 close · 9 ping · 10 pong */
export function encodeFrame(opcode, payload, mask = randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Incremental frame decoder. feed(buf) → array of { opcode, payload(Buffer), fin }. Handles server frames (unmasked)
 * and, for tests, masked ones too. Reassembles fragmented messages (opcode 0 continuation) into the first opcode.
 */
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); this.frag = null; }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) break; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) break;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = this.buf.subarray(off, off + 4); const p = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) p[i] = payload[i] ^ m[i & 3]; payload = p; } else payload = Buffer.from(payload);
      this.buf = this.buf.subarray(need);
      if (opcode === 0) { // continuation
        if (!this.frag) continue;
        this.frag.parts.push(payload);
        if (fin) { out.push({ opcode: this.frag.opcode, payload: Buffer.concat(this.frag.parts), fin: true }); this.frag = null; }
      } else if (!fin && (opcode === 1 || opcode === 2)) {
        this.frag = { opcode, parts: [payload] };
      } else {
        out.push({ opcode, payload, fin });
      }
    }
    return out;
  }
}

/**
 * Connect. target = { socketPath } | { host, port }. wsPath = the CDP path (e.g. /devtools/browser/<id>).
 * Returns an EventEmitter with send(text) · close() and events 'message'(string) · 'close' · 'error' · 'ping'.
 */
export function connect(target, wsPath, { timeoutMs = 3000, hostHeader = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const em = new EventEmitter();
    const key = randomBytes(16).toString('base64');
    const sock = target.socketPath ? net.createConnection({ path: target.socketPath }) : net.createConnection({ host: target.host, port: target.port });
    const dec = new FrameDecoder();
    let upgraded = false, headerBuf = Buffer.alloc(0), closed = false;
    const timer = setTimeout(() => { if (!upgraded) { sock.destroy(); reject(new Error('ws handshake timeout')); } }, timeoutMs);
    sock.setNoDelay(true);
    sock.on('connect', () => sock.write(handshakeRequest(wsPath, hostHeader, key)));
    sock.on('data', (chunk) => {
      if (!upgraded) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = headerBuf.subarray(0, end).toString('latin1');
        const rest = headerBuf.subarray(end + 4);
        const status = /^HTTP\/1\.1 (\d{3})/.exec(head);
        const accept = /Sec-WebSocket-Accept:\s*(\S+)/i.exec(head);
        if (!status || status[1] !== '101' || !accept || accept[1] !== expectedAccept(key)) {
          clearTimeout(timer); sock.destroy(); reject(new Error('ws handshake rejected: ' + head.split('\r\n')[0])); return;
        }
        upgraded = true; clearTimeout(timer);
        resolve(em);
        if (rest.length) handle(rest);
        return;
      }
      handle(chunk);
    });
    function handle(buf) {
      for (const f of dec.feed(buf)) {
        if (f.opcode === 1) em.emit('message', f.payload.toString('utf8'));
        else if (f.opcode === 2) em.emit('message', f.payload);
        else if (f.opcode === 9) { em.emit('ping'); if (!closed) sock.write(encodeFrame(10, f.payload)); }
        else if (f.opcode === 8) { closed = true; try { sock.write(encodeFrame(8, f.payload)); } catch { /* peer already gone */ } sock.end(); }
      }
    }
    sock.on('error', (e) => { if (!upgraded) { clearTimeout(timer); reject(e); } else em.emit('error', e); });
    sock.on('close', () => { closed = true; em.emit('close'); });
    em.send = (text) => { if (closed) throw new Error('ws closed'); sock.write(encodeFrame(1, text)); };
    em.close = () => { if (closed) return; closed = true; try { sock.write(encodeFrame(8, Buffer.from([0x03, 0xe8]))); } catch { /* ignore */ } setTimeout(() => sock.destroy(), 200); };
  });
}
