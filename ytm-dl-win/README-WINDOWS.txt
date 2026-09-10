ytm-dl - portable build for Windows 10/11 (x64)
================================================

Start here
----------
One file for everything:  ytm.bat  (double-click = menu: 1 start, 2 stop, 3 status,
4 selftest, 5 log, 6 report-to-file, 7 deno, 8 free-the-folder, 0 quit).
The short Russian version (6 checkboxes) is the last section of this file - it used
to be a separate SHPARGALKA.txt. Separate instruction files are gone: one folder,
one entry point, one README.

What this is
------------
A browser userscript + a local companion process. The userscript lives on the
YouTube Music page and does what only a browser can do (it sees the real player
response, real cookies, real home IP). The companion does everything a browser
may not do: ffmpeg remux, mp3 conversion, tags, cover art, a queue, and a
"do not download twice" archive.

Nothing is installed. The whole app is one folder. You can move it to a USB
stick, it keeps working.


Folder layout (do not rename)
-----------------------------
  ytm-dl\
    ytm.bat                       <- the ONE entry point (double-click = menu)
    start.bat                     <- alias (shortcut compatibility), no logic inside
    ytm-dl.ini                    <- settings (port, output folder, token, cookies)
    setup.ps1                     <- THE installer, run once: portable python + ffmpeg,
                                      packages from wheels (no network needed) + self-check
    install-packages-offline.bat  <- thin wrapper: runs setup.ps1 -PackagesOnly
    README-WINDOWS.txt            <- this file
    ytm-dl-log.txt                <- written by the server on first run
    ytm-dl-error.txt              <- written only if the control tool itself crashed
    userscript\
      ytm-downloader.user.js      <- drag this into Tampermonkey
    wheels\
      yt_dlp-*.whl, mutagen-*.whl,  <- packages, ALREADY IN THIS ARCHIVE (see step 3)
      PySocks-*.whl                  (PySocks = socks5 для обложек, 16 KB, BSD)
      SHA256SUMS.txt, manifest.json
    app\
      companion.py                <- the engine (one file, stdlib only)
      control.py                  <- the menu and all start/stop/status/log/report logic
      python\                     <- portable python      (YOU / setup.ps1 put it here)
      bin\ffmpeg.exe              <- ffmpeg                (YOU / setup.ps1 put it here)
    music\                        <- finished .m4a / .mp3 files land here

  app\python must contain python.exe (a few builds put it into app\python\bin\python.exe,
  both are detected). app\bin must contain exactly one file: ffmpeg.exe.


Two ways to get the missing binaries
------------------------------------
A) Automatic (one command, PowerShell):
     cd <the ytm-dl folder>
     powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
   Downloads ~30 MB of Python + ~90 MB of ffmpeg, installs yt-dlp, mutagen, PySocks and curl-cffi (from wheels\ if present, else PyPI)
   local python only, then runs the self-check.

B) Manual, if you prefer to download yourself:
   1. Portable Python (has pip and the full stdlib, unlike the "embeddable" build):
        https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only.tar.gz
      Extract it, rename the inner "python" folder so that you end up with
        ytm-dl\app\python\python.exe
      Then, in this folder:
        app\python\python.exe -m ensurepip --upgrade
        app\python\python.exe -m pip install -U yt-dlp mutagen PySocks
   2. packages (yt-dlp + mutagen + PySocks). They are NOT missing: all three are
      pure-python wheels (tag py3-none-any, zero dependencies) and ship inside
      this archive under wheels\,
      so installing them needs no internet at all:
        install-packages-offline.bat    (it is just: setup.ps1 -PackagesOnly)
      equivalent one-liner:
        app\python\python.exe -m pip install --no-index --find-links wheels -U yt-dlp mutagen PySocks
      (if you prefer online, drop --no-index --find-links and pip takes them from PyPI)
   3. ffmpeg, a single file is enough:
        https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
      From the extracted bin\ folder copy ffmpeg.exe (optionally ffprobe.exe) to
        ytm-dl\app\bin\ffmpeg.exe
   4. Check:
        ytm.bat selftest      (or double-click ytm.bat and press 4)
      Expect "gotovo k rabote" / all lines [ok]. A missing ffprobe is only a warning.


Step by step, first run
-----------------------
1. Extract the archive to a folder without one-file surgery, e.g.
     C:\Tools\ytm-dl\
   (the folder name may contain spaces and Cyrillic - both are handled).
2. Run setup.ps1 (or do the manual version above). On a machine with no internet at all:
   unpack portable python into app\python yourself, put ffmpeg.exe into app\bin, then run
   setup.ps1 now covers the packages too: with wheels\ in place pip never touches the
   network, and -Offline additionally forbids the python/ffmpeg downloads. The old
   install-packages-offline.bat is kept as a wrapper (setup.ps1 -PackagesOnly).
3. Chrome/Edge/Firefox: install Tampermonkey
     https://chrome.google.com/webstore/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo
   (Firefox: https://addons.mozilla.org/firefox/addon/tampermonkey/ )
4. IMPORTANT for local files + localhost access:
   - Chrome/Edge: open chrome://extensions, find Tampermonkey, enable
     "Allow user scripts" (and "Allow access to file URLs" if you load the file from disk).
   - Firefox: no extra switch needed.
5. Load the script: drag  userscript\ytm-downloader.user.js  into the Tampermonkey
   "Dashboard > Utilities > Import/Export/Update" area - or just onto any Tampermonkey
   page - and press "Install" in the dialog. (Alternative: Tampermonkey menu
   "Create new script", paste the file content, Ctrl+S.)
6. Run ytm.bat, press 1. Keep the window open; Ctrl+C in it stops the engine
   cleanly, yt-dlp/ffmpeg children included. An old shortcut still works too:
   start.bat is now a one-line ALIAS, nothing else references it.
7. Open https://music.youtube.com and start any song. The player bar gets a download
   button; Ctrl+Shift+Y opens the panel. Port must match ytm-dl.ini (default 8765).
   Press "proverit'" (check) in the panel - it should answer
   "companion ok - ffmpeg=da - yt-dlp=2026.x - out=C:\...\ytm-dl\music".
8. If a job stops with "Sign in to confirm you're not a bot" / 403, there are two
   extra levers (both optional, nothing to install):
     a) a JS runtime for yt-dlp's po-token solver: just run
            ytm.bat deno --download      (earlier: get-deno.bat)
        it fetches deno from the official GitHub release, checks the published sha256
        and puts deno.exe into app\bin (or copies node.exe if node is already on this
        PC). Manual version, if you prefer a browser:
          https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-pc-windows-msvc.zip
          official checksum of that zip: 15E5300B0BA3C3695A7621D90160A746EC9E710228CEE639AFA9D580F6E3CD11
          -> app\bin\deno.exe
        the launcher puts app\bin on PATH, and --check / the panel then show it
        instead of the [warn]. Third option, for a machine with no download at all:
        set  player_client=tv  in ytm-dl.ini - that client needs no po-token, so no
        JS runtime is required (fewer formats, but no bot-check either).
     b) cookies. There are two ways, and on Windows 2026 the "file" one is the
        reliable one:
        * reliable (any browser incl. Vivaldi/Edge/Brave/Opera): in the browser where
          you are logged in to music.youtube.com, install the extension
          "Get cookies.txt LOCALLY" (or "cookies.txt"), press its icon on that tab ->
          Export -> save the file as  cookies.txt  INTO THIS FOLDER (next to ytm.bat),
          then in ytm-dl.ini:  cookies_file=cookies.txt  (relative paths are resolved
          next to the folder; absolute paths work too). Restart the engine (ytm.bat -> 1).
        * zero files, but a lottery: cookies_from_browser=vivaldi|chrome|edge|brave.
          Since Chrome 127 (2024) Chromium keeps cookies in app-bound encryption, so an
          external process gets "Failed to decrypt with DPAPI" - that is the browser
          protecting you, not our bug. Firefox does not encrypt, but its profile is
          locked while firefox is open ("database is locked") -> close it, or export too.
        Verify in one command - ytm.bat selftest now prints the verdict:
            [ok  ] cookies (access to your account) - file cookies.txt: 41 youtube
                   cookies, sign-in present (4)
   The window now cannot close on you twice over: app\control.py pauses in a real
   console, and ytm.bat has its own `pause >nul` AFTER the python call - so even if
   python.exe is locked/quarantined and never starts, cmd itself keeps the window
   the ALIAS file (start.bat) calls ytm.bat by a full path (%~dp0): a shortcut
   with a wrong "Start in" used to make `call ytm.bat` unresolvable, and then
   nothing ran and nothing paused - exactly the flash people complain about.
   If the window vanishes instantly, do NOT re-run and hope: the control tool writes
   its traceback to ytm-dl-error.txt (and a copy to the Desktop), so it cannot die
   silently any more. Then open ytm-dl-log.txt in the same folder: that file is
   written by the COMPANION itself (--log-file), so it holds everything the console
   showed - the start banner, a full traceback if python died, the "port 8765 is
   busy" message, and "server exited, code N". Exit code 2 = port was busy,
   3 = the old companion could not be freed (then: ytm.bat kill). To send all of it
   at once: ytm.bat report.

   If the download button is missing but the script runs: the panel and the
   Tampermonkey menu work regardless of the player-bar markup, and any fatal error
   inside the userscript is printed as a red banner at the top of the page instead
   of being swallowed.

9. To take a whole playlist or "Liked songs": open it in YTM and press
   "ves' list / liked odnoi zadachei". To take only what is on screen:
   "ochered' so stranicu". Files with tags land in  ytm-dl\music.


Process control (ytm.bat -> app\control.py, ASCII output)
---------------------------------------------------------
Closing the window with the X button used to leave ONE python process behind; that
process (plus its yt-dlp/ffmpeg children) is what keeps the \music folder locked and
the port busy. Everything about that is now one tool:

    ytm.bat            menu (double-click)
    ytm.bat serve      start, log live in this window; Ctrl+C stops it AND the children
    ytm.bat status     companion pids, who owns the port, full /hello dump
    ytm.bat stop       graceful: /shutdown, the server kills its own children
    ytm.bat kill       hard: taskkill /T /F on the process tree
    ytm.bat selftest   companion --check (python/ffmpeg/yt-dlp/mutagen/cookies/proxy/writable)
    ytm.bat log        tail of ytm-dl-log.txt
    ytm.bat report     all of the above into ytm-dl-report.txt + a Desktop copy
    ytm.bat deno       JS-runtime for bot-check (--download fetches, verifies sha256)
    ytm.bat uninstall  stop everything, then prove the folder is unlocked

Why Python and not .bat/.ps1 - exactly the two complaints this folder earned:
cmd.exe dies SILENTLY on a line it does not understand (window closes, nothing said),
and PowerShell can HANG (WMI, Get-NetTCPConnection, Invoke-WebRequest), which is how a
launcher ends up "running" forever without ever starting the server. A Python tool
either works or prints a traceback, and that traceback also goes to ytm-dl-error.txt
(+ the Desktop), so "silent" is no longer a possible outcome.

Companions are matched by their COMMAND LINE (the string companion.py inside it),
never by image name, so an unrelated python.exe of another program is left alone.
`serve` passes --stop-other to the server: freeing the port is the companion's own job
now, no PowerShell in the critical path. Nothing in the folder is ever deleted -
`uninstall` only stops processes and reports whether the folder is unlocked.

Settings worth knowing (ytm-dl.ini)
-----------------------------------
  out                   where files go. Default "music" = inside the folder = the
                        portable behaviour. Set it to "D:\Music\ytm" to write elsewhere.
                        The panel field "papka" can override it per-job, but only
                        inside your home folder - that limit is intentional.
  cookies_file          cookies.txt in Netscape format, exported from the browser where
                        you are logged in to YouTube Music. THE main way to give the
                        engine your account. It is a key to your Google account: keep it
                        in this folder only, never send/screenshot/commit it.
  cookies_from_browser  chrome|firefox|edge|vivaldi|brave|opera|... - same thing without
                        a file, but Chromium under Windows 127+ encrypts its cookie
                        store, so this often fails with "Failed to decrypt with DPAPI".
                        Without either key: "playlist"/"url" modes hit "Sign in to confirm
                        you're not a bot" on account content, and "liked songs" cannot
                        work at all (that playlist belongs to your account).
                        The in-tab modes direct/replay/record/cover need NO cookies:
                        they already run inside the logged-in tab.
  organize=album        subfolder per album.
  token=...             if your machine has other local servers or you exposed the port.


Known limits (honest list)
--------------------------
- The bundled wheels are pinned (yt_dlp 2026.08.19, mutagen 1.48.1, PySocks 1.7.1).
  YouTube changes
  SABR/po-token handling regularly, so when a mode stops working, update the bundled
  yt-dlp:  app\python\python.exe -m pip install -U yt-dlp
  and restart the engine (ytm.bat, press 1). This is the same failure mode Electron apps have, they just
  hide it behind their own auto-update.
- Playlists are read by scrolling the page DOM (the track list is virtual). The
  "whole list" job instead hands the playlist URL to yt-dlp - no scroll needed.
- DRM content is detected and refused, not bypassed.
- Archive file:  music\.ytm-archive.txt  ("already downloaded"). Deleting files by hand
  does not clear it; use the panel button "sbrosit'", or delete the file.
- Only legal, own-content / permitted downloads. This is a downloader, not a licence.


=========================================================================
КАК ЭТО КАЧАЕТ: РЕЖИМЫ И ХУКИ (коротко, по-человечески)

Юзерскрипт «хукает» в твоём Firefox две вещи:
  - ответ /player (player response): список дорожек со ссылками googlevideo.
    Скрипт подсматривает его fetch/XHR-хуком, а если не успел - вытаскивает из
    самой страницы (ytInitialPlayerResponse), и только потом просит страницу;
  - трафик плеера (запросы к googlevideo): скрипт запоминает URL и скачанные
    Range-куски. Отсюда режимы:
      auto    - сам: есть живая ссылка из player response -> direct; её нет, но
                плеер уже ПРОКАЧАЛ трек целиком -> replay; иначе -> resolve/ytdlp.
                С 0.5.2 replay включается только при честном полном покрытии -
                «m4a, который не играется» из недокачанного куска больше не
                случается (это был баг 0.4.9);
      direct  - скрипт сам качает ссылку из player response и отдаёт байты
                компаньону (remux+теги на его стороне);
      replay  - перекачивает ровно тот URL, что качал плеер (тот же IP и права);
      resolve - компаньон получает перехваченный player response и скармливает
                его yt-dlp;
      ytdlp   - yt-dlp сам разбирает страницу: лесенка web_safari -> default ->
                tv -> web_embedded, и такие ошибки, как «The page needs to be
                reloaded» или bot-check, - повод ПРОБОВАТЬ СЛЕДУЮЩИЙ КЛИЕНТ, а не
                фразиться на первом;
      record  - «запись»: собирает трек из кусков, которые плеер качает прямо
                сейчас (единственный путь для SABR, когда ссылок нет вообще).
  Выбор mp3 - это НЕ отдельное скачивание: качается лучшая m4a/opus-дорожка, а
  компаньон перекладывает её в mp3 (LAME) уже на диске. Заодно поэтому mp3 и
  не зависит от того, что там YouTube разрешает скрипту.

=========================================================================
НАСТРОЙКИ В БЛОКНОТЕ: ytm-dl.json (0.5.2)

Его не надо искать в архиве и создавать руками: ytm.bat config (или пункт 10 в
меню) создаст ytm-dl.json из ТЕКУЩИХ значений ini и откроет в Блокноте. Файл
живёт В КОРНЕ папки (рядом с ytm.bat), не в app\. Правь, Ctrl+S, ytm.bat restart.

В корне папки лежит ytm-dl.example.json. Скопируй его в ytm-dl.json (рядом с
ytm.bat) и правь в Блокноте - это тот же ytm-dl.ini, только с нормальными
кавычками. Если ytm-dl.json существует, он ВАЖНЕЕ ini; баннер запуска и
ytm.bat selftest пишут «ytm-dl.json применён: …», так что видно, какой файл
действует. Ключи: out, port, token, organize, proxy, player_client,
cookies_from_browser, cookies_file, convert, verify. Строки «"//...":» -
комментарии, на них можно не смотреть, но и удалять не обязательно.

  "proxy": "none" - КАЧАТЬ НАПРЯМУЮ: не брать ни строку из конфига, ни системный
      прокси Windows (тот, что слушает Firefox в режиме «системный прокси»).
      Режим «сел на чужой ноут без VPN - и всё работает». В панели Tampermonkey
      для этого же появилось поле proxy: пусто = как в конфиге, none = прямо,
      адрес (http://127.0.0.1:7890 или socks5://127.0.0.1:10808) = через него.
  "convert": "mp3" (или m4a/opus) - перестраховка «файл скачался, а плеер
      телефона не ест»: готовый файл переупаковывается/перекодируется уже у
      компаньона, второй раз в сеть не ходя. Явный copy НЕ трогает никогда.
  "verify": false - выключить проверку «а играется ли готовый файл». Включена по
      умолчанию: поток, где контейнер на месте, а данных нет (ровно твой случай
      «не играбельный m4a»), теперь ЛОВИТСЯ ДО выдачи файла; битый файл не
      сохраняется и не попадает в архив «уже скачано», а в лог пишется причина и
      первые байты.

=========================================================================
ЧТО ПОПАДАЕТ В ЛОГ (это же - «скинь лог» в поддержку)

ytm-run.log рядом с ytm.bat (у движка - ytm-dl-log.txt в корне) с 0.5.2 содержит:
  - [userscript:info]/[userscript:err] - сообщения панели Tampermonkey: её log()
    и всё, что панель показала красным/жёлтым. Идёт, пока компаньон жив;
    подробная диагностика одной строкой - по кнопке «проверить» в панели;
  - [job id] попытка n/5 (клиент tv): exit 1 ERROR: ... - КАЖДАЯ неудачная
    попытка лесенки yt-dlp, а не только финальный вердикт;
  - строку версии: баннер пишет «build : ytm-dl 0.5.2», панель показывает её же
    в статусе («companion ok (сборка …)») и честно пишет «версии разошлись»,
    если панель и компаньон не обновлены синхронно. «Ничего не чинится» чаще
    всего объясняется именно этим - теперь видно за секунду.

=========================================================================
«СЛИШКОМ МНОГО УСТРОЙСТВ»: ЕСЛИ САМ ПЛЕЕР ВСТАЛ

Когда YouTube приостанавливает аккаунт («Воспроизведение приостановлено, так
как сейчас слишком много устройств...» - Premium-счётчик одновременных
прослушиваний, и общий выход прокси в него тоже вносит вклад), пустой
streamingData приходит ДАЖЕ во вкладке, а yt-dlp у всех клиентов получает
«The page needs to be reloaded». Это не «сломалось»: это лимит, и 5 попыток
лесенки его не снимают, а только усиливают подозрительность. Поэтому с 0.5.3:
  - auto видит лимит по перехваченному ответу плеера и сдаётся честно, одной
    строкой, вместо двух минут молчаливых ретраев;
  - ошибки бот-чека перестали совать «добавь cookies», когда cookies уже
    подключены (текст говорит: лимит/недоверие к IP, что делать);
  - record по-прежнему работает: он не зовёт /player, а пишет то, что играет;
  - с 0.5.4 компаньон САМ пробует тот же трек на www.youtube.com: Музыка и
    видеохостинг - одни и те же ролики и потоки (у Музыки просто нет картинки),
    а приостановки у них независимые. «В Музыке встало, на ютюбе играет» теперь
    лечится без галочек: второй круг лесенки идёт через видеохостинг, в логе это
    видно («музыка приостановлена - пробую тот же id на youtube.com»); с 0.5.5
  - с 0.5.5 то же и для «скачать весь плейлист»: если browse Музыки не отдаёт
    лист (HTTP 400 - «лист не перечисляется» в панели), листы PL/RD/OLK сами
    перечитываются на www.youtube.com. «Понравившиеся» к хосту привязаны - для
    них помогает только ждать паузы аккаунта; подменять их чужим списком мы не
    будем. Формат (mp3/m4a/opus) берётся из выпадающего «формат» В ПАНЕЛИ - если
    качается mp3, который вы не просили, посмотрите его там (настройка помнится).
  - 0.5.6: запросы yt-dlp к YouTube идут с настоящим браузерным TLS-отпечатком
    (колесо curl-cffi ставится офлайн-инсталлером само; выключается impersonate=off
    в ytm-dl.ini/json). В панели чекбокс «через youtube.com»: треки и листы сначала
    пробуются на видеохостинге, Music остаётся запасным (для PL/RD это и так
    автоматика, для альбомов OLAK - попытка с откатом). Настройки свёрнуты в
    секции; шапка панели всегда показывает формат/режим/дедуп.
  - 0.5.7: чиним то, что нашли в ваших логах. (1) Плейлист падал с «yt-dlp: нет
    вывода» - это была моя строка вместо объекта ImpersonateTarget в API (ошибка
    с пустым сообщением); теперь цель передаётся правильно, а любые пустые
    исключения печатаются с именем класса в ytm-run.log. (2) Авто-фолбэк на
    youtube.com не срабатывал для задач, где панель присылает только ссылку
    (режим resolve) - id теперь извлекается из url, фолбэк работает всегда.
    (3) «Не качать существующие» честно работает и без архива: если точно такой
    файл уже лежит в папке, задача пропускается с пометкой, а не плодит «(1)»;
    для альбомов - то же на каждой позиции. (4) Свёрнутый плеер: текущий трек
    берётся из player-bar, определение игры больше не требует адреса /watch?v=
    (скачивание с экрана альбома/liked работает; на странице альбома лист можно
    собрать «очередью со страницы», когда browse Музыки приостановлен).
  - 0.5.8: «(1)» добито до конца: проверка «файл уже лежит» в плейлисте стоит
    ТЕПЕРЬ ДО переноса файла, то есть отсекает и те позиции, которые yt-dlp зря
    перекачал из-за пустого архива (в 0.5.7 проверка ловила только «не скачался»).
    Имя ищется в любом известном контейнере, id дописывается в архив - самолечение.
    Третий закрытый путь - auto/ytdlp: там « (1)» рождался внутри webm_transcode,
    который пишет в папку сразу; проверка «уже лежит» теперь стоит перед ним.
    Установщики объединены: достаточно setup.ps1 (wheels ставит без сети; режим
    -PackagesOnly = только пакеты), install-packages-offline.bat оставлен обёрткой,
    двойной клик по нему по-прежнему работает.
  - 0.5.9: (1) чекбокс «youtube.com как запас» теперь честный: без галочки ходит
    ТОЛЬКО Music (в ошибке - подсказка «включи галочку»), с галочкой после reload-
    вердикта тот же id пробуется на youtube.com; для плейлистов - так же. Никакой
    ПЕРЕСТАНОВКИ приоритета хостов больше нет (это и выглядело как «всегда работает /
    инвертировано»). (2) Новое: кнопка «прогон через плеер» - полный алгоритм как в
    оригинальном приложении: для каждого трека страницы сама запрашивает /player
    (свои po-token и сессия браузера), стримы качаются из вкладки, компаньон делает
    теги/remux/архив; уже скачанное пропускается по архиву, при лимите даже на
    страницу прогон сам останавливается, чтобы не усугублять. (3) Обновление БЕЗ
    переустановки и без всяких .exe (программа - папка, не exe): распаковать
    ytm-dl-win.zip поверх старой папки (ytm-dl.ini, cookies.txt и music\ архив не
    трогает) и выполнить ytm.bat restart - всё.
  - 0.5.10: (1) «(1) самому первому файлу в пустой папке» - исправлено: после
    webm-транскода имя больше НЕ пересчитывается вторым dest_for (это он и рождал
    « (1)», видя файл, только что записанный первым). (2) Новый чекбокс «web_safari
    сразу»: лесенка стартует с рабочего клиента без прогрева default/tv; явно
    заданный player_client он не перетирает - конфликта с ручным режимом нет.
    (3) «Скачать весь плейлист» снова не требует галочки: перечитывание листа на
    www при browse-400 - автоматическое (закачка же трека - по-прежнему только по
    чекбоксу «youtube.com как запас»). (4) Кнопка прогона переименована в
    «браузерный прогон», у неё появился tooltip, а на странице без треклиста она
    берёт текущий трек; «скачать текущий» тоже теперь сам допрашивает страницу,
    если ответ плеера ещё не перехвачен.
  - 0.5.11: (1) «web_safari сразу» теперь включён по умолчанию, и явный клиент в
    лесенке реально ПЕРВЫЙ шаг (раньше впереди всё равно грелся default - отсюда
    «скачал только 5-м шагом»). (2) Плейлист: вместо вечных 0% - «скачиваю дорожку N»;
    позиции, упавшие на «Requested format is not available» у всех клиентов,
    добиваются по одной одиночным путём (тем самым сафари), а не пишутся в потери;
    если yt-dlp вообще не отдал лист - панель читает треклист запросом вкладки
    (/browse тем же, чем пользуется премиум-приложение). (3) Кнопка «браузерный
    прогон» убрана как лишняя: это стал выбор «очередь через: companion | browser»
    рядом с полем «лист»; прогон и очередь теперь пользуются одним сборщиком
    треклиста, страница альбома больше не «это не список». (4) Обложка доезжает и в
    ytdlp-режиме (берётся из плеер-бара), очереди с страницы - с заголовком трека.
  - 0.5.12: (1) «не скачалось 10» теперь действительно добивается по одному: падав
    позиции yt-dlp возвращает как None (без id), и 0.5.11 их не видел - id берётся из
    строк логгера, клиентоподобные качаются одиночным путём (сафари), count их учитывает.
    (2) Прогресс плейлиста ползёт и при нулевой закачке: «скачано k, отвалились m».
    (3) Чинка бага панели: ytcfg для чтения листа теперь берётся из окна страницы
    (в песочнице Tampermonkey его не было - «страница ещё не подготовила» было багом).
    (4) Теги и обложка доезжают даже когда запрос пришёл без меты - через info.json
    yt-dlp; очередь с страницы добавляет исполнителя и альбом. Чекбокс «web_safari
    сразу»: в новой версии он включен по умолчанию, НО если ты его когда-либо трогал,
    сохранённая настройка (выкл) имеет силу - включи галочку руками.
  - 0.5.13: «очередь со страницы» стала живой: статус показывает каждую позицию
    (очередь 7/40: название), после 3 ошибок подряд очередь встаёт сама - это щадит
    лимит аккаунта, а повтор кнопки позже докачает только недостающее. Плейлистное
    добивание получило ту же вежливость (пауза 4 с + стоп). Тултипы объясняют,
    где работает очередь и почему 320k влияет только на mp3 (в m4a лежит AAC из
    стрима, его потолок без premium ~128k - перекодировка в 320 файл удвоит, а
    звук нет; mp3 из него тоже не станет «настоящим 320», но контейнер и теги
    будут какие надо).
Что делать человеку: дождаться (час-два), выйти и войти в YouTube Music,
заккрыть лишние вкладки с музыкой, при возможности - сменить узел VPN.

=========================================================================
ЕСЛИ ОКНО ВСЁ ТАКИ ЗАКРЫВАЕТСЯ И НИЧЕГО НЕ ПИШЕТ

Тогда запускалка до своих проверок не доходит (или не находит app\control.py).
Есть способ это обойти: ytm-run.bat - ОДИН файл, который работает в ЛЮБОЙ папке
ytm-dl, старой или новой. Положи его в корень папки (туда же, где лежит ALIAS start.bat) и дважды
кликни. Он ничего не переустанавливает: печатает, какой python нашёл, прогоняет
--check, затем поднимает сервер прямо в этом окне (весь вывод виден, остановка -
Ctrl+C), и в конце ждёт нажатие клавиши. Всё то же самое падает в ytm-run.log рядом
с ним, так что если окно всё-таки мелькнуло - причина уже лежит в файле. Это
отладчик, не запускатель: когда сервер поднялся, ytm-run.bat можно удалить.

Заодно: если браузер пишет «адрес недоступен» на http://127.0.0.1:8765, а окно
ytm-run.bat показывает, что сервер запущен - это не папка, это firewall или прокси;
проверяется тем же адресом в браузере (должен быть короткий json, а не «сайт не найден»).

ЕСЛИ НА РУКАХ СТАРАЯ ПАПКА (там ещё есть test.bat, а ytm.bat нет)

Та папка устроена иначе: лог в ней затирает и печатает только powershell, а при
ошибке окно закрывается. Разобраться, почему она «молча не запускается», можно не
трогая её: возьми diag-old.bat (он лежит в корне этого архива, отдельным файлом, и
в саму папку его клал не я) и положи его РЯДОМ со start.bat - алиасом новой папки. Двойной
клик по нему. Он ничего не качает, ничего не удаляет и не зовёт powershell: он
покажет, какие файлы есть, что написали ytm-dl-log.txt и music\ytm-dl-server.log,
запускается ли python из app\python, и кто держит порт. Строка, которая нужна,
начинается с [WHY]. После ответа файл можно удалить.

Лечится это только одним способом: новая папка из этого архива (перенеси в неё
ytm-dl.ini и music\, а из app\ - python\, bin\ffmpeg.exe и bin\deno.exe).
Там вся диагностика - цифры 3, 4, 5 и 6 в меню, и окно не закрывается ни при
каком исходе.

ШПАРГАЛКА: 6 шагов (это тот же текст, что раньше лежал в SHPARGALKA.txt)
=========================================================================
Ты уже сделал: python лежит в app\python\  (есть app\python\python.exe)
                ffmpeg  лежит в app\bin\    (есть app\bin\ffmpeg.exe)
Если это не так — вернись к README-WINDOWS.txt.


[ ] 1. Поставить пакеты (одна минута, интернет НЕ нужен)
    Дважды кликни:   install-packages-offline.bat
    В окне должно появиться в конце:
        yt-dlp  2026.08.19
        mutagen 1.48.1
        PySocks 1.7.1
    (PySocks нужен, только если в proxy= стоит socks5:// - через него компаньон
     тянет обложки; yt-dlp умеет socks сам). Окно закрой (Enter / крестик).


[ ] 2. Проверить, что папка собрана правильно
    Дважды кликни:   ytm.bat   -> потом цифра 4 (самопроверка)
    Ищи строки "[ok  ]". Нужно, чтобы ffmpeg и mutagen были [ok].
    Строка "JS-runtime для yt-dlp" = [warn] — это НОРМАЛЬНО, можно жить.
    Если что-то [FAIL] — значит python или ffmpeg лежат не в той папке.


[ ] 3. Разрешить скрипты в браузере (только Chrome или Edge)
    В адресную строку вставь:   chrome://extensions      (Edge: edge://extensions)
    Найди Tampermonkey -> "Подробности" -> включи:
       • Разрешить пользовательские скрипты   <- ОБЯЗАТЕЛЬНО
       • Разрешить доступ к файловым URL       <- если будешь перетаскивать файл
    Firefox: этот шаг пропускаешь, там ничего включать не надо.


[ ] 4. Положить скрипт в Tampermonkey
    Открой папку  userscript  и перетащи файл  ytm-downloader.user.js
    прямо на окно браузера (на любую страницу) -> Tampermonkey покажет
    окно "Установить..." -> жми "Установить".
    Не получается перетащить: Tampermonkey -> "Создать новую панель
    управления"/"Создать новый скрипт" -> удали всё, что там есть ->
    открой ytm-downloader.user.js в Блокноте -> Ctrl+A, Ctrl+C ->
    вставь в редактор (Ctrl+V) -> Ctrl+S.
    Проверка: значок Tampermonkey на youtube music должен быть цветным,
    а в его меню должен быть пункт "Панель / настройки (Ctrl+Shift+Y)".


[ ] 5. Запустить движок
    Дважды кликни:   ytm.bat   -> потом цифра 1 (запуск)
    Первым делом он сам прогонит self-check (строки [ok]), потом в окне
    должно появиться:
        ytm-dl companion  http://127.0.0.1:8765
          ffmpeg    : C:\...\app\bin\ffmpeg.exe
          yt-dlp    : 2026.08.19
    Если ffmpeg или yt-dlp тут "НЕ НАЙДЕН" - пакеты/python лежат не в той папке.
    ЭТО ОКНО НЕ ЗАКРЫВАЙ, пока качаешь. Закрыл окно —downloads встали.


[ ] 6. Качать
    Открой  https://music.youtube.com  , включи любой трек.
    Внизу, в панели плеера, появится кнопка скачать (стрелка).
       • кнопка / Shift+D         = этот трек
       • Ctrl+Shift+Y             = панель: режим, формат, битрейт, папка
       • на панели нажми "проверить" -> должно ответить "companion ok"
    Готовые файлы падают в  music\  рядом с ytm.bat.

    Cookies: когда они реально нужны

       • НЕ нужны для обычного трека в режиме direct/replay/record и для пункта

         "Скачать обложку" - это работает из вкладки, где ты уже залогинен.

       • НУЖНЫ для "ytdlp" без перехвата, для "весь плейлист"/"Liked" и для всего,

         что YouTube отдаёт только вошедшим (explicit-контент).

       • Создать cookie руками нельзя: это то, что Google выдал входу (SID,

         __Secure-1PSID, SAPISID, у YTM ещё __Secure-3PSID). Можно только

         экспортировать существующее: DevTools (F12) -> Application -> Cookies ->

         .music.youtube.com, или расширение из шага 1 выше.

       • Файл = ключ от аккаунта Google. Держать в папке ytm-dl-win, не пересылать,

         не выкладывать, не коммитить. Утек - выйти из аккаунта в браузере, старый

         файл перестанет работать.

       • Протухает: YouTube крутит сессионные cookie. Лайфхак из FAQ yt-dlp:

         приватное окно -> войти -> экспорт -> ЗАКРЫТЬ окно (сессия больше не

         крутится) -> файл живой дольше обычного.



    Если ошибка в стиле "GM_xmlhttpRequest недоступен" или запросы не уходят:
      • Firefox при первом запросе скрипта к 127.0.0.1 показывает разрешение — его надо
        подтвердить; если мигнул и пропал: значок Tampermonkey -> сайт -> доступы
      • быстрая проверка без всякого скрипта: открой новую вкладку и вставь
          http://127.0.0.1:8765/hello
        если там JSON (ffmpeg/yt-dlp/python) — сервер живой, проблема на стороне браузера;
        если «не удаётся подключиться» — сервер не запущено (смотри ytm-dl-log.txt)
      • с этой версии запросы к серверу работают и без GM_xmlhttpRequest (обычным fetch),
        так что «нет разрешения» больше не должно быть причиной отказа

    Если окно закрылось СРАЗУ или «ничего не происходит» - два файла всё объяснят
    (копии обоих кладутся на Рабочий стол):
      ytm-dl-error.txt - трейс, если упала сама запускалка;
      ytm-dl-log.txt   - пишет САМ сервер (запускалка его больше не затирает):
        banner, трейс падения, «порт занят или недоступен» и "server exited, code N".
    Код 2 = порт занят старым компаньоном (запуск снимает его сам, --stop-other;
    если не вышло, код 3) — тогда: ytm.bat kill.
    Быстрая проверка, живой ли сервер: открой в новой вкладке
    http://127.0.0.1:8765/hello (порт — из ytm-dl.ini, не всегда 8765).
    Одна команда вместо всех этих разборов:  ytm.bat report  - соберёт статус,
    netstat по порту из ini, python-процессы с командными строками, --check и
    хвост лога в ytm-dl-report.txt (плюс копия на Рабочий стол).

    Если кнопки НЕТ или она ничего не делает:
      • Ctrl+Shift+Y -> в панели "диагностика". Ищи строку "ui":
          host: true,  floating: false  = сел в плеер-бар, всё ок
          host: false, floating: true   = разметку YTM обновили, кнопка плавает
                                           в правом нижнем углу страницы
      • панели нет вообще -> скрипт не на той вкладке/отключён: значок
        Tampermonkey на music.youtube.com должен быть цветным и показывать
        "YTM Downloader ... включен"
      • если панель не открывается, но скрипт вообще запускается: в меню
        Tampermonkey есть пункт "Показать панель (даже если UI не построился)" —
        он открывает панель принудительно; любая фатальная ошибка скрипта теперь
        показывается красной плашкой сверху страницы, а не только в консоли
      • "companion не отвечает" в статусе -> окно закрыто, либо порт
        не совпадает с ytm-dl.ini (по умолчанию 8765)

    Файл скачался, но НЕ играется (или имя с unknown_video, два трека одного
    размера): это не плеер виноват, это вместо музыки в файл легла страница
    «подтвердите, что вы не бот». Проверить за 10 секунд:
      • ПКМ по файлу -> Свойства: размер у двух разных треков одинаковая, или
        имя кончается на unknown_video - значит внутри не медиа;
      • Ctrl+Shift+Y -> «диагностика» / хвост ytm-dl-log.txt: там будет строка
        "вместо медиа пришёл текст (бот-чек...)" вместо молчаливого «готово»;
      • что делать: режим resolve (или browser в ytm-dl.ini), а если уже лежит
        cookies_file - убедиться, что он свежий (выйти из аккаунта и войти снова).
    С версии 0.4.2 такое молча не сохраняется: companion смотрит первые байты,
    называет контейнер по ним (m4a/webm/opus/mp3), HTML отказывается писать на
    диск и говорит почему. Старые «пустышки» из папки просто удали.

    Почему в скачанных с гитхаба программах это работало, а тут пишет про
    бот-чек: они вообще ничего не качают из браузера. Внутри у них один и тот
    же трюк - вызвать yt-dlp ссылкой на видео и всё. ytm-dlp-gui: аргументы
    лежат в assets/arguments ("-x", "-f", "bestaudio", "--audio-format m4a"),
    cookie там нет ни одного — весь труд на yt-dlp. А y2mp3 и gordonpn устроены
    иначе: ytdl-core + fluent-ffmpeg (у y2mp3 это форк @distube/ytdl-core), то
    есть поток тянут из самого приложения — тот же путь, что у нас "direct".
    yt-dlp тем временем сам получает player response, сам ставит заголовки и
    po-token и качает тем же IP, с которого запрашивал. Браузерная же выдача
    googlevideo — как раз то, что YouTube считает подозрительным трафиком; поэтому
    скриптовые сборки (и наш direct) падают от бот-чека первыми, а yt-dlp-путь — последним.
    Отсюда режим "ytdlp" в панели (Tampermonkey -> настроить): он не трогает
    перехваченный player response и отдаёт задачу yt-dlp ровно так, как
    оригинальное приложение. Если и он скажет "sign in to confirm" - значит
    YouTube прижимает твой IP/аккаунт, и тогда нужен cookies_file (или
    cookies_from_browser=chrome) в ytm-dl.ini: оригинал бы тоже встал.

    Весь плейлист или "Liked": открой его в YTM, в панели нажми
    "Скачать весь лист / liked одной задачей". Уже скачанное он
    пропускает сам (архив .ytm-archive.txt), поэтому можно жать
    эту кнопку хоть каждый день — докачает только новое.


=========================================================================
ОКНО УПРАВЛЕНИЯ (когда надо остановить/посмотреть/освободить папку)
-------------------------------------------------------------------------
  ytm.bat             вот это меню (двойной клик по ytm.bat)
  ytm.bat serve       то же, что цифра 1 (запуск движка в этом же окне)
  ytm.bat status      кто висит, занят ли порт, сколько детей и задач
  ytm.bat stop        штатная остановка (сервер сам снимает yt-dlp/ffmpeg)
  ytm.bat kill        жёстко, через taskkill /T /F (дерево процесса)
  ytm.bat selftest    проверка папки (бывший test.bat)
  ytm.bat report      весь отчёт в файл (бывший diagnostic.bat)
  ytm.bat uninstall   остановить всё и проверить, что папку можно удалить

  Как узнать, занята ли папка, не выходя из браузера: в панели кнопка «проверить»
  дописывает строку "· занят: 2 процесс(а), 1 задач(а)" или "· свободен (можно
  останавливать и удалять)". Если "занят" — жми ytm.bat stop, потом ещё раз
  «проверить»: должно стать "свободен", и папка удалится без висящих процессов.

  «Не удаляется папка» = внутри висит python/companion (или его yt-dlp/ffmpeg).
  Запуск сам освобождает порт (--stop-other у сервера, без PowerShell), поэтому
  повторный старт не говорит «порт занят». Старая папка: запусти в НЕЙ ytm.bat stop и/или kill.

Если не работает — три причины на 90% случаев
-------------------------------------------------------------------------
"companion недоступен" / "Failed to fetch"
    -> движок не запущен (ytm.bat -> 1), либо в шаге 3 не включён
       "Разрешать пользовательские скрипты", либо порт занят:
       поменяй port= в ytm-dl.ini и в поле "port" на панели.

Скачивается, но файл без обложек/тегов или тишина в music\
    -> ffmpeg не там. Должно быть ровно app\bin\ffmpeg.exe, а не
       app\bin\ffmpeg-8.0\bin\ffmpeg.exe. Проверь ytm.bat selftest.

"Sign in to confirm you're not a bot" / 403
    -> нужны cookies ТВОЕГО аккаунта. Порядок такой:
       1) в браузере, где ты залогинен в music.youtube.com, ставишь расширение
          "Get cookies.txt LOCALLY" (или "cookies.txt") -> на вкладке YTM жмёшь на
          иконку -> Export -> сохраняется youtube.com_cookies.txt;
       2) переименовываешь в cookies.txt и кладёшь В КОРЕНЬ ytm-dl-win (рядом с ytm.bat);
       3) в ytm-dl.ini:  cookies_file=cookies.txt   (путь относительно папки) - или НЕ
          трогать ini вовсе: cookies.txt рядом с ytm.bat (или в папке вывода) само
          подхватывается на старте движка, и в баннере + selftest тогда написано
          "файл cookies.txt: … (автомат, из папки программы)". Явная строка в ini
          важнее авто-поиска. Положил файл, а selftest всё ещё пишет "none"? Значит
          движок не перезапущен: и ini, и поиск рядом читаются только на старте.
       4) перезапускаешь движок (ytm.bat -> 1) и проверяешь:
            ytm.bat -> 4 (selftest)
              [ok  ] cookies (доступ к аккаунту) — файл cookies.txt: 41 cookie youtube, вход есть (4)
          если там "нет ни одного авторизационного" — ты экспортировал, НЕ будучи
          залогинен; если "0 строк" — это JSON вместо Netscape (нужны TAB-ы).
       Путь "без файлов" для Firefox - cookies_from_browser=firefox: Firefox не шифрует
       своё хранилище, yt-dlp читает профиль сам. Только ЗАКРОЙ firefox на время запуска
       движка (открытый профиль залочен: "database is locked") - дождись баннера в окне
       и открывай firefox обратно. С Chromium (chrome/edge/brave/opera/vivaldi) тот же
       ключ - лотерея: с 127-й версии их хранилище шифруется, и ответом будет
       "Failed to decrypt with DPAPI" (это защита браузера, не наша поломка) - там и
       нужен экспорт в cookies.txt, как выше.
       ПОРТАТИВНЫЙ Firefox (PortableApps: X:\...\FirefoxPortable\App\Firefox64) этим
       путём "в лоб" НЕ работает: yt-dlp из поставки ищет профиль на Windows ТОЛЬКО
       в %APPDATA%\Mozilla\Firefox\Profiles (плюс папка браузера из MS Store). У
       портативного браузера там ничего нет -> "could not find firefox cookies
       database in ...". Лечится явным путём к профилю, синтаксис ровно тот же, что у
       yt-dlp --cookies-from-browser:
         cookies_from_browser=firefox:X:\PortableApps\FirefoxPortable\Data\profile
       путь вести надо к папке, в которой ЛЕЖИТ cookies.sqlite (Data\profile, а НЕ
       App\Firefox64 - это сам браузер); можно дать и ...\FirefoxPortable, и
       ...\Data\profile\Profiles - найдётся. Логины живут в контейнере -> допиши
       "::имя" (или "::none", если без контейнера). После правки: ytm.bat -> 4
       (selftest), строка cookies должна стать [ok] ... профиль firefox:
       <путь>\cookies.sqlite; закрытый firefox на время запуска движка по-прежнему
       обязателен. Не хочешь возиться с путями - экспорт в cookies.txt (см. выше)
       работает независимо от того, где живёт профиль.
       (разбор пути и эти подсказки - с 0.4.8: там же selftest понимает firefox:<путь>;
       обновление = распаковать новый архив в ту же папку, ytm-dl.ini и музыку на месте
       не трогать - зависимости не менялись, setup.ps1 заново запускать не нужно).

"YouTube недоступен вообще" (РФ): прокси
    -> главный вопрос: ЧЕМ именно обходится блокировка. Ответ видит selftest:
       ytm.bat -> 4  ->  строка "proxy (чем ходит yt-dlp)".
       • VPN поднимает интерфейс на весь ПК (WireGuard, Outline-сервер, TUN-режим
         Clash/v2rayN) или прокси прописан в системных параметрах Windows: тогда python
         и yt-dlp УЖЕ идут через него. proxy= можно оставить ПУСТЫМ - с этой версии
         компаньон сам читает системный прокси (WinINET, его же слушает Firefox в режиме
         "системный прокси"), проверяет, что порт отвечает, и наследует его.
       • проксирует только браузер (FoxyProxy в Firefox: "системный прокси
         socks5://127.0.0.1:10808", SwitchyOmega, "прокси" в настройках браузера):
         тогда всё, что НЕ браузер, ходит напрямую, и это надо починить одной строкой
         в ytm-dl.ini - тем же адресом:
              proxy=socks5://127.0.0.1:10808
         SOCKS5 теперь работает: yt-dlp умеет его сам (yt_dlp/socks.py, PySocks для
         этого не нужен), а собственным запросам компаньона (обложка, thumbnail)
         нужен PySocks - он ЕДЕТ В АРХИВЕ (wheels\PySocks-1.7.1) и ставится тем же
         install-packages-offline.bat / setup.ps1. Можно и http-вход того же клиента:
         Clash/Mihomo :7890, v2rayN :10809, Surge :6152.
    -> почему трек скачался и без proxy=: байты шли ИЗ ВКЛАДКИ (режимы
       direct/replay/record качает браузер, а браузер у тебя проксируется). Как только
       задача уходит в yt-dlp (ytdlp, browser, playlist/liked) или компаньон сам тянет
       обложку - это отдельный процесс, и ему нужен свой путь наружу. С этой версии
       proxy= доезжает до ВСЕГО (раньше - только до url-режима), плюс пустое поле more
       не «вслепую напрямую»: значение берётся из системного прокси, если тот есть.
    -> выход зафиксирован (один узел)? Тогда всё хорошо: googlevideo-ссылка привязана к
       IP выдачи, и при фиксированном выходе "вкладка и yt-dlp с разных IP" не случается.
       Риск появится, если включишь автосмену узлов - тогда зафиксируй узел или качай в
       direct/replay (там байты вообще из вкладки).
    -> проверить: ytm.bat -> 4 (selftest), строка "proxy (чем ходит yt-dlp)".

    Если UI не строился и консоль кричала "Element.innerHTML setter ... blocked by
    CSP": с версии 0.3.8 панель собирается без innerHTML (только createElement),
    поэтому на Firefox+Tampermonkey она появляется даже при строгой CSP страницы.
    Как убедиться, что версия новая: заголовок панели сам показывает v0.6.3 (с
    этой версии цифра берётся из @version, а не захардкожена), а статус «companion
    ok (сборка 0.6.3)» - версию компаньона; при разнобое панель пишет «версии
    разошлись». А надёжнее всего: Tampermonkey -> свойства скрипта -> 0.5.13 (если там
    старьё - перетащи userscript\ytm-downloader.user.js в Tampermonkey ещё раз,
    он спросит замену)

deno.exe — ЭТО НЕ УСТАНОВКА. Это один файл с GitHub, и он кладётся в app\bin:
      • самый простой путь: запусти  ytm.bat deno --download   (раньше был get-deno.bat)
        (он сам качает deno с github.com/denoland/deno/releases, сверяет sha256
         и кладёт deno.exe в app\bin; если на ПК уже стоит node — скопирует его)
      • вручную: https://github.com/denoland/deno/releases/latest
        -> asset  deno-x86_64-pc-windows-msvc.zip  (~42 МБ)
        -> распаковать, достануть ОДИН deno.exe  -> в app\bin\
      • если качать нечем вообще: в ytm-dl.ini поставь player_client=tv
        (этот клиент YouTube не требует ни po-token, ни JS-runtime)

Кнопки для двух этих случаев (оба необязательные, ничего не устанавливается):
  • «auto» падает «это не медиапоток», а yt-dlp качает: в auto байты берутся из
      вкладки; если cookies нет, вкладка отдаёт HTML/заглушку - отсюда и ошибка, а
      дальше включается запасной прогон через yt-dlp. С 0.4.9 cookies.txt в корне
      подхватывается сам, так что «auto» снова становится авто, а не «попробуй browser».
  • качает .webm без обложки: web/tv-выдача без cookies не содержит m4a, и yt-dlp брал
      opus. Теперь в запасном прогоне просим bestaudio[ext=m4a], а web_safari идёт
      первым в очереди клиентов. Плюс с 0.5.0: если всё-таки прилетел webm/opus,
      компаньон приводит его к ВЫБРАННОМУ формату до записи тегов -
        m4a  -> AAC 256k (у opus прозрачность наступает раньше 256k; потер на слух
                почти нет, зато обложка и теги живут как у всех: covr читает всё)
        mp3  -> LAME V0 (~245k) или CBR из ini (bitrate=). Да, это ДВОЙНОЕ lossy
                (сначала opus, потом mp3) - файл такого размера, что на слух не
                слышно, и об этом честно пишется в лог задачи; зато APIC+ID3 видно
                везде, включая проводник Windows
        opus -> webm перепаковывается в .opus С -c copy, ни одного перекодирования,
                качество бит в бит; обложка кладётся в METADATA_BLOCK_PICTURE
                (foobar2000/VLC/mpv видят; проводник - нет, но это цена zero-loss).
                Android: .opus играет нативно (Ogg/Opus встроен с 5.0), текстовые
                теги системный экстрактор читает, а вот embedded-обложку - НЕТ
                (в исходниках AOSP OggExtractor разбора METADATA_BLOCK_PICTURE нет,
                проверено по android14-release); Poweramp/Musicolet/VLC для Android -
                читают. Картинка «везде, включая бортовые системы авто» - это m4a/mp3.
                auto-режим, когда браузер отдал opus-байты, теперь шлёт format=opus:
                тот же remux без потерь, а не сырой .webm (format=copy не тронут -
                это по-прежнему «кинь как есть», для тех, кому надо именно так).
      format=copy не трогается вовсе: просил сырьё - получай сырьё как есть.
  • «This video is not available» на одном и том же треке: это решает YouTube (страна
      выхода, возраст, «только для входа»), а не сборка. С cookies того аккаунта, под
      каким видео видно в браузере, обычно уезжает; без него список форматов короче.
  • «компаньон:  · 100%» на плейлисте: пустое сообщение больше не печатается - в панели
      видно «yt-dlp вернул 0 позиций из N» или «не скачалось: N», и задача с нулём
      файлов считается ошибкой, а не успехом (раньше «пусто» выглядело как «всё ок»).
  • плейлист: 10 из 10 «The page needs to be reloaded» при валидных cookies. Причина была
      в двух слоях: userscript форсил player_client=tv, а компаньон передавал его
      в yt-dlp списком строк «player_client=tv» - API же ждёт СЛОВАРЬ, и строки
      тихо игнорировались: лист всегда ехал на web-дефолте, который без po-token и
      отвечает «reloaded». Теперь userscript клиента не форсит, extractor_args едет
      словарём, и при «ни один трек не скачался» лист сам пересобирается на
      web_safari+formats=missing_pot, затем на web_embedded (успешное download_archive
      не перекает, так что повтор дешёвый). tv по-прежнему работает, если прописать
      player_client=tv в ini: он станет первым в ряду, а не единственным.
  • bot-check всё время -> скачай deno ОДНИМ файлом и положи рядом с ffmpeg:
      https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-pc-windows-msvc.zip
      (внутри один deno.exe, ~110 МБ; контрольная сумма того zip:
       15E5300B0BA3C3695A7621D90160A746EC9E710228CEE639AFA9D580F6E3CD11)
      путь: app\bin\deno.exe  ->  перезапусти движок (ytm.bat -> 1), warn в самопроверке станет [ok]
  • Firefox: cookies_from_browser=firefox ругается "database is locked", пока браузер
      открыт (профиль залочен): закрой firefox, дождись баннера движка, открой обратно.
      Ругается "could not find firefox cookies database" - значит Firefox портативный
      и профиль не в %APPDATA%: пиши путь прямо в ключ, см. раздел про cookies.
      Совсем надёжный обход: экспортни cookies для music.youtube.com
      в формате Netscape (расширение "cookies.txt" / "cookie-exporter") сохрани рядом со
      папкой и в ytm-dl.ini поставь:  cookies_file=cookies.txt   , затем перезапуск.
      С Chrome/Edge/Brave/Vivaldi/Opera то же самое ещё актуальнее: с 2024 года их
      cookie-хранилище шифруется (app-bound encryption), и cookies_from_browser читает
      его через силу -> "Failed to decrypt with DPAPI". Экспорт в файл работает всегда.

Режим на панели: auto ломается -> поставь "replay", потом "direct".
Формат: m4a = оригинал без перекодирования (быстро, качество 256k AAC),
        mp3 = на всякий случай, 192k достаточно.
=========================================================================
