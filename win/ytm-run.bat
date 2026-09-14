@echo off
rem  ytm-run.bat - one single file you can drop into ANY ytm-dl folder, old build or
rem  new one. It does not need ytm.bat and it does not need app\control.py: it starts
rem  app\companion.py directly, prints every step in THIS window and never closes it
rem  without a key press. Use it when start.bat "closes and says nothing": this file
rem  cannot do that, and if it fails, the reason is on the screen and in ytm-run.log.
setlocal EnableExtensions EnableDelayedExpansion
set "HERE=%~dp0"
cd /d "!HERE!"
set "LOGF=!HERE!ytm-run.log"
> "!LOGF!" echo ytm-run start
set "PY=!HERE!app\python\python.exe"
if exist "!PY!" goto havepy
set "PY=!HERE!app\python\bin\python.exe"
if exist "!PY!" goto havepy
set "PY="
for /f "delims=" %%p in ('where python 2^>nul') do if not defined PY set "PY=%%p"
if defined PY goto havepy
echo [x] NO python found: not app\python\python.exe, not in PATH.
echo     Run setup.ps1 once - it puts python into app\python of THIS folder.
>> "!LOGF!" echo WHY: no python found in !HERE!app\python and not in PATH
pause
exit /b 3
:havepy
echo ============ ytm-run ============
echo folder : !HERE!
echo python : !PY!
"!PY!" -c "import sys;print('version:', sys.version.split()[0])"
if not exist "!HERE!app\companion.py" echo [x] no app\companion.py here - this is not an unpacked ytm-dl folder
if not exist "!HERE!app\companion.py" goto fin
echo.
echo ---- self-check ----
"!PY!" -u -X utf8 "!HERE!app\companion.py" --check --out "!HERE!music" 2>&1
"!PY!" -u -X utf8 "!HERE!app\companion.py" --check --out "!HERE!music" > "!LOGF!" 2>&1
echo.
echo ---- server, live output below. Ctrl+C stops it ----
"!PY!" -u -X utf8 "!HERE!app\companion.py" --stop-other --log-file "!LOGF!" --out "!HERE!music"
echo ---- server exited ----
:fin
echo.
echo everything above is also in: !LOGF!
echo if the window was open all the time, the answer is in these 2 files.
pause
endlocal
exit /b 0
