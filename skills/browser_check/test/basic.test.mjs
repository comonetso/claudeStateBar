// node --test test/basic.test.mjs — leak/policy/config fixtures (no browser, no network)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, redactUrl, redactBody, redactHeaders } from '../scripts/lib/redact.mjs';
import { decide, cdpAllowed, keyAllowed, selectorAllowed } from '../scripts/lib/policy.mjs';
import { validate, siteFor } from '../scripts/lib/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('redact: secrets in objects, urls, headers, bodies', () => {
  const r = redact({ password: 'x', temporary_password: 'y', reset_token: 'z', challenge_token: 'q', code: '123456', ticket: 't', nested: { access_token: 'a', url: 'https://h/p?token=1&x=2#frag' }, headers: { Authorization: 'Bearer abc', cookie: 'a=b', 'x-request-id': 'rid' } });
  assert.equal(r.password, '***'); assert.equal(r.temporary_password, '***'); assert.equal(r.reset_token, '***'); assert.equal(r.challenge_token, '***'); assert.equal(r.code, '***'); assert.equal(r.ticket, '***');
  assert.equal(r.nested.access_token, '***'); assert.equal(r.nested.url, 'https://h/p?token=***&x=2');
  assert.equal(r.headers.Authorization, '***'); assert.equal(r.headers.cookie, '***'); assert.equal(r.headers['x-request-id'], 'rid');
  assert.equal(redactUrl('https://h/a?ticket=abc&keep=1#h'), 'https://h/a?ticket=***&keep=1');
  assert.equal(redactBody('{"password":"p","ok":1}'), '{"password":"***","ok":1}');
  assert.ok(!redactBody('password=hunter2&x=1').includes('hunter2'));
  assert.ok(!redactBody('Authorization: Bearer eyJabcdefghijk').includes('eyJ'));
  assert.equal(redactHeaders({ 'Set-Cookie': 'a=b', Accept: '*/*' })['Set-Cookie'], '***');
});

test('policy: classification and gates', () => {
  assert.equal(decide({ instruction: '화면 확인해 봐' }).allow, true);
  assert.equal(decide({ instruction: '이 버튼 눌러 봐', action: true }).cls, 'ui-action');
  const m = decide({ instruction: '글 삭제해 봐', target: 'https://h/t', what: 'delete message 1' });
  assert.equal(m.allow, false); assert.equal(m.cls, 'data-mutation');
  const ok = decide({ instruction: '글 삭제해 봐', target: 'https://h/t', what: 'delete message 1' }, { class: 'data-mutation', target: 'https://h/t', what: 'delete message 1', by: 'user' });
  assert.equal(ok.allow, true);
  assert.equal(decide({ instruction: '로그인 해 봐' }).allow, false);
  assert.equal(decide({ instruction: '자동 채우기로 넣어' }).cls, 'auth-sensitive');
  assert.equal(decide({ instruction: '화면 봐', userTab: true }).allow, false);
  assert.equal(cdpAllowed('Browser.getVersion', 'C').ok, false);
  assert.equal(cdpAllowed('Network.getCookies', 'B').ok, false);
  assert.equal(cdpAllowed('Page.captureScreenshot', 'B', { fromSurface: false }).ok, false);
  assert.equal(cdpAllowed('Target.createTarget', 'B').ok, false);
  assert.equal(cdpAllowed('Target.createTarget', 'C').ok, true);
  assert.equal(cdpAllowed('Target.closeTarget', 'C', { targetId: 'x' }, new Set(['y'])).ok, false);
  assert.equal(cdpAllowed('Target.closeTarget', 'C', { targetId: 'x' }, new Set(['x'])).ok, true);
  assert.equal(cdpAllowed('Emulation.setDeviceMetricsOverride', 'B').ok, true);
  assert.equal(keyAllowed('Control+V'), false); assert.equal(keyAllowed('Shift+Insert'), false); assert.equal(keyAllowed('Enter'), true);
  assert.equal(selectorAllowed('aside-inline-menu li'), false); assert.equal(selectorAllowed('input[type=file]'), false); assert.equal(selectorAllowed('button.save'), true);
});

test('config: schema, unknown keys, defaults, site match', () => {
  const bad = validate({ schemaVersion: 1, mode: 'auto', asidee: {} });
  assert.equal(bad.ok, false); assert.ok(bad.errors.some((e) => e.includes('unknown key')));
  const rel = validate({ schemaVersion: 1, mode: 'auto', aside: { bin: 'aside' } });
  assert.ok(rel.errors.some((e) => e.includes('absolute')));
  const good = validate(JSON.parse(readFileSync(join(ROOT, 'config', 'example.json'), 'utf8').replace(/<[^>]+>/g, '/placeholder')));
  assert.equal(good.ok, true, good.errors.join('; '));
  assert.equal(good.config.aside.maxConcurrent, 1);
  const s = siteFor(good.config, 'https://dev.example.invalid:5173/t/x?token=1');
  assert.equal(s.login, 'rotating-refresh');
  assert.equal(siteFor(good.config, 'https://other.invalid/').match, null);
});

// The patterns name private hosts, paths and ports, so they are NOT in this public package: listing
// them here would publish them. They live in a local file, one /regex/flags per line (default
// ~/.claude/_private/browser_check_leak.txt, override with BROWSER_CHECK_LEAK_LIST). Without it the
// leak check is skipped, not passed.
const LEAK_LIST = process.env.BROWSER_CHECK_LEAK_LIST || join(homedir(), '.claude', '_private', 'browser_check_leak.txt');

test('leak: public package contains no private host/path/port fixtures', (t) => {
  if (!existsSync(LEAK_LIST)) { t.skip('no leak list at ' + LEAK_LIST); return; }
  const PRIVATE = readFileSync(LEAK_LIST, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const m = /^\/(.*)\/([a-z]*)$/.exec(l.trim()); assert.ok(m, 'bad leak list line: ' + l); return new RegExp(m[1], m[2]); });
  assert.ok(PRIVATE.length > 0, 'leak list is empty: ' + LEAK_LIST);
  const skip = /(^|\/)(test\/regress|node_modules|\.git)(\/|$)/;
  const files = [];
  // rel uses '/' on every OS: on Windows join() gives '\', which the skip pattern never matched
  (function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); const rel = p.slice(ROOT.length + 1).split(sep).join('/'); if (skip.test(rel)) continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(mjs|js|py|sh|json|md)$/.test(n)) files.push(p); } })(ROOT);
  const hits = [];
  for (const f of files) { const t = readFileSync(f, 'utf8'); for (const re of PRIVATE) if (re.test(t)) hits.push(f.slice(ROOT.length + 1) + ' ~ ' + re); }
  assert.deepEqual(hits, [], 'private values leaked:\n' + hits.join('\n'));
});
