@echo off
rem  ytm-dl / package install. 0.5.8: all logic moved into setup.ps1 (mode -PackagesOnly) -
rem  one installer for everything. This file stays as a thin wrapper so old habits and
rem  old instructions (double-click) keep working.
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -PackagesOnly
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [x] install failed. Check the lines above, then run: ytm.bat selftest
)
pause
exit /b %RC%
