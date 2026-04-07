import path from 'path';
import os from 'os';
import WebTorrent from 'webtorrent';
import logger from './logger.js';

const PATHNAME = '/wt';

let client = null;

export async function destroyWebTorrentSession() {
  if (!client) return;
  const c = client;
  client = null;
  await new Promise((resolve, reject) => {
    try {
      c.destroy((err) => (err ? reject(err) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}

function addTorrentAndPickFile(magnetUri, fileIdx, onReady, onError) {
  const downloadPath = path.join(os.tmpdir(), 'stremio-rd-hls-wt');
  const timeoutMs = Number(process.env.WEBTORRENT_METADATA_TIMEOUT_MS) || 180000;

  const t = setTimeout(() => {
    onError(
      new Error(
        `WebTorrent: nema metapodataka posle ${timeoutMs / 1000}s (malo seedera / blokiran torrent / firewall).`
      )
    );
  }, timeoutMs);

  let settled = false;
  const done = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    fn();
  };

  client.once('error', (err) => done(() => onError(err)));

  client.add(
    magnetUri,
    { path: downloadPath, deselect: true, strategy: 'sequential' },
    (torrent) => {
      torrent.on('error', (err) => done(() => onError(err)));
      try {
        const n = torrent.files?.length || 0;
        if (!n) {
          done(() => onError(new Error('WebTorrent: torrent nema fajlove u metapodacima')));
          return;
        }
        let idx = Number.isFinite(fileIdx) && fileIdx >= 0 ? fileIdx | 0 : 0;
        if (idx >= n) {
          logger.warn(`WebTorrent: fileIdx ${fileIdx} van opsega (0..${n - 1}), koristim 0`);
          idx = 0;
        }
        const file = torrent.files[idx];
        file.select(7);
        logger.log(
          `WebTorrent: samo fajl #${idx} (prioritet 7), ne ceo batch — demux/FFmpeg mogu tokom skidanja.`
        );
        done(() => onReady(file, idx, torrent));
      } catch (e) {
        done(() => onError(e));
      }
    }
  );
}

/**
 * Magnet → HTTP za ffprobe + createReadStream za FFmpeg stdin (isti torrent).
 * HTTP samo za metapodatke; enkod ide pipe da nema preranog EOF od Range zahteva.
 */
export async function magnetPrepare(magnetUri, fileIdx = 0) {
  await destroyWebTorrentSession();
  client = new WebTorrent();
  const server = client.createServer({ pathname: PATHNAME }, 'node');

  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    server.server.once('error', onErr);
    server.listen(0, '127.0.0.1', () => {
      server.server.off('error', onErr);
      resolve();
    });
  });

  const port = server.address().port;

  return new Promise((resolve, reject) => {
    addTorrentAndPickFile(
      magnetUri,
      fileIdx,
      (file, idx, torrent) => {
        const rel = file.path.replace(/\\/g, '/');
        const encodedPath = rel.split('/').map((seg) => encodeURI(seg)).join('/');
        const probeUrl = `http://127.0.0.1:${port}${PATHNAME}/${torrent.infoHash}/${encodedPath}`;
        logger.log(`WebTorrent ffprobe+pipe, fajl #${idx}: ${String(file.name || '').slice(0, 72)}…`);
        resolve({
          probeUrl,
          readStream: () => file.createReadStream(),
        });
      },
      reject
    );
  });
}

/** @deprecated koristi magnetPrepare */
export async function magnetToReadStream(magnetUri, fileIdx = 0) {
  const { readStream } = await magnetPrepare(magnetUri, fileIdx);
  return readStream();
}

/**
 * Magnet + fileIdx → samo HTTP (debug / WEBTORRENT_FFMPEG_HTTP=1).
 */
export async function magnetToHttpUrl(magnetUri, fileIdx = 0) {
  await destroyWebTorrentSession();

  client = new WebTorrent();
  const server = client.createServer({ pathname: PATHNAME }, 'node');

  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    server.server.once('error', onErr);
    server.listen(0, '127.0.0.1', () => {
      server.server.off('error', onErr);
      resolve();
    });
  });

  const port = server.address().port;

  return new Promise((resolve, reject) => {
    addTorrentAndPickFile(
      magnetUri,
      fileIdx,
      (file, idx, torrent) => {
        const rel = file.path.replace(/\\/g, '/');
        const encodedPath = rel.split('/').map((seg) => encodeURI(seg)).join('/');
        const url = `http://127.0.0.1:${port}${PATHNAME}/${torrent.infoHash}/${encodedPath}`;
        logger.log(`WebTorrent spreman (HTTP, fajl #${idx}): ${url.slice(0, 120)}…`);
        resolve(url);
      },
      reject
    );
  });
}
