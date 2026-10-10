@echo off
cd /d "%~dp0"

rem Redirect TEMP/TMP to the scratch drive so ffmpeg scratch files stay off C:.
set "LWB_TEMP=E:\lifa-scratch\temp"
if not exist "%LWB_TEMP%" mkdir "%LWB_TEMP%"
set "TEMP=%LWB_TEMP%"
set "TMP=%LWB_TEMP%"
set "HF_HOME=E:\lifa-scratch\hf-home"
if not exist "%HF_HOME%" mkdir "%HF_HOME%"

rem 端口预检：桥接可能已由计划任务 LWBBridgeNow 常驻。
rem 重复启动会以 EADDRINUSE 崩溃并弹窗，这里直接提示并退出。
curl -s -o NUL --noproxy 127.0.0.1 --max-time 2 http://127.0.0.1:8199/health >NUL 2>&1
if not errorlevel 1 (
    echo [提示] 本地媒体桥接已经在运行中，无需重复启动。
    echo 配置中心：http://127.0.0.1:8199/
    pause
    exit /b 0
)

node bridge.mjs
pause
