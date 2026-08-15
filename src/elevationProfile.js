const { COLORS } = require('./map');

const CATEGORY_BY_CLASS = { flat: 'cardio', climb: 'strength', descent: 'recovery' };

const FILL_ALPHA = {
  cardio: 'rgba(193, 80, 47, 0.32)',
  strength: 'rgba(47, 107, 79, 0.32)',
  recovery: 'rgba(201, 154, 46, 0.32)',
};

/**
 * Builds an inline SVG elevation profile: distance on x, elevation on y,
 * filled area + line, coloured per segment with the same category
 * colours used on the map.
 */
function buildElevationSvg(points, analysis, width = 880, height = 220) {
  const { dist, smoothEle, segments } = analysis;
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

  const parts = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const endIdx = Math.min(seg.endIdx + 1, n - 1); // extend to next point so fills touch, no gaps
    const cat = CATEGORY_BY_CLASS[seg.cls];

    const linePts = [];
    for (let i = seg.startIdx; i <= endIdx; i++) linePts.push(`${xOf(i).toFixed(1)},${yOf(i).toFixed(1)}`);

    const areaPts = [`${xOf(seg.startIdx).toFixed(1)},${baseline.toFixed(1)}`, ...linePts, `${xOf(endIdx).toFixed(1)},${baseline.toFixed(1)}`];

    parts.push(`<polygon points="${areaPts.join(' ')}" fill="${FILL_ALPHA[cat]}" />`);
    parts.push(`<polyline points="${linePts.join(' ')}" fill="none" stroke="${COLORS[cat]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`);
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Elevation profile">${parts.join('')}</svg>`;
}

module.exports = { buildElevationSvg };
