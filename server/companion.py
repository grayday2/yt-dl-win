#!/usr/bin/env python3
"""
companion.py — локальный напарник для userscript'а YTM Downloader.

Почему он вообще нужен
----------------------
Userscript живёт в песочнице страницы: он НЕ может запустить ffmpeg, НЕ может
писать в произвольные папки, НЕ может держать очередь на 300 треков. Всё это —
работа «взрослого» процесса. Поэтому split такой:

    браузер (userscript)  ->  что он умеет лучше всех:
        * видит player response YouTube со всеми poToken/visitorData уже «в руках»;
        * имеет настоящие cookies и «домашний» IP;
        * рисует UI в панели плеера.
    companion (этот файл) ->  всё остальное:
        * скачивание/склейка медиа, remux, конвертация, теги, обложки;
        * очередь, ретраи, переиспользование уже скачанного.

Онтологически это тот же паттерн, что у Electron-приложений: renderer (UI) +
main (привилегированный слой). Только здесь «main» вынесен в отдельный процесс,
потому что у userscript'а нет никакой привилегии.

Запуск:
    python3 companion.py --port 8765 --out ~/Music/ytm
Опционально: pip install yt-dlp mutagen  (без mutagen теги пишются через ffmpeg).
"""
from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

try:  # необязательный, но приятный
    from mutagen.mp4 import MP4, MP4Cover, MP4Tags
    from mutagen.id3 import ID3, TIT2, TPE1, TALB, TCON, TDRC, TRCK, APIC, ID3NoHeaderError
    HAVE_MUTAGEN = True
except Exception:  # pragma: no cover
    HAVE_MUTAGEN = False

API_VERSION = "1"
APP_VERSION = "0.6.27"   # версия СБОРКИ (не протокола): её печатает баннер, отдаёт /hello и selftest - по ней в логах видно, что реально установлено
# Активные дочерние процессы (yt-dlp/ffmpeg). Нужны не для «красивости»: сервер, убитый
# извне, оставляет их висеть — и именно они держат открытыми файлы в music/, из-за чего
# папку нельзя удалить. Реестр даёт и /shutdown, и отчёту в логе что показывать.
CHILDREN: set = set()
CHILDREN_LOCK = threading.Lock()


PROXY_NONE_VALUES = ("none", "off", "direct", "0", "прямой", "без прокси")

# 0.6.16: единственный источник порядка клиентов для обеих дорог (url и playlist)
# и общего лечения «missing_pot». Правится здесь - действует везде.
CLIENT_CHAIN = ("web_safari", "", "tv", "web_embedded")
MISSING_POT = ["--extractor-args", "youtube:formats=missing_pot"]


def load_json_cfg(root: Path | None = None) -> tuple[dict, str]:
    """ytm-dl.json в корне программы - то же, что ini, только править в Блокноте
    приятнее (кавычки, а не «;»). Если файл есть, он ВАЖНЕЕ ini. Возвращает
    (cfg, строка-предупреждение); битый json не роняет запуск - работаем как без него."""
    p = (root or ROOT) / "ytm-dl.json"
    if not p.is_file():
        return {}, ""
    try:
        data = json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception as e:  # noqa: BLE001
        return {}, f"{p.name} не разобран ({str(e)[:120]}) - применяется только ytm-dl.ini"
    if not isinstance(data, dict):
        return {}, f"{p.name}: ожидается объект {{...}}, а не {type(data).__name__}"
    cfg = {str(k).lower(): v for k, v in data.items() if not str(k).startswith("//")}
    known = {"out", "port", "token", "organize", "proxy", "player_client",
             "cookies_from_browser", "cookies_file", "convert", "verify", "impersonate"}
    odd = [k for k in cfg if k not in known]
    if odd:
        return cfg, f"{p.name}: непонятные ключи {odd} (используются: {sorted(known)})"
    return cfg, ""


def norm_proxy(value) -> tuple[str, bool]:
    """(значение, «явно без прокси»). 'none'/'off'/'прямой' = не брать НИЧЕГО:
    ни строку из ini, ни системный прокси - «универсальная база без VPN»."""
    v = str(value or "").strip()
    if v.lower() in PROXY_NONE_VALUES:
        return "", True
    return v, False


def _run_tracked(cmd, **kw):
    """subprocess.run + регистрация ребёнка в CHILDREN (см. выше)."""
    kw = dict(kw)
    tmo = kw.pop("timeout", None)      # Popen timeout не принимает — он у communicate
    # capture_output — convenience-флаг subprocess.run, у Popen его нет:
    if kw.pop("capture_output", False):
        kw.setdefault("stdout", subprocess.PIPE)
        kw.setdefault("stderr", subprocess.PIPE)
    text = kw.pop("text", None)
    if text is not None:
        kw.setdefault("encoding", "utf-8" if text else None)
        if text:
            # 0.6.7: yt-dlp пишет в трубу что попало: cp1251 в локализованных
            # сообщениях, битые байты в названиях треков. strict-decode ронял
            # reader-поток subprocess (боевой лог: "0x92 in position 678"), попытка
            # возвращалась с ПУСТЫМ выводом и классифицировалась как «нет вывода» -
            # отсюда ложный «лимит аккаунта» и потерянные треки. replace съедает
            # мусор, ASCII-маркеры («ERROR: [youtube] id: ...») выживают полностью.
            kw.setdefault("errors", "replace")
    pr = subprocess.Popen(cmd, **kw)
    with CHILDREN_LOCK:
        CHILDREN.add(pr)
    try:
        out, err = pr.communicate(timeout=tmo)
    finally:
        with CHILDREN_LOCK:
            CHILDREN.discard(pr)
    return subprocess.CompletedProcess(cmd, pr.returncode, out, err)


class _StderrProxy:
    """stderr пишет в stdout: обёрнут один поток, а значит в --log-file попадает и
    трейс, и banner, и то, что обычный человек видит в окне."""

    def write(self, data):
        return sys.stdout.write(data)

    def flush(self):
        try:
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass

    def isatty(self):
        return False

    def fileno(self):
        return 2


def _ytm_log_line(text: str) -> None:
    """Строка прямо в sys._ytm_log (он открыт без буфера). Нужно потому, что print
    в этот момент идёт в консоль и оседает в её буфере: banner и трейс обязаны попасть
    в файл ДО того, как stdout обёрнут в него."""
    lg = getattr(sys, "_ytm_log", None)
    if lg is None:
        return
    try:
        lg.write((text + chr(10)).encode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        pass

def companion_pids(port: int) -> list[int]:
    """pid-ы, которые СЛУШАЮТ порт и помнят в командной строке companion.py.

    Ищем именно по командной строке: по имени образа (python.exe) мы не гадаем, иначе
    можно снять интерпретатор любой другой программы.
    """
    pids: set = set()
    ours: set = set()
    try:
        if os.name == "nt":
            r = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=20)
            for line in (r.stdout or "").splitlines():
                cols = line.split()
                if len(cols) >= 5 and cols[0].upper() == "TCP" and cols[3].upper() == "LISTENING" \
                        and cols[1].endswith(":" + str(port)):
                    try:
                        pids.add(int(cols[-1]))
                    except ValueError:
                        pass
            for pid in pids:
                try:
                    q = subprocess.run(["wmic", "process", "where", "processid=" + str(pid),
                                        "get", "commandline", "/value"], capture_output=True,
                                       text=True, encoding="utf-8", errors="replace", timeout=20)
                    if "companion.py" in (q.stdout or ""):
                        ours.add(pid)
                except Exception:  # noqa: BLE001  (wmic вырезан в сборках без WMI)
                    pass
        else:
            r = subprocess.run(["ss", "-lptn", "sport = :" + str(port)], capture_output=True,
                               text=True, timeout=20)
            for m in re.finditer(r"pid=(\d+)", r.stdout or ""):
                pids.add(int(m.group(1)))
            for pid in pids:
                try:
                    cl = Path("/proc", str(pid), "cmdline").read_bytes().decode("utf-8", "replace")
                except OSError:
                    continue
                if "companion.py" in cl:
                    ours.add(pid)
        return sorted(ours or pids)
    except Exception as e:  # noqa: BLE001  нет netstat/ss - не беда, просто не найдём
        print(f"  (список процессов на порту недоступен: {e})")
        return []


def stop_other_companion(port: int, token=None, wait: float = 6.0) -> bool:
    """Штатно гасит компаньона, занявшего порт: GET /shutdown, и только если не вышло -
    снятие процесса по pid. Возвращает True, если порт свободен.

    Специально без PowerShell: запускатель не имеет права зависнуть на остановке.
    """
    import urllib.error
    import urllib.request
    hello = "http://127.0.0.1:" + str(port) + "/hello"
    try:
        with urllib.request.urlopen(hello, timeout=2) as resp:
            body = resp.read(4096).decode("utf-8", "replace")
        if "ytm-dl-companion" not in body:
            print("  !! порт " + str(port) + " занят чужой программой - её не трогаем")
            return False
    except (urllib.error.URLError, OSError):
        return True                      # порт и так свободен
    hdr = {"X-YTM-Token": token} if token else {}
    try:
        req = urllib.request.Request("http://127.0.0.1:" + str(port) + "/shutdown", headers=hdr)
        with urllib.request.urlopen(req, timeout=4) as resp:
            msg = "previous companion stopped: " + resp.read(200).decode("utf-8", "replace").strip()
            print("  " + msg)
            _ytm_log_line(msg)
    except Exception as e:  # noqa: BLE001
        print("  /shutdown не сработал (" + type(e).__name__ + ") - снимаю по pid")
    t0 = time.time()
    while time.time() - t0 < wait:
        try:
            with urllib.request.urlopen(hello, timeout=1):
                pass
        except (urllib.error.URLError, OSError):
            print("  порт свободен")
            return True
        time.sleep(0.3)
    for pid in companion_pids(port):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                               text=True, timeout=20)
            else:
                os.kill(pid, 15)   # SIGTERM: у компаньона есть свой graceful exit
        except Exception:  # noqa: BLE001
            pass
    t0 = time.time()
    while time.time() - t0 < 4:
        try:
            with urllib.request.urlopen(hello, timeout=1):
                pass
        except (urllib.error.URLError, OSError):
            print("  порт свободен (после принудительной остановки)")
            return True
        time.sleep(0.3)
    print("  !! порт всё ещё занят - запусти ytm.bat kill")
    return False


def kill_children(sigkill: bool = True) -> int:
    """Снимает всех живых детей; возвращает сколько. Вызывается при остановке сервера."""
    with CHILDREN_LOCK:
        ps = list(CHILDREN)
    killed = 0
    for pr in ps:
        try:
            if pr.poll() is None:
                (pr.kill if sigkill else pr.terminate)()
                killed += 1
        except Exception:  # noqa: BLE001
            pass
    return killed


JOB_TTL_SEC = 60 * 60 * 6
MAX_JOBS_KEPT = 200


# --------------------------------------------------------------------------- utils

# Портативная раскладка: companion живёт в <корень>/app/, рядом кладутся
# python (app/python/), ffmpeg (app/bin/) и музыка (по умолчанию <корень>/music/).
# Всё это находится БЕЗ PATH и без установки «в систему» — то, ради чего сборку
# собирают в одну папку.
ROOT = Path(__file__).resolve().parent.parent


def env_path(var: str) -> Path | None:
    """Переменная окружения → существующий путь (для launcher'а и для тестов)."""
    v = os.environ.get(var)
    if not v:
        return None
    p = Path(v).expanduser()
    return p if p.exists() else None


def find_in_app(*subs: str, exe: str = "") -> Path | None:
    """Ищет файл внутри портативной папки (app/bin/ffmpeg.exe и т.п.)."""
    names = [Path(*subs)] + ([Path(*subs) / exe] if exe else [])
    for cand in names:
        p = ROOT / cand
        if p.exists():
            return p
        p2 = Path(__file__).resolve().parent / cand
        if p2.exists():
            return p2
    return None


JS_RUNTIMES = ("deno", "node", "bun", "quickjs")   # то, что понимает yt-dlp для po-token


def find_in_app_bin(name: str) -> str | None:
    """Портативный вариант: deno.exe/node.exe можно просто положить в app/bin.

    ВАЖНО: ищем именно ФАЙЛ. find_in_app() вернул бы и каталог app/bin/deno.exe/,
    если такой существует, — поэтому тут своя проверка is_file(), а не .exists().
    """
    suf = ".exe" if os.name == "nt" else ""
    for base in (ROOT / "app" / "bin", ROOT / "bin", Path(__file__).resolve().parent.parent / "app" / "bin"):
        for cand in (base / (name + suf), base / name):
            if cand.is_file() and os.access(cand, os.X_OK if os.name != "nt" else os.F_OK):
                return str(cand)
    return None


def find_js_runtime() -> list[str]:
    """Сначала app/bin (портативная папка), потом PATH. Возвращает пути, без дублей."""
    out: list[str] = []
    for n in JS_RUNTIMES:
        p = find_in_app_bin(n) or which(n)
        if p and p not in out:
            out.append(p)
    return out


def which(*names: str) -> str | None:
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def find_ffmpeg() -> str | None:
    """
    Порядок поиска (от «положил рядом» до «установлено в системе»):
      1. $YTMDL_FFMPEG                — явный путь (launcher/тесты);
      2. app/bin/ffmpeg[.exe], app/ffmpeg.exe — портативная папка;
      3. PATH;
      4. imageio-ffmpeg (колесо pip кладёт статик рядом с python).
    YTMDL_NO_FFMPEG=1 выключает шаги 3-4 - это честный способ проверить
    «что если в системе ничего нет», не ломая системный PATH (тесты/диагностика).
    """
    env = env_path("YTMDL_FFMPEG")
    if env:
        return str(env)
    for cand in ("bin/ffmpeg", "ffmpeg", "bin/ffmpeg.exe", "ffmpeg.exe"):
        p = find_in_app(*cand.split("/"))
        if p:
            return str(p)
    if os.environ.get("YTMDL_NO_FFMPEG"):
        return None
    exe = which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def pkg_version(mod: str) -> str | None:
    """Версия пакета так, чтобы не зависеть от того, есть ли у него __version__
    (у mutagen его НЕТ — есть version_string; у yt_dlp — только внутри yt_dlp.version)."""
    try:
        import importlib.metadata as md
        return md.version(mod)
    except Exception:  # noqa: BLE001
        try:
            m = __import__(mod)
            return str(getattr(m, "__version__", None) or getattr(m, "version_string", "?"))
        except Exception:
            return None


def find_python() -> str:
    """
    Интерпретатор, которым надо запускать yt-dlp как модуль (subprocess). Для
    портативной сборки критично: если этого не сделать, подпроцесс уйдёт в системный
    python без yt-dlp, и `url`/`playlist`-режимы свалятся в «yt-dlp не установлен».
      1. $YTMDL_PYTHON;
      2. app/python/python.exe (или bin/python);
      3. sys.executable (текущий интерпретатор — обычно и есть правильный).
    """
    env = env_path("YTMDL_PYTHON")
    if env:
        return str(env)
    # portable-раскладка python-build-standalone кладёт bin/ внутрь; вариант без bin/ —
    # когда содержимое архива распаковали «плоско»
    for cand in ("python/python.exe", "python/bin/python.exe", "python/python", "python/bin/python"):
        p = find_in_app(*cand.split("/"))
        if p:
            return str(p)
    return sys.executable


PYTHON = find_python()


_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]{0,127}")

AUTH_COOKIE_NAMES = ("sid", "hsid", "ssid", "apisid", "sapisid", "sidcc", "__secure-1psid",
                     "__secure-3psid", "__secure-1psidts", "__host-1psid", "__host-3psid")


SUPPORTED_BROWSERS = ("brave", "chrome", "chromium", "edge", "opera", "vivaldi", "whale",
                      "firefox", "safari")
CHROMIUM_BASED = ("brave", "chrome", "chromium", "edge", "opera", "vivaldi", "whale")
# регулярка yt-dlp (yt_dlp/__init__.py): name [+keyring] [:profile] [::container].
# (?!:) у profile нужен, иначе "::container" съедается двояко.
_SPEC_RE = re.compile(r"""(?x)
    (?P<name>[^+:]+)
    (?:\s*\+\s*(?P<keyring>[^:]+))?
    (?:\s*:\s*(?!:)(?P<profile>.+?))?
    (?:\s*::\s*(?P<container>.+))?
""")


def cookies_spec(spec) -> dict:
    r"""Разбор `firefox:U:\...\Data\profile::none` ровно как его делает yt-dlp.
    Возвращает {browser, profile, container} (пустые строки = не задано)."""
    raw = str(spec or "").strip()
    if not raw:
        return {"browser": "", "profile": "", "container": ""}
    m = _SPEC_RE.fullmatch(raw)
    if not m:
        return {"browser": raw, "profile": "", "container": ""}
    d = m.groupdict()
    return {"browser": (d.get("name") or "").strip().lower(),
            "profile": (d.get("profile") or "").strip().strip('"').strip("'"),
            "container": (d.get("container") or "").strip()}


def cookies_from_browser_tuple(spec):
    """(кортеж для opts["cookiesfrombrowser"] или None, подсказка-ошибка или "").

    Python-API yt-dlp принимает cookiesfrombrowser ТОЛЬКО кортежем
    (browser, profile, keyring, container); строку "firefox:<путь>" он парсит лишь в
    CLI. Без profile портативный Firefox не находится в принципе, поэтому кортеж
    важнее «просто передать строку как есть».
    """
    d = cookies_spec(spec)
    if not d["browser"]:
        return None, ""
    tup = (d["browser"], d["profile"] or None, None, d["container"] or None)
    hint = firefox_profile_check(d["browser"] + ((":" + d["profile"]) if d["profile"] else ""))
    return tup, hint


def ff_cookie_db(profile: str) -> str:
    """Есть ли в profile (или рядом) cookies.sqlite - той же логикой глоба, что и
    yt-dlp (_firefox_cookie_dbs: '', '*/', 'Profiles/*/'). '' если нет."""
    if not profile:
        return ""
    base = Path(os.path.expandvars(os.path.expanduser(profile)))
    if base.is_file() and base.name == "cookies.sqlite":
        return str(base)
    # тот же охват, что у yt-dlp (_firefox_cookie_dbs: '', '*/', 'Profiles/*/'), но
    # без магии: профиль может быть дан и как кореньPortableApps, и как ...\profile
    for root_dir in (base, base / "profile", base / "Profiles"):
        if not root_dir.is_dir():
            continue
        if (root_dir / "cookies.sqlite").is_file():
            return str(root_dir / "cookies.sqlite")
        try:
            for d1 in root_dir.iterdir():
                if not d1.is_dir():
                    continue
                if (d1 / "cookies.sqlite").is_file():
                    return str(d1 / "cookies.sqlite")
                try:
                    for d2 in d1.iterdir():
                        if d2.is_dir() and (d2 / "cookies.sqlite").is_file():
                            return str(d2 / "cookies.sqlite")
                except OSError:
                    continue
        except OSError:
            continue
    return ""


_PORTABLE_FF_CACHE: list | None = None


def portable_ff_roots() -> list:
    """Куда обычно кладут портативный Firefox (PortableApps/Firefox-Portable и проч.).
    Только подсказка человеку: yt-dlp сам эти папки не смотрит — на Windows у него
    в `_firefox_browser_dirs()` есть %APPDATA%\\Mozilla\\Firefox\\Profiles и папка
    MSStore, не больше. Каталог ищем, а не открываем: косяков на чужом дереве нам не надо."""
    global _PORTABLE_FF_CACHE
    if _PORTABLE_FF_CACHE is not None:
        return _PORTABLE_FF_CACHE
    roots = []
    for key in ("PortableAppsPath", "PortableAppsDirectory", "PortableAppsBaseDirectory"):
        v = os.environ.get(key)
        if v:
            roots.append(Path(v))
    roots.append(Path.home() / "PortableApps")
    if os.name == "nt":
        for drv in ("C:\\", "D:\\", "E:\\", "U:\\", "V:\\"):
            roots.append(Path(drv) / "PortableApps")
            roots.append(Path(drv))
    found = []
    for r in roots:
        try:
            if not r.is_dir():
                continue
            cands = sorted(pth for pth in r.glob("*Firefox*") if pth.is_dir())[:6]
            if not cands and (r / "PortableApps").is_dir():
                cands = sorted(p for p in (r / "PortableApps").glob("*Firefox*") if p.is_dir())[:6]
            for c in cands:
                for sub in (c / "Data" / "profile", c / "Data", c):
                    db = ff_cookie_db(str(sub))
                    if db:
                        found.append(db)
                        break
                if len(found) >= 4:
                    break
        except OSError:
            continue
    if found:
        _PORTABLE_FF_CACHE = found
        return found
    # ничего не нашли, но дерево похоже на PortableApps - кинем шаблон, по которому искать
    guess = [str(r / "FirefoxPortable" / "Data" / "profile")
             for r in roots if r.is_dir() and (r / "FirefoxPortable").is_dir()]
    return guess


def firefox_profile_check(spec) -> str:
    """Проверка ДО запуска yt-dlp: портативный/нестандартный Firefox находится только
    когда путь к профилю передан явно. Возвращает '' всё хорошо, иначе - текст подсказки
    (исключение не бросаем: пусть человек получит и нормальный вывод yt-dlp тоже)."""
    d = cookies_spec(spec)
    if d["browser"] != "firefox":
        return ""
    if d["profile"]:
        # путь может вести и в App\\Firefox64 (это программа, не профиль) - поправим
        db = ff_cookie_db(d["profile"])
        if db:
            return ""
        near = portable_ff_roots()
        return ("профиль firefox не найден по указанному пути: " + d["profile"]
                + " (нужна папка со cookies.sqlite). У PortableApps это обычно "
                + "...\\FirefoxPortable\\Data\\profile"
                + ("; рядом нашёл " + near[0] if near else ""))
    roots = [os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles"),
             str(Path.home() / ".mozilla" / "firefox"),
             str(Path.home() / ".var" / "app" / "org.mozilla.firefox" / ".mozilla" / "firefox")]
    for r in roots:
        if ff_cookie_db(r):
            return ""
    # профиль в %APPDATA% пустой, но человек, похоже, живёт в портативном Firefox:
    # подсказать конкретный путь вместо абстракции про «стандартные папки»
    near = portable_ff_roots()
    if near:
        return ("профиль firefox в стандартных папках не найден, а портативный — вот он: "
                + near[0] + "\n  yt-dlp сам туда не заглянет, пропиши его в ytm-dl.ini: "
                + "cookies_from_browser=firefox:" + str(Path(near[0]).parent))
    _PORTABLE_FF_CACHE = []
    return ("профиль firefox не найден в стандартных папках (%APPDATA%\\Mozilla\\Firefox\\Profiles). "
            "Портативный Firefox (PortableApps) там не живёт - укажите профиль прямо в ключе: "
            "cookies_from_browser=firefox:<путь>\\FirefoxPortable\\Data\\profile")




def cookies_txt_nearby(root=None, out_dir=None) -> str:
    """cookies.txt, который человек положил РЯДОМ с ytm.bat (или в папку вывода),
    но про который ytm-dl.ini ничего не знает. '' = искать негде/нечего.

    Это не «магия, ломающая конфиг», а пропуск в одну сторону: явный путь в ini или
    в командной строке всегда важнее. Смысл в том, что «кинул файл - и ничего не
    произошло» выглядит как сломанные куки, хотя на деле забыта одна строка в ini."""
    for base in (root, out_dir):
        if not base:
            continue
        try:
            p = Path(base).expanduser() / "cookies.txt"
            if p.is_file() and p.stat().st_size > 0:
                return str(p)
        except OSError:
            continue
    return ""


def cookies_report(root=None, browser=None, path_=None) -> tuple:
    """Честная диагностика «что у нас с cookies» для --check/selftest.

    Никогда не печатает ЗНАЧЕНИЯ cookie: файл рядом с mp3 - это ключ от аккаунта
    Google, и он не должен попадать ни в логи, ни в отчёты, которые просят прислать.
    Возвращает (ok, warn, detail).
    """
    def read_file(path: Path):
        try:
            raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            return None, f"не читается: {type(e).__name__}: {e}", False
        auth = 0
        yt = 0
        ts = 0
        bad = 0
        total = 0
        for ln in raw:
            l = ln.strip()
            if not l or l.startswith("#") and not l.startswith("#HttpOnly_"):
                continue
            if l.startswith("#HttpOnly_"):
                l = l[len("#HttpOnly_"):].strip()
            parts = l.split("\t")
            if len(parts) < 7:
                bad += 1
                continue
            dom = (parts[0] or "").lower()
            # 7 полей = curl/Netscape (имя в колонке 1, Mozilla-формат с #HttpOnly_),
            # в «локальных» экспортёрах имя иногда стоит в колонке 5 — принимаем оба
            cand = [c.strip().lower() for c in (parts[1], parts[5] if len(parts) > 5 else "")]
            name = next((c for c in cand if c and c not in ("true", "false") and _NAME_RE.fullmatch(c)),
                        cand[0])
            total += 1
            if "youtube" in dom or "googlevideo" in dom:
                yt += 1
            if name in AUTH_COOKIE_NAMES:
                auth += 1
            if name.endswith("psidts"):
                ts += 1
        age = ""
        try:
            d = (time.time() - path.stat().st_mtime) / 86400
            age = f", {int(d)} дн." if d >= 1 else ""
        except OSError:
            pass
        return (total, yt, auth, ts, bad, age), "", False

    browser = (browser or "").strip() or None
    path_ = (str(path_) if path_ else "").strip() or None
    auto = ""
    if not path_ and not browser:
        # файл лежит, а ini про него молчит: честнее сказать «найден, но не подключён»,
        # чем «none», из-за чего человек идёт искать опечатку в экспорте
        auto = cookies_txt_nearby(root)
    if path_:
        pp = Path(path_)
        if not pp.is_absolute() and root:
            pp = Path(root) / pp
        if not pp.is_file():
            return False, True, f"файла нет: {pp} — экспортируй cookies из браузера и перезапусти"
        r, err, _ = read_file(pp)
        if r is None:
            return False, True, f"{pp} — {err}"
        total, yt, auth, ts, bad, age = r
        if total == 0:
            return False, True, (f"{pp.name}: 0 строк (нужен формат Netscape: домены и имена "
                                "через TAB, а не JSON из Cookie-Editor)" + (f", битых строк {bad}" if bad else ""))
        if yt == 0:
            return False, True, f"{pp.name}: {total} cookie, но ни одного youtube/googlevideo — экспортируй с music.youtube.com"
        if auth == 0:
            return False, True, (f"{pp.name}: {total} cookie, youtube есть ({yt}), но нет ни одного "
                                 "авторизационного (SID/__Secure-1PSID) — похоже, ты был не залогинен "
                                 "в тот момент, когда экспортировал")
        return True, False, (f"файл {pp.name}: {yt} cookie youtube, вход есть ({auth}){age}"
                             + (f" — тонкий набор ({yt} из {total}): полный экспорт профиля "
                                "(все домены, включая google) вызывает у YouTube больше доверия, "
                                "чем cookies только вкладки" if yt < 50 else "")
                             + (" (автомат, из папки программы)" if auto else "")
                             + ("" if ts else "; нет __Secure-1PSIDTS — Google часто ротирует его в 2 неделях, обнови экспорт"))
    if browser:
        d = cookies_spec(browser)
        browser_name = d["browser"] or str(browser).strip()
        prof = d["profile"]
        if browser_name not in SUPPORTED_BROWSERS:
            return False, True, (f"неизвестный браузер '{browser_name}' — можно: chrome, edge, brave, "
                                 "opera, vivaldi, chromium, firefox, safari (профиль: firefox:<путь>)")
        if browser_name == "firefox" and prof:
            db = ff_cookie_db(prof)
            if db:
                wal = Path(db).parent / "cookies.sqlite-wal"
                return True, False, ("профиль firefox: " + db
                                     + (" — судя по -wal, браузер открыт: если yt-dlp скажет "
                                        "«database is locked», закройте Firefox, запустите движок "
                                        "и откройте браузер обратно" if wal.exists() else ""))
            # текст берём у той же проверки, что стоит перед запуском yt-dlp: иначе
            # selftest и реальная ошибка живут разными словами и человек не понимает,
            # какой путь ему вписать
            return False, True, (firefox_profile_check(str(browser))
                                 or ("указанного профиля firefox нет: " + prof
                                     + " (нужна папка со cookies.sqlite, у PortableApps это "
                                       "...\\FirefoxPortable\\Data\\profile)"))
        if browser_name == "firefox":
            _h = firefox_profile_check(str(browser))
            if _h:
                return False, True, _h
        browser = browser_name
        base = (Path(os.environ.get("LOCALAPPDATA", "")) if browser in CHROMIUM_BASED
                else Path(os.environ.get("APPDATA", ""))) if os.name == "nt" else Path.home()
        sub = {"brave": "BraveSoftware/Brave-Browser/User Data", "chrome": "Google/Chrome/User Data",
               "chromium": "Chromium/User Data", "edge": "Microsoft/Edge/User Data",
               "opera": "Opera Software/Opera Stable", "vivaldi": "Vivaldi/User Data",
               "whale": "Naver/Naver Whale/User Data"}.get(browser)
        prof = (base / sub.replace("/", os.sep) if sub else Path.home() / (".config/google-chrome"
                if browser == "chrome" else ".mozilla/firefox" if browser == "firefox"
                else "Library/Cookies")) if base else None
        have = bool(prof) and prof.is_dir()
        if not have:
            return False, True, f"профиль {browser} не найден ({prof}) — проверь имя браузера в ytm-dl.ini"
        if os.name == "nt" and browser in CHROMIUM_BASED:
            return False, True, (f"профиль {browser} найден, но на Windows Chromium 127+ держит cookies в "
                                 "app-bound encryption: 'Failed to decrypt with DPAPI' — это не мы, это yt-dlp. "
                                 "Надёжнее: экспорт в cookies.txt + cookies_file=cookies.txt")
        return True, False, f"читаем cookies из профиля {browser} (браузер лучше закрыть — профиль бывает залочен)"
    if auto:
        return True, False, ("файл " + Path(auto).name + " в корне программы (автоматически; "
                             "в ytm-dl.ini cookies_file пуст - строка необязательна)")
    return False, True, ("none — режимы browser/ytdlp и «понравившееся» упрутся в бот-чек; "
                         "решение: экспортировать cookies с music.youtube.com в cookies.txt и "
                         "cookies_file=cookies.txt в ytm-dl.ini (файл, положенный рядом, "
                         "подхватывается сам — нужен перезапуск движка)")


def proxy_report(pr: str | None = None, why: str = "", have_socks: bool = True) -> tuple:
    """«Чем ходят yt-dlp и обложки» - то, на чём всё ломается в РФ: браузер может быть
    через прокси, а python-процесс - напрямую, и тогда байты не доедут никогда.
    (ok, warn, detail)."""
    pr = str(pr or "").strip()
    if pr:
        socks = pr.lower().startswith("socks")
        if socks:
            how = ("socks5: yt-dlp проходит через него сам (у него свой транспорт); "
                   "обложкам через socks " + ("нужен PySocks - он есть в wheels/"
                                             if not have_socks else "нужен PySocks - установлен"))
        else:
            how = "http/https"
        tail = " · yt-dlp (url/browser/playlist) и обложки идут через него"
        src = " · " + why if why else ""
        return True, False, how + " " + pr + tail + src
    return False, True, ("proxy= пуст, системного прокси нет: yt-dlp и обложки ходят напрямую - "
                         "если браузер у тебя через VPN/прокси, добавь proxy=http://127.0.0.1:<порт> "
                         "или proxy=socks5://127.0.0.1:<порт> (PySocks теперь в поставке)")


def effective_proxy(explicit: str | None = None) -> tuple:
    """Один источник правды для --check, баннера и job'ов: (значение, почему)."""
    return decide_proxy(explicit, system_proxy_settings(), socks_module_available())


_HAS_CURL_CFFI = None   # None = ещё не проверяли; проба - subprocess, делаем один раз


def _has_curl_cffi() -> bool:
    """Импортируется ли curl_cffi нашим встроенным python - значит у yt-dlp есть
    --impersonate: TLS/HTTP2-отпечаток настоящего браузера вместо python-подписи,
    которая у YouTube всё чаще вызывает «бот-чек при валидных cookies»."""
    global _HAS_CURL_CFFI
    if _HAS_CURL_CFFI is None:
        try:
            r = subprocess.run([PYTHON, "-c", "import curl_cffi"],
                               capture_output=True, text=True, timeout=60)
            _HAS_CURL_CFFI = r.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            _HAS_CURL_CFFI = False
    return _HAS_CURL_CFFI


def impersonate_target(cfg=None) -> "str | None":
    """Ключ `impersonate` (ini -> CLI --impersonate, json важнее): auto | off | <цель>.
    auto = 'chrome', если curl_cffi установлен (в поставке колесо в wheels/ ставится
    install-packages-offline.bat); off = не трогать (поведение <=0.5.5); явная цель
    ('edge-130', 'chrome-116:windows-10'...) передаётся yt-dlp как есть."""
    if cfg is None:
        cfg = getattr(Handler, "cfg", None) or {}
    v = str(cfg.get("impersonate") or "auto").strip()
    if not v or v.lower() in ("auto", "1", "on", "yes"):
        return "chrome" if _has_curl_cffi() else None
    if v.lower() in ("off", "none", "0", "no"):
        return None
    return v


def _alt_host_allowed(job: "Job") -> bool:
    """0.5.9: «youtube.com как запас» включается ТОЛЬКО галочкой панели. Смысл
    значения host_pref="www" стал строже, чем в 0.5.6: это не приоритет хостов
    (порядок всегда Music -> www), а РАЗРЕШЕНИЕ второго круга на видеохостинге.
    Без галочки полоса честно падает на Music - ничего не происходит «само»."""
    return str(job.meta.get("host_pref") or "") == "www"



def run_check(out_dir: Path | str, cookies_browser: str | None = None,
            cookies_path: str | None = None, proxy: tuple | None = None) -> int:
    """
    `python companion.py --check` — самодиагностика портативной папки: launcher зовёт
    её при каждом старте, чтобы «не работает» превращалось в конкретную строку про
    отсутствующий exe, а не в тихий деградированный режим.
    Выход: 0 = готов, 1 = чего-то критичного нет.
    """
    def line(ok_, name, detail="", kind="hard"):
        mark = "ok  " if ok_ else ("FAIL" if kind == "hard" else "warn")
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))
        return (not ok_) and kind == "hard", (not ok_) and kind != "hard"

    bad = warn = False
    print(f"ytm-dl companion {APP_VERSION} · self-check\n  root : {ROOT}")
    d = Path(out_dir)
    r, w = False, ""
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".ytm-write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        r, w = True, f"{d}  (запись ок)"
    except OSError as e:
        w = f"{d} — {e}"
    b, _ = line(r, "папка назначения", w); bad = bad or b

    b, _ = line(bool(FF.ok), "ffmpeg", str(FF.ffmpeg or "не найден: app/bin/ffmpeg.exe или PATH")); bad = bad or b
    b, _ = line(bool(FF.ffprobe), "ffprobe", str(FF.ffprobe or "нет — длительность берём из отчёта ffmpeg"), "soft")

    for kind, name, mod in (("hard", "mutagen (теги/обложки)", "mutagen"), ("soft", "yt-dlp (resolve/playlist)", "yt_dlp")):
        r, w = False, "?"
        try:
            probe = ("import importlib.metadata as m;print(m.version('yt-dlp'))" if mod == "yt_dlp"
                     else "import mutagen;print(mutagen.version_string)")
            pr = subprocess.run([PYTHON, "-c", probe],
                                capture_output=True, text=True, timeout=90)
            r, w = pr.returncode == 0, ((pr.stdout or pr.stderr).strip().splitlines() or ["?"])[-1][:120]
        except Exception as e:  # noqa: BLE001
            w = f"не удалось запустить {PYTHON}: {e}"
        b, _ = line(r, name, f"{w} · python={PYTHON}", kind); bad = bad or b

    try:  # отдельная проверка запуска yt-dlp как модуля: на неё спотыкаются url/playlist
        pr = subprocess.run([PYTHON, "-m", "yt_dlp", "--version"], capture_output=True, text=True, timeout=90)
        r, w = pr.returncode == 0, ((pr.stdout or pr.stderr).strip().splitlines() or ["?"])[-1][:120]
    except Exception as e:  # noqa: BLE001
        r, w = False, str(e)[:120]
    b, _ = line(r, "yt-dlp как модуль (url/playlist)", f"{w} · python={PYTHON}"); bad = bad or b

    imp = impersonate_target()
    b, _ = line(bool(imp), "impersonate (curl_cffi)",
                f"{imp} - TLS/HTTP2-отпечаток настоящего браузера" if imp
                else "не установлен - прогони install-packages-offline.bat "
                     "(колесо curl-cffi лежит в архиве)", "soft")

    rt = find_js_runtime()
    b, _ = line(bool(rt), "JS-runtime для yt-dlp (po-token)",
                ", ".join(rt) or "нет — часть запросов упрётся в бот-чек. Лечится без установки: положи deno.exe в папку app\\bin (рядом с ffmpeg.exe)", "soft")


    a = archive_path(d)
    b, _ = line(True, "архив «уже скачано»", f"{a} ({len(read_archive(d))} записей)", "soft")
    ck, wk, cdet = cookies_report(ROOT, cookies_browser, cookies_path)
    b, _ = line(ck, "cookies (доступ к аккаунту)", cdet, "soft")
    warn = warn or wk
    _pv, _pw2 = proxy if isinstance(proxy, tuple) else (proxy, "из ytm-dl.ini")
    pk, pw, pdet = proxy_report(_pv, _pw2, socks_module_available())
    b, _ = line(pk, "proxy (чем ходит yt-dlp)", pdet, "soft")
    warn = warn or pw
    print("  " + ("готово к работе" if not bad else "ЕСТЬ ПРОБЛЕМЫ — см. FAIL выше"))
    return 1 if bad else 0


def sniff_container(path: Path) -> str:
    """Настоящий контейнер по первым байтам - единственное, чему можно верить при
    переименовании: `%(ext)s` у yt-dlp бывает `unknown_video`, а `f.container` из
    player response - `'bin'`, когда mime не опознан."""
    try:
        with path.open("rb") as f:
            head = f.read(64)
    except OSError:
        return ""
    if head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"skip",
                     b"styp", b"moof", b"sidx", b"uuid"):
        return "m4a"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    if head[:4] in (b"\x04\x00\x00\x00", b"\x05\x00\x00\x00"):
        return "mp4"                      # raw MPD/ISO-BMFF без ftyp: всё равно mp4-семейство
    return ""


def looks_like_html_bytes(data: bytes) -> bool:
    d = (data or b"")[:240]
    if b"\x00" in d[:64]:
        return False
    head = d.decode("utf-8", "replace")
    return bool(re.search(r"<\s*(!?doctype|html|head|body|meta)", head, re.I))


def looks_like_html(path: Path) -> bool:
    """Первые байты - текст с тегом. Ровно так выглядит ответ googlevideo, когда
    YouTube вместо потока отдаёт страницу «подтвердите, что вы не бот» или редирект."""
    try:
        with path.open("rb") as f:
            head = f.read(512)
    except OSError:
        return False
    if b"\x00" in head[:64]:
        return False                      # в медиа-потоке NUL в первых байтах не бывает
    low = head[:256].lower()
    return (b"<html" in low or b"<!doctype" in low or b"<?xml" in low
            or b"<Error" in head[:256] or b"sign in to confirm" in low
            or b"unusual traffic" in low or b"captcha" in low)


def _real_name(p: Path) -> Path:
    """yt-dlp при `--load-info-json` иногда пишет `id.unknown_video`: расширение
    берётся из info-dict, которого у нас нет. Если байты опознаются - переименовываем
    честно, иначе плеер получает файл без контейнера и «не понимает, что это»."""
    suffix = p.suffix.lower().lstrip(".")
    if suffix and not suffix.startswith("unknown") and suffix not in ("part", "tmp"):
        return p
    kind = sniff_container(p)
    if not kind or kind == suffix:
        return p
    q = p.with_name(p.stem + "." + kind)
    try:
        p.replace(q)
        return q
    except OSError:
        return p


def safe_name(name: str, maxlen: int = 120) -> str:
    """Санитизация имени файла: userscript присылает данные со страницы, доверять им нельзя."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "")
    name = re.sub(r"\s+", " ", name).strip().strip(".")
    if not name:
        name = "track"
    return name[:maxlen]


def probe_durations(ffprobe: str | None, path: Path) -> tuple[float | None, float | None]:
    """(duration_of_input, duration_of_output) — используется в тестах для проверки полноты файла."""
    if not ffprobe:
        return None, None
    def dur(p):
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "json", str(p)], capture_output=True, text=True, timeout=60)
            return float(json.loads(out.stdout)["format"]["duration"])
        except Exception:
            return None
    return dur(path), dur(path)


def _jsonable(obj):
    """Path/bytes внутри meta ломают json.dumps (реальный баг: finalize() клал Path в
    job.meta['dest'] -> /job/<id> отдавал 500, а расширения — «неизвестная ошибка»).
    Прокручиваем словарь, приводя всё не-JSON-ное к строкам."""
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(x) for x in obj]
    if isinstance(obj, (bytes, bytearray)):
        return len(obj)
    if hasattr(obj, "__fspath__"):
        return str(obj)
    return obj


# --------------------------------------------------------------------------- jobs

@dataclass
class Job:
    id: str
    kind: str                      # "media" | "browser" | "url"
    dest: Path
    status: str = "queued"          # queued|running|done|error
    progress: float = 0.0
    message: str = ""
    created: float = field(default_factory=time.time)
    finished: float | None = None
    error: str | None = None
    cancelled: bool = False          # 0.6.4: кнопка «стоп»: чекпойнты handlers'ов её читают
    meta: dict = field(default_factory=dict)
    logs: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return _jsonable({
            "id": self.id, "kind": self.kind, "status": self.status,
            "progress": round(self.progress, 3), "message": self.message,
            "error": self.error, "cancelled": self.cancelled,
            "dest": str(self.dest), "meta": self.meta,
            "created": self.created, "finished": self.finished,
            "logs": self.logs[-40:],
        })


class Queue:
    """Последовательная очередь. Параллелить нельзя: YouTube режет скорость на конкурентные сессии."""

    def __init__(self, max_workers: int = 1):
        self._q: list[Job] = []
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._workers = [threading.Thread(target=self._run, daemon=True) for _ in range(max_workers)]
        self._started = False

    def start(self):
        with self._lock:
            if self._started:
                return
            self._started = True
            for w in self._workers:
                w.start()

    def submit(self, job: Job) -> Job:
        with self._lock:
            self._jobs[job.id] = job
            self._q.append(job)
            self._cv.notify()
            self._gc_locked()
        return job

    def active(self) -> int:
        """Сколько задач ещё не завершены (для /status и /shutdown)."""
        with self._lock:
            return sum(1 for j in self._jobs.values() if j.status not in ("done", "error", "cancelled"))

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _gc_locked(self):
        if len(self._jobs) <= MAX_JOBS_KEPT:
            return
        dead = sorted((j for j in self._jobs.values()
                       if j.status in ("done", "error") and time.time() - (j.finished or j.created) > JOB_TTL_SEC),
                      key=lambda j: j.created)
        for j in dead:
            self._jobs.pop(j.id, None)

    def _run(self):
        while True:
            with self._cv:
                while not self._q:
                    self._cv.wait(0.5)
                job = self._q.pop(0)
            if job.cancelled:   # 0.6.4: сняли, пока ждала в очереди
                job.status = "cancelled"
                job.finished = time.time()
                continue
            try:
                job.status = "running"
                HANDLERS[job.kind](job)
                job.status = "cancelled" if job.cancelled else "done"
                job.progress = 1.0
                job.finished = time.time()
            except Exception as e:  # noqa: BLE001 - любое падение должно быть видно в UI
                if job.cancelled:
                    # чекпойнт между попытками бросил исключение - это НЕ ошибка,
                    # это пользовательская остановка; красить её в error не за чем
                    job.status = "cancelled"
                else:
                    job.status = "error"
                    job.error = f"{type(e).__name__}: {e}"
                    job.logs.append(traceback.format_exc(limit=6))
                    print(f"[job {job.id}] {job.error}", file=sys.stderr)
                job.finished = time.time()


# --------------------------------------------------------------------------- persistent throttle queue

_THROTTLE_META_KEYS = {
    "cookies_file", "proxy", "format", "format_spec", "out_dir", "organize",
    "dedup", "title", "artist", "album", "thumbnail",
}


class ThrottleQueue:
    """Small, deliberately boring persistent queue for YouTube account limits.

    The on-disk format contains only portable retry state (an interval, never an
    absolute deadline).  ``retry_until`` is an in-memory lease used to prevent a
    monitor tick or a second HTTP request from submitting the same video twice.
    """
    def __init__(self, out_dir: Path | str, clock=None):
        self.out_dir = Path(out_dir)
        self.path = self.out_dir / ".ytm-throttle-queue.json"
        self.clock = clock or time.time
        self._lock = threading.RLock()
        self._records: dict[str, dict] = {}
        self._leases: dict[str, float] = {}
        self._load()
        self.sync_archive()

    def _load(self):
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            rows = raw.get("items", raw) if isinstance(raw, dict) else raw
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, dict) and row.get("vid"):
                        self._records[str(row["vid"])] = dict(row)
        except (OSError, ValueError, TypeError):
            pass

    def _save(self):
        self.out_dir.mkdir(parents=True, exist_ok=True)
        rows = []
        for row in self._records.values():
            # Lease is intentionally not persisted: a restart must not turn a
            # clock-relative backoff into an absolute retry deadline.
            rows.append({k: v for k, v in row.items() if k != "retry_until"})
        tmp = self.path.with_name(self.path.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"version": 1, "items": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    @staticmethod
    def _meta(meta: dict | None) -> dict:
        meta = meta or {}
        return {k: _jsonable(meta[k]) for k in _THROTTLE_META_KEYS if k in meta and meta[k] is not None}

    def sync_archive(self):
        archived = set(read_archive(self.out_dir))
        with self._lock:
            changed = [vid for vid in self._records if vid in archived]
            for vid in changed:
                self._records.pop(vid, None)
                self._leases.pop(vid, None)
            if changed:
                self._save()
        return len(changed)

    def add(self, vid: str, meta=None, backoff_seconds=7200, attempt=0,
            status="throttled", reason=None):
        vid = str(vid or "").strip()
        if not vid:
            return {"ok": False, "reason": "missing videoId"}
        with self._lock:
            if vid in self._records:
                return {"ok": False, "duplicate": True, "item": dict(self._records[vid])}
            row = {"vid": vid, "throttled_at": self.clock(),
                   "backoff_seconds": max(1, int(backoff_seconds)),
                   "attempt": max(0, int(attempt)), "status": status,
                   "meta": self._meta(meta)}
            if reason:
                row["reason"] = str(reason)[:300]
            self._records[vid] = row
            self._save()
            return {"ok": True, "duplicate": False, "item": dict(row)}

    enqueue = add

    def get_ready(self, now=None):
        now = self.clock() if now is None else now
        ready = []
        with self._lock:
            for vid, row in self._records.items():
                if row.get("status") != "throttled":
                    continue
                # Wall clocks can move backwards; restart the interval rather
                # than immediately unleashing every queued request.
                elapsed = now - float(row.get("throttled_at", now))
                if elapsed < 0:
                    row["throttled_at"] = now
                    self._save()
                    continue
                if elapsed >= max(1, int(row.get("backoff_seconds", 7200))):
                    lease = self._leases.get(vid, 0)
                    if lease <= now:
                        ready.append(dict(row))
        return ready

    def lease(self, vid, now=None, seconds=300):
        now = self.clock() if now is None else now
        with self._lock:
            row = self._records.get(str(vid))
            if not row or row.get("status") != "throttled":
                return False
            if self._leases.get(str(vid), 0) > now:
                return False
            self._leases[str(vid)] = now + seconds
            row["retry_until"] = now + seconds
            return True

    def mark_failed(self, vid, reason="attempt limit"):
        with self._lock:
            row = self._records.get(str(vid))
            if not row:
                return False
            row["status"] = "failed"
            row["reason"] = str(reason)[:300]
            self._leases.pop(str(vid), None)
            self._save()
            return True

    def remove(self, vid):
        with self._lock:
            existed = self._records.pop(str(vid), None) is not None
            self._leases.pop(str(vid), None)
            if existed:
                self._save()
            return existed

    def list(self):
        with self._lock:
            return [dict(x) for x in self._records.values()]

    def status(self):
        rows = self.list()
        now = self.clock()
        return {"total": len(rows),
                "waiting": sum(1 for x in rows if x.get("status") == "throttled" and x["vid"] not in self._leases),
                "in_flight": sum(1 for x in rows if self._leases.get(x["vid"], 0) > now),
                "failed": sum(1 for x in rows if x.get("status") == "failed"),
                "items": rows}

    def retry_now(self, vid=None):
        with self._lock:
            rows = self._records.values() if vid is None else [self._records.get(str(vid))]
            n = 0
            for row in rows:
                if row and row.get("status") == "throttled":
                    row["throttled_at"] = self.clock() - max(1, int(row.get("backoff_seconds", 7200)))
                    n += 1
            if n:
                self._save()
            return n

    def clear(self, vid=None):
        with self._lock:
            if vid is None:
                n = len(self._records); self._records.clear(); self._leases.clear()
            else:
                n = 1 if self._records.pop(str(vid), None) else 0; self._leases.pop(str(vid), None)
            if n:
                self._save()
            return n
    def pump(self, queue, max_attempt=6):
        """Lease ready rows and put them on the existing serial Queue."""
        submitted = []
        for row in self.get_ready():
            vid = row["vid"]
            if int(row.get("attempt", 0)) >= max_attempt:
                self.mark_failed(vid, "достигнут предел попыток")
                continue
            if not self.lease(vid):
                continue
            meta = dict(row.get("meta") or {})
            meta.update({"videoId": vid, "url": f"https://music.youtube.com/watch?v={vid}",
                         "throttle_retry": True})
            job = Job(id=uuid.uuid4().hex[:12], kind="url", dest=self.out_dir / "pending")
            job.meta = meta
            queue.submit(job)
            row["attempt"] = int(row.get("attempt", 0)) + 1
            self._records[vid]["attempt"] = row["attempt"]
            self._save()
            submitted.append(job)
        return submitted


def _queue_throttled(job, vid, reason="лимит YouTube"):
    """Best-effort bridge used by all three integration points."""
    tq = getattr(Handler, "throttle", None) if "Handler" in globals() else None
    if not tq or not vid or job.meta.get("throttle_retry"):
        return None
    meta = dict(job.meta)
    meta.setdefault("meta", {})
    for k, v in (job.meta.get("meta") or {}).items():
        meta.setdefault(k, v)
    result = tq.add(str(vid), meta, reason=reason)
    if result.get("duplicate"):
        job.logs.append("throttle queue: duplicate " + str(vid))
    else:
        job.logs.append("throttle queue: added " + str(vid))
    return result


# --------------------------------------------------------------------------- ffmpeg

class Ffmpeg:
    def __init__(self):
        self.ffmpeg = find_ffmpeg()
        self.ffprobe = which("ffprobe") or (
            self.ffmpeg.replace("ffmpeg", "ffprobe") if self.ffmpeg else None)
        if self.ffprobe and not Path(self.ffprobe).exists():
            self.ffprobe = None

    @property
    def ok(self) -> bool:
        return bool(self.ffmpeg)

    def run(self, args: list[str], job: Job | None = None, timeout: int = 3600) -> str:
        cmd = [self.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", *args]
        if job:
            job.logs.append(" ".join(cmd[-8:]))
        p = _run_tracked(cmd, capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0:
            raise RuntimeError(f"ffmpeg exit {p.returncode}: {p.stderr[-600:]}")
        return p.stdout

    def remux(self, src: Path, dst: Path, job: Job | None = None) -> Path:
        """Без перекодирования: из 'сырых' фрагментов/frag-mp4 в нормальный контейнер."""
        self.run(["-err_detect", "ignore_err", "-fflags", "+genpts+discardcorrupt",
                  "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(dst)], job)
        return dst

    def to_mp3(self, src: Path, dst: Path, bitrate: str = "320k", job: Job | None = None) -> Path:
        self.run(["-i", str(src), "-vn", "-codec:a", "libmp3lame", "-b:a", bitrate, str(dst)], job)
        return dst

    def duration(self, path: Path) -> float | None:
        # ffprobe есть не во всех сборках (wheel imageio-ffmpeg не содержит его вовсе) —
        # тогда вытаскиваем Duration из отчёта ffmpeg об input: он пишется и без ffprobe.
        if not self.ffprobe:
            if not self.ffmpeg:
                return None
            try:
                p = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(path)],
                                   capture_output=True, text=True, timeout=60)
                m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", (p.stderr or "") + (p.stdout or ""))
                if not m:
                    return None
                return float(m.group(1)) * 3600 + float(m.group(2)) * 60 + float(m.group(3))
            except Exception:
                return None
        try:
            out = subprocess.run([self.ffprobe, "-v", "error", "-show_entries",
                                  "format=duration", "-of", "json", str(path)],
                                 capture_output=True, text=True, timeout=60)
            return float(json.loads(out.stdout)["format"]["duration"])
        except Exception:
            return None


FF = Ffmpeg()


# --------------------------------------------------------------------------- tagging

TAG_MAP_ID3 = {  # для .mp3
    "title": ("TIT2", lambda v: v),
    "artist": ("TPE1", lambda v: v),
    "album": ("TALB", lambda v: v),
    "genre": ("TCON", lambda v: v),
    "date": ("TDRC", lambda v: v),
    "track": ("TRCK", lambda v: v),
    # 0.6.10: mp3-пути TPE2 не хватало - «Исполнитель альбома» в свойствах
    # Windows оставался пустым даже при известном артисте.
    "albumartist": ("TPE2", lambda v: v),
}
# MP4/M4A используют ковровые атомы iTunes
TAG_MAP_MP4 = {
    "title": "\xa9nam", "artist": "\xa9ART", "album": "\xa9alb",
    # 0.6.10: "gnre" в mutagen только читается (числовой ID, рендерер None) -
    # как только жанр впервые доехал до этой ветки из info.json, он ронял
    # ВСЁ тегирование m4a на TypeError. Пишем текстовый ©gen - его понимают все.
    "genre": "\xa9gen", "date": "\xa9day", "track": "trkn", "albumartist": "aART",
    "composer": "\xa9wrt", "comment": "\xa9cmt",
}


def clean_title(title, artist) -> str:
    """0.6.11: «MAK DADDY - Bezos» в поле «Название» - это заголовок ролика на
    YouTube, а не трек. Если заголовок начинается с «Артист <тире>», префикс
    срезается И в тегах, и в имени файла (они всегда должны совпадать). Без
    известного артиста не гадаем: «A - B» само по себе может быть названием."""
    t = str(title or "").strip()
    a = str(artist or "").strip()
    if not t or not a:
        return t
    # 0.6.14: YTM кладёт в DOM-строки NBSP/узкие пробелы - по буквальному
    # совпадению префикс «1nonly и Shakewell - » не срезался. Сопоставляем по
    # словам с гибкими пробелами, а режем из оригинала (регистр не трогаем).
    def _flex(s: str) -> str:
        s = re.sub(r"[\u00a0\u202f\u2007\u2009]", " ", s)
        return r"\s+".join(re.escape(w) for w in s.split())
    # 0.6.16: артист в тегах чинится через запятую (0.6.14), а youtube-заголовок
    # хранит «A и B»/«A & B» - сравниваем со всеми склейками, иначе префикс
    # выживал ровно на фитах («1nonly, Shakewell - WHO GON' SLIDE» в бою).
    variants = [a]
    if "," in a:
        variants += [a.replace(", ", " \u0438 "), a.replace(", ", " & "), a.replace(", ", " feat. ")]
    for av in variants:
        m = re.match(r"^\s*%s\s*[-\u2013\u2014\u2012\u2015]\s*(.+)$" % _flex(av), t,
                     re.IGNORECASE | re.UNICODE)
        if m:
            rest = m.group(1).strip()
            if len(rest) >= 2:
                return rest
    return t


def sniff_image(data: bytes) -> tuple:
    """(расширение, mime) настоящей картинки. Обложки YTM приходят webp, а covr в
    mp4/msfv принимает только jpeg/png - врать про image/jpeg нельзя, часть
    плееров на «jpg, а внутри webp» показывает пустую обложку."""
    d = data or b""
    if d[:4] == b"RIFF" and d[8:12] == b"WEBP":
        return ("webp", "image/webp")
    if d[:3] == b"\xff\xd8\xff":
        return ("jpg", "image/jpeg")
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        return ("png", "image/png")
    if d[:6] in (b"GIF87a", b"GIF89a"):
        return ("gif", "image/gif")
    return ("jpg", "image/jpeg")


def cover_for_bytes(data: bytes) -> bytes:
    """webp -> jpeg/png, если есть ffmpeg; иначе как есть (лучше кривая обложка,
    чем её отсутствие, но расширение при этом честное)."""
    ext, _ = sniff_image(data)
    if ext != "webp" or not FF.ok:
        return data
    try:
        tmp = Path(tempfile.mkdtemp(prefix="ytm_cov_"))
        src, dst = tmp / "c.webp", tmp / "c.png"
        src.write_bytes(data)
        FF.run(["-i", str(src), "-y", str(dst)])
        out = dst.read_bytes()
        shutil.rmtree(tmp, ignore_errors=True)
        return out if out[:8] == b"\x89PNG\r\n\x1a\n" else data
    except Exception:  # noqa: BLE001
        return data


def write_tags(path: Path, meta: dict, cover_url: str | None = None,
               cover_bytes: bytes | None = None, proxy: str | None = None) -> dict:
    """Пишет теги. Возвращает сводку для UI (что реально записалось)."""
    written: dict[str, str] = {}
    suf = path.suffix.lower()
    # 0.6.12: «№ 0» в свойствах = TRCK с нулём. Нулевые/отрицательные числа -
    # не данные (yt-dlp кладёт track_number=0 когда номера нет), не пишем.
    # 0.6.16: ноль в любой форме - не данные: 0, "0", [0], "0/12". Фильтр
    # прошлой версии пропускал список [0] (из info.json номер иной раз именно
    # список) - отсюда живучий «Дорожка: 0» в свойствах.
    def _zero(v):
        if v is None or v == "":
            return True
        if isinstance(v, bool):
            return False
        if isinstance(v, (int, float)):
            return v <= 0
        if isinstance(v, (list, tuple, set)):
            return all(_zero(x) for x in v)
        return bool(re.fullmatch(r"0+(\.0+)?(/\d+)?", str(v).strip()))
    data = {k: v for k, v in (meta or {}).items() if not _zero(v)}
    # 0.6.19: по просьбе владельца нумерацию дорожек в теги НЕ пишем вовсе.
    # Номера у нас откуда ни возьмись: из info.json (track_number=0), из
    # playlist_index (позиция В ЛИСТЕ, а не в альбоме - «Дорожка 791» в
    # свойствах). Пока нет честного источника (релиз-треклист), молчание
    # честнее числа. Ключи приняты и игнорируются; возврат - по явному «давай».
    data.pop("track", None)
    data.pop("disc", None)
    # 0.6.11: название = только название. «TOOL - Fear Inoculum» в TIT2 - мусор
    # из youtube-заголовка, когда строка листа принесла артиста отдельно.
    _ct = clean_title(data.get("title"), data.get("artist"))
    if _ct:
        data["title"] = _ct
    # 0.6.10: «исполнитель альбома» (TPE2/aART) - по нему Explorer группирует
    # музыку, и он же у нас не приходил никогда. Стандартная конвенция
    # теггеров: для не-сборника без отдельного album artist он равен
    # артисту трека. Пишем только когда альбом известен - конвенция, не выдумка.
    if data.get("album") and data.get("artist") and not data.get("albumartist"):
        data["albumartist"] = data["artist"]

    if HAVE_MUTAGEN and data:
        try:
            if suf == ".mp3":
                try:
                    tags = ID3(path)
                except ID3NoHeaderError:
                    tags = ID3()
                import mutagen.id3 as _mid3
                # 0.6.10: в карте лежат ИМЕНА фреймов (строки). Прежний код звал
                # frame(...) на строке - TypeError прятался в _error, и mp3 с самых
                # 0.5.x тихо жил БЕЗ текстовых тегов (обложка в отдельной ветке -
                # потому «картинка есть, альбом пустой»). Разрешаем имя в класс.
                for key, (frame, conv) in TAG_MAP_ID3.items():
                    if key in data:
                        cls = getattr(_mid3, frame) if isinstance(frame, str) else frame
                        tags.add(cls(encoding=3, text=str(conv(data[key]))))
                        written[key] = str(data[key])
                tags.save(path)
            elif suf in (".m4a", ".mp4", ".m4b", ".mov"):
                tags = MP4(path)
                # Ни add_tag(), ни add_tags(dict) у MP4 нет — и не нужны: __setitem__ сам
                # создаёт MP4Tags, если их не было. (Здесь я два раза подряд спотыкался об
                # «метод не найден»/«NoneType is not callable», и оба раза теги молча не писались.)
                for key, atom in TAG_MAP_MP4.items():
                    if key not in data:
                        continue
                    if key in ("genre",):
                        tags[atom] = [str(data[key])]
                    elif key == "track":
                        n = re.match(r"(\d+)", str(data[key]))
                        tags[atom] = [(int(n.group(1)), 0)] if n else [str(data[key])]
                    else:
                        tags[atom] = [str(data[key])]
                    written[key] = str(data[key])
                tags.save()
            else:
                # opus/webm/flac: универсальный V Comment-путь через mutagen tags
                try:
                    from mutagen import File as MFile
                    f = MFile(path)
                    if f is not None and f.tags is None and hasattr(f, "add_tags"):
                        f.add_tags()   # без этого remuxнутый .opus остался бы без тегов
                    if f is not None and f.tags is not None:
                        names = {"title": "TITLE", "artist": "ARTIST", "album": "ALBUM",
                                 "genre": "GENRE", "date": "DATE", "track": "TRACKNUMBER",
                                 "albumartist": "ALBUMARTIST"}
                        for k, v in data.items():
                            if k in names:
                                f.tags[names[k]] = [str(v)]
                                written[k] = str(v)
                        f.save()
                except Exception as e:  # noqa: BLE001
                    print(f"tag fallback failed: {e}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            written["_error"] = f"mutagen: {e}"

    cover = cover_bytes
    if not cover and cover_url and re.match(r"^https?://", str(cover_url)):
        cover = http_get_bytes(cover_url, timeout=20, proxy=_proxy_of(proxy))
    if cover:
        cext, cmime = sniff_image(cover)
        if cext == "webp" and FF.ok:
            cover = cover_for_bytes(cover)         # png годится для covr и для APIC
            cext, cmime = sniff_image(cover)
    if cover and suf in (".m4a", ".mp4", ".mov"):
        try:
            tags = MP4(path)
            fmt = MP4Cover.FORMAT_PNG if cext == "png" else MP4Cover.FORMAT_JPEG
            if cext == "webp":
                written["_cover_error"] = "webp: нужен ffmpeg для конвертации в png/jpeg"
                raise RuntimeError("webp cover without ffmpeg")
            tags["covr"] = [MP4Cover(cover, imageformat=fmt)]
            tags.save()
            written["cover"] = f"{len(cover)} bytes"
        except Exception as e:  # noqa: BLE001
            written["_cover_error"] = str(e)
    elif cover and suf == ".mp3":
        try:
            tags = ID3(path)
            tags.add(APIC(encoding=3, mime=cmime, type=3, desc="Cover", data=cover))
            tags.save()
            written["cover"] = f"{len(cover)} bytes"
        except Exception as e:  # noqa: BLE001
            written["_cover_error"] = str(e)

    # webm: картинку туда положить нечем (webm-муxер ffmpeg отвергает вложения),
    # но remuxнутый .opus принимает штатную VorbisComment-картинку - это и есть
    # путь «opus как вариант» без единого лишнего перекодирования.
    if cover and "cover" not in written and suf in (".opus", ".ogg", ".oga"):
        try:
            import base64 as _b64
            from mutagen import File as _MF
            from mutagen.flac import Picture as _Pic
            fo = _MF(path)
            if fo is None:
                raise RuntimeError("mutagen не открыл " + suf)
            if fo.tags is None and hasattr(fo, "add_tags"):
                fo.add_tags()
            pic = _Pic()
            pic.type = 3
            pic.desc = "Cover"
            pic.mime = str(cmime or "image/jpeg")
            pic.data = cover
            fo.tags["METADATA_BLOCK_PICTURE"] = [_b64.b64encode(pic.write()).decode()]
            fo.save()
            written["cover"] = str(len(cover)) + " bytes (METADATA_BLOCK_PICTURE)"
        except Exception as e:  # noqa: BLE001
            written["_cover_error"] = str(e)
    # Если mutagen не справился с обложкой для m4a - last resort: ffmpeg attached_pic.
    # ВАЖНО: имя временного файла строим из path.name + суффиксы, а НЕ через
    # with_suffix(): с «x.webm.covr» второй with_suffix давал «x.jpg» - jpg-мусор
    # оседал в папке с музыкой, а сама подмена молча не происходила.
    if cover and "cover" not in written and suf not in (".mp3", ".webm", ".opus", ".ogg") and FF.ok:
        try:
            tmp = Path(str(path) + ".covr" + suf)
            pic = Path(str(path) + ".covr.jpg")
            pic.write_bytes(cover)
            FF.run(["-i", str(path), "-i", str(pic),
                    "-map", "0", "-map", "1", "-c", "copy",
                    "-disposition:v:1", "attached_pic", str(tmp)])
            pic.unlink(missing_ok=True)
            tmp.replace(path)
            written["cover"] = "via ffmpeg"
        except Exception as e:  # noqa: BLE001
            written["_cover_error"] = str(e)
            for junk in (pic, tmp):
                try:
                    junk.unlink(missing_ok=True)
                except OSError:
                    pass
    return written


def socks_module_available() -> bool:
    """Есть ли в ЭТОМ python модуль socks (PySocks). Нужен он только собственным
    запросам компаньона (обложка/thumbnail через urllib): у yt-dlp с 2020-х есть СВОЙ
    socks-транспорт (yt_dlp/socks.py), поэтому `--proxy socks5://` у него работает и без
    PySocks. PySocks едет в архиве третьим wheel-ом: 16 КБ, BSD, зависимостей ноль."""
    import importlib.util
    return bool(importlib.util.find_spec("socks"))


# старое имя оставляем: на него ссылались selftest и тесты
socks_available = socks_module_available


def _tcp_open(spec, timeout: float = 0.7) -> bool:
    """Живёт ли локальный вход прокси (host:port из socks5://127.0.0.1:10808)."""
    import re as _re
    m = _re.search(r"(?://)?([0-9a-zA-Z_.\-]+):(\d+)", str(spec or ""))
    if not m:
        return False
    try:
        import socket
        with socket.create_connection((m.group(1), int(m.group(2))), timeout=timeout):
            return True
    except OSError:
        return False


def system_proxy_settings() -> dict:
    """Прокси, которым система (и, следом, Firefox в режиме «системный прокси») уже
    пользуется: Windows - WinINET, остальное - переменные окружения.
    {'socks': '127.0.0.1:10808', 'http': '...'}; {} если ProxyEnable=0."""
    out: dict[str, str] = {}
    try:
        if os.name == "nt":
            import winreg
            qk = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, qk) as k:
                if not winreg.QueryValueEx(k, "ProxyEnable")[0]:
                    return {}
                try:
                    server = str(winreg.QueryValueEx(k, "ProxyServer")[0] or "").strip()
                except OSError:
                    server = ""
            if not server:
                return {}
            if "=" in server:                       # "http=a:1;socks=127.0.0.1:10808"
                for part in re.split(r"[;", server):
                    k2, _, v2 = part.partition("=")
                    if v2.strip():
                        out[k2.strip().lower()] = v2.strip()
            else:
                out["http"] = server
        else:
            import urllib.request
            out = {str(k).lower(): v for k, v in (urllib.request.getproxies() or {}).items()}
    except Exception:
        return out
    return out


def decide_proxy(explicit=None, sysprox=None, have_socks: bool = True, probe=_tcp_open) -> tuple:
    """Чистая функция выбора прокси (тестится без реестра): (значение, почему)."""
    ex = str(explicit or "").strip()
    if ex.lower() in PROXY_NONE_VALUES:
        return "", "proxy=none: прямо, системный прокси не наследуем"
    if ex:
        return ex, "из ytm-dl.ini"
    sp = dict(sysprox or {})
    cand = sp.get("socks") or sp.get("socks5") or sp.get("socks5h")
    if cand:
        spec = cand if "://" in cand else "socks5://" + cand
        if not probe(spec):
            return "", "системный socks не отвечает: " + spec
        if not have_socks:
            return "", ("в системе socks (" + spec + "), PySocks не установлен: yt-dlp "
                        "пройдёт через него сам (свой транспорт), обложки - нет")
        return spec, "унаследован системный socks (браузер ходит через него)"
    http = sp.get("http") or sp.get("https")
    if http:
        return ("http://" + http if "://" not in http else http), "унаследован системный http-прокси"
    return "", ""


def _proxy_of(value=None) -> str:
    """Прокси для СОБСТВЕННЫХ запросов компаньона (обложка, thumbnail). Берём из
    ytm-dl.ini, т.е. ровно тот же выход, которым браузер смотрит видео. Пустое поле =
    пробуем унаследовать СИСТЕМНЫЙ прокси - это случай Firefox + «системный прокси
    socks5://127.0.0.1:10808» (FoxyProxy/Loon/Amnezia): раньше такой настройке
    соответствовало «молча качаем напрямую»."""
    _cfg = getattr(Handler, "cfg", None) or {}
    if _cfg.get("proxy_direct"):
        return ""              # «proxy=none»: не унаследуем систему и не лезем в ini
    pr = str(value or _cfg.get("proxy") or "").strip()
    if not pr:
        pr, why = decide_proxy("", system_proxy_settings(), socks_module_available())
        if why:
            print(("proxy: " + pr + " - " + why) if pr else ("proxy: " + why), file=sys.stderr)
    if pr.lower().startswith("socks") and not socks_module_available():
        raise ImportError("for covers over socks5 install PySocks (install-packages-offline.bat) "
                          "or put an http:// port into proxy=")
    return pr


def http_get_bytes(url: str, timeout: int = 30, proxy: str | None = None) -> bytes | None:
    import urllib.request

    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0", "Referer": "https://music.youtube.com/"})
        pr = str(proxy or "").strip()
        if pr.lower().startswith("socks") and not socks_module_available():
            raise ImportError("socks5 without PySocks: run install-packages-offline.bat "
                              "(PySocks ships in wheels\\) or put an http:// port into proxy=")
        # ВАЖНО: build_opener принимает ХЭНДЛЕРЫ, а не список. Единственный аргумент
        # "список" приводил к "expected BaseHandler instance, got <class 'list'>" -
        # и обложка/embedded-thumbnail падали молча (файл приходил без картинки).
        if pr:
            # без ProxyHandler с явным значением urllib послушает системный прокси,
            # а нам нужен ПРОКСИ ИЗ ИНИ (браузерный может быть вообще только у браузера)
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": pr, "https": pr}))
        elif proxy is None:
            opener = urllib.request.build_opener()  # системный прокси (getproxies) как раньше
        else:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:
        print("http_get_bytes %s: %s" % (url[:120], e), file=sys.stderr)
        return None


# --------------------------------------------------------------------------- handlers

def out_dir_ok(candidate: str | None, default: Path) -> Path | None:
    """
    Папка назначения. Браузер не может открыть диалог выбора каталога (у userscript'а нет
    такого API), поэтому путь приходит строкой и обязан быть проверен здесь: это localhost-
    сервер, но writes без валидации — это «любая страница, до которой доедет запрос, пишет
    файлы куда хочет». Пусто -> default (--out). За пределами домашней папки -> None (отказ).
    """
    if not candidate or str(candidate).strip() == str(default):
        return Path(default)             # «как в конфиге» — не резолвим и не проверяем заново
    raw = os.path.expanduser(str(candidate).strip())
    if not raw or "\x00" in raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = Path.home() / p
    p = p.resolve()
    home = Path.home().resolve()
    if p != home and home not in p.parents:
        return None
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return p if p.is_dir() else None


# ------------------------------------------------------------------ download archive
#
# Дедупликация в духе yt-dlp --download-archive, но своя: она обязана работать для
# ВСЕХ режимов (media/direct/replay тоже попадают в `done`), а не только для yt-dlp-ветки.
# Файл `.ytm-archive.txt` в папке назначения = «этот videoId у меня уже есть», поэтому
# переоткрытие плейлиста на следующей неделе не перекачивает 200 треков заново.

ARCHIVE_NAME = ".ytm-archive.txt"
ARCHIVE_DIR: dict = {}          # {"dir": Path} — переопределение через --archive


def archive_path(out_dir: Path | str) -> Path:
    """Файл архива: по умолчанию в папке назначения (рядом с музыкой), но --archive
    позволяет вынести его на общий диск, чтобы одна база работала для нескольких папок."""
    if ARCHIVE_DIR.get("dir"):
        return Path(ARCHIVE_DIR["dir"]) / ARCHIVE_DIR.get("name", ARCHIVE_NAME)
    return Path(out_dir) / ARCHIVE_NAME


def archive_key_id(line: str) -> str:
    """
    videoId из строки архива в ЛЮБОМ из двух форматов:
      • «<id>\t<название>» — как пишем мы;
      • «youtube <id>»     — как пишет yt-dlp --download-archive.
    Второй формат принципиален: в режиме «весь лист» архив ведёт yt-dlp, и без нормализации
    собственный файл читался бы как «id = youtube» (реальный баг, найденный живым прогоном:
    повторный лист не распознавался как «уже скачано»).
    """
    parts = [p for p in (line or "").strip().replace("\t", " ").split(" ") if p]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if parts[0].lower() in ("youtube", "youtube:tab", "webpage") and len(parts) > 1:
        return parts[1]
    return parts[0]


def read_archive(out_dir: Path | str) -> list[str]:
    """videoId'шники уже скачанного в порядке записи, без дублей (оба формата строк)."""
    seen: list[str] = []
    got: set[str] = set()
    try:
        for line in archive_path(out_dir).read_text(encoding="utf-8").splitlines():
            vid = archive_key_id(line)
            if vid and vid not in got:
                got.add(vid)
                seen.append(vid)
    except OSError:
        pass
    return seen


def archive_has(out_dir: Path | str, vid: str) -> bool:
    """Есть ли id в архиве (оба формата строк; пустой id — всегда False)."""
    if not vid:
        return False
    try:
        for line in archive_path(out_dir).read_text(encoding="utf-8").splitlines():
            if archive_key_id(line) == vid:
                return True
    except OSError:
        pass
    return False


def archive_add(out_dir: Path | str, vid: str, title: str = "") -> bool:
    """True, если запись добавлена (False — уже была или id некорректен)."""
    if not vid or not re.fullmatch(r"[A-Za-z0-9_-]{6,128}", vid):
        return False
    p = archive_path(out_dir)
    if archive_has(p.parent, vid):
        return False
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(f"{vid}\t{title}\n")
        return True
    except OSError:
        return False


def extract_video_id(url: str | None) -> str | None:
    """videoId из watch?v=/v=/e=/shorts/... — то, по чему ищем в архиве."""
    if not url:
        return None
    # 11 символов — реальный формат youtube; {6,64} — чтобы тестовые/фикстура-id тоже
    # проходили (иначе дедуп «молча» не срабатывает на нестандартных id)
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,64})", url) or re.search(r"/(?:v|e|shorts)/([A-Za-z0-9_-]{6,64})", url)
    return m.group(1) if m else None


LIKED_ALIASES = {"liked", "likes", "lm", "yy", "liked_music", "понравившиеся"}


def resolve_playlist_url(url: str | None) -> tuple[str | None, bool]:
    """
    (playlist_url, liked) из ссылки, которую пользователь открыл в браузере.
    YouTube Music живёт на /watch?list=..., /playlist?list=..., а «понравившееся» —
    плейлист LM для YT и YY для YouTube Music (и тот, и другой понимается yt-dlp).
    """
    if not url:
        return None, False
    u = url.strip()
    if u.lower().rstrip("/") in LIKED_ALIASES:
        return "https://music.youtube.com/playlist?list=YY", True
    m = re.search(r"[?&]list=(RDCLAK[0-9A-Za-z_-]{2,}|LM|YY)", u)
    if m:
        return f"https://music.youtube.com/playlist?list={m.group(1)}", True
    m = re.search(r"[?&]list=([A-Za-z0-9_-]{5,})", u)
    if m:
        # страница открыта в YTM -> качаем через music-домен, иначе yt-dlp вернёт
        # «видео»-версию плейлиста (другие форматы, другие теги, иногда 360p-мусор)
        dom = "music" if "music.youtube.com" in u else "www"
        return f"https://{dom}.youtube.com/playlist?list={m.group(1)}", False
    return None, False


def dest_for(job_meta: dict, out_dir: Path, suffix: str) -> Path:
    # 0.6.11: файл именовался по «MAK DADDY - Bezos» и тег вставлялся тот же -
    # срезаем «Артист -» и здесь, чтобы имя и TIT2 не разъезжались.
    title = safe_name(clean_title(job_meta.get("title"), job_meta.get("artist"))
                      or job_meta.get("videoId") or "track", 90)
    if job_meta.get("album") and job_meta.get("organize") == "album":
        folder = out_dir / safe_name(job_meta["album"], 60)
    else:
        folder = out_dir
    folder.mkdir(parents=True, exist_ok=True)
    # 0.6.21: имя файла = ТОЛЬКО название (правило владельца; артисты и альбом -
    # в тегах, при organize=album альбом и так папка). Прежний шаблон
    # «артист - название» каждый раз переживал баги парсинга byline вслух:
    # файл «ONLY IF I DIE... - WHO GON' SLIDE» - это альбом в позиции артиста.
    # Цена: одноимённые треки в одной папке = «уже есть» (пропуск, не « (1)») -
    # это тот же контракт, что и «(1) не появится НИГДЕ».
    base = title
    p = folder / f"{base}{suffix}"
    n = 1
    while p.exists():  # не перетираем: идемпотентность важнее красоты
        p = folder / f"{base} ({n}){suffix}"
        n += 1
        if n > 99:
            break
    return p


def dest_taken(job_meta: dict, out_dir: Path) -> "Path | None":
    """0.5.8: «(1)» не появится НИГДЕ. Имя считаем ровно так же, как dest_for, и
    спрашиваем одно: лежит ли в папке файл с этим базовым именем - в ЛЮБОМ
    известном контейнере. Да - трек уже скачан: новый кусок выбрасываем, id
    дописываем в архив (самолечение после переезда music\\ или «сбросить»)."""
    if not job_meta.get("title"):
        return None  # без настоящего заголовка имя было бы заглушкой "track" - не основание
    # 0.6.21: ровно то же вычисление, что в dest_for, - имя теперь «только
    # название», и clean_title здесь обязателен, иначе «артист - трек» в meta
    # разминался бы с именем на диске (двойник вместо пропуска).
    title = safe_name(clean_title(job_meta.get("title"), job_meta.get("artist"))
                      or job_meta.get("videoId") or "track", 90)
    if job_meta.get("album") and job_meta.get("organize") == "album":
        folder = out_dir / safe_name(job_meta["album"], 60)
    else:
        folder = out_dir
    base = title
    for suf in (".m4a", ".mp3", ".opus", ".webm", ".ogg", ".mka", ".flac"):
        p = folder / (base + suf)
        if p.exists():
            return p
    return None


def _head_hex(p: Path, n: int = 32) -> str:
    """первые байты файла в hex - по ним «заглушка vs медиа» видно без плеера"""
    try:
        with p.open("rb") as f:
            return f.read(n).hex(" ")
    except OSError:
        return "?"


def _undecodable(path: Path, want_duration) -> str:
    """'' если файл честно декодируется; иначе - объяснение для человека.
    -xerror ловит битый контейнер; сравнение длительности ловит то, что ffmpeg
    проглатывает молча: ftyp на месте, mdat пустой - размер есть, звука нет."""
    if not FF.ok:
        return ""
    try:
        FF.run(["-xerror", "-i", str(path), "-f", "null", "-"])
    except Exception as e:  # noqa: BLE001
        return "декодирование не прошло: " + str(e)[:220]
    try:
        wd = float(want_duration or 0)
    except (TypeError, ValueError):
        wd = 0.0
    if wd > 10.0:
        dur = FF.duration(path)
        if dur is not None and dur < max(1.0, 0.5 * wd):
            return (f"в файле {dur:.1f} с вместо ~{wd:.0f} с - поток пустой "
                    "(браузер играл через SABR, а повторная выдача вернула пустышку)")
    return ""


def finalize(job: Job, raw: Path, target_fmt: str, bitrate: str | None) -> None:
    """Из 'сырья' -> готовый файл с тегами. Общий финал всех трёх режимов."""
    meta = job.meta.get("meta") or {}
    out_dir = out_dir_ok(job.meta.get("out_dir"), Path(DEFAULTS["out"]))
    cover_url = meta.get("thumbnail")
    want = (target_fmt or "m4a").lower()
    job.progress = 0.75
    job.message = "remux"

    if want == "mp3":
        dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, ".mp3")
        if not FF.ok:
            raise RuntimeError("для mp3 нужен ffmpeg (remux в m4a возможен и без него)")
        FF.to_mp3(raw, dst, bitrate or "320k", job)
    elif want == "opus":
        # «opus отдельным режимом» из панели И из auto-режима (там userscript
        # теперь шлёт opus вместо copy). webm->.opus - это remux `-c copy`:
        # ни одного перекодирования; картинка и теги доедут в write_tags ниже.
        ext = sniff_container(raw) or ""
        if not ext:
            raise RuntimeError("это не медиапоток (не опознан контейнер по первым байтам) — "
                               "попробуй режим browser, где качает yt-dlp")
        if ext == "webm" and FF.ok:
            dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, ".opus")
            try:
                FF.run(["-i", str(raw), "-c", "copy", str(dst)], job)
                job.logs.append("webm→opus (remux, без перекодирования)")
            except Exception as e:  # noqa: BLE001
                job.logs.append(f"webm→opus не вышло ({str(e)[:150]}); оставляю .webm как есть")
                dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, ".webm")
                shutil.move(str(raw), dst)
        else:
            # Ogg/Opus из браузера может прийти уже готовым (.ogg), а может и m4a -
            # тогда трогать нечего: write_tags отработает по фактическому контейнеру
            dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, "." + ext)
            if raw != dst:
                shutil.move(str(raw), dst)
    elif want == "copy":
        # контейнер берём из байтов, а не из того, что прислал браузер: 'bin'/''
        # превращались в непонятный файл без плейлистного расширения
        ext = sniff_container(raw) or ("m4a" if _looks_like_mp4(raw) else "")
        if not ext:
            raise RuntimeError("это не медиапоток (не опознан контейнер по первым байтам) — "
                               "попробуй режим browser, где качает yt-dlp")
        dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, "." + ext)
        shutil.move(str(raw), dst)
    else:
        dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, ".m4a")
        if FF.ok:
            try:
                FF.remux(raw, dst, job)
            except Exception as e:  # noqa: BLE001
                # remux упал: оставлять файл с расширением .m4a, внутри которого
                # лежат непонятно что, нельзя - такой «результат» невозможно
                # ни воспроизвести, ни объяснить
                if sniff_container(raw):
                    _why = _undecodable(raw, meta.get("duration")) if \
                        (getattr(Handler, "cfg", None) or {}).get("verify", True) else ""
                    if _why:
                        _hx = _head_hex(raw)
                        raw.unlink(missing_ok=True)
                        raise RuntimeError(
                            "remux не удался и сырьё не играбельно - файл НЕ сохранён: "
                            + _why + " | начало байтов: " + _hx
                            + " | auto берёт байты из вкладки, а googlevideo выдаёт их "
                              "только плееру; качай через ytdlp/queue - там качает yt-dlp "
                              "со своим запросом")
                    job.logs.append(f"remux failed ({e}); keeping raw copy")
                    shutil.move(str(raw), dest_for({**meta, "organize": job.meta.get("organize")},
                                                   out_dir, "." + sniff_container(raw)))
                else:
                    raw.unlink(missing_ok=True)
                    if dst.exists():
                        dst.unlink()
                    raise RuntimeError(f"remux не удался ({e}) и сырьё не похоже на медиа — файл не сохранён")
        else:
            # ffmpeg отсутствует: «m4a» из webm/opus-куска всё равно не выйдет,
            # пишем как есть и честно говорим об этом в message
            ext = sniff_container(raw) or "bin"
            dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, "." + ext)
            job.message = f"без ffmpeg: сохранено как .{ext}"
            shutil.move(str(raw), dst)
    if raw.exists() and raw != dst:
        try:
            raw.unlink()
        except OSError:
            pass

    job.progress = 0.9
    # «размер правдоподобный, а не играет» (обещание auto на SABR-выдаче) ловим ДО
    # выдачи файла человеку: декод + длительность. Отключается verify=0 в ini/json.
    if (getattr(Handler, "cfg", None) or {}).get("verify", True):
        why = _undecodable(dst, meta.get("duration"))
        if why:
            _hx = _head_hex(dst)
            try:
                dst.unlink(missing_ok=True)
            except OSError:
                pass
            raise RuntimeError("результат не воспроизводится, файл удалён: " + why
                               + " | начало байтов: " + _hx
                               + " | в auto байты просит googlevideo, а он отдаёт их только "
                                 "плееру - для надёжного пути включи режим ytdlp (или queue)")
    job.message = "tags"
    tags = write_tags(dst, meta, cover_url, proxy=job.meta.get("proxy"))
    job.dest = dst
    job.meta.update({"written_tags": tags, "size": dst.stat().st_size,
                     "duration": FF.duration(dst) if FF.ok else None})
    # в архив пишем только после успешного finalize (remux мог упасть и оставить «raw copy»)
    vid = job.meta.get("videoId") or meta.get("videoId") or extract_video_id(meta.get("url") or job.meta.get("url"))
    if vid and job.meta.get("dedup", True):
        if archive_add(out_dir, vid, str(meta.get("title") or "")):
            job.meta["archived"] = True


def _looks_like_mp4(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            head = f.read(16)
        return any(s in head for s in (b"ftyp", b"moov", b"mdat", b"styp", b"moof", b"sidx"))
    except OSError:
        return False


class PlaylistFallback(Exception):
    """все позиции листа упали на ОДНОМ наборе клиентов - это НЕ «лист сломан»;
    сигнал обёртке handle_playlist попробовать следующий вариант."""


def webm_transcode(f: Path, want_fmt: str, job, out_dir, meta):
    """webm/opus (или m4a, если просили mp3) -> запрошенное. Возвращает (путь, note)|None.

    Зачем: без m4a в выдаче yt-dlp берёт opus = `.webm`; mutagen в webm теги не
    пишет, а webm-муxер ffmpeg ОТВЕРГАЕТ картинки («Only VP8/VP9/AV1 video and
    Vorbis or Opus audio ... are supported» - проверено на ffmpeg 7.0.2). Отсюда и
    «скачал .webm, а картинки нет»: дело в контейнере, не в наших кривых руках.

    Три честных пути:
      opus  -> remux в .opus с `-c copy`: НИ ОДНОГО перекодирования, качество бит в
               бит; обложка живёт в METADATA_BLOCK_PICTURE (foobar2000/mpv/VLC видят,
               проводник Windows - нет);
      m4a   -> AAC 256k по умолчанию: прозрачность opus наступает раньше 256k, потер
               на слух, как правило, нет;
      mp3   -> LAME V0 (~245k) или CBR из ini (bitrate=): да, ДВОЙНОЕ lossy (сначала
               opus 128-160k, потом mp3), и мы пишем это в logs задачи, а не прячем.
    """
    suf = f.suffix.lower()
    want = (want_fmt or "m4a").lower()
    opusish = suf in (".webm", ".opus", ".ogg")
    if not opusish and not (want == "mp3" and suf in (".m4a", ".mp4", ".m4b")):
        return None
    if not FF.ok:
        return None
    if opusish and suf == ".webm" and not _looks_like_webm(f):
        return None
    if want in ("m4a", ""):
        br = str(job.meta.get("bitrate") or "256k")
        ext, args = ".m4a", ["-c:a", "aac", "-b:a", br]
        note = suf + "→m4a (AAC " + br + ")"
    elif want == "mp3":
        br = str(job.meta.get("bitrate") or "").strip()
        ext = ".mp3"
        args = ["-c:a", "libmp3lame"] + (["-b:a", br] if br else ["-q:a", "0"])
        note = (suf + "→mp3 (LAME " + (br + " CBR" if br else "V0 ~245k")
                + "); двойное lossy: ytm отдал opus, дальше mp3")
    elif want in ("opus", "webm"):
        if suf != ".webm":
            return None
        ext, args = ".opus", ["-c", "copy"]
        note = suf + "→opus (remux, без перекодирования)"
    else:
        return None
    dst = dest_for({**(meta or {}), "organize": job.meta.get("organize")}, out_dir, ext)
    try:
        FF.run(["-i", str(f), "-vn", "-map_metadata", "0", *args, str(dst)], job)
    except Exception as e:  # noqa: BLE001
        try:
            dst.unlink(missing_ok=True)
        except OSError:
            pass
        return (f, suf + "→" + ext + " не вышло (" + str(e)[:150] + "); оставляю как есть")
    if dst != f:
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass
    return (dst, note)


def _looks_like_webm(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            return f.read(4) == b"\x1a\x45\xdf\xa3"
    except OSError:
        return False


def handle_media(job: Job) -> None:
    """Режим «браузер уже скачал байты»: сырые данные лежат в job.meta['part_paths'] (или в job.meta['raw'])."""
    parts = job.meta.get("part_paths") or []
    raw = Path(job.meta["raw"]) if job.meta.get("raw") else None
    if parts:
        if raw is None:
            raw = Path(tempfile.mkstemp(prefix="ytm_", suffix=".frag")[1])
        with raw.open("wb") as out:
            for pp in parts:
                with open(pp, "rb") as f:
                    shutil.copyfileobj(f, out, 1024 * 256)
                job.progress = min(0.7, job.progress + 0.05)
                try:
                    os.unlink(pp)
                except OSError:
                    pass
    if raw is None or not Path(raw).exists():
        raise RuntimeError("нет загруженных медиаданных")
    # байты из браузера могут оказаться страницей «подтвердите что вы не бот»: это
    # не медиа, и сохранять это как трек нельзя - иначе получаются два файла
    # Порядок важен: HTML смотрим ПЕРВЫМ и до unlink - страница бот-чека
    # бывает короче 1 КиБ, и по одному только размеру её от трека не отличить.
    if looks_like_html(raw):
        head = Path(raw).read_bytes()[:240].decode("utf-8", "replace").replace("\n", " ")
        size0 = Path(raw).stat().st_size
        Path(raw).unlink(missing_ok=True)
        raise RuntimeError(
            f"вместо медиа пришёл текст (бот-чек/редирект, {size0} Б): {head[:160]!r} — "
            "переключись в режим browser (yt-dlp с cookies) или добавь cookies_file в ytm-dl.ini")
    size0 = Path(raw).stat().st_size
    if size0 < 1024:
        Path(raw).unlink(missing_ok=True)
        raise RuntimeError(f"слишком мало байт ({size0}) - поток не докачался, повтори трек")
    out_dir = out_dir_ok(job.meta.get("out_dir"), Path(DEFAULTS["out"]))
    # id ищем в трёх местах: явное поле /media?videoId=, meta.videoId, и, если userscript
    # прислал только ссылку страницы, вытаскиваем v= из meta.url
    _m = job.meta.get("meta") or {}
    vid = job.meta.get("videoId") or _m.get("videoId") or extract_video_id(_m.get("url") or job.meta.get("url"))
    # «уже скачано» проверяем ДО remux: дешевле всего отказаться, когда байты уже тут,
    # но до первой работы с файлом. remove=False — чтобы «skip» не съедал уже написанное.
    if vid and archive_has(out_dir, vid) and job.meta.get("dedup", True):
        Path(raw).unlink(missing_ok=True)
        job.status = "done"; job.progress = 1.0
        job.message = f"уже есть в архиве ({vid}) — пропущено"
        job.meta["skipped"] = True
        return
    # 0.5.7: если архив потерян, а файл на месте - тоже «уже есть»: пропускаем
    # без создания « (1)» и записываем id в архив, чтобы дальше всё считалось честно
    if job.meta.get("dedup", True):
        _mm = dict(job.meta.get("meta") or {})
        _mm["organize"] = job.meta.get("organize")
        _p = dest_taken(_mm, out_dir)
        if _p is not None:
            Path(raw).unlink(missing_ok=True)
            if vid:
                archive_add(out_dir, str(vid), str(_mm.get("title") or ""))
            job.status = "done"; job.progress = 1.0
            job.message = f"уже лежит в {_p.parent.name}\\ - пропуск (id записан в архив)"
            job.meta["skipped"] = True
            return
    finalize(job, Path(raw), job.meta.get("format", "m4a"), job.meta.get("bitrate"))


def handle_url(job: Job) -> None:
    """Режим «скачай сам» через yt-dlp. Нужны cookies браузера, иначе 403/бот-детект."""
    url = job.meta.get("url") or (job.meta.get("meta") or {}).get("url")
    if not url:
        # в режиме ytdlp userscript шлёт videoId, а не ссылку страницы: соберём её,
        # иначе «нет url» было бы честной, но бесполезной ошибкой
        vid = job.meta.get("videoId") or (job.meta.get("meta") or {}).get("videoId")
        if vid:
            url = f"https://music.youtube.com/watch?v={vid}"
            job.meta["url"] = url
    if not url:
        raise RuntimeError("нет url и нет videoId - companion не знает, что качать")
    tmp = Path(tempfile.mkdtemp(prefix="ytm_url_"))
    # url ОБЯЗАТЕЛЬНО последний аргумент, а -o стоит рядом со своим шаблоном:
    # любой cmd += [...] после url сдвигает хвост, и yt-dlp начинает есть путь
    # как позиционный аргумент (Unsupported url scheme "C"). Поэтому флаги копим
    # отдельно, а "-o <шаблон> <url>" доклеиваем в каждой попытке.
    head = [PYTHON, "-m", "yt_dlp",
            "-f", _fallback_format(job),
            "--no-playlist", "--no-write-playlist-metafiles", "--windows-filenames",
            "--write-info-json"]   # 0.5.12: sidecar info.json - откуда имена/теги/обложка,
                                   # когда запрос их не принес (salvage, ytdlp без перехвата)
    cookies_from = job.meta.get("cookies_from_browser")
    if cookies_from:
        hint = firefox_profile_check(cookies_from)
        if hint:
            # без этой строки человек получил бы «could not find firefox cookies database
            # in ...AppData...» и решил бы, что куки битые: у портативного Firefox
            # профиль живёт НЕ в %APPDATA%, и yt-dlp сам его не найдёт
            raise RuntimeError("cookies: " + hint)
        head += ["--cookies-from-browser", str(cookies_from)]
    if job.meta.get("cookies_file"):
        # файл Netscape-формата: единственный способ для Firefox (профиль залочен,
        # пока браузер открыт) и удобный вариант для «перенёс cookies на другую машину»
        head += ["--cookies", str(job.meta["cookies_file"])]
    if FF.ok:
        head += ["--ffmpeg-location", str(Path(FF.ffmpeg).parent)]
    out_tpl = str(tmp / "%(id)s.%(ext)s")
    # socks5 МОЖНО: у yt-dlp СВОЙ socks-транспорт (yt_dlp/socks.py), PySocks для него
    # не нужен (он нужен только urllib-запросам самого компаньона). Страховка -
    # на случай сборки yt-dlp без этого транспорта:
    if str(job.meta.get("proxy") or "").lower().startswith("socks") and not socks_module_available():
        try:
            import yt_dlp.socks  # noqa: F401
        except Exception as e:
            raise RuntimeError("this yt-dlp has no socks transport and PySocks is missing: "
                               "put an http:// port into proxy=") from e
    ladder = _client_ladder(job.meta.get("player_client"))
    p = None
    bot_html = ''
    # music.youtube.com и www.youtube.com - ТЕ ЖЕ самые видео и те же аудио-потоки
    # (у Музыки просто нет картинки), но приостановки у них независимые: на практике
    # аккаунт ловит «слишком много устройств» в Музыке, когда видеохостинг играет.
    # Поэтому если ХОТЬ НА ОДНОЙ попытке круга замечен reload/бот-подобный вердикт,
    # делаем второй круг тем же id, но на www. Именно «хоть на одной», а не «на
    # последней»: после приостановки последние попытки обычно отчитываются сухим
    # «Requested format is not available» без всякого маркера (лог пользователя,
    # 0.5.4: reload на 1-2 попытках, format-not-available на 3-4 - и фолбэк молчал).
    # 0.5.7: vid ОБЯЗАТЕЛЬНО даже без meta.videoId - «resolve»-задача приносит только
    # url, и без этого второй хост молча не добавлялся (пользователь: «auto не сработал»)
    _vid = str(job.meta.get("videoId") or (job.meta.get("meta") or {}).get("videoId")
               or extract_video_id(url) or "")
    _pref = str(job.meta.get("host_pref") or "")
    _hosts = [url]
    if _vid and "music.youtube.com" in (url or "") and _alt_host_allowed(job):
        # 0.5.9: второй хост - ТОЛЬКО по галочке «youtube.com как запас» (пользователь:
        # «работает всегда, а должен только по чекбоксу»). Порядок не меняется: Music
        # первый, www - запасной круг после reload-вердикта.
        _hosts.append(f"https://www.youtube.com/watch?v={_vid}")
        job.logs.append("host fallback разрешён галочкой панели (youtube.com запасным)")
    blob = ''
    throttle_seen = False   # маркер лимита ловится с ЛЮБОЙ попытки music-круга
    for _hi, host_url in enumerate(_hosts):
        if job.cancelled:   # 0.6.4: «стоп» доходит до очереди за 1-2 попытки, не в середине
            raise RuntimeError("остановлено пользователем")
        if _hi:
            job.logs.append("host fallback: " + host_url)
            _ytm_log_line(f"[job {job.id}] музыка приостановлена/не доверяет - пробую тот же "
                          "id на youtube.com (те же потоки, другие лимиты)")
        for n, (client, extra) in enumerate(ladder):
            c = list(head)
            want = client or job.meta.get("player_client")
            if want:   # один --extractor-args, а не два: yt-dlp не любит повторы
                c += ["--extractor-args", f"youtube:player_client={want}", "--retries", "2"] + list(extra or [])
            if job.meta.get("proxy"):
                c += ["--proxy", str(job.meta["proxy"])]
            _imp = impersonate_target()
            if _imp:
                c += ["--impersonate", _imp]   # curl_cffi: отпечаток браузера на каждой попытке
            c += ["-o", out_tpl, host_url]
            if n or _hi:
                job.message = f"yt-dlp: попытка {n + 1}/{len(ladder)} (клиент {client}" + \
                              (", youtube.com)" if _hi else ")")
            job.logs.append("cmd: " + shlex.join(c))
            p = _run_tracked(c, capture_output=True, text=True, timeout=3600)
            blob = (p.stdout or "") + "\n" + (p.stderr or "")
            job.logs.append(blob[-3000:])
            if p.returncode != 0:
                # в ytm-run.log обязана попасть КАЖДАЯ попытка: по одной финальной строке
                # «yt-dlp exit 1» не понять, проходил ли web_safari/missing_pot вообще
                _err1 = next((ln.strip()[:200] for ln in blob.splitlines() if "ERROR" in ln), "")
                _ytm_log_line(f"[job {job.id}] попытка {n + 1}/{len(ladder)} "
                              f"(клиент {client or 'default'}{', youtube.com' if _hi else ''}): "
                              f"exit {p.returncode} {_err1}")
                if not _hi and ("needs to be reloaded" in blob or "too many" in blob.lower()
                                or "check you're not a bot" in blob):
                    throttle_seen = True   # фолбэку хватит и этого, даже если финал - «formats»
            if "check you're not a bot" in blob or "sign in to confirm" in blob:
                # главная улика живёт в выводе yt-dlp, а не в скачанном файле: без неё
                # человек видел «это видео недоступно» там, где надо было нести cookies
                bot_html = "бот-чек на запросе /player (YouTube не поверил IP/аккаунту)"
            if p.returncode == 0:
                break
            if not blob.strip():
                # 0.6.7: «exit N и ноль байт» - не вердикт YouTube, а поломка чтения
                # (см. errors=replace выше). Считать такое фатальным нельзя: трек и
                # не скачается, и в ThrottleQueue не попадёт (маркеров-то нет).
                job.logs.append("yt-dlp exit %s без вывода - не классифицируем, следующий клиент" % p.returncode)
                continue
            if not _looks_like_bot_check(blob):
                break          # 404 / приватный / удалённый вторым клиентом не лечится
        if p is not None and p.returncode == 0:
            if client:   # 0.6.5: запомнить победителя; «""» (дефолт) не помним - там
                _WIN["key"] = (client, tuple(extra or ()))   # поведение зависит от версии yt-dlp
            break
        # на второй хост идём, если лимитная подпись была на ЛЮБОЙ попытке круга;
        # приватное или удалённое видео и на www не отдастся - не множим запросы
        if not throttle_seen:
            break
    if p is None or p.returncode != 0:
        if throttle_seen:
            _queue_throttled(job, _vid or extract_video_id(url),
                             "после полной лестницы: лимит/бот-чек YouTube")
        shutil.rmtree(tmp, ignore_errors=True)
        if bot_html:
            raise RuntimeError(f"yt-dlp exit {p.returncode if p else '?'}: {bot_html} — "
                               "cookies_from_browser=chrome (или cookies_file=cookies.txt) в ytm-dl.ini; "
                               "без них даже deno с po-token не поможет")
        raise RuntimeError(f"yt-dlp exit {p.returncode if p else '?'}: "
                           f"{_yt_dlp_hint((p.stderr or '') if p else 'нет запуска')}"
                           + (" — включи «youtube.com как запас» в панели: тот же id на "
                              "видеохостинге обычно отдаётся, даже когда Music приостановлен"
                              if throttle_seen and not _alt_host_allowed(job) else ""))
    produced = sorted([f for f in tmp.iterdir() if f.suffix not in (".json", ".txt", ".yml")],
                      key=lambda f: f.stat().st_size, reverse=True)
    if not produced:
        shutil.rmtree(tmp, ignore_errors=True)
        # exit 0 и ни одного файла. Сюда приходят ИЗ handle_browser, поэтому
        # звать handle_url отсюда нельзя - была бы бесконечная рекурсия
        raise RuntimeError(
            "yt-dlp отработал без ошибок, но файл не появился: так выглядит пустой "
            "formats в переданном player response - выбери режим ytdlp (yt-dlp сам "
            "разберёт страницу) или добавь cookies")
    got = produced[0]
    got = _real_name(got)
    if looks_like_html(got):
        shutil.rmtree(tmp, ignore_errors=True)
        _ckd = bool(job.meta.get("cookies_file") or job.meta.get("cookies_from_browser"))
        raise RuntimeError("yt-dlp сохранил HTML вместо потока (бот-чек)" +
                           (" - cookies ПОДКЛЮЧЕНЫ, но YouTube всё равно отдаёт страницу-"
                            "заглушку: временный лимит аккаунта («слишком много устройств») "
                            "или недоверие к IP выхода - подождать/перезалогин/сменить узел; "
                            "record и «прогон через плеер» качают и в таком состоянии"
                            if _ckd else
                            ": cookies_from_browser=firefox в ytm-dl.ini, либо "
                            "cookies_file=cookies.txt"))
    # 0.5.12: метаданные из запроса могут быть пустыми (плейлистное добивание,
    # ytdlp-режим без перехваченного ответа) - читаем info.json самого yt-dlp:
    # тогда имя файла, теги и ОБЛОЖКА доезжают в любом случае.
    _mu0 = job.meta.get("meta") or {}
    if not _mu0.get("title") or not job.meta.get("thumbnail"):
        try:
            jf = next(iter(sorted(tmp.glob("*.info.json"))), None)
            if jf is not None:
                import json as _json
                j = _json.loads(jf.read_text(encoding="utf-8", errors="replace"))
                _mu = job.meta.setdefault("meta", {})
                for _k, _jk in (("title", "title"), ("artist", "uploader"),
                                ("album", "album"), ("duration", "duration")):
                    if not _mu.get(_k) and j.get(_jk) is not None:
                        _mu[_k] = j[_jk]
                # 0.6.10: год/жанр/номер дорожки/album artist в DOM-строках листа
                # не живут, но музыкальный клиент yt-dlp кладёт их в info.json -
                # не использовать их было бы расточительством. Ничего не
                # выдумываем: поля нет в info.json - поля нет в тегах.
                if not _mu.get("track"):
                    _tv = j.get("track") or j.get("track_number")
                    # 0.6.16: info.json приносит номер то int, то списком [0], то
                    # словарём {"id": ...} - разворачиваем до скаляра ДО проверки.
                    if isinstance(_tv, (list, tuple)):
                        _tv = _tv[0] if _tv else None
                    if isinstance(_tv, dict):
                        _tv = _tv.get("id") or _tv.get("number")
                    try:
                        _tv = int(str(_tv).split("/")[0])   # "3/12" -> 3, "0" -> None
                    except (TypeError, ValueError):
                        pass
                    _mu["track"] = _tv or None
                if not _mu.get("date"):
                    _mu["date"] = j.get("year") or j.get("release_date") or j.get("release_year") or None
                if not _mu.get("genre"):
                    _g = j.get("genre") or j.get("genres")
                    if isinstance(_g, (list, tuple)):
                        _g = ", ".join(str(x) for x in _g if x)
                    _mu["genre"] = _g or None
                if not _mu.get("albumartist") and j.get("album_artist"):
                    _mu["albumartist"] = j["album_artist"]
                if not job.meta.get("thumbnail") and j.get("thumbnail"):
                    job.meta["thumbnail"] = j["thumbnail"]
        except Exception as _ie:  # noqa: BLE001
            job.logs.append("info.json не прочитан: " + str(_ie)[:120])
    out_dir = out_dir_ok(job.meta.get("out_dir"), Path(DEFAULTS["out"]))
    # yt-dlp без m4a в выдаче честно берёт opus = .webm. Теги в него пишутся, а вот
    # обложка - нет, и человек видит «файл без картинки». Если нужен m4a/mp3 -
    # перекодируем СРАЗУ (иначе write_tags отработает по webm, а файл потом поедет).
    _meta_u = job.meta.get("meta") or {}
    # 0.5.8: «уже есть» для auto/ytdlp-пути. Имя здесь узнаётся только после скачки,
    # а webm_transcode пишет СРАЗУ в out_dir через dest_for - то есть « (1)» мог
    # родиться ещё до переноса. Проверка стоит перед любым действием с файлом:
    # совпало по базовому имени (любой контейнер) - свежий кусок в tmp выбрасываем,
    # id дописываем в архив, задача «сделана» без записи в папку.
    if job.meta.get("dedup", True):
        _p = dest_taken({**_meta_u, "organize": job.meta.get("organize")}, out_dir)
        if _p is not None:
            _v = job.meta.get("videoId") or _meta_u.get("videoId") or extract_video_id(url)
            if _v:
                archive_add(out_dir, str(_v), str(_meta_u.get("title") or ""))
            job.meta["skipped"] = True
            job.dest = _p
            job.message = f"уже лежит в {_p.parent.name}\\ - свежая копия выброшена (id записан в архив)"
            shutil.rmtree(tmp, ignore_errors=True)
            return
    # yt-dlp без m4a в выдаче берёт opus = .webm, а в webm не ложатся ни теги, ни
    # обложка - конвертируем ДО записи тегов, иначе write_tags отработает по webm
    conv = webm_transcode(got, str(job.meta.get("format") or ""), job, out_dir, _meta_u)
    if conv:
        got, note = conv
        job.logs.append(note)
    # 0.5.10: вот кто добавлял « (1)» ПЕРВОМУ же файлу в пустой папке. webm_transcode
    # уже записал результат в music\ по имени, которое сам выдал dest_for; второй
    # dest_for видит ЭТОТ файл и честно уходит на « (1)», а move перетаскивает туда
    # первый и единственный файл. Файл уже в папке назначения - имя не пересчитываем.
    if got.parent == out_dir:
        dst = got
    else:
        dst = dest_for({**_meta_u, "organize": job.meta.get("organize")}, out_dir, got.suffix)
        if got != dst:
            shutil.move(str(got), dst)
    shutil.rmtree(tmp, ignore_errors=True)
    if _meta_u or job.meta.get("thumbnail"):
        write_tags(dst, _meta_u, job.meta.get("thumbnail"))
    job.dest = dst
    job.meta["size"] = dst.stat().st_size


def handle_browser(job: Job) -> None:
    """
    Режим «донос»: userscript прислал player response, который плеер получил внутри браузера.
    Пробуем скормить его yt-dlp через --load-info-json; не вышло - падаем в handle_url.
    Это единственный способ получить звук, когда у формата нет `url`, а только
    SABR-дескриптор: разбираться с protobuf-сессиями должен тот, кто это уже делает (yt-dlp).
    """
    # Режим «как в оригинальных приложениях»: они вообще не трогают player
    # response и googlevideo - просто зовут yt-dlp по URL, и тот сам получает
    # свой player response (и свой же po-token). Сюда же ведём и случай, когда
    # перехваченного ответа нет: load-info-json без него всё равно нечем делать.
    if job.meta.get("prefer_url") or not job.meta.get("player_response"):
        job.meta.setdefault("player_client", "tv")
        return handle_url(job)
    pdata = job.meta.get("player_response")
    if not pdata:
        raise RuntimeError("пустой player_response")
    try:
        import yt_dlp  # noqa: F401
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("yt-dlp не установлен (pip install yt-dlp) — режим browser недоступен") from e

    tmp = Path(tempfile.mkdtemp(prefix="ytm_bi_"))
    info = {
        "id": job.meta.get("videoId"),
        "extractor": "youtube",
        "extractor_key": "Youtube",
        "webpage_url": f"https://music.youtube.com/watch?v={job.meta.get('videoId')}",
        "url": f"https://music.youtube.com/watch?v={job.meta.get('videoId')}",
        "title": (job.meta.get("meta") or {}).get("title") or job.meta.get("videoId"),
        "duration": (job.meta.get("meta") or {}).get("duration"),
        "uploader": (job.meta.get("meta") or {}).get("artist"),
        "_ytm_player_response": pdata,
    }
    infof = tmp / "info.json"
    infof.write_text(json.dumps(info), encoding="utf-8")
    out_dir = out_dir_ok(job.meta.get("out_dir"), Path(DEFAULTS["out"]))
    cmd = [PYTHON, "-m", "yt_dlp", "--load-info-json", str(infof),
           "-f", _fallback_format(job),
           "--no-download-archive", "--no-write-info-json",
           "-o", str(tmp / "%(id)s.%(ext)s")]
    if job.meta.get("cookies_from_browser"):
        # профиль передаётся строкой как есть (это CLI-синтаксис yt-dlp, тут мы в CLI
        # и идём); проверка - чтобы «портативный firefox» был виден сразу, а не через
        # «could not find firefox cookies database in ...\AppData\...»
        _hint = firefox_profile_check(job.meta["cookies_from_browser"])
        if _hint:
            raise RuntimeError("cookies: " + _hint)
        cmd += ["--cookies-from-browser", str(job.meta["cookies_from_browser"])]
    if job.meta.get("cookies_file"):
        cmd += ["--cookies", str(job.meta["cookies_file"])]
    if job.meta.get("proxy"):
        # googlevideo-ссылка привязана к IP, с котором её выдали: «вкладка через VPN,
        # yt-dlp напрямую» = 403 ровно на скачивании байтов, а не на разборе
        cmd += ["--proxy", str(job.meta["proxy"])]
    p = _run_tracked(cmd, capture_output=True, text=True, timeout=3600)
    job.logs.append((p.stdout or "")[-1200:] + "\n" + (p.stderr or "")[-1200:])
    if p.returncode != 0:
        # graceful degradation: yt-dlp всё равно может уметь это по URL + cookies
        job.message = "browser-режим не сработал, пробую url-режим"
        shutil.rmtree(tmp, ignore_errors=True)     # tmp убираем ДО вызова: handle_url пишет в свой
        job.meta.setdefault("player_client", "tv")
        try:
            return handle_url(job)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    produced = sorted([f for f in tmp.iterdir() if f.suffix not in (".json", ".txt")],
                      key=lambda f: f.stat().st_size, reverse=True)
    if not produced:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError("yt-dlp отработал, но файл не появился")
    got = _real_name(produced[0])
    if looks_like_html(got):
        shutil.rmtree(tmp, ignore_errors=True)
        _ckb = bool(job.meta.get("cookies_file") or job.meta.get("cookies_from_browser"))
        raise RuntimeError("в выводе yt-dlp оказался HTML (бот-чек)" +
                           (" - cookies ПОДКЛЮЧЕНЫ, но YouTube не отдаёт поток: обычно это "
                            "временный лимит «слишком много устройств» на аккаунте или "
                            "недоверие к выходу прокси - подождать, перезалогиниться, сменить "
                            "узел; пока качай record (работает во время воспроизведения) или "
                            "«прогон через плеер» (0.5.9: страница сама запросит /player по "
                            "каждому треку - это обходит блок yt-dlp)"
                            if _ckb else " — добавь cookies в ytm-dl.ini")
                           + ("" if _alt_host_allowed(job) else
                              " · и включи «youtube.com как запас» в панели"))
    dst = dest_for({**(job.meta.get("meta") or {}), "organize": job.meta.get("organize")},
                   out_dir, got.suffix)
    shutil.move(str(got), dst)
    shutil.rmtree(tmp, ignore_errors=True)
    write_tags(dst, job.meta.get("meta") or {}, job.meta.get("thumbnail"),
               proxy=job.meta.get("proxy"))
    job.dest = dst
    job.meta["size"] = dst.stat().st_size


def _looks_like_bot_check(text: str) -> bool:
    """Признак того, что дело в недоверии к нам, а не в видео: такое стоит
    пробовать другим клиентом. «Video unavailable» - нет."""
    low = (text or "").lower()
    return any(k in low for k in ("sign in to confirm", "not a bot", "restricted",
                                  "http 403", "po token", "pot:", "requested format",
                                  "page needs to be reloaded", "gcfhr", "unexpected"))


def _fallback_format(job) -> str:
    """--extractor-args/-f для ЗАПАСНОГО прогона (когда у нас нет перехваченного
    player response). userscript при m4a шлёт `bestaudio[ext=m4a]/bestaudio/best`;
    собственный же прогон компаньона с `bestaudio/best` на web/tv-выдаче честно
    брал opus - и человек получал .webm без обложки, хотя хотел m4a."""
    spec = str(job.meta.get("format_spec") or "").strip()
    if spec:
        return spec
    want = str(job.meta.get("format") or "m4a").lower()
    if want == "mp3":
        # mp3 всё равно перекодируем сами, поэтому пусть yt-dlp принесёт самый
        # «прозрачный» исходник: m4a 256k -> LAME лучше, чем opus 128k -> LAME
        return "bestaudio[ext=m4a]/bestaudio/best"
    if want in ("opus", "webm"):
        return "bestaudio[ext=webm]/bestaudio/best"
    return "bestaudio[ext=m4a]/bestaudio/best"


_WIN = {"key": None}   # 0.6.5: (client, tuple(extra)) последнего УСПЕХА, в памяти процесса.
                       # YouTube крутит блок по доверию минутами: клиент, который проехал
                       # 20 секунд назад, с высокой вероятностью проедет и следующий трек.
                       # Специально НЕ персистим: это прогноз, а не состояние (см. урок
                       # monotonic-часов в ThrottleQueue).


def _client_ladder(chosen):
    """Клиенты, которые стоит перебрать, а не сдаваться на первом отказе.

    Порядок (по живым логам): web_safari - ФОРМАТНЫЙ клиент (у него m4a/aac есть всегда,
    и он не требует po-token), поэтому он идёт ПЕРВЫМ: «yt-dlp = дефолт» на деле означает
    web+tv, а web без cookies упирается в бот-чек и отдаёт пустой formats - отсюда и
    «скачивает webm без обложки», и «This video is not available» там, где браузер
    играет. Дальше - дефолт yt-dlp (ручной выбор человека), tv (без po-token),
    web_embedded (для «недоступно без входа»), и web_safari+missing_pot как последний
    шанс, если Safari-вариант не отдал ничего.
    Если человек задал player_client сам, перебор начинаем с ЕГО значения: в 0.5.10
    перед выбором всё равно стоял "" (дефолт yt-dlp = web без pot) и первые 30-60
    секунд жигали впустую - пользователь: «почему качает только 5-м шагом», хотя
    просил safari сразу. Первый "" остаётся только когда выбор не сделан."""
    first = [] if not chosen else [(chosen, []), ("", [])]
    # 0.6.16: цепочка клиентов - ОДИН источник правды (CLIENT_CHAIN); url-режим
    # и плейлист теперь выводят порядки из неё, а не держат два рукописных списка.
    rest = [(c, []) for c in CLIENT_CHAIN] + [("web_safari", list(MISSING_POT))]
    out, seen = [], set()
    for c, e in first + rest:
        k = (c, tuple(e))
        if k not in seen:
            seen.add(k); out.append(k)   # 0.6.5: ровно нормализованный key - иначе sticky
                                        # сравнение ('tv',()) != ('tv',[]) и дублирует шаг
    w = _WIN.get("key")   # 0.6.5: победитель сессии - ПЕРВЫМ; лестница не укорачивается,
    if w is not None:     # а переставляется: провал на липком догоняет остальные шаги
        k = tuple(w)
        if k in out:
            out.insert(0, out.pop(out.index(k)))
        else:
            out.insert(0, k)
    return out


def _yt_dlp_hint(err: str) -> str:
    """Человеческое объяснение частых падений yt-dlp (иначе в UI - простыня traceback)."""
    t = (err or "").strip().splitlines()
    tail = t[-1][:300] if t else "нет вывода"
    low = (err or "").lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return tail + " | нужен вход: запустите компаньон с --cookies-from-browser chrome (или используйте режим resolve из вкладки)"
    if "sabrendpoint" in low or "po token" in low or "pot" in low:
        return tail + " | po-token/SABR: обновите yt-dlp (pip install -U yt-dlp) и включите провайдер токенов"
    if "private video" in low or "members-only" in low:
        return tail + " | приватный/премиум-контент: нужны cookies вашего аккаунта"
    if "needs to be reloaded" in low or "too many devices" in low or "приостановлено" in low:
        # «The page needs to be reloaded» у свежих yt-dlp = YouTube не верит сессии.
        # При рабочих cookies это почти всегда временный лимит («слишком много
        # устройств») или недоверие к общему выходу прокси - повторение попыток
        # ситуацию только усугубляет, поэтому подсказка про ожидание, а не про «ещё раз»
        return tail + " | YouTube не доверяет текущей сессии: при живых cookies это обычно " \
                      "временный лимит аккаунта («слишком много устройств») или недоверие к " \
                      "выходу прокси. Подождите 1-2 часа / перезалогиньтесь / смените узел; " \
                      "пока работает record (качает во время воспроизведения)"
    if "requested format is not available" in low:
        # web_safari/web без cookies часто отдают только SABR-форматы, а их yt-dlp
        # без po-token не берёт - наружу это вылезает как «format not available»,
        # и без этой строки выглядит как «сломанный format_spec», а не как «нет cookies»
        return tail + " | пустые форматы без cookies: нужен --cookies-from-browser " \
                      "и/или JS-runtime (deno) для po-token"
    return tail


def _playlist_once(job: Job) -> None:
    """
    Целиком: плейлист / альбом / «Понравившиеся» — так же, как это делает десктопное
    приложение. Скачивание отдаётся yt-dlp (он умеет листать, резать по формату и,
    главное, вести --download-archive), а мы раскладываем результат по `out_dir`
    с теми же правилами именования и тегирования, что и в одиночных режимах.
    """
    url, liked = resolve_playlist_url(job.meta.get("playlist_url") or job.meta.get("url"))
    if not url:
        raise RuntimeError("нужна ссылка вида /playlist?list=... или /watch?...&list=... (либо строка \"liked\")")
    try:
        import yt_dlp  # noqa: F401
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("yt-dlp не установлен (pip install -U yt-dlp) — режим playlist недоступен") from e

    out_dir = out_dir_ok(job.meta.get("out_dir"), Path(DEFAULTS["out"]))
    job.message = f"плейлист ({'понравившиеся' if liked else url.split('list=')[-1]})"
    if job.meta.get("dry_run"):          # проверка дедупликации без обращения к YouTube
        job.meta["url"], job.meta["liked"] = url, liked
        job.progress = 1.0
        job.message += " · dry_run: разбор пропущен"
        return

    tmp = Path(tempfile.mkdtemp(prefix="ytm_pl_"))
    want_fmt = (job.meta.get("format") or "m4a").lower()
    opts: dict = {
        # outtmpl обязан быть АБСОЛЮТНЫМ: с «path» + «%(id)s.%(ext)s» yt-dlp в плейлист-
        # режиме писал часть файлов в cwd проекта (проверено живым прогоном), а наш
        # «есть ли файл в tmp» принимал это за «уже скачано ранее».
        "outtmpl": str(tmp / "%(id)s.%(ext)s"),
        "format": job.meta.get("format_spec") or _fallback_format(job),
        "noplaylist": False,
        # extract_flat обязан быть False: если он наследуется из ~/.config/yt-dlp/config
        # (или переменных окружения), yt-dlp вообще не качает — и тогда «0 файлов»
        # выглядело бы как успех.
        "extract_flat": False,
        "ignoreerrors": True,           # 1 битый трек не должен обрывать 200 остальных
        "quiet": True, "no_warnings": True,
        "restrictfilenames": False,
        "writethumbnail": want_fmt in ("m4a", "mp3"),   # обложку пишем только куда умеем
        "download_archive": str(archive_path(out_dir)),
        "windowsfilenames": True,
    }
    if job.meta.get("items"):
        # подмножество, как --playlist-items: "1-10", "1,3,7", "-5" — полезно на
        # трёхтысячных «понравившихся», когда надо проверить/докачать только хвост
        opts["playlist_items"] = str(job.meta["items"])
    if job.meta.get("cookies_from_browser"):
        # ВАЖНО: кортеж, а не строка (см. cookies_from_browser_tuple) - иначе
        # портативный Firefox через API не работает вовсе
        _tup, _hint = cookies_from_browser_tuple(job.meta["cookies_from_browser"])
        if _hint:
            raise RuntimeError("cookies: " + _hint)
        if _tup:
            opts["cookiesfrombrowser"] = _tup
    if job.meta.get("cookies_file"):
        opts["cookiefile"] = str(job.meta["cookies_file"])
    if job.meta.get("proxy"):
        prx = str(job.meta["proxy"])
        if prx.lower().startswith("socks") and not socks_module_available():
            try:
                import yt_dlp.socks  # noqa: F401
            except Exception as e:
                raise RuntimeError("playlist over socks5: no PySocks and no yt-dlp socks "
                                   "transport - use an http:// port") from e
        opts["proxy"] = prx
    # extractor_args задаёт обёртка handle_playlist. Формат - ИМЕННО dict {arg:
    # [values,...]}: YoutubeIE читает params['extractor_args'][ie][key] через
    # traverse_obj, а список строк «player_client=tv» он бы проглотил молча
    # (лист поехал бы на web-дефолте = «The page needs to be reloaded» в логах).
    _ea = dict(job.meta.get("_pl_ea") or {})
    if _ea:
        opts.setdefault("extractor_args", {})["youtube"] = _ea
    if FF.ok:
        opts["ffmpeg_location"] = str(Path(FF.ffmpeg).parent)
    if job.meta.get("dedup") is False:
        opts.pop("download_archive")    # «скачать всё, даже уже скачанное»

    got: list[Path] = []
    moved: list[dict] = []
    noise: list[str] = []
    archived_hits: list[str] = []

    class _Ytl:
        """yt-dlp пишет «мягкие» падения (те самые, что глотает ignoreerrors) только в
        logger. Без него handle_playlist отчитался бы `done: 0 файлов` вместо внятной
        ошибки — этот класс собирает warning/error в job.logs и в noise."""
        def debug(self, msg): pass
        def info(self, msg):
            # 0.5.11: «висит на 0%» больше не молчание: yt-dlp пишет «Destination»
            # на КАЖДУЮ дорожку, по ним и ведём счётчик прямо во время одного
            # extract_info(download=True), где промежуточных колбэков нет
            if isinstance(msg, str) and msg.startswith("[download] Destination:"):
                self._n = getattr(self, "_n", 0) + 1
                job.progress = min(0.95, 0.05 + 0.06 * self._n)
                job.message = "плейлист: скачиваю дорожку %d" % self._n
        def warning(self, msg): self._e(msg)
        def error(self, msg): self._e(msg)
        def _e(self, msg):
            msg = (msg or "").strip()
            if msg and msg not in noise:
                noise.append(msg)
                job.logs.append(msg[:400])
                # 0.5.12: когда НИЧЕГО не скачивается (форматы пусты у всех клиентов),
                # строк Destination нет вовсе - и панель опять молчала бы до финального
                # вердикта. Считаем и отвалившиеся позиции: прогресс идет, и он честный.
                if "ERROR" in msg and "[youtube]" in msg:
                    self._d = getattr(self, "_d", 0) + 1
                    job.progress = min(0.95, 0.05 + 0.06 * (getattr(self, "_n", 0) + self._d))
                    job.message = "плейлист: скачано дорожек %d, отвалились %d" % (
                        getattr(self, "_n", 0), self._d)

    archived = failed = lost = 0
    total_pos = 0            # сколько позиций было в листе вообще (для честного «0 из N»)
    last_err = ""

    def count_archived_hits():
        """Кто именно пропал из выдачи из-за download_archive (yt-dlp заменяет такие
        позиции None / пустым списком) — без этого «всё уже скачано» неотличимо от
        «плейлист недоступен», и пользователь получает ложную ошибку."""
        n = 0
        try:
            popts = {"quiet": True, "no_warnings": True, "extract_flat": "in_playlist", "ignoreerrors": True}
            if opts.get("playlist_items"):
                popts["playlist_items"] = opts["playlist_items"]
            if job.meta.get("cookies_from_browser"):
                # раньше сюда летела одна строка в 1-кортеже: yt-dlp её не разворачивает
                # и probe падал молча (в логах только "archive probe failed")
                _pt, _ph = cookies_from_browser_tuple(job.meta["cookies_from_browser"])
                if _ph:
                    raise RuntimeError("cookies: " + _ph)
                if _pt:
                    popts["cookiesfrombrowser"] = _pt
            if job.meta.get("cookies_file"):
                popts["cookiefile"] = str(job.meta["cookies_file"])
            probe = yt_dlp.YoutubeDL(popts)
            li = probe.extract_info(url, download=False) or {}
            for ent in (li.get("entries") or []):
                if ent and ent.get("id") and archive_has(out_dir, ent["id"]):
                    archived_hits.append(ent["id"])
                    n += 1
        except Exception as e:  # noqa: BLE001  — probe best-effort, не роняем задачу
            job.logs.append(f"archive probe failed: {str(e)[:160]}")
        return n

    try:
        _imp = impersonate_target()
        if _imp:
            # API ждёт ImpersonateTarget, а не строку: строка внутри yt-dlp натыкается
            # на assert с ПУСТЫМ сообщением - так в 0.5.6 появился «yt-dlp: нет вывода».
            # В CLI (--impersonate chrome) строка - правильный формат, там ничего не трогаем.
            try:
                from yt_dlp.networking.impersonate import ImpersonateTarget
                opts["impersonate"] = ImpersonateTarget.from_str(_imp)
            except Exception as _ie:  # noqa: BLE001
                # на совсем старом (или тестовом) yt-dlp без impersonate-модуля лучше
                # запустить без флага, чем убить всю задачу; в CLI --impersonate не трогаем
                _ytm_log_line(f"[playlist] impersonate skipped: {type(_ie).__name__}: {str(_ie)[:120]}")
        with yt_dlp.YoutubeDL({**opts, "logger": _Ytl()}) as ydl:
            info = ydl.extract_info(url, download=True)
            entries = (info or {}).get("entries") or []
            total_pos = len(entries)
            if not entries and read_archive(out_dir):
                archived = count_archived_hits()
                if archived:
                    job.meta.update({"url": url, "liked": liked, "files": [], "count": 0,
                                     "archived_only": archived, "archived_ids": archived_hits,
                                     "failed": 0, "lost": 0, "archive": str(archive_path(out_dir))})
                    job.dest = out_dir
                    job.progress = 1.0
                    job.message = f"всё уже скачано ({archived}) — new 0"
                    return
                raise RuntimeError(
                    "плейлист пуст или недоступен: "
                    + (next((x for x in reversed(noise) if "ERROR" in x), noise[-1] if noise else "yt-dlp вернул 0 позиций"))
                    + " — для аккаунтных/liked-листов нужен --cookies-from-browser")
            last_err = ""
            # 0.6.2: урожай videoId упавших позиций собираем ОДИН раз и ДО цикла.
            # Было: next(x for x in reversed(noise) if "[youtube] " in x) — то есть
            # ОДНА последняя строка шума на каждую упавшую позицию. Но noise (см.
            # _Ytl) — накопительный список на ВЕСЬ прогон листа, а цикл по entries
            # идёт уже ПОСЛЕ того, как extract_info отработал все позиции. Значит к
            # этому моменту в noise лежат ошибки всех трупов сразу, и каждая итерация
            # находила один и тот же последний videoId; дедуп по videoId добивал
            # остальные. Живое следствие в логе владельца: панель пишет
            # «не скачалось 10», а salvage — «добиваю 1/1», потому что в _pl_failed
            # легла ровно одна запись из десяти. Добивание одиночным путём — это как
            # раз тот механизм, который по докстрингу _playlist_salvage «вывозит на
            # заблокированных аккаунтах там, где плейлистный extract падает на
            # Requested format is not available у всех позиций сразу», то есть баг
            # выключал его ровно в той ситуации, ради которой он написан.
            # Берём только ERROR-строки: предупреждение с тем же id не повод считать
            # позицию павшей и гонять её по лестнице второй раз.
            _harvest: list[tuple[str, str]] = []
            _seen_ids: set[str] = set()
            for _mm in re.finditer(
                    r"\[youtube\] ([A-Za-z0-9_-]{11}): ([^|\n]{0,200})",
                    "\n".join(x for x in noise if "ERROR" in x and "[youtube]" in x)):
                if _mm.group(1) not in _seen_ids:
                    _seen_ids.add(_mm.group(1))
                    _harvest.append((_mm.group(1), _mm.group(2)))
            for ent in entries:
                if ent is None:
                    # ignoreerrors: None = позиция, которую yt-dlp не смог ни разобрать,
                    # ни скачать (приватное, удалённое, скрытое YouTube из выдачи). Это не
                    # «архивный пропуск», но и не то же самое, что ошибка разбора — считаем
                    # отдельно, чтобы «все треки пропали» не выглядело пустым успехом.
                    lost += 1
                    # 0.5.12: при ignoreerrors упавшая позиция приходит как None, и
                    # видеоид из нее не вытащить - но его пишет логгер («ERROR:
                    # [youtube] <id>: причина»). Забираем id и несем в _pl_failed:
                    # иначе добивание вежливо смотрело на пустой список, пока 10
                    # трупов лежали в "lost". С 0.6.2 берём ВСЕ собранные id, а не
                    # последний; дедуп не даёт задвоить на следующей итерации.
                    lst = job.meta.setdefault("_pl_failed", [])
                    for _vid, _err in _harvest:
                        if not any(x.get("videoId") == _vid for x in lst):
                            lst.append({"videoId": _vid, "err": _err})
                    continue
                # download_archive говорит о пропуске так: позиция приходит ГОТОВОЙ
                # (url + requested_downloads есть), а файла нет, потому что yt-dlp сам
                # решил не качать. Отличаем это от «скачивание упало» — иначе второй прогон
                # того же листа выглядел бы как провал, а не как «всё уже скачано».
                vid = ent.get("id")
                dl = (ent.get("requested_downloads") or [{}])[0]
                real = Path(dl["filepath"]) if dl.get("filepath") else None
                if ent.get("skipped") == "archive":
                    archived += 1
                    archived_hits.append(str(vid))
                    continue
                f = real if (real and real.exists()) else (tmp / f"{vid}.{(ent.get('ext') or 'm4a')}")
                if not f.exists():
                    cand = sorted(tmp.glob(f"{vid}.*"), key=lambda x: x.stat().st_size, reverse=True)
                    f = cand[0] if cand else f
                # 0.5.8: главное место утечки « (1)». Если в папке уже лежит файл с
                # этим базовым именем (архив молчит, yt-dlp зря перекачал трек в tmp) -
                # выбрасываем свежий кусок и считаем позицию архивным пропуском.
                # Проверка ДО ветки «файла нет»: так закрываются оба исхода сразу.
                if job.meta.get("dedup", True):
                    _taken = dest_taken({"title": ent.get("title"), "artist": ent.get("uploader"),
                                         "album": ent.get("album"),
                                         "organize": job.meta.get("organize")}, out_dir)
                    if _taken is not None:
                        try:
                            if f.exists():
                                f.unlink()
                        except OSError:
                            pass
                        archived += 1
                        if vid:
                            archived_hits.append(str(vid))
                            archive_add(out_dir, str(vid), str(ent.get("title") or ""))
                        continue
                if not f.exists():
                    # «пропуск по архиву» без skip-флага: yt-dlp не скачал, но и не ошибся
                    if vid and archive_has(out_dir, str(vid)):
                        archived += 1
                        archived_hits.append(str(vid))
                    else:
                        failed += 1
                        last_err = str(ent.get("_error") or "файл не создан (бот-чек? см. logs)")[:200]
                        # 0.5.11: заводим список павших - handle_playlist доберёт их
                        # одиночным путём (лестница клиентов), который реально пашет,
                        # когда плейлистный extract всех позиций умер на форматах
                        if vid:
                            job.meta.setdefault("_pl_failed", []).append({
                                "videoId": str(vid), "title": ent.get("title"),
                                "artist": ent.get("uploader"), "album": ent.get("album"),
                                "track": ent.get("playlist_index"), "duration": ent.get("duration"),
                                "thumbnail": ent.get("thumbnail"), "err": last_err})
                    continue
                meta = {
                    "title": ent.get("title"), "artist": ent.get("uploader"),
                    "album": ent.get("album"), "track": ent.get("playlist_index"),
                    "duration": ent.get("duration"), "thumbnail": ent.get("thumbnail"),
                }
                # webm/opus -> m4a: yt-dlp отдаёт webm, а iTunes-atoms (теги, обложка) в нём
                # не живут; «скопировать» opus в mp4 значит получить файл, который обычный
                # плеер не узнает. Честный путь — перекодировать в AAC, и об этом пишем в logs.
                conv = webm_transcode(f, want_fmt, job, out_dir, meta)
                if conv:
                    f, note = conv
                    job.logs.append(note)
                ext = f.suffix
                if f.parent == out_dir:
                    dst = f        # 0.5.10: transcode уже положил файл под итоговым именем
                else:
                    dst = dest_for({**meta, "organize": job.meta.get("organize")}, out_dir, ext)
                    if not dst.exists() and f != dst:
                        shutil.move(str(f), dst)
                # Обложка: с writethumbnail yt-dlp кладёт sidecar «<имя>.jpg» (в tmp —
                # пока файл не переехал, и рядом с dst — после переезда). Забираем байты,
                # отдаём их write_tags (он пишет covr/APIC и умеет ffmpeg-fallback), и
                # только тогда удаляем sidecar, чтобы в папке с музыкой не плохались .jpg.
                raw_cover = None
                sidecars = [c for c in (list(tmp.glob(f"{vid}.*.jpg")) + list(tmp.glob(f"{dst.stem}*.jpg"))
                                        + list(out_dir.glob(f"{dst.stem}*.jpg")))
                            if c.is_file()]
                for cand in sidecars:
                    try:
                        raw_cover = cand.read_bytes()
                        if raw_cover:
                            break
                    except OSError:
                        continue
                for cand in sidecars:
                    try:
                        cand.unlink(missing_ok=True)
                    except OSError:
                        pass
                write_tags(dst, meta, None, raw_cover)
                moved.append({"videoId": vid, "title": meta.get("title"), "dest": str(dst),
                              "size": dst.stat().st_size})

    except Exception as e:  # noqa: BLE001
        # 0.5.7: пустые сообщения исключений (AssertionError от API-impersonate,
        # например) не должны выглядеть как «нет вывода» - держим имя класса,
        # а настоящий текст и след - в ytm-run.log
        t = (str(e) or "").strip() or f"{type(e).__module__}.{type(e).__name__}"
        _ytm_log_line(f"[job {job.id}] playlist exc: {t[:200]} | "
                      + traceback.format_exc(limit=1)[-300:].replace(chr(10), " "))
        if _playlist_error_is_client(t) and not job.meta.get("_pl_second"):
            raise PlaylistFallback(t) from e
        raise RuntimeError(f"yt-dlp: {_yt_dlp_hint(t)}") from e
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # причина из логгера (yt-dlp пишет туда настоящие ERROR) важнее моего дефолтного
    # «файл не создан» — иначе в UI остаётся общая формулировка вместо «Private video»
    real_err = next((m for m in reversed(noise) if "ERROR" in m), "")
    if real_err or not last_err:
        last_err = real_err or last_err
    job.meta.update({"url": url, "liked": liked, "files": moved, "count": len(moved),
                     "archived_only": archived, "failed": failed, "lost": lost,
                     "last_error": last_err, "archive": str(archive_path(out_dir))})
    job.dest = out_dir
    job.progress = 1.0
    bits = []
    if moved:
        bits.append(f"готово: {len(moved)} файл(ов)")
    if archived:
        bits.append(f"уже было в архиве: {archived}")
    if failed or lost:
        bits.append(f"не скачалось: {failed + lost}")
    if job.meta.get("salvaged"):
        bits.append(f"одиночно добито: {job.meta['salvaged']}")   # 0.5.11
    if not entries and not (moved or failed or lost):
        # было ровно 0 позиций и archived=0: раньше отсюда уходило сообщение «пусто»,
        # и в панели стояло «компаньон:  · 100%» — неотличимо от «лист пустой»
        bits.append(f"yt-dlp вернул 0 позиций из {total_pos}")
    job.message = ", ".join(bits) or ("пусто: 0 файлов" + (f" — {last_err}" if last_err else " — см. logs"))
    if not moved and not archived:
        # «0 файлов» — это не успех: молчаливый done с пустым списком был главным
        # обманом этого режима (проверено живым прогоном на закрытом плейлисте).
        # Сначала - право на второй клиент (см. handle_playlist), потом уже крик.
        raise PlaylistFallback(f"ни один трек не скачался ({failed or lost or total_pos}) — "
                              f"последнее: {_yt_dlp_hint(last_err) if last_err else 'см. logs'}")


def _playlist_error_is_client(text: str) -> bool:
    """по тексту ошибки понять, что виноват КЛИЕНТ, а не лист/ссылка/cookies"""
    t = (text or "").lower()
    return ("reloaded" in t or "not a bot" in t or "sign in" in t or "please wait" in t
            or "requested format" in t or "no formats" in t
            or "unable to download api page" in t
            or ("unable to extract" in t and "playlist" not in t))


def _playlist_salvage(job: "Job") -> int:
    """0.5.11: позиции, которые плейлистная лесенка (browse + смена клиентов разом)
    не смогла, добираем ОДИНОЧНЫМ путём handle_url: у него web_safari+missing_pot
    стоит последним шансом и на заблокированных аккаунтах вывозит ровно там, где
    extract_info плейлиста падает на «Requested format is not available» у всех
    позиций сразу. Имена, дедуп, теги и обложка - те же (handle_url сам)."""
    # 0.5.11: добиваем ТОЛЬКО то, что похоже на вину клиента/форматов: приватное
    # видео или «не доступно» одиночный путь тоже не возьмёт, а 4 попытки по
    # лестнице на каждый труп = лишняя минута в тишине
    fails = [f for f in (job.meta.get("_pl_failed") or [])
             if f.get("videoId") and not f.get("_tried") and _playlist_error_is_client(str(f.get("err") or ""))]
    if not fails:
        return 0
    prev_msg = job.message
    out_dir = out_dir_ok(job.meta.get("out_dir"), Path(DEFAULTS["out"]))
    saved = 0
    dead_run = 0
    for k, f in enumerate(fails, 1):
        f["_tried"] = True
        if job.cancelled:   # 0.6.4
            job.logs.append("salvage: остановлено пользователем; остальное - повтором листа или retry-очередью")
            break
        # 0.5.13: темп и торможение. Добивание без пауз превращало «10 падений» в
        # 50 плотных запросов и укладывало аккаунт пластом (пользователь: «один трек
        # взяло, больше не удалось»). Пауза между дорожками + стоп после трёх трупов
        # подряд: повтор кнопки позже докачает остальное - архив не даст дважды.
        if k > 1:
            time.sleep(4.0)
        job.message = "плейлист: добиваю %d/%d одиночным путём" % (k, len(fails))
        sub = Job(id=f"{job.id}-s{k}", kind="url", dest=out_dir)
        sub.meta = dict(job.meta)
        sub.meta.pop("_pl_failed", None)
        sub.meta["url"] = f"https://music.youtube.com/watch?v={f['videoId']}"
        sub.meta["meta"] = {kk: f[kk] for kk in
                            ("title", "artist", "album", "track", "duration", "thumbnail") if f.get(kk)}
        if f.get("thumbnail"):
            sub.meta["thumbnail"] = f["thumbnail"]
        _ytm_log_line(f"[job {job.id}] playlist salvage {k}/{len(fails)}: {f['videoId']}")
        try:
            handle_url(sub)
            saved += 1
            job.meta.setdefault("files", []).append(
                {"videoId": f["videoId"],
                 "title": (sub.meta.get("meta") or {}).get("title") or f.get("title"),
                 "dest": str(sub.dest), "salvaged": True})
        except Exception as e:  # noqa: BLE001
            err = str(e)
            if _looks_like_bot_check(err) or "слишком много устройств" in err.lower():
                _queue_throttled(sub, f["videoId"], "playlist salvage: лимит YouTube")
            job.logs.append(f"salvage {f['videoId']}: {err[:160]}")
            dead_run += 1
            if dead_run >= 3:
                job.logs.append("salvage stop: три позиции подряд легли - аккаунт "
                                "лимитит; повтори плейлист позже, скачанное архив пропустит")
                break
        else:
            dead_run = 0
    else:
        job.message = prev_msg          # «не скачалось: N» в панели важнее «добиваю»
    if saved:
        m = job.meta
        # 0.6.3: спасённые позиции надо вычитать из ОБЕИХ корзин. Позиция, которую
        # yt-dlp не смог ни разобрать ни скачать, приходит как ent is None и уходит
        # в lost, а не в failed; старый код делал max(0, failed - saved) и в боевом
        # прогоне 0.6.2 не менял ровным счётом ничего — все десять треков альбома
        # легли именно в lost, failed был нулём, max(0, 0-10) = 0. Порядок корзин
        # (сначала failed, потом lost) значения не имеет: сумма та же, а в сообщение
        # идёт именно сумма.
        rest = saved
        for key in ("failed", "lost"):
            take = min(int(m.get(key) or 0), rest)
            m[key] = int(m.get(key) or 0) - take
            rest -= take
        m["salvaged"] = int(m.get("salvaged") or 0) + saved
        # 0.5.12: спасённое - такие же файлы, как usual: count обязан их учитывать,
        # иначе done с count=0 и «пустой папкой» снова выглядит обманом
        m["count"] = len(m.get("files") or [])
        # 0.6.3: сообщение ПЕРЕСОБИРАЕМ из исправленных счётчиков, а не подменяем в
        # нём слово. Здесь был .replace("плейлист: добиваю", "плейлист: добито одиночно"),
        # но ветка for/else выше возвращает job.message к prev_msg — тому самому
        # «не скачалось: N», которое _playlist_once сложил ДО добивания и с которым
        # потом выбросил PlaylistFallback. Подмена слова в строке «не скачалось: 10»
        # не срабатывала, и панель до самого конца утверждала, что всё пропало, хотя
        # файлы один за другим ложились в папку. Владелец скачал весь альбом из 10
        # треков, а в логе висело «не скачалось: 10» — расхождение стало видно только
        # после того, как 0.6.2 научил salvage перебирать все позиции, а не одну.
        # Формулировки берём те же, что в _playlist_once, чтобы панель не заговорила
        # на втором языке.
        left = int(m.get("failed") or 0) + int(m.get("lost") or 0)
        got = int(m.get("count") or 0)
        bits = []
        if got:
            bits.append(f"готово: {got} файл(ов)")
        if int(m.get("archived_only") or 0):
            bits.append(f"уже было в архиве: {m['archived_only']}")
        bits.append(f"одиночно добито: {m['salvaged']}")
        if left:
            bits.append(f"не скачалось: {left}")
        job.message = ", ".join(bits)
        job.logs.append(f"playlist salvage: вытащено {saved}")
        if m.get("last_error"):
            m["last_error"] = f"{m.get('last_error')} · одиночно вытащено {saved}"
    return saved


def _playlist_client_variants(job):
    """Варианты youtube extractor-args. Первый - вежливый: то, что просили (tv из
    userscript'а), ЗАПЯТАЯ + web_safari: yt-dlp сам переключится, если у tv пустой
    response. Второй - web_safari + formats=missing_pot: ровно то, чем лечится
    «The page needs to be reloaded», когда po-token не отдаётся."""
    chosen = [c for c in dict.fromkeys(x.strip() for x in
                str(job.meta.get("player_client") or "").split(",") if x.strip())]
    w = _WIN.get("key")
    if w and w[0] and not w[1] and w[0] not in chosen:
        chosen = [w[0]] + list(chosen)   # 0.6.5: лист тоже стартует с proven-клиента,
    first = chosen + [c for c in ("web_safari",) if c not in chosen]   # иначе «сначала гоняет безуспешно»
    # второй заход - тот же клиент, но formats=missing_pot: YouTube отказывает в
    # po-token'е, и yt-dlp по умолчанию ВЫБРАСЫВАЕТ все форматы; с этим флагом он
    # отдаёт их как есть, и скачивание идёт. Третий - web_embedded (не требует pot
    # вообще, но отдаёт только безопасные форматы).
    return [{"player_client": first or [CLIENT_CHAIN[0]]},
            {"player_client": [CLIENT_CHAIN[0]], "formats": ["missing_pot"]},
            {"player_client": [CLIENT_CHAIN[3]]}]   # 0.6.16: те же константы, что и у url-лестницы


def _playlist_host_swap(job: "Job") -> "str | None":
    """0.5.5: плейлисты с нейтральным к хосту id (PL/RD/OLK/UU/FU) существуют и на
    www.youtube.com - если browse Музыки отвечает 400/лимитом, тот же list
    перечитывается там. «Понравившиеся» НЕ переносим: у liked нет двойника на www
    (LM - ДРУГОЙ список), подменить его молча = украсть у пользователя состав."""
    u = str(job.meta.get("playlist_url") or job.meta.get("url") or "")
    if "music.youtube.com" not in u:
        return None
    m = re.search(r"[?&]list=((?:PL|RD(?!CLAK)|OLK|UU|FU)[A-Za-z0-9_-]{4,})", u)
    if not m:
        return None
    nu = f"https://www.youtube.com/playlist?list={m.group(1)}"
    job.meta["playlist_url"] = nu
    return nu


def handle_playlist(job: Job) -> None:
    """Одна попытка = _playlist_once; если все позиции упали так, будто виноват
    клиент, - ещё заходы с другими extractor-args. С 0.5.5: если и они сдохли на
    browse (400/reloaded), для хост-нейтрального листа добавляется ВТОРОЙ круг уже
    на www.youtube.com - лимиты у Music и видеохостинга независимые, листы те же."""
    last = None
    for _hi in range(2):
        variants = _playlist_client_variants(job)
        if job.cancelled:   # 0.6.4: между ЗАХОДАМИ (сам extract_info прерывать не будем -
            raise RuntimeError("остановлено пользователем")   # он и так атомарный на лист)
        for n, ea in enumerate(variants):
            job.meta["_pl_ea"] = ea
            job.meta["_pl_second"] = bool(n)
            if n:
                job.message = "плейлист: заход %d/%d%s" % (
                    n + 1, len(variants), " (после смены хоста)" if _hi else "")
                job.logs.append("playlist retry: youtube:"
                                + " ".join(f"{k}={','.join(v)}" for k, v in ea.items()))
            elif _hi:
                job.message = "плейлист: перечитываю лист на www.youtube.com"
            try:
                _playlist_once(job)
                # 0.5.11: часть позиций могла лечь на форматах - добираем их ОДИНОЧНЫМ
                # путём (тот же handle_url, что у пользователя вывозит на 5-м шаге)
                _playlist_salvage(job)
                return
            except PlaylistFallback as e:
                last = e
                if _playlist_salvage(job):
                    # лесенка клиентов в API-режиме не смогла, а одиночный путь смог:
                    # считаем лист скачанным, что успели - уже в архиве и на месте
                    return
        # 0.5.10: круг www для плейлиста - автоматика: это НЕ запасная закачка стрима
        # (та - только по галочке), а перечитывание того же list, когда browse Музыки
        # уперся в 400. Без него «скачать весь плейлист» умирало ровно тогда, когда
        # раньше работал - пользователь: «скачать плейлист не работает тоже».
        if not _hi and _playlist_host_swap(job):
            job.logs.append("playlist host fallback: перечитываю тот же list на www.youtube.com")
            _ytm_log_line(f"[job {job.id}] playlist: browse на music не отдал лист - "
                            "пробую тот же list на youtube.com")
            continue
        break
    msg = str(last) if last else "плейлист: неизвестная ошибка"
    if "api page" in msg.lower() or "400" in msg:
        msg += (" - browse-эндпоинт Музыки не отдаёт лист (тот же лимит аккаунта на "
                "Music-стороне); хост-нейтральные листы уже перечитаны через www, а "
                "«Понравившиеся» привязаны к Music-домену - попробуйте через несколько часов")
    for f in (job.meta.get("_pl_failed") or []):
        if f.get("videoId") and _playlist_error_is_client(str(f.get("err") or "")):
            _queue_throttled(job, f["videoId"], "playlist: лимит/бот-чек YouTube")
    raise RuntimeError(msg)

HANDLERS = {"media": handle_media, "url": handle_url, "browser": handle_browser,
            "playlist": handle_playlist}


# --------------------------------------------------------------------------- HTTP

def _cors(handler: BaseHTTPRequestHandler):
    origin = handler.headers.get("Origin") or ""
    if re.match(r"^https://([a-z0-9-]+\.)*youtube\.com$", origin):
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-YTM-Token")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")


_LOG_MIRROR: dict[str, float] = {}   # текст -> когда написан (дедуп зеркала /log)


class Handler(BaseHTTPRequestHandler):
    server_version = f"YTMDLCompanion/{API_VERSION}"
    queue: Queue = None  # type: ignore
    cfg: dict = {}
    throttle: ThrottleQueue = None  # type: ignore

    def log_message(self, fmt: str, *a):  # тихий лог
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))

    def _send(self, code: int, payload, extra: dict | None = None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        if not isinstance(payload, bytes):
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        _cors(self)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _check_token(self) -> bool:
        want = self.cfg.get("token")
        if not want:
            return True
        got = self.headers.get("X-YTM-Token") or (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
        return got == want

    def do_OPTIONS(self):  # CORS preflight
        self.send_response(204)
        _cors(self)
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/throttle-queue/"):
            if not self._check_token():
                return self._send(403, {"error": "bad token"})
            tq = self.throttle
            if u.path == "/throttle-queue/status":
                return self._send(200, tq.status())
            if u.path == "/throttle-queue/list":
                return self._send(200, {"items": tq.list()})
            return self._send(404, {"error": "not found"})
        if u.path == "/hello":
            return self._send(200, {
                "name": "ytm-dl-companion", "api": API_VERSION,
                "ffmpeg": bool(FF.ok), "ffmpeg_path": FF.ffmpeg, "mutagen": HAVE_MUTAGEN,
                "yt_dlp": _yt_dlp_version(), "out": str(self.cfg["out"]),
                # «где лежит база уже скачанного» — чтобы userscript мог показать это в /ping
                "archive": str(archive_path(self.cfg["out"])),
                "archived": len(read_archive(self.cfg["out"])),
                "cookies_from_browser": self.cfg.get("cookies_from_browser"),
                "cookies_file": self.cfg.get("cookies_file"),
                # откуда взялись cookies (ini / автомат по cookies.txt в корне): панель
                # обязана показывать источник, иначе «файл лежит, но не работает» читают
                # как «компаньон сломался»
                "cookies_how": self.cfg.get("cookies_how"),
                "player_client": self.cfg.get("player_client"),
                "impersonate": impersonate_target(),
                # «proxy= пуст, но мы унаследили системный» - панель должна это видеть,
                # иначе человек решит, что прокси не применён
                "proxy": self.cfg.get("proxy"), "proxy_effective": self.cfg.get("proxy_effective"),
                "proxy_direct": self.cfg.get("proxy_direct", False),
                # версия сборки - панель показывает её рядом со своей: «почему не чинится»
                # чаще всего объясняется устаревшей стороной, а не логикой
                "build": APP_VERSION, "convert": self.cfg.get("convert") or None,
                # 0.6.18 (замечание ревью про невидимость сессии): липкий победитель
                # лестницы виден в /hello - «на каком клиенте осел движок» проверяется
                # снаружи, а не гадаем по косвенным строкам.
                "sticky_client": (list(_WIN["key"]) if _WIN.get("key") else None),
                "verify": self.cfg.get("verify", True),
                "socks_module": socks_module_available(),
                # портативная диагностика: панель показывает это в /проверить, чтобы
                # «не берёт формат» не выглядело как вина скрипта
                "python": PYTHON, "root": str(ROOT),
                "js_runtime": (find_js_runtime() or [None])[0],
                # «сколько детей и задач сейчас висит» — это то, что держит папку занятой
                "children": len(CHILDREN), "active_jobs": Handler.queue.active() if Handler.queue else 0,
            })
        if u.path == "/shutdown":
            # остановка = деструктивная операция: только с localhost и только с токеном,
            # если он задан (иначе любой сайт, достучавшийся до порта, гасил бы сервер)
            if self.client_address and self.client_address[0] not in ("127.0.0.1", "::1", "localhost"):
                return self._send(403, {"error": "shutdown разрешён только с localhost"})
            if not self._check_token():
                return self._send(403, {"error": "bad token"})
            self.close_connection = True   # иначе клиент ждёт EOF, которого не будет
            self._send(200, {"ok": True, "stopped_children": kill_children(True)})

            def _die():
                time.sleep(0.4)            # даём долиться ответа
                try:
                    self.server.shutdown()
                except Exception:  # noqa: BLE001
                    pass
                kill_children(True)        # гонка: yt-dlp мог стартовать после первого прохода
                print("stopped by /shutdown")
                try:
                    sys.stdout.flush()
                except Exception:  # noqa: BLE001
                    pass
                os._exit(0)                # worker-треды daemon-ами не станут, если зависнут
            threading.Thread(target=_die, daemon=True).start()
            return
        if u.path == "/cover":  # {url, name} -> кладёт cover.<ext> рядом с треком
            q = parse_qs(u.query)
            url = (q.get("url") or [""])[0].strip()
            if not re.match(r"^https?://", url):
                return self._send(400, {"error": "нужен http(s) url картинки"})
            try:
                data = http_get_bytes(url, timeout=30, proxy=_proxy_of())
            except (RuntimeError, ImportError) as e:
                return self._send(400, {"error": str(e)})
            if not data:
                return self._send(502, {"error": "картинка не скачалась (проверь сеть/VPN; "
                                                 "для обложек из РФ нужен proxy= в ytm-dl.ini)"})
            if looks_like_html_bytes(data):
                return self._send(502, {"error": "вместо картинки пришёл текст (бот-чек)"})
            ext, mime = sniff_image(data)
            if ext == "webp" and (q.get("to") or [""])[0] == "jpg":
                data = cover_for_bytes(data)
                ext, mime = sniff_image(data)
            out_dir = out_dir_ok((q.get("out") or [None])[0], Path(DEFAULTS["out"]))
            name = safe_name((q.get("name") or ["cover"])[0] or "cover")
            dst = out_dir / (name + f".cover.{ext}")
            dst.write_bytes(data)
            return self._send(200, {"saved": str(dst), "bytes": len(data), "mime": mime})

        if u.path == "/archive":
            # берём exactly cfg["out"]: валидатор out_dir_ok вернул бы None для «честного»
            # --out вне HOME (например /mnt/music), а это только чтение своего же файла
            d = Path(self.cfg["out"])
            return self._send(200, {"out_dir": str(d), "file": str(archive_path(d)),
                                    "count": len(read_archive(d)), "ids": read_archive(d)})
        if u.path == "/has":
            qs = parse_qs(u.query)
            d = Path(self.cfg["out"])
            want = [x for x in (qs.get("ids") or [""])[0].split(",") if x]
            have = {x for x in want if x and archive_has(d, x)}
            return self._send(200, {"out_dir": str(d), "have": sorted(have),
                                    "missing": [x for x in want if x and x not in have]})
        if u.path == "/jobs":
            return self._send(200, {"jobs": [j.to_dict() for j in self.queue._jobs.values()]})
        m = re.match(r"^/job/([A-Za-z0-9_-]+)$", u.path)
        if m:
            job = self.queue.get(m.group(1))
            if not job:
                return self._send(404, {"error": "no such job"})
            if not self._check_token():
                return self._send(403, {"error": "bad token"})
            return self._send(200, job.to_dict())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._check_token():
            return self._send(403, {"error": "bad token"})
        # 0.6.20 (проверено по коду прежде, чем принять из ревью): браузер ВСЕГДА
        # несёт Origin на POST - и <form> без префлайта, и fetch. Прошлая защита
        # от чужих страниц держалась только на CORS (читателя не пустит), но слепая
        # ЗАПИСЬ проходила: любой сайт мог лить байты в /media (до 6 GiB) и спамить
        # /log. Гейт: чужой Origin - отказ; своего Origin нет (curl, .bat, тесты) -
        # не браузер, не трогаем. Легитимные origins: панель (music/www.youtube.com)
        # и localhost-страница панели инструментов.
        origin = str(self.headers.get("Origin") or "").strip()
        if origin and not re.match(
                r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
                r"|^https://([a-z0-9-]+\.)*(youtube|google)\.com$", origin):
            return self._send(403, {"error": "чужой Origin для POST"})
        u = urlparse(self.path)
        q = parse_qs(u.query)
        n = int(self.headers.get("Content-Length") or 0)
        if n > 6 * 1024 * 1024 * 1024:
            return self._send(413, {"error": "too large"})
        # 0.6.20: практичные лимиты на точках (из того же ревью, проверено:
        # раньше весь POST жил под одним 6 GiB - /log и /job столько не едят НИКОГДА)
        if u.path in ("/media", "/browser") and n > 768 * 1024 * 1024:
            return self._send(413, {"error": "поток больше 768 MiB - не верю"})
        if u.path == "/log" and n > 64 * 1024:
            return self._send(413, {"error": "лог больше 64 KiB - не верю"})
        if u.path in ("/job", "/archive/reset") and n > 1024 * 1024:
            return self._send(413, {"error": "служебный запрос больше 1 MiB - не верю"})

        if u.path == "/log":
            # зеркало панели Tampermonkey: «собрать лог» = один файл, а не
            # «F12 + скриншоты». Пишем как есть, с дедупом повторов (2 с), чтобы
            # мелькающие хуки не забивали ytm-run.log
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "bad json"})
            txt = str(data.get("text") or "").strip()[:1600].replace("\n", " ")   # 0.6.22: 300 резал вердикты скролла в самом файле лога
            lvl = str(data.get("level") or "info")[:8]
            if txt:
                now = time.time()
                prev = _LOG_MIRROR.get(txt)
                if not (prev is not None and now - prev < 2.0):
                    _LOG_MIRROR[txt] = now
                    if len(_LOG_MIRROR) > 400:
                        for k in sorted(_LOG_MIRROR, key=_LOG_MIRROR.get)[:200]:
                            _LOG_MIRROR.pop(k, None)
                    _ytm_log_line("[userscript:" + lvl + "] " + txt)
            return self._send(200, {"ok": True})

        if u.path == "/media":  # байты уже в руках браузера: складываем на диск как есть
            meta = json.loads(q.get("meta", ["{}"])[0] or "{}")
            # проверка папки ДО чтения тела: иначе отказ оставил бы в сокете непрочитанные
            # байты, и Keep-Alive-соединение «сломалось» бы на следующем запросе
            out_dir = out_dir_ok((q.get("out") or [None])[0], Path(self.cfg["out"]))
            if out_dir is None:
                self.rfile.read(min(n, 1 << 20)) if n else None
                return self._send(400, {"error": "bad out dir (только внутри домашней папки)"})
            job = Job(id=uuid.uuid4().hex[:12], kind="media",
                      dest=Path(tempfile.mkstemp(prefix="ytm_in_", suffix=".part")[1]))
            raw = job.dest
            written = 0
            with raw.open("wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(1024 * 512, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
                    written += len(chunk)
            if written == 0:
                return self._send(400, {"error": "empty body"})
            job.meta = {"raw": str(raw), "meta": meta,
                        "format": q.get("format", ["m4a"])[0],
                        "bitrate": (q.get("bitrate") or [None])[0],
                        "out_dir": str(out_dir), "organize": self.cfg.get("organize"),
                        # videoId приходит отдельным полем: по нему ищем в архиве и
                        # пишем его после успеха (meta может не иметь title, но id обязан)
                        "videoId": (q.get("videoId") or [meta.get("videoId") or ""])[0],
                        "dedup": (q.get("dedup") or ["1"])[0] not in ("0", "false", "no"),
                        "skip_ids": True,
                        "bytes": written,
                        # обложка/теги качаются тем же путём, что и всё остальное:
                        # без поля proxy write_tags полез бы в систему за прокси и на
                        # «proxy=none» падал бы таймаутом, а не молчал
                        "proxy": self.cfg.get("proxy", "") or ""}
            _pj = (q.get("proxy") or [None])[0]
            if _pj is not None:
                job.meta["proxy"], _ = norm_proxy(_pj)
            _cvm = str(self.cfg.get("convert") or "")
            if _cvm and str(job.meta.get("format")) != "copy":
                job.meta["format"] = _cvm
            self.queue.submit(job)
            return self._send(202, {"job": job.id, "bytes": written})

        if u.path.startswith("/job/") and u.path.endswith("/cancel"):
            # 0.6.4: «стоп» из панели. Queued - снимаем сразу; running - handler
            # заметит флаг на ближайшем чекпойнте; done - вернём status=done без лжи.
            if not self._check_token():
                return self._send(403, {"error": "bad token"})
            jid = u.path[len("/job/"):-len("/cancel")].strip("/")
            q = self.queue
            with q._lock:
                job = q._jobs.get(jid)
                if job is not None and job.status == "queued":
                    try:
                        q._q.remove(job)
                    except ValueError:
                        pass
                    job.cancelled = True
                    job.status = "cancelled"
                    job.finished = time.time()
                elif job is not None:
                    job.cancelled = True
            if job is None:
                return self._send(404, {"error": "нет такой задачи"})
            return self._send(200, {"cancelled": True, "status": job.status})

        if u.path.startswith("/throttle-queue/"):
            if not self._check_token():
                return self._send(403, {"error": "bad token"})
            try:
                payload = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "bad json"})
            tq = self.throttle
            if u.path == "/throttle-queue/retry-now":
                return self._send(200, {"updated": tq.retry_now(payload.get("vid"))})
            if u.path == "/throttle-queue/clear":
                return self._send(200, {"cleared": tq.clear(payload.get("vid"))})
            return self._send(404, {"error": "not found"})

        if u.path == "/archive/reset":
            qs = parse_qs(u.query)
            d = out_dir_ok((qs.get("out") or [None])[0], Path(self.cfg["out"])) if qs.get("out") else Path(self.cfg["out"])
            if d is None:
                return self._send(400, {"error": "bad out dir (только внутри домашней папки)"})
            f = archive_path(d)
            n = len(read_archive(d))
            try:
                f.unlink(missing_ok=True)
            except OSError as e:
                return self._send(500, {"error": f"не вышло: {e}"})
            return self._send(200, {"cleared": n, "file": str(f)})

        if u.path == "/job":  # {"kind":"url"|"browser"|"playlist", ...}
            try:
                payload = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "bad json"})
            kind = payload.get("kind") or "url"
            if kind not in HANDLERS:
                return self._send(400, {"error": f"unknown kind {kind}"})
            job = Job(id=uuid.uuid4().hex[:12], kind=kind, dest=Path(f"{self.cfg['out']}/pending"))
            if "out_dir" in payload:
                checked = out_dir_ok(payload["out_dir"], Path(self.cfg["out"]))
                if checked is None:
                    return self._send(400, {"error": "bad out_dir (только внутри домашней папки)"})
                payload["out_dir"] = str(checked)
            else:
                payload.setdefault("out_dir", self.cfg["out"])
            payload.setdefault("organize", self.cfg.get("organize"))
            # критично для портативной сборки: cookies задаются ОДИН раз в ytm-dl.ini
            # (и в --cookies-from-browser у launcher-а), а ждут их job'ы `url`/`playlist`.
            # Без этого флаг есть, но до yt-dlp не доезжает, и «Понравившееся» падает в
            # bot-check, хотя --check показывает его настроенным.
            if self.cfg.get("cookies_from_browser"):
                payload.setdefault("cookies_from_browser", self.cfg["cookies_from_browser"])
            if self.cfg.get("cookies_file"):
                payload.setdefault("cookies_file", self.cfg["cookies_file"])
            # «tv» — клиент, которому не нужен po-token: единственный способ жить вообще
            # без deno/node там, где их нельзя скачать (офлайн-машина)
            if self.cfg.get("player_client"):
                payload.setdefault("player_client", self.cfg["player_client"])
            # прокси доезжает до job'ов: у человека VPN, и «качать тем же выходом,
            # чем браузер смотрит видео» - способ не словить 403 на несовпадении IP
            if self.cfg.get("proxy"):
                payload.setdefault("proxy", self.cfg["proxy"])
            # панель может прислать proxy=none явно - нормализуем ДО meta, чтобы
            # ни один обработчик не увидел «none» как адрес прокси
            if payload.get("proxy") is not None:
                _pv, _pd = norm_proxy(payload["proxy"])
                payload["proxy"] = _pv
                if _pd:
                    payload["proxy_direct"] = True
            # convert= из ini/json - перестраховка «плеер не ест контейнер»: бьём
            # поверх запроса панели, но только если человек НЕ выставил copy (copy =
            # «отдай сырые байты как есть», это неприкосновенно)
            _cvj = str(self.cfg.get("convert") or "")
            if _cvj and str(payload.get("format") or "") != "copy":
                payload["format"] = _cvj
            job.meta = payload
            self.queue.submit(job)
            return self._send(202, {"job": job.id})

        return self._send(404, {"error": "not found"})


def _yt_dlp_version() -> str | None:
    try:
        import yt_dlp

        return yt_dlp.version.__version__
    except Exception:
        return None


DEFAULTS: dict = {"out": Path.home() / "Music" / "ytm", "organize": None}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Local companion for the YTM userscript")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    # «force convert» и «verify» обычно приходят из ytm-dl.json / ytm-dl.ini; флаги -
    # для ручного запуска. convert=mp3 = перестраховка «контейнер не подходит плееру»,
    # verify=0 = отключить декод-проверку готового файла (медленные диски).
    ap.add_argument("--convert", default=None, metavar="FMT", help="принудительный выход: m4a|mp3|opus")
    ap.add_argument("--verify", default=None, metavar="0|1", help="проверять файл декодированием (0=выкл)")
    ap.add_argument("--impersonate", default=None, metavar="MODE",
                    help="TLS-отпечаток запросов yt-dlp: auto|off|<цель curl_cffi>")
    ap.add_argument("--out", default=str(DEFAULTS["out"]), help="куда складывать файлы")
    ap.add_argument("--organize", choices=["none", "album"], default="none")
    ap.add_argument("--token", default=os.environ.get("YTM_TOKEN"),
                    help="необязательная строка-пароль (браузер должен присылать X-YTM-Token)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--archive", default=None,
                    help="файл архива «уже скачано» (по умолчанию <out>/.ytm-archive.txt)")
    ap.add_argument("--proxy", default=None,
                    help="http(s)/socks прокси для yt-dlp (напр. http://127.0.0.1:1080) - когда "
                         "браузер в VPN, а yt-dlp ходит напрямую и ловит бот-чек по другому IP")
    ap.add_argument("--player-client", default=None,
                    help="youtube:player_client для yt-dlp (tv — не требует po-token и потому работает "
                         "без JS-runtime; web — нужен po-token, т.е. deno/node)")
    ap.add_argument("--cookies-file", default=None,
                    help="файл cookies в формате Netscape (--cookies в yt-dlp); нужно Firefox-пользователям: "
                         "профиль браузера залочен, пока Firefox открыт")
    ap.add_argument("--cookies-from-browser", default=None,
                    help="chrome|firefox|edge|... — нужно для playlist/url-режимов на аккаунтном контенте")
    ap.add_argument("--check", action="store_true",
                    help="самодиагностика папки (python/ffmpeg/yt-dlp/mutagen/права на запись) и выход")
    ap.add_argument("--log-file", default=None,
                    help="дублировать ВЕСЬ вывод (включая трейс падения) в файл: на Windows"
                         " закрытое окно = нет никакого лога")
    ap.add_argument("--stop-other", action="store_true",
                    help="перед стартом штатно погасить компаньона, висящего на этом же порте"
                         " (он держит порт и файлы music); чужие процессы не трогаем")
    args = ap.parse_args(argv)
    # ytm-dl.json (если лежит в корне) важнее launcher-ных значений из ini: человек
    # правит один файл в Блокноте и не должен ничего пересохранять в кодировках
    jc, jwarn = load_json_cfg()
    _jused: list[str] = []
    if jwarn:
        print("  !! " + jwarn)
        _ytm_log_line("config warn: " + jwarn)
    if jc:
        for _k in ("proxy", "player_client", "cookies_from_browser", "cookies_file",
                   "convert", "verify", "impersonate"):
            if getattr(args, _k, None) in (None, "") and jc.get(_k) not in (None, ""):
                setattr(args, _k, str(jc[_k]))
                _jused.append(_k)
        if jc.get("out") and str(args.out) == str(DEFAULTS["out"]):
            args.out = str(jc["out"])
            _jused.append("out")
        if jc.get("port") and args.port == 8765:
            try:
                args.port = int(str(jc["port"]))
                _jused.append("port")
            except (TypeError, ValueError):
                print("  !! port в ytm-dl.json не число - игнорирую")
        if jc.get("token") and not args.token:
            args.token = str(jc["token"])
            _jused.append("token")
        if jc.get("organize") in ("none", "album") and args.organize in (None, "none"):
            args.organize = str(jc["organize"])
            _jused.append("organize")
        if _jused:
            _jm = "ytm-dl.json применён: " + ", ".join(sorted(set(_jused)))
            print("  config    : " + _jm)
            _ytm_log_line("config: " + _jm)

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    DEFAULTS.update({"out": out, "organize": args.organize})
    # лог launcher-а: открываем СРАЗУ, чтобы в него попал и трейс падения на старте
    sys._ytm_log = None
    if args.log_file:
        try:
            lf = Path(args.log_file).expanduser()
            lf.parent.mkdir(parents=True, exist_ok=True)
            # binary: stdout потом пишется ПОВЕРХ этого файла, поэтому в лог попадёт
            # и banner, и трейс, и всё, что человек видит в окне
            sys._ytm_log = open(lf, "ab", buffering=0)
            _ytm_log_line("ytm-dl companion start  cwd=" + os.getcwd() + "  python=" + sys.version.split()[0] + "  log-file=" + str(lf))
        except Exception as e:  # noqa: BLE001
            sys._ytm_log = None
            print("  !! --log-file " + str(args.log_file) + " не открыт: " + str(e))
    if args.archive:
        # «папка = папка, файл = файл»: принимаем и каталог, и путь к .txt
        p = Path(args.archive).expanduser()
        a_dir, a_name = (p, ARCHIVE_NAME) if not p.suffix else (p.parent, p.name)
        a_dir.mkdir(parents=True, exist_ok=True)
        ARCHIVE_DIR.update({"dir": a_dir, "name": a_name})

    cookies_file = str(Path(args.cookies_file).expanduser()) if args.cookies_file else None
    cookies_how = "из ytm-dl.ini/CLI" if cookies_file else ""
    if cookies_file and not Path(cookies_file).exists():
        print(f"  !! cookies-файл не найден: {cookies_file} — аккаунтный контент упадёт в bot-check")
    if not cookies_file and not args.cookies_from_browser:
        # «кинул cookies.txt рядом с ytm.bat» — самое частое, что человек делает руками;
        # раньше это выглядело как «компаньон не видит куки», потому что строка в ini
        # всё ещё была пуста
        cookies_file = cookies_txt_nearby(ROOT, out)
        if cookies_file:
            try:  # relative_to падает, если cookies в папке вывода вне ROOT
                rel = str(Path(cookies_file).relative_to(ROOT))
            except ValueError:
                rel = str(cookies_file)
            cookies_how = "автомат: " + rel
            _note = ("  !! cookies_file в ytm-dl.ini пуст, но файл лежит в папке программы —"
                     " беру его (" + Path(cookies_file).name + ")")
            # в окно это печатается ДО обёртки stdout в --log-file, а в лог обязано
            # попасть: «куки подхвачены автоматически» - ровно то, что ищут в ytm-run.log
            print(_note)
            _ytm_log_line(_note.strip())
    _px_raw = str(args.proxy or "").strip()
    _px_in, _px_direct = norm_proxy(args.proxy)
    if _px_direct:
        # «proxy=none» - универсальная база: ни строки из ini, ни унаследования системы
        _px, _px_why = "", "proxy=none — прямо, системный прокси не наследуем"
        print("  proxy     : " + _px_why)
        _ytm_log_line("proxy: " + _px_why)
    else:
        _px, _px_why = effective_proxy(_px_in or None)
        if _px and not _px_raw:
            print("  proxy     : " + _px + " - " + _px_why + " (в ytm-dl.ini пусто -> унаследовано)")
            _ytm_log_line("proxy: " + _px + " (" + _px_why + ")")
    args.convert = str(args.convert or "").strip().lower()
    if args.convert and args.convert not in ("m4a", "mp3", "opus"):
        print("  !! convert=" + repr(args.convert) + " не понимаю (бывает m4a|mp3|opus) - игнорирую")
        _ytm_log_line("config warn: convert=" + repr(args.convert) + " игнорируется")
        args.convert = ""
    args.verify = str(args.verify if args.verify is not None else "1").strip().lower() \
        not in ("0", "off", "no", "false")
    Handler.cfg = {"out": out, "organize": args.organize, "token": args.token,
                   "proxy_effective": _px,
                   "cookies_from_browser": args.cookies_from_browser,
                   "cookies_file": cookies_file, "cookies_how": cookies_how,
                   "player_client": args.player_client,
                   "proxy": _px,
                   # direct = человек сказал «без прокси» явно (none/off): и панели,
                   # и унаследованию в _proxy_of говорим «нет» - одним флагом
                   "proxy_direct": _px_direct,
                   "convert": args.convert, "verify": args.verify,
                   "impersonate": str(args.impersonate or "").strip()}
    if args.check:   # режим проверки: ничего не слушаем, только диагностируем папку
        sys.exit(run_check(out, args.cookies_from_browser,
                           args.cookies_file or (cookies_file if not args.cookies_from_browser else None),
                           effective_proxy(args.proxy)))
    _prev_hook = sys.excepthook

    def _hook(t, v, tb):
        _ytm_log_line("traceback (fatal): "
                      + "".join(traceback.format_exception(t, v, tb)))
        _prev_hook(t, v, tb)

    sys.excepthook = _hook
    if args.stop_other and not stop_other_companion(args.port, args.token):
        print("  !! порт всё ещё занят - второй запуск или ytm.bat kill")
        return 3
    Handler.queue = Queue(max_workers=1)  # YouTube throttling: do not parallelize retries
    Handler.queue.start()
    Handler.throttle = ThrottleQueue(out)
    def _throttle_monitor():
        time.sleep(60)   # 0.6.4: после рестарта «созревшие» не должны ждать целый час
        while True:
            time.sleep(3600)
            try:
                Handler.throttle.sync_archive()
                Handler.throttle.pump(Handler.queue)
            except Exception as exc:  # monitor must never kill the companion
                _ytm_log_line("throttle monitor: " + repr(exc))
    threading.Thread(target=_throttle_monitor, name="ytm-throttle", daemon=True).start()

    # лог по умолчанию (music\ytm-dl-server.log) открываем ДО bind: «порт занят» -
    # как раз то, что человек не увидит иначе, потому что окно закроется вместе с текстом
    if sys._ytm_log is None:
        try:
            lf = Path(out) / "ytm-dl-server.log"
            sys._ytm_log = open(lf, "ab", buffering=0)
        except Exception as e:  # noqa: BLE001
            print(f"  log       : НЕ пишется в файл ({e}) - только консоль")
    try:
        srv = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        # «порт занят» - единственный частый способ умереть до всякого лога;
        # формулируем словами и сразу говорим, что делать
        print(f"!! порт {args.port} занят или недоступен: {e}")
        print(f"   кто слушает:  netstat -ano | findstr :{args.port}   (PID в последней колонке)")
        print("   снять его:    ytm.bat stop    (или ytm.bat kill - жёстко, с деревом детей)")
        for ln in ("bind failed: " + str(e), "use: ytm.bat stop (or ytm.bat kill)"):
            _ytm_log_line(ln)
        sys.stdout.flush()
        os._exit(2)          # обёрнутый stdout через обычный выход не закрывается
    _ytm_log_line("ytm-dl companion  http://" + args.host + ":" + str(args.port))
    print(f"ytm-dl companion  http://{args.host}:{args.port}")
    print("  log       : " + str(Path(args.log_file).expanduser()) if args.log_file
          else ("  log       : " + str(Path(out) / "ytm-dl-server.log") if sys._ytm_log else
                "  log       : нет (только консоль)"))
    if args.log_file and sys._ytm_log is not None:
        import io
        # write_through + line_buffering: буфер не съедает строки, когда окно уже
        # закрыто; detach нужен, иначе Python заругается на закрытый stdout
        sys.stdout = io.TextIOWrapper(sys._ytm_log, encoding="utf-8", errors="replace",
                                      line_buffering=True, write_through=True)
        sys.stderr = _StderrProxy()
        atexit.register(lambda: sys.stdout.detach())
    print(f"  build     : ytm-dl {APP_VERSION}  (все сообщения - в ytm-run.log, включая панель)")
    _ytm_log_line("banner: build ytm-dl " + APP_VERSION)
    if args.convert or not args.verify:
        _cvn = ("convert=" + args.convert if args.convert else "") + (", verify=0" if not args.verify else "")
        print("  output    : " + _cvn)
        _ytm_log_line("output: " + _cvn)
    print(f"  out dir   : {out}  (переопределяется полем «папка» в панели: только внутри {Path.home()})")
    print(f"  archive   : {archive_path(out)}  ({len(read_archive(out))} записей — «уже скачано»)")
    print(f"  python    : {PYTHON}" + ("  (портативный из app/)" if PYTHON != sys.executable else ""))
    print(f"  root      : {ROOT}  (портативная раскладка: app/, music/)")
    print(f"  player    : {args.player_client or 'default (web-клиенты, нужен JS-runtime для po-token)'}")
    print(f"  cookies   : {args.cookies_from_browser or ('file: ' + cookies_file + ('  [' + cookies_how + ']' if cookies_how and cookies_how != 'из ytm-dl.ini/CLI' else '') if cookies_file else 'none (playlist/url на аккаунтном контенте упадёт в bot-check; cookies.txt в папке программы подхватывается сам)')}")
    print(f"  proxy     : {_px or 'нет: yt-dlp ходит напрямую (если браузер через VPN - добавь proxy= в ytm-dl.ini)'}"
          + ("" if (not _px or _px == _px_in) else "   [унаследован: " + _px_why + "]")
          + ("   !! обложкам через socks нужен PySocks: прогони install-packages-offline.bat"
             if _px.lower().startswith("socks") and not socks_module_available() else ""))
    print(f"  ffmpeg    : {FF.ffmpeg or 'НЕ НАЙДЕН (теги/конвертация будут ограничены)'}")
    print(f"  mutagen   : {'yes' if HAVE_MUTAGEN else 'no'}")
    print(f"  yt-dlp    : {_yt_dlp_version() or 'no (режим browser недоступен)'}")
    print(f"  token     : {'set' if args.token else 'none (доступ только с localhost)'}")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("  !! слушает не-loopback интерфейс - обязательно задайте --token")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped")            # в окно И (если есть) в лог: print уже обёрнут
        _ytm_log_line("stopped by ctrl-c")
    sys.stdout.flush()
    os._exit(0)              # обёрнутый stdout не закрываем дважды (иначе 120 вместо 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
