const sharp = require('sharp');
const { textWidth } = require('./textWidth');
const { EFFORT_COLORS } = require('./effortColors');
const { SPOT_COLORS } = require('./spotColors');

const USER_AGENT = 'MyPhysicalHealth/1.0 (GPX ride poster generator; contact: kevin.mayfield@mayfield-is.co.uk)';
const TILE_SIZE = 256;
const MAX_TILES = 50;

const COLORS = {
  cardio: '#2f6b4f',
  strength: '#c97a2f',
  recovery: '#3f6fa8',
};
const CATEGORY_BY_CLASS = { flat: 'cardio', climb: 'strength', descent: 'recovery' };

const LOW_VALUE_COLOR = SPOT_COLORS.lowValue;
const JUNCTION_COLOR = SPOT_COLORS.junction;
const BONK_COLOR = SPOT_COLORS.bonk;
const DECOUPLE_COLOR = SPOT_COLORS.decouple;

function lon2xFrac(lon, zoom) {
  return ((lon + 180) / 360) * Math.pow(2, zoom);
}

function lat2yFrac(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom);
}

function project(lat, lon, zoom) {
  return { x: lon2xFrac(lon, zoom) * TILE_SIZE, y: lat2yFrac(lat, zoom) * TILE_SIZE };
}

function computeBbox(points, paddingFrac) {
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  for (const p of points) {
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
  }
  const latPad = (latMax - latMin) * paddingFrac || 0.001;
  const lonPad = (lonMax - lonMin) * paddingFrac || 0.001;
  return {
    latMin: latMin - latPad,
    latMax: latMax + latPad,
    lonMin: lonMin - lonPad,
    lonMax: lonMax + lonPad,
  };
}

function tileCountAtZoom(bbox, zoom) {
  const xMin = Math.floor(lon2xFrac(bbox.lonMin, zoom));
  const xMax = Math.floor(lon2xFrac(bbox.lonMax, zoom));
  const yMin = Math.floor(lat2yFrac(bbox.latMax, zoom));
  const yMax = Math.floor(lat2yFrac(bbox.latMin, zoom));
  return { xMin, xMax, yMin, yMax, count: (xMax - xMin + 1) * (yMax - yMin + 1) };
}

function chooseZoom(bbox) {
  // Tile count only shrinks as zoom decreases, so the first (highest,
  // most detailed) zoom satisfying the cap is the best available.
  for (let zoom = 18; zoom >= 3; zoom--) {
    const t = tileCountAtZoom(bbox, zoom);
    if (t.count <= MAX_TILES) return { zoom, ...t };
  }
  return { zoom: 3, ...tileCountAtZoom(bbox, 3) };
}

async function fetchTile(zoom, x, y) {
  const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Tile fetch failed: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Colours the route by effort (heart rate, or power if HR is absent) when
// available; falls back to the terrain-category colours otherwise.
function resolveRouteColorSegments(terrainSegments, effortSegments) {
  if (effortSegments && effortSegments.length) {
    return effortSegments.map((s) => ({ startIdx: s.startIdx, endIdx: s.endIdx, color: EFFORT_COLORS[s.bin] }));
  }
  return terrainSegments.map((s) => ({ startIdx: s.startIdx, endIdx: s.endIdx, color: COLORS[CATEGORY_BY_CLASS[s.cls]] }));
}

function routePolylines(points, colorSegments, projectFn, offsetX, offsetY) {
  const parts = [];
  for (const seg of colorSegments) {
    const coords = [];
    for (let i = seg.startIdx; i <= seg.endIdx; i++) {
      const { x, y } = projectFn(points[i].lat, points[i].lon);
      coords.push(`${(x - offsetX).toFixed(1)},${(y - offsetY).toFixed(1)}`);
    }
    parts.push(
      `<polyline points="${coords.join(' ')}" fill="none" stroke="${seg.color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`
    );
  }
  return parts.join('');
}

function pinMarkup(x, y, label, color, canvasWidth, canvasHeight) {
  const parts = [`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="${color}" stroke="#fffaf0" stroke-width="2.5" />`];
  if (label) {
    const fontSize = 17;
    const paddingX = 10;
    const paddingY = 7;
    const gap = 15;
    const boxW = textWidth(label, fontSize) + paddingX * 2;
    const boxH = fontSize + paddingY * 2;

    const fitsRight = canvasWidth === undefined || x + gap + boxW <= canvasWidth - 4;
    const boxX = fitsRight ? x + gap : x - gap - boxW;

    let boxY = y - boxH / 2;
    if (canvasHeight !== undefined) {
      boxY = Math.max(4, Math.min(boxY, canvasHeight - boxH - 4));
    }
    const textY = boxY + boxH / 2 + fontSize * 0.36;

    parts.push(
      `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="6" ry="6" fill="rgba(253,249,240,0.92)" stroke="${color}" stroke-width="1.5" />`,
      `<text x="${(boxX + paddingX).toFixed(1)}" y="${textY.toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#2b2b24">${escapeXml(label)}</text>`
    );
  }
  return parts.join('');
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pinsMarkup(highlights, projectFn, offsetX, offsetY, canvasWidth, canvasHeight) {
  const defs = [
    highlights.climb && { ...highlights.climb, color: COLORS.strength },
    highlights.flat && { ...highlights.flat, color: COLORS.cardio },
  ].filter(Boolean);
  return defs
    .map((pin) => {
      const { x, y } = projectFn(pin.lat, pin.lon);
      return pinMarkup(x - offsetX, y - offsetY, pin.name, pin.color, canvasWidth, canvasHeight);
    })
    .join('');
}

// A filled circle with a minus sign: a stretch that sat in the easiest
// zone for no obvious terrain reason.
function lowValueMarkup(x, y) {
  const r = 11;
  return [
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${LOW_VALUE_COLOR}" stroke="#fffaf0" stroke-width="2.5" />`,
    `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="800" fill="#fffaf0" text-anchor="middle">&#8722;</text>`,
  ].join('');
}

// A warning triangle: a low-value stretch where speed also dipped
// sharply, hinting at a junction, lights, a rest stop, or a rough patch.
function junctionMarkup(x, y) {
  const s = 13;
  const points = [
    [x, y - s],
    [x - s, y + s * 0.75],
    [x + s, y + s * 0.75],
  ]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  return [
    `<polygon points="${points}" fill="${JUNCTION_COLOR}" stroke="#fffaf0" stroke-width="2" stroke-linejoin="round" />`,
    `<text x="${x.toFixed(1)}" y="${(y + s * 0.75 - 3).toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="800" fill="#fffaf0" text-anchor="middle">!</text>`,
  ].join('');
}

// A diamond with a downward arrow: an extended, non-recovering energy
// crash — distinct in shape and colour from the low-value/junction icons.
function bonkMarkup(x, y) {
  const s = 13;
  const points = [
    [x, y - s],
    [x + s, y],
    [x, y + s],
    [x - s, y],
  ]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  return [
    `<polygon points="${points}" fill="${BONK_COLOR}" stroke="#fffaf0" stroke-width="2" stroke-linejoin="round" />`,
    `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="800" fill="#fffaf0" text-anchor="middle">&#8595;</text>`,
  ].join('');
}

// A hexagon with a downward arrow: the earlier warning sign of a bonk —
// power dropping relative to heart rate, before the crash itself. Same
// declining-arrow motif as the bonk marker, but a different shape and a
// lighter, amber colour to read as "warning" rather than "confirmed."
function decoupleMarkup(x, y) {
  const s = 13;
  const points = [0, 60, 120, 180, 240, 300].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return [x + s * Math.sin(rad), y - s * Math.cos(rad)];
  });
  const pointsStr = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  return [
    `<polygon points="${pointsStr}" fill="${DECOUPLE_COLOR}" stroke="#fffaf0" stroke-width="2" stroke-linejoin="round" />`,
    `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="800" fill="#fffaf0" text-anchor="middle">&#8595;</text>`,
  ].join('');
}

function lowValueMarkersMarkup(lowValueSpots, projectFn, offsetX, offsetY) {
  if (!lowValueSpots || !lowValueSpots.length) return '';
  return lowValueSpots
    .map((spot) => {
      const { x, y } = projectFn(spot.lat, spot.lon);
      const px = x - offsetX;
      const py = y - offsetY;
      return spot.possibleJunction ? junctionMarkup(px, py) : lowValueMarkup(px, py);
    })
    .join('');
}

function bonkMarkersMarkup(bonkEpisodes, projectFn, offsetX, offsetY) {
  if (!bonkEpisodes || !bonkEpisodes.length) return '';
  return bonkEpisodes
    .map((ep) => {
      const { x, y } = projectFn(ep.lat, ep.lon);
      return bonkMarkup(x - offsetX, y - offsetY);
    })
    .join('');
}

function decoupleMarkersMarkup(decoupleOnset, projectFn, offsetX, offsetY) {
  if (!decoupleOnset) return '';
  const { x, y } = projectFn(decoupleOnset.lat, decoupleOnset.lon);
  return decoupleMarkup(x - offsetX, y - offsetY);
}

/**
 * Renders the real OpenStreetMap basemap with the colour-coded route and
 * highlight pins overlaid, cropped to the ride's padded bounding box.
 * Throws if tiles can't be fetched — caller should fall back to the
 * schematic renderer.
 */
async function renderBasemap(points, segments, effortSegments, highlights, lowValueSpots, bonkEpisodes, decoupleOnset) {
  const bbox = computeBbox(points, 0.08);
  const { zoom, xMin, xMax, yMin, yMax } = chooseZoom(bbox);

  const positions = [];
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) positions.push({ tx, ty });
  }
  const tileBuffers = await mapWithConcurrency(positions, 6, ({ tx, ty }) => fetchTile(zoom, tx, ty));

  const gridW = (xMax - xMin + 1) * TILE_SIZE;
  const gridH = (yMax - yMin + 1) * TILE_SIZE;

  const composites = positions.map(({ tx, ty }, i) => ({
    input: tileBuffers[i],
    left: (tx - xMin) * TILE_SIZE,
    top: (ty - yMin) * TILE_SIZE,
  }));

  const gridBuffer = await sharp({
    create: { width: gridW, height: gridH, channels: 3, background: '#eae6d9' },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const originX = xMin * TILE_SIZE;
  const originY = yMin * TILE_SIZE;
  const projectFn = (lat, lon) => project(lat, lon, zoom);

  const topLeft = projectFn(bbox.latMax, bbox.lonMin);
  const bottomRight = projectFn(bbox.latMin, bbox.lonMax);
  const cropX = Math.max(0, Math.round(topLeft.x - originX));
  const cropY = Math.max(0, Math.round(topLeft.y - originY));
  const cropW = Math.min(gridW - cropX, Math.round(bottomRight.x - topLeft.x));
  const cropH = Math.min(gridH - cropY, Math.round(bottomRight.y - topLeft.y));

  const croppedBuffer = await sharp(gridBuffer).extract({ left: cropX, top: cropY, width: cropW, height: cropH }).png().toBuffer();

  const cropOffsetX = originX + cropX;
  const cropOffsetY = originY + cropY;
  const colorSegments = resolveRouteColorSegments(segments, effortSegments);
  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}">
    ${routePolylines(points, colorSegments, projectFn, cropOffsetX, cropOffsetY)}
    ${lowValueMarkersMarkup(lowValueSpots, projectFn, cropOffsetX, cropOffsetY)}
    ${bonkMarkersMarkup(bonkEpisodes, projectFn, cropOffsetX, cropOffsetY)}
    ${decoupleMarkersMarkup(decoupleOnset, projectFn, cropOffsetX, cropOffsetY)}
    ${pinsMarkup(highlights, projectFn, cropOffsetX, cropOffsetY, cropW, cropH)}
  </svg>`;

  const finalBuffer = await sharp(croppedBuffer)
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return {
    dataUrl: `data:image/png;base64,${finalBuffer.toString('base64')}`,
    width: cropW,
    height: cropH,
    usedBasemap: true,
  };
}

/**
 * Fallback schematic map: a locally-projected polyline on a plain card,
 * no basemap, same colour coding. Returned as inline SVG markup (no
 * raster step needed) for use when tiles are unavailable.
 */
function renderSchematic(points, segments, effortSegments, highlights, lowValueSpots, bonkEpisodes, decoupleOnset) {
  const width = 900;
  const height = 560;
  const margin = 60;

  const latMin = Math.min(...points.map((p) => p.lat));
  const latMax = Math.max(...points.map((p) => p.lat));
  const lonMin = Math.min(...points.map((p) => p.lon));
  const lonMax = Math.max(...points.map((p) => p.lon));
  const cosLat = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);

  const xOf = (lon) => (lon - lonMin) * cosLat;
  const yOf = (lat) => latMax - lat;

  const spanX = Math.max(xOf(lonMax), 1e-9);
  const spanY = Math.max(yOf(latMin), 1e-9);
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const projectFn = (lat, lon) => ({ x: xOf(lon) * scale + offsetX, y: yOf(lat) * scale + offsetY });

  const colorSegments = resolveRouteColorSegments(segments, effortSegments);
  const svgMarkup = `<svg class="map-zoom-target" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schematic route map">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#fdf9f0" />
    ${routePolylines(points, colorSegments, projectFn, 0, 0)}
    ${lowValueMarkersMarkup(lowValueSpots, projectFn, 0, 0)}
    ${bonkMarkersMarkup(bonkEpisodes, projectFn, 0, 0)}
    ${decoupleMarkersMarkup(decoupleOnset, projectFn, 0, 0)}
    ${pinsMarkup(highlights, projectFn, 0, 0, width, height)}
  </svg>`;

  return { svgMarkup, width, height, usedBasemap: false };
}

async function renderRouteMap(points, segments, effortSegments, highlights, lowValueSpots, bonkEpisodes, decoupleOnset) {
  try {
    return await renderBasemap(points, segments, effortSegments, highlights, lowValueSpots, bonkEpisodes, decoupleOnset);
  } catch {
    return renderSchematic(points, segments, effortSegments, highlights, lowValueSpots, bonkEpisodes, decoupleOnset);
  }
}

module.exports = { renderRouteMap, COLORS };
