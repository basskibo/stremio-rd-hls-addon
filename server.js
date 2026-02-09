import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { unrestrictRD, unrestrictRDFromId } from './rd_helper.js';
import logger from './logger.js';
import pkg from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// HLS folder
const HLS_DIR = path.join(__dirname, 'hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR);


// Dohvati lokalni IPv4
const interfaces = os.networkInterfaces();
let IPv4 = null;
for (const name of Object.keys(interfaces)) {
  for (const iface of interfaces[name]) {
    if (iface.family === 'IPv4' && !iface.internal) {
      IPv4 = iface.address;
    }
  }
}

// Koristi ngrok URL ako je postavljen, inače lokalnu IP
const NGROK_URL = process.env.NGROK_URL || null;
let SERVER_BASE_URL = null;
if (NGROK_URL) {
  SERVER_BASE_URL = NGROK_URL;
  logger.log(`Using ngrok URL: ${NGROK_URL}`);
} else {
  SERVER_BASE_URL = `http://${IPv4}:${PORT}`;
  logger.log(`Using local IP: ${SERVER_BASE_URL}`);
}

let ffmpegProcess = null;

// Stremio addon manifest i stream handler
const manifest = {
  id: 'org.local.rd-hls',
  version: '1.0.0',
  name: 'Local RD HLS',
  description: 'Streams via local FFmpeg server',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ id, type }) => {
  logger.log(`Request for stream: type=${type}, id=${id}`);
  
  try {
    const rdLink = await unrestrictRDFromId(id, type);
    if (!rdLink) {
      logger.log(`No RD link found for id: ${id}`);
      return { streams: [] };
    }
  
    const startUrl = `${SERVER_BASE_URL}/start?url=${encodeURIComponent(rdLink)}`;
    logger.log(`Returning stream URL: ${startUrl}`);
    
    return {
      streams: [
        {
          name: 'Local PC (HLS)',
          title: 'RD → FFmpeg → HLS',
          url: startUrl
        }
      ]
    };
  } catch (err) {
    logger.error('Error in stream handler:', err);
    return { streams: [] };
  }
});

// serveHTTP servira HTML stranicu i JSON endpoint-e
// Ali možda ne sluša na svim interfejsima - probajmo da serviramo addon endpoint-e direktno kroz Express
// na isti način kao serveHTTP
const addonInterface = builder.getInterface();

// Serviraj manifest.json kroz Express (kao serveHTTP)
app.get('/manifest.json', (req, res) => {
  // Ako je browser zahtev (Accept: text/html), serviraj HTML stranicu
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    const manifest = addonInterface.manifest;
    res.send(`<!DOCTYPE html>
<html style="background-image: url(https://dl.strem.io/addon-background.jpg);">
<head>
  <meta charset="utf-8">
  <title>${manifest.name} - Stremio Addon</title>
  <style>
    * { box-sizing: border-box; }
    body, html { margin: 0; padding: 0; width: 100%; min-height: 100%; }
    body { display: flex; align-items: center; justify-content: center; font-family: Arial, sans-serif; }
    .container { text-align: center; background: rgba(0,0,0,0.8); padding: 40px; border-radius: 10px; }
    .icon { width: 100px; height: 100px; margin: 0 auto 20px; background: #9F3ED5; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
    .icon::after { content: '▶'; color: white; font-size: 50px; }
    h1 { color: white; margin: 0 0 10px; }
    .version { color: #ccc; margin: 0 0 20px; }
    .description { color: #ccc; margin: 0 0 30px; }
    .install-link { display: inline-block; }
    button { background: #9F3ED5; color: white; border: none; padding: 15px 30px; font-size: 18px; border-radius: 5px; cursor: pointer; }
    button:hover { background: #8E2FC4; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon"></div>
    <h1>${manifest.name}</h1>
    <div class="version">v${manifest.version}</div>
    <div class="description">${manifest.description}</div>
    <a id="installLink" class="install-link" href="stremio://${req.headers.host || 'localhost:3000'}/manifest.json">
      <button>INSTALL</button>
    </a>
  </div>
  <script>
    document.getElementById('installLink').href = 'stremio://' + window.location.host + '/manifest.json';
  </script>
</body>
</html>`);
  } else {
    // Ako je JSON zahtev, serviraj manifest
    res.json(addonInterface.manifest);
  }
});

// Serviraj stream endpoint-e kroz Express (kao serveHTTP)
app.get('/:resource/:type/:id.json', async (req, res) => {
  const { resource, type, id } = req.params;
  
  try {
    if (resource === 'stream' && addonInterface.stream) {
      const result = await addonInterface.stream({ type, id });
      res.json(result);
    } else if (resource === 'catalog' && addonInterface.catalog) {
      const result = await addonInterface.catalog({ type, id });
      res.json(result);
    } else if (resource === 'meta' && addonInterface.meta) {
      const result = await addonInterface.meta({ type, id });
      res.json(result);
    } else {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (err) {
    logger.error('Error handling addon request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
  
// Funkcija za čišćenje HLS foldera
function clearHLSFolder() {
  try {
    if (!fs.existsSync(HLS_DIR)) {
      fs.mkdirSync(HLS_DIR, { recursive: true });
      return;
    }
    
    const files = fs.readdirSync(HLS_DIR);
    files.forEach(file => {
      const filePath = path.join(HLS_DIR, file);
      try {
        fs.unlinkSync(filePath);
        logger.debug(`Deleted HLS file: ${file}`);
      } catch (err) {
        logger.warn(`Failed to delete HLS file ${file}:`, err.message);
      }
    });
    logger.log('HLS folder cleared');
  } catch (err) {
    logger.error('Error clearing HLS folder:', err);
  }
}

// Pokretanje FFmpeg streama
app.get('/start', async (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) return res.send("Missing url in params");

  try {
    // Zaustavi stari FFmpeg proces ako postoji
    if (ffmpegProcess) {
      logger.log('Stopping previous FFmpeg process...');
      ffmpegProcess.kill("SIGKILL");
      ffmpegProcess = null;
      // Sačekaj malo da se proces zaista završi
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Očisti HLS folder pre pokretanja novog streama
    logger.log('Clearing HLS folder...');
    clearHLSFolder();
    
    // Dobij direktan link sa RD
    const directUrl = await unrestrictRD(urlParam);
    if (!directUrl) {
      logger.error('Failed to get direct URL from RD');
      return res.status(500).send('Failed to get direct URL');
    }

    logger.log(`Starting FFmpeg stream for: ${directUrl.substring(0, 50)}...`);
    
    // FFmpeg HLS konfiguracija - koristi delete_segments da briše stare segmente
    ffmpegProcess = spawn('ffmpeg', [
      '-y',
      '-i', directUrl,
      '-vf', 'format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-pix_fmt', 'yuv420p',
      '-map', '0:v:0',
      '-map', '0:a:2?',
      '-map', '0:a:0?',
      '-c:a', 'aac',
      '-ac', '2',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '10', // Zadrži samo poslednjih 10 segmenata u playlisti
      '-hls_flags', 'delete_segments+program_date_time', // Briši stare segmente
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', `${HLS_DIR}/stream%03d.ts`, // Eksplicitno ime fajlova
      '-hls_playlist_type', 'vod',
      `${HLS_DIR}/stream.m3u8`
    ], {
      stdio: ['ignore', 'pipe', 'pipe'] // Redirect stdout i stderr
    });

    ffmpegProcess.stderr.on('data', d => logger.debug('FFmpeg:', d.toString()));
    
    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg process error:', err);
    });
    
    ffmpegProcess.on('exit', (code, signal) => {
      logger.log(`FFmpeg process exited with code ${code}, signal ${signal}`);
      ffmpegProcess = null;
    });

    // Sačekaj da se FFmpeg pokrene i kreira prvi segment i playlist
    let playlistReady = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
      if (fs.existsSync(playlistPath)) {
        const stats = fs.statSync(playlistPath);
        if (stats.size > 0) {
          playlistReady = true;
          logger.log('HLS playlist created and ready');
          break;
        }
      }
    }
    
    if (!playlistReady) {
      logger.warn('HLS playlist not ready after 5 seconds, redirecting anyway...');
    }
    
    // Kada se pokrene, redirectuj na HLS playlist
    res.redirect(`/stream/stream.m3u8`);

  } catch (err) {
    logger.error('Failed to start stream:', err);
    res.status(500).send('Failed to start stream');
  }
});

// Statika za HLS fajlove - CORS headers za cross-origin pristup
app.use("/stream", (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
}, express.static(HLS_DIR, {
  setHeaders: (res, path) => {
    if (path.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (path.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
  }
}));

// Express servira sve na portu 3000:
// - Addon endpoint-e (/manifest.json, /:resource/:type/:id.json) - kao serveHTTP
// - FFmpeg endpoint-e (/start, /stream/*.m3u8, /stream/*.ts)

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.log(`Server running on port ${PORT}`);
  logger.log(`Stremio addon manifest: ${SERVER_BASE_URL}/manifest.json`);
  logger.log(`Add this URL to Stremio: ${SERVER_BASE_URL}/manifest.json`);
  logger.log(`FFmpeg endpoints: ${SERVER_BASE_URL}/start, ${SERVER_BASE_URL}/stream/*.m3u8`);
});
