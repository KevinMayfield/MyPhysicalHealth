const { parseGpx } = require('./gpx');
const { analyseRide } = require('./analysis');
const { geocodeHighlights } = require('./geocode');
const { renderRouteMap } = require('./map');
const { buildElevationSvg } = require('./elevationProfile');
const { buildReportHtml } = require('./template');

/**
 * Runs the full GPX-to-poster pipeline and returns the finished
 * self-contained HTML report string.
 */
async function generateReportHtml(gpxXml, { includeToolbar = false, pdfHref = '' } = {}) {
  const { name, points } = parseGpx(gpxXml);
  const rideName = name || 'Untitled ride';
  const analysis = analyseRide(points);

  const { climbName, flatName } = await geocodeHighlights(analysis.highlightClimb, analysis.highlightFlat);

  const highlights = {
    climb: analysis.highlightClimb && { ...analysis.highlightClimb, name: climbName },
    flat: analysis.highlightFlat && { ...analysis.highlightFlat, name: flatName },
  };

  const mapResult = await renderRouteMap(points, analysis.segments, highlights);
  const elevationSvg = buildElevationSvg(points, analysis);

  const totalClimbM = analysis.stats.cardio.elevGainM + analysis.stats.strength.elevGainM + analysis.stats.recovery.elevGainM;

  const hrValues = points.map((p) => p.hr).filter((h) => typeof h === 'number');
  const avgHrOverall = hrValues.length ? hrValues.reduce((a, b) => a + b, 0) / hrValues.length : null;

  const html = buildReportHtml({
    rideName,
    rideDate: points[0].time,
    totalDistanceKm: analysis.totalDistanceM / 1000,
    totalDurationS: analysis.totalDurationS,
    totalClimbM,
    avgHrOverall,
    mapResult,
    elevationSvg,
    cardio: analysis.stats.cardio,
    strength: analysis.stats.strength,
    cardioName: flatName,
    strengthName: climbName,
    includeToolbar,
    pdfHref,
  });

  return { html, rideName };
}

module.exports = { generateReportHtml };
