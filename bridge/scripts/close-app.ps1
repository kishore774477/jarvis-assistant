<#
  Close an app politely — the same as clicking its X — so it can still ask
  "save changes?". Never kills a process outright, and never touches Windows
  itself, JARVIS's own processes, or the browser the JARVIS screen runs in.
  Prints what was closed as JSON.
#>
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = 'Stop'

$aliases = @{
  'epic' = 'EpicGamesLauncher'; 'epic games' = 'EpicGamesLauncher'; 'epic games launcher' = 'EpicGamesLauncher'
  'vs code' = 'Code'; 'vscode' = 'Code'; 'visual studio code' = 'Code'
  'word' = 'WINWORD'; 'excel' = 'EXCEL'; 'powerpoint' = 'POWERPNT'
  'telegram' = 'Telegram'; 'whatsapp' = 'WhatsApp'; 'spotify' = 'Spotify'
  'steam' = 'steam'; 'discord' = 'Discord'; 'brave' = 'brave'; 'vlc' = 'vlc'
  'antigravity' = 'Antigravity'; 'omen' = 'OmenCommandCenterBackground'; 'zoom' = 'Zoom'
}
# Closing any of these would take Windows, or JARVIS itself, down with it.
$protected = 'explorer','chrome','msedge','node','powershell','pwsh','cmd','conhost','windowsterminal','claude','dwm','csrss','winlogon','lsass','services','svchost','system','idle'

$want = $Name.Trim().ToLower()
$proc = if ($aliases.ContainsKey($want)) { $aliases[$want] } else { $want -replace '\s', '' }
try {
  $hits = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and (
      $_.ProcessName -ieq $proc -or $_.ProcessName -like "*$proc*" -or $_.MainWindowTitle -like "*$Name*"
    )
  }
  $blocked = @($hits | Where-Object { $protected -contains $_.ProcessName.ToLower() })
  $hits = @($hits | Where-Object { $protected -notcontains $_.ProcessName.ToLower() })
  if (-not $hits.Count) {
    if ($blocked.Count) { throw "$Name can't be closed by JARVIS - it would close JARVIS or Windows too." }
    throw "$Name is not open."
  }
  $closed = @()
  foreach ($p in $hits) {
    if ($p.CloseMainWindow()) { $closed += $p.ProcessName }
  }
  [PSCustomObject]@{ ok = $true; closed = ($closed | Select-Object -Unique) } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
