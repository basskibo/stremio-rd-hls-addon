import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { unrestrictRD, unrestrictRDFromId } from './rd_helper.js'; // tvoj helper za RD
import logger from './logger.js';

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

let ffmpegProcess = null;

// Stremio addon endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    logger.log(`Request for stream: type=${type}, id=${id}`);
  
    // TODO: OVDE mapirati Stremio ID na stvarni RD link
    const rdLink = await unrestrictRDFromId(id); // napiši funkciju koja vraća direktan link
    if (!rdLink) return res.json({ streams: [] });
  
    const startUrl = `http://${IPv4}:${PORT}/start?url=${encodeURIComponent(rdLink)}`;
  
    res.json({
      streams: [
        {
          name: 'Local PC (HLS)',
          title: `RD → FFmpeg → HLS`,
          url: startUrl
        }
      ]
    });
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

// Pokretanje servera
app.listen(PORT, () => {
  logger.log(`Server running at http://${IPv4}:${PORT}`);
});
