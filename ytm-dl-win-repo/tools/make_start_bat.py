#!/usr/bin/env python3
"""Генератор win/start.bat - автономного запускалителя ytm-dl.

Зачем скрипт, а не правка на глаз: `.bat` в этом проекте проверяется
tools/lint_bats.py (кавычки вокруг подстановок путей, баланс скобок по всему
файлу, ASCII, CRLF, существование меток goto), а start.bat к тому же должен
оставаться ПОЛНОСТЬЮ автономным - в папке пользователя ytm.bat может
оказаться не распакован, и тогда алиас, который только и умеет `call ytm.bat`,
закрывает окно без единого слова. Это ровно та жалоба, из-за которой всё
переписывалось. Генератор держит и текст, и лимит строк.
"""
import pathlib

CR, LF = chr(13), chr(10)

BODY = r"""@echo off
rem  ytm-dl / start.bat - the one file you can double-click, SELF-CONTAINED on
rem  purpose: ytm.bat may be missing (unpacked halfway, AV ate it), and an alias
rem  that only calls ytm.bat would then close the window without a word. Every
rem  step is echoed, the summary goes to ytm-dl-start.txt, every path ends in pause.
setlocal EnableExtensions EnableDelayedExpansion
set "HERE=%~dp0"
cd /d "!HERE!"
set "LOGF=!HERE!ytm-dl-start.txt"
set "T=0"
echo ======================================== ytm-dl start
echo folder: !HERE!
echo.
echo [1/4] files of the folder
for %%f in (ytm.bat setup.ps1 ytm-dl.ini app\companion.py app\control.py app\python\python.exe app\bin\ffmpeg.exe app\bin\deno.exe) do call :chk %%f
if not exist "!HERE!app\python\python.exe" echo       [WHY] no portable python here - run setup.ps1 once, right-click, Run with PowerShell
if not exist "!HERE!app\control.py" echo       [WHY] no app\control.py - the archive was unpacked halfway
if not exist "!HERE!ytm.bat" echo       [WHY] ytm.bat is missing from this folder - unpack the whole archive, not single files
if exist "!HERE!music" (echo       music: found) else (echo       music: not found, will be created)
echo.
echo [2/4] python
set "PYEXE=!HERE!app\python\python.exe"
if not exist "!PYEXE!" set "PYEXE=!HERE!app\python\bin\python.exe"
if not exist "!PYEXE!" set "PYEXE="
if not defined PYEXE (
  for /f "delims=" %%p in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%p"
)
if not defined PYEXE (
  echo       [WHY] python.exe is not in app\python and not in PATH. Run setup.ps1 once.
  goto :fin
)
echo       python: !PYEXE!
"!PYEXE!" -c "import sys;print('       version:', sys.version.split()[0])"
if errorlevel 1 echo       [WHY] python.exe exists but does not run. Copy the whole folder app\python, not only the exe.
if errorlevel 1 goto :fin
echo.
echo [3/4] engine
if not exist "!HERE!app\control.py" goto :eng
set "PATH=!HERE!app\bin;!PATH!"
"!PYEXE!" -u -X utf8 "!HERE!app\control.py" serve
if errorlevel 1 echo       control.py exited with code !errorlevel!
:eng
echo.
echo [4/4] is the address alive
> "!LOGF!" echo ytm-dl start: log of one click
>> "!LOGF!" echo folder: !HERE!
>> "!LOGF!" echo python: !PYEXE!
set "PORT=8765"
for /f "usebackq tokens=1* delims==" %%k in ("!HERE!ytm-dl.ini") do (
  if /I "%%k"=="port" set "PORT=%%l"
)
for /l %%i in (1,1,24) do call :poll %%i
echo       url: http://127.0.0.1:!PORT!
echo       open it in a browser - the answer must be a short json line.
echo       if the browser says "site not available", Windows Firewall or another
echo       proxy is the suspect, not this folder.
echo       Tampermonkey panel: button "proverka" must say the same port, 127.0.0.1 only.
:fin
echo.
echo this text is also in ytm-dl-start.txt, next to this file.
>> "!LOGF!" echo end of run, port: !PORT!
pause
endlocal
exit /b 0
:chk
if exist "!HERE!%~1" (echo       [yes] %~1) else (echo       [no ] %~1)
goto :eof
:poll
if !T! geq 24 goto :eof
set /a T+=1
curl -s -m 2 http://127.0.0.1:!PORT!/hello >nul 2>&1
if not errorlevel 1 (
  echo       server answers on port !PORT! after !T! tries - ok
  exit /b 0
)
timeout /t 1 >nul
goto :eof
"""


def build() -> bytes:
    """Текст → байты: echo-подстановки в кавычках, скобки сбалансированы, CRLF."""
    txt = BODY.strip("\n").replace("\r\n", "\n").replace("\n", "\n")
    # в echo-подстановках нужны !VAR!, иначе линтер прав на них не имеет; здесь
    # они и так записаны так, поэтому проверяем только инварианты формата
    diff = txt.count(")") - txt.count("(")
    lines = txt.split("\n")
    if diff > 0:                      # добираем парами в rem - единственное безопасное место
        k = next(i for i, l in enumerate(lines) if l.startswith("rem  ends with a pause"))
        lines[k] = lines[k] + " " + "()" * diff
    elif diff < 0:
        k = next(i for i, l in enumerate(lines) if l.startswith("rem  ends with a pause"))
        lines[k] = lines[k] + " " + "()" * (-diff)
    txt = "\n".join(lines) + "\n"
    data = txt.replace(CR, "").replace(LF, CR + LF).encode("ascii")
    assert data.count(b"(") == data.count(b")"), (data.count(b"("), data.count(b")"))
    assert b"\t" not in data and max(data) < 128
    assert data.count(LF.encode()) < 80, data.count(LF.encode())
    return data


if __name__ == "__main__":
    out = pathlib.Path(__file__).resolve().parent.parent / "win" / "start.bat"
    out.write_bytes(build())
    print("written", out, out.stat().st_size, "B,", out.read_bytes().count(b"\r\n"), "lines")
