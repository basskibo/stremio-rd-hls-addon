/**
 * Jednostavan RD → HLS server za stari iPad (iOS 12 Safari).
 *
 *  - Torrentio + Real-Debrid daje direktan HTTP link do fajla.
 *  - ffmpeg pravi HLS (H.264 + AAC, .ts segmenti) koji Safari pušta nativno.
 *  - Titlove server izvlači posebno (ugrađeni + OpenSubtitles), a plejer ih sam crta,
 *    pa može da se bira prevod i pomera sinhronizacija.
 *  - Može preko Stremio addona (/manifest.json) ili direktno iz browsera (/).
 *
 * Pokretanje: npm start  (podešavanja u .env, vidi README.md)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HLS_DIR = path.join(ROOT, 'hls');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const PORT = Number(process.env.PORT) || 3000;
const RD_TOKEN = (process.env.RD_TOKEN || process.env.RD_API_TOKEN || '').trim();
const LAN_URL = trimSlash(process.env.LAN_URL) || `http://${lanIp()}:${PORT}`;
/** Adresa addona za Stremio (npr. ngrok https ako Stremio web ne prihvata http). */
const PUBLIC_URL = trimSlash(process.env.PUBLIC_URL || process.env.NGROK_URL) || LAN_URL;
const TORRENTIO = trimSlash(process.env.TORRENTIO_URL) || 'https://torrentio.strem.fun';
/** Bez 4K/HDR/remux-a — preteški za transkodiranje i nepotrebni za iPad. */
const TORRENTIO_OPTS =
  process.env.TORRENTIO_OPTS ||
  'qualityfilter=brremux,hdrall,dolbyvision,dolbyvisionwithhdr,threed,4k,scr,cam,unknown';
const MAX_SIZE_GB = Number(process.env.MAX_SIZE_GB) || 1.5;
/** Na slabom hardveru (Raspberry Pi) H.264 izvori idu prvi — samo se kopiraju, bez transkodiranja. */
const PREFER_H264 = process.env.PREFER_H264 === '1';
const AUDIO_LANGS = langList(process.env.AUDIO_LANG || 'jpn,ja,jp');
const SUB_LANGS = langList(process.env.SUB_LANG || 'eng,en');
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT) || 1080;
const X264_PRESET = process.env.X264_PRESET || 'veryfast';
const SEG_SEC = 4;

const KITSU = 'https://anime-kitsu.strem.fun';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const OPENSUBS = 'https://opensubtitles-v3.strem.io';

function trimSlash(s) {
  return s ? String(s).trim().replace(/\/+$/, '') : '';
}
function langList(s) {
  return s.split(/[,\s]+/).filter(Boolean).map((x) => x.toLowerCase());
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}
function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}
const hashKey = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url.replace(RD_TOKEN, '***')}`);
  return res.text();
}
const getJson = async (url) => JSON.parse(await fetchText(url));

/** Mali keš za meta/katalog/titl odgovore (One Piece meta ima 1400 epizoda). */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

// ---------------------------------------------------------------------------
// Katalog: pretraga, meta, epizode
// ---------------------------------------------------------------------------

function posterFor(m) {
  if (m.poster) return m.poster;
  const imdb = m.imdb_id || (String(m.id).startsWith('tt') ? m.id : '');
  return imdb ? `https://images.metahub.space/poster/medium/${imdb}/img` : '';
}
const brief = (m) => ({ id: m.id, type: m.type, name: m.name, poster: posterFor(m), year: m.releaseInfo || m.year || '' });

/** Spori katalog (Cinemeta zna da kasni) ne sme da zadrži ostale. */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function catalogs(lists) {
  const results = await Promise.allSettled(lists.map(([, url]) => withTimeout(getJson(url), 6000)));
  return lists.map(([name], i) => ({
    name,
    items: results[i].status === 'fulfilled' ? (results[i].value.metas || []).slice(0, 20).map(brief) : [],
  }));
}

function search(q) {
  const e = encodeURIComponent(q);
  return catalogs([
    ['Anime', `${KITSU}/catalog/anime/kitsu-anime-list/search=${e}.json`],
    ['Serije', `${CINEMETA}/catalog/series/top/search=${e}.json`],
    ['Filmovi', `${CINEMETA}/catalog/movie/top/search=${e}.json`],
  ]);
}

function home() {
  return cached('home', 3600_000, () =>
    catalogs([
      ['Popularni anime', `${KITSU}/catalog/anime/kitsu-anime-trending.json`],
      ['Trenutno se emituje', `${KITSU}/catalog/anime/kitsu-anime-airing.json`],
      ['Popularne serije', `${CINEMETA}/catalog/series/top.json`],
    ])
  );
}

function rawMeta(type, id) {
  const base = id.startsWith('kitsu:') ? KITSU : CINEMETA;
  return cached(`meta:${type}:${id}`, 6 * 3600_000, async () => (await getJson(`${base}/meta/${type}/${encodeURIComponent(id)}.json`)).meta);
}

async function meta(type, id) {
  const m = await rawMeta(type, id);
  const videos = (m.videos || [])
    .map((v) => ({
      id: v.id,
      season: Number(v.season) || 0,
      episode: Number(v.episode || v.number) || 0,
      title: v.title || v.name || '',
      released: (v.released || '').slice(0, 10),
      thumb: v.thumbnail || '',
    }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    poster: posterFor(m),
    background: m.background || '',
    description: m.description || '',
    year: m.releaseInfo || m.year || '',
    videos,
  };
}

// ---------------------------------------------------------------------------
// Omiljeno (JSON fajl na serveru — preživi brisanje Safari keša)
// ---------------------------------------------------------------------------

function readFavorites() {
  try {
    return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeFavorites(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FAVORITES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FAVORITES_FILE);
}

function addFavorite(item) {
  if (!item || !item.id || !item.type) throw new Error('Nedostaje id/type');
  const entry = {
    id: String(item.id),
    type: String(item.type),
    name: String(item.name || ''),
    poster: String(item.poster || ''),
    year: String(item.year || ''),
    added: new Date().toISOString(),
  };
  const list = readFavorites().filter((f) => f.id !== entry.id);
  list.unshift(entry);
  writeFavorites(list);
  return list;
}

function removeFavorite(id) {
  const list = readFavorites().filter((f) => f.id !== id);
  writeFavorites(list);
  return list;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Neispravan JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Izvori (Torrentio + RD)
// ---------------------------------------------------------------------------

/** key → { url, label, type, id }; linkovi u Stremio/browseru nose samo ključ, ne RD token. */
const sourcesByKey = new Map();

function sizeGb(text) {
  const m = String(text).match(/([\d.]+)\s*([KMGT])B/i);
  if (!m) return null;
  return Number(m[1]) * { K: 1e-6, M: 1e-3, G: 1, T: 1e3 }[m[2].toUpperCase()];
}

/** Grube naznake da izdanje ima engleske titlove (ili da je rusko — bez engleskog titla). */
function subsHint(text) {
  let n = 0;
  if (/subsplease|erai|horriblesubs|judas|ember|\basw\b|anime ?time|yameii|varyg|tsundere|multi.?sub|esub|\beng(lish)?\b|dual.?audio|\bsub(bed|s)?\b/i.test(text)) n += 2;
  if (/🇬🇧|🇺🇸/u.test(text)) n += 1;
  if (/🇷🇺|\brus\b|anilibria|anidub|animevost|dream ?cast|shiza/i.test(text)) n -= 3;
  return n;
}

async function findSources(type, id) {
  if (!RD_TOKEN) throw new Error('RD_TOKEN nije podešen u .env');
  const torType = type === 'movie' ? 'movie' : 'series';
  const opts = [TORRENTIO_OPTS, `realdebrid=${RD_TOKEN}`].filter(Boolean).join('|');
  const data = await getJson(`${TORRENTIO}/${opts}/stream/${torType}/${encodeURIComponent(id)}.json`);
  const out = [];
  let tooBig = 0;
  (data.streams || []).forEach((s, order) => {
    if (!s.url) return;
    const name = String(s.name || '');
    const title = String(s.title || '');
    const lines = title.split('\n');
    const info = lines.find((l) => /💾|👤/.test(l)) || '';
    const size = (info.match(/💾\s*([\d.]+\s*[KMGT]B)/) || [])[1] || '';
    const gb = sizeGb(size);
    if (gb != null && gb > MAX_SIZE_GB) {
      tooBig += 1;
      return;
    }
    const file = (s.behaviorHints && s.behaviorHints.filename) || lines[lines.length > 1 ? 1 : 0] || '';
    const src = {
      key: hashKey(s.url),
      cached: /RD\+/.test(name),
      quality: name.split('\n').slice(1).join(' ').trim(),
      file,
      release: lines[0] || file,
      size,
      seeds: (info.match(/👤\s*(\d+)/) || [])[1] || '',
      // Torrentio: naslov / fajl / 👤 💾 ⚙️ / zastavice jezika.
      langs: lines.slice(lines.indexOf(info) + 1).join(' ').trim(),
      subsHint: subsHint(title),
      h264: /\b(x264|h\.?264|avc)\b/i.test(title) && !/x265|hevc|h\.?265|10.?bit|hi10/i.test(title),
      order,
    };
    sourcesByKey.set(src.key, { url: s.url, label: file || src.release, type, id });
    out.push(src);
  });
  // Keširani na RD-u prvi (kreću odmah), pa verovatno sa engleskim titlom, pa Torrentio redosled.
  const h264First = (a, b) => Number(b.h264) - Number(a.h264);
  out.sort(
    (a, b) =>
      Number(b.cached) - Number(a.cached) ||
      (PREFER_H264 && h264First(a, b)) ||
      b.subsHint - a.subsHint ||
      h264First(a, b) ||
      a.order - b.order
  );
  return { maxSizeGb: MAX_SIZE_GB, tooBig, sources: out.slice(0, 25) };
}

/** Torrentio /resolve vraća 302 ka RD linku; ako RD još skida, vraća video-placeholder. */
async function resolveDirectUrl(url) {
  if (!url.startsWith(TORRENTIO)) return url;
  const res = await fetch(url, { redirect: 'manual' });
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`Torrentio resolve: HTTP ${res.status}`);
  if (/\/videos\/|torrentio/.test(loc) && !/real-debrid/.test(loc)) {
    const what = (loc.match(/videos\/(\w+)/) || [])[1] || loc;
    throw new Error(
      what.startsWith('downloading')
        ? 'Real-Debrid još skida ovaj torrent — izaberi izvor sa ⚡ ili probaj kasnije.'
        : what.startsWith('download_failed')
          ? 'Real-Debrid ne može da skine ovaj torrent — izaberi drugi izvor.'
          : `Real-Debrid/Torrentio greška: ${what}`
    );
  }
  return loc;
}

// ---------------------------------------------------------------------------
// ffprobe + izbor traka
// ---------------------------------------------------------------------------

function ffprobe(url) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', url],
      { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`ffprobe: ${(stderr || err.message).trim().slice(-300)}`));
        resolve(JSON.parse(stdout));
      }
    );
  });
}

const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext']);
const tag = (s, k) => String((s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '').toLowerCase();
const disp = (s, k) => Boolean(s.disposition && s.disposition[k]);

function trackLabel(s) {
  const title = (s.tags && (s.tags.title || s.tags.TITLE)) || '';
  return [tag(s, 'language') || '?', title, s.codec_name].filter(Boolean).join(' · ');
}

/** Ocena titla: engleski gore, „Full/Dialogue” još više, „Signs & Songs/Forced” dole. */
function subScore(s) {
  const t = tag(s, 'title');
  let n = 0;
  if (SUB_LANGS.includes(tag(s, 'language')) || /english/.test(t)) n += 50;
  if (/sign|song|forced/.test(t) || disp(s, 'forced')) n -= 100;
  if (/full|dialog/.test(t)) n += 10;
  if (disp(s, 'default')) n += 1;
  return n;
}

function pickTracks(probe, audioIndex) {
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !disp(s, 'attached_pic'));
  if (!video) throw new Error('Fajl nema video traku');

  const audios = streams.filter((s) => s.codec_type === 'audio');
  const audio =
    audios.find((s) => s.index === audioIndex) ||
    audios.find((s) => AUDIO_LANGS.includes(tag(s, 'language'))) ||
    audios.find((s) => /japan/.test(tag(s, 'title'))) ||
    audios.find((s) => disp(s, 'default')) ||
    audios[0];

  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const textSubs = subs.filter((s) => !BITMAP_SUBS.has(s.codec_name)).slice(0, 12);
  // PGS se ne može crtati u plejeru — „upeče” se u sliku samo ako nema tekstualnog engleskog.
  const bitmapEng = subs
    .filter((s) => BITMAP_SUBS.has(s.codec_name) && subScore(s) > 0)
    .sort((a, b) => subScore(b) - subScore(a))[0];
  const hasEngText = textSubs.some((s) => subScore(s) > 0);
  return { video, audio, audios, textSubs, burnSub: !hasEngText && bitmapEng ? bitmapEng : null };
}

// ---------------------------------------------------------------------------
// Titlovi: parsiranje i čišćenje (ASS karaoke/natpisi, SRT)
// ---------------------------------------------------------------------------

function parseTime(t) {
  const m = String(t).trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + Number(`0.${m[4]}`);
}

/**
 * ASS → [[start, end, text, top]]. Izbacuje ono što kao običan titl izgleda kao smeće:
 * crteže (\p1), pozicionirane natpise (\pos/\move), natpise/karaoke/romaji stilove i
 * „slovo po slovo” linije. Prevod pesama ostaje; `top` = linija ide na vrh ekrana
 * (stil ili \an7-9), kao romaji u One Piece fansubovima.
 */
function parseAss(text) {
  const cues = [];
  const styleTop = {};
  let styleFields = null;
  let fields = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Format:')) {
      const f = line.slice(7).split(',').map((x) => x.trim().toLowerCase());
      if (f.includes('text') && f.includes('start')) fields = f;
      else if (f.includes('alignment')) styleFields = f;
      continue;
    }
    if (line.startsWith('Style:') && styleFields) {
      const parts = line.slice(6).split(',').map((x) => x.trim());
      const al = Number(parts[styleFields.indexOf('alignment')]);
      styleTop[parts[styleFields.indexOf('name')]] = al >= 7 && al <= 9;
      continue;
    }
    if (!line.startsWith('Dialogue:') || !fields) continue;
    const parts = line.slice(9).split(',');
    const rec = {};
    fields.forEach((f, i) => {
      rec[f] = i === fields.length - 1 ? parts.slice(i).join(',') : (parts[i] || '').trim();
    });
    const raw = rec.text || '';
    if (/\\p[1-9]/.test(raw) || /\\(pos|move)\(/.test(raw)) continue;
    if (/sign|kara|title|typeset|^ts\b|romaji|kanji|note/i.test(rec.style || '')) continue;
    const clean = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
    if (clean.replace(/\s/g, '').length <= 1) continue;
    const an = raw.match(/\\an(\d)/);
    const top = an ? Number(an[1]) >= 7 : Boolean(styleTop[rec.style]);
    const s = parseTime(rec.start);
    const e = parseTime(rec.end);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) cues.push([s, e, clean, top ? 1 : 0]);
  }
  return tidyCues(cues);
}

function parseSrt(text) {
  const cues = [];
  for (const block of text.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const s = parseTime(a);
    const e = parseTime(b);
    const t = lines
      .slice(i + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
    if (t && Number.isFinite(s) && Number.isFinite(e)) cues.push([s, e, t]);
  }
  return tidyCues(cues);
}

/** Sortira i spaja duplikate (isti tekst koji se preklapa ili se nastavlja). */
function tidyCues(cues) {
  cues.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const c of cues) {
    let dup = null;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 20; k--) {
      const o = out[k];
      if (o[2] === c[2] && c[0] <= o[1] + 0.05) {
        dup = o;
        break;
      }
    }
    if (dup) dup[1] = Math.max(dup[1], c[1]);
    else out.push([Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000, c[2], c[3] || 0]);
  }
  return out;
}

/** Ćirilica/latinica — da ruski titl pogrešno označen kao „eng” ne bude izabran. */
function scriptOf(cues) {
  const sample = cues.slice(0, 80).map((c) => c[2]).join(' ');
  const cyr = (sample.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (sample.match(/[A-Za-z]/g) || []).length;
  if (cyr + lat < 20) return 'unknown';
  return cyr > lat ? 'cyrillic' : 'latin';
}

/** Spoljni (OpenSubtitles) titlovi preko Stremio OpenSubtitles v3 addona. */
async function externalSubs(type, id) {
  if (!type || !id) return [];
  const ids = [];
  if (id.startsWith('kitsu:')) {
    // Kitsu numeracija (npr. One Piece 800) → IMDb sezona/epizoda; probaj i S1E<apsolutni broj>.
    const kid = id.split(':')[1];
    try {
      const m = await rawMeta('series', `kitsu:${kid}`);
      const v = (m.videos || []).find((x) => x.id === id);
      if (v && v.imdb_id) {
        if (v.imdbSeason) ids.push(['series', `${v.imdb_id}:${v.imdbSeason}:${v.imdbEpisode}`]);
        if (v.episode) ids.push(['series', `${v.imdb_id}:1:${v.episode}`]);
      } else if (m.imdb_id && !(m.videos || []).length) {
        ids.push(['movie', m.imdb_id]);
      }
    } catch (e) {
      log('Kitsu meta za titlove:', e.message);
    }
  } else if (id.startsWith('tt')) {
    ids.push([type === 'movie' ? 'movie' : 'series', id]);
  }
  const seen = new Set();
  const out = [];
  for (const [t, i] of ids) {
    try {
      const d = await cached(`os:${t}:${i}`, 3600_000, () => getJson(`${OPENSUBS}/subtitles/${t}/${i}.json`));
      for (const s of d.subtitles || []) {
        if (!SUB_LANGS.includes(String(s.lang).toLowerCase()) || seen.has(s.url)) continue;
        seen.add(s.url);
        out.push({ sid: `os-${hashKey(s.url)}`, url: s.url });
      }
    } catch (e) {
      log('OpenSubtitles:', e.message);
    }
  }
  return out.slice(0, 15).map((s, n) => ({ ...s, label: `OpenSubtitles EN #${n + 1}`, kind: 'external' }));
}

function loadExternalCues(url) {
  return cached(`oscues:${url}`, 6 * 3600_000, async () => parseSrt(await fetchText(url)));
}

// ---------------------------------------------------------------------------
// ffmpeg posao (samo jedan istovremeno — kućna upotreba)
// ---------------------------------------------------------------------------

let job = null;

function stopJob() {
  if (!job) return;
  const old = job;
  job = null;
  if (old.proc && old.proc.exitCode === null) old.proc.kill('SIGKILL');
  fs.rm(old.dir, { recursive: true, force: true }, () => {});
}

function startJob(key, startSec, audioIndex) {
  const jobId = `${key}-${startSec}-${audioIndex >= 0 ? audioIndex : 'a'}`;
  if (job && job.id === jobId && !job.error) return job;
  const source = sourcesByKey.get(key);
  if (!source) throw new Error('Nepoznat izvor — vrati se na listu izvora i izaberi ponovo (server je možda restartovan).');
  stopJob();
  const dir = path.join(HLS_DIR, jobId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const j = {
    id: jobId,
    key,
    dir,
    label: source.label,
    videoType: source.type || '',
    videoId: source.id || '',
    startSec,
    state: 'resolve',
    info: {},
    audios: [],
    audioIndex: -1,
    embedded: [],
    external: null,
    error: null,
    proc: null,
    tail: [],
  };
  job = j;
  j.externalPromise = externalSubs(source.type, source.id).then((list) => (j.external = list));
  runJob(j, source.url, audioIndex).catch((e) => failJob(j, e));
  return j;
}

function failJob(j, e) {
  j.error = e.message || String(e);
  j.state = 'error';
  log('GREŠKA:', j.error);
}

async function runJob(j, sourceUrl, audioIndex) {
  log('Start:', j.label, j.startSec ? `od ${j.startSec}s` : '');
  const input = await resolveDirectUrl(sourceUrl);
  if (job !== j) return;
  j.state = 'probe';
  const probe = await ffprobe(input);
  if (job !== j) return;
  const t = pickTracks(probe, audioIndex);
  const v = t.video;
  const copyVideo =
    !t.burnSub &&
    v.codec_name === 'h264' &&
    v.pix_fmt === 'yuv420p' &&
    (!v.level || v.level <= 42) &&
    (v.height || 0) <= MAX_HEIGHT;
  j.audios = t.audios.map((a) => ({ index: a.index, label: trackLabel(a) }));
  j.audioIndex = t.audio ? t.audio.index : -1;
  j.embedded = t.textSubs.map((s) => ({
    sid: `emb-${s.index}`,
    index: s.index,
    label: trackLabel(s),
    score: subScore(s),
    kind: 'embedded',
    file: path.join(j.dir, `sub_${s.index}.ass`),
  }));
  j.info = {
    video: `${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt || ''} → ${copyVideo ? 'kopija' : 'H.264'}`,
    audio: t.audio ? trackLabel(t.audio) : 'nema',
    burned: t.burnSub ? trackLabel(t.burnSub) : '',
    duration: Number(probe.format && probe.format.duration) || 0,
  };
  j.fmtStart = Number(probe.format && probe.format.start_time) || 0;
  log('Trake:', JSON.stringify(j.info), `ugrađenih titlova: ${j.embedded.length}`);

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
  if (/^https?:/.test(input)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10');
  }
  if (j.startSec > 0) args.push('-ss', String(j.startSec));
  // -copyts: izlaz zadržava vremena izvora, pa titlovi (ugrađeni i spoljni) idu po istom satu.
  args.push('-copyts', '-i', input);

  // Izlaz 1: HLS (video + audio).
  const scale = `scale=-2:'min(${MAX_HEIGHT},ih)',format=yuv420p`;
  if (t.burnSub) {
    args.push('-filter_complex', `[0:${v.index}][0:${t.burnSub.index}]overlay,${scale}[v]`, '-map', '[v]');
  } else {
    args.push('-map', `0:${v.index}`);
    if (!copyVideo) args.push('-vf', scale);
  }
  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', '21',
      '-profile:v', 'high', '-level', '4.1', '-maxrate', '8M', '-bufsize', '16M',
      '-force_key_frames', `expr:gte(t,n_forced*${SEG_SEC})`
    );
  }
  if (t.audio) args.push('-map', `0:${t.audio.index}`, '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  args.push(
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls', '-hls_time', String(SEG_SEC), '-hls_list_size', '0',
    '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(j.dir, 'seg_%05d.ts'),
    path.join(j.dir, 'stream.m3u8')
  );
  // Izlazi 2..n: svaki tekstualni titl kao .ass (piše se usput, dok se video konvertuje).
  // -ignore_readorder: inače ASS muxer drži sve linije do kraja ako fansub nije u ReadOrder redu.
  for (const s of j.embedded) {
    args.push('-map', `0:${s.index}`, '-c:s', 'ass', '-flush_packets', '1', '-f', 'ass', '-ignore_readorder', '1', s.file);
  }

  j.state = 'encode';
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  j.proc = proc;
  proc.stderr.on('data', (d) => {
    j.tail.push(...String(d).split('\n').filter(Boolean));
    j.tail = j.tail.slice(-20);
  });
  proc.on('exit', (code, signal) => {
    if (job !== j) return;
    if (code === 0) {
      j.state = 'done';
      log('Gotovo:', j.label);
    } else if (!signal) {
      failJob(j, new Error(`ffmpeg izašao (${code}): ${j.tail.slice(-3).join(' | ')}`));
    }
  });
}

/**
 * Koje vreme izvora odgovara video.currentTime = 0. Uz -ss i kopiranje videa to je
 * ključni frejm pre traženog trenutka, pa se čita iz prvog segmenta.
 */
function detectOrigin(j) {
  if (j.origin != null || j.originPending) return;
  j.originPending = true;
  execFile(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', path.join(j.dir, 'seg_00000.ts')],
    { timeout: 10_000 },
    (err, stdout) => {
      j.originPending = false;
      const pts = parseFloat(stdout);
      if (!err && Number.isFinite(pts)) j.origin = Math.max(0, Math.round((pts - j.fmtStart) * 1000) / 1000);
    }
  );
}

function jobStatus(j) {
  let segments = 0;
  let encodedSec = 0;
  try {
    for (const m of fs.readFileSync(path.join(j.dir, 'stream.m3u8'), 'utf8').matchAll(/#EXTINF:([\d.]+)/g)) {
      segments += 1;
      encodedSec += Number(m[1]);
    }
  } catch {}
  if (segments >= 1) detectOrigin(j);
  return {
    id: j.id,
    key: j.key,
    label: j.label,
    videoType: j.videoType,
    videoId: j.videoId,
    state: j.state,
    error: j.error,
    info: j.info,
    audios: j.audios,
    audioIndex: j.audioIndex,
    startSec: j.startSec,
    encodedSec: Math.round(encodedSec * 10) / 10,
    origin: j.origin == null ? null : j.origin,
    ready: !j.error && j.origin != null && (segments >= 2 || j.state === 'done'),
    playlist: `/hls/${j.id}/stream.m3u8`,
  };
}

/** Ugrađeni titl; vremena se svode na „od početka fajla” kao i kod spoljnih titlova. */
function embeddedCues(j, s) {
  let cues = [];
  try {
    cues = parseAss(fs.readFileSync(s.file, 'utf8'));
  } catch {}
  return j.fmtStart ? cues.map(([a, b, t, top]) => [a - j.fmtStart, b - j.fmtStart, t, top]) : cues;
}

/** Lista titlova za trenutni video + predlog koji da se uključi. */
async function subsList(j) {
  await Promise.race([j.externalPromise, new Promise((r) => setTimeout(r, 8000))]);
  const embedded = j.embedded.map((s) => {
    const cues = embeddedCues(j, s);
    const script = scriptOf(cues);
    let score = s.score;
    if (script === 'cyrillic') score -= 200;
    if (script === 'latin') score += 5;
    if (!cues.length && j.state === 'done') score -= 100;
    const sample = cues[Math.min(cues.length - 1, 5)];
    return {
      sid: s.sid,
      kind: s.kind,
      label: s.label + (script === 'cyrillic' ? ' (ćirilica)' : ''),
      sample: sample ? sample[2].replace(/\n/g, ' ').slice(0, 70) : '',
      score,
    };
  });
  const external = (j.external || []).map(({ sid, label, kind }) => ({ sid, label, kind, sample: '' }));
  const bestEmb = embedded.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)[0];
  return {
    default: bestEmb ? bestEmb.sid : external.length ? external[0].sid : '',
    burned: j.info.burned || '',
    pending: !j.embedded.length && !['encode', 'done', 'error'].includes(j.state),
    subs: [...embedded, ...external],
  };
}

async function subCues(j, sid) {
  const emb = j.embedded.find((s) => s.sid === sid);
  if (emb) return { cues: embeddedCues(j, emb), complete: j.state === 'done' };
  const ext = (j.external || []).find((s) => s.sid === sid);
  if (ext) return { cues: await loadExternalCues(ext.url), complete: true };
  throw new Error('Nepoznat titl');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra });
  res.end(body);
}
const sendJson = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), 'application/json');

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
function serveStatic(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) return send(res, 404, 'Nema');
    send(res, 200, buf, STATIC_TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

const manifest = {
  id: 'org.local.ipad-hls',
  version: '2.1.0',
  name: 'iPad HLS (RD)',
  description: 'Real-Debrid → HLS za stari iPad. Otvara se u Safariju sa japanskim zvukom i engleskim titlovima.',
  resources: ['stream'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: [],
};

async function stremioStreams(type, id) {
  const { sources } = await findSources(type, id);
  return sources.map((s, i) => ({
    name: `${s.cached ? '⚡' : '⏳'} iPad\n${s.quality}`,
    title: [s.release, s.file !== s.release ? s.file : '', [s.size && `💾 ${s.size}`, s.seeds && `👤 ${s.seeds}`, s.langs].filter(Boolean).join('  ')]
      .filter(Boolean)
      .join('\n'),
    externalUrl: `${LAN_URL}/watch/${s.key}`,
    behaviorHints: { bingeGroup: `ipad-hls-${i}` },
  }));
}

function serveHls(res, rel) {
  const [jobId, file] = rel.split('/');
  if (!job || job.id !== jobId || !/^[\w.-]+$/.test(file || '')) return send(res, 404, 'nema');
  fs.readFile(path.join(job.dir, file), (err, buf) => {
    if (err) return send(res, 404, 'nema');
    if (file.endsWith('.m3u8')) {
      // Kreni od početka, ne od „live” ivice event playliste.
      const txt = String(buf).replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
      return send(res, 200, txt, 'application/vnd.apple.mpegurl');
    }
    send(res, 200, buf, 'video/mp2t', { 'cache-control': 'max-age=3600' });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  let m;
  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', 'text/plain', { 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, DELETE' });
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    if (/^\/watch\/\w+$/.test(p)) return serveStatic(res, 'watch.html');
    if ((m = p.match(/^\/static\/([\w.-]+)$/))) return serveStatic(res, m[1]);
    if (p === '/manifest.json') return sendJson(res, manifest);
    if ((m = p.match(/^\/stream\/(\w+)\/(.+)\.json$/))) {
      log(`Stremio: ${m[1]} ${m[2]}`);
      return sendJson(res, { streams: await stremioStreams(m[1], m[2]) });
    }
    if (p === '/api/config') return sendJson(res, { addonUrl: `${PUBLIC_URL}/manifest.json`, maxSizeGb: MAX_SIZE_GB });
    if (p === '/api/home') return sendJson(res, await home());
    if (p === '/api/favorites') {
      if (req.method === 'POST') return sendJson(res, addFavorite(await readBody(req)));
      if (req.method === 'DELETE') return sendJson(res, removeFavorite(u.searchParams.get('id') || ''));
      return sendJson(res, readFavorites());
    }
    if (p === '/api/search') return sendJson(res, await search(u.searchParams.get('q') || ''));
    if ((m = p.match(/^\/api\/meta\/(\w+)\/(.+)$/))) return sendJson(res, await meta(m[1], m[2]));
    if ((m = p.match(/^\/api\/sources\/(\w+)\/(.+)$/))) return sendJson(res, await findSources(m[1], m[2]));
    if (p === '/api/link') {
      const link = String(u.searchParams.get('u') || '').trim();
      if (!/^https?:\/\//.test(link)) return sendJson(res, { error: 'Link mora da počne sa http(s)://' }, 400);
      const key = hashKey(link);
      // type/id (npr. series + tt0388629:1:1) su opcioni — služe samo za OpenSubtitles.
      sourcesByKey.set(key, {
        url: link,
        label: decodeURIComponent(link.split('/').pop() || link),
        type: u.searchParams.get('type') || '',
        id: u.searchParams.get('id') || '',
      });
      return sendJson(res, { key });
    }
    if ((m = p.match(/^\/api\/start\/(\w+)$/))) {
      const t = Math.max(0, Math.floor(Number(u.searchParams.get('t')) || 0));
      const a = u.searchParams.has('audio') ? Number(u.searchParams.get('audio')) : -1;
      return sendJson(res, jobStatus(startJob(m[1], t, a)));
    }
    if (p === '/api/status') return sendJson(res, job ? jobStatus(job) : { state: 'idle' });
    if (p === '/api/subs') return job ? sendJson(res, await subsList(job)) : sendJson(res, { error: 'Nema aktivnog videa' }, 404);
    if ((m = p.match(/^\/api\/sub\/([\w-]+)$/))) {
      if (!job) return sendJson(res, { error: 'Nema aktivnog videa' }, 404);
      return sendJson(res, await subCues(job, m[1]));
    }
    if (p === '/api/stop') {
      stopJob();
      return sendJson(res, { state: 'idle' });
    }
    if (p.startsWith('/hls/')) return serveHls(res, p.slice(5));
    send(res, 404, 'Nema');
  } catch (e) {
    log('Greška:', req.url.replace(RD_TOKEN, '***'), e.message);
    sendJson(res, { error: e.message }, 500);
  }
});

fs.mkdirSync(HLS_DIR, { recursive: true });
for (const d of fs.readdirSync(HLS_DIR)) fs.rmSync(path.join(HLS_DIR, d), { recursive: true, force: true });
process.on('SIGINT', () => (stopJob(), process.exit(0)));
process.on('SIGTERM', () => (stopJob(), process.exit(0)));

server.listen(PORT, '0.0.0.0', () => {
  log(`Browser (iPad):  ${LAN_URL}/`);
  log(`Stremio addon:   ${PUBLIC_URL}/manifest.json`);
  if (!RD_TOKEN) log('UPOZORENJE: RD_TOKEN nije podešen u .env — izvori neće raditi.');
});
