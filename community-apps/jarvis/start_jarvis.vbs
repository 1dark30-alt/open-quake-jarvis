Set WshShell = CreateObject("WScript.Shell")
Dim fso, scriptDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir & "\Mark-XLVI"
exePath = scriptDir & "\Mark-XLVI\jarvis_backend.exe"
WshShell.Run chr(34) & exePath & chr(34), 0, True
