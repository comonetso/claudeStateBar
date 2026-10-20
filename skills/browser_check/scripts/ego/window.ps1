# browser_check ego window helper (PC, Windows PowerShell 5.1 - keep this file ASCII).
#   window.ps1 list            -> one JSON line: ego windows (visible / minimized / title length)
#   window.ps1 ensure [<exe>]  -> if no ego window is visible (all closed with X, or ego not running), start ego.exe
#                                 again and minimize every window it shows, at once and without activating it.
# Why (measured 2026-10-21): X does not close an ego window, ego hides it and stops painting it; a task space opened
# while every window is hidden goes into a new hidden window that never paints, so capture gets nothing. Running
# ego.exe again shows the hidden window (a "-WindowStyle Minimized" start is ignored); minimizing it right away keeps
# it off the screen (about 65-185 ms visible) and a minimized ego window keeps painting for screencast.
param([string]$Action = 'list', [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class BcEgoWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<IntPtr> Windows(HashSet<uint> pids) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p)) { var c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "Chrome_WidgetWin_1" && GetWindowTextLength(h) > 0) list.Add(h); }
      return true; }, IntPtr.Zero);
    return list;
  }
}
"@
function EgoPids { $s = New-Object 'System.Collections.Generic.HashSet[uint32]'; Get-Process ego -ErrorAction SilentlyContinue | ForEach-Object { [void]$s.Add([uint32]$_.Id) }; return ,$s }
function State {
  $pids = EgoPids
  $wins = [BcEgoWin]::Windows($pids)
  $vis = @($wins | Where-Object { [BcEgoWin]::IsWindowVisible($_) })
  return @{ running = ($pids.Count -gt 0); windows = $wins.Count; visible = $vis.Count; minimized = @($vis | Where-Object { [BcEgoWin]::IsIconic($_) }).Count }
}
function DefaultExe {
  $base = Join-Path $env:ProgramFiles 'Citro Labs\ego lite\Application\ego.exe'
  if (Test-Path $base) { return $base }
  return $null
}

if ($Action -eq 'list') { (State) | ConvertTo-Json -Compress; exit 0 }

if ($Action -eq 'ensure') {
  $before = State
  if ($before.visible -gt 0) { @{ ok = $true; action = 'none'; before = $before } | ConvertTo-Json -Compress; exit 0 }
  if (-not $Exe) { $Exe = DefaultExe }
  if (-not $Exe -or -not (Test-Path $Exe)) { @{ ok = $false; why = 'ego.exe not found'; before = $before } | ConvertTo-Json -Compress; exit 0 }
  # A cold start restores the last session and can show a second window a moment after the first; a reopen of a
  # running ego shows only the hidden one. Keep watching 3 s after the first window on a cold start, 1 s otherwise.
  $watchMs = $(if ($before.running) { 1000 } else { 3000 })
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Process -FilePath $Exe
  $seen = @{}; $firstAt = -1
  while ($sw.ElapsedMilliseconds -lt 10000) {
    foreach ($h in [BcEgoWin]::Windows((EgoPids))) {
      if ([BcEgoWin]::IsWindowVisible($h) -and -not [BcEgoWin]::IsIconic($h)) {
        $t = [int]$sw.ElapsedMilliseconds
        # WM_SYSCOMMAND SC_MINIMIZE = what the window's own minimize button sends, so ego minimizes itself and keeps
        # its restore position. ShowWindow(SW_SHOWMINNOACTIVE) from outside left a window that, restored from the
        # taskbar later, stayed at the minimized off-screen position and never came up (2026-10-21).
        $k = [string]$h
        # posted, not sent: send once, and again only if it is still up 500 ms later
        if (-not $seen.ContainsKey($k) -or ($t - $seen[$k]) -gt 500) { [void][BcEgoWin]::PostMessage($h, 0x0112, [IntPtr]0xF020, [IntPtr]::Zero); $seen[$k] = $t }
        if ($firstAt -lt 0) { $firstAt = $t }
      }
    }
    if ($firstAt -ge 0 -and $sw.ElapsedMilliseconds - $firstAt -gt $watchMs) { break }
    Start-Sleep -Milliseconds 20
  }
  $after = State
  @{ ok = ($after.visible -gt 0); action = $(if ($before.running) { 'reopened' } else { 'started' }); firstVisibleMs = $firstAt; minimizedWindows = $seen.Count; before = $before; after = $after } | ConvertTo-Json -Compress
  exit 0
}
@{ ok = $false; why = "unknown action $Action" } | ConvertTo-Json -Compress
