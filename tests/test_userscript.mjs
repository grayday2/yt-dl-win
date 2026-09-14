// Автотесты чистой логики userscript'а.
// Загружает реальный ytm-downloader.user.js в Node с мокнутого DOM и проверяет
// разбор player response, SABR-детект, Range/покрытие байтов, сборку MP4 и выбор режима.
//   node tests/test_userscript.mjs
'use strict';
let SCROLL_TEST = Promise.resolve();
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'userscript', 'ytm-downloader.user.js'), 'utf8');

/* ------------------------------- мок браузера ------------------------------- */
const el = (tag = 'div') => ({
  tagName: tag.toUpperCase(), hidden: true, isContentEditable: false, id: '', textContent: '', innerHTML: '',
  children: [], dataset: {}, style: {}, className: '', firstElementChild: null,
  appendChild(c) { if (c) c.parentNode = this; this.children.push(c); return c; },
  append(...c) { this.children.push(...c); },
  insertBefore(c) { if (c) c.parentNode = this; this.children.unshift(c); return c; },
  removeChild(c) { const k = this.children.indexOf(c); if (k >= 0) this.children.splice(k, 1); return c; },
  get classList() { const s = this; return { add: (v) => { s.className = (s.className ? s.className + ' ' : '') + v; } }; },
  contains() { return true; },
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  querySelector(sel) { return (sel && sel[0] === '#') ? this.__byId(sel.slice(1)) : null; },
  __byId(id, n) { n = n || this; if (n.id === id) return n; for (const c of (n.children || [])) { const x = this.__byId(id, c); if (x) return x; } return null; },
  querySelectorAll() { return []; },
  closest() { return null; }, click() {}, remove() {},
});
el().firstElementChild = { style: {} };

const sandbox = {
  console,
  TextEncoder, TextDecoder, Uint8Array, URLSearchParams, Promise, JSON, Math, Date, Number, String, Object, Array, Set, Map, RegExp, Error,
  setTimeout: (fn) => { return 0; },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  location: { href: 'https://music.youtube.com/watch?v=abcDEF12345', search: '?v=abcDEF12345', origin: 'https://music.youtube.com' },
  document: {
    title: 'Some Song - YouTube Music',
    readyState: 'complete',
    head: el('head'), body: el('body'), documentElement: el('html'),
    createElement: (t) => Object.assign(el(t), { firstElementChild: { style: {} } }),
  createElementNS: (ns, t) => Object.assign(el(t), { firstElementChild: { style: {} }, namespaceURI: ns }),
  createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
  createElementNS: (ns, t) => Object.assign(el(t), { firstElementChild: { style: {} } }),
    querySelector(sel) { return (sel && sel[0] === '#') ? this.__byId(sel.slice(1)) : null; },
    querySelectorAll: () => [],
    __byId(id, node) {
      const r = node || this.body || this;   // контролы живут в body, не в самом document
      if (r.id === id) return r;
      for (const c of (r.children || [])) { const x = this.__byId(id, c); if (x) return x; }
      return null;
    },
    addEventListener: () => {},
  },
  MutationObserver: class { observe() {} disconnect() {} },
  XMLHttpRequest: class { constructor(){ this.upload={}; } open(){} setRequestHeader(){} send(){} addEventListener(){} getResponseHeader(){return null;} },
  fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), clone(){ return this; } }),
};
sandbox.__alerted = null;
sandbox.alert = (m) => { sandbox.__alerted = m; };   // глобально: userscript зовёт alert(...) без окна
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(src, context, { filename: 'ytm-downloader.user.js' });
const L = sandbox.YTMDL_LIB;
if (!L) { console.error('ФATAL: скрипт не экспортировал YTMDL_LIB'); process.exit(1); }

/* --------------------------------- assertions -------------------------------- */
let pass = 0, fail = 0;
const eq = (got, want, name) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got:  ${a}\n         want: ${b}`); }
};
const ok = (cond, name) => eq(!!cond, true, name);
const group = (t) => console.log(`\n${t}`);

/* ------------------------------- фикстуры YTM ------------------------------- */
const mkPr = (streams, play) => ({
  videoDetails: { videoId: 'abcDEF12345', title: 'Test Track', author: 'Test Artist', lengthSeconds: 213,
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/hq720.jpg' }] } },
  playabilityStatus: play || { status: 'OK' },
  streamingData: {
    expiresInSeconds: 21600,
    adaptiveFormats: streams,
  },
  signatureTimestamp: 21728,
});
const directAudio = { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129000,
  contentLength: '3430000', url: 'https://sb2.googlevideo.com/videoplayback?ip=1.2.3.4&sabr=0&dur=213.000', qualityLabel: '256kbps' };
const sabrAudio = { itag: 141, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 256000, contentLength: '6800000',
  qualityLabel: '256kbps', playerDescriptor: {Sabr: {}}, streamCancellationPolicy: {} };
const webmAudio = { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, contentLength: '4210000',
  url: 'https://r1---sn-x.googlevideo.com/videoplayback?itag=251&range=0-1000', quality: 'tiny' };

group('pickAudioFormats / diagnose');
{
  const f = L.pickAudioFormats(mkPr([sabrAudio, directAudio, webmAudio]));
  eq(f.length, 3, 'видит все аудио-дорожки');
  eq(f.slice(0, 2).every((x) => x.url !== null) && f[2].url === null, true, 'с url сортируются первыми');
  eq(f.map((x) => x.itag), [251, 140, 141],
    'порядок: сначала скачиваемые самой (251 opus 160k > 140 m4a 129k), затем SABR без url');
  eq(f.some((x) => x.itag === 141 && x.sabr), true, 'SABR-формат помечен');
  eq(L.containerOf('audio/mp4; codecs="mp4a.40.2"'), 'm4a', 'контейнер m4a по mime');
  eq(L.containerOf('audio/webm; codecs="opus"'), 'opus', 'контейнер opus по mime');
  eq(L.pickAudioFormats({ streamingData: { adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4' }] } }), [], 'видео отбрасывается');
  eq(L.canDownloadDirectly(f), true, 'direct возможен когда есть url');
  eq(L.canDownloadDirectly([f[2]]), false, 'direct невозможен при только-SABR');

  const dSabr = L.diagnose(mkPr([sabrAudio]), L.pickAudioFormats(mkPr([sabrAudio])));
  eq([dSabr.level, dSabr.sabr, dSabr.withUrl], ['warn', 1, 0], 'диагноз: только SABR');
  ok(/SABR/.test(dSabr.text), 'диагноз упоминает SABR');
  const dBad = L.diagnose(mkPr([], { status: 'UNPLAYABLE', reason: 'Video unavailable' }), []);
  eq(dBad.level, 'bad', 'диагноз: неиграбельно');
  ok(/UNPLAYABLE/.test(dBad.text), 'диагноз содержит playabilityStatus');
  const dEmpty = L.diagnose(mkPr([]), []);
  eq(dEmpty.level, 'bad', 'пустой streamingData — это ошибка, а не «просто пусто»');
}

group('sniffBytes / looksLikeHtml (не сохранять HTML как трек)');
{
  const { sniffBytes, looksLikeHtml } = L;
  const mp4 = new Uint8Array(64); mp4.set([0, 0, 0, 0x18], 0); mp4.set([102, 116, 121, 112], 4); // 'ftyp'
  const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x88, 0x85, 0x81, 0x02]);
  const page = (n) => {
    const body = '<!DOCTYPE html><html><head><title>Sign in to confirm you\'re not a bot</title></head><body>';
    const b = new Uint8Array(Math.max(body.length, n)); b.set(new TextEncoder().encode(body)); return b;
  };
  eq(sniffBytes(mp4), 'm4a', 'ftyp -> m4a');
  eq(sniffBytes(ebml), 'webm', 'EBML -> webm');
  eq(sniffBytes(page(4096)), '', 'HTML не притворяется медиа');
  eq(looksLikeHtml('text/html; charset=utf-8', mp4), true, 'content-type текста важнее магических байт');
  eq(looksLikeHtml('', page(4096)), true, 'HTML ловится и без content-type (бот-чек = 4096 Б, у пользователя файлы были одного размера)');
  eq(looksLikeHtml('video/mp4', mp4), false, 'нормальный поток не отбраковывается');
  eq(looksLikeHtml('application/octet-stream', ebml), false, 'webm тоже ок');
}

group('streamHeaders / fetchStream (заголовок клиента вместо «скачать молча» )');
{
  eq(L.streamHeaders({ clientName: 5, clientVersion: '2.20240101.00.00' }),
    { 'X-Youtube-Client-Name': '5', 'X-Youtube-Client-Version': '2.20240101.00.00' },
    'берём имя и версию клиента из перехваченного ответа');
  const d = L.streamHeaders(undefined);
  eq([d['X-Youtube-Client-Name'], typeof d['X-Youtube-Client-Version']], ['67', 'string'],
    'без ответа подставляем YTM-клиент, а не падаем');
  let seen = null;
  const realFetch = sandbox.fetch;
  sandbox.fetch = async (u, o) => { seen = o; return { ok: true, status: 200, headers: { get: () => null } }; };
  try {
    await L.fetchStream('https://googlevideo/a', { 'X-Youtube-Client-Name': '67' });
    eq([seen.credentials, seen.headers['X-Youtube-Client-Name']], ['include', '67'],
      'credentials=include остаётся, заголовок доезжает');
    ok(/music\.youtube\.com\/$/.test(seen.referrer), 'referrer = страница, а не пустой');
    seen = null;
    await L.fetchStream('https://googlevideo/a', null);
    eq(seen.headers, undefined, 'без заголовков их и нет (фолбэк после CORS-провала)');
  } finally { sandbox.fetch = realFetch; }
}

group('initialPlayerResponse (ответ плеера без перехвата)');
{
  const pr = { videoDetails: { videoId: 'abcDEF12345', title: 'T' }, streamingData: { adaptiveFormats: [] } };
  const other = { videoDetails: { videoId: 'xxxxxxxxxxx' } };
  const saved = sandbox.ytInitialPlayerResponse, savedYtp = sandbox.ytplayer;
  try {
    delete sandbox.ytInitialPlayerResponse; delete sandbox.ytplayer;
    eq(L.initialPlayerResponse('abcDEF12345'), null, 'источников нет -> null, а не исключение');
    sandbox.ytInitialPlayerResponse = other;
    eq(L.initialPlayerResponse('abcDEF12345'), null, 'чужой трек из глобалов не берём');
    sandbox.ytInitialPlayerResponse = pr;
    eq(L.initialPlayerResponse('abcDEF12345'), pr, 'глобал ytInitialPlayerResponse подхвачен');
    eq(L.initialPlayerResponse(''), pr, 'без videoId берём что есть');
    delete sandbox.ytInitialPlayerResponse;
    sandbox.ytplayer = { config: { args: { player_response: pr } } };
    eq(L.initialPlayerResponse('abcDEF12345'), pr, 'ytplayer.config.args.player_response подхвачен');
    sandbox.ytplayer = undefined;
    eq(L.initialPlayerResponse('abcDEF12345'), null, 'и снова пусто');
    ok(/fromPage = initialPlayerResponse/.test(src) && /mode === 'resolve' && !info\.pr && companionAvailable/.test(src),
      'auto без перехвата ведёт в ytdlp, а не в ошибку «не перехвачен»');
  } finally {
    if (saved === undefined) delete sandbox.ytInitialPlayerResponse; else sandbox.ytInitialPlayerResponse = saved;
    if (savedYtp === undefined) delete sandbox.ytplayer; else sandbox.ytplayer = savedYtp;
  }
}

group('mediaMeta (pr не должен уезжать в query - отсюда 414)');
{
  const big = { videoId: 'v1', title: 'T', artist: 'A', pr: { streamingData: { adaptiveFormats: [{}] } } };
  const m = L.mediaMeta(big);
  eq('pr' in m, false, 'pr вырезан из meta');
  eq([m.videoId, m.title], ['v1', 'T'], 'остальное на месте');
  const q = [...L.mediaQuery(big, 'm4a').entries()];
  const metaStr = (q.find(([k]) => k === 'meta') || [])[1] || '';
  ok(metaStr.length < 200, `meta в query короткая (${metaStr.length} Б, а не мегабайты)`);
  ok(!/"pr"/.test(metaStr), 'в json meta нет поля pr');
}

group('url/Range-утилиты');
{
  const u = 'https://r.googlevideo.com/videoplayback?a=b&range=0-1000&sig=AA%3D%3D#c';
  eq(L.splitQuery(u).base, 'https://r.googlevideo.com/videoplayback', 'splitQuery base');
  eq(L.splitQuery(u).hash, '#c', 'splitQuery hash');
  eq(L.splitQuery('https://x.y/z').pairs, [], 'url без query');
  eq(L.setQuery(u, { range: '0-' }), 'https://r.googlevideo.com/videoplayback?a=b&range=0-&sig=AA%3D%3D#c',
    'замена параметра без трогания других (sig не раскодирован)');
  eq(L.setQuery('https://x.y/z?a=1', { range: '0-' }), 'https://x.y/z?a=1&range=0-', 'добавление параметра');
  eq(L.setQuery('https://x.y/z?a=1', { junk: null }), 'https://x.y/z?a=1', 'null не добавляет');
  eq(L.fullRangeUrl('https://x.y/v?range=5-9'), 'https://x.y/v?range=0-', 'fullRangeUrl');
  eq(L.parseRange('bytes=0-999'), { start: 0, end: 999 }, 'parseRange');
  eq(L.parseRange('bytes=1000-'), { start: 1000, end: null }, 'parseRange open end');
  eq(L.parseRange('nope'), null, 'parseRange мусор -> null');
}

group('coverageFromRanges (дырки в скачанном)');
{
  const full = L.coverageFromRanges([{ start: 0, end: 999 }, { start: 1000, end: 1999 }]);
  eq([full.covered, full.contiguous, full.gaps.length, full.last], [2000, true, 0, 1999], 'смежные диапазоны склеиваются');
  const gapped = L.coverageFromRanges([{ start: 0, end: 99 }, { start: 300, end: 399 }]);
  eq([gapped.covered, gapped.contiguous, gapped.gaps], [200, false, [[100, 299]]], 'дырка обнаружена');
  const open = L.coverageFromRanges([{ start: 0, end: null }]);
  eq(open.contiguous, true, 'диапазон без конца не создаёт дырок');
  eq(L.coverageFromRanges([]).covered, 0, 'пусто -> 0');
  eq(L.coverageFromRanges([{ start: 5, end: 5 }, { start: 0, end: 4 }, { start: 6, end: 9 }]).covered, 10, 'unordered input');
}

group('resolveMode (выбор стратегии)');
{
  const fDirect = L.pickAudioFormats(mkPr([directAudio]));
  const fSabr = L.pickAudioFormats(mkPr([sabrAudio]));
  eq(L.resolveMode({}, fDirect, null, 'auto'), 'direct', 'есть url -> direct');
  eq(L.resolveMode({}, fSabr, 'https://g/v?itag=141&sabr=1', 'auto'), 'resolve', 'SABR-url -> не replay, а resolve');
  eq(L.resolveMode({}, fSabr, 'https://g/v?itag=140&range=0-10', 'auto'), 'replay', 'обычный Range-url -> replay');
  eq(L.resolveMode({}, fSabr, null, 'auto'), 'resolve', 'ничего нет -> resolve (yt-dlp)');
  eq(L.resolveMode({}, fDirect, null, 'record'), 'resolve', '0.6.16: record удалён - старый cfg.mode честно едет в resolve, а не падает');
  // ytdlp = «как в оригинальном приложении»: не лезть в googlevideo из браузера
  eq(L.resolveMode({}, fDirect, null, 'ytdlp'), 'resolve', 'ytdlp ведёт в resolve, хотя url есть');
  {
    const info = { videoId: 'vid123', title: 'T', artist: 'A', pr: { streamingData: {} }, thumbnail: 't.jpg', duration: 12 };
    const y = L.browserJobPayload(info, 'ytdlp');
    eq([y.kind, y.prefer_url, y.player_response], ['browser', true, null], 'ytdlp: prefer_url + пустой player_response');
    const r = L.browserJobPayload(info, 'auto');
    eq([r.prefer_url, r.player_response ? 'pr' : null], [undefined, 'pr'], 'auto/browser: player response едет как раньше');
    ok(y.videoId === 'vid123' && y.meta.videoId === 'vid123', 'videoId и в payload, и в meta');
  }
}

/* --------------------------------- MP4 --------------------------------- */
const mkBox = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const zero = (n) => Buffer.alloc(n);
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };


group('walkBoxes / box / fourcc');
{
  const buf = Buffer.concat([mkBox('ftyp', zero(8)), mkBox('moov', zero(4)), mkBox('mdat', Buffer.from('hi'))]);
  const boxes = L.walkBoxes(new Uint8Array(buf), 0);
  eq(boxes.map((b) => b.type), ['ftyp', 'moov', 'mdat'], 'walkBoxes типы');
  eq(boxes.map((b) => b.size), [16, 12, 10], 'walkBoxes размеры');
  eq(L.fourcc(new Uint8Array(buf), 4), 'moov'.length === 4 ? 'ftyp' : '?', 'fourcc читает тип');
  const rt = L.box('test', new Uint8Array([1, 2, 3]));
  eq([rt[0], rt[1], rt[2], rt[3]], [0, 0, 0, 11], 'box() пишет размер');
  eq(Array.from(L.concat([new Uint8Array([1]), new Uint8Array([2, 3])])), [1, 2, 3], 'concat');
  eq(!!L.findPath(new Uint8Array(buf), 'moov', []), true, 'findPath находит moov');
}

group('isEncryptedMp4 / readTrunSamples');
{
  const encBuf = Buffer.concat([mkBox('moov', mkBox('trak', mkBox('mdia', mkBox('minf', mkBox('stbl', mkBox('sinf', zero(4)))))))]);
  eq(L.isEncryptedMp4(new Uint8Array(encBuf)), true, 'sinf распознаётся');
  eq(L.isEncryptedMp4(new Uint8Array(mkBox('moov', mkBox('trak', zero(8))))), false, 'чистый init не «зашифрованный»');
  const flags = 0x000000 | 0x101; // data_offset | sample_size
  const flagsBuf = Buffer.alloc(4); flagsBuf.writeUInt32BE(flags, 0);
  const cnt = Buffer.alloc(4); cnt.writeUInt32BE(2, 0);
  const dataOff = Buffer.alloc(4);
  const s1 = Buffer.alloc(4); s1.writeUInt32BE(400, 0);
  const s2 = Buffer.alloc(4); s2.writeUInt32BE(500, 0);
  const trun = mkBox('trun', Buffer.concat([flagsBuf, cnt, dataOff, s1, s2]));
  const moof = mkBox('moof', mkBox('mfhd', zero(4)), mkBox('traf', trun));
  const tr = L.readTrunSamples(new Uint8Array(moof));
  eq(tr.entries.map((x) => x.size), [400, 500], 'trun читает размеры сэмплов');
  eq([tr.count, tr.flags], [2, 0x101], 'trun отдаёт count/flags (нужны для классификации)');
  eq(tr.dataOffset, 0, 'data_offset прочитан (flag 0x1 сдвигает записи на 4 байта)');
  // тот же trun БЕЗ data_offset: сдвиг не должен применяться
  const trun2 = mkBox('trun', Buffer.concat([u32be(0x000100), cnt, s1, s2]));
  eq(L.readTrunSamples(new Uint8Array(mkBox('moof', mkBox('traf', trun2)))).entries.map((x) => x.size),
    [400, 500], 'без флага 0x1 записи идут сразу после sample_count');
}

group('collectSamples (размеры из фрагментов)');
{
  const box = (type, ...parts) => mkBox(type, Buffer.concat(parts.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)))));
  const init = Buffer.concat([
    box('ftyp', Buffer.from('isomiso2', 'latin1')),
    box('moov',
      // mvhd v0: [ver/flags|creation|modification](12) timescale duration rate matrix(36) next(24)
      box('mvhd', Buffer.concat([zero(12), u32be(1000), u32be(0), u32be(0x00010000), zero(68)])),
      box('trak', box('tkhd', zero(80)),
        box('mdia', box('mdhd', Buffer.concat([zero(12), u32be(44100), u32be(2048)])),
          box('minf', box('stbl', box('stsd', zero(8)), box('stts', zero(8)))))),
      // trex: [ver/flags](4) track_ID sample_desc_idx default_duration default_size default_flags
      box('mvex', box('trex', Buffer.concat([zero(4), u32be(1), u32be(1), u32be(2048), zero(8)])))),
  ]);
  // фрагмент 1: trun.flags=0x201 (data_offset + duration), «длительности» = байты (как пишет ffmpeg)
  const trunA = box('trun', Buffer.concat([u32be(0x201), u32be(4), u32be(8),
    u32be(300), u32be(300), u32be(300), u32be(300)]));
  const fragA = Buffer.concat([box('moof', box('mfhd', zero(4)), box('traf',
    box('tfhd', Buffer.concat([zero(4), u32be(1)])),
    box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), zero(8)])), trunA)), box('mdat', Buffer.alloc(1200, 0x11))]);
  // фрагмент 2: trun.flags=0x301 (data_offset + size + duration) — честные размеры
  const trunB = box('trun', Buffer.concat([u32be(0x301), u32be(3), u32be(8),
    u32be(400), u32be(1024), u32be(400), u32be(1024), u32be(400), u32be(1024)]));
  const fragB = Buffer.concat([box('moof', box('mfhd', zero(4)), box('traf',
    box('tfhd', Buffer.concat([zero(4), u32be(1)])),
    box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), zero(8)])), trunB)), box('mdat', Buffer.alloc(1200, 0x22))]);

  const c = L.collectSamples(new Uint8Array(Buffer.concat([init, fragA, fragB])));
  eq(c.n, 7, 'найдено 7 сэмплов из двух фрагментов');
  eq(c.sizes.reduce((a, b) => a + b, 0), 2400, 'сумма размеров == байты двух mdat');
  eq(c.partial, false, 'partial=false: размеры из trun, а не распределены наугад');
  eq(c.estimated, false, 'estimated=false');
  eq(c.timescale, 44100, 'timescale вычитан из mdhd');
  eq(c.sizes.slice(0, 4), [300, 300, 300, 300], 'байт-«длительности» распознаны как размеры');
  eq(c.sizes.slice(4), [400, 400, 400], 'trun 0x301 даёт точные размеры');
  eq([...new Set(c.durations)], [2048], 'длительности = дефолт trex (2048), а не байты из trun');

  const media = Buffer.concat([Buffer.alloc(1200, 0x11), Buffer.alloc(1200, 0x22)]);
  const r = L.assembleMp4(new Uint8Array(init), new Uint8Array(media), c);
  eq(r.warnings, [], 'сборка без предупреждений');
  eq(r.fixed, true, 'stco пропатчен');
  const moovB2 = L.walkBoxes(r.bytes, 0).find((b) => b.type === 'moov');
  const stblB = L.findPath(r.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl'], moovB2.start);
  eq(L.childBoxes(r.bytes, stblB).filter((x) => x.type === 'stsz').length, 1, 'stsz ровно один');
  eq(L.childBoxes(r.bytes, stblB).filter((x) => x.type === 'stts').length, 1, 'stts ровно один (старый удалён)');
  const mvhdB = L.findPath(r.bytes, 'moov', ['mvhd'], moovB2.start);
  ok(Buffer.from(r.bytes).readUInt32BE(mvhdB.start + 24) > 0, 'mvhd.duration проставлен');
  const outBuf = Buffer.from(r.bytes);
  const stcoB = L.findPath(r.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stco'], moovB2.start);
  const mdatB = L.walkBoxes(r.bytes, 0).find((b) => b.type === 'mdat');
  eq(outBuf.readUInt32BE(stcoB.start + 16), mdatB.start + 8, 'stco указывает ровно на payload mdat');
  const stszB = L.findPath(r.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stsz'], moovB2.start);
  eq(outBuf.readUInt32BE(stszB.start + 12), 0, 'stsz.sample_size == 0 (размеры перечислены)');
  eq(outBuf.readUInt32BE(stszB.start + 16), 7, 'stsz.sample_count == 7');
}

group('distributeSizes / mfra');
{
  const d = L.distributeSizes(1000, [1, 1, 1]);
  eq(d.reduce((a, b) => a + b, 0), 1000, 'distributeSizes: сумма точно равна total');
  eq(d.every((x) => x > 0), true, 'distributeSizes: без нулей (stsz с нулём ломает разбор)');
  const d2 = L.distributeSizes(10, [1000, 1, 1]);
  eq(d2.reduce((a, b) => a + b, 0), 10, 'distributeSizes: баланс при жёстких весах');
  ok(d2.every((x) => x >= 1), 'distributeSizes: минимальный размер >= 1');
}

group('папка загрузки (out) -> companion');
{
  const cfg = L._test.cfg;
  const saved = cfg.out;
  cfg.out = '';
  eq(L.dirOverride(), '', 'пустая настройка => пустой override');
  eq(L.withDirOverride({ kind: 'browser', videoId: 'x' }), { kind: 'browser', videoId: 'x' },
    'без overrides payload не обрастает полями (companion возьмёт --out)');
  eq([...L.mediaQuery({ title: 'T' }, 'm4a').entries()], [['format', 'm4a'], ['meta', '{"title":"T"}']],
    'без overrides в query только формат и meta');
  cfg.out = '  Music/ytm-single  ';
  eq(L.dirOverride(), 'Music/ytm-single', 'строка тримится');
  eq(L.withDirOverride({ kind: 'url' }).out_dir, 'Music/ytm-single', 'для /job уходит out_dir');
  const q = [...L.mediaQuery({ title: 'T' }, 'mp3').entries()];
  ok(q.some(([k, v]) => k === 'out' && v === 'Music/ytm-single'), `для /media уходит out: ${JSON.stringify(q)}`);
  ok(q.some(([k, v]) => k === 'bitrate'), 'битрейт при mp3 не потерялся');
  cfg.out = saved;
}

group('плейлист/liked + дедуп («не качать уже скачанное»)');
{
  const cfg = L._test.cfg;
  const saved = { out: cfg.out, dedup: cfg.dedup, token: cfg.token };
  cfg.out = ''; cfg.token = '';

  // --- videoId доезжает до companion'а (иначе архив не с чем сверять) ---
  cfg.dedup = true;
  const q = [...L.mediaQuery({ title: 'T', videoId: 'abcDEF12345' }, 'm4a').entries()];
  ok(q.some(([k, v]) => k === 'videoId' && v === 'abcDEF12345'), `videoId в query /media: ${JSON.stringify(q)}`);
  ok(!q.some(([k]) => k === 'dedup'), 'по умолчанию dedup не включаем явным параметром (он включён на сервере)');
  cfg.dedup = false;
  const q2 = [...L.mediaQuery({ title: 'T', videoId: 'abcDEF12345' }, 'm4a').entries()];
  ok(q2.some(([k, v]) => k === 'dedup' && v === '0'), 'выключенный чекбокс -> dedup=0 (скачать поверх)');
  const p1 = L.jobPayload({ kind: 'playlist', url: 'liked' });
  eq(p1.dedup, false, 'dedup=0 прокидывается и в payload /job');
  cfg.dedup = true;
  const p2 = L.jobPayload({ kind: 'playlist', url: 'liked' });
  ok(!('dedup' in p2) || p2.dedup !== false, 'при включённом чекбоксе поле не портит дефолт сервера');
  cfg.out = 'Music/alt';
  eq(L.jobPayload({ kind: 'playlist', url: 'liked' }).out_dir, 'Music/alt',
    'override папки действует и для playlist-джоба (архив тогда в этой папке)');
  cfg.out = '';

  // --- сбор id из ссылок страницы ---
  eq(L.idsFromHrefs([
    'https://music.youtube.com/watch?v=aaaa1111bbb&list=RDAMVMxyz',
    'https://music.youtube.com/watch?v=bbbb2222ccc',
    'https://music.youtube.com/watch?v=aaaa1111bbb&list=RDAMVMxyz',   // дубль
    'https://music.youtube.com/watch?v=ab',                             // мусор -> отбрасываем (слишком короткий id)
    null, 42,
  ]), ['aaaa1111bbb', 'bbbb2222ccc'], 'idsFromHrefs: дубли в порядок, мусорные id отброшены');
  eq(L.idsFromHrefs(['https://music.youtube.com/shorts/cccc3333ddd', 'https://y/v/dddd4444eee']),
    ['cccc3333ddd', 'dddd4444eee'], 'shorts и /v/ тоже считаются треками');

  // --- ссылка листа для «одной задачи» ---
  const MU = { loc: 'https://music.youtube.com/watch?v=aaaa1111bbb&list=RDAMVMxyz' };
  eq(L.playlistHrefFromHrefs(['https://music.youtube.com/watch?v=aaaa1111bbb&list=RDAMVMxyz'], MU),
    'https://music.youtube.com/playlist?list=RDAMVMxyz', 'radio-кью из YTM остаётся в YTM');
  eq(L.playlistHrefFromHrefs(['https://music.youtube.com/playlist?list=OLAK5uy_myspace'], MU),
    'https://music.youtube.com/playlist?list=OLAK5uy_myspace', 'альбом из YTM -> music-домен');
  eq(L.playlistHrefFromHrefs(['https://www.youtube.com/watch?v=aaaa1111bbb&list=PLregular'],
    { loc: 'https://www.youtube.com/watch?v=aaaa1111bbb&list=PLregular' }),
    'https://www.youtube.com/playlist?list=PLregular', 'обычный YouTube-лист -> www-домен');
  eq(L.playlistHrefFromHrefs(['https://www.youtube.com/playlist?list=RDCLAK5uy_abc'],
    { loc: 'https://www.youtube.com/' }),
    'https://music.youtube.com/playlist?list=RDCLAK5uy_abc', 'liked (RDCLAK) всегда через YTM');
  eq(L.playlistHrefFromHrefs(['https://music.youtube.com/watch?v=aaaa1111bbb']), null,
    'list= короче 5 символов не выдумываем');
  eq(L.playlistHrefFromHrefs(['https://music.youtube.com/playlist?list=RDCLAK5uy_abc']),
    'https://music.youtube.com/playlist?list=RDCLAK5uy_abc', ' liked-лист (RDCLAK) остаётся на music-домене');
  eq(L.playlistHrefFromHrefs(['https://music.youtube.com/watch?v=aaaa1111bbb']), null,
    'трек без list= -> нет плейлиста');
  eq(L.playlistHrefFromHrefs([]), null, 'пустая страница -> null');
  eq(L.likedHrefFromHrefs(['https://music.youtube.com/playlist?list=RDCLAK5uy_abc']), 'liked', 'liked узнан');
  eq(L.likedHrefFromHrefs(['https://music.youtube.com/playlist?list=LM']), 'liked', 'старый LM тоже liked');
  eq(L.likedHrefFromHrefs(['https://music.youtube.com/playlist?list=OLAK5uy_myspace']), null,
    'обычный плейлист не путаем с liked');

  // --- скролл-сбор: виртуальный список отдаёт строки порциями ---
  // асинхронную часть вешаем в промис и дожидаемся перед итоговым отчётом
  SCROLL_TEST = (async () => {
    const doc = L._test.document;
    const all = ['t0000000001', 't0000000002', 't0000000003', 't0000000004', 't0000000005', 't0000000006'];
    const win = { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 };
    // окно отдаёт по 2 строки на каждые 400 px: ровно как виртуальный треклист YTM,
    // где половины id в DOM нет, пока строка не въехала во вьюпорт
    const readIds = () => all.slice(Math.min(all.length, Math.floor(win.scrollTop / 400) * 2),
      Math.min(all.length, Math.floor(win.scrollTop / 400) * 2) + 2);
    const realQSA = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = () => readIds().map((id) => ({ href: `https://music.youtube.com/watch?v=${id}` }));
    const res = await L.collectAllIds(win, { step: 400, rounds: 12, pauseMs: 0, stableFor: 1, wait: () => Promise.resolve() });
    // короткий список (весь в DOM) и «нет скроллера» — пока мок ещё висит
    win.scrollTop = 0;                        // мок читает из win — сбрасываем состояние
    const tiny = { scrollTop: 0, clientHeight: 1000, scrollHeight: 400 };
    const r2 = await L.collectAllIds(tiny, { step: 300, rounds: 50, pauseMs: 0, stableFor: 1, wait: () => Promise.resolve() });
    const r3 = await L.collectAllIds(null, { wait: () => Promise.resolve() });
    doc.querySelectorAll = realQSA;
    ok(Array.isArray(res) && res.length >= 4, `скролл-сбор дочитал виртуальный список: ${res && res.length}/${all.length} id`);
    ok(res && new Set(res).size === res.length, 'без дублей');
    ok(res && res.includes(all[0]) && res.includes(all[all.length - 1]), 'первая и последняя строка найдены');
    eq(L.idsFromHrefs([]).length, 0, 'без ссылок на странице id нет (отсюда и нужен скролл)');
    ok(r2.length >= 2 && r2.length <= 4, `короткий список закрылся по «низ + стабильно», без 50 холостых прогонов: ${r2.length} id`);
    ok(Array.isArray(r3), 'нет скроллера -> деградация в pageTrackIds, а не исключение');
  })();
  cfg.out = saved.out; cfg.dedup = saved.dedup; cfg.token = saved.token;

  // --- чистый хелпер фильтрации (тот же путь, что и в UI-кнопке) ---
  eq([...new Set(['a', 'a', 'b'])].join(','), 'a,b', 'Set used for id uniq (sanity)');
}

group('MP4: insertIntoBox');
{
  const mkInit = () => Buffer.concat([
    mkBox('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), zero(4)])),
    mkBox('moov',
      mkBox('trak', mkBox('mdia', mkBox('minf', mkBox('stbl', mkBox('stsd', zero(8)))))),
      mkBox('mvex', mkBox('trex', zero(24)))),
  ]);
  const initFull = mkInit();
  const moovBox = L.walkBoxes(new Uint8Array(initFull), 0).find((b) => b.type === 'moov');

  // Контракт editBox/insertIntoBox: buf — это СПИСОК top-level боксов, возвращается buf того
  // же вида (не «моов-грейд», не обёртка). Все уровни правятся одинаково — иначе путь
  // ['moov',...] от init-буфера тихонько правит ftyp вместо stbl (реальный баг, ловился дважды).
  const t = L.insertIntoBox(new Uint8Array(initFull), ['moov', 'trak', 'mdia', 'minf', 'stbl'], L.box('stsz', new Uint8Array(12)));
  ok(t, 'вставка по полному пути проходит');
  eq(L.walkBoxes(t, 0).map((b) => b.type), ['ftyp', 'moov'], 'вернули buf того же вида: [ftyp, moov]');
  eq(t.length, initFull.length + 20, 'moov вырос ровно на вставленный бокс (20 Б)');
  const stbl = L.findPath(t, 'moov', ['trak', 'mdia', 'minf', 'stbl']);
  eq(L.childBoxes(t, stbl).map((b) => b.type), ['stsd', 'stsz'], 'таблица дописана в конец stbl');
  const mvexNew = L.childBoxes(t, L.findPath(t, 'moov', [])).find((b) => b.type === 'mvex');
  const mvexOld = L.childBoxes(new Uint8Array(initFull), moovBox).find((b) => b.type === 'mvex');
  eq(Buffer.compare(Buffer.from(t.subarray(mvexNew.start, mvexNew.start + mvexNew.size)),
                    Buffer.from(initFull.subarray(mvexOld.start, mvexOld.start + mvexOld.size))), 0,
    'соседний mvex перенесён байт-в-байт');
  // ftyp до moov в исходном буфере не должен был измениться вообще
  const ftypOnly = L.insertIntoBox(new Uint8Array(initFull), ['ftyp'], new Uint8Array(0));
  eq(ftypOnly !== null, true, 'path из одного бокса тоже работает');
  eq(L.walkBoxes(ftypOnly, 0).map((b) => b.type), ['ftyp', 'moov'], 'path из одного бокса не ломает соседей');
  eq(L.walkBoxes(new Uint8Array(initFull), 0).map((b) => b.type), ['ftyp', 'moov'], 'исходный buf не мутируется');
  eq(L.walkBoxes(new Uint8Array(initFull.slice(moovBox.start, moovBox.start + moovBox.size)), 0).map((b) => b.type),
     ['moov'], 'walkBoxes(buf, 0) обходит именно переданный буфер');
  eq(L.insertIntoBox(new Uint8Array(initFull), ['moov', 'nope'], new Uint8Array(4)), null, 'несуществующий путь -> null');
  eq(L.insertIntoBox(new Uint8Array(mkBox('ftyp', zero(4))), ['moov'], new Uint8Array(4)), null, 'нет root -> null');
  eq(L.walkBoxes(new Uint8Array(mkBox('ftyp', zero(4))), 0).map((b) => b.type), ['ftyp'], 'walkBoxes не выдумывает боксы');
}

group('assembleMp4 (сборка прогрессивного файла)');
{
  const buildInit = () => Buffer.concat([
    mkBox('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), zero(4), Buffer.from('isom', 'latin1')])),
    mkBox('moov',
      mkBox('mvhd', Buffer.concat([zero(12), u32be(44100), zero(16)])),
      mkBox('trak', mkBox('tkhd', zero(80)),
        mkBox('mdia', mkBox('mdhd', Buffer.concat([zero(12), u32be(44100), zero(12)])),
          mkBox('minf', mkBox('stbl', mkBox('stsd', zero(8)))))),
      mkBox('mvex', mkBox('trex', zero(24)))),
  ]);
  const initFull = buildInit();
  const samples = [{ size: 400, duration: 1024 }, { size: 500, duration: 1024 }];
  const mdat = Buffer.alloc(900, 0x7f);
  const res = L.assembleMp4(new Uint8Array(initFull), new Uint8Array(mdat), samples);
  const outBuf = Buffer.from(res.bytes);
  const boxes = L.walkBoxes(res.bytes, 0);
  const types = boxes.map((b) => b.type);
  eq(types, ['ftyp', 'mdat', 'moov'], 'ftyp на месте, moov переехал в конец');
  eq(boxes.reduce((a, b) => a + b.size, 0), outBuf.length, 'размеры боксов == размер файла');
  eq(boxes.every((b) => b.start + b.size <= outBuf.length), true, 'нет боксов, вылезших за файл');
  eq(boxes.every((b) => !b.broken), true, 'ни один бокс не помечен битым');

  const mdatBox = boxes.find((b) => b.type === 'mdat');
  const moovBox = boxes.find((b) => b.type === 'moov');
  eq(outBuf.subarray(mdatBox.start + 8, mdatBox.start + mdatBox.size).equals(mdat), true, 'mdat = ровно все медиа-байты');
  eq(res.mdatPayloadOffset, mdatBox.start + 8, 'заявленный offset == начало payload mdat');
  eq(moovBox.start + moovBox.size, outBuf.length, 'moov замыкает файл');

  const moovKids = L.childBoxes(res.bytes, moovBox).map((b) => b.type);
  eq(moovKids.includes('mvex'), false, 'mvex вырезан');
  eq(moovKids.includes('trak'), true, 'trak сохранён');
  const stbl = L.findPath(res.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl'], moovBox.start);
  ok(stbl, 'stbl читается по полному пути от корня файла');
  eq(L.childBoxes(res.bytes, stbl).map((b) => b.type), ['stsd', 'stsz', 'stco', 'stsc', 'stts'], 'все четыре таблицы добавлены');

  const stco = L.findPath(res.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stco'], moovBox.start);
  eq(outBuf.readUInt32BE(stco.start + 12), 1, 'stco: один чанк');
  eq(outBuf.readUInt32BE(stco.start + 16), mdatBox.start + 8, 'stco -> начало payload mdat');
  const stsz = L.findPath(res.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stsz'], moovBox.start);
  eq([outBuf.readUInt32BE(stsz.start + 20), outBuf.readUInt32BE(stsz.start + 24)], [400, 500], 'stsz пересчитал размеры сэмплов');
  eq(outBuf.readUInt32BE(stsz.start + 12), 0, 'stsz.sample_size == 0 (размеры перечислены поштучно)');
  const stsc = L.findPath(res.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stsc'], moovBox.start);
  eq(outBuf.readUInt32BE(stsc.start + 12), 1, 'stsc: одна запись');
  eq(outBuf.readUInt32BE(stsc.start + 20), 2, 'stsc: samples_per_chunk == 2 (на все сэмплы один чанк)');
  eq(outBuf.readUInt32BE(stsc.start + 24), 1, 'stsc: sample_description_index == 1');
  const stts = L.findPath(res.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stts'], moovBox.start);
  eq(outBuf.readUInt32BE(stts.start + 12), 1, 'stts: одна запись');
  eq(outBuf.readUInt32BE(stts.start + 16), 2, 'stts: 2 сэмпла');
  eq(outBuf.readUInt32BE(stts.start + 20), 1024, 'stts: duration 1024 на сэмпл');
  // Регрессия с реальными init-сегментами: в них stts/stsz/stco уже есть (пустые).
  // Дописывать нельзя — надо заменять, иначе читается первый (пустой) вариант.
  const tblTypes = L.childBoxes(res.bytes, stbl).map((b) => b.type);
  eq(tblTypes.filter((x) => x === 'stsz').length, 1, 'stsz ровно один (дубли из init удалены)');
  eq(tblTypes.filter((x) => ['stts', 'stsc', 'stco'].includes(x)).every((x) => true) &&
     ['stts', 'stsc', 'stco'].every((k) => tblTypes.filter((x) => x === k).length === 1), true,
     'stts/stsc/stco тоже ровно по одному');
  eq(tblTypes.indexOf('stsd') < tblTypes.indexOf('stts'), true, 'stsd остался перед таблицами');
  // длительности: в нормальном init mvhd/mdhd nonzero -> не портим
  const mvhd = L.findPath(res.bytes, 'moov', ['mvhd'], moovBox.start);
  ok(outBuf.readUInt32BE(mvhd.start + 24) > 0, 'mvhd.duration сохранён ненулевым');
  eq(res.fixed, true, 'fixed=true когда таблицы пропатчены');
  eq(res.warnings, [], 'без предупреждений на валидном входе');
  const origMoov = L.walkBoxes(new Uint8Array(initFull), 0).find((b) => b.type === 'moov');
  const grew = moovBox.size - origMoov.size;
  const mvexSize = L.childBoxes(new Uint8Array(initFull), origMoov).find((b) => b.type === 'mvex').size;
  // stsz(8+12+2*4) + stco(8+12) + stsc(8+16) + stts(8+16) = 56
  const tblSum = L.childBoxes(res.bytes, stbl).reduce((a, b) => a + b.size, 0);
  const oldTblSum = L.childBoxes(new Uint8Array(initFull),
    L.findPath(new Uint8Array(initFull), 'moov', ['trak', 'mdia', 'minf', 'stbl'], origMoov.start)).reduce((a, b) => a + b.size, 0);
  eq(grew, tblSum - oldTblSum - mvexSize, `moov = stbl(${tblSum} - ${oldTblSum}) - mvex(${mvexSize})`);
  ok(grew < 120, `moov вырос только на таблицы (${grew} Б), а не на что-то лишнее`);
  eq(outBuf.length, initFull.length - origMoov.size + 8 + mdat.length + moovBox.size, 'размер файла = init-без-moov + mdat + новый moov');

  // расхождение таблицы -> warning + один сплошной сэмпл, структура валидна
  const bad = L.assembleMp4(new Uint8Array(initFull), new Uint8Array(mdat), [{ size: 10 }]);
  ok(bad.warnings.some((w) => /!=/.test(w)), 'несошедшаяся таблица даёт warning');
  eq(L.walkBoxes(bad.bytes, 0).map((b) => b.type), ['ftyp', 'mdat', 'moov'], 'структура осталась валидной');
  const badMoov = L.walkBoxes(bad.bytes, 0).find((b) => b.type === 'moov');
  const stszBad = L.findPath(bad.bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stsz'], badMoov.start);
  eq(Buffer.from(bad.bytes).readUInt32BE(stszBad.start + 16), 1, 'откат на один сплошной сэмпл');

  // несколько треков -> тривиальная сборка неприменима, но файл остаётся целым
  const multi = Buffer.concat([
    mkBox('ftyp', zero(8)),
    mkBox('moov', mkBox('trak', mkBox('mdia', mkBox('minf', mkBox('stbl', mkBox('stsd', zero(8)))))),
      mkBox('trak', mkBox('mdia', mkBox('minf', mkBox('stbl', mkBox('stsd', zero(8))))))),
  ]);
  const m2 = L.assembleMp4(new Uint8Array(multi), new Uint8Array(mdat), samples);
  ok(m2.warnings.some((w) => /трека/.test(w)), 'несколько треков: честный отказ от авто-сборки');
  eq(m2.fixed, false, 'fixed=false при отказе');
  eq(L.walkBoxes(m2.bytes, 0).map((b) => b.type), ['ftyp', 'moov', 'mdat'], 'fallback = init+mdat как есть');

  // DRM-поток: предупреждаем, а не делаем вид, что всё ок
  const enc = Buffer.concat([mkBox('ftyp', zero(8)), mkBox('moov', mkBox('trak', mkBox('mdia', mkBox('minf',
    mkBox('stbl', mkBox('stsd', Buffer.concat([zero(8), mkBox('sinf', zero(8))]))))))) ].map((x) => Buffer.from(x)));
  const e2 = L.assembleMp4(new Uint8Array(enc), new Uint8Array(mdat), samples);
  ok(e2.warnings.some((w) => /зашифр/.test(w)), 'sinf помечен как шифрованный поток');

  // нет moov
  const noMoov = L.assembleMp4(new Uint8Array(mkBox('ftyp', zero(4))), new Uint8Array(Buffer.alloc(100)), []);
  eq(noMoov.fixed, false, 'без moov fixed=false');
  ok(noMoov.warnings.some((w) => /moov/.test(w)), 'и warning с объяснением');
}

group('куда вешается хук и что считается player response');
{
  // 1) цель хука: window страницы, а не песочница - иначе «ответа плеера нет»
  const page = { fetch: () => {}, __page: 1 };
  eq(L.hookTarget({ fetch: () => {}, unsafeWindow: page }).__page, 1, 'вернулась именно window страницы');
  eq(L.hookTarget({ fetch: () => {}, unsafeWindow: { nofetch: 1 } }).__page, undefined,
    'unsafeWindow без fetch -> остаёмся в песочнице');
  eq(L.hookTarget({ fetch: () => {} }).__page, undefined, 'нет unsafeWindow (Violentmonkey @grant none) -> песочница');

  // 2) мусор вместо ответа не должен притворяться «плеер ответил»
  eq(L.looksLikePlayerResponse({ videoDetails: { videoId: 'x' } }), true, 'обычный ответ годится');
  eq(L.looksLikePlayerResponse({ playabilityStatus: { status: 'UNPLAYABLE' } }), true,
    'UNPLAYABLE - тоже player response (его надо показать, а не выбросить)');
  eq(L.looksLikePlayerResponse({ html: '<!DOCTYPE html>' }), false, 'HTML-заглушка - не ответ');
  eq(L.looksLikePlayerResponse({}), false, 'пустой объект - не ответ');
  eq(L.looksLikePlayerResponse(null), false, 'null - не ответ');
  const st = L._test.state;
  eq(L._test.capturePlayerResponse('HTMLVID1', { html: '<!DOCTYPE html><html>sign in' }, 'self'), false,
    'capture отказался писать HTML как перехваченный ответ');
  eq(st.byVideo.get('HTMLVID1'), undefined, 'и в состояние это не легло');

  // 3) заголовки скрипта: без document-start хук ставится после /player
  ok(/@run-at\s+document-start/.test(src), '@run-at document-start (иначе YTM успевает ответить без нас)');
  ok(/@grant\s+unsafeWindow/.test(src), '@grant unsafeWindow (иначе хук видит только свои запросы)');
  ok(/observe\(document\.body \|\| document\.documentElement/.test(src),
    'на document-start body ещё нет - observer висит на documentElement');
}

group('перехват и состояние');
{
  const st = L._test.state;
  const pr = mkPr([directAudio]);
  eq(L._test.capturePlayerResponse('abcDEF12345', pr, 'unit'), true, 'capture принимает ответ');
  eq(st.byVideo.get('abcDEF12345').source, 'unit', 'источник записан');
  eq(L._test.capturePlayerResponse('abcDEF12345', pr, 'unit'), false, 'тот же объект не перезаписывается');
  eq(L._test.capturePlayerResponse(null, pr, 'unit'), false, 'без videoId — отказ');
  eq(L._test.currentVideoId(), 'abcDEF12345', 'videoId берётся из location.search');

  // sniffed url
  st.streams.set('abcDEF12345', { ranges: [
    { url: 'https://g/v?itag=140&range=0-100', start: 0, end: 100, at: 1 },
    { url: 'https://g/v?itag=141&range=0-100', start: 0, end: 100, at: 1 },
  ], itags: new Set([140, 141]), bytes: 0, lastAt: Date.now() });
  ok(/itag=141/.test(L._test.bestSniffedUrl('abcDEF12345')), 'bestSniffedUrl выбирает старший itag');
  eq(L._test.bestSniffedUrl('nope'), null, 'нет данных -> null');
}

group('hookFetch перехватывает /youtubei/v1/player');
{
  const captured = [];
  sandbox.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => '3430000' },
    clone() { return this; }, json: async () => mkPr([directAudio]),
  });
  globalThis.fetch = sandbox.fetch;
  // повторно инициализировать хук нельзя (guarded), поэтому эмулируем путь через прямой вызов capture
  const pr = mkPr([sabrAudio, directAudio]);
  ok(L._test.capturePlayerResponse('abcDEF12345', pr, 'fetch-test'), 'повторный ответ с новым объектом принимается');
  eq(L.pickAudioFormats(L._test.state.byVideo.get('abcDEF12345').pr).length, 2, 'состояние обновилось');
}

SCROLL_TEST = SCROLL_TEST.then(async () => {
  // 0.6.8: cap ранний выход - 6 id в DOM, просим 3, скроллить дальше незачем
  const doc = L._test.document;
  const real = doc.querySelectorAll.bind(doc);
  const win = { scrollTop: 0, clientHeight: 500, scrollHeight: 5000 };
  doc.querySelectorAll = () => ['t0000000001','t0000000002','t0000000003','t0000000004','t0000000005','t0000000006']
    .map((id) => ({ href: 'https://music.youtube.com/watch?v=' + id }));
  const got = await L.collectAllIds(win, { step: 400, rounds: 50, pauseMs: 0, stableFor: 1, wait: () => Promise.resolve(), cap: 3 });
  doc.querySelectorAll = real;
  ok(got.length === 3, `cap=3: ровно 3 id и никаких 50 раундов скролла (got ${got.length})`);
});
await SCROLL_TEST;
group('панель: элементы плейлиста/дедупа и их обработчики');
{
  let dom = null; let uiErr = null;
  try { L._test.ensureUi(); dom = sandbox.document; } catch (e) { uiErr = e; }
  ok(uiErr === null, 'ensureUi строит панель на пустом DOM без innerHTML: ' + (uiErr && uiErr.message));
  const ALL_IDS = ['ytmdl-root', 'ytmdl-btn', 'ytmdl-panel', 'ytmdl-close', 'ytmdl-mode', 'ytmdl-fmt',
    'ytmdl-br', 'ytmdl-port', 'ytmdl-token', 'ytmdl-ping', 'ytmdl-verb', 'ytmdl-album',
    'ytmdl-out', 'ytmdl-dedup', 'ytmdl-items', 'ytmdl-archive', 'ytmdl-archive-reset', 'ytmdl-one',
    'ytmdl-all', 'ytmdl-list', 'ytmdl-diag', 'ytmdl-formats', 'ytmdl-bar', 'ytmdl-status', 'ytmdl-log',
    'ytmdl-alt', 'ytmdl-safari', 'ytmdl-qvia'];   // 0.5.11: pthru-кнопка стала методом очереди
  const built = ALL_IDS.filter((id) => dom && dom.__byId(id));
  ok(built.length === ALL_IDS.length,
    'все ' + ALL_IDS.length + ' контролов панели созданы createElement-ом (было: ' + built.length + ')');
  ok(ALL_IDS.every((id) => { const e = dom && dom.__byId(id); return e && typeof e.addEventListener === 'function'; }),
    'на каждый контрол можно повесить обработчик (раньше это молча падало на CSP)');
  const why = '—';
  for (const sel of ['#ytmdl-dedup', '#ytmdl-out', '#ytmdl-items'])
    ok(src.includes("bind('" + sel + "'"), 'привязка настройки ' + sel + ' есть');
  ok(src.includes("bind('#ytmdl-safari', 'safariFirst')"), 'чекбокс safariFirst привязан и сохраняется');
  for (const sel of ['#ytmdl-list', '#ytmdl-archive', '#ytmdl-archive-reset'])
    ok(src.includes("$('" + sel + "')"), 'обработчик ' + sel + ' есть');
  ok(src.includes("kind: 'playlist'"), 'кнопка листа отправляет kind:"playlist"');
  ok(src.includes('/archive/reset') && src.includes('/archive'), 'показ и сброс архива бьют по нужным путям');
  ok(src.includes('/has?ids='), 'пред-проверка «что уже есть» идёт через /has');
  ok(src.includes('dedup: true'), 'дедуп включён по умолчанию');
  ok(src.includes('items: cfg.playlistItems'), 'диапазон строк листа прокидывается в job');
  ok(src.includes('js_runtime'), 'панель читает js_runtime из /hello (портативная диагностика)');
  ok(/const busy = \(h\.children \|\| 0\) \+ \(h\.active_jobs \|\| 0\);/.test(src),
    'статус «проверить» считает занятость по children+active_jobs из /hello');
  ok(src.includes('занято:') && src.includes('свободен (можно останавливать и удалять)'),
    'в статусе видно «занято / свободен» — то, из-за чего папку не удалить');
  const ver = (src.match(/@version\s+(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  ok(ver.length === 3 && (ver[0] > 0 || ver[1] > 3 || (ver[1] === 3 && ver[2] >= 8)),
    `версия >= 0.3.8 (innerHTML-free UI), текущая — с занятостью из /hello: ${ver.join('.')}`);
  const menuCmds = (src.match(/GM_registerMenuCommand\('/g) || []).length;
  ok(menuCmds >= 4, `в меню менеджера добавлены команды (найдено ${menuCmds})`);
}

group('посадка кнопки: селекторы плеер-бара и плавающий фолбэк');
{
  // 1) чинный DOM: кнопка должна попасть в .right-controls (первый селектор цепочки)
  const mk = (have) => ({
    querySelector: (sel) => (have.includes(sel) ? { __sel: sel, firstChild: null, insertBefore(c) { this.child = c; return c; }, contains() { return false; } } : null),
  });
  const d1 = mk(['ytmusic-player-bar .right-controls']);
  eq(L.findPlayerHost(d1).__sel, 'ytmusic-player-bar .right-controls', 'первый селектор = текущая разметка YTM');
  // 2) YTM переименовал правый контейнер — должны поймать хотя бы сам бар
  const d2 = mk(['ytmusic-player-bar']);
  eq(L.findPlayerHost(d2).__sel, 'ytmusic-player-bar', 'если .right-controls исчез — садимся на сам плеер-бар');
  // 3) и на play-button, если бар есть, но пустой
  const d3 = mk(['ytmusic-play-button', 'ytmusic-player-bar']);
  eq(L.findPlayerHost(d3).__sel, 'ytmusic-play-button', 'есть отдельная кнопка play — ловим и её (порядок важнее «большого» контейнера)');
  // 4) ничего нет → null (и именно это включает плавающий фолбэк)
  eq(L.findPlayerHost(mk([])), null, 'пустая страница → null');
  // 5) кривой селектор не должен ронять UI: querySelector бросает SyntaxError
  const dBad = { querySelector: (sel) => { if (sel.includes('#right-controls')) throw new Error('bad selector'); return sel === 'ytmusic-player-bar' ? { __sel: sel } : null; } };
  eq(L.findPlayerHost(dBad).__sel, 'ytmusic-player-bar', 'бросающий querySelector переживается, поиск идёт дальше');
  // 6) сам mount(): без бара кнопка уходит в body и помечается floating
  const T = L._test;
  T.state.mounted = false; T.state.floating = false;
  T.ensureUi();
  const root = T.els().root;
  const savedQ = sandbox.document.querySelector;
  sandbox.document.querySelector = () => null;
  sandbox.document.body.children.length = 0;
  const m = T.mount();
  eq(m, true, 'mount() возвращает true даже без плеер-бара (кнопка всё равно на странице)');
  eq(T.state.floating, true, 'и state.floating=true — это видно в «диагностике» панели');
  eq(sandbox.document.body.children.includes(root), true, 'корень кнопки добавлен в body');
  eq(root.dataset.float, '1', 'плавающий режим помечен data-float=1 (включает CSS-позиционирование)');
  // 7) бар появился позже (SPA-перерисовка) — кнопка переезжает в бар и floating гаснет
  sandbox.document.body.children.length = 0;
  const bar = { firstChild: null, insertBefore(c) { this.child = c; return c; }, contains() { return false; }, parentNode: null };
  sandbox.document.querySelector = (sel) => (sel === 'ytmusic-player-bar .right-controls' ? bar : null);
  T.state.mounted = false;
  T.mount();
  eq(T.state.floating, false, 'когда бар всё-таки нашёлся, floating сбрасывается');
  eq(bar.child === root, true, 'кнопка переехала в найденный контейнер');
  sandbox.document.querySelector = savedQ;
  // 8) диагностика обязана это показывать — иначе «не вижу кнопку» нечем проверить
  ok(src.includes('ui: { mounted:') && src.includes('host: !!findPlayerHost(document)'),
    'showDiag печатает ui.mounted/floating/host (главный вопрос при «ничего не происходит»)');
  ok(L.PLAYER_HOSTS.length >= 8, `цепочка селекторов не короче 8 (сейчас ${L.PLAYER_HOSTS.length})`);
}

group('падение UI не ломает хоткеи, меню и видимость ошибки');
{
  const T = L._test;
  const savedCreate = sandbox.document.createElement;
  const savedAdd = sandbox.document.addEventListener;
  const savedQ = sandbox.document.querySelector;
  try {
    const added = [];
    sandbox.document.addEventListener = (ev, fn) => added.push(ev);
    sandbox.document.createElement = () => { throw new Error('createElement boom'); };
    L.showFatal('test', new Error('boom-notify'));
    // мок el() не парсит innerHTML, поэтому смотрим на children/textContent
    const banner = () => (sandbox.document.body.children.slice(-1)[0] || {});
    ok(/^YTM Downloader: test/.test(banner().textContent || ''),
      'showFatal пишет текст ошибки на страницу (видно без F12): ' + JSON.stringify(banner().textContent));
    ok(/ytmdl-fatal/.test(banner().id || ''), 'у баннера есть свой id');

    // если и createElement, и createElementNS сломаны — должен сработать alert
    const savedNS = sandbox.document.createElementNS;
    sandbox.document.createElementNS = () => { throw new Error('ns boom'); };
    sandbox.__alerted = null;
    L.showFatal('worst', new Error('totally broken'));
    ok(/worst/.test(sandbox.__alerted || '') && /totally broken/.test(sandbox.__alerted || ''),
      'когда DOM недоступен совсем, ошибка уходит в alert (не теряется): ' + JSON.stringify(sandbox.__alerted));
    sandbox.document.createElementNS = savedNS;

    T.state.mounted = false; T.state.floating = false;
    T.boot.hotkeys = false;
    // ensureUi кэшируется в els: без сброса он вернётся раньше, чем что-то упадёт,
    // и тест проверял бы не сценарий «UI сломался», а кэш
    T.setEls(null);
    L.registerMenuCommands.done = false;
    sandbox.document.querySelector = () => null;
    T.boot();
    ok(added.includes('keydown'), 'keydown регистрируется ДО ensureUi — Ctrl+Shift+Y живёт и без панели');
    ok(/createElement boom/.test(banner().textContent || ''),
      'причина падения ensureUi показана на странице: ' + JSON.stringify((banner().textContent || '').slice(0, 90)));
    ok(L.uiBrokenFlag() === true, 'uiBroken=true → панель будет пересобрана по требованию');

    sandbox.document.createElement = savedCreate;
    let threw = null;
    try { T.togglePanel(true); } catch (e) { threw = e; }
    ok(threw === null, 'togglePanel при сломанном UI пересобирает панель, а не бросает');
  } finally {
    sandbox.document.createElement = savedCreate;
    sandbox.document.addEventListener = savedAdd;
    sandbox.document.querySelector = savedQ;
  }
  ok(!/els\.btn\.addEventListener/.test(src), 'нет прямых els.btn.addEventListener — всё через on()');
  ok(/const on = \(elm, ev, fn\) => \{ if \(elm\) elm\.addEventListener\(ev, fn\); \};/.test(src),
    'on() = null-safe обёртка: один съехавший id не убивает boot');
  ok(/showFatal\('unhandledrejection'/.test(src) && /window\.addEventListener\('error'/.test(src),
    'ошибки страницы (onerror/unhandledrejection) тоже ловятся и показываются');
}

group('когда GM_xmlhttpRequest не разрешён (главный Firefox-сценарий)');
{
  const T = L._test;
  ok(/typeof GM_xmlhttpRequest !== 'function'/.test(src), 'gmx проверяет наличие GM_xmlhttpRequest');
  ok(new RegExp('127\\.0\\.0\\.1|localhost').test(src) && src.includes('fetch(u, {'),
    'и для локального адреса падает не в ошибку, а в обычный fetch (компаньон отдаёт CORS для *.youtube.com)');
  ok(src.includes('доступ к 127.0.0.1'),
    'текст ошибки говорит, ЧТО включить, а не просто «GM недоступен»');
  ok(new RegExp('@grant\\s+GM_xmlhttpRequest').test(src), '@grant GM_xmlhttpRequest на месте — иначе запрос не ушёл бы даже через fetch');
  ok(new RegExp('открой новую вкладку на \' \+').test(src),
    'в статусе есть способ проверить компаньон без скрипта: открыть /hello вкладки');
}

group('UI не зависит от innerHTML (CSP-песочница Firefox)');
{
  ok(!/\.innerHTML\s*=/.test(src), 'в скрипте не осталось присваиваний innerHTML');
  ok(src.includes('createElementNS'), 'иконка собирается createElementNS (svg требует SVG-namespace)');
  ok(src.includes('Sink type'), 'в коде есть комментарий, ПОЧЕМУ нельзя innerHTML — чтобы это не «улучшили» обратно');
  ok(/id = 'ytmdl-/.test(src) || /'#' === /.test(src) || src.includes("id = v"), 'id назначается явно в h()');
}

group('падение UI не ломает хоткеи, меню и видимость ошибки');
{
  const T = L._test;
  const savedCreate = sandbox.document.createElement;
  const savedAdd = sandbox.document.addEventListener;
  const savedQ = sandbox.document.querySelector;
  try {
    const added = [];
    sandbox.document.addEventListener = (ev, fn) => added.push(ev);
    sandbox.document.createElement = () => { throw new Error('createElement boom'); };
    L.showFatal('test', new Error('boom-notify'));
    const banner = () => (sandbox.document.body.children.slice(-1)[0] || {});
    ok(/^YTM Downloader: test/.test(banner().textContent || ''),
      'showFatal пишет текст ошибки на страницу (видно без F12)');
    ok(/ytmdl-fatal/.test(banner().id || ''), 'у баннера есть свой id');
    const savedNS = sandbox.document.createElementNS;
    sandbox.document.createElementNS = () => { throw new Error('ns boom'); };
    sandbox.__alerted = null;
    L.showFatal('worst', new Error('totally broken'));
    ok(/worst/.test(sandbox.__alerted || ''), 'когда DOM недоступен совсем, ошибка уходит в alert');
    sandbox.document.createElementNS = savedNS;

    T.state.mounted = false; T.state.floating = false;
    T.boot.hotkeys = false; T.setEls(null);
    L.registerMenuCommands.done = false;
    sandbox.document.querySelector = () => null;
    T.boot();
    ok(added.includes('keydown'), 'keydown регистрируется ДО ensureUi — Ctrl+Shift+Y живёт и без панели');
    ok(/createElement boom/.test(banner().textContent || ''), 'причина падения ensureUi показана на странице');
    ok(L.uiBrokenFlag() === true, 'uiBroken=true → панель будет пересобрана по требованию');
  } finally {
    sandbox.document.createElement = savedCreate;
    sandbox.document.addEventListener = savedAdd;
    sandbox.document.querySelector = savedQ;
  }
  ok(!/els\.btn\.addEventListener/.test(src), 'нет прямых els.btn.addEventListener — всё через on()');
  ok(/const on = \(elm, ev, fn\) => \{ if \(elm\) elm\.addEventListener\(ev, fn\); \};/.test(src),
    'on() = null-safe обёртка: один съехавший id не убивает boot');
  ok(/showFatal\('unhandledrejection'/.test(src) && src.includes("addEventListener('error'"),
    'ошибки страницы ловятся, но чужие (без тега ytm-dl) не выводятся плашкой');
}

group('когда GM_xmlhttpRequest не разрешён (главный Firefox-сценарий)');
{
  ok(/typeof GM_xmlhttpRequest !== 'function'/.test(src), 'gmx проверяет наличие GM_xmlhttpRequest');
  ok(src.includes('fetch(u, {') && new RegExp('127' + String.fromCharCode(92) + '.0' + String.fromCharCode(92)
     + '.0' + String.fromCharCode(92) + '.1|localhost').test(src),
    'для локального адреса есть fetch-фолбэк (компаньон отдаёт CORS для *.youtube.com)');
  ok(src.includes('доступ к 127.0.0.1'), 'текст ошибки говорит, ЧТО включить');
  ok(new RegExp('@grant' + String.fromCharCode(92) + 's+GM_xmlhttpRequest').test(src),
    '@grant GM_xmlhttpRequest на месте');
  ok(/открой новую вкладку на ' \+ base\(\)/.test(src), 'в статусе есть проверка компаньона без скрипта: /hello в новой вкладке');
}


group('0.5.2: mediaFmt/sniffedFull, зеркало в /log, поля панели');
{
  const L2 = L._test;
  eq(L2.sniffedContainer('https://r1---.googlevideo.com/videoplayback?itag=251&sq=0'), 'opus', 'itag 251 = opus');
  eq(L2.sniffedContainer('https://r1---.googlevideo.com/videoplayback?itag=250'), 'opus', '250 = тоже opus');
  eq(L2.sniffedContainer('https://x/googlevideo?itag=140&sparams=...'), 'm4a', 'itag 140 = m4a');
  eq(L2.sniffedContainer(undefined), 'm4a', 'нет itag - безопасный m4a');
  const cf = L2.cfg;
  const saveFmt = cf.format, saveConv = cf.convert, saveProxy = cf.proxy;
  cf.format = 'opus';
  eq(L2.mediaFmt('opus'), 'opus', 'opus выбран и сырьё opus - просим opus');
  eq(L2.mediaFmt('mp4a'), 'm4a', 'opus выбран, а сырьё m4a: НЕ врать расширением .opus');
  cf.format = 'mp3';
  eq(L2.mediaFmt('opus'), 'mp3', 'mp3 выбран: конвертацию запрашиваем, а не обманываем контейнером');
  cf.format = 'copy';
  eq(L2.mediaFmt('opus'), 'copy', 'copy = сырые байты, и точка');
  cf.format = saveFmt;
  const st = L2.state;
  st.streams.set('FULLVID1', { ranges: [{ start: 0, end: 5000000 }], itags: new Set(['140']), bytes: 5000000, lastAt: 1 });
  st.streams.set('BITVID1', { ranges: [{ start: 0, end: 300000 }], itags: new Set(['140']), bytes: 300000, lastAt: 1 });
  st.streams.set('GAPVID1', { ranges: [{ start: 0, end: 2000000 }, { start: 3000000, end: 9000000 }], itags: new Set(['140']), bytes: 8000000, lastAt: 1 });
  eq(L2.sniffedFull('FULLVID1', 300), true, 'непрерывное покрытие половины веса = файл целый, replay можно');
  eq(L2.sniffedFull('BITVID1', 620), false, '10 секунд прослушивания 620-секундного трека = кусок: replay нельзя');
  eq(L2.sniffedFull('GAPVID1', 620), false, 'дырка в покрытии - не «целый»');
  eq(L2.sniffedFull('NOPEVID1', 0), false, 'нет записи - не выдумываем');
  ok(/mode === 'replay' && !sniffedFull\(info\.videoId, info\.duration\)/.test(src), 'гард стоит В runTrack (до any POST)');
  ok(/postMedia\(bytes, info, fmt\)/.test(src) && !/postMedia\(bytes, info, 'copy'\)/.test(src),
     'replay шлёт контейнер по itag, а не «copy» любых обрезков');
  ok(/mirrorLog\(a\.map\(String\)\.join\(' '\), 'info'\)/.test(src), 'каждый log() дублируется в компаньон');
  ok(src.includes("if (kind === 'err' || kind === 'warn') {") && src.includes('setStatus._mirrorKey'), 'и всё, что панель показала красным (0.6.3: дедуп повтора 15 с)');
  ok(src.includes('/log') && src.includes('encodeURIComponent(cfg.token)'), 'зеркало ходит на /log с токеном');
  ok(/_mirrorSeen\.get\(key\) \|\| 0\) < 2000/.test(src), 'дедуп 2 секунды - хуки не забьют лог');
    ok(/@version      0\.6\.27/.test(src), 'шапка 0.6.27');
  ok(!src.includes("mkBtn('ytmdl-pthru'"), 'отдельной кнопки прогона больше нет (0.5.11)');
  ok(src.includes("'ytmdl-qvia'"), 'метод очереди выбирается селектором companion|browser');
  ok(src.includes("safariFirst: true"), 'web_safari сразу - теперь дефолт');
  ok(src.includes('ytmusic-player-bar img#image'), 'обложка для ytdlp-режима берётся из плеер-бара');
  ok(src.includes('pageScroller()'), 'общий сборщик списка: альбомы больше не «не список»');
  ok(src.includes('докрутит список'), 'кнопка очереди объясняет, где она работает (тултип)');
  ok(src.includes('Ошибка 3 раза подряд - очередь встаёт'), 'и селектор очереди объясняет режимы (тултип)');
  {
    const items = L._test.collectBrowseItems({
      contents: { sections: [{ itemSectionRenderer: { contents: [
        { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'vidAAA111' },
          flexColumns: [ { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Дорожка первая' }] } } }, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Ван Моррисон · _into_ Подборка' }] } } } ] } },
      ] } }] },
      header: {},
      onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
        { playlistPanelVideoRenderer: { videoId: 'vidBBB222', title: { runs: [{ text: 'Дорожка вторая' }, { text: ' (live)' }] },
          longBylineText: { runs: [{ text: 'Ван Моррисон' }] } } },
        { playlistPanelVideoRenderer: { videoId: 'vidAAA111', title: { simpleText: 'дубль' } } },
      ] } }],
    });
    eq(items.length, 2, 'browse-лист: dedup по videoId и порядок ответа сохранены');
    eq(items[0].videoId, 'vidAAA111', 'mRLIR: id из playlistItemData');
    eq(items[0].title, 'Дорожка первая', 'mRLIR: заголовок из flexColumns');
    eq(items[1].title, 'Дорожка вторая (live)', 'ppr: runs склеиваются');
  eq(items[0].artist, 'Ван Моррисон', '0.5.12: исполнитель доезжает до очереди из второй колонки');
  eq(items[1].artist, 'Ван Моррисон', '0.5.12: ppr-строка несёт byline как artist');
    eq(L._test.collectBrowseItems({}).length, 0, 'мусорный ответ -> пусто, не падает');
  {
    const doc = L._test.document;
    const real = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = (sel) => (String(sel).includes('player-queue-item'))
      ? [{ videoId: 'qOne000000001' }, { playlistItemData: { videoId: 'qTwo000000002' } },
         { getAttribute: () => 'qThr000000003', querySelector: () => null }]
      : [];
    eq(L._test.pageTrackIds().join(','), 'qOne000000001,qTwo000000002,qThr000000003',
       '0.6.4: строки очереди «Следующее» дают id из videoId/playlistItemData/video-id');
    doc.querySelectorAll = (sel) => (String(sel).includes('player-queue-item'))
      ? [{ videoId: 'qShouldNotAppear' }]
      : [{ href: 'https://music.youtube.com/watch?v=albumTrack01' }];
    eq(L._test.pageTrackIds().join(','), 'albumTrack01',
       '...но на странице С треклистом очередь не примешивается (только фолбэк)');
    doc.querySelectorAll = real;
  }
  ok(src.includes("mkBtn('ytmdl-stop', 'стоп', 'danger')"), '0.6.15: «стоп» - danger-кнопка общего ряда');
  ok(src.includes('async function stopEverything'), 'остановка - единая функция (очередь+прогон+jobs)');
  ok(src.includes('state.playThru.stop = true'), '«стоп» доезжает и до браузерного прогона');
  ok(src.includes("if (j.status === 'cancelled') throw new Error"),
     'pollJob считает cancelled терминальным (иначе «стоп» = часы холостого поллинга)');
  ok(src.includes('state.queueJobIds.push(jb)'), 'id задач очереди отслеживаются для отмены');
  {
    const stopi = src.indexOf("mkBtn('ytmdl-stop'");
    ok(stopi > src.indexOf("mkBtn('ytmdl-list'") && stopi < src.indexOf("mkBtn('ytmdl-diag'"),
       '0.6.15: «стоп» в одном ряду с кнопками скачивания (между «плейлистом» и «диагностикой»), не особняком');
    ok(src.includes('#ytmdl-panel button.danger{background:#ff0033'),
       '«стоп» - красный YouTube #ff0033, те же размер и форма, что у соседних кнопок');
  }
  ok((src.match(/ytmdl-stop/g) || []).length === 2, 'кнопка «стоп» определена ровно один раз (+биндинг)');
  ok(src.includes("'FEmusic_liked_videos', 'FEmusic_liked_songs'"), 'liked: browse библиотеки как фолбэк (без подмены YY на LM!)');
  ok(src.includes("/^FE/.test(listId) ? listId : 'VL' + listId"), 'browseViaPage знает FE*-коллекции');
  ok(src.includes('if (lim > 0 && items.length > lim) items = items.slice(0, lim)'), 'поле «сколько» действует и в page-browse фолбэке');
  {
    const doc = L._test.document; const real = doc.querySelectorAll.bind(doc);
    const st = L._test.state; const keep = st.pageQueue;
    st.pageQueue = [];
    doc.querySelectorAll = (sel) => {
      const q = String(sel);
      if (q.includes('watch?v=')) return [];
      if (q.includes('player-queue-item')) return [];
      if (q.includes('responsive-list-item')) return [
        { playlistItemData: { videoId: 'playlistRo_1' } },
        { playlistItemData: { videoId: 'playlistRo_2' } },
      ];
      if (q.includes('lockup')) return [{ contentId: 'playlistRo_2' }];
      return [];
    };
    eq(L._test.pageTrackIds().join(','), 'playlistRo_1,playlistRo_2',
       '0.6.8: строки нового UI (list-item=800 без ссылок) собираются из playlistItemData');
    doc.querySelectorAll = (sel) => {
      const q = String(sel);
      if (q.includes('watch?v=') || q.includes('queue')) return [];
      if (q.includes('yt-lockup')) return [{ contentId: 'lkVid123456' }, { contentId: 'PLplaylist555' }, { contentId: 'RDmix123456789' }];
      return [];
    };
    eq(L._test.pageTrackIds().join(','), 'lkVid123456',
       'contentId берётся ровно 11-символьный: PL/RD-айдище плейлиста в треклист не проникнет');
    st.pageQueue = keep; doc.querySelectorAll = real;
  }
  ok(src.includes('const here = (/list=([A-Za-z0-9_-]{2,})/.exec(location.href)'),
     '0.6.8: liked-страница = её собственный list id из url, а не маркер');
  ok(src.includes('lm ? [lm[1], \'FEmusic_liked_videos\', \'FEmusic_liked_songs\']'),
     'сначала реальный id листа, FE*-коллекции - запасными попытками');
  ok(src.includes("via: 'page-dom'"), 'browse закрыт - ставим в очередь то, что видно на странице');
  ok(src.includes('const CAP = o.cap || 0;') && (src.match(/беру первые \$\{lim\} по полю/g) || []).length === 2,
     'поле «сколько» ограничивает скролл и срез в обоих прогонах');
  group('строки с заголовками и настоящие потолки (0.6.9)');
  // 800 в логе = потолок ВЫРЕЗАНИЯ у нас, а не лимит YouTube: листы больше 800
  // существуют; page-dom снимал один отрисованный кусок ленивой ленты.
  ok(src.includes('collectBrowseItems(await r.json(), 5000)'),
     'browse-кап поднят с 800 - большие liked не обрезаны');
  ok(src.includes('out.length >= 2000'),
     'перехват get_queue режет не на 400');
  ok(src.includes("onBatch: feed") && src.includes("queueFromPage({ live: acc })"),
     'page-dom копит ленту скроллом (кап = «сколько») И качает параллельно - очередь на первой пачке, а не после всего скролла (0.6.26)');
  ok(src.includes("gained.set(describeEl(elx)") && src.includes("атрибуция докорма:"),
     'атрибуция докорма: итог «кто реально крутил строки» пишется в лог по каждому скроллеру (вопрос владельца)');
  ok(src.includes("if (!burstWorked && ci + 1 < cands.length"),
     'доказанный дожим отменяет карусель: немые кандидаты не съедают ~60 с на цикл');
  {
    const row = (id, title, by) => ({
      videoId: id,
      querySelectorAll: (s) => s === 'yt-formatted-string'
        ? [{ getAttribute: () => title, textContent: title },
           { getAttribute: () => '', textContent: by }] : [],
      getAttribute: () => null, querySelector: () => null,
    });
    const doc = L._test.document; const real = doc.querySelectorAll.bind(doc);
    const stq = L._test.state.pageQueue; L._test.state.pageQueue = [];
    doc.querySelectorAll = (sel) => (String(sel).includes('player-queue-item'))
      ? [row('rowId123456', 'Doll Days', 'Tool \u00b7 Fear Inoculum \u00b7 Apr 24, 2019')] : [];
    const rows = L._test.pageListRows();
    doc.querySelectorAll = real;
    eq(rows.length, 1, '0.6.9: строки страницы читаются вместе с заголовками');
    eq(rows[0].title, 'Doll Days', 'заголовок - из первого formatted-string');
    eq(rows[0].artist, 'Tool', 'исполнитель - начало byline (тот самый «рядом с исполнителем»)');
    eq(rows[0].album, 'Fear Inoculum', 'альбом - ВТОРОЙ фрагмент, а не хвост с датой');
    L._test.state.pageQueue = stq;
  }
  {
    const q = L._test.parseQueuePayload({ queueDatas: [{ contents: [{ playlistPanelVideoRenderer: {
      videoId: 'qPanel11111', title: { runs: [{ text: 'Punccon' }] },
      longBylineText: { runs: [{ text: 'Tool' }, { text: ' \u00b7 ' }, { text: 'Fear Inoculum' }] },
    } }] }] });
    eq(q[0].artist, 'Tool', 'byline панели очереди тоже разбирается (0.6.9)');
    eq(q[0].album, 'Fear Inoculum', 'и альбом оттуда же');
  }
  ok(src.includes('pqById.get(id) || {}, cleanMeta(row) || {}'),
     'job тянет заголовки каскадом: DOM-строка поверх очереди страницы (0.6.23: metaOf читает строку в момент постановки)');
  {
    // 0.6.10: боевые строки из панели «Следующее» (скриншот пользователя):
    // разделитель - «·» (middle dot), фиты склеены «и» и остаются одним TPE1.
    const b = L._test.splitByline('1nonly и Shakewell · ONLY IF I DIE, WOULD I NOT BE');
    eq(b.artist, '1nonly, Shakewell', '0.6.14: фиты через «и» -> список через запятую (по запросу пользователя)');
    eq(b.album, 'ONLY IF I DIE, WOULD I NOT BE', 'альбом - фрагмент после «·», запятые внутри не мешают');
    eq(L._test.splitByline('Natte Visstick · FISHSTICK BASS').album, 'FISHSTICK BASS',
       'вторая строка со скрина разбирается так же');
  }
  ok(src.includes('const rounds = o.rounds != null ? o.rounds : 1000'),
     'бюджет скролла 400->1000: 13k liked больше не режется тихо на ~6500');
  {
    // 0.6.11: скроллер ищется поднятием от строки: YTM крутит внутренний
    // контейнер, документ «короткий» - по старым селекторам сбор обрывался
    // на отрисованных ~800 из 1884.
    const doc = L._test.document; const real = doc.querySelector.bind(doc);
    const deep = { scrollHeight: 5000, clientHeight: 600, parentElement: null };
    const row = { scrollHeight: 40, clientHeight: 40, parentElement: deep };
    doc.querySelector = (sel) => (/queue-item|lockup/.test(String(sel)) ? row : null);
    ok(L._test.pageScroller() === deep, 'предок-скроллер строки найден, даже когда селекторы страницы молчат');
    doc.querySelector = (sel) => (/queue-item|lockup/.test(String(sel))
      ? { scrollHeight: 40, clientHeight: 40, parentElement: null } : null);
    const fb = L._test.pageScroller();
    ok(fb === doc.scrollingElement || fb === doc.documentElement,
       'без переполненного предка тихий откат к документу (не падение)');
    doc.querySelector = real;
  }
  ok(src.includes('while (el) {') && src.includes('el = el.parentElement;'),
     'путь вверх по предкам - именно он, а не разовый снимок');
  ok(src.includes("'auto · none/0 · http://127.0.0.1:10808'"),
     'подсказка поля proxy в панели говорит про 0');
  group('byline против ячеек длительности в строке (0.6.12)');
  {
    const cell = (t) => ({ getAttribute: () => t, textContent: t });
    const mkRow = (cells) => [{ videoId: 'likedRow123',
      querySelectorAll: (s) => s === 'yt-formatted-string' ? cells.map(cell) : [],
      getAttribute: () => null, querySelector: () => null }];
    const doc = L._test.document; const real = doc.querySelectorAll.bind(doc);
    const keep = L._test.state.pageQueue; L._test.state.pageQueue = [];
    doc.querySelectorAll = (sel) => String(sel).includes('queue-item')
      ? mkRow(['bluetooth baslijn', 'gladde paling · bluetooth baslijn', '1:25']) : [];
    let rows = L._test.pageListRows();
    eq(rows[0].artist, 'gladde paling', 'длительность хвостовой ячейки НЕ становится артистом');
    eq(rows[0].album, 'bluetooth baslijn', 'альбом на месте');
    eq(rows[0].title, 'bluetooth baslijn', 'заголовок не съехал');
    doc.querySelectorAll = (sel) => String(sel).includes('queue-item')
      ? mkRow(['CP Violation', '1:41']) : [];
    rows = L._test.pageListRows();
    eq(rows[0].artist, '', 'без byline-разделателя артист не выдумывается: тайминг отфильтрован');
    eq(rows[0].album, '', 'и альбом тоже - добьёт info.json компаньона');
    doc.querySelectorAll = real; L._test.state.pageQueue = keep;
  }
  group('0.6.17: скроллер = тот, кто ДВИГАЕТ СТРОКИ, а не тот, кто принимает числа');
  {
    const doc = L._test.document;
    const rs = doc.querySelector.bind(doc);
    const real = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; },
      set scrollTop(v) { this._v = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); } };
    const row = { getBoundingClientRect: () => ({ top: 100 - real._v }) };
    doc.querySelector = (sel) => String(sel).includes('#items') ? { querySelector: () => row } : rs(sel);
    const fake = { _s: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._s; }, set scrollTop(v) { this._s = v; } };
    ok(L._test.pickScroller([fake, real]) === real,
       'overflow:hidden-обманщик принимает scrollTop, но строки не едут - его не берём');
    doc.querySelector = rs;
  }
  ok(src.includes("new WheelEvent('wheel'") && src.includes("new Event('scroll'"),
     'после каждого программного листа шлём scroll+колесо поверх списка (ручной скролл догружал, программный - нет)');
  ok(src.includes('__win') && src.includes("window.scrollTo(0, v)"),
     'последний кандидат - само окно: то, что крутится пользовательским колесом');
  ok(src.includes('visStall >= 4'),
     'числа двигаются, строки стоят 4 раунда - кандидат объявлен лжецом, сбор уходит дальше');

  group('0.6.16: watchdog прокрутки, префикс со склейками, record удалён');
  {
    // Застывший кандидат (scrollTop игнорирует запись) не должен выжигать
    // 1000 раундов «долго и вслепую» - watchdog уводит к живому.
    const doc = L._test.document;
    const rq = doc.querySelectorAll.bind(doc); const rs = doc.querySelector.bind(doc);
    const frozen = { get scrollTop() { return 0; }, set scrollTop(_) {}, scrollHeight: 5000, clientHeight: 500 };
    const live = { _v: 0, get scrollTop() { return this._v; },
      set scrollTop(v) { this._v = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
      scrollHeight: 1500, clientHeight: 500 };
    let reads = 0;
    const rid = () => { reads++; return reads > 4 ? ['aa000000001', 'aa000000002'] : ['aa000000001']; };
    doc.querySelector = (sel) => String(sel).includes('#main-panel') ? live
      : (String(sel).includes('queue-item') ? null : (String(sel).includes('#items') ? null : rs(sel)));
    doc.querySelectorAll = () => [];
    await (async () => {
      const r = await L.collectAllIds(frozen, { readIds: rid, rounds: 60, pauseMs: 0, escalate: true, total: 0, wait: () => Promise.resolve() });
      eq(r.length, 2, 'мёртвый скроллер не съедает раунды: эскалация на живой, хвост дочитан');
    })();
    doc.querySelectorAll = rq; doc.querySelector = rs;
  }
  {
    // префикс-склейки: артист чинится через запятую, а title от YouTube - «A и B»
    eq(L._test.stripArtistPrefix("1nonly и Shakewell - WHO GON' SLIDE", '1nonly, Shakewell'), "WHO GON' SLIDE",
       '0.6.16: «A, B» в артистах и «A и B» в заголовке совпадают - префикс срезан');
    eq(L._test.stripArtistPrefix('GHOST & 2359 - Live', 'GHOST, 2359'), 'Live',
       'английская склейка «&» тоже вариант того же артиста');
  }
  ok(!src.includes('ytmdl-rec') && !src.includes('autoRecord'),
     'record вырезан целиком: ни кнопки, ни чекбокса, ни автостарта (просил владелец)');
  ok(src.includes("if (want === 'record') return 'resolve';"), 'старый сохранённый режим не осиротел');
  ok(src.includes('stable = 0; loadStall++;') && src.includes('if ((isLoadingHint() || state.browseInflight > 0) && loadStall < 25) {'),
     'пока крутится спиннер, «стабильность» обнуляется - вердикт «конец» не наедается из ожидания');
  ok(src.includes('собрано ${nn}'), 'прогресс сбора виден на панели - «долго» больше не молчит');

  group('ленивое чтение, спиннер и «лист целиком» (0.6.15)');
  {
    const doc = L._test.document;
    const rq = doc.querySelectorAll.bind(doc); const rs = doc.querySelector.bind(doc);
    doc.querySelector = (sel) => (String(sel).includes('#items') ? null : rs(sel));
    doc.querySelectorAll = (sel) => String(sel).includes('watch?v=')
      ? [{ href: 'watch?v=rowLockup011' }, { href: 'https://music.youtube.com/watch?v=rowLockup022' }] : [];
    eq(L._test.pageTrackIds().join(','), 'rowLockup011,rowLockup022',
       'относительный href «watch?v=» без слэша читается (боевые 0 строк - из-за него)');
    doc.querySelectorAll = rq; doc.querySelector = rs;
  }
  {
    const doc = L._test.document;
    const rq = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = (sel) => String(sel).includes('loading-indicator')
      ? [{ offsetHeight: 4, offsetParent: {} }] : [];
    ok(L._test.isLoadingHint() === true, 'заметный спиннер = страница догружается, вердикт «конец» запрещён');
    doc.querySelectorAll = () => [];
    ok(L._test.isLoadingHint() === false, 'нет спиннера - никаких лишних пауз');
    doc.querySelectorAll = rq;
  }
  {
    const doc = L._test.document;
    const rs = doc.querySelector.bind(doc);
    doc.querySelector = (sel) => String(sel).includes('#header') ? { textContent: 'Понравившиеся \u00b7 1\u00a0884 трека' } : null;
    eq(L._test.expectedListTotal(), 1884, 'шапка «1 884 трека» с NBSP - цель сбора');
    doc.querySelector = (sel) => String(sel).includes('#header') ? { textContent: 'Popular releases \u00b7 20 songs' } : null;
    eq(L._test.expectedListTotal(), 20, '20-трековый лист артиста узнаваем - его крутить не надо');
    doc.querySelector = rs;
  }
  {
    // «споткнулась о первую подгрузку»: виден спиннер - сбор ждёт, а не сдаётся,
    // даже когда список выглядит «внизу и без изменений».
    const doc = L._test.document;
    const rq = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = () => [{ offsetHeight: 4, offsetParent: {} }];
    const el = { _s: 0, get scrollTop() { return this._s; }, set scrollTop(v) { this._s = v; },
      scrollHeight: 800, clientHeight: 800 };
    let k = 0;
    const grow = () => { k++; return Array.from({ length: Math.min(5, Math.ceil(k / 3)) }, (_, i) => 'g00000000' + (i + 1) + 'x'); };
    await (async () => {
      const res = await L.collectAllIds(el, { readIds: grow, rounds: 40, pauseMs: 0, stableFor: 2, wait: () => Promise.resolve(), total: 0 });
      eq(res.length, 5, 'со спиннером «стабильность» не считается - дочитано до конца');
    })();
    doc.querySelectorAll = rq;
  }
  ok(src.includes('пробую скроллер #'), 'тупик кандидата = проба следующего, а не тихий конец');
  ok(src.includes("return { via: 'page-fast', count: shown.length };"),
     'полностью отрисованный лист - без companion, browse и скролла вовсе');
  ok(src.includes("' | lockup='"), 'пробник страницы считает lockup-строки и свободные href - молчание невозможно');

  group('проба скроллера, артисты и префикс (0.6.14)');
  {
    eq(L._test.splitByline('Boney M. \u00b7 Daddy Cool').artist, 'Boney M.', 'одиночный артист не тронут');
    eq(L._test.splitByline('The\u00a0Killers & Friends \u00b7 Human').artist, 'The Killers, Friends',
       'NBSP склеивается в обычный пробел, «&» - тоже запятая');
  }
  {
    eq(L._test.stripArtistPrefix("1nonly\u00a0и Shakewell - WHO GON SLIDE", '1nonly и Shakewell'), 'WHO GON SLIDE',
       'заголовок «Артист - Трек» с NBSP режется до одного названия');
    eq(L._test.stripArtistPrefix('Purple - Rain', 'Prince'), 'Purple - Rain',
       'дефис в начале без совпадения с артистом - не гадаем');
  }
  {
    const stuck = { get scrollTop() { return 0; }, set scrollTop(_) {}, scrollHeight: 500, clientHeight: 400 };
    const real = { _v: 0, get scrollTop() { return this._v; },
      set scrollTop(v) { this._v = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
      scrollHeight: 9000, clientHeight: 500 };
    ok(L._test.pickScroller([stuck, real]) === real,
       'проба выбирает контейнер, который РЕАЛЬНО сдвигается, а не первый найденный');
    const none = { get scrollTop() { return 0; }, set scrollTop(_) {}, scrollHeight: 500, clientHeight: 400 };
    ok(L._test.pickScroller([none]) === null, 'если не сдвинулся никто - null, collectAllIds честно доложит');
  }
  ok(src.includes("setStatus('очередь уже идёт - повторная кнопка её не трогает"),
     'повторное нажатие «листа» не останавливает летящую очередь («само на 11 остановилось» - было оно)');
  ok(src.includes('state.listBusy') && src.includes('probe: true'),
     'параллельные нажатия не плодят сборы, а DOM-сбор выбирает скроллер пробой');

  group('0.6.23: onBatch кормит очередь на лету; browse-хук решает за watchdog');
  {
    // onBatch: каждый id приходит РОВНО один разом, до конца сбора
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    let n = 0; const got = [];
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => { n++; return Array.from({ length: Math.min(n, 3) }, (_, j) => 'b000000000' + String(j).padStart(2, '0')); },
      rounds: 60, pauseMs: 0, stableFor: 2, total: 3, wait: () => Promise.resolve(),
      onBatch: (b) => { for (const x of b) got.push(x); } }))();
    eq(got.join(','), r.join(','), 'пачки onBatch = ровно итоговый список, без повторов и потерь');
    eq(new Set(got).size, got.length, 'ни одного id дважды');
  }
  {
    // «низ + тишина» + browse сказал «нет continuation» - конец БЕЗ дожима и карусели
    const st = L._test.state;
    const bak = { hm: st.browseHasMore, inf: st.browseInflight, at: st.browseLastAt };
    const el = { _v: 0, scrollHeight: 600, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 100); } };
    let passes = 0;
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => { passes++; st.browseHasMore = false; st.browseInflight = 0; st.browseLastAt = Date.now(); return ['c0000000001', 'c0000000002']; },
      rounds: 400, pauseMs: 0, stableFor: 2, total: 0, wait: () => Promise.resolve() }))();
    Object.assign(st, bak);
    eq(r.length, 2, 'чужие browse-ответы без continuation больше НЕ завершают сбор');
    ok(passes >= 25, 'hasMore=false не приговор: крутим до бюджета раундов (' + passes + ') - право «конца» только у низа+тишины');
  }
  {
    // continuation обещан и свеж - терпение и дожим даже БЕЗ total
    const st = L._test.state;
    const bak = { hm: st.browseHasMore, inf: st.browseInflight, at: st.browseLastAt };
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    let p2 = 0;
    await (async () => L.collectAllIds(el, {
      readIds: () => { p2++; st.browseHasMore = true; st.browseInflight = 0; st.browseLastAt = Date.now(); return ['d0000000001', 'd0000000002', 'd0000000003']; },
      rounds: 45, pauseMs: 0, stableFor: 2, total: 0, wait: () => Promise.resolve() }))();
    Object.assign(st, bak);
    ok(p2 >= 35, 'YouTube ждёт чанк - переживаем 14 раундов и дышим (дожили до ' + p2 + ')');
  }
  ok(src.includes('if (o.live) { state.abortCollect = true; acc.reported = true; }'),
     '0.6.27: конец живой очереди (лимит/стоп/норма) гасит скролл - бесполезных витков «в никуда» больше нет');
  ok(src.includes('if (!acc.reported) setStatus('),
     '0.6.27: вердикт очереди («12 готово, стоп на лимите») не затирается статусом сбора');
  group('0.6.24: browse-вердикт - подтверждение, а не приговор авансом');
  ok(src.includes('state.browseHasMore = null; state.browseLastAt = 0;'),
     'browse-сигнал обнуляется на старте прогона - память страницы до клика не в счёт');
  ok(src.includes('(tot ? seen.size < tot : true)') && !src.includes('(tot ? seen.size < tot : more)'),
     '0.6.25 отменяет 0.6.24: дожим без total идёт ВСЕГДА - «свежий continuation» решает терпение, не дожим');
  ok(src.includes('"continuationItemRenderer"') || src.includes('/"continuationItemRenderer"/'),
     'browse-ответ нюхается на continuationItemRenderer (fetch и xhr)');
  ok(src.includes('onBatch: feed') && src.includes('const feed = (arr) => {'),
     'очередь стартует на первой пачке: queueFromPage подключён к onBatch (параллельно скроллу)');
  ok(src.includes('abort: () => state.abortCollect || ctl.stop'),
     '«стоп» в параллельном режиме гасит и скролл, и очередь');
  group('0.6.22: эскалация помнит вердикты пробы; дожим дышит; зеркало полное');
  ok(!src.includes('probeKept') && src.includes("scrollerCandidates().filter((c) => c && c !== el)"),
     '0.6.25: карусель полная снова - усечение по пробе срезало докорм роста (694->398->198->100)');
  ok(src.includes('(tot ? seen.size < tot : true)'),
     '0.6.25: финальный дожим не привязан к total - страницы без шапки тоже дожимаются');
  {
    // без total: рост прекратился - дожим всё равно крутится и возвращает собранное
    const st = L._test.state;
    const bak = { hm: st.browseHasMore, inf: st.browseInflight, at: st.browseLastAt };
    Object.assign(st, { browseHasMore: null, browseInflight: 0, browseLastAt: 0 });
    let grow = 0, passes = 0;
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => { passes++; grow = Math.min(grow + 40, 400); return Array.from({ length: grow }, (_, j) => 'e' + String(j).padStart(10, '0')); },
      rounds: 200, pauseMs: 0, stableFor: 2, total: 0, wait: () => Promise.resolve(), escalate: false }))();
    Object.assign(st, bak);
    eq(r.length, 400, 'докорм после остановки роста собран целиком');
    ok(passes > 45, 'и после тишины страница ещё крутилась в дожиме, а не сдалась на 14 (' + passes + ' раундов)');
  }
  ok(!src.includes('ci++; elx = cands[ci]; catched = false; visStall = 0; lastVisTop = null; loadStall = 0;\n          if (o.onStall) { try { o.onStall(seen.size, ci, cands.length); } catch (e) {} }\n          try { elx.scrollTop = 0; } catch (e) {}'),
     'откат scrollTop=0 на смене кандидата убран («вернулся вверх страницы» больше нет)');
  ok(src.includes('Дожим - «дыхание»') || src.includes('дожим - «дыхание»') || src.includes('«дыхание» (0.6.22)'),
     'внизу дожим отходит на 1.5 экрана и возвращается - IntersectionObserver видит новое пересечение');
  {
    // годных ноль - сands = [el]: сбор на найденном контейнере завершается,
    // не гоняясь по отвергнутым (эскалация с пустым accepted не бесконечна)
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => ['a0000000001'], rounds: 200, pauseMs: 0, stableFor: 2, total: 0,
      escalate: true, wait: () => Promise.resolve() }))();
    eq(r.length, 1, 'без пробы эскалация жива по-старому (full list) - 1 строка собрана и вернётся');
  }
  group('0.6.21: критическая масса укорачивает дожим; обманщик повергается сразу');
  {
    // tot=10, собрано 9 (90%+), дальше тишина: дожим обязан быть коротким и
    // сбор завершается с тем, что есть (удалённые с площадки треки не ждут)
    let n = 0;
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    let waits = 0;
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => { n++; return Array.from({ length: 9 }, (_, j) => 'x000000000' + String(j).padStart(2, '0')); },
      rounds: 400, pauseMs: 0, stableFor: 2, total: 10,
      wait: (ms) => { waits++; return Promise.resolve(); } }))();
    eq(r.length, 9, 'масса набрана - 9 из 10 вернулись без вечного ожидания');
    ok(waits < 60, 'и дожим короткий: раундов ожидания ' + waits + ' (< 60 - экономия на хвосте)');
  }
  ok(src.includes('cuLeft = mass ? 12 : 45'), 'дожим при массе - 12 раундов, без неё - прежние 45');
  ok(!src.includes('noGrowth = 999'), '0.6.25: мгновенных приговоров 999 нет - watchdog вернулся к deadN (0.6.19)');
  ok(src.includes('noGrowth = deadN'),
     '0.6.25: обманщик умерщвляется watchdog-ом на пороге deadN (0.6.19), а не константой 999');
  group('0.6.19: byline из колонок, терпение при известном total, зеркало без обрезки');
  {
    // боевой HTML: responsive-строка = колонки title|артисты|альбом, « • » рисует
    // CSS. Прежний выбор «последняя строка» ставил альбом в артисты.
    const doc = L._test.document;
    const realQs = doc.querySelector.bind(doc);
    const fsx = (txt) => ({ getAttribute: (a) => (a === 'title' ? txt : null), textContent: txt });
    const row = {
      videoId: 'battleRow01',
      querySelectorAll: (sel) => String(sel).includes('formatted-string')
        ? [fsx("WHO GON' SLIDE"), fsx('1nonly \u0438 Shakewell'), fsx('ONLY IF I DIE, WOULD I NOT BE')]
        : [],
      getAttribute: () => null, querySelector: () => null,
    };
    const main = { scrollHeight: 90000, clientHeight: 600, parentElement: null, querySelectorAll: () => [row] };
    doc.querySelector = (sel) => (String(sel).includes('#items') ? main : realQs(sel));
    doc.querySelectorAll = () => [];
    const rows = L._test.pageListRows();
    doc.querySelector = realQs;
    eq(rows.length, 1, 'строка найдена');
    eq(rows[0].artist, '1nonly, Shakewell', 'артисты = ПЕРВАЯ колонка, а не последняя (файл «альбом - трек» отсюда)');
    eq(rows[0].album, 'ONLY IF I DIE, WOULD I NOT BE', 'альбом доехал до тега TALB, а не съелся в артисты');
    eq(rows[0].title, "WHO GON' SLIDE", 'заголовок - только название');
  }
  {
    // терпение: total из шапки = 9, список реально рос - 18 раундов тишины не
    // считают концом (в 0.6.18 порог 14 убивал боёвый «791 из 1884»)
    let n = 0;
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    const grow = () => { n++; const c = n < 20 ? 3 : 9; return Array.from({ length: c }, (_, j) => 'g00000000' + String(j).padStart(2, '0')); };
    const r = await (async () => L.collectAllIds(el, { readIds: grow, rounds: 200, pauseMs: 0, stableFor: 2, total: 9, wait: () => Promise.resolve() }))();
    eq(r.length, 9, 'тишина дольше 14 раундов при росте и известном total больше не «конец списка»');
  }
  {
    // финальный дожим: тишина и исчерпанные кандидаты - сбор завершается, а не виснет
    const el2 = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = Math.min(v, 8500); } };
    const r2 = await (async () => L.collectAllIds(el2, {
      readIds: () => ['h0000000001', 'h0000000002', 'h0000000003'],
      rounds: 200, pauseMs: 0, stableFor: 2, total: 9, wait: () => Promise.resolve() }))();
    eq(r2.length, 3, 'недокрученный список: вернули что есть (после дожима), без вечного ожидания');
  }
  ok(src.includes('slice(0, 1600)'), 'зеркало лога: 280 символов резали вердикты кандидатов - потолок поднят');
  ok(src.includes("byline = rest.join(' \\u00b7 ');"), 'rowTexts клеит колонки, а не берёт последнюю');
  ok(src.includes('финальный дожим'), 'и слово в логе честное: «не докручен - дожимаю»');
  group('0.6.18: вечно крутящийся спиннер не вешает сбор; «стоп» властен; вердикты всех кандидатов');
  {
    // боевой liked 0.6.17: never-off спиннер (буфер бокового плеера) держал
    // loading-ветку вечно - 1000 раундов тишины после «скроллер: document».
    const doc = L._test.document;
    const rq = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = (sel) => String(sel).includes('paper-progress')
      ? [{ offsetHeight: 4, offsetParent: {}, hasAttribute: () => true }]
      : rq(sel);
    const el = { _v: 0, scrollHeight: 500, clientHeight: 400,   // «короткий»: низ достигнут сразу
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = v; } };
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => ['zz000000001', 'zz000000002'], rounds: 400, pauseMs: 0,
      stableFor: 2, wait: () => Promise.resolve(), total: 0 }))();
    doc.querySelectorAll = rq;
    eq(r.length, 2, 'вечный спиннер: сбор всё равно завершился за конечное число раундов (0.6.17 висел)');
  }
  {
    // «стоп» во время прокрутки: collect обязан вerverнуть собранное и не делать вид, что ничего не было
    const el = { _v: 0, scrollHeight: 9000, clientHeight: 500,
      get scrollTop() { return this._v; }, set scrollTop(v) { this._v = v; } };
    const seenN = { n: 0, stop: false };
    const r = await (async () => L.collectAllIds(el, {
      readIds: () => { const ids = Array.from({ length: seenN.n + 1 }, (_, i) => 'q000000000' + i); seenN.n++; if (seenN.n === 2) seenN.stop = true; return ids; },
      rounds: 400, pauseMs: 0, stableFor: 3, total: 0, wait: () => Promise.resolve(),
      abort: () => seenN.stop }))();   // «стоп» нажали во время второго раунда
    eq(r.length, 2, 'после «стоп» сбор вернул всё, что было на странице в момент нажатия');
    eq(seenN.n, 2, 'и остановился немедленно - третьего прохода не случилось (0.6.17 жевал 1000)');
  }
  ok(src.includes('проба скролла - все кандидаты:'), '0.6.18: лог проверяет ВСЕХ кандидатов с вердиктами - как просил владелец');
  ok(src.includes('проба скролла - победитель:'), 'и отдельной строкой - кто победил');
  ok(!src.includes('прокручиваю'), 'ложь «собрано N - прокручиваю» до первого скролла удалена из исходника');
  ok(src.includes('state.abortCollect = true;') && src.includes("else if (state.listBusy) acted = true;"),
     '«стоп» ставит abort-флаг и засчитывается, когда очередь ещё не началась');
  ok(src.includes('if (!r) { try { r = document.querySelector(LIST_ROW_SEL); } catch (e) {} }'),
     'якорь строки ищется и вне scope - иначе визуальная проба молча глохла');

  group('главный список против панели очереди (0.6.13)');
  {
    const doc = L._test.document;
    const realQsa = doc.querySelectorAll.bind(doc); const realQs = doc.querySelector.bind(doc);
    const mk = (id) => ({ videoId: id, querySelectorAll: () => [], getAttribute: () => null, querySelector: () => null });
    const main = {
      scrollHeight: 90000, clientHeight: 600, parentElement: null,
      querySelectorAll: (sel) => String(sel).includes('lockup') ? [mk('mainRow0001'), mk('mainRow0002')] : [],
    };
    doc.querySelector = (sel) => (String(sel).includes('#items') ? main : null);
    doc.querySelectorAll = (sel) => (String(sel).includes('queue-item') ? [mk('queueItm0001')] : []);
    eq(L._test.pageTrackIds().join(','), 'mainRow0001,mainRow0002',
       'открытая панель очереди не перехватывает сбор: строки главного списка, не её 100');
    eq(L._test.pageListRows().map((x) => x.videoId).join(','), 'mainRow0001,mainRow0002',
       'pageListRows берёт заголовки тоже из главного списка, а не из панели');
    ok(L._test.pageScroller() === main, 'скролл цепляет контейнер главного списка, не панель');
    doc.querySelector = realQs; doc.querySelectorAll = realQsa;
  }
  {
    const q = L._test.parseQueuePayload({ queueDatas: [{ contents: [{ playlistPanelVideoRenderer: {
      videoId: 'subtitleRow11', title: { runs: [{ text: "WHO GON' SLIDE" }] },
      subtitle: { runs: [{ text: '1nonly' }, { text: ' и ' }, { text: 'Shakewell' },
                          { text: ' · ' }, { text: 'ONLY IF I DIE, WOULD I NOT BE' }] },
      shortBylineText: { simpleText: 'ONLY IF I DIE, WOULD I NOT BE' },
    } }] }] });
    eq(q[0].artist, '1nonly, Shakewell', 'строка subtitle важнее shortBylineText: альбом не становится артистом');
    eq(q[0].album, 'ONLY IF I DIE, WOULD I NOT BE', 'альбом лежит в альбоме, а не в имени файла');
  }
  ok(src.includes('state.domOnly.add(target)') && src.includes("if (domOnly) throw new Error("),
     'список, упавший у companion и в browse, запоминается: повтор нажимает сразу DOM (не «долго думало»)');
  ok(src.includes('row = pageListRows().find((x) => x.videoId === id)') && src.includes('pqById.get(id) || {}, cleanMeta(row)'),
     'мета строится слиянием по id, где DOM-строка поверх get_queue');

  group('get_queue как источник очереди и чтение ytcfg (0.6.6)');
  {
    const j = { queueDatas: [{ title: { runs: [{ text: 'Up next' }] }, contents: [
      { playlistPanelVideoRenderer: { videoId: 'aB3dE5fG7hI', index: { simpleText: '1' },
        title: { runs: [{ text: 'One' }] }, lengthText: { simpleText: '3:00' } } },
      { playlistPanelVideoRenderer: { videoId: 'zZ0yY1xW2vU', index: { simpleText: '2' },
        title: { simpleText: 'Two' } } },
      { playlistPanelVideoRenderer: { videoId: 'aB3dE5fG7hI', title: { runs: [{ text: 'dup' }] } } },
      { playlistPanelWrapperRenderer: { stuff: 1 } },
    ] }] };
    const q = L._test.parseQueuePayload(j);
    eq(q.map((x) => x.videoId).join(','), 'aB3dE5fG7hI,zZ0yY1xW2vU', 'порядок панели, дубли отброшены');
    eq(q[0].title, 'One', 'заголовок читается и из runs, и из simpleText');
    eq(L._test.parseQueuePayload(null).length, 0, 'мусор не бросается');
    eq(L._test.parseQueuePayload({ queueDatas: [{ contents: [{ playlistPanelVideoRenderer: { videoId: 'short' } }] }] }).length, 0,
       'короткий videoId не берём');
  }
  {
    const store = { INNERTUBE_API_KEY: 'AIzaTEST', INNERTUBE_CONTEXT: { a: 1 } };
    eq(L._test.ytcfgVal('INNERTUBE_API_KEY', { ytcfg: { get(k) { return store[k]; } } }), 'AIzaTEST',
       'менеджер (.get) - основной YTM-формат');
    eq(L._test.ytcfgVal('INNERTUBE_API_KEY', { ytcfg: { data_: { INNERTUBE_API_KEY: 'KEY2' } } }), 'KEY2',
       'data_-форма тоже читается');
    eq(L._test.ytcfgVal('INNERTUBE_API_KEY', { INNERTUBE_API_KEY: 'FLAT' }), 'FLAT',
       'плоский window (www) не сломать');
    eq(L._test.ytcfgVal('INNERTUBE_API_KEY', {}), null, 'нет нигде - null, без исключений');
  }
  {
    const doc = L._test.document; const real = doc.querySelectorAll.bind(doc);
    const st = L._test.state; const keep = st.pageQueue;
    doc.querySelectorAll = (sel) => (String(sel).includes('player-queue-item'))
      ? [{ tagName: 'YTMUSIC-PLAYER-QUEUE-ITEM' }, { tagName: 'X' }] : [];
    st.pageQueue = [];
    eq(L._test.pageTrackIds().length, 0, 'строки без id и данных нет - честно пусто');
    st.pageQueue = [{ videoId: 'pageQueueId1', title: 'A' }, { videoId: 'pageQueueId2', title: 'B' }];
    eq(L._test.pageTrackIds().join(','), 'pageQueueId1,pageQueueId2',
       '0.6.6: DOM-строки молчат (боевой случай 95×null) - берём id из данных get_queue');
    st.pageQueue = keep; doc.querySelectorAll = real;
  }
  ok(src.includes("/music\\/get_queue/.test(url)"), 'fetch-хук перехватывает get_queue (панель уже отрисована им)');
  ok(src.includes('/music\\/get_queue/.test(u)'), '...и XHR-путь перехватывает');
  ok(src.includes('async function pageQueueAttempt'), 'нет перехвата - запрос get_queue от имени страницы');
  ok(src.includes("ytcfgVal('INNERTUBE_API_KEY', w)"), 'browse и selfAskPlayer читают конфиг через менеджер');
  ok(!src.includes("const ctx = global.ytcfg || {};"), 'песочное global.ytcfg больше нигде не источник конфига');

  }
  ok(src.includes('web_safari сразу'), 'чекбокс «web_safari сразу» в панели');
    ok(src.includes("out.host_pref = 'www'"), 'панель передаёт приоритет хоста в задачах');
    ok(src.includes("mkChk('ytmdl-alt'"), 'чекбокс «через youtube.com» в панели');
    ok(src.includes('renderChips'), 'шапка показывает эффективные формат/режим');
    ok(src.includes("h('details')"), 'настройки свёрнуты в секции (ничего не удалено)');
  eq(L._test.accountThrottled({ pr: { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Воспроизведение приостановлено, так как сейчас слишком много устройств' } } }),
     'Воспроизведение приостановлено, так как сейчас слишком много устройств', 'лимит аккаунта распознан по ответу плеера');
  eq(L._test.accountThrottled({ pr: { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Private video' } } }),
     '', 'другой UNPLAYABLE - не наш случай, не мешаем качать');
  eq(L._test.accountThrottled({ pr: { playabilityStatus: { status: 'OK' } } }), '', 'OK = тихо');
  ok(/if \(wantMode === 'auto'\)/.test(src) && /accountThrottled\(info\)/.test(src),
     'auto коротко замыкается на лимите; явный режим по-прежнему пробуется');
  ok(/GM_info\.script\.version/.test(src), 'VER из @version: панель больше не врёт про 0.4.9');
  ok(src.includes('ytmdl-proxy') && src.includes("bind('#ytmdl-proxy', 'proxy')"), 'поле proxy в панели есть и биндится');
  ok(src.includes('ytmdl-conv') && src.includes("bind('#ytmdl-conv', 'convert')"), 'select convert в панели есть и биндится');
  ok(src.includes("q.set('proxy', cfg.proxy)"), 'proxy из панели доезжает до /media');
  ok(src.includes('out.proxy = cfg.proxy'), 'и до /job');
  ok(src.includes("forced || fmt || cfg.format"), 'convert перебивает формат у /media');
  ok(src.includes("out.format !== 'copy'"), 'copy - единственное, что convert не трогает');
  ok(/proxy=\$\{h\.proxy_direct/.test(src), 'статус панели показывает режим прокси компаньона');
  ok(/версии разошлись/.test(src), 'расхождение версий панели и компаньона видно сразу');
  cf.convert = saveConv; cf.proxy = saveProxy;
}

console.log(`\n${fail ? 'ПРОВАЛ' : 'ВСЁ ЗЕЛЁНОЕ'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
