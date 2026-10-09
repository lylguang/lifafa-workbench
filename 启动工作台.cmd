@echo off
rem Launch LWB workbench. If the port is in use, an instance is already running.
cd /d "%~dp0"

rem Step 0) Redirect TEMP/TMP to the scratch drive (E: has the most free space).
rem   Remotion bundling, Chrome profiles and render workspaces all follow
rem   TEMP/TMP. A single render can write hundreds of MB, and a full drive
rem   makes rendering fail with ENOSPC. Nothing in the pipeline may touch C:.
set "LWB_TEMP=E:\lifa-scratch\temp"
if not exist "%LWB_TEMP%" mkdir "%LWB_TEMP%"
set "TEMP=%LWB_TEMP%"
set "TMP=%LWB_TEMP%"
rem Model-download caches (HuggingFace hub etc.) also default to C:\Users\...\.cache.
set "HF_HOME=E:\lifa-scratch\hf-home"
if not exist "%HF_HOME%" mkdir "%HF_HOME%"
set "TORCH_HOME=E:\lifa-scratch\torch-home"
if not exist "%TORCH_HOME%" mkdir "%TORCH_HOME%"
set "npm_config_cache=E:\lifa-scratch\npm-cache"
if not exist "%npm_config_cache%" mkdir "%npm_config_cache%"

rem Step 0.5) Refuse to start a second instance when 4173 already answers.
rem   A second `npm run dev` would die with EADDRINUSE and look like a
rem   startup failure; the first instance's browser tab is still valid.
curl -s -o NUL --noproxy 127.0.0.1 --max-time 2 http://127.0.0.1:4173/ >NUL 2>&1
if not errorlevel 1 (
    echo [INFO] The workbench is already running; no need to start it again.
    echo        Open http://127.0.0.1:4173/ in your browser, or refresh the existing tab.
    pause
    exit /b 0
)

rem Step 1) Start the local media bridge (voiceover/subtitles/cover -> local ComfyUI).
rem    Skipped when 8199 already answers.
curl -s -o NUL --noproxy 127.0.0.1 --max-time 2 http://127.0.0.1:8199/health >NUL 2>&1
if errorlevel 1 (
    start "local-media-bridge" /min /D "%~dp0..\本地媒体桥接" cmd /c "node bridge.mjs"
    rem `ping` sleep: `timeout /t` fails when stdin is redirected.
    ping -n 3 127.0.0.1 >NUL
)

rem Step 2) Start the workbench with the local model endpoints injected.
rem Step 3) Remotion browser: use the version-paired headless shell
rem   (measured 5.6x faster than system Chrome). It must stay on a short
rem   path: Windows MAX_PATH is 260 and the render workspace path alone
rem   is already ~300 chars, which makes spawn fail with ENOENT.
set "LWB_REMOTION_HEADLESS_SHELL=E:\lifa-scratch\browser\chrome-headless-shell-win64\chrome-headless-shell.exe"
rem Fallback browser when the headless shell is unavailable.
set "LWB_REMOTION_BROWSER_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL=http://127.0.0.1:8199"
set "LWB_SPOKEN_VIDEO_BAILIAN_IMAGE_BASE_URL=http://127.0.0.1:8199"
rem Extra args (e.g. --trusted-host <domain> for tunnel access) pass through to the harness CLI.
rem
rem The harness prints an authenticated URL (http://127.0.0.1:4173/?token=...) that
rem mints a session cookie. It exists only in process memory and changes on every
rem restart, so a browser opened at the bare origin gets
rem "dsh web authentication required". Capture it to a file so a new browser (or
rem a new machine profile) can be pointed at the right URL without digging through
rem this console window. 双击「打开工作台.cmd」即可用它。
set "LWB_ACCESS_URL_FILE=E:\lifa-scratch\workbench-url.txt"
if not exist "E:\lifa-scratch" mkdir "E:\lifa-scratch"
if exist "%LWB_ACCESS_URL_FILE%" del "%LWB_ACCESS_URL_FILE%"
rem Tee the launcher's stdout so the token line lands in the file as it is printed.
rem Write it as ASCII (the URL is pure ASCII) on purpose: a UTF-8 BOM would be read by
rem cmd as a stray character and glued onto the front of the URL, breaking the open
rem (2026-10-08 实测：文件里出现过 "锘?ttp://..."，双击打开直接失败）。
powershell -NoProfile -Command "$env:LWB_ACCESS_URL_FILE='%LWB_ACCESS_URL_FILE%'; & node lwb/dsh-launcher.mjs --port 4173 %* 2>&1 | ForEach-Object { $line = $_; Write-Host $line; if ($line -match 'http://127\.0\.0\.1:4173/\?token=\S+') { [System.IO.File]::WriteAllText($env:LWB_ACCESS_URL_FILE, ($line -replace '^.*?(http://)', '$1'), [System.Text.Encoding]::ASCII) } }"
pause
