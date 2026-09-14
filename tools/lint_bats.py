#!/usr/bin/env python3
"""Линтер .bat для портативной сборки: кавычки путей, метки goto, баланс скобок, ASCII, CRLF.

Вынесен из build_win_package.sh специально: правило «%VAR% вне кавычек» уже дважды
умирало молча (сначала из-за `\r` в конце строки, потом из-за требования «кавычка
соседствует с переменной»), а проверить его на реальном dist нельзя — там всё
правильно. Поэтому lint_bats.check_bat_text() доступна тестам напрямую.
"""
import re
import pathlib

# !VAR! - to zhe samye podstanovki s probelami v puti; esli pravilo ne
# pokryvalo by ikh, lint molchal by na samom opasnom variante zapuska.
NEEDS_QUOTES = ("PYEXE", "OUTDIR", "COMPANION", "INI")


def _inside_quotes(text, pos):
    """True, если позиция внутри одной пары кавычек cmd (счёт " левее нечётный)."""
    return text[:pos].count('"') % 2 == 1


def _is_echo(line: str) -> bool:
    """echo/rem, в том числе записанные после перенаправления
    (`>> "f" echo ...`): кавычки там не нужны. Намеренно на строковых операциях -
    регулярка с переменной длиной внутри группы вела себя неочевидно."""
    k = line.strip()
    while k[:1] in (">", "<") or k[:1].isdigit():
        k = k.lstrip("0123456789<>|& ")
        if k[:1] in (chr(34), chr(39)):
            q = k[0]
            k = k[1:].split(q, 1)[-1].strip() if q in k[1:] else k[1:]
    return k.lower().startswith(("echo", "rem", "::"))



def check_bat_text(txt, raw=None, name=""):
    """Возвращает список строк ошибок (пусто = чисто). txt — уже без \r по строкам."""
    errs = []
    lines = txt.split("\n") if "\r" not in txt[:200] else txt.replace("\r", "").split("\n")
    for i, l0 in enumerate(lines, 1):
        l = l0.rstrip("\r")
        s = l.strip().lower()
        if s.startswith(("rem", "echo", "::", "@echo")):
            continue                          # в rem/echo кавычки не нужны
        # echo внутри блока / после перенаправления - тот же случай: кавычки там
        # не нужны, а раньше их отсутствие и не проверялось. Без этого правила
        # !VAR!-форма начала светиться как ошибка ровно на безобидных строках.
        if _is_echo(l):                                      # то же, что выше
            continue
        if re.search(r'set\s+"[A-Za-z0-9_]+=', l, re.I):
            continue                          # set "NAME=…" — хвост целиком в кавычках
        for var in NEEDS_QUOTES:
            for m in re.finditer(r"[%!]" + var + r"[%!]|[!](" + var + r")[!]", l):
                if not _inside_quotes(l, m.start()):
                    errs.append(f"{name}:{i}: %{var}% вне кавычек -> {l.strip()[:74]}")
        if l.count('"') % 2:
            errs.append(f"{name}:{i}: нечётное число \" на строке (обрывок кавычки ломает команду) -> {l.strip()[:74]}")
        if re.match(r"^\s*[%!]PYEXE[%!]\s", l):
            errs.append(f"{name}:{i}: запуск без кавычек (нужно \"!PYEXE!\" %PYARGS%) -> {l.strip()[:74]}")
    labels = {m.group(1).lower() for m in re.finditer(r"^\s*:([A-Za-z0-9_-]+)\s*$", txt, re.M)}
    gotos = {m.group(1).lower() for m in re.finditer(r"\bgoto\s+:?([A-Za-z0-9_-]+)", txt, re.I)}
    if gotos - labels - {'eof'}:
        errs.append(f"{name}: goto в никуда: {sorted(gotos - labels)}")
    if txt.count("(") != txt.count(")"):
        errs.append(f"{name}: небаланс скобок ({txt.count('(')} vs {txt.count(')')})")
    if raw is not None:
        if any(c > 127 for c in raw):
            errs.append(f"{name}: не-ASCII (кодировка консоли съест текст)")
        # порог «3 строки» осмысленен только для настоящих файлов; однострочные
        # пробы из тестов он ронял бы по несуществующей причине
        if raw.count(b"\r\n") < 3 and raw.count(b"\r\n") < len([x for x in txt.splitlines() if x.strip()]):
            errs.append(f"{name}: нет CRLF ({raw.count(b'\r\n')} CRLF при {len(txt.splitlines())} строках)")
    return errs


def lint_dir(root, quiet=False):
    """Каталог → число ошибок (0 = чисто). quiet — для тестов, чтобы не мешать stdout."""
    p0, p1 = (print, print) if not quiet else (lambda *a, **k: None, None)
    fail = 0
    for f in sorted(pathlib.Path(root).rglob("*.bat")):
        raw = f.read_bytes()
        txt = raw.decode("utf-8", "replace")
        errs = check_bat_text(txt.replace("\r", ""), raw, f.name)
        for e in errs:
            p0(f"  FAIL {e}")
        labels = sorted({m.group(1).lower() for m in re.finditer(r"^\s*:([A-Za-z0-9_-]+)\s*$", txt, re.M)})
        p0(f"  {'ok  ' if not errs else 'FAIL'} {f.name}: {len(txt.splitlines())} строк, метки: {', '.join(labels) or '—'}")
        fail |= 1 if errs else 0
    return fail


if __name__ == "__main__":
    import sys
    sys.exit(1 if lint_dir(sys.argv[1] if len(sys.argv) > 1 else ".") else 0)
