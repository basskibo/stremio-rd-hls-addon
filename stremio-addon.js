import pkg from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = pkg;
import { unrestrictRDFromId } from './rd_helper.js';
import os from 'os';
import logger from './logger.js';

// Koristi ngrok URL ako je postavljen, inače lokalnu IP
const NGROK_URL = process.env.NGROK_URL || null; // Primer: "https://abc123.ngrok.io"
const SERVER_PORT = 3000; // Port na kome radi server.js

let SERVER_BASE_URL = null;
if (NGROK_URL) {
  SERVER_BASE_URL = NGROK_URL;
  logger.log(`Using ngrok URL: ${NGROK_URL}`);
} else {
  // Dohvati lokalni IPv4
  const interfaces = os.networkInterfaces();
  let IPv4 = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        IPv4 = iface.address;
        break;
      }
    }
    if (IPv4) break;
  }
  SERVER_BASE_URL = `http://${IPv4}:${SERVER_PORT}`;
  logger.log(`Using local IP: ${SERVER_BASE_URL}`);
}

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
      // Map Stremio ID -> RD link (koristi Torrentio + RD unrestrict)
      const rdLink = await unrestrictRDFromId(id, type);
      if (!rdLink) {
        logger.log(`No RD link found for id: ${id}`);
        return { streams: [] };
      }
    
      // URL koji pokreće FFmpeg stream na server.js
      const startUrl = `http://${IPv4}:${SERVER_PORT}/start?url=${encodeURIComponent(rdLink)}`;
      
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


serveHTTP(builder.getInterface(), { port: 3001 });

logger.log('Stremio addon running at http://localhost:3001/manifest.json');
