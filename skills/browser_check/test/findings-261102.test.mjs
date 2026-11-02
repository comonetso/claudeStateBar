// node --test test/findings-261102.test.mjs — what the 2026-11-02 comparison with ego's docs and source found.
// The prelude runs here against a small fake of ego's task space, so its logic is tested without a browser;
// test/ego-real-261102.mjs checks the same things in ego itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScript } from '../scripts/lib/ego.mjs';
import { parseLook, shapeLook, lookHints } from '../scripts/lib/look.mjs';
import { runHints, newerVersion } from '../scripts/lib/runHints.mjs';
import { pruneArtifacts, runFolderTime } from '../scripts/lib/artifacts.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Fresh classes per run, as in ego (a script's classes are its own, measured 2026-11-02): the prelude wraps their methods.
function fakes() {
class FakeKeyboard { async press() { return {}; } }
class FakeMouse { async click() { return {}; } }

/** A page with ego's zoom and its hiding of console messages. */
class FakePage {
  constructor(label, world) { this.label = label; this.spaceId = 7; this.world = world; this.keyboard = new FakeKeyboard(); this.mouse = new FakeMouse(); this.buffer = []; this.cdpCalls = []; this.override = null; this.automated = world.automated; this.wentBlank = false; this.inflightWrite = 0; }
  async cdp(method, params) {
    this.cdpCalls.push(method);
    if (method === 'egoAutomated.disable') { if (this.world.oldBrowser) throw new Error("'egoAutomated.disable' wasn't found"); this.automated = false; return {}; }
    if (method === 'Emulation.setDeviceMetricsOverride') this.override = params;
    if (method === 'Emulation.clearDeviceMetricsOverride') this.override = null;
    return {};
  }
  async events() { return this.buffer.splice(0); }
  async waitForTimeout() {}
  async waitForLoadState() {}
  async goto(u) { if (u === 'about:blank') this.wentBlank = true; }
  async url() { return 'https://x.invalid/' + this.label; }
  async info() { return { url: await this.url(), title: this.label, w: 1, h: 1, pw: 1, ph: 1 }; }
  async click() { return this.world.clickReceipt || {}; }
  async evaluate(fn, arg) {
    if (typeof fn === 'string') return undefined;
    const src = fn.toString();
    if (src.includes('console.debug')) { if (!this.automated) this.buffer.push({ method: 'Runtime.consoleAPICalled', params: { type: 'debug', args: [{ value: arg }] } }); return undefined; }
    if (src.includes('innerWidth, innerHeight')) {
      if (!this.override) return [1353, 903];
      const z = this.override.mobile ? 1 : this.world.zoom;
      return [Math.round(this.override.width / z), Math.round(this.override.height / z)];
    }
    if (src.includes('__bc_guard_selftest')) return 'TypeError: bc-guard: blocked POST';
    if (src.includes('__bcInflightWrite') && src.includes('performance')) return { p: this.inflightWrite ? 1 : 0, w: this.inflightWrite, n: 1, url: await this.url() };
    if (src.includes('__bcInflightWrite')) return this.inflightWrite;
    if (src.includes('__bcGuard')) return { blocked: [], allow: [] };
    return undefined;
  }
}
class FakeTask {
  constructor(world) { this.world = world; this.spaceId = 7; this.name = 'space'; this.map = new Map([['p1', new FakePage('p1', world)]]); this.finished = 0; }
  page(l) { return this.map.get(l); }
  async pages() { return [...this.map.values()]; }
  async finish() { this.finished++; }
  open(l) { const p = new FakePage(l, this.world); this.map.set(l, p); return p; }
}
return { FakeTask };
}

async function start(settings = {}, worldOver = {}) {
  const world = { zoom: 1.1, automated: true, oldBrowser: false, clickReceipt: null, ...worldOver };
  const task = new (fakes().FakeTask)(world);
  const outs = {};
  const fakeConsole = { log(l) { const m = /^@@OUT (\S+) (.*)$/.exec(String(l)); if (m) (outs[m[1]] = outs[m[1]] || []).push(JSON.parse(m[2])); }, debug() {}, info() {} };
  const taskSpace = async () => task;
  const listTaskSpaces = async () => { world.listed = (world.listed || 0) + 1; return []; };
  const bc = await new AsyncFunction('taskSpace', 'listTaskSpaces', 'console', buildScript('return bc;', settings))(taskSpace, listTaskSpaces, fakeConsole);
  return { bc, task, world, outs };
}

test('the prelude talks to the browser once before the script, so a wait at its top does not hang', async () => {
  const { world } = await start();
  assert.equal(world.listed, 1);
});

test('console: ego hiding it is turned off, and arriving messages make the counts trustworthy', async () => {
  const { bc, task } = await start();
  const p = task.page('p1');
  await bc.watch(p);
  assert.ok(p.cdpCalls.indexOf('egoAutomated.disable') < p.cdpCalls.indexOf('Runtime.enable'), 'it must come before Runtime.enable');
  const r = await bc.problems(p);
  assert.equal(r.consoleState, 'on'); assert.equal(r.summary.console, 0); assert.equal(r.summary.exceptions, 0);
});

test('console: --no-console leaves it hidden and reports "not known", never 0', async () => {
  const { bc, task } = await start({ console: false });
  const p = task.page('p1');
  await bc.watch(p);
  assert.ok(!p.cdpCalls.includes('egoAutomated.disable'));
  const r = await bc.problems(p);
  assert.equal(r.consoleState, 'hidden'); assert.equal(r.summary.console, null); assert.equal(r.summary.exceptions, null);
});

test('console: when messages do not arrive at all the tool says it is blind, never 0', async () => {
  const { bc, task } = await start({}, { oldBrowser: true });   // the switch-off is refused and the hiding stays on
  const p = task.page('p1');
  await bc.watch(p);
  const r = await bc.problems(p);
  assert.equal(r.consoleState, 'blind'); assert.equal(r.summary.console, null);
  assert.match(runHints({ outs: { PROBLEMS: [r] } })[0], /NOT known/);
});

test('console: an older browser that reports everything is simply on', async () => {
  const { bc, task } = await start({}, { oldBrowser: true, automated: false });
  await bc.watch(task.page('p1'));
  assert.equal((await bc.problems(task.page('p1'))).consoleState, 'on');
});

test('width: a desktop width is corrected for page zoom, a mobile one is left alone', async () => {
  const { bc, task } = await start();
  const p = task.page('p1');
  for (const w of [768, 1024, 1280]) { const r = await bc.setWidth(p, w, 800); assert.equal(r.width, w, 'asked ' + w); }
  const m = await bc.setWidth(p, 390, 844);
  assert.equal(m.width, 390); assert.equal(p.override.width, 390); assert.equal(p.override.mobile, true); assert.equal(p.override.deviceScaleFactor, 3);
});

test('time limit: past it the next browser call stops the run, and the space is still closed', async () => {
  const { bc, task, outs } = await start({ deadlineMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(bc.run('s', async ({ page }) => { await page.click('#a'); assert.fail('must not get here'); }), (e) => e.code === 'BC_DEADLINE');
  assert.equal(task.finished, 1, 'the space is closed');
  assert.equal(outs.RUN_ERROR[0].kind, 'BC_DEADLINE');
  assert.match(runHints({ text: JSON.stringify(outs.RUN_ERROR) })[0], /time limit/);
});

test('refused CDP commands stay refused through the new wrapper, ordinary ones pass', async () => {
  const { bc, task } = await start();
  await bc.run('s', async ({ page }) => {
    assert.throws(() => page.cdp('Fetch.enable'), /refuses Fetch\.enable/);
    assert.throws(() => page.cdp('Storage.clearDataForOrigin'), /refuses/);
    await page.cdp('Runtime.enable');
  });
  assert.equal(task.finished, 1);
});

test('a window a click opened gets the guard and the record at once, and closes with the space', async () => {
  const world = { clickReceipt: { popups: [{ label: 'p2', targetId: 't' }] } };
  const { bc, task, outs } = await start({ guard: { allow: ['/api/refresh'] } }, world);
  let inside;
  await bc.run('s', async ({ task: t, page }) => {
    await bc.watch(page);
    t.open('p2');
    await page.click('a');
    inside = t.page('p2').cdpCalls.slice();
  });
  assert.ok(inside.includes('Page.addScriptToEvaluateOnNewDocument'), 'guard and counter installed');
  assert.ok(inside.includes('egoAutomated.disable') && inside.includes('Network.enable'), 'record started');
  assert.equal(task.finished, 1);
  assert.ok(outs.GUARD && outs.GUARD_BLOCKED);
});

test('the event record is per space: a second bc.run in one script does not inherit the first', async () => {
  const { bc, task } = await start();
  const p = task.page('p1');
  await bc.watch(p);
  p.buffer.push({ method: 'Network.requestWillBeSent', params: { requestId: '1', request: { method: 'POST', url: 'https://x.invalid/a' } } });
  assert.equal((await bc.sent(p)).length, 1);
  p.spaceId = 8;
  assert.equal((await bc.sent(p)).length, 0);
});

test('closing waits for every window: a write open in one leaves the space open and says so', async () => {
  const { bc, task, outs } = await start({ settleMs: 30 });
  task.open('p2').inflightWrite = 1;
  const closed = await bc.finish(task, task.page('p1'));
  assert.equal(closed.closed, false); assert.equal(task.finished, 0);
  assert.equal(outs.LEFT_OPEN[0].page, 'p2');
});

test('look refuses a ref from an earlier result before anything is pressed, and says what to use', () => {
  for (const sel of ['@12', 'ref=12']) {
    const r = parseLook(['https://x.invalid/', '--click', sel]);
    assert.equal(r.ok, false); assert.match(r.error, /loc=/);
  }
  assert.ok(parseLook(['https://x.invalid/', '--click', 'loc=href:https://x.invalid/a']).ok);
  assert.ok(parseLook(['https://x.invalid/', '--click', 'text="Save"']).ok);
  assert.equal(parseLook(['https://x.invalid/', '--no-console']).spec.noConsole, true);
});

test('a failed step is not "ok": status and hint say so', () => {
  const base = { status: 'ok', images: [], hints: [], outs: {} };
  const s = shapeLook({ ...base, outs: { STEPS: [[{ do: 'click', sel: '#a', ok: true }, { do: 'click', sel: '#nope', ok: false, error: 'page.click timed out after 3000ms: Selector #nope matched 0 elements' }]] } });
  assert.equal(s.status, 'step-failed');
  assert.match(s.hints[0], /step 2 \(--click #nope\) failed/); assert.match(s.hints[0], /--wait <selector>/);
  assert.equal(shapeLook({ ...base, outs: { STEPS: [[{ do: 'click', ok: true }]] } }).status, 'ok');
  assert.match(lookHints({ steps: [{ do: 'click', sel: 'a', ok: false, error: 'Selector a matched 3 elements' }] })[0], />> nth=0/);
});

test('look result: windows, the rest of the page and a cut full capture are all in hints', () => {
  const s = shapeLook({ status: 'ok', images: ['/o/text.txt', '/o/look.png', '/o/popup-p2.txt', '/o/popup-p2.png'], hints: ['h0'],
    outs: { POPUPS: [[{ label: 'p2', url: 'https://x.invalid/' }]], TEXT: [{ head: 'x', cut: false, more: '[more content below the viewport: 3 screens]' }], SHOT: [{ ok: true, fullPage: { whole: false, height: 10000, pageHeight: 20000 } }] } });
  assert.equal(s.image, '/o/look.png'); assert.equal(s.popups[0].image, '/o/popup-p2.png'); assert.equal(s.popups[0].textFile, '/o/popup-p2.txt');
  assert.equal(s.hints[0], 'h0');
  assert.ok(s.hints.some((h) => /opened a new window \(p2/.test(h)));
  assert.ok(s.hints.some((h) => /--full to read all/.test(h)));
  assert.ok(s.hints.some((h) => /stops at 10000 of 20000/.test(h)));
  assert.equal(shapeLook({ status: 'ok', images: ['/o/popup-p2.png'], hints: [], outs: {} }).image, null, "a popup's capture is not the page's");
});

test('run hints: the update notice is found on either stream, stops and limits are explained', () => {
  assert.match(runHints({ text: '[ego-browser:notice] Ego Lite update is available (current 0.6.1.13).' })[0], /update is available/);
  assert.match(runHints({ text: 'x EGO_TASK_SPACE_USER_IN_CONTROL y' })[0], /do not retry/);
  assert.match(runHints({ text: 'EGO_TASK_SPACE_INACTIVE' })[0], /hard stop/);
  assert.match(runHints({ text: 'EGO_PAGE_UNRESPONSIVE' })[0], /Page\.stopLoading/);
  assert.match(runHints({ status: 'timeout' })[0], /keeps a script running/);
  assert.deepEqual(runHints({ text: 'all fine', status: 'ok', outs: { PROBLEMS: [{ consoleState: 'on' }] } }), []);
  assert.match(runHints({ outs: { PROBLEMS: [{ consoleState: 'hidden' }] } })[0], /--no-console/);
});

test('doctor: a downloaded newer version is found, equal or older ones are not', () => {
  assert.equal(newerVersion('ego-browser 0.6.1.13', ['0.6.1.13', '0.6.2.5', 'SetupMetrics', 'ego.exe']), '0.6.2.5');
  assert.equal(newerVersion('ego-browser 0.6.2.5', ['0.6.1.13', '0.6.2.5']), null);
  assert.equal(newerVersion('ego-browser 0.6.1.9', ['0.6.1.13', '0.6.1.11']), '0.6.1.13');
  assert.equal(newerVersion(null, ['0.6.2.5']), null);
});

test('retention: only run folders older than the limit go, once a day, nothing else is touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-prune-'));
  try {
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    const old = '2026-10-09T13-41-18-574Z', recent = '2026-11-01T00-00-00-000Z', other = 'keep-this', almost = '2026-10-09';
    for (const n of [old, recent, other, almost]) { mkdirSync(join(dir, n)); writeFileSync(join(dir, n, 'f'), 'x'); }
    assert.equal(runFolderTime(other), null);
    assert.equal(pruneArtifacts(dir, 7, now), 1);
    assert.ok(!existsSync(join(dir, old)));
    for (const n of [recent, other, almost]) assert.ok(existsSync(join(dir, n)), n + ' must stay');
    mkdirSync(join(dir, old));
    utimesSync(join(dir, '.last-prune'), new Date(now - 3600000), new Date(now - 3600000));
    assert.equal(pruneArtifacts(dir, 7, now), 0, 'not twice in one day');
    utimesSync(join(dir, '.last-prune'), new Date(now - 90000000), new Date(now - 90000000));
    assert.equal(pruneArtifacts(dir, 7, now), 1, 'again the next day');
    assert.equal(pruneArtifacts(join(dir, 'no-such-folder'), 7, now), 0);
    assert.equal(pruneArtifacts(dir, 0, now), 0, 'a nonsense limit removes nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
