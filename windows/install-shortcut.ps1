<#  Creates two Desktop shortcuts. Re-run any time to refresh them.
      IMD Worker Monitor       runs launcher-silent.vbs: tunnels + hub + the dashboard tab, no window
                               (output in windows\launcher.log and windows\logs; a message box if it fails;
                               double-click again to re-open the tab)
      Stop IMD Worker Monitor  runs stop-monitor.cmd: ends the tunnels and the hub
    -Visible makes the first shortcut run launcher.ps1 in a console window instead (the old behaviour).
    -AtLogon also puts a silent "IMD Worker Monitor" shortcut in your Startup folder, so the monitor starts
    when you sign in (it opens the dashboard tab then too). Delete that shortcut to undo. #>
param([switch]$Visible, [switch]$AtLogon)
$ErrorActionPreference = 'Stop'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $here 'launcher.ps1'
$silent   = Join-Path $here 'launcher-silent.vbs'
$stop     = Join-Path $here 'stop-monitor.cmd'
foreach ($f in @($launcher, $silent, $stop)) { if (-not (Test-Path $f)) { throw "$f not found next to this script" } }

$desktop = [Environment]::GetFolderPath('Desktop')
$ps      = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$sh = New-Object -ComObject WScript.Shell

$lnk = $sh.CreateShortcut((Join-Path $desktop 'IMD Worker Monitor.lnk'))
if ($Visible) {
  $lnk.TargetPath = $ps; $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""; $lnk.WindowStyle = 1
  $lnk.Description = "Open the IMD worker monitor (SSH tunnels + dashboard) in a console window"
} else {
  $lnk.TargetPath = $wscript; $lnk.Arguments = "//B `"$silent`""; $lnk.WindowStyle = 7
  $lnk.Description = "Open the IMD worker monitor (SSH tunnels + dashboard), silently in the background"
}
$lnk.WorkingDirectory = $here
$lnk.IconLocation     = "$ps,0"
$lnk.Save()
Write-Host "Created shortcut: IMD Worker Monitor ($(if ($Visible) { 'console window' } else { 'silent' }))" -ForegroundColor Green

$lnk = $sh.CreateShortcut((Join-Path $desktop 'Stop IMD Worker Monitor.lnk'))
$lnk.TargetPath       = Join-Path $env:WINDIR 'System32\cmd.exe'
$lnk.Arguments        = "/c `"$stop`""
$lnk.WorkingDirectory = $here
$lnk.IconLocation     = "$env:WINDIR\System32\shell32.dll,131"
$lnk.Description      = "Stop the IMD worker monitor (tunnels + hub)"
$lnk.WindowStyle      = 7
$lnk.Save()
Write-Host "Created shortcut: Stop IMD Worker Monitor" -ForegroundColor Green

if ($AtLogon) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = $sh.CreateShortcut((Join-Path $startup 'IMD Worker Monitor.lnk'))
  $lnk.TargetPath = $wscript; $lnk.Arguments = "//B `"$silent`""; $lnk.WindowStyle = 7
  $lnk.Description = "Start the IMD worker monitor (SSH tunnels + dashboard) silently at sign-in"
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation     = "$ps,0"
  $lnk.Save()
  Write-Host "Created shortcut: IMD Worker Monitor in $startup (starts at sign-in)" -ForegroundColor Green
}
Write-Host "Double-click the first to open the dashboard; the second to disconnect."
