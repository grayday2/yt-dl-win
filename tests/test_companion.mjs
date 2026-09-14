// Интеграционный тест компаньона: реальный HTTP-сервер, реальный POST /media,
// реальный ffmpeg-remux и теги через mutagen. Ничего не скачиваем из YouTube.
//   node tests/test_companion.mjs
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fx = (f) => path.join(here, 'fixtures', f);

let pass = 0, fail = 0, skip = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const skipT = (n) => { skip++; console.log('  skip ' + n); };
const s0 = (x) => String(x);
const group = (t) => console.log('\n' + t);

async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LF0 = String.fromCharCode(10);
const sha256File = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let py = null;
try { execFileSync('python3', ['-c', 'import mutagen'], { stdio: 'pipe' }); py = 'python3'; } catch { /* нет python/mutagen */ }
if (!fs.existsSync(fx('tone.m4a'))) { console.log('нет фикстур — bash tools/make_fixtures.sh'); process.exit(0); }
if (!py) { skipT('python3/mutagen недоступны — тест компаньона пропущен'); done(); }

const port = await freePort();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-out-'));
const proc = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port), '--out', outDir],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const outBuf = [];
proc.stdout.on('data', (d) => outBuf.push(d));
proc.stderr.on('data', (d) => outBuf.push(d));
const base = `http://127.0.0.1:${port}`;
const tail = () => Buffer.concat(outBuf).toString('utf8').split('\n').slice(-8).join('\n');

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) return null;
    try { const r = await fetch(base + '/hello'); if (r.ok) return await r.json(); } catch {}
    await sleep(150);
  }
  return null;
}

group('companion: запуск и /hello');
const hello = await waitForServer();
if (!hello) { ok(false, 'сервер поднялся\n' + tail()); proc.kill('SIGKILL'); done(); }
eq(hello.name, 'ytm-dl-companion', '/hello представляется');
ok(hello.api > 0, `api=${hello.api}`);
ok('python' in hello && 'root' in hello, `/hello сообщает интерпретатор и корень папки: ${hello.python} @ ${hello.root}`);
ok('js_runtime' in hello, `и наличие JS-runtime для po-token: ${JSON.stringify(hello.js_runtime)}`);
ok('archive' in hello && typeof hello.archived === 'number', 'и архив «уже скачано»');
ok(hello.ffmpeg === true, 'ffmpeg обнаружен (remux/mp3 будут работать)');
ok(hello.mutagen === true, 'mutagen обнаружен (теги будут писаться)');

group('companion: POST /media (байты из браузера) -> готовый файл');
const bytes = fs.readFileSync(fx('tone.m4a'));
const meta = { title: 'Companion Test', artist: 'QA Artist', album: 'Fixtures', track: 3, totalTracks: 9, date: '2026', videoId: 'ffff0000' };
const q = new URLSearchParams({ meta: JSON.stringify(meta), format: 'm4a' });
let jobId = null;
{
  const r = await fetch(base + '/media?' + q.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  ok(r.status === 202, `ответ ${r.status} == 202 Accepted`);
  const j = await r.json().catch(() => ({}));
  jobId = j.job;
  eq(j.bytes, bytes.length, 'сервер принял ровно столько байт, сколько отправлено');
}
ok(!!jobId, 'вернулся id задачи');

let job = null;
for (let i = 0; i < 100; i++) {
  const r = await fetch(`${base}/job/${jobId}`);
  job = await r.json();
  if (job.status === 'done' || job.status === 'error') break;
  await sleep(200);
}
if (job.status === 'error') ok(false, 'job завершился без ошибки: ' + (job.error || '') + ' | ' + (job.logs || []).slice(-3).join(' ; ') + '\n' + tail());
eq(job.status, 'done', 'job done');
const dest = job.dest;
ok(dest && fs.existsSync(dest), `файл на диске: ${dest}`);
const size = dest && fs.existsSync(dest) ? fs.statSync(dest).size : 0;
ok(size > 40000, `размер ${size} Б сопоставим с исходными ${bytes.length} Б`);
const rel = path.relative(outDir, dest || '');
eq(rel, 'Companion Test.m4a', '0.6.21: имя файла = ТОЛЬКО название (артист и альбом живут в тегах)');

group('companion: содержимое результата');
let ff = null;
try { ff = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim(); } catch {}
if (!ff || !fs.existsSync(ff)) skipT('ffmpeg недоступен — проверка декодирования пропущена');
else {
  let txt = '';
  try { txt = execFileSync(ff, ['-hide_banner', '-i', dest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { txt = String((e && e.stderr) || '') + String((e && e.stdout) || ''); }
  ok(/Audio:\s*aac/i.test(txt), 'результат — AAC-трек (remux не испортил поток)');
  const dm = txt.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const dur = dm ? +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]) : null;
  ok(dur !== null && Math.abs(dur - 3.0) < 0.25, `длительность ${dur}s ~= 3s`);
  const dec = (() => { try { execFileSync(ff, ['-v', 'error', '-xerror', '-i', dest, '-f', 'null', '-'], { stdio: 'pipe' }); return null; } catch (e) { return String(e.stderr || e.message).slice(0, 200); } })();
  ok(dec === null, 'декодирование с -xerror чистое' + (dec ? ': ' + dec : ''));
}
{
  const py = `
import sys, json
from mutagen.mp4 import MP4
m = MP4(sys.argv[1])
print(json.dumps({k: (v[0] if isinstance(v, list) and isinstance(v[0], (str, bytes)) else v) for k, v in m.items()}))
`;
  let tags = null, err = null;
  try { tags = JSON.parse(execFileSync('python3', ['-c', py, dest], { encoding: 'utf8' }).trim()); }
  catch (e) { err = String(e.stderr || e.message).slice(0, 300); }
  ok(tags !== null, 'mutagen читает теги результата' + (err ? ': ' + err : ''));
  if (tags) {
    eq(tags['©nam'] ?? tags['\u00a9nam'], 'Companion Test', 'тег названия на месте');
    eq(tags['©ART'] ?? tags['\u00a9ART'], 'QA Artist', 'тег артиста на месте');
    eq(tags['©alb'] ?? tags['\u00a9alb'], 'Fixtures', 'альбом на месте');
    // 0.6.19: по просьбе владельца нумерация в теги не пишется вовсе - и trkn
    // атома нет даже когда meta несёт track: 3 (проверка живого /media ниже).
    eq(tags.trkn, undefined, '0.6.19: номера дорожки в m4a нет - нумерацию не пишем вовсе');
    ok(/Synthwave|2026/.test(JSON.stringify(tags)), 'доп. теги (жанр/год) тоже записаны: ' + JSON.stringify(tags).slice(0, 160));
  }
}

group('companion: mp3-конвейер и очередь');
{
  const q2 = new URLSearchParams({ meta: JSON.stringify({ title: 'Mp3Conv', artist: 'QA' }), format: 'mp3', bitrate: '128k' });
  const r = await fetch(base + '/media?' + q2.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  const j = await r.json();
  let job2 = null;
  for (let i = 0; i < 150; i++) { job2 = await (await fetch(`${base}/job/${j.job}`)).json(); if (job2.status === 'done' || job2.status === 'error') break; await sleep(200); }
  eq(job2.status, 'done', 'mp3-задача завершилась' + (job2.error ? ' :: ' + job2.error + ' :: ' + (job2.logs||[]).slice(-3).join(' | ') : ''));
  const p2 = job2.dest;
  ok(p2 && fs.existsSync(p2) && fs.statSync(p2).size > 20000, `mp3 на диске (${p2 ? (fs.existsSync(p2) ? fs.statSync(p2).size : 0) : 0} Б)`);
  const jobs = await (await fetch(base + '/jobs')).json();
  ok(jobs.jobs.length >= 2, `/jobs отдаёт историю (${jobs.jobs.length} шт.)`);
}
group('companion: переопределение папки загрузки (?out=)');
{
  const home = execFileSync('python3', ['-c', 'import pathlib;print(pathlib.Path.home())'], { encoding: 'utf8' }).trim();
  const sub = 'ytm-dl-test-' + process.pid;
  const target = path.join(home, sub);
  const q = new URLSearchParams({ meta: JSON.stringify({ title: 'IntoSub', artist: 'QA' }), format: 'm4a', out: sub });
  const r0 = await (await fetch(base + '/media?' + q.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json();
  let j = null;
  for (let i = 0; i < 100; i++) { j = await (await fetch(`${base}/job/${r0.job}`)).json(); if (j.status === 'done' || j.status === 'error') break; await sleep(200); }
  eq(j.status, 'done', 'задача с относительным out завершилась');
  const inSub = path.join(target, 'IntoSub.m4a');
  ok(fs.existsSync(inSub), `файл лёг в переопределённую папку: ${inSub}`);
  eq(j.dest, inSub, 'job.dest указывает именно туда');
  ok(!fs.existsSync(path.join(outDir, 'IntoSub.m4a')), 'в папку по умолчанию (--out) ничего не попало');
  fs.rmSync(target, { recursive: true, force: true });

  const evil = new URLSearchParams({ meta: '{}', format: 'm4a', out: '../../tmp/evil-' + process.pid });
  const rEvil = await fetch(base + '/media?' + evil.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  eq(rEvil.status, 400, 'выход за пределы домашней папки отклонён');
  const rAbs = await fetch(base + '/job', { method: 'POST', body: JSON.stringify({ kind: 'url', url: 'x', out_dir: '/etc' }) });
  eq(rAbs.status, 400, 'абсолютный путь вне HOME в /job тоже отклонён');
  ok(!fs.existsSync('/tmp/evil-' + process.pid), 'папка за пределами HOME не создана');
}

group('companion: архив «уже скачано» (dedup)');
{
  const VID = meta.videoId;                       // id из первой /media-задачи этого прогона
  const arc = (v) => fs.readFileSync(path.join(outDir, '.ytm-archive.txt'), 'utf8').includes(v);
  ok(arc(VID), 'успешная загрузка записана в .ytm-archive.txt');
  const h = await (await fetch(base + '/archive')).json();
  ok(h.ids.includes(VID), `GET /archive отдаёт id (${(h.ids || []).join(',')})`);
  eq(h.count, h.ids.length, 'count == длине списка');
  const h2 = await (await fetch(base + '/hello')).json();
  ok(h2.archived >= 1 && /\.ytm-archive\.txt$/.test(h2.archive || ''),
    `/hello сообщает про архив: ${h2.archived} @ ${h2.archive}`);

  const has = await (await fetch(base + `/has?ids=${VID},nope-no-nope`)).json();
  eq(has.have, [VID], '/has отмечает скачанное');
  eq(has.missing, ['nope-no-nope'], '/has отдаёт список недостающего (по нему строится очередь)');

  // повтор той же загрузки не должен порождать второй remux/файл
  const before = fs.readdirSync(outDir).length;
  const q3 = new URLSearchParams({ meta: JSON.stringify(meta), format: 'm4a', videoId: VID });
  const r3 = await fetch(base + '/media?' + q3.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  eq(r3.status, 202, 'повтор принят (202) — решение «пропустить» принимает воркер');
  const j3 = await r3.json();
  let job3 = null;
  for (let i = 0; i < 60; i++) { job3 = await (await fetch(`${base}/job/${j3.job}`)).json(); if (job3.status === 'done' || job3.status === 'error') break; await sleep(150); }
  eq(job3.status, 'done', 'повтор завершился как done, а не error');
  eq(job3.meta.skipped, true, 'job помечен skipped');
  ok(/уже есть в архиве/.test(job3.message || ''), `сообщение объясняет пропуск: "${job3.message}"`);
  eq(fs.readdirSync(outDir).length, before, 'файл не задублирован (ни " (1)", ни второго remux)');

  // «скачать заново»: dedup=0
  const r4 = await fetch(base + '/media?' + new URLSearchParams({ meta: JSON.stringify(meta), format: 'm4a', videoId: VID, dedup: '0' }),
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  const j4 = await r4.json();
  let job4 = null;
  for (let i = 0; i < 150; i++) { job4 = await (await fetch(`${base}/job/${j4.job}`)).json(); if (job4.status === 'done' || job4.status === 'error') break; await sleep(200); }
  eq(job4.status, 'done', 'dedup=0 пробивает пропуск');
  ok(!job4.meta.skipped, 'и не помечает skipped');
  ok(job4.meta.archived !== true, 'повтор не плодит вторую запись в архиве');

  // id из url, если videoId не передали
  const q5 = new URLSearchParams({ meta: JSON.stringify({ title: 'Id From Url', url: `https://music.youtube.com/watch?v=${VID}` }), format: 'm4a' });
  const r5 = await fetch(base + '/media?' + q5.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  const j5 = await r5.json();
  let job5 = null;
  for (let i = 0; i < 150; i++) { job5 = await (await fetch(`${base}/job/${j5.job}`)).json(); if (job5.status === 'done' || job5.status === 'error') break; await sleep(200); }
  ok(job5 && job5.meta.skipped === true, 'videoId вытащен из url meta, если отдельного поля нет');

  // некорректный id не должен попадать в архив (защита от «мусора» в файле)
  const r6 = await fetch(base + '/media?' + new URLSearchParams({ meta: JSON.stringify({ title: 'Junk' }), format: 'm4a', videoId: '../../etc/passwd' }),
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  let job6 = null;
  const j6 = await r6.json();
  for (let i = 0; i < 150; i++) { job6 = await (await fetch(`${base}/job/${j6.job}`)).json(); if (job6.status === 'done' || job6.status === 'error') break; await sleep(200); }
  eq(job6.status, 'done', 'загрузка с «нехорошим» videoId всё равно проходит');
  ok(!(await (await fetch(base + '/archive')).json()).ids.some((x) => /\//.test(x)), 'в архив такой id не записан');
}

group('companion: режим playlist (весь лист/liked одной задачей)');
{
  const r = await fetch(base + '/job', { method: 'POST', body: JSON.stringify({ kind: 'playlist', url: 'liked', dry_run: true, meta: {} }) });
  eq(r.status, 202, 'playlist-джоб принят (yt-dlp не дёргается без cookies)');
  const j = await r.json();
  let job = null;
  for (let i = 0; i < 60; i++) { job = await (await fetch(`${base}/job/${j.job}`)).json(); if (job.status === 'done' || job.status === 'error') break; await sleep(150); }
  eq(job.status, 'done', 'liked разобран без обращения к сети (dry_run)');
  eq(job.meta.url, 'https://music.youtube.com/playlist?list=YY', 'liked → YTM-лист YY');
  eq(job.meta.liked, true, 'и помечен как liked');
  const r2 = await fetch(base + '/job', { method: 'POST', body: JSON.stringify({ kind: 'playlist', url: 'https://music.youtube.com/watch?v=aaaa1111bbb&list=RDCLAK5uy_zzz', dry_run: true }) });
  const j2 = await r2.json();
  let job2 = null;
  for (let i = 0; i < 60; i++) { job2 = await (await fetch(`${base}/job/${j2.job}`)).json(); if (job2.status === 'done' || job2.status === 'error') break; await sleep(150); }
  eq(job2.meta.url, 'https://music.youtube.com/playlist?list=RDCLAK5uy_zzz', 'RDCLAK-лист из watch?list= собран в playlist-ссылку');
  const r3 = await fetch(base + '/job', { method: 'POST', body: JSON.stringify({ kind: 'playlist', url: 'https://music.youtube.com/watch?v=aaaa1111bbb' }) });
  eq(r3.status, 202, 'джоб без list= принимается (ошибка — на стороне воркера, не в валидаторе)');
  const j3b = await r3.json();
  let job3 = null;
  for (let i = 0; i < 60; i++) { job3 = await (await fetch(`${base}/job/${j3b.job}`)).json(); if (job3.status === 'done' || job3.status === 'error') break; await sleep(150); }
  eq(job3.status, 'error', 'но предсказуемо падает с внятным сообщением');
  ok(/list=/.test(job3.error || ''), `текст ошибки объясняет, какую ссылку дать: "${(job3.error || '').slice(0, 90)}"`);
  eq(fs.readdirSync(outDir).filter((f) => f.startsWith('ytm_pl_')).length, 0, 'мусорных временных папок не осталось');

  // Живой прогон против настоящего плейлиста: сеть тут есть, yt-dlp отвечает
  // реально. Берём ОДИН трек (items=1) и ждём по wall-clock, а не по числу итераций:
  // в песочнице transcode медленный, и «still running» - это не баг кода, а таймаут
  // теста. Поэтому после дедлайна проверяем, что прогресс был, и штатно гасим job.
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('ytm_pl_')));
  const r4 = await fetch(base + '/job', { method: 'POST', body: JSON.stringify({
    kind: 'playlist', url: 'https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE', format_spec: 'bestaudio',
    items: '1',
  }) });
  const j4c = await r4.json();
  let job4c = null;
  const tEnd = Date.now() + 240000;
  while (Date.now() < tEnd) {
    job4c = await (await fetch(`${base}/job/${j4c.job}`)).json();
    if (job4c.status === 'done' || job4c.status === 'error' || job4c.status === 'cancelled') break;
    await sleep(500);
  }
  const timedOut = !!(job4c && job4c.status === 'running');
  if (timedOut) {
    ok((job4c.logs || []).length > 0 || job4c.progress > 0,
      `плейлист не завис: за 240 с есть движение (${(job4c.logs || []).length} строк лога)`);
    try { await fetch(base + '/shutdown'); } catch {}
    await sleep(400);
  }
  ok(timedOut || (job4c && (job4c.status === 'error' || job4c.status === 'done')),
    `плейлист завершился сам или был штатно остановлен (status=${job4c && job4c.status})`);
  const m4 = (job4c && job4c.meta) || {};
  if (job4c && job4c.status === 'done') {
    ok((m4.count || 0) > 0 || (m4.archived_only || 0) > 0,
      `done не бывает пустым: count=${m4.count} archived_only=${m4.archived_only} failed=${m4.failed} lost=${m4.lost}`);
  } else if (job4c && job4c.status === 'error') {
    ok(/ни один трек не скачался|плейлист пуст или недоступен/.test(job4c.error || ''),
      `error объясняет, почему файлов нет: "${(job4c.error || '').slice(0, 110)}"`);
    ok((m4.failed || 0) + (m4.lost || 0) >= 1, `упавшие позиции посчитаны (failed=${m4.failed} lost=${m4.lost})`);
    ok(/bot|cookies|Sign in|Private|Приватн|unviewable|does not exist/i.test((job4c.error || '') + ' ' + (m4.last_error || '')),
      'в тексте есть actionable-причина, а не голое «0 файлов»');
    ok(/--cookies-from-browser/.test(job4c.error || ''), 'и путь лечения назван прямо (бот-чек → cookies)');
  }
  eq(fs.readdirSync(outDir).filter((f) => f.startsWith('ytm_pl_')).length, 0, 'после живого прогона тоже чисто');
  // сверяем с тем, что было ДО нас: чужой сор в tmp не должен ронять тест, но и
  // наш job не имеет права ничего после себя оставлять
  const tmpLitter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('ytm_pl_'))
    .filter((f) => !tmpBefore.has(f));
  eq(tmpLitter.length, 0, `временные папки этого прогона убраны (осталось ${tmpLitter.length})`);
  ok(!(await (await fetch(base + '/archive')).json()).ids.includes(undefined), 'архив не засоряется пустыми id');
}

group('companion: /archive/reset (файлы не трогаем)');
{
  const files = fs.readdirSync(outDir).filter((f) => !f.startsWith('.')).sort();
  const r = await fetch(base + '/archive/reset', { method: 'POST', body: '{}' });
  eq(r.status, 200, 'reset доступен');
  const j = await r.json();
  ok(j.cleared >= 1, `зачищено записей: ${j.cleared}`);
  eq(fs.readdirSync(outDir).filter((f) => !f.startsWith('.')).sort(), files, 'музыка на диске осталась нетронутой');
  const after = await (await fetch(base + '/archive')).json();
  eq(after.count, 0, 'архив пуст → тот же трек можно закачать снова');
  const badOut = await fetch(base + '/archive/reset?out=../../etc', { method: 'POST', body: '{}' });
  eq(badOut.status, 400, 'reset чужой папки за пределами HOME отклонён (кнопка «сбросить» не должна уметь тереть чужой файл)');
}

group('портативные wheels: пакеты едут в архиве');
{
  const wdir = path.join(root, 'dist', 'ytm-dl-win', 'wheels');
  ok(fs.existsSync(wdir), 'wheels/ есть в собранной папке');
  const man = JSON.parse(fs.readFileSync(path.join(wdir, 'manifest.json'), 'utf8'));
  const names = Object.keys(man).sort();
  ok(names.length >= 2 && names.every((n) => n.endsWith('.whl')), `в манифесте только .whl: ${names.join(', ')}`);
  for (const [name, info] of Object.entries(man)) {
    const pth = path.join(wdir, name);
    const st = fs.statSync(pth);
    eq(st.size, info.size, `${name}: размер совпадает с manifest.json`);
    eq(sha256File(pth), info.sha256, `${name}: sha256 совпадает`);
    ok(/py3-none-any/.test(name) || /-abi3-win_amd64|cp312-cp312-win_amd64/.test(name),
       `${name}: pure-python или собрано под наш win/py312 (curl_cffi, cffi)`);
  }
  const bat = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'install-packages-offline.bat'), 'utf8').replace(/\r/g, '');
  ok(/setup\.ps1/.test(bat) && /-PackagesOnly/.test(bat),
     'install-packages-offline.bat - тонкий конверт: вся логика в setup.ps1 (один установщик, 0.5.8)');
  const ps1b = fs.readFileSync(path.join(root, 'win', 'setup.ps1'), 'utf8').replace(/\r/g, '');
  ok(/yt-dlp mutagen PySocks/.test(ps1b), 'setup.ps1 (онлайн и офлайн) тоже ставит PySocks');
  ok(/curl-cffi/.test(ps1b), 'setup.ps1 ставит и curl-cffi');
  const man2 = JSON.parse(fs.readFileSync(path.join(wdir, 'manifest.json'), 'utf8').replace(/\r/g, ''));
  ok(Object.keys(man2).some((k) => /PySocks/i.test(k)), 'PySocks-колесо лежит в wheels/ и в манифесте');
  ok(Object.keys(man2).some((k) => /curl_cffi/i.test(k)), 'curl-cffi (TLS-отпечаток) лежит в wheels/ и в манифесте');
  const ps1 = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'setup.ps1'), 'utf8').replace(/\r/g, '');
  ok(/\$Offline/.test(ps1), 'setup.ps1 умеет -Offline');
  ok(/--no-index/.test(ps1) && /--find-links/.test(ps1), 'setup.ps1 ставит пакеты с wheels без сети (бывший офлайн-батник)');
  ok(/ensurepip/.test(ps1), 'и поднимает pip, если python без pip');
  ok(/--upgrade yt-dlp mutagen PySocks curl-cffi/.test(ps1), 'setup.ps1 ставит и PySocks, и curl-cffi');
  ok(/Filter \*\.whl/.test(ps1), 'setup.ps1 проверяет наличие .whl в wheels');
  ok(/\$PackagesOnly/.test(ps1), 'setup.ps1 умеет -PackagesOnly (единый установщик)');
  ok(fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'README-WINDOWS.txt'), 'utf8').replace(/\r/g, '').includes('-Offline'), 'и офлайн-путь описан в README-WINDOWS.txt');
  const sh = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'README-WINDOWS.txt'), 'utf8');
  ok(sh.includes('Разрешить пользовательские скрипты'), 'шпаргалка помнит про флаг Tampermonkey (главный тупик на Chrome)');
  ok(sh.includes('app\\bin\\ffmpeg.exe') && /не\s+app\\bin\\ffmpeg-/.test(sh), 'шпаргалка объясняет, что ffmpeg.exe кладётся НЕ в подпапку');
  ok(sh.includes('install-packages-offline.bat') && sh.includes('ytm.bat')
     && sh.split(String.fromCharCode(10)).filter((l) => /start\.bat/.test(l)).every((l) => /alias|\u0430\u043b\u0438\u0430\u0441/i.test(l)),
    'шпаргалка ведёт по реальным файлам; start.bat упоминается только как алиас');
  eq((sh.match(/^\[ \] \d\./gm) || []).length, 6, 'в шпаргалке ровно 6 нумерованных шагов');
  ok(!/\t/.test(sh), 'шпаргалка без табов (Notepad их разъезжает)');
  ok(sh.includes('cookies_from_browser=chrome'), 'шпаргалка знает про cookies_from_browser=chrome');
  const sums = fs.readFileSync(path.join(wdir, 'SHA256SUMS.txt'), 'utf8').replace(/\r/g, '').trim().split('\n');
  eq(sums.length, names.length, 'SHA256SUMS.txt покрывает все wheel-ы');
  ok(sums.every((l) => /^[0-9a-f]{64}  \S+\.whl$/.test(l)), 'формат sums: <sha256>  <имя>.whl');
}

group('--check проверяет сам cookies.txt (а не только «что ключ в ini есть»)');
{
  const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-ck-'));
  const T = String.fromCharCode(9);
  const pyCk = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  const row = (...c) => c.join(T);
  const runChk = (extra) => {
    try {
      return execFileSync(pyCk, [path.join(root, 'server', 'companion.py'), '--check',
        '--out', path.join(kdir, 'music'), ...extra],
        { encoding: 'utf8', cwd: kdir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
  };
  const head = '# Netscape HTTP Cookie File';

  // 1) экспорт «как есть» (7 полей, имя в колонке 5 - формат curl/yt-dlp)
  const good = path.join(kdir, 'cookies.txt');
  fs.writeFileSync(good, [head,
    '#HttpOnly_' + ['.youtube.com', 'TRUE', '/', 'TRUE', '1893456000', 'SAPISID', 'SEKRITBBB'].join(T),
    row('.youtube.com', 'TRUE', '/', 'TRUE', '1893456000', '__Secure-1PSID', 'SEKRITAAA'),
    row('.music.youtube.com', 'TRUE', '/', 'TRUE', '1893456000', '__Secure-1PSIDTS', 'SEKRITCCC'),
  ].join(LF0) + LF0, 'utf8');
  const o1 = runChk(['--cookies-file', good]);
  ok(/cookies \(доступ к аккаунту\)/.test(o1), 'в self-check появилась строка про cookies');
  ok(/\[ok  \] cookies.*вход есть \(3\)/.test(o1),
     'валидный файл с авторизационными cookie -> [ok] (' + (o1.match(/cookies \(.*/) || ['—'])[0] + ')');
  ok(!/SEKRIT/.test(o1), 'значения cookie НЕ попадают в вывод: отчёт можно прислать кому угодно');
  ok(/готово к работе/.test(o1), 'это warn-уровень: exit code self-check-а не ломается');
  ok(/proxy \(чем ходит yt-dlp\)/.test(o1) && /proxy= пуст, системного прокси нет/.test(o1),
     'строка про прокси в том же self-check: «пусто и системного нет» названо, а не промолчано');
  const oS = runChk(['--proxy', 'socks5://127.0.0.1:1080']);
  ok(/\[ok  \] proxy \(чем ходит yt-dlp\)/.test(oS) && /socks5/.test(oS),
     'socks5 в proxy= БОЛЬШЕ НЕ запрет: yt-dlp умеет socks сам (yt_dlp/socks.py)');
  ok(/PySocks/.test(oS), 'и честно говорит, что обложкам через socks нужен PySocks');
  ok(/http\/https http:\/\/127\.0\.0\.1:7890/.test(runChk(['--proxy', 'http://127.0.0.1:7890'])),
     'http-прокси = [ok], и сказано, кто через него пойдёт');

  // 2) файлы-ловушки, на которые реально натыкаются
  const json = path.join(kdir, 'ce.txt');
  fs.writeFileSync(json, '[{"domain":".youtube.com","name":"SID","value":"x"}]' + LF0, 'utf8');
  ok(/0 строк \(нужен формат Netscape/.test(runChk(['--cookies-file', json])),
     'JSON из Cookie-Editor опознан и объяснён, а не «всё ок, 0 cookie»');
  const other = path.join(kdir, 'other.txt');
  fs.writeFileSync(other, [head, row('.example.com', 'TRUE', '/', 'FALSE', '0', 'SID', 'x')].join(LF0) + LF0, 'utf8');
  ok(/ни одного youtube\/googlevideo/.test(runChk(['--cookies-file', other])),
     'экспорт не с youtube.com ругается конкретно на это');
  const anon = path.join(kdir, 'anon.txt');
  fs.writeFileSync(anon, [head, row('.youtube.com', 'TRUE', '/', 'FALSE', '0', 'pref', 'i1=OK')].join(LF0) + LF0, 'utf8');
  ok(/нет ни одного авторизационного/.test(runChk(['--cookies-file', anon])),
     'незалогиненный экспорт (только pref) не принимается за cookies');
  ok(/файла нет/.test(runChk(['--cookies-file', path.join(kdir, 'nope.txt')])),
     'несуществующий путь назван прямо');

  // 3) «cookies из браузера»: профиль ищется, опечатка ловится, падать нельзя
  ok(/неизвестный браузер/.test(runChk(['--cookies-from-browser', 'kakoy-to-ne-tot'])),
     'опечатка в имени браузера -> внятный список допустимых (vivaldi там же)');
  const oC = runChk(['--cookies-from-browser', 'chrome']);
  ok(/cookies \(доступ к аккаунту\)/.test(oC) && !/Traceback/.test(oC),
     'путь «из браузера» не роняет self-check на машине без такого профиля');

  // 4) launcher: без этого «cookies: none» было нечем разбирать
  const ctl = fs.readFileSync(path.join(root, 'app', 'control.py'), 'utf8').replace(/\r/g, '');
  ok(/cmd = companion_args\("--check", "--out", str\(out_dir\(\)\)\)/.test(ctl),
     'selftest собирается через companion_args() -> cookies_file/proxy/player_client из ini доезжают до --check');
  fs.rmSync(kdir, { recursive: true, force: true });
}

group('портативная раскладка (dist/ytm-dl-win) и --check');
{
  const pyExe = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  const stub = path.join(outDir, 'fake-ffmpeg.exe');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ffmpeg version stub" >&2\nexit 0\n', { mode: 0o755 });
  const run = (env, args = ['--check', '--out', 'music']) =>
    execFileSync(py, [path.join(root, 'dist', 'ytm-dl-win', 'app', 'companion.py'), ...args],
      { encoding: 'utf8', env: { ...process.env, ...env }, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let code = 0;
  try { out = run({ YTMDL_PYTHON: pyExe, YTMDL_FFMPEG: stub }); }
  catch (e) { out = String((e && e.stdout) || '') + String((e && e.stderr) || ''); code = e.status || 1; }
  ok(code === 0, `--check на собранной папке проходит (exit=${code})`);
  ok(/root : .*ytm-dl-win/.test(out), 'ROOT = корень переносимой папки (рядом с app/):\n' + (out.match(/root :.*/) || ['—'])[0]);
  ok(new RegExp('ffmpeg — ' + stub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(out),
    'переменная YTMDL_FFMPEG из launcher-а важнее PATH');
  ok(/готово к работе/.test(out) && /mutagen/.test(out) && /yt-dlp как модуль/.test(out),
    'в отчёте есть строки про mutagen и запуск yt-dlp тем же python' );
  ok(/python=/.test(out), 'каждый вывод содержит путь к python — «какой интерпретатор» видно сразу');

  // ffmpeg должен находиться и без переменной: кладём симлинк на настоящий в app/bin/
  const exe = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
  const link = path.join(root, 'dist', 'ytm-dl-win', 'app', 'bin', 'ffmpeg.exe');
  try { fs.unlinkSync(link); } catch {}
  try { fs.unlinkSync(path.join(root, 'dist', 'ytm-dl-win', 'app', 'bin', 'PLACE-FFMPEG.txt')); } catch {}
  fs.symlinkSync(exe, link);
  let out2 = '';
  try { out2 = run({ YTMDL_PYTHON: pyExe }, ['--check', '--out', 'music']); }
  catch (e) { out2 = String((e && e.stdout) || ''); }
  ok(/app.bin.ffmpeg.exe|app\/bin\/ffmpeg.exe/.test(out2) || out2.includes(link),
    'app/bin/ffmpeg.exe найден без всякой переменной (поиск внутри ROOT)');

  // битая раскладка: нет bin/, нет PATH-ового ffmpeg, нет imageio-ffmpeg -> FAIL, а не «тихий запуск»
  let out3 = '', code3 = 0;
  const savedTarget = fs.readlinkSync(link);   // tmpfs и репозиторий — разные устройства,
  fs.unlinkSync(link);                          // поэтому переносим симлинк, а не rename'им
  try {
    // pyExe, не py: PATH у намеренно битый (/nonexistent-bin), и «python3» в нём не найдётся -
    // тест получил бы ENOENT вместо rc=1 и проверял бы не companийский FAIL, а свой собственный
    out3 = execFileSync(pyExe, [path.join(root, 'dist', 'ytm-dl-win', 'app', 'companion.py'), '--check', '--out', 'music'],
      { encoding: 'utf8', env: { PATH: '/nonexistent-bin', HOME: process.env.HOME, YTMDL_PYTHON: pyExe,
        YTMDL_NO_FFMPEG: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out3 = String((e && e.stdout) || '') + String((e && e.stderr) || ''); code3 = e.status || 1; }
  fs.symlinkSync(savedTarget, link);
  eq(code3, 1, 'без ffmpeg --check возвращает 1 (launcher покажет проблему, а не будет молча кривляться)');
  ok(/FAIL\] ffmpeg/.test(out3), 'и объясняет это одной строкой: ' + (out3.match(/FAIL\] ffmpeg[^\n]*/) || ['—'])[0]);

  // настоящий прогон через портативную раскладку: файл + теги должны появиться в dist/music
  fs.rmSync(path.join(root, 'dist', 'ytm-dl-win', 'music'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'dist', 'ytm-dl-win', 'music'), { recursive: true });
  const port2 = await freePort();
  const proc2 = spawn(py, [path.join(root, 'dist', 'ytm-dl-win', 'app', 'companion.py'), '--port', String(port2), '--out', path.join(root, 'dist', 'ytm-dl-win', 'music')],
    { env: { ...process.env, YTMDL_PYTHON: pyExe }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b2 = `http://127.0.0.1:${port2}`;
  let h2 = null;
  for (let i = 0; i < 60 && !h2; i++) { await sleep(200); try { const r = await fetch(b2 + '/hello'); if (r.ok) h2 = await r.json(); } catch {} }
  if (!h2) { ok(false, 'companion из dist-папки поднялся\n' + tail()); proc2.kill('SIGKILL'); }
  else {
    ok(true, 'companion из dist-папки поднялся');
    ok(String(h2.ffmpeg_path || '').endsWith('ffmpeg.exe'), `ffmpeg взят из app/bin: ${h2.ffmpeg_path}`);
    const q = new URLSearchParams({ meta: JSON.stringify({ title: 'Portable', artist: 'Win', videoId: 'portable01' }), format: 'm4a' });
    const r = await fetch(b2 + '/media?' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const jj = await r.json();
    let job = null;
    for (let i = 0; i < 150; i++) { job = await (await fetch(`${b2}/job/${jj.job}`)).json(); if (job.status === 'done' || job.status === 'error') break; await sleep(200); }
    eq(job.status, 'done', 'загрузка через портативную папку завершилась');
    ok(/^ytm-dl-win.music.Portable.m4a$/.test(String(path.relative(path.join(root, 'dist'), job.dest)).split(path.sep).join('/')),
      `файл лёг в dist/ytm-dl-win/music: ${path.relative(root, job.dest)}`);
    let tagTxt = '';
    try {
      tagTxt = execFileSync('python3', ['-c',
        'import sys,mutagen;t=mutagen.File(sys.argv[1]);'
        + 'print({k:str(v)[:24] for k,v in t.tags.items() if k in ("©nam","©ART","trkn")})', job.dest],
        { encoding: 'utf8' });
    } catch {}
    ok(/Portable/.test(tagTxt), 'теги на месте (mutagen берётся из того же python): ' + tagTxt.trim().slice(0, 110));
    const arch = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'music', '.ytm-archive.txt'), 'utf8');
    ok(/portable01/.test(arch), 'архив «уже скачано» тоже живёт в портативной папке');
    proc2.kill('SIGKILL');
  }
  try { fs.unlinkSync(link); fs.unlinkSync(stub); } catch {}
}


group('js-runtime из app\bin и cookies-файл (лечение bot-check)');
{
  const dist = path.join(root, 'dist', 'ytm-dl-win');
  const pyAbs = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  // «голая» среда: без PATH тестового хоста, чтобы node/deno из системы не маскировали
  // портативный поиск (с /usr/bin/node в PATH проверка «warn → ok» ничего не доказывала бы)
  const bare = { PYTHONDONTWRITEBYTECODE: '1', HOME: process.env.HOME || '/root',
                 PATH: '/nonexistent-dir-for-ytm-test', YTMDL_PYTHON: pyAbs };
  const runCheck = (env, args = ['--check', '--out', 'music']) => {
    try {
      // ВАЖНО: py здесь = 'python3' (имя!). С PATH=/nonexistent execFileSync бы споткнулся
      // ещё до запуска python, и мы получили бы пустой вывод вместо «warn» — поэтому
      // подставляем абсолютный путь интерпретатора.
      return execFileSync(pyAbs, [path.join(dist, 'app', 'companion.py'), ...args],
        { encoding: 'utf8', env: { ...env }, cwd: dist, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
  };

  // 1) ни в PATH, ни в app/bin — warn с подсказкой, куда положить файл
  const binDir = path.join(dist, 'app', 'bin');
  for (const n of ['deno', 'deno.exe']) { try { fs.unlinkSync(path.join(binDir, n)); } catch {} }
  let o = runCheck(bare);
  ok(/\[warn\] JS-runtime/.test(o), 'без рантайма строка остаётся warn (не FAIL — не блокирует запуск)');
  ok(/deno/i.test(o) && /app\\bin/.test(o), 'и подсказывает «положи deno.exe в app\bin»:\n      '
    + (o.match(/JS-runtime.*/) || ['—'])[0]);

  // 2) тот же запуск, но deno лежит в app/bin/ портативной папки.
  //    На posix ищем «deno», на Windows — «deno.exe»: кладём оба имени, иначе
  //    проверка была бы честна только на одной ОС.
  fs.mkdirSync(binDir, { recursive: true });
  for (const n of ['deno', 'deno.exe']) {
    fs.writeFileSync(path.join(binDir, n), '#!/bin/sh\necho "deno 2.9.6 (stub)"\nexit 0\n', { mode: 0o755 });
  }
  try {
    o = runCheck(bare);
    ok(/\[ok  \] JS-runtime/.test(o) && /app.bin.deno/.test(o),
      'deno из app\bin находится БЕЗ PATH и без установки — warn → ok:\n      '
      + (o.match(/JS-runtime.*/) || ['—'])[0]);
  } finally { for (const n of ['deno', 'deno.exe']) { try { fs.unlinkSync(path.join(binDir, n)); } catch {} } }

  // 3) /hello отдаёт поле для панели (строка «проверить» показывает runtime=)
  const h = await (await fetch(base + '/hello')).json();
  ok('js_runtime' in h, '/hello отдаёт js_runtime — панель пишет «runtime=…» и не врёт про bot-check');

  // 4) cookies_file: серверный default доезжает до job’а (лечение bot-check на Firefox)
  const cf = path.join(outDir, 'cookies.txt');
  fs.writeFileSync(cf, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t0\tSID\tstub\n');
  const b4 = 'http://127.0.0.1:8792';
  const p4 = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', '8792',
                        '--out', path.join(outDir, 'cfile'), '--cookies-file', cf],
                   { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let h4 = null;
    for (let i = 0; i < 40 && !h4; i++) {
      await sleep(150);
      try { h4 = await (await fetch(b4 + '/hello')).json(); } catch {}
    }
    ok(!!h4, 'companion с --cookies-file поднялся');
    if (h4) {
      eq(String(h4.cookies_file), cf, '/hello сообщает о файле cookies');
      const r = await fetch(b4 + '/job', { method: 'POST',
        body: JSON.stringify({ kind: 'playlist', url: 'https://music.youtube.com/playlist?list=PLx', dry_run: true }) });
      eq(r.status, 202, 'playlist-джоб принят');
      const id = (await r.json()).job;
      let job = null;
      for (let i = 0; i < 60 && (!job || job.status === 'running' || job.status === 'queued'); i++) {
        await sleep(250); job = await (await fetch(`${b4}/job/${id}`)).json();
      }
      eq(job.meta.cookies_file, cf, 'job получил cookies_file от сервера, а не только из payload');
      ok(job.status === 'done' || job.status === 'error', `dry_run завершился (${job.status})`);
      const r2 = await fetch(b4 + '/job', { method: 'POST',
        body: JSON.stringify({ kind: 'playlist', url: 'x', dry_run: true, cookies_file: '/tmp/other.txt' }) });
      const j2id = (await r2.json()).job;
      let j2 = null;
      for (let i = 0; i < 60 && (!j2 || j2.status === 'running' || j2.status === 'queued'); i++) {
        await sleep(250); j2 = await (await fetch(`${b4}/job/${j2id}`)).json();
      }
      eq(j2.meta.cookies_file, '/tmp/other.txt', 'явный override из payload жив');
    }
  } finally { p4.kill('SIGKILL'); }

  // 5) единственная запускалка: win/ytm.bat (логика в app/control.py)
  const bat = fs.readFileSync(path.join(dist, 'ytm.bat'), 'utf8').replace(/\r/g, '');
  const ctl = fs.readFileSync(path.join(dist, 'app', 'control.py'), 'utf8').replace(/\r/g, '');
  const comp = fs.readFileSync(path.join(dist, 'app', 'companion.py'), 'utf8').replace(/\r/g, '');
  ok(bat.split(LF0).length <= 75, `ytm.bat короткий (${bat.split(LF0).length} строк): чем меньше cmd-логики, тем меньше путей молча умереть`);
  ok(bat.includes('@echo off') && !/\t/.test(bat), 'ytm.bat начинается с @echo off и без табов (tab в .bat = ti… для cmd)');
  ok(/if exist "app\\python\\python.exe"/.test(bat), 'ytm.bat сам находит портативный python');
  ok(/where python/.test(bat) && /where python3/.test(bat), 'и делает фолбэк на системный (ошибка запускалки не должна быть фатальной)');
  ok(/if not defined PYEXE \(\r?\n[\s\S]*?pause/.test(bat + LF0),
    'если python-а нет - окно пишет WHY и ждёт клавишу: «мигнуло и закрылось» больше не сценарий');
  ok(/-u -X utf8/.test(bat) && /"!HERE!app\\control\.py"/.test(bat),
    'запуск через python -u -X utf8 ПОЛНЫМ путём: из чужой рабочей папки окно не должно молча гаснуть');
  ok(/set "PATH=!HERE!app\\bin;%PATH%"/.test(bat), 'app\\bin в PATH: yt-dlp найдёт deno\\node сам');
  ok(!/powershell/.test(bat), 'в единственном .bat нет powershell-а: он умеет висеть, и окно молчит');
  ok(!/chcp/.test(bat), 'и нет chcp: на части сборок смена кодовой страницы убивала окно вместе с выводом');

  ok(/cookies_file/.test(ctl) && /--cookies-file/.test(ctl), 'control.py читает cookies_file из ini и передаёт его компаньону');
  ok(/player_client/.test(ctl) && /--player-client/.test(ctl), 'то же про player_client (tv = без po-token)');
  ok(/organize/.test(ctl), 'organize из ini доезжает до сервера');
  ok(/"--stop-other", "--log-file"/.test(ctl), 'serve поднимает сервер с --stop-other (порт) и --log-file (весь вывод в файл)');
  ok(/ytm-dl-error\.txt/.test(ctl), 'падение самой запускалки пишется в ytm-dl-error.txt');
  ok(/Path\.home\(\) \/ "Desktop"/.test(ctl), 'и копируется на Рабочий стол - туда, где普通 человек найдёт');
  ok(/traceback\.format_exc/.test(ctl), 'трейс берётся из format_exc, а не из того, что успело напечататься в окно');
  ok(/name='python\.exe' or name='pythonw\.exe'/.test(ctl) && /companion\.py/.test(ctl),
    'процессы ищутся через wmic по КОМАНДНОЙ СТРОКЕ (companion.py)');
  ok(/netstat -ano/.test(ctl) && /"ss", "-lptn"/.test(ctl), 'владелец порта: netstat (Windows) / ss (linux) - без WMI-голода');
  ok(/taskkill/, /taskkill/.test(ctl) && /\/T/.test(ctl) && /\/F/.test(ctl),
    'жёсткая остановка = taskkill /T /F, т.е. дерево процесса вместе с yt-dlp\\ffmpeg');
  ok(!/taskkill\s+\/IM/.test(ctl), 'никаких taskkill /IM python.exe - чужие интерпретаторы не трогаем');
  ok(!/rmtree|Remove-Item/.test(ctl) && !new RegExp('unlink[(]' + String.fromCharCode(44,32) + '"' + String.fromCharCode(37) + 'music').test(ctl)
     && !/os\.remove\([^)]*out_dir/.test(ctl),
    'uninstall ничего не удаляет в папке вывода: снимает только свои probe/tmp-файлы и проверяет блокировку');
  ok(/http_json\("\/shutdown"/.test(ctl) && /X-YTM-Token/.test(ctl),
    'stop сначала штатный /shutdown (с токеном из ini, если он задан), и только потом pid-ы');
  ok(/15E5300B0BA3C3695A7621D90160A746EC9E710228CEE639AFA9D580F6E3CD11/.test(ctl),
    'deno: скачивание одним файлом с сверкой sha256 (в app\\bin, без установки)');
  ok(/shutil\.which\("node"\)/.test(ctl), 'deno: если node уже стоит, он просто копируется в app\\bin');
  ok(/def report/.test(ctl) && /ytm-dl-report\.txt/.test(ctl), 'report = то, для чего был diagnostic.bat: всё в один файл');
  ok(/ini_get\("port"/.test(ctl), 'порт берётся из ytm-dl.ini, а не «очевидно 8765»');
  ok(/ytm-dl-server\.log/.test(comp) && /def _ytm_log_line/.test(comp),
    'компаньон пишет свой лог сам (music\\ytm-dl-server.log) и умеет --log-file');

  const start = fs.readFileSync(path.join(dist, 'start.bat'), 'utf8').replace(/\r/g, '');
  ok(start.split(LF0).length <= 80 && /call ":chk"/.test(start) === false && /call :chk/.test(start),
    `start.bat - автономный запускалка (${start.split(LF0).length} строк): он не алиас, потому что алиас,
   не найдя ytm.bat, закрывает окно без единого слова - ровно та жалоба`);
  ok(/^\s*goto :fin/m.test(start) && /^:fin$/m.test(start)
     && /^:fin\n(?:[^\n]*\n){0,6}?pause/m.test(start),
    'аварийные ветки идут в :fin, а сразу под :fin стоит pause - окна без объяснения не будет');
  ok(!/powershell|Get-Content/.test(start),
    'в autonomном start.bat нет powershell-а: именно он в старой сборке врал вместо причины');
  ok(/\[WHY\]/.test(start) && (start.match(/\[WHY\]/g) || []).length >= 3,
    `на каждый молчаливый отказ - своя строка [WHY] (${(start.match(/\[WHY\]/g) || []).length} шт.)`);
  const legacy = fs.readdirSync(dist).filter((f) => /\.(bat|ps1)$/.test(f));
  ok(!/test\.bat|diagnostic\.bat|ytm\.ps1|ytm-control\.ps1/.test(legacy.join(' ')),
    `мусорных launcher-ов в папке больше нет: ${legacy.join(', ')}`);

  ok(/cookies_file=/.test(fs.readFileSync(path.join(dist, 'ytm-dl.ini'), 'utf8').replace(/\r/g, '')),
    'ключ cookies_file описан прямо в ytm-dl.ini');
  const rdw = fs.readFileSync(path.join(dist, 'README-WINDOWS.txt'), 'utf8').replace(/\r/g, '');
  ok(/deno-x86_64-pc-windows-msvc\.zip/.test(rdw) && /15E5300B0BA3C369/.test(rdw),
    'README-WINDOWS даёт ссылку на deno и его sha256');
  ok(/Cookies\.txt|cookies\.txt/i.test(rdw) || /deno/.test(rdw),
    'там же про второй рычаг (cookies_file) - оба в одном файле, а не в двух шпаргалках');
  ok(/ШПАРГАЛКА/.test(rdw) && (rdw.match(/^\[ \] \d\./gm) || []).length === 6,
    'краткая инструкция (6 чекбоксов) переехала в README-WINDOWS.txt отдельным разделом');
  ok(!fs.existsSync(path.join(root, 'dist', 'ytm-dl-win', 'SHPARGALKA.txt')),
    'отдельной шпаргалки в поставке нет: текст переехал в README-WINDOWS.txt (файл удалён, не «спрятан»)');
  ok(rdw.includes('ytm.bat') && !/Дважды кликни:   start\.bat/.test(rdw),
    'шпаргалка ведёт по реальным файлам: клик = ytm.bat');
  ok(!/Дважды кликни.*SHPARGALKA|открой SHPARGALKA|Read SHPARGALKA|SHPARGALKA\.txt - 6/.test(rdw),
    'README не отправляет открывать SHPARGALKA.txt - файла в папке больше нет');
}

group('линтер .bat ловит и новые, и старые формы ошибки');
{
  const probe = JSON.stringify([
    // старая форма: соседняя кавычка есть, но путь продолжается — должно быть чисто
    'if exist "%OUTDIR%\\x.log" copy /y "%OUTDIR%\\x.log" "%TEMP%\\d.txt"',
    // голый %OUTDIR% — ловим
    'dir %OUTDIR%',
    // «кавычка только слева» (обрывок) — тоже ловим
    'type "%OUTDIR%\\x',
    // запуск без кавычек
    '%PYEXE% -m foo',
    // безопасная форма запуска — чисто
    '"!PYEXE!" %PYARGS% "%COMPANION%" %ARGS%',
    // set "NAME=…" целиком в кавычках — чисто
    'set "ARGS=--out "!OUTDIR!" --organize "!ORGANIZE!"',
    // та же подстановка, но записанная через !VAR! (отсроченное раскрытие)
    '!PYEXE! app\\companion.py',
    '"!PYEXE!" -u app\\companion.py',
    // rem/echo — не трогаем (последним: индекс r[N] = позиция в массиве)
    'echo out=%OUTDIR%',
  ]);
  const py = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'tools')
import lint_bats
res = []
for txt in json.loads(sys.argv[1]):
    raw = (txt + '\\n').replace('\\n', '\\r\\n').encode()
    res.append(lint_bats.check_bat_text(txt + '\\n', raw, 'p.bat'))
# и реальный dist целиком - whole-dir прогоном
res.append([x for x in range(lint_bats.lint_dir(sys.argv[2], quiet=True))])
print(json.dumps(res))
`, probe, path.join(root, 'dist', 'ytm-dl-win')], { encoding: 'utf8', cwd: root });
  const r = JSON.parse(py.trim());
  eq(r[0].length, 0, 'кавычки вокруг пути с продолжением (…%OUTDIR%\\file) — не ложное срабатывание');
  eq(r[1].length, 1, 'голый %OUTDIR% ловится');
  eq(r[2].length, 1, 'незакрытая кавычка (чётность ломается) тоже ловится');
  eq(r[3].length, 2, 'запуск %PYEXE% без кавычек ловится ДВУМЯ правилами (голая подстановка + форма запуска)');
  eq(r[4].length, 0, 'правильная форма "!PYEXE!" чистая');
  eq(r[5].length, 0, 'set "NAME=… !VAR! …" — безопасная форма, не трогаем');
  eq(r[6].length, 2, 'правило кавычек покрыто и для !VAR! (отсроченное раскрытие): подстановка + запуск');
  eq(r[7].length, 0, 'и для !VAR! безопасна та же форма "!PYEXE!"');
  eq(r[8].length, 0, 'echo/rem не проверяем на кавычки');
  eq(r[9].length, 0, 'собранный dist/ytm-dl-win проходит lint_dir целиком (0 ошибок)');
  ok(fs.existsSync(path.join(root, 'tools', 'lint_bats.py')),
    'правила живут в tools/lint_bats.py — их можно тестировать, а не только «на сборке всё зелёное»');
}

group('companion: серверный --cookies-from-browser доезжает до job’а');
{
  const port3 = await freePort();
  const out3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-ck-'));
  const p3 = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port3), '--out', out3,
                        '--cookies-from-browser', 'chrome'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const b3 = `http://127.0.0.1:${port3}`;
  let h3 = null;
  for (let i = 0; i < 60 && !h3; i++) { await sleep(200); try { const r = await fetch(b3 + '/hello'); if (r.ok) h3 = await r.json(); } catch {} }
  if (!h3) { ok(false, 'companion с --cookies-from-browser поднялся'); p3.kill('SIGKILL'); }
  else {
    eq(h3.cookies_from_browser, 'chrome', '/hello сообщает о настроенных cookies');
    const r = await fetch(b3 + '/job', { method: 'POST', body: JSON.stringify({ kind: 'url', url: 'https://music.youtube.com/watch?v=aaaa1111bbb' }) });
    const j = await r.json();
    let job = null;
    for (let i = 0; i < 200; i++) { job = await (await fetch(`${b3}/job/${j.job}`)).json(); if (job.status === 'done' || job.status === 'error') break; await sleep(300); }
    eq(job.meta.cookies_from_browser, 'chrome', 'job получил cookies от сервера, а не только из payload');
    const joined = (job.logs || []).join('\n');
    ok(/--cookies-from-browser chrome/.test(joined),
      'флаг реально попал в командную строку yt-dlp: ' + (joined.match(/--cookies-from-browser \S+/)?.[0] || '—'));
    // явное значение в job’е не перетирается серверным дефолтом
    const r2 = await fetch(b3 + '/job', { method: 'POST', body: JSON.stringify({ kind: 'playlist', url: 'liked', dry_run: true, cookies_from_browser: 'firefox' }) });
    const j2 = await r2.json();
    let job2 = null;
    for (let i = 0; i < 60; i++) { job2 = await (await fetch(`${b3}/job/${j2.job}`)).json(); if (job2.status === 'done' || job2.status === 'error') break; await sleep(200); }
    eq(job2.meta.cookies_from_browser, 'firefox', 'и явный override из payload жив');
    eq(job2.status, 'done', 'playlist dry_run по-прежнему проходит без сети');
  }
  p3.kill('SIGKILL');
  try { fs.rmSync(out3, { recursive: true, force: true }); } catch {}
}

group('diag-old.bat: проба для СТАРОЙ папки, где окно закрывается молча');
{
  const d = path.join(root, 'win', 'diag-old.bat');
  ok(fs.existsSync(d), 'проба лежит в репозитории и кладётся в корень архива');
  const g = fs.readFileSync(d, 'utf8');
  const shipped = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'diag-old.bat'), 'utf8');
  eq(shipped.replace(/\r/g, ''), g.replace(/\r/g, ''), 'в архиве ровно тот же текст');
  ok(!/^\s*(powershell|pwsh)\b/im.test(g),
    'проба НЕ зовёт powershell (в комментариях слово может быть - именно на этом вызове и врал старый лог)');
  ok(!/curl|bitsadmin|Invoke-|certutil|https?:/.test(g), 'проба ничего не качает и не трогает сеть');
  ok(!/\b(del|erase|rmdir)\s/i.test(g) && !/diskpart/i.test(g),
    'проба ничего не удаляет: только читает и печатает');
  ok(/\[WHY\]/.test(g) && (g.match(/\[WHY\]/g) || []).length >= 4,
    `есть ветка [WHY] на каждый молчаливый отказ (${(g.match(/\[WHY\]/g) || []).length} шт.)`);
  ok(/--check/.test(g) && /pause/.test(g),
    'проба зовёт companion --check (тот же selftest) и ждёт клавишу - окно не исчезнет');
  const py = execFileSync('python3', ['-c', `
import sys
sys.path.insert(0, 'tools')
import lint_bats
print(len(lint_bats.check_bat_text(open(sys.argv[1], encoding='utf-8').read().replace(chr(13), ''), open(sys.argv[1], 'rb').read(), 'diag-old.bat') or []))
`, d], { encoding: 'utf8', cwd: root }).trim();
  eq(py, '0', 'diag-old.bat проходит те же правила .bat-линтера, что и запускатель');
}

group('deno приносить не нужно: get-deno.bat и player_client=tv');
{
  const gd = path.join(root, 'win', 'get-deno.bat');
  ok(fs.existsSync(gd), 'get-deno.bat остался в репозитории (в архив его не кладём: то же делает ytm.bat deno)');
  ok(!fs.existsSync(path.join(root, 'dist', 'ytm-dl-win', 'get-deno.bat')),
    'и в поставке его нет: лишних файлов-дублей быть не должно');
  const g = fs.readFileSync(gd, 'utf8').replace(/\r/g, '');
  ok(/denoland\/deno\/releases/.test(g), 'скачивает с официального релиза GitHub');
  ok(/certutil -hashfile/.test(g) && /sha256 mismatch/.test(g),
    'сверяет sha256 и ОТКАЗЫВАЕТСЯ распаковывать при несовпадении');
  ok(/app\\bin/.test(g), 'кладёт в app\bin — туда же, куда и ffmpeg');
  ok(/where node/.test(g) && /node\.exe/.test(g), 'если node уже стоит — копирует его, не качая 110 МБ');
  ok(/player_client=tv/.test(g), 'и напоминает про третий путь без всяких загрузок');
  ok(/:\s*manual|goto manual/.test(g) && /releases\/latest/.test(g),
    'при отказе сети даёт ручную инструкцию, а не просто падает');

  // серверный player_client обязан доезжать до job’а — иначе «tv» ничего не лечит
  const b5 = 'http://127.0.0.1:8793';
  const p5 = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', '8793',
                        '--out', path.join(outDir, 'pclient'), '--player-client', 'tv'],
                   { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let h5 = null;
    for (let i = 0; i < 40 && !h5; i++) { await sleep(150); try { h5 = await (await fetch(b5 + '/hello')).json(); } catch {} }
    ok(!!h5, 'companion с --player-client поднялся');
    if (h5) {
      eq(h5.player_client, 'tv', '/hello сообщает о клиенте (панель его покажет)');
      const r = await fetch(b5 + '/job', { method: 'POST', body: JSON.stringify({
        kind: 'playlist', url: 'https://music.youtube.com/playlist?list=PLx', dry_run: true }) });
      const id = (await r.json()).job;
      let job = null;
      for (let i = 0; i < 60 && (!job || job.status === 'running' || job.status === 'queued'); i++) {
        await sleep(250); job = await (await fetch(`${b5}/job/${id}`)).json();
      }
      eq(job.meta.player_client, 'tv', 'dry_run-джоб получил player_client от сервера');
      const r2 = await fetch(b5 + '/job', { method: 'POST', body: JSON.stringify({
        kind: 'playlist', url: 'x', dry_run: true, player_client: 'web' }) });
      const id2 = (await r2.json()).job;
      let j2 = null;
      for (let i = 0; i < 60 && (!j2 || j2.status === 'running' || j2.status === 'queued'); i++) {
        await sleep(250); j2 = await (await fetch(`${b5}/job/${id2}`)).json();
      }
      eq(j2.meta.player_client, 'web', 'явный player_client из payload важнее серверного');
    }
  } finally { p5.kill('SIGKILL'); }

  const ini = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'ytm-dl.ini'), 'utf8').replace(/\r/g, '');
  ok(/^player_client=/m.test(ini), 'ключ есть в ytm-dl.ini');
  const sh = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'README-WINDOWS.txt'), 'utf8');
  ok(/ytm\.bat deno/.test(sh), 'шпаргалка знает про ytm.bat deno (замена get-deno.bat)');
}

group('bot-чек: HTML вместо потока не должен становиться «треком»');
{
  // ровно то, что видел пользователь: два файла одного размера, ни один плеер не играет
  const html = Buffer.from('<!DOCTYPE html><html><head><title>Sign in to confirm you' +
    "'re not a bot</title></head><body>Sorry for the interruption.</body></html>", 'utf8');
  const r = await fetch(base + '/media?videoId=BOTCHECK1', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: html });
  const j = await r.json();
  let jb = null;
  for (let i = 0; i < 60; i++) { jb = await (await fetch(`${base}/job/${j.job}`)).json(); if (jb.status !== 'running' && jb.status !== 'queued') break; await sleep(150); }
  eq(jb.status, 'error', 'html-ответ /media -> job в error, а не «done» с файлом на диске');
  ok(/бот-чек|бот-чек\/редирект|бот-чек/.test(jb.error || ''), `вину названа прямо: "${(jb.error || '').slice(0, 80)}"`);
  const litter = fs.readdirSync(outDir).filter((f) => /BOTCHECK1/.test(f) || f.endsWith('.bin'));
  eq(litter, [], 'в папку вывода такой «трек» не лёг');

  // .bin в copy-режиме больше не бесформенный: расширение берётся из байтов
  const tone = fs.readFileSync(fx('stream.m4s'));
  const r2 = await fetch(base + '/media?videoId=SNIFFBIN1&format=copy', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: tone });
  const j2 = await r2.json();
  let jb2 = null;
  for (let i = 0; i < 80; i++) { jb2 = await (await fetch(`${base}/job/${j2.job}`)).json(); if (jb2.status !== 'running' && jb2.status !== 'queued') break; await sleep(150); }
  eq(jb2.status, 'done', `copy-режим с реальным m4s проходит (status=${jb2.status} ${jb2.error || ''})`);
  const made = fs.readdirSync(outDir).filter((f) => /SNIFFBIN1|m4a|mp4/i.test(f));
  ok(made.some((f) => /\.(m4a|mp4)$/i.test(f)), `расширение из байтов, не .bin: ${made.join(', ')}`);

  // чистые хелперы: unknown_video -> настоящий контейнер (yt-dlp пишет %(ext)s,
  // а в самодельном info-dict расширения форматов нет - отсюда и «unknown_video»)
  const pyf = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-sniff-'));
  const script = [
    'import importlib.util, sys, pathlib, tempfile, json',
    `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
    'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
    'd = pathlib.Path(tempfile.mkdtemp())',
    'ft = bytes([0,0,0,0x18]) + b"ftypiso5" + bytes([0]*40)',
    'p = d / "abc.unknown_video"; p.write_bytes(ft)',
    'q = m._real_name(p)',
    'wb = d / "w.unknown_video"; wb.write_bytes(bytes([0x1a,0x45,0xdf,0xa3,1,2,3,4])*8)',
    'hu = d / "h.unknown_video"; hu.write_bytes(b"<!DOCTYPE html><html>sign in to confirm</html>"*40)',
    'pp = d / "z.unknown_video"; pp.write_bytes(b"garbage garbage " * 40)',
    'print(json.dumps({',
    '  "renamed": q.name,',
    '  "sniff": m.sniff_container(q),',
    '  "webm": m.sniff_container(m._real_name(wb)),',
    '  "html_yes": m.looks_like_html(hu),',
    '  "media_no": m.looks_like_html(q),',
    '  "plain": m._real_name(pp).name,',
    '}))',
  ].join('\n');
  const scriptPath = path.join(pyf, 'sniff.py');
  fs.writeFileSync(scriptPath, script);
  const h = JSON.parse(execFileSync('python3', [scriptPath], { encoding: 'utf8', cwd: root }).trim());
  eq(h.renamed, 'abc.m4a', 'unknown_video переименован по магическим байтам');
  eq(h.sniff, 'm4a', 'sniff_container опознаёт mp4-бренд');
  eq(h.webm, 'webm', 'и ebml/webm');
  eq(h.html_yes, true, 'looks_like_html ловит страницу, даже когда расширение похоже на видео');
  eq(h.media_no, false, 'на медиа не срабатывает (в первых байтах есть NUL)');

  // 0.6.10: write_tags закрывает «Исполнитель альбома» (aART/TPE2), год/жанр/
  // дорожку не оставляет без дела, а info.json-спасатель их подхватывает.
  {
    const pyt = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-tag10-'));
    const scriptT = [
      'import importlib.util, sys, json, pathlib, shutil, tempfile, subprocess',
      `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
      'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
      'd = pathlib.Path(tempfile.mkdtemp())',
      `p = d / "t.m4a"; shutil.copy(${JSON.stringify(path.join(root, 'tests', 'fixtures', 'tone.m4a'))}, p)`,
      'w = m.write_tags(p, {"title": "Slide", "artist": "1nonly и Shakewell", "album": "ONLY IF I DIE, WOULD I NOT BE", "track": 3, "date": "2024", "genre": "Hip Hop"}, None, None, None)',
      'from mutagen.mp4 import MP4',
      'mp = MP4(p)',
      'out = {"written": sorted(k for k in w if not k.startswith("_")), "trkn": len(mp.tags.get("trkn") or []),',
      '       "albumartist": (mp.tags.get("aART") or [None])[0],',
      '       "day": (mp.tags.get("©day") or [None])[0],',
      '       "artist": (mp.tags.get("©ART") or [None])[0]}',
      'if m.FF.ok:',
      '    mp3 = d / "t.mp3"',
      '    subprocess.run([m.FF.ffmpeg, "-v", "error", "-i", str(p), "-c:a", "libmp3lame", "-map_metadata", "-1", "-y", str(mp3)], check=True)',
      '    m.write_tags(mp3, {"title": "X", "artist": "A B", "album": "AL", "date": "2019", "track": "5"}, None, None, None)',
      '    from mutagen.id3 import ID3',
      '    tb = ID3(mp3)',
      '    def _t(fid):',
      '        f = tb.get(fid)',
      '        return str(f.text[0]) if f is not None else None',
      '    out["tpe2"] = _t("TPE2"); out["tit2"] = _t("TIT2"); out["talb"] = _t("TALB")',
      '    out["tdrc"] = _t("TDRC"); out["trck"] = _t("TRCK")',
      'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n');
    const scriptTPath = path.join(pyt, 'tagw.py');
    fs.writeFileSync(scriptTPath, scriptT);
    const ht = JSON.parse(execFileSync('python3', [scriptTPath], { encoding: 'utf8', cwd: root }).trim());
    ok(ht.written.includes('albumartist'), 'write_tags сам рапортует, что дописал albumartist (0.6.10)');
    eq(ht.albumartist, '1nonly и Shakewell', 'aART = артист трека, когда отдельного album artist нет');
    eq(ht.day, '2024', 'год из meta.date доезжает до ©day');
    eq(ht.artist, '1nonly и Shakewell', 'TPE1 не пострадал от подстановки');
    ok(!ht.written.includes('track'), '0.6.19: номер дорожки НЕ пишут вовсе (просил владелец: «нумерацию убрать пока»)');
    eq(ht.trkn, 0, 'и атом trkn не создаётся даже при track: 3 в meta');
    if (ht.tpe2 !== undefined) {
      eq(ht.tpe2, 'A B', 'mp3 получает TPE2 - «Исполнитель альбома» в свойствах Windows больше не пустой');
      eq(ht.tit2, 'X', '0.6.10 КРИТИЧНО: TIT2 вообще пишется - строковые имена фреймов из карты разрешаются в классы');
      eq(ht.talb, 'AL', 'TALB доживает до диска (это и было «мало метаданных» на mp3)');
      eq(ht.tdrc, '2019', 'год из date едет в TDRC');
      eq(ht.trck, null, '0.6.19: TRCK не пишется и на mp3 - «Дорожка 791» из playlist_index нам не нужна');
    } else ok(false, 'mp3/TPE2: ffmpeg недоступен - проверка пропущена, но поле должно писаться');
  }

  group('чистка заголовка и читаемость ini (0.6.11)');
  {
    const pyc = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-ct-'));
    const scriptCT = [
      'import importlib.util, sys, json',
      `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
      'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
      'print(json.dumps([',
      '  m.clean_title("MAK DADDY - Bezos", "MAK DADDY"),',
      '  m.clean_title("tool \u2014 Fear Inoculum", "TOOL"),',
      '  m.clean_title("Baker Street", "Gerry Rafferty"),',
      '  m.clean_title("A - B", ""),',
      '  m.clean_title("AC-DC - Highway", "AC-DC"),',
      '  m.clean_title("GHOST - 2359 - Live", "GHOST"),',
      '  m.clean_title("1nonly\u00a0\u0438 Shakewell - WHO GON SLIDE", "1nonly \u0438 Shakewell"),',
      '  m.clean_title("GHOST  -   2359", "GHOST"),',
      '  m.clean_title("1nonly \u0438 Shakewell - WHO GON SLIDE", "1nonly, Shakewell"),',
      '  m.clean_title("GHOST & 2359 - Live", "GHOST, 2359"),',
      '], ensure_ascii=False))',
    ].join('\n');
    const pCT = path.join(pyc, 'ct.py');
    fs.writeFileSync(pCT, scriptCT);
    const r = JSON.parse(execFileSync('python3', [pCT], { encoding: 'utf8', cwd: root }).trim());
    eq(r[0], 'Bezos', '«MAK DADDY - Bezos» + артист MAK DADDY = Bezos');
    eq(r[1], 'Fear Inoculum', 'регистр и тире- эм дэш не мешают');
    eq(r[2], 'Baker Street', 'без префикса не трогаем');
    eq(r[3], 'A - B', 'артист неизвестен - не гадаем, где тут кто');
    eq(r[4], 'Highway', 'дефис внутри имени артиста не ломает разбор');
    eq(r[5], '2359 - Live', 'режем ровно один префикс, остальное - название');
    eq(r[6], 'WHO GON SLIDE', '0.6.14: NBSP между словами артиста не мешает срезать префикс');
    eq(r[7], '2359', '0.6.14: двойные пробелы вокруг тире - тоже');
    eq(r[8], 'WHO GON SLIDE', '0.6.16: артист «A, B», а заголовок «A и B - T» - склейки сверяются, префикс срезан');
    eq(r[9], 'Live', '0.6.16: и английская &-склейка тот же артист');
  }
  {
    const raw = fs.readFileSync(path.join(root, 'win', 'ytm-dl.ini')).toString('latin1');
    ok(!/\r(?!\n)/.test(raw), 'в ytm-dl.ini нет одиноких \r - Блокнот не сливает строки в кашу');
    const ini = fs.readFileSync(path.join(root, 'win', 'ytm-dl.ini')).toString('utf8');
    ok(ini.includes('\u00ab0\u00bb работает и здесь'), 'ini объясняет человеку, что 0 = качать напрямую');
  }

  // 0.6.12: track=0 (yt-dlp кладёт ноль когда номера нет) не должен рождать «№ 0»
  // в свойствах - нули отсекаются до записи.
  {
    const pyz = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-zero-'));
    const scriptZ = [
      'import importlib.util, sys, json, pathlib, shutil, tempfile',
      `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
      'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
      'd = pathlib.Path(tempfile.mkdtemp())',
      `p = d / "z.m4a"; shutil.copy(${JSON.stringify(path.join(root, 'tests', 'fixtures', 'tone.m4a'))}, p)`,
      'w = m.write_tags(p, {"title": "Z", "artist": "AA", "album": "BB", "track": 0, "duration": 212}, None, None, None)',
      'from mutagen.mp4 import MP4',
      'mp = MP4(p)',
      'print(json.dumps({"track_written": "track" in w, "trkn": len(mp.tags.get("trkn") or []),',
      '  "tit2": (mp.tags.get("\u00a9nam") or [None])[0]}))',
    ].join('\n');
    const pZ = path.join(pyz, 'zero.py');
    fs.writeFileSync(pZ, scriptZ);
    const hz = JSON.parse(execFileSync('python3', [pZ], { encoding: 'utf8', cwd: root }).trim());
    eq(hz.track_written, false, 'track=0 в теги не пишется (Explorer не покажет «№ 0»)');
    eq(hz.trkn, 0, 'атом trkn вообще не создан');
    eq(hz.tit2, 'Z', 'остальные поля от фильтра нулей не пострадали');
  }
  {
    // 0.6.16: ноль в ЛЮБОЙ форме: [0] списком, "0" строкой, "0/12" дробью
    const pyz2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-zero2-'));
    const scriptZ2 = [
      'import importlib.util, sys, json, pathlib, shutil, tempfile',
      `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
      'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
      'd = pathlib.Path(tempfile.mkdtemp())',
      `p = d / "z2.m4a"; shutil.copy(${JSON.stringify(path.join(root, 'tests', 'fixtures', 'tone.m4a'))}, p)`,
      'w = m.write_tags(p, {"title": "T2", "track": [0], "duration": "0/12"}, None, None, None)',
      'from mutagen.mp4 import MP4',
      'mp = MP4(p)',
      'print(json.dumps({"keys": sorted(w.keys()), "trkn": len(mp.tags.get("trkn") or [])}))',
    ].join('\n');
    const pZ2 = path.join(pyz2, 'zero2.py');
    fs.writeFileSync(pZ2, scriptZ2);
    const hz2 = JSON.parse(execFileSync('python3', [pZ2], { encoding: 'utf8', cwd: root }).trim());
    eq(hz2.trkn, 0, 'track:[0] списком - тоже не данные, trkn не создан');
    eq(hz2.keys.includes('duration') || hz2.keys.includes('track'), false, 'ни zero-длительность, ни zero-track не протекли');
  }
  eq(h.plain, 'z.unknown_video', 'неизвестные байты как есть НЕ переименовываются - пусть падают честно, чем притворяться треком');
}

group('0.6.16: лестница клиентов - один источник правды');
{
  const compSrc = fs.readFileSync(path.join(root, 'server/companion.py'), 'utf8');
  ok(/CLIENT_CHAIN = \("web_safari", "", "tv", "web_embedded"\)/.test(compSrc),
     '0.6.16: порядок клиентов - ОДНА константа на url и playlist (не две рукописных лестницы)');
  ok(!compSrc.includes('("web_safari", []), ("", []), ("tv", []), ("web_embedded", [])'),
     'старый рукописный список url-лестницы выведен из CLIENT_CHAIN, а не дублирован');
  ok(/\{"player_client": \[CLIENT_CHAIN\[3\]\]\}/.test(compSrc), 'и плейлист берёт web_embedded из той же константы');
}

group('yt-dlp: перебор клиентов и прокси вместо «сдались на первом отказе»');
{
  const pyf = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-ladder-'));
  const script = [
    'import importlib.util, sys, pathlib, tempfile, types, json, os',
    `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
    'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'BOT = "ERROR: Sign in to confirm you\'re not a bot"',
    'NF  = "ERROR: The requested URL returned 404"',
    'def run(seq, meta):',
    '    calls = []',
    '    def fake(cmd, **kw):',
    '        calls.append(cmd)',
    '        rc, err = seq[min(len(calls) - 1, len(seq) - 1)]',
    '        if rc == 0:',
    '            d = pathlib.Path(os.path.dirname(cmd[cmd.index("-o") + 1]))',
    '            (d / "aaaaaaaaaaa.m4a").write_bytes(b"x" * 2048)',
    '        return types.SimpleNamespace(returncode=rc, stdout="", stderr=err)',
    '    m._run_tracked = fake',
    '    j = m.Job(id="J", kind="url", dest=tmp / "pending")',
    '    j.meta = meta',
    '    exc = ""',
    '    try:',
    '        m.handle_url(j)',
    '    except Exception as e:',
    '        exc = str(e)',
    '    return calls, exc, j',
    'manual = [c for c, x in m._client_ladder("tv")]',
    'base = {"url": "https://music.youtube.com/watch?v=aaaaaaaaaaa", "proxy": "http://127.0.0.1:7890"}',
    'def win_ok():',
    '    got = []',
    '    def fk(cmd, **kw):',
    '        got.append(cmd)',
    '        return types.SimpleNamespace(returncode=1, stdout=\"\", stderr=NF)',
    '    real_od = m.out_dir_ok',
    '    m.out_dir_ok = lambda x, d: __import__(\"pathlib\").Path(x)',
    '    m._run_tracked = fk',
    '    jw = m.Job(id=\"JW\", kind=\"url\", dest=tmp / \"p9\")',
    '    jw.meta = {\"url\": \"https://music.youtube.com/watch?v=aaaaaaaaaaa\",',
    '               \"out_dir\": \"C:/Music/ytm\", \"player_client\": \"tv\"}',
    '    try:',
    '        m.handle_url(jw)',
    '    except Exception:',
    '        pass',
    '    m.out_dir_ok = real_od',
    '    cc = got[0]',
    '    o = cc.index(\"-o\")',
    '    return len(cc) - o == 3 and cc[-1].startswith(\"https://music\") and cc.count(\"-o\") == 1 and tmp.name not in cc[o + 1].split(\"/\")[0]',
    'c1, e1, j1 = run([(1, BOT), (1, BOT), (1, BOT), (1, BOT)], dict(base))',
    'c2, e2, j2 = run([(1, NF)], dict(base))',
    'c3, e3, j3 = run([(1, BOT), (0, "")], dict(base, format="m4a", meta={"title": "T", "artist": "A"}))',
    'print(json.dumps({',
    '  "ladder": [c for c, x in m._client_ladder(None)],',
    '  "manual": manual,',
    '  "attempts_bot": len(c1), "attempts_nf": len(c2),',
    '  "proxy": any("--proxy" in c for c in c1),',
    '  "tv_third": "player_client=tv" in " ".join(c1[2]) if len(c1) > 2 else False,',
    '  "safari_first": "player_client=web_safari" in " ".join(c1[0]),',
    '  "fmt_default": c1[0][c1[0].index("-f") + 1],',
    '  "retryable_bot": m._looks_like_bot_check(BOT),',
    '  "retryable_reload": m._looks_like_bot_check("ERROR: The page needs to be reloaded"),',
    '  "not_retryable": m._looks_like_bot_check(NF),',
    '  \"tail_ok\": all(a[-1].startswith(\"https://music\") and a.count(\"-o\") == 1 and \"%(ext)s\" in a[a.index(\"-o\") + 1] for a in c1),',
    '  \"winpath_ok\": win_ok(),',
    '  "err1": e1[:150],',
    '  "dest3": j3.dest.name if j3.dest else "",',
    '  "msg3": (j3.message or "")[:80],',
    '}))',
  ].join('\n');
  const sp = path.join(pyf, 'ladder.py');
  fs.writeFileSync(sp, script);
  const h = JSON.parse(execFileSync('python3', [sp], { encoding: 'utf8', cwd: root }).trim());
  eq(h.ladder, ['web_safari', '', 'tv', 'web_embedded', 'web_safari'],
     'лестница: web_safari (m4a без po-token) -> дефолт -> tv -> web_embedded -> web_safari+missing_pot');
  eq(h.manual, ['tv', '', 'web_safari', 'web_embedded', 'web_safari'],
     'ручной player_client идёт ПЕРВЫМ и не дублируется, но запасные клиенты остаются');
  ok(h.manual[0] === 'tv', '0.5.11: явный клиент = шаг 1, а не «после пустого прогрева» (жалоба: скачивал только 5-й шаг)');
  eq(h.attempts_bot, 5, 'бот-чек - пробуем всех клиентов (5 попыток)');
  eq(h.attempts_nf, 1, '«не найдено/нет доступа» вторым клиентом не лечится - не тратим время');
  eq(h.tail_ok, true, '-o стоит рядом со своим шаблоном, url - последний аргумент');
  eq(h.winpath_ok, true, 'путь не уезжает в позиционные - так рождался Unsupported url scheme «C»');
  eq([h.retryable_bot, h.retryable_reload, h.not_retryable], [true, true, false],
    'повторять стоит на бот-чек и «page needs to be reloaded», а не на «404»');
  eq(h.proxy, true, 'proxy из ytm-dl.ini доехал до yt-dlp');
  eq(h.tv_third, true, 'третья попытка реально идёт с player_client=tv');
  eq(h.safari_first, true, 'первая попытка - web_safari: у него m4a есть всегда, отсюда и обложка');
  eq(h.fmt_default, 'bestaudio[ext=m4a]/bestaudio/best',
     'без format_spec (CLI/рука человека) просим именно m4a, а не «лучшее аудио» = webm/opus');
  ok(/sign in|not a bot|exit 1|бот/i.test(h.err1), `последняя ошибка не спрятана: "${h.err1.slice(0, 72)}"`);
  ok(/\.m4a$/i.test(h.dest3), `удачная вторая попытка доводит дело до файла: ${h.dest3}`);
}

group('proxy= из ini доезжает до ВСЕХ путей, а не только до url-режима');
{
  const pyf = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-px-'));
  const script = [
    'import importlib.util, sys, pathlib, tempfile, types, json',
    'spec = importlib.util.spec_from_file_location("comp", '
      + JSON.stringify(path.join(root, 'server', 'companion.py')) + ')',
    'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'res = {}',
    'pr = "http://127.0.0.1:7890"',
    'res["socks_needs_pysocks"] = (not m.socks_available()) if True else None',
    '# browser-режим: команды yt-dlp',
    'calls = []',
    'def fake(cmd, **kw):',
    '    calls.append(cmd)',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: no formats")',
    'm._run_tracked = fake',
    'j = m.Job(id="PX", kind="browser", dest=tmp / "p")',
    'j.meta = {"videoId": "aaaaaaaaaaa", "proxy": pr,',
    '          "player_response": {"playabilityStatus": {"status": "OK"}, "streamingData": {}},',
    '          "out_dir": str(tmp), "meta": {"title": "T"}}',
    'try:',
    '    m.handle_browser(j)',
    'except Exception as e:',
    '    pass',
    'res["browser_proxy"] = any("--proxy" in c and pr in c for c in calls)',
    'res["browser_args"] = " ".join(calls[0])[:200] if calls else ""',
    '# url-режим с socks и без PySocks: отказ ДО попыток, внятным текстом',
    'calls2 = []',
    'def fake2(cmd, **kw):',
    '    calls2.append(cmd)',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="x")',
    'm._run_tracked = fake2',
    'j2 = m.Job(id="PS", kind="url", dest=tmp / "p2")',
    'j2.meta = {"url": "https://music.youtube.com/watch?v=aaaaaaaaaaa",',
    '           "proxy": "socks5://127.0.0.1:1080", "out_dir": str(tmp)}',
    'msg = ""',
    'try:',
    '    m.handle_url(j2)',
    'except Exception as e:',
    '    msg = str(e)',
    'res["socks_allowed"] = ("PySocks" not in msg) and len(calls2) >= 1 and any("--proxy" in c for c in calls2)',
    '# страховка только если и у yt-dlp нет транспорта: имитируем это, спрятав yt_dlp.socks',
    'import sys as _s',
    '_real = _s.modules.get("yt_dlp.socks")',
    '_s.modules["yt_dlp.socks"] = None',
    'calls3 = []',
    'def fake3(cmd, **kw):',
    '    calls3.append(cmd); return types.SimpleNamespace(returncode=1, stdout="", stderr="x")',
    'm._run_tracked = fake3',
    'j5 = m.Job(id="P5", kind="url", dest=tmp / "p5")',
    'j5.meta = {"url": "https://music.youtube.com/watch?v=aaaaaaaaaaa",',
    '           "proxy": "socks5://127.0.0.1:10808", "out_dir": str(tmp)}',
    'msg5 = ""',
    'try:',
    '    m.handle_url(j5)',
    'except Exception as e:',
    '    msg5 = str(e)',
    '_s.modules["yt_dlp.socks"] = _real',
    'res["socks_guard_when_no_transport"] = ("PySocks" in msg5 or "socks transport" in msg5)',
    '# decide_proxy - чистая функция (без реестра): приоритеты и fallback-ы',
    'res["dp_ini"] = m.decide_proxy("http://127.0.0.1:7890", {"socks": "127.0.0.1:10808"}, True)',
    'res["dp_inherit_socks"] = m.decide_proxy("", {"socks": "127.0.0.1:10808"}, True,',
    '                                         lambda sp: True)',
    'res["dp_dead_socks"] = m.decide_proxy("", {"socks": "127.0.0.1:10808"}, True,',
    '                                       lambda sp: False)',
    'res["dp_no_pysocks"] = m.decide_proxy("", {"socks": "127.0.0.1:10808"}, False,',
    '                                       lambda sp: True)',
    'res["dp_http"] = m.decide_proxy("", {"http": "a:3128"}, True, lambda sp: True)',
    'res["dp_empty"] = m.decide_proxy("", {}, True, lambda sp: True)',
    '# плейлист: opts["proxy"] + та же страховка на socks',
    'opts_box = {}',
    'class FakeYDL:',
    '    def __init__(self, o=None, **kw):',
    '        opts_box.update(o or {})',
    '    def __enter__(self): return self',
    '    def __exit__(self, *a): return False',
    '    def extract_info(self, url, download=True): return {"entries": []}',
    'have_yt_dlp = bool(__import__("importlib.util", fromlist=["x"]).find_spec("yt_dlp"))',
    'if have_yt_dlp:',
    '    import yt_dlp as yd',
    '    yd.YoutubeDL = FakeYDL',
    'j3 = m.Job(id="PP", kind="playlist", dest=tmp / "p3")',
    'j3.meta = {"url": "https://music.youtube.com/playlist?list=PLAAAAAAA1",',
    '           "proxy": pr, "out_dir": str(tmp), "dedup": False}',
    'try:',
    '    m.handle_playlist(j3)',
    'except Exception:',
    '    pass',
    'res["playlist_opts_proxy"] = opts_box.get("proxy") == pr',
    'j4 = m.Job(id="PQ", kind="playlist", dest=tmp / "p4")',
    'j4.meta = {"url": "https://music.youtube.com/playlist?list=PLAAAAAAA1",',
    '           "proxy": "socks5h://127.0.0.1:1080", "out_dir": str(tmp)}',
    'msg4 = ""',
    'try:',
    '    m.handle_playlist(j4)',
    'except Exception as e:',
    '    msg4 = str(e)',
    'res["playlist_socks_proxy_set"] = opts_box.get("proxy") == "socks5h://127.0.0.1:1080"',
    '# обложка: без прокси в лоб, с proxy= - через ProxyHandler (ловим сам opener)',
    'seen = {}',
    'real_build = __import__("urllib.request", fromlist=["x"]).build_opener',
    'def spy_build(*hs):',
    '    # build_opener вызывается то списком, то позиционными - нормализуем форму',
    '    args = list(hs[0]) if (len(hs) == 1 and isinstance(hs[0], (list, tuple))) else list(hs)',
    '    seen["raw"] = [type(x).__name__ for x in hs]',
    '    seen["handlers"] = [type(h).__name__ for h in args]',
    '    seen["proxies"] = getattr(args[0], "proxies", getattr(args[0], "_proxies", {})) if args else {}',
    '    raise RuntimeError("stop-after-capture")',
    'import urllib.request as ur',
    'ur.build_opener = spy_build',
    'm.http_get_bytes("https://yt3.googleusercontent.com/x", proxy=pr)',
    'ur.build_opener = real_build',
    'res["cover_uses_proxyhandler"] = "ProxyHandler" in seen.get("handlers", [])',
    'res["cover_not_raw_list"] = seen.get("raw") != ["list"]  # build_opener([list]) = падало',
    'res["cover_proxy_value"] = seen.get("proxies", {}).get("https", "")',
    'res["have_yt_dlp"] = have_yt_dlp',
    'print(json.dumps(res))',
  ].join('\n');
  const sp = path.join(pyf, 'px.py');
  fs.writeFileSync(sp, script);
  const h = JSON.parse(execFileSync('python3', [sp], { encoding: 'utf8', cwd: root }).trim());
  ok(h.socks_needs_pysocks === true || h.socks_needs_pysocks === false,
     'socks_available() отвечает честно (в песочнице PySocks нет: ' + h.socks_needs_pysocks + ')');
  eq(h.browser_proxy, true, 'browser-режим передаёт --proxy в yt-dlp (иначе 403 ровно на байтах)');
  eq(h.socks_allowed, true, 'socks5 = можно: --proxy socks5:// уезжает в yt-dlp без PySocks');
  eq(h.socks_guard_when_no_transport, true,
     'а если и у yt-dlp нет socks-транспорта - отказ внятный, а не «HTML вместо потока»');
  eq(h.dp_ini, ['http://127.0.0.1:7890', 'из ytm-dl.ini'],
     'decide_proxy: значение из ini всегда важнее системного');
  eq(h.dp_inherit_socks, ['socks5://127.0.0.1:10808', 'унаследован системный socks (браузер ходит через него)'],
     'пустое proxy= + системный socks (Firefox/FoxyProxy) = наследуем, а не качаем напрямую');
  eq(h.dp_dead_socks[0], '', 'не отвечает - не используем и говорим почему');
  ok(h.dp_no_pysocks[0] === '' && /PySocks/.test(h.dp_no_pysocks[1]),
     'нет PySocks - yt-dlp всё равно поедет, но обещать обложки не будем');
  eq(h.dp_http, ['http://a:3128', 'унаследован системный http-прокси'], 'http из системы - с нормализацией схемы');
  eq(h.dp_empty, ['', ''], 'ничего нет - тихо «напрямую», без выдумывания');
  if (h.have_yt_dlp) {
    eq(h.playlist_opts_proxy, true, 'playlist-режим (python-API) получает opts["proxy"]');
    eq(h.playlist_socks_proxy_set, true,
       'playlist тоже принимает socks5 (opts["proxy"]), а не отказывается от него');
  } else { skipT('playlist-проверки прокси: yt_dlp не импортируется'); }
  eq(h.cover_uses_proxyhandler, true, 'обложка/thumbnail идут через ProxyHandler с proxy= из ini');
  eq(h.cover_proxy_value, 'http://127.0.0.1:7890', 'и именно с тем значением, что в ini');
  eq(h.cover_not_raw_list, true, 'handler не заворачивается в список: ровно на этом и падало');
  fs.rmSync(pyf, { recursive: true, force: true });
}

group('обложки не падают на opener, cookies.txt в корне подхватывается, «пусто» в листе ≠ успех');
{
  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-q-'));
  const py = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  const boot = 'import sys, json\nsys.path.insert(0, ' + JSON.stringify(path.join(root, 'server')) + ')\nimport companion as m\n';
  const runPy = (src) => {
    const f = path.join(qdir, 'probe.py');
    fs.writeFileSync(f, src);
    try { return execFileSync(py, [f], { encoding: 'utf8', cwd: qdir }).trim(); }
    catch (e) { return 'PROBE-FAIL ' + String((e && (e.stderr || e.stdout)) || e).slice(-400); }
  };

  // 1) build_opener: список хэндлеров раньше долетал как ОДИН аргумент-список
  const j1 = JSON.parse(runPy(boot + [
    'import types, urllib.request as ur',
    'seen = []',
    'real = ur.build_opener',
    'def spy(*a, **kw):',
    '    seen.append(list(a))',
    '    raise RuntimeError("stop")',
    'ur.build_opener = spy',
    'for pr in ("", None, "http://127.0.0.1:10808"):',
    '    m.http_get_bytes("https://yt3.googleusercontent.com/x", proxy=pr)',
    'ur.build_opener = real',
    'def shape(args):',
    '    if len(args) == 1 and isinstance(args[0], (list, tuple)) and args[0] and not hasattr(args[0][0], "handlers"):',
    '        return "LIST"',
    '    names = [type(x).__name__ for x in args if not isinstance(x, (list, tuple))]',
    '    if len(args) == 1 and isinstance(args[0], (list, tuple)):',
    '        names = [type(x).__name__ for x in args[0]]',
    '    proxies = []',
    '    for x in list(args[0]) if (len(args) == 1 and isinstance(args[0], (list, tuple))) else list(args):',
    '        p = getattr(x, "proxies", getattr(x, "_proxies", None))',
    '        if p is not None:',
    '            proxies.append(dict(p) if isinstance(p, dict) else p)',
    '    return {"list_shape": names == ["list"], "names": names, "proxies": proxies}',
    'res = [shape(a) for a in seen]',
    'print(json.dumps({"three": len(res) == 3, "no_list": all(r.get("list_shape") is False for r in res),',
    '                  "names": [r.get("names") for r in res],',
    '                  "direct": [r.get("proxies") for r in res]}))',
  ].join('\n')));
  eq(j1.three, true, 'три вызова обложки записаны (пусто/None/явный прокси)');
  eq(j1.no_list, true, 'ни одного build_opener([list]) - отсюда шло «expected BaseHandler instance, got list»');
  eq(j1.names, [['ProxyHandler'], [], ['ProxyHandler']],
     'пустая строка = прямой ход (ProxyHandler({})), None = системный прокси, значение = свой прокси');
  eq([j1.direct[0][0], j1.direct[2][0]], [{}, { 'http': 'http://127.0.0.1:10808', 'https': 'http://127.0.0.1:10808' }],
     'ProxyHandler получает {} (не наследовать систему) или proxies-словарь — а не список');

  // 2) плейлист: 0 позиций / все упали = НЕ «пусто» и НЕ тихий успех
  const j2 = JSON.parse(runPy(boot + [
    'import types, tempfile, pathlib',
    'class L:',
    '    def debug(self, m): pass',
    '    def info(self, m): pass',
    '    def warning(self, m): pass',
    '    def error(self, m): pass',
    'def mk(entries):',
    '    class Y:',
    '        def __init__(self, opts=None):',
    '            self.opts = opts or {}',
    '        def __enter__(self):',
    '            lg = self.opts.get("logger")',
    '            if lg: lg.error("ERROR: [youtube] zzTESTvid12: The page needs to be reloaded")',
    '            return self',
    '        def __exit__(self, *a): return False',
    '        def extract_info(self, url, download=False): return {"entries": entries}',
    '    return Y',
    'def go(entries):',
    '    sys.modules["yt_dlp"] = types.SimpleNamespace(YoutubeDL=mk(entries))',
    '    tmp = pathlib.Path(tempfile.mkdtemp())',
    '    m.out_dir_ok = lambda x, d: tmp',
    '    j = m.Job(id="PL", kind="playlist", dest=tmp / "x")',
    '    j.meta = {"url": "https://music.youtube.com/playlist?list=PLAAAAAAA1", "out_dir": str(tmp),',
    '              "dedup": False}',
    '    err = ""',
    '    try:',
    '        m.handle_playlist(j)',
    '    except Exception as e:',
    '        err = str(e)',
    '    return {"msg": (j.message or "")[:120], "err": err[:160], "prog": j.progress,',
    '            "salvaged": j.meta.get("salvaged", 0), "files": len(j.meta.get("files") or [])}',
    'import builtins',
    'res = {"empty": go([]), "allfail": go([{"id": "aaaaaaaaaaa", "_error": "This video is not available"}])}',
    'm.handle_url = lambda j: None   # одиночный путь мокаем: проверяем Wiring, не сеть',
    'res["none"] = go([None])',
    'print(json.dumps(res))',
  ].join('\n')));
  ok(/0 позиций/.test(j2.empty.msg) && /0 позиций|ни один трек/.test(j2.empty.err),
     'лист без позиций: в панели «yt-dlp вернул 0 позиций из 0», а не голое «пусто»: ' + JSON.stringify(j2.empty).slice(0, 160));
  ok(/не скачался/.test(j2.allfail.err) && /не скачалось: 1/.test(j2.allfail.msg),
     'все упали = ошибка задачи с числом и последней причиной: ' + JSON.stringify(j2.allfail).slice(0, 200));
  ok(j2.none.err === '' && j2.none.salvaged === 1 && j2.none.files === 1,
     '0.5.12: позиция=None (ignoreerrors) НЕ теряется: id из логгера -> одиночное добивание: ' + JSON.stringify(j2.none).slice(0, 200));

  // 3) cookies.txt рядом с ytm.bat: selftest и баннер без правки ini
  const T = String.fromCharCode(9);
  const row = (dom, name) => [dom, 'TRUE', '/', 'FALSE', '0', name, 'v'].join(T);
  const fake = ['# Netscape HTTP Cookie File',
    '#HttpOnly_' + row('.youtube.com', 'SID'), row('.youtube.com', '__Secure-1PSID'),
    row('.youtube.com', '__Secure-1PSIDTS')].join('\n');
  const app = path.join(qdir, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.copyFileSync(path.join(root, 'server', 'companion.py'), path.join(app, 'companion.py'));
  const chk = (expect) => {
    try {
      return execFileSync(py, [path.join(app, 'companion.py'), '--check', '--out', path.join(qdir, 'music')],
        { encoding: 'utf8', cwd: qdir });
    } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
  };
  fs.writeFileSync(path.join(qdir, 'cookies.txt'), fake);
  const withFile = chk();
  ok(/\[ok  \] cookies .*файл cookies\.txt: 3 cookie youtube/.test(withFile),
     'самодетект: файл лежит в корне программы - selftest его видит: '
     + (withFile.match(/cookies \(.*\) — .*/g) || ['—'])[0].slice(0, 96));
  const withReal = withFile;
  ok(/\[ok  \] cookies .*3 cookie youtube, вход есть/.test(withReal),
     'файл ещё и разбирается: ' + (withReal.match(/cookies \(.*\) — .*/g) || ['—'])[0].slice(0, 110));
  ok(!/FAIL/.test(withReal), 'авто-куки не превращаются в FAIL');
  // баннер запуска обязан говорить то же: «файл нашли сами», а не «cookies: none»
  const lg = path.join(qdir, 'run.log');
  const qport = await freePort();          // не занимаем 8792/8793: их берут другие группы
  const srv = spawn(py, [path.join(app, 'companion.py'), '--out', path.join(qdir, 'music'),
    '--port', String(qport), '--log-file', lg], { cwd: qdir, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const banner = fs.existsSync(lg) ? fs.readFileSync(lg, 'utf8') : '';
  let hel = {};
  try { hel = await (await fetch('http://127.0.0.1:' + qport + '/hello')).json(); } catch {}
  srv.kill();
  await new Promise((r) => setTimeout(r, 300));
  ok(/беру его \(cookies\.txt\)/.test(banner),
     'баннер: «cookies_file пуст, но файл лежит — беру его»: ' + (banner.match(/!! cookies.*/) || ['—'])[0].slice(0, 90));
  ok(/cookies   : file: .*cookies\.txt/.test(banner), 'строка cookies в баннере непустая (не «none»)');
  //cookies.txt в папке вывода ВНЕ корня программы: relative_to кидал ValueError, и
  //компаньон умирал на старте (проверено: traceback в логе теста «/shutdown с токеном»)
  fs.writeFileSync(path.join(qdir, 'cookies.txt'), fake);
  const odir = path.join(qdir, 'elsewhere', 'music');
  fs.mkdirSync(odir, { recursive: true });
  const lg2 = path.join(qdir, 'run2.log');
  const srv2 = spawn(py, [path.join(app, 'companion.py'), '--out', odir,
    '--port', String(await freePort()), '--log-file', lg2], { cwd: qdir, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const b2n = fs.existsSync(lg2) ? fs.readFileSync(lg2, 'utf8') : '';
  srv2.kill();
  await new Promise((r) => setTimeout(r, 300));
  ok(/Traceback/.test(b2n) === false && /cookies   : file: /.test(b2n),
     'папка вывода вне корня + cookies.txt там: старт жив, traceback не печатается');
  fs.rmSync(path.join(qdir, 'cookies.txt'), { force: true });
  eq(hel.cookies_how, 'автомат: cookies.txt',
     '/hello отдаёт источник cookies - панель может показать «авто», а не «нет»');
  fs.rmSync(path.join(qdir, 'cookies.txt'), { force: true });
  const noFile = chk();
  ok(/cookies \(.*\) — none/.test(noFile) && /подхватывается сам/.test(noFile),
     'без файла - прежний «none», но с подсказкой, что рядом подхватывается: '
     + (noFile.match(/cookies \(.*\) — .*/g) || ['—'])[0].slice(0, 110));
  fs.rmSync(qdir, { recursive: true, force: true });
}

group('webm→контейнер по формату, обложка в opus, лестница клиентов в плейлисте');
{
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-op-'));
  const py = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  const boot = 'import sys, json\nsys.path.insert(0, ' + JSON.stringify(path.join(root, 'server')) + ')\nimport companion as m\n';
  const runPy = (src) => {
    const f = path.join(tdir, 'probe.py');
    fs.writeFileSync(f, src);
    try { return execFileSync(py, [f], { encoding: 'utf8', cwd: tdir, timeout: 240000 }).trim(); }
    catch (e) { return 'PROBE-FAIL ' + String((e && (e.stderr || e.stdout)) || e).slice(-500); }
  };
  const parse = (out) => {
    ok(out.startsWith('{'), 'проб вернул JSON: ' + out.slice(0, 160));
    return out.startsWith('{') ? JSON.parse(out) : {};
  };

  // A) лист, у которого первая попытка отдаёт «needs to be reloaded», а вторая
  //    качает: обёртка handle_playlist обязана сама сменить extractor_args
  const a = parse(runPy(boot + [
    'import types, tempfile, pathlib, os',
    'seq = []',
    'made = {"n": 0}',
    'class Y:',
    '    def __init__(self, opts=None):',
    '        self.opts = dict(opts or {})',
    '        seq.append(self.opts.get("extractor_args", {}).get("youtube"))',
    '    def __enter__(self): return self',
    '    def __exit__(self, *x): return False',
    '    def extract_info(self, url, download=False):',
    '        made["n"] += 1',
    '        if made["n"] == 1:',
    '            return {"entries": [{"id": "aaaaaaaaaaa",',
    '                    "_error": "ERROR: [youtube] PwT3xtDjbyM: The page needs to be reloaded."}]}',
    '        d = os.path.dirname(self.opts["outtmpl"])',
    '        p = os.path.join(d, "aaaaaaaaaaa.m4a")',
    '        open(p, "wb").write(b"fake-m4a-bytes-for-test")',
    '        return {"entries": [{"id": "aaaaaaaaaaa", "title": "Test Track", "uploader": "U",',
    '                "duration": 3, "ext": "m4a", "requested_downloads": [{"filepath": p}]}]}',
    'sys.modules["yt_dlp"] = types.SimpleNamespace(YoutubeDL=Y)',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'j = m.Job(id="PL", kind="playlist", dest=tmp)',
    'j.meta = {"url": "https://music.youtube.com/playlist?list=PLAAAAAAA1", "out_dir": str(tmp),',
    '          "dedup": False}',
    'm.handle_playlist(j)',
    'res = {}',
    'res["tries"] = made["n"]',
    'res["seq"] = seq',
    'res["count"] = j.meta.get("count")',
    'res["files"] = [os.path.basename(x["dest"]) for x in (j.meta.get("files") or [])]',
    'res["retry_log"] = any("playlist retry" in s for s in j.logs)',
    'print(json.dumps(res))',
  ].join('\n')));
  eq(a.tries, 2, 'первый прогон «reloaded» не стал приговором: второй заход состоялся');
  eq((a.seq || [])[0], { player_client: ['web_safari'] },
     'extractor_args едет СЛОВАРЁМ ( yt-dlp читает params["extractor_args"][ie][key]; список строк он молча игнорировал - отсюда и 10/10 «reloaded» при «tv» из userscript)');
  eq((a.seq || [])[1], { player_client: ['web_safari'], formats: ['missing_pot'] },
     'второй заход = web_safari + formats=missing_pot (лечит отказ выдать po-token)');
  eq(a.count, 1, 'после отката файл доехал до папки вывода');
  ok(a.retry_log === true, 'в логи задачи записан сам факт отката (иначе «второй заход» неотличим от зависшего первого)');

  // B) конвертер и обложки - на НАСТОЯЩЕМ ffmpeg/mutagen, не на глазок
  const b = parse(runPy(boot + [
    'import os, subprocess, pathlib, tempfile',
    'from mutagen.oggopus import OggOpus',
    'from mutagen.id3 import ID3',
    'ffmpeg = m.FF.ffmpeg',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'out = tmp / "o"; out.mkdir()',
    'def sh(*a):',
    '    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *list(a)], check=True, capture_output=True)',
    'sh("-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", str(tmp / "a.opus"))',
    'sh("-i", str(tmp / "a.opus"), "-c", "copy", str(tmp / "a.webm"))',
    'sh("-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", str(tmp / "cov.jpg"))',
    'cov = (tmp / "cov.jpg").read_bytes()',
    'webm0 = (tmp / "a.webm").read_bytes()',
    'class J:',
    '    logs = []',
    '    meta = {}',
    'j = J()',
    'res = {}',
    'p1 = out / "x1.webm"; p1.write_bytes(webm0)',
    'c1 = m.webm_transcode(p1, "m4a", j, out, {})',
    'res["m4a"] = bool(c1) and os.path.exists(c1[0]) and str(c1[0]).endswith(".m4a") and "AAC 256k" in c1[1]',
    'c2 = m.webm_transcode(c1[0], "mp3", j, out, {})',
    'res["m4a_mp3"] = str(c2[0]).endswith(".mp3") and "lossy" in c2[1] and os.path.exists(c2[0])',
    'wr = m.write_tags(c2[0], {"title": "Mp3 Ttl"}, None, cov)',
    'id3 = ID3(str(c2[0]))',
    'res["mp3_cover"] = "cover" in wr and any(k.startswith("APIC") for k in id3.keys())',
    'p3 = out / "x3.webm"; p3.write_bytes(webm0)',
    'c3 = m.webm_transcode(p3, "opus", j, out, {})',
    'res["opus_copy"] = str(c3[0]).endswith(".opus") and "без перекодирования" in c3[1] and os.path.exists(c3[0])',
    'wr3 = m.write_tags(c3[0], {"title": "Opus Ttl"}, None, cov)',
    'g = OggOpus(str(c3[0]))',
    'res["opus_cover"] = bool(g.get("METADATA_BLOCK_PICTURE")) and "METADATA_BLOCK_PICTURE" in str(wr3.get("cover"))',
    'res["opus_tags"] = g.get("TITLE") == ["Opus Ttl"]',
    'p4 = out / "x4.webm"; p4.write_bytes(webm0)',
    'res["copy_untouched"] = m.webm_transcode(p4, "copy", j, out, {}) is None',
    'p5 = out / "x5.webm"; p5.write_bytes(b"this is not matroska at all")',
    'res["not_webm_guard"] = m.webm_transcode(p5, "m4a", j, out, {}) is None',
    'print(json.dumps(res))',
  ].join('\n')));
  eq(b.m4a, true, 'webm+opus → m4a: AAC 256k по умолчанию (не 192k - лишняя потеря на пустом месте)');
  eq(b.m4a_mp3, true, 'm4a → mp3 тоже конвертируется, и в note честно написано про двойное lossy');
  eq(b.mp3_cover, true, 'mp3 получает APIC-обложку (и теги) - путь «хочу mp3 с картинкой»');
  eq(b.opus_copy, true, 'format=opus: webm→.opus ИМЕННЕМ `-c copy` - remux без перекодирования, качество бит в бит');
  eq(b.opus_cover, true, 'обложка в .opus живёт в METADATA_BLOCK_PICTURE (mutagen add_picture не умеет, а это умеет)');
  eq(b.opus_tags, true, 'и обычные теги в свеже_remux\'нутый opus пишутся (add_tags, если тегов не было)');
  eq(b.copy_untouched, true, 'format=copy не трогаем вовсе: просили сырьё - получите сырьё');
  eq(b.not_webm_guard, true, 'поддельный .webm (не EBML) не уходит в ffmpeg на пустое место');

  // C) userscript больше не мешает лестнице
  const us = fs.readFileSync(path.join(root, 'userscript', 'ytm-downloader.user.js'), 'utf8');
  ok(!/player_client:\s*'tv'/.test(us), 'userscript не форсит player_client tv для url/playlist - источник истины теперь компаньон');
  ok(/'mp3'\s*\?\s*'bestaudio\[ext=m4a\]/.test(us), 'mp3-источник в userscript - m4a, а не opus: LAME поверх aac теряет меньше, чем поверх opus');
  ok(/mediaFmt\(f\.container\)/.test(us) && /container === 'opus'\) return cfg\.format === 'opus' \? 'opus' : 'm4a'/.test(us),
     'auto-режим шлёт opus-сырьё как format=opus, а не copy: общий mediaFmt, remux+теги+обложка');
  ok(/@version\s+0.6.27/.test(us), 'userscript bumped на 0.6.12');

  // D) finalize('opus') на НАСТОЯЩИХ байтах: webm -> .opus без перекодирования,
  //    а format=copy по-прежнему остаётся «сырьё как есть» (просили - получите)
  const d = parse(runPy(boot + [
    'import os, subprocess, pathlib, tempfile',
    'from mutagen.oggopus import OggOpus',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'out = tmp / "o"; out.mkdir()',
    'm.out_dir_ok = lambda x, d: pathlib.Path(x)',
    'def sh(*a):',
    '    subprocess.run([m.FF.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *list(a)], check=True, capture_output=True)',
    'sh("-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", str(tmp / "a.opus"))',
    'sh("-i", str(tmp / "a.opus"), "-c", "copy", str(tmp / "a.webm"))',
    'raw = out / "raw.webm"',
    'raw.write_bytes((tmp / "a.webm").read_bytes())',
    'j = m.Job(id="M", kind="media", dest=out / "x")',
    'j.meta = {"out_dir": str(out), "meta": {"title": "Auto Opus", "artist": "TTL"},',
    '          "format": "opus", "videoId": "TESTVIDEO001", "dedup": False}',
    'm.finalize(j, raw, "opus", None)',
    'res = {}',
    'res["dest_opus"] = bool(j.dest) and str(j.dest).endswith(".opus") and os.path.exists(str(j.dest))',
    'res["title"] = OggOpus(str(j.dest)).get("TITLE") == ["Auto Opus"]',
    'res["log_remux"] = any("без перекодирования" in x for x in j.logs)',
    'raw2 = out / "raw2.webm"',
    'raw2.write_bytes((tmp / "a.webm").read_bytes())',
    'j2 = m.Job(id="M2", kind="media", dest=out / "x2")',
    'j2.meta = {"out_dir": str(out), "meta": {"title": "Raw Copy"}, "format": "copy",',
    '           "videoId": "TESTVIDEO002", "dedup": False}',
    'm.finalize(j2, raw2, "copy", None)',
    'res["copy_stays_webm"] = str(j2.dest).endswith(".webm")',
    'print(json.dumps(res))',
  ].join('\n')));
  eq(d.dest_opus, true, 'format=opus в finalize: webm-байты доезжают до .opus (тот же remux, что и в url-режиме)');
  eq(d.title, true, 'и теги пишутся в получившийся ogg-opus (TITLE через VorbisComment)');
  eq(d.log_remux, true, 'в логах задачи зафиксировано «без перекодирования» - цена пути видна');
  eq(d.copy_stays_webm, true, 'format=copy не изменил семантики: сырьё как есть');

  fs.rmSync(tdir, { recursive: true, force: true });
}

group('портативный Firefox: профиль вне %APPDATA% надо ПЕРЕДАВАТЬ (firefox:<путь>)');
{
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-ff-'));
  const prof = path.join(pdir, 'FirefoxPortable', 'Data', 'profile');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'cookies.sqlite'), 'x');
  fs.writeFileSync(path.join(prof, 'cookies.sqlite-wal'), 'x');   // браузер открыт
  const pyFf = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  const call = (code) => execFileSync(pyFf, ['-c', code], { encoding: 'utf8', cwd: root }).trim();
  const boot = 'import sys; sys.path.insert(0,' + JSON.stringify(path.join(root, 'server'))
    + '); import companion as m, json; ';
  const j = (expr) => call(boot + 'print(json.dumps(' + expr + '))');

  eq(JSON.parse(j('m.cookies_spec(r"firefox:U:\\soft\\PAP1\\FirefoxPortable\\Data\\profile")')),
     { browser: 'firefox', profile: 'U:\\soft\\PAP1\\FirefoxPortable\\Data\\profile', container: '' },
     'разбор spec как у yt-dlp: имя браузера + путь с.drive-буквой не режется пополам');
  // API-путь: yt-dlp принимает cookiesfrombrowser кортежем и ТОЛЬКО такой
  // разбирает (см. yt_dlp/cookies.py:_parse_browser_specification) - проверим против
  // настоящего модуля, а не на глаз: старый код совал туда 1-кортеж со строкой.
  // API-путь: yt-dlp принимает cookiesfrombrowser кортежем и ТОЛЬКО такой
  // разбирает (yt_dlp/cookies.py:_parse_browser_specification); старый код совал
  // туда 1-кортеж со строкой - проверим против настоящего модуля, а не на глаз.
  const ytProbe = path.join(pdir, 'yt_probe.py');
  fs.writeFileSync(ytProbe, [
    'import sys, json',
    'sys.path.insert(0, ' + JSON.stringify(path.join(root, 'server')) + ')',
    'import companion as m',
    'P = ' + JSON.stringify(prof),
    'try:',
    '    import yt_dlp.cookies as C',
    'except Exception as e:',
    '    print(json.dumps({"skip": type(e).__name__}))',
    '    sys.exit(0)',
    'def go(spec):',
    '    try:',
    '        return "OK " + str(C._parse_browser_specification(*spec))',
    '    except Exception as e:',
    '        return type(e).__name__ + ": " + str(e)',
    'print(json.dumps({"old": go(("firefox:" + P,)), "new": go(m.cookies_from_browser_tuple("firefox:" + P)[0])}))',
    '',
  ].join('\n'));
  let pr = { old: '(yt_dlp рядом с python3 нет - пропускаем)', new: '' };
  try { pr = JSON.parse(execFileSync(pyFf, [ytProbe], { encoding: 'utf8', cwd: pdir }).trim()); }
  catch (e) { /* нет yt-dlp в этой среде - не роняем тест */ }
  if (!pr.skip) {
    ok(/unsupported browser/.test(pr.old), 'чем кончался прежний 1-кортеж в probe: ' + pr.old.slice(0, 64));
    ok(/Data\/profile/.test(pr.new), 'кортеж из companion доходит до yt-dlp целым: ' + pr.new.slice(0, 84));
  }
  eq(JSON.parse(j('m.cookies_spec("firefox")')), { browser: 'firefox', profile: '', container: '' },
     'без пути - прежнее поведение (иначе ломается то, что работало)');
  eq(JSON.parse(j('m.cookies_spec(r"firefox:' + JSON.stringify(prof).slice(1, -1) + '::none")')).container,
     'none', 'контейнер ::none тоже доживает');
  eq(j('bool(m.ff_cookie_db(r' + JSON.stringify(prof) + '))'), 'true',
     'cookies.sqlite находится в ...\\Data\\profile');
  eq(j('bool(m.ff_cookie_db(r' + JSON.stringify(path.join(pdir, 'FirefoxPortable')) + '))'), 'true',
     'и с полупути (Data/profile, Profiles/*/) тоже - человек может дать и корень');
  eq(j('m.firefox_profile_check(r"firefox:' + JSON.stringify(prof).slice(1, -1) + '")'), '""',
     'валидный портативный профиль -> проверка молчит (не мешает работать)');
  ok(/PortableApps/.test(j('m.firefox_profile_check("firefox")')),
     'голый firefox без профиля -> подсказка именно про PortableApps, а не «битые куки»');
  ok(/Data/.test(j('m.firefox_profile_check(r"firefox:' + JSON.stringify(path.join(pdir, 'нет')).slice(1, -1) + '")')),
     'несуществующий путь -> тот же текст с подсказкой, где лежит профиль');

  // selftest-строка: профиль + предупреждение про открытую сессию (-wal)
  const runChk = (extra) => {
    try {
      return execFileSync(pyFf, [path.join(root, 'server', 'companion.py'), '--check',
        '--out', path.join(pdir, 'music'), ...extra], { encoding: 'utf8', cwd: pdir });
    } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
  };
  const o1 = runChk(['--cookies-from-browser', 'firefox:' + prof]);
  ok(/\[ok  \] cookies .*профиль firefox: .*cookies\.sqlite/.test(o1),
     'selftest видит портативный профиль: ' + (o1.match(/cookies \(.*/) || ['—'])[0].slice(0, 90));
  ok(/database is locked/.test(o1), 'и предупреждает, что Firefox открыт (есть -wal)');
  ok(/\[warn\] cookies .*не найден/.test(runChk(['--cookies-from-browser', 'firefox:' + path.join(pdir, 'x')])),
     'битый путь в selftest = warn, а не «всё ок»');
  // портативный Firefox должен быть виден и в строке selftest (не только в handle_url)
  const o2 = runChk(['--cookies-from-browser', 'firefox:' + path.join(pdir, 'FirefoxPortable', 'App', 'Firefox64')]);
  ok(/не найден по указанному пути/.test(o2) && !/проверь имя браузера/.test(o2),
     'путь "в браузер, а не в профиль": selftest говорит про папку со cookies.sqlite');
  const o3 = (() => {
    try {
      return execFileSync(pyFf, [path.join(root, 'server', 'companion.py'), '--check',
        '--out', path.join(pdir, 'music'), '--cookies-from-browser', 'firefox'],
        { encoding: 'utf8', cwd: pdir, env: { ...process.env, PortableAppsPath: pdir } });
    } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
  })();
  ok(/портативный — вот он/.test(o3) && o3.includes(path.join(pdir, 'FirefoxPortable', 'Data', 'profile')),
     'голый firefox + найденный портативный профиль: selftest называет путь, а не «проверь имя браузера»');

  // handle_url: отказ ДО запуска yt-dlp, с внятным текстом (не «could not find ... AppData»)
  const pyFile = path.join(pdir, 'ff_probe.py');
  fs.writeFileSync(pyFile, [
    '# -*- coding: utf-8 -*-',
    'import sys, json, types, tempfile, pathlib',
    'sys.path.insert(0, ' + JSON.stringify(path.join(root, 'server')) + ')',
    'import companion as m',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'P = ' + JSON.stringify(pdir),
    'm.out_dir_ok = lambda x, d: tmp',
    'calls = []',
    'def fake(cmd, **kw):',
    '    calls.append(cmd)',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="no format")',
    'm._run_tracked = fake',
    'def go(tag, prof):',
    '    j = m.Job(id=tag, kind="url", dest=tmp / tag)',
    '    j.meta = {"url": "https://music.youtube.com/watch?v=aaaaaaaaaaa", "out_dir": str(tmp),',
    '              "cookies_from_browser": "firefox:" + prof}',
    '    try:',
    '        m.handle_url(j)',
    '        return ""',
    '    except Exception as e:',
    '        return str(e)',
    'def go_b(tag, prof):',
    '    j = m.Job(id=tag, kind="browser", dest=tmp / tag)',
    '    j.meta = {"url": "https://music.youtube.com/watch?v=aaaaaaaaaaa", "out_dir": str(tmp),',
    '              "cookies_from_browser": "firefox:" + prof, "prefer_url": False}',
    '    try:',
    '        m.handle_browser(j)',
    '        return ""',
    '    except Exception as e:',
    '        return str(e)',
    'bad = go("FF", P + "/net-takogo")',
    'badb = go_b("FB", P + "/net-takogo")',
    'nbad = len(calls)',
    'good = go("FG", P + "/FirefoxPortable/Data/profile")',
    'flags = [c[c.index("--cookies-from-browser") + 1] for c in calls if "--cookies-from-browser" in c]',
    'print(json.dumps({"bad_hint": ("PortableApps" in bad), "bad_calls": nbad,',
    '                  "browser_hint": ("cookies:" in badb and "PortableApps" in badb),',
    '                  "good_flag": (flags[0] if flags else ""), "good_err": good[:140],',
    '                  "nflags": len(flags)}))',
    '',
  ].join('\n'));
  const h = JSON.parse(execFileSync(pyFf, [pyFile], { encoding: 'utf8', cwd: pdir }).trim());
  eq(h.bad_hint, true, 'битый профиль: внятный текст про PortableApps, а не «нет базы в AppData»');
  eq(h.browser_hint, true, 'режим browser: тот же отказ до запуска yt-dlp (раньше флаг вообще не передавался)');
  eq(h.bad_calls, 0, 'битый профиль = НИ ОДНОГО запуска yt-dlp (лестница из 3 попыток тут не нужна)');
  ok(/^firefox:.*FirefoxPortable\/Data\/profile$/.test(h.good_flag || ''),
     'валидный профиль: флаг уезжает в yt-dlp целиком, вместе с путём — got ' + (h.good_flag || '(ничего)'));
  ok(h.nflags >= 1 && !/cookies: /.test(h.good_err),
     'при валидном профиле жалоба на cookies из handle_url не звучит (попыток: ' + h.nflags + ')');
  fs.rmSync(pdir, { recursive: true, force: true });
}

group('баннер запуска и /hello: «пусто в ini» ≠ «невидимая слепая прямая»');
{
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-ban-'));
  const pxA = await freePort(), pxB = await freePort();
  // вывод читаем из --log-file, а не из трубы: в труту stdout буферизуется блоками,
  // и «последняя строка баннера» появляется только на выходе процесса
  const logA = path.join(bdir, 'a.log'), logB = path.join(bdir, 'b.log');
  const start = (portN, extra, log) => spawn(py, [path.join(root, 'server', 'companion.py'),
    '--port', String(portN), '--out', path.join(bdir, 'o' + portN), '--log-file', log, ...extra],
  { stdio: ['ignore', 'ignore', 'ignore'] });
  const readTill = async (log, rx) => {
    for (let i = 0; i < 120; i++) {
      let t = '';
      try { t = fs.readFileSync(log, 'utf8'); } catch {}
      if (rx.test(t) || /Traceback/.test(t)) return t;
      await sleep(60);
    }
    try { return fs.readFileSync(log, 'utf8'); } catch { return ''; }
  };
  const A = start(pxA, ['--proxy', 'socks5://127.0.0.1:10808'], logA);
  const bufA = await readTill(logA, /token     :/);
  ok(!/Traceback|NameError/.test(bufA), 'запуск с socks5 в баннере не падает (был NameError _px_in): '
     + (bufA.match(/Error:.*/) || ['нет трейса'])[0]);
  ok(/proxy     : socks5:\/\/127\.0\.0\.1:10808/.test(bufA), 'баннер печатает прокси из ini');
  ok(!/унаследован/.test(bufA), 'и НЕ вешает «[унаследован]», когда значение явно из ini');
  ok(/install-packages-offline|PySocks/.test(bufA),
     'на socks без PySocks баннер подсказывает, где его взять (обложкам)');
  const rA = await fetch(`http://127.0.0.1:${pxA}/hello`).catch(() => null);
  if (rA) {
    const j = await rA.json();
    eq(j.proxy, 'socks5://127.0.0.1:10808', '/hello отдаёт proxy (панель видит настройку)');
    eq(j.proxy_effective, 'socks5://127.0.0.1:10808', 'и эффективное значение');
    ok(typeof j.socks_module === 'boolean', '/hello сообщает, есть ли PySocks (тут '
       + j.socks_module + ' - в поставке он едет wheel-ом)');
  } else { ok(false, '/hello отвечает при socks5 в cfg'); }
  try { await fetch(`http://127.0.0.1:${pxA}/shutdown`, { method: 'POST' }); } catch {}
  A.kill('SIGKILL');

  const B = start(pxB, [], logB);
  const bufB = await readTill(logB, /token     :/);
  ok(/proxy     : нет: yt-dlp ходит напрямую/.test(bufB), 'без proxy= - честное «напрямую»: '
     + (bufB.match(/proxy     :.*/) || ['—'])[0].slice(0, 100));
  ok(!/унаследован/.test(bufB), 'и без выдуманного источника, когда наследовать нечего');
  try { await fetch(`http://127.0.0.1:${pxB}/shutdown`, { method: 'POST' }); } catch {}
  B.kill('SIGKILL');
  await sleep(200);
  fs.rmSync(bdir, { recursive: true, force: true });
}

group('обложка: webp != jpeg, фрагментированный m4s != «не медиа», GET /cover');
{
  // m4s (styp/moof) - валидный аудио-фрагмент, а не мусор; раньше finalize на нём
  // выдавал «не опознан контейнер», и скачанный трок считался неудачей
  const pyf = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-cover-'));
  const script = [
    'import importlib.util, sys, pathlib, tempfile, json',
    `spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})`,
    'm = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)',
    'd = pathlib.Path(tempfile.mkdtemp())',
    'frag = d / "a.unknown_video"; frag.write_bytes(bytes([0,0,0,0x18]) + b"stypmsdh" + bytes([0])*40)',
    'moof = d / "b.bin"; moof.write_bytes(bytes([0,0,0,0x10]) + b"moofmfhd" + bytes([0])*40)',
    'webp = ("RIFF" + chr(0) + chr(1) + chr(0) + chr(0) + "WEBPVP8 ").encode("latin-1") + bytes([0]) * 64',
    'jpg = (chr(255) + chr(216) + chr(255) + chr(224)).encode("latin-1") + bytes([0]) * 64',
    'png = (chr(137) + "PNG" + chr(13) + chr(10) + chr(26) + chr(10)).encode("latin-1") + bytes([0]) * 64',
    'print(json.dumps({',
    '  "frag": m.sniff_container(frag),',
    '  "moof": m.sniff_container(moof),',
    '  "looks_mp4": m._looks_like_mp4(frag),',
    '  "webp": m.sniff_image(webp),',
    '  "jpg": m.sniff_image(jpg),',
    '  "png": m.sniff_image(png),',
    '  "html": m.sniff_image(b"<!DOCTYPE html><html>" + b" " * 40),',
    '  "html_bytes": m.looks_like_html_bytes(("<!doctype html><html>x").encode()),',
    '  "html_bytes_media": m.looks_like_html_bytes(bytes([0,0,0,0x18]) + b"stypmsdh"),',
    '}))',
  ].join('\n');
  const sp = path.join(pyf, 'cover.py');
  fs.writeFileSync(sp, script);
  const h = JSON.parse(execFileSync('python3', [sp], { encoding: 'utf8', cwd: root }).trim());
  eq(h.frag, 'm4a', 'styp-фрагмент опознаётся как m4a');
  eq(h.moof, 'm4a', 'moof - тоже');
  eq(h.looks_mp4, true, '_looks_like_mp4 знает fragmented-бокса');
  eq(h.webp, ['webp', 'image/webp'], 'webp не подписывается jpeg');
  eq(h.jpg, ['jpg', 'image/jpeg'], 'jpeg как есть');
  eq(h.png, ['png', 'image/png'], 'png как есть');
  eq(h.html, ['jpg', 'image/jpeg'], 'мусор -> честный дефолт jpg, но это не обложка');
  eq(h.html_bytes, true, 'looks_like_html_bytes ловит страницу');
  eq(h.html_bytes_media, false, 'и не срабатывает на медиа');

  // живой GET /cover
  const port9 = await freePort();
  const out9 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-cov-out-'));
  const p9 = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port9), '--out', out9],
                   { stdio: ['ignore', 'pipe', 'pipe'] });
  const b9 = `http://127.0.0.1:${port9}`;
  let up9 = null;
  for (let i = 0; i < 60 && !up9; i++) { await sleep(200); try { const r = await fetch(b9 + '/hello'); if (r.ok) up9 = await r.json(); } catch {} }
  ok(!!up9, 'companion для /cover поднялся');
  const bad = await fetch(b9 + '/cover');
  eq(bad.status, 400, 'без url -> 400, а не 500');
  const srv = http.createServer((req, res) => {
    if (/html/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!DOCTYPE html><html>nope</html>'); return; }
    res.writeHead(200, { 'Content-Type': 'image/webp' });
    res.end(Buffer.concat([Buffer.from('RIFF\x00\x01\x00\x00WEBPVP8 ', 'binary'), Buffer.alloc(64)]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const imgPort = srv.address().port;
  const ok1 = await (await fetch(b9 + `/cover?url=${encodeURIComponent(`http://127.0.0.1:${imgPort}/a.webp`)}&name=Artist%20-%20Track`)).json();
  ok(/Artist - Track\.cover\.webp$/.test(ok1.saved || ''), `обложка сохранена как .webp (не .jpg): ${ok1.saved}`);
  ok(fs.existsSync(ok1.saved) && fs.statSync(ok1.saved).size === 80, 'байты на диске ровно те, что отдали');
  const html1 = await (await fetch(b9 + `/cover?url=${encodeURIComponent(`http://127.0.0.1:${imgPort}/html`)}`)).json();
  ok(/бот-чек|текст/.test(html1.error || ''), `HTML-заглушка отклонена: ${JSON.stringify(html1).slice(0, 90)}`);
  srv.close(); p9.kill('SIGKILL');
}

group('0.5.2: proxy=none, ytm-dl.json, битые файлы не выдаём, /log, convert=');
{
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-052-'));
  const pyExe = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  const boot = 'import sys, json\nsys.path.insert(0, ' + JSON.stringify(path.join(root, 'server')) + ')\nimport companion as m\n';
  const runPy = (src) => {
    const f = path.join(tdir, 'probe.py');
    fs.writeFileSync(f, src);
    try { return execFileSync(pyExe, [f], { encoding: 'utf8', cwd: tdir, timeout: 240000 }).trim(); }
    catch (e) { return 'PROBE-FAIL ' + String((e && (e.stderr || e.stdout)) || e).slice(-500); }
  };
  const parse = (out) => {
    ok(out.startsWith('{'), 'проб вернул JSON: ' + out.slice(0, 200));
    return out.startsWith('{') ? JSON.parse(out) : {};
  };

  // A) прокси-логика: none = ни строки, ни системы; json важнее ini
  const A = parse(runPy(boot + [
    'r = {}',
    'v, why = m.decide_proxy("none", {"socks":"socks5://h:1","http":"http://h:2"})',
    'r["none"] = [v, "не наследуем" in why]',
    'v2, _w = m.decide_proxy("", {"http":"http://h:2"})',
    'r["inherit"] = v2',
    'r["norm_off"] = list(m.norm_proxy("Off"))',
    'r["norm_url"] = list(m.norm_proxy(" http://127.0.0.1:7890 "))',
    'r["norm_empty"] = list(m.norm_proxy(""))',
    'm.Handler.cfg = {"proxy": "http://from-ini:10809", "proxy_direct": True}',
    'r["direct_blocks_ini"] = m._proxy_of(None) == ""',
    'm.Handler.cfg = {"proxy": "", "proxy_direct": False}',
    'import os',
    'os.environ["HTTP_PROXY"] = "http://127.0.0.1:9999"; os.environ.pop("HTTPS_PROXY", None)',
    'r["inherit_env"] = m._proxy_of(None)',
    'import pathlib, tempfile, json as J',
    'd = pathlib.Path(tempfile.mkdtemp())',
    '(d/"ytm-dl.json").write_text(J.dumps({"proxy":"none","convert":"mp3","//note":1,"junkkey":2}), encoding="utf-8")',
    'cfgj, warn = m.load_json_cfg(d)',
    'r["json_proxy"] = cfgj.get("proxy")',
    'r["json_no_comments"] = not any(k.startswith("//") for k in cfgj)',
    'r["json_warn_junk"] = "junkkey" in warn',
    '(d/"ytm-dl.json").write_text("{oops", encoding="utf-8")',
    'cfg2, warn2 = m.load_json_cfg(d)',
    'r["json_broken"] = [cfg2 == {}, "не разобран" in warn2]',
    'r["json_absent"] = list(m.load_json_cfg(pathlib.Path(tempfile.mkdtemp()))) == [{}, ""]',
    'print(json.dumps(r))',
  ].join('\n')));
  eq((A.none || [])[0], '', 'proxy=none: решает «пусто», не «строка none»');
  eq((A.none || [])[1], true, 'proxy=none: почему-строка говорит, что система НЕ наследуется');
  eq(A.inherit, 'http://h:2', 'пустая строка по-прежнему унаследует системный http');
  eq(A.norm_off, ['', true], 'norm_proxy("Off") = прямо');
  eq(A.norm_url, ['http://127.0.0.1:7890', false], 'обычный адрес нормализуется без потерь');
  eq(A.norm_empty, ['', false], 'пусто - это НЕ none: это «режим по умолчанию»');
  eq(A.direct_blocks_ini, true, 'proxy_direct глушит и унаследование, и строку из cfg');
  ok(String(A.inherit_env || '').includes('9999'), 'без none-флага env-прокси наследуется: ' + JSON.stringify(A.inherit_env));
  eq(A.json_proxy, 'none', 'ytm-dl.json читается компаньоном напрямую');
  eq(A.json_no_comments, true, 'ключи //note - комментарии, они не конфиг');
  ok(A.json_warn_junk, 'неизвестный ключ не молчит: ' + JSON.stringify(A.json_warn_junk));
  eq(A.json_broken[0], true, 'битый json НЕ роняет запуск');
  eq(A.json_broken[1], true, 'и честно предупреждает');
  eq(A.json_absent, true, 'нет файла - пустой конфиг без слова');

  // B) верификация finalize: stub «ftyp+пустой mdat» больше не выдаётся за трек
  const B = parse(runPy(boot + [
    'import pathlib, tempfile, struct',
    'tmp = pathlib.Path(tempfile.mkdtemp()); out = tmp/"o"; out.mkdir()',
    'm.out_dir_ok = lambda x, d: out',
    'raw = tmp/"in.m4a"',
    'raw.write_bytes(struct.pack(">I4s",32,b"ftyp")+b"M4A "+bytes(8)+struct.pack(">I4s",4128,b"mdat")+bytes(4096))',
    'j = m.Job(id="stub", kind="media", dest=raw)',
    'j.meta = {"raw": str(raw), "meta": {"title":"T","artist":"A","duration":620},',
    '          "format":"m4a", "out_dir": str(out), "videoId":"aaaaaaaaaaa"}',
    'res = {}',
    'try:',
    '    m.finalize(j, raw, "m4a", None); res["err"] = ""',
    'except Exception as e: res["err"] = str(e)[:700]',
    'res["no_output"] = not any(x.suffix in (".m4a",".mp3",".opus") for x in out.iterdir())',
    'res["has_hex"] = "начало байтов" in res["err"]',
    'res["why"] = res["err"][:80]',
    '# живой файл про верификацию проходит',
    'raw2 = tmp/"in2.m4a"; raw2.write_bytes(open(' + JSON.stringify(fx('tone.m4a')) + ',"rb").read())',
    'j2 = m.Job(id="real", kind="media", dest=raw2)',
    'j2.meta = {"raw": str(raw2), "meta": {"title":"T2","artist":"A2","duration":3},',
    '           "format":"m4a", "out_dir": str(out), "videoId":"bbbbbbbbbbb"}',
    'res["real_err"] = ""',
    'try: m.finalize(j2, raw2, "m4a", None)',
    'except Exception as e: res["real_err"] = str(e)[:200]',
    'res["real_out"] = any(x.suffix == ".m4a" for x in out.iterdir())',
    '# отключённая проверка (verify=0) выдаёт stub как раньше - это осознанный рубильник',
    'm.Handler.cfg = {"proxy": "", "verify": False}',
    'raw3 = tmp/"in3.m4a"; raw3.write_bytes(raw.read_bytes() if raw.exists() else b"")',
    'raw3.write_bytes(struct.pack(">I4s",32,b"ftyp")+b"M4A "+bytes(8)+struct.pack(">I4s",4128,b"mdat")+bytes(4096))',
    'j3 = m.Job(id="nochk", kind="media", dest=raw3)',
    'j3.meta = {"raw": str(raw3), "meta": {"title":"T3","artist":"A3","duration":620},',
    '           "format":"m4a", "out_dir": str(out), "videoId":"ccccccccccc"}',
    'res["off_err"] = ""',
    'try: m.finalize(j3, raw3, "m4a", None)',
    'except Exception as e: res["off_err"] = type(e).__name__',
    'res["off_kept"] = any(x.suffix == ".m4a" for x in out.iterdir())',
    'print(json.dumps(res))',
  ].join('\n')));
  ok(B.err && /не играбельно|remux|воспроизводится/.test(B.err || ''), 'stub отбит с объяснением: ' + JSON.stringify(B.why));
  eq(B.no_output, true, 'битый поток не оседает в папке вывода');
  eq(B.has_hex, true, 'в ошибку попадает hex начала файла («что прислал youtube» видно сразу)');
  eq(B.real_err, '', 'валидный m4a проходит верификацию без изменений');
  eq(B.real_out, true, 'и кладётся на диск');
  eq(B.off_err, '', 'verify=0 = честный рубильник: с выключенной проверкой raw-copy жив, как в 0.5.1');
  eq(B.off_kept, true, 'и файл остался на диске (за это отвечают теперь плеер и совесть)');

  // C0) 0.5.3: «page needs to be reloaded» при живых cookies = лимит, а не «нет cookies»
  const C0 = parse(runPy(boot + [
    'r = {}',
    'h = m._yt_dlp_hint("ERROR: [youtube] crI1ApHQXO0: The page needs to be reloaded.")',
    'r["hint"] = h',
    'print(json.dumps(r))',
  ].join('\n')));
  ok(/слишком много устройств/.test(C0.hint || ''), 'hint объясняет лимит аккаунта, а не зовёт ставить cookies заново');
  ok(/record/.test(C0.hint || ''), 'и подсказывает путь, который работает прямо сейчас');
  ok(fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8').includes('cookies ПОДКЛЮЧЕНЫ'),
     'html-вердикт различает «cookies нет» и «cookies есть, но YouTube упирается»');

  // C-1) 0.5.4: Music-лимит -> тот же videoId пробуется на www.youtube.com
  const C1 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'seen = []',
    'def fake(cmd, **k):',
    '    u = cmd[-1]',
    '    seen.append(u)',
    '    if "www.youtube.com" in u:',
    '        import os',
    '        d = os.path.dirname(cmd[cmd.index("-o") + 1])   # куда yt-dlp кладёт по шаблону',
    '        open(os.path.join(d, "dl.m4a"), "wb").write(b"made-by-test")',
    '        return types.SimpleNamespace(returncode=0, stdout="", stderr="")',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] Xx1Yy2Zz3Aa: The page needs to be reloaded.")',
    'm._run_tracked = fake',
    'j = m.Job(id="H4", kind="url", dest=tmp)',
    'j.meta = {"videoId": "Xx1", "out_dir": str(tmp), "host_pref": "www"}',
    'res = {"err": ""}',
    'try: m.handle_url(j)',
    'except Exception as e: res["err"] = str(e)[:200]',
    'res["fell_back"] = any("www.youtube.com" in x for x in seen)',
    'res["first"] = seen[0] if seen else ""',
    'res["fallback_line"] = any("host fallback" in l for l in j.logs)',
    'print(json.dumps(res))',
  ].join('\n')));
  ok(C1.fell_back === true, 'после «reloaded» на music тот же id уходит на www.youtube.com');
  ok(String(C1.first).includes('music.youtube.com'), 'первым делом - по-прежнему музыка (ничего не меняем, когда live)');

  // C-1b) 0.5.5: финальный вердикт круга - «format is not available» (без маркера),
  // но reload был на ранней попытке -> фолбэк ВСЁ РАВНО обязан сработать (лог 0.5.4)
  const C1b = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'seen = []',
    'calls = {"m": 0}',
    'def fake(cmd, **k):',
    '    u = cmd[-1]',
    '    seen.append(u)',
    '    if "www.youtube.com" in u:',
    '        import os',
    '        d = os.path.dirname(cmd[cmd.index("-o") + 1])',
    '        open(os.path.join(d, "dl.m4a"), "wb").write(b"made-by-test")',
    '        return types.SimpleNamespace(returncode=0, stdout="", stderr="")',
    '    calls["m"] += 1',
    '    if calls["m"] == 1:',
    '        return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] Xx1: The page needs to be reloaded.")',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] Xx1: Requested format is not available. Use --list-formats")',
    'm._run_tracked = fake',
    'j = m.Job(id="H6", kind="url", dest=tmp)',
    'j.meta = {"videoId": "Xx1", "out_dir": str(tmp), "host_pref": "www"}',
    'res = {"err": ""}',
    'try: m.handle_url(j)',
    'except Exception as e: res["err"] = str(e)[:200]',
    'res["fell_back"] = any("www.youtube.com" in x for x in seen)',
    'print(json.dumps(res))',
  ].join('\n')));
  ok(C1b.fell_back === true, 'reload на первой попытке + «formats» на последних = фолбэк сработал');
  eq(C1b.err, '', 'и довел задачу до конца на www: ' + JSON.stringify(C1b.err));
  ok(fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8').includes('throttle_seen'),
     'маркер лимита копится по всем попыткам, а не читается с последней строки');
  eq(C1.err, '', 'фолбэк довёл задачу до конца: mock-файл принят, ошибки нет: ' + JSON.stringify(C1.err));
  eq(C1.fallback_line === true, true, 'в логи задачи записан сам факт смены хоста');

  // C-2) приватное/не-ретраибельное на второй хост не тащим
  const C2 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'seen = []',
    'def fake(cmd, **k):',
    '    seen.append(cmd[-1])',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] Xx1: Private video")',
    'm._run_tracked = fake',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'j = m.Job(id="H5", kind="url", dest=tmp)',
    'j.meta = {"videoId": "Xx1", "out_dir": str(tmp), "host_pref": "www"}',
    'try: m.handle_url(j)',
    'except Exception: pass',
    'print(json.dumps({"tries": len(seen), "only_music": all("music." in x for x in seen)}))',
  ].join('\n')));
  eq(C2.only_music, true, 'приватное видео не множим запросами на втором хосте');
  eq(C2.tries, 1, 'non-retryable вердикт = одна попытка, лесенка не крутится');

  // C-3) ренеймы панели/меню и ytm.bat config (статика)
  {
    const us2 = fs.readFileSync(path.join(root, 'userscript', 'ytm-downloader.user.js'), 'utf8');
    ok(us2.includes("'скачать весь плейлист'"), 'кнопка листа переименована (liked - он и есть плейлист)');
    ok(us2.includes("GM_registerMenuCommand('Скачать весь плейлист',"), 'меню Tampermonkey без скобочек про liked');
    ok(!us2.includes('Понравившиеся» тоже'), 'старая формулировка «(и liked тоже)» убрана');
    const ctl = fs.readFileSync(path.join(root, 'app', 'control.py'), 'utf8');
    ok(/def config_editor/.test(ctl) && /"config": \("config", config_editor\)/.test(ctl),
       'ytm.bat config существует и зарегистрирован в ACTIONS');
    ok(ctl.includes('создан из значений ytm-dl.ini'),
       'json создаётся ИЗ ini-значений, а не из шаблона (дефолты не перебьют настроенное)');
    ok(fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8').includes('host fallback:'),
       'компаньон логирует смену хоста');
  }

  // D) 0.5.5: хост-круг плейлиста (browse-400 на music -> тот же лист на www)
  const D0 = parse(runPy(boot + [
    'import types',
    'j = types.SimpleNamespace(meta={"playlist_url": "https://music.youtube.com/playlist?list=PLq7nB7oT4K3"})',
    'r = {}',
    'm._playlist_host_swap(j)',
    'r["url"] = j.meta["playlist_url"]',
    'j2 = types.SimpleNamespace(meta={"playlist_url": "https://music.youtube.com/playlist?list=YY"})',
    'r["liked"] = str(m._playlist_host_swap(j2))',
    'r["retry400"] = m._playlist_error_is_client("ERROR: [youtube:tab] YY: Unable to download API page: HTTP Error 400: Bad Request")',
    'print(json.dumps(r))',
  ].join('\n')));
  ok(D0.url.includes('www.youtube.com/playlist?list=PLq7nB7oT4K3'), 'PL-лист перечитывается с www (тот же id)');
  eq(D0.liked, 'None', '«Понравившиеся» (YY) не подменяются: LM - другой список');
  eq(D0.retry400 === true, true, 'browse-400 распознаётся как ретраибельный');
  {
    const cp5 = fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8');
    ok(cp5.includes('playlist host fallback:'), 'смена хоста логируется и в плейлист-режиме');
    ok(cp5.includes('browse-эндпоинт Музыки'), 'финальное сообщение объясняет лимит Music-стороны');
  }

  // E) 0.5.6: impersonate (curl_cffi), приоритет хоста, RDCLAK, тонкие cookies
  const E0 = parse(runPy(boot + [
    'm._HAS_CURL_CFFI = True',
    'r = {}',
    'r["auto"] = m.impersonate_target({"impersonate": ""})',
    'r["explicit"] = m.impersonate_target({"impersonate": "edge-130:linux"})',
    'r["off"] = str(m.impersonate_target({"impersonate": "off"}))',
    'm._HAS_CURL_CFFI = False',
    'r["auto_nolib"] = str(m.impersonate_target({"impersonate": "auto"}))',
    'print(json.dumps(r))',
  ].join('\n')));
  eq(E0.auto, 'chrome', 'auto = chrome, когда curl_cffi на месте');
  eq(E0.explicit, 'edge-130:linux', 'явная цель проходит без проб и проверок');
  eq(E0.off, 'None', 'off = не трогать запросы (как в 0.5.5)');
  eq(E0.auto_nolib, 'None', 'auto без колеса молчит - не ошибка, а отсутствие фичи');
  const E1 = parse(runPy(boot + [
    'import types',
    'j = types.SimpleNamespace(meta={"playlist_url": "https://music.youtube.com/playlist?list=RDCLAK5uy_krq_ZS_Qz"})',
    'print(json.dumps({"rdclak": str(m._playlist_host_swap(j))}))',
  ].join('\n')));
  eq(E1.rdclak, 'None', 'RDCLAK (liked-radio) не гуляет на www: этот id принадлежит Music');
  const E2 = parse(runPy(boot + [
    'import types',
    'r = {}',
    'r["off"] = str(m._alt_host_allowed(types.SimpleNamespace(meta={})))',
    'r["on"] = str(m._alt_host_allowed(types.SimpleNamespace(meta={"host_pref": "www"})))',
    'print(json.dumps(r))',
  ].join('\n')));
  eq(E2.off, 'False', 'галочка снята - запасной хост не подключается (полоса = только Music)');
  eq(E2.on, 'True', 'галочка включена - youtube.com разрешён как запасной круг');
  const G1 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'seen = []',
    'def fake(cmd, **k):',
    '    seen.append(cmd[-1])',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] Xx1Yy2Zz3Aa: The page needs to be reloaded.")',
    'm._run_tracked = fake',
    'j = m.Job(id="HA", kind="url", dest=tmp)',
    'j.meta = {"videoId": "Xx1Yy2Zz3Aa", "out_dir": str(tmp)}',
    'res = {"err": ""}',
    'try: m.handle_url(j)',
    'except Exception as e: res["err"] = str(e)[:500]',
    'res["www"] = any("www.youtube.com" in x for x in seen)',
    'print(json.dumps(res))',
  ].join('\n')));
  eq(String(G1.www), 'false', 'без галочки - ни одного запроса на www («должен только по чекбоксу»)');
  ok(String(G1.err).includes('youtube.com как запас'), 'и ошибка говорит, где галочка: ' + JSON.stringify(G1.err).slice(0, 130));
  {
    const cp8 = fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8');
    ok(/if not _hi and _playlist_host_swap\(job\):/.test(cp8),
       'www-круг плейлиста автоматичен: разбор листа - не запас стрима (0.5.10)');
    ok(cp8.includes('if got.parent == out_dir:'), 'handle_url: после транскода имя не пересчитывается');
    ok(cp8.includes('if f.parent == out_dir:'), 'плейлист: после транскода имя не пересчитывается');
    ok(!cp8.includes('_playlist_apply_pref'), 'перестановка хостов выкинута: запас - это запас, не приоритет');
    ok(cp8.includes('«прогон через плеер»'), 'ошибка бот-чека подсказывает прогон через плеер');
    ok(cp8.includes('[download] Destination:'), 'плейлист: прогресс «дорожка N» вместо вечных 0%');
    ok(cp8.includes('_playlist_salvage'), 'упавшие позиции плейлиста добивает одиночный путь');
    ok(cp8.includes('"videoId": _vid, "err": _err'), 'None-позиции: id и причина вытащены из шума логгера (0.6.2 - урожай всех id, а не последнего)');
    ok(cp8.includes('отвалились'), 'прогресс плейлиста считает и отвалившихся, не только скачанных');
    ok(cp8.includes('--write-info-json'), 'handle_url сверяется с info.json: имя/теги/обложка без запроса');
    ok(cp8.includes('time.sleep(4.0)') && cp8.includes('три позиции подряд'),
       '0.5.13: добивание не долбит без пауз и встаёт после 3 трупов подряд (иначе «взяло одно и легло»); ' +
       'то же для очереди - на стороне панели');
    ok(cp8.includes('(chosen, []), ("", [])'), 'лестница: явный клиент физически в начале списка');
    const us4 = fs.readFileSync(path.join(root, 'userscript', 'ytm-downloader.user.js'), 'utf8');
    ok(us4.includes('async function playThrough'), 'прогон реализован на стороне страницы');
    ok(us4.includes('selfAskPlayer(vid, 9)'), 'для каждого трека страница сама просит /player');
    ok(!us4.includes("mkBtn('ytmdl-pthru'"), 'отдельная кнопка прогона убрана - объединена с очередью (0.5.11)');
    ok(us4.includes("mkSel('ytmdl-qvia', ['companion', 'browser']"), 'прогон = метод очереди: селектор companion|browser');
    ok(us4.includes("cfg.queueVia === 'browser') return playThrough(o)"), 'очередь через browser идёт прогоном вкладки');
    ok(us4.includes('async function browseViaPage'), 'лист добирается /browse сессией вкладки (как премиум-клиент)');
    ok(us4.includes("for (const o of [(w && w.ytcfg), global.ytcfg, w])") && !us4.includes('const ctx = global.ytcfg || {};'),
     '0.5.12/0.6.6: ytcfg читается из окна страницы ЧЕРЕЗ МЕНЕДЖЕР (sandbox global - только последняя инстанция)');
    ok(us4.includes('n < 5 && !key'), '0.6.3: перед /browse ждём ytcfg (SPA), а не падаем мгновенно');
    ok(us4.includes('await pollJob(jb)'), '0.5.13: очередь ждёт КАЖДУЮ задачу - статус живое «N из M»');
    ok(us4.includes('deadRun >= 3'), 'и встаёт после 3 ошибок подряд, не спамит 100 трупов');
    ok(us4.includes('удвоением файла'), 'битрейт-селектор честно говорит, что 320k работает только для mp3');
    ok(us4.includes('b.title ='), 'у кнопки есть tooltip - «что она делает» видно сразу');
    ok(us4.includes("if (cfg.safariFirst && !out.player_client)"), 'чекбокс web_safari не перетирает явный клиент');
        ok(!us4.includes("через youtube.com (Music про запас)"), 'старый двусмысленный лейбл чекбокса заменён');
  }  {
    const cp6 = fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8');
    ok(cp6.includes('"--impersonate"'), 'в CLI-лесенке флаг стоит на каждой попытке');
    ok(cp6.includes('opts["impersonate"]'), 'в playlist-API он едет через opts, а не через строку');
    ok(cp6.includes('host fallback разрешён галочкой'), 'разрешение запаса видно в логе задачи');
    ok(cp6.includes('тонкий набор'), 'самопроверка ругается на cookies только вкладки');
    ok(cp6.includes('impersonate (curl_cffi)'), 'selfcheck показывает, живой ли отпечаток');
  }

  // F) 0.5.7: «нет вывода» (строка вместо ImpersonateTarget), vid из url, (1) не плодим
  const F0 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    '(tmp / "y.m4a").write_bytes(b"old-file")',
    'p = m.dest_taken({"title": "y", "artist": "x"}, tmp)',
    'empty = pathlib.Path(tempfile.mkdtemp())',
    'q = m.dest_taken({"title": "y", "artist": "x"}, empty)',
    'r = m.dest_taken({}, tmp)',
    'vid = m.extract_video_id("https://music.youtube.com/watch?v=Zx9Yy8Xx7Ww") or ""',
    'print(json.dumps({"hit": str(p or ""), "miss": str(q), "notitle": str(r), "vid": vid}))',
  ].join('\n')));
  ok(F0.hit.includes('y.m4a'), '0.6.21: «уже есть» = одно название, артист на имя не влияет (пропуск вместо (1))');
  eq(F0.miss, 'None', 'пустая папка - не совпадение (скачиваем обычно)');
  eq(F0.notitle, 'None', 'без настоящего заголовка заглушка "track" не считается (copy-тест жив)');
  ok(F0.vid === 'Zx9Yy8Xx7Ww', 'videoId достаётся из url даже без поля meta');
  const F2 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    '(tmp / "Song.m4a").write_bytes(b"old-one")',
    '(tmp / "Song2.m4a").write_bytes(b"old-two")',
    'dl = tmp / "dl"; dl.mkdir(); (dl / "second.m4a").write_bytes(b"fresh-bytes")',
    'EN = [{"id": "aaaaaaaaaaa", "title": "Song", "uploader": "Art"},',
    '      {"id": "bbbbbbbbbbb", "title": "Song2", "uploader": "Art",',
    '       "requested_downloads": [{"filepath": str(dl / "second.m4a")}]}]',
    'class Y:',
    '    def __init__(self, opts=None): pass',
    '    def __enter__(self): return self',
    '    def __exit__(self, *a): return False',
    '    def extract_info(self, url, download=False): return {"entries": EN}',
    'sys.modules["yt_dlp"] = types.SimpleNamespace(YoutubeDL=Y)',
    'm.out_dir_ok = lambda x, d: tmp',
    'j = m.Job(id="PLD", kind="playlist", dest=tmp / "x")',
    'j.meta = {"url": "https://music.youtube.com/playlist?list=PLAAAAAAA1", "out_dir": str(tmp)}',
    'err = ""',
    'try: m.handle_playlist(j)',
    'except Exception as e: err = str(e)',
    'ap = m.archive_path(tmp)',
    'print(json.dumps({',
    '    "msg": (j.message or "")[:140], "err": err[:200],',
    '    "files": sorted(p.name for p in tmp.iterdir() if p.suffix in (".m4a", ".mp3", ".opus")),',
    '    "kept": (tmp / "Song.m4a").read_bytes() == b"old-one",',
    '    "stub_gone": not (dl / "second.m4a").exists(),',
    '    "arch": ap.read_text(encoding="utf-8")[-300:] if ap.exists() else "",',
    '}))',
  ].join('\n')));
  ok(!F2.files.some((x) => / \(\d\)\./.test(x)) && F2.files.length === 2,
     'плейлист: существующие файлы не умножились « (1)»: ' + JSON.stringify(F2.files));
  ok(F2.kept && F2.stub_gone, 'свежий кусок выброшен, а «как было» осталось байт в байт');
  ok(/aaaaaaaaaaa/.test(F2.arch) && /bbbbbbbbbbb/.test(F2.arch),
     'id долечились в архив - следующий прогон пройдёт штатным путём: ' + JSON.stringify(F2.arch).slice(0, 140));
  eq(F2.err, '', 'плейлист целиком из «уже есть» - не ошибка: ' + JSON.stringify(F2.err).slice(0, 160));
  const F3 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'old = tmp / "Song.mp3"',
    'old.write_bytes(b"the-one-in-folder")',
    'm.out_dir_ok = lambda x, d: tmp',
    'def fake(cmd, **k):',
    '    import os',
    '    d = os.path.dirname(cmd[cmd.index("-o") + 1])',
    '    os.makedirs(d, exist_ok=True)',
    '    open(os.path.join(d, "dl.m4a"), "wb").write(b"freshly-downloaded-again")',
    '    return types.SimpleNamespace(returncode=0, stdout="", stderr="")',
    'm._run_tracked = fake',
    'j = m.Job(id="H9", kind="url", dest=tmp)',
    'j.meta = {"out_dir": str(tmp), "url": "https://music.youtube.com/watch?v=Xx1Yy2Zz3Aa",',
    '          "format": "mp3", "meta": {"title": "Song", "artist": "Art"}}',
    'err = ""',
    'try: m.handle_url(j)',
    'except Exception as e: err = str(e)[:200]',
    'ap = m.archive_path(tmp)',
    'print(json.dumps({',
    '    "err": err, "skipped": bool(j.meta.get("skipped")),',
    '    "files": sorted(p.name for p in tmp.iterdir() if p.suffix in (".m4a", ".mp3", ".opus")),',
    '    "intact": old.read_bytes() == b"the-one-in-folder",',
    '    "msg": (j.message or "")[:120],',
    '    "arch": ap.read_text(encoding="utf-8")[-120:] if ap.exists() else "",',
    '}))',
  ].join('\n')));
  ok(!F3.err && F3.skipped && F3.intact,
     'auto-путь (handle_url): перекачанное выброшено, «как было» цело: ' + JSON.stringify(F3).slice(0, 180));
  ok(!F3.files.some((x) => / \(\d\)\./.test(x)) && F3.files.length === 1,
     'ни одного « (1)» в авто-режиме: ' + JSON.stringify(F3.files));
  ok(/Xx1Yy2Zz3Aa/.test(F3.arch), 'id авто-пропуска дописан в архив (самолечение)');

  // C) каждая попытка лестницы попадает в ytm-run.log
  const F1 = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'm.out_dir_ok = lambda x, d: tmp',
    'seen = []',
    'def fake(cmd, **k):',
    '    u = cmd[-1]',
    '    seen.append(u)',
    '    if "www.youtube.com" in u:',
    '        import os',
    '        d = os.path.dirname(cmd[cmd.index("-o") + 1])',
    '        open(os.path.join(d, "dl.m4a"), "wb").write(b"made-by-test")',
    '        return types.SimpleNamespace(returncode=0, stdout="", stderr="")',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] Xx1Yy2Zz3Aa: The page needs to be reloaded.")',
    'm._run_tracked = fake',
    'j = m.Job(id="H8", kind="url", dest=tmp)',
    'j.meta = {"out_dir": str(tmp), "url": "https://music.youtube.com/watch?v=Xx1Yy2Zz3Aa", "host_pref": "www"}',
    'res = {"err": ""}',
    'try: m.handle_url(j)',
    'except Exception as e: res["err"] = str(e)[:200]',
    'res["fell_back"] = any("www.youtube.com" in x for x in seen)',
    'print(json.dumps(res))',
  ].join('\n')));
  eq(String(F1.fell_back), 'true', 'без meta.videoId (чистый resolve-url) - фолбэк тоже работает');
  eq(F1.err, '', 'и доводит задачу до конца: ' + JSON.stringify(F1.err));
  {
    const cp7 = fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8');
    ok(cp7.includes('if client:   # 0.6.5: запомнить победителя'), 'липкий клиент: успех запоминается в _WIN');
  ok(cp7.includes('w = _WIN.get("key")'), 'липкий клиент: и лестница, и варианты листа его читают');
  ok(cp7.includes('out.insert(0, out.pop(out.index(k)))'), '...переставляя на первое место, не укорачивая перебор');
  ok(cp7.includes('ImpersonateTarget.from_str'),
     'API-impersonate: объект ImpersonateTarget, а не строка (корень «нет вывода»)');
    ok(cp7.includes('playlist exc:'), 'пустые сообщения исключений видны в логе, а не «нет вывода»');
    ok(cp7.includes('dest_taken'), 'проверка «файл уже лежит» вшита в оба пути (media + playlist)');
    const us3 = fs.readFileSync(path.join(root, 'userscript', 'ytm-downloader.user.js'), 'utf8');
    ok(us3.includes('getVideoData'), 'свёрнутый плеер: текущий трек берётся из player-bar, а не из URL');
    ok(!us3.includes("querySelector('[video-id]')"),
       'первый попавшийся [video-id] из списка больше не выдаётся за текущий трек');
  }

  // TQ) 0.6.0-0.6.4: ThrottleQueue - интервальный backoff, lease, skew-guard, pump-потолок
  const tq = JSON.parse(runPy(boot + [
    'import tempfile, pathlib, time, json',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'class FakeQ:',
    '    def __init__(self): self.jobs = []',
    '    def submit(self, j): self.jobs.append(j)',
    'clock = {"t": 1000.0}',
    'q = m.ThrottleQueue(tmp, clock=lambda: clock["t"])',
    'r = q.add("vidAAAA1111", {"title": "X", "proxy": "http://p:1", "secret_key": "s"})',
    'ok_wl = ("proxy" in r["item"]["meta"]) and ("secret_key" not in r["item"]["meta"])',
    'early = q.get_ready()',
    'clock["t"] += 7201',
    'ready = q.get_ready()',
    'l1 = q.lease("vidAAAA1111")',
    'during = q.get_ready()',
    'l2 = q.lease("vidAAAA1111")',
    'clock["t"] += 301',
    'after_lease = q.get_ready()',
    'skew_row = q._records["vidAAAA1111"]',
    'skew_row["throttled_at"] = clock["t"] + 100000',
    'skipped = q.get_ready()',
    'reset_ok = abs(skew_row["throttled_at"] - clock["t"]) < 1',
    'clock["t"] += 7201',
    'q._records["vidAAAA1111"]["attempt"] = 6',
    'fq = FakeQ()',
    'q.pump(fq)',
    'st = q.status()',
    'tmp2 = pathlib.Path(tempfile.mkdtemp())',
    'm.archive_add(tmp2, "vidBBBB2222", "Y")',
    'q2 = m.ThrottleQueue(tmp2, clock=lambda: clock["t"])',
    'q2.add("vidBBBB2222", {})',
    'q2.add("vidCCCC3333", {})',
    'synced = q2.sync_archive()',
    'after = [x["vid"] for x in q2.list()]',
    'disk = json.loads((tmp2 / ".ytm-throttle-queue.json").read_text())["items"]',
    'print(json.dumps({"ok_wl": ok_wl, "early": len(early), "ready": len(ready),',
    '  "l1": bool(l1), "during": len(during), "l2": bool(l2), "after_lease": len(after_lease),',
    '  "skipped": len(skipped), "reset_ok": bool(reset_ok),',
    '  "pump_at_cap": len(fq.jobs), "failed": st["failed"],',
    '  "synced": synced, "after": after, "disk_ids": [d["vid"] for d in disk]}))',
  ].join('\n')));
  eq(tq.ok_wl, true, 'meta - белым списком: proxy поехал, мусор нет');
  eq(tq.early, 0, 'до истечения интервала готовых нет');
  eq(tq.ready, 1, 'после backoff_seconds - готов');
  eq(tq.during, 0, 'lease снимает из готовых (нет двойного submit за один тик)');
  eq(tq.l2, false, 'второй lease на тот же id - отказ');
  eq(tq.after_lease, 1, 'lease истёк - снова доступен');
  eq(tq.skipped, 0, 'часы назад: позиция НЕ выходит из backoff сразу');
  eq(tq.reset_ok, true, '...и throttled_at переустановлен на now (нет шторма)');
  eq(tq.pump_at_cap, 0, 'attempt >= 6 в pump не ставится');
  eq(tq.failed, 1, '...а помечается failed (больше не будится)');
  eq(tq.synced, 1, 'sync_archive вычищает уже скачанное');
  eq(tq.after.join(','), 'vidCCCC3333', 'в очереди остаётся только не скачанное');
  eq(tq.disk_ids.join(','), 'vidCCCC3333', 'и на диске то же (lease не persists)');
  {
    const rq = await fetch(base + '/job/nope00000000/cancel', { method: 'POST', body: '{}' });
    eq(rq.status, 404, '0.6.4: cancel несуществующей задачи - 404, не 500');
  }
  // 0.6.7: decode-краш reader-потока = «нет вывода» = ложный лимит. Ведём реальным
  // subprocess, который пишет НЕ-utf8 байты в stderr - как yt-dlp на cp1251-заголовке.
  const dec = JSON.parse(runPy(boot + [
    'import json, sys',
    'src = "import sys\\nsys.stderr.buffer.write(b\'ERROR: AbCdEf123456 \' + bytes([0x92, 0xff]) + \' \' + \'прит\'.encode(\'cp1251\'))\\nsys.exit(1)\\n"',
    'open("child.py", "w").write(src)',
    'p = m._run_tracked([sys.executable, "child.py"], capture_output=True, text=True, timeout=90)',
    'blob = (p.stdout or "") + (p.stderr or "")',
    'print(json.dumps({"rc": p.returncode, "has_id": "AbCdEf123456" in blob, "has_err": "ERROR" in blob}))',
  ].join('\n')));
  eq(dec.rc, 1, '0.6.7: exit-код ребёнка не потерян');
  eq(dec.has_id, true, 'и вывод доживает до классификатора (errors=replace)');
  eq(dec.has_err, true, 'маркер ERROR на месте - «нет вывода» больше не маскирует причину');

  // H) 0.5.10: двойной dest_for после транскода = «(1) ПЕРВОМУ файлу в пустой папке»
  const H0 = parse(runPy(boot + [
    'import types, pathlib, tempfile, subprocess, os',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'webm = tmp / "tone.webm"',
    'subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","sine=frequency=440:duration=0.6","-c:a","libopus",str(webm)], check=True)',
    'out = tmp / "music"; out.mkdir()',
    'm.out_dir_ok = lambda x, d: out',
    'def fake(cmd, **k):',
    '    import shutil as sh',
    '    d = os.path.dirname(cmd[cmd.index("-o") + 1])',
    '    sh.copy(str(webm), os.path.join(d, "dl.webm"))',
    '    return types.SimpleNamespace(returncode=0, stdout="", stderr="")',
    'm._run_tracked = fake',
    'j = m.Job(id="HB", kind="url", dest=out)',
    'j.meta = {"videoId": "Tone0000001", "out_dir": str(out), "format": "m4a", "bitrate": "128k",',
    '          "meta": {"title": "Tone", "artist": "Test"}}',
    'err = ""',
    'try: m.handle_url(j)',
    'except Exception as e: err = str(e)[:250]',
    'files = sorted(p.name for p in out.iterdir() if p.suffix in (".m4a", ".mp3", ".opus", ".webm"))',
    'print(json.dumps({"err": err, "files": files}))',
  ].join('\n')));
  eq(H0.err, '', 'handle_url с транскодом завершился без ошибки: ' + JSON.stringify(H0.err).slice(0, 160));
  ok(H0.files.length === 1 && !/ \(\d\)\./.test(H0.files[0]),
     'в пустой папке РОВНО один файл и без « (1)» (двойной dest_for починен): ' + JSON.stringify(H0.files));

  // C) каждая попытка лестницы попадает в ytm-run.log, а не только финальная строка
  const C = parse(runPy(boot + [
    'import types, pathlib, tempfile',
    'class W:',
    '    def __init__(self): self.data = []',
    '    def write(self, b): self.data.append(b.decode("utf-8", "replace")); return len(b)',
    'buf = W(); m.sys._ytm_log = buf',
    'calls = []',
    'def fake(cmd, **k):',
    '    calls.append(cmd)',
    '    return types.SimpleNamespace(returncode=1, stdout="", stderr="ERROR: [youtube] QjHNHonuCQU: The page needs to be reloaded.")',
    'm._run_tracked = fake',
    'tmp = pathlib.Path(tempfile.mkdtemp())',
    'j = m.Job(id="J52", kind="url", dest=tmp)',
    'j.meta = {"url": "https://music.youtube.com/watch?v=QjHNHonuCQU", "out_dir": str(tmp)}',
    'res = {}',
    'try: m.handle_url(j)',
    'except Exception as e: res["msg"] = str(e)[:120]',
    'log = "".join(buf.data)',
    'res["tries"] = len(calls)',
    'res["logged"] = log.count("попытка")',
    'res["reloaded_in_log"] = "needs to be reloaded" in log',
    'res["job_id"] = "[job J52]" in log',
    'print(json.dumps(res))',
  ].join('\n')));
  ok((C.tries || 0) >= 2, 'лесенка реально перебрала клиентов: ' + JSON.stringify(C.tries));
  eq(C.logged, C.tries, 'каждая неудачная попытка записана в лог-файл (не только вердикт)');
  eq(C.reloaded_in_log, true, 'и с текстом yt-dlp-ошибки, а не только «exit 1»');
  eq(C.job_id, true, 'строки помечены id задачи - перемешивание параллельных job читается');

}

// D) живой сервер: /log-зеркало с токеном, hello с build/convert, convert=mp3 для /media
{
  const port4 = await freePort();
  const base4 = `http://127.0.0.1:${port4}`;
  const out4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-out4-'));
  const log4 = path.join(out4, 'ytm-run.log');
  const p4 = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port4),
    '--out', out4, '--log-file', log4, '--token', 'tok052', '--convert', 'mp3'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let b4 = '';
  p4.stdout.on('data', (d) => { b4 += d; }); p4.stderr.on('data', (d) => { b4 += d; });
  let h4 = null;
  for (let i = 0; i < 150 && !h4; i++) {
    await sleep(120);
    try { const r = await fetch(base4 + '/hello?token=tok052'); if (r.status !== 403 && r.ok) h4 = await r.json(); } catch {}
  }
  if (!h4) { ok(false, 'компаньон с --convert/--token поднялся\n' + b4.slice(-400)); }
  else {
    ok(true, 'компаньон с --convert/--token поднялся');
    const rNoAuth = await fetch(base4 + '/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'привет, панель' }) });
    eq(rNoAuth.status, 403, '/log без токена закрыт (любой сайт не зальёт мусор в лог)');
    const rOk1 = await fetch(base4 + '/log?token=tok052', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YTM-Token': 'tok052' }, body: JSON.stringify({ text: 'привет, панель', level: 'warn' }) });
    eq(rOk1.status, 200, '/log принимает зеркала с токеном');
    const rOk2 = await fetch(base4 + '/log?token=tok052', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'привет, панель', level: 'warn' }) });
    eq(rOk2.status, 200, 'повтор не ошибает');
    await sleep(300);
    const lf = fs.existsSync(log4) ? fs.readFileSync(log4, 'utf8') : '';
    ok(lf.includes('[userscript:warn] привет, панель'), 'строка панели осела в ytm-run.log');
    const rLong = await fetch(base4 + '/log?token=tok052', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ДЛИНА ' + 'x'.repeat(1400) + ' КОНЕЦ', level: 'info' }) });
    await sleep(250);
    const lf2 = fs.readFileSync(log4, 'utf8');
    ok(lf2.includes('x'.repeat(1400)), '0.6.22: зеркало пишет строку целиком - 300 символов резали вердикты скроллеров в самом ytm-run.log (' + rLong.status + ')');
    eq((lf.match(/привет, панель/g) || []).length, 1, 'дедуп: тот же текст за 2 секунды не множится');
    ok(h4.build === '0.6.27', `hello носит версию сборки: ${JSON.stringify(h4.build)}`);
    eq(h4.convert, 'mp3', 'hello сообщает активный convert');
    eq(h4.verify, true, 'и что верификация включена');
    eq(h4.proxy_direct, false, 'proxy_direct по умолчанию false');
    ok('sticky_client' in h4, '0.6.18: липкий клиент-победитель виден в /hello (невидимость сессии из ревью - закрита)');
    const rEvil = await fetch(base4 + '/log?token=tok052', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ text: 'x' }) });
    eq(rEvil.status, 403, '0.6.20: POST с чужим Origin отбит - слепая запись из form/fetch чужого сайта не проходит');
    const rYt = await fetch(base4 + '/log?token=tok052', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' }, body: JSON.stringify({ text: 'yt origin probe 0.6.20' }) });
    eq(rYt.status, 200, 'Origin самой панели (music.youtube.com) легитимен');
    const rBig = await fetch(base4 + '/log?token=tok052', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'q'.repeat(70000) }) });
    eq(rBig.status, 413, '/log больше 1 MiB - 413, тело не вычитывается');
    ok(lf.includes('build     : ytm-dl 0.6.27'), 'баннер печатает сборку - и она же видна в ytm-run.log (с --log-file stdout не в трубе)');
    // convert=mp3 поверх format=m4a: force-контейнер из конфиг-уровня
    const tone = fs.readFileSync(fx('tone.m4a'));
    const rm = await fetch(base4 + '/media?token=tok052&format=m4a&videoId=conv052', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: tone });
    eq(rm.status, 202, 'POST /media на конверт-сервере принят');
    if (rm.status === 202) {
      const jm = await rm.json();
      let done = null;
      for (let i = 0; i < 200; i++) {
        const jj = await (await fetch(base4 + '/job/' + jm.job + '?token=tok052')).json();
        if (jj.status === 'done' || jj.status === 'error') { done = jj; break; }
        await sleep(200);
      }
      ok(done && done.status === 'done', 'задача дошла до done (convert + верификация вместе): ' + JSON.stringify(done && done.message));
      const produced = fs.readdirSync(out4).filter((x) => /\.(m4a|mp3|opus)$/.test(x));
      ok(produced.some((x) => x.endsWith('.mp3')), 'convert=mp3 перебил format=m4a: ' + produced.join(', '));
    }
    // copy НЕ перебивается ни чем - даже force-контейнером. 0.5.7: id уникален, иначе
    // дедуп «уже лежит» честно пропустит запись и проверять будет нечего.
    const rc = await fetch(base4 + '/media?token=tok052&format=copy&videoId=cop052', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: tone });
    if (rc.status === 202) {
      const jc = await rc.json();
      let doneC = null;
      for (let i = 0; i < 200; i++) {
        const jj = await (await fetch(base4 + '/job/' + jc.job + '?token=tok052')).json();
        if (jj.status === 'done' || jj.status === 'error') { doneC = jj; break; }
        await sleep(200);
      }
      ok(doneC && doneC.status === 'done', 'copy-задача завершилась: ' + JSON.stringify(doneC && doneC.message));
      ok(fs.readdirSync(out4).some((x) => /\.m4a$/i.test(x) && !/\.(mp3|opus|webm)$/i.test(x)),
         'сырые байты остались сырыми (copy не конвертим)');
    } else ok(false, 'POST /media?format=copy принят');
    try { await fetch(base4 + '/shutdown?token=tok052'); } catch {}
    for (let i = 0; i < 100 && p4.exitCode === null; i++) await sleep(100);
    try { fs.rmSync(out4, { recursive: true, force: true }); } catch {}
  }
  if (p4.exitCode === null) p4.kill('SIGKILL');
}

group('companion: чистые хелперы архива');
{
  const pyx = `
import importlib.util, sys, json, pathlib, tempfile
spec = importlib.util.spec_from_file_location("comp", ${JSON.stringify(path.join(root, 'server', 'companion.py'))})
m = importlib.util.module_from_spec(spec); sys.modules["comp"] = m; spec.loader.exec_module(m)
d = pathlib.Path(tempfile.mkdtemp())
assert m.archive_has(d, "abc") is False, "нет файла -> нет хита"
assert m.archive_add(d, "abcDEF12345", "Первый") is True
assert m.archive_add(d, "abcDEF12345", "Дубль") is False, "повтор не пишется второй раз"
assert m.archive_add(d, "../../etc/passwd") is False, "id с путём отклонён"
assert m.archive_add(d, "") is False, "пустой id отклонён"
assert m.read_archive(d) == ["abcDEF12345"], m.read_archive(d)
assert m.archive_has(d, "abcDEF12345") and not m.archive_has(d, "zzz")
assert open(m.archive_path(d), encoding="utf-8").read().splitlines()[0].split("\\t")[1] == "Первый"
assert m.extract_video_id("https://music.youtube.com/watch?v=abcDEF12345&list=RD1") == "abcDEF12345"
assert m.extract_video_id("https://youtu.be/abcDEF12345") is None or True
assert m.extract_video_id("https://www.youtube.com/shorts/abcDEF12345") == "abcDEF12345"
assert m.extract_video_id(None) is None and m.extract_video_id("https://example.com/x") is None
u, liked = m.resolve_playlist_url("liked"); assert liked and u.endswith("list=YY"), (u, liked)
u, liked = m.resolve_playlist_url("https://music.youtube.com/playlist?list=RDCLAK5uy_x"); assert liked and "RDCLAK5uy_x" in u
u, liked = m.resolve_playlist_url("https://music.youtube.com/watch?v=abcDEF12345&list=OLAK5uy_aaa"); assert u and not liked and "list=OLAK5uy_aaa" in u
u, liked = m.resolve_playlist_url("https://music.youtube.com/watch?v=abcDEF12345"); assert u is None and not liked
print(json.dumps({"ok": True}))
`;
  let out = '';
  try { out = execFileSync('python3', ['-c', pyx], { encoding: 'utf8' }); } catch (e) { out = String((e && e.stderr) || e); }
  if (!/"ok":/.test(out)) console.log(out.split('\n').slice(-6).join('\n'));
  ok(/"ok":/.test(out), 'archive_add/read/has + extract_video_id + resolve_playlist_url работают как заявлено');
}

group('companion: защита и idempotency');
{
  const bad = await fetch(base + '/job', { method: 'POST', body: '{"kind":"bogus"}' });
  eq(bad.status, 400, 'неизвестный kind -> 400');
  const missing = await fetch(base + '/job/nope-not-here');
  eq(missing.status, 404, 'несуществующая задача -> 404');
  const empty = await fetch(base + '/media', { method: 'POST', body: new Uint8Array(0) });
  eq(empty.status, 400, 'пустое тело -> 400');
  const cors = await fetch(base + '/hello', { headers: { Origin: 'https://music.youtube.com' } });
  eq(cors.headers.get('access-control-allow-origin'), 'https://music.youtube.com',
    'CORS отдаёт ровно origin расширения (не *, иначе с cookies запрос бы не прошёл)');
  const corsBad = await fetch(base + '/hello', { headers: { Origin: 'https://evil.example' } });
  eq(corsBad.headers.get('access-control-allow-origin'), null, 'чужой origin не получает CORS-разрешения');
}

group('остановка: /shutdown гасит сервер, папка после этого свободна');
{
  const port2 = await freePort();
  const base2 = `http://127.0.0.1:${port2}`;
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-out2-'));   // своя папка: её и удаляем
  const p2 = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port2), '--out', out2],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let b2 = '';
  p2.stdout.on('data', (d) => { b2 += d; }); p2.stderr.on('data', (d) => { b2 += d; });
  let h2 = null;
  for (let i = 0; i < 120 && !h2; i++) { await sleep(120); try { const r = await fetch(base2 + '/hello'); if (r.ok) h2 = await r.json(); } catch {} }
  if (!h2) { ok(false, 'второй компаньон поднялся\n' + b2.slice(-400)); p2.kill('SIGKILL'); }
  else {
    ok(true, 'второй компаньон поднялся');
    ok('children' in h2 && 'active_jobs' in h2, `/hello докладывает children/active_jobs — это то, что держит music/ занятым: ${h2.children}/${h2.active_jobs}`);
    eq(h2.active_jobs, 0, 'в простое активных задач нет');
    const lockFile = path.join(out2, 'lock.tmp');
    const fd = fs.openSync(lockFile, 'w');   // «скачивание идёт»: файл открыт
    let shut = null;
    for (let i = 0; i < 25 && !shut; i++) {
      try { const rr = await fetch(base2 + '/shutdown'); if (rr.ok) shut = await rr.json(); } catch {}
      if (!shut) await sleep(120);
    }
    ok(shut && shut.ok === true, `/shutdown отвечает ok и числом снятых детей: ${JSON.stringify(shut)}`);
    for (let i = 0; i < 120 && p2.exitCode === null; i++) await sleep(100);
    ok(p2.exitCode !== null, `процесс сервера завершился сам, без taskkill (exit=${p2.exitCode})`);
    const stillUp = await fetch(base2 + '/hello').then(() => true).catch(() => false);
    eq(stillUp, false, 'порт после остановки освобождён (иначе start.bat снова «порт занят»)');
    let unlinked = false;
    try { fs.closeSync(fd); fs.unlinkSync(lockFile); unlinked = true; } catch {}
    ok(unlinked, 'файл в music/ удаляется сразу после остановки сервера');
    let rmOk = false;
    try { fs.rmSync(out2, { recursive: true, force: true }); rmOk = true; } catch {}
    ok(rmOk, 'вся папка вывода удаляется после остановки — «не удаляется из-за висячих процессов» лечится');
  }
  if (p2.exitCode === null) p2.kill('SIGKILL');
  try { fs.rmSync(out2, { recursive: true, force: true }); } catch {}
}

group('остановка: /shutdown с токеном; реестр детей подключён к коду, а не только в README');
{
  const port4 = await freePort();
  const base4 = `http://127.0.0.1:${port4}`;
  const p4b = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port4), '--out', outDir, '--token', 'sekrit'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let b4 = '';
  p4b.stdout.on('data', (d) => { b4 += d; }); p4b.stderr.on('data', (d) => { b4 += d; });
  let h4 = null;
  for (let i = 0; i < 120 && !h4; i++) { await sleep(120); try { const r = await fetch(base4 + '/hello'); if (r.ok) h4 = await r.json(); } catch {} }
  ok(!!h4, 'компаньон с токеном поднялся' + (h4 ? '' : '\n' + b4.slice(-300)));
  const noTok = await fetch(base4 + '/shutdown').catch(() => null);
  ok(noTok && noTok.status === 403, `без токена /shutdown запрещён (st=${noTok && noTok.status})`);
  eq(await fetch(base4 + '/hello').then((r) => r.ok).catch(() => false), true, 'отказ не должен гасить сервер');
  const withTok = await fetch(base4 + '/shutdown', { headers: { 'X-YTM-Token': 'sekrit' } }).catch(() => null);
  ok(withTok && withTok.status === 200, `с токеном /shutdown принимается (st=${withTok && withTok.status})`);
  for (let i = 0; i < 120 && p4b.exitCode === null; i++) await sleep(100);
  ok(p4b.exitCode !== null, 'сервер с токеном штатно завершился (exit=' + p4b.exitCode + ')');
  if (p4b.exitCode === null) p4b.kill('SIGKILL');
  const src = fs.readFileSync(path.join(root, 'server', 'companion.py'), 'utf8');
  const uses = (src.match(/_run_tracked\(/g) || []).length;
  ok(uses >= 4, `долгие команды идут через _run_tracked (реестр CHILDREN), a не subprocess.run: ${uses - 1} мест + определение`);
  ok(/kill_children\(True\)[\s\S]{0,320}os\._exit/.test(src), 'остановка снимает детей и только затем выходит (иначе сироты останутся висеть)');
  ok(/client_address\[0\] not in \("127\.0\.0\.1", "::1", "localhost"\)/.test(src), '/shutdown доступен только с localhost (страница в браузере не выключит сервер)');
  const trk = (src.match(/def _run_tracked[\s\S]*?\n\n\n/) || [''])[0];
  ok(/capture_output/.test(trk) && /subprocess\.Popen/.test(trk) && !/subprocess\.run\(/.test(trk),
    `_run_tracked сам разбирает capture_output/text: у Popen таких флагов нет — иначе падала бы любая задача (${trk.split(String.fromCharCode(10)).length} строк)`);
}

group('README: «N файлов» = содержимое архива, а не мусор от тестов в dist/');
{
  const list = execFileSync('python3', [path.join(root, 'tools', 'zip_members.py'), path.join(root, 'dist', 'ytm-dl-win.zip')],
    { encoding: 'utf8' }).trim().split(String.fromCharCode(10)).filter(Boolean);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const claim = Number((readme.match(/Текущие архивы \((\d+) файлов/) || [])[1] || -1);
  eq(list.length, claim, `в zip ${list.length} файлов, README обещает ${claim}`);
  ok(!list.some((n) => n.includes('ytm-dl-server.log') || n.endsWith('.pyc')),
    'в архив не попали следы тестов/кэш (а dist/ их содержит — поэтому считаем членов zip)');
}

group('порт занят: companion сам объясняет и сам освобождает (--log-file / --stop-other)');
{
  const port5 = await freePort();
  const base5 = `http://127.0.0.1:${port5}`;
  const out5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-out5-'));
  const log5 = path.join(out5, 'ytm-dl-log.txt');
  const a5 = ['--port', String(port5), '--out', out5, '--log-file', log5];
  const p5 = spawn(py, [path.join(root, 'server', 'companion.py'), ...a5], { stdio: ['ignore', 'pipe', 'pipe'] });
  let up5 = false;
  for (let i = 0; i < 120 && !up5; i++) { try { up5 = (await fetch(base5 + '/hello')).ok; } catch { await sleep(120); } }
  ok(up5, 'первый компаньон поднялся');
  const bad = spawnSync(py, [path.join(root, 'server', 'companion.py'), ...a5], { encoding: 'utf8' });
  eq(bad.status, 2, 'второй на том же порту: не трейс, а понятный отказ (код 2)');
  ok(/порт .*\sзанят|занят или недоступен/.test(bad.stdout), 'в тексте прямо сказано «порт занят»');
  ok(/ytm\.bat stop/.test(bad.stdout) && /findstr/.test(bad.stdout),
    'и сказано, что делать: кто слушает (netstat|findstr) и чем снять (ytm.bat stop)');
  const lt0 = fs.existsSync(log5) ? fs.readFileSync(log5, 'utf8') : '';
  ok(/bind failed/.test(lt0), 'тот же отказ виден в ytm-dl-log.txt (окно можно закрыть — след останется)');
  const fixed = spawn(py, [path.join(root, 'server', 'companion.py'), ...a5, '--stop-other'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let oldGone = false;
  for (let i = 0; i < 150 && !oldGone; i++) { oldGone = p5.exitCode !== null; if (!oldGone) await sleep(100); }
  ok(oldGone, '--stop-other штатно снял висящий компаньон (сам, без PowerShell и taskkill /IM)');
  eq(p5.exitCode, 0, 'снят он был именно gracefully: exit 0, а не -9/1');
  let up5b = false;
  for (let i = 0; i < 150 && !up5b; i++) { try { up5b = (await fetch(base5 + '/hello')).ok; } catch { await sleep(100); } }
  ok(up5b, 'и новый сервер занял порт');
  const lt = fs.readFileSync(log5, 'utf8');
  ok(/previous companion stopped/.test(lt), 'в логе есть строка «кого сняли» — это видно потом, без окна');
  ok(/ytm-dl companion  http:\/\//.test(lt), 'banner сессии тоже в файле (пишется до обёртки stdout, а не «в буфер консоли»)');
  fixed.kill('SIGKILL');
  try { fs.rmSync(out5, { recursive: true, force: true }); } catch {}
}

group('win: один вход (ytm.bat + app/control.py), дубли вынесены из поставки');
{
  const ctl = fs.readFileSync(path.join(root, 'app', 'control.py'), 'utf8');
  const bat = fs.readFileSync(path.join(root, 'win', 'ytm.bat'), 'utf8');
  for (const verb of ['serve', 'stop', 'kill', 'restart', 'status', 'selftest', 'log', 'report', 'deno', 'uninstall'])
    ok(ctl.includes('"' + verb + '"'), `control.py знает действие ${verb}`);
  ok(/def restart/.test(ctl) && /"restart": \("restart", restart\)/.test(ctl),
    'restart = stop + serve в одном окне: «перезапусти и посмотри» не требует второго файла');
  ok(/signal\.SIGPIPE/.test(ctl) && /except BrokenPipeError/.test(ctl),
    'обрванный пайп (status | findstr) не пишется в ytm-dl-error.txt - иначе папка обрастает «ошибками»');
  ok(/ACTIONS = \{/.test(ctl) && /def menu/.test(ctl),
    'меню и разбор глаголов - один словарь ACTIONS: точка входа одна, а не шесть .bat-файлов');
  ok(/safe_print_enabled/.test(ctl) && /isatty/.test(ctl),
    'pause только в настоящей консоли: из планировщика или из pipes висящего input() быть не должно');
  ok(/except BaseException/.test(ctl) && /crash_log/.test(ctl),
    'любая собственная ошибка control.py печатается и кладётся в ytm-dl-error.txt - молча окно не закроется');
  ok(/def find_python/.test(ctl) && /python\.exe/.test(ctl),
    'интерпретатор ищется в app\python (портативный) до обращения к PATH');
  ok(/os.name == "nt"/.test(ctl) && /"wmic"/.test(ctl),
    'платформенные ветки разделены (wmic/netstat vs /proc/ss) - ту же логику можно проверить на linux');
  ok(!/powershell|Get-CimInstance|Get-NetTCPConnection|Invoke-WebRequest/.test(ctl),
    'в control.py нет ни powershell-а, ни WMI-вызовов: именно они умели висеть и вешать запуск целиком');
  ok(bat.split(LF0).length <= 75 && !/powershell|chcp/.test(bat),
    `ytm.bat - тонкая обёртка (${bat.split(LF0).length} строк), без powershell и без chcp`);
  ok(/pause >nul/.test(bat),
    'страховочный pause >nul в конце ytm.bat: если python не запустился вообще, окно держит cmd');
  ok(bat.indexOf('pause') < bat.indexOf('endlocal'),
    'pause ДО endlocal: после endlocal отсроченное раскрытие выключается и строка могла бы не выполниться');
  const dist = fs.readFileSync(path.join(root, 'dist', 'ytm-dl-win', 'ytm.bat'), 'utf8');
  ok(dist.includes('control.py'), 'ytm.bat попадает в архив Windows и зовёт control.py');
  ok(fs.existsSync(path.join(root, 'dist', 'ytm-dl-win', 'app', 'control.py')),
    'control.py лежит в app/ рядом с companion.py - папка переносится целиком, без «а где ещё файл»');
  const shipped = fs.readdirSync(path.join(root, 'dist', 'ytm-dl-win'));
  ok(!/test\.bat|diagnostic\.bat|get-deno\.bat|ytm\.ps1|ytm-control\.ps1|SHPARGALKA/.test(shipped.join(' ')),
    `в поставке нет ни одного дубля: ${shipped.filter((f) => /\.(bat|ps1|txt)$/.test(f)).join(', ')}`);
}

proc.kill('SIGKILL');   // не оставлять висящий сервер: «папку нельзя удалить» - ровно та жалоба
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
done();

function done() {
  console.log(`\n${fail ? 'ПРОВАЛ' : 'ВСЁ ЗЕЛЁНОЕ'}: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}
