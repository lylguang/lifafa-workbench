@echo off
rem 环境自检。首次使用前先跑这个（或者跑「首次运行.cmd」，它会先调用本脚本）。
rem 所有逻辑在 .ps1 里——cmd 内嵌 PowerShell 必翻车（引号与 GBK 路径处理，2026-10-08 实测）。
rem 这个 .cmd 只是入口：它负责把随包的 Node 与 FFmpeg 放进 PATH，再转交 .ps1。
cd /d "%~dp0"

rem 随包运行时优先：客户机没装 Node/FFmpeg 时（2026-10-09 实测客户机就是这样，
rem 双击「首次运行.cmd」直接报 "'node' 不是内部或外部命令"）。
rem 包内的放在最前面，系统装的仍可用——客户想用自己装的就装在 PATH 前面也无效，
rem 这里保证包内的先命中，行为一致。
if exist "%~dp0运行环境\node\node.exe" set "PATH=%~dp0运行环境\node;%PATH%"
if exist "%~dp0运行环境\ffmpeg" set "PATH=%~dp0运行环境\ffmpeg;%PATH%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0自检.ps1"
echo.
pause
