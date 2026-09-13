#!/usr/bin/env bash
# Прогон всех проверок. node обязателен; python3+mutagen+ffmpeg — для real/companion/e2e.
set -u
cd "$(dirname "$0")/.."
fail=0
echo "════ node --check (синтаксис пользовательского скрипта) ════"
node --check userscript/ytm-downloader.user.js || fail=1
echo "════ python-синтаксис компаньона ════"
python3 -m py_compile server/companion.py || fail=1
echo "════ фикстуры ════"
[ -f tests/fixtures/stream.m4s ] || { echo "нет tests/fixtures/stream.m4s — генерирую…"; bash tools/make_fixtures.sh || fail=1; }
echo "════ портативная сборка (dist/ytm-dl-win.zip) ════"
bash tools/build_win_package.sh >/dev/null || { echo "не собрался dist"; fail=1; }
for t in test_userscript test_real_mp4 test_companion test_e2e; do
  echo; echo "════ tests/$t.mjs ════"
  node "tests/$t.mjs" || fail=1
done
# после прогона не оставляем тестовых серверов: «висящий python, из-за которого
# папка не удаляется» - та жалоба, ради которой вообще писали ytm.bat
for pid in $(pgrep -f "server/companion.py --port [0-9]" 2>/dev/null); do kill -TERM $pid 2>/dev/null || true; done
echo; [ $fail -eq 0 ] && echo "✅ ВСЁ ЗЕЛЁНОЕ" || echo "❌ есть падения"
exit $fail
