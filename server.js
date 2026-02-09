import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { unrestrictRD, unrestrictRDFromId } from './rd_helper.js'; // tvoj helper za RD

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
    console.log(`Request for stream: type=${type}, id=${id}`);
  
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
  
// Pokretanje FFmpeg streama
app.get('/start', async (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) return res.send("Missing url in params");

  try {
    // Dobij direktan link sa RD
    const directUrl = await unrestrictRD(urlParam);

    if (ffmpegProcess) ffmpegProcess.kill("SIGKILL");

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
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      `${HLS_DIR}/stream.m3u8`
    ]);

    ffmpegProcess.stderr.on('data', d => console.log(d.toString()));

    // Kada se pokrene, redirectuj na HLS playlist
    res.redirect(`/stream/stream.m3u8`);

  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to start stream');
  }
});

// Statika za HLS fajlove
app.use("/stream", express.static(HLS_DIR));

// Pokretanje servera
app.listen(PORT, () => {
  console.log(`Server running at http://${IPv4}:${PORT}`);
});
