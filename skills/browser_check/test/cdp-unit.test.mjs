// node --test test/cdp-unit.test.mjs — transport C pieces that need no browser: framing, handshake, policy gating, ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encodeFrame, FrameDecoder, handshakeRequest, expectedAccept } from '../scripts/lib/cdp-ws.mjs';
import { CdpClient } from '../scripts/lib/cdp-client.mjs';
import { parseEndpoint } from '../scripts/lib/cdp-tcp.mjs';
import { checkSocket } from '../scripts/lib/cdp-unix.mjs';

test('ws framing: encode(masked) → decode round-trip, all length classes, fragmentation, control frames', () => {
  const dec = new FrameDecoder();
  for (const n of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
    const text = 'x'.repeat(n);
    const frames = dec.feed(encodeFrame(1, text));
    assert.equal(frames.length, 1, 'len ' + n); assert.equal(frames[0].opcode, 1); assert.equal(frames[0].payload.toString(), text);
  }
  // server-style unmasked frame
  const raw = Buffer.concat([Buffer.from([0x81, 3]), Buffer.from('abc')]);
  assert.equal(dec.feed(raw)[0].payload.toString(), 'abc');
  // fragmented: first (no fin) + continuation (fin)
  const p1 = Buffer.concat([Buffer.from([0x01, 2]), Buffer.from('he')]);
  const p2 = Buffer.concat([Buffer.from([0x80, 3]), Buffer.from('llo')]);
  assert.equal(dec.feed(p1).length, 0);
  const f = dec.feed(p2); assert.equal(f.length, 1); assert.equal(f[0].payload.toString(), 'hello');
  // split across chunks
  const whole = encodeFrame(1, 'split-me');
  assert.equal(dec.feed(whole.subarray(0, 4)).length, 0);
  assert.equal(dec.feed(whole.subarray(4))[0].payload.toString(), 'split-me');
  // ping/close opcodes pass through
  assert.equal(dec.feed(encodeFrame(9, 'p'))[0].opcode, 9);
  assert.equal(dec.feed(encodeFrame(8, Buffer.from([3, 232])))[0].opcode, 8);
});

test('ws handshake: request shape and accept key (RFC 6455 example)', () => {
  const req = handshakeRequest('/devtools/browser/abc', '127.0.0.1', 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.ok(req.startsWith('GET /devtools/browser/abc HTTP/1.1\r\n'));
  assert.ok(/Upgrade: websocket/.test(req) && /Sec-WebSocket-Version: 13/.test(req) && req.endsWith('\r\n\r\n'));
  assert.equal(expectedAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

function fakeWs() {
  const em = new EventEmitter(); em.sent = []; em.send = (t) => em.sent.push(JSON.parse(t)); em.close = () => em.emit('close'); return em;
}

test('cdp client: policy gate, ownership, response/event routing, timeout', async () => {
  const ws = fakeWs();
  const c = new CdpClient(ws, { commandTimeoutMs: 50, transport: 'C' });
  await assert.rejects(c.send('Browser.getVersion'), /policy/);
  await assert.rejects(c.send('Network.getCookies'), /policy/);
  await assert.rejects(c.send('Page.captureScreenshot', { fromSurface: false }), /policy/);
  await assert.rejects(c.send('Target.closeTarget', { targetId: 'not-mine' }), /policy/);
  // createTarget allowed on C; simulate browser reply then attach
  const p = c.openTarget('about:blank');
  const m1 = ws.sent[0]; assert.equal(m1.method, 'Target.createTarget'); assert.equal(m1.params.background, true);
  ws.emit('message', JSON.stringify({ id: m1.id, result: { targetId: 'T1' } }));
  await new Promise((r) => setImmediate(r));
  const m2 = ws.sent[1]; assert.equal(m2.method, 'Target.attachToTarget'); assert.equal(m2.params.targetId, 'T1'); assert.equal(m2.params.flatten, true);
  ws.emit('message', JSON.stringify({ id: m2.id, result: { sessionId: 'S1' } }));
  const t = await p; assert.deepEqual(t, { targetId: 'T1', sessionId: 'S1' }); assert.ok(c.owned.has('T1'));
  // Page.navigate: allowed on our own session, denied elsewhere
  await assert.rejects(c.send('Page.navigate', { url: 'https://x/' }, 'NOT-OURS'), /policy/);
  await assert.rejects(c.send('Page.navigate', { url: 'https://x/' }), /policy/);
  const nav = c.send('Page.navigate', { url: 'https://x/' }, 'S1');
  const mn = ws.sent[ws.sent.length - 1]; assert.equal(mn.method, 'Page.navigate'); assert.equal(mn.sessionId, 'S1');
  ws.emit('message', JSON.stringify({ id: mn.id, result: { frameId: 'f' } }));
  assert.equal((await nav).frameId, 'f');
  // sessionId propagates; events route by session; redaction applied in recorder
  const rec = c.record('S1');
  const q = c.send('Runtime.evaluate', { expression: '1' }, 'S1');
  const m3 = ws.sent[ws.sent.length - 1]; assert.equal(m3.method, 'Runtime.evaluate'); assert.equal(m3.sessionId, 'S1');
  ws.emit('message', JSON.stringify({ method: 'Runtime.consoleAPICalled', sessionId: 'S1', params: { type: 'error', args: [{ value: 'token=abc123' }] } }));
  ws.emit('message', JSON.stringify({ method: 'Network.responseReceived', sessionId: 'OTHER', params: { requestId: 'r', response: { status: 500, url: 'https://h/?ticket=1', headers: {} } } }));
  ws.emit('message', JSON.stringify({ method: 'Network.responseReceived', sessionId: 'S1', params: { requestId: 'r', response: { status: 401, url: 'https://h/a?ticket=1', headers: { 'set-cookie': 'x', server: 'nginx' } } } }));
  ws.emit('message', JSON.stringify({ id: m3.id, result: { result: { value: 1 } } }));
  assert.equal((await q).result.value, 1);
  const ev = rec.events(); assert.equal(ev.length, 2);
  assert.ok(!JSON.stringify(ev[0]).includes('abc123'), 'console token redacted');
  assert.equal(ev[1].url, 'https://h/a?ticket=***'); assert.equal(ev[1].headers['set-cookie'], '***'); assert.equal(ev[1].headers.server, 'nginx');
  assert.equal(rec.summary().problems.length, 2);
  rec.stop();
  // timeout
  await assert.rejects(c.send('Runtime.evaluate', { expression: '2' }, 'S1'), /timeout/);
  // closeTarget only for owned; dispose closes and clears
  const d = c.dispose();
  const m5 = ws.sent.find((m) => m.method === 'Target.closeTarget'); assert.equal(m5.params.targetId, 'T1');
  ws.emit('message', JSON.stringify({ id: m5.id, result: {} }));
  await d; assert.equal(c.owned.size, 0); assert.equal(c.closed, true);
});

test('cdp-tcp: loopback only · cdp-unix: socket checks', () => {
  assert.deepEqual(parseEndpoint('http://127.0.0.1:9333'), { host: '127.0.0.1', port: 9333 });
  assert.deepEqual(parseEndpoint('http://localhost:1'), { host: '127.0.0.1', port: 1 });
  assert.throws(() => parseEndpoint('http://10.0.0.5:9222'), /loopback/);
  assert.equal(checkSocket('/nonexistent/x.sock').ok, false);
  assert.equal(checkSocket(process.execPath).why, 'not a socket');
});
