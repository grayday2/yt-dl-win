#!/usr/bin/env python3
"""ytm-dl / control  —  ЕДИНСТВЕННАЯ точка входа в портативной папке.

    ytm.bat              меню (двойной клик)
    ytm.bat serve        поднять компаньона и держать окно (лог в этой консоли)
    ytm.bat restart        стоп + сразу новый запуск (то же, что 1 после 2)
    ytm.bat stop         штатно: /shutdown висящему процессу + снять его детей
    ytm.bat kill         жёстко: снять дерево процесса по pid
    ytm.bat status       что запущено, кто держит порт, что видно в /hello
    ytm.bat selftest     companion --check (python/ffmpeg/yt-dlp/mutagen/права)
    ytm.bat log          хвост ytm-dl-log.txt
    ytm.bat report       diagnostic-отчёт в файл + копия на Рабочий стол
    ytm.bat deno         принести JS-runtime (или подсказать, какой файл скачать)
    ytm.bat config       создать/открыть ytm-dl.json в Блокноте (важнее ini)
    ytm.bat uninstall    остановить всё и проверить, что папку можно удалить

Почему это на Python, а не .bat/.ps1: ровно из-за двух жалоб пользователя. cmd
молча умирает на первой непонятной строке (окно закрылось, объяснений нет), а
обёртки поверх системных служб умеют ВИСНУТЬ, и тогда запускатель не стартует
сервер вообще. Python в папке уже есть (он и есть движок), у него нет этих
режимов отказа, и трейс всегда можно положить в файл.

Никакого чужого python не убиваем: процессы ищем по КОМАНДНОЙ СТРОКЕ
(companion.py), а не по имени образа. Из системных утилит - только netstat/ss,
wmic и taskkill, у каждого вызова свой таймаут; обращений к реестру процессов и
прочим службам, которые умеют висеть, здесь нет вовсе.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent          # <root>/app (или app/ в репозитории)
try:                                     # python по умолчанию печатает трейс в никуда,
    if hasattr(signal, "SIGPIPE"):       # когда читателя уже нет; нам нужен обычный exit
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except Exception:  # noqa: BLE001        (на Windows SIGPIPE нет - и не нужен)
    pass

ROOT = HERE.parent                              # портативная папка


def _companion() -> Path:
    """app/companion.py в собранной папке; в репозитории рядом лежит server/companion.py."""
    for cand in (HERE / "companion.py", ROOT / "server" / "companion.py"):
        if cand.is_file():
            return cand
    return HERE / "companion.py"


INI = ROOT / "ytm-dl.ini"
LOGF = ROOT / "ytm-dl-log.txt"
SERVER_LOG = "ytm-dl-server.log"
COMPANION = _companion()


# ---------------------------------------------------------------- мелочи вывода
def _pipe_broken() -> None:
    """`ytm.bat status | findstr` / `| more`: читатель умер раньше нас. Это не
    авария — писать ytm-dl-error.txt и пугать трейсом здесь нельзя."""
    try:
        sys.stdout = open(os.devnull, "w")
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(0)


def say(*a) -> None:
    try:
        print(*a, flush=True)
    except BrokenPipeError:
        _pipe_broken()


def head(t: str) -> None:
    say("", "== " + t + " " + "=" * max(0, 58 - len(t)))


def safe_print_enabled() -> bool:
    return sys.stdin is not None and sys.stdout is not None and sys.stdout.isatty()


def pause_if_tty() -> None:
    """Двойной клик = окно закрывается вместе с процессом; этого быть не должно."""
    try:
        if sys.stdin is not None and sys.stdin.isatty():
            input("  [Enter]")
    except Exception:  # noqa: BLE001
        pass


def crash_log(text: str) -> None:
    try:
        (ROOT / "ytm-dl-error.txt").write_text(text, encoding="utf-8")
        d = Path.home() / "Desktop"
        if d.is_dir():
            (d / "ytm-dl-error.txt").write_text(text, encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- настройки
_JSON: dict | None = None


def json_cfg() -> dict:
    """ytm-dl.json - те же настройки для правки в Блокноте (JSON понимает запятые
    и кавычки честно, в отличие от «ключ=значение»). Если файл есть, он ВАЖНЕЕ ini.
    Битый json не роняет запуск: предупредили и живём по ini."""
    global _JSON
    if _JSON is None:
        _JSON = {}
        p = ROOT / "ytm-dl.json"
        if p.is_file():
            try:
                d = json.loads(p.read_text(encoding="utf-8-sig"))
                if isinstance(d, dict):
                    _JSON = {str(k).lower(): v for k, v in d.items()
                             if not str(k).startswith("//")}
                else:
                    say("  (ytm-dl.json: ожидается {...} - игнорирую, живу по ytm-dl.ini)")
            except Exception as e:  # noqa: BLE001
                say("  (ytm-dl.json не разобран: %s - живу по ytm-dl.ini)" % e)
    return _JSON


def ini_get(key: str, default: str = "") -> str:
    jv = json_cfg().get(key.lower())
    if jv is not None and str(jv).strip():
        return str(jv).strip()
    if not INI.exists():
        return default
    try:
        for raw in INI.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith(";") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip().lower() == key.lower() and v.strip():
                return v.strip()
    except Exception as e:  # noqa: BLE001
        say("  (ytm-dl.ini не прочитан: %s)" % e)
    return default


def out_dir() -> Path:
    o = ini_get("out", "music")
    p = Path(o)
    return p if p.is_absolute() or (len(o) > 1 and o[1] == ":") else ROOT / o


def port() -> int:
    try:
        return int(ini_get("port", "8765"))
    except ValueError:
        return 8765


def token() -> str:
    return ini_get("token", "")


def find_python() -> list[str]:
    env = os.environ.get("YTMDL_PYTHON")
    cands = ([env] if env else []) + [
        str(ROOT / "app" / "python" / "python.exe"),
        str(ROOT / "app" / "python" / "bin" / "python.exe"),
        str(ROOT / "app" / "python" / "python"),
        str(ROOT / "app" / "python" / "bin" / "python"),
        sys.executable,
    ]
    for c in cands:
        if c and Path(c).is_file():
            return [c]
    for name in ("python", "python3", "py"):
        w = shutil.which(name)
        if w:
            return [w] + (["-3"] if name == "py" else [])
    return []


def companion_args(*extra: str) -> list[str]:
    args = find_python()
    if not args:
        return []
    args = args + ["-u", "-X", "utf8", str(COMPANION)]
    args += ["--port", str(port()), "--out", str(out_dir())]
    organize = ini_get("organize", "none")
    if organize:
        args += ["--organize", organize]
    if token():
        args += ["--token", token()]
    for key, flag in (("cookies_from_browser", "--cookies-from-browser"),
                      ("cookies_file", "--cookies-file"),
                      ("player_client", "--player-client"),
                      ("proxy", "--proxy"),
                      # convert/verify - «перестраховки»: force-контейнер и декод-проверка
                      ("convert", "--convert"),
                      ("verify", "--verify"),
                      # impersonate - TLS-отпечаток yt-dlp (curl_cffi), auto при пустом
                      ("impersonate", "--impersonate")):
        v = ini_get(key)
        if v:
            if key == "cookies_file" and not (Path(v).is_absolute() or (len(v) > 1 and v[1] == ":")):
                v = str(ROOT / v)
            args += [flag, v]
    return args + list(extra)


# ---------------------------------------------------------------- «что живёт в системе»
def http_json(path: str, method: str = "GET", timeout: float = 3.0):
    url = "http://127.0.0.1:%d%s" % (port(), path)
    hdr = {"X-YTM-Token": token()} if token() else {}
    req = urllib.request.Request(url, headers=hdr, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(65536).decode("utf-8", "replace") or "{}")


def server_alive() -> dict | None:
    try:
        return http_json("/hello")
    except Exception:  # noqa: BLE001
        return None


def run_quiet(cmd: list[str], timeout: float = 15.0) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
        return (p.stdout or "") + (p.stderr or "")
    except Exception:  # noqa: BLE001
        return ""


def pids_on_port(p: int | None = None) -> list[int]:
    p = p or port()
    out: list[int] = []
    if os.name == "nt":
        for line in run_quiet(["netstat", "-ano", "-p", "tcp"]).splitlines():
            c = line.split()
            if len(c) >= 5 and c[0].upper() == "TCP" and c[3].upper() == "LISTENING" \
                    and c[1].rsplit(":", 1)[-1] == str(p):
                try:
                    out.append(int(c[-1]))
                except ValueError:
                    pass
    else:
        for line in run_quiet(["ss", "-lptn", "sport = :%d" % p]).splitlines():
            for m in re.finditer(r"pid=(\d+)", line):
                out.append(int(m.group(1)))
    return sorted(set(out))


def companion_pids() -> list[tuple[int, str]]:
    """(pid, командная строка) наших процессов. Только те, где видно companion.py."""
    found: list[tuple[int, str]] = []
    if os.name == "nt":
        txt = run_quiet(["wmic", "process", "where",
                         "name='python.exe' or name='pythonw.exe'",
                         "get", "processid,commandline", "/value"], timeout=20)
        cur = ""
        for line in txt.splitlines():
            line = line.strip()
            if line.lower().startswith("commandline="):
                cur = line[12:]
            elif line.lower().startswith("processid=") and "companion.py" in cur:
                try:
                    found.append((int(line[10:]), cur))
                except ValueError:
                    pass
    else:
        for d in Path("/proc").glob("[0-9]*"):
            try:
                cl = (d / "cmdline").read_bytes().decode("utf-8", "replace").replace("\0", " ")
            except OSError:
                continue
            if "companion.py" in cl:
                found.append((int(d.name), cl))
    return sorted(set(found))


def kill_tree(pid: int) -> str:
    if os.name == "nt":
        return run_quiet(["taskkill", "/PID", str(pid), "/T", "/F"], timeout=20).strip()
    try:
        os.kill(pid, 15)
        return "SIGTERM -> %d" % pid
    except OSError as e:
        return str(e)


def stop(graceful: bool = True) -> int:
    """True = порт свободен. Сначала штатно, потом по pid (всегда только свои)."""
    alive = server_alive() if graceful else None
    if graceful and alive is None and not pids_on_port() and not companion_pids():
        say("  companion not running, nothing to stop")
        return 0
    if graceful:
        try:
            r = http_json("/shutdown", timeout=5)
            say("  /shutdown ok:", json.dumps(r, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            say("  /shutdown not available (%s) -> killing by pid" % type(e).__name__)
        for _ in range(40):
            if server_alive() is None:
                say("  [ok] companion stopped")
                return 0
            time.sleep(0.25)
        say("  [!] still answering - falling back to kill")
    targets = {pid for pid, _ in companion_pids()} | set(pids_on_port())
    if not targets:
        say("  [ok] nothing to stop")
        return 0
    for pid in sorted(targets):
        say("  kill %d: %s" % (pid, kill_tree(pid) or "done"))
    for _ in range(20):
        if server_alive() is None and not pids_on_port():
            say("  [ok] port is free")
            return 0
        time.sleep(0.25)
    say("  [x] port is still busy - who owns it: netstat -ano | findstr :%d" % port())
    return 1


# ---------------------------------------------------------------- запуск
def serve() -> int:
    args = companion_args("--stop-other", "--log-file", str(LOGF))
    if not args:
        say("[x] python not found. Run setup.ps1 once, or unpack python into app\\python\\")
        return 2
    say("[.] folder : %s" % ROOT)
    say("[.] python : %s" % " ".join(args[:1]))
    say("[.] out    : %s" % out_dir())
    say("[.] port   : %d   (userscript talks to http://127.0.0.1:%d)" % (port(), port()))
    say("")
    if not COMPANION.is_file():
        say("[x] not found: app\\companion.py - extract the WHOLE archive into one folder,")
        say("    do not pull single files out of it.")
        return 2
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(ROOT / "app" / "bin"), env.get("PATH", "")])
    env.setdefault("YTMDL_PYTHON", args[0])
    if (ROOT / "app" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).is_file():
        env["YTMDL_FFMPEG"] = str(ROOT / "app" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
    try:
        pr = subprocess.Popen(args, cwd=str(ROOT), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        say("[x] could not start python: %s" % e)
        say("    try: %s" % " ".join(args))
        crash_log("Popen failed\n" + "".join(traceback.format_exc()))
        return 3
    say("[.] server is running. Live log below; Ctrl+C here = stop everything.")
    say("[.] (you can also close this window later - ytm.bat stop / kill still works)")
    say("-" * 66)
    try:
        assert pr.stdout is not None
        for line in pr.stdout:
            say(line.rstrip())
    except KeyboardInterrupt:
        say("")
        say("[.] Ctrl+C - stopping the server (children included)...")
        try:
            http_json("/shutdown", timeout=3)
        except Exception:  # noqa: BLE001
            pass
        for _ in range(20):
            if pr.poll() is not None:
                break
            time.sleep(0.25)
        if pr.poll() is None:
            pr.terminate()
    rc = pr.wait(timeout=15) if pr.poll() is None else pr.returncode
    say("-" * 66)
    say("[.] server exited, code %s   (full trace: %s)" % (rc, LOGF.name))
    if rc not in (0, None):
        tail_log(20)
    return 0 if rc in (0, None) else int(rc or 0)


def restart() -> int:
    say("[.] restart: stop current session, then serve")
    stop(True)
    return serve()


def _log_action() -> int:
    tail_log(30)
    return 0


def tail_log(n: int = 25) -> None:
    head("ytm-dl-log.txt (last %d lines)" % n)
    if not LOGF.is_file():
        say("  (file does not exist yet - start.bat/ytm.bat serve creates it)")
        return
    say("  size %d B, last write %s" % (LOGF.stat().st_size,
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(LOGF.stat().st_mtime))))
    lines = LOGF.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines[-n:]:
        say("  | " + line)


def status() -> int:
    head("status")
    say("  folder : %s" % ROOT)
    say("  ini    : %s%s" % ("found" if INI.is_file() else "MISSING (defaults are used)",
        "  ·  ytm-dl.json применён поверх него" if json_cfg() else ""))
    say("  port   : %d   out: %s   token: %s" % (port(), out_dir(), "set" if token() else "none"))
    for label, p in (("companion.py", COMPANION),
                     ("python", Path(find_python()[0]) if find_python() else None),
                     ("ffmpeg", ROOT / "app" / "bin" / "ffmpeg.exe"),
                     ("deno", ROOT / "app" / "bin" / "deno.exe"),
                     ("launcher log", LOGF),
                     ("server log", out_dir() / SERVER_LOG)):
        if p is None:
            say("  %-12s : NOT FOUND" % label)
        else:
            mark = "[yes]" if p.exists() else "[NO ]"
            extra = ""
            if p.is_file():
                extra = "  %d B  %s" % (p.stat().st_size,
                                        time.strftime("%d.%m %H:%M", time.localtime(p.stat().st_mtime)))
            say("  %s %-12s : %s%s" % (mark, label, p, extra))
    head("processes")
    ours = companion_pids()
    if ours:
        for pid, cl in ours:
            say("  [run] pid %d  %s" % (pid, re.sub(r"\s+", " ", cl)[:120]))
    else:
        say("  [no ] no companion.py process is running")
    owners = pids_on_port()
    say(("  [busy] port %d is held by pid(s): %s" % (port(), ", ".join(map(str, owners))))
        if owners else "  [free] port %d is free" % port())
    h = server_alive()
    if h:
        head("/hello")
        for k in ("name", "api", "ffmpeg", "ffmpeg_path", "yt_dlp", "mutagen", "out", "archive",
                  "archived", "cookies_from_browser", "cookies_file", "player_client", "proxy",
                  "impersonate",
                  "js_runtime", "python", "root", "children", "active_jobs"):
            if k in h:
                say("  %-20s : %s" % (k, h[k]))
    else:
        say("  [-- ] /hello does not answer (start it: ytm.bat serve)")
    return 0


def selftest() -> int:
    # klyuchi cookies/proxy/clienta iz ini ranshe do --check NE dokhodili: selftest
    # pisal "cookies: none" v /hello, a v --check etoy stroki vovse ne bylo.
    cmd = companion_args("--check", "--out", str(out_dir()))
    if not cmd:
        say("[x] python not found - run setup.ps1 once")
        return 2
    say("[.] " + " ".join(cmd))
    say("")
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(ROOT / "app" / "bin"), env.get("PATH", "")])
    return subprocess.call(cmd, cwd=str(ROOT), env=env)


def report() -> int:
    """То же, что делал diagnostic.bat, но без cmd-акробатики: отчёт в файл."""
    import io
    buf = io.StringIO()
    keep = sys.stdout
    try:
        sys.stdout = _Tee(keep, buf)
        say("ytm-dl report %s" % time.strftime("%d.%m.%Y %H:%M:%S"))
        status()
        head("companion --check")
        args = find_python()
        if args:
            env = dict(os.environ)
            env["PATH"] = os.pathsep.join([str(ROOT / "app" / "bin"), env.get("PATH", "")])
            out = subprocess.run(args + ["-X", "utf8", str(COMPANION), "--check", "--out", str(out_dir())],
                                 capture_output=True, text=True, encoding="utf-8", errors="replace",
                                 cwd=str(ROOT), env=env, timeout=180)
            say((out.stdout or "") + (out.stderr or ""))
            say("  [rc] exit code: %d" % out.returncode)
        else:
            say("  [NO] python not found")
        tail_log(40)
    finally:
        sys.stdout = keep
    txt = buf.getvalue()
    target = ROOT / "ytm-dl-report.txt"
    target.write_text(txt, encoding="utf-8")
    desk = Path.home() / "Desktop" / "ytm-dl-report.txt"
    try:
        if desk.parent.is_dir():
            desk.write_text(txt, encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    print(txt)
    say("")
    say("  saved: %s" % target)
    say("  copy : %s" % (desk if desk.is_file() else "(Desktop not available)"))
    say("  send this file - it has everything needed to tell what is wrong")
    return 0


class _Tee:
    def __init__(self, a, b):
        self.a, self.b = a, b

    def write(self, s):
        self.a.write(s)
        try:
            self.b.write(s)
        except Exception:  # noqa: BLE001
            pass

    def flush(self):
        for x in (self.a, self.b):
            try:
                x.flush()
            except Exception:  # noqa: BLE001
                pass


def deno() -> int:
    """JS-runtime для po-token: один файл в app\\bin. Скачивание - только явным ключом."""
    exe = ROOT / "app" / "bin" / ("deno.exe" if os.name == "nt" else "deno")
    bin_dir = exe.parent
    bin_dir.mkdir(parents=True, exist_ok=True)
    url = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
    sha = "15E5300B0BA3C3695A7621D90160A746EC9E710228CEE639AFA9D580F6E3CD11"
    if exe.is_file():
        say("[ok] already there: %s (%d B)" % (exe, exe.stat().st_size))
        return 0
    node = shutil.which("node")
    if node:
        dst = bin_dir / ("node.exe" if os.name == "nt" else "node")
        try:
            if not dst.exists():
                shutil.copy2(node, dst)
            say("[ok] copied your existing node -> %s" % dst)
            say("     (deno не нужен; если yt-dlp его всё же попросит - скачай deno ниже)")
            return 0
        except Exception as e:  # noqa: BLE001
            say("[.] could not copy node (%s) - will explain how to get deno" % e)
    say("no JS-runtime in app\\bin\\ and no node in PATH.")
    say("")
    say("  1) download (single file, no installer):")
    say("     %s" % url)
    say("  2) expected sha256 of the zip:")
    say("     %s" % sha)
    say("  3) unzip it, put deno.exe here:")
    say("     %s" % exe)
    say("  4) run this command again, or ytm.bat status - line 'deno' must say [yes]")
    say("")
    say("  or: ytm.bat deno --download   (downloads and verifies sha256 itself)")
    if "--download" not in sys.argv:
        return 1
    import hashlib
    import zipfile
    tmp = ROOT / "app" / "bin" / "deno-download.zip"
    say("[.] downloading ...")
    try:
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
    except Exception as e:  # noqa: BLE001
        say("[x] download failed: %s" % e)
        say("    do it by hand in a browser (link above) - no proxy/antivirus here,")
        say("    but your box may have one")
        return 1
    h = hashlib.sha256(tmp.read_bytes()).hexdigest().upper()
    if h != sha:
        say("[x] sha256 mismatch: %s" % h)
        tmp.unlink(missing_ok=True)
        return 1
    with zipfile.ZipFile(tmp) as z:
        if exe.name not in z.namelist():
            say("[x] deno.exe not inside the zip: %s" % z.namelist()[:6])
            return 1
        with z.open(exe.name) as src, open(exe, "wb") as dst:
            shutil.copyfileobj(src, dst)
    tmp.unlink(missing_ok=True)
    say("[ok] verified + installed: %s (%d B)" % (exe, exe.stat().st_size))
    say("     start the server again: ytm.bat serve")
    return 0


def uninstall() -> int:
    """Ничего НЕ удаляет: только гасит процессы и честно отвечает, снимается ли папка."""
    head("uninstall (frees the folder, deletes nothing)")
    stop(True)
    stop(False)
    busy = []
    o = out_dir()
    if o.is_dir():
        for p in sorted(o.iterdir())[:5]:
            if not p.is_file():
                continue
            try:
                fd = os.open(p, os.O_RDWR)
                os.close(fd)
            except PermissionError:
                busy.append(p.name)
            except OSError:
                pass
    probe = ROOT / (".ytm-delete-probe-%d" % os.getpid())
    try:
        probe.write_text("x")
        probe.unlink()
    except Exception as e:  # noqa: BLE001
        busy.append("<root>: %s" % e)
    if busy:
        say("  [!] still locked:")
        for b in busy:
            say("      %s" % b)
        say("  usual suspects: an Explorer/Notepad window inside the folder, antivirus,")
        say("  OneDrive sync, or a python.exe not started by us (see ytm.bat status).")
        return 1
    say("  [ok] folder is not locked - you can delete it (Shift+Del)")
    say("       keep first, if you want: %s" % o)
    return 0


def config_editor() -> int:
    """ytm-dl.json в Блокноте. Если файла нет - он СОЗДАЁТСЯ из текущих значений
    ytm-dl.ini (не из дефолтного шаблона: иначе defaults json перебили бы уже
    настроенный ini). Дальше json важнее ini - правь только его."""
    p = ROOT / "ytm-dl.json"
    if not p.is_file():
        data = {"//": "ytm-dl.json - настройки для Блокнота, созданы из ytm-dl.ini. "
                      "Пока этот файл существует, он ВАЖНЕЕ ini. После правки: ytm.bat restart."}
        for k in ("out", "port", "token", "organize", "proxy", "player_client",
                  "cookies_from_browser", "cookies_file", "convert", "verify", "impersonate"):
            v = ini_get(k, "")
            if k == "port":
                try:
                    v = int(v)
                except ValueError:
                    v = 8765
            data[k] = v
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        say("  [ok] %s создан из значений ytm-dl.ini" % p.name)
    if sys.platform == "win32":
        try:
            subprocess.Popen(["notepad.exe", str(p)])
            say("  открыто в Блокноте: правь, Ctrl+S, потом ytm.bat restart")
        except OSError as e:
            say("  notepad не открылся (%s) - файл: %s" % (e, p))
    else:
        say("  файл для любого редактора: %s" % p)
    return 0


# ---------------------------------------------------------------- меню
ACTIONS = {
    "serve": ("serve", serve), "1": ("serve", serve), "s": ("serve", serve),
    "restart": ("restart", restart), "r": ("restart", restart),
    "stop": ("stop", lambda: stop(True)), "2": ("stop", lambda: stop(True)),
    "kill": ("kill", lambda: stop(False)), "9": ("kill", lambda: stop(False)),
    "status": ("status", status), "3": ("status", status),
    "selftest": ("selftest", selftest), "test": ("selftest", selftest),
    "4": ("selftest", selftest),
    "log": ("log", _log_action), "5": ("log", _log_action),
    "report": ("report", report), "6": ("report", report), "diagnostic": ("report", report),
    "deno": ("deno", deno), "7": ("deno", deno),
    "config": ("config", config_editor),
    "uninstall": ("uninstall", uninstall), "8": ("uninstall", uninstall),
}


def menu() -> int:
    while True:
        head("ytm-dl  (%s)" % ROOT.name)
        say("   1) start the engine (this window stays open, live log)")
        say("   2) stop it (graceful, kills its own yt-dlp/ffmpeg children)")
        say("   9) kill it hard (taskkill /T /F tree)")
        say("   4) restart    - stop, then start again in this window")
        say("   3) status     - what runs, who holds port %d, /hello summary" % port())
        say("   4) selftest   - companion --check on this folder")
        say("   5) log        - tail of ytm-dl-log.txt")
        say("   6) report     - write everything to a file (send it if stuck)")
        say("   7) deno       - JS-runtime for bot-check (one file into app\\bin)")
        say("   8) uninstall  - free the folder so Windows can delete it")
        say("  10) config     - ytm-dl.json in Notepad (created from ini; json WINS)")
        say("   0) quit")
        h = server_alive()
        say("")
        if h:
            say("  server: UP on port %d   children=%s active_jobs=%s"
                % (port(), h.get("children"), h.get("active_jobs")))
        else:
            say("  server: down (port %d %s)" % (port(), "busy by someone else"
                                                 if pids_on_port() else "free"))
        try:
            c = input("  > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return 0
        if c in ("0", "q", "quit", "exit", ""):
            return 0
        act = ACTIONS.get(c)
        if not act:
            say("  (?) unknown choice; 0 = quit")
            continue
        try:
            act[1]()
        except KeyboardInterrupt:
            say("  [.] interrupted")
        except Exception:  # noqa: BLE001
            tb = traceback.format_exc()
            say(tb)
            crash_log("action %s failed\n%s" % (c, tb))
        if not safe_print_enabled():
            return 0
        pause_if_tty()


def main(argv: list[str]) -> int:
    if not argv:
        return menu()
    act = argv[0].strip().lower().lstrip("/")
    if act in ("--help", "-h", "help"):
        print(__doc__)
        return 0
    item = ACTIONS.get(act)
    if not item:
        say("? unknown action: %s" % act)
        print(__doc__)
        return 2
    return int(item[1]() or 0)


if __name__ == "__main__":
    code = 1
    try:
        code = main(sys.argv[1:])
    except SystemExit:
        raise
    except BrokenPipeError:      # нас просто перестали читать (| findstr) - не авария
        _pipe_broken()
    except BaseException:  # noqa: BLE001  - окно НЕ должно закрываться молча
        tb = traceback.format_exc()
        try:
            sys.__stderr__.write(tb)
        except Exception:  # noqa: BLE001
            pass
        crash_log("ytm-dl control crashed\n" + tb)
        say("")
        say("[x] control tool crashed - the traceback above is also in ytm-dl-error.txt")
        code = 1
    # Double-clicked action (not the menu, which has its own [Enter]): never let the
    # window vanish before the text has been read. `serve` keeps the console busy by
    # definition, so no pause there.
    try:
        argv = sys.argv[1:]
        if argv and argv[0].strip().lower() not in ("serve", "1") and safe_print_enabled():
            pause_if_tty()
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(code)
