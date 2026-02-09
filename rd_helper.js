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
 async function unrestrictRDFromId(stremioId) {
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
      
      // 3️⃣ Prvo proveri postojeće torrentove na RD account-u
      logger.log(`Checking existing RD torrents for query: ${query}`);
      const existingTorrentResult = await searchRDTorrents(query);
      
      if (existingTorrentResult) {
        // Ako je direktan link, vrati ga odmah
        if (existingTorrentResult.startsWith('http://') || existingTorrentResult.startsWith('https://')) {
          logger.log('Found existing RD link, using it directly');
          return existingTorrentResult;
        }
        
        // Ako je torrent ID, uzmi direktan link
        if (typeof existingTorrentResult === 'string') {
          logger.log('Found existing RD torrent ID, getting direct link');
          const directLink = await getTorrentDownloadLink(existingTorrentResult);
          if (directLink) {
            return directLink;
          }
        }
      }
      
      // 4️⃣ Ako nema postojećeg torrenta, treba magnet link da dodamo novi
      logger.warn('No existing torrent found on RD account for:', query);
      logger.warn('Need magnet link to add new torrent to RD');
      logger.warn('TODO: Implement magnet link search or use mapping file');
      
      // Za sada vraćamo null - treba implementirati dobijanje magnet linka
      // Opcije:
      // - Koristi Torrentio addon API sa Stremio ID
      // - Koristi torrent search API
      // - Koristi mapping fajl sa predefinisanim linkovima
      
      return null;
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
    logger.log('Torrent added to RD, ID:', data.id);
    return data.id;
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
      logger.log(`Torrent status: ${torrentInfo.status} (${i + 1}/${maxRetries})`);

      // Status: 0=waiting, 1=downloading, 2=completed, 3=error
      if (torrentInfo.status === 2) {
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
      } else if (torrentInfo.status === 3) {
        logger.error('Torrent download failed on RD');
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
      
      // Loguj sve nazive torrentova za debugging
      const allFilenames = torrents.map(t => t.filename).filter(Boolean);
      logger.debug(`All RD torrent filenames (first 10): ${allFilenames.slice(0, 10).join(', ')}`);
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
        
        matchingTorrent = torrents.find(t => {
          if (!t.filename) return false;
          const filenameLower = t.filename.toLowerCase();
          return filenameLower.includes(seriesName) && 
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
 * Pokušava da dobije magnet link za Stremio ID
 * @param {string} stremioId - Stremio ID (npr. "tt9335498:5:6")
 * @param {string} query - Search query string
 * @returns {Promise<string|null>} Magnet link ili null
 */
async function getMagnetLinkFromStremioId(stremioId, query) {
  try {
    logger.log(`Attempting to get magnet link for Stremio ID: ${stremioId}`);
    
    // Opcija 1: Proveri mapping fajl
    const mappingFile = path.join(__dirname, 'torrent-mapping.json');
    if (fs.existsSync(mappingFile)) {
      const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
      if (mapping[stremioId]) {
        logger.log('Found magnet link in mapping file');
        return mapping[stremioId];
      }
      if (mapping[query]) {
        logger.log('Found magnet link in mapping file for query');
        return mapping[query];
      }
    }
    
    // Opcija 2: Koristi Torrentio addon API (ako je dostupan)
    // Možeš koristiti Torrentio addon URL da dobiješ stream info koji sadrži magnet link
    // Primer: https://torrentio.strem.fun/.../stream/{type}/{id}.json
    
    // Opcija 3: Koristi torrent search API
    // Možeš integrisati 1337x, RARBG, ili drugi torrent search API
    
    logger.warn('No magnet link found. Create torrent-mapping.json file with format:');
    logger.warn(`{ "${stremioId}": "magnet:?xt=urn:btih:..." }`);
    logger.warn(`or { "${query}": "magnet:?xt=urn:btih:..." }`);
    
    return null;
  } catch (err) {
    logger.error('Error getting magnet link:', err);
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
  getMagnetLinkFromStremioId
};