@echo off
rem 打开李发发工作台。
rem
rem 工作台每次重启都会生成一次性访问令牌（只存在进程内存），裸地址
rem http://127.0.0.1:4173/ 在新浏览器或新配置下会报 dsh web authentication
rem required。启动工作台.cmd 会把带令牌的地址写到 workbench-url.txt，
rem 由同目录的「打开工作台.ps1」读出来打开。
rem
rem 本文件是 GBK 编码：cmd 按 GBK 读脚本，写成 UTF-8 会出现乱码。
rem 复杂逻辑一律放到 .ps1 里（本文件只有一行调用），避免 cmd 的引号与
rem 变量展开把命令行拆坏——2026-10-08 实测在 cmd 里内嵌 PowerShell 必翻车。

rem 随包运行时优先：客户机可能既没 Node 也没 FFmpeg（2026-10-09 实测新机器
rem 双击任何脚本都报 "'node' 不是内部或外部命令"）。放到 PATH 最前面，客户
rem 就不需要自己装；系统里已装的仍可作为后备。
if exist "%~dp0运行环境
ode
ode.exe" set "PATH=%~dp0运行环境
ode;%PATH%"
if exist "%~dp0运行环境fmpeg" set "PATH=%~dp0运行环境fmpeg;%PATH%"

rem 工作台没起就先拉起来，免得打开一个死地址。
curl -s -o NUL --noproxy 127.0.0.1 --max-time 2 http://127.0.0.1:4173/ >NUL 2>&1
if errorlevel 1 (
    echo [INFO] 工作台未运行，正在启动...
    start "" /D "%~dp0" cmd /c "启动工作台.cmd"
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0打开工作台.ps1"
