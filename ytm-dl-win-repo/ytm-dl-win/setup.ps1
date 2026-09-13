# ytm-dl setup - Windows 10/11, PowerShell 5+. Run ONCE, from inside the portable folder.
# It downloads portable Python 3.12 (with pip) into app\python and ffmpeg.exe into app\bin,
# then installs yt-dlp + mutagen + PySocks + curl-cffi into that Python only.
# 0.5.8: this is the ONLY installer now. If wheels\*.whl are next to this script, packages
# install from them without any network (old install-packages-offline.bat behaviour).
#   .\setup.ps1 -PackagesOnly   just (re)install packages into existing python, nothing else.
# No system install, no registry, no PATH changes: everything stays in this folder.
# Skip it entirely and place the files by hand - README-WINDOWS.txt lists the exact URLs.
#
#   .\setup.ps1                online: downloads python + ffmpeg, pip installs from PyPI
#   .\setup.ps1 -Offline       no network at all: pythonfmpeg from the local folder,
#                              yt-dlp + mutagen + PySocks from the wheels\ that ship here
param([switch]$Offline, [switch]$PackagesOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ($PackagesOnly) {
  # Старый install-packages-offline.bat стал этим режимом: только пакеты, без скачивания
  # python/ffmpeg. Python берём портативный, а если его нет - любой из PATH (как раньше).
  $py = 'app\python\python.exe', 'app\python\bin\python.exe', 'app\python.exe' |
        ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $py) { $g = Get-Command python.exe -ErrorAction SilentlyContinue; if ($g) { $py = $g.Source } }
  if (-not $py) { throw "python not found: app\python\python.exe is missing and python.exe is not in PATH" }
  $wheels = Get-ChildItem -Path (Join-Path $root 'wheels') -Filter *.whl -ErrorAction SilentlyContinue
  if (-not $wheels) { throw "no .whl files in wheels\ - the archive was unpacked partially." }
  Write-Host "[.] python : $py"
  Write-Host "[.] wheels : $root\wheels ($($wheels.Count) files)"
  & $py -m ensurepip --upgrade 2>&1 | Out-Null
  & $py -m pip install --disable-pip-version-check --no-index --find-links (Join-Path $root 'wheels') --upgrade yt-dlp mutagen PySocks curl-cffi
  if ($LASTEXITCODE -ne 0) { throw "pip failed. Then run: ytm.bat selftest" }
  & $py -c "import importlib.metadata as m;print('    yt-dlp ',m.version('yt-dlp'));print('    mutagen',m.version('mutagen'));print('    PySocks',m.version('PySocks'));print('    curl_cffi',m.version('curl-cffi'))"
  Write-Host "ok. packages are inside that python - nothing was installed into the system."
  exit 0
}

$PyUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only.tar.gz'
$FfUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

function Get-To([string]$url, [string]$dest) {
  if (Test-Path $dest) { Write-Host "  already downloaded: $(Split-Path -Leaf $dest)"; return }
  Write-Host "  downloading $(Split-Path -Leaf $dest) ..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

New-Item -ItemType Directory -Force -Path app\python, app\bin, music | Out-Null

# ---- 1. portable python -------------------------------------------------------
Write-Host "[1/4] portable python -> app\python"
if (-not (Test-Path app\python\python.exe) -and -not (Test-Path app\python\bin\python.exe)) {
  $tgz = Join-Path $env:TEMP 'ytm-py.tar.gz'
  Get-To $PyUrl $tgz
  tar -xf $tgz -C app\python --strip-components=1
  Remove-Item $tgz -ErrorAction SilentlyContinue
} else { Write-Host "  app\python already unpacked" }
$py = if (Test-Path app\python\python.exe) { "$root\app\python\python.exe" } else { "$root\app\python\bin\python.exe" }
if (-not (Test-Path $py)) { throw "python.exe missing after extraction (expected app\python\python.exe)" }
& $py --version

# ---- 2. packages into that python only ---------------------------------------
& $py -m ensurepip --upgrade 2>&1 | Out-Null
# 0.5.8: если wheels\ лежат рядом - ставим С НИХ, сети не нужно (это и есть бывший
# install-packages-offline.bat). Нет wheels - обычный pip из PyPI.
$wheels2 = Get-ChildItem -Path (Join-Path $root 'wheels') -Filter *.whl -ErrorAction SilentlyContinue
if ($wheels2) {
  # wheels are py3-none-any (pure python, no dependencies) - bundled in this archive.
  # PySocks gives the companion itself a socks5 path (covers/thumbnails); yt-dlp has its own.
  Write-Host "[2/4] pip install --no-index --find-links wheels  (offline, $($wheels2.Count) wheels)"
  & $py -m pip install --disable-pip-version-check --no-index --find-links (Join-Path $root 'wheels') --upgrade yt-dlp mutagen PySocks curl-cffi
} elseif ($Offline) {
  throw "Offline: папка wheels не найдена - архив распакован не целиком?"
} else {
  Write-Host "[2/4] python -m pip install -U yt-dlp mutagen PySocks curl-cffi"
  # PySocks ставится «по-хорошему»: если его нет в сети, установка не должна падать -
  # без него работают и yt-dlp (свой socks), и обложки напрямую
  & $py -m pip install --disable-pip-version-check --upgrade yt-dlp mutagen PySocks curl-cffi
}
if ($LASTEXITCODE -ne 0) { throw "pip failed." }

# ---- 3. ffmpeg (a single exe is enough for remux/mp3) -------------------------
Write-Host "[3/4] ffmpeg -> app\bin\ffmpeg.exe"
if ($Offline -and -not (Test-Path app\bin\ffmpeg.exe)) {
  $local = Get-ChildItem -Path . -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notlike '*\app\bin\*' } | Select-Object -First 1
  if ($local) { Copy-Item $local.FullName app\bin\ffmpeg.exe -Force; Write-Host "  taken from $($local.FullName)" }
}
if (-not (Test-Path app\bin\ffmpeg.exe)) {
  if ($Offline) { throw "Offline: ffmpeg.exe нет в app\bin и скачивать нельзя. Положите ffmpeg.exe в app\bin вручную (или уберите -Offline)." }
  $zip = Join-Path $env:TEMP 'ytm-ff.zip'
  Get-To $FfUrl $zip
  $tmp = Join-Path $env:TEMP 'ytm-ff'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem -Path $tmp -Recurse -Filter ffmpeg.exe | Where-Object { $_.FullName -like '*\bin\*' } | Select-Object -First 1
  if (-not $exe) { throw "ffmpeg.exe not found inside the archive" }
  Copy-Item $exe.FullName app\bin\ffmpeg.exe -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -ErrorAction SilentlyContinue
} else { Write-Host "  app\bin\ffmpeg.exe already there" }

# ---- 4. self-check ------------------------------------------------------------
Write-Host "[4/4] self-check"
$env:YTMDL_FFMPEG = "$root\app\bin\ffmpeg.exe"
$env:YTMDL_PYTHON = $py
& $py app\companion.py --check --out "$root\music"
Write-Host ""
Write-Host "done. start the companion with ytm.bat (double-click -> 1), then load userscript\ytm-downloader.user.js into Tampermonkey."
