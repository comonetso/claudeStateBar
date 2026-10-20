/*
 * PC side: install / check / remove the ego relay (scripts/ego/relay.mjs) that lets servers drive ego lite.
 * Files go to a fixed per-user folder (%LOCALAPPDATA%\browser-check\relay — the same for every Claude config dir on
 * this PC, so servers have one path to call) and a Task Scheduler entry starts it in the user's own logon session,
 * not elevated: at logon and every minute (a second copy exits at once if one answers), no time limit, on battery too.
 * That is the same shape as the earlier PC → server tunnel task (conhost --headless keeps it windowless; a killed
 * process is brought back by the minute trigger, not by "restart on failure", which conhost's exit 0 defeats).
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const TASK_NAME = 'browser-check ego relay';
export const RELAY_FILES = ['relay.mjs', 'entry.cmd', 'window.ps1'];
export const relayDir = (env = process.env) => join(env.LOCALAPPDATA || join(env.USERPROFILE || '', 'AppData', 'Local'), 'browser-check', 'relay');

// PowerShell gets its script as -EncodedCommand (Windows PowerShell drops double quotes from -Command) and answers
// in UTF-8 (otherwise in the console code page).
async function ps(script, timeout = 30000) {
  const enc = Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' + script, 'utf16le').toString('base64');
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split(/\r?\n/).pop() || 'null');
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export function localHealth(dir = relayDir(), timeoutMs = 3000) {
  return new Promise((res) => {
    try {
      const port = Number(readFileSync(join(dir, 'port'), 'utf8').trim());
      const token = readFileSync(join(dir, 'token'), 'utf8').trim();
      const r = http.get({ host: '127.0.0.1', port, path: '/health', headers: { 'x-bc-token': token }, timeout: timeoutMs }, (resp) => {
        let b = ''; resp.on('data', (d) => { b += d; }); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res({ ok: false, why: 'bad answer' }); } });
      });
      r.on('error', (e) => res({ ok: false, why: e.code || e.message })); r.on('timeout', () => { r.destroy(); res({ ok: false, why: 'timeout' }); });
    } catch (e) { res({ ok: false, why: 'not installed or not started (' + (e.code || e.message) + ')' }); }
  });
}

async function taskState() {
  try { return await ps(`$t = Get-ScheduledTask -TaskName ${q(TASK_NAME)} -ErrorAction SilentlyContinue; if ($t) { @{ exists = $true; state = [string]$t.State } | ConvertTo-Json -Compress } else { @{ exists = $false } | ConvertTo-Json -Compress }`); }
  catch (e) { return { exists: null, why: String(e.message).slice(0, 160) }; }
}

export async function status() {
  if (process.platform !== 'win32') return { supported: false, why: 'the relay runs on the Windows PC only' };
  const dir = relayDir();
  return { supported: true, dir, files: RELAY_FILES.filter((f) => existsSync(join(dir, f))), task: await taskState(), health: await localHealth(dir) };
}

export async function install({ node = process.execPath } = {}) {
  if (process.platform !== 'win32') return { supported: false, why: 'the relay runs on the Windows PC only' };
  const dir = relayDir();
  mkdirSync(dir, { recursive: true });
  for (const f of RELAY_FILES) copyFileSync(join(HERE, '..', 'ego', f), join(dir, f));
  const relay = join(dir, 'relay.mjs');
  // Replace a running copy so the new files are used: stop the task and the process it started.
  const old = await localHealth(dir, 1500);
  await ps([
    `Unregister-ScheduledTask -TaskName ${q(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`,
    old && old.ok && old.pid ? `Stop-Process -Id ${Number(old.pid)} -Force -ErrorAction SilentlyContinue` : '$null',
    `$me = "$env:USERDOMAIN\\$env:USERNAME"`,
    `$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\conhost.exe" -Argument ('--headless "' + ${q(node)} + '" "' + ${q(relay)} + '"')`,
    `$t1 = New-ScheduledTaskTrigger -AtLogOn -User $me`,
    `$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)`,
    `$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `$p = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName ${q(TASK_NAME)} -Action $a -Trigger $t1,$t2 -Settings $s -Principal $p | Out-Null`,
    `Start-ScheduledTask -TaskName ${q(TASK_NAME)}`,
    `@{ ok = $true } | ConvertTo-Json -Compress`,
  ].join('; '));
  let health = { ok: false };
  for (let i = 0; i < 30 && !health.ok; i++) { await new Promise((r) => setTimeout(r, 500)); health = await localHealth(dir, 1500); }
  return { supported: true, dir, node, task: await taskState(), health };
}

export async function uninstall() {
  if (process.platform !== 'win32') return { supported: false, why: 'the relay runs on the Windows PC only' };
  const dir = relayDir();
  const h = await localHealth(dir, 1500);
  await ps([
    `Unregister-ScheduledTask -TaskName ${q(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`,
    h && h.ok && h.pid ? `Stop-Process -Id ${Number(h.pid)} -Force -ErrorAction SilentlyContinue` : '$null',
    `@{ ok = $true } | ConvertTo-Json -Compress`,
  ].join('; '));
  // Remove only the files this installer put there, plus the relay's own token/port/log.
  for (const f of [...RELAY_FILES, 'token', 'port', 'relay.log']) { try { rmSync(join(dir, f), { force: true }); } catch { /* in use */ } }
  try { rmdirSync(dir); } catch { /* not empty — left for the owner to look at */ }
  return { supported: true, dir, removed: true, task: await taskState() };
}
