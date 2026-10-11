Option Explicit
Dim shell, fso, scriptPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = "E:\lifa-scratch\lwb-alert.ps1"
If Not fso.FileExists(scriptPath) Then WScript.Quit 0 End If
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """", 0, False
WScript.Quit 0
