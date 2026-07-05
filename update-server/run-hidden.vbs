' Starts the SNKRS update server with NO console window.
' Used by the "SNKRS Bot Update Server" logon scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
' 0 = hidden window, False = don't wait. If a server is already listening,
' the new one exits 0 immediately (see server.js), so re-runs are harmless.
sh.Run "node """ & dir & "\server.js""", 0, False
