// node --test test/borrow.test.mjs — opt-in C features without a browser: borrowing a user's tab, giving it back,
// the write guard, isolated windows, the read-only tab list, and the config keys that switch them on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpClient } from '../scripts/lib/cdp-client.mjs';
import { cdpAllowed, writeAllowed, urlMatches } from '../scripts/lib/policy.mjs';
import { validate, siteFor } from '../scripts/lib/config.mjs';

// A fake browser: every command gets the handler's answer (undefined = no answer). The handler may emit events.
function fakeBrowser(handler) {
  const ws = new EventEmitter(); ws.sent = [];
  ws.event = (method, params, sessionId) => ws.emit('message', JSON.stringify({ method, params, sessionId }));
  ws.send = (t) => {
    const m = JSON.parse(t); ws.sent.push(m);
    setImmediate(async () => { const r = await handler(m, ws); if (r !== undefined) ws.emit('message', JSON.stringify(r && r.__error ? { id: m.id, error: r.__error } : { id: m.id, result: r })); });
  };
  ws.close = () => ws.emit('close');
  return ws;
}

const TABS = [
  { targetId: 'J', type: 'page', url: 'https://jandi.example/app', title: 'JANDI' },
  { targetId: 'M1', type: 'page', url: 'https://mesa.example:8443/admin?token=abc', title: 'Mesa' },
  { targetId: 'M2', type: 'page', url: 'https://mesa.example:8443/other', title: 'Mesa elsewhere' },
  { targetId: 'X', type: 'page', url: 'https://other.example/?q=mesa.example:8443', title: 'mentions mesa in query' },
  { targetId: 'SW', type: 'service_worker', url: 'https://mesa.example:8443/sw.js' },
];
const WIN = { J: 1, M1: 1, M2: 2, X: 1 };

function browser(extra = () => undefined) {
  return fakeBrowser((m, ws) => {
    const x = extra(m, ws); if (x !== undefined) return x;
    switch (m.method) {
      case 'Target.getTargets': return { targetInfos: TABS };
      case 'Browser.getWindowForTarget': return { windowId: WIN[m.params.targetId], bounds: { windowState: 'normal' } };
      case 'Target.attachToTarget': return { sessionId: 'S-' + m.params.targetId };
      case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'prep-1' };
      case 'Runtime.evaluate': return { result: { value: /restored/.test(m.params.expression) && /__bcBorrow; if/.test(m.params.expression) ? { restored: 2 } : { injected: ['aside-inline-menu'] } } };
      default: return {};
    }
  });
}
const open = { borrowGate: () => ({ ok: true }) };

test('policy: read-only tab/window lookups pass on C only; everything else Browser.*/Fetch.* stays denied', () => {
  assert.equal(cdpAllowed('Target.getTargets', 'C', {}, new Set()).ok, true);
  assert.equal(cdpAllowed('Browser.getWindowForTarget', 'C', { targetId: 'J' }, new Set()).ok, true);
  assert.equal(cdpAllowed('Target.getTargets', 'B', {}, new Set()).ok, false);
  assert.equal(cdpAllowed('Browser.getWindowForTarget', 'B', {}, new Set()).ok, false);
  for (const m of ['Browser.close', 'Browser.setWindowBounds', 'Fetch.enable', 'Fetch.failRequest', 'Storage.setCookies', 'Target.activateTarget', 'Target.createBrowserContext', 'Target.disposeBrowserContext'])
    assert.equal(cdpAllowed(m, 'C', {}, new Set()).ok, false, m);
  // a lent tab may be attached, never closed
  assert.equal(cdpAllowed('Target.attachToTarget', 'C', { targetId: 'M1' }, new Set(), new Set(['M1'])).ok, true);
  assert.equal(cdpAllowed('Target.closeTarget', 'C', { targetId: 'M1' }, new Set(), new Set(['M1'])).ok, false);
  assert.equal(cdpAllowed('Target.attachToTarget', 'C', { targetId: 'M1' }, new Set()).ok, false);
});

test('urlMatches / writeAllowed: origin+path only, exact unless *', () => {
  assert.equal(urlMatches('mesa.example:8443', 'https://mesa.example:8443/admin?x=1'), true);
  assert.equal(urlMatches('mesa.example:8443', 'https://other.example/?q=mesa.example:8443'), false, 'query is not looked at');
  assert.equal(urlMatches('https://mesa.example:*/admin*', 'https://mesa.example:8443/admin/users'), true);
  assert.equal(urlMatches('https://mesa.example:*/admin', 'https://mesa.example:8443/admin/users'), false);
  const allow = ['/api/v1/auth/refresh', '/api/v1/realtime/*', 'https://api.example/keep'];
  assert.equal(writeAllowed(allow, 'https://mesa.example:8443/api/v1/auth/refresh?x=1'), true);
  assert.equal(writeAllowed(allow, 'https://mesa.example:8443/api/v1/auth/refresh/extra'), false);
  assert.equal(writeAllowed(allow, 'https://mesa.example:8443/api/v1/realtime/ticket'), true);
  assert.equal(writeAllowed(allow, 'https://api.example/keep'), true);
  assert.equal(writeAllowed(allow, 'https://evil.example/keep'), false);
  assert.equal(writeAllowed(allow, 'https://mesa.example:8443/api/v1/accounts'), false);
  assert.equal(writeAllowed([], 'https://mesa.example:8443/api/v1/auth/refresh'), false);
});

test('borrowing is off by default (no gate given)', async () => {
  const c = new CdpClient(browser(), { transport: 'C', commandTimeoutMs: 200 });
  await assert.rejects(c.borrowTab({ match: 'mesa.example:8443', sameWindowAs: 'jandi.example' }), (e) => e.code === 'not-lent');
  assert.equal(c.borrowed.size, 0);
});

test('borrowTab: picks the tab in the anchor window, preps it, never creates/raises/closes; release undoes everything', async () => {
  const ws = browser();
  const c = new CdpClient(ws, { transport: 'C', commandTimeoutMs: 200, ...open });
  const b = await c.borrowTab({ match: 'mesa.example:8443', sameWindowAs: 'jandi.example' });
  assert.equal(b.targetId, 'M1'); assert.equal(b.sessionId, 'S-M1'); assert.equal(b.windowId, 1);
  assert.ok(!b.url.includes('abc'), 'token in the URL is redacted'); assert.deepEqual(b.injected, ['aside-inline-menu']);
  const methods = ws.sent.map((m) => m.method);
  assert.ok(!methods.includes('Target.createTarget') && !methods.includes('Target.activateTarget') && !methods.includes('Page.bringToFront'));
  assert.ok(methods.includes('Page.addScriptToEvaluateOnNewDocument'), 'prep survives navigation');
  // on the borrowed session: navigate yes; close/raise no
  await c.send('Page.navigate', { url: 'https://mesa.example:8443/x' }, 'S-M1');
  await assert.rejects(c.send('Page.close', {}, 'S-M1'), /borrowed tab/);
  await assert.rejects(c.send('Page.bringToFront', {}, 'S-M1'), /borrowed tab/);
  await assert.rejects(c.send('Target.closeTarget', { targetId: 'M1' }), /policy/);
  await assert.rejects(c.send('Fetch.enable', {}, 'S-M1'), /policy/, 'scripts still cannot use Fetch directly');
  // emulation is recorded and reset on release
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true }, 'S-M1');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, 'S-M1');
  const n0 = ws.sent.length;
  const r = await c.releaseTab('M1');
  const after = ws.sent.slice(n0).map((m) => m.method);
  assert.deepEqual(after, ['Emulation.clearDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Page.removeScriptToEvaluateOnNewDocument', 'Runtime.evaluate', 'Target.detachFromTarget']);
  assert.ok(!after.includes('Target.closeTarget') && !after.includes('Page.close'), 'the tab stays open');
  assert.ok(r.released && r.undone.some((u) => /prep \(2/.test(u)));
  assert.equal(c.borrowed.size, 0);
  await assert.rejects(c.send('Page.navigate', { url: 'https://x/' }, 'S-M1'), /policy/, 'after release the session is not ours');
});

test('borrowTab: no tab / several tabs / no anchor window → refuses, creates nothing', async () => {
  const ws = browser();
  const c = new CdpClient(ws, { transport: 'C', commandTimeoutMs: 200, ...open });
  await assert.rejects(c.borrowTab({ match: 'nothing.example' }), (e) => e.code === 'no-tab' && /ask the person/.test(e.message));
  await assert.rejects(c.borrowTab({ match: 'mesa.example:8443' }), (e) => e.code === 'several' && e.candidates.length === 2);
  await assert.rejects(c.borrowTab({ match: 'mesa.example:8443', sameWindowAs: 'slack.example' }), (e) => e.code === 'no-anchor');
  const ok = await c.borrowTab({ match: 'mesa.example:8443', targetId: 'M2' });
  assert.equal(ok.targetId, 'M2');
  assert.ok(!ws.sent.some((m) => m.method === 'Target.createTarget'));
  await c.dispose();
  assert.ok(ws.sent.some((m) => m.method === 'Target.detachFromTarget'), 'dispose gives the tab back');
  assert.ok(!ws.sent.some((m) => m.method === 'Target.closeTarget'), 'dispose never closes a borrowed tab');
});

test('guardWrites: GET passes, POST is failed and logged, allowed path passes; self-test must block its probe', async () => {
  const ws = browser((m, w) => {
    // the self-test fetch: the page POSTs the probe, the browser pauses it, the guard fails it, fetch rejects
    if (m.method === 'Runtime.evaluate' && /__browser_check_guard_selftest__/.test(m.params.expression)) {
      w.event('Fetch.requestPaused', { requestId: 'probe', request: { method: 'POST', url: 'https://mesa.example:8443/__browser_check_guard_selftest__/1' }, resourceType: 'Fetch' }, 'S-M1');
      return new Promise((r) => setTimeout(() => r({ result: { value: 'blocked TypeError' } }), 5));
    }
    return undefined;
  });
  const c = new CdpClient(ws, { transport: 'C', commandTimeoutMs: 200, ...open });
  await c.borrowTab({ match: 'mesa.example:8443', sameWindowAs: 'jandi.example' });
  const g = await c.guardWrites('S-M1', { allow: ['/api/v1/auth/refresh'] });
  assert.equal(g.selfTest.ok, true);
  const en = ws.sent.find((m) => m.method === 'Fetch.enable'); assert.equal(en.sessionId, 'S-M1'); assert.equal(en.params.patterns[0].requestStage, 'Request');
  assert.ok(ws.sent.some((m) => m.method === 'Fetch.failRequest' && m.params.requestId === 'probe'));
  const pause = (id, method, url) => ws.event('Fetch.requestPaused', { requestId: id, request: { method, url }, resourceType: 'XHR' }, 'S-M1');
  pause('g', 'GET', 'https://mesa.example:8443/api/v1/accounts');
  pause('p', 'POST', 'https://mesa.example:8443/api/v1/accounts?token=zzz');
  pause('r', 'POST', 'https://mesa.example:8443/api/v1/auth/refresh');
  pause('d', 'delete', 'https://mesa.example:8443/api/v1/accounts/1');
  pause('o', 'POST', 'https://mesa.example:8443/x'); // another session's request is not ours to answer
  ws.event('Fetch.requestPaused', { requestId: 'other', request: { method: 'POST', url: 'https://x/' } }, 'S-OTHER');
  await new Promise((r) => setTimeout(r, 20));
  const answer = (id) => ws.sent.filter((m) => m.params && m.params.requestId === id).map((m) => m.method);
  assert.deepEqual(answer('g'), ['Fetch.continueRequest']);
  assert.deepEqual(answer('p'), ['Fetch.failRequest']);
  assert.deepEqual(answer('r'), ['Fetch.continueRequest']);
  assert.deepEqual(answer('d'), ['Fetch.failRequest']);
  assert.deepEqual(answer('other'), []);
  const s = g.summary();
  assert.equal(s.blocked, 3); assert.equal(s.passed, 1);
  assert.ok(!JSON.stringify(s).includes('zzz'), 'logged URLs are redacted');
  assert.ok(!s.entries.some((e) => e.probe), 'the self-test probe is not counted');
  await c.releaseTab('M1');
  assert.ok(ws.sent.some((m) => m.method === 'Fetch.disable' && m.sessionId === 'S-M1'), 'release stops the guard');
});

test('guardWrites: a self-test whose POST got through turns the guard off and throws', async () => {
  const ws = browser((m) => (m.method === 'Runtime.evaluate' && /__browser_check_guard_selftest__/.test(m.params.expression) ? { result: { value: 'reached 404' } } : undefined));
  const c = new CdpClient(ws, { transport: 'C', commandTimeoutMs: 200, ...open });
  await c.borrowTab({ match: 'mesa.example:8443', sameWindowAs: 'jandi.example' });
  await assert.rejects(c.guardWrites('S-M1'), (e) => e.code === 'guard-self-test');
  assert.ok(ws.sent.some((m) => m.method === 'Fetch.disable'));
  assert.equal(c.guards.size, 0);
});

test('isolated window: own profile, minimized new window, cookies only there, thrown away on dispose', async () => {
  const ws = browser((m) => {
    if (m.method === 'Target.createBrowserContext') return { browserContextId: 'CTX' };
    if (m.method === 'Target.createTarget') return { targetId: 'ISO' };
    if (m.method === 'Browser.getWindowForTarget' && m.params.targetId === 'ISO') return { windowId: 9, bounds: { windowState: 'minimized' } };
    return undefined;
  });
  const c = new CdpClient(ws, { transport: 'C', commandTimeoutMs: 200 });
  const w = await c.openIsolatedWindow('https://mesa.example:8443/login');
  assert.deepEqual(w, { targetId: 'ISO', sessionId: 'S-ISO', browserContextId: 'CTX', windowState: 'minimized' });
  const ct = ws.sent.find((m) => m.method === 'Target.createTarget');
  assert.equal(ct.params.newWindow, true); assert.equal(ct.params.windowState, 'minimized'); assert.equal(ct.params.browserContextId, 'CTX');
  assert.equal(ws.sent.find((m) => m.method === 'Target.createBrowserContext').params.disposeOnDetach, true);
  await assert.rejects(c.send('Page.bringToFront', {}, 'S-ISO'), /isolated window/);
  const ck = await c.setIsolatedCookies('CTX', [{ name: 'sid', value: 'SECRET', domain: 'mesa.example', path: '/' }]);
  assert.deepEqual(ck, { count: 1, names: ['sid'] });
  assert.equal(ws.sent.find((m) => m.method === 'Storage.setCookies').params.browserContextId, 'CTX');
  await assert.rejects(c.setIsolatedCookies('DEFAULT', [{ name: 'a', value: 'b' }]), /not an isolated profile/);
  await assert.rejects(c.send('Storage.setCookies', { cookies: [] }), /policy/, 'scripts cannot set cookies directly');
  await c.dispose();
  const tail = ws.sent.map((m) => m.method);
  assert.ok(tail.indexOf('Target.closeTarget') < tail.indexOf('Target.disposeBrowserContext'));
  assert.equal(c.isolated.size, 0);
});

test('listTabs: pages only, with window ids; nothing attached', async () => {
  const ws = browser();
  const c = new CdpClient(ws, { transport: 'C', commandTimeoutMs: 200 });
  const tabs = await c.listTabs();
  assert.deepEqual(tabs.map((t) => [t.targetId, t.windowId]), [['J', 1], ['M1', 1], ['M2', 2], ['X', 1]]);
  assert.ok(!ws.sent.some((m) => m.method === 'Target.attachToTarget'));
});

test('config: borrow / guardWrites / writeAllow are optional, validated, and old configs stay valid', () => {
  const base = { schemaVersion: 1, mode: 'remote', sites: [{ match: 'https://mesa.example:*', login: 'rotating-refresh' }] };
  assert.equal(validate(base).ok, true);
  const lent = { ...base, sites: [{ match: 'https://mesa.example:*', borrow: { sameWindowAs: 'jandi.example' }, guardWrites: true, writeAllow: ['/api/v1/auth/refresh'] }] };
  const v = validate(lent); assert.equal(v.ok, true, v.errors.join());
  const s = siteFor(v.config, 'https://mesa.example:8443/admin');
  assert.deepEqual(s.borrow, { sameWindowAs: 'jandi.example' }); assert.equal(s.guardWrites, true);
  assert.equal(siteFor(validate(base).config, 'https://mesa.example:8443/').guardWrites, false);
  for (const bad of [{ borrow: true }, { borrow: { window: 'x' } }, { borrow: { sameWindowAs: '' } }, { guardWrites: 'yes' }, { writeAllow: '/x' }, { writeAllow: [''] }])
    assert.equal(validate({ ...base, sites: [{ match: 'https://mesa.example:*', ...bad }] }).ok, false, JSON.stringify(bad));
});
