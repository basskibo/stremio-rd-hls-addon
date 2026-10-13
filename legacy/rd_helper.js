import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RD_API_TOKEN = (process.env.RD_API_TOKEN || '').trim();
const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';
/** Ako je 1/true/yes, ignoriše RD čak i kada je RD_API_TOKEN postavljen (samo WebTorrent + unrestrict za http linkove). */
const RD_DISABLE = /^(1|true|yes)$/i.test(String(process.env.RD_DISABLE || '').trim());
const RD_TRY_MAGNET = Boolean(RD_API_TOKEN) && !RD_DISABLE;

export async function unrestrictRD(url) {
  try {
    if (!RD_API_TOKEN) {
      logger.debug('RD_API_TOKEN nije postavljen — preskačem unrestrict.');
      return null;
    }
    logger.log('UNRESTRICT RD - URL:', url);
    
    // Proveri da li je validan URL
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('magnet:'))) {
      logger.error('Invalid URL format for unrestrictRD:', url);
      return null;
    }
    
    const res = await fetch(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RD_API_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ link: url })
      }
    );
  
    const status = res.status;
    const statusText = res.statusText;
    logger.log(`RD API Response - Status: ${status} ${statusText}`);
  
    if (!res.ok) {
      // Pokušaj da pročitaš error response
      let errorBody;
      try {
        errorBody = await res.text();
        logger.error('RD API Error Response:', errorBody);
      } catch (e) {
        logger.error('Could not read error response body');
      }
      throw new Error(`RD API error: ${status} ${statusText} - ${errorBody || ''}`);
    }
  
    const data = await res.json();
    logger.log('RD API Success - DATA:', data);
    
    if (!data.download) {
      logger.error('RD API response missing download field:', data);
      return null;
    }
    
    return data.download;
  } catch (err) {
    logger.error('Error in unrestrictRD:', err.message, err.stack);
    return null;
  }
}
  

/**
 * Jedan kandidat iz liste torrenta (Torrentio) za Stremio id.
 * @param {string} stremioId npr. tt0388629:10:9
 * @param {string} type movie | series
 * @param {number} torIdx indeks u već sortiranoj listi (0 = najbolji po trenutnoj heuristici)
 * @returns {Promise<null|{ kind:'http'|'magnet', url?:string, magnet?:string, fileIdx:number, title:string, displayTitle:string, torIdx:number, total:number }>}
 */
async function resolveStremioSource(stremioId, type = 'series', torIdx = 0) {
  logger.log(`Torrentio upit: ${stremioId} (${type}), torIdx=${torIdx}`);

  const torrentioLinks = await getStreamLinksFromTorrentio(stremioId, type || 'series');
  if (!torrentioLinks || torrentioLinks.length === 0) {
    logger.warn('Torrentio: nema streamova');
    return null;
  }

  const idx = Math.max(0, Math.min(Number(torIdx) || 0, torrentioLinks.length - 1));
  const stream = torrentioLinks[idx];
  const displayTitle = String(stream.title || stream.filename || 'Torrent')
    .split('\n')[0]
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, 120);

  if (stream.url && /^https?:\/\//i.test(stream.url)) {
    logger.log(`Torrentio [${idx + 1}/${torrentioLinks.length}] HTTP: ${displayTitle.slice(0, 72)}…`);
    return {
      kind: 'http',
      url: stream.url,
      fileIdx: Number.isInteger(stream.fileIdx) ? stream.fileIdx : 0,
      title: stream.title || displayTitle,
      displayTitle,
      torIdx: idx,
      total: torrentioLinks.length,
    };
  }

  if (!stream.magnetLink) {
    logger.error(`Torrentio [${idx + 1}]: nema magnet linka`);
    return null;
  }

  if (RD_TRY_MAGNET) {
    const magnetPreview = stream.magnetLink.substring(0, 72);
    logger.log(`RD: pokušaj magneta [${idx + 1}/${torrentioLinks.length}]: ${magnetPreview}…`);
    try {
      const torrentId = await addTorrentToRD(stream.magnetLink);
      if (torrentId) {
        const rdDirectLink = await getTorrentDownloadLink(torrentId);
        if (rdDirectLink) {
          logger.log('RD: direktan HTTP link spreman (obično brže od lokalnog torrenta).');
          return {
            kind: 'http',
            url: rdDirectLink,
            fileIdx: 0,
            title: stream.title || displayTitle,
            displayTitle,
            torIdx: idx,
            total: torrentioLinks.length,
          };
        }
        logger.warn(
          'RD: nema spremnog linka (timeout, još uvek skida ili greška) — prelazim na WebTorrent.'
        );
      } else {
        logger.warn('RD: addMagnet nije uspeo — prelazim na WebTorrent.');
      }
    } catch (err) {
      logger.warn('RD greška — prelazim na WebTorrent:', err.message || String(err));
    }
  } else if (RD_API_TOKEN && RD_DISABLE) {
    logger.log('RD_DISABLE: preskačem Real-Debrid za magnet — WebTorrent.');
  }

  const fileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : 0;
  logger.log(
    `WebTorrent [${idx + 1}/${torrentioLinks.length}] fileIdx=${fileIdx}: ${displayTitle.slice(0, 72)}…`
  );
  return {
    kind: 'magnet',
    magnet: stream.magnetLink,
    fileIdx,
    title: stream.title || displayTitle,
    displayTitle,
    torIdx: idx,
    total: torrentioLinks.length,
  };
}

/**
 * @param {string} stremioId npr. tt0388629:10:9
 * @param {string} type movie | series
 * @returns {Promise<string|{magnet:string,fileIdx:number}|null>}
 */
async function unrestrictRDFromId(stremioId, type = 'series') {
  try {
    const r = await resolveStremioSource(stremioId, type, 0);
    if (!r) return null;
    if (r.kind === 'http') return r.url;
    return { magnet: r.magnet, fileIdx: r.fileIdx };
  } catch (err) {
    logger.error('Error in unrestrictRDFromId:', err);
    return null;
  }
}
  

/**
 * Dodaje magnet link ili torrent URL na Real-Debrid
 * @param {string} magnetOrUrl - Magnet link ili torrent URL
 * @returns {Promise<string|null>} RD torrent ID ili null
 */
async function addTorrentToRD(magnetOrUrl) {
  try {
    if (!RD_API_TOKEN) return null;
    logger.log('Adding torrent to RD:', magnetOrUrl);
    
    const res = await fetch(`${RD_API_BASE}/torrents/addMagnet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RD_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ magnet: magnetOrUrl })
    });

    if (!res.ok) {
      const errorText = await res.text();
      logger.error('Failed to add torrent to RD:', res.status, errorText);
      return null;
    }

      const data = await res.json();
      const torrentId = data.id;
      logger.log(`Torrent added to RD, ID: ${torrentId}`);
      return torrentId;
  } catch (err) {
    logger.error('Error adding torrent to RD:', err);
    return null;
  }
}

/**
 * Proverava status torrenta na RD i vraća direktan link kada je spreman
 * @param {string} torrentId - RD torrent ID
 * @returns {Promise<string|null>} Direktan download link ili null
 */
async function getTorrentDownloadLink(torrentId, maxRetries = 10, delayMs = 2000) {
  try {
    if (!RD_API_TOKEN) return null;
    for (let i = 0; i < maxRetries; i++) {
      const res = await fetch(`${RD_API_BASE}/torrents/info/${torrentId}`, {
        headers: {
          'Authorization': `Bearer ${RD_API_TOKEN}`
        }
      });

      if (!res.ok) {
        logger.error('Failed to get torrent info:', res.status);
        return null;
      }

      const torrentInfo = await res.json();
      const statusText = torrentInfo.status || 'unknown';
      logger.log(`Torrent status: ${statusText} (${i + 1}/${maxRetries})`);

      // Status može biti: "magnet_error", "magnet_conversion", "waiting_files_selection", "queued", "downloading", "downloaded", "error", "virus", "compressing", "uploading"
      // Ako je "waiting_files_selection", treba da selektujemo fajlove
      if (statusText === 'waiting_files_selection') {
        logger.log('Torrent waiting for file selection, selecting files...');
        
        if (torrentInfo.files && torrentInfo.files.length > 0) {
          // Selektuj sve fajlove ili samo video fajlove
          const videoFiles = torrentInfo.files.filter(f => {
            const name = (f.path || f.filename || '').toLowerCase();
            return name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.avi') || 
                   name.endsWith('.mov') || name.endsWith('.webm') || name.endsWith('.m4v');
          });
          
          const filesToSelect = videoFiles.length > 0 ? videoFiles : torrentInfo.files;
          const fileIds = filesToSelect.map(f => f.id).join(',');
          
          logger.log(`Selecting ${filesToSelect.length} file(s) for download`);
          
          const selectRes = await fetch(`${RD_API_BASE}/torrents/selectFiles/${torrentId}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RD_API_TOKEN}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ files: fileIds })
          });
          
          if (selectRes.ok) {
            logger.log('Files selected successfully, waiting for download...');
            // Nastavi sa čekanjem
          } else {
            const errorText = await selectRes.text();
            logger.error(`Failed to select files: ${selectRes.status} ${errorText}`);
          }
        }
      }
      
      // Status: "downloaded" = completed
      if (statusText === 'downloaded' || torrentInfo.status === 2) {
        // Torrent je završen, uzmi prvi fajl
        if (torrentInfo.files && torrentInfo.files.length > 0) {
          const mainFile = torrentInfo.files.find(f => f.selected === 1) || torrentInfo.files[0];
          if (mainFile && mainFile.id) {
            // Unrestrictuj link
            const unrestrictRes = await fetch(`${RD_API_BASE}/torrents/selectFiles/${torrentId}`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${RD_API_TOKEN}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: new URLSearchParams({ files: String(mainFile.id) })
            });

            if (unrestrictRes.ok) {
              const unrestrictData = await unrestrictRes.json();
              // Link se nalazi u torrents/info nakon selectFiles
              const finalInfo = await fetch(`${RD_API_BASE}/torrents/info/${torrentId}`, {
                headers: { 'Authorization': `Bearer ${RD_API_TOKEN}` }
              }).then(r => r.json());
              
              if (finalInfo.links && finalInfo.links.length > 0) {
                const directLink = await unrestrictRD(finalInfo.links[0]);
                return directLink;
              }
            }
          }
        }
        return null;
      } else if (statusText === 'error' || statusText === 'virus' || torrentInfo.status === 3) {
        logger.error(`Torrent download failed on RD with status: ${statusText}`);
        return null;
      }

      // Čekaj pre sledeće provere
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    logger.warn('Torrent download timeout - not ready after', maxRetries, 'retries');
    return null;
  } catch (err) {
    logger.error('Error getting torrent download link:', err);
    return null;
  }
}

/**
 * Proverava da li RD već ima cached torrent (instant availability)
 * @param {string} hash - Torrent hash (info_hash)
 * @returns {Promise<string|null>} Direktan download link ako postoji, null ako ne
 */
async function checkRDInstantAvailability(hash) {
  try {
    if (!RD_API_TOKEN) return null;
    logger.log('Checking RD instant availability for hash:', hash);
    
    const res = await fetch(`${RD_API_BASE}/torrents/instantAvailability/${hash}`, {
      headers: {
        'Authorization': `Bearer ${RD_API_TOKEN}`
      }
    });

    if (!res.ok) {
      logger.debug('No instant availability or error:', res.status);
      return null;
    }

    const data = await res.json();
    logger.log('RD instant availability response:', JSON.stringify(data, null, 2));
    
    // Ako postoji instant availability, vraća objekat sa linkovima
    // Format: { "hash": { "rd": [{ "filename": "...", "filesize": ... }] } }
    if (data[hash] && data[hash].rd && data[hash].rd.length > 0) {
      // Vraća prvi dostupan fajl
      const file = data[hash].rd[0];
      logger.log('Found instant availability file:', file);
      // Treba da dobijemo direktan link - možda kroz torrents/addMagnet pa selectFiles
      return file;
    }
    
    return null;
  } catch (err) {
    logger.error('Error checking RD instant availability:', err);
    return null;
  }
}

/**
 * Pretražuje postojeće torrentove na RD account-u
 * @param {string} query - Search query za pretragu u nazivima torrentova
 * @returns {Promise<string|null>} Magnet link ili torrent ID ako se nađe
 */
async function searchRDTorrents(query) {
  try {
    if (!RD_API_TOKEN) return null;
    logger.log(`Searching existing RD torrents for: ${query}`);
    
    const res = await fetch(`${RD_API_BASE}/torrents`, {
      headers: {
        'Authorization': `Bearer ${RD_API_TOKEN}`
      }
    });

    const status = res.status;
    logger.log(`RD torrents API response status: ${status}`);
    
    if (status === 401) {
      logger.error('RD API authentication failed - check your API token!');
      return null;
    }

    if (!res.ok) {
      const errorText = await res.text();
      logger.error('Failed to get RD torrents list:', status, errorText);
      return null;
    }

    const torrents = await res.json();
    logger.log(`Found ${torrents.length} torrents on RD account`);
    
    // Loguj prvih 5 torrentova za debugging
    if (torrents.length > 0) {
      const sampleTorrents = torrents.slice(0, 5).map(t => ({
        id: t.id,
        filename: t.filename,
        status: t.status,
        hasLinks: !!(t.links && t.links.length > 0)
      }));
      logger.debug(`Sample RD torrents: ${JSON.stringify(sampleTorrents, null, 2)}`);
      
      // Loguj sve nazive torrentova za debugging (INFO level da korisnik vidi)
      const allFilenames = torrents.map(t => t.filename).filter(Boolean);
      logger.info(`Sample RD torrent filenames (first 10): ${allFilenames.slice(0, 10).join(', ')}`);
      
      // Traži torrentove koji sadrže "demon" i "slayer" za debugging
      const demonSlayerTorrents = torrents.filter(t => 
        t.filename && t.filename.toLowerCase().includes('demon') && t.filename.toLowerCase().includes('slayer')
      );
      if (demonSlayerTorrents.length > 0) {
        logger.info(`Found ${demonSlayerTorrents.length} Demon Slayer torrents on RD:`);
        demonSlayerTorrents.slice(0, 5).forEach(t => {
          logger.info(`  - ${t.filename} (Status: ${t.status}, Has links: ${!!(t.links && t.links.length > 0)})`);
        });
      }
    } else {
      logger.warn('No torrents found on RD account - account might be empty or API issue');
    }
    
    // Pretraži torrentove po nazivu (case-insensitive)
    // Pokušaj različite varijante pretrage
    const queryLower = query.toLowerCase();
    const queryParts = queryLower.split(' ').filter(p => p.length > 2); // Ukloni kratke reči
    
    // Prvo pokušaj tačno poklapanje
    let matchingTorrent = torrents.find(t => 
      t.filename && t.filename.toLowerCase().includes(queryLower)
    );
    
    // Ako nema tačnog, pokušaj sa delovima query-ja
    if (!matchingTorrent && queryParts.length > 0) {
      matchingTorrent = torrents.find(t => {
        if (!t.filename) return false;
        const filenameLower = t.filename.toLowerCase();
        // Proveri da li svi delovi query-ja postoje u nazivu
        return queryParts.every(part => filenameLower.includes(part));
      });
    }
    
    // Ako i dalje nema, pokušaj samo sa glavnim delovima (serija + sezona/epizoda)
    if (!matchingTorrent) {
      const seasonEpisodeMatch = query.match(/s(\d+)e(\d+)/i);
      if (seasonEpisodeMatch) {
        const season = seasonEpisodeMatch[1];
        const episode = seasonEpisodeMatch[2];
        const seriesName = query.split(/s\d+e\d+/i)[0].trim().toLowerCase();
        
        // Pokušaj različite varijante serije (bez ":", sa tačkama, itd.)
        const seriesVariants = [
          seriesName,
          seriesName.replace(/:/g, ''),
          seriesName.replace(/:/g, '.'),
          seriesName.replace(/\s+/g, '.'),
          seriesName.replace(/\s+/g, ''),
          'demon slayer',
          'kimetsu no yaiba'
        ];
        
        const seasonEpisodeVariants = [
          `s${season}e${episode}`,
          `s${season.padStart(2, '0')}e${episode.padStart(2, '0')}`,
          `s${season}e${episode.padStart(2, '0')}`,
          `season ${season} episode ${episode}`,
          `s${season} e${episode}`
        ];
        
        matchingTorrent = torrents.find(t => {
          if (!t.filename) return false;
          const filenameLower = t.filename.toLowerCase();
          
          // Proveri da li naziv sadrži bilo koju varijantu serije
          const hasSeriesName = seriesVariants.some(variant => filenameLower.includes(variant));
          
          // Proveri da li naziv sadrži bilo koju varijantu sezone/epizode
          const hasSeasonEpisode = seasonEpisodeVariants.some(variant => filenameLower.includes(variant));
          
          return hasSeriesName && hasSeasonEpisode;
        });
      }
    }
    
    // Ako i dalje nema, pokušaj samo sa ključnim rečima (demon + slayer + sezona/epizoda)
    if (!matchingTorrent) {
      const seasonEpisodeMatch = query.match(/s(\d+)e(\d+)/i);
      if (seasonEpisodeMatch) {
        const season = seasonEpisodeMatch[1];
        const episode = seasonEpisodeMatch[2];
        
        matchingTorrent = torrents.find(t => {
          if (!t.filename) return false;
          const filenameLower = t.filename.toLowerCase();
          return (filenameLower.includes('demon') && filenameLower.includes('slayer')) &&
                 (filenameLower.includes(`s${season}e${episode}`) || 
                  filenameLower.includes(`s${season.padStart(2, '0')}e${episode.padStart(2, '0')}`));
        });
      }
    }
    
    if (matchingTorrent) {
      logger.log(`Found matching torrent on RD - ID: ${matchingTorrent.id}, Filename: ${matchingTorrent.filename}, Status: ${matchingTorrent.status}, Links: ${matchingTorrent.links?.length || 0}`);
      
      // Ako je torrent već završen, uzmi direktan link
      if (matchingTorrent.status === 2 && matchingTorrent.links && matchingTorrent.links.length > 0) {
        logger.log(`Torrent already completed, using existing link: ${matchingTorrent.links[0]}`);
        return matchingTorrent.links[0];
      }
      
      // Ako je u toku, vrati ID da se čeka
      logger.log(`Torrent in progress (status: ${matchingTorrent.status}), returning ID to wait: ${matchingTorrent.id}`);
      return matchingTorrent.id;
    }
    
    logger.warn(`No matching torrent found on RD account for query: ${query}`);
    logger.debug(`Query parts used for search: ${JSON.stringify(queryParts)}`);
    if (torrents.length > 0) {
      logger.debug(`Searched through ${torrents.length} torrents but no match found`);
    }
    return null;
  } catch (err) {
    logger.error('Error searching RD torrents:', err.message, err.stack);
    return null;
  }
}

/**
 * Pretražuje torrentove - prvo proverava RD account, zatim instant availability
 * @param {string} query - Search query (npr. "Demon Slayer S5E6")
 * @param {string} torrentHash - Opciono: torrent hash za instant availability check
 * @returns {Promise<string|null>} Magnet link, torrent ID, ili direktan link
 */
async function searchTorrent(query, torrentHash = null) {
  try {
    logger.log('Searching torrent for query:', query);
    
    // 1. Prvo proveri postojeće torrentove na RD account-u
    const existingTorrent = await searchRDTorrents(query);
    if (existingTorrent) {
      // Ako je direktan link, vrati ga
      if (existingTorrent.startsWith('http://') || existingTorrent.startsWith('https://')) {
        logger.log('Found existing RD link:', existingTorrent);
        return existingTorrent;
      }
      // Ako je torrent ID, koristi ga
      if (typeof existingTorrent === 'string' && existingTorrent.length > 10) {
        logger.log('Found existing RD torrent ID:', existingTorrent);
        const directLink = await getTorrentDownloadLink(existingTorrent);
        return directLink;
      }
    }
    
    // 2. Ako imaš torrent hash, proveri instant availability
    if (torrentHash) {
      const instantFile = await checkRDInstantAvailability(torrentHash);
      if (instantFile) {
        logger.log('Found instant availability on RD');
        // Treba da dodamo magnet i uzmemo link
        // Za sada vraćamo null jer treba magnet link
      }
    }
    
    // 3. Ako nema ništa, treba magnet link - za sada vraćamo null
    logger.warn('No torrent found on RD. Need magnet link to add new torrent.');
    logger.warn('Query:', query);
    return null;
  } catch (err) {
    logger.error('Error searching torrent:', err);
    return null;
  }
}

/**
 * Torrentio u `title` ubacuje liniju kao u drugim addonima: "👤 1470 💾 1.2 GB ⚙️ NyaaSi".
 * Taj broj je iz indexer-a (najčešće seeders / peer count) — veći = bolji swarm.
 */
function parseTorrentioPeerScore(title) {
  if (!title) return 0;
  const m = String(title).match(/👤\s*([\d][\d\s.,]*)/u);
  if (!m) return 0;
  const raw = m[1].replace(/[\s,]/g, '');
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Torrentio u title ubaci npr. "💾 246.3 MB" ili "💾 1.36 GB".
 * @returns {number|null} veličina u bajtovima ili null ako nema / ne parsira
 */
function parseTorrentioSizeBytes(title) {
  if (!title) return null;
  const m = String(title).match(/💾\s*([\d]+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)/iu);
  if (!m) return null;
  const num = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return null;
  const u = m[2].toLowerCase();
  const mult =
    u === 'kb' || u === 'kib'
      ? 1024
      : u === 'mb' || u === 'mib'
        ? 1024 ** 2
        : u === 'gb' || u === 'gib'
          ? 1024 ** 3
          : u === 'tb' || u === 'tib'
            ? 1024 ** 4
            : 0;
  if (!mult) return null;
  return Math.round(num * mult);
}

/**
 * Dobija stream linkove iz Torrentio addon API-ja
 * @param {string} stremioId - Stremio ID (npr. "tt9335498:5:6")
 * @param {string} type - Tip sadržaja ("movie" ili "series")
 * @returns {Promise<Array|null>} Niz stream linkova ili null
 */
async function getStreamLinksFromTorrentio(stremioId, type) {
  try {
    logger.log(`Getting stream links from Torrentio for: ${stremioId} (type: ${type})`);
    
    // Torrentio addon URL format
    // Možeš koristiti javni Torrentio instance ili svoj
    // Primer: https://torrentio.strem.fun/{config}/manifest.json
    // Stream endpoint: https://torrentio.strem.fun/{config}/stream/{type}/{id}.json
    
    // Za sada koristimo javni Torrentio instance
    // Možeš promeniti ovo da koristiš svoj Torrentio config
    const TORRENTIO_BASE = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
    const TORRENTIO_CONFIG = process.env.TORRENTIO_CONFIG || 'filter=qualityfilter=1080p|720p|480p';
    
    const streamUrl = `${TORRENTIO_BASE}/${TORRENTIO_CONFIG}/stream/${type}/${stremioId}.json`;
    logger.log(`Fetching from Torrentio: ${streamUrl}`);
    
    const res = await fetch(streamUrl);
    
    if (!res.ok) {
      logger.error(`Torrentio API error: ${res.status} ${res.statusText}`);
      return null;
    }
    
    const data = await res.json();
    logger.log(`Torrentio returned ${data.streams?.length || 0} streams`);
    logger.debug(`Torrentio response structure: ${JSON.stringify(Object.keys(data), null, 2)}`);
    
    if (!data.streams || data.streams.length === 0) {
      logger.warn('No streams found from Torrentio');
      return null;
    }
    
    // Loguj strukturu prvog streama za debugging
    if (data.streams[0]) {
      logger.debug(`First stream structure: ${JSON.stringify(Object.keys(data.streams[0]), null, 2)}`);
    }
    
    const streamLinks = data.streams
      .map((s) => {
        const infoHash = s.infoHash;
        const sources = s.sources || [];
        const fileIdx = s.fileIdx;
        const filename = s.behaviorHints?.filename || s.title || 'Unknown';
        const title = s.title || filename;
        const url =
          s.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url).trim() : null;

        let magnetLink = null;
        if (infoHash) {
          const trackers = sources
            .map((src) => (String(src).startsWith('tracker:') ? String(src).slice('tracker:'.length) : src))
            .filter(
              (t) =>
                t.startsWith('http://') ||
                t.startsWith('https://') ||
                t.startsWith('udp://')
            );
          const trackerParams = trackers.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
          magnetLink = `magnet:?xt=urn:btih:${infoHash}${trackerParams ? '&' + trackerParams : ''}`;
        }

        return {
          name: s.name || 'Unknown',
          title,
          infoHash,
          fileIdx,
          filename,
          magnetLink,
          sources,
          url,
          peerScore: parseTorrentioPeerScore(title),
          sizeBytes: parseTorrentioSizeBytes(title),
        };
      })
      .filter((s) => s.infoHash || s.url);

    streamLinks.sort((a, b) => {
      if (b.peerScore !== a.peerScore) return b.peerScore - a.peerScore;
      const sa = a.sizeBytes ?? Number.MAX_SAFE_INTEGER;
      const sb = b.sizeBytes ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return 0;
    });

    logger.log(`Torrentio: ${streamLinks.length} streamova (magnet ili direktan URL)`);

    if (streamLinks.length === 0) {
      logger.error('Torrentio: nema upotrebljivih streamova');
      return null;
    }

    /** 0 = isključeno; podrazumevano 1 GB — samo ako Torrentio u title ima 💾 liniju. */
    const maxGb = parseFloat(process.env.TORRENT_MAX_SIZE_GB ?? '1');
    const maxBytes =
      Number.isFinite(maxGb) && maxGb > 0 ? Math.floor(maxGb * 1024 * 1024 * 1024) : null;

    let result = streamLinks;
    if (maxBytes != null) {
      const small = streamLinks.filter((s) => s.sizeBytes != null && s.sizeBytes <= maxBytes);
      if (small.length > 0) {
        result = small;
        logger.log(
          `Torrentio: biram među ${small.length} kandidata sa poznatom veličinom ≤ ${maxGb} GB (jak swarm + manji fajl).`
        );
      } else {
        logger.warn(
          `Torrentio: nema streamova sa 💾 ≤ ${maxGb} GB (batch često nema veličinu pojedinačnog fajla u naslovu) — fallback na najjači swarm.`
        );
      }
    }

    const best = result[0];
    const head = String(best.title).split('\n')[0].slice(0, 120);
    const szLog =
      best.sizeBytes != null
        ? `${(best.sizeBytes / (1024 * 1024)).toFixed(1)} MiB`
        : 'veličina nepoznata u 💾';
    logger.log(`Torrentio: izabran 👤 ${best.peerScore}, 💾 ${szLog}: ${head}`);

    return result;
    
  } catch (err) {
    logger.error('Error getting stream links from Torrentio:', err.message);
    return null;
  }
}

export {
  unrestrictRDFromId,
  resolveStremioSource,
  addTorrentToRD,
  getTorrentDownloadLink,
  searchTorrent,
  searchRDTorrents,
  checkRDInstantAvailability,
  getStreamLinksFromTorrentio,
};