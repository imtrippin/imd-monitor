@echo off
rem IMD Worker Monitor - stop the silent launcher. It reads windows\launcher.pid (one JSON record per line,
rem written by launcher.ps1 for itself and every child it has running: pid, process creation time, kind,
rem executable and the launcher.ps1 path, hub.js path or exact ssh -L forward it started), then drops stop.flag
rem (the supervisor loop exits within ~3 s and kills the tunnels and the hub it started) and waits up to 12 s.
rem Then it stops only a listed process whose PID still exists AND whose creation time, executable and command
rem line still match its record; anything else is reported as not ours and left running. A read or query
rem error, or a file with no usable record, means the cleanup is not confirmed: the file is kept and the exit is 1. With no launcher.pid
rem it stops nothing and says how to stop the monitor by hand (it never searches for processes by name).
rem Never this script's own process. HERE reaches PowerShell as an environment variable, never inside the
rem command text.
set "HERE=%~dp0"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$pf=Join-Path $env:HERE 'launcher.pid'; " ^
  "if (-not (Test-Path -LiteralPath $pf)) { Write-Host 'No launcher.pid next to this script, so no running process is known to belong to this monitor. Nothing was stopped.'; " ^
  "  Write-Host 'To stop it by hand: close the launcher console window (or press Ctrl+C in it). For the silent launcher, use Task Manager (Details tab, add the Command line column) and end powershell.exe running this launcher.ps1, node.exe running this hub.js and ssh.exe with a -L 127.0.0.1:... forward, after checking each command line.'; exit 1 }; " ^
  "$readErr=$null; $lines=@(); try { $lines=@(Get-Content -LiteralPath $pf -Encoding UTF8 -ErrorAction Stop) } catch { $readErr=[string]$_ }; " ^
  "$flag=Join-Path $env:HERE 'stop.flag'; Set-Content -LiteralPath $flag -Value 'stop'; " ^
  "$deadline=(Get-Date).AddSeconds(12); while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $flag)) { Start-Sleep -Milliseconds 500 }; " ^
  "if (Test-Path -LiteralPath $flag) { Remove-Item -LiteralPath $flag -Force }; " ^
  "if (Test-Path -LiteralPath $pf) { try { $lines += @(Get-Content -LiteralPath $pf -Encoding UTF8 -ErrorAction Stop) } catch { $readErr=[string]$_ } }; " ^
  "$recs=@(); foreach ($l in @($lines | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)) { $r=$null; try { $r=$l | ConvertFrom-Json } catch {}; " ^
  "  if ($r -and $r.pid -and $r.start -and $r.match) { $recs+=$r } else { $unconfirmed++; Write-Host ('not a launcher.pid record (unreadable; cleanup not confirmed): ' + $l) } }; " ^
  "if ($readErr) { $unconfirmed++; Write-Host ('could not read launcher.pid: ' + $readErr) }; if ($recs.Count -eq 0) { $unconfirmed++; Write-Host 'launcher.pid holds no usable record; cleanup not confirmed' }; " ^
  "function Ms($d) { [long][Math]::Floor(([datetime]$d).ToUniversalTime().Ticks / 10000) }; " ^
  "function Get-Match($r) { $p=$null; try { $p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$r.pid) -ErrorAction Stop } catch { return @{ Error=[string]$_ } }; if (-not $p) { return $null }; " ^
  "  $ok=$false; try { $want=if ($r.start -is [datetime]) { $r.start } else { [datetime]::Parse([string]$r.start, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }; " ^
  "    $ok=($p.CreationDate -and (Ms $p.CreationDate) -eq (Ms $want) -and ([string]$p.CommandLine).IndexOf([string]$r.match, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and (-not $r.exe -or [string]$p.ExecutablePath -eq [string]$r.exe)) } catch {}; " ^
  "  return @{ Ours=$ok } }; " ^
  "$recs=@($recs | Sort-Object { if ($_.kind -eq 'launcher') { 0 } else { 1 } }); $failed=0; " ^
  "foreach ($r in $recs) { $tag=[string]$r.kind + ' pid ' + $r.pid; " ^
  "  if ([int]$r.pid -eq $PID) { Write-Host ($tag + ': this stop script itself, left running'); continue }; " ^
  "  $m=Get-Match $r; if (-not $m) { Write-Host ($tag + ': already gone'); continue }; if ($m.Error) { $unconfirmed++; Write-Host ($tag + ': process query failed (' + $m.Error + '); cleanup not confirmed'); continue }; " ^
  "  if (-not $m.Ours) { $unconfirmed++; Write-Host ($tag + ': does not match its record, left running (another start time, executable or command line); cleanup not confirmed'); continue }; " ^
  "  try { Stop-Process -Id ([int]$r.pid) -Force -ErrorAction Stop; Write-Host ('stopped ' + $tag) } catch { $failed++; Write-Host ('could not stop ' + $tag + ': ' + $_) } }; " ^
  "if ($failed -gt 0 -or $unconfirmed -gt 0) { Write-Host ('Cleanup not confirmed (' + $failed + ' could not be stopped, ' + $unconfirmed + ' record(s) unmatched or unreadable); launcher.pid is kept. Check the processes by hand (Task Manager, Details tab, Command line column).'); exit 1 }; " ^
  "Remove-Item -LiteralPath $pf -Force -ErrorAction SilentlyContinue; Write-Host 'IMD Worker Monitor stopped.'"
exit /b %ERRORLEVEL%
