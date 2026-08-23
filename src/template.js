const { css } = require('./style');
const icons = require('./icons');
const { formatDistanceKm, formatDuration, formatInt, formatDate, formatActivityLabel, escapeHtml } = require('./format');
const { EFFORT_COLORS, EFFORT_LABELS } = require('./effortColors');
const { TECHNICAL_COLORS, TECHNICAL_LABELS } = require('./technicalColors');
const { TERRAIN_COLORS, TERRAIN_LABELS } = require('./terrainColors');
const { hrZoneRangeLabels, powerZoneRangeLabels } = require('./analysis');

function statCell(value, unit, label) {
  return `<div class="stat"><div><span class="value">${value}</span>${unit ? `<span class="unit">${unit}</span>` : ''}</div><div class="label">${label}</div></div>`;
}

function panelStat(value, label) {
  return `<div class="item"><span class="value">${value}</span><span class="label">${label}</span></div>`;
}

function benefitCard(icon, title, body) {
  return `<div class="benefit-card"><div class="icon">${icon}</div><div><h4>${title}</h4><p>${body}</p></div></div>`;
}

/**
 * Assembles the full self-contained poster report HTML: header/hero,
 * route map + elevation profile, cardio/strength panels, benefits
 * section, takeaway band, and footer. Same markup is used for the
 * on-screen view and (via the print stylesheet) for PDF export.
 */
function buildReportHtml(data) {
  const {
    rideName,
    rideDate,
    totalDistanceKm,
    totalDurationS,
    totalClimbM,
    avgHrOverall,
    mapResult,
    elevationSvg,
    elevationSvgFtp,
    terrainMapResult,
    terrainElevationSvg,
    technicalMapResult,
    technicalElevationSvg,
    technicalSegments,
    cardio,
    strength,
    recovery,
    cardioName,
    strengthName,
    effortSource,
    activityType,
    powerSummary,
    hrSummary,
    ageSummary,
    lowValueSpots,
    bonkEpisodes,
    decoupleOnset,
    peakHrOverall,
    includeToolbar,
    pdfHref,
    stravaActivityId,
  } = data;

  const stravaUrl = stravaActivityId ? `https://www.strava.com/activities/${encodeURIComponent(stravaActivityId)}` : null;

  const cardioSpot = cardioName || 'the flattest stretch of the ride';
  const strengthSpot = strengthName || 'the steepest climb of the ride';
  const cardioSpotLabel = cardioName ? escapeHtml(cardioName) : 'the flat stretch';
  const strengthSpotLabel = strengthName ? escapeHtml(strengthName) : 'the climb';

  const mapAlt = effortSource ? 'Route map coloured by effort' : 'Route map coloured by workout type';
  const mapMediaHtml = mapResult.usedBasemap
    ? `<img class="map-zoom-target" src="${mapResult.dataUrl}" alt="${mapAlt}" />`
    : mapResult.svgMarkup;
  const mapHtml = `<div class="map-zoom-wrap">
      <div class="map-zoom-controls no-print">
        <button type="button" class="map-zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" class="map-zoom-btn" data-zoom="out" aria-label="Zoom out">&#8722;</button>
        <button type="button" class="map-zoom-btn" data-zoom="reset" aria-label="Reset zoom">&#8634;</button>
      </div>
      <div class="map-zoom-scroll">${mapMediaHtml}</div>
    </div>
    ${mapResult.usedBasemap ? `<p class="map-attribution">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors</p>` : ''}`;

  const effortMetric = effortSource === 'power' ? 'power' : 'heart rate';
  const routeIntro = effortSource
    ? `This is the route from the ride, coloured by how hard you were working, based on
        your ${effortMetric} — from easiest (blue) to hardest (red). Two spots stand out.`
    : `This is the route from the ride, with each stretch coloured by what kind of
        effort it was. Two spots stand out.`;

  const zoneBadgeLabel = effortSource === 'power' ? 'FTP zones' : effortSource === 'hr' ? 'LTHR zones' : null;
  const zoneBadgeHtml = zoneBadgeLabel ? `<span class="zone-badge">${zoneBadgeLabel}</span>` : '';

  // The flat elevation chart(s) are labelled independently of the map's
  // effort colouring above: it defaults to LTHR (heart-rate) zones
  // whenever HR data is present, with a second FTP (power) zones chart
  // alongside it when power data is also present.
  const elevationBadgeLabel = hrSummary ? 'LTHR zones' : powerSummary ? 'FTP zones' : null;
  const elevationBadgeHtml = elevationBadgeLabel ? `<span class="zone-badge">${elevationBadgeLabel}</span>` : '';

  const hasLowValueSpots = Boolean(lowValueSpots && lowValueSpots.length);
  const hasJunctionSpots = Boolean(lowValueSpots && lowValueSpots.some((s) => s.possibleJunction));
  const hasBonkSpots = Boolean(bonkEpisodes && bonkEpisodes.length);
  const hasDecoupleOnset = Boolean(decoupleOnset);
  const lowValueLegendHtml =
    hasLowValueSpots || hasBonkSpots
      ? `<div class="legend low-value-legend">
        ${hasLowValueSpots ? `<span class="swatch"><span class="icon-chip low-value">${icons.lowValueDot}</span>Low training value</span>` : ''}
        ${hasJunctionSpots ? `<span class="swatch"><span class="icon-chip junction">${icons.junctionFlag}</span>Possible junction / rest stop</span>` : ''}
        ${hasBonkSpots ? `<span class="swatch"><span class="icon-chip bonk">${icons.bonkDiamond}</span>Possible bonk</span>` : ''}
        ${hasDecoupleOnset ? `<span class="swatch"><span class="icon-chip decouple">${icons.decoupleHexagon}</span>Early signs of a bonk</span>` : ''}
      </div>`
      : '';

  const endpointHintHtml = `<p class="legend-hint">S and E mark where the highlighted cardio and strength stretches actually start and end.</p>`;

  const legendHtml = effortSource
    ? `<div class="legend effort-legend">
        ${EFFORT_COLORS.map((color, i) => `<span class="swatch"><span class="dot" style="background:${color}"></span>${EFFORT_LABELS[i]}</span>`).join('')}
      </div>
      ${lowValueLegendHtml}
      ${endpointHintHtml}`
    : `<div class="legend">
        <span class="swatch"><span class="dot" style="background:var(--cardio)"></span>Cardio — flat &amp; rolling</span>
        <span class="swatch"><span class="dot" style="background:var(--strength)"></span>Strength — climbing</span>
        <span class="swatch"><span class="dot" style="background:var(--recovery)"></span>Recovery</span>
      </div>
      ${lowValueLegendHtml}
      ${endpointHintHtml}`;

  // Two extra map + elevation pairs under the same section, same
  // rendering style as the map/elevation above: a finer terrain
  // breakdown, and technical/difficult sections.
  const terrainNote = `Not all terrain trains you the same way. Flat, steady stretches and
      sustained climbs let you hold a consistent effort for minutes at a time — that's what
      builds VO2 max and long-ride endurance. Rolling terrain breaks that effort into surges
      and recoveries, which is valuable in its own way but doesn't build the same sustained
      aerobic engine. If you're training for a long steady event, the flat and sustained-climb
      minutes below are your best guide to how much real aerobic training load this ride gave you.`;
  const terrainMapMediaHtml = terrainMapResult.usedBasemap
    ? `<img class="map-zoom-target" src="${terrainMapResult.dataUrl}" alt="Route map coloured by terrain breakdown" />`
    : terrainMapResult.svgMarkup;
  const terrainMapHtml = `<div class="map-zoom-wrap">
      <div class="map-zoom-controls no-print">
        <button type="button" class="map-zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" class="map-zoom-btn" data-zoom="out" aria-label="Zoom out">&#8722;</button>
        <button type="button" class="map-zoom-btn" data-zoom="reset" aria-label="Reset zoom">&#8634;</button>
      </div>
      <div class="map-zoom-scroll">${terrainMapMediaHtml}</div>
    </div>
    ${terrainMapResult.usedBasemap ? `<p class="map-attribution">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors</p>` : ''}`;
  const terrainLegendHtml = `<div class="legend">
      ${Object.keys(TERRAIN_LABELS)
        .map((key) => `<span class="swatch"><span class="dot" style="background:${TERRAIN_COLORS[key]}"></span>${TERRAIN_LABELS[key]}</span>`)
        .join('')}
    </div>`;

  const hasTechnicalHighlights = Boolean(technicalSegments && technicalSegments.some((s) => s.cls !== 'other'));
  const technicalIntro = hasTechnicalHighlights
    ? `Winding or braking-heavy stretches — technical climbs and descents, and any cautious,
        deliberately slow descents — regardless of how the terrain itself was classified above.`
    : `Checked for winding or braking-heavy stretches — nothing stood out enough to flag. This
        was a consistently smooth ride.`;
  const technicalMapMediaHtml = technicalMapResult.usedBasemap
    ? `<img class="map-zoom-target" src="${technicalMapResult.dataUrl}" alt="Route map highlighting technical and difficult sections" />`
    : technicalMapResult.svgMarkup;
  const technicalMapHtml = `<div class="map-zoom-wrap">
      <div class="map-zoom-controls no-print">
        <button type="button" class="map-zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" class="map-zoom-btn" data-zoom="out" aria-label="Zoom out">&#8722;</button>
        <button type="button" class="map-zoom-btn" data-zoom="reset" aria-label="Reset zoom">&#8634;</button>
      </div>
      <div class="map-zoom-scroll">${technicalMapMediaHtml}</div>
    </div>
    ${technicalMapResult.usedBasemap ? `<p class="map-attribution">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors</p>` : ''}`;
  const technicalLegendHtml = `<div class="legend">
      ${Object.keys(TECHNICAL_LABELS)
        .map((key) => `<span class="swatch"><span class="dot" style="background:${TECHNICAL_COLORS[key]}"></span>${TECHNICAL_LABELS[key]}</span>`)
        .join('')}
    </div>`;

  const activityLabel = formatActivityLabel(activityType);

  const NHS_MODERATE_TARGET_MIN = 150;
  const NHS_VIGOROUS_TARGET_MIN = 75;

  function nhsLine(moderateS, vigorousS) {
    const moderatePct = Math.round((moderateS / 60 / NHS_MODERATE_TARGET_MIN) * 100);
    const vigorousPct = Math.round((vigorousS / 60 / NHS_VIGOROUS_TARGET_MIN) * 100);
    return `<p class="table-nhs">This ride alone covers <strong>${moderatePct}%</strong> of the NHS weekly moderate-activity
      goal (${NHS_MODERATE_TARGET_MIN} min) and <strong>${vigorousPct}%</strong> of the vigorous-activity goal
      (${NHS_VIGOROUS_TARGET_MIN} min), for adults aged 19-64.</p>`;
  }

  function zoneBreakdownTable(zoneSecondsByBin, rangeLabels, unit) {
    if (!zoneSecondsByBin) return '';
    return `<p class="zone-breakdown-label">Time in each zone</p>
      <div class="table-scroll">
        <table class="zone-table">
          <thead>
            <tr><th>Zone</th><th>Range</th><th>Minutes</th></tr>
          </thead>
          <tbody>
            ${zoneSecondsByBin
              .map(
                (s, i) =>
                  `<tr><td><span class="dot" style="background:${EFFORT_COLORS[i]}"></span>${EFFORT_LABELS[i]}</td><td>${rangeLabels ? `${rangeLabels[i]} ${unit}` : '—'}</td><td>${formatDuration(s)}</td></tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  function activityTableCard(label, basisText, moderateS, vigorousS, zoneSecondsByBin, rangeLabels, unit) {
    return `<div class="card table-card">
      <p class="table-basis"><strong>${label}</strong> — ${basisText}</p>
      <div class="table-scroll">
        <table class="activity-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Duration</th>
              <th>Moderate</th>
              <th>Vigorous</th>
              <th>Avg HR</th>
              <th>Peak HR</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${escapeHtml(activityLabel)}</td>
              <td>${formatDuration(totalDurationS)}</td>
              <td>${formatDuration(moderateS)}</td>
              <td>${formatDuration(vigorousS)}</td>
              <td>${avgHrOverall ? `${formatInt(avgHrOverall)} bpm` : '—'}</td>
              <td>${peakHrOverall ? `${formatInt(peakHrOverall)} bpm` : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ${nhsLine(moderateS, vigorousS)}
      ${zoneBreakdownTable(zoneSecondsByBin, rangeLabels, unit)}
    </div>`;
  }

  const tableCards = [];
  if (powerSummary) {
    const ftpBasis = powerSummary.isManual
      ? `FTP entered: ${formatInt(powerSummary.ftp)}W`
      : `FTP estimate ${formatInt(powerSummary.ftp)}W — 95% of your best 20-minute power this ride`;
    tableCards.push(
      activityTableCard(
        'Power zones',
        ftpBasis,
        powerSummary.moderateS,
        powerSummary.vigorousS,
        powerSummary.zoneSecondsByBin,
        powerZoneRangeLabels(powerSummary.ftp),
        'W'
      )
    );
  }
  if (hrSummary) {
    const lthrBasis = hrSummary.isManual
      ? `LTHR entered: ${formatInt(hrSummary.lthr)} bpm`
      : `LTHR estimate ${formatInt(hrSummary.lthr)} bpm — 88% of your peak heart rate this ride`;
    tableCards.push(
      activityTableCard(
        'Heart-rate zones',
        lthrBasis,
        hrSummary.moderateS,
        hrSummary.vigorousS,
        hrSummary.zoneSecondsByBin,
        hrZoneRangeLabels(hrSummary.lthr),
        'bpm'
      )
    );
  }
  if (ageSummary) {
    tableCards.push(
      activityTableCard(
        'Age-based heart-rate zones',
        `LTHR estimate ${formatInt(ageSummary.lthr)} bpm — 88% of an age-estimated max HR of ${formatInt(ageSummary.maxHrEstimated)} bpm (Tanaka formula)`,
        ageSummary.moderateS,
        ageSummary.vigorousS,
        ageSummary.zoneSecondsByBin,
        hrZoneRangeLabels(ageSummary.lthr),
        'bpm'
      )
    );
  }
  if (tableCards.length === 0) {
    tableCards.push(`<div class="card table-card">
      <p class="table-basis"><strong>No effort data</strong> — this ride has no power or heart-rate data to build zones from</p>
      <div class="table-scroll">
        <table class="activity-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Duration</th>
              <th>Moderate</th>
              <th>Vigorous</th>
              <th>Avg HR</th>
              <th>Peak HR</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${escapeHtml(activityLabel)}</td>
              <td>${formatDuration(totalDurationS)}</td>
              <td>—</td>
              <td>—</td>
              <td>${avgHrOverall ? `${formatInt(avgHrOverall)} bpm` : '—'}</td>
              <td>${peakHrOverall ? `${formatInt(peakHrOverall)} bpm` : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`);
  }

  const activityTableHtml = `<section class="activity-summary">
    <div class="section-head">
      <p class="eyebrow">Physical activity summary</p>
      <h2>Moderate vs vigorous effort, at a glance</h2>
      <p>Zones 2-3 (green/yellow) count as moderate — "cardio" — activity; zones 4-5
        (orange/red) count as vigorous.${tableCards.length > 1 ? ' Power, heart rate and age-based zones can each give a slightly different picture of effort, so every one available is shown below.' : ''}</p>
    </div>
    ${tableCards.join('')}
  </section>`;

  function lowValueItem(spot) {
    const iconHtml = spot.possibleJunction ? icons.junctionFlag : icons.lowValueDot;
    const chipClass = spot.possibleJunction ? 'junction' : 'low-value';
    const whereText = spot.name
      ? `near ${escapeHtml(spot.name)} (${spot.atDistanceKm.toFixed(1)} km into the ride)`
      : `around ${spot.atDistanceKm.toFixed(1)} km into the ride`;
    return `<li class="low-value-item">
      <span class="icon-chip ${chipClass}">${iconHtml}</span>
      <div>
        <strong>${formatDuration(spot.durationS)}</strong> ${whereText}
        ${spot.possibleJunction ? '<span class="tag">possibly a junction, lights, rest stop, or a rough patch</span>' : ''}
      </div>
    </li>`;
  }

  const trainingValueHtml = !effortSource
    ? ''
    : `<section class="training-value">
    <div class="section-head">
      <p class="eyebrow">Training value check</p>
      <h2>Stretches that cost you training value</h2>
      <p>These are spots that sat in Zone 1 — your easiest zone — on ground that was flat or
        only gently downhill, so gravity wasn't doing the work either. Zone 1 straight after a
        hard effort is normal recovery and doesn't count here. The first and last 200m are
        skipped for privacy.</p>
    </div>
    <div class="card">
      ${
        lowValueSpots && lowValueSpots.length
          ? `<ul class="low-value-list">${lowValueSpots.map(lowValueItem).join('')}</ul>`
          : `<p class="low-value-empty">Nice — no significant low-value stretches spotted. You made good use of
              nearly every minute out there.</p>`
      }
    </div>
  </section>`;

  function whereDescription(name, atKm) {
    return name ? `near ${escapeHtml(name)} (${atKm.toFixed(1)} km into the ride)` : `around ${atKm.toFixed(1)} km into the ride`;
  }

  function bonkItem(ep) {
    const severityLabel = ep.severity.charAt(0).toUpperCase() + ep.severity.slice(1);
    return `<li class="low-value-item">
      <span class="icon-chip bonk">${icons.bonkDiamond}</span>
      <div>
        <strong>${formatDuration(ep.durationS)}</strong> ${whereDescription(ep.name, ep.atStartKm)}
        <span class="tag">${severityLabel}</span>
      </div>
    </li>`;
  }

  const bonkHtml =
    !bonkEpisodes || !bonkEpisodes.length
      ? ''
      : `<section class="bonk-check">
    <div class="section-head">
      <p class="eyebrow">Fuel check</p>
      <h2>Signs you may have bonked</h2>
      <p>A bonk is an extended, non-recovering crash in output — even on ground that should
        let you push harder — usually from running low on fuel. Zone 1 straight after a hard
        effort doesn't count here; this only flags stretches that never really came back.</p>
    </div>
    <div class="card">
      <ul class="low-value-list">${bonkEpisodes.map(bonkItem).join('')}</ul>
      ${
        decoupleOnset
          ? `<p class="decouple-note">Signs of this may have started earlier than the crash itself:
              your power began dropping relative to your heart rate ${whereDescription(decoupleOnset.name, decoupleOnset.atKm)}
              — a classic early warning that fuel was running low.</p>`
          : ''
      }
    </div>
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(rideName)} — Ride Report</title>
<style>${css}</style>
</head>
<body>
<div class="poster">

  <header class="hero">
    <p class="eyebrow">Your ride, your health</p>
    <h1>${escapeHtml(rideName)}</h1>
    <p class="subtitle">One bike ride, two workouts in one — a cardio session and a strength
      session, back to back. Good for every rider, whatever your age.</p>
    <div class="stat-strip">
      ${statCell(formatDistanceKm(totalDistanceKm), 'km', 'Distance')}
      ${statCell(formatDuration(totalDurationS), '', 'Time out')}
      ${statCell(formatInt(totalClimbM), 'm', 'Climbing')}
      ${statCell(avgHrOverall ? formatInt(avgHrOverall) : '—', '', 'Avg heart rate')}
    </div>
  </header>

  <section class="panels-section">
    <div class="section-head">
      <p class="eyebrow">Two workouts, one ride</p>
      <h2>What each part actually did for you</h2>
    </div>
    <div class="panels">
      <div class="panel cardio">
        <div class="icon">${icons.heart}</div>
        <p class="spot">Best spot: ${cardioSpotLabel}</p>
        <h3>Cardio — the steady heart workout</h3>
        <p class="copy">On the flat sections — like ${cardioSpot} — you settled into a
          strong, steady rhythm you could hold for a long time. This is what trains your
          heart and lungs to work more efficiently.</p>
        <div class="stat-row">
          ${panelStat(`${formatDistanceKm(cardio.distanceKm)} km`, 'Flat distance')}
          ${panelStat(formatDuration(cardio.durationS), 'Time spent')}
        </div>
        <div class="stat-row">
          ${panelStat(`${cardio.avgSpeedKmh.toFixed(1)} km/h`, 'Steady pace')}
          ${panelStat(cardio.avgHr ? `${formatInt(cardio.avgHr)} bpm` : '—', 'Avg heart rate')}
        </div>
      </div>
      <div class="panel strength">
        <div class="icon">${icons.dumbbell}</div>
        <p class="spot">Best spot: ${strengthSpotLabel}</p>
        <h3>Strength — the muscle workout</h3>
        <p class="copy">Going uphill — like ${strengthSpot} — your pedal stroke slowed but
          got much harder, pushing your body weight against gravity over and over. That's
          real resistance training, no gym required.</p>
        <div class="stat-row">
          ${panelStat(`${formatDistanceKm(strength.distanceKm)} km`, 'Of climbing')}
          ${panelStat(formatDuration(strength.durationS), 'Time spent')}
        </div>
        <div class="stat-row">
          ${panelStat(`${formatInt(strength.elevGainM)} m`, 'Total height gained')}
          ${panelStat(strength.maxHr ? `${formatInt(strength.maxHr)} bpm` : '—', 'Peak effort')}
        </div>
      </div>
    </div>
    <div class="panel recovery">
      <div class="icon">${icons.wind}</div>
      <h3>Recovery</h3>
      <p class="copy">On the descents, you eased off and let gravity do the work —
        a breather for your legs and a chance for your heart rate to settle before
        the next effort.</p>
      <div class="stat-row">
        ${panelStat(formatDuration(recovery.durationS), 'Time spent')}
        ${panelStat(recovery.avgHr ? `${formatInt(recovery.avgHr)} bpm` : '—', 'Avg heart rate')}
        ${panelStat(`${recovery.avgSpeedKmh.toFixed(1)} km/h`, 'Pace')}
      </div>
    </div>
  </section>

  <section class="map-section">
    <div class="section-head">
      <p class="eyebrow">Your route, colour-coded</p>
      <h2>Where the workout changed</h2>
      <p>${routeIntro}</p>
    </div>
    <div class="card map-card">
      ${zoneBadgeHtml}
      ${mapHtml}
      ${legendHtml}
    </div>
    <div class="card elevation-card">
      <h3>The same route, laid out flat (height above sea level)${elevationBadgeHtml ? ` ${elevationBadgeHtml}` : ''}</h3>
      ${elevationSvg}
    </div>
    ${
      elevationSvgFtp
        ? `<div class="card elevation-card">
      <h3>The same route, laid out flat (height above sea level) <span class="zone-badge">FTP zones</span></h3>
      ${elevationSvgFtp}
    </div>`
        : ''
    }

    <div class="section-head technical-head">
      <p class="eyebrow">Digging a little deeper</p>
      <h3>Terrain breakdown</h3>
      <p>${terrainNote}</p>
    </div>
    <div class="card map-card">
      ${terrainMapHtml}
      ${terrainLegendHtml}
    </div>
    <div class="card elevation-card">
      <h3>The same route, laid out flat — terrain breakdown</h3>
      ${terrainElevationSvg}
    </div>

    <div class="section-head technical-head">
      <p class="eyebrow">Where it got tricky</p>
      <h3>Technical / difficult sections</h3>
      <p>${technicalIntro}</p>
    </div>
    <div class="card map-card">
      ${technicalMapHtml}
      ${technicalLegendHtml}
    </div>
    <div class="card elevation-card">
      <h3>The same route, laid out flat — technical &amp; difficult sections</h3>
      ${technicalElevationSvg}
    </div>
  </section>

  ${activityTableHtml}

  ${trainingValueHtml}

  ${bonkHtml}

  <section class="benefits">
    <div class="section-head">
      <p class="eyebrow">Why mixing hills and flats works</p>
      <h2>Two workouts beat one — for every rider</h2>
      <p>Steady flat riding builds a strong heart. Climbing builds strong muscles and
        bones. Riders of any age benefit from both — but the strength side becomes
        especially important after 50, when the body naturally starts losing muscle and
        bone density faster.</p>
    </div>
    <div class="benefit-grid">
      ${benefitCard(icons.muscle, "Keeps muscle you'd otherwise lose", "Pushing hard on a climb is resistance training. It tells your legs to hold on to strength instead of quietly losing it year after year — muscle loss that speeds up noticeably from your 50s on.")}
      ${benefitCard(icons.bone, 'Loads your bones, for stronger bones', 'Grinding up a hill puts real force through your hips and legs — the kind of load that helps keep bones dense as you age.')}
      ${benefitCard(icons.balance, 'Better balance, fewer falls', 'The strength and control built climbing carries straight into everyday stability — getting up, carrying things, steady footing.')}
      ${benefitCard(icons.bolt, 'A metabolism that stays active', 'Muscle burns energy even at rest. Keeping it means your body stays more efficient, not less, as the years go on.')}
    </div>
  </section>

  <section class="takeaway">
    <p class="eyebrow">The takeaway</p>
    <h2>You didn't just go for a bike ride — you did a full workout</h2>
    <p>The flats trained your heart. The hills trained your muscles and bones. Remember
      the pattern: <strong>${cardioSpotLabel}</strong> for a cardio spin,
      <strong>${strengthSpotLabel}</strong> when you want the strength session. Great for
      any rider, any age.</p>
  </section>

  <footer>${escapeHtml(rideName)} · recorded ride, ${formatDate(rideDate)}</footer>

</div>
${
  includeToolbar
    ? `<div class="toolbar no-print">
        ${stravaUrl ? `<a class="btn strava-btn" href="${stravaUrl}" target="_blank" rel="noopener">View on Strava</a>` : ''}
        <a class="btn" href="${pdfHref}">Download PDF</a>
      </div>`
    : ''
}
<script>
  document.querySelectorAll('.map-zoom-wrap').forEach(function (wrap) {
    var target = wrap.querySelector('.map-zoom-target');
    var scroll = wrap.querySelector('.map-zoom-scroll');
    if (!target || !scroll) return;
    var steps = [100, 150, 200, 300, 400];
    var idx = 0;
    function apply() {
      target.style.width = steps[idx] + '%';
      scroll.classList.toggle('is-zoomed', idx > 0);
    }
    wrap.querySelectorAll('[data-zoom]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-zoom');
        if (action === 'in') idx = Math.min(idx + 1, steps.length - 1);
        else if (action === 'out') idx = Math.max(idx - 1, 0);
        else idx = 0;
        apply();
      });
    });
  });
</script>
</body>
</html>`;
}

module.exports = { buildReportHtml };
