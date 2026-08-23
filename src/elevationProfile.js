const { COLORS } = require('./map');
const { EFFORT_COLORS } = require('./effortColors');
const { SPOT_COLORS } = require('./spotColors');

const CATEGORY_BY_CLASS = { flat: 'cardio', climb: 'strength', descent: 'recovery' };

const FILL_ALPHA = {
  cardio: 'rgba(47, 107, 79, 0.32)',
  strength: 'rgba(201, 122, 47, 0.32)',
  recovery: 'rgba(63, 111, 168, 0.32)',
};

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const EFFORT_FILL_ALPHA = EFFORT_COLORS.map((hex) => hexToRgba(hex, 0.32));

function diamondMarker(x, y, s, color) {
  const pts = [
    [x, y - s],
    [x + s, y],
    [x, y + s],
    [x - s, y],
  ]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  return `<polygon points="${pts}" fill="${color}" stroke="#fffaf0" stroke-width="1.5" stroke-linejoin="round" />`;
}

function hexagonMarker(x, y, s, color) {
  const pts = [0, 60, 120, 180, 240, 300]
    .map((deg) => {
      const rad = (deg * Math.PI) / 180;
      return [x + s * Math.sin(rad), y - s * Math.cos(rad)];
    })
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  return `<polygon points="${pts}" fill="${color}" stroke="#fffaf0" stroke-width="1.5" stroke-linejoin="round" />`;
}

function circleMarker(x, y, s, color) {
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s}" fill="${color}" stroke="#fffaf0" stroke-width="1.5" />`;
}

function triangleMarker(x, y, s, color) {
  const pts = [
    [x, y - s],
    [x - s, y + s * 0.75],
    [x + s, y + s * 0.75],
  ]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  return `<polygon points="${pts}" fill="${color}" stroke="#fffaf0" stroke-width="1.5" stroke-linejoin="round" />`;
}

/**
 * Builds an inline SVG elevation profile: distance on x, elevation on y,
 * filled area + line. Coloured by effort (heart rate, or power if HR is
 * absent) when available, matching the map; falls back to the terrain
 * category colours otherwise. Pass `zoneSegments` to colour by a specific
 * metric's zones (e.g. analysis.hrZoneSegments or .powerZoneSegments)
 * instead of the ride's primary effort metric. Pass `colorSegmentsOverride`
 * (already-resolved `{startIdx, endIdx, color}`, e.g. from
 * colorSegments.resolveClassColorSegments) to colour by any other
 * per-point classification instead -- takes priority over `zoneSegments`
 * when both are given. Marks any low-value/
 * junction spots, bonk episodes, and the aerobic decoupling onset (if
 * found) along the top, with a guide line down to the profile so they're
 * easy to line up with the climb/descent below.
 */
function buildElevationSvg(points, analysis, width = 880, height = 220, zoneSegments, colorSegmentsOverride) {
  const { dist, smoothEle, segments, effortSegments, lowValueSpots, bonkEpisodes, decoupleOnset } = analysis;
  const n = points.length;
  const hasMarkers = Boolean((lowValueSpots && lowValueSpots.length) || (bonkEpisodes && bonkEpisodes.length) || decoupleOnset);
  const margin = { top: hasMarkers ? 30 : 16, right: 12, bottom: 12, left: 12 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const totalDist = dist[n - 1] || 1;
  const minEle = Math.min(...smoothEle);
  const maxEle = Math.max(...smoothEle);
  const eleRange = maxEle - minEle || 1;

  const xOf = (i) => margin.left + (dist[i] / totalDist) * plotW;
  const yOf = (i) => margin.top + (1 - (smoothEle[i] - minEle) / eleRange) * plotH;
  const baseline = margin.top + plotH;

  const segsToUse = zoneSegments || effortSegments;
  const useEffort = segsToUse && segsToUse.length > 0;
  const colorSegments =
    colorSegmentsOverride && colorSegmentsOverride.length
      ? colorSegmentsOverride.map((s) => ({ startIdx: s.startIdx, endIdx: s.endIdx, stroke: s.color, fill: hexToRgba(s.color, 0.32) }))
      : useEffort
        ? segsToUse.map((s) => ({ startIdx: s.startIdx, endIdx: s.endIdx, stroke: EFFORT_COLORS[s.bin], fill: EFFORT_FILL_ALPHA[s.bin] }))
        : segments.map((s) => {
            const cat = CATEGORY_BY_CLASS[s.cls];
            return { startIdx: s.startIdx, endIdx: s.endIdx, stroke: COLORS[cat], fill: FILL_ALPHA[cat] };
          });

  // Long mountain rides can carry tens of thousands of points; drawing
  // every one bloats the SVG enough to choke the renderer. One or two
  // points per pixel of chart width is visually lossless at this scale.
  const MAX_PROFILE_POINTS = 1200;
  const stride = Math.max(1, Math.floor(n / MAX_PROFILE_POINTS));

  const parts = [];
  for (const seg of colorSegments) {
    const endIdx = Math.min(seg.endIdx + 1, n - 1); // extend to next point so fills touch, no gaps

    const linePts = [];
    for (let i = seg.startIdx; i <= endIdx; i += stride) linePts.push(`${xOf(i).toFixed(1)},${yOf(i).toFixed(1)}`);
    if ((endIdx - seg.startIdx) % stride !== 0) linePts.push(`${xOf(endIdx).toFixed(1)},${yOf(endIdx).toFixed(1)}`);

    const areaPts = [`${xOf(seg.startIdx).toFixed(1)},${baseline.toFixed(1)}`, ...linePts, `${xOf(endIdx).toFixed(1)},${baseline.toFixed(1)}`];

    parts.push(`<polygon points="${areaPts.join(' ')}" fill="${seg.fill}" />`);
    parts.push(`<polyline points="${linePts.join(' ')}" fill="none" stroke="${seg.stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`);
  }

  if (hasMarkers) {
    const xAtKm = (km) => margin.left + ((km * 1000) / totalDist) * plotW;
    const markerY = 15;
    const guideTop = markerY + 10;

    function guideLine(x, color) {
      parts.push(`<line x1="${x.toFixed(1)}" y1="${guideTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${baseline.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.55" />`);
    }

    for (const spot of lowValueSpots || []) guideLine(xAtKm(spot.atDistanceKm), spot.possibleJunction ? SPOT_COLORS.junction : SPOT_COLORS.lowValue);
    for (const ep of bonkEpisodes || []) guideLine(xAtKm(ep.atStartKm), SPOT_COLORS.bonk);
    if (decoupleOnset) guideLine(xAtKm(decoupleOnset.atKm), SPOT_COLORS.decouple);

    for (const spot of lowValueSpots || []) {
      const x = xAtKm(spot.atDistanceKm);
      if (spot.possibleJunction) parts.push(triangleMarker(x, markerY, 8, SPOT_COLORS.junction));
      else parts.push(circleMarker(x, markerY, 7, SPOT_COLORS.lowValue));
    }
    for (const ep of bonkEpisodes || []) {
      parts.push(diamondMarker(xAtKm(ep.atStartKm), markerY, 9, SPOT_COLORS.bonk));
    }
    if (decoupleOnset) {
      parts.push(hexagonMarker(xAtKm(decoupleOnset.atKm), markerY, 9, SPOT_COLORS.decouple));
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Elevation profile">${parts.join('')}</svg>`;
}

module.exports = { buildElevationSvg };
