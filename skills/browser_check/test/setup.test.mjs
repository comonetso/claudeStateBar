// node --test test/setup.test.mjs — first-run config (ego lite): ssh host parsing, the decision rules, never
// overwriting a current config, migrating an old Aside one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSshHosts, decide, setup } from '../scripts/lib/setup.mjs';
import { validate } from '../scripts/lib/config.mjs';

// An absolute path on whichever OS runs the tests (config validation checks it against the running platform)
const ABS_BIN = resolve('/opt/ego/ego-browser');
const health = (dir = 'C:\\Users\\u\\AppData\\Local\\browser-check\\relay') => ({ ok: true, version: 1, dir, ego: { bin: 'C:\\x\\ego-browser.exe', running: true } });

test('setup: ssh config hosts, wildcards and negations skipped', () => {
  const txt = 'Host MyPC\n  HostName 10.0.0.2\n  Port 2222\nHost *.internal !bad\nHost a b\nhost c\n';
  assert.deepEqual(parseSshHosts(txt), ['MyPC', 'a', 'b', 'c']);
  assert.deepEqual(parseSshHosts(''), []);
});

test('setup: PC with ego lite → ego.bin', () => {
  const d = decide({ isWindows: true, egoBin: ABS_BIN, egoVersion: 'ego-browser 0.6.0.16' });
  assert.equal(d.status, 'created');
  assert.equal(d.config.ego.bin, ABS_BIN);
  assert.ok(d.notes.some((n) => n.includes('relay install')));
  assert.equal(validate(d.config).ok, true, validate(d.config).errors.join('; '));
});

test('setup: Windows without ego lite → not-ready (never treated as a server)', () => {
  const d = decide({ isWindows: true, egoBin: null, pcs: [{ host: 'Other', health: health() }] });
  assert.equal(d.status, 'not-ready');
  assert.ok(d.todo[0].includes('install ego lite'));
});

test('setup: server with one PC relay → remoteHost and relay folder', () => {
  const d = decide({ isWindows: false, egoBin: null, pcs: [{ host: 'MyPC', health: health() }, { host: 'db', health: { ok: false, why: 'no answer' } }] });
  assert.equal(d.status, 'created');
  assert.equal(d.config.ego.remoteHost, 'MyPC');
  assert.ok(d.config.ego.relayDir.endsWith('relay'));
  assert.equal(validate(d.config).ok, true, validate(d.config).errors.join('; '));
});

test('setup: several PCs → choose-host, never guessed; the chosen one is used', () => {
  const pcs = [{ host: 'PC1', health: health() }, { host: 'PC2', health: health() }];
  const d = decide({ isWindows: false, pcs });
  assert.equal(d.status, 'choose-host'); assert.deepEqual(d.candidates, ['PC1', 'PC2']);
  assert.equal(decide({ isWindows: false, pcs }, 'PC2').config.ego.remoteHost, 'PC2');
  assert.equal(decide({ isWindows: false, pcs }, 'nope').status, 'choose-host');
});

test('setup: server with no PC relay → not-ready with what a person does', () => {
  const d = decide({ isWindows: false, pcs: [{ host: 'x', health: { ok: false, why: 'Permission denied' } }] });
  assert.equal(d.status, 'not-ready');
  assert.ok(d.todo.some((t) => t.includes('relay install')));
});

const deps = (over = {}) => ({ isWindows: () => false, findEgo: () => null, egoVersion: async () => null, sshHosts: () => ['github.com', 'MyPC'], health: async (h) => (h === 'MyPC' ? health() : { ok: false, why: 'no' }), ...over });

test('setup: writes once, then leaves a current config alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-setup-'));
  try {
    const f = join(dir, 'config.json');
    const r1 = await setup({ configFile: f }, deps());
    assert.equal(r1.status, 'created');
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).ego.remoteHost, 'MyPC');
    const r2 = await setup({ configFile: f }, deps({ health: async () => { throw new Error('must not be asked'); } }));
    assert.equal(r2.status, 'exists');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('setup: an old Aside config is reported, and --migrate keeps its site rules with a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-setup-'));
  try {
    const f = join(dir, 'config.json');
    writeFileSync(f, JSON.stringify({ schemaVersion: 1, mode: 'auto', aside: { enabled: true }, sites: [{ match: 'https://a.invalid', login: 'rotating-refresh', darkReader: 'tolerate', guardWrites: true, writeAllow: ['/r'] }] }));
    assert.equal((await setup({ configFile: f }, deps())).status, 'old-layout');
    const r = await setup({ configFile: f, migrate: true }, deps());
    assert.equal(r.status, 'created'); assert.equal(r.migrated, true);
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(cfg.schemaVersion, 2);
    assert.deepEqual(cfg.sites, [{ match: 'https://a.invalid', login: 'rotating-refresh', guardWrites: true, writeAllow: ['/r'] }]);
    assert.ok(readdirSync(dir).some((n) => /^config\.v1-.*\.json$/.test(n)), 'old file backed up');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
