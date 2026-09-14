// Проверка сборки MP4 на НАСТОЯЩЕМ фрагментированном AAC-потоке (не на рукописной фикстуре).
// 1) берём init-сегмент и mdat из файла, созданных ffmpeg;
// 2) прогоняем через assembleMp4 из реального userscript'а;
// 3) проверяем, что полученный файл читается внешними инструментами (ffprobe/ffmpeg/mutagen).
//   node tests/test_real_mp4.mjs
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => path.join(here, 'fixtures', f);

/* ---- загрузка логики userscript'а (тот же файл, что ставится в Tampermonkey) ---- */
const src = fs.readFileSync(path.join(here, '..', 'userscript', 'ytm-downloader.user.js'), 'utf8');
const stub = () => ({ style: {}, dataset: {}, hidden: true, textContent: '', innerHTML: '', children: [], firstElementChild: { style: {} }, appendChild() {}, append() {}, insertBefore() {}, contains: () => true, addEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => stub(), querySelectorAll: () => [], closest: () => null, click() {}, remove() {} });
const sb = { console, TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, Number, String, Object, Array, Set, Map, RegExp, Error, URLSearchParams, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {}, location: { href: 'x', search: '', origin: '' }, document: { title: 'x', readyState: 'complete', head: stub(), body: stub(), documentElement: stub(), createElement: () => stub(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }, MutationObserver: class { observe() {} }, fetch: async () => ({}), XMLHttpRequest: class {} };
sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(src, sb, { filename: 'userscript' });
const L = sb.YTMDL_LIB;

/* ---- ffmpeg/ffprobe ---- */
// В этом окружении ffmpeg лежит только в wheel'е imageio-ffmpeg, а ffprobe там отсутствует:
// берём путь из get_ffmpeg_exe() ЦЕЛИКОМ и валидируем всё одним ffmpeg (-f null для декода,
// -f wav с разбором заголовка — заодно проверка, что звука реально столько, сколько заявлено).
let FF = null;
try { FF = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim(); } catch {}
if (FF && !fs.existsSync(FF)) FF = null;
if (!FF) { try { FF = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch { FF = null; } }
const have = (...p) => p.every((x) => fs.existsSync(x));

let pass = 0, fail = 0, skip = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const skipT = (n) => { skip++; console.log('  skip ' + n); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

if (!have(fx('stream.m4s'), fx('tone.m4a'))) {
  console.log('нет фикстур (tests/fixtures/stream.m4s) — сгенерируйте: bash tools/make_fixtures.sh');
  process.exit(0);
}

/* ---- 1. выделяем init и медиа-байты из реального frag-потока ---- */
const stream = fs.readFileSync(fx('stream.m4s'));
const boxes = L.walkBoxes(new Uint8Array(stream), 0);
console.log('боксы потока:', boxes.map((b) => b.type).join(' '));
const initBox = boxes.find((b) => b.type === 'moov');
const initBytes = stream.subarray(0, initBox.start + initBox.size);   // ftyp..moov (+可能 moof до первого mdat)
const mdatList = boxes.filter((b) => b.type === 'mdat');
const sizes = mdatList.map((b) => b.size - 8);
const mdatBytes = Buffer.concat(mdatList.map((b) => stream.subarray(b.start + 8, b.start + b.size)));

console.log(`\ninit ${initBytes.length} Б, mdat-ов ${mdatList.length}, медиа ${mdatBytes.length} Б`);

/* ---- 2. сборка ---- */
const collected = L.collectSamples(new Uint8Array(stream));
ok(collected.n > 0 && collected.sizes.length === collected.n,
  `collectSamples: ${collected.n} сэмплов из ${mdatList.length} фрагментов (partial=${collected.partial}, estimated=${collected.estimated})`);
ok(collected.sizes.reduce((a, b) => a + b, 0) === mdatBytes.length, 'сумма размеров == сумма mdat-payload (47083) — таблицы сходятся с медиа');
ok(collected.sizes.every((x) => x > 0), 'все размеры положительны (не нули из пустого trun)');
const samples = collected.sizes.map((size, i) => ({ size, duration: collected.durations[i] || 1024 }));
const res = L.assembleMp4(new Uint8Array(initBytes), new Uint8Array(mdatBytes), samples);
ok(!res.warnings.some((w) => /нет таблицы/.test(w)), 'предупреждения «нет таблицы сэмплов» нет');
const outPath = path.join(os.tmpdir(), `ytm_assembled_${process.pid}.m4a`);
fs.writeFileSync(outPath, Buffer.from(res.bytes));
console.log('warnings:', res.warnings.length ? res.warnings : 'нет', '| fixed:', res.fixed);

ok(res.bytes.length > mdatBytes.length, 'собранный файл больше, чем просто медиа-байты');
{
  const obx = L.walkBoxes(res.bytes, 0);
  const moovB = obx.find((b) => b.type === 'moov');
  const stblB = moovB && L.findPath(res.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl'], moovB.start);
  const kids = stblB ? L.childBoxes(res.bytes, stblB).map((b) => b.type) : [];
  eq(kids.filter((x) => x === 'stsz').length, 1, 'в собранном файле ровно один stsz (дубли init-сегмента удалены)');
  eq(['stts', 'stsc', 'stco'].every((k) => kids.filter((x) => x === k).length === 1), true, 'stts/stsc/stco тоже без дублей');
  eq(kids.indexOf('stsd') >= 0 && kids.indexOf('stsd') < kids.indexOf('stts'), true, 'stsd не потерян и стоит до stts');
}
const ob = L.walkBoxes(res.bytes, 0);
ok(ob.every((b) => b.start + b.size <= res.bytes.length) && ob.reduce((a, b) => a + b.size, 0) === res.bytes.length,
  'все боксы собранного файла валидных размеров и покрывают его целиком');
ob.length && console.log('боксы результата:', ob.map((b) => b.type).join(' '));

if (!FF) { skipT('ffprobe/ffmpeg недоступны — пропущена проверка чтения файла'); }
else {
  /* ---- 3a. читается ли как mp4 ---- */
  let dur = null, codec = null, parseErr = null;
  {
    // ffprobe'а нет → читаем отчёт ffmpeg об input из stderr (он пишется и при ошибке «нет выхода»)
    let txt = '';
    try { txt = execFileSync(FF, ['-hide_banner', '-i', outPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { txt = String((e && e.stderr) || '') + String((e && e.stdout) || ''); }
    codec = (txt.match(/Audio:\s*([a-z0-9]+)/i) || [])[1] || null;
    const dm = txt.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    dur = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : null;
    if (dur === null) parseErr = txt.slice(0, 240);
  }
  ok(parseErr === null, 'ffmpeg разобрал заголовок собранного файла' + (parseErr ? ': ' + parseErr : ''));
  ok(codec === 'aac', `кодек именно aac (${codec}) — stsd/esds пережили пересборку`);
  ok(dur && Math.abs(dur - 3.0) < 0.2, `длительность ${dur}s == ~3s (mvhd/tkhd/mdhd восстановлены)`);

  /* ---- 3b. декодируется ли без ошибок (не просто парсится) ---- */
  const wavPath = outPath + '.wav';
  let decErr = null;
  try {
    execFileSync(FF, ['-v', 'error', '-xerror', '-i', outPath, '-f', 'wav', '-y', wavPath], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { decErr = String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | '); }
  ok(decErr === null, 'ffmpeg декодировал файл с -xerror без ошибок' + (decErr ? ': ' + decErr : ''));
  ok(fs.existsSync(wavPath) && fs.statSync(wavPath).size > 100000, `wav после декодирования ${fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0} Б (звук действительно есть)`);

  /* ---- 3c. remux в mp3 (то, что делает companion) ---- */
  const mp3Path = outPath + '.mp3';
  let remuxErr = null;
  try { execFileSync(FF, ['-v', 'error', '-xerror', '-i', outPath, '-c:a', 'libmp3lame', '-b:a', '128k', '-y', mp3Path], { stdio: 'pipe' }); }
  catch (e) { remuxErr = String(e.stderr || e.message).slice(0, 160); }
  ok(remuxErr === null, 'remux в mp3 прошёл' + (remuxErr ? ': ' + remuxErr : ''));
  const mp3Size = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
  ok(mp3Size > 30000, `mp3 ненулевой (${mp3Size} Б)`);

  /* ---- 3d. теги поверх собранного файла (проверка, что moov пригоден для правки) ---- */
  const tagScript = `
import sys, json
from mutagen.mp4 import MP4, MP4Cover
p = sys.argv[1]
m = MP4(p)
m['\\xa9nam'] = ['Real Test Title']; m['\\xa9ART'] = ['Real Artist']; m['trkn'] = [(7, 0)]
m['covr'] = [MP4Cover(bytes.fromhex('ffd8ffe000104a4649460001'), imageformat=MP4Cover.FORMAT_JPEG)]
m.save()
back = MP4(p)
print(json.dumps({'title': back['\\xa9nam'][0], 'artist': back['\\xa9ART'][0], 'track': back['trkn'][0][0], 'covr': len(bytes(back['covr'][0]))}))
`;
  let tagInfo = null, tagErr = null;
  try { tagInfo = JSON.parse(execFileSync('python3', ['-c', tagScript, outPath], { encoding: 'utf8' }).trim()); }
  catch (e) { tagErr = String(e.stderr || e.message).trim().split('\n').slice(-2).join(' '); }
  ok(tagInfo !== null, 'mutagen записал и прочитал теги в собранном файле' + (tagErr ? ': ' + tagErr : ''));
  if (tagInfo) ok(tagInfo.title === 'Real Test Title' && tagInfo.artist === 'Real Artist' && tagInfo.track === 7,
    `значения тегов вернулись: ${JSON.stringify(tagInfo)}`);
}

fs.unlinkSync(outPath);
try { fs.unlinkSync(wavPath); } catch {}
console.log(`\n${fail ? 'ПРОВАЛ' : 'ВСЁ ЗЕЛЁНОЕ'}: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
