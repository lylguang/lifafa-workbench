@echo off
rem First-run setup for the delivery package. Run this ONCE after extracting.
rem
rem The zip cannot store symlinks or junctions, so they were all skipped when the
rem package was built. This rebuilds them from the lockfile (~100 seconds).
rem Running it again is harmless -- it detects everything is in place and exits.
rem
rem The bundled Node and FFmpeg go on PATH first: a customer machine may have
rem neither installed (2026-10-09 measured -- a fresh machine reports
rem "'node' is not recognized" right here, on the very first script they click).
rem
rem All logic lives in the .mjs; this file only sets up PATH and calls it.
cd /d "%~dp0"

if exist "%~dp0运行环境\node\node.exe" set "PATH=%~dp0运行环境\node;%PATH%"
if exist "%~dp0运行环境\ffmpeg" set "PATH=%~dp0运行环境\ffmpeg;%PATH%"

where node >NUL 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         The bundled runtime is missing at: %~dp0运行环境\node
    echo         Please re-extract the package, or install Node.js 22+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

node scripts\setup-delivery.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] First-run setup failed. See the message above.
    pause
    exit /b 1
)
echo.
pause
