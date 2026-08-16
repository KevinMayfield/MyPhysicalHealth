const USER_AGENT = 'MyPhysicalHealth/1.0 (GPX ride poster generator; contact: kevin.mayfield@mayfield-is.co.uk)';

function buildLabel(address, displayName) {
  if (!address) {
    return displayName ? displayName.split(',').slice(0, 2).join(',').trim() : null;
  }
  const primary =
    address.road || address.pedestrian || address.cycleway || address.path || address.hamlet || address.neighbourhood;
  const secondary = address.village || address.town || address.city || address.suburb || address.county;

  if (primary && secondary && primary !== secondary) return `${primary}, ${secondary}`;
  if (secondary) return secondary;
  if (primary) return primary;
  return displayName ? displayName.split(',').slice(0, 2).join(',').trim() : null;
}

/**
 * Reverse-geocodes a single lat/lon via Nominatim. Returns a short place
 * label, or null if the lookup fails or yields nothing usable — callers
 * must never invent a name in that case.
 */
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=16`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return buildLabel(data.address, data.display_name);
  } catch {
    return null;
  }
}

/**
 * Looks up the two highlight locations (a small, fixed number of
 * requests per report), spaced out to be polite to the Nominatim
 * usage policy of ~1 request/second.
 */
async function geocodeHighlights(highlightClimb, highlightFlat) {
  const climbName = highlightClimb ? await reverseGeocode(highlightClimb.lat, highlightClimb.lon) : null;
  if (highlightFlat) await new Promise((r) => setTimeout(r, 1100));
  const flatName = highlightFlat ? await reverseGeocode(highlightFlat.lat, highlightFlat.lon) : null;
  return { climbName, flatName };
}

/**
 * Reverse-geocodes a list of {lat, lon} spots in sequence, spaced out to
 * respect Nominatim's ~1 request/second usage policy. Returns the same
 * spots with a `name` field added (null where the lookup fails).
 */
async function geocodeSpots(spots) {
  const named = [];
  for (let i = 0; i < spots.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1100));
    const name = await reverseGeocode(spots[i].lat, spots[i].lon);
    named.push({ ...spots[i], name });
  }
  return named;
}

module.exports = { reverseGeocode, geocodeHighlights, geocodeSpots };
