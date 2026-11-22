<#
  The windows open on screen, and closing them — what JARVIS uses for "close
  that", "close the Downloads folder", "close the YouTube tab".

    -Action list                 every normal window: app, title
    -Action close    -Match x    politely close windows whose title or app
                                 contains x (the same as clicking the X, so an
                                 app with unsaved work still asks)
    -Action closetab -Match x    in a browser window whose current tab title
                                 contains x, close just that tab (Ctrl+W)

  Never touches the taskbar or desktop, the JARVIS screen, JARVIS's own black
  window, or the Claude app. Prints JSON.
#>
param(
  [ValidateSet('list', 'close', 'closetab')][string]$Action = 'list',
  [string]$Match = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class JWin { public IntPtr Handle; public string Title; public string Class; public uint Pid; }
public static class JWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static uint ThreadOf(IntPtr h) { uint p; return GetWindowThreadProcessId(h, out p); }

  public static List<JWin> List() {
    var list = new List<JWin>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;                 // owned popups and dialogs
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;            // tool windows
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;                                    // hidden store apps
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.Length == 0) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new JWin { Handle = h, Title = t.ToString(), Class = c.ToString(), Pid = pid });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$procNames = @{}
function Get-AppName([uint32]$procId) {
  if (-not $procNames.ContainsKey($procId)) {
    $procNames[$procId] = try { (Get-Process -Id $procId).ProcessName } catch { '' }
  }
  $procNames[$procId]
}

function Test-Protected($w, [string]$app) {
  if ($w.Class -in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW')) { return $true }
  if ($w.Title -like 'J.A.R.V.I.S*') { return $true }                       # the JARVIS screen and black window
  if ($w.Class -eq 'ConsoleWindowClass' -and $w.Title -match 'npm|jarvis') { return $true }
  if ($app -in @('claude', 'ApplicationFrameHost', 'TextInputHost', 'SearchHost', 'StartMenuExperienceHost')) { return $true }
  return $false
}

function Get-Windows {
  [JWindows]::List() | ForEach-Object {
    $app = Get-AppName $_.Pid
    [PSCustomObject]@{ Handle = $_.Handle; Title = $_.Title; Class = $_.Class; App = $app; Protected = (Test-Protected $_ $app) }
  }
}

function Find-Windows([string]$m) {
  $want = $m.Trim()
  $all = @(Get-Windows)
  # A folder window's title is the folder name: "close downloads" should not also close a
  # browser whose tab happens to say "downloads", so exact names win over partial matches.
  $exact = @($all | Where-Object { $_.Title -ieq $want -or $_.App -ieq $want -or $_.App -ieq ($want -replace '\s', '') })
  if ($exact.Count) { return $exact }
  @($all | Where-Object { $_.Title -like "*$want*" -or $_.App -like "*$($want -replace '\s', '')*" })
}

$browsers = @('brave', 'chrome', 'msedge', 'firefox', 'opera')
try {
  switch ($Action) {
    'list' {
      $out = Get-Windows | Where-Object { -not $_.Protected } | ForEach-Object { [PSCustomObject]@{ app = $_.App; title = $_.Title } }
      [PSCustomObject]@{ ok = $true; windows = @($out) } | ConvertTo-Json -Compress -Depth 3
    }
    'close' {
      if (-not $Match.Trim()) { throw 'Say which window to close.' }
      $hits = @(Find-Windows $Match)
      $safe = @($hits | Where-Object { -not $_.Protected } | Select-Object -First 10)
      if (-not $safe.Count) {
        if ($hits.Count) { throw "That window belongs to JARVIS or Windows itself, so it stays open." }
        throw "No open window matches `"$Match`"."
      }
      foreach ($w in $safe) { [JWindows]::PostMessage($w.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }  # WM_CLOSE
      [PSCustomObject]@{ ok = $true; closed = @($safe | ForEach-Object { "$($_.App): $($_.Title)" }) } | ConvertTo-Json -Compress -Depth 3
    }
    'closetab' {
      if (-not $Match.Trim()) { throw 'Say which tab to close.' }
      $hits = @(Find-Windows $Match | Where-Object { -not $_.Protected -and $browsers -contains $_.App.ToLower() -and $_.Title -like "*$Match*" })
      if (-not $hits.Count) { throw "No browser window is showing a tab that matches `"$Match`". A tab that is not the one on screen in its window can only be closed from JARVIS's own Brave." }
      Add-Type -AssemblyName System.Windows.Forms
      $closed = @()
      foreach ($w in $hits | Select-Object -First 5) {
        $h = $w.Handle
        if ([JWindows]::IsIconic($h)) { [JWindows]::ShowWindow($h, 9) | Out-Null }
        $fg = [JWindows]::ThreadOf([JWindows]::GetForegroundWindow())
        $me = [JWindows]::GetCurrentThreadId()
        [JWindows]::AttachThreadInput($me, $fg, $true) | Out-Null
        try { [JWindows]::BringWindowToTop($h) | Out-Null; [JWindows]::SetForegroundWindow($h) | Out-Null }
        finally { [JWindows]::AttachThreadInput($me, $fg, $false) | Out-Null }
        Start-Sleep -Milliseconds 300
        # Only press Ctrl+W if that exact window really is in front, so it can never land elsewhere.
        if ([JWindows]::GetForegroundWindow() -eq $h) {
          [System.Windows.Forms.SendKeys]::SendWait('^w')
          $closed += "$($w.App): $($w.Title)"
          Start-Sleep -Milliseconds 300
        }
      }
      if (-not $closed.Count) { throw 'The browser window could not be brought to the front, so no tab was closed.' }
      [PSCustomObject]@{ ok = $true; closed = $closed } | ConvertTo-Json -Compress -Depth 3
    }
  }
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
