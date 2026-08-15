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

function secondsBetween(a, b) {
  if (!a || !b) return 0;
  return (b.getTime() - a.getTime()) / 1000;
}

/**
 * Runs the full analysis pipeline described in CLAUDE.md over a parsed
 * list of GPX trackpoints and returns per-point series, per-category
 * aggregates, and the two highlight segments.
 */
function analyseRide(points) {
  const n = points.length;
  const dist = new Array(n).fill(0); // cumulative metres
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + haversineMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }

  const hasTime = points.every((p) => p.time instanceof Date && !isNaN(p.time));

  // --- Elevation smoothing (rolling ~15s window, or index window if no time) ---
  const rawEle = points.map((p) => (typeof p.ele === 'number' ? p.ele : null));
  const smoothEle = new Array(n);
  for (let i = 0; i < n; i++) {
    let lo = i;
    let hi = i;
    if (hasTime) {
      while (lo > 0 && secondsBetween(points[lo - 1].time, points[i].time) <= SMOOTH_WINDOW_S / 2) lo--;
      while (hi < n - 1 && secondsBetween(points[i].time, points[hi + 1].time) <= SMOOTH_WINDOW_S / 2) hi++;
    } else {
      lo = Math.max(0, i - 7);
      hi = Math.min(n - 1, i + 7);
    }
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

  return {
    dist,
    smoothEle,
    gradient,
    pointClass,
    segments,
    totalDistanceM,
    totalDurationS,
    stats,
    highlightClimb: highlightInfo(highlightClimb, peakHrIdx),
    highlightFlat: highlightInfo(highlightFlat, minEleIdx),
    peakHr: peakHr > -Infinity ? peakHr : null,
  };
}

module.exports = { analyseRide, haversineMeters };
