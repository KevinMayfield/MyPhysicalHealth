const { parseGpx } = require('./gpx');
const { analyseRide } = require('./analysis');
const { geocodeHighlights, geocodeSpots } = require('./geocode');
const { renderRouteMap } = require('./map');
const { buildElevationSvg } = require('./elevationProfile');
const { buildReportHtml } = require('./template');

/**
 * Runs the full GPX-to-poster pipeline and returns the finished
 * self-contained HTML report string.
 */
async function generateReportHtml(gpxXml, options = {}) {
  const { name, activityType, points } = parseGpx(gpxXml);
  return generateReportHtmlFromPoints({ name, activityType, points }, options);
}

/**
 * Same pipeline as generateReportHtml, but starting from an already-
 * parsed {name, activityType, points} triple instead of raw GPX XML —
 * shared by the GPX upload flow and the Strava import flow.
 */
async function generateReportHtmlFromPoints({ name, activityType, points }, { includeToolbar = false, pdfHref = '', age = null, ftp = null, lthr = null } = {}) {
  const rideName = name || 'Untitled ride';
  const analysis = analyseRide(points, { age, ftp, lthr });

  const { climbName, flatName } = await geocodeHighlights(analysis.highlightClimb, analysis.highlightFlat);

  const highlights = {
    climb: analysis.highlightClimb && { ...analysis.highlightClimb, name: climbName },
    flat: analysis.highlightFlat && { ...analysis.highlightFlat, name: flatName },
  };

  const lowValueSpotsNamed = await geocodeSpots(analysis.lowValueSpots);
  const bonkEpisodesNamed = await geocodeSpots(analysis.bonkEpisodes);
  const decoupleOnsetNamed = analysis.decoupleOnset ? (await geocodeSpots([analysis.decoupleOnset]))[0] : null;

  const mapResult = await renderRouteMap(
    points,
    analysis.segments,
    analysis.effortSegments,
    highlights,
    analysis.lowValueSpots,
    analysis.bonkEpisodes,
    analysis.decoupleOnset,
    analysis.mapStartIdx,
    analysis.mapEndIdx
  );
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
    recovery: analysis.stats.recovery,
    cardioName: flatName,
    strengthName: climbName,
    effortSource: analysis.effortSource,
    effortThreshold: analysis.effortThreshold,
    activityType,
    powerSummary: analysis.powerSummary,
    hrSummary: analysis.hrSummary,
    ageSummary: analysis.ageSummary,
    lowValueSpots: lowValueSpotsNamed,
    bonkEpisodes: bonkEpisodesNamed,
    decoupleOnset: decoupleOnsetNamed,
    peakHrOverall: analysis.peakHr,
    includeToolbar,
    pdfHref,
  });

  return { html, rideName };
}

module.exports = { generateReportHtml, generateReportHtmlFromPoints };
