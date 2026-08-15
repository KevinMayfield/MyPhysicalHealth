const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
});

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parses a GPX 1.1 (Strava export style) buffer/string into an ordered
 * array of trackpoints: { lat, lon, ele, time (Date), hr, cad, atemp }.
 * HR/cadence/temp are optional per point and may be undefined.
 */
function parseGpx(xml) {
  const doc = parser.parse(xml);
  const gpx = doc.gpx;
  if (!gpx) throw new Error('Not a valid GPX file');

  const tracks = toArray(gpx.trk);
  if (tracks.length === 0) throw new Error('GPX file has no tracks');

  const name = tracks[0].name ? String(tracks[0].name) : undefined;

  const points = [];
  for (const trk of tracks) {
    for (const seg of toArray(trk.trkseg)) {
      for (const pt of toArray(seg.trkpt)) {
        const lat = num(pt.lat);
        const lon = num(pt.lon);
        if (lat === undefined || lon === undefined) continue;

        const ele = num(pt.ele);
        const time = pt.time ? new Date(pt.time) : undefined;

        let hr;
        let cad;
        let atemp;
        const ext = pt.extensions;
        if (ext) {
          const tpe = ext['gpxtpx:TrackPointExtension'];
          if (tpe) {
            hr = num(tpe['gpxtpx:hr']);
            cad = num(tpe['gpxtpx:cad']);
            atemp = num(tpe['gpxtpx:atemp']);
          }
        }

        points.push({ lat, lon, ele, time, hr, cad, atemp });
      }
    }
  }

  if (points.length === 0) throw new Error('GPX file has no trackpoints');

  return { name, points };
}

module.exports = { parseGpx };
