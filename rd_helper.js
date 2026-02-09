import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMDB_API_KEY = "f593842b5c3424753cb2fec85a21b46f"; // stavi ovde svoj TMDb API key
const RD_API_TOKEN = "I2TRCIH5PJN7WU4427ESNCB6NPAK7FY4633MQ5LR3CZAX75T3KBQ";
const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";

export async function unrestrictRD(url) {
  try {
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
    logger.log('RD API Success - DATA:', JSON.stringify(data, null, 2));
    
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
 * Dobija RD link sa Stremio ID
 * @param {string} stremioId - npr. "tt0388629:9:47"
 * @returns {Promise<string|null>} direktan RD HLS link ili null
 */
 async function unrestrictRDFromId(stremioId, type = 'series') {
    try {
      let imdbId, season, episode;
      const parts = stremioId.split(':');
  
      imdbId = parts[0];
      if (parts.length === 3) {
        season = parts[1];
        episode = parts[2];
      }
  
      // 1️⃣ find TMDb ID
      const findResp = await fetch(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
      );
      const findData = await findResp.json();
  
      let tmdbId;
      if (findData.tv_results && findData.tv_results.length > 0) {
        tmdbId = findData.tv_results[0].id;
      } else if (findData.movie_results && findData.movie_results.length > 0) {
        tmdbId = findData.movie_results[0].id;
      } else {
        logger.warn('TMDb ID not found for', imdbId);
        return null;
      }
  
      // 2️⃣ Ako je epizoda serije, dohvati naziv epizode
      let query = '';
      if (season && episode) {
        const epResp = await fetch(
          `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`
        );
        const epData = await epResp.json();
        logger.log('epData', epData)
        
        // Sačuvaj epData u fajl
        const epDataFile = path.join(__dirname, 'epData.json');
        fs.writeFileSync(epDataFile, JSON.stringify(epData, null, 2), 'utf8');
        logger.log(`epData saved to ${epDataFile}`);

        if (!epData.name) {
          logger.warn('Episode not found:', stremioId);
          return null;
        }
        query = `${findData.tv_results[0].name} S${season}E${episode} ${epData.name}`;
      } else {
        // Film
        query = findData.movie_results[0].title;
      }
  
      logger.debug('QUERY', query)
      logger.debug('findData', findData)
      logger.debug('tmdbId', tmdbId)
      logger.debug('imdbId', imdbId)
      logger.debug('season', season)
      logger.debug('episode', episode)
      logger.debug('parts', parts)
      logger.debug('stremioId', stremioId)
      
      // 3️⃣ Koristi Torrentio addon API da dobiješ stream linkove, zatim unrestrictuj kroz RD
      // Ovo je način kako rade svi RD addoni - koriste Torrentio da dobiju linkove, pa ih unrestrictuju
      logger.log(`Getting stream links from Torrentio for Stremio ID: ${stremioId}`);
      
      const torrentioLinks = await getStreamLinksFromTorrentio(stremioId, type || 'series');
      
      if (!torrentioLinks || torrentioLinks.length === 0) {
        logger.warn('No stream links found from Torrentio');
        return null;
      }
      
      // Uzmi prvi stream (obično najbolji kvalitet)
      const firstStream = torrentioLinks[0];
      if (!firstStream || !firstStream.infoHash) {
        logger.error('Invalid stream data from Torrentio:', firstStream);
        return null;
      }
      
      const infoHash = firstStream.infoHash;
      const streamName = String(firstStream.name || 'Unknown').replace(/\n/g, ' ').trim();
      logger.log(`Processing stream: ${streamName} (infoHash: ${infoHash.substring(0, 16)}...)`);
      
      // 1. Prvo proveri RD instant availability sa infoHash-om
      logger.log('Checking RD instant availability...');
      const instantFile = await checkRDInstantAvailability(infoHash);
      
      if (instantFile && instantFile.rd && instantFile.rd.length > 0) {
        // RD već ima cached torrent - uzmi direktan link
        logger.log('Found instant availability on RD!');
        // Instant availability vraća info o fajlovima, treba da dodamo torrent i uzmemo link
        // Za sada koristimo magnet link pristup
      }
      
      // 2. Ako nema instant availability, dodaj magnet link na RD
      if (!firstStream.magnetLink) {
        logger.error('No magnet link available for stream');
        return null;
      }
      
      const magnetPreview = firstStream.magnetLink.substring(0, 60);
      logger.log(`Adding magnet link to RD: ${magnetPreview}...`);
      const torrentId = await addTorrentToRD(firstStream.magnetLink);
      
      if (!torrentId) {
        logger.error('Failed to add torrent to RD');
        return null;
      }
      
      // 3. Čekaj da se torrent download završi i uzmi direktan link
      logger.log('Waiting for torrent to be ready on RD...');
      const rdDirectLink = await getTorrentDownloadLink(torrentId);
      
      if (!rdDirectLink) {
        logger.error('Failed to get direct download link from RD');
        return null;
      }
      
      logger.log('Successfully got direct link from RD');
      return rdDirectLink;
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
    
    // Torrentio vraća streams sa infoHash i sources (tracker URLs), ne direktnim URL-ovima
    // Treba da kreiramo magnet link ili koristimo infoHash za RD instant availability
    const streamLinks = data.streams.map(s => {
      const infoHash = s.infoHash;
      const sources = s.sources || [];
      const fileIdx = s.fileIdx;
      const filename = s.behaviorHints?.filename || s.title || 'Unknown';
      
      // Kreiraj magnet link iz infoHash i sources
      let magnetLink = null;
      if (infoHash) {
        const trackers = sources.filter(src => src.startsWith('http://') || src.startsWith('https://') || src.startsWith('udp://'));
        const trackerParams = trackers.map(t => `tr=${encodeURIComponent(t)}`).join('&');
        magnetLink = `magnet:?xt=urn:btih:${infoHash}${trackerParams ? '&' + trackerParams : ''}`;
      }
      
      return {
        name: s.name || 'Unknown',
        title: s.title || filename,
        infoHash: infoHash,
        fileIdx: fileIdx,
        filename: filename,
        magnetLink: magnetLink,
        sources: sources
      };
    }).filter(s => s.infoHash); // Filtriraj samo one sa infoHash-om
    
    logger.log(`Found ${streamLinks.length} valid streams from Torrentio (with infoHash)`);
    
    if (streamLinks.length === 0) {
      logger.error('No valid streams with infoHash found in Torrentio response');
      return null;
    }
    
    return streamLinks;
    
  } catch (err) {
    logger.error('Error getting stream links from Torrentio:', err.message);
    return null;
  }
}

export { 
  unrestrictRDFromId, 
  addTorrentToRD, 
  getTorrentDownloadLink, 
  searchTorrent,
  searchRDTorrents,
  checkRDInstantAvailability,
  getStreamLinksFromTorrentio
};