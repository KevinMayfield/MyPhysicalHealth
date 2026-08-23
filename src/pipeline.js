const { parseGpx } = require('./gpx');
const { analyseRide } = require('./analysis');
const { geocodeHighlights, geocodeSpots } = require('./geocode');
const { renderRouteMap, resolveRouteColorSegments } = require('./map');
const { resolveClassColorSegments } = require('./colorSegments');
const { TECHNICAL_COLORS } = require('./technicalColors');
const { TERRAIN_COLORS } = require('./terrainColors');
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
async function generateReportHtmlFromPoints(
  { name, activityType, points },
  { includeToolbar = false, pdfHref = '', age = null, ftp = null, lthr = null, stravaActivityId = null } = {}
) {
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
    resolveRouteColorSegments(analysis.segments, analysis.effortSegments),
    highlights,
    analysis.lowValueSpots,
    analysis.bonkEpisodes,
    analysis.decoupleOnset,
    analysis.mapStartIdx,
    analysis.mapEndIdx
  );
  // The flat elevation chart defaults to LTHR (heart-rate) zones when
  // available; otherwise it falls back to the ride's primary effort
  // metric (power, if present) or plain terrain colouring. A second FTP
  // (power) zones chart is only added when both metrics are present,
  // since otherwise it would just duplicate the primary chart.
  const elevationSvg = analysis.hrZoneSegments
    ? buildElevationSvg(points, analysis, 880, 220, analysis.hrZoneSegments)
    : buildElevationSvg(points, analysis);
  const elevationSvgFtp =
    analysis.hrZoneSegments && analysis.powerZoneSegments
      ? buildElevationSvg(points, analysis, 880, 220, analysis.powerZoneSegments)
      : null;

  // Two extra map + elevation pairs, neither with highlight pins or spot
  // markers of its own: a finer terrain breakdown (flat/rolling/sustained
  // climb/descent), and technical/difficult sections (winding, braking,
  // cautious descents) -- both independent of the main cardio/strength/
  // recovery split and of each other.
  const terrainColorSegments = resolveClassColorSegments(analysis.terrainSegments, TERRAIN_COLORS);
  const terrainMapResult = await renderRouteMap(points, terrainColorSegments, {}, [], [], null, analysis.mapStartIdx, analysis.mapEndIdx);
  const terrainElevationSvg = buildElevationSvg(points, analysis, 880, 220, null, terrainColorSegments);

  const technicalColorSegments = resolveClassColorSegments(analysis.technicalSegments, TECHNICAL_COLORS);
  const technicalMapResult = await renderRouteMap(points, technicalColorSegments, {}, [], [], null, analysis.mapStartIdx, analysis.mapEndIdx);
  const technicalElevationSvg = buildElevationSvg(points, analysis, 880, 220, null, technicalColorSegments);

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
    elevationSvgFtp,
    terrainMapResult,
    terrainElevationSvg,
    terrainSegments: analysis.terrainSegments,
    technicalMapResult,
    technicalElevationSvg,
    technicalSegments: analysis.technicalSegments,
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
    stravaActivityId,
  });

  return { html, rideName };
}

module.exports = { generateReportHtml, generateReportHtmlFromPoints };
