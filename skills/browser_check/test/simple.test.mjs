// node --test test/simple.test.mjs — the easy front door without a browser: `look` arguments and the script it
// builds, `api` lookup over ego's help text, the data dir worked out without CLAUDE_PLUGIN_DATA, and bin/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseLook, buildLookScript, shapeLook } from '../scripts/lib/look.mjs';
import { parseHelp, answer, BC_API } from '../scripts/lib/api.mjs';
import { dataDirGuess } from '../scripts/lib/config.mjs';
import { buildScript, EGO_DIR } from '../scripts/lib/ego.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('look: steps keep their order, options are read, bad input is refused', () => {
  const p = parseLook(['https://x.invalid/a', '--fill', "loc=css:input[name='q']", 'a = b', '--click', 'text=Go', '--press', 'Enter', '--wait', '.res', '--width', '390x700', '--dark', '--full', '--name', 'my-check']);
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.spec.steps.map((s) => s.do), ['fill', 'click', 'press', 'wait']);
  assert.equal(p.spec.steps[0].sel, "loc=css:input[name='q']");
  assert.equal(p.spec.steps[0].text, 'a = b');
  assert.equal(p.spec.width, 390); assert.equal(p.spec.height, 700);
  assert.ok(p.spec.dark && p.spec.full && p.spec.shot);
  assert.equal(p.spec.name, 'my-check');
  assert.equal(parseLook(['https://x.invalid/', '--width', '390']).spec.height, 844);
  for (const bad of [[], ['ftp://x/'], ['not a url'], ['https://x.invalid/', '--fill', 'only-selector'], ['https://x.invalid/', '--bogus'],
    ['https://x.invalid/', 'https://y.invalid/'], ['https://x.invalid/', '--allow-write', '/api'], ['https://x.invalid/', '--name', 'has space'], ['https://x.invalid/', '--width', 'wide']]) {
    assert.equal(parseLook(bad).ok, false, JSON.stringify(bad));
  }
  assert.ok(parseLook(['https://x.invalid/', '--guard-writes', '--allow-write', '/api/token']).ok);
});

test('look: the built script parses with the prelude in front, and only uses bc helpers that exist', () => {
  const p = parseLook(['https://x.invalid/', '--fill', '#q', 'it\'s "quoted" `tick` ${x}', '--click', 'text=Go', '--select', 'select', 'b', '--press', 'Enter', '--wait-ms', '200', '--width', '390', '--dark']);
  const script = buildScript(buildLookScript(p.spec), { url: p.spec.url });
  assert.doesNotThrow(() => new AsyncFunction('taskSpace', 'help', script));
  assert.ok(script.includes('it\'s \\"quoted\\" `tick` ${x}'), 'the typed text travels as JSON data, never as code');
  const prelude = readFileSync(join(EGO_DIR, 'prelude.mjs'), 'utf8');
  for (const m of buildLookScript(p.spec).matchAll(/\bbc\.(\w+)\(/g)) assert.ok(new RegExp('\\b' + m[1] + '\\(').test(prelude), 'bc.' + m[1] + ' is not in the prelude');
});

test('look: the result is reshaped to one object per kind', () => {
  const res = { status: 'ok', where: 'local', ms: 10, images: ['/o/text.txt', '/o/look.png'], out: '/o', leftOpen: null, guard: null, hints: [], tail: [],
    outs: { PAGE: [{ url: 'https://x.invalid/' }], STEPS: [[{ do: 'click', ok: true }]], TEXT: [{ chars: 5, head: 'hello', cut: false }], SHOT: [{ ok: true }],
      PROBLEMS: [{ summary: { console: 0 }, console: [], exceptions: [], log: [], failed: [], http: [], ext: [{ x: 1 }] }], SENT: [[{ method: 'POST' }]], CLOSED: [{ closed: true }] } };
  const s = shapeLook(res);
  assert.equal(s.text, 'hello'); assert.equal(s.textFile, '/o/text.txt'); assert.equal(s.image, '/o/look.png');
  assert.equal(s.steps[0].do, 'click'); assert.equal(s.sent[0].method, 'POST'); assert.equal(s.closed.closed, true);
  assert.equal(s.problems.ext, undefined, 'extension noise is left out of the short result');
});

test("api: ego's help text splits into name / description / signature, and a part of a name finds it", () => {
  const help = 'profiles\n\nList browser profiles.\n\nawait profiles()\n\nPage.click\n\nClick an element.\n\nawait page.click(selector, { timeout? })\n\nPage.dblclick\n\nDouble-click.\n\nawait page.dblclick(selector)\n\nTaskSpace.name\n\nName.\n\ntask.name';
  const b = parseHelp(help);
  assert.equal(b.length, 4);
  assert.deepEqual(b[1], { name: 'Page.click', desc: 'Click an element.', sig: 'await page.click(selector, { timeout? })' });
  assert.deepEqual(answer('click', b, []).ego.map((x) => x.name), ['Page.click', 'Page.dblclick']);
  assert.deepEqual(answer('page.CLICK', b, []).ego.map((x) => x.name), ['Page.click']);
  assert.equal(answer('bc.shot', b, []).bc[0].name, 'bc.shot');
  const all = answer('', b, ['webcheck']);
  assert.equal(all.ego.length, 4); assert.equal(all.bc.length, BC_API.length); assert.deepEqual(all.kits, ['webcheck']);
  assert.ok(answer('nothing-like-this', b, []).note);
  assert.equal(answer('', null, []).egoAvailable, false);
});

test('api: every bc helper it describes exists in the prelude', () => {
  const prelude = readFileSync(join(EGO_DIR, 'prelude.mjs'), 'utf8');
  for (const x of BC_API) { const n = x.name.replace(/^bc\./, ''); assert.ok(new RegExp('^\\s+(async )?' + n + '[(: ]', 'm').test(prelude), x.name + ' missing from the prelude'); }
});

test('config: the data dir without CLAUDE_PLUGIN_DATA comes from where the plugin is installed', () => {
  assert.equal(dataDirGuess('/srv/x/.claude/plugins/cache/comonetso/browser-check/0.2.0', {}).replace(/\\/g, '/'), '/srv/x/.claude/plugins/data/browser-check-comonetso');
  assert.equal(dataDirGuess('/x/plugins/cache/some.market/my plugin/1.0', {}).replace(/\\/g, '/'), '/x/plugins/data/my-plugin-some-market');
  assert.equal(dataDirGuess('/anything', { CLAUDE_PLUGIN_DATA: '/d' }).replace(/\\/g, '/').replace(/^[A-Z]:/, ''), '/d');
  assert.equal(dataDirGuess('/work/skills/browser_check', { CLAUDE_CONFIG_DIR: '/home/u/.claude-team' }).replace(/\\/g, '/'), '/home/u/.claude-team/plugins/data/browser-check-comonetso');
});

test('bin: the shell launcher is LF and executable in git, the .cmd one is CRLF, both point at the CLI', () => {
  const sh = readFileSync(join(ROOT, 'bin', 'browser-check'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n') && !sh.includes('\r'), 'bin/browser-check must be LF with a #!/bin/sh line');
  assert.ok(sh.includes('scripts/browser-check.mjs'));
  const cmd = readFileSync(join(ROOT, 'bin', 'browser-check.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n') && cmd.includes('scripts\\browser-check.mjs'));
  let mode = null;
  try { mode = execFileSync('git', ['ls-files', '-s', 'bin/browser-check'], { cwd: ROOT, encoding: 'utf8' }).split(' ')[0]; } catch { /* not a git checkout (installed copy) */ }
  if (mode) assert.equal(mode, '100755', 'bin/browser-check needs the executable bit in git (git update-index --chmod=+x)');
});
