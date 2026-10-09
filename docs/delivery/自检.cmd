@echo off
rem Environment self-check. Run this before 启动工作台.cmd on a new machine.
rem All logic lives in the .ps1 -- inlining PowerShell in a .cmd breaks on quoting
rem and GBK path handling (2026-10-08 measured).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0自检.ps1"
echo.
pause
