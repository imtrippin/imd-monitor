<#  IMD Worker Monitor launcher - ONE page for every box.
    1. Opens a loopback-only SSH tunnel to each box in windows\boxes.json:
         local 127.0.0.1:<LocalPort> -> <SshHost> 127.0.0.1:<RemotePort>
       Local ports come from boxes.json; pick any free loopback ports.
    2. Starts the local hub (windows/hub.js, Node, no deps) on 127.0.0.1:<HubPort> (default 18790),
       which serves the dashboard and merges every box's /api/state + /api/history.
    3. Opens ONE browser tab on the hub.
    4. Supervises what it started: a tunnel or hub that exits is restarted (with backoff).
    Host-key checking stays ON. Children share this console, so closing the window (X) or
    Ctrl+C ends them too. Per-box pages stay reachable at their LocalPort.
    Parameters: -Box <Id>[,<Id>...] opens only those boxes; -HubPort <n> moves the hub;
    -Silent (passed by launcher-silent.vbs) shows a message box when the launcher fails.
    Logs: this script's transcript is appended to windows\launcher.log; the stderr of each ssh
    tunnel and of the hub goes to windows\logs\<name>.log (rewritten each time that child starts).
    Silent mode: launcher-silent.vbs runs this script with no window, and stop-monitor.cmd ends it
    (it drops a stop.flag next to this script, which the supervisor loop picks up within 3 s and
    shuts down cleanly). windows\launcher.pid holds one JSON record per line for this launcher and
    every child it has running: pid, start (the process creation time, UTC ISO 8601), kind
    (launcher, hub or tunnel), exe (the executable path) and match (this launcher.ps1 path, this
    repo's hub.js path, or the tunnel's exact '-L 127.0.0.1:<local>:127.0.0.1:<remote>' forward).
    It is rewritten whenever the launcher starts or restarts a child; stop-monitor.cmd stops only
    the processes whose pid, creation time, executable and command line still match a record.
    A launcher that starts no child (everything already running) writes no launcher.pid.
    SSH aliases: a box is used only when its SshHost appears on a literal 'Host' line of
    ~/.ssh/config. Aliases that come from an Include file or a wildcard pattern are not recognised;
    add a plain 'Host <alias>' line for them.
    Box display names and notes may contain any characters except '=' in Name (the hub splits its
    --box argument on '='); quotes are escaped for the hub's command line.
#>
param([string[]]$Box, [int]$HubPort = 18790, [switch]$Silent)
$ErrorActionPreference = 'Stop'
$selfPath = $MyInvocation.MyCommand.Path
$here = Split-Path -Parent $selfPath
$logDir = Join-Path $here 'logs'
# A message box from a separate hidden process, so it never blocks the supervisor. The text travels in an
# environment variable (inherited by the child), never inside the command line.
function Show-Notice([string]$text) {
  $env:IMD_MONITOR_NOTICE = $text
  $cmd = "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show(`$env:IMD_MONITOR_NOTICE, 'IMD Worker Monitor', 'OK', 'Warning', 'OK', 'DefaultDesktopOnly')"
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))) | Out-Null
}
# Any error that ends the launcher: in silent mode nobody sees the console, so say it in a message box.
trap {
  Write-Host "FATAL: $_" -ForegroundColor Red
  if ($Silent) { try { Show-Notice "IMD Worker Monitor stopped with an error:`n`n$_`n`nLogs: $(Join-Path $PSScriptRoot 'launcher.log') and $(Join-Path $PSScriptRoot 'logs')" } catch {} }
  break
}
$stopFlag = Join-Path $here 'stop.flag'
$pidFile = Join-Path $here 'launcher.pid'
if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue }   # a stale flag must not stop a fresh start
# a transcript of this run (git-ignored *.log): the only place the output lands when launched hidden
try { Start-Transcript -Path (Join-Path $here 'launcher.log') -Append | Out-Null } catch {}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $ssh)) { $ssh = 'ssh' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH (the hub needs Node 22+)" }
$hubUrl = "http://127.0.0.1:$hubPort/"
$webDist = Join-Path (Split-Path -Parent $here) 'web\dist'
if (-not (Test-Path (Join-Path $webDist 'index.html'))) { throw "web\dist not built - run 'npm run build' in monitor\web first" }

# Boxes live in windows\boxes.json (not in git): copy boxes.example.json and fill in your own
# names, IPs (Note is display-only) and the ~/.ssh/config aliases the tunnels use.
$boxesFile = Join-Path $here 'boxes.json'
if (-not (Test-Path $boxesFile)) { throw "windows\boxes.json not found - copy windows\boxes.example.json to boxes.json and fill in your boxes" }
$boxes = @((Get-Content $boxesFile -Raw | ConvertFrom-Json) | ForEach-Object {
  [pscustomobject]@{ Id=[string]$_.Id; Name=[string]$_.Name; Note=[string]$_.Note; LocalPort=[int]$_.LocalPort; RemotePort=[int]$_.RemotePort; SshHost=[string]$_.SshHost }
})
# These fields end up in ssh and hub command lines: Id and SshHost must be plain names. Name and Note
# are escaped for the hub's --box argument (ConvertTo-WinArg); Name may not contain '=' because the
# hub splits that argument on '='. Ids key the supervision and the hub's box list, so they are unique;
# ports must be valid and no two boxes (or a box and the hub) may share a local port.
$seenIds = @{}; $seenPorts = @{}
foreach ($b in $boxes) {
  # no leading '-': ssh (and the hub) would read such a name as an option (-F, -V ...)
  if ($b.Id -cnotmatch '^(?!-)[A-Za-z0-9_.-]+\z') { throw "boxes.json: Id '$($b.Id)' may only use letters, digits, '_', '.' and '-', and may not start with '-'" }
  if ($b.SshHost -cnotmatch '^(?!-)[A-Za-z0-9_.-]+\z') { throw "boxes.json: box '$($b.Id)': SshHost '$($b.SshHost)' may only use letters, digits, '_', '.' and '-', and may not start with '-'" }
  if ($b.Name -like '*=*') { throw "boxes.json: box '$($b.Id)': Name may not contain '='" }
  if ($seenIds.ContainsKey($b.Id)) { throw "boxes.json: Id '$($b.Id)' is used by more than one box" }
  foreach ($port in @($b.LocalPort, $b.RemotePort)) { if ($port -lt 1 -or $port -gt 65535) { throw "boxes.json: box '$($b.Id)': port $port is not between 1 and 65535" } }
  if ($b.LocalPort -eq $HubPort) { throw "boxes.json: box '$($b.Id)': LocalPort $($b.LocalPort) is the hub's port; pick another (or pass -HubPort)" }
  if ($seenPorts.ContainsKey($b.LocalPort)) { throw "boxes.json: boxes '$($seenPorts[$b.LocalPort])' and '$($b.Id)' share LocalPort $($b.LocalPort)" }
  $seenIds[$b.Id] = $true; $seenPorts[$b.LocalPort] = $b.Id
}
# A box is only in play once its alias appears on a literal 'Host' line of ~/.ssh/config (a
# listed-but-unconfigured box is skipped). Include files and wildcard patterns are not read.
$sshConfig = Join-Path $HOME '.ssh\config'
$aliases = @(); if (Test-Path $sshConfig) { $aliases = @(Get-Content $sshConfig | Where-Object { $_ -match '^\s*Host\s+' } | ForEach-Object { ($_ -replace '^\s*Host\s+', '') -split '\s+' }) }
$boxes = @($boxes | Where-Object { if ($aliases -contains $_.SshHost) { $true } else { Write-Host "$($_.Name): no literal 'Host $($_.SshHost)' line in ~/.ssh/config - skipped (Include files and wildcard Host patterns are not read; add a plain 'Host $($_.SshHost)' line)." -ForegroundColor DarkGray; $false } })
if ($Box) { $boxes = @($boxes | Where-Object { $Box -contains $_.Id }) }
if ($boxes.Count -eq 0) { throw "no boxes to open (check ~/.ssh/config aliases and the -Box ids)" }

function Test-Port([int]$p) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { return $false }
}
function Get-Health([string]$url) {
  try { return (Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 6).Content | ConvertFrom-Json } catch { return $null }
}
# Children are started with -NoNewWindow so they share this console: closing the window or
# Ctrl+C ends them, and nothing is left listening on the tunnel and hub ports afterwards.
function Start-Tunnel($b) {
  $fwd = "127.0.0.1:$($b.LocalPort)`:127.0.0.1:$($b.RemotePort)"
  $a = @('-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10',
         '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L',$fwd,'--',$b.SshHost)   # '--': the destination is never an option
  return Start-Process -FilePath $ssh -ArgumentList $a -PassThru -NoNewWindow -RedirectStandardError (Join-Path $logDir "tunnel-$($b.Id).log")
}
# Start-Process joins -ArgumentList with spaces and adds no quoting, so each argument that may carry
# spaces or quotes is quoted here by the Windows command-line rules (a quote becomes \", and the
# backslashes in front of a quote or at the end are doubled), which is how node splits its argv.
function ConvertTo-WinArg([string]$s) { '"' + (($s -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
$hubJs = Join-Path $here 'hub.js'
function Start-Hub() {
  $a = @((ConvertTo-WinArg $hubJs), '--port', $hubPort, '--web', (ConvertTo-WinArg $webDist))
  foreach ($b in $boxes) { $a += @('--box', (ConvertTo-WinArg "$($b.Id)=$($b.LocalPort)=$($b.Name)=$($b.Note)")) }
  return Start-Process -FilePath $node -ArgumentList $a -PassThru -NoNewWindow -WorkingDirectory $here -RedirectStandardError (Join-Path $logDir 'hub.log')
}
# One launcher.pid record (a JSON line) for a process this launcher owns. The creation time and the
# executable come from Win32_Process, the same source stop-monitor.cmd checks them against; if that
# query fails the creation time falls back to Get-Process (the stop script then may not match it and
# leaves that process running, which is the safe side). $null when the process is already gone.
function Get-PidRecord([int]$id, [string]$kind, [string]$match) {
  $start = $null; $exe = ''
  try { $c = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop; if ($c) { $start = $c.CreationDate; $exe = [string]$c.ExecutablePath } } catch {}
  if (-not $start) { try { $start = (Get-Process -Id $id -ErrorAction Stop).StartTime } catch { return $null } }
  return ([pscustomobject][ordered]@{ pid = $id; start = $start.ToUniversalTime().ToString('o'); kind = $kind; exe = $exe; match = $match } | ConvertTo-Json -Compress)
}
# launcher.pid: this launcher's record, then one record for every child it has running.
function Write-PidFile() {
  if (-not $script:selfRecord) { $script:selfRecord = Get-PidRecord $PID 'launcher' $selfPath }
  $lines = @($script:selfRecord) + @($tracked.Values | Where-Object { $_.Proc -and -not $_.Proc.HasExited } | ForEach-Object { Get-PidRecord $_.Proc.Id $_.Kind $_.Match })
  try { [IO.File]::WriteAllLines($pidFile, [string[]]@($lines | Where-Object { $_ }), (New-Object Text.UTF8Encoding $false)) } catch {}   # UTF-8 without BOM: paths may hold any character
}
function Wait-Port([int]$p, [int]$tries, [int]$ms) { for ($i = 0; $i -lt $tries -and -not (Test-Port $p); $i++) { Start-Sleep -Milliseconds $ms }; return (Test-Port $p) }

Write-Host "IMD Worker Monitor" -ForegroundColor Cyan
$tracked = @{}   # 'tunnel:<box Id>' or 'hub' -> @{ Proc; Start (scriptblock); Port; Label; Kind; Match; NextRetry; Backoff }
$hub = $null
$tunnelsTried = 0; $tunnelsFailed = 0
try {
  foreach ($b in $boxes) {
    if (Test-Port $b.LocalPort) {
      Write-Host "$($b.Name): local port $($b.LocalPort) already open (existing tunnel, not supervised here)."
    } else {
      Write-Host "$($b.Name): tunnel 127.0.0.1:$($b.LocalPort) -> $($b.SshHost) 127.0.0.1:$($b.RemotePort) ..."
      $p = Start-Tunnel $b
      $tunnelsTried++
      if (-not (Wait-Port $b.LocalPort 30 500)) {
        $tunnelsFailed++
        Write-Host "  $($b.Name): tunnel failed (is '$($b.SshHost)' reachable?). Will retry in the background; the page shows it as unreachable meanwhile." -ForegroundColor Red
        if ($p -and -not $p.HasExited) { $p.Kill() }
        $p = $null
      } else { Write-Host "  up (ssh pid $($p.Id))." -ForegroundColor Green }
      $thisBox = $b   # not $box: PowerShell names are case-insensitive and $Box is the [string[]] parameter
      $tracked["tunnel:$($b.Id)"] = @{ Proc = $p; Start = { Start-Tunnel $thisBox }.GetNewClosure(); Port = $b.LocalPort; Label = "$($b.Name) tunnel"
                                       Kind = 'tunnel'; Match = "-L 127.0.0.1:$($b.LocalPort):127.0.0.1:$($b.RemotePort)"; NextRetry = (Get-Date); Backoff = 5 }
      Write-PidFile
    }
    $h = Get-Health "http://127.0.0.1:$($b.LocalPort)/api/health"
    if ($h -and $h.ok -and $h.service -eq 'imd-monitor') { Write-Host "  $($b.Name): backend ok ($($h.workers) workers)" }
    elseif (Test-Port $b.LocalPort) { Write-Host "  $($b.Name): port $($b.LocalPort) is not the IMD monitor backend." -ForegroundColor Red }
  }
  if ($Silent -and $tunnelsTried -gt 0 -and $tunnelsFailed -eq $tunnelsTried) {
    Show-Notice "No SSH tunnel could be opened. Is your key loaded in the ssh-agent (ssh-add)? The launcher keeps retrying in the background.`n`nLogs: $logDir"
  }

  # hub: one process merges every configured box. Reuse a running hub only if it was started with
  # the SAME box set, compared as id=port=name=note per box (an orphan from a -Box run would otherwise
  # silently hide the other boxes, and one started before a port or name change would use the old ones).
  # The hub reports a missing name as the id and a missing note as null, so compare the same way.
  $wanted = @($boxes | ForEach-Object { "$($_.Id)=$($_.LocalPort)=$(if ($_.Name) { $_.Name } else { $_.Id })=$($_.Note)" } | Sort-Object) -join ','
  if (Test-Port $hubPort) {
    $h = Get-Health "$($hubUrl)api/health"
    $have = if ($h -and $h.boxes) { @($h.boxes | ForEach-Object { "$($_.id)=$($_.port)=$($_.name)=$($_.note)" } | Sort-Object) -join ',' } else { '' }
    if ($h -and $h.service -eq 'imd-monitor-hub' -and $have -eq $wanted) {
      Write-Host "Hub: already running on $hubPort with the same boxes (reusing; not supervised here)."
    } else {
      $owner = $null
      try { $owner = Get-Process -Id (Get-NetTCPConnection -LocalPort $hubPort -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess -ErrorAction Stop } catch {}
      if ($owner -and $owner.ProcessName -eq 'node' -and $h -and $h.service -eq 'imd-monitor-hub') {
        Write-Host "Hub: a stale hub (pid $($owner.Id), boxes '$have') is on $hubPort; replacing it with boxes '$wanted'." -ForegroundColor Yellow
        $owner.Kill(); Start-Sleep -Milliseconds 500
      } else {
        throw "port $hubPort is in use by something that is not our hub (owner: $(if ($owner) { $owner.ProcessName + ' pid ' + $owner.Id } else { 'unknown' })). Stop it or pass -HubPort."
      }
    }
  }
  if (-not (Test-Port $hubPort)) {
    Write-Host "Hub: node hub.js on 127.0.0.1:$hubPort ..."
    $hub = Start-Hub
    if (-not (Wait-Port $hubPort 20 250)) { throw "hub failed to start on $hubPort" }
    $tracked['hub'] = @{ Proc = $hub; Start = { Start-Hub }; Port = $hubPort; Label = 'hub'; Kind = 'hub'; Match = $hubJs; NextRetry = (Get-Date); Backoff = 5 }
    Write-PidFile
    Write-Host "  up (node pid $($hub.Id))." -ForegroundColor Green
  }
  $h = Get-Health "$($hubUrl)api/health"
  if ($h -and $h.ok -and $h.service -eq 'imd-monitor-hub') { Start-Process $hubUrl; Write-Host "Dashboard: $hubUrl ($($h.boxes.Count) boxes)" -ForegroundColor Green }
  else { Write-Host "$hubPort did not answer as the IMD hub." -ForegroundColor Red }

  Write-Host ""
  if ($tracked.Count -eq 0) { Write-Host "Using existing tunnel(s) and hub; you can close this window."; return }
  Write-Host "Keep this window open to stay connected. Close it (or Ctrl+C) to disconnect; in silent mode run stop-monitor.cmd."
  # supervise: restart anything we started that exits (tunnel dropped after sleep, hub crash, ...)
  while ($true) {
    Start-Sleep -Seconds 3
    if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue; Write-Host "stop requested (stop.flag)"; break }
    foreach ($key in @($tracked.Keys)) {
      $t = $tracked[$key]; $name = $t.Label
      $alive = $t.Proc -and -not $t.Proc.HasExited
      if ($alive) { $t.Backoff = 5; continue }
      if ((Get-Date) -lt $t.NextRetry) { continue }
      if (Test-Port $t.Port) { continue }   # someone else holds the port; leave it
      Write-Host "$(Get-Date -Format HH:mm:ss) $name exited - restarting..." -ForegroundColor Yellow
      try {
        $t.Proc = & $t.Start
        if (Wait-Port $t.Port 20 500) { Write-Host "  $name back up (pid $($t.Proc.Id))." -ForegroundColor Green; $t.Backoff = 5 }
        else { if ($t.Proc -and -not $t.Proc.HasExited) { $t.Proc.Kill() }; $t.Proc = $null; throw "no listener" }
      } catch {
        $t.NextRetry = (Get-Date).AddSeconds($t.Backoff); $t.Backoff = [Math]::Min($t.Backoff * 2, 60)
        Write-Host "  $name restart failed ($_); next try in $($t.Backoff)s." -ForegroundColor Red
      }
      Write-PidFile
    }
  }
} finally {
  foreach ($t in $tracked.Values) { try { if ($t.Proc -and -not $t.Proc.HasExited) { $t.Proc.Kill() } } catch {} }
  Write-Host "Closed."
  try { Stop-Transcript | Out-Null } catch {}
}
