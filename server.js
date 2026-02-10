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
  
    // FFmpeg endpoint-e servirajmo na portu 3001
    const FFMPEG_PORT = 3001;
    const ffmpegBaseUrl = NGROK_URL ? NGROK_URL.replace(`:${PORT}`, `:${FFMPEG_PORT}`) : `http://${IPv4}:${FFMPEG_PORT}`;
    const startUrl = `${ffmpegBaseUrl}/start?url=${encodeURIComponent(rdLink)}`;
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

// Koristi serveHTTP direktno - kao u stremio-addon.js gde je radilo
// serveHTTP pokreće svoj server na portu 3000 i servira addon endpoint-e
// Dodaj FFmpeg endpoint-e kroz Express middleware na istom serveru
// serveHTTP koristi Express interno, pa možemo da dodamo middleware

const addonServer = serveHTTP(builder.getInterface(), { port: PORT });

// Dodaj FFmpeg endpoint-e na serveHTTP server
// serveHTTP koristi Express interno, pa možemo da dodamo middleware
// ALI serveHTTP pokreće svoj server, ne možemo da dodamo Express endpoint-e

// Zato koristimo serveHTTP na portu 3000 i dodajemo FFmpeg endpoint-e
// kroz Express na drugom portu (3001)
  
// Funkcija za čišćenje HLS foldera
// NE briše playlist dok FFmpeg radi - samo stare segmente
function clearHLSFolder() {
  try {
    if (!fs.existsSync(HLS_DIR)) {
      fs.mkdirSync(HLS_DIR, { recursive: true });
      return;
    }
    
    const files = fs.readdirSync(HLS_DIR);
    let deletedCount = 0;
    files.forEach(file => {
      // Ne briši playlist dok FFmpeg radi - on će ga ažurirati
      // Samo briši stare .ts segmente
      if (file.endsWith('.ts')) {
        const filePath = path.join(HLS_DIR, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
          logger.debug(`Deleted HLS segment: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete HLS segment ${file}:`, err.message);
        }
      }
    });
    logger.log(`HLS folder cleared: deleted ${deletedCount} old segments`);
  } catch (err) {
    logger.error('Error clearing HLS folder:', err);
  }
}

// Pokretanje FFmpeg streama
app.get('/start', async (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) return res.send("Missing url in params");

  try {
    // Uvek zaustavi stari FFmpeg proces pre pokretanja novog
    if (ffmpegProcess) {
      logger.log('Stopping previous FFmpeg process...');
      try {
        // Prvo pokušaj sa SIGTERM
        ffmpegProcess.kill("SIGTERM");
        // Sačekaj da se proces zaista završi
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Ako još uvek radi, koristi SIGKILL
        if (ffmpegProcess && !ffmpegProcess.killed) {
          logger.warn('FFmpeg process still running, using SIGKILL...');
          ffmpegProcess.kill("SIGKILL");
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        logger.warn('Error stopping FFmpeg process:', err.message);
      }
      ffmpegProcess = null;
    }
    
    // Očisti HLS folder pre pokretanja novog streama (samo stare segmente, ne playlist)
    logger.log('Clearing old HLS segments...');
    clearHLSFolder();
    
    // Obriši stari playlist ako postoji (FFmpeg će kreirati novi)
    const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
    if (fs.existsSync(playlistPath)) {
      try {
        fs.unlinkSync(playlistPath);
        logger.debug('Deleted old playlist');
      } catch (err) {
        logger.warn('Failed to delete old playlist:', err.message);
      }
    }
    
    // Dobij direktan link sa RD
    const directUrl = await unrestrictRD(urlParam);
    if (!directUrl) {
      logger.error('Failed to get direct URL from RD');
      return res.status(500).send('Failed to get direct URL');
    }

    logger.log(`Starting FFmpeg stream for: ${directUrl.substring(0, 50)}...`);
    
    // FFmpeg HLS konfiguracija - optimizovano za iOS 12.5.7 (iPad Air)
    // Koristimo baseline profile za maksimalnu kompatibilnost sa starijim iOS uređajima
    // Event type da se playlist kreira odmah (ne čeka završetak streama)
    ffmpegProcess = spawn('ffmpeg', [
      '-y',
      '-i', directUrl,
      // Video codec - baseline profile za iOS 12 kompatibilnost
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'baseline', // Baseline profile za iOS 12 kompatibilnost (ne main ili high)
      '-level', '3.1', // Level 3.1 za iOS 12 kompatibilnost
      '-pix_fmt', 'yuv420p', // YUV420P je standardni format za iOS
      '-vf', 'format=yuv420p', // Osiguraj YUV420P format
      '-g', '30', // GOP size - keyframe svakih 30 frame-ova (važno za HLS)
      '-keyint_min', '30', // Minimum keyframe interval
      '-sc_threshold', '0', // Scene change threshold
      '-b:v', '2M', // Video bitrate
      '-maxrate', '2M',
      '-bufsize', '4M',
      // Audio codec
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '44100',
      // Map streamove
      '-map', '0:v:0',
      '-map', '0:a:2?',
      '-map', '0:a:0?',
      // HLS postavke
      '-f', 'hls',
      '-hls_time', '6', // Segment dužina u sekundama
      '-hls_list_size', '0', // 0 = zadrži sve segmente
      '-hls_segment_filename', `${HLS_DIR}/stream%d.ts`, // Eksplicitno ime: stream0.ts, stream1.ts, itd.
      '-hls_playlist_type', 'event', // Event type - playlist se kreira odmah i ažurira se dok se segmenti dodaju
      '-hls_flags', 'append_list+independent_segments', // Dodaj segmente u playlist dok se dodaju + independent segments za iOS
      '-start_number', '0', // Počni sa segmentom 0
      `${HLS_DIR}/stream.m3u8`
    ], {
      stdio: ['ignore', 'pipe', 'pipe'] // Redirect stdout i stderr
    });

    // Loguj FFmpeg stderr output za debugging (posebno video codec greške)
    ffmpegProcess.stderr.on('data', d => {
      const output = d.toString();
      // Loguj samo važne poruke (greške, upozorenja, codec info)
      if (output.includes('error') || output.includes('Error') || 
          output.includes('warning') || output.includes('Warning') ||
          output.includes('codec') || output.includes('Stream') ||
          output.includes('Video:')) {
        logger.warn('FFmpeg:', output.trim());
      } else {
        logger.debug('FFmpeg:', output.trim());
      }
    });
    
    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg process error:', err);
    });
    
    ffmpegProcess.on('exit', (code, signal) => {
      logger.log(`FFmpeg process exited with code ${code}, signal ${signal}`);
      ffmpegProcess = null;
    });

    // Sačekaj da se FFmpeg pokrene i kreira playlist sa prvim segmentom
    // VOD type kreira playlist tek kada se završi prvi segment
    // Čekamo da se kreira playlist i da sadrži barem jedan segment
    let playlistReady = false;
    for (let i = 0; i < 60; i++) { // Povećano na 30 sekundi (60 * 500ms)
      await new Promise(resolve => setTimeout(resolve, 500));
      const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
      
      // Proveri da li postoji playlist
      if (fs.existsSync(playlistPath)) {
        const playlistStats = fs.statSync(playlistPath);
        if (playlistStats.size > 0) {
          try {
            // Pročitaj playlist i proveri da li sadrži bilo koji segment
            const playlistContent = fs.readFileSync(playlistPath, 'utf8');
            
            // Proveri da li playlist sadrži bilo koji .ts segment
            if (playlistContent.includes('.ts')) {
              // Proveri da li postoji prvi segment koji je naveden u playlist-u
              // Pronađi prvi .ts fajl u playlist-u
              const segmentMatch = playlistContent.match(/stream\d+\.ts/);
              if (segmentMatch) {
                const firstSegmentName = segmentMatch[0];
                const firstSegmentPath = path.join(HLS_DIR, firstSegmentName);
                
                if (fs.existsSync(firstSegmentPath)) {
                  const segmentStats = fs.statSync(firstSegmentPath);
                  if (segmentStats.size > 50000) { // Min 50KB za prvi segment
                    playlistReady = true;
                    logger.log(`HLS playlist and first segment ready (${firstSegmentName}, ${segmentStats.size} bytes)`);
                    break;
                  }
                }
              } else {
                // Ako nema match-a, možda je playlist još uvek prazan
                logger.debug(`Playlist exists but no segment found yet (size: ${playlistStats.size})`);
              }
            }
          } catch (err) {
            logger.warn(`Error reading playlist: ${err.message}`);
          }
        }
      }
    }
    
    if (!playlistReady) {
      logger.warn('HLS playlist not ready after 30 seconds - redirecting anyway');
      // Proveri da li postoji playlist makar
      const playlistPath = path.join(HLS_DIR, 'stream.m3u8');
      if (fs.existsSync(playlistPath)) {
        logger.log('Playlist exists, redirecting anyway');
      } else {
        logger.warn('Playlist does not exist!');
      }
    }
    
    // Kada se pokrene, redirectuj na HLS playlist
    res.redirect(`/stream/stream.m3u8`);

  } catch (err) {
    logger.error('Failed to start stream:', err);
    res.status(500).send('Failed to start stream');
  }
});

// Statika za HLS fajlove - CORS headers za cross-origin pristup
// Važno za iOS 12 - mora da ima pravilne Content-Type headers i Range support
app.use("/stream", (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  // Važno za iOS - dozvoli Range requests za HLS
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
}, express.static(HLS_DIR, {
  setHeaders: (res, path) => {
    if (path.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (path.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      // Važno za iOS - dozvoli Range requests
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// serveHTTP pokreće svoj server na portu 3000 i servira addon endpoint-e
// Express servira FFmpeg endpoint-e na portu 3001
// Stream handler vraća URL sa portom 3001 za FFmpeg endpoint-e
// PROBLEM: Ne možeš koristiti 2 ngrok tunela!

// Rešenje: Koristimo serveHTTP na portu 3000 i dodajemo FFmpeg endpoint-e
// kroz Express na drugom portu (3001), ali za ngrok koristimo samo port 3000
// i FFmpeg endpoint-e servirajmo kroz proxy ili redirect

const FFMPEG_PORT = 3001;

const server = app.listen(FFMPEG_PORT, '0.0.0.0', () => {
  logger.log(`serveHTTP addon server running on port ${PORT}`);
  logger.log(`Express FFmpeg server running on port ${FFMPEG_PORT}`);
  logger.log(`Stremio addon manifest: ${SERVER_BASE_URL}/manifest.json`);
  logger.log(`Add this URL to Stremio: ${SERVER_BASE_URL}/manifest.json`);
  logger.log(`FFmpeg endpoints: http://${IPv4}:${FFMPEG_PORT}/start, http://${IPv4}:${FFMPEG_PORT}/stream/*.m3u8`);
  logger.log(`NOTE: For ngrok, use port ${PORT} for addon, and access FFmpeg via local IP:${FFMPEG_PORT}`);
});
