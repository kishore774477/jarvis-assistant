<#
  Bring JARVIS's own Brave window (the one started with the JARVIS profile)
  to the front. Windows does not let a background program hand focus to a
  window, so this joins the input of the window currently in front first —
  the same approach as claude-new-chat.ps1. The user's everyday Brave windows
  are left alone: only the Brave whose command line names the JARVIS profile
  is touched.
#>
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JarvisFront {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
try {
  $main = Get-CimInstance Win32_Process -Filter "Name='brave.exe'" |
    Where-Object { $_.CommandLine -like '*JARVIS\Brave Profile*' -and $_.CommandLine -notlike '*--type=*' } |
    Select-Object -First 1
  if (-not $main) { throw 'JARVIS Brave is not running.' }
  $p = Get-Process -Id $main.ProcessId
  $h = $p.MainWindowHandle
  if ($h -eq 0) { throw 'JARVIS Brave has no window.' }
  if ([JarvisFront]::IsIconic($h)) { [JarvisFront]::ShowWindow($h, 9) | Out-Null }   # SW_RESTORE
  $fgPid = 0
  $fgThread = [JarvisFront]::GetWindowThreadProcessId([JarvisFront]::GetForegroundWindow(), [ref]$fgPid)
  $me = [JarvisFront]::GetCurrentThreadId()
  [JarvisFront]::AttachThreadInput($me, $fgThread, $true) | Out-Null
  try {
    [JarvisFront]::BringWindowToTop($h) | Out-Null
    [JarvisFront]::SetForegroundWindow($h) | Out-Null
  } finally {
    [JarvisFront]::AttachThreadInput($me, $fgThread, $false) | Out-Null
  }
  [PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
