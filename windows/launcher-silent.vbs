' IMD Worker Monitor - silent launcher. Runs launcher.ps1 -Silent with no window (output: launcher.log and logs\ next to it;
' a message box appears if the launcher fails).
' Stop it with stop-monitor.cmd. Double-clicking this again while it runs just re-opens the dashboard tab.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\launcher.ps1"" -Silent"
sh.Run cmd, 0, False
