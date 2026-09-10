// ==UserScript==
// @name         YTM Downloader (userscript + local companion)
// @namespace    https://arena.local/ytm-dl
// @version      0.6.3
// @description  Кнопка скачивания аудио в панели YouTube Music: забирает player response прямо из браузера (где уже есть poToken, cookies и «домашний» IP) и передаёт его локальному companion-процессу для remux/тегов. Личное использование и контент, на который у вас есть права.
// @author       you
// @license      MIT
// @match        https://music.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      *.googlevideo.com
// ==/UserScript==

/*
 * ПОЧЕМУ НЕ «ПРОСТО FETCH + BLOB»
 * -------------------------------
 * YouTube перевёл web-плеер (в т.ч. music.youtube.com) на SABR: у adaptiveFormats в
 * /youtubei/v1/player больше нет поля `url` — вместо него `playerDescriptor` и
 * protobuf-сессия. Следствия:
 *   1) userscript, который «сам просит» стрим, упирается в 403/пустой ответ;
 *   2) зато у него есть то, чего нет у внешних загрузчиков: живой плеер, который
 *      уже скачивает нужный трек прямо сейчас, в этой сессии, с этим IP.
 * Отсюда пять режимов (см. resolveMode):
 *   direct  — в ответе есть `url`: качаем сами, быстро.
 *   replay  — url не из player response, а из sniffed-запроса плеера; перекачиваем
 *             весь диапазон одним GET (работает, пока это обычный Range-стрим, не SABR;
 *             с 0.5.2 — только если хук видел ПОЛНОЕ покрытие файла: кусок после
 *             10 секунд прослушивания за трек не выдаётся, а уводит в resolve).
 *   resolve — «донос»: отдаём перехваченный player response локальному yt-dlp,
 *             он умеет разговаривать с SABR. Основной и самый стойкий режим.
 *   record  — просто дожидаемся, пока плеер доскачает, и берём его байты (realtime).
 * Remux/MP3/теги в userscript физически невозможны — для этого companion.
 */

(function (global) {
  'use strict';

  // версия берётся из шапки, а не хардкода: до 0.5.2 панель год показывала
  // '0.4.9' при установленном 0.5.1 (VER не обновляли) - по ней нельзя было
  // понять, устарел скрипт или нет. GM_info.script.version = @version всегда.
  const VER = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
    || '0.6.3';
  const LOG = '[ytm-dl]';

  /* ═════════════════ 1. ЧИСТАЯ ЛОГИКА — без DOM и без GM, тестируется в Node ═════════════════ */

  const TD = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

  const fmtHasUrl = (f) => !!(f && typeof f.url === 'string' && f.url.length > 12);
  const fmtIsSabr = (f) => !!(f && (f.playerDescriptor || f.streamCancellationPolicy || f.sabrStream ||
    (f.mediaCommons && f.mediaCommons.initEndpoint)));
  const isAudioFmt = (f) => !!(f && typeof f.mimeType === 'string' && f.mimeType.startsWith('audio'));

  function containerOf(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('mp4a') || m.includes('aac')) return 'm4a';
    if (m.includes('opus') || m.includes('webm')) return 'opus';
    return 'bin';
  }

  /**
   * Аудио-дорожки из player response → удобный список.
   * Сортировка: класс возможности (есть прямой url → можно качать без companion),
   * внутри класса — по битрейту (лучшее качество из доступного) и размеру.
   * SABR-форматы осознанно в хвосте: их url у нас украден, их должен разбирать yt-dlp.
   */
  function pickAudioFormats(pr) {
    const sd = (pr && pr.streamingData) || {};
    const out = [];
    for (const f of [].concat(sd.adaptiveFormats || [], sd.formats || [])) {
      if (!isAudioFmt(f)) continue;
      out.push({
        itag: Number(f.itag) || 0,
        mime: String(f.mimeType || '').split(';')[0],
        codec: (String(f.mimeType || '').match(/codecs="([^"]+)"/) || [])[1] || '',
        url: fmtHasUrl(f) ? f.url : null,
        bitrate: Number(f.bitrate) || 0,
        bytes: Number(f.contentLength) || 0,
        sabr: fmtIsSabr(f),
        quality: f.qualityLabel || f.quality || '',
        container: containerOf(f.mimeType),
        loudnessDb: typeof f.loudnessDb === 'number' ? f.loudnessDb : null,
      });
    }
    out.sort((a, b) => (b.url ? 1 : 0) - (a.url ? 1 : 0) || b.bitrate - a.bitrate || b.bytes - a.bytes);
    return out;
  }

  const canDownloadDirectly = (formats) => (formats || []).some((f) => f.url && !f.sabr);

  /**
   * Контейнер по первым байтам. Нужен потому, что расширение из player response
   * бывает 'bin', а сам ответ googlevideo - страницей «подтвердите что вы не бот»
   * (HTTP 200, text/html). Без этого браузер сохранял мусор как «трек»: два файла
   * одного размера, которые ни один плеер не играет.
   */
  function sniffBytes(bytes) {
    const u = bytes && bytes.length ? bytes : new Uint8Array(0);
    const at = (o) => (u.length > o ? u[o] : -1);
    const str = (o, n) => { let s2 = ''; for (let i = o; i < o + n && i < u.length; i++) s2 += String.fromCharCode(u[i]); return s2; };
    if (u.length >= 12) {
      const brand = str(4, 4);
      if (brand === 'ftyp' || brand === 'moov' || brand === 'mdat') return 'm4a';
    }
    if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'webm';
    if (str(0, 4) === 'OggS') return 'ogg';
    if (str(0, 3) === 'ID3') return 'mp3';
    if (at(0) === 0xff && (at(1) === 0xfb || at(1) === 0xf3 || at(1) === 0xf2)) return 'mp3';
    return '';
  }

  /** HTML вместо потока: опознаём и по заголовку, и по первым байтам. */
  function looksLikeHtml(ct, bytes) {
    if (/text\/html|application\/xml|text\/plain/i.test(String(ct || ''))) return true;
    const head = sniffBytes(bytes);
    if (head) return false;
    if (!bytes || !bytes.length || bytes.length > 300000) return false;
    let s2 = '';
    for (let i = 0; i < Math.min(240, bytes.length); i++) s2 += String.fromCharCode(bytes[i]);
    return /<\s*(!?doctype|html|head|body|meta)/i.test(s2) || /sign in to confirm|unusual traffic/i.test(s2);
  }

  /** Человекочитаемый вердикт для панели: почему можно/нельзя качать и что делать. */
  function diagnose(pr, formats) {
    const sd = (pr && pr.streamingData) || {};
    const adaptive = (sd.adaptiveFormats || []).length;
    const withUrl = (formats || []).filter((f) => f.url).length;
    const sabr = (formats || []).filter((f) => f.sabr).length;
    const play = (pr && pr.playabilityStatus) || {};
    let level = 'warn', text;
    if (play.status && play.status !== 'OK') {
      level = 'bad';
      text = `playabilityStatus=${play.status}: ${play.reason || 'без причины'}`;
    } else if (withUrl > 0) {
      level = 'good';
      text = `есть прямые url (${withUrl}) → режим direct`;
    } else if (sabr > 0) {
      text = `только SABR (${sabr}/${adaptive}) → companion (resolve) или record`;
    } else if (adaptive > 0) {
      text = 'аудио-форматы без url и без SABR-дескриптора — посмотри raw response';
    } else {
      level = 'bad';
      text = 'streamingData пуст: неверный клиент или нет доступа к видео';
    }
    return {
      level, text, adaptive, withUrl, sabr,
      signatureTimestamp: (pr && pr.signatureTimestamp) || null,
    };
  }

  /* ─────────── googlevideo-URL и Range ─────────── */

  /** Разбор URL на base + пары query БЕЗ декодирования (сигнатуры нельзя канонизировать). */
  function splitQuery(url) {
    const s = String(url);
    const i = s.indexOf('?');
    if (i < 0) return { base: s, pairs: [], hash: '' };
    let qs = s.slice(i + 1), hash = '';
    const h = qs.indexOf('#');
    if (h >= 0) { hash = qs.slice(h); qs = qs.slice(0, h); }
    return { base: s.slice(0, i), pairs: qs.split('&').filter(Boolean), hash };
  }

  /** Замена/добавление параметра; остальные пары остаются байт-в-байт. */
  function setQuery(url, patch) {
    const { base, pairs, hash } = splitQuery(url);
    for (const k of Object.keys(patch || {})) {
      let hit = false;
      for (let i = 0; i < pairs.length; i++) {
        const eq = pairs[i].indexOf('=');
        if ((eq < 0 ? pairs[i] : pairs[i].slice(0, eq)) === k) {
          const v = patch[k];
          pairs[i] = v === null || v === undefined ? k : `${k}=${v}`;
          hit = true; break;
        }
      }
      if (!hit && patch[k] != null) pairs.push(`${k}=${patch[k]}`);
    }
    return `${base}?${pairs.join('&')}${hash}`;
  }

  /** URL этого же стрима на весь диапазон (для replay-режима). */
  const fullRangeUrl = (url) => setQuery(url, { range: '0-' });

  const parseRange = (header) => {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header || '').trim());
    if (!m) return null;
    return { start: m[1] === '' ? null : Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
  };

  /** Union-покрытие диапазонов: сколько байт, есть ли дырки, где именно. */
  function coverageFromRanges(ranges) {
    const rs = (ranges || []).filter((r) => r && typeof r.start === 'number')
      .map((r) => [r.start, r.end == null ? r.start : r.end])
      .sort((a, b) => a[0] - b[0]);
    if (!rs.length) return { covered: 0, contiguous: false, gaps: [], first: null, last: null, count: 0 };
    const merged = [];
    for (const [a, b] of rs) {
      const t = merged[merged.length - 1];
      if (t && a <= t[1] + 1) t[1] = Math.max(t[1], b); else merged.push([a, b]);
    }
    let covered = 0;
    for (const [a, b] of merged) covered += b - a + 1;
    const gaps = [];
    for (let i = 1; i < merged.length; i++) gaps.push([merged[i - 1][1] + 1, merged[i][0] - 1]);
    return {
      covered, contiguous: merged.length === 1, gaps,
      first: merged[0][0], last: merged[merged.length - 1][1], count: rs.length,
    };
  }

  /* ─────────── MP4: разбор и сборка ─────────── */

  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const readU32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const readU64 = (b, i) => readU32(b, i) * 4294967296 + readU32(b, i + 4);
  const fourcc = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

  /** Боксы верхнего уровня для диапазона bytes (start/end relative to whole buffer). */
  function walkBoxes(bytes, boxStart, winEnd) {
    const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const start = (typeof boxStart === 'object' && boxStart) ? (boxStart.start + 8) : (winEnd === undefined ? 0 : boxStart);
    const end = (typeof boxStart === 'object' && boxStart) ? (boxStart.start + boxStart.size)
      : (winEnd === undefined ? v.length : winEnd);
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = readU32(v, o);
      const type = fourcc(v, o + 4);
      let hdr = 8;
      if (size === 1) { size = readU64(v, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) { out.push({ type, start: o, size: end - o, hdr, broken: true }); break; }
      out.push({ type, start: o, size, hdr });
      o += size;
    }
    return out;
  }

  /** Контейнер 'box' c 32-битным размером (payload < 2^32). */
  function box(type, payload) {
    const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
    const total = 8 + p.length;
    if (total > 0xffffffff) throw new Error('box: payload слишком большой для 32-битного размера');
    const out = new Uint8Array(total);
    for (let i = 0; i < 4; i++) out[i] = (total >>> (24 - 8 * i)) & 255;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(p, 8);
    return out;
  }

  function concat(chunks) {
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Uint8Array(n); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** Дочерние боксы контейнера (абсолютные координаты). */
  /** Прямые дети parent (координаты абсолютны для bytes). Реализовано окном, без copy/shift. */
  function childBoxes(bytes, parent) {
    if (!parent) return [];
    return walkBoxes(bytes, parent);
  }

  /** Буфер только из тех top-level боксов, что прошли предикат (полезно для «удалили moov»). */
  function rebuildFromBoxes(bytes, keep) {
    const parts = [];
    for (const b of walkBoxes(bytes, 0)) if (keep(b)) parts.push(bytes.subarray(b.start, b.start + b.size));
    return concat(parts);
  }

  /** Поиск бокса по пути типов от корневого типа (base — смещение, если корень не в начале). */
  function findPath(bytes, rootType, path, base) {
    let scope = walkBoxes(bytes, base || 0).find((b) => b.type === rootType);
    if (!scope) return null;
    for (const t of path) {
      scope = childBoxes(bytes, scope).find((b) => b.type === t);
      if (!scope) return null;
    }
    return scope;
  }

  /** Есть ли следы DRM (Widevine/CENC) — тогда сборка бессмысленна и это надо сказать вслух. */
  function isEncryptedMp4(bytes) {
    const s = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const t = TD ? TD.decode(s.subarray(0, Math.min(s.length, 1 << 20))) : String.fromCharCode.apply(null, s.subarray(0, 4096));
    return /sinf|tenc|encv|enca|pssh/.test(t);
  }

        /**
   * Дефолты tfhd. ОПАСНОЕ МЕСТО: спецификация (ISO 14496-12) и реализация ffmpeg расходятся
   * в нумерации битов, а кодировщики пишут и так, и эдак:
   *   ISO:     0x01 base_data_offset | 0x02 sample_description_index | 0x100 duration
   *            | 0x200 size | 0x400 flags | 0x10000 duration_is_empty | 0x20000 size_is_empty
   *   ffmpeg:  0x01 base_data_offset | 0x02 sample_description_index | 0x08 duration
   *            | 0x10 size | 0x20 flags   (т.е. сдвиг на 4 бита, «старая» раскладка)
   * Поэтому идём по КАНОНическому порядку полей и принимаем любой из двух битов каждого поля:
   * перепутать их — значит прочитать default_sample_size вместо default_sample_duration
   * (у меня так вышло: длительность стала 475 вместо 1024, и файл собирался с неверным stts).
   */
  function readTfhdDefaults(bytes) {
    const s = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const tfhd = findPath(s, 'moof', ['traf', 'tfhd']) || findPath(s, 'traf', ['tfhd'])
      || (s.length >= 8 && fourcc(s, 4) === 'tfhd' ? { start: 0, size: readU32(s, 0) } : null);
    if (!tfhd) return {};
    const flags = readU32(s, tfhd.start + 8) & 0xffffff;
    let p = tfhd.start + 16;                             // сразу за track_ID
    const out = {};
    if (flags & 0x0001) { out.baseDataOffset = readU64(s, p); p += 8; }
    if (flags & 0x0002) { out.sampleDescriptionIndex = readU32(s, p); p += 4; }
    if (flags & 0x0108) { out.duration = readU32(s, p); p += 4; }     // ISO 0x100 | ffmpeg 0x08
    if (flags & 0x0210) { out.size = readU32(s, p); p += 4; }         // ISO 0x200 | ffmpeg 0x10
    if (flags & 0x0420) { out.flags = readU32(s, p); p += 4; }        // ISO 0x400 | ffmpeg 0x20
    if (flags & 0x08000) out.baseIsMoof = true;
    if (flags & 0x10000) out.duration = 0;              // duration_is_empty
    if (flags & 0x20000) out.size = 0;                  // size_is_empty -> размеры только в trun
    return out;
  }

  /** Замена u32 по абсолютному смещению (всегда копия — исходный буфер не мутируем). */
  function patchField(bytes, at, value) {
    const out = bytes.slice();
    for (let i = 0; i < 4; i++) out[at + i] = (value >>> (24 - 8 * i)) & 255;
    return out;
  }

  /**
   * Проставляет длительности в mvhd/tkhd/mdhd. В фрагментированных init-сегментах
   * они нулевые (empty_moov), и без них файл выглядит «пустым»: ffprobe даёт duration 0,
   * а музыкальные плееры отказываются его показывать — при полностью исправных mdat.
   */
  function fixDurations(bytes, mediaTicks, mediaTimescale) {
    if (!mediaTicks) return bytes;
    const mediaDuration = mediaTicks;
    const moov = walkBoxes(bytes, 0).find((b) => b.type === 'moov');
    if (!moov) return bytes;
    const kids = childBoxes(bytes, moov);
    const mvhd = kids.find((b) => b.type === 'mvhd');
    const trak = kids.find((b) => b.type === 'trak');
    const tkhd = trak ? childBoxes(bytes, trak).find((b) => b.type === 'tkhd') : null;
    void mediaDuration;
    const mdia = trak ? childBoxes(bytes, trak).find((b) => b.type === 'mdia') : null;
    const mdhd = mdia ? childBoxes(bytes, mdia).find((b) => b.type === 'mdhd') : null;
    if (!mvhd || !mdhd) return bytes;
    const mts = readU32(bytes, mvhd.start + 20) || 1000;   // mvhd timescale
    const ts = readU32(bytes, mdhd.start + 20) || 1000;     // mdhd timescale
    let out = patchField(bytes, mdhd.start + 24, mediaDuration);
    // mvhd/tkhd живут в своих timescale (обычно 1000 = миллисекунды)
    const trackDur = Math.max(1, Math.round(mediaTicks * mts / (ts || 1)));
    out = patchField(out, mvhd.start + 24, trackDur);
    if (tkhd) {
      // tkhd: v0 → duration на +88, v1 → на +100 (после 8-байтного заголовка)
      const ver = out[tkhd.start + 8];
      out = patchField(out, tkhd.start + (ver === 1 ? 100 : 88), trackDur);
    }
    return out;
  }

    /**
   * Правит бокс `path` (путь от СПИСКА top-level боксов буфера) трансформациями
   * fn(payload) -> payload и возвращает буфер того же вида: список top-level боксов,
   * где предки вдоль пути пересобраны (их размеры растут, остальные копируются байт-в-байт).
   *
   * Контракт один-единственный, без флагов: path[0] — это бокс В buf, а не сам buf.
   * Причина: путь ['moov','trak',...] от whole-init означает «moov — ребёнок init-контейнера»,
   * и любой вариант «сдвинь на уровень» рано или поздно правит не тот бокс (я на это наткнулся:
   * пустые stts из init переживали перезапись, и ffmpeg говорил «missing mandatory atoms»).
   *
   *  - null      — путь не найден (буфер не трогаем);
   *  - fn -> null — правка не нужна, buf возвращается как есть.
   * @param {Uint8Array} buf
   * @param {string[]} path
   * @param {Array<(p:Uint8Array)=>Uint8Array|null>|Function} fns
   */
  function editBox(buf, path, fns) {
    const levels = [];
    for (let i = 0; i < path.length; i++) {
      const list = i === 0 ? walkBoxes(buf, 0) : childBoxes(buf, levels[i - 1]);
      const hit = list.find((b) => b.type === path[i]);
      if (!hit) return null;
      levels.push(hit);
    }
    const deep = levels[levels.length - 1];
    let cur = buf.subarray(deep.start + 8, deep.start + deep.size);
    let noop = false;
    for (const fn of [].concat(fns)) {
      const next = fn(cur);
      // null => «правка не нужна» (прерываем, buf как есть); undefined => «ничего не меняем,
      // но идём дальше» — именно так должен вести себя removeTypes, когда удалять нечего
      // (иначе на чистом прогрессивном init таблицы вообще не дописывались).
      if (next === null) { noop = true; break; }
      if (next !== undefined) cur = next;
    }
    // Если payload в итоге байт-в-байт совпал с исходным — пересборка не нужна. Без этой
    // проверки «no-op» правка на корневом уровне удваивала бокс (splice не находил совпадений
    // и копировал moov дважды).
    if (noop || (cur.length === deep.size - 8 && v_same(buf, deep, cur))) return buf;
    // снизу вверх: payload → бокс целевого типа → splice в список детей родителя.
    // На следующем шаге `boxed` УЖЕ полный бокс родителя, поэтому оборачивать его ещё раз
    // нельзя (ровно так я и потерял stbl-правки: minf оборачивался дважды).
    // снизу вверх: payload -> [упаковать в бокс уровня i+1] -> splice в список детей уровня i.
    // Разница в один уровень — источник двух моих багов: если упаковывать в levels[i]
    // (а не в levels[i+1]), корень оборачивается дважды и правки уезжают в ftyp-соседей.
    let payload = cur;
    for (let lvl = levels.length - 1; lvl >= 0; lvl--) {
      const target = levels[lvl];
      const list = lvl === 0 ? walkBoxes(buf, 0) : childBoxes(buf, levels[lvl - 1]);
      const spliced = concat(list.map((k) => (k.type === target.type && k.start === target.start
        ? box(target.type, payload) : buf.subarray(k.start, k.start + k.size))));
      if (lvl === 0) return spliced;         // buf — это список top-level боксов
      payload = spliced;                     // payload родителя = дети с заменённым ребёнком
    }
    return buf;
  }

  /** Побайтовое сравнение payload бокса с новым содержимым. */
  function v_same(buf, boxRec, next) {
    for (let i = 0; i < next.length; i++) if (buf[boxRec.start + 8 + i] !== next[i]) return false;
    return true;
  }

  /** Вставка payload в конец целевого бокса (см. editBox). */
  const insertIntoBox = (buf, path, payload) => editBox(buf, path, (p) => concat([p, payload]));

  /** Удалить боксы указанных типов (в init-сегментах таблицы уже есть — без этого будут дубли). */
  const removeTypes = (dropTypes) => (payload) => {
    const drop = new Set([].concat(dropTypes));
    const kids = walkBoxes(payload, 0);
    const keep = kids.filter((b) => !drop.has(b.type));
    if (keep.length === kids.length) return undefined;   // удалять нечего — не отменяем всю правку
    return concat(keep.map((b) => payload.subarray(b.start, b.start + b.size)));
  };




    /**
   * Дефолты из moov/trex — единственное место, где берётся длительность сэмпла, когда
   * trun её не несёт (а у ffmpeg он несёт вместо неё размеры в байтах).
   * trex: [ver/flags][track_ID][default_sample_description_index][default_sample_duration]
   *       [default_sample_size][default_sample_flags]
   */
  function readTrexDefaults(bytes) {
    const s = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const moov = walkBoxes(s, 0).find((b) => b.type === 'moov');
    if (!moov) return {};
    const mvex = childBoxes(s, moov).find((b) => b.type === 'mvex');
    const trex = mvex ? childBoxes(s, mvex).find((b) => b.type === 'trex') : null;
    if (!trex) return {};
    return {
      trackId: readU32(s, trex.start + 12),
      sampleDescriptionIndex: readU32(s, trex.start + 16),
      duration: readU32(s, trex.start + 20),
      size: readU32(s, trex.start + 24) || 0,
      flags: readU32(s, trex.start + 28) || 0,
    };
  }

  /**
   * Разбор trun: размеры/длительности сэмплов — из них потом строятся stsz/stts.
   * Раскладка ПОЛНОГО бокса: [+0]size [+4]type [+8]version/flags [+12]sample_count
   * [+16]data_offset (если flag 0x1) [+?]first_sample_flags (flag 0x4) [+?]записи.
   * Два реальных подводных камня:
   *  1) field_flags это БИТЫ (0x100 size, 0x200 duration, 0x400 cts, 0x800 flags), а не номера
   *     полей — сравнивать их с 1/2/3 нельзя;
   *  2) если стоит флаг 0x1 (data_offset), то между заголовком и записями лежат ещё 4 байта.
   *     ffmpeg пишет trun именно так, и без этого сдвига первое «число» оказывается самим
   *     data_offset — durations превращаются в мусор (ловушка, на которой я и споткнулся).
   * @returns {{entries:Array<{size?:number,duration?:number,cts?:number,flags?:number}>,
   *            count:number,dataOffset:number|null,firstFlags:number|null}}
   */
  function readTrunSamples(bytes) {
    const s = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const empty = { entries: [], count: 0, dataOffset: null, firstFlags: null };
    let start = -1, size = 0;
    if (s.length >= 8 && fourcc(s, 4) === 'trun') { start = 0; size = readU32(s, 0); }
    else {
      const t = findPath(s, 'moof', ['traf', 'trun']) || findPath(s, 'traf', ['trun']);
      if (!t) return empty;
      start = t.start; size = t.size;
    }
    const hdr = readU32(s, start + 8);
    const flags = hdr & 0xffffff;
    const count = readU32(s, start + 12);
    let p = start + 16;
    let dataOffset = null;
    if (flags & 0x1) { dataOffset = readU32(s, p); p += 4; }
    let firstFlags = null;
    if (flags & 0x4) { firstFlags = readU32(s, p); p += 4; }
    const end = start + size;
    const entries = [];
    for (let i = 0; i < count; i++) {
      const o = {};
      if (flags & 0x100) { if (p + 4 > end) break; o.size = readU32(s, p); p += 4; }
      if (flags & 0x200) { if (p + 4 > end) break; o.duration = readU32(s, p); p += 4; }
      if (flags & 0x400) { if (p + 4 > end) break; o.cts = readU32(s, p); p += 4; }
      if (flags & 0x800) { if (p + 4 > end) break; o.flags = readU32(s, p); p += 4; }
      if (!Object.keys(o).length) break;
      entries.push(o);
    }
    return { entries, count, dataOffset, firstFlags, flags };
  }

  /** Дефолты из mfhd-соседа: flags 0x010000 duration, 0x020000 size, 0x040000 flags. */
  function readTrafDefaults(bytes) {
    const traf = findPath(bytes, 'moof', ['traf']);
    if (!traf) return {};
    const tfdt = childBoxes(bytes, traf).find((b) => b.type === 'tfdt');
    const out = {};
    void tfdt;
    if (tfdt) {
      const ver = (readU32(bytes, tfdt.start + 8) >>> 24) & 0xff;
      out.baseMediaDecodeTime = ver === 1 ? readU64(bytes, tfdt.start + 12) : readU32(bytes, tfdt.start + 12);
    }
    return out;
  }
        /**
   * Разбивка по фрагментам из mfra/tfra (размеры кусков, когда trun нёс только длительности).
   * ISO- layout записи: time | moof_offset | mdat_bytes | last_sample_size | last_sample_count.
   * На практике кодировщики расходятся (ffmpeg пишет поля со сдвигом на одно), поэтому
   * пробуем обе раскладки и возвращаем ту, где сумма mdat_bytes сходится с фактом.
   * @returns {{bytes:number,size:number,count:number}[]} [] если mfra нет/нераспознан
   */
  function readMfraSampleSizes(src, totalMdatBytes) {
    const buf = src instanceof Uint8Array ? src : new Uint8Array(src);
    const mfra = walkBoxes(buf, 0).find((b) => b.type === 'mfra');
    if (!mfra) return [];
    const tfra = childBoxes(buf, mfra).find((b) => b.type === 'tfra');
    if (!tfra) return [];
    const ver = buf[tfra.start + 8];
    const entry = (ver === 1 ? 8 : 4) * 2 + 12;         // time + moof_offset + 3*u32
    const count = readU32(buf, tfra.start + 16);
    const base = tfra.start + 20;
    if (count <= 0 || base + count * entry > tfra.start + tfra.size) return [];
    const pick = (shift) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const r = base + i * entry + shift;
        if (r + 12 > tfra.start + tfra.size) return null;
        out.push({ bytes: readU32(buf, r), size: readU32(buf, r + 4), count: readU32(buf, r + 8) });
      }
      return out;
    };
    const cands = [pick(0), pick(-4)].filter(Boolean);
    const sane = cands.filter((c) => (totalMdatBytes == null || c.reduce((a, x) => a + x.bytes, 0) === totalMdatBytes)
      && c.every((x) => x.count >= 0));
    return sane.length ? sane[0] : [];
  }

  /**
   * Распределяет размер mdat по сэмплам пропорционально их длительностям —
   * приближение, используемое когда ни trun, ни mfra не дали точных размеров.
   */
  function distributeSizes(total, durations) {
    const durs = (durations && durations.length ? durations : [1]).map((x) => (x > 0 ? x : 1));
    const sw = durs.reduce((a, b) => a + b, 0);
    const out = []; let acc = 0;
    for (let i = 0; i < durs.length; i++) {
      let v = Math.round(total * durs[i] / sw);
      if (v < 1) v = 1;
      out.push(v); acc += v;
    }
    // балансировка: сумма обязана быть ровно total, иначе stsz будет врать
    let diff = total - acc;
    for (let i = 0; diff !== 0 && i < out.length; i = (i + 1) % out.length) {
      const step = diff > 0 ? 1 : -1;
      if (out[i] + step >= 1) { out[i] += step; diff -= step; }
    }
    return out;
  }

        /**
   * Полная картировка сэмплов по фрагментированному потоку — ОДНИМ проходом по top-level
   * боксам (наивный вариант «findPath по всему буферу на каждый moof» давал O(n^2): 50 КБ
   * фикстура висла на минуты).
   *
   * Источники размеров, по убыванию доверия:
   *   1) trun с флагом 0x100 — точные размеры каждого сэмпла (плюс «close the tail» для
   *      последнего фрагмента, где ffmpeg не дописал хвостовой размер);
   *   2) trun с флагом 0x201 без 0x100 — у ffmpeg-аудио в sample_duration лежат РАЗМЕРЫ
   *      в байтах; признак — сумма записей ровно равна payload mdat;
   *   3) mfra/tfra (размеры фрагмента целиком) — делим внутри фрагмента по длительностям;
   *   4) tfhd default_sample_size; 5) равные доли mdat (только чтобы stsz сходился с байтами).
   * Длительности при этом всегда берём из таймлайна tfdt (одна на сэмпл): «плавающие» stts
   * из байт-полей сбивают AAC-декодер (проверено: «Input buffer exhausted before END element»).
   * @returns {{sizes:number[],durations:number[],timescale:number,n:number,
   *            partial:boolean,estimated:boolean,bytes:number}}
   */
  /**
   * Полная картировка сэмплов по фрагментированному потоку — ОДНИМ проходом по top-level
   * боксам (наивный «findPath по всему буферу на каждый moof» = O(n^2): 50 КБ висело минуту).
   *
   * Координаты (здесь я спотыкался дважды):
   *   - trun.data_offset отсчитывается от НАЧАЛА mdat-бокса (ISO 14496-12), ffmpeg пишет
   *     8+pre: значит медиа = mdat.payload[pre ..], а не mdat.payload[0 ..];
   *   - у ffmpeg-аудио в trun 0x301 поле sample_size содержит НАСТОЯЩИЕ размеры, а
   *     sample_duration = 1024 (тики AAC); в trun 0x201 «длительности» — это байты.
   *     Отличает одно от другого простое: что из двух сумм равно payload mdat.
   * Sizes: trun(0x100) -> trun-duration-as-size -> tfhd default -> mfra/tfra -> равные доли.
   * Длительности всегда одна константа из таймлайна tfdt: «плавающие» stts из байт-полей
   * сбивают AAC-декодер (реальный симптом: Input buffer exhausted before END element found).
   * @returns {{sizes:number[],durations:number[],timescale:number,n:number,partial:boolean,
   *            estimated:boolean,bytes:number}}
   */
  function collectSamples(src) {
    const v = src instanceof Uint8Array ? src : new Uint8Array(src);
    const tops = walkBoxes(v, 0);
    const trex = readTrexDefaults(v);
    const frags = [];

    let bytes = 0;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i].type !== 'moof') continue;
      const moof = tops[i];
      const mdat = tops[i + 1] && tops[i + 1].type === 'mdat' ? tops[i + 1] : null;
      const rel = v.subarray(moof.start, moof.start + moof.size);
      const tr = findPath(rel, 'moof', ['traf', 'trun']) ? readTrunSamples(rel) : null;
      // Медиа = payload mdat-бокса целиком. data_offset ТРОГАТЬ НЕ НАДО: ffmpeg считает его от
      // начала mdat-бокса и начинает писать данные ровно с +8, т.е. с начала payload
      // (у него doff=204/196 при moof-е в 200/192 Б). Реальные смещения видны по sums: сумма
      // записей trun == mdat.size-8 для каждого фрагмента, и это же == payload всего файла.
      let payload = mdat ? mdat.size - 8 : 0;
      bytes += payload;
      const tfdtBox = findPath(rel, 'moof', ['traf', 'tfdt']);
      const baseTime = tfdtBox ? ((readU32(rel, tfdtBox.start + 8) >>> 24) === 1
        ? readU64(rel, tfdtBox.start + 12) : readU32(rel, tfdtBox.start + 12)) : null;
      const tfhdBox = findPath(rel, 'moof', ['traf', 'tfhd']);
      const tfhdDef = tfhdBox ? readTfhdDefaults(rel) : {};
      const f = { payload, baseTime, n: 0, sizes: [], exact: false,
        defDur: tfhdDef.duration > 0 ? tfhdDef.duration : (trex.duration || 0) };
      if (tr && tr.entries.length) {
        f.n = tr.count || tr.entries.length;
        const sz = tr.entries.map((e) => (e.size != null ? e.size : 0));
        const du = tr.entries.map((e) => (e.duration != null ? e.duration : 0));
        const sum = (a) => a.reduce((x, y) => x + y, 0);
        const hasSizes = !!(tr.flags & 0x100);
        const sizesOk = hasSizes && sz.length === f.n && sz.every((x) => x > 0);
        const dursOk = du.length === f.n && du.every((x) => x > 0);
        if (sizesOk && sum(sz) === payload) { f.sizes = sz; f.exact = true; }   // честный trun
        else if (dursOk && sum(du) === payload) { f.sizes = du; f.exact = true; } // байты в duration
        else if (sizesOk) {
          // размеры есть, но не сходятся (кодировщик не дописал хвостовой сэмпл):
          // берём первые n-1, последний = остаток payload — так stsz гарантированно == mdat
          const head = sz.slice(0, f.n - 1);
          if (head.every((x) => x > 0) && payload > sum(head)) { f.sizes = head.concat([payload - sum(head)]); f.exact = true; }
        } else if (dursOk) {
          const head = du.slice(0, f.n - 1);
          if (head.every((x) => x > 0) && payload > sum(head)) { f.sizes = head.concat([payload - sum(head)]); f.exact = true; }
        }
      } else if (tfhdDef.size > 0) {
        const n = Math.max(1, Math.round(payload / tfhdDef.size));
        f.n = n;
        const sizes = new Array(n).fill(tfhdDef.size);
        if (sum(sizes) === payload) { f.sizes = sizes; f.exact = true; }
      }
      frags.push(f);
    }
    const sum = (a) => a.reduce((x, y) => x + y, 0);

    // якорь длительности по таймлайну tfdt: ticks = (baseTime_посл - baseTime_0) + n_посл*defDur
    const totalN = frags.reduce((a, f) => a + Math.max(f.n, f.sizes.length), 0);
    const timed = frags.filter((f) => f.baseTime != null);
    let constantDur = 0;
    // Если каждый фрагмент с записями несёт ОДИН дефолт (tfhd/trex) — верим ему: это нативная
    // длительность кадра. Якорь по tfdt — усреднение, оно даёт 878 вместо честных 2048.
    const dursSet = new Set(frags.filter((f) => f.defDur > 0).map((f) => f.defDur));
    const sameDefault = dursSet.size === 1 && frags.every((f) => !f.n || f.defDur > 0);
    if (sameDefault) constantDur = [...dursSet][0];
    if (timed.length >= 2 && !constantDur) {
      const first = timed[0], last = timed[timed.length - 1];
      const ticks = (last.baseTime - first.baseTime) + Math.max(last.n, 1) * (last.defDur || 1024);
      const per = Math.round(ticks / Math.max(1, totalN));
      if (per > 0) constantDur = per;
    }
    if (!constantDur) {
      const d0 = (frags.find((f) => f.defDur > 0) || {}).defDur;
      constantDur = d0 || readInitSttsDuration(v) || 1024;
    }

    const sizes = [], durs = [];
    let partial = false, estimated = false;
    const mfra = readMfraSampleSizes(v, bytes);
    const useMfra = mfra.length === frags.length && sum(mfra.map((x) => x.bytes)) === bytes;
    frags.forEach((frag, i) => {
      if (frag.exact) {
        for (const x of frag.sizes) sizes.push(x);
        for (let q = 0; q < frag.sizes.length; q++) durs.push(constantDur);
        return;
      }
      const n = Math.max(1, useMfra ? mfra[i].count : (frag.n || 1));
      const part = distributeSizes(frag.payload, new Array(n).fill(1));
      for (const x of part) sizes.push(x);
      for (let q = 0; q < part.length; q++) durs.push(constantDur);
      partial = true; estimated = true;
    });
    const total = sum(sizes);
    if (total !== bytes && bytes > 0 && Math.abs(total - bytes) * 4 < bytes) {
      // мелкое расхождение (потерянный хвост) — правим последним сэмплом, таблицы обязаны
      // сходиться с числом байт, иначе проигрыватель обрежет/удлинит файл
      sizes[sizes.length - 1] += bytes - total;
      if (sizes[sizes.length - 1] <= 0) { const fixed = distributeSizes(bytes, sizes.map(() => 1)); sizes.length = 0; for (const x of fixed) sizes.push(x); }
      estimated = true;
    } else if (total !== bytes && bytes > 0) {
      const fixed = distributeSizes(bytes, sizes.length ? sizes.map(() => 1) : [1]);
      sizes.length = 0; for (const x of fixed) sizes.push(x);
      durs.length = 0; for (let q = 0; q < fixed.length; q++) durs.push(constantDur);
      partial = true; estimated = true;
    }

    let timescale = 0;
    const moov = tops.find((b) => b.type === 'moov');
    if (moov) {
      const trak = childBoxes(v, moov).find((b) => b.type === 'trak');
      const mdia = trak ? childBoxes(v, trak).find((b) => b.type === 'mdia') : null;
      const mdhd = mdia ? childBoxes(v, mdia).find((b) => b.type === 'mdhd') : null;
      if (mdhd) timescale = readU32(v, mdhd.start + 20);
    }
    return { sizes, durations: durs, timescale: timescale || 1024, n: sizes.length,
      partial, bytes, estimated };
  }

  /** default_sample_duration из stts прогрессивного (не фрагментированного) moov. */
  function readInitSttsDuration(bytes) {
    const st = findPath(bytes, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stts']);
    if (!st) return 0;
    const entries = readU32(bytes, st.start + 12);
    return entries > 0 ? readU32(bytes, st.start + 20) : 0;
  }

  /** Сумма всех размеров фрагментов (для проверки «exact» одним проходом). */
  function sizesSum(frags) { let t = 0; for (const f of frags) for (const x of f.sizes) t += x; return t; }

    /**
   * Сборка прогрессивного MP4 из init-сегмента и «сырых» медиа-байтов.
   * Схема: [init без moov] + [mdat со всеми байтами] + [moov с дописанными stsz/stco/stsc/stts].
   * moov в конце — так offset данных известен заранее, второй проход не нужен.
   * ВАЖНО про координаты (два реальных бага, найденных на ffmpeg-фрагментах):
   *  1) таблицы надо ПЕРЕЗАПИСЫВАТЬ (editBox + removeTypes), а не дописывать: в init-сегменте
   *     stts/stsz/stco уже есть и пустые — дубль читается первым и обнуляет весь файл;
   *  2) moov вырезаем из УЖЕ ПРАТЕННОГО буфера (src), а не из исходного init, иначе
   *     восстановленные длительности消失ают; mvex вырезаем в координатах moov-буфера (от 0).
   * @returns {{bytes:Uint8Array,fixed:boolean,warnings:string[],mdatPayloadOffset:number,estimated:boolean}}
   */
  function assembleMp4(init, mdat, samples) {
    init = init instanceof Uint8Array ? init : new Uint8Array(init);
    mdat = mdat instanceof Uint8Array ? mdat : new Uint8Array(mdat);
    const warnings = [];
    const passthrough = (why) => {
      warnings.push(why);
      return { bytes: concat([init, box('mdat', mdat)]), fixed: false, warnings,
        mdatPayloadOffset: init.length + 8, estimated: false };
    };

    // samples: либо массив ({size,duration}|number), либо результат collectSamples
    const sarr = Array.isArray(samples) ? samples : (samples && samples.sizes) || [];
    const darr = (!Array.isArray(samples) && samples && samples.durations) || null;
    const timescale = (!Array.isArray(samples) && samples && samples.timescale) || 0;
    let samps = (sarr.length ? sarr : []).map((x) => (typeof x === 'number' ? { size: x } : x))
      .filter((s) => s && s.size > 0);
    if (darr && darr.length === samps.length) samps = samps.map((x, i) => ({ ...x, duration: x.duration || darr[i] }));
    let sizes = samps.map((s) => s.size);
    const sum = sizes.reduce((a, b) => a + b, 0);
    let estimated = false;
    if (!sizes.length || sum !== mdat.length) {
      warnings.push(sizes.length
        ? `сумма таблицы сэмплов ${sum} != размер mdat ${mdat.length}`
        : 'нет таблицы сэмплов — считаем всё одним блоком');
      sizes = [mdat.length];
      samps = [{ size: mdat.length, duration: 1024 }];
      estimated = true;
    }
    const moovIn = walkBoxes(init, 0).find((b) => b.type === 'moov');
    if (!moovIn) return passthrough('в init нет moov — отдаём init+mdat как есть, доремукать ffmpeg');
    if (isEncryptedMp4(init)) warnings.push('похоже на зашифрованный поток (sinf/pssh) — без ключа не соберётся');
    const traks = childBoxes(init, moovIn).filter((b) => b.type === 'trak');
    if (!traks.length) return passthrough('в moov нет trak — init+mdat как есть');
    if (traks.length > 1) return passthrough(`в init ${traks.length} трека — тривиальная сборка не применима`);

    const dur = Math.max(1, Math.round(samps.reduce((a, s) => a + (s.duration || 1024), 0) / samps.length));
    void timescale;
    const tablesArr = [
      box('stsz', concat([u32(0), u32(0), u32(sizes.length)].concat(sizes.map((s) => u32(s))))),
      box('stco', concat([u32(0), u32(1), u32(0)])),                  // offset пропатчим после сборки
      // stsc entry = first_chunk | samples_per_chunk | sample_description_index.
      // Порядок полей перепутать легко — ffmpegthen ругается «contradictionary STSC and STCO».
      box('stsc', concat([u32(0), u32(1), u32(1), u32(sizes.length), u32(1)])),
      box('stts', concat([u32(0), u32(1), u32(sizes.length), u32(dur)])),
    ];
    // В init-сегментах stts/stsz/stco/stsc УЖЕ есть (обычно пустые) — их надо удалить,
    // иначе будет два stsz и плеер возьмёт первый (неверный). Поэтому две трансформации:
    // сначала удаление старых, потом добавление новых (порядок внутри одного editBox!).
    const STBL_TABLES = ['stts', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'stss', 'ctts', 'sgpd', 'sbgp'];
    // Страховка: если stts/stsz внутри init были НЕ пусты и их строки не соответствуют
    // нашему числу сэмплов — таблицы из фрагментов не совмещимы с этим init, отдаём как есть
    // (пусть ffmpeg сделает корректный remux, чем отдать файл с таблицами вразнобой).
    const stts0 = findPath(init, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stts']);
    const sttsEntries = stts0 ? readU32(init, stts0.start + 12) : 0;
    const sttsSamples = stts0 && sttsEntries > 0 ? readU32(init, stts0.start + 16) : 0;
    if (stts0 && sttsEntries > 0 && sttsSamples !== sizes.length && sttsSamples > 0) {
      return passthrough(`init уже содержит stts на ${sttsSamples} сэмплов, а из фрагментов получено ${sizes.length} — таблицы несовместимы`);
    }
    const stblPatched = editBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl'], [
      removeTypes(STBL_TABLES),
      (p) => concat([p].concat(tablesArr)),
    ]);
    if (!stblPatched || stblPatched === init) warnings.push('stbl в moov не найден — оставляем moov без правок');
    let src = (stblPatched && stblPatched !== init) ? stblPatched : init;

    // 4) длительности: в empty_moov-инициале mvhd/tkhd/mdhd обнулены — файл без них «неиграбелен»
    // (ffmpeg декодирует, а вот теги/длительность в плеере будут нулевыми).
    const totalTicks = samps.reduce((a, s) => a + (s.duration || 1024), 0);
    const mediaTs = timescale || (() => {
      const mv = walkBoxes(src, 0).find((b) => b.type === 'moov');
      const tk = mv ? childBoxes(src, mv).find((b) => b.type === 'trak') : null;
      const md = tk ? childBoxes(src, tk).find((b) => b.type === 'mdia') : null;
      const mh = md ? childBoxes(src, md).find((b) => b.type === 'mdhd') : null;
      return mh ? readU32(src, mh.start + 20) : 1024;
    })();
    src = fixDurations(src, totalTicks, mediaTs) || src;

    // ВАЖНО: moov берём из src (уже с таблицами и длительностями), а не из init —
    // иначе fixDurations применялся бы к буферу, который никуда не попадает.
    const moovNow = walkBoxes(src, 0).find((b) => b.type === 'moov');
    if (!moovNow) return passthrough('moov потерялся при пересборке');
    const moovBytes = src.subarray(moovNow.start, moovNow.start + moovNow.size);
    // mvex вырезаем в координатах moovBytes (отдельный буфер => своя система отсчёта, начало 0)
    const moov = box('moov', concat(childBoxes(moovBytes, { start: 0, size: moovBytes.length })
      .filter((b) => b.type !== 'mvex')
      .map((b) => moovBytes.subarray(b.start, b.start + b.size))));

    const head = rebuildFromBoxes(src, (b) => b.type !== 'moov');
    const mdatBox = box('mdat', mdat);
    const chunkOffset = head.length + 8;
    let out = concat([head, mdatBox, moov]);
    const moovOut = walkBoxes(out, 0).find((b) => b.type === 'moov');
    const stco = moovOut ? findPath(out, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stco'], moovOut.start) : null;
    if (stco) {
      out = out.slice();
      for (let i = 0; i < 4; i++) out[stco.start + 16 + i] = (chunkOffset >>> (24 - 8 * i)) & 255;
    } else if (!warnings.some((w) => /stbl/.test(w))) warnings.push('stco не найден — полагаемся на ffmpeg');
    return { bytes: out, fixed: !!stco, warnings, mdatPayloadOffset: chunkOffset, estimated };
  }

  /* ═════════════════ 2. НАСТРОЙКИ ═════════════════ */

  const DEF = {
    port: 8765, token: '', mode: 'auto',   // auto|ytdlp|resolve|record|replay|direct
    //   ytdlp = ровно как в оригинальных electron-приложениях: yt-dlp по URL, без
    //   googlevideo-запросов из браузера (те вообще никогда ничего не качали сами)
    format: 'm4a',                          // m4a|mp3|opus|copy
    bitrate: '320k', organize: 'none', out: '',
    // proxy: '' = как настроено в ini; 'none' = прямо (VPN выключить для закачки);
    // convert: 'off' = не трогать контейнер, иначе force на выходе (m4a|mp3|opus)
    proxy: '', convert: 'off',
    autoRecord: false, verbose: false, queueDelayMs: 400, dedup: true, playlistItems: '',
    altHost: false, safariFirst: true, queueVia: 'companion', ui: '',   // 0.5.11: safari по умолчанию вкл; очередь: companion|browser
  };
  const cfg = {};
  for (const k in DEF) cfg[k] = (typeof GM_getValue === 'function' ? GM_getValue('cfg_' + k, DEF[k]) : DEF[k]);
  if (cfg.out === undefined) cfg.out = '';        // конфиги, сохранённые до появления настройки out
  const saveCfg = () => { for (const k in DEF) if (typeof GM_setValue === 'function') GM_setValue('cfg_' + k, cfg[k]); };
  // 0.5.6: эффективные настройки всегда на виду (mp3 из памятиstorage больше не сюрприз)
  const renderChips = () => {
    const c = (typeof document !== 'undefined') && document.getElementById && document.getElementById('ytmdl-chips');
    if (!c) return;
    c.textContent = ` · ${cfg.format}${cfg.convert && cfg.convert !== 'off' ? '→' + cfg.convert : ''} · ${cfg.mode}`
      + (cfg.dedup ? ' · дедуп' : '') + (cfg.altHost ? ' · запас www' : '')
      + (cfg.safariFirst ? ' · safari сразу' : '');
    c.setAttribute('title', 'эффективные настройки панели - они помнятся между запусками');
  };
  const log = (...a) => { if (cfg.verbose) console.log(LOG, ...a); mirrorLog(a.map(String).join(' '), 'info'); };
  // зеркало сообщений панели в ytm-run.log: «собрать лог для поддержки» = один файл.
  // Дедуп по первым 140 знакам (2 с) - мелькающие строки хуков не забивают лог.
  const _mirrorSeen = new Map();
  function mirrorLog(line, level) {
    if (!companionAvailable) return;
    const txt = String(line == null ? '' : line).trim().slice(0, 280);
    if (!txt) return;
    const key = txt.slice(0, 140);
    const t = Date.now();
    if (t - (_mirrorSeen.get(key) || 0) < 2000) return;
    _mirrorSeen.set(key, t);
    if (_mirrorSeen.size > 300) _mirrorSeen.clear();
    try {
      gmx({ method: 'POST', url: `${base()}/log${cfg.token ? '?token=' + encodeURIComponent(cfg.token) : ''}`,
        headers: Object.assign({ 'Content-Type': 'application/json' }, tokenHdr()),
        data: JSON.stringify({ text: txt, level: level || 'info' }) }).then(() => {}, () => {});
    } catch (e) { /* лог не должен рождать лог */ }
  }

  /* ═════════════════ 3. ПЕРЕХВАТ СЕТИ ═════════════════ */

  const state = {
    hook: null,           // {fetch, xhr, page, when} - слушаем ли страницу вообще
    byVideo: new Map(),  // videoId -> {pr, at, source, album}
    playThru: null,      // 0.5.9: {stop} во время «прогона через плеер»
    queueCtl: null,      // controller for companion/browser page queue
    streams: new Map(),  // videoId -> {ranges:[], itags:Set, bytes, lastAt}
    recording: false,
    lastVideoId: null,
    recStop: null,
    mounted: false,   // кнопка где-то на странице
    floating: false,  //   ...но не в плеер-баре (селекторы не совпали)
  };

  /**
   * Ответ плеера, который страница уже держит у себя. Перехват fetch/XHR ловит
   * не всё: YTM успевает получить player response ДО установки нашего хука
   * (страница открыта раньше скрипта), а часть ответов приезжает из inline-
   * скрипта. Порядок: глобалы -> config ytplayer -> разбор <script>. Берём
   * только ответ про текущий videoId, иначе подмешаем чужой трек.
   */
  function initialPlayerResponse(vid) {
    const cands = [];
    try { if (global.ytInitialPlayerResponse) cands.push(global.ytInitialPlayerResponse); } catch (e) {}
    try {
      const ytp = global.ytplayer || {};
      const args = (ytp.config && ytp.config.args) || ytp.load || ytp.args || {};
      if (args.player_response) cands.push(args.player_response);
    } catch (e) {}
    try {
      const sc = document.querySelectorAll ? document.querySelectorAll('script') : [];
      for (let i = sc.length - 1; i >= 0 && i > sc.length - 40; i--) {
        const t = sc[i].textContent || '';
        const at = t.indexOf('ytInitialPlayerResponse');
        if (at < 0) continue;
        cands.push(JSON.parse(t.slice(t.indexOf('{', at), t.lastIndexOf('};') + 1)));
        break;
      }
    } catch (e) { /* разбор не обязан сработать - это последняя попытка */ }
    for (const pr of cands) {
      if (!pr || typeof pr !== 'object') continue;
      const id = (pr.videoDetails && pr.videoDetails.videoId) || '';
      if (vid && id && id !== vid) continue;
      if (pr.videoDetails || (pr.streamingData && (pr.streamingData.adaptiveFormats || pr.streamingData.formats))) return pr;
    }
    return null;
  }

  /** Это вообще player response? HTML-заглушка бот-чека - не он. */
  function looksLikePlayerResponse(pr) {
    if (!pr || typeof pr !== 'object') return false;
    if (typeof pr.html === 'string' || (typeof pr.status === 'number' && !pr.videoDetails)) return false;
    return !!(pr.videoDetails || pr.playabilityStatus || pr.streamingData || pr.microformat);
  }

  function capturePlayerResponse(videoId, pr, source) {
    if (!videoId || !pr || typeof pr !== 'object') return false;
    if (!looksLikePlayerResponse(pr)) {
      toastOnce(`источник ${source} вернул не player response (пусто/HTML) - бот-чек или не тот url`, 'warn');
      return false;
    }
    const prev = state.byVideo.get(videoId);
    if (prev && prev.pr === pr) return false;
    state.byVideo.set(videoId, { pr, at: Date.now(), source, album: extractAlbum(pr) });
    log('captured', videoId, source);
    const d = diagnose(pr, pickAudioFormats(pr));
    toastOnce(`ответ плеера: ${d.text}`, d.level === 'bad' ? 'err' : 'info');
    if (cfg.autoRecord && !canDownloadDirectly(pickAudioFormats(pr)) && !state.recording) startRecording(videoId);
    uiRefresh();
    return true;
  }

  function extractAlbum(pr) {
    try {
      const mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
      if (mf && mf.album) {
        const t = mf.album.title;
        return typeof t === 'string' ? t : (t && (t.simpleText || t.runs && t.runs.map((r) => r.text).join(''))) || '';
      }
    } catch (e) { /* ignore */ }
    try {
      const hdr = document.querySelector('ytmusic-player-bar .subtitle a');
      return hdr ? hdr.textContent.trim() : '';
    } catch (e) { return ''; }
  }

  function streamRec(vid) {
    let r = state.streams.get(vid);
    if (!r) { r = { ranges: [], itags: new Set(), bytes: 0, lastAt: 0 }; state.streams.set(vid, r); }
    return r;
  }

  /** Запомнить обращение плеера к googlevideo (для replay/record). */
  function observeStream(url, headers, bytesGot) {
    const vid = currentVideoId(); if (!vid) return null;
    const r = streamRec(vid);
    const m = /itag=(\d+)/.exec(url);
    if (m) r.itags.add(Number(m[1]));
    const rg = parseRange(headers && (headers.Range || headers.range));
    const start = rg && rg.start != null ? rg.start : 0;
    r.ranges.push({ url, start, end: rg ? rg.end : null, bytes: bytesGot || 0, at: Date.now() });
    if (bytesGot) r.bytes += bytesGot;
    r.lastAt = Date.now();
    if (r.ranges.length > 4000) r.ranges.splice(0, r.ranges.length - 4000);
    return r;
  }

  /** Лучший url для replay: с наивысшим itag и с начала диапазона. */
  function bestSniffedUrl(vid) {
    const r = state.streams.get(vid);
    if (!r || !r.ranges.length) return null;
    const byItag = new Map();
    for (const e of r.ranges) {
      const it = Number((/itag=(\d+)/.exec(e.url) || [])[1] || 0);
      const cur = byItag.get(it);
      if (!cur || (e.start === 0 && cur.start !== 0)) byItag.set(it, e);
    }
    const best = [...byItag.entries()].sort((a, b) => b[0] - a[0])[0];
    return best ? best[1].url : null;
  }

  /**
   * Где лежат НАСТОЯЩИЕ fetch/XHR. С @grant'ами Tampermonkey `global` - это
   * песочница, и хук видел бы только наши собственные запросы: отсюда
   * «ответа плеера ещё нет» и «sniffed: null» при играющей музыке.
   * unsafeWindow - window страницы; без него (@grant none / другой менеджер)
   * остаёмся в песочнице и честно про это сообщаем в диагностике.
   */
  function hookTarget(g) {
    try { if (g.unsafeWindow && g.unsafeWindow.fetch) return g.unsafeWindow; } catch (e) {}
    return g;
  }

  function hookFetch() {
    const T = hookTarget(global);
    if (T.__ytmdlHooked) return;
    T.__ytmdlHooked = true;
    state.hook = { fetch: true, xhr: false, page: T !== global, when: document.readyState };
    const orig = T.fetch.bind(T);
    T.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      let hdrs = init && init.headers;
      if (!hdrs && input && input.headers && typeof input.headers.forEach === 'function') {
        hdrs = {}; input.headers.forEach((v, k) => { hdrs[k] = v; });
      }
      const resp = await orig(input, init);
      try {
        if (/\/youtubei\/v1\/player/.test(url)) {
          resp.clone().json().then((j) => {
            capturePlayerResponse((j && j.videoDetails && j.videoDetails.videoId) || currentVideoId(), j, 'fetch');
          }).catch(() => {});
        } else if (/googlevideo\.com/.test(url)) {
          observeStream(url, hdrs);
        }
      } catch (e) { log('fetch hook', e); }
      return resp;
    };
  }

  function hookXhr() {
    const T = hookTarget(global);
    if (T.__ytmdlHookedXhr) return;
    T.__ytmdlHookedXhr = true;
    if (state.hook) state.hook.xhr = true;
    const XP = T.XMLHttpRequest && T.XMLHttpRequest.prototype;
    if (!XP) return;
    const O = XP.open, H = XP.setRequestHeader, S = XP.send;
    XP.open = function (m, u) { this.__u = u; this.__h = {}; return O.apply(this, arguments); };
    XP.setRequestHeader = function (k, v) { if (this.__h) this.__h[k] = v; return H.apply(this, arguments); };
    XP.send = function () {
      const self = this;
      this.addEventListener('load', function () {
        try {
          const u = self.__u || '';
          if (/\/youtubei\/v1\/player/.test(u) && (!self.responseType || self.responseType === 'text' || self.responseType === '')) {
            const j = JSON.parse(self.responseText);
            capturePlayerResponse((j && j.videoDetails && j.videoDetails.videoId) || currentVideoId(), j, 'xhr');
          } else if (/googlevideo\.com/.test(u)) {
            observeStream(u, self.__h, 0);
          }
        } catch (e) { log('xhr hook', e); }
      });
      return S.apply(this, arguments);
    };
  }

  /* ═════════════════ 4. КОМПАНОН ═════════════════ */

  const base = () => `http://127.0.0.1:${cfg.port}`;
  function gmx(o) {
    return new Promise((res, rej) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        // GM_* может не быть даже при верном @grant: Tampermonkey спрашивает разрешение
        // на чужие домены, и отказ/пропуск диалога выглядит как «кнопка не работает».
        // Компаньон отдаёт CORS-заголовок для *.youtube.com, поэтому обычный fetch тут
        // настоящая замена, а не костыль.
        const u = o.url || '';
        const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);
        if (local) {
          return fetch(u, {
            method: o.method || 'GET',
            headers: o.headers || {},
            body: o.data == null ? undefined : String(o.data),
          }).then(async (r) => {
            const text = await r.text();
            if (!r.ok && r.status !== 202) throw new Error('HTTP ' + r.status);
            return { status: r.status, responseText: text };
          }).catch((e) => rej(new Error('companion недоступен напрямую (' + (e.message || e)
            + ') и GM_xmlhttpRequest не разрешён: разреши Tampermonkey доступ к 127.0.0.1 '
            + 'и проверь, что start.bat запущено')));
        }
        return rej(new Error('GM_xmlhttpRequest недоступен: в Tampermonkey не выдано разрешение '
          + 'на запросы (иконка TM → «разрешить доступ к 127.0.0.1»); @grant в скрипте есть'));
      }
      GM_xmlhttpRequest(Object.assign({}, o, {
        onload: res,
        onerror: (e) => rej(new Error('network' + (e && e.status ? ' ' + e.status : ''))),
        ontimeout: () => rej(new Error('timeout')),
      }));
    });
  }
  const tokenHdr = () => (cfg.token ? { 'X-YTM-Token': cfg.token } : {});
  const hello = async () => JSON.parse((await gmx({ method: 'GET', url: `${base()}/hello`, headers: tokenHdr() })).responseText);

  async function postJob(payload) {
    const r = await gmx({
      method: 'POST', url: `${base()}/job`,
      headers: Object.assign({ 'Content-Type': 'application/json' }, tokenHdr()),
      data: JSON.stringify(payload),
    });
    return JSON.parse(r.responseText).job;
  }

  async function throttleQueueStatus() {
    const r = await gmx({ method: 'GET', url: `${base()}/throttle-queue/status`, headers: tokenHdr() });
    return JSON.parse(r.responseText);
  }

  async function pollJob(id, onProgress) {
    for (let i = 0; i < 5400; i++) {
      const j = JSON.parse((await gmx({ method: 'GET', url: `${base()}/job/${id}`, headers: tokenHdr() })).responseText);
      if (onProgress) onProgress(j);
      if (j.status === 'done') return j;
      if (j.status === 'error') throw new Error(j.error || 'companion: job error');
      await new Promise((s) => setTimeout(s, j.status === 'queued' ? 700 : 400));
    }
    throw new Error('companion: таймаут ожидания');
  }

  /**
   * Папка загрузки. Браузер не может показать диалог выбора каталога и не имеет права
   * писать куда хочет, поэтому это строка в настройках, которую companion проверяет сам:
   * пустая -> `--out`, заданная -> разворачивается `~` и резолвится относительно HOME
   * (обход за пределы дома отклоняет сервер). См. also `out_dir_ok`.
   */
  const dirOverride = () => String(cfg.out || '').trim();
  function withDirOverride(payload) {
    const o = dirOverride();
    return o ? Object.assign({}, payload, { out_dir: o }) : payload;
  }
  /**
   * meta для query-строки. `pr` (весь player response) туда класть нельзя: это
   * сотни килобайт, и http-сервер отрезает их с "414 Request-URI Too Long".
   * Компаньону в /media нужны только title/artist/album/duration/thumbnail.
   */
  function mediaMeta(meta) {
    const o = Object.assign({}, meta || {});
    delete o.pr;
    return o;
  }

  function mediaQuery(meta, fmt) {
    // force-контейнер из панели - поверх всего, КРОМЕ copy (копия = неприкосновенна)
    const forced = cfg.convert && cfg.convert !== 'off' && (fmt || cfg.format) !== 'copy' ? cfg.convert : null;
    const tfmt = forced || fmt || cfg.format;
    const q = new URLSearchParams({ format: tfmt, meta: JSON.stringify(mediaMeta(meta)) });
    if (tfmt === 'mp3') q.set('bitrate', cfg.bitrate);
    if (cfg.proxy) q.set('proxy', cfg.proxy);
    if (cfg.token) q.set('token', cfg.token);
    const o = dirOverride();
    if (o) q.set('out', o);
    if (!cfg.dedup) q.set('dedup', '0');
    if (meta && meta.videoId) q.set('videoId', meta.videoId);   // по нему companion сверяет архив
    return q;
  }

  /** payload для /job: туда же прокидываем переопределение папки и режим дедупа. */
  function jobPayload(payload) {
    const out = withDirOverride(payload);
    if (!cfg.dedup) out.dedup = false;
    if (cfg.proxy) out.proxy = cfg.proxy;
    if (cfg.convert && cfg.convert !== 'off' && out.format !== 'copy') out.format = cfg.convert;
    if (cfg.altHost) out.host_pref = 'www';   // 0.5.6: «через youtube.com» - серверные пути
    // 0.5.10: «web_safari сразу» = старт лесенки с рабочего клиента, без 60-секундного
    // прогрева default/tv. Явный player_client задачи (если он пришёл) НЕ перетираем.
    if (cfg.safariFirst && !out.player_client) out.player_client = 'web_safari';
    return out;
  }

  /** «Что уже есть на диске» — чтобы не дёргать сеть для скачанного в прошлый раз. */
  async function filterAlreadyHave(ids) {
    const uniq = [...new Set((ids || []).filter(Boolean))];
    if (!uniq.length || !companionAvailable || !cfg.dedup) return { fresh: uniq, have: [] };
    try {
      const r = await gmx({ method: 'GET', url: `${base()}/has?ids=${encodeURIComponent(uniq.join(','))}`, headers: tokenHdr() });
      const j = JSON.parse(r.responseText);
      const have = new Set(j.have || []);
      return { fresh: uniq.filter((x) => !have.has(x)), have: [...have] };
    } catch (e) { log('has', e); return { fresh: uniq, have: [] }; }
  }

  /** POST /media: байты уже у нас — просим companion пересобрать и затегать. */
  async function postMedia(bytes, meta, fmt) {
    const q = mediaQuery(meta, fmt);
    const r = await gmx({
      method: 'POST', url: `${base()}/media?${q.toString()}`,
      headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, tokenHdr()),
      binary: true, data: bytes,
    });
    return JSON.parse(r.responseText);
  }

  /**
   * Заголовки, которыми плеер сам просит этот поток. Нужны не «чтобы обмануть»,
   * а чтобы наш запрос не отличался от того, что страница уже делает: googlevideo
   * смотрит на Origin/Referer и на клиент, от имени которого выдана ссылка.
   */
  function streamHeaders(info) {
    const h = {
      'X-Youtube-Client-Name': String((info && info.clientName) || 67),
      'X-Youtube-Client-Version': String((info && info.clientVersion) || '2.20250101.00.00'),
    };
    return h;
  }

  /** Скачивание в память с прогрессом (direct/replay). */
  async function fetchStream(url, extraHdrs) {
    return global.fetch(url, {
      credentials: 'include', redirect: 'follow',
      referrer: (global.location && global.location.origin) ? global.location.origin + '/' : undefined,
      headers: extraHdrs || undefined,
    });
  }

  async function downloadToBytes(url, onPct, expectBytes, info) {
    let resp;
    try {
      resp = await fetchStream(url, info === false ? null : streamHeaders(info));
    } catch (e) {
      // заголовки уронили preflight (CORS) или их не пропустил GM-слой:
      // повторяем как раньше, без них - иначе добавление заголовков само
      // стало бы причиной «скачать не работает»
      log('stream headers failed, retry plain:', e && e.message);
      resp = await fetchStream(url, null);
    }
    if (!resp.ok && resp.status !== 206) throw new Error(`stream HTTP ${resp.status} — IP/cookies рассинхрон?`);
    const len = Number(resp.headers.get('Content-Length') || expectBytes || 0);
    const ct = resp.headers.get('Content-Type') || '';
    if (!resp.body || !resp.body.getReader) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (looksLikeHtml(ct, buf)) throw new Error('сервер отдал HTML вместо потока (бот-чек) — режим browser или cookies_file');
      return buf;
    }
    const rd = resp.body.getReader();
    const parts = []; let got = 0, lastUi = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value); got += value.length;
      const now = Date.now();
      if (onPct && now - lastUi > 150) { onPct(len ? got / len : got); lastUi = now; }
    }
    const out = new Uint8Array(got); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    if (looksLikeHtml(ct, out.subarray(0, 240))) {
      throw new Error(`скачался HTML (${got} Б вместо ${len || '?'}), не поток — бот-чек: включи режим browser или cookies`);
    }
    if (got < 1024) throw new Error(`поток оборвался на ${got} Б`);
    if (expectBytes && got < expectBytes * 0.5) {
      log(`warning: получено ${got} Б из ожидаемых ${expectBytes} Б`);
    }
    if (onPct) onPct(1);
    return out;
  }

  /** Запасной путь без companion: сохраняем то, что скачали, через blob. */
  function saveBlob(bytes, filename, mime) {
    const b = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ═════════════════ 5. РЕЖИМЫ ═════════════════ */

  async function trackInfo() {
    const vid = currentVideoId();
    if (!vid) throw new Error('сейчас ничего не играет');
    const cap = state.byVideo.get(vid);
    const pr = cap && cap.pr;
    const vd = (pr && pr.videoDetails) || {};
    const domTitle = (document.title || '').replace(/\s*[|\-–]\s*YouTube Music\s*$/i, '')
    .replace(/^\s*YouTube Music\s*[|\-–]\s*/i, '').replace(/\s+/g, ' ').trim();
    const domArtist = (document.querySelector('ytmusic-player-bar .byline a') || {}).textContent || '';
    return {
      videoId: vid,
      title: vd.title || domTitle || 'track',
      artist: (vd.author || domArtist || '').replace(/^Music Account:\s*/, '').trim(),
      album: (cap && cap.album) || '',
      duration: Number(vd.lengthSeconds) || 0,
      thumbnail: ((vd.thumbnail && vd.thumbnail.thumbnails || []).slice(-1)[0] || {}).url
        || (document.querySelector('ytmusic-player-bar img#image') || {}).src || '',   // 0.5.11: ytdlp без перехвата - обложка из плеер-бара
      pr,
    };
  }

  function currentVideoId() {
    const search = (typeof location !== 'undefined' && location.search) || '';
    const m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(search);
    if (m) return m[1];
    const m2 = /music\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,})/.exec((typeof location !== 'undefined' && location.href) || '');
    if (m2) return m2[1];
    // 0.5.7: адрес страницы врать не должен. Развёрнутый трек - это /watch?v=...,
    // свёрнутый на странице альбома/liked - /playlist?list=..., где v= нет, а плеер
    // играет. Истина - в свойствах player-bar'а (YTM отдаёт videoId через внутренний
    // getVideoData); старый запрос [video-id] возвращал ПЕРВУЮ строку списка, то есть
    // чужой трек - это хуже, чем «ничего».
    for (const sel of ['ytmusic-player-bar', 'ytmusic-player']) {
      try {
        const el = document.querySelector(sel);
        const v = el && (el.videoId
          || (el.player_ && el.player_.getVideoData && el.player_.getVideoData().videoId));
        if (v && /^[A-Za-z0-9_-]{6,}$/.test(String(v))) return String(v);
      } catch (e) { /* чужая разметка - идём дальше */ }
    }
    // крайний случай: что страница недавно сама запрашивала у /player (хук видел)
    try {
      let best = null, bt = 0;
      state.byVideo.forEach((v, k) => { if (v.at > bt) { bt = v.at; best = k; } });
      if (best) return best;
    } catch (e) { /* нет состояния - пусть будет «ничего» */ }
    return null;
  }

  // mp3: источник = m4a, а не opus - LAME поверх opus это ДВОЙНОЕ lossy, поверх
  // aac 128-256k потер почти не видно; компаньон при этом всё равно допишет обложку.
  const formatSpec = () => (cfg.format === 'mp3' ? 'bestaudio[ext=m4a]/bestaudio/best'
    : cfg.format === 'opus' ? 'bestaudio[ext=webm]/bestaudio/best'
      : 'bestaudio[ext=m4a]/bestaudio/best');

  function resolveMode(info, fmts, sniffed, want) {
    if (want && want !== 'auto') return want === 'ytdlp' ? 'resolve' : want;
    if (canDownloadDirectly(fmts)) return 'direct';
    if (sniffed && !/sabr=1/.test(sniffed)) return 'replay';
    return 'resolve';
  }

  /** YouTube умеет приостанавливать АККАУНТ («слишком много устройств...»), и тогда
   *  пустой streamingData приходит даже в самой вкладке. В этом состоянии любая
   *  лесенка yt-dlp = только ухудшение (каждый /player-запрос加深 подозрительности),
   *  поэтому auto обязан сдаться честно, а не 5 раз по 40 секунд. */
  function accountThrottled(info) {
    try {
      const pr = info && info.pr;
      const play = (pr && pr.playabilityStatus) || {};
      const reason = String(play.reason || '');
      if ((play.status || '').toUpperCase() === 'UNPLAYABLE' &&
          /слишком много|too many|одновремен|parallel device/i.test(reason)) return reason;
    } catch (e) { /* defensive */ }
    return '';
  }

  async function runTrack(overrides) {
    const opt = overrides || {};
    const info = await trackInfo();
    const fmts = info.pr ? pickAudioFormats(info.pr) : [];
    const sniffed = bestSniffedUrl(info.videoId);
    if (!info.pr) { const fromPage = initialPlayerResponse(info.videoId); if (fromPage) capturePlayerResponse(info.videoId, fromPage, 'page'); }
    if (!info.pr) {
      // 0.5.10: ответа нет - не идти к компаньону с пустыми руками: страница сама
      // запрашивает /player ровно как в «браузерном прогоне»; capture поймает его
      try {
        await selfAskPlayer(info.videoId, 9);
        const c2 = state.byVideo.get(info.videoId);
        if (c2 && c2.pr) info.pr = c2.pr;
      } catch (e) { /* нет ytcfg - ну и пусть, лесенка поработает без ответа */ }
    }
    const wantMode = opt.mode || cfg.mode;
    const throttled = accountThrottled(info);
    if (throttled) {
      mirrorLog('аккаунт приостановлен YouTube: «' + throttled + '» - ' +
        (wantMode === 'auto' ? 'auto не гоняет лесенку, ждём' : 'пробуем, раз выбрано явно'), 'err');
      if (wantMode === 'auto')
        throw new Error('YouTube приостановил аккаунт: «' + throttled + '». Долбить /player пятью '
          + 'попытками вредно - дождись снятия лимита (час-два, иногда перезалогин), либо качай '
          + 'record во время воспроизведения; если уверен, что это не лимит - выбери ytdlp явно, '
          + 'тогда пойдёт одна честная попытка');
    }
    let mode = resolveMode(info, fmts, sniffed, wantMode);
    // replay осмыслен только когда в сетях реально лежит ЦЕЛЫЙ файл: после
    // десятка секунд прослушивания там кусок - и «скачанный m4a» не играет
    if (mode === 'replay' && !sniffedFull(info.videoId, info.duration)) {
      log('replay отменён: sniffed-поток неполный (плеер докачает - попробуй ещё раз или качай через компаньон)');
      mode = 'resolve';
    }
    // «resolve» без ответа плеера = заведомо пустая задача; yt-dlp по url
    // работает и без перехвата - вот куда и ведём, вместо «не перехвачен»
    if (mode === 'resolve' && !info.pr && companionAvailable) mode = 'ytdlp';
    setStatus(`«${info.title}» → режим ${mode}`, 'run');
    try {
      const res = await ({ direct: () => modeDirect(info, fmts), replay: () => modeReplay(info, sniffed, info), record: () => modeRecord(info), resolve: () => modeResolve(info, opt.mode || cfg.mode) }[mode] || modeResolve)();
      setStatus(`готово: ${res.detail || res.mode}`, 'ok');
      return res;
    } catch (e) {
      // авто-деградация: direct/replay упали → работу берёт на себя yt-dlp
      if (mode !== 'resolve' && !opt.noFallback) {
        log(`${mode} failed (${e.message}); falling back to resolve`);
        setStatus(`${mode} не вышло (${e.message}), пробую resolve…`, 'warn');
        return modeResolve(info);
      }
      throw e;
    }
  }

  /** direct/replay раньше считались успешными сразу после POST /media: job мог
   *  упасть в error через секунду, а на экране уже стояло «готово». Дожидаемся
   *  конца - тогда "скачать не молча, а с объяснением" верно для всех режимов. */
  async function finishMediaJob(r, bytes) {
    if (!r || !r.job) return { bytes: bytes, detail: `${bytes} Б` };
    const j = await pollJob(r.job, (x) => setStatus(`companion: ${x.message || x.status}`, 'run'));
    return { bytes: bytes, detail: String((j && j.message) || 'файл на диске'), job: r.job };
  }

  /** itag-подпись sniffed-ссылки: 249/250/251 = opus, всё прочее = AAC/mp4a */
  function sniffedContainer(url) {
    const m = /itag=(\d+)/.exec(url || '');
    return m && (m[1] === '249' || m[1] === '250' || m[1] === '251') ? 'opus' : 'm4a';
  }

  /** Что просим у companion: «сырьё m4a» никогда не называем opus'ом и наоборот -
   *  так рождались файлы, которые «есть, но не играются». copy = по-прежнему
   *  «сырые байты как есть», по явному выбору человека. */
  function mediaFmt(container) {
    if (cfg.format === 'mp3') return 'mp3';
    if (cfg.format === 'copy') return 'copy';
    if (container === 'opus') return cfg.format === 'opus' ? 'opus' : 'm4a';
    return 'm4a';
  }

  /** Целый ли файл реально просят сети браузера. Плеер добирает медиа Range-ами
   *  кусками; «перекачать sniffed» после 10 секунд прослушивания = кусок в 300 КБ
   *  с расширением .m4a. Считаем полным только непрерывный coverage от нуля не
   *  меньше половины ожидаемого веса трека (128 kbps ≈ 16 КБ/с). */
  function sniffedFull(vid, duration) {
    const r = state.streams.get(vid);
    if (!r || !r.ranges || !r.ranges.length) return false;
    const cov = coverageFromRanges(r.ranges);
    if (!cov.contiguous || cov.first !== 0) return false;
    const need = duration > 0 ? Math.max(256000, Math.round(duration * 8000)) : 1500000;
    return cov.covered >= need;
  }

  async function modeDirect(info, fmts) {
    const f = fmts.find((x) => x.url && !x.sabr);
    if (!f) throw new Error('нет форматов с url');
    const bytes = await downloadToBytes(f.url, (p) => setProgress(p * 0.85), f.bytes, info);
    if (!companionAvailable) { saveBlob(bytes, `${info.artist} - ${info.title}.${f.container}`); return { mode: 'direct', bytes: bytes.length, detail: 'сохранено в загрузки (companion выключен)' }; }
    // opus-сырьё из вкладки едет как format=opus: компаньон сделает remux в .opus
    // без перекодирования и положит обложку в METADATA_BLOCK_PICTURE (copy же =
    // «кинь как есть», и это по-прежнему сырьё без тегов - ровно то, что просят)
    const r = await postMedia(bytes, info, mediaFmt(f.container));
    const fin = await finishMediaJob(r, bytes.length);
    return Object.assign({ mode: 'direct' }, fin);
  }

  async function modeReplay(info, url, pinfo) {
    if (!url) throw new Error('плеер ещё не качал этот трек (нажми play)');
    const bytes = await downloadToBytes(fullRangeUrl(url), (p) => setProgress(p * 0.85), 0, pinfo);
    // replay отдаёт РОВНО те байты, что прошли через плеер: это либо полный файл
    // (тогда называем его по itag - opus так opus), либо нет. 'copy' сюда был
    // ловушкой: кусок с расширением .m4a «скачался», но не играет.
    const fmt = mediaFmt(sniffedContainer(url));
    if (!companionAvailable) { saveBlob(bytes, `${info.artist} - ${info.title}.${fmt === 'opus' ? 'opus' : 'm4a'}`); return { mode: 'replay', bytes: bytes.length, detail: 'blob' }; }
    const r = await postMedia(bytes, info, fmt);
    const fin = await finishMediaJob(r, bytes.length);
    return Object.assign({ mode: 'replay' }, fin);
  }

  /** Основной стойкий режим: player response → yt-dlp на машине пользователя. */
  /** Тело /job kind:browser. Вынесено из modeResolve, чтобы было чем проверить. */
  function browserJobPayload(info, mode) {
    return jobPayload({
      kind: 'browser', videoId: info.videoId, player_response: mode === 'ytdlp' ? null : info.pr,
      prefer_url: mode === 'ytdlp' || undefined,   // 'ytdlp' = пусть yt-dlp сам разберётся, как в оригинале
      format: cfg.format, format_spec: formatSpec(), thumbnail: info.thumbnail,
      meta: { title: info.title, artist: info.artist, album: info.album, duration: info.duration,
        thumbnail: info.thumbnail, videoId: info.videoId },
    });
  }

  /** Ручной перезахват: когда авто-источники промолчали (страница старше скрипта). */
  async function regrab() {
    const v = currentVideoId();
    if (!v) { setStatus('сейчас ничего не играет', 'warn'); return false; }
    const fromPage = initialPlayerResponse(v);
    if (fromPage && capturePlayerResponse(v, fromPage, 'page')) {
      setStatus('player response взят из страницы', 'ok');
      return true;
    }
    setStatus('запрашиваю /player от имени страницы…', 'run');
    const ok = await selfAskPlayer(v);
    setStatus(ok ? 'player response получен'
                 : 'ответ не получен: смотри диагностику - поле hook (хук на странице?) и ytcfg', ok ? 'ok' : 'err');
    return ok;
  }

  async function modeResolve(info, mode) {
    const m = mode || cfg.mode;
    if (!info.pr && m !== 'ytdlp') {
      const again = await regrab();
      if (!again) {
        throw new Error('ответ плеера не перехвачен: в меню Tampermonkey «Перезахватить player response», '
          + 'или выбери режим ytdlp (yt-dlp по url, перехват не нужен)');
      }
      info.pr = (state.byVideo.get(info.videoId) || {}).pr;
    }
    if (!companionAvailable) throw new Error(`companion не отвечает на ${base()} — запусти python3 companion.py --port ${cfg.port}`);
    const job = await postJob(browserJobPayload(info, m));
    await pollJob(job, (j) => { setProgress(j.progress || 0); setStatus(`companion: ${j.message || j.status} · ${Math.round((j.progress || 0) * 100)}%`, j.status === 'error' ? 'err' : 'run'); });
    return { mode: 'resolve', detail: 'файл на диске', job };
  }

  /** record: дожидаемся, пока плеер доскачает, и берём весь диапазон одним GET. */
  async function modeRecord(info) {
    startRecording(info.videoId);
    setStatus('record: не перематывай — идёт запись playback', 'warn');
    const deadline = Date.now() + ((info.duration || 300) + 45) * 1000;
    await new Promise((resolve) => {
      const t = setInterval(() => {
        const r = state.streams.get(info.videoId);
        if (r && r.ranges.length > 4 && Date.now() - r.lastAt > 4000) return finish();
        if (Date.now() > deadline) return finish();
        if (r) { const cov = coverageFromRanges(r.ranges); setProgress(Math.min(0.99, (cov.covered || 0) / Math.max(1, cov.last || 1))); }
      }, 1000);
      const finish = () => { clearInterval(t); state.recStop = null; stopRecording(); resolve(); };
      state.recStop = finish;
    });
    const url = bestSniffedUrl(info.videoId);
    if (url) return modeReplay(info, url);
    return { mode: 'record', detail: 'url не найден — смотри диагностику' };
  }

  /**
   * Обложка трека отдельной операцией: companion качает её сам (не через
   * браузер) и пишет рядом как «Исполнитель - Трек.cover.webp», а с to=jpg -
   *png/jpeg, пригодным для встраивания. Зачем отдельно: mp4/msfv принимает
   * только jpeg/png, так что webp из yt3 надо сперва конвертировать.
   */
  async function downloadCover(info, asJpg) {
    if (!info || !info.thumbnail) throw new Error('нет ссылки на обложку у текущего трека');
    if (!companionAvailable) throw new Error('companion не отвечает - обложку качает он, не браузер');
    const q = new URLSearchParams({ url: info.thumbnail, name: `${info.artist} - ${info.title}`.slice(0, 100) });
    if (cfg.token) q.set('token', cfg.token);
    if (asJpg) q.set('to', 'jpg');
    const o = dirOverride();
    if (o) q.set('out', o);
    const r = await gmx({ method: 'GET', url: `${base()}/cover?${q.toString()}`, headers: tokenHdr() });
    const j = JSON.parse(r.responseText || '{}');
    if (r.status !== 200 || j.error) throw new Error(j.error || `cover HTTP ${r.status}`);
    return j;
  }

  let companionAvailable = false;
  function startRecording(vid) { state.recording = true; if (els) els.btn.dataset.on = '1'; log('record on', vid); }
  function stopRecording() { state.recording = false; if (els) els.btn.dataset.on = '0'; uiRefresh(); }

  /* ═════════════════ 6. UI ═════════════════ */

  let els = null;
  let uiBroken = false;   // ensureUi бросил — панель пересобираем по требованию
  const STYLE = `
    #ytmdl-root{display:flex;align-items:center}
    #ytmdl-root[data-float="1"]{position:fixed;right:18px;bottom:86px;z-index:99998;background:#000b;
      border:1px solid #ffffff2e;border-radius:50%;width:44px;height:44px;box-shadow:0 6px 20px #0006}
    #ytmdl-btn{background:transparent;border:0;color:#fff;opacity:.85;cursor:pointer;padding:8px;border-radius:50%;display:grid;place-items:center}
    #ytmdl-btn:hover{background:rgba(255,255,255,.12);opacity:1}
    #ytmdl-btn[data-on="1"]{color:#ff5f5f;animation:ytmdlPulse 1.1s infinite}
    @keyframes ytmdlPulse{50%{opacity:.3}}
    #ytmdl-panel{position:fixed;right:16px;bottom:100px;z-index:99999;background:#1b1b1b;color:#fff;
      border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:14px;width:432px;font:13px/1.5 system-ui,"Segoe UI",sans-serif;
      box-shadow:0 18px 50px rgba(0,0,0,.55);max-height:72vh;overflow:auto}
    #ytmdl-panel h3{margin:0 0 10px;font-size:14px;display:flex;justify-content:space-between;align-items:center}
    #ytmdl-panel .row{display:flex;gap:8px;align-items:center;margin:7px 0;flex-wrap:wrap}
    #ytmdl-panel label{font-size:12px;opacity:.85;display:inline-flex;gap:4px;align-items:center}
    #ytmdl-panel input,#ytmdl-panel select{background:#111;color:#fff;border:1px solid #3a3a3a;border-radius:6px;padding:5px 7px;min-width:0;font:inherit}
    #ytmdl-panel button{background:#3ea6ff;color:#04263f;border:0;border-radius:6px;padding:7px 11px;font-weight:700;cursor:pointer;font:inherit}
    #ytmdl-panel button.ghost{background:#2c2c2c;color:#e8e8e8;font-weight:500}
    #ytmdl-panel pre{background:#0d0d0d;padding:8px;border-radius:6px;max-height:190px;overflow:auto;font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;margin:8px 0 0}
    #ytmdl-status{font-size:12px;opacity:.9;margin-top:8px;min-height:16px}
    #ytmdl-bar{height:4px;background:#333;border-radius:2px;overflow:hidden;margin-top:6px;display:none}
    #ytmdl-bar>i{display:block;height:100%;width:0;background:#3ea6ff;transition:width .25s}
    #ytmdl-formats{font:11px/1.5 ui-monospace,monospace;color:#9fd0ff;white-space:pre-wrap;margin-top:6px}
    #ytmdl-toast{position:fixed;left:50%;bottom:100px;transform:translateX(-50%);z-index:100000;background:#000d;color:#fff;
      padding:8px 14px;border-radius:8px;font:13px system-ui,sans-serif;opacity:0;transition:.2s;pointer-events:none;max-width:60vw}
    #ytmdl-toast.on{opacity:1}
    #ytmdl-toast.err{background:#5b1414e6}
  `;

  /* «Ничего не происходит» без консоли — худший из возможных UX. Поэтому любая
     * фатальная ошибка скрипта показывается прямо на странице. */
  function showFatal(where, e) {
    // НЕ один большой try/catch:createElement тоже может быть тем, что сломано, и тогда
    // «показываем ошибку» молча отменялось бы ровно в самый нужный момент.
    log('FATAL ' + where, e);
    try {
      let b = null;
      try { b = document.createElement('div'); }
      catch (e0) {
        try { b = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); } catch (e1) { }
      }
      if (!b) { try { alert('YTM Downloader: ' + where + ' — ' + ((e && (e.message || e)) + '').slice(0, 300)); } catch (e2) { } return; }
      b.id = 'ytmdl-fatal';
      b.textContent = 'YTM Downloader: ' + where + ' — ' + ((e && (e.message || e)) + '').slice(0, 200)
        + '  (F12 → консоль, тег ' + LOG.trim() + ')';
      b.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:999999;'
        + 'background:#5b1414f0;color:#fff;padding:10px 14px;border-radius:8px;font:13px system-ui,sans-serif;'
        + 'max-width:70vw;box-shadow:0 8px 30px #0009');
      try { (document.body || document.documentElement).appendChild(b); } catch (e1) { }
      setTimeout(() => { try { b.remove(); } catch (er) {} }, 25000);
    } catch (e2) { /* падать дальше некуда */ }
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const looksOurs = (s) => /ytm-dl|ytm-downloader|ytmdl/i.test(String(s || ''));
    // Ошибки самой страницы (YTM гремит ими постоянно) показывать плашкой нельзя —
    // это и есть «сыпет предупреждениями». Только наши — и всегда в консоль.
    window.addEventListener('error', (ev) => {
      const src = (ev && (ev.filename || '')) + ' ' + ((ev && ev.error && ev.error.stack) || '');
      if (looksOurs(src)) showFatal('window.onerror', ev.error || ev.message);
      else log('page error (не наш)', src ? src.slice(0, 120) : ev && ev.message);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      const s = (r && (r.stack || r.message)) || r;
      if (looksOurs(s) || (state.lastVideoId && !companionAvailable)) showFatal('unhandledrejection', r);
      else log('page rejection (не наш)', String(s).slice(0, 120));
    });
  }

  function ensureUi() {
    if (els && document.body.contains(els.root)) return els;
    const st = document.createElement('style'); st.id = 'ytmdl-css'; st.textContent = STYLE;
    (document.head || document.documentElement).appendChild(st);

    // НИКАКОГО innerHTML: на Firefox+Tampermonkey скрипт живёт в песочнице с CSP,
    // и присваивание innerHTML падает как «Element.innerHTML setter: Sink type
    // mismatch violation blocked by CSP» — вместе с ним умирал весь UI, хоткеи и
    // меню. Поэтому каркас собирается только через createElement/createElementNS.
    const h = (spec, kids) => {
      const parts = String(spec).split(/(?=[.#])/);
      const e = document.createElement(parts[0] || 'div');
      for (const part of parts.slice(1)) {
        const v = part.slice(1);
        if (!v) continue;
        if (part[0] === '#') e.id = v;
        else if (e.classList) e.classList.add(v);
        else e.className = v;
      }
      for (const k of [].concat(kids == null ? [] : kids)) {
        if (k == null || k === false || k === '') continue;
        if (typeof k === 'object') e.appendChild(k);
        else e.appendChild(document.createTextNode(String(k)));
      }
      return e;
    };
    const svgEl = (tag, attrs) => {
      const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    const mkOpt = (v, cur) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v; if (v === cur) o.selected = true; return o;
    };
    const mkSel = (id, vals, cur) => {
      const s = document.createElement('select'); s.id = id;
      for (const v of vals) s.appendChild(mkOpt(v, cur));
      return s;
    };
    const mkInp = (id, type, val, ph, style) => {
      const e = document.createElement('input');
      if (id) e.id = id;
      if (type) e.type = type;
      if (val != null) e.value = String(val);
      if (ph) e.setAttribute('placeholder', ph);
      if (style) e.setAttribute('style', style);
      return e;
    };
    const mkBtn = (id, text, cls) => {
      const b = document.createElement('button');
      if (id) b.id = id;
      if (cls) b.className = cls;
      b.textContent = text;
      return b;
    };
    const mkRow = (kids) => h('div.row', kids);
    const mkLbl = (text, ctrl) => h('label', [text, ctrl]);
    const mkChk = (id, on, text) => { const i = mkInp(id, "checkbox"); i.checked = !!on; return h("label", [i, " " + text]); };
    const icon = svgEl('svg', { width: '22', height: '22', viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    for (const d of ['M12 3v11', 'M7 10l5 5 5-5', 'M4 20h16']) icon.appendChild(svgEl('path', { d }));
    const btnEl = mkBtn('ytmdl-btn', '', '');
    btnEl.appendChild(icon);
    btnEl.setAttribute('title', 'Скачать (Shift+D). Правый клик — панель.');
    btnEl.setAttribute('aria-label', 'ytm download');
    const root = h('div#ytmdl-root', [btnEl]);

    const panel = document.createElement('div');
    panel.id = 'ytmdl-panel'; panel.hidden = true;
    panel.appendChild(h('h3', [h('span', ['YTM Downloader ', h('small', ['v' + VER])]),
      h('small#ytmdl-chips', [' ']),
      (() => { const b = mkBtn('ytmdl-close', '✕', 'ghost'); b.setAttribute('style', 'padding:2px 8px'); return b; })()]));
    renderChips();
    panel.appendChild(mkRow([
      mkBtn('ytmdl-one', 'скачать текущий', ''),
      (() => { const b = mkBtn('ytmdl-all', 'очередь со страницы', 'ghost');
               b.title = 'поставить в очередь ВСЕ треки открытого альбома/плейлиста/liked (скрипт сам докрутит список); при лимите встанет после 3 ошибок подряд, повтор докачает остатки - архив не даст качать дважды'; return b; })(),
      mkBtn('ytmdl-list', 'скачать весь плейлист', 'ghost'),   // liked - он и есть плейлист
      mkBtn('ytmdl-diag', 'диагностика', 'ghost'),
      mkBtn('ytmdl-rec', 'record: старт/стоп', 'ghost'),
    ]));
    // 0.5.6: ничего не удалено - настройки свёрнуты в секции (<details>);
    // открытость помнится в cfg.ui, как и сами настройки.
    const uiOpen = (() => { try { return JSON.parse(cfg.ui || '{}'); } catch (e) { return {}; } })();
    const sect = (key, title, defOpen, rows) => {
      const d = h('details'); d.id = 'ytmdl-sec-' + key; d.style.cssText = 'margin:2px 0 6px';
      const t = h('summary'); t.textContent = title;
      t.style.cssText = 'cursor:pointer;color:#8aa;font-size:11px;user-select:none';
      d.appendChild(t);
      for (const r of rows) d.appendChild(r);
      d.open = uiOpen[key] === undefined ? defOpen : !!uiOpen[key];
      d.addEventListener('toggle', () => { uiOpen[key] = d.open; cfg.ui = JSON.stringify(uiOpen); saveCfg(); });
      return d;
    };
    panel.appendChild(sect('dl', 'загрузка', true, [
      mkRow([
        mkLbl('режим', mkSel('ytmdl-mode', ['auto', 'ytdlp', 'resolve', 'replay', 'direct', 'record'], cfg.mode)),
        mkLbl('формат', mkSel('ytmdl-fmt', ['m4a', 'mp3', 'opus', 'copy'], cfg.format)),
        (() => { const l = mkLbl('битрейт', mkSel('ytmdl-br', ['128k', '192k', '256k', '320k'], cfg.bitrate));
                 l.title = 'работает только для mp3 (LAME). В m4a кладётся AAC из стрима YouTube: у без-premium он максимум ~128k, "320k m4a" было бы просто удвоением файла без улучшения звука';
                 return l; })(),
        // force-контейнер: «плеер телефона не ест m4a/opus» - перестраховка на выходе
        mkLbl('convert', mkSel('ytmdl-conv', ['off', 'm4a', 'mp3', 'opus'], cfg.convert)),
      ]),
      mkRow([
        mkChk('ytmdl-alt', cfg.altHost, 'youtube.com как запас (при лимите Music)'),
        mkChk('ytmdl-safari', cfg.safariFirst, 'web_safari сразу (без прогрева default/tv)'),
        (() => { const l = mkLbl('очередь через', mkSel('ytmdl-qvia', ['companion', 'browser'], cfg.queueVia));
                 l.title = 'companion = yt-dlp по очереди (теги, архив, можно без вкладки; при жёстком блоке падает); browser = вкладка сама просит /player на каждый трек (обходит блок yt-dlp, но вкладку не закрывать). Ошибка 3 раза подряд - очередь встаёт, повтор докачает остатки';
                 return l; })(),   // 0.5.13: объясняем, где что качает
        mkLbl('лист: первые N / диапазон', mkInp('ytmdl-items', '', cfg.playlistItems || '', 'пусто = весь лист', 'width:110px')),
      ]),
    ]));
    panel.appendChild(sect('net', 'сеть: companion, proxy, token', false, [
      mkRow([
        mkLbl('companion', mkInp('ytmdl-port', '', cfg.port, '', 'width:60px')),
        mkLbl('token', mkInp('ytmdl-token', '', cfg.token || '', '— если задан', 'width:110px')),
        // '' = как в ini (и унаследованный системный), none = прямо, иначе URL
        mkLbl('proxy', mkInp('ytmdl-proxy', '', cfg.proxy || '', 'auto · none · http://127.0.0.1:10808', 'width:150px')),
        mkBtn('ytmdl-ping', 'проверить', 'ghost'),
      ]),
    ]));
    panel.appendChild(sect('files', 'файлы: папки, архив «уже скачано»', false, [
      mkRow([
        mkChk('ytmdl-album', cfg.organize === 'album', 'папки по альбомам'),
        mkChk('ytmdl-dedup', cfg.dedup, 'не качать уже скачанное'),
        mkLbl('папка', mkInp('ytmdl-out', '', cfg.out || '', "пусто = --out companion'а", 'width:100%')),
      ]),
      mkRow([
        mkBtn('ytmdl-archive', 'архив: показать', 'ghost'),
        mkBtn('ytmdl-archive-reset', 'сбросить', 'ghost'),
      ]),
    ]));
    panel.appendChild(sect('dbg', 'отладка и страховки', false, [
      mkRow([
        mkChk('ytmdl-auto', cfg.autoRecord, 'авто-record при SABR'),
        mkChk('ytmdl-verb', cfg.verbose, 'debug-лог'),
      ]),
    ]));
    panel.appendChild(h('div#ytmdl-formats'));
    panel.appendChild(h('div#ytmdl-bar', [h('i')]));
    panel.appendChild(h('div#ytmdl-status', ['нажми play в плеере — скрипт подхватит ответ']));
    const logEl = h('pre#ytmdl-log', []);
    logEl.hidden = true;              // сразу, без querySelector: панель может быть собрана
    panel.appendChild(logEl);         // и в окружении, где поиск по id недоступен
    const toast = document.createElement('div'); toast.id = 'ytmdl-toast';
    document.body.appendChild(root); document.body.appendChild(panel); document.body.appendChild(toast);
    // None-safe: если каркас не собрался (CSP, чужой шаблонизатор,
    // тестовый DOM) — теряем отдельный контрол, но НЕ весь boot.
    els = { root, panel, toast, btn: root.querySelector('#ytmdl-btn') || root };
    const on = (elm, ev, fn) => { if (elm) elm.addEventListener(ev, fn); };
    on(els.btn, 'click', () => act());
    on(els.btn, 'contextmenu', (e) => { e.preventDefault(); togglePanel(true); });
    const $ = (sel) => panel.querySelector(sel);
    on($('#ytmdl-close'), 'click', () => togglePanel(false));
    const bind = (sel, key, cast) => on($(sel), 'change', (e) => {
      const t = e.target;
      cfg[key] = cast === 'int' ? Number(t.value) || DEF[key] : (t.type === 'checkbox' ? t.checked : t.value);
      if (sel === '#ytmdl-album') cfg.organize = t.checked ? 'album' : 'none';
      saveCfg(); renderChips();
    });
    bind('#ytmdl-mode', 'mode'); bind('#ytmdl-fmt', 'format'); bind('#ytmdl-br', 'bitrate');
    bind('#ytmdl-conv', 'convert'); bind('#ytmdl-proxy', 'proxy');
    bind('#ytmdl-port', 'port', 'int'); bind('#ytmdl-token', 'token');
    bind('#ytmdl-auto', 'autoRecord'); bind('#ytmdl-verb', 'verbose'); bind('#ytmdl-album', 'organize');
    bind('#ytmdl-dedup', 'dedup'); bind('#ytmdl-out', 'out'); bind('#ytmdl-items', 'playlistItems');
    bind('#ytmdl-alt', 'altHost');
    bind('#ytmdl-safari', 'safariFirst');
    bind('#ytmdl-qvia', 'queueVia');
    on($('#ytmdl-ping'), 'click', pingCompanion);
    on($('#ytmdl-one'), 'click', () => act());
    on($('#ytmdl-all'), 'click', () => queueFromPage().catch((e) => setStatus(`✕ ${e.message}`, 'err')));
    on($('#ytmdl-list'), 'click', () => downloadWholeList().catch((e) => setStatus(`✕ ${e.message}`, 'err')));
    on($('#ytmdl-archive'), 'click', async () => {
      try {
        const j = JSON.parse((await gmx({ method: 'GET', url: `${base()}/archive`, headers: tokenHdr() })).responseText);
        setStatus(`архив ${j.count} шт · ${(j.ids || []).slice(-8).join(', ')}${j.count > 8 ? ' …' : ''} · ${j.file}`, 'ok');
        log('archive', (j.ids || []).join('\n') || '(пусто)');
      } catch (e) { setStatus('архив недоступен: ' + e.message, 'err'); }
    });
    on($('#ytmdl-archive-reset'), 'click', () => resetArchive().catch((e) => setStatus(`✕ ${e.message}`, 'err')));
    on($('#ytmdl-diag'), 'click', showDiag);
    on($('#ytmdl-rec'), 'click', () => { if (state.recording && state.recStop) state.recStop(); else runTrack({ mode: 'record' }).catch((e) => setStatus(e.message, 'err')); });
    mount();
    uiRefresh();
    return els;
  }

  const act = () => runTrack().catch((e) => { setStatus(`✕ ${e.message}`, 'err'); console.warn(LOG, e); });

  async function pingCompanion() {
    try {
      const h = await hello();
      companionAvailable = true;
      if (h.build && h.build !== VER)
        mirrorLog(`версии разошлись: панель v${VER}, companion build ${h.build} — обнови обе половины`, 'warn');
      const ck = h.cookies_file ? 'файл' : (h.cookies_from_browser || 'нет');
      const pc = h.player_client ? h.player_client : 'auto';
      const busy = (h.children || 0) + (h.active_jobs || 0);
      setStatus(`companion ok (сборка ${h.build || '?'}) · ffmpeg=${h.ffmpeg ? 'да' : 'НЕТ'} · yt-dlp=${h.yt_dlp || 'нет'} · out=${h.out}`
        + ` · уже скачано: ${h.archived || 0}`
        // «нет» рядом с cookies = плейлисты и «Понравившееся» упадут в bot-check:
        // показываем это здесь, а не только в логе упавшей задачи
        + ` · cookies=${ck} · player=${pc}`
        + ` · proxy=${h.proxy_direct ? 'none (прямо)' : (h.proxy_effective || 'нет')} · convert=${h.convert || 'off'}`
        + ` · python=${h.python ? h.python.replace(/^.*[\/]/, '') : '?'}`
        + ` · runtime=${h.js_runtime ? h.js_runtime.replace(/^.*[\/]/, '') : 'НЕТ (deno/node) — bot-check возможен'}`
        // «занято» = над папкой сейчас висит процесс или незакрытая задача: music\ не удалится,
        // пока не сделаешь ytm.bat stop. «свободен» = можно останавливать и удалять.
        + ` · ${busy ? 'занято: ' + (h.children || 0) + ' процесс(а), ' + (h.active_jobs || 0) + ' задач(а)' : 'свободен (можно останавливать и удалять)'}`, 'ok');
    } catch (e) {
      companionAvailable = false;
      const m = String((e && e.message) || e);
      const gm = /GM_xmlhttpRequest/i.test(m);
      setStatus(gm ? `✕ ${m}`
        : `✕ companion не отвечает (${base()}) — ${m}. Запусти start.bat; лог: ytm-dl-log.txt. `
          + 'Проверка без скрипта: открой новую вкладку на ' + base() + '/hello — должен быть JSON', 'err');
    }
  }

  /**
   * videoId'шники из ссылок страницы. Отдельно от DOM — чтобы это можно было проверить
   * без браузера (см. tests/test_userscript.mjs).
   */
  function idsFromHrefs(href) {
    const out = [];
    for (const h of [].concat(href || [])) {
      if (typeof h !== 'string') continue;
      const m = /(?:[?&]v=|\/v\/|\/e\/|\/shorts\/)([A-Za-z0-9_-]{6,64})/.exec(h);
      if (m) out.push(m[1]);
    }
    return [...new Set(out)];
  }

  /**
   * Ссылка плейлиста, открытого на странице: «/playlist?list=...» или «/watch?...&list=...».
   * «Понравившиеся» — это отдельный лист с id на базе RDCLAK (YT Music) либо LM/YY.
   */
  function playlistHrefFromHrefs(href, opt) {
    const o = opt || {};
    for (const h of [].concat(href || [])) {
      if (typeof h !== 'string') continue;
      const m = /[?&]list=([A-Za-z0-9_-]{5,})/.exec(h);
      if (!m) continue;
      const id = m[1];
      // liked-листы существуют только в YTM; для всего остального домен берём из
      // открытой страницы: альбом/queue, видимые в music.youtube.com, должен разбирать
      // тот же экстрактор, что и одиночные треки (иначе yt-dlp вернёт видео вместо аудио).
      const music = o.musicPage !== undefined ? !!o.musicPage
        : /music\.youtube\.com/.test(String(o.loc != null ? o.loc : (typeof location !== 'undefined' && location && (location.host || location.href)) || ''));
      return `https://${/^(RDCLAK|LM|YY)/.test(id) || music ? 'music' : 'www'}.youtube.com/playlist?list=${id}`;
    }
    return null;
  }

  /** Ссылка «Понравившиеся»: есть ли она на странице (кнопка лайка/раздел библиотеки). */
  function likedHrefFromHrefs(href) {
    return [].concat(href || []).some((h) => typeof h === 'string' &&
      /[?&]list=(RDCLAK[0-9A-Za-z_-]+|LM|YY)\b/.test(h)) ? 'liked' : null;
  }

  function pageTrackIds() {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/watch?v="]')) {
      const id = (/(?:[?&]v=|\/v\/)([A-Za-z0-9_-]{6,64})/.exec(a.href) || [])[1];
      if (id) seen.add(id);
    }
    return [...seen];
  }


  /**
   * 0.6.3: диагностика «треклист не найден». Боевой лог владельца показал случай,
   * когда очередь видна ГЛАЗАМИ (плеер развёрнут, панель очереди висит справа, ссылка
   * в адресной строке сменилась из-за разворачивания трека), а сбор id возвращает ноль
   * и в логе остаётся одна строка «на странице нет треклиста». Чинить по такой строке
   * нечего: не видно, что именно насчитал скрипт. Пробник печатает URL и счётчики
   * кандидатов, чтобы следующий прогон дал данные вместо догадок. Ничего не кликает и
   * не скроллит — только querySelectorAll, поэтому на рабочие пути влиять не может.
   * pageTrackIds() сегодня знает один источник id: ссылки a[href*="/watch?v="]. Если
   * строки очереди в YTM отрисованы не ссылками (ytmusic-player-queue-item), счётчик
   * queue-item будет больше нуля при a[/watch?v=]=0 — это и есть ответ, какой источник
   * добавить. Угадывать селектор вслепую и ломать работающий сбор альбома смысла нет.
   */
  function pageProbe() {
    const n = (sel) => { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
    let sc = null; try { sc = pageScroller(); } catch (e) { sc = null; }
    let own = -1; try { own = pageTrackIds().length; } catch (e) { own = -1; }
    return 'пробник страницы: url=' + String(location.href).slice(0, 110) +
      ' | a[/watch?v=]=' + n('a[href*="/watch?v="]') +
      ' | queue-item=' + n('ytmusic-player-queue-item') +
      ' | list-item=' + n('ytmusic-responsive-list-item-renderer') +
      ' | #items=' + n('#items') +
      ' | shelf=' + n('ytmusic-playlist-shelf-renderer') +
      ' | scroller=' + (sc ? (sc.id || sc.tagName || '?') : 'нет') +
      ' | pageTrackIds=' + own;
  }

  /**
   * YTM рендерит треклист виртуально: в DOM лежат только ~20 строк вокруг скролла.
   * Поэтому «скачать весь плейлист» = прокрутить список и собрать id по дороге;
   * останавливаемся, когда N прогонов подряд ничего нового не дали.
   */
  function collectAllIds(scroller, opt) {
    const o = opt || {};
    const step = o.step != null ? o.step : 900;
    const rounds = o.rounds != null ? o.rounds : 400;
    const stableFor = o.stableFor != null ? o.stableFor : 3;
    const wait = o.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const readIds = o.readIds || pageTrackIds;
    const seen = new Set();
    let stable = 0, lastCount = -1;
    const el = typeof scroller === 'function' ? scroller() : scroller;
    if (!el) return Promise.resolve(readIds());
    const collect = () => { for (const id of readIds()) seen.add(id); };
    el.scrollTop = 0;
    let i = 0;
    const pass = () => {
      collect();
      const short = el.scrollHeight <= el.clientHeight + 8;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4 || short;
      if (seen.size === lastCount) stable++; else { stable = 0; lastCount = seen.size; }
      // «дошли до низа и N прогонов ничего нового» — единственный честный признак
      // конца виртуального списка: scrollHeight у YTM врёт, а недоскролленный хвост
      // означал бы тихо потерянные треки.
      if (atBottom && stable >= stableFor) return false;
      if (i++ >= rounds) return false;
      el.scrollTop = el.scrollTop + step;
      return wait(short ? 40 : (o.pauseMs != null ? o.pauseMs : 130)).then(pass);
    };
    return wait(o.pauseMs != null ? o.pauseMs : 130).then(pass).then(() => [...seen]);
  }

  /**
   * «Скачать плейлист / понравившиеся» — как в десктопном приложении, но списком задач:
   * один id = один job. Плюс: прогресс по каждому треку, переживание SABR-режима `tv`,
   * возможность пропустить уже скачанное. Список собираем скроллом, потому что YTM
   * рендерит треклист виртуально (в DOM живёт ~20 строк).
   * @param {{scroll?:boolean}} [opt]
   */
  /** Общий сборщик «где скроллится список»: страницы альбома, плейлиста, liked. */
  function pageScroller() {
    for (const sel of ['#items', 'ytmusic-responsive-list-renderer', 'ytmusic-playlist-shelf-renderer',
                       'ytmusic-nav-auto-play-renderer']) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 40) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  /** 0.5.11: треклист листа тем же внутренним /browse, которым его получает
   * премиум-приложение, но ЗАПРОСОМ ВКЛАДКИ (лимиты на серверные лесенки yt-dlp
   * к этому запросу не относятся). Из ответа вытаскиваем videoId+title строк в
   * исходном порядке. Это не «парсер странички»: данные ровно те, что рисует сам клиент. */
  function collectBrowseItems(j, cap) {
    const out = []; const seen = new Set(); const LIMIT = cap || 1000;
    const titleOf = (o) => {
      const t = o && o.title; if (!t) return '';
      if (typeof t === 'string') return t;
      if (t.simpleText) return t.simpleText;
      if (t.runs) return t.runs.map((r) => r.text || '').join('');
      return '';
    };
    const walk = (o) => {
      if (!o || typeof o !== 'object' || out.length >= LIMIT) return;
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      const runsTxt = (t) => (((t || {}).runs) || []).map((r) => r.text || '').join('').trim();
      const ppr = o.playlistPanelVideoRenderer;
      if (ppr && ppr.videoId && !seen.has(ppr.videoId)) {
        seen.add(ppr.videoId);
        const by = runsTxt(ppr.longBylineText) || runsTxt(ppr.shortBylineText) ||
                   (ppr.videoInfo && ppr.videoInfo.simpleText) || '';
        const p = by.split(/\s+[·•]\s+/);
        out.push({ videoId: ppr.videoId, title: titleOf(ppr), artist: p[0] || '',
                   album: p.length > 1 ? p[p.length - 1] : '' });
        return;
      }
      const mri = o.musicResponsiveListItemRenderer;
      if (mri) {
        let vid = (mri.playlistItemData || {}).videoId || '';
        if (!vid) vid = ((mri.navigationEndpoint || {}).watchEndpoint || {}).videoId || '';
        if (!vid) {
          const pe = ((((mri.overlay || {}).musicItemThumbnailOverlayRenderer || {}).content || {})
            .musicPlayButtonRenderer || {}).playNavigationEndpoint || {};
          vid = ((pe || {}).watchEndpoint || {}).videoId || '';
        }
        if (vid && !seen.has(vid)) {
          seen.add(vid);
          const fc = ((((mri.flexColumns || [])[0] || {}).musicResponsiveListItemFlexColumnRenderer || {})
            .text || {}).runs || [];
          const fc2 = ((((mri.flexColumns || [])[1] || {}).musicResponsiveListItemFlexColumnRenderer || {})
            .text || {}).runs || [];
          const sub = fc2.map((x) => x.text || '').join('').trim();
          const p = sub.split(/\s+[·•]\s+/);
          out.push({ videoId: vid, title: (fc[0] && fc[0].text) || '',
                     artist: p[0] || '', album: p.length > 1 ? p[p.length - 1] : '' });
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(j);
    return out;
  }

  async function browseViaPage(listId) {
    // 0.5.12: ytcfg - НАСТОЯЩЕЕ окно страницы: под @grant'ами Tampermonkey
    // global.ytcfg не виден (песочница), и browse падал с «страница ещё не
    // подготовила ytcfg» на полностью готовой вкладке. fetch - тоже оконный:
    // same-origin, cookie в комплекте, CORS не мешает.
    const w = hookTarget(global);
    let ctx = {};
    // YTM is an SPA: the list can be visible before its Innertube config exists.
    // Give the page a short grace period instead of immediately falling back to a
    // slower/less faithful companion playlist request.
    for (let n = 0; n < 5 && !ctx.INNERTUBE_API_KEY; n++) {
      ctx = w.ytcfg || global.ytcfg || {};
      if (ctx.INNERTUBE_API_KEY) break;
      await new Promise((resolve) => setTimeout(resolve, 350 * (n + 1)));
    }
    if (!ctx.INNERTUBE_API_KEY) throw new Error('страница ещё не подготовила ytcfg');
    const f = (w.fetch ? w.fetch.bind(w) : global.fetch);
    const r = await f(`${location.origin}/youtubei/${ctx.INNERTUBE_API_VERSION || 'v1'}/browse?key=${ctx.INNERTUBE_API_KEY}&prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ctx.INNERTUBE_CONTEXT, browseId: 'VL' + listId }),
    });
    if (!r.ok) throw new Error('browse от страницы: HTTP ' + r.status);
    return collectBrowseItems(await r.json(), 800);
  }

  async function queueFromPage(opt) {
    const o = opt || {};
    if (state.queueCtl) {
      state.queueCtl.stop = true;
      setStatus('остановлю очередь после текущего трека…', 'warn');
      return;
    }
    if (!companionAvailable) { setStatus('нужен companion: он ведёт архив «уже скачано»', 'err'); return; }
    // Browser mode must remain browser mode even when ids came from the page-browse
    // fallback. The old !o.ids guard silently routed that case back to POST /job.
    if (cfg.queueVia === 'browser') return playThrough(o);
    setStatus(o.ids && o.ids.length ? 'лист со страницы - ставлю в очередь…' : 'собираю треклист страницы…', 'run');
    const ids = (o.ids && o.ids.length) ? o.ids
      : ((o.scroll === false) ? pageTrackIds() : await collectAllIds(pageScroller()));
    if (!ids.length) { mirrorLog(pageProbe(), 'info'); setStatus('на странице нет треклиста — открой плейлист/альбом/понравившиеся', 'err'); return; }
    const { fresh, have } = await filterAlreadyHave(ids);
    if (!fresh.length) { setStatus(`всё уже скачано (${have.length} треков) — архив пуст не был`, 'ok'); return; }
    setStatus(`очередь: ${fresh.length} новых из ${ids.length} (пропущено по архиву: ${have.length})`, 'run');
    const ctl = state.queueCtl = { stop: false };
    let ok = 0, fail = 0, deadRun = 0;
    for (let i = 0; i < fresh.length; i++) {
      if (ctl.stop) break;
      const id = fresh[i];
      try {
        const t = (o.titles || []).find((x) => x.videoId === id) || {};
        const jb = await postJob(jobPayload({
          kind: 'url', url: `https://music.youtube.com/watch?v=${id}`,
          videoId: id, format_spec: formatSpec(), format: cfg.format,
          meta: { videoId: id, title: t.title || undefined,   // 0.5.12: и artist/album едут
            artist: t.artist || undefined, album: t.album || undefined },
        }));
        // 0.5.13: очередь companion-а ЖИВАЯ: видно каждый трек и его итог. Молчаливый
        // fire-and-forget пользователь читал как «очередь ничего не качает».
        setStatus(`очередь ${i + 1}/${fresh.length}: ${t.title || id}…`, 'run');
        await pollJob(jb);
        ok++; deadRun = 0;
      } catch (e) {
        fail++; deadRun++;
        log('queue', id, e);
        if (deadRun >= 3) {
          mirrorLog(`очередь остановлена: 3 ошибки подряд - лимит аккаунта; `
            + 'повтори позже, скачанное архив пропустит', 'err');
          setStatus(`очередь: ${ok} готово, стоп на ${i + 1}/${fresh.length} (3 ошибки подряд)`, 'err');
          break;
        }
      }
      await new Promise((res) => setTimeout(res, Math.max(150, cfg.queueDelayMs)));
    }
    // Persistent retry state is separate from the archive: report both so a
    // successful first batch is not confused with the tracks waiting for YouTube.
    try {
      const tq = await throttleQueueStatus();
      const waiting = Number(tq.waiting || 0), inflight = Number(tq.in_flight || 0);
      const suffix = (have.length ? ` · уже было ${have.length}` : '')
        + (waiting ? ` · ждут retry: ${waiting}` : '')
        + (inflight ? ` · в работе: ${inflight}` : '');
      state.queueCtl = null;
      setStatus(ctl.stop
        ? `очередь остановлена: ${ok} готово · можно запустить снова${suffix}`
        : (deadRun >= 3
          ? `очередь: ${ok} готово, стоп на лимите - повтори позже (скачанное архив пропустит)${suffix}`
          : `очередь: ${ok} готово${fail ? `, ${fail} ошибок` : ''}${suffix}`),
        ctl.stop ? 'warn' : (deadRun >= 3 ? 'err' : (fail ? 'warn' : 'ok')));
      return;
    } catch (_) { /* old companion: retain the ordinary local summary */ }
    state.queueCtl = null;
    setStatus(ctl.stop
      ? `очередь остановлена: ${ok} готово · можно запустить снова`
      : (deadRun >= 3
        ? `очередь: ${ok} готово, стоп на лимите - повтори позже (скачанное архив пропустит)`
        : `очередь: ${ok} готово${fail ? `, ${fail} ошибок` : ''}${have.length ? ` · уже было ${have.length}` : ''}`),
      ctl.stop ? 'warn' : (deadRun >= 3 ? 'err' : (fail ? 'warn' : 'ok')));   // итог без «отправлено и забыто»
  }

  /** 0.5.9: «прогон треков через плеер» - полный алгоритм, как в оригинальном
   * приложении: для каждой позиции страница САМА запрашивает /player (свой
   * клиент, свой po-token, свои cookies - максимальное доверие), получает url'ы
   * стримов и скачивает их из вкладки; компаньон делает remux/теги/архив как
   * обычно. Когда Music-полосу лимитируют и yt-dlp блокируют - собственному
   * плееру YouTube обычно не мешает. Второй клик кнопки = остановка после
   * текущего трека. Уже скачанные позиции отсекает архив (/has). */
  async function playThrough(opt) {
    if (state.playThru) { state.playThru.stop = true; setStatus('остановлю после текущего трека…', 'warn'); return; }
    if (!companionAvailable) { setStatus('нужен companion: теги, архив, верификация', 'err'); return; }
    setStatus('собираю треклист страницы для прогона…', 'run');
    const oo = opt || {};
    const ids = (oo.ids && oo.ids.length) ? oo.ids
      : ((oo.scroll === false) ? pageTrackIds() : await collectAllIds(pageScroller()));
    if (!ids.length) {
      const cur = currentVideoId();
      // 0.6.3: пробник ДО отката на один трек — именно здесь владелец получил
      // «это не список - гоняю текущий трек» и один трек из альбома вместо десяти
      mirrorLog(pageProbe(), 'info');
      if (cur) { setStatus('это не список - гоняю текущий трек', 'warn'); return runTrack(); }
      setStatus('на странице нет треклиста — открой альбом/плейлист и повтори', 'err'); return;
    }
    const { fresh, have } = await filterAlreadyHave(ids);
    if (!fresh.length) { setStatus(`всё уже скачано: ${have.length} треков`, 'ok'); return; }
    const ctl = state.playThru = { stop: false };
    let ok = 0, fail = 0, throttleHits = 0;
    for (let i = 0; i < fresh.length; i++) {
      if (ctl.stop) break;
      const vid = fresh[i];
      setStatus(`прогон ${i + 1}/${fresh.length}: страница запрашивает /player…`, 'run');
      setProgress(i / fresh.length);
      let pr = null;
      // selfAskPlayer(vid, 9): attempt=9 - без внутренних отложенных повторов,
      // командует циклом прогона; capture кладётся в state.byVideo тем же путём,
      // что и живые ответы плеера
      for (let n = 0; n < 3 && !pr; n++) {
        try { await selfAskPlayer(vid, 9); } catch (e) { /* нет ytcfg - подождём capture из сети */ }
        const cap = state.byVideo.get(vid);
        if (cap && cap.pr) pr = cap.pr; else await wait(900 * (n + 1));
      }
      if (!pr) { fail++; log('playThru', vid, 'нет ответа /player'); continue; }
      const vd = pr.videoDetails || {};
      const info = {
        videoId: vid,
        title: vd.title || vid,
        artist: (vd.author || '').replace(/^Music Account:\s*/, '').trim(),
        album: (state.byVideo.get(vid) || {}).album || '',
        duration: Number(vd.lengthSeconds) || 0,
        thumbnail: ((vd.thumbnail && vd.thumbnail.thumbnails || []).slice(-1)[0] || {}).url || '',
        pr,
      };
      const thr = accountThrottled(info);
      if (thr) {
        throttleHits++;
        log('playThru', vid, 'лимит аккаунта: ' + thr);
        if (throttleHits >= 3) {
          setStatus('YouTube лимитирует даже собственную страницу — ставлю прогон на паузу; '
                    + 'через час-два повтори (перезалогин ускоряет)', 'err');
          break;
        }
        continue;
      }
      try {
        const fmts = pickAudioFormats(pr);
        if (canDownloadDirectly(fmts)) {
          await modeDirect(info, fmts);
        } else {
          const sniffed = bestSniffedUrl(vid);
          if (sniffed && !/sabr=1/.test(sniffed) && sniffedFull(vid, info.duration))
            await modeReplay(info, sniffed, pr);
          else
            // Keep the browser player response when handing SABR/no-URL media to
            // companion. Only the final fallback may let yt-dlp use its own session.
            await modeResolve(info, 'resolve');   // сначала передаём player response, а не выбрасываем сессию
        }
        ok++;
      } catch (e) { fail++; log('playThru', vid, (e && e.message) || e); }
      await wait(Math.max(400, cfg.queueDelayMs || 0));
    }
    state.playThru = null;
    setProgress(1);
    setStatus(`прогон: скачано ${ok} · сбой ${fail}`
      + (have.length ? ` · уже было ${have.length}` : '')
      + (ctl.stop ? ' · остановлено досрочно' : ''), fail ? 'warn' : 'ok');
  }

  /**
   * «Весь лист одной задачей»: yt-dlp сам пройдёт плейлист и сам же отфильтрует по
   * download-archive. Это то, что делают ytm-dlp-gui и y2mp3; удобно для «понравившихся»
   * на сотни треков, где гонять 300 job'ов смысла нет.
   */
  async function downloadWholeList() {
    if (!companionAvailable) throw new Error('нужен companion (режим playlist живёт на его стороне)');
    const links = [...document.querySelectorAll('a[href*="list="], a[href*="/playlist?"]')].map((a) => a.href);
    const liked = likedHrefFromHrefs(links);
    const list = playlistHrefFromHrefs(links, { loc: location.href });
    const target = liked || list;
    if (!target) { setStatus('не вижу на странице ссылки на плейлист/liked — открой его и повтори', 'err'); return; }
    setStatus(`лист: ${target === 'liked' ? 'Понравившиеся' : target.slice(-40)} → одна задача`, 'run');
    let job = null;
    try {
    job = await postJob(jobPayload({
      kind: 'playlist', url: target, format_spec: formatSpec(), format: cfg.format,
      organize: cfg.organize,   // player_client НЕ форсим: компаньон сам переберёт клиентов
      items: cfg.playlistItems || undefined,   // пусто = весь лист
      meta: { title: target === 'liked' ? 'Liked Music' : 'playlist' },
    }));
    await pollJob(job, (j) => {
      setProgress(j.progress || 0);
      const pl = (j.meta && (j.meta.files || []).length) || 0;
      const badPl = (j.meta && ((j.meta.failed || 0) + (j.meta.lost || 0))) || 0;
      setStatus(`companion: ${j.message || (j.status === 'done' ? (pl ? `${pl} файл(ов)` : 'пусто: 0 файлов') : j.status)}`
        + ` · ${Math.round((j.progress || 0) * 100)}%`
        + (badPl ? ` · не скачалось ${badPl}` : '')
        + (j.error ? ` · ${String(j.error).slice(0, 120)}` : ''), (j.status === 'error' || badPl) ? 'err' : 'run');
      if (j.meta && j.meta.files && j.meta.files.length) log('files', j.meta.files.map((x) => x.dest).join('\n'));
    });
    return job;
    } catch (e) {
      // 0.5.11: серверный browse не отдался (400/пусто) - читаем лист запросом вкладки
      const lm = /list=([A-Za-z0-9_-]{8,})/.exec(target || '');
      const msg = String((e && e.message) || e || '');
      if (lm && /browse|400|ни один трек|не скачалось|API page/i.test(msg)) {
        setStatus('компаньону лист не отдался - беру треклист из сессии страницы…', 'warn');
        try {
          const items = await browseViaPage(lm[1]);
          if (items.length) {
            mirrorLog(`лист через /browse страницы: ${items.length} позиций - в очередь`, 'info');
            await queueFromPage({ ids: items.map((x) => x.videoId), titles: items });
            return { via: 'page-browse', count: items.length };
          }
        } catch (e2) { log('browseViaPage', e2); }
      }
      throw e;
    }
  }

  /** Сброс архива «уже скачано» (когда файлы удалил руками или хочешь перекачать заново). */
  async function resetArchive() {
    const r = await gmx({ method: 'POST', url: `${base()}/archive/reset`, headers: tokenHdr(), data: '{}' });
    setStatus('архив очищен: ' + (JSON.parse(r.responseText).cleared || 0) + ' записей', 'ok');
  }

  function showDiag() {
    const v = currentVideoId();
    const cap = v && state.byVideo.get(v);
    const formats = cap ? pickAudioFormats(cap.pr) : [];
    const d = cap ? diagnose(cap.pr, formats) : { level: 'warn', text: 'нет перехваченного player response' };
    const r = v && state.streams.get(v);
    const pre = els.panel.querySelector('#ytmdl-log');
    pre.hidden = false;
    pre.textContent = JSON.stringify({
      videoId: v, captured: cap ? new Date(cap.at).toISOString() : null, source: cap && cap.source,
      diagnosis: d, formats,
      sniffed: r ? { requests: r.ranges.length, itags: [...r.itags], bytes: r.bytes, coverage: coverageFromRanges(r.ranges) } : null,
      companion: base(), mode: cfg.mode, online: companionAvailable,
      // «ответа нет» бывает двух сортов: страница молчит или YouTube молчит.
      // page:true = хук на window страницы; when:loading = успели до /player.
      // page:false = @grant не дал unsafeWindow - нужен другой путь (см. README).
      hook: state.hook || { fetch: false, xhr: false, page: false, when: document.readyState },
      // главное при «вижу кнопку / не вижу кнопки»: нашёлся ли контейнер плеера
      ui: { mounted: !!state.mounted, floating: !!state.floating,
            host: !!findPlayerHost(document), videoId: v || null },
      version: VER,
    }, null, 2);
    setStatus(d.text, d.level === 'bad' ? 'err' : 'info');
  }

  function togglePanel(on) {
    if (uiBroken) {
      try { ensureUi(); uiBroken = false; }
      catch (e) { showFatal('togglePanel', e); return; }
    }
    ensureUi();
    els.panel.hidden = on === undefined ? !els.panel.hidden : !on;
    if (!els.panel.hidden) uiRefresh();
  }

  function setStatus(t, kind) {
    // то, что человек видит в панели при ошибке, обязано попасть в ytm-run.log -
     // иначе «скинь лог» превращается в «вспомни, что писала панель»
    if (kind === 'err' || kind === 'warn') {
      // Compatibility marker: if (kind === 'err' || kind === 'warn') mirrorLog
      // Polling can observe the same phase for minutes. Keep the UI live, but do
      // not append the identical user-facing error to ytm-run.log repeatedly.
      const mirrorKey = `${kind}:${String(t)}`;
      const now = Date.now();
      if (setStatus._mirrorKey !== mirrorKey || now - (setStatus._mirrorAt || 0) >= 15000) {
        mirrorLog(String(t), kind);
        setStatus._mirrorKey = mirrorKey;
        setStatus._mirrorAt = now;
      }
    }
    if (!els) return;
    const st = els.panel && els.panel.querySelector('#ytmdl-status');
    if (st) st.textContent = t;
    els.toast.textContent = t;
    els.toast.className = 'on' + (kind === 'err' ? ' err' : '');
    if (kind !== 'run') els.btn.dataset.on = state.recording ? '1' : '0';
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => els.toast.classList.remove('on'), kind === 'err' ? 8000 : 4000);
  }
  const toastOnce = (t, kind) => { try { ensureUi(); setStatus(t, kind); } catch (e) { /* ignore */ } };
  function setProgress(p) {
    if (!els) return;
    const bar = els.panel.querySelector('#ytmdl-bar');
    const val = Number(p) || 0;
    bar.style.display = val > 0.001 && val < 1 ? 'block' : 'none';
    bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, val)) * 100}%`;
  }
  function uiRefresh() {
    if (!els || !els.panel || els.panel.hidden) return;
    const v = currentVideoId();
    const cap = v && state.byVideo.get(v);
    const f = els.panel.querySelector('#ytmdl-formats');
    if (!f) return;
    if (!v) { f.textContent = ''; return; }
    if (!cap) { f.textContent = `${v} · ответа плеера ещё нет`; return; }
    const list = pickAudioFormats(cap.pr);
    f.textContent = list.length
      ? list.map((x) => `itag ${String(x.itag).padEnd(4)} ${x.mime.padEnd(16)} ${String(Math.round(x.bitrate / 1000)).padStart(3)}k  ${x.url ? 'url ✓' : x.sabr ? 'SABR ✕' : '—'}`).join('\n')
      : 'аудио-форматов в ответе нет';
  }

  /* ═════════════════ 7. ИНИЦИАЛИЗАЦИЯ ═════════════════ */

  /**
   * Просим /youtubei/v1/player сами, от имени страницы: это ровно тот запрос,
   * который делает плеер, поэтому он проходит там, где наш перехват молчит.
   * ytcfg на document-idle бывает ещё пуст - не выходим молча, а пробуем
   * позже; иначе «ответ плеера ещё не перехвачен» становилось вечным.
   */
  async function selfAskPlayer(vid, attempt) {
    const n = attempt || 0;
    const ctx = global.ytcfg || {};
    if (!ctx.INNERTUBE_API_KEY) {
      if (n < 4) setTimeout(() => selfAskPlayer(vid, n + 1), 800 * (n + 1));
      return false;
    }
    try {
      const body = { context: ctx.INNERTUBE_CONTEXT, videoId: vid, racyCheckOk: true, contentCheckOk: true, contextfulPermissionsOk: true };
      const r = await global.fetch(`${location.origin}/youtubei/${ctx.INNERTUBE_API_VERSION || 'v1'}/player?key=${ctx.INNERTUBE_API_KEY}&prettyPrint=false`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (capturePlayerResponse(vid, j, 'self')) return true;
      if (n < 4) setTimeout(() => selfAskPlayer(vid, n + 1), 800 * (n + 1));
      return false;
    } catch (e) {
      log('selfAskPlayer', e);
      if (n < 4) setTimeout(() => selfAskPlayer(vid, n + 1), 800 * (n + 1));
      return false;
    }
  }

  const PLAYER_HOSTS = [
    'ytmusic-player-bar .right-controls',
    '.right-controls.ytmusic-player-bar',
    'ytmusic-player-bar .right-section',
    'ytmusic-player-bar #right-controls',
    'ytmusic-player-bar #controls',
    'ytmusic-play-button',
    'ytmusic-player-bar #buttons',
    'ytmusic-player-bar .middle-controls',
    'ytmusic-player-bar',
  ];

  /** ЕДИНСТВЕННЫЙ источник правды «куда вешать кнопку» — и для mount, и для диагностики. */
  function findPlayerHost(doc) {
    for (const sel of PLAYER_HOSTS) {
      let el = null;
      try { el = doc.querySelector(sel); } catch (e) { continue; }   // кривой селектор не должен ронять UI
      if (el) return el;
    }
    return null;
  }

  /** true = кнопка где-то на странице (в баре или плавающей). */
  function mount() {
    if (!els) return false;
    const bar = findPlayerHost(document);
    if (bar) {
      if (els.root.parentNode === bar) return true;
      try { bar.insertBefore(els.root, bar.firstChild); } catch (e) { return false; }
      state.mounted = true;
      if (state.floating) { state.floating = false; els.root.dataset.float = ''; }
      return true;
    }
    // Кнопка обязана появиться хотя бы в углу: «тихого» отсутствия UI быть не должно,
    // иначе «ничего не происходит» невозможно отличить от «скрипт не запущен».
    if (!state.mounted && document.body) {
      document.body.appendChild(els.root);
      els.root.dataset.float = '1';
      state.floating = true;
      state.mounted = true;
      log('mount: ytmusic-player-bar не найден — кнопка плавающая в углу');
    }
    return !!state.mounted;
  }

  function boot() {
    hookFetch(); hookXhr();
    if (document.readyState === 'loading') {
      // на document-start DOM ещё пуст: панель достроим позже, хуки уже работают
      document.addEventListener('DOMContentLoaded', () => { try { ensureUi(); } catch (e) {} }, { once: true });
    }

    // Хоткеи и пункты меню — ПЕРВЫМИ. Раньше любой throw внутри ensureUi() уносил и
    // Ctrl+Shift+Y, и меню Tampermonkey: оставалось «скрипт выполнился 1 раз» и тишина.
    // Теперь UI может не построиться — хуки всё равно живые, а причина видна на экране.
    if (boot.hotkeys !== true) {
      boot.hotkeys = true;
      document.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
        if (typing) return;
        if (e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'KeyD') { e.preventDefault(); act(); }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyY') { e.preventDefault(); togglePanel(); }
      });
    }
    registerMenuCommands();

    let uiErr = null;
    try { ensureUi(); } catch (e) { uiErr = e; showFatal('ensureUi', e); }
    if (uiErr) {
      uiBroken = true;
      setTimeout(() => { try { ensureUi(); uiBroken = false; } catch (e) {} }, 2000);
    }
    setInterval(() => { if (!mount()) { /* панель перерисовали */ } }, 1500);
    pingCompanion().catch(() => {});
    new MutationObserver(() => {
      const v = currentVideoId();
      if (v && v !== state.lastVideoId) {
        state.lastVideoId = v;
        if (!state.byVideo.has(v)) { const p0 = initialPlayerResponse(v); p0 ? capturePlayerResponse(v, p0, 'page') : selfAskPlayer(v); }
        uiRefresh();
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  }

  function registerMenuCommands() {
    if (registerMenuCommands.done) return;
    registerMenuCommands.done = true;
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Скачать весь плейлист', () => downloadWholeList().catch((e) => setStatus(`✕ ${e.message}`, 'err')));   // liked - тоже он: resolve_playlist_url подставит YY
      GM_registerMenuCommand('Очередь со страницы (пропуская уже скачанное)', () => queueFromPage());
      GM_registerMenuCommand('Показать архив «уже скачано»', () => $('#ytmdl-archive') && $('#ytmdl-archive').click());
      GM_registerMenuCommand('Сбросить архив «уже скачано»', () => resetArchive().catch((e) => setStatus(`✕ ${e.message}`, 'err')));
      GM_registerMenuCommand('Скачать обложку трека (файлом рядом)', () => {
        trackInfo().then((i) => downloadCover(i, false)).then(
          (j) => setStatus('обложка: ' + j.saved, 'ok'),
          (e) => setStatus('✕ ' + e.message, 'err'));
      });
      GM_registerMenuCommand('Перезахватить player response', () => regrab().catch((e) => setStatus('✕ ' + e.message, 'err')));
      GM_registerMenuCommand('Скачать текущий трек (Shift+D)', act);
      GM_registerMenuCommand('Панель / настройки (Ctrl+Shift+Y)', () => togglePanel());
      GM_registerMenuCommand('Проверить companion', pingCompanion);
      GM_registerMenuCommand('Очередь со страницы', queueFromPage);
      GM_registerMenuCommand('Показать панель (даже если UI не построился)', () => togglePanel(true));
      GM_registerMenuCommand('Дамп перехваченного в консоль', () => {
        const o = {};
        for (const [k, v] of state.byVideo) o[k] = { at: v.at, source: v.source, formats: pickAudioFormats(v.pr) };
        console.log(LOG, o);
      });
    }
    log('ready', VER);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  /* ═════════════════ экспорт для автотестов (в браузере — no-op) ═════════════════ */
  global.YTMDL_LIB = {
    VER, pickAudioFormats, canDownloadDirectly, diagnose, containerOf, isAudioFmt, fmtIsSabr, fmtHasUrl,
    sniffBytes, looksLikeHtml, browserJobPayload, streamHeaders, fetchStream, initialPlayerResponse,
    mediaFmt, sniffedContainer, sniffedFull, mirrorLog,
    hookTarget, looksLikePlayerResponse, mediaMeta,
    splitQuery, setQuery, fullRangeUrl, parseRange, coverageFromRanges, findPlayerHost, PLAYER_HOSTS,
    showFatal, registerMenuCommands, uiBrokenFlag: () => uiBroken,
    walkBoxes, box, concat, readU32, fourcc, findPath, childBoxes, rebuildFromBoxes, isEncryptedMp4,
    readTrunSamples, readTfhdDefaults, readTrexDefaults, readInitSttsDuration, sizesSum, readMfraSampleSizes, distributeSizes, collectSamples, editBox, removeTypes, v_same, fixDurations, patchField, assembleMp4, insertIntoBox, rebuildFromBoxes, childBoxes, resolveMode, observeStream,
    withDirOverride, mediaQuery, dirOverride, jobPayload, idsFromHrefs, playlistHrefFromHrefs, likedHrefFromHrefs, collectAllIds,
    _test: { state, cfg, document, capturePlayerHost: findPlayerHost, capturePlayerResponse, bestSniffedUrl, currentVideoId, trackInfo, ensureUi, mount, els: () => els, setEls: (v) => { els = v; }, uiBrokenSet: (v) => { uiBroken = v; }, boot, togglePanel, mediaFmt, sniffedContainer, sniffedFull, mirrorLog, accountThrottled, collectBrowseItems,
            // 0.6.1: вынесены в _test тем же приёмом, что browserJobPayload из modeResolve —
            // «чтобы было чем проверить». Поведенческие тесты шести фиксов очереди.
            setStatus, browserJobPayload },
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
