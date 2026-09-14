#!/usr/bin/env python3
"""Список файлов архива построчно (zip или tar).

Нужен тестам: `dist/` после прогона содержит мусор (music/ytm-dl-server.log,
симлинки app/bin), поэтому «сколько файлов в поставке» надо считать по архиву.
"""
import pathlib
import sys
import tarfile
import zipfile


def main() -> int:
    p = pathlib.Path(sys.argv[1])
    if p.suffix == ".zip":
        with zipfile.ZipFile(p) as z:
            names = [i.filename for i in z.infolist() if not i.is_dir()]
    else:
        with tarfile.open(p) as t:
            names = [m.name for m in t.getmembers() if m.isfile()]
    for n in names:
        if "__pycache__" in n.split("/") or n.endswith(".pyc"):
            continue
        print(n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
