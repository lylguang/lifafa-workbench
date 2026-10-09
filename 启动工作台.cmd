@echo off
rem Launch LWB workbench. If the port is in use, an instance is already running.
cd /d "%~dp0"

rem Step -1) Bundled runtime first. A customer machine may have neither Node nor
rem   FFmpeg installed (2026-10-09 measured on a fresh machine: clicking any
rem   script reports "'node' is not recognized"). The package carries both, and
rem   putting them ahead on PATH means the customer never has to install them.
rem   Anything they did install system-wide still works as a fallback.
if exist "%~dp0运行环境\node\node.exe" set "PATH=%~dp0运行环境\node;%PATH%"
if exist "%~dp0运行环境\ffmpeg" set "PATH=%~dp0运行环境\ffmpeg;%PATH%"
where node >NUL 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. The bundled runtime is missing from:
    echo           %~dp0运行环境\node
    echo         Please re-extract the package, or install Node.js 22+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

rem Step 0) Pick the scratch drive and redirect TEMP/TMP to it.
rem   Remotion bundling, Chrome profiles and render workspaces all follow
rem   TEMP/TMP. A single render can write hundreds of MB, and a full drive
rem   makes rendering fail with ENOSPC. Nothing in the pipeline may touch C:.
rem
rem   The drive is chosen at run time (roomiest non-system drive with >= 20G
rem   free) rather than hardcoded: a customer machine has no reason to have our
rem   E: drive. All of the logic lives in the .ps1 -- inlining PowerShell in a
rem   .cmd breaks on quoting and GBK path handling (2026-10-08 measured), and
rem   complex logic must stay out of this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0设置渲染暂存盘.ps1"
if errorlevel 1 (
    echo [ERROR] Failed to prepare the scratch directory; see the message above.
    pause
    exit /b 1
)

rem The scratch root may sit on a path with non-ASCII characters. cmd reads
rem script text as GBK, so passing it on the command line would corrupt it;
rem the .ps1 writes it to a plain file next to itself instead, and we read it
rem back here. It must not live under TEMP: PowerShell's $env:TEMP and cmd's
rem %TEMP% can differ as strings (8.3 short path vs long path).
set "LWB_SCRATCH_RELAY=%~dp0.lwb-scratch-root.txt"
for /f "usebackq delims=" %%F in ("%LWB_SCRATCH_RELAY%") do set "LWB_SCRATCH_ROOT=%%F"
if not exist "%LWB_SCRATCH_ROOT%" (
    echo [ERROR] Could not determine the scratch directory.
    pause
    exit /b 1
)

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
rem    Skipped when 8199 already answers. Standard-edition deliveries ship
rem    without the bridge folder, so skip it there instead of failing.
curl -s -o NUL --noproxy 127.0.0.1 --max-time 2 http://127.0.0.1:8199/health >NUL 2>&1
if errorlevel 1 (
    if exist "%~dp0..\本地媒体桥接\bridge.mjs" (
        start "local-media-bridge" /min /D "%~dp0..\本地媒体桥接" cmd /c "node bridge.mjs"
        rem `ping` sleep: `timeout /t` fails when stdin is redirected.
        ping -n 3 127.0.0.1 >NUL
    ) else (
        echo [INFO] Local media bridge not shipped in this edition; skipping.
    )
)

rem Step 2) Remotion browser: prefer the version-paired headless shell shipped
rem   with the package (measured 5.6x faster than system Chrome). It must stay
rem   on a short path: Windows MAX_PATH is 260 and the render workspace path
rem   alone is already ~300 chars, which makes spawn fail with ENOENT.
if exist "%~dp0浏览器\chrome-headless-shell-win64\chrome-headless-shell.exe" (
    set "LWB_REMOTION_HEADLESS_SHELL=%~dp0浏览器\chrome-headless-shell-win64\chrome-headless-shell.exe"
) else (
    rem No bundled shell: fall back to a locally installed Chrome/Chromium.
    set "LWB_REMOTION_BROWSER_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe"
)
if not defined LWB_REMOTION_HEADLESS_SHELL set "LWB_REMOTION_BROWSER_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe"
rem Let the launcher pick the scratch drive itself when it has not been told.
set "LWB_SCRATCH_ROOT=%LWB_SCRATCH_ROOT%"
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
rem Same scratch root as 设置渲染暂存盘.ps1 chose -- 「打开工作台.ps1」 looks there too.
set "LWB_ACCESS_URL_FILE=%LWB_SCRATCH_ROOT%\workbench-url.txt"
if not exist "%LWB_ACCESS_URL_FILE%" mkdir "%LWB_ACCESS_URL_FILE%" 2>NUL
if exist "%LWB_ACCESS_URL_FILE%" del "%LWB_ACCESS_URL_FILE%"

rem 模型下载镜像：huggingface.co 在国内多数网络下连不通（2026-10-08 实测超时），
rem 而 fp8/1B 配音模型与白板 Python 依赖都要联网取，必须走镜像。
if not defined HF_ENDPOINT set "HF_ENDPOINT=https://hf-mirror.com"

rem Tee the launcher's stdout so the token line lands in the file as it is printed.
rem Write it as ASCII (the URL is pure ASCII) on purpose: a UTF-8 BOM would be read by
rem cmd as a stray character and glued onto the front of the URL, breaking the open
rem (2026-10-08 实测：文件里出现过 "锘?ttp://..."，双击打开直接失败）。
powershell -NoProfile -Command "$env:LWB_ACCESS_URL_FILE='%LWB_ACCESS_URL_FILE%'; & node lwb/dsh-launcher.mjs --port 4173 %* 2>&1 | ForEach-Object { $line = $_; Write-Host $line; if ($line -match 'http://127\.0\.0\.1:4173/\?token=\S+') { [System.IO.File]::WriteAllText($env:LWB_ACCESS_URL_FILE, ($line -replace '^.*?(http://)', '$1'), [System.Text.Encoding]::ASCII) } }"
pause
