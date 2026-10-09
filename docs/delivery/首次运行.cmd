@echo off
rem First-run setup for the delivery package. Run this ONCE after extracting.
rem
rem The zip cannot store symlinks or junctions, so they were all skipped when the
rem package was built. This rebuilds them from the lockfile (~30 seconds).
rem Running it again is harmless -- it detects that everything is in place and
rem does nothing.
rem
rem All logic lives in the .mjs; this file only calls it.
cd /d "%~dp0"
node scripts\setup-delivery.mjs
echo.
pause
