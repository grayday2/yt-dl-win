@echo off
rem  ytm-dl / fetch the JS runtime that yt-dlp uses for YouTube po-tokens.
rem  Why: without it some requests hit "Sign in to confirm you're not a bot".
rem  Two sources are tried: an official GitHub release of deno, and, if node is
rem  already installed on this PC, its node.exe is simply copied. Nothing is
rem  installed into the system - the file just lands in app\bin.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul
set "DEST=%~dp0app\bin"
set "VER=v2.9.6"
set "ASSET=deno-x86_64-pc-windows-msvc.zip"
set "URL=https://github.com/denoland/deno/releases/download/%VER%/%ASSET%"
set "SUMURL=%URL%.sha256sum"
set "TMP=%TEMP%\ytm-deno"

if not exist "%DEST%" mkdir "%DEST%"

rem --- free option: an already installed node.exe counts as a JS runtime too ---
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%p in ('where node') do if not defined NODEHIT set "NODEHIT=%%p"
  if defined NODEHIT (
    echo [.] node already installed: !NODEHIT!
    echo     Copying it into app\bin so the portable folder stays self-contained...
    copy /y "!NODEHIT!" "%DEST%\node.exe" >nul 2>&1
    if not errorlevel 1 (
      echo [ok] app\bin\node.exe - restart the engine, the [warn] line becomes [ok]
      echo      ^(if node needs node_modules beside it, deno below is the cleaner option^)
      pause
      exit /b 0
    )
  )
)

echo [.] downloading deno %VER% ^(one file, ~42 MB zip / ~110 MB unpacked^)
echo     %URL%
if exist "%TMP%" rmdir /s /q "%TMP%" >nul 2>&1
mkdir "%TMP%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%TMP%\%ASSET%'; Invoke-WebRequest -UseBasicParsing -Uri '%SUMURL%' -OutFile '%TMP%\sum.txt'; Write-Host '[.] downloaded' } catch { Write-Host ('[x] download failed: ' + $_.Exception.Message) }"
if not exist "%TMP%\%ASSET%" goto manual

rem --- verify the checksum published by the release itself ---
for /f "tokens=1" %%h in ('powershell -NoProfile -Command "(Get-Content '%TMP%\sum.txt' | Select-String -Pattern '^[0-9a-fA-F]{64}').Matches.Value"') do set "EXPECT=%%h"
for /f "tokens=1" %%g in ('certutil -hashfile "%TMP%\%ASSET%" SHA256 ^| findstr /r "^[0-9a-fA-F]*$"') do set "GOT=%%g"
if not defined EXPECT (
  echo [!] checksum file was not parsed; installing unverified
) else (
  for /f "tokens=1" %%z in ("!EXPECT!") do set "EXPECT=%%z"
  if /I not "!EXPECT!"=="!GOT!" (
    echo [x] sha256 mismatch - refusing to unpack.
    echo     expected: !EXPECT!
    echo     got     : !GOT!
    goto manual
  )
)

echo [.] unpacking
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%TMP%\%ASSET%' -DestinationPath '%TMP%\u' -Force"
if not exist "%TMP%\u\deno.exe" (
  echo [x] deno.exe not found inside the archive
  goto manual
)
move /y "%TMP%\u\deno.exe" "%DEST%\deno.exe" >nul
echo [ok] %DEST%\deno.exe
"%DEST%\deno.exe" --version
echo.
echo Now restart ytm.bat (item 1 in the menu): the "JS-runtime" line must turn into [ok].
rmdir /s /q "%TMP%" >nul 2>&1
pause
exit /b 0

:manual
echo.
echo [!] Automatic download did not work. Get it by hand - it is ONE file, no installer:
echo     1. open  %URL%
echo        (or: github.com/denoland/deno/releases/latest - asset %ASSET%)
echo     2. unpack the zip, take deno.exe out of it
echo     3. put it here:  %DEST%\deno.exe
echo     4. restart ytm.bat
echo.
echo     You can also drop node.exe there instead, or just copy a whole Node.js
echo     folder to app\bin - yt-dlp accepts deno, node, bun or quickjs.
echo     And you can skip this entirely: set  player_client=tv  in ytm-dl.ini,
echo     that client does not need a po-token at all.
echo.
pause
exit /b 1
