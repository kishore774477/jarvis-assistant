<#
  Put a "JARVIS" icon on the desktop that starts JARVIS with one double-click.

  The black window starts minimised (it still has to stay open while JARVIS
  runs), and JARVIS opens in its own clean window. Run again any time; it just
  replaces the shortcut.

    powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
    powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1 -Startup   # also start with Windows
    powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1 -RemoveStartup
#>
param([switch]$Startup, [switch]$RemoveStartup)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'Start JARVIS.bat'
$ico = Join-Path $PSScriptRoot 'jarvis.ico'

# An arc-reactor icon, drawn once: cyan rings on near-black, saved as a
# PNG-in-ICO (supported by Windows since Vista).
if (-not (Test-Path $ico)) {
  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 6, 14, 20))), 4, 4, 248, 248)
  $glow = [System.Drawing.Color]::FromArgb(255, 80, 230, 240)
  foreach ($r in @(@(118, 14), @(84, 6), @(56, 10))) {
    $pen = New-Object System.Drawing.Pen $glow, $r[1]
    $d = $r[0] * 2
    $g.DrawEllipse($pen, 128 - $r[0], 128 - $r[0], $d, $d)
  }
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 255, 255))), 104, 104, 48, 48)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $fs = [System.IO.File]::Create($ico)
  $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)          # ICONDIR
  $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0) # 256x256, no palette
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
  $w.Write($png)
  $w.Close()
}

function New-JarvisShortcut([string]$path) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($path)
  $lnk.TargetPath = $bat
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$ico,0"
  $lnk.WindowStyle = 7          # start the black window minimised
  $lnk.Description = 'Start J.A.R.V.I.S.'
  $lnk.Save()
}

$desktop = [Environment]::GetFolderPath('Desktop')
New-JarvisShortcut (Join-Path $desktop 'JARVIS.lnk')
Write-Output "Desktop shortcut: $(Join-Path $desktop 'JARVIS.lnk')"

$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'JARVIS.lnk'
if ($Startup) {
  New-JarvisShortcut $startupLnk
  Write-Output "JARVIS will also start with Windows: $startupLnk"
}
if ($RemoveStartup -and (Test-Path $startupLnk)) {
  Remove-Item $startupLnk
  Write-Output 'JARVIS will no longer start with Windows.'
}
