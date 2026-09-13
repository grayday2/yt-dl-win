// Сквозной тест всего конвейера:
//   реальные ffmpeg-фрагменты -> assembleMp4 (логика userscript'а) -> POST /media компаньону
//   -> remux + теги -> готовый к проигрыванию файл.
// Именно это делает кнопка в Tampermonkey, только байты приходят из вкладки.
//   node tests/test_e2e.mjs
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fx = (f) => path.join(here, 'fixtures', f);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

if (!fs.existsSync(fx('stream.m4s'))) { console.log('нет фикстур — bash tools/make_fixtures.sh'); process.exit(0); }

/* ---------- 1. userscript: сборка прогрессивного файла из «сырых» байтов ---------- */
const src = fs.readFileSync(path.join(root, 'userscript', 'ytm-downloader.user.js'), 'utf8');
const stub = () => ({ style: {}, dataset: {}, hidden: true, textContent: '', innerHTML: '', children: [], firstElementChild: { style: {} }, appendChild() {}, append() {}, insertBefore() {}, contains: () => true, addEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => stub(), querySelectorAll: () => [], closest: () => null, click() {}, remove() {} });
const sb = { console, TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, Number, String, Object, Array, Set, Map, RegExp, Error, URLSearchParams, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {}, location: { href: 'https://music.youtube.com/watch?v=x', search: '?x=1', origin: 'https://music.youtube.com' }, document: { title: 'x', readyState: 'complete', head: stub(), body: stub(), documentElement: stub(), createElement: () => stub(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }, MutationObserver: class { observe() {} }, fetch: async () => ({}), XMLHttpRequest: class {} };
sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(src, sb, { filename: 'userscript' });
const L = sb.YTMDL_LIB;

const stream = fs.readFileSync(fx('stream.m4s'));
const tops = L.walkBoxes(new Uint8Array(stream), 0);
const initEnd = tops.find((b) => b.type === 'moov');
const initBytes = stream.subarray(0, initEnd.start + initEnd.size);
const mdatList = tops.filter((b) => b.type === 'mdat');
// «сырьё», как его видит userscript: конкатенация payload'ов всех mdat
const media = Buffer.concat(mdatList.map((b) => stream.subarray(b.start + 8, b.start + b.size)));

const collected = L.collectSamples(new Uint8Array(stream));
const res = L.assembleMp4(new Uint8Array(initBytes), new Uint8Array(media), collected);
console.log(`\nсборка: ${media.length} Б медиа -> ${res.bytes.length} Б файла (fixed=${res.fixed}, est=${res.estimated}, warnings=${JSON.stringify(res.warnings)})`);
ok(res.warnings.length === 0, 'сборка без предупреждений');
ok(res.bytes.length > media.length, 'к медиа добавился moov');

/* ---------- 2. то, что реально отдаётся в загрузку ---------- */
const rawPath = path.join(os.tmpdir(), `ytm_e2e_${process.pid}.m4a`);
fs.writeFileSync(rawPath, Buffer.from(res.bytes));

/* ---------- 3. компаньон: remux + теги ---------- */
let py = 'python3';
try { execFileSync(py, ['-c', 'import mutagen'], { stdio: 'pipe' }); } catch { console.log('\npython3+mutagen недоступны — часть 3 пропущена'); finish(); }
const port = await freePort();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-e2e-'));
const proc = spawn(py, [path.join(root, 'server', 'companion.py'), '--port', String(port), '--out', outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
proc.stdout.on('data', (d) => logs.push(d)); proc.stderr.on('data', (d) => logs.push(d));
const base = `http://127.0.0.1:${port}`;
let hello = null;
for (let i = 0; i < 80 && !hello; i++) { try { const r = await fetch(base + '/hello'); if (r.ok) hello = await r.json(); } catch {} await sleep(150); }
ok(!!hello, 'компаньон поднялся');
if (!hello) { proc.kill('SIGKILL'); finish(); }

const meta = { title: 'E2E Fragmented', artist: 'Pipeline QA', album: 'Assembled', track: 5 };
const qs = new URLSearchParams({ meta: JSON.stringify(meta), format: 'm4a' });
const post = await (await fetch(`${base}/media?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(rawPath) })).json();
ok(!!post.job, `POST /media принят (${post.bytes} Б)`);
let job = null;
for (let i = 0; i < 120; i++) { job = await (await fetch(`${base}/job/${post.job}`)).json(); if (job.status === 'done' || job.status === 'error') break; await sleep(200); }
ok(job.status === 'done', 'компаньон довёл файл до done' + (job.error ? ': ' + job.error : ''));
const dest = job.dest;
ok(fs.existsSync(dest), `файл на диске: ${path.basename(dest || '')}`);

/* ---------- 4. финальная проверка «как это увидит слушатель» ---------- */
let ff = null;
try { ff = execFileSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim(); } catch {}
if (ff && fs.existsSync(ff)) {
  let txt = '';
  try { txt = execFileSync(ff, ['-hide_banner', '-i', dest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { txt = String((e && e.stderr) || ''); }
  ok(/Audio:\s*aac/i.test(txt), 'кодек AAC в финальном файле');
  const dm = txt.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const dur = dm ? +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]) : null;
  ok(dur !== null && Math.abs(dur - 3.0) < 0.25, `длительность финального файла ${dur}s ≈ 3s`);
  const ref = execFileSync(ff, ['-v', 'error', '-i', dest, '-f', 'wav', '-y', dest + '.wav'], { stdio: 'pipe' });
  const wavSize = fs.existsSync(dest + '.wav') ? fs.statSync(dest + '.wav').size : 0;
  ok(wavSize > 200000, `звук декодируется целиком (wav ${wavSize} Б)`);
  const err = (() => { try { execFileSync(ff, ['-v', 'error', '-xerror', '-i', dest, '-f', 'null', '-'], { stdio: 'pipe' }); return null; } catch (e) { return String(e.stderr || e.message).slice(0, 160); } })();
  ok(err === null, 'декодирование без ошибок' + (err ? ': ' + err : ''));
  try { fs.unlinkSync(dest + '.wav'); } catch {}
} else {
  console.log('  skip ffmpeg недоступен — проверка декодирования пропущена');
}
try {
  const tags = JSON.parse(execFileSync(py, ['-c',
    'import sys,json\nfrom mutagen.mp4 import MP4\nm=MP4(sys.argv[1])\nprint(json.dumps({k:(v[0] if isinstance(v,list) else v) for k,v in m.items() if k in ("©nam","©ART","©alb","trkn")}))',
    dest], { encoding: 'utf8' }).trim());
  ok(tags['©nam'] === 'E2E Fragmented' && tags['©ART'] === 'Pipeline QA', 'теги дожили до финального файла: ' + JSON.stringify(tags));
} catch (e) { ok(false, 'чтение тегов: ' + String(e.stderr || e.message).slice(0, 160)); }

proc.kill('SIGKILL');
fs.unlinkSync(rawPath);
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
finish();

function finish() {
  console.log(`\n${fail ? 'ПРОВАЛ' : 'ВСЁ ЗЕЛЁНОЕ'}: ${pass} passed, ${fail} failed`);
  if (fail) console.log('--- вывод компаньона ---\n' + Buffer.concat(logs).toString('utf8').split('\n').slice(-20).join('\n'));
  process.exit(fail ? 1 : 0);
}
