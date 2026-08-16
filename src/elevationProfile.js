const { COLORS } = require('./map');
const { EFFORT_COLORS } = require('./effortColors');

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

/**
 * Builds an inline SVG elevation profile: distance on x, elevation on y,
 * filled area + line. Coloured by effort (heart rate, or power if HR is
 * absent) when available, matching the map; falls back to the terrain
 * category colours otherwise.
 */
function buildElevationSvg(points, analysis, width = 880, height = 220) {
  const { dist, smoothEle, segments, effortSegments } = analysis;
  const n = points.length;
  const margin = { top: 16, right: 12, bottom: 12, left: 12 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const totalDist = dist[n - 1] || 1;
  const minEle = Math.min(...smoothEle);
  const maxEle = Math.max(...smoothEle);
  const eleRange = maxEle - minEle || 1;

  const xOf = (i) => margin.left + (dist[i] / totalDist) * plotW;
  const yOf = (i) => margin.top + (1 - (smoothEle[i] - minEle) / eleRange) * plotH;
  const baseline = margin.top + plotH;

  const useEffort = effortSegments && effortSegments.length > 0;
  const colorSegments = useEffort
    ? effortSegments.map((s) => ({ startIdx: s.startIdx, endIdx: s.endIdx, stroke: EFFORT_COLORS[s.bin], fill: EFFORT_FILL_ALPHA[s.bin] }))
    : segments.map((s) => {
        const cat = CATEGORY_BY_CLASS[s.cls];
        return { startIdx: s.startIdx, endIdx: s.endIdx, stroke: COLORS[cat], fill: FILL_ALPHA[cat] };
      });

  const parts = [];
  for (const seg of colorSegments) {
    const endIdx = Math.min(seg.endIdx + 1, n - 1); // extend to next point so fills touch, no gaps

    const linePts = [];
    for (let i = seg.startIdx; i <= endIdx; i++) linePts.push(`${xOf(i).toFixed(1)},${yOf(i).toFixed(1)}`);

    const areaPts = [`${xOf(seg.startIdx).toFixed(1)},${baseline.toFixed(1)}`, ...linePts, `${xOf(endIdx).toFixed(1)},${baseline.toFixed(1)}`];

    parts.push(`<polygon points="${areaPts.join(' ')}" fill="${seg.fill}" />`);
    parts.push(`<polyline points="${linePts.join(' ')}" fill="none" stroke="${seg.stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`);
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Elevation profile">${parts.join('')}</svg>`;
}

module.exports = { buildElevationSvg };
