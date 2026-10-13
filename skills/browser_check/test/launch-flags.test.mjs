// node --test test/launch-flags.test.mjs — Aside launch flags for transport C: what is missing, and how a shortcut's arguments are extended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { missingFlags, addFlags, warningFor, setShortcutArgs, OCCLUSION_FLAG, OCCLUSION_FEATURE, SCREENSHOT_FEATURE } from '../scripts/lib/launch-flags.mjs';

const DISABLE = '--disable-features=' + OCCLUSION_FEATURE;
const ENABLE = '--enable-features=' + SCREENSHOT_FEATURE;
const ALL = OCCLUSION_FLAG + ' ' + DISABLE + ' ' + ENABLE;
const BASE = '--user-data-dir="C:\\Users\\me\\AppData\\Local\\Aside\\User Data"';

test('all three flags missing → all reported, and added after the existing arguments', () => {
  assert.deepEqual(missingFlags(BASE), [OCCLUSION_FLAG, DISABLE, ENABLE]);
  const out = addFlags(BASE);
  assert.equal(out, BASE + ' ' + ALL);
  assert.deepEqual(missingFlags(out), []);
});

test('nothing missing → arguments unchanged', () => {
  const s = BASE + ' ' + ALL;
  assert.deepEqual(missingFlags(s), []);
  assert.equal(addFlags(s), s);
});

test('existing feature lists are extended, not duplicated (Chromium keeps only the last copy of a switch)', () => {
  const s = BASE + ' ' + OCCLUSION_FLAG + ' --disable-features=Foo,Bar --enable-features=Baz';
  assert.deepEqual(missingFlags(s), [DISABLE, ENABLE]);
  const out = addFlags(s);
  assert.equal((out.match(/--disable-features/g) || []).length, 1);
  assert.equal((out.match(/--enable-features/g) || []).length, 1);
  assert.match(out, /--disable-features=Foo,Bar,CalculateNativeWinOcclusion/);
  assert.match(out, /--enable-features=Baz,CDPScreenshotNewSurface/);
  assert.deepEqual(missingFlags(out), []);
});

test('only the last copy of a feature switch counts', () => {
  const ok = BASE + ' ' + OCCLUSION_FLAG + ' --disable-features=Foo ' + DISABLE + ' ' + ENABLE;
  assert.deepEqual(missingFlags(ok), []);
  const lost = BASE + ' ' + OCCLUSION_FLAG + ' ' + DISABLE + ' --disable-features=Foo ' + ENABLE;
  assert.deepEqual(missingFlags(lost), [DISABLE]);
  const out = addFlags(lost);
  assert.equal((out.match(/--disable-features/g) || []).length, 1);
  assert.match(out, /--disable-features=CalculateNativeWinOcclusion,Foo/);
});

test('quoted lists and a real main-process command line are read', () => {
  assert.deepEqual(missingFlags(BASE + ' ' + OCCLUSION_FLAG + ' --disable-features="A,' + OCCLUSION_FEATURE + '" --enable-features="' + SCREENSHOT_FEATURE + ',B"'), []);
  const line = '"C:\\Program Files\\Aside\\Application\\Aside.exe" ' + BASE + ' ' + ALL + ' --restore-last-session';
  assert.deepEqual(missingFlags(line), []);
});

test('a longer switch that only starts with the flag name does not count', () => {
  assert.deepEqual(missingFlags(BASE + ' ' + OCCLUSION_FLAG + '-foo ' + DISABLE + ' ' + ENABLE), [OCCLUSION_FLAG]);
});

test('warning only when Aside runs without the flags', () => {
  assert.equal(warningFor({ supported: false }), null);
  assert.equal(warningFor({ supported: true, running: false, missing: null }), null);
  assert.equal(warningFor({ supported: true, running: true, missing: [] }), null);
  const w = warningFor({ supported: true, running: true, missing: [ENABLE] });
  assert.match(w, /minimized/);
  assert.match(w, /launch-flags --apply/);
});

test('a real .lnk takes the extended arguments (quoted path, non-ASCII) and reads them back', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-lnk-'));
  try {
    const lnk = join(dir, '시험 Aside.lnk');
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(lnk) + '); $s.TargetPath = $env:ComSpec; $s.Save()'], { windowsHide: true });
    const next = addFlags(BASE + ' --x="한글 값"');
    assert.equal(await setShortcutArgs(lnk, next), next);
    assert.deepEqual(missingFlags(next), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
