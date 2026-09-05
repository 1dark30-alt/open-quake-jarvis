Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName) & "\Mark-LV"
python = root & "\.venv\Scripts\python.exe"
If Not fso.FileExists(python) Then
    MsgBox "Run install_mark55.py with Python 3.11 or newer first."
    WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & python & Chr(34) & " quake_main.py", 0, False
