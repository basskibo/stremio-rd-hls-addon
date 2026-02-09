const TMDB_API_KEY = "f593842b5c3424753cb2fec85a21b46f"; // stavi ovde svoj TMDb API key

export async function unrestrictRD(url) {
  try {
    console.log('UNRESTRICT RD', url)
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
    console.log('DATA' , data)
    return data.download;
  } catch (err) {
    console.error('Error in unrestrictRD:', err);
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
        console.warn('TMDb ID not found for', imdbId);
        return null;
      }
  
      // 2️⃣ Ako je epizoda serije, dohvati naziv epizode
      let query = '';
      if (season && episode) {
        const epResp = await fetch(
          `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`
        );
        const epData = await epResp.json();
        console.log('epData', epData)

        if (!epData.name) {
          console.warn('Episode not found:', stremioId);
          return null;
        }
        query = `${findData.tv_results[0].name} S${season}E${episode} ${epData.name}`;
      } else {
        // Film
        query = findData.movie_results[0].title;
      }
  
      console.log('QUERY', query)
      console.log('findData', findData)
      console.log('tmdbId', tmdbId)
      console.log('imdbId', imdbId)
      console.log('season', season)
      console.log('episode', episode)
      console.log('parts', parts)
      console.log('stremioId', stremioId)
      // 3️⃣ Search na Real-Debrid (ili unapred definisan link) → za sada hardkod test link
      // Ovde ide tvoja logika za RD API / torrent search
      // Za primer koristimo unrestrictRD na fiktivnom linku
      const rdUrl = await unrestrictRD(query); // unrestrictRD može da prihvati query string ili ID sa RD
      return rdUrl;
    } catch (err) {
      console.error('Error in unrestrictRDFromId:', err);
      return null;
    }
  }
  

export { unrestrictRDFromId };