# MyPhysicalHealth

## What this app does

Takes a cyclist's GPX ride file and turns it into a visual "poster" style report that
explains the ride in plain language: which parts were a **cardio** workout (flat, steady
effort) and which parts were a **strength** workout (climbing, resistance against
gravity), and why that combination is good for the rider's health.

The audience is **any cyclist, any age** — not just older riders. The report should
note that the strength/climbing side is *especially* valuable for riders over 50 (faster
muscle and bone density loss from that age on), but that's a supporting detail, not the
headline framing.

This is a rebuild, as a proper application, of a report format that was prototyped
manually (GPX → analysis script → static HTML poster → PDF export). The sections below
capture what that prototype established, as the functional spec for the app.

## Input

- **GPX 1.1** files (Strava export format). Structure:
  - `<trk><name>` — ride name.
  - `<trkseg><trkpt lat=".." lon="..">` — one point per second typically.
  - `<trkpt><ele>` — elevation (metres).
  - `<trkpt><time>` — ISO8601 UTC timestamp.
  - `<trkpt><extensions><gpxtpx:TrackPointExtension>` — optional per-point:
    `<gpxtpx:hr>` (heart rate, bpm), `<gpxtpx:cad>` (cadence, rpm), `<gpxtpx:atemp>`
    (ambient temp, °C).
- HR/cadence extensions are optional per point — handle their absence gracefully
  (some points, or entire files, may lack them).

## Analysis pipeline

1. Parse all trackpoints into an ordered list (lat, lon, ele, time, hr, cad).
2. Compute cumulative distance along the track using the haversine formula.
3. Smooth elevation with a rolling window (~15 seconds) to remove GPS/barometer noise
   before doing any gradient math.
4. Compute local gradient (%) at each point using a ~40 m distance window over the
   *smoothed* elevation (look back/forward until the window is covered, not a fixed
   point count).
5. Classify each point:
   - `|grade| ≤ 1.5%` → **flat** → cardio
   - `grade > 1.5%` → **climb** → strength
   - `grade < -1.5%` → **descent** → recovery
6. Collapse consecutive same-class points into segments; fold any segment shorter than
   ~20 seconds into its neighbour so brief noise doesn't fragment the ride into
   hundreds of tiny segments.
7. Aggregate per category (flat / climb / descent): total distance, total duration,
   % of ride time, average speed, average & max HR, average cadence, elevation
   gain/loss.
8. Identify **one highlight climb** (the longest/steepest sustained climb — ideally the
   one containing the ride's peak heart rate) and **one highlight flat/cardio stretch**
   (typically the longest low-gradient stretch, or the section around the ride's lowest
   elevation).
9. Reverse-geocode the highlight points' lat/lon (e.g. via
   `https://nominatim.openstreetmap.org/reverse`) to attach a real place/road name to
   each highlight (e.g. "Caudle Hill, Fairburn", "NCN 67, River Aire, Stourton").
   - Always send a descriptive `User-Agent` identifying the app and a contact.
   - Only label a highlight with a name once it's been confirmed this way — never
     invent a place name.
   - Keep this to a small, occasional number of lookups per report (a couple of
     points), not per-trackpoint.

## Report content ("poster")

- **Header**: ride name, date, hero stat strip — total distance, total time, total
  climbing (m), average heart rate.
- **Route map** — this is the centrepiece:
  - Preferred: a **real basemap**, not a schematic. Fetch OpenStreetMap tiles
    (`tile.openstreetmap.org/{z}/{x}/{y}.png`) at a zoom level that covers the ride's
    bounding box (+ ~8% padding) in roughly 30–50 tiles, stitch them into one image,
    crop to the padded bbox, and overlay the route on top using matching Web Mercator
    pixel math so it lines up exactly with the roads underneath.
  - Route overlay coloured by category: **cardio = red/terracotta**,
    **strength = green**, **recovery = gold/ochre**. Same three colours everywhere in
    the report (map, elevation profile, legend) — this is the whole visual language of
    the app.
  - Always show **"Map data © OpenStreetMap contributors"** with a link near the map
    when OSM tiles are used.
  - Add small labelled pins at the two highlight locations. Size each label's
    background to fit its actual place-name text — don't hardcode a fixed pill width,
    since place names vary a lot in length and a too-narrow pill lets text spill out
    over the map with no contrast behind it.
  - Fallback (no network / tiles unavailable): draw the route as a schematic, locally
    projected polyline (equirectangular projection is fine) on a plain card background,
    same colour coding, no basemap.
- **Elevation profile**: distance on x, elevation on y, filled area + line, using the
  same three category colours, directly underneath the map so the reader can connect
  "steep bit on the chart" to "green bit on the map".
- **Two comparison panels**, side by side (stack on narrow screens): "Cardio" and
  "Strength".
  - Icon + "Best spot: `<highlight place name>`" + a short plain-language paragraph.
  - A stat row per panel including, at minimum: distance, **time spent**, and either
    pace/avg-speed + avg HR (cardio panel) or elevation gained + peak HR (strength
    panel). Figures should wrap to a second row cleanly on narrow layouts rather than
    overflow.
- **Benefits section**: general-audience framing ("good for every rider, any age"), a
  small set of short benefit cards — muscle retention, bone density, balance/fewer
  falls, active metabolism. Note the added importance of the strength/climbing side for
  riders over 50 as a supporting detail inside this section, not as the section's whole
  premise.
- **Takeaway / closing band**: restates the two highlight spots by name as a memorable
  "go here for cardio, go there for strength" pattern.
- **Footer**: ride name + ride date.

Copy throughout should be plain-language / lay-person friendly — this is for someone
reading about their own bike ride, not a sports-science paper.

## Visual design

- Poster-style, single scrolling page. Generous whitespace, rounded cards with soft
  shadows, tight/bold headings, `font-variant-numeric: tabular-nums` on stat figures.
- Full light/dark theme support via CSS custom properties:
  - Complete light palette defined on bare `:root`.
  - Dark overrides under `@media (prefers-color-scheme: dark)`, guarded by
    `:root:not([data-theme="light"])`.
  - Dark overrides repeated under `:root[data-theme="dark"]` so an explicit
    light/dark toggle (if the app has one) wins over OS preference in both directions.
  - Every colour comes from a token — nothing hardcoded only inside a media/attribute
    block.
- Palette family (not exact hexes — pick tastefully, but keep this relationship):
  warm stone/parchment neutral background (not a generic AI-cliché cream), dark
  ink text, terracotta/coral for cardio, deep forest green for strength, muted
  ochre/gold for recovery.
- System font stack is fine — this is a content-heavy utility report, not a
  typography showcase.
- Self-contained output: no runtime requests to external CSS/JS/fonts. Anything
  fetched (map tiles, geocoding) happens at report-generation time and gets embedded
  (e.g. the stitched map as a base64 PNG) into the final page.

## Output formats

1. **HTML report** — the poster itself, viewable directly / embeddable.
2. **PDF export** — same content through a print stylesheet: force light theme
   regardless of system setting, A4 page size with small margins, `break-inside: avoid`
   on cards and sections so a card never gets cut across a page boundary. Render via a
   headless-Chrome print-to-pdf step (or equivalent). Should come out as a handful of
   clean A4 pages.

## Non-goals

- Not exclusively an "over 50s" tool — don't frame the whole app around that audience,
  even though it's a genuine and worth-surfacing benefit.
- Don't fabricate or guess place names for map highlights — only label what's been
  confirmed via geocoding.
- Don't hammer the OSM tile server or Nominatim — modest, occasional requests per
  report generation, proper User-Agent, and attribution when tiles are used.

## Reference rides (used while prototyping this format)

- **Ronde van Elmet** (Leeds, UK) — 49.9 km, 2h14m, 499 m climbing, avg HR 155.
  Highlights: NCN 67 / River Aire, Stourton (cardio); East Leeds Link Road &
  Temple Newsam (strength).
- **Gvc Tuesday** (Garforth/Fairburn/Monk Fryston, UK) — 42.4 km, 1h44m, 328 m
  climbing, avg HR 148. Highlights: Hillam & Monk Fryston flats (cardio); Caudle Hill,
  Fairburn (strength).

These are useful as manual test fixtures — the report for each should reproduce
figures in this range and land the highlight pins on the correct real-world spots.
