// node --test test/setup.test.mjs — first-run config: port and host-list parsing, the decision rules, never overwriting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseHostList, parseDebugPort, decide, setup, asideCandidates, loopback, TUNNEL_SOCKET } from '../scripts/lib/setup.mjs';
import { validate } from '../scripts/lib/config.mjs';

// An absolute path on whichever OS runs the tests (config validation checks it against the running platform)
const ABS_BIN = resolve('/opt/aside/aside');

test('setup: DevTools port from the main Aside process, not its helpers', () => {
  assert.equal(parseDebugPort(['"C:\\A\\Aside.exe" --remote-debugging-port=9333 --restart --user-data-dir="C:\\u"']), 9333);
  assert.equal(parseDebugPort(['Aside.exe --type=renderer --remote-debugging-port=1111', 'Aside.exe --remote-debugging-port 9333']), 9333);
  assert.equal(parseDebugPort(['Aside.exe --type=gpu-process --remote-debugging-port=1111']), null);
  assert.equal(parseDebugPort([]), null);
});

test('setup: aside host list parsing (format measured 2026-09-26)', () => {
  const pc = parseHostList('* local                                        (this machine)           \n  remote:0f1e2d3c-aaaa-bbbb-cccc-111122223333  MyPc               online\n');
  assert.equal(pc.local, true);
  assert.deepEqual(pc.remotes, [{ id: '0f1e2d3c-aaaa-bbbb-cccc-111122223333', name: 'MyPc', state: 'online' }]);
  const two = parseHostList('  local   (this machine)\n* remote:a  Office PC   offline\n  remote:b  Home   disabled\n  remote:c  Odd\n');
  assert.deepEqual(two.remotes.map((r) => [r.name, r.state]), [['Office PC', 'offline'], ['Home', 'disabled'], ['Odd', 'unknown']]);
  assert.deepEqual(parseHostList('').remotes, []);
});

test('setup: Aside CLI candidates per OS, PATH first', () => {
  const w = asideCandidates('win32', { PATH: '', LOCALAPPDATA: 'C:\\L' }, 'C:\\U');
  assert.ok(w[w.length - 1].endsWith(join('Aside', 'CLI', 'current', 'aside.exe')));
  const l = asideCandidates('linux', { PATH: '' }, '/home/user');
  assert.deepEqual(l.slice(-3), [join('/home/user', '.local', 'bin', 'aside'), '/usr/local/bin/aside', '/usr/bin/aside']);
});

test('setup: decisions — PC, server with one/several/no remote host, nothing usable', () => {
  const ok = { ok: true, browser: 'Chrome/153' };
  const ports = { cdp: 9333, daemon: 30100 };
  // PC: the browser is here — direct, ports as found, no remote host
  const pc = decide({ asideBin: ABS_BIN, ports, localCdp: ok, daemon: { ok: true }, isWindows: true });
  assert.equal(pc.status, 'created');
  assert.deepEqual(pc.config.cdp.local, { endpoint: loopback(9333), daemonEndpoint: loopback(30100) });
  assert.equal(pc.config.aside.remoteHost, undefined);
  assert.equal(validate(pc.config).ok, true);
  // PC with the Aside browser closed: its own Aside shows up as a remote host — must not become "server"
  const pcClosed = decide({ asideBin: ABS_BIN, ports: { cdp: null, daemon: null }, localCdp: { ok: false, reason: 'no running Aside' }, isWindows: true, hosts: { ok: true, remotes: [{ name: 'MyPc', state: 'online' }] } });
  assert.equal(pcClosed.status, 'not-ready'); assert.equal(pcClosed.config, undefined);
  // server, one remote PC, tunnel up
  const server = { asideBin: '/home/user/.local/bin/aside', ports: { cdp: null, daemon: null }, localCdp: { ok: false }, isWindows: false };
  const one = decide({ ...server, socket: { ok: true }, hosts: { ok: true, remotes: [{ name: 'MyPc', state: 'online' }] } });
  assert.equal(one.status, 'created'); assert.equal(one.config.aside.remoteHost, 'MyPc');
  assert.deepEqual(one.config.cdp.remote, { transport: 'unix', socketPath: TUNNEL_SOCKET });
  assert.equal(validate(one.config).ok, true);
  // server, several remote PCs: do not guess; the user's choice is taken
  const two = { ok: true, remotes: [{ name: 'A', state: 'online' }, { name: 'B', state: 'online' }] };
  const many = decide({ ...server, socket: { ok: false }, hosts: two });
  assert.equal(many.status, 'choose-host'); assert.deepEqual(many.candidates.map((c) => c.name), ['A', 'B']);
  const chosen = decide({ ...server, socket: { ok: false }, hosts: two }, 'B');
  assert.equal(chosen.status, 'created'); assert.equal(chosen.config.aside.remoteHost, 'B');
  // server, no Aside, tunnel up: C only
  const conly = decide({ ...server, asideBin: null, socket: { ok: true } });
  assert.equal(conly.status, 'created'); assert.equal(conly.config.aside.enabled, false); assert.equal(validate(conly.config).ok, true);
  // server, nothing usable: write nothing, say what a person must do
  const none = decide({ ...server, asideBin: null, socket: { ok: false, why: 'socket file absent' } });
  assert.equal(none.status, 'not-ready'); assert.ok(none.todo.some((t) => /aside login/.test(t)));
  const noLogin = decide({ ...server, socket: { ok: false }, hosts: { ok: false, why: 'Not logged in' } });
  assert.equal(noLogin.status, 'not-ready'); assert.ok(noLogin.todo.some((t) => /aside login/.test(t)));
  // site rules are never guessed
  assert.deepEqual(one.config.sites, []);
});

test('setup: writes only when there is no config, and never overwrites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-setup-'));
  const file = join(dir, 'data', 'config.json');
  const deps = {
    findAside: () => '/x/aside', findLocalPorts: async () => ({ cdp: 9333, daemon: null }),
    probeLocalCdp: async (port) => ({ ok: port === 9333, browser: 'Chrome/153' }), probeDaemon: async () => ({ ok: false }),
    socket: () => ({ ok: false }), hostList: async () => { throw new Error('must not be called on a PC'); }, isWindows: () => true,
  };
  const saved = process.env.BROWSER_CHECK_CONFIG;
  process.env.BROWSER_CHECK_CONFIG = file;
  try {
    const r = await setup({ configFile: file }, deps);
    assert.equal(r.status, 'created'); assert.ok(existsSync(file)); assert.equal(r.valid, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).cdp.local.endpoint, loopback(9333));
    writeFileSync(file, '{"schemaVersion":1,"mode":"local"}');
    const again = await setup({ configFile: file }, deps);
    assert.equal(again.status, 'exists');
    assert.equal(readFileSync(file, 'utf8'), '{"schemaVersion":1,"mode":"local"}', 'existing config untouched');
    const other = join(dir, 'other', 'config.json');
    const nothing = await setup({ configFile: other }, { ...deps, findLocalPorts: async () => ({ cdp: null, daemon: null }), findAside: () => null });
    assert.equal(nothing.status, 'not-ready'); assert.ok(!existsSync(other), 'not-ready writes nothing');
  } finally {
    if (saved === undefined) delete process.env.BROWSER_CHECK_CONFIG; else process.env.BROWSER_CHECK_CONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
