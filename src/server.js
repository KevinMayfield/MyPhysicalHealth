try {
  process.loadEnvFile();
} catch {
  // No .env file present — fine if Strava env vars are set some other way.
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { generateReportHtml, generateReportHtmlFromPoints } = require('./pipeline');
const { renderPdf, shutdown } = require('./pdf');
const strava = require('./strava');
const { escapeHtml, formatDuration } = require('./format');
const { analyseRide, LTHR_FROM_MAXHR_FACTOR, TANAKA_MAXHR_INTERCEPT, TANAKA_MAXHR_AGE_FACTOR } = require('./analysis');
const { buildElevationSvg } = require('./elevationProfile');

const PORT = process.env.PORT || 3000;
const REPORT_TTL_MS = 60 * 60 * 1000;
const PROFILE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const STRAVA_LOOKBACK_S = 30 * 24 * 60 * 60; // last month
const NHS_MODERATE_TARGET_MIN = 150; // per week
const NHS_VIGOROUS_TARGET_MIN = 75; // per week
const NHS_WEEK_LOOKBACK_S = 7 * 24 * 60 * 60;
const MET_RECOVERY = 4;
const MET_MODERATE = 8;
const MET_VIGOROUS = 10;

/** Calories burned = MET x weight (kg) x duration (hours), per heart-rate category. */
function caloriesForBreakdown(bd, weightKg) {
  const recoveryCal = MET_RECOVERY * weightKg * (bd.recoveryS / 3600);
  const moderateCal = MET_MODERATE * weightKg * (bd.moderateS / 3600);
  const vigorousCal = MET_VIGOROUS * weightKg * (bd.vigorousS / 3600);
  return { recoveryCal, moderateCal, vigorousCal, totalCal: recoveryCal + moderateCal + vigorousCal };
}

/** Small bounded-concurrency map, so we don't fire off dozens of Strava requests at once. */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** LTHR to classify an activity's zones: a saved real value beats an age estimate beats a per-activity peak-HR estimate. */
function resolveActivityLthr(activity, savedLthr, savedAge) {
  if (savedLthr) return savedLthr;
  if (savedAge) return (TANAKA_MAXHR_INTERCEPT - TANAKA_MAXHR_AGE_FACTOR * savedAge) * LTHR_FROM_MAXHR_FACTOR;
  if (activity.max_heartrate) return activity.max_heartrate * LTHR_FROM_MAXHR_FACTOR;
  return null;
}

const app = express();
// Behind a reverse proxy (Fly.io, Render, etc.) the app only ever sees plain
// HTTP internally — trust X-Forwarded-Proto so req.protocol (used to build
// the Strava OAuth redirect URI) reports "https" correctly in production.
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function parseAge(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 5 && n <= 110 ? Math.round(n) : null;
}

function parseFtp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 30 && n <= 600 ? Math.round(n) : null;
}

function parseLthr(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 80 && n <= 220 ? Math.round(n) : null;
}

const LB_TO_KG = 0.45359237;

function parseWeightKg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 20 && n <= 300 ? Math.round(n * 10) / 10 : null;
}

/** Converts a weight entered in the given unit ("kg" or "lb") into kilograms. */
function parseWeightInput(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return parseWeightKg(unit === 'lb' ? n * LB_TO_KG : n);
}

/** @type {Map<string, { rideName: string, html: string, createdAt: number }>} */
const reports = new Map();

function cleanupExpiredReports() {
  const now = Date.now();
  for (const [id, report] of reports) {
    if (now - report.createdAt > REPORT_TTL_MS) reports.delete(id);
  }
}

/**
 * Strava tokens live only in this server-side session map, keyed by a
 * random session id in an HttpOnly cookie — never sent to the browser
 * directly. Persisted to a local file (gitignored) so a server restart
 * doesn't force the user to reconnect their Strava account.
 * @type {Map<string, { accessToken: string, refreshToken: string, expiresAt: number, athleteName: string, ftp?: number|null, maxHr?: number|null }>}
 */
const SESSIONS_FILE = path.join(__dirname, '..', '.strava-sessions.json');

function loadStravaSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function persistStravaSessions() {
  try {
    const serializable = {};
    for (const [sid, s] of stravaSessions) {
      serializable[sid] = { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt, athleteName: s.athleteName };
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(serializable));
  } catch (err) {
    console.error('Failed to persist Strava sessions:', err.message);
  }
}

const stravaSessions = loadStravaSessions();

function getStravaSession(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  return sid ? stravaSessions.get(sid) : null;
}

/** Returns a valid (refreshed if necessary) access token for this session. */
async function ensureFreshToken(session) {
  if (session.expiresAt > Date.now() / 1000 + 60) return session.accessToken;
  const refreshed = await strava.refreshAccessToken(session.refreshToken);
  session.accessToken = refreshed.access_token;
  session.refreshToken = refreshed.refresh_token;
  session.expiresAt = refreshed.expires_at;
  persistStravaSessions();
  return session.accessToken;
}

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #eae6d9; color: #262620; margin: 0; padding: 40px 20px; }
  .wrap { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .card { background: #fdfbf3; border-radius: 20px; box-shadow: 0 8px 24px rgba(38,38,32,0.08); padding: 32px; }
  .centered { text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #6f6c5f; line-height: 1.5; margin: 0 0 16px; }
  .field { text-align: left; margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #6f6c5f; margin-bottom: 6px; }
  input[type="file"], input[type="number"] { display: block; width: 100%; box-sizing: border-box; }
  input[type="number"] { border: 1px solid rgba(38,38,32,0.2); border-radius: 10px; padding: 10px 12px; font-size: 15px; }
  .hint { font-size: 12px; color: #948f7f; margin-top: 6px; margin-bottom: 0; }
  button, .btn { background: #262620; color: #fdfbf3; border: none; border-radius: 999px; padding: 12px 28px; font-size: 15px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-block; }
  button:disabled { opacity: 0.6; }
  .error { color: #c1502f; margin-bottom: 16px; }
  #status { color: #6f6c5f; margin-top: 16px; font-size: 14px; }
  .divider { display: flex; align-items: center; gap: 12px; margin: 24px 0; color: #948f7f; font-size: 13px; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: rgba(38,38,32,0.12); }
  .strava-btn { background: #fc4c02; }
  .strava-status { margin-bottom: 12px; }
  .text-link { display: inline-block; margin-top: 12px; margin-left: 12px; font-size: 13px; color: #948f7f; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; font-size: 14px; border-bottom: 1px solid rgba(38,38,32,0.08); }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #948f7f; }
  .gen-link { color: #c1502f; font-weight: 700; text-decoration: none; flex-shrink: 0; }
  .activity-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
  .strava-link { color: #fc4c02; font-weight: 600; font-size: 12px; text-decoration: none; }
  .muted { color: #948f7f; }
  .activity-card { border: 1px solid rgba(38,38,32,0.08); border-radius: 14px; padding: 18px; margin-bottom: 14px; }
  .activity-card:last-child { margin-bottom: 0; }
  .activity-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
  .activity-head strong { font-size: 15px; }
  .activity-meta { font-size: 12px; color: #948f7f; margin-top: 2px; }
  .activity-elevation { margin-bottom: 14px; border-radius: 10px; overflow: hidden; background: rgba(38,38,32,0.03); }
  .activity-elevation svg { display: block; }
  .zone-recovery { background: #3f6fa8; }
  .zone-moderate { background: #2f6b4f; }
  .zone-vigorous { background: #c97a2f; }
  .zone-bar { display: flex; width: 100%; height: 14px; border-radius: 999px; overflow: hidden; background: rgba(38,38,32,0.06); }
  .zone-bar span { display: block; height: 100%; }
  .zone-panels { display: flex; gap: 10px; margin-top: 10px; }
  .zone-panel { flex: 1; border-radius: 10px; padding: 10px 12px; text-align: center; }
  .zone-panel .value { display: block; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .zone-panel .label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; opacity: 0.85; }
  .zone-panel .kcal { display: block; font-size: 11px; margin-top: 4px; opacity: 0.75; }
  .weight-row { display: flex; gap: 8px; }
  .weight-row input { flex: 1; }
  .weight-row select { border: 1px solid rgba(38,38,32,0.2); border-radius: 10px; padding: 10px 12px; font-size: 15px; background: #fdfbf3; }
  .profile-summary { display: flex; gap: 20px; flex-wrap: wrap; margin: 16px 0; }
  .profile-summary > div { display: flex; flex-direction: column; }
  .profile-summary .value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .profile-summary .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #948f7f; margin-top: 2px; }
  .profile-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  dialog { border: none; border-radius: 20px; padding: 32px; max-width: 380px; width: 90%; background: #fdfbf3; color: #262620; box-shadow: 0 8px 24px rgba(38,38,32,0.2); }
  dialog::backdrop { background: rgba(38,38,32,0.5); }
  .dialog-actions { display: flex; gap: 12px; align-items: center; }
  .dialog-actions .btn-secondary { background: none; color: #6f6c5f; }
  .zone-panel-recovery { background: #dbe6f0; color: #2c5580; }
  .zone-panel-moderate { background: #dde9df; color: #234f3a; }
  .zone-panel-vigorous { background: #f5ddc4; color: #8a4f1c; }
  .activity-stats { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 16px; }
  .activity-stats > div { display: flex; flex-direction: column; }
  .activity-stats .value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .activity-stats .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #948f7f; margin-top: 2px; }
  .no-hr { margin-top: 12px; font-size: 13px; margin-bottom: 0; }
  .nhs-progress-track { width: 100%; height: 10px; border-radius: 999px; background: rgba(38,38,32,0.06); overflow: hidden; }
  .nhs-fill-moderate { height: 100%; background: #2f6b4f; border-radius: 999px; }
  .nhs-fill-vigorous { height: 100%; background: #c97a2f; border-radius: 999px; }
  .nhs-summary-panels { display: flex; gap: 14px; flex-wrap: wrap; }
  .nhs-summary-panel { flex: 1; min-width: 160px; border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 4px; }
  .nhs-summary-panel .pct { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .nhs-summary-panel .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .nhs-summary-panel .sub { font-size: 12px; opacity: 0.8; margin-bottom: 8px; }
  .nhs-summary-moderate { background: #dde9df; color: #234f3a; }
  .nhs-summary-vigorous { background: #f5ddc4; color: #8a4f1c; }
`;

app.get('/', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const savedAge = parseAge(cookies.age);
  const savedFtp = parseFtp(cookies.ftp);
  const savedLthr = parseLthr(cookies.lthr);
  const savedWeightKg = parseWeightKg(cookies.weightKg);
  const session = getStravaSession(req);

  // Defaults: Strava-derived values win when connected, falling back to
  // stored (cookie) values otherwise. Strava has no "age" field, so age
  // always comes from the stored value.
  let effectiveAge = savedAge;
  let effectiveFtp = savedFtp;
  let effectiveLthr = savedLthr;
  let effectiveWeightKg = savedWeightKg;

  const stravaConnectHtml = session
    ? `<p class="strava-status">Connected to Strava as <strong>${escapeHtml(session.athleteName)}</strong></p>
       <a class="text-link" href="/strava/disconnect">Disconnect</a>`
    : `<a class="btn strava-btn" href="/auth/strava">Connect with Strava</a>
       <p class="hint">Lists your rides from the last 30 days below, so you can generate a report
         without downloading a GPX file first.</p>`;

  let activitiesHtml = '';
  if (session) {
    try {
      const accessToken = await ensureFreshToken(session);
      const afterUnix = Math.floor(Date.now() / 1000) - STRAVA_LOOKBACK_S;
      const activities = await strava.listRecentActivities(accessToken, afterUnix);
      activities.sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime());

      const athlete = await strava.getAthlete(accessToken).catch(() => null);
      const stravaFtp = parseFtp(athlete?.ftp);
      const stravaWeightKg = parseWeightKg(athlete?.weight);
      const stravaMaxHr = activities.reduce((max, a) => (a.max_heartrate > max ? a.max_heartrate : max), 0) || null;
      const stravaLthr = stravaMaxHr ? Math.round(stravaMaxHr * LTHR_FROM_MAXHR_FACTOR) : null;
      // Cached on the session so /generate and /strava/generate don't need to refetch.
      session.ftp = stravaFtp;
      session.maxHr = stravaMaxHr;

      effectiveFtp = stravaFtp ?? savedFtp;
      effectiveLthr = stravaLthr ?? savedLthr;
      effectiveWeightKg = stravaWeightKg ?? savedWeightKg;

      // For activities with a route, one full-streams fetch gets us both the
      // HR zone breakdown and the elevation profile (same analysis the full
      // report uses). Activities without GPS (e.g. indoor trainer rides)
      // fall back to the lightweight HR-only breakdown, with no elevation chart.
      const perActivity = await mapWithConcurrency(activities, 3, async (a) => {
        const hasGps = Array.isArray(a.start_latlng) && a.start_latlng.length === 2;
        const lthr = resolveActivityLthr(a, effectiveLthr, null);

        if (hasGps) {
          try {
            const streams = await strava.getActivityStreams(accessToken, a.id);
            const points = strava.streamsToPoints(a, streams);
            if (points.length < 2) return { bd: null, elevationSvg: null };
            const analysis = analyseRide(points, { ftp: effectiveFtp, lthr: lthr || undefined });
            const bd =
              a.has_heartrate && lthr && analysis.hrSummary
                ? {
                    recoveryS: analysis.hrSummary.zoneSecondsByBin[0],
                    moderateS: analysis.hrSummary.moderateS,
                    vigorousS: analysis.hrSummary.vigorousS,
                  }
                : null;
            // Defaults to LTHR (heart-rate) zones when present, falling back
            // to the ride's primary effort metric (power, or terrain) otherwise.
            const elevationSvg = analysis.hrZoneSegments
              ? buildElevationSvg(points, analysis, 560, 140, analysis.hrZoneSegments)
              : buildElevationSvg(points, analysis, 560, 140);
            return { bd, elevationSvg };
          } catch (err) {
            console.error(`Activity analysis failed for activity ${a.id}:`, err.message);
            return { bd: null, elevationSvg: null };
          }
        }

        if (!a.has_heartrate || !lthr) return { bd: null, elevationSvg: null };
        try {
          const bd = await strava.getActivityHrBreakdown(accessToken, a.id, lthr);
          return { bd, elevationSvg: null };
        } catch (err) {
          console.error(`Strava HR breakdown failed for activity ${a.id}:`, err.message);
          return { bd: null, elevationSvg: null };
        }
      });

      const weekCutoffMs = Date.now() - NHS_WEEK_LOOKBACK_S * 1000;
      let weekModerateS = 0;
      let weekVigorousS = 0;
      activities.forEach((a, i) => {
        if (perActivity[i].bd && new Date(a.start_date).getTime() >= weekCutoffMs) {
          weekModerateS += perActivity[i].bd.moderateS;
          weekVigorousS += perActivity[i].bd.vigorousS;
        }
      });
      const moderatePctOfGoal = Math.round((weekModerateS / 60 / NHS_MODERATE_TARGET_MIN) * 100);
      const vigorousPctOfGoal = Math.round((weekVigorousS / 60 / NHS_VIGOROUS_TARGET_MIN) * 100);

      const nhsSummaryHtml = `<div class="card">
        <h1>This week vs NHS guidelines</h1>
        <p>Based on Strava activities in the last 7 days. NHS guidance: 150 min moderate or 75 min vigorous
          activity per week.</p>
        <div class="nhs-summary-panels">
          <div class="nhs-summary-panel nhs-summary-moderate">
            <span class="pct">${moderatePctOfGoal}%</span>
            <span class="label">Moderate</span>
            <span class="sub">${formatDuration(weekModerateS)} of ${NHS_MODERATE_TARGET_MIN}m goal</span>
            <div class="nhs-progress-track"><div class="nhs-fill-moderate" style="width:${Math.min(moderatePctOfGoal, 100)}%"></div></div>
          </div>
          <div class="nhs-summary-panel nhs-summary-vigorous">
            <span class="pct">${vigorousPctOfGoal}%</span>
            <span class="label">Vigorous</span>
            <span class="sub">${formatDuration(weekVigorousS)} of ${NHS_VIGOROUS_TARGET_MIN}m goal</span>
            <div class="nhs-progress-track"><div class="nhs-fill-vigorous" style="width:${Math.min(vigorousPctOfGoal, 100)}%"></div></div>
          </div>
        </div>
      </div>`;

      const cards = activities
        .map((a, i) => {
          const date = new Date(a.start_date_local).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          const km = (a.distance / 1000).toFixed(1);
          const hasGps = Array.isArray(a.start_latlng) && a.start_latlng.length === 2;
          const genLink = hasGps
            ? `<a class="gen-link" href="/strava/generate/${a.id}">View report</a>`
            : '<span class="muted">No GPS data</span>';

          const bd = perActivity[i].bd;
          const elevationSvg = perActivity[i].elevationSvg;
          let bodyHtml;
          if (bd) {
            const totalS = bd.recoveryS + bd.moderateS + bd.vigorousS || 1;
            const recoveryPct = (bd.recoveryS / totalS) * 100;
            const moderatePct = (bd.moderateS / totalS) * 100;
            const vigorousPct = (bd.vigorousS / totalS) * 100;
            const cal = effectiveWeightKg ? caloriesForBreakdown(bd, effectiveWeightKg) : null;

            bodyHtml = `
              <div class="zone-bar">
                <span style="width:${recoveryPct.toFixed(2)}%" class="zone-recovery"></span>
                <span style="width:${moderatePct.toFixed(2)}%" class="zone-moderate"></span>
                <span style="width:${vigorousPct.toFixed(2)}%" class="zone-vigorous"></span>
              </div>
              <div class="zone-panels">
                <div class="zone-panel zone-panel-recovery">
                  <span class="value">${formatDuration(bd.recoveryS)}</span><span class="label">Recovery</span>
                  ${cal ? `<span class="kcal">${Math.round(cal.recoveryCal)} kcal</span>` : ''}
                </div>
                <div class="zone-panel zone-panel-moderate">
                  <span class="value">${formatDuration(bd.moderateS)}</span><span class="label">Moderate</span>
                  ${cal ? `<span class="kcal">${Math.round(cal.moderateCal)} kcal</span>` : ''}
                </div>
                <div class="zone-panel zone-panel-vigorous">
                  <span class="value">${formatDuration(bd.vigorousS)}</span><span class="label">Vigorous</span>
                  ${cal ? `<span class="kcal">${Math.round(cal.vigorousCal)} kcal</span>` : ''}
                </div>
              </div>
              <div class="activity-stats">
                <div><span class="value">${formatDuration(a.moving_time)}</span><span class="label">Duration</span></div>
                <div><span class="value">${Math.round(a.average_heartrate)} bpm</span><span class="label">Avg HR</span></div>
                <div><span class="value">${Math.round(a.max_heartrate)} bpm</span><span class="label">Max HR</span></div>
                ${cal ? `<div><span class="value">${Math.round(cal.totalCal)} kcal</span><span class="label">Calories</span></div>` : ''}
              </div>`;
          } else {
            bodyHtml = `<div class="activity-stats">
              <div><span class="value">${formatDuration(a.moving_time)}</span><span class="label">Duration</span></div>
            </div>
            <p class="muted no-hr">No heart-rate data for this activity.</p>`;
          }

          return `<div class="activity-card">
            <div class="activity-head">
              <div>
                <strong>${escapeHtml(a.name)}</strong>
                <div class="activity-meta">${date} · ${escapeHtml(a.type)} · ${km} km</div>
              </div>
              <div class="activity-actions">
                ${genLink}
                <a class="strava-link" href="https://www.strava.com/activities/${a.id}" target="_blank" rel="noopener">View on Strava</a>
              </div>
            </div>
            ${elevationSvg ? `<div class="activity-elevation">${elevationSvg}</div>` : ''}
            ${bodyHtml}
          </div>`;
        })
        .join('');

      activitiesHtml = `${nhsSummaryHtml}
      <div class="card">
        <h1>Your Strava activities</h1>
        <p>From the last 30 days, broken down into recovery/moderate/vigorous by heart-rate zone.</p>
        ${activities.length ? cards : `<p class="muted">No activities found in the last 30 days.</p>`}
      </div>`;
    } catch (err) {
      console.error(err);
      activitiesHtml = `<div class="card"><p class="error">Couldn't load your Strava activities (${escapeHtml(err.message)}). Try
        <a href="/strava/disconnect">disconnecting</a> and reconnecting.</p></div>`;
    }
  }

  const profileHtml = `<div class="card">
    <h1>Your profile</h1>
    <p>Used to work out your effort zones and estimate calories.${
      session ? ' Age, weight, FTP and LTHR come from Strava first, falling back to what you enter below.' : ' Only remembered on this device via cookies.'
    }</p>
    <div class="profile-summary">
      <div><span class="value">${effectiveAge ?? '—'}</span><span class="label">Age</span></div>
      <div><span class="value">${effectiveWeightKg ? `${effectiveWeightKg} kg` : '—'}</span><span class="label">Weight</span></div>
      <div><span class="value">${effectiveFtp ? `${effectiveFtp} W` : '—'}</span><span class="label">FTP</span></div>
      <div><span class="value">${effectiveLthr ? `${effectiveLthr} bpm` : '—'}</span><span class="label">LTHR</span></div>
    </div>
    <div class="profile-actions">
      <button type="button" onclick="document.getElementById('profileDialog').showModal()">Edit profile</button>
    </div>
    <div style="margin-top:12px">${stravaConnectHtml}</div>
  </div>

  <dialog id="profileDialog">
    <form method="post" action="/profile">
      <h1>Edit your profile</h1>
      <div class="field">
        <label for="age">Your age</label>
        <input type="number" id="age" name="age" min="5" max="110" placeholder="e.g. 42" value="${effectiveAge ?? ''}" />
      </div>
      <div class="field">
        <label for="weight">Your weight</label>
        <div class="weight-row">
          <input type="number" id="weight" name="weight" min="1" step="0.1" placeholder="e.g. 75" value="${effectiveWeightKg ?? ''}" />
          <select name="weightUnit">
            <option value="kg" selected>kg</option>
            <option value="lb">lb</option>
          </select>
        </div>
        <p class="hint">Enter kg or lb — always stored as kilograms.</p>
      </div>
      <div class="field">
        <label for="ftp">Your FTP in watts</label>
        <input type="number" id="ftp" name="ftp" min="30" max="600" placeholder="e.g. 220" value="${effectiveFtp ?? ''}" />
      </div>
      <div class="field">
        <label for="lthr">Your LTHR in bpm</label>
        <input type="number" id="lthr" name="lthr" min="80" max="220" placeholder="e.g. 165" value="${effectiveLthr ?? ''}" />
      </div>
      <div class="dialog-actions">
        <button type="submit">Save</button>
        <button type="button" class="btn-secondary" onclick="document.getElementById('profileDialog').close()">Cancel</button>
      </div>
    </form>
  </dialog>`;

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MyPhysicalHealth — Ride Report</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="wrap">
    ${profileHtml}

    ${activitiesHtml}

    <div class="card centered">
      <h1>Turn your ride into a report</h1>
      <p>Upload a GPX file from your bike ride and get a poster-style report showing the
        cardio and strength sides of your ride, with a map, elevation profile, and a
        downloadable PDF.</p>
      <form id="form" method="post" action="/generate" enctype="multipart/form-data">
        <div class="field">
          <label for="gpxfile">GPX file</label>
          <input type="file" id="gpxfile" name="gpxfile" accept=".gpx" required />
        </div>
        <button type="submit">View report</button>
      </form>
      <div id="status"></div>
    </div>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', () => {
      document.querySelector('#form button').disabled = true;
      document.getElementById('status').textContent = 'Analysing your ride — this can take a few seconds (fetching the map and place names)…';
    });
  </script>
</body>
</html>`);
});

app.post('/profile', (req, res) => {
  const cookieOpts = { maxAge: PROFILE_COOKIE_MAX_AGE_MS, httpOnly: true, sameSite: 'lax' };
  // Only touch fields actually submitted — the connected-Strava view only submits a
  // weight mini-form, and mustn't wipe out previously saved age/ftp/lthr cookies.
  if ('age' in req.body) {
    const age = parseAge(req.body.age);
    if (age !== null) res.cookie('age', String(age), cookieOpts);
    else res.clearCookie('age', cookieOpts);
  }
  if ('ftp' in req.body) {
    const ftp = parseFtp(req.body.ftp);
    if (ftp !== null) res.cookie('ftp', String(ftp), cookieOpts);
    else res.clearCookie('ftp', cookieOpts);
  }
  if ('lthr' in req.body) {
    const lthr = parseLthr(req.body.lthr);
    if (lthr !== null) res.cookie('lthr', String(lthr), cookieOpts);
    else res.clearCookie('lthr', cookieOpts);
  }
  if ('weight' in req.body) {
    const weightKg = parseWeightInput(req.body.weight, req.body.weightUnit);
    if (weightKg !== null) res.cookie('weightKg', String(weightKg), cookieOpts);
    else res.clearCookie('weightKg', cookieOpts);
  }
  res.redirect('/');
});

/**
 * Resolves the age/FTP/LTHR to classify a ride with: a connected Strava
 * account's FTP and max-HR-derived LTHR take priority over manually saved
 * cookie values, since they reflect the athlete's real numbers.
 */
function resolveProfileParams(req) {
  const session = getStravaSession(req);
  const cookies = parseCookies(req.headers.cookie);
  const savedAge = parseAge(cookies.age);
  const savedFtp = parseFtp(cookies.ftp);
  const savedLthr = parseLthr(cookies.lthr);
  const stravaFtp = session?.ftp || null;
  const stravaLthr = session?.maxHr ? Math.round(session.maxHr * LTHR_FROM_MAXHR_FACTOR) : null;
  return {
    age: savedAge, // Strava has no age field
    ftp: stravaFtp ?? savedFtp,
    lthr: stravaLthr ?? savedLthr,
  };
}

app.post('/generate', upload.single('gpxfile'), async (req, res) => {
  if (!req.file) {
    res.status(400).send('No GPX file uploaded.');
    return;
  }
  try {
    cleanupExpiredReports();
    const { age, ftp, lthr } = resolveProfileParams(req);
    const xml = req.file.buffer.toString('utf8');
    const id = crypto.randomUUID();
    const { html, rideName } = await generateReportHtml(xml, { includeToolbar: true, pdfHref: `/report/${id}/pdf`, age, ftp, lthr });
    reports.set(id, { rideName, html, createdAt: Date.now() });
    res.redirect(`/report/${id}`);
  } catch (err) {
    console.error(err);
    res.status(400).send(`Couldn't generate a report from that file: ${err.message}`);
  }
});

function stravaRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/auth/strava/callback`;
}

app.get('/auth/strava', (req, res) => {
  try {
    res.redirect(strava.getAuthorizeUrl(stravaRedirectUri(req)));
  } catch (err) {
    res.status(500).send(`Strava isn't configured: ${err.message}`);
  }
});

app.get('/auth/strava/callback', async (req, res) => {
  if (req.query.error) {
    res.status(400).send('Strava connection was cancelled or denied.');
    return;
  }
  try {
    const token = await strava.exchangeCodeForToken(req.query.code);
    const sid = parseCookies(req.headers.cookie).sid || crypto.randomUUID();
    stravaSessions.set(sid, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_at,
      athleteName: [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(' ') || 'your account',
    });
    persistStravaSessions();
    res.cookie('sid', sid, { maxAge: SESSION_COOKIE_MAX_AGE_MS, httpOnly: true, sameSite: 'lax' });
    res.redirect('/strava/activities');
  } catch (err) {
    console.error(err);
    res.status(500).send(`Couldn't connect to Strava: ${err.message}`);
  }
});

app.get('/strava/disconnect', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) {
    stravaSessions.delete(sid);
    persistStravaSessions();
  }
  res.clearCookie('sid', { httpOnly: true, sameSite: 'lax' });
  res.redirect('/');
});

// Activities now list inline on the main page.
app.get('/strava/activities', (req, res) => res.redirect('/'));

app.get('/strava/generate/:activityId', async (req, res) => {
  const session = getStravaSession(req);
  if (!session) {
    res.redirect('/auth/strava');
    return;
  }
  try {
    cleanupExpiredReports();
    const accessToken = await ensureFreshToken(session);
    const activity = await strava.getActivity(accessToken, req.params.activityId);
    const streams = await strava.getActivityStreams(accessToken, activity.id);
    const points = strava.streamsToPoints(activity, streams);
    if (points.length === 0) {
      res.status(400).send("This activity doesn't have GPS data to build a report from.");
      return;
    }

    const { age, ftp, lthr } = resolveProfileParams(req);

    const id = crypto.randomUUID();
    const { html, rideName } = await generateReportHtmlFromPoints(
      { name: activity.name, activityType: activity.type, points },
      { includeToolbar: true, pdfHref: `/report/${id}/pdf`, age, ftp, lthr, stravaActivityId: activity.id }
    );
    reports.set(id, { rideName, html, createdAt: Date.now() });
    res.redirect(`/report/${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Couldn't generate a report from that activity: ${err.message}`);
  }
});

app.get('/report/:id', (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    res.status(404).send('Report not found or has expired. Please upload the GPX file again.');
    return;
  }
  res.type('html').send(report.html);
});

app.get('/report/:id/pdf', async (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    res.status(404).send('Report not found or has expired. Please upload the GPX file again.');
    return;
  }
  try {
    const pdf = await renderPdf(report.html);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${report.rideName.replace(/[^a-z0-9-_]+/gi, '_')}.pdf"`,
    });
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to render PDF.');
  }
});

const server = app.listen(PORT, () => {
  console.log(`MyPhysicalHealth listening on http://localhost:${PORT}`);
});

process.on('SIGTERM', async () => {
  await shutdown();
  server.close(() => process.exit(0));
});
process.on('SIGINT', async () => {
  await shutdown();
  server.close(() => process.exit(0));
});
