const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { unrestrictRDFromId } = require('./rd_helper');

const PC_IP = '192.168.1.16'; // ili IPv4 iz server.js (možeš dinamički ako želiš)

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

builder.defineStreamHandler(async ({ id }) => {
    console.log(`Request for stream: id=${id}`);
  
    // TODO: map Stremio ID -> RD link
    const rdLink = await unrestrictRDFromId(id); // može hardkod za test
    if (!rdLink) return res.json({ streams: [] });
  
    const startUrl = `http://${IPv4}:${PORT}/start?url=${encodeURIComponent(rdLink)}`;
    res.json({
      streams: [
        {
          name: 'Local PC (HLS)',
          title: 'RD → FFmpeg → HLS',
          url: startUrl
        }
      ]
    });

});


serveHTTP(builder.getInterface(), { port: 3001 });

console.log('Stremio addon running at http://localhost:3001/manifest.json');
