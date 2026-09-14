#!/usr/bin/env bash
# Генерация фикстур для tests/test_real_mp4.mjs
#   tone.m4a     — обычный (не фрагментированный) AAC, «эталон»
#   stream.m4s   — тот же звук, но нарезанный на несколько moof+mdat (как googlevideo
#                  отдаёт аудио кусками по Range-запросам) — полигон для assembleMp4
set -e
cd "$(dirname "$0")/.."
FF=${FF:-$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())" 2>/dev/null || command -v ffmpeg)}
mkdir -p tests/fixtures
"$FF" -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=3" -c:a aac -b:a 128k -y tests/fixtures/tone.m4a
# -frag_size даёт несколько фрагментов даже на монотонном тоне (keyframe-only не режет sine)
"$FF" -i tests/fixtures/tone.m4a -c copy -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_size 8192 -f mp4 -y tests/fixtures/stream.m4s
ls -l tests/fixtures/
