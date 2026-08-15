const sharp = require('sharp');
const { textWidth } = require('./textWidth');

const USER_AGENT = 'MyPhysicalHealth/1.0 (GPX ride poster generator; contact: kevin.mayfield@mayfield-is.co.uk)';
const TILE_SIZE = 256;
const MAX_TILES = 50;

const COLORS = {
  cardio: '#c1502f',
  strength: '#2f6b4f',
  recovery: '#c99a2e',
};
const CATEGORY_BY_CLASS = { flat: 'cardio', climb: 'strength', descent: 'recovery' };

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

function routePolylines(points, segments, projectFn, offsetX, offsetY) {
  const parts = [];
  for (const seg of segments) {
    const coords = [];
    for (let i = seg.startIdx; i <= seg.endIdx; i++) {
      const { x, y } = projectFn(points[i].lat, points[i].lon);
      coords.push(`${(x - offsetX).toFixed(1)},${(y - offsetY).toFixed(1)}`);
    }
    const color = COLORS[CATEGORY_BY_CLASS[seg.cls]];
    parts.push(
      `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`
    );
  }
  return parts.join('');
}

function pinMarkup(x, y, label, color, canvasWidth, canvasHeight) {
  const parts = [`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${color}" stroke="#fffaf0" stroke-width="2" />`];
  if (label) {
    const fontSize = 15;
    const paddingX = 9;
    const paddingY = 6;
    const gap = 12;
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

/**
 * Renders the real OpenStreetMap basemap with the colour-coded route and
 * highlight pins overlaid, cropped to the ride's padded bounding box.
 * Throws if tiles can't be fetched — caller should fall back to the
 * schematic renderer.
 */
async function renderBasemap(points, segments, highlights) {
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
  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}">
    ${routePolylines(points, segments, projectFn, cropOffsetX, cropOffsetY)}
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
function renderSchematic(points, segments, highlights) {
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

  const svgMarkup = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schematic route map">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#fdf9f0" />
    ${routePolylines(points, segments, projectFn, 0, 0)}
    ${pinsMarkup(highlights, projectFn, 0, 0, width, height)}
  </svg>`;

  return { svgMarkup, width, height, usedBasemap: false };
}

async function renderRouteMap(points, segments, highlights) {
  try {
    return await renderBasemap(points, segments, highlights);
  } catch {
    return renderSchematic(points, segments, highlights);
  }
}

module.exports = { renderRouteMap, COLORS };
