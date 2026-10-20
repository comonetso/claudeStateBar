// node --test test/ego.test.mjs — the ego runner without a browser: script assembly, output collection, ssh options,
// the prelude's refused-command list and its syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitsNamed, buildScript, collect, sshArgs, EGO_DIR } from '../scripts/lib/ego.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const prelude = readFileSync(join(EGO_DIR, 'prelude.mjs'), 'utf8');

test('ego: only the kits a script names travel with it', () => {
  assert.deepEqual(kitsNamed("await bc.kit(page, 'webcheck'); await bc.kit(p2, \"perfdiag\"); bc.kit(page,'webcheck')"), ['webcheck', 'perfdiag']);
  assert.deepEqual(kitsNamed('no kits here'), []);
});

test('ego: buildScript fills the settings line and includes named kits', () => {
  const s = buildScript("await bc.kit(page, 'perfdiag');", { url: 'https://x.invalid/', windowScript: 'C:\\w.ps1' });
  const line = s.split('\n').find((l) => l.includes('/*__BC_CFG__*/'));
  const cfg = JSON.parse(line.replace(/^.*\/\*__BC_CFG__\*\/ /, '').replace(/;$/, ''));
  assert.equal(cfg.url, 'https://x.invalid/'); assert.equal(cfg.windowScript, 'C:\\w.ps1'); assert.equal(cfg.light, true);
  assert.ok(cfg.kit.perfdiag.length > 100);
  assert.ok(s.trimEnd().endsWith("await bc.kit(page, 'perfdiag');"));
  assert.throws(() => buildScript("bc.kit(page, 'nope')"), /unknown kit/);
});

test('ego: collect turns @@IMG into files, @@OUT into data, the rest into a redacted tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-ego-'));
  try {
    const out = ['plain line', '@@IMG a.png ' + Buffer.from('PNGDATA').toString('base64'), '@@OUT T {"x":1}', '@@OUT T 2', 'see https://h/p?token=abc', ''].join('\r\n');
    const c = collect(out, dir);
    assert.equal(c.images.length, 1); assert.ok(existsSync(c.images[0])); assert.equal(readFileSync(c.images[0], 'utf8'), 'PNGDATA');
    assert.deepEqual(c.outs.T, [{ x: 1 }, 2]);
    assert.equal(c.tail[0], 'plain line');
    assert.ok(!c.tail.join('\n').includes('abc'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ego: ssh keeps one master connection and never prompts', () => {
  const a = sshArgs('MyPC', '"entry.cmd" 300000', { controlDir: '/tmp/bc' });
  assert.ok(a.includes('BatchMode=yes')); assert.ok(a.includes('ControlMaster=auto')); assert.ok(a.some((x) => x.startsWith('ControlPath=')));
  assert.deepEqual(a.slice(-2), ['MyPC', '"entry.cmd" 300000']);
});

test('ego: the prelude refuses what SKILL.md §1 forbids and nothing ordinary', () => {
  const m = /const __bcDeny = (\/.*\/);/.exec(prelude);
  assert.ok(m, 'deny list not found');
  const deny = eval(m[1]); // eslint-disable-line no-eval — a regex literal taken from our own file
  for (const c of ['Storage.clearDataForOrigin', 'Storage.getCookies', 'Network.getAllCookies', 'Network.getCookies', 'Network.clearBrowserCookies', 'Network.deleteCookies', 'Network.setCookie', 'Browser.close', 'Browser.setWindowBounds', 'Fetch.enable', 'Target.createTarget', 'Target.closeTarget', 'Page.close'])
    assert.ok(deny.test(c), 'should refuse ' + c);
  for (const c of ['Runtime.enable', 'Network.enable', 'Network.getResponseBody', 'Page.captureScreenshot', 'Page.startScreencast', 'Emulation.setDeviceMetricsOverride', 'CSS.getMatchedStylesForNode', 'Accessibility.getFullAXTree', 'Target.getTargets', 'Browser.getWindowForTarget', 'Input.dispatchKeyEvent'])
    assert.ok(!deny.test(c), 'should allow ' + c);
});

test('ego: prelude parses as a module body and keeps its settings marker', () => {
  assert.ok(/\/\*__BC_CFG__\*\/[^\n]*;/.test(prelude));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction('taskSpace', prelude));
});

test('ego: PowerShell helpers stay ASCII (Windows PowerShell 5.1 misreads BOM-less UTF-8)', () => {
  for (const f of ['window.ps1', 'entry.cmd']) assert.ok(!/[^\x00-\x7F]/.test(readFileSync(join(ROOT, 'scripts', 'ego', f), 'utf8')), f + ' has non-ASCII');
});
