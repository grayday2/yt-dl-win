@echo off
rem  ytm-dl / the ONE entry point: double-click = menu (start / stop / status /
rem  selftest / log / report / deno / uninstall).  Commands: ytm.bat serve,
rem  ytm.bat stop, ytm.bat kill, ytm.bat restart, ytm.bat status, ytm.bat selftest,
rem  ytm.bat log, ytm.bat report, ytm.bat deno, ytm.bat uninstall.  start.bat is only
rem  an alias for "ytm.bat serve", so old shortcuts keep working.
rem
rem  Deliberately this thin: cmd.exe dies SILENTLY on anything it does not understand,
rem  and "the window closed and nothing was said" was the worst failure of this folder.
rem  So: no parsing here at all, no loops, no codepage tricks. Everything after
rem  "found python" lives in app\control.py - plain Python, which always prints a traceback and
rem  writes it to ytm-dl-error.txt before the window may close.
setlocal EnableExtensions EnableDelayedExpansion
title ytm-dl control
cd /d "%~dp0"
set "HERE=%~dp0"
set "LOGF=!HERE!ytm-dl-error.txt"

set "PYEXE="
if exist "app\python\python.exe" set "PYEXE=app\python\python.exe"
if not defined PYEXE if exist "app\python\bin\python.exe" set "PYEXE=app\python\bin\python.exe"
if not defined PYEXE if exist "app\python\python" set "PYEXE=app\python\python"
if not defined PYEXE for /f "delims=" %%p in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%p"
if not defined PYEXE for /f "delims=" %%p in ('where python3 2^>nul') do if not defined PYEXE set "PYEXE=%%p"

if not defined PYEXE (
  echo [x] no python.exe found in app\python\ and none in PATH.
  echo.
  echo     Run setup.ps1 once - it downloads portable python and ffmpeg INTO this
  echo     folder:  right-click win setup.ps1 - "Run with PowerShell"
  echo     (the file is here: setup.ps1). Or unpack any Python 3.10+ into
  echo     app\python\ so that app\python\python.exe exists.
  echo.
  echo     This window stays open until you press a key, so nothing "flashes away".
  pause
  exit /b 3
)

set "ARGS="
if /I not "%~1"=="" set "ARGS=!ARGS! %*"
set "PATH=!HERE!app\bin;%PATH%"
rem  control.py by full path and with its own existence check: without this cmd just
rem  says "can't open file" for a moment and the window is already gone.
if exist "!HERE!app\control.py" goto run
echo [x] app\control.py is missing in "!HERE!"
echo     Unpack the WHOLE archive into one folder. Do not pull single files out of it.
echo     Files that are here now:
dir /b "!HERE!"
echo.
"!PYEXE!" -c "print('   python works, so the folder is the only problem')"
echo.
pause >nul
exit /b 4
:run
"!PYEXE!" -u -X utf8 "!HERE!app\control.py"!ARGS!
if not errorlevel 1 goto tail
if exist "!LOGF!" goto tail
>"!LOGF!" echo ytm-dl: python exited with !errorlevel!
>>"!LOGF!" echo folder: !HERE!
>>"!LOGF!" echo python: !PYEXE!
>>"!LOGF!" echo args: !ARGS!
echo [x] engine stopped with code !errorlevel! - details written to ytm-dl-error.txt
:tail
rem  Safety net: the pause above belongs to python (it only pauses when stdin is
rem  a real console). If python never got that far - the file is locked by AV, the
rem  interpreter is quarantined, the exe is 0 bytes, - cmd is the only one left who
rem  can keep the window. pause returns by itself on EOF, so a scheduled hidden run
rem  does not hang on it.
pause >nul
endlocal
exit /b %errorlevel%
