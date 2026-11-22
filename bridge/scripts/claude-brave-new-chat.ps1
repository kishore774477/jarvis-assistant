<#
  Open claude.ai on a new chat in the Brave browser, type a request into it
  and send it, in front of the user: the Brave twin of claude-new-chat.ps1,
  which does the same in the Claude desktop app.

  The text is read from $TextFile (written by build.mjs), never passed on the
  command line, and reaches the message box through the clipboard, whose
  previous text is put back afterwards.

  Every keystroke is sent only after checking that the window in front is
  Brave AND its title names Claude (the tab title of claude.ai is
  "... - Claude"), so none can land in another app or another site. The check
  is case-sensitive: before the page has loaded the tab is titled with the
  lowercase address "claude.ai/new", so waiting for "Claude" also waits for
  the page to load.

  You must already be logged in to claude.ai in Brave.
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$Browser
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BraveFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@

function Get-FrontWindow {
  $h = [BraveFocus]::GetForegroundWindow()
  $fgPid = 0
  [BraveFocus]::GetWindowThreadProcessId($h, [ref]$fgPid) | Out-Null
  $sb = New-Object System.Text.StringBuilder 512
  [BraveFocus]::GetWindowText($h, $sb, 512) | Out-Null
  [PSCustomObject]@{
    Name  = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName
    Title = $sb.ToString()
  }
}

# Brave in front, showing a loaded claude.ai page that is not the login page.
function Test-ClaudeInFront {
  $w = Get-FrontWindow
  ($w.Name -eq 'brave') -and ($w.Title -cmatch 'Claude') -and ($w.Title -notmatch 'log ?in|sign ?in')
}

function Show-Window([IntPtr]$h) {
  if ([BraveFocus]::IsIconic($h)) { [BraveFocus]::ShowWindow($h, 9) | Out-Null }   # SW_RESTORE
  $fgPid = 0
  $fgThread = [BraveFocus]::GetWindowThreadProcessId([BraveFocus]::GetForegroundWindow(), [ref]$fgPid)
  $me = [BraveFocus]::GetCurrentThreadId()
  [BraveFocus]::AttachThreadInput($me, $fgThread, $true) | Out-Null
  try {
    [BraveFocus]::BringWindowToTop($h) | Out-Null
    [BraveFocus]::SetForegroundWindow($h) | Out-Null
  } finally {
    [BraveFocus]::AttachThreadInput($me, $fgThread, $false) | Out-Null
  }
}

# Wait (up to ~20 s) for the new claude.ai tab to load and be in front.
function Wait-ClaudeTab {
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-ClaudeInFront) { return }
    $front = Get-FrontWindow
    if ($front.Name -eq 'brave' -and $front.Title -match 'log ?in|sign ?in') {
      throw 'Claude in Brave is asking you to log in. Log in to claude.ai in Brave once, then ask again.'
    }
    # Brave opened the tab behind another app: bring its Claude window forward.
    $w = Get-Process -Name 'brave' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -cmatch 'Claude' } |
      Select-Object -First 1
    if ($w) { Show-Window $w.MainWindowHandle }
    Start-Sleep -Milliseconds 500
  }
  throw 'Claude did not open in Brave. Check that you are online and logged in to claude.ai in Brave.'
}

function Send-ToClaude([string]$keys) {
  if (-not (Test-ClaudeInFront)) { throw 'Claude in Brave was not the window in front, so nothing more was typed.' }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

$previous = $null
$touchedClipboard = $false
try {
  $text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
  if (-not $text -or -not $text.Trim()) { throw 'The request is empty.' }
  if (-not (Test-Path -LiteralPath $Browser)) { throw 'Brave is not installed.' }

  Start-Process -FilePath $Browser -ArgumentList 'https://claude.ai/new'
  # Let the new tab take over the window title before reading it, so an
  # already-open Claude tab is not mistaken for the new one.
  Start-Sleep -Milliseconds 1500
  Wait-ClaudeTab
  # The page title arrives before the message box is ready for typing.
  Start-Sleep -Milliseconds 2000

  # Clear any unsent draft, then type the request and send it.
  Send-ToClaude '^a'
  Send-ToClaude '{DEL}'
  try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
  $touchedClipboard = $true
  Set-Clipboard -Value $text
  Send-ToClaude '^v'
  Start-Sleep -Milliseconds 700
  Send-ToClaude '{ENTER}'
  Start-Sleep -Milliseconds 300

  [PSCustomObject]@{ ok = $true; sent = $true } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  if ($touchedClipboard) {
    if ($null -ne $previous) { Set-Clipboard -Value $previous } else { Set-Clipboard -Value $null }
  }
}
