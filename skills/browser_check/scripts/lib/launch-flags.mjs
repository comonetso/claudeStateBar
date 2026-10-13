/*
 * Aside launch flags for transport C on Windows (owner decision 2026-10-14 — "a plugin feature, not a hand-edited
 * shortcut"). Measured 2026-10-14 on Windows with a colour change before every capture:
 *   - every Aside window covered → captures time out; --disable-backgrounding-occluded-windows and
 *     --disable-features=CalculateNativeWinOcclusion turn the occlusion tracking off and captures keep working
 *   - the window minimized → captures and input time out with or without those two; --enable-features=
 *     CDPScreenshotNewSurface (Chromium's screenshot path that copies a fresh surface instead of waiting for the next
 *     presented frame) made captures and real clicks/keys go through while minimized (isolated test browser)
 *
 *   check()            the running Aside's main process: are the flags on? + the Aside shortcuts and their flags (read-only)
 *   fix({ dataDir })   add the missing flags to every Aside shortcut, saving the old arguments first; Aside itself is
 *                      not restarted — the flags apply from the next full start of Aside
 *   undo({ dataDir })  put the shortcuts back from the last saved arguments
 *
 * Shortcuts are the only place a user-started Aside gets its flags from, so that is what is edited — never the
 * Aside install or its profile. Windows only; elsewhere every call reports { supported: false }.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const execFileP = promisify(execFile);

export const OCCLUSION_FLAG = '--disable-backgrounding-occluded-windows';
export const OCCLUSION_FEATURE = 'CalculateNativeWinOcclusion';
export const SCREENSHOT_FEATURE = 'CDPScreenshotNewSurface';
// feature-list switches and the feature each must carry (Chromium keeps only the last copy of a switch it sees)
const FEATURE_NEEDS = [['--disable-features', OCCLUSION_FEATURE], ['--enable-features', SCREENSHOT_FEATURE]];

const switchRe = (sw) => new RegExp(sw + '(?:=|\\s+)("([^"]*)"|(\\S+))', 'g');
const valuesOf = (m) => String(m[2] !== undefined ? m[2] : m[3]).split(',').map((x) => x.trim()).filter(Boolean);

/** Values of every copy of a feature-list switch. */
function featureValues(line, sw) {
  const out = [];
  const re = switchRe(sw);
  let m;
  while ((m = re.exec(line))) out.push(...valuesOf(m));
  return out;
}

/** Values of the last copy only — the one Chromium uses. */
function lastFeatureValues(line, sw) {
  const re = switchRe(sw);
  let m, last = null;
  while ((m = re.exec(line))) last = valuesOf(m);
  return last;
}

/** Which of the three flags a command line (or shortcut arguments) lacks. Pure. */
export function missingFlags(line) {
  const s = String(line || '');
  const missing = [];
  if (!new RegExp('(^|\\s)' + OCCLUSION_FLAG + '(\\s|$|=)').test(s)) missing.push(OCCLUSION_FLAG);
  for (const [sw, feature] of FEATURE_NEEDS) {
    const last = lastFeatureValues(s, sw);
    if (!last || !last.includes(feature)) missing.push(sw + '=' + feature);
  }
  return missing;
}

/**
 * Shortcut arguments with the missing flags added. An existing feature list is extended in place (a second copy
 * of the switch would replace the first). Pure; returns the same string when nothing is missing.
 */
export function addFlags(args) {
  let s = String(args || '').trim();
  const missing = missingFlags(s);
  if (!missing.length) return s;
  if (missing.includes(OCCLUSION_FLAG)) s = (s ? s + ' ' : '') + OCCLUSION_FLAG;
  for (const [sw, feature] of FEATURE_NEEDS) {
    if (!missing.includes(sw + '=' + feature)) continue;
    const all = featureValues(s, sw);
    if (all.length) {
      // fold every copy of the switch into one list that also carries ours
      s = s.replace(new RegExp('\\s*' + sw + '(?:=|\\s+)("[^"]*"|\\S+)', 'g'), '').trim();
      s = (s ? s + ' ' : '') + sw + '=' + [...new Set([...all, feature])].join(',');
    } else {
      s = (s ? s + ' ' : '') + sw + '=' + feature;
    }
  }
  return s;
}

// The script goes in as -EncodedCommand (Windows PowerShell drops double quotes from a -Command argument) and the
// output is forced to UTF-8 (otherwise it comes back in the console code page and non-ASCII paths/values break).
async function ps(script, timeout = 20000) {
  const enc = Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + script, 'utf16le').toString('base64');
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim() || 'null');
}

// Aside shortcuts in the usual places: pinned to the taskbar, the Start menu (user and all users), the desktops.
const FIND_SHORTCUTS = [
  "$dirs = @(\"$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\", \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\", \"$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\", [Environment]::GetFolderPath('Desktop'), \"$env:PUBLIC\\Desktop\") | Where-Object { $_ -and (Test-Path $_) }",
  '$sh = New-Object -ComObject WScript.Shell',
  "$out = @(foreach ($d in $dirs) { Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $s = $sh.CreateShortcut($_.FullName); if ($s.TargetPath -match '\\\\Aside\\\\Application\\\\Aside\\.exe$') { [pscustomobject]@{ path = $_.FullName; target = $s.TargetPath; args = [string]$s.Arguments } } } })",
  'ConvertTo-Json -Compress -InputObject @($out)',
].join('; ');

const MAIN_COMMAND_LINE = "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='Aside.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { [string]$_.CommandLine })";

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export async function check() {
  if (process.platform !== 'win32') return { supported: false };
  const [lines, shortcuts] = await Promise.all([ps(MAIN_COMMAND_LINE).catch(() => []), ps(FIND_SHORTCUTS).catch(() => [])]);
  const main = (Array.isArray(lines) ? lines : [lines]).filter(Boolean)[0] || null;
  const list = (Array.isArray(shortcuts) ? shortcuts : [shortcuts]).filter(Boolean).map((s) => ({ path: s.path, args: s.args, missing: missingFlags(s.args) }));
  return {
    supported: true,
    running: !!main,
    missing: main ? missingFlags(main) : null, // flags the running Aside lacks (null = Aside not running)
    shortcuts: list,
  };
}

/** Write a shortcut's arguments and read them back; throws when the shortcut can't be saved or reads back different. */
export async function setShortcutArgs(path, args) {
  const got = await ps('$sh = New-Object -ComObject WScript.Shell; $s = $sh.CreateShortcut(' + psQuote(path) + '); $s.Arguments = ' + psQuote(args) + '; $s.Save(); ConvertTo-Json -Compress -InputObject ([string]$sh.CreateShortcut(' + psQuote(path) + ').Arguments)');
  // Save() reports no error on a shortcut the user may not write — it just stays as it was (measured 2026-10-14:
  // Aside's installer leaves the user only Delete rights on its Start-menu shortcuts and recreates them on update)
  if (got !== args) throw new Error('the shortcut did not take the change — it is write-protected for this user (Aside creates its Start-menu shortcuts that way and recreates them on update; a shortcut the user pinned or made is writable)');
  return got;
}

const backupFile = (dataDir) => join(dataDir, 'backups', 'aside-shortcuts.json');

export async function fix({ dataDir }) {
  const c = await check();
  if (!c.supported) return c;
  const todo = c.shortcuts.filter((s) => s.missing.length);
  if (!todo.length) return { ...c, changed: [], note: c.shortcuts.length ? 'every Aside shortcut already has the flags' : 'no Aside shortcut found' };
  if (!dataDir) throw new Error('no data dir for the backup');
  mkdirSync(join(dataDir, 'backups'), { recursive: true });
  // keep the oldest saved arguments per shortcut so undo returns to the state before the plugin first touched it
  const prev = existsSync(backupFile(dataDir)) ? JSON.parse(readFileSync(backupFile(dataDir), 'utf8')) : { shortcuts: {} };
  for (const s of todo) if (!(s.path in prev.shortcuts)) prev.shortcuts[s.path] = s.args;
  prev.saved_at = new Date().toISOString();
  writeFileSync(backupFile(dataDir), JSON.stringify(prev, null, 1));
  const changed = [];
  const failed = [];
  for (const s of todo) {
    const next = addFlags(s.args);
    try {
      await setShortcutArgs(s.path, next);
      changed.push({ path: s.path, before: s.args, after: next });
    } catch (e) {
      failed.push({ path: s.path, why: String((e && (e.stderr || e.message)) || e).split('\n')[0].slice(0, 300) });
    }
  }
  // a shortcut that never changed has nothing to undo — keep only what this call (or an earlier one) really changed
  if (failed.length) {
    for (const f of failed) if (prev.shortcuts[f.path] === (todo.find((s) => s.path === f.path) || {}).args) delete prev.shortcuts[f.path];
    writeFileSync(backupFile(dataDir), JSON.stringify(prev, null, 1));
  }
  return { ...(await check()), changed, failed, backup: backupFile(dataDir), restart: 'the flags apply when Aside is fully closed and started again from a shortcut' };
}

export async function undo({ dataDir }) {
  if (process.platform !== 'win32') return { supported: false };
  if (!dataDir || !existsSync(backupFile(dataDir))) return { supported: true, restored: [], note: 'no saved shortcut arguments' };
  const saved = JSON.parse(readFileSync(backupFile(dataDir), 'utf8')).shortcuts || {};
  const restored = [];
  const failed = [];
  for (const [path, args] of Object.entries(saved)) {
    if (!existsSync(path)) { failed.push({ path, why: 'shortcut no longer exists' }); continue; }
    try {
      await setShortcutArgs(path, args);
      restored.push({ path, args });
    } catch (e) {
      failed.push({ path, why: String((e && (e.stderr || e.message)) || e).split('\n')[0].slice(0, 200) });
    }
  }
  return { supported: true, restored, failed, restart: 'takes effect when Aside is fully closed and started again' };
}

/** One warning line for doctor/setup, or null. */
export function warningFor(c) {
  if (!c || !c.supported || !c.running || !c.missing || !c.missing.length) return null;
  return 'Aside runs without ' + c.missing.join(' ') + ' — transport C stops capturing while every Aside window is covered or the window is minimized. `browser-check.mjs launch-flags --apply` adds them to the Aside shortcuts (ask the user first).';
}
