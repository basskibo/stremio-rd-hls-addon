import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMDB_API_KEY = "f593842b5c3424753cb2fec85a21b46f"; // stavi ovde svoj TMDb API key

export async function unrestrictRD(url) {
  try {
    logger.log('UNRESTRICT RD', url)
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
  
    if (!res.ok) {
      throw new Error('RD API error');
    }
  
    const data = await res.json();
    logger.log('DATA', data)
    return data.download;
  } catch (err) {
    logger.error('Error in unrestrictRD:', err);
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
      // 3️⃣ Search na Real-Debrid (ili unapred definisan link) → za sada hardkod test link
      // Ovde ide tvoja logika za RD API / torrent search
      // Za primer koristimo unrestrictRD na fiktivnom linku
      const rdUrl = await unrestrictRD(query); // unrestrictRD može da prihvati query string ili ID sa RD
      return rdUrl;
    } catch (err) {
      logger.error('Error in unrestrictRDFromId:', err);
      return null;
    }
  }
  

export { unrestrictRDFromId };