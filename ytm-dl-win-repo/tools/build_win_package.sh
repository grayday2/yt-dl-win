#!/usr/bin/env bash
# Собирает портативную Windows-раскладку в dist/ytm-dl-win/ и упаковывает её в zip.
# Бинарники (python, ffmpeg) в архив НЕ кладём — их приносит setup.ps1 или пользователь;
# зато кладём README с точными URL и путями и прогоняем lint по .bat.
set -u
cd "$(dirname "$0")/.."
OUT=dist/ytm-dl-win
fail=0

rm -rf dist
mkdir -p "$OUT/app/bin" "$OUT/app/python" "$OUT/music" "$OUT/userscript"
cp server/companion.py app/control.py         "$OUT/app/"
cp userscript/ytm-downloader.user.js  "$OUT/userscript/"
cp win/ytm.bat win/start.bat win/setup.ps1 win/install-packages-offline.bat win/ytm-dl.ini win/ytm-dl.example.json win/README-WINDOWS.txt "$OUT/"
# diag-old.bat - НЕ запускатель, а_probe для старой папки. Один файл, в корне архива,
# архива, чтобы его можно было вынуть, не распаковывая всё (см. README-WINDOWS).
cp win/diag-old.bat "$OUT/"
cp win/ytm-run.bat "$OUT/"        # одноразовый отладчик: один файл, кладётся в любую папку
# pure-python wheels (py3-none-any) едут в архив: пакеты ставятся БЕЗ сети
if ls win/wheels/*.whl >/dev/null 2>&1; then
  mkdir -p "$OUT/wheels"; cp win/wheels/*.whl win/wheels/SHA256SUMS.txt win/wheels/manifest.json "$OUT/wheels/"
  echo "  ok   wheels: $(ls win/wheels/*.whl | wc -l) шт, $(du -sh win/wheels | cut -f1)"
else
  echo "  FAIL в win/wheels нет .whl — соберите их:  python3 -m pip download --no-deps --only-binary=:all: --dest win/wheels yt-dlp mutagen PySocks curl-cffi"
  fail=1
fi
# dist пересоздаётся, но музыкальная папка может содержать следы предыдущих прогонов
# (тесты пишут туда ytm-dl-server.log) - в архив они попасть не должны
find "$OUT/music" -mindepth 1 ! -name README-KEEP.txt -delete 2>/dev/null || true
rm -f "$OUT"/ytm-dl-log.txt "$OUT"/ytm-dl-error.txt "$OUT"/ytm-dl-diagnostic.txt "$OUT"/ytm-dl-report.txt
cat > "$OUT/app/python/PLACE-PYTHON.txt" <<'PLACE'
PORTABLE PYTHON - put the folder here as: app\python\python.exe
What you need: CPython 3.12 x86_64 windows "install_only" build
(pip included; companion also needs the offline wheels from wheels\).
Download (official, same URL setup.ps1 uses):
  https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only.tar.gz
Easiest: run setup.ps1 (double-click) - it downloads this and installs
the wheels itself. Manual way: unpack so that app\python\python.exe exists,
then run install-packages-offline.bat.
PLACE
cat > "$OUT/app/bin/PLACE-FFMPEG.txt" <<'PLACE'
BINARYS HERE - the folder app\bin must contain:
  ffmpeg.exe   (required)
  ffprobe.exe  (required)
  deno.exe     (optional - po-token helper; "ytm.bat deno" downloads it)
Download ffmpeg+ffprobe (official Windows build, same URL setup.ps1 uses):
  https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
  -> take the two .exe from the archive's bin\ folder and drop them HERE.
Easiest: run setup.ps1 - it downloads and unpacks them itself.
PLACE
printf 'finished files land here\n'                 > "$OUT/music/README-KEEP.txt"
printf 'Same companion works on Linux/macOS:  python3 app/companion.py --out ./music --check\n' \
  > "$OUT/RUNME-linux-macos.txt"

echo "════ CRLF для Windows-текстов ════"
python3 - "$OUT" <<'PYCRLF'
import sys, pathlib
for f in sorted(pathlib.Path(sys.argv[1]).rglob("*")):
    if f.is_file() and f.suffix.lower() in (".bat", ".ps1", ".ini", ".txt", ".py", ".json"):
        b = f.read_bytes()          # .py тоже: python читает CRLF так же, a notepad — только CRLF
        n = b.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        if n != b:
            f.write_bytes(n)
            print("  ok  ", f.relative_to(sys.argv[1]))
PYCRLF
[ $? -eq 0 ] || fail=1

echo "════ lint .bat: кавычки путей, метки goto, ASCII, CRLF ════"
python3 tools/lint_bats.py "$OUT"
[ $? -eq 0 ] || fail=1

echo "════ wheels: хэши + реальная офлайн-установка в чистый venv ════"
python3 - "$OUT" <<'PYWH'
import sys, json, hashlib, pathlib, subprocess, tempfile, shutil, re, os
root = pathlib.Path(sys.argv[1]); wh = root / "wheels"
fail = 0
man = json.loads((wh / "manifest.json").read_text(encoding="utf-8"))
for name, info in man.items():
    p = wh / name
    if not p.exists():
        print(f"  FAIL нет {name}"); fail = 1; continue
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    ok = h == info["sha256"] and p.stat().st_size == info["size"]
    print(f"  {'ok  ' if ok else 'FAIL'} {name}  {p.stat().st_size} B  {h[:16]}…")
    fail |= 0 if ok else 1
    if ("py3-none-any" not in name and not re.search(r"cp3[0-9]+-abi3", name)
            and not re.search(r"-cp312-cp312-win_amd64\.whl$", name)):   # встроенный python ровно 3.12/win64
        print(f"  FAIL {name}: не pure-python wheel — на Windows может не подойти"); fail = 1
if not fail:  # полный офлайн: свежий venv, pip без сети, ставим из собранной папки
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ytm-wheel-"))
    try:
        subprocess.run([sys.executable, "-m", "venv", str(tmp / "v")], check=True, capture_output=True)
        pyv = tmp / "v" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        env = {k: v for k, v in os.environ.items() if k not in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")}
        mode = "pip"
        try:
            subprocess.run([str(pyv), "-m", "pip", "install", "--no-index", "--no-cache-dir",
                            "--progress-bar", "off", "--find-links", str(wh),
                            "yt-dlp", "mutagen", "PySocks"], check=True, capture_output=True, text=True, env=env)
        except Exception as e:
            # pip - это ещё один интерпретатор: в песочнице с ~60 МБ free его снимает
            # OOM-killer (returncode < 0). Проверка от этого хуже не становится:
            # ставим те же файлы так, как их ставит pip (wheel = zip в site-packages),
            # и честно говорим, что pip-шаг не выполнялся
            if getattr(e, "returncode", 0) is not None and getattr(e, "returncode", 0) >= 0:
                raise
            mode = "zip->site-packages (pip убит OOM: не хватает памяти на второй интерпретатор)"
            sp = pathlib.Path(subprocess.run(
                [str(pyv), "-c", "import site;print(site.getsitepackages()[0])"],
                capture_output=True, text=True, check=True).stdout.strip())
            import zipfile
            for w in sorted(wh.glob("*.whl")):
                with zipfile.ZipFile(w) as z:
                    z.extractall(sp)
        out = subprocess.run([str(pyv), "-c",
                              "import yt_dlp, mutagen, socks, importlib.metadata as m;"
                              " print(m.version('yt-dlp'), m.version('mutagen'))"],
                             capture_output=True, text=True)
        if out.returncode != 0:   # metadata может отсутствовать при ручной распаковке
            out = subprocess.run([str(pyv), "-c",
                                  "import yt_dlp, mutagen;"
                                  " print(yt_dlp.version.__version__, mutagen.version_string)"],
                                 capture_output=True, text=True, check=True)
        print(f"  ok   офлайн-установка в чистый venv ({mode}): yt-dlp {out.stdout.split()[0]}, mutagen {out.stdout.split()[1]} (--no-index, сети не было)")
    except Exception as e:
        print("  FAIL офлайн-установка не прошла:", str(e)[-400:]); fail = 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
sys.exit(fail)
PYWH
[ $? -eq 0 ] || fail=1

echo "════ собранный companion и userscript ════"
# subprocess'ом, а не импортом: exec-модуль с @dataclass на Python 3.13 падает на
# sys.modules.get(cls.__module__). PYTHONDONTWRITEBYTECODE — чтобы __pycache__ не попал в zip
PYTHONDONTWRITEBYTECODE=1 python3 "$OUT/app/companion.py" --help >/dev/null 2>&1 \
  && echo "  ok   companion из dist запускается (--help)" \
  || { echo "  FAIL companion из dist не запускается"; fail=1; }
PYTHONDONTWRITEBYTECODE=1 python3 "$OUT/app/companion.py" --check --out "$OUT/music" 2>&1 \
  | grep -q "root : .*ytm-dl-win" \
  && echo "  ok   --check видит ROOT портативной папки" \
  || { echo "  FAIL --check не нашёл ROOT"; fail=1; }
PYTHONDONTWRITEBYTECODE=1 python3 "$OUT/app/control.py" --help >/dev/null 2>&1 \
  && echo "  ok   control.py из dist запускается (--help)" \
  || { echo "  FAIL control.py из dist не запускается"; fail=1; }
PYTHONDONTWRITEBYTECODE=1 python3 "$OUT/app/control.py" status 2>&1 | grep -q "== status" \
  && echo "  ok   control.py status работает на собранной папке" \
  || { echo "  FAIL control.py status не вывел отчёт"; fail=1; }
node --check "$OUT/userscript/ytm-downloader.user.js" \
  && echo "  ok   userscript парсится" || { echo "  FAIL userscript не парсится"; fail=1; }
cmp -s "$OUT/userscript/ytm-downloader.user.js" userscript/ytm-downloader.user.js \
  && echo "  ok   userscript в архиве = исходник" \
  || { echo "  FAIL userscript в архиве отличается от исходника"; fail=1; }
rm -rf "$OUT/app/__pycache__"
# dist-проверки (control.py status/selftest) сами пишут ytm-dl-* рядом с папкой -
# в архив они попасть не должны: там не должно быть ничего, кроме поставки
rm -f "$OUT"/ytm-dl-log.txt "$OUT"/ytm-dl-error.txt "$OUT"/ytm-dl-diagnostic.txt "$OUT"/ytm-dl-report.txt "$OUT"/../ytm-dl-report.txt

echo "════ zip + tar.gz (складываем в корень проекта, а не в dist/, чтобы файл было видно) ════"
python3 - "$OUT" <<'PYZIP'
import sys, zipfile, tarfile, pathlib, hashlib
root = pathlib.Path(sys.argv[1])
ws = root.parent.parent.parent              # dist/ytm-dl-win -> корень проекта
files = sorted(p for p in root.rglob("*")
               if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
made = []
for out in (ws / "ytm-dl-win.zip", root.parent / "ytm-dl-win.zip"):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, arcname=str(p.relative_to(root.parent)))
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
    assert bad is None, f"битый член в {out}: {bad}"
    made.append((out, len(files)))
for out in (ws / "ytm-dl-win.tar.gz", root.parent / "ytm-dl-win.tar.gz"):
    with tarfile.open(out, "w:gz") as tf:
        for p in files:
            tf.add(p, arcname=str(p.relative_to(root.parent)))
    with tarfile.open(out) as tf:
        n = len(tf.getmembers())
    made.append((out, n))
for p in files:
    print(f"  + {p.relative_to(root.parent)}  {p.stat().st_size:>8} B")
for out, n in made:
    print(f"\n{out.relative_to(ws)}: {out.stat().st_size} B, файлов {n}, sha256 {hashlib.sha256(out.read_bytes()).hexdigest()}")
PYZIP
[ $? -eq 0 ] || fail=1

# README не должен врать про хэш: пересборка меняет метаданные архива, поэтому строку
# с размерами/sha256 перезаписывает сама сборка
python3 tools/sync_readme_archives.py || fail=1

for f in ytm-dl-win.zip ytm-dl-win.tar.gz; do
  [ -s "$f" ] || { echo "  FAIL нет $f в корне проекта"; fail=1; }
done
[ $fail -eq 0 ] && echo "✅ готово: ./ytm-dl-win.zip и ./ytm-dl-win.tar.gz (копии — в dist/)" \
               || { echo "❌ сборка с проблемами"; exit 1; }
