#!/usr/bin/env python3
"""Обновляет в README строку про готовые архивы (размер + sha256).

Зачем: сборка меняет метаданные zip/tar при каждом прогоне, поэтому хэш, записанный
в README руками, устаревает сразу. Пусть его пишет сам build_win_package.sh.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys

ws = pathlib.Path(__file__).resolve().parent.parent
readme = ws / "README.md"


def main() -> int:
    if not readme.exists():
        return 0
    arch = []
    for name in ("ytm-dl-win.zip", "ytm-dl-win.tar.gz"):
        p = ws / name
        if not p.exists():
            print(f"  warn  README не обновлён: нет {name}")
            return 0
        arch.append((name, p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest()))
    files = _count(ws / "ytm-dl-win.zip")   # считаем ЧЛЕНЫ архива, а не файлы dist/: там
                                          # всегда остаётся мусор от тестов (log в music/)
    new = (
        f"Текущие архивы ({files} файлов, без `__pycache__`): "
        f"`{arch[0][0]}` {arch[0][1]} Б sha256 `{arch[0][2][:32]}…`, "
        f"`{arch[1][0]}` {arch[1][1]} Б sha256 `{arch[1][2][:32]}…` — один и тот же набор байт "
        "в двух контейнерах (содержимое членов сверяется на сборке). Пересборка меняет только "
        "метаданные архива, не содержимое, и эту строку обновляет сам `build_win_package.sh` — "
        "обновить README руками уже не получится."
    )
    s = readme.read_text(encoding="utf-8")
    pat = r"Текущие архивы.*?обновить README руками уже не получится\."
    s2, n = re.subn(pat, lambda _m: new, s, flags=re.S)
    if not n:
        anchor = "Покрыто тестами (`tests/test_companion.mjs`, группа «портативная раскладка»)"
        if anchor not in s:
            print("  warn  в README нет ни старого текста про архивы, ни якоря для вставки")
            return 1
        s2 = s.replace(anchor, new + "\n\n" + anchor)
    readme.write_text(s2, encoding="utf-8")
    print("  ok   README: строка про архивы обновлена (zip sha256 " + arch[0][2][:12] + "…)")
    return 0


def _count(archive: pathlib.Path) -> int:
    """Сколько файлов реально лежит в архиве (не в dist/: там после тестов остаётся
    music/ytm-dl-server.log и прочие следы, из-за чего «N файлов» в README расходилось)."""
    if archive.suffix == ".zip":
        import zipfile
        with zipfile.ZipFile(archive) as z:
            names = [i.filename for i in z.infolist() if not i.is_dir()]
    else:
        import tarfile
        with tarfile.open(archive) as t:
            names = [m.name for m in t.getmembers() if m.isfile()]
    return len([n for n in names
                if "__pycache__" not in n.split("/") and not n.endswith(".pyc")])


if __name__ == "__main__":
    sys.exit(main())
