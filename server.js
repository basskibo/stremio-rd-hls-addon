import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { unrestrictRD, resolveStremioSource, getStreamLinksFromTorrentio } from './rd_helper.js';
import {
  destroyWebTorrentSession,
  magnetToHttpUrl,
  magnetPrepare,
} from './webtorrent_session.js';
import logger from './logger.js';
import pkg from 'stremio-addon-sdk';
const { addonBuilder, getRouter } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
/** Ispod HTTPS tunela / reverse proxy-a da Location i logovi budu konsistentni. */
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
const PORT = Number(process.env.PORT) || 3000;

const HLS_DIR = path.join(__dirname, 'hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR);

function pickLanIPv4() {
  const interfaces = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      fallback = iface.address;
      if (!/^169\.254\./.test(iface.address)) return iface.address;
    }
  }
  return fallback;
}

const IPv4 = pickLanIPv4();
const NGROK_URL = (process.env.NGROK_URL && process.env.NGROK_URL.replace(/\/$/, '')) || null;

/** URL koji iPad / Stremio moraju da vide (isti host za manifest i stream) */
const SERVER_BASE_URL =
  (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.replace(/\/$/, '')) ||
  NGROK_URL ||
  (IPv4 ? `http://${IPv4}:${PORT}` : `http://127.0.0.1:${PORT}`);

/** Posle /start pokazuje na stream.m3u8 ili master.m3u8 (više audio + titlovi). */
let activeHlsPlaylistFile = 'stream.m3u8';
/** Redirect endpoint: bira master ili stream po fajlu na disku (odloženi magnet + titlovi u masteru). */
const HLS_FOLLOW_PLAYLIST = 'follow-playlist.m3u8';
/** Jednostavan HLS: MPEG-TS (podrazum.) ili fMP4 segmente — na nekim Android/Stremio uređajima video radi samo uz fMP4. */
const HLS_FMP4_SIMPLE = process.env.HLS_FMP4 === '1';

/**
 * Opciono: -max_interleave_delta (µs). Podrazumevano prazno — ugrađeni FFmpeg mux; vrednost 0 je nekad lomila HLS izlaz.
 * Eksplicitno: FFMPEG_MAX_INTERLEAVE_DELTA_US=0 ili =default (bez opcije).
 */
function ffmpegMuxInterleaveOpts() {
  const v = process.env.FFMPEG_MAX_INTERLEAVE_DELTA_US;
  if (v === undefined || v === null || String(v).trim() === '') return [];
  if (v === 'default') return [];
  return ['-max_interleave_delta', String(v).trim()];
}

function hlsPlaylistAbsUrl() {
  return `${SERVER_BASE_URL}/hls/${activeHlsPlaylistFile}`;
}

function hlsPlaylistFollowAbsUrl() {
  return `${SERVER_BASE_URL}/hls/${HLS_FOLLOW_PLAYLIST}`;
}

function ffprobeJson(inputUrl) {
  return new Promise((resolve, reject) => {
    const analyzeduration = process.env.FFPROBE_ANALYZEDURATION || '8000000';
    const probesize = process.env.FFPROBE_PROBESIZE || '52428800';
    const args = [
      '-v',
      'error',
      '-analyzeduration',
      analyzeduration,
      '-probesize',
      probesize,
    ];
    if (/127\.0\.0\.1|localhost/i.test(inputUrl)) {
      args.push('-seekable', '0');
    }
    args.push('-print_format', 'json', '-show_streams', '-show_format', inputUrl);
    const p = spawn('ffprobe', args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `ffprobe izlaz ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const TEXT_SUB_CODECS = new Set([
  'subrip',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'srt',
  'microdvd',
  'mpl2',
  'subviewer',
  'subviewer1',
  'stl',
  'realtext',
  'text',
]);

function isTextSubtitleCodec(codecName) {
  return codecName && TEXT_SUB_CODECS.has(String(codecName).toLowerCase());
}

function planHlsFromProbe(probe) {
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter(
    (s) => s.codec_type === 'subtitle' && isTextSubtitleCodec(s.codec_name)
  );
  return { video, audios, subs };
}

async function resolveStreamInput(urlParam, fileIdxParsed) {
  let directUrl = null;
  let wtReadStream = null;
  let probeSourceUrl = null;
  if (urlParam.startsWith('magnet:')) {
    const idx = Number.isFinite(fileIdxParsed) ? fileIdxParsed : 0;
    if (process.env.WEBTORRENT_FFMPEG_HTTP === '1') {
      directUrl = await magnetToHttpUrl(urlParam, idx);
      probeSourceUrl = directUrl;
    } else {
      const mp = await magnetPrepare(urlParam, idx);
      probeSourceUrl = mp.probeUrl;
      wtReadStream = mp.readStream();
    }
  } else if (urlParam.startsWith('http://') || urlParam.startsWith('https://')) {
    const unrestricted = await unrestrictRD(urlParam);
    directUrl = unrestricted || urlParam;
    probeSourceUrl = directUrl;
  } else {
    throw new Error('url mora biti magnet: ili http(s):');
  }
  return { directUrl, wtReadStream, probeSourceUrl };
}

function probeStreamLangTag(stream) {
  const raw = String((stream.tags && stream.tags.language) || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (/^[a-z]{2,3}(-[a-z]{2,3})?$/.test(raw)) return raw.split('-')[0];
  return 'und';
}

/** Jezik za HLS MEDIA: samo kratak siguran kod za plejer. */
function vmHlsLangForBucket(bucket) {
  const m = { en: 'en', ja: 'ja', sr: 'sr', hr: 'hr', bs: 'bs', und: 'und' };
  return m[bucket] || 'und';
}

function langBase(stream) {
  const raw = String((stream.tags && stream.tags.language) || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  return raw.split('-')[0] || '';
}

/** Audio: samo japanski, engleski, ili označen default u kontejneru. */
function selectHlsAudios(audios) {
  if (!audios || audios.length === 0) return audios;
  const isJa = (a) => {
    const b = langBase(a);
    return ['jpn', 'ja', 'jp'].includes(b) || b.startsWith('ja');
  };
  const isEn = (a) => {
    const b = langBase(a);
    return ['eng', 'en'].includes(b) || b.startsWith('en');
  };
  const isDef = (a) => a.disposition && Number(a.disposition.default) === 1;

  const ja = audios.find(isJa);
  const en = audios.find(isEn);
  const def = audios.find(isDef);

  const out = [];
  if (ja) out.push(ja);
  if (en && (!ja || en.index !== ja.index)) out.push(en);
  if (def && !out.some((x) => x.index === def.index)) out.push(def);

  const seen = new Set();
  const uniq = out.filter((a) => {
    if (seen.has(a.index)) return false;
    seen.add(a.index);
    return true;
  });
  return uniq.length ? uniq : [audios[0]];
}

const SUB_CODEC_RANK = { subrip: 0, srt: 0, mov_text: 1, webvtt: 2, ass: 3, ssa: 3 };

function subRank(codec) {
  const c = String(codec || '').toLowerCase();
  return SUB_CODEC_RANK[c] != null ? SUB_CODEC_RANK[c] : 9;
}

/** Titl bucket: en sr hr bs (rs → sr). */
function subLangBucket(s) {
  const b = langBase(s);
  if (['eng', 'en'].includes(b) || b.startsWith('en')) return 'en';
  if (['srp', 'sr', 'rs', 'scc'].includes(b) || b.startsWith('sr')) return 'sr';
  if (['hrv', 'hr'].includes(b) || b.startsWith('hr')) return 'hr';
  if (['bos', 'bs', 'hbs', 'b+'].includes(b) || b.startsWith('bs') || b === 'bo' || b.startsWith('bo')) {
    return 'bs';
  }
  return null;
}

function audioLangBucket(a) {
  const b = langBase(a);
  if (['jpn', 'ja', 'jp'].includes(b) || b.startsWith('ja')) return 'ja';
  if (['eng', 'en'].includes(b) || b.startsWith('en')) return 'en';
  return 'und';
}

/** Jedan audio za pipe / jednostavan HLS: AUDIO_LANG_PREF=ja,en,default (podrazumevano). */
function pickPreferredAudioTrack(audios) {
  if (!audios || audios.length === 0) return null;
  const raw = (process.env.AUDIO_LANG_PREF || 'ja,en,default').trim().toLowerCase();
  const keys = raw.split(/[,\s]+/).filter(Boolean);
  const byKey = (key) => {
    if (key === 'default' || key === 'def') {
      return audios.find((x) => x.disposition && Number(x.disposition.default) === 1);
    }
    if (key === 'ja' || key === 'jpn' || key === 'jp') {
      return audios.find((x) => audioLangBucket(x) === 'ja');
    }
    if (key === 'en' || key === 'eng') {
      return audios.find((x) => audioLangBucket(x) === 'en');
    }
    return null;
  };
  for (const key of keys) {
    const f = byKey(key);
    if (f) return f;
  }
  return audios[0];
}

/** Prioritet jezika za automatski izbor titlova (pipe/simple HLS uzima prvi). Podrazumevano prevod (sr) pre en. */
function subsPreferenceOrder() {
  const raw = (process.env.SUBS_LANG_PREF || 'sr,hr,bs,en').trim();
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  const valid = new Set(['en', 'sr', 'hr', 'bs']);
  const order = parts.map((p) => p.toLowerCase()).filter((p) => valid.has(p));
  const seen = new Set();
  const dedup = order.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
  if (dedup.length === 0) return ['en', 'sr', 'hr', 'bs'];
  for (const k of ['en', 'sr', 'hr', 'bs']) {
    if (!seen.has(k)) dedup.push(k);
  }
  return dedup;
}

/**
 * Titl: jedan tok po bucket-u (en/sr/hr/bs), prvo bolji kodek (subrip pre ass).
 * Redosled jezika: SUBS_LANG_PREF (npr. sr,en,hr,bs).
 */
function selectHlsSubs(subs) {
  if (!subs || subs.length === 0) return [];

  const order = subsPreferenceOrder();
  const best = new Map();
  for (const s of subs) {
    const bk = subLangBucket(s);
    if (!bk) continue;
    const cur = best.get(bk);
    if (!cur || subRank(s.codec_name) < subRank(cur.codec_name)) best.set(bk, s);
  }
  const out = [];
  for (const k of order) {
    if (best.has(k)) out.push(best.get(k));
  }
  return out;
}

/** Jezik u HLS master mapu: poznati bucket-i + inače tag iz kontejnera. */
function hlsVariantLanguage(stream, kind) {
  if (kind === 'audio') {
    const b = audioLangBucket(stream);
    if (b === 'ja' || b === 'en') return vmHlsLangForBucket(b);
  } else {
    const b = subLangBucket(stream);
    if (b) return vmHlsLangForBucket(b);
  }
  return probeStreamLangTag(stream);
}

/**
 * audio: string lista indeksa (ffprobe) ili prazno → automatski selectHlsAudios
 * subsKeyPresent: da li klijent šalje query ključ subs (prazan / none → bez titlova)
 */
function applyHlsTrackSelection(plan, { audioParam, subsParam, subsKeyPresent }) {
  if (!plan || !plan.video) return plan;
  const audioByIndex = new Map(plan.audios.map((a) => [a.index, a]));
  const subByIndex = new Map(plan.subs.map((s) => [s.index, s]));

  const audioTrim = audioParam != null ? String(audioParam).trim() : '';
  let audios;
  if (audioTrim) {
    const idxs = audioTrim
      .split(/[,;\s]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n));
    if (!idxs.length) throw new Error('audio: nema indeksa');
    audios = [];
    for (const i of idxs) {
      const a = audioByIndex.get(i);
      if (!a) throw new Error(`audio: nema toka #${i}`);
      audios.push(a);
    }
  } else {
    audios = selectHlsAudios(plan.audios);
  }

  let subs;
  if (!subsKeyPresent) {
    subs = selectHlsSubs(plan.subs);
  } else {
    const st = subsParam == null ? '' : String(subsParam).trim();
    if (!st || st === '-' || st.toLowerCase() === 'none') subs = [];
    else {
      const idxs = st
        .split(/[,;\s]+/)
        .map((x) => parseInt(x, 10))
        .filter((n) => Number.isFinite(n));
      subs = [];
      for (const i of idxs) {
        const s = subByIndex.get(i);
        if (!s) throw new Error(`subs: nema toka #${i}`);
        subs.push(s);
      }
    }
  }

  return { ...plan, audios, subs };
}

function streamKeyForStart(urlParam, fileIdxParsed, audioParam, subsParam, subsKeyPresent) {
  const audioPart =
    audioParam != null && String(audioParam).trim() ? String(audioParam).trim() : 'auto';
  let subsPart = 'auto';
  if (subsKeyPresent) {
    const st = subsParam == null ? '' : String(subsParam).trim();
    subsPart =
      !st || st === '-' || st.toLowerCase() === 'none' ? 'none' : st;
  }
  return `${urlParam}\0${Number.isFinite(fileIdxParsed) ? fileIdxParsed : ''}\0${audioPart}\0${subsPart}`;
}

/**
 * Jedan dug /start koji čeka HLS često ubije tunel (Cloudflare/ngrOk ~100s) — klijent nikad ne dobije 302, folder ostane prazan.
 * Sa HTTPS javnim URL-om ili HLS_NONBLOCKING_START=1: odmah 302 na playlistu; player ponavlja GET dok FFmpeg ne kreira fajl.
 */
const nonBlockingHlsStart =
  process.env.HLS_NONBLOCKING_START === '1' ||
  (process.env.HLS_NONBLOCKING_START !== '0' &&
    process.env.HLS_BLOCKING_START !== '1' &&
    /^https:\/\//i.test(SERVER_BASE_URL));

if (!IPv4 && !NGROK_URL && !process.env.PUBLIC_BASE_URL) {
  logger.warn('Nisam našao LAN IPv4 — postavi PUBLIC_BASE_URL ili NGROK_URL za tablet.');
}

if (NGROK_URL) logger.log(`Koristim ngrok bazu: ${NGROK_URL}`);
else logger.log(`Koristim lokalnu bazu: ${SERVER_BASE_URL}`);

let ffmpegProcess = null;
/** Sprečava dupli /start (Stremio retry) da ne pošalje SIGTERM dok prvi transkod još uvek čeka pakete. */
let activeStreamKey = null;
let encodeGeneration = 0;
/** Raste na svaki novi /start posle duplicate-checka; odbacuje stari deferred magnet pipeline. */
let encodeSession = 0;
/** Magnet + pipe: klijent već dobio 302, čeka se WebTorrent/ffprobe pre FFmpeg. */
let pendingDeferredMagnetStart = false;

const manifest = {
  id: 'org.local.rd-hls',
  version: '1.0.20',
  name: 'Local HLS (Stremio + browser)',
  description:
    'Torrentio → FFmpeg HLS u Stremiu. Simple stream.m3u8: bez odvojenih WebVTT segmenata (Stremio). Titlovi u simple: HLS_SIMPLE_SUBS_VTT=1 (browser). SUBS_LANG_PREF. RD_API_TOKEN / RD_DISABLE.',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
};

function episodeLabelFromStremioId(stremioId, mediaType) {
  if (!stremioId || mediaType === 'movie') return '';
  const m = /^tt\d+:(\d+):(\d+)$/i.exec(String(stremioId).trim());
  if (m) return `Sezona ${m[1]}, epizoda ${m[2]}`;
  return String(stremioId).slice(0, 24);
}

function formatTorrentioForStremio(entry, index, total, episodeLine) {
  const raw = String(entry.title || entry.filename || 'Nepoznat torrent');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] || raw;
  const detailLines = lines.slice(1, 6);
  const bits = [`${index + 1}/${total}`];
  if (entry.peerScore) bits.push(`👤 ${entry.peerScore}`);
  if (entry.sizeBytes != null)
    bits.push(`💾 ${(entry.sizeBytes / (1024 * 1024)).toFixed(1)} MiB`);
  const sub = entry.infoHash ? `BTIH ${String(entry.infoHash).slice(0, 8)}…` : '';
  let desc = bits.join(' · ');
  if (episodeLine) desc = `${episodeLine}\n${desc}`;
  desc += `\n\n${head}`;
  if (detailLines.length) desc += `\n${detailLines.join('\n')}`;
  if (sub) desc += `\n${sub}`;
  desc +=
    '\n\nPlay = u Stremiu (video+zvuk bez odvojenih WebVTT segmenata). Titlovi u browseru: server sa HLS_SIMPLE_SUBS_VTT=1. SUBS_LANG_PREF, /start?subs= indeksi. Audio: AUDIO_LANG_PREF.';
  return { head: head.slice(0, 92), description: desc.slice(0, 950) };
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ id, type }) => {
  logger.log(`Request for stream: type=${type}, id=${id}`);

  try {
    const list = await getStreamLinksFromTorrentio(id, type || 'series');
    if (!list || list.length === 0) {
      logger.log(`Nema Torrentio izvora za id: ${id}`);
      return { streams: [] };
    }

    const maxPick = Math.max(1, Math.min(15, Number(process.env.TORRENT_PICK_COUNT) || 8));
    const n = Math.min(list.length, maxPick);
    const streams = [];
    const epLine = episodeLabelFromStremioId(id, type);

    for (let i = 0; i < n; i++) {
      const { head, description } = formatTorrentioForStremio(list[i], i, n, epLine);
      const label = i === 0 ? `▶ ${head}` : `#${i + 1} · ${head}`;
      const watchUrl = `${SERVER_BASE_URL}/hls/watch?stremioId=${encodeURIComponent(id)}&type=${encodeURIComponent(type || 'series')}&torIdx=${i}`;
      const startExtra = (process.env.STREMIO_START_QUERY || '').trim().replace(/^\?/, '');
      const startAmp = startExtra ? `&${startExtra}` : '';
      const playInAppUrl = `${SERVER_BASE_URL}/start?stremioId=${encodeURIComponent(id)}&type=${encodeURIComponent(type || 'series')}&torIdx=${i}&stremio=1${startAmp}`;
      let streamDescription = description;
      if (process.env.STREMIO_EXTERNAL_WATCH !== '1') {
        streamDescription =
          `${description}\n\nBrowser: ${watchUrl}`.slice(0, 950);
      }
      const st = {
        name: i === 0 ? 'Lokalni HLS — najbolji kandidat' : `Lokalni HLS — alternativa ${i + 1}`,
        title: label,
        description: streamDescription,
        behaviorHints: {
          bingeGroup: `local-hls-${id}-${type || 'series'}`,
        },
        /** Samo ovo — ako postoji externalUrl, mnogi Stremio klijenti uvek otvaraju novi tab. */
        url: playInAppUrl,
      };
      if (process.env.STREMIO_EXTERNAL_WATCH === '1') {
        st.externalUrl = watchUrl;
      }
      streams.push(st);
    }

    logger.log(`Stremio: ${streams.length} stream(ova) sa detaljnim opisom`);

    return { streams };
  } catch (err) {
    logger.error('Error in stream handler:', err);
    return { streams: [] };
  }
});

function clearHLSFolder() {
  try {
    if (!fs.existsSync(HLS_DIR)) {
      fs.mkdirSync(HLS_DIR, { recursive: true });
      return;
    }

    const files = fs.readdirSync(HLS_DIR);
    let deletedCount = 0;
    for (const file of files) {
      if (
        file.endsWith('.ts') ||
        file.endsWith('.m4s') ||
        file.endsWith('.mp4') ||
        file.endsWith('.m3u8') ||
        file.endsWith('.vtt')
      ) {
        const filePath = path.join(HLS_DIR, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
          logger.debug(`Deleted HLS file: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete HLS file ${file}:`, err.message);
        }
      }
    }
    logger.log(`HLS folder cleared: deleted ${deletedCount} old HLS fajlova`);
  } catch (err) {
    logger.error('Error clearing HLS folder:', err);
  }
}

/** Dupli /start: čekaj isti kriterijum kao runPipeline pre 302 — inače Stremio dobije prazan manifest. */
async function waitUntilHlsPlaylistReady(basename, maxWaitSec) {
  const playlistPath = path.join(HLS_DIR, basename);
  const pollMs = 500;
  const maxIter = Math.ceil((maxWaitSec * 1000) / pollMs);
  for (let i = 0; i < maxIter; i++) {
    if (!ffmpegProcess || ffmpegProcess.killed) return false;
    if (fs.existsSync(playlistPath)) {
      try {
        const playlistStats = fs.statSync(playlistPath);
        if (playlistStats.size > 32) {
          const playlistContent = fs.readFileSync(playlistPath, 'utf8');
          if (playlistContent.length < 30) {
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          if (basename === 'master.m3u8') {
            if (!playlistContent.includes('#EXT-X-STREAM-INF')) {
              await new Promise((r) => setTimeout(r, pollMs));
              continue;
            }
          } else {
            if (!playlistContent.includes('.ts') && !playlistContent.includes('.m4s')) {
              await new Promise((r) => setTimeout(r, pollMs));
              continue;
            }
          }
          const segNames = fs
            .readdirSync(HLS_DIR)
            .filter((f) => f.endsWith('.ts') || f.endsWith('.m4s'));
          let bigSeg = null;
          for (const f of segNames) {
            const st = fs.statSync(path.join(HLS_DIR, f));
            if (st.size > 12000) {
              bigSeg = f;
              break;
            }
          }
          if (bigSeg) return true;
        }
      } catch (_) {
        /* poll again */
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/** ffprobe metapodaci; ili url+fileIdx ili stremioId+type+torIdx. */
app.get('/hls/probe', async (req, res) => {
  let urlParam = req.query.url || null;
  let fileIdxParsed =
    req.query.fileIdx != null && req.query.fileIdx !== ''
      ? parseInt(String(req.query.fileIdx), 10)
      : NaN;

  if (req.query.stremioId && req.query.type) {
    const torI = parseInt(String(req.query.torIdx ?? '0'), 10) || 0;
    try {
      const r = await resolveStremioSource(req.query.stremioId, req.query.type, torI);
      if (!r) return res.status(404).json({ error: 'Nema torrenta' });
      if (r.kind === 'http') {
        urlParam = r.url;
        fileIdxParsed = NaN;
      } else {
        urlParam = r.magnet;
        fileIdxParsed = r.fileIdx;
      }
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  if (!urlParam) return res.status(400).json({ error: 'Missing url ili stremioId+type' });

  try {
    const { probeSourceUrl } = await resolveStreamInput(urlParam, fileIdxParsed);
    if (!probeSourceUrl) {
      return res.status(500).json({ error: 'Nema probe URL' });
    }
    const probed = await ffprobeJson(probeSourceUrl);
    const plan = planHlsFromProbe(probed);
    const suggestedAudio = selectHlsAudios(plan.audios).map((a) => a.index);
    const suggestedSubs = selectHlsSubs(plan.subs).map((s) => s.index);
    const audios = plan.audios.map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: a.channels,
      lang: (a.tags && a.tags.language) || '',
      title: (a.tags && a.tags.title) || '',
      default: !!(a.disposition && Number(a.disposition.default) === 1),
    }));
    const subs = plan.subs.map((s) => ({
      index: s.index,
      codec: s.codec_name,
      lang: (s.tags && s.tags.language) || '',
      title: (s.tags && s.tags.title) || '',
    }));
    /** Svi titl tokovi u fajlu (uključujući PGS/hd_mv2) — addon u HLS muxuje samo tekst (subs). */
    const allSubtitleStreams = (probed.streams || [])
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        lang: (s.tags && s.tags.language) || '',
        title: (s.tags && s.tags.title) || '',
      }));
    const payload = {
      video: plan.video
        ? { index: plan.video.index, codec: plan.video.codec_name }
        : null,
      audios,
      subs,
      allSubtitleStreams,
      suggestedAudio,
      suggestedSubs,
    };
    if (subs.length === 0 && allSubtitleStreams.length > 0) {
      payload.note =
        'U fajlu su titlovi, ali nisu tekstualni (npr. samo PGS) — u HLS ih ovaj addon ne stavlja; treba release sa SRT/ASS ili poseban režim.';
    } else if (subs.length === 0 && allSubtitleStreams.length === 0) {
      payload.note = 'Kontejner nema titl tokova.';
    }
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/hls/resolve', async (req, res) => {
  const stremioId = req.query.stremioId;
  const type = req.query.type;
  const torIdx = parseInt(String(req.query.torIdx ?? '0'), 10) || 0;
  if (!stremioId || !type) {
    return res.status(400).json({ error: 'stremioId i type su obavezni' });
  }
  try {
    const r = await resolveStremioSource(stremioId, type, torIdx);
    if (!r) return res.status(404).json({ error: 'Nema izvora' });
    const nextIdx = r.torIdx + 1;
    const hasNext = nextIdx < r.total;
    const nextUrl = hasNext
      ? `${SERVER_BASE_URL}/hls/watch?stremioId=${encodeURIComponent(stremioId)}&type=${encodeURIComponent(type)}&torIdx=${nextIdx}`
      : null;
    return res.json({
      kind: r.kind,
      magnet: r.kind === 'magnet' ? r.magnet : null,
      url: r.kind === 'http' ? r.url : null,
      fileIdx: r.kind === 'magnet' ? r.fileIdx : 0,
      displayTitle: r.displayTitle,
      pageTitle: `${r.displayTitle.slice(0, 72)} — HLS`,
      episodeLabel: episodeLabelFromStremioId(stremioId, type),
      torIdx: r.torIdx,
      total: r.total,
      hasNext,
      nextUrl,
      playbackHint:
        'Nije live TV: FFmpeg još snima segmente. Premotaj samo na deo koji je već transkodovan (inče će plejer čekati). Titl: uključi “titlovi” u browseru ako ih HLS uključi.',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.options('/start', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.get('/start', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Location, X-HLS-Playlist, Retry-After');
  let urlParam = req.query.url || null;
  let fileIdxParsed =
    req.query.fileIdx != null && req.query.fileIdx !== ''
      ? parseInt(String(req.query.fileIdx), 10)
      : NaN;

  let stremioKeyExtra = '';
  if (req.query.stremioId && req.query.type) {
    const torI = parseInt(String(req.query.torIdx ?? '0'), 10) || 0;
    stremioKeyExtra = `${req.query.stremioId}\0${req.query.type}\0${torI}`;
    try {
      const r = await resolveStremioSource(req.query.stremioId, req.query.type, torI);
      if (!r) {
        return res.status(404).type('text/plain').send('Nema tog torrenta (Torrentio / RD).');
      }
      if (r.kind === 'http') {
        urlParam = r.url;
        fileIdxParsed = NaN;
      } else {
        urlParam = r.magnet;
        fileIdxParsed = r.fileIdx;
      }
    } catch (e) {
      return res.status(500).type('text/plain').send(e.message || String(e));
    }
  }

  if (!urlParam) return res.status(400).send('Nedostaje url ili stremioId+type');

  /** Ugrađeni Stremio (tablet/TV): ne šalji odmah 302 na follow-playlist i ne koristi non-blocking /start — 503 na manifestu često daje „Playback error”. */
  const stremioPlayer =
    req.query.stremio === '1' ||
    req.query.stremio === 'true' ||
    String(req.query.stremio || '').toLowerCase() === 'yes';

  const audioQ = req.query.audio;
  const subsQ = req.query.subs;
  const subsKeyPresent = Object.prototype.hasOwnProperty.call(req.query, 'subs');
  const streamKey =
    (stremioKeyExtra ? `${stremioKeyExtra}\0` : '') +
    streamKeyForStart(urlParam, fileIdxParsed, audioQ, subsQ, subsKeyPresent);

  try {
    if (ffmpegProcess && activeStreamKey === streamKey) {
      const plName = activeHlsPlaylistFile;
      logger.log(
        'Isti izvor — Stremio je ponovo pozvao /start; čekam spreman manifest (bez ovoga Stremio dobije prazan playlist).'
      );
      const maxWait = Math.max(
        30,
        Number(process.env.HLS_READY_MAX_WAIT_SEC) || 600
      );
      const ready = await waitUntilHlsPlaylistReady(plName, maxWait);
      if (!ready) {
        return res
          .status(503)
          .setHeader('Retry-After', '2')
          .type('text/plain')
          .send('HLS se još generiše — pokušaj ponovo za 1–2 s.');
      }
      res.setHeader('X-HLS-Playlist', plName);
      return res.redirect(302, `${SERVER_BASE_URL}/hls/${plName}`);
    }

    activeHlsPlaylistFile = 'stream.m3u8';

    if (pendingDeferredMagnetStart && activeStreamKey === streamKey) {
      logger.log(
        'Isti magnet — ponovljen /start dok se još priprema WebTorrent/ffprobe; šaljem follow-playlistu.'
      );
      res.setHeader('X-HLS-Playlist', HLS_FOLLOW_PLAYLIST);
      return res.redirect(302, hlsPlaylistFollowAbsUrl());
    }

    encodeSession += 1;
    const session = encodeSession;
    pendingDeferredMagnetStart = false;

    if (ffmpegProcess) {
      logger.log('Stopping previous FFmpeg process...');
      try {
        ffmpegProcess.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 1000));
        if (ffmpegProcess && !ffmpegProcess.killed) {
          logger.warn('FFmpeg still running, using SIGKILL...');
          ffmpegProcess.kill('SIGKILL');
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        logger.warn('Error stopping FFmpeg process:', err.message);
      }
      ffmpegProcess = null;
    }

    await destroyWebTorrentSession();

    logger.log('Clearing old HLS segments...');
    clearHLSFolder();

    const useDeferredMagnetPipeline =
      !stremioPlayer &&
      process.env.HLS_BLOCKING_START !== '1' &&
      urlParam.startsWith('magnet:') &&
      process.env.WEBTORRENT_FFMPEG_HTTP !== '1';

    if (stremioPlayer) {
      logger.log(
        'Stremio plejer (stremio=1): blokirajući /start do prvog segmenta — bez follow-playlist / 503 na manifestu.'
      );
    }

    const runPipeline = async () => {
      if (session !== encodeSession) {
        logger.warn('runPipeline: odbačeno na ulazu (noviji /start)');
        return;
      }
      let directUrl = null;
      let wtReadStream = null;
      let probeSourceUrl = null;
      try {
        ({ directUrl, wtReadStream, probeSourceUrl } = await resolveStreamInput(
          urlParam,
          fileIdxParsed
        ));
      } catch (e) {
        if (!res.headersSent) return res.status(400).send(e.message || String(e));
        logger.error('Deferred: resolveStreamInput', e.message || e);
        if (session === encodeSession) {
          pendingDeferredMagnetStart = false;
          activeStreamKey = null;
        }
        return;
      }

      if (session !== encodeSession) {
        logger.warn('runPipeline: odbačeno posle resolveStreamInput (noviji /start)');
        return;
      }

      if (!directUrl && !wtReadStream) {
        logger.error('Nema ulaza za FFmpeg (RD unrestrict ili WebTorrent).');
        if (!res.headersSent) return res.status(500).send('Failed to resolve input URL');
        if (session === encodeSession) {
          pendingDeferredMagnetStart = false;
          activeStreamKey = null;
        }
        return;
      }

      let hlsPlan = null;
      if (probeSourceUrl && process.env.HLS_SIMPLE !== '1') {
        try {
          const probed = await ffprobeJson(probeSourceUrl);
          hlsPlan = planHlsFromProbe(probed);
          const subAll = (probed.streams || []).filter((s) => s.codec_type === 'subtitle');
          if (subAll.length > 0 && hlsPlan.subs.length === 0) {
            const names = subAll.map((s) => s.codec_name || '?').join(', ');
            logger.log(
              `Titlovi u kontejneru (${subAll.length}): ${names} — nema tekstualnih (SRT/ASS/VTT); PGS/VobSub ne idu u HLS bez posebnog režima.`
            );
          }
          logger.log(
            `ffprobe: ${hlsPlan.audios.length} audio, ${hlsPlan.subs.length} tekst titl (PGS/DVB preskočeni).`
          );
        } catch (e) {
          logger.warn('ffprobe failed:', e?.message || String(e));
          hlsPlan = null;
        }
      }

      if (session !== encodeSession) {
        logger.warn('runPipeline: preskočeno posle ffprobe (noviji /start ili dupli zahtev — stari zahtev nema odgovor)');
        return;
      }

      if (hlsPlan) {
        try {
          hlsPlan = applyHlsTrackSelection(hlsPlan, {
            audioParam: audioQ,
            subsParam: subsQ,
            subsKeyPresent,
          });
        } catch (e) {
          if (!res.headersSent) return res.status(400).send(e.message || String(e));
          logger.error('Deferred: HLS track izbor', e.message || e);
          if (session === encodeSession) {
            pendingDeferredMagnetStart = false;
            activeStreamKey = null;
          }
          return;
        }
        logger.log(
          `HLS izbor: ${hlsPlan.audios.length} audio, ${hlsPlan.subs.length} titl (audio/subs query ili auto).`
        );
      }

      if (hlsPlan) {
        const muxTextSubsInHls =
          process.env.HLS_NO_PIPE_SUBS !== '1' &&
          process.env.HLS_EXCLUDE_TEXT_SUBS !== '1' &&
          process.env.HLS_INCLUDE_TEXT_SUBS !== '0';
        if (!muxTextSubsInHls && hlsPlan.subs.length > 0) {
          logger.log(
            'Tekstualni titlovi isključeni (HLS_EXCLUDE_TEXT_SUBS=1 ili HLS_INCLUDE_TEXT_SUBS=0 ili HLS_NO_PIPE_SUBS=1).'
          );
          hlsPlan = { ...hlsPlan, subs: [] };
        }
      }

      /**
       * WebTorrent stdin + FFmpeg master HLS (više audio / titl u var_stream_map) često ruši
       * proces (SIGSEGV). Pouzdano: jedan izabrani audio, jedan playlist, bez titlova u muxu.
       * Pun master: WEBTORRENT_FFMPEG_HTTP=1 (FFmpeg čita HTTP sa lokalnog WT servera) ili RD HTTP URL.
       */
      if (hlsPlan && wtReadStream && process.env.HLS_PIPE_MASTER !== '1') {
        const pick = pickPreferredAudioTrack(hlsPlan.audios);
        let subsKeep = hlsPlan.subs;
        if (subsKeep.length > 1) subsKeep = [subsKeep[0]];
        hlsPlan = { ...hlsPlan, audios: pick ? [pick] : [], subs: subsKeep };
        logger.log(
          `WebTorrent pipe: 1 audio (#${pick?.index}); titl u mux: ${subsKeep.length ? `#${subsKeep[0].index}` : 'ne'}; bez master HLS na pipe.`
        );
      }

      let useHlsMaster =
        hlsPlan &&
        hlsPlan.video &&
        (hlsPlan.audios.length > 1 || hlsPlan.subs.length > 0) &&
        process.env.HLS_NO_MASTER !== '1';

      if (wtReadStream && process.env.HLS_PIPE_MASTER !== '1') {
        useHlsMaster = false;
      }

      if (useHlsMaster) {
        activeHlsPlaylistFile = 'master.m3u8';
      } else {
        activeHlsPlaylistFile = 'stream.m3u8';
      }

      /**
       * Jednostavan stream.m3u8 + -c:s webvtt pravi stream_vtt.m3u8 i par .vtt po segmentu.
       * Stremio često ne pušta video/zvuk (plejer zaglavi na titl manifestu ili krivom toku).
       * Master HLS (više audio/titl) koristi drugačiji raspored fajlova.
       */
      if (
        hlsPlan &&
        hlsPlan.subs.length > 0 &&
        !useHlsMaster &&
        process.env.HLS_SIMPLE_SUBS_VTT !== '1'
      ) {
        logger.log(
          'Simple HLS (samo stream.m3u8 + streamN.ts): titlovi isključeni — odvojeni WebVTT segmenti kvare Stremio. Za titlove u browseru: HLS_SIMPLE_SUBS_VTT=1. Za master varijantu: WEBTORRENT_FFMPEG_HTTP=1 i dovoljno audio/titl tokova za master.m3u8.'
        );
        hlsPlan = { ...hlsPlan, subs: [] };
      }

      const playlistPath = path.join(HLS_DIR, activeHlsPlaylistFile);

      logger.log(
        wtReadStream
          ? `Starting FFmpeg (WebTorrent → stdin pipe)${useHlsMaster ? ' + master HLS (audio/titl)' : ''}…`
          : `Starting FFmpeg stream for: ${String(directUrl).substring(0, 72)}…`
      );

      let ffmpegStderr = '';
      const isLocalWt =
        wtReadStream != null ||
        (typeof directUrl === 'string' &&
          (directUrl.startsWith('http://127.0.0.1:') || directUrl.startsWith('http://localhost:')));

      /** WebTorrent + HEVC transkod na CPU često treba minut(e) da upiše prvi .ts — 30s je premalo. */
      const maxWaitSec = Math.max(
        30,
        Number(process.env.HLS_READY_MAX_WAIT_SEC) || (isLocalWt ? 600 : 120)
      );
      const pollMs = 500;
      const maxIterations = Math.ceil((maxWaitSec * 1000) / pollMs);

      /**
       * WebTorrent HTTP može dugo da "ćuti" dok ne stigne naredni komad — premali rw_timeout ubije FFmpeg
       * ~kod 10 min (600s). 134 segmenta × 4s ≈ 9 min — često se poklapa sa starim defaultom.
       * mikrosekunde; podrazumevano 4h za lokalni WT, ili FFMPEG_RW_TIMEOUT_US (npr. 86400000000 = 24h).
       */
      const rwTimeoutUs = isLocalWt
        ? process.env.FFMPEG_RW_TIMEOUT_US || String(4 * 3600 * 1_000_000) /* 4 h, µs */
        : '120000000';

      /** Spor HTTP + veliki MKV / HEVC; za stdin pipe nema rw_timeout / HTTP reconnect. */
      const inputOpts = [
        '-hide_banner',
        '-loglevel',
        isLocalWt ? 'info' : 'warning',
        '-thread_queue_size',
        '2048',
        '-protocol_whitelist',
        wtReadStream
          ? 'file,http,https,tcp,tls,crypto,data,subfile,pipe,fd'
          : 'file,http,https,tcp,tls,crypto,data,subfile',
        '-analyzeduration',
        '100M',
        '-probesize',
        '100M',
        '-fflags',
        process.env.FFMPEG_INPUT_FLAGS || '+genpts',
      ];
      if (!wtReadStream) {
        inputOpts.push('-rw_timeout', rwTimeoutUs);
        if (isLocalWt) {
          inputOpts.push(
            '-reconnect',
            '1',
            '-reconnect_streamed',
            '1',
            '-reconnect_delay_max',
            String(process.env.FFMPEG_RECONNECT_DELAY_MAX_SEC || '60'),
            '-seekable',
            '0'
          );
        } else {
          inputOpts.push(
            '-reconnect',
            '1',
            '-reconnect_streamed',
            '1',
            '-reconnect_delay_max',
            '10'
          );
        }
      }

      const hlsTimeNum = Math.max(
        2,
        Number(process.env.HLS_SEGMENT_SEC) || (isLocalWt ? 4 : 6)
      );
      const hlsTime = String(hlsTimeNum);
      /** GOP ≈ fps×segment — stabilniji prvi frejm na ExoPlayeru/Stremiju (stari -g 48 sa 4s segment = slika „zaleđena”, zvuk ide). */
      const fpsOut = 24000 / 1001;
      const gopFrames = Math.max(
        48,
        Math.min(480, Math.round(fpsOut * hlsTimeNum))
      );
      const x264Preset = process.env.HLS_X264_PRESET || 'veryfast';
      const h264Profile = process.env.HLS_X264_PROFILE || 'baseline';
      const h264Level = process.env.HLS_X264_LEVEL || '3.1';
      const x264Tune =
        process.env.HLS_X264_TUNE === 'none'
          ? []
          : ['-tune', process.env.HLS_X264_TUNE || 'fastdecode'];
      if (session !== encodeSession) {
        logger.warn('runPipeline: preskočeno pre FFmpeg spawna (noviji /start)');
        return;
      }
      const myGen = ++encodeGeneration;
      activeStreamKey = streamKey;

      const videoEncode = [
        '-max_muxing_queue_size',
        '4096',
        '-avoid_negative_ts',
        'make_zero',
        '-c:v',
        'libx264',
        '-preset',
        x264Preset,
        ...x264Tune,
        '-profile:v',
        h264Profile,
        '-level',
        h264Level,
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'scale=min(1280\\,iw):-2:flags=fast_bilinear,format=yuv420p,setsar=1,fps=24000/1001',
        '-g',
        String(gopFrames),
        '-keyint_min',
        String(gopFrames),
        '-sc_threshold',
        '0',
        '-force_key_frames',
        `expr:gte(t,n_forced*${hlsTime})`,
        '-x264-params',
        'repeat-headers=1',
        '-b:v',
        '2M',
        '-maxrate',
        '2M',
        '-bufsize',
        '4M',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-ar',
        '48000',
      ];

      let ffmpegArgs;
      if (useHlsMaster) {
        const subs = hlsPlan.subs;
        const mapArgs = ['-map', `0:${hlsPlan.video.index}`];
        hlsPlan.audios.forEach((a) => mapArgs.push('-map', `0:${a.index}`));
        subs.forEach((s) => mapArgs.push('-map', `0:${s.index}`));

        let defaultAudioI = 0;
        const defI = hlsPlan.audios.findIndex(
          (a) => a.disposition && Number(a.disposition.default) === 1
        );
        if (defI >= 0) defaultAudioI = defI;
        else {
          const enI = hlsPlan.audios.findIndex((a) => audioLangBucket(a) === 'en');
          if (enI >= 0) defaultAudioI = enI;
        }

        /**
         * FFmpeg HLS: samostalan unos "s:0,sgroup:…" pravi titl-samo varijantu → mp4 mux
         * "No streams to mux". Titlovi moraju uz video: v:0,agroup:…,s:0[,s:1…],sgroup:sub.
         * Izbegavamo name: u mapu — %v u hls_fmp4_init_filename inače postaje "Aud1" umesto broja.
         */
        const vmParts = [];
        if (subs.length) {
          const subMap = subs.map((_, i) => `s:${i}`).join(',');
          vmParts.push(`v:0,agroup:aud,${subMap},sgroup:sub`);
        } else {
          vmParts.push('v:0,agroup:aud');
        }
        hlsPlan.audios.forEach((a, i) => {
          const lang = hlsVariantLanguage(a, 'audio');
          vmParts.push(
            `a:${i},agroup:aud,language:${lang}${
              i === defaultAudioI ? ',default:yes' : ',default:no'
            }`
          );
        });

        // fMP4 + var_stream_map + titlovi na stdin (WebTorrent pipe) ponekad ruši FFmpeg (SIGSEGV).
        const wantFmp4 =
          subs.length > 0 &&
          process.env.HLS_SUBS_TS !== '1' &&
          (process.env.HLS_FMP4_PIPE === '1' || !wtReadStream);
        const useFmp4Segments = wantFmp4;
        if (subs.length && wtReadStream && !useFmp4Segments && process.env.HLS_SUBS_TS !== '1') {
          logger.log(
            'HLS: titlovi + pipe → MPEG-TS segmenti (fMP4 na pipe često SIGSEGV). HTTP izvor i dalje može fMP4; eksplicitno pipe+fMP4: HLS_FMP4_PIPE=1.'
          );
        }
        const hlsSegOpts = useFmp4Segments
          ? [
              '-hls_segment_type',
              'fmp4',
              '-hls_fmp4_init_filename',
              'hls_init_%v.mp4',
              '-hls_segment_filename',
              path.join(HLS_DIR, 'hls_%v_seg%03d.m4s'),
            ]
          : ['-hls_segment_filename', path.join(HLS_DIR, 'hls_%v_seg%03d.ts')];

        ffmpegArgs = [
          '-y',
          ...inputOpts,
          '-i',
          wtReadStream ? '-' : directUrl,
          ...mapArgs,
          ...videoEncode,
          ...(subs.length ? ['-c:s', 'webvtt'] : []),
          ...ffmpegMuxInterleaveOpts(),
          '-f',
          'hls',
          '-hls_time',
          hlsTime,
          '-hls_list_size',
          '0',
          '-hls_playlist_type',
          'event',
          '-hls_flags',
          'append_list+independent_segments',
          ...hlsSegOpts,
          '-master_pl_name',
          'master.m3u8',
          '-var_stream_map',
          vmParts.join(' '),
          path.join(HLS_DIR, 'hls_var_%v.m3u8'),
        ];
      } else {
        const mapSimple =
          hlsPlan && hlsPlan.video && hlsPlan.audios[0]
            ? [
                '-map',
                `0:${hlsPlan.video.index}`,
                ...(process.env.FFMPEG_AUDIO_MAP
                  ? process.env.FFMPEG_AUDIO_MAP.split(/\s+/).filter(Boolean)
                  : ['-map', `0:${hlsPlan.audios[0].index}`]),
                ...(hlsPlan.subs[0] ? ['-map', `0:${hlsPlan.subs[0].index}`] : []),
              ]
            : [
                '-map',
                '0:v:0',
                ...(process.env.FFMPEG_AUDIO_MAP
                  ? process.env.FFMPEG_AUDIO_MAP.split(/\s+/).filter(Boolean)
                  : ['-map', '0:a:0?']),
              ];
        const subCodec = hlsPlan && hlsPlan.subs[0] ? ['-c:s', 'webvtt'] : [];
        ffmpegArgs = [
          '-y',
          ...inputOpts,
          '-i',
          wtReadStream ? '-' : directUrl,
          ...mapSimple,
          ...videoEncode,
          ...subCodec,
          ...ffmpegMuxInterleaveOpts(),
          '-f',
          'hls',
          '-hls_time',
          hlsTime,
          '-hls_list_size',
          '0',
          '-hls_playlist_type',
          'event',
          ...(HLS_FMP4_SIMPLE
            ? [
                '-hls_segment_type',
                'fmp4',
                '-hls_fmp4_init_filename',
                'stream_init.mp4',
                '-hls_segment_filename',
                path.join(HLS_DIR, 'stream%d.m4s'),
              ]
            : ['-hls_segment_filename', path.join(HLS_DIR, 'stream%d.ts')]),
          '-hls_flags',
          'append_list+independent_segments+program_date_time',
          '-start_number',
          '0',
          path.join(HLS_DIR, 'stream.m3u8'),
        ];
      }

      ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: wtReadStream ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });

      if (session === encodeSession) pendingDeferredMagnetStart = false;

      if (wtReadStream) {
        wtReadStream.pipe(ffmpegProcess.stdin, { end: true });
        wtReadStream.on('error', (e) => logger.warn('WebTorrent read stream:', e.message));
        ffmpegProcess.stdin.on('error', () => {});
      }

      ffmpegProcess.stderr.on('data', (d) => {
        const output = d.toString();
        ffmpegStderr += output;
        const chunks = output.split(/\r\n|\n|\r/);
        for (const raw of chunks) {
          const line = raw.trim();
          if (!line) continue;
          const looksProgress =
            /frame=\s*\d+|speed=\s*[\d.]+x|\bsize=\s*\d+kB|time=\s*[\d:.]+/i.test(line);
          const looksBad =
            /error|invalid|failed|unable|not found|\b403\b|\b404\b|\bhttp\b|protocol|Nothing was written|no packets|signal 15|timed out|timeout/i.test(
              line
            );
          if (looksBad) {
            logger.warn('FFmpeg:', line);
          } else if (looksProgress) {
            logger.debug('FFmpeg:', line);
          } else {
            logger.debug('FFmpeg:', line);
          }
        }
      });

      ffmpegProcess.on('error', (err) => {
        logger.error('FFmpeg process error:', err);
      });

      ffmpegProcess.on('exit', (code, signal) => {
        logger.log(`FFmpeg process exited with code ${code}, signal ${signal}`);
        if (myGen === encodeGeneration) {
          activeStreamKey = null;
        }
        if (code !== 0 && code !== null) {
          const tail = ffmpegStderr.trim().slice(-8000);
          logger.error('FFmpeg stderr (ceo ili kraj):\n' + tail);
        }
        ffmpegProcess = null;
      });

      if (nonBlockingHlsStart && !stremioPlayer) {
        logger.log(
          'Neblokirajući /start (tunel/HTTPS): odmah šaljem 302 na playlistu — WebTorrent/FFmpeg i dalje rade lokalno; player ponavlja zahtev dok .m3u8 nije spreman.'
        );
        if (!res.headersSent) {
          res.setHeader('X-HLS-Playlist', activeHlsPlaylistFile);
          return res.redirect(302, hlsPlaylistAbsUrl());
        }
        return;
      }

      let playlistReady = false;
      let lastProgressLog = 0;
      for (let i = 0; i < maxIterations; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        const elapsedSec = ((i + 1) * pollMs) / 1000;
        if (elapsedSec - lastProgressLog >= 45) {
          lastProgressLog = elapsedSec;
          logger.log(
            `Čekam prvi HLS segment… ${Math.round(elapsedSec)}s / ${maxWaitSec}s (WebTorrent/HEVC može biti spor)`
          );
        }
        if (!ffmpegProcess || ffmpegProcess.killed) {
          logger.warn('FFmpeg je stao pre nego što je HLS playlist spreman — proveri log iznad.');
          break;
        }
        if (!fs.existsSync(playlistPath)) continue;
        const playlistStats = fs.statSync(playlistPath);
        if (playlistStats.size <= 0) continue;
        try {
          const playlistContent = fs.readFileSync(playlistPath, 'utf8');
          if (playlistContent.length < 30) continue;
          const segNames = fs
            .readdirSync(HLS_DIR)
            .filter((f) => f.endsWith('.ts') || f.endsWith('.m4s'));
          let bigSeg = null;
          for (const f of segNames) {
            const st = fs.statSync(path.join(HLS_DIR, f));
            if (st.size > 12000) {
              bigSeg = f;
              break;
            }
          }
          if (!bigSeg) continue;
          if (useHlsMaster) {
            if (!playlistContent.includes('#EXT-X-STREAM-INF')) continue;
            playlistReady = true;
            logger.log(`HLS master + segment ready (${bigSeg})`);
            break;
          }
          if (!playlistContent.includes('.ts') && !playlistContent.includes('.m4s')) continue;
          playlistReady = true;
          logger.log(`HLS playlist and segment ready (${bigSeg})`);
          break;
        } catch (err) {
          logger.warn(`Error reading playlist: ${err.message}`);
        }
      }

      if (!playlistReady) {
        logger.error(
          `HLS nije spreman posle ${maxWaitSec}s — prekidam FFmpeg i vraćam 503 (ne šaljem prazan manifest).`
        );
        encodeGeneration += 1;
        activeStreamKey = null;
        if (session === encodeSession) pendingDeferredMagnetStart = false;
        try {
          if (ffmpegProcess && !ffmpegProcess.killed) ffmpegProcess.kill('SIGTERM');
        } catch (_) {}
        ffmpegProcess = null;
        await destroyWebTorrentSession();
        if (!res.headersSent) {
          return res
            .status(503)
            .type('text/plain')
            .send(
              'HLS još nije spreman (WebTorrent/HEVC transkod traje dugo ili nema peerova). ' +
                'Sačekaj pa ponovi Play u Stremiu; pokušaj torrent sa više 👤. ' +
                `Možeš povećati timeout: HLS_READY_MAX_WAIT_SEC=900`
            );
        }
        return;
      }

      if (!res.headersSent) {
        res.setHeader('X-HLS-Playlist', activeHlsPlaylistFile);
        res.redirect(302, hlsPlaylistAbsUrl());
      }
    };

    if (useDeferredMagnetPipeline) {
      activeHlsPlaylistFile = 'stream.m3u8';
      pendingDeferredMagnetStart = true;
      activeStreamKey = streamKey;
      res.setHeader('X-HLS-Playlist', HLS_FOLLOW_PLAYLIST);
      res.redirect(302, hlsPlaylistFollowAbsUrl());
      logger.log(
        'Deferred magnet: odmah 302 na follow-playlistu (automatski master ako ima titlove) — 30s–3min do prvog segmenta na velikom batchu.'
      );
      void runPipeline().catch((err) => {
        logger.error('Deferred magnet pipeline:', err);
        if (session === encodeSession) {
          pendingDeferredMagnetStart = false;
          activeStreamKey = null;
        }
      });
      return;
    }

    await runPipeline();
    if (!res.headersSent) {
      logger.warn(
        '/start: runPipeline završio bez odgovora (obično noviji Play prekine prethodni — ponovi jednom).'
      );
      return res
        .status(503)
        .type('text/plain')
        .send('Stream prekinut ili zastarel zahtev. Ponovi Play u Stremiu.');
    }
  } catch (err) {
    logger.error('Failed to start stream:', err);
    if (!res.headersSent) res.status(500).send('Failed to start stream');
  }
});

/** Watch u browseru: link iz opisa streama ili STREMIO_EXTERNAL_WATCH=1 (?stremioId&type&torIdx). JS zove /start pa kači HLS. */
app.get('/hls/watch', (req, res) => {
  const qp = (n) => {
    const v = req.query[n];
    if (v == null) return null;
    return Array.isArray(v) ? String(v[0]) : String(v);
  };
  const boot = {
    magnet: qp('magnet'),
    url: qp('url'),
    fileIdx: qp('fileIdx') || '0',
    stremioId: qp('stremioId'),
    stremioType: qp('type'),
    torIdx: qp('torIdx') || '0',
  };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>HLS — Local</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(180deg,#121218 0%,#0a0a0c 100%);color:#e8e8e8;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
.app{max-width:980px;margin:0 auto;padding:0 16px 24px}
.hdr{padding:18px 0 8px;border-bottom:1px solid #2a2a32;margin-bottom:12px}
.badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8ab4ff;background:#1a2332;padding:4px 10px;border-radius:999px;margin-bottom:10px}
#showTitle{font-size:clamp(1rem,2.8vw,1.35rem);font-weight:650;margin:0 0 8px;line-height:1.3;color:#f2f2f2}
.meta{margin:0;font-size:13px;color:#9aa0a6;line-height:1.5}
.subhint{margin:10px 0 0;font-size:12px;color:#b0b8c4;line-height:1.55;padding:10px 12px;background:#1e242c;border-radius:10px;border-left:3px solid #4a90d9}
.status{margin:14px 0;font-size:14px;line-height:1.5;color:#c8d0d8;min-height:2.5em}
.actions{margin-bottom:12px}
#nextTor{padding:11px 18px;font-size:14px;font-weight:500;cursor:pointer;border-radius:10px;border:1px solid #3d5266;background:linear-gradient(180deg,#2c3d4f,#243240);color:#e8eef4;box-shadow:0 2px 8px rgba(0,0,0,.35)}
#nextTor:hover{filter:brightness(1.08)}
.player-wrap{border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.45);border:1px solid #2a2a32}
video{width:100%;max-height:min(72vh,640px);background:#000;display:block;vertical-align:middle}
.tools{margin-top:18px;padding-top:16px;border-top:1px solid #2a2a32;font-size:13px;line-height:1.65;color:#9aa0a6}
.tools .hint{margin:12px 0 0;padding:11px 14px;background:#181c22;border-radius:10px;font-size:12px;line-height:1.55;color:#aeb6bf}
.tools .hint code{font-size:11px;color:#7ec8ff}
.tools a{color:#8ab4ff}
.tools .row{margin:6px 0}
</style>
</head>
<body>
<div class="app">
<header class="hdr">
  <span class="badge">Lokalni transkod</span>
  <h1 id="showTitle">Učitavanje…</h1>
  <p id="metaLine" class="meta"></p>
  <p id="hintLine" class="subhint" style="display:none"></p>
</header>
<div id="status" class="status">Priprema…</div>
<div class="actions"><button type="button" id="nextTor" style="display:none">Sledeći torrent</button></div>
<div class="player-wrap">
<video id="v" controls playsinline webkit-playsinline crossorigin="anonymous"></video>
</div>
<footer class="tools">
  <div class="row"><a id="newtab" href="/hls/watch" target="_blank" rel="noopener">Isti link u novom tabu</a> · samo za debug: <a href="/hls/${HLS_FOLLOW_PLAYLIST}">${HLS_FOLLOW_PLAYLIST}</a>, <a href="/hls/stream.m3u8">stream.m3u8</a>, <a href="/hls/master.m3u8">master.m3u8</a> (ne treba klikati — video iznad se veže sam).</div>
  <p class="hint">Audio: <strong>AUDIO_LANG_PREF</strong>. Stremio: simple HLS bez odvojenih .vtt segmenata. Titlovi u ovom plejeru: pokreni server sa <code>HLS_SIMPLE_SUBS_VTT=1</code>. <code>HLS_FMP4=1</code>, <code>WEBTORRENT_FFMPEG_HTTP=1</code> po potrebi.</p>
</footer>
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js" crossorigin="anonymous"></script>
<script>window.__WD_BOOT=${bootJson};</script>
<script>
(function(){
  var v=document.getElementById('v');
  var st=document.getElementById('status');
  var nt=document.getElementById('newtab');
  var showTitle=document.getElementById('showTitle');
  var metaLine=document.getElementById('metaLine');
  var hintLine=document.getElementById('hintLine');
  var nextTor=document.getElementById('nextTor');
  if(nt) nt.href=location.pathname+location.search;
  var origin=location.origin;
  var boot=window.__WD_BOOT||{};
  var hlsRef=null;

  function tryAutoplay(){
    v.muted=true;
    var p=v.play();
    if(p&&p.catch) p.catch(function(){});
    st.textContent+=' Ako nema zvuka, isključi “utišaj” na videu.';
  }

  function attach(src){
    st.textContent='Plejer: učitavam playlist (nije “live” emitovanje — segmenti nastaju po redu). Ne otvaraj stream.m3u8 ručno; sve ide ovde automatski.';
    if(hlsRef){ try{ hlsRef.destroy(); }catch(_){ } hlsRef=null; }
    if(v.canPlayType('application/vnd.apple.mpegurl')){
      v.src=src;
      v.addEventListener('loadedmetadata',function once(){
        v.removeEventListener('loadedmetadata',once);
        if(v.textTracks&&v.textTracks.length>0){
          v.textTracks[0].mode='showing';
          st.textContent+=' Titlovi: uključena prva staza — proveri CC u kontrolama.';
        }
        tryAutoplay();
      });
      v.addEventListener('error',function(){
        st.textContent='Video greška — proveri playlist (osveži za par sekundi).';
      },{once:true});
    } else if(window.Hls&&Hls.isSupported()){
      var h=new Hls({
        enableWorker:true,
        lowLatencyMode:false,
        maxBufferLength:180,
        maxMaxBufferLength:600,
        liveDurationInfinity:false,
        backBufferLength:120
      });
      hlsRef=h;
      h.loadSource(src);
      h.attachMedia(v);
      h.on(Hls.Events.MANIFEST_PARSED,function(){
        if(h.subtitleTracks&&h.subtitleTracks.length>0){
          h.subtitleTrack=0;
          st.textContent+=' Titlovi iz master playliste uključeni.';
        }
        tryAutoplay();
      });
      h.on(Hls.Events.SUBTITLE_TRACKS_UPDATED,function(){
        if(h.subtitleTracks&&h.subtitleTracks.length>0&&(h.subtitleTrack==null||h.subtitleTrack<0)){
          h.subtitleTrack=0;
          st.textContent+=' Titlovi učitani — uključena prva staza.';
        }
      });
      h.on(Hls.Events.ERROR,function(_,d){
        if(!d||!d.fatal)return;
        if(d.type===Hls.ErrorTypes.NETWORK_ERROR){
          st.textContent='Čekam segment / mrežu… (normalno dok FFmpeg piše .ts)';
          h.startLoad();
        } else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){
          st.textContent='MEDIA_ERROR — oporavak…';
          h.recoverMediaError();
        } else {
          st.textContent='HLS greška: '+d.type+' — probaj osvežiti stranicu.';
        }
      });
    } else {
      st.textContent='Nema ugrađenog HLS u ovom pregledaču — koristi Safari na iPadu.';
    }
  }

  function startQuery(){
    var q;
    if(boot.stremioId&&boot.stremioType){
      q='/start?stremioId='+encodeURIComponent(boot.stremioId)+'&type='+encodeURIComponent(boot.stremioType)+'&torIdx='+encodeURIComponent(boot.torIdx||'0');
    } else {
      q='/start?url='+encodeURIComponent(boot.magnet||boot.url);
      if(boot.magnet) q+='&fileIdx='+encodeURIComponent(boot.fileIdx||'0');
    }
    return q;
  }

  function runStart(){
    st.textContent='Pokrećem transkod (torrent 1–3 min)…';
    fetch(startQuery(),{redirect:'manual',credentials:'same-origin'})
      .then(function(r){
        var playlistUrl=null;
        if(r.status>=300&&r.status<400){
          var loc=r.headers.get('Location');
          if(loc){ try{ playlistUrl=new URL(loc,origin).href; }catch(_){} }
        }
        if(!playlistUrl){
          var hint=r.headers.get('X-HLS-Playlist');
          if(hint) playlistUrl=origin+'/hls/'+hint.replace(/^\\/+/,'');
        }
        if(playlistUrl){
          st.textContent='Povezujem HLS — prvi segment kod batch torrenta može 30s–3min (plejer ponavlja dok FFmpeg ne krene).';
          attach(playlistUrl);
          return;
        }
        if(!r.ok){
          return r.text().then(function(body){
            var msg='Start nije uspeo ('+r.status+').';
            if(body) msg+=' '+(body+'').replace(/\\s+/g,' ').trim().slice(0,280);
            st.textContent=msg;
          });
        }
        st.textContent='Neočekivan odgovor ('+r.status+').';
      })
      .catch(function(e){ st.textContent='Mreža: '+e.message; });
  }

  function init(){
    if(boot.stremioId&&boot.stremioType){
      st.textContent='Biram torrent…';
      var rq='/hls/resolve?stremioId='+encodeURIComponent(boot.stremioId)+'&type='+encodeURIComponent(boot.stremioType)+'&torIdx='+encodeURIComponent(boot.torIdx||'0');
      fetch(rq,{credentials:'same-origin'})
        .then(function(r){return r.json().then(function(j){ return {ok:r.ok,j:j}; });})
        .then(function(x){
          if(!x.ok||!x.j||x.j.error){
            st.textContent='Resolve: '+(x.j&&x.j.error||'greška');
            return;
          }
          var d=x.j;
          if(d.pageTitle) document.title=d.pageTitle;
          if(showTitle) showTitle.textContent=d.displayTitle||'';
          if(metaLine){
            var ml=[];
            if(d.episodeLabel) ml.push(d.episodeLabel);
            ml.push('Torrent u listi: '+(d.torIdx+1)+' / '+d.total);
            metaLine.textContent=ml.join(' · ');
          }
          if(hintLine&&d.playbackHint){
            hintLine.style.display='block';
            hintLine.textContent=d.playbackHint;
          }
          if(v&&d.displayTitle) v.setAttribute('title',d.displayTitle);
          if(nextTor&&d.hasNext&&d.nextUrl){
            nextTor.style.display='block';
            nextTor.textContent='Sledeći torrent ('+(d.torIdx+2)+' / '+d.total+')';
            nextTor.onclick=function(){ location.href=d.nextUrl; };
          }
          runStart();
        })
        .catch(function(e){ st.textContent='Mreža: '+e.message; });
      return;
    }
    if(boot.magnet||boot.url){
      if(showTitle) showTitle.textContent='Direktan magnet/URL';
      document.title='HLS';
      if(v) v.setAttribute('title','HLS');
      runStart();
      return;
    }
    st.textContent='Nema parametara — otvori iz Stremio stream liste.';
    attach(origin+'/hls/stream.m3u8');
  }
  init();
})();
</script>
</body>
</html>`);
});

app.get(`/hls/${HLS_FOLLOW_PLAYLIST}`, (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const names = ['master.m3u8', 'stream.m3u8'];
  for (const name of names) {
    const pl = path.join(HLS_DIR, name);
    try {
      if (fs.existsSync(pl) && fs.statSync(pl).size > 16) {
        return res.redirect(302, `${SERVER_BASE_URL}/hls/${name}`);
      }
    } catch (_) {}
  }
  if (pendingDeferredMagnetStart || (ffmpegProcess && !ffmpegProcess.killed)) {
    res.setHeader('Retry-After', '1');
    return res
      .status(503)
      .type('text/plain')
      .send('HLS se još priprema — sačekaj 1s i osveži (ili plejer sam ponavlja).');
  }
  return res
    .status(404)
    .type('text/plain')
    .send('Nema aktivnog HLS — otvori watch stranicu iz Stremio i pritisni play.');
});

app.use(
  '/hls',
  (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    if (req.method === 'OPTIONS') return res.sendStatus(200);

    next();
  },
  (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const base = path.basename(req.path || '');
    if (base !== 'stream.m3u8' && base !== 'master.m3u8') return next();
    const pl = path.join(HLS_DIR, base);
    if (fs.existsSync(pl)) return next();
    if (ffmpegProcess && !ffmpegProcess.killed) {
      res.setHeader('Retry-After', '2');
      return res
        .status(503)
        .type('text/plain')
        .send('HLS se još generiše (FFmpeg/WebTorrent) — pokušaj ponovo za 1–2 s.');
    }
    next();
  },
  express.static(HLS_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');
      } else if (filePath.endsWith('.m4s') || filePath.endsWith('.mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');
      } else if (filePath.endsWith('.vtt')) {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

app.use(getRouter(builder.getInterface()));

const server = app.listen(PORT, '0.0.0.0');
server.once('listening', () => {
  logger.log(`Stremio addon + HLS server: port ${PORT}`);
  logger.log(`Manifest (dodaj u Stremio): ${SERVER_BASE_URL}/manifest.json`);
  logger.log(`Start URL pattern: ${SERVER_BASE_URL}/start?url=...`);
  logger.log(`HLS playlist (posle /start): ${hlsPlaylistAbsUrl()}`);
  logger.log(`Plejer u browseru (tablet / novi tab): ${SERVER_BASE_URL}/hls/watch`);
  if (nonBlockingHlsStart) {
    logger.log(
      'Režim tunela: /start ne drži otvoren HTTP odgovor dok HLS ne krene (izbegava timeout tunela). Za staro blokiranje na LAN+HTTPS: HLS_BLOCKING_START=1'
    );
  }
  logger.log(
    `Sa tableta (isti WiFi): koristi http://<IP-racunara>:${PORT}/manifest.json ili PUBLIC_BASE_URL`
  );
  if (HLS_FMP4_SIMPLE) {
    logger.log('HLS: fMP4 segmenti (HLS_FMP4=1) — umesto .ts koriste se .m4s + stream_init.mp4');
  }
  if (process.env.CLEAR_HLS_ON_BOOT === '1') {
    clearHLSFolder();
    logger.log('CLEAR_HLS_ON_BOOT=1: očišćen hls/ pri startu servera');
  }
  const muxIv = ffmpegMuxInterleaveOpts();
  logger.log(
    muxIv.length
      ? `FFmpeg mux: ${muxIv[0]} ${muxIv[1]}`
      : 'FFmpeg mux: bez max_interleave_delta (podrazumevano); eksplicitno 0: FFMPEG_MAX_INTERLEAVE_DELTA_US=0'
  );
  logger.log(
    `Titlovi: Stremio simple = bez WebVTT segmenata (HLS_SIMPLE_SUBS_VTT=1 za browser); SUBS_LANG_PREF=${subsPreferenceOrder().join(',')}`
  );
  const sq = (process.env.STREMIO_START_QUERY || '').trim();
  if (sq) logger.log(`Stremio /start: dodatak iz STREMIO_START_QUERY — ${sq}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${PORT} je već zauzet (EADDRINUSE). Ugasi drugi proces na tom portu ili pokreni npr. PORT=3001 npm start (i isti PORT u PUBLIC_BASE_URL).`
    );
  } else {
    logger.error('Ne mogu da otvorim port — server greška:', err.message || err);
  }
  process.exit(1);
});
