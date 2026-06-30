' Launches the SNKRS update server (serve.js) with NO console window.
' Used by the Task Scheduler entry so the server runs silently at login.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir
' 0 = hidden window, False = don't wait for it to exit
sh.Run "node """ & scriptDir & "\serve.js""", 0, False
