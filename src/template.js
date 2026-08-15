const { css } = require('./style');
const icons = require('./icons');
const { formatDistanceKm, formatDuration, formatInt, formatDate, escapeHtml } = require('./format');

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
    cardio,
    strength,
    cardioName,
    strengthName,
    includeToolbar,
    pdfHref,
  } = data;

  const cardioSpot = cardioName || 'the flattest stretch of the ride';
  const strengthSpot = strengthName || 'the steepest climb of the ride';
  const cardioSpotLabel = cardioName ? escapeHtml(cardioName) : 'the flat stretch';
  const strengthSpotLabel = strengthName ? escapeHtml(strengthName) : 'the climb';

  const mapHtml = mapResult.usedBasemap
    ? `<img src="${mapResult.dataUrl}" alt="Route map coloured by workout type" />
       <p class="map-attribution">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors</p>`
    : mapResult.svgMarkup;

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

  <section class="map-section">
    <div class="section-head">
      <p class="eyebrow">Your route, colour-coded</p>
      <h2>Where the workout changed</h2>
      <p>This is the route from the ride, with each stretch coloured by what kind of
        effort it was. Two spots stand out.</p>
    </div>
    <div class="card map-card">
      ${mapHtml}
      <div class="legend">
        <span class="swatch"><span class="dot" style="background:var(--cardio)"></span>Cardio — flat &amp; rolling</span>
        <span class="swatch"><span class="dot" style="background:var(--strength)"></span>Strength — climbing</span>
        <span class="swatch"><span class="dot" style="background:var(--recovery)"></span>Recovery — coasting down</span>
      </div>
    </div>
    <div class="card elevation-card">
      <h3>The same route, laid out flat (height above sea level)</h3>
      ${elevationSvg}
    </div>
  </section>

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
  </section>

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
${includeToolbar ? `<div class="toolbar no-print"><a class="btn" href="${pdfHref}">Download PDF</a></div>` : ''}
</body>
</html>`;
}

module.exports = { buildReportHtml };
