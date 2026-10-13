// node --test test/launch-flags.test.mjs — Aside occlusion flags: what is missing, and how a shortcut's arguments are extended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { missingFlags, addFlags, warningFor, setShortcutArgs, OCCLUSION_FLAG, OCCLUSION_FEATURE } from '../scripts/lib/launch-flags.mjs';

const FEATURE = '--disable-features=' + OCCLUSION_FEATURE;
const BASE = '--user-data-dir="C:\\Users\\me\\AppData\\Local\\Aside\\User Data"';

test('both flags missing → both reported, and added after the existing arguments', () => {
  assert.deepEqual(missingFlags(BASE), [OCCLUSION_FLAG, FEATURE]);
  const out = addFlags(BASE);
  assert.ok(out.startsWith(BASE));
  assert.deepEqual(missingFlags(out), []);
  assert.equal(out, BASE + ' ' + OCCLUSION_FLAG + ' ' + FEATURE);
});

test('nothing missing → arguments unchanged', () => {
  const s = BASE + ' ' + OCCLUSION_FLAG + ' ' + FEATURE;
  assert.deepEqual(missingFlags(s), []);
  assert.equal(addFlags(s), s);
});

test('an existing --disable-features list is extended, not duplicated (Chromium keeps only the last switch)', () => {
  const s = BASE + ' ' + OCCLUSION_FLAG + ' --disable-features=Foo,Bar';
  assert.deepEqual(missingFlags(s), [FEATURE]);
  const out = addFlags(s);
  assert.equal((out.match(/--disable-features/g) || []).length, 1);
  assert.match(out, /--disable-features=Foo,Bar,CalculateNativeWinOcclusion$/);
  assert.deepEqual(missingFlags(out), []);
});

test('only the last --disable-features switch counts', () => {
  const ok = BASE + ' ' + OCCLUSION_FLAG + ' --disable-features=Foo ' + FEATURE;
  assert.deepEqual(missingFlags(ok), []);
  const lost = BASE + ' ' + OCCLUSION_FLAG + ' ' + FEATURE + ' --disable-features=Foo';
  assert.deepEqual(missingFlags(lost), [FEATURE]);
  const out = addFlags(lost);
  assert.equal((out.match(/--disable-features/g) || []).length, 1);
  assert.match(out, /--disable-features=CalculateNativeWinOcclusion,Foo$/);
});

test('a quoted feature list and a real main-process command line are read', () => {
  assert.deepEqual(missingFlags(BASE + ' ' + OCCLUSION_FLAG + ' --disable-features="A,' + OCCLUSION_FEATURE + '"'), []);
  const line = '"C:\\Program Files\\Aside\\Application\\Aside.exe" ' + BASE + ' ' + OCCLUSION_FLAG + ' ' + FEATURE + ' --restore-last-session';
  assert.deepEqual(missingFlags(line), []);
});

test('a longer switch that only starts with the flag name does not count', () => {
  assert.deepEqual(missingFlags(BASE + ' ' + OCCLUSION_FLAG + '-foo ' + FEATURE), [OCCLUSION_FLAG]);
});

test('warning only when Aside runs without the flags', () => {
  assert.equal(warningFor({ supported: false }), null);
  assert.equal(warningFor({ supported: true, running: false, missing: null }), null);
  assert.equal(warningFor({ supported: true, running: true, missing: [] }), null);
  assert.match(warningFor({ supported: true, running: true, missing: [OCCLUSION_FLAG] }), /launch-flags --apply/);
});

test('a real .lnk takes the extended arguments (quoted path, non-ASCII) and reads them back', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-lnk-'));
  try {
    const lnk = join(dir, '시험 Aside.lnk');
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(lnk) + '); $s.TargetPath = $env:ComSpec; $s.Arguments = ' + q(BASE) + '; $s.Save()'], { windowsHide: true });
    const next = addFlags(BASE + ' --x="한글 값"');
    assert.equal(await setShortcutArgs(lnk, next), next);
    assert.deepEqual(missingFlags(next), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
