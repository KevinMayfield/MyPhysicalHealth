const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const FLAT_THRESHOLD = 1.5; // %
const SMOOTH_WINDOW_S = 15; // seconds, +/- half
const GRADIENT_WINDOW_M = 40; // metres, +/- half
const MIN_SEGMENT_S = 20; // seconds

const BEST_POWER_WINDOW_S = 20 * 60; // best sustained 20-minute effort
const FTP_FROM_BEST20_FACTOR = 0.95; // FTP estimate = 95% of that
// A single-ride LTHR estimate is commonly quoted as 85-90% of max HR
// recorded during the ride; 88% is the midpoint of that range.
const LTHR_FROM_MAXHR_FACTOR = 0.88;

// Tanaka et al. (2001) age-predicted max HR: 208 - 0.7 x age.
const TANAKA_MAXHR_INTERCEPT = 208;
const TANAKA_MAXHR_AGE_FACTOR = 0.7;

// --- "Low training value" detection ---
const LOW_VALUE_ZONE_BIN = 0; // Zone 1, 0-indexed
const HARD_EFFORT_MIN_BIN = 3; // Zone 4+ counts as a hard effort
const DESCENT_SPEED_TOLERANCE = 0.15; // a "mild" descent isn't >15% faster than average
const RECOVERY_GRACE_S = 60; // Zone 1 within 1 min of a hard effort is normal recovery
const LOW_VALUE_MIN_S = 30; // ignore blips shorter than this
const LOW_VALUE_MAX_SPOTS = 6; // cap how many we report
const STOP_SPEED_KMH = 8; // a dip below this suggests a stop (junction, lights, gate)
const PRIVACY_EXCLUSION_M = 200; // never flag near the very start/end of the route

// --- Bonk detection ---
// A bonk shows up as Zone 1 output that doesn't recover, on terrain that
// should demand more (climbing or flat — a descent is legitimately easy
// regardless of fuel level, so it's excluded). This works whether the
// underlying zone is power/FTP or heart-rate/LTHR based, since it reuses
// whichever is primary; raw speed alone is too confounded by gradient on
// mountainous rides to use directly.
const BONK_ZONE_BIN = 0; // Zone 1, 0-indexed
const BONK_FOLD_GAP_S = 300; // a recovery has to hold for 5+ min to end an episode
const BONK_MIN_S = 480; // minimum 8 min to count as a bonk, not just a lull
const BONK_MODERATE_S = 30 * 60;
const BONK_SEVERE_S = 90 * 60;
const BONK_MAX_SPOTS = 4;
// Glycogen depletion can't happen in the first few km — this filters
// out a slow staging/neutralised rollout at the start.
const BONK_WARMUP_MIN_M = 3000;
// Nor can it happen without having actually worked hard first — this
// filters out a congested, bunched-up mass-participation start, which
// looks like low output but isn't fuel depletion.
const BONK_MIN_PRIOR_HARD_EFFORT_S = 45 * 60;
// Glycogen depletion is fundamentally a long-ride phenomenon — a couple
// of hours in at the least, even for a hard effort. This is what
// actually separates a real bonk from a relaxed, low-output stretch of
// an otherwise short ride.
const BONK_MIN_ELAPSED_S = 2.5 * 60 * 60;
// A near-standstill for the whole episode is more likely a deliberate
// rest/feed stop than a bonk, which is defined by crawling, not parking.
const BONK_MIN_AVG_SPEED_KMH = 4;
// Aerobic decoupling: power-per-heartbeat compared against an early-ride
// baseline (skipping warm-up), restricted to non-descent points.
const DECOUPLE_WINDOW_S = 20 * 60;
const DECOUPLE_BASELINE_START_FRAC = 0.1;
const DECOUPLE_BASELINE_END_FRAC = 0.35;
const DECOUPLE_THRESHOLD_PCT = 15;
const DECOUPLE_HOLD_S = 600; // decoupling must hold for 10+ min to count as onset
// A device auto-pause or GPS dropout can leave a large gap between two
// points; capping each interval stops that gap inflating a segment's
// apparent duration into looking like a longer bonk than it really was.
const BONK_GAP_CAP_S = 60;

function secondsBetween(a, b) {
  if (!a || !b) return 0;
  return (b.getTime() - a.getTime()) / 1000;
}

/**
 * Zone 1-5 from % of FTP (cycling power zones).
 */
function powerZone(power, ftp) {
  if (!ftp || ftp <= 0) return 3;
  const pct = (power / ftp) * 100;
  if (pct <= 55) return 1;
  if (pct <= 75) return 2;
  if (pct <= 90) return 3;
  if (pct <= 105) return 4;
  return 5;
}

/**
 * Zone 1-5 from % of LTHR (cycling heart-rate zones).
 */
function hrZone(hr, lthr) {
  if (!lthr || lthr <= 0) return 3;
  const pct = (hr / lthr) * 100;
  if (pct < 81) return 1;
  if (pct <= 89) return 2;
  if (pct <= 94) return 3;
  if (pct <= 105) return 4;
  return 5;
}

/**
 * Smooths one per-point metric (power or heart rate) over the shared
 * ~15s window, filling any start/end gaps from the nearest value so
 * every point ends up with a value.
 */
function smoothEffortSeries(points, hasTime, timeWindowBounds, source) {
  const n = points.length;
  const raw = points.map((p) => (typeof p[source] === 'number' ? p[source] : null));
  const smooth = new Array(n);
  for (let i = 0; i < n; i++) {
    const [lo, hi] = timeWindowBounds(i);
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      if (raw[j] !== null) {
        sum += raw[j];
        count++;
      }
    }
    smooth[i] = count > 0 ? sum / count : null;
  }
  for (let i = 1; i < n; i++) if (smooth[i] === null) smooth[i] = smooth[i - 1];
  for (let i = n - 2; i >= 0; i--) if (smooth[i] === null) smooth[i] = smooth[i + 1];
  return smooth;
}

/**
 * Bins an already-smoothed series into zones via zoneOf, and returns the
 * fold-cleaned zone segments, seconds spent in each of the 5 zones, and
 * the moderate (zones 2-3) / vigorous (zones 4-5) totals.
 */
function zonesFromSmoothSeries(points, hasTime, smooth, zoneOf) {
  const n = points.length;
  const zoneBin = smooth.map((v) => zoneOf(v) - 1); // 0-indexed: 0=Zone1 ... 4=Zone5

  const zoneSecondsByBin = [0, 0, 0, 0, 0];
  let moderateS = 0;
  let vigorousS = 0;
  for (let i = 1; i < n; i++) {
    const dt = hasTime ? secondsBetween(points[i - 1].time, points[i].time) : 1;
    const bin = zoneBin[i];
    zoneSecondsByBin[bin] += dt;
    if (bin === 1 || bin === 2) moderateS += dt;
    else if (bin === 3 || bin === 4) vigorousS += dt;
  }

  let start = 0;
  const rawSegs = [];
  for (let i = 1; i <= n; i++) {
    if (i === n || zoneBin[i] !== zoneBin[start]) {
      rawSegs.push({ bin: zoneBin[start], startIdx: start, endIdx: i - 1 });
      start = i;
    }
  }
  const segments = foldShortSegments(rawSegs, 'bin', points, hasTime);

  return { zoneBin, segments, zoneSecondsByBin, moderateS, vigorousS };
}

/**
 * Computes a full effort-zone breakdown (FTP zones for power, LTHR zones
 * for heart rate) for one metric: the threshold, zone segments for
 * colouring, and total moderate (zones 2-3) / vigorous (zones 4-5)
 * seconds. Independent of which metric (if any) drives the map colour,
 * so power and heart rate can both be summarised when both are present.
 *
 * If manualThreshold is given (a known real-world FTP or LTHR), it's
 * used directly instead of estimating one from this ride — a known
 * value is more trustworthy than an in-ride estimate.
 */
function computeEffortZones(points, hasTime, timeWindowBounds, source, manualThreshold) {
  const smooth = smoothEffortSeries(points, hasTime, timeWindowBounds, source);
  const isManual = typeof manualThreshold === 'number' && Number.isFinite(manualThreshold) && manualThreshold > 0;

  let threshold;
  let zoneOf;
  if (source === 'power') {
    threshold = isManual ? manualThreshold : bestAverageOverWindow(points, hasTime, BEST_POWER_WINDOW_S, 'power') * FTP_FROM_BEST20_FACTOR;
    zoneOf = (v) => powerZone(v, threshold);
  } else {
    threshold = isManual
      ? manualThreshold
      : Math.max(...points.filter((p) => typeof p.hr === 'number').map((p) => p.hr)) * LTHR_FROM_MAXHR_FACTOR;
    zoneOf = (v) => hrZone(v, threshold);
  }

  const { zoneBin, segments, zoneSecondsByBin, moderateS, vigorousS } = zonesFromSmoothSeries(points, hasTime, smooth, zoneOf);
  return { threshold, isManual, zoneBin, segments, zoneSecondsByBin, moderateS, vigorousS };
}

/**
 * Best average of `key` (e.g. power) over any windowS-second stretch of
 * the ride, via a sliding window. If the ride is shorter than the
 * window, falls back to the overall average.
 */
function bestAverageOverWindow(points, hasTime, windowS, key) {
  const n = points.length;
  const totalDurationS = hasTime ? secondsBetween(points[0].time, points[n - 1].time) : n;
  const values = points.map((p) => (typeof p[key] === 'number' ? p[key] : null));

  if (totalDurationS < windowS) {
    const valid = values.filter((v) => v !== null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  }

  let lo = 0;
  let sum = 0;
  let count = 0;
  let best = 0;
  for (let hi = 0; hi < n; hi++) {
    if (values[hi] !== null) {
      sum += values[hi];
      count++;
    }
    while (lo < hi && (hasTime ? secondsBetween(points[lo].time, points[hi].time) : hi - lo) > windowS) {
      if (values[lo] !== null) {
        sum -= values[lo];
        count--;
      }
      lo++;
    }
    const span = hasTime ? secondsBetween(points[lo].time, points[hi].time) : hi - lo;
    if (span >= windowS && count > 0) {
      const avg = sum / count;
      if (avg > best) best = avg;
    }
  }
  return best;
}

/**
 * Groups consecutive same-key segments, folding any shorter than minSegS
 * into a neighbour so brief noise doesn't fragment the series. Generic
 * over the key field name so it can fold either terrain classes or
 * effort bins.
 */
function foldShortSegments(rawSegs, keyField, points, hasTime, minSegS = MIN_SEGMENT_S) {
  let segs = rawSegs.map((s) => ({ ...s }));
  const segDurationS = (seg) =>
    hasTime ? secondsBetween(points[seg.startIdx].time, points[seg.endIdx].time) : seg.endIdx - seg.startIdx;
  const mergeInto = (target, source) => {
    target.startIdx = Math.min(target.startIdx, source.startIdx);
    target.endIdx = Math.max(target.endIdx, source.endIdx);
  };

  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      if (segDurationS(segs[i]) < minSegS) {
        if (i > 0) {
          mergeInto(segs[i - 1], segs[i]);
          segs.splice(i, 1);
        } else {
          mergeInto(segs[i + 1], segs[i]);
          segs.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
    const combined = [];
    for (const seg of segs) {
      const prev = combined[combined.length - 1];
      if (prev && prev[keyField] === seg[keyField] && prev.endIdx + 1 === seg.startIdx) {
        prev.endIdx = seg.endIdx;
      } else {
        combined.push({ ...seg });
      }
    }
    segs = combined;
  }
  return segs;
}

/**
 * Runs the full analysis pipeline described in CLAUDE.md over a parsed
 * list of GPX trackpoints and returns per-point series, per-category
 * aggregates, and the two highlight segments.
 */
function analyseRide(points, { age, ftp, lthr } = {}) {
  const n = points.length;
  const dist = new Array(n).fill(0); // cumulative metres
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + haversineMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }

  // Privacy: the map (bounding box, drawn route, and any flagged spots)
  // should never show the first/last 200m, since a ride's start/end is
  // very often the rider's home.
  let mapStartIdx = 0;
  while (mapStartIdx < n - 1 && dist[mapStartIdx] < PRIVACY_EXCLUSION_M) mapStartIdx++;
  let mapEndIdx = n - 1;
  while (mapEndIdx > 0 && dist[n - 1] - dist[mapEndIdx] < PRIVACY_EXCLUSION_M) mapEndIdx--;
  if (mapEndIdx <= mapStartIdx) {
    mapStartIdx = 0;
    mapEndIdx = n - 1;
  }

  const hasTime = points.every((p) => p.time instanceof Date && !isNaN(p.time));

  // Shared ~15s (or +/-7 point) smoothing window, reused for elevation,
  // speed, and effort so they all move at the same time resolution.
  function timeWindowBounds(i) {
    let lo = i;
    let hi = i;
    if (hasTime) {
      while (lo > 0 && secondsBetween(points[lo - 1].time, points[i].time) <= SMOOTH_WINDOW_S / 2) lo--;
      while (hi < n - 1 && secondsBetween(points[i].time, points[hi + 1].time) <= SMOOTH_WINDOW_S / 2) hi++;
    } else {
      lo = Math.max(0, i - 7);
      hi = Math.min(n - 1, i + 7);
    }
    return [lo, hi];
  }

  // --- Elevation smoothing (rolling ~15s window, or index window if no time) ---
  const rawEle = points.map((p) => (typeof p.ele === 'number' ? p.ele : null));
  const smoothEle = new Array(n);
  for (let i = 0; i < n; i++) {
    const [lo, hi] = timeWindowBounds(i);
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      if (rawEle[j] !== null) {
        sum += rawEle[j];
        count++;
      }
    }
    smoothEle[i] = count > 0 ? sum / count : rawEle[i] ?? 0;
  }

  // --- Effort zones: FTP (power) and/or LTHR (heart rate), computed
  //     independently and separately whenever the underlying metric is
  //     present. Power drives the map/elevation colouring when both are
  //     available, but both summaries are reported. ---
  const hasPower = points.some((p) => typeof p.power === 'number');
  const hasHr = points.some((p) => typeof p.hr === 'number');

  const powerZones = hasPower ? computeEffortZones(points, hasTime, timeWindowBounds, 'power', ftp) : null;
  const hrZones = hasHr ? computeEffortZones(points, hasTime, timeWindowBounds, 'hr', lthr) : null;

  const effortSource = hasPower ? 'power' : hasHr ? 'hr' : null;
  const primaryZones = effortSource === 'power' ? powerZones : effortSource === 'hr' ? hrZones : null;
  const effortSegments = primaryZones ? primaryZones.segments : [];
  const effortThreshold = primaryZones ? primaryZones.threshold : null;

  const powerSummary = powerZones
    ? {
        ftp: powerZones.threshold,
        isManual: powerZones.isManual,
        zoneSecondsByBin: powerZones.zoneSecondsByBin,
        moderateS: powerZones.moderateS,
        vigorousS: powerZones.vigorousS,
      }
    : null;
  const hrSummary = hrZones
    ? {
        lthr: hrZones.threshold,
        isManual: hrZones.isManual,
        zoneSecondsByBin: hrZones.zoneSecondsByBin,
        moderateS: hrZones.moderateS,
        vigorousS: hrZones.vigorousS,
      }
    : null;

  // --- Age-based LTHR (Tanaka max-HR estimate), same zone thresholds as
  //     the recorded-HR LTHR summary, just anchored to an age-estimated
  //     max HR instead of the ride's own peak. ---
  let ageSummary = null;
  if (hasHr && typeof age === 'number' && Number.isFinite(age) && age > 0) {
    const maxHrEstimated = TANAKA_MAXHR_INTERCEPT - TANAKA_MAXHR_AGE_FACTOR * age;
    const ageLthr = maxHrEstimated * LTHR_FROM_MAXHR_FACTOR;
    const hrSmooth = smoothEffortSeries(points, hasTime, timeWindowBounds, 'hr');
    const { zoneSecondsByBin, moderateS, vigorousS } = zonesFromSmoothSeries(points, hasTime, hrSmooth, (v) => hrZone(v, ageLthr));
    ageSummary = { maxHrEstimated, lthr: ageLthr, zoneSecondsByBin, moderateS, vigorousS };
  }

  // --- Smoothed speed (km/h) over the same ~15s window, used to tell a
  //     genuinely fast/steep descent (legitimate free speed) apart from a
  //     mild one where the rider isn't actually going any faster than
  //     usual ---
  const speedKmh = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const [lo, hi] = timeWindowBounds(i);
    const runM = dist[hi] - dist[lo];
    const runS = hasTime ? secondsBetween(points[lo].time, points[hi].time) : hi - lo;
    speedKmh[i] = runS > 0 ? (runM / runS) * 3.6 : 0;
  }

  // --- Local gradient (%) over a ~40m distance window on smoothed elevation ---
  const gradient = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let lo = i;
    let hi = i;
    while (lo > 0 && dist[i] - dist[lo - 1] <= GRADIENT_WINDOW_M / 2) lo--;
    while (hi < n - 1 && dist[hi + 1] - dist[i] <= GRADIENT_WINDOW_M / 2) hi++;
    const runM = dist[hi] - dist[lo];
    gradient[i] = runM > 0 ? ((smoothEle[hi] - smoothEle[lo]) / runM) * 100 : 0;
  }

  // --- Classification ---
  const classOf = (g) => (g > FLAT_THRESHOLD ? 'climb' : g < -FLAT_THRESHOLD ? 'descent' : 'flat');
  const pointClass = gradient.map(classOf);

  // --- Group into initial segments of consecutive same class ---
  let segments = [];
  {
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || pointClass[i] !== pointClass[start]) {
        segments.push({ cls: pointClass[start], startIdx: start, endIdx: i - 1 });
        start = i;
      }
    }
  }

  const segDurationS = (seg) =>
    hasTime ? secondsBetween(points[seg.startIdx].time, points[seg.endIdx].time) : seg.endIdx - seg.startIdx;

  // --- Fold segments shorter than ~20s into a neighbour ---
  const mergeInto = (target, source) => {
    target.startIdx = Math.min(target.startIdx, source.startIdx);
    target.endIdx = Math.max(target.endIdx, source.endIdx);
  };

  let changed = true;
  while (changed && segments.length > 1) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      if (segDurationS(segments[i]) < MIN_SEGMENT_S) {
        if (i > 0) {
          mergeInto(segments[i - 1], segments[i]);
          segments.splice(i, 1);
        } else {
          mergeInto(segments[i + 1], segments[i]);
          segments.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
    // Recombine adjacent segments that ended up with the same class.
    const combined = [];
    for (const seg of segments) {
      const prev = combined[combined.length - 1];
      if (prev && prev.cls === seg.cls && prev.endIdx + 1 === seg.startIdx) {
        prev.endIdx = seg.endIdx;
      } else {
        combined.push({ ...seg });
      }
    }
    segments = combined;
  }

  // --- Per-category aggregation ---
  const CATEGORY_BY_CLASS = { flat: 'cardio', climb: 'strength', descent: 'recovery' };
  const categories = { cardio: emptyAgg(), strength: emptyAgg(), recovery: emptyAgg() };

  function emptyAgg() {
    return {
      distanceM: 0,
      durationS: 0,
      hrSum: 0,
      hrCount: 0,
      hrMax: -Infinity,
      cadSum: 0,
      cadCount: 0,
      elevGainM: 0,
      elevLossM: 0,
    };
  }

  const segClassOfIdx = new Array(n);
  for (const seg of segments) {
    for (let i = seg.startIdx; i <= seg.endIdx; i++) segClassOfIdx[i] = seg.cls;
  }

  for (const seg of segments) {
    const cat = CATEGORY_BY_CLASS[seg.cls];
    const agg = categories[cat];
    agg.distanceM += dist[seg.endIdx] - dist[seg.startIdx];
    agg.durationS += segDurationS(seg);
    for (let i = seg.startIdx; i <= seg.endIdx; i++) {
      const p = points[i];
      if (typeof p.hr === 'number') {
        agg.hrSum += p.hr;
        agg.hrCount++;
        if (p.hr > agg.hrMax) agg.hrMax = p.hr;
      }
      if (typeof p.cad === 'number' && p.cad > 0) {
        agg.cadSum += p.cad;
        agg.cadCount++;
      }
      if (i > seg.startIdx) {
        const delta = smoothEle[i] - smoothEle[i - 1];
        if (delta > 0) agg.elevGainM += delta;
        else agg.elevLossM += -delta;
      }
    }
  }

  const totalDurationS = hasTime ? secondsBetween(points[0].time, points[n - 1].time) : n;
  const totalDistanceM = dist[n - 1];

  const stats = {};
  for (const cat of Object.keys(categories)) {
    const a = categories[cat];
    stats[cat] = {
      distanceKm: a.distanceM / 1000,
      durationS: a.durationS,
      pctTime: totalDurationS > 0 ? (a.durationS / totalDurationS) * 100 : 0,
      avgSpeedKmh: a.durationS > 0 ? (a.distanceM / 1000) / (a.durationS / 3600) : 0,
      avgHr: a.hrCount > 0 ? a.hrSum / a.hrCount : null,
      maxHr: a.hrCount > 0 ? a.hrMax : null,
      avgCadence: a.cadCount > 0 ? a.cadSum / a.cadCount : null,
      elevGainM: a.elevGainM,
      elevLossM: a.elevLossM,
    };
  }

  // --- Highlights ---
  let peakHrIdx = -1;
  let peakHr = -Infinity;
  let minEleIdx = -1;
  let minEle = Infinity;
  for (let i = 0; i < n; i++) {
    if (typeof points[i].hr === 'number' && points[i].hr > peakHr) {
      peakHr = points[i].hr;
      peakHrIdx = i;
    }
    if (smoothEle[i] < minEle) {
      minEle = smoothEle[i];
      minEleIdx = i;
    }
  }

  const climbSegments = segments.filter((s) => s.cls === 'climb');
  const flatSegments = segments.filter((s) => s.cls === 'flat');

  const scoreClimb = (s) => (dist[s.endIdx] - dist[s.startIdx]) * (segDurationS(s) || 1);
  let highlightClimb =
    (peakHrIdx >= 0 && climbSegments.find((s) => peakHrIdx >= s.startIdx && peakHrIdx <= s.endIdx)) ||
    climbSegments.slice().sort((a, b) => scoreClimb(b) - scoreClimb(a))[0] ||
    null;

  let highlightFlat =
    (minEleIdx >= 0 &&
      flatSegments.find((s) => minEleIdx >= s.startIdx && minEleIdx <= s.endIdx && segDurationS(s) >= 60)) ||
    flatSegments.slice().sort((a, b) => segDurationS(b) - segDurationS(a))[0] ||
    null;

  function highlightInfo(seg, preferIdx) {
    if (!seg) return null;
    const repIdx =
      preferIdx !== undefined && preferIdx >= seg.startIdx && preferIdx <= seg.endIdx
        ? preferIdx
        : Math.round((seg.startIdx + seg.endIdx) / 2);
    return {
      startIdx: seg.startIdx,
      endIdx: seg.endIdx,
      distanceKm: (dist[seg.endIdx] - dist[seg.startIdx]) / 1000,
      durationS: segDurationS(seg),
      lat: points[repIdx].lat,
      lon: points[repIdx].lon,
    };
  }

  // --- Low training-value spots: Zone 1 on flat or only mildly downhill
  //     terrain, away from the very start/end of the route (privacy), and
  //     not immediately after a hard effort (that's normal recovery, not
  //     a missed opportunity). A dip in speed within the spot suggests it
  //     may be a junction, traffic lights, or a rough patch that forced a
  //     slowdown, rather than just an easy stretch. ---
  const overallAvgSpeedKmh = totalDurationS > 0 ? (totalDistanceM / 1000) / (totalDurationS / 3600) : 0;

  let lowValueSpots = [];
  if (primaryZones) {
    const zoneBin = primaryZones.zoneBin;
    const lowValueFlag = new Array(n).fill(false);
    let lastHardEffortTime = null;
    let lastHardEffortIdx = -1;

    for (let i = 0; i < n; i++) {
      if (zoneBin[i] >= HARD_EFFORT_MIN_BIN) {
        lastHardEffortTime = points[i].time;
        lastHardEffortIdx = i;
      }

      if (dist[i] < PRIVACY_EXCLUSION_M || dist[i] > totalDistanceM - PRIVACY_EXCLUSION_M) continue;
      if (zoneBin[i] !== LOW_VALUE_ZONE_BIN) continue;
      if (pointClass[i] === 'climb') continue;
      if (pointClass[i] === 'descent' && speedKmh[i] > overallAvgSpeedKmh * (1 + DESCENT_SPEED_TOLERANCE)) continue;

      const sinceHardS =
        lastHardEffortIdx < 0
          ? Infinity
          : hasTime
            ? secondsBetween(lastHardEffortTime, points[i].time)
            : i - lastHardEffortIdx;
      if (sinceHardS < RECOVERY_GRACE_S) continue;

      lowValueFlag[i] = true;
    }

    let start = 0;
    const rawLowSegs = [];
    for (let i = 1; i <= n; i++) {
      if (i === n || lowValueFlag[i] !== lowValueFlag[start]) {
        rawLowSegs.push({ flag: lowValueFlag[start], startIdx: start, endIdx: i - 1 });
        start = i;
      }
    }
    const foldedLowSegs = foldShortSegments(rawLowSegs, 'flag', points, hasTime);

    lowValueSpots = foldedLowSegs
      .filter((seg) => seg.flag && segDurationS(seg) >= LOW_VALUE_MIN_S)
      .map((seg) => {
        let minSpeed = Infinity;
        for (let i = seg.startIdx; i <= seg.endIdx; i++) if (speedKmh[i] < minSpeed) minSpeed = speedKmh[i];
        const repIdx = Math.round((seg.startIdx + seg.endIdx) / 2);
        return {
          startIdx: seg.startIdx,
          endIdx: seg.endIdx,
          atDistanceKm: dist[repIdx] / 1000, // how far into the ride this spot is
          durationS: segDurationS(seg),
          lat: points[repIdx].lat,
          lon: points[repIdx].lon,
          possibleJunction: minSpeed < STOP_SPEED_KMH,
        };
      })
      .sort((a, b) => b.durationS - a.durationS)
      .slice(0, LOW_VALUE_MAX_SPOTS);
  }

  // --- Bonk detection: extended, non-recovering Zone 1 output on
  //     climbing or flat terrain (a fast descent is excluded — coasting
  //     downhill is easy regardless of fuel level). ---
  function movingDurationS(seg) {
    if (!hasTime) return seg.endIdx - seg.startIdx;
    let total = 0;
    for (let i = seg.startIdx + 1; i <= seg.endIdx; i++) {
      total += Math.min(secondsBetween(points[i - 1].time, points[i].time), BONK_GAP_CAP_S);
    }
    return total;
  }

  let bonkEpisodes = [];
  let decoupleOnset = null;
  if (primaryZones) {
    const zoneBin = primaryZones.zoneBin;
    const bonkFlag = new Array(n).fill(false);
    let cumHardEffortS = 0;
    for (let i = 0; i < n; i++) {
      const elapsedS = hasTime ? secondsBetween(points[0].time, points[i].time) : i;
      const eligible =
        elapsedS >= BONK_MIN_ELAPSED_S &&
        dist[i] >= BONK_WARMUP_MIN_M &&
        cumHardEffortS >= BONK_MIN_PRIOR_HARD_EFFORT_S;
      bonkFlag[i] = eligible && zoneBin[i] === BONK_ZONE_BIN && pointClass[i] !== 'descent';
      if (i > 0) {
        const dt = hasTime ? secondsBetween(points[i - 1].time, points[i].time) : 1;
        if (zoneBin[i] >= 1) cumHardEffortS += dt;
      }
    }

    let start = 0;
    const rawBonkSegs = [];
    for (let i = 1; i <= n; i++) {
      if (i === n || bonkFlag[i] !== bonkFlag[start]) {
        rawBonkSegs.push({ flag: bonkFlag[start], startIdx: start, endIdx: i - 1 });
        start = i;
      }
    }
    const foldedBonkSegs = foldShortSegments(rawBonkSegs, 'flag', points, hasTime, BONK_FOLD_GAP_S);

    bonkEpisodes = foldedBonkSegs
      .filter((seg) => {
        if (!seg.flag || movingDurationS(seg) < BONK_MIN_S) return false;
        // A crawl, not a standstill: exclude near-total stops (a feed
        // station or mechanical), which isn't the same thing as a bonk.
        const avgSpeedKmh = (dist[seg.endIdx] - dist[seg.startIdx]) / 1000 / (movingDurationS(seg) / 3600);
        return avgSpeedKmh >= BONK_MIN_AVG_SPEED_KMH;
      })
      .map((seg) => {
        const durationS = movingDurationS(seg);
        return {
          startIdx: seg.startIdx,
          endIdx: seg.endIdx,
          durationS,
          severity: durationS >= BONK_SEVERE_S ? 'severe' : durationS >= BONK_MODERATE_S ? 'moderate' : 'mild',
          atStartKm: dist[seg.startIdx] / 1000,
          atEndKm: dist[seg.endIdx] / 1000,
          lat: points[seg.startIdx].lat,
          lon: points[seg.startIdx].lon,
        };
      })
      .sort((a, b) => a.startIdx - b.startIdx)
      .slice(0, BONK_MAX_SPOTS);

    // Aerobic decoupling onset — only meaningful with both power and HR,
    // and only worth surfacing once we know a bonk actually happened.
    if (bonkEpisodes.length && hasPower && hasHr) {
      const powerSmooth = smoothEffortSeries(points, hasTime, timeWindowBounds, 'power');
      const hrSmooth = smoothEffortSeries(points, hasTime, timeWindowBounds, 'hr');
      const firstBonkIdx = bonkEpisodes[0].startIdx;
      const baselineStartS = totalDurationS * DECOUPLE_BASELINE_START_FRAC;
      const baselineEndS = totalDurationS * DECOUPLE_BASELINE_END_FRAC;

      let baseSumP = 0;
      let baseSumH = 0;
      for (let i = 0; i < n; i++) {
        const t = hasTime ? secondsBetween(points[0].time, points[i].time) : i;
        if (t < baselineStartS || t > baselineEndS || pointClass[i] === 'descent') continue;
        baseSumP += powerSmooth[i];
        baseSumH += hrSmooth[i];
      }
      const baselineRatio = baseSumH > 0 ? baseSumP / baseSumH : null;

      if (baselineRatio) {
        let lo = 0;
        let sumP = 0;
        let sumH = 0;
        let belowSinceIdx = null;
        let onsetIdx = null;
        for (let i = 0; i < firstBonkIdx; i++) {
          if (pointClass[i] !== 'descent') {
            sumP += powerSmooth[i];
            sumH += hrSmooth[i];
          }
          while (lo < i && (hasTime ? secondsBetween(points[lo].time, points[i].time) : i - lo) > DECOUPLE_WINDOW_S) {
            if (pointClass[lo] !== 'descent') {
              sumP -= powerSmooth[lo];
              sumH -= hrSmooth[lo];
            }
            lo++;
          }
          const span = hasTime ? secondsBetween(points[lo].time, points[i].time) : i - lo;
          if (span < DECOUPLE_WINDOW_S || sumH <= 0) continue;

          const dropPct = ((baselineRatio - sumP / sumH) / baselineRatio) * 100;
          if (dropPct >= DECOUPLE_THRESHOLD_PCT) {
            if (belowSinceIdx === null) belowSinceIdx = i;
          } else {
            belowSinceIdx = null;
          }
          if (belowSinceIdx !== null && onsetIdx === null) {
            const heldS = hasTime ? secondsBetween(points[belowSinceIdx].time, points[i].time) : i - belowSinceIdx;
            if (heldS >= DECOUPLE_HOLD_S) onsetIdx = belowSinceIdx;
          }
        }
        if (onsetIdx !== null) {
          decoupleOnset = { atKm: dist[onsetIdx] / 1000, lat: points[onsetIdx].lat, lon: points[onsetIdx].lon };
        }
      }
    }
  }

  return {
    dist,
    smoothEle,
    gradient,
    pointClass,
    segments,
    effortSegments,
    effortSource,
    effortThreshold,
    powerSummary,
    hrSummary,
    ageSummary,
    lowValueSpots,
    bonkEpisodes,
    decoupleOnset,
    mapStartIdx,
    mapEndIdx,
    totalDistanceM,
    totalDurationS,
    stats,
    highlightClimb: highlightInfo(highlightClimb, peakHrIdx),
    highlightFlat: highlightInfo(highlightFlat, minEleIdx),
    peakHr: peakHr > -Infinity ? peakHr : null,
  };
}

module.exports = { analyseRide, haversineMeters };
