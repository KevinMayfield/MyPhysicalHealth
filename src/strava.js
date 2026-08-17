const { hrZone } = require('./analysis');

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API_BASE = 'https://www.strava.com/api/v3';

function credentials() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set (check your .env file).');
  }
  return { clientId, clientSecret };
}

function getAuthorizeUrl(redirectUri) {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read_all',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Strava token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Exchanges an OAuth `code` for an access/refresh token pair. */
async function exchangeCodeForToken(code) {
  const { clientId, clientSecret } = credentials();
  return postToken({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' });
}

/** Exchanges a refresh token for a fresh access token (Strava access tokens last ~6h). */
async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = credentials();
  return postToken({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
}

async function apiGet(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Strava API request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Lists the athlete's activities starting after `afterUnixSeconds`. */
async function listRecentActivities(accessToken, afterUnixSeconds) {
  const params = new URLSearchParams({ after: String(afterUnixSeconds), per_page: '100' });
  return apiGet(`/athlete/activities?${params}`, accessToken);
}

/** Fetches a single activity's summary/detail by id. */
async function getActivity(accessToken, activityId) {
  return apiGet(`/activities/${activityId}`, accessToken);
}

/** Fetches the authenticated athlete's profile (includes `ftp` if the athlete has set one on Strava). */
async function getAthlete(accessToken) {
  return apiGet('/athlete', accessToken);
}

/** Fetches the raw per-second streams (position, elevation, HR, cadence, power) for one activity. */
async function getActivityStreams(accessToken, activityId) {
  const params = new URLSearchParams({ keys: 'time,latlng,altitude,heartrate,cadence,watts', key_by_type: 'true' });
  return apiGet(`/activities/${activityId}/streams?${params}`, accessToken);
}

/**
 * Fetches just the time+heartrate stream for an activity and classifies
 * it into recovery (Zone 1) / moderate (Zones 2-3) / vigorous (Zones
 * 4-5) seconds against the given LTHR — the same zone thresholds used
 * throughout the full report, just without needing the full analysis
 * pipeline for a lightweight list-view summary. Returns null if the
 * activity has no heart-rate stream.
 */
async function getActivityHrBreakdown(accessToken, activityId, lthr) {
  const params = new URLSearchParams({ keys: 'time,heartrate', key_by_type: 'true' });
  const streams = await apiGet(`/activities/${activityId}/streams?${params}`, accessToken);
  const timeArr = streams.time?.data || [];
  const hrArr = streams.heartrate?.data || [];
  if (!hrArr.length) return null;

  let recoveryS = 0;
  let moderateS = 0;
  let vigorousS = 0;
  for (let i = 1; i < hrArr.length; i++) {
    const dt = typeof timeArr[i] === 'number' && typeof timeArr[i - 1] === 'number' ? timeArr[i] - timeArr[i - 1] : 1;
    const zone = hrZone(hrArr[i], lthr); // 1-5
    if (zone === 1) recoveryS += dt;
    else if (zone === 2 || zone === 3) moderateS += dt;
    else vigorousS += dt;
  }
  return { recoveryS, moderateS, vigorousS };
}

/**
 * Converts a Strava activity + its streams into the same {lat, lon, ele,
 * time, hr, cad, power} point shape produced by the GPX parser, so it
 * can run through the same analysis pipeline as an uploaded file.
 */
function streamsToPoints(activity, streams) {
  const timeArr = streams.time?.data || [];
  const latlngArr = streams.latlng?.data || [];
  const altArr = streams.altitude?.data || [];
  const hrArr = streams.heartrate?.data || [];
  const cadArr = streams.cadence?.data || [];
  const wattsArr = streams.watts?.data || [];
  const startMs = new Date(activity.start_date).getTime();

  const n = Math.max(timeArr.length, latlngArr.length);
  const points = [];
  for (let i = 0; i < n; i++) {
    const latlng = latlngArr[i];
    if (!latlng) continue;
    points.push({
      lat: latlng[0],
      lon: latlng[1],
      ele: typeof altArr[i] === 'number' ? altArr[i] : undefined,
      time: new Date(startMs + (typeof timeArr[i] === 'number' ? timeArr[i] : i) * 1000),
      hr: typeof hrArr[i] === 'number' ? hrArr[i] : undefined,
      cad: typeof cadArr[i] === 'number' ? cadArr[i] : undefined,
      power: typeof wattsArr[i] === 'number' ? wattsArr[i] : undefined,
    });
  }
  return points;
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  listRecentActivities,
  getActivity,
  getAthlete,
  getActivityStreams,
  getActivityHrBreakdown,
  streamsToPoints,
};
