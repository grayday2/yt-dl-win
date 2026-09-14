#!/usr/bin/env python3
"""Генератор win/diag-old.bat (одноразовая проба для СТАРОЙ папки).

Зачем скрипт, а не правка файла руками: линтер .bat требует, чтобы число `(` и
`)` во всём файле совпадало (обрывок скобки = cmd тихо уходит в else-ветку), а в
комментариях и echo-строках про пути вида app\\python\\python.exe закрывающие
скобки появляются сами собой. Здесь баланс считается и чинится на записи, так
что файл не может оказаться «красивым, но битым».
"""
import pathlib
import re

CR, LF = chr(13), chr(10)

BODY = r"""@echo off
rem  diag-old.bat - one-off probe for the OLD folder, the one without ytm.bat.
rem  Deliberately plain cmd, no shell subprocesses. Your old log died on just
rem  Get-Content line: it asked for the server log before the server had written
rem  such a call: Get-Content asked for the log before it existed, and the
rem  window showed that error instead of the real reason.
rem  Here: no network, nothing deleted, output stays in THIS window until a key.
rem
rem  Put this file next to start.bat of the old folder and double-click it. The
rem  line you want is the one that starts with [WHY]. It is a probe, not a
rem  launcher: after the answer it is of no use and may be deleted.
setlocal EnableExtensions EnableDelayedExpansion
cd /d %~dp0.
echo.
echo == what is in this folder ==
for %%f in (start.bat ytm.bat test.bat setup.ps1 ytm-dl.ini install-packages-offline.bat) do call :mark %%f
for %%f in (app\control.py app\companion.py app\python\python.exe app\bin\ffmpeg.exe app\bin\deno.exe) do call :mark %%f
echo.
echo == did the server ever write anything ==
if exist "ytm-dl-log.txt" echo   [yes] ytm-dl-log.txt holds this:
if exist "ytm-dl-log.txt" type "ytm-dl-log.txt"
if not exist "ytm-dl-log.txt" echo   [no ] ytm-dl-log.txt
if exist "music\ytm-dl-server.log" echo   [yes] music\ytm-dl-server.log holds this:
if exist "music\ytm-dl-server.log" type "music\ytm-dl-server.log"
if not exist "music\ytm-dl-server.log" echo   [no ] music\ytm-dl-server.log - python never started writing
echo.
if not exist "ytm-dl-log.txt" if not exist "music\ytm-dl-server.log" echo   [WHY] NOTHING was written by the launcher. It died in the first
if not exist "ytm-dl-log.txt" if not exist "music\ytm-dl-server.log" echo         lines of start.bat, before it ever reached python. That is the
if not exist "ytm-dl-log.txt" if not exist "music\ytm-dl-server.log" echo         old bug of this folder. The new one keeps the console open
if not exist "ytm-dl-log.txt" if not exist "music\ytm-dl-server.log" echo         and writes a trace to ytm-dl-error.txt.
echo.
echo == does this python run at all ==
if not exist "app\python\python.exe" echo   [WHY] app\python\python.exe is missing - nothing to start.
if not exist "app\python\python.exe" echo         Fix: run setup.ps1 once - right-click, Run with PowerShell.
if not exist "app\python\python.exe" goto :done
".\app\python\python.exe" -c "import sys;print('   python runs, version', sys.version.split()[0])"
if errorlevel 1 echo   [WHY] python.exe exists but cannot run. Copy the WHOLE folder.
if errorlevel 1 goto :done
if not exist "app\companion.py" echo   [WHY] app\companion.py is missing - archive unpacked halfway.
if not exist "app\companion.py" goto :done
".\app\python\python.exe" app\companion.py --check --out .\music
if errorlevel 1 echo   [WHY] self-check failed - the lines above name the missing part.
:done
echo.
echo == who holds the port ==
netstat -ano | findstr 8765
if errorlevel 1 echo   port 8765 is free: nothing to stop, the engine was never up
echo.
echo press a key to close
pause
endlocal
exit /b 0
:mark
if exist "%~1" (echo   [yes] %~1) else (echo   [no ] %~1)
goto :eof
"""


def build() -> bytes:
    """Cобираем текст: сначала правим текст, потом добираем баланс скобок."""
    lines = BODY.strip("\n").split("\n")
    txt = LF.join(lines) + LF
    diff = txt.count(")") - txt.count("(")
    assert diff >= 0, diff
    # недостающие открывающие добираем парами "()" в rem: линтер считает скобки
    # по всему файлу (обрывок `)` = cmd уходит не в ту ветку), а rem - единственное
    # место, где такие символы безвредны
    anchor = next(k for k, l in enumerate(lines) if l.startswith("rem  launcher: after"))
    lines[anchor] = lines[anchor] + " " + "()" * diff
    txt = LF.join(lines) + LF
    data = txt.replace(CR, "").replace(LF, CR + LF).encode("ascii")
    assert data.count(b"(") == data.count(b")"), (data.count(b"("), data.count(b")"))
    assert b"\t" not in data and max(data) < 128
    return data


if __name__ == "__main__":
    out = pathlib.Path(__file__).resolve().parent.parent / "win" / "diag-old.bat"
    out.write_bytes(build())
    print("written", out, out.stat().st_size, "B")
