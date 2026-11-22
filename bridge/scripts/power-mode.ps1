<#
  Switch the Windows power mode (Settings > System > Power > Power mode):
  best performance, balanced or best power efficiency. Uses the same power
  "overlay" Windows' own slider uses. Prints the mode now in effect as JSON.
#>
param([ValidateSet('performance', 'balanced', 'efficiency', 'get')][string]$Mode = 'get')
$ErrorActionPreference = 'Stop'
Add-Type -Namespace JarvisPower -Name Overlay -MemberDefinition @'
[DllImport("powrprof.dll")] public static extern uint PowerGetEffectiveOverlayScheme(out Guid g);
[DllImport("powrprof.dll")] public static extern uint PowerSetActiveOverlayScheme(Guid g);
'@
$ids = @{
  performance = [Guid]'ded574b5-45a0-4f42-8737-46345c09c238'
  balanced    = [Guid]'00000000-0000-0000-0000-000000000000'
  efficiency  = [Guid]'961cc777-2547-4f9d-8174-7d86181b8a7a'
}
try {
  if ($Mode -ne 'get') {
    $r = [JarvisPower.Overlay]::PowerSetActiveOverlayScheme($ids[$Mode])
    if ($r -ne 0) { throw "Windows refused the power mode change (code $r)." }
  }
  $g = [Guid]::Empty
  [JarvisPower.Overlay]::PowerGetEffectiveOverlayScheme([ref]$g) | Out-Null
  $now = ($ids.GetEnumerator() | Where-Object { $_.Value -eq $g } | Select-Object -First 1).Key
  if (-not $now) { $now = 'custom' }
  [PSCustomObject]@{ ok = $true; mode = $now } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
