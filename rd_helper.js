import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMDB_API_KEY = "f593842b5c3424753cb2fec85a21b46f"; // stavi ovde svoj TMDb API key

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
          'Authorization': 'Bearer I2TRCIH5PJN7WU4427ESNCB6NPAK7FY4633MQ5LR3CZAX75T3KBQ',
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
      
      // 3️⃣ TODO: Ovde treba da se implementira logika za pretragu na Real-Debrid
      // Trenutno query je samo string sa nazivom, ali unrestrictRD očekuje RD link
      // Opcije:
      // - Pretraži RD torrents sa query stringom
      // - Koristi unapred definisan RD link
      // - Koristi RD cached link ako postoji
      
      logger.warn('unrestrictRDFromId: query string passed to unrestrictRD, but it expects RD link URL');
      logger.warn('Query:', query);
      logger.warn('TODO: Implement RD search/torrent lookup logic here');
      
      // Za sada vraćamo null jer nemamo validan RD link
      return null;
      
      // Kada implementiraš RD search, koristi ovako:
      // const rdLink = await searchRDOrGetCachedLink(query);
      // if (!rdLink) return null;
      // const rdUrl = await unrestrictRD(rdLink);
      // return rdUrl;
    } catch (err) {
      logger.error('Error in unrestrictRDFromId:', err);
      return null;
    }
  }
  

export { unrestrictRDFromId };