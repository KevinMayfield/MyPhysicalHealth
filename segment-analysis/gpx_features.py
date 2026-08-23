"""
GPX parsing and feature engineering for ride-segment clustering.

Mirrors the core math already used by the main app's analysis pipeline
(src/analysis.js) — haversine distance, ~15s elevation smoothing, ~40m
gradient window — so the segment categories explored here stay comparable
to the flat/climb/descent classification the app already does, rather
than reinventing incompatible definitions.

This module has no dependency on the main Node app; it's a standalone
read of the same GPX files.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

EARTH_RADIUS_M = 6371000
SMOOTH_WINDOW_S = 15  # seconds, +/- half — same as analysis.js
GRADIENT_WINDOW_M = 40  # metres, +/- half — same as analysis.js
SPEED_SMOOTH_WINDOW_S = 5  # shorter than SMOOTH_WINDOW_S: braking events only last a few seconds
BRAKE_THRESHOLD_MPS2 = -0.4  # noticeable deceleration, above typical GPS/rolling-terrain speed noise

NS = {
    "gpx": "http://www.topografix.com/GPX/1/1",
    "gpxtpx": "http://www.garmin.com/xmlschemas/TrackPointExtension/v1",
}


def _local(tag: str) -> str:
    """Strips the namespace off an ElementTree tag, e.g. '{ns}ele' -> 'ele'."""
    return tag.rsplit("}", 1)[-1]


def _parse_time(text: str) -> datetime | None:
    if not text:
        return None
    # GPX times are ISO8601 UTC, typically with a trailing 'Z'.
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def parse_gpx(path: str | Path) -> tuple[str, pd.DataFrame]:
    """
    Parses one GPX 1.1 file into (ride_name, points_dataframe).

    points_dataframe columns: lat, lon, ele, time, hr, cad, power
    (hr/cad/power are NaN where absent — handled gracefully, per the GPX
    spec's per-point-optional extensions).
    """
    # A couple of the example files have stray bytes before the XML
    # declaration (e.g. a leading "if "); the app's JS parser tolerates
    # this silently, so trim to the first '<' to match that behaviour
    # rather than failing on otherwise-valid GPX.
    raw_text = Path(path).read_text(encoding="utf-8")
    start = raw_text.index("<")
    root = ET.fromstring(raw_text[start:])

    ride_name = Path(path).stem
    name_el = root.find(".//gpx:trk/gpx:name", NS)
    if name_el is not None and name_el.text:
        ride_name = name_el.text.strip()

    rows = []
    for trkpt in root.iter():
        if _local(trkpt.tag) != "trkpt":
            continue
        lat = float(trkpt.attrib["lat"])
        lon = float(trkpt.attrib["lon"])
        ele = hr = cad = power = np.nan
        time = None
        for child in trkpt:
            tag = _local(child.tag)
            if tag == "ele":
                ele = float(child.text)
            elif tag == "time":
                time = _parse_time(child.text)
            elif tag == "extensions":
                for ext in child.iter():
                    ext_tag = _local(ext.tag)
                    if ext_tag == "hr" and ext.text:
                        hr = float(ext.text)
                    elif ext_tag == "cad" and ext.text:
                        cad = float(ext.text)
                    elif ext_tag == "power" and ext.text:
                        power = float(ext.text)
        rows.append((lat, lon, ele, time, hr, cad, power))

    df = pd.DataFrame(rows, columns=["lat", "lon", "ele", "time", "hr", "cad", "power"])
    return ride_name, df


def haversine_m(lat1, lon1, lat2, lon2) -> np.ndarray:
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def bearing_deg(lat1, lon1, lat2, lon2) -> np.ndarray:
    """Initial compass bearing (degrees, 0-360) from point 1 to point 2."""
    lat1r, lat2r = np.radians(lat1), np.radians(lat2)
    dlon = np.radians(lon2 - lon1)
    x = np.sin(dlon) * np.cos(lat2r)
    y = np.cos(lat1r) * np.sin(lat2r) - np.sin(lat1r) * np.cos(lat2r) * np.cos(dlon)
    return (np.degrees(np.arctan2(x, y)) + 360) % 360


def _rolling_time_window_mean(values: np.ndarray, t_s: np.ndarray, window_s: float) -> np.ndarray:
    """Centered rolling mean over a time window (irregular sampling-safe)."""
    n = len(values)
    out = np.full(n, np.nan)
    valid = ~np.isnan(values)
    lo = 0
    hi = 0
    for i in range(n):
        while lo < i and t_s[i] - t_s[lo] > window_s / 2:
            lo += 1
        if hi < i:
            hi = i
        while hi < n - 1 and t_s[hi + 1] - t_s[i] <= window_s / 2:
            hi += 1
        seg_valid = valid[lo : hi + 1]
        if seg_valid.any():
            out[i] = values[lo : hi + 1][seg_valid].mean()
    return out


def build_point_series(df: pd.DataFrame) -> pd.DataFrame:
    """
    Computes the same per-point series the app derives: cumulative
    distance, elapsed seconds, smoothed elevation, local gradient (%),
    speed (km/h), and bearing/turn-rate (deg/s) — the last one has no app
    equivalent, but is a natural proxy for "obstacles" (junctions,
    switchbacks, technical terrain) that pure gradient can't see.

    Also computes acceleration (m/s^2) from a lightly-smoothed speed
    series — a braking proxy that turn-rate and stop_fraction both miss:
    a rider scrubbing speed hard through a hairpin without ever dropping
    below the stop_fraction floor, or without much net bearing change,
    still shows up here as a sharp deceleration.
    """
    df = df.reset_index(drop=True).copy()
    n = len(df)

    lat = df["lat"].to_numpy()
    lon = df["lon"].to_numpy()
    ele = df["ele"].to_numpy()

    seg_dist = np.zeros(n)
    seg_dist[1:] = haversine_m(lat[:-1], lon[:-1], lat[1:], lon[1:])
    dist = np.cumsum(seg_dist)

    has_time = df["time"].notna().all()
    if has_time:
        t0 = df["time"].iloc[0]
        t_s = np.array([(t - t0).total_seconds() for t in df["time"]])
    else:
        t_s = np.arange(n, dtype=float)  # 1 point per second fallback

    smooth_ele = _rolling_time_window_mean(ele, t_s, SMOOTH_WINDOW_S)
    smooth_ele = pd.Series(smooth_ele).ffill().bfill().to_numpy()

    # Local gradient over a ~40m *distance* window on smoothed elevation.
    gradient = np.zeros(n)
    lo = hi = 0
    for i in range(n):
        while lo < i and dist[i] - dist[lo] > GRADIENT_WINDOW_M / 2:
            lo += 1
        if hi < i:
            hi = i
        while hi < n - 1 and dist[hi + 1] - dist[i] <= GRADIENT_WINDOW_M / 2:
            hi += 1
        run_m = dist[hi] - dist[lo]
        gradient[i] = ((smooth_ele[hi] - smooth_ele[lo]) / run_m) * 100 if run_m > 0 else 0.0

    dt = np.diff(t_s, prepend=t_s[0])
    dt[dt <= 0] = np.nan
    speed_kmh = np.zeros(n)
    speed_kmh[1:] = (seg_dist[1:] / dt[1:]) * 3.6
    speed_kmh = pd.Series(speed_kmh).fillna(0).to_numpy()

    bearing = np.zeros(n)
    bearing[1:] = bearing_deg(lat[:-1], lon[:-1], lat[1:], lon[1:])
    # Smallest signed angle between consecutive bearings, in degrees.
    turn = np.zeros(n)
    dbear = np.diff(bearing, prepend=bearing[0])
    turn[1:] = np.abs((dbear[1:] + 180) % 360 - 180)
    turn_rate = np.divide(turn, dt, out=np.zeros(n), where=~np.isnan(dt) & (dt > 0))

    # Raw point-to-point speed is too noisy to difference directly (GPS
    # jitter would swamp any real braking signal); smooth over a short
    # window first, same idea as the elevation smoothing above but shorter
    # since a braking event is a matter of seconds, not tens of seconds.
    smooth_speed_kmh = _rolling_time_window_mean(speed_kmh, t_s, SPEED_SMOOTH_WINDOW_S)
    smooth_speed_kmh = pd.Series(smooth_speed_kmh).ffill().bfill().to_numpy()
    smooth_speed_mps = smooth_speed_kmh / 3.6
    accel_mps2 = np.zeros(n)
    with np.errstate(invalid="ignore", divide="ignore"):
        accel_mps2[1:] = np.diff(smooth_speed_mps) / dt[1:]
    accel_mps2 = pd.Series(accel_mps2).replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy()

    out = df.copy()
    out["dist_m"] = dist
    out["t_s"] = t_s
    out["smooth_ele"] = smooth_ele
    out["gradient_pct"] = gradient
    out["speed_kmh"] = speed_kmh
    out["turn_deg"] = turn
    out["turn_rate_dps"] = turn_rate
    out["accel_mps2"] = accel_mps2
    return out


@dataclass
class WindowConfig:
    window_s: float = 60.0
    step_s: float | None = None  # defaults to non-overlapping (== window_s)


def windowed_features(points: pd.DataFrame, ride_name: str, cfg: WindowConfig = WindowConfig()) -> pd.DataFrame:
    """
    Slices a ride's point series into fixed-duration windows and computes
    one feature row per window — the unit of analysis for clustering.

    Features are chosen to separate not just "flat vs climbing" (which the
    app's gradient-threshold rule already does) but texture within a
    grade band: smoothness, turniness, stop-start behaviour, and braking,
    since those are what distinguish e.g. a "flat with obstacles" stretch
    from a "flat, steady" one at the same average gradient — or a hairpin
    descent that's scrubbing speed hard from a fast, smooth one, which
    turn-rate and stop_fraction alone can't tell apart.
    """
    step_s = cfg.step_s or cfg.window_s
    t_s = points["t_s"].to_numpy()
    total_s = t_s[-1] if len(t_s) else 0

    rows = []
    start = 0.0
    seg_idx = 0
    while start < total_s:
        end = start + cfg.window_s
        mask = (t_s >= start) & (t_s < end)
        if mask.sum() < 5:
            start += step_s
            continue
        w = points.loc[mask]

        grade = w["gradient_pct"].to_numpy()
        speed = w["speed_kmh"].to_numpy()
        turn_rate = w["turn_rate_dps"].to_numpy()
        accel = w["accel_mps2"].to_numpy()
        ele = w["smooth_ele"].to_numpy()

        ele_diff = np.diff(ele)
        elev_gain = ele_diff[ele_diff > 0].sum()
        elev_loss = -ele_diff[ele_diff < 0].sum()

        grade_sign = np.sign(np.where(np.abs(grade) < 1.0, 0, grade))
        sign_changes = np.sum(np.abs(np.diff(grade_sign)) > 0)

        stop_fraction = float(np.mean(speed < 3.0))

        row = {
            "ride": ride_name,
            "segment_idx": seg_idx,
            "start_s": start,
            "duration_s": w["t_s"].iloc[-1] - w["t_s"].iloc[0],
            "distance_m": w["dist_m"].iloc[-1] - w["dist_m"].iloc[0],
            "start_lat": w["lat"].iloc[0],
            "start_lon": w["lon"].iloc[0],
            "end_lat": w["lat"].iloc[-1],
            "end_lon": w["lon"].iloc[-1],
            "grade_mean": np.mean(grade),
            "grade_std": np.std(grade),
            "grade_abs_mean": np.mean(np.abs(grade)),
            "grade_sign_changes": sign_changes,
            "elev_gain_m": elev_gain,
            "elev_loss_m": elev_loss,
            "speed_mean_kmh": np.mean(speed),
            "speed_std_kmh": np.std(speed),
            "speed_cv": (np.std(speed) / np.mean(speed)) if np.mean(speed) > 0 else 0.0,
            "turn_rate_mean_dps": np.mean(turn_rate),
            "turn_rate_p90_dps": np.percentile(turn_rate, 90),
            "stop_fraction": stop_fraction,
            "brake_p10_mps2": np.percentile(accel, 10),
            "brake_fraction": float(np.mean(accel < BRAKE_THRESHOLD_MPS2)),
        }
        if w["hr"].notna().any():
            row["hr_mean"] = w["hr"].mean()
            row["hr_std"] = w["hr"].std()
        if w["cad"].notna().any():
            row["cad_mean"] = w["cad"].mean()
            row["cad_std"] = w["cad"].std()
        if w["power"].notna().any():
            row["power_mean"] = w["power"].mean()
            row["power_std"] = w["power"].std()

        rows.append(row)
        seg_idx += 1
        start += step_s

    return pd.DataFrame(rows)


def _unique_ride_name(name: str, path: Path, seen: set[str]) -> str:
    """
    GPX <name> isn't guaranteed unique across files (e.g. two different
    days both saved as "Afternoon Ride") -- keying point_series/combined
    by name alone would silently overwrite one ride's points with
    another's while merging their windowed rows under one label. Fall
    back to the filename to disambiguate.
    """
    if name not in seen:
        return name
    return f"{name} ({path.stem})"


def load_all_rides(gpx_dir: str | Path, cfg: WindowConfig = WindowConfig()) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    """
    Parses every .gpx file in gpx_dir and returns:
      - a combined windowed-feature DataFrame (one row per segment, all rides)
      - a dict of ride_name -> full point-level DataFrame (for later plotting)
    """
    gpx_dir = Path(gpx_dir)
    all_windows = []
    point_series = {}
    for path in sorted(gpx_dir.glob("*.gpx")):
        ride_name, raw = parse_gpx(path)
        if raw.empty:
            continue
        ride_name = _unique_ride_name(ride_name, path, point_series.keys())
        points = build_point_series(raw)
        point_series[ride_name] = points
        all_windows.append(windowed_features(points, ride_name, cfg))
    combined = pd.concat(all_windows, ignore_index=True) if all_windows else pd.DataFrame()
    return combined, point_series


ROUTE_SMOOTH_WINDOW_M = 80  # metres, +/- half; distance analogue of SMOOTH_WINDOW_S at a rough cycling pace


def _rolling_distance_window_mean(values: np.ndarray, dist_m: np.ndarray, window_m: float) -> np.ndarray:
    """Centered rolling mean over a distance window — mirrors _rolling_time_window_mean, keyed on distance instead of elapsed time."""
    n = len(values)
    out = np.full(n, np.nan)
    valid = ~np.isnan(values)
    lo = hi = 0
    for i in range(n):
        while lo < i and dist_m[i] - dist_m[lo] > window_m / 2:
            lo += 1
        if hi < i:
            hi = i
        while hi < n - 1 and dist_m[hi + 1] - dist_m[i] <= window_m / 2:
            hi += 1
        seg_valid = valid[lo : hi + 1]
        if seg_valid.any():
            out[i] = values[lo : hi + 1][seg_valid].mean()
    return out


def build_route_point_series(df: pd.DataFrame) -> pd.DataFrame:
    """
    Same idea as build_point_series, but for a *planned route* export
    (lat/lon/ele only — no time, HR, cadence or power, and points spaced
    by distance along the route rather than ~1Hz GPS samples). Feeding a
    file like this through build_point_series would hit its "no time"
    fallback of assuming one point per second, which — combined with
    these files' actual ~25-45m point spacing — would fabricate speeds
    of 100+ km/h out of nothing.

    Speed, turn-rate-per-second, stop_fraction and braking all require a
    real recorded pace, so none of them can be computed here. This
    derives only what's knowable from route geometry alone: elevation
    and gradient (smoothed over distance rather than time), and a
    distance-normalised turn density (degrees of bearing change per
    metre) as a speed-independent stand-in for how winding a stretch is.
    """
    df = df.reset_index(drop=True).copy()
    n = len(df)

    lat = df["lat"].to_numpy()
    lon = df["lon"].to_numpy()
    ele = df["ele"].to_numpy()

    seg_dist = np.zeros(n)
    seg_dist[1:] = haversine_m(lat[:-1], lon[:-1], lat[1:], lon[1:])
    dist = np.cumsum(seg_dist)

    smooth_ele = _rolling_distance_window_mean(ele, dist, ROUTE_SMOOTH_WINDOW_M)
    smooth_ele = pd.Series(smooth_ele).ffill().bfill().to_numpy()

    gradient = np.zeros(n)
    lo = hi = 0
    for i in range(n):
        while lo < i and dist[i] - dist[lo] > GRADIENT_WINDOW_M / 2:
            lo += 1
        if hi < i:
            hi = i
        while hi < n - 1 and dist[hi + 1] - dist[i] <= GRADIENT_WINDOW_M / 2:
            hi += 1
        run_m = dist[hi] - dist[lo]
        gradient[i] = ((smooth_ele[hi] - smooth_ele[lo]) / run_m) * 100 if run_m > 0 else 0.0

    bearing = np.zeros(n)
    bearing[1:] = bearing_deg(lat[:-1], lon[:-1], lat[1:], lon[1:])
    turn = np.zeros(n)
    dbear = np.diff(bearing, prepend=bearing[0])
    turn[1:] = np.abs((dbear[1:] + 180) % 360 - 180)
    turn_rate_dpm = np.divide(turn, seg_dist, out=np.zeros(n), where=seg_dist > 0)

    out = df.copy()
    out["dist_m"] = dist
    out["smooth_ele"] = smooth_ele
    out["gradient_pct"] = gradient
    out["turn_deg"] = turn
    out["turn_rate_dpm"] = turn_rate_dpm
    return out


@dataclass
class RouteWindowConfig:
    window_m: float = 1000.0
    step_m: float | None = None  # defaults to non-overlapping (== window_m)


def route_windowed_features(points: pd.DataFrame, ride_name: str, cfg: RouteWindowConfig = RouteWindowConfig()) -> pd.DataFrame:
    """
    Distance-windowed analogue of windowed_features() for route-only GPX
    data. Produces only the features derivable from geometry alone —
    grade and turn density — in place of the speed- and time-dependent
    texture features (speed_*, turn_rate_dps, stop_fraction, brake_*)
    that a real recorded ride provides.
    """
    step_m = cfg.step_m or cfg.window_m
    dist = points["dist_m"].to_numpy()
    total_m = dist[-1] if len(dist) else 0

    rows = []
    start = 0.0
    seg_idx = 0
    while start < total_m:
        end = start + cfg.window_m
        mask = (dist >= start) & (dist < end)
        if mask.sum() < 3:
            start += step_m
            continue
        w = points.loc[mask]

        grade = w["gradient_pct"].to_numpy()
        turn_rate = w["turn_rate_dpm"].to_numpy()
        ele = w["smooth_ele"].to_numpy()

        ele_diff = np.diff(ele)
        elev_gain = ele_diff[ele_diff > 0].sum()
        elev_loss = -ele_diff[ele_diff < 0].sum()

        grade_sign = np.sign(np.where(np.abs(grade) < 1.0, 0, grade))
        sign_changes = np.sum(np.abs(np.diff(grade_sign)) > 0)

        rows.append({
            "ride": ride_name,
            "segment_idx": seg_idx,
            "start_m": start,
            "distance_m": w["dist_m"].iloc[-1] - w["dist_m"].iloc[0],
            "start_lat": w["lat"].iloc[0],
            "start_lon": w["lon"].iloc[0],
            "end_lat": w["lat"].iloc[-1],
            "end_lon": w["lon"].iloc[-1],
            "grade_mean": np.mean(grade),
            "grade_std": np.std(grade),
            "grade_abs_mean": np.mean(np.abs(grade)),
            "grade_sign_changes": sign_changes,
            "elev_gain_m": elev_gain,
            "elev_loss_m": elev_loss,
            "turn_rate_dpm_mean": np.mean(turn_rate),
            "turn_rate_dpm_p90": np.percentile(turn_rate, 90),
        })
        seg_idx += 1
        start += step_m

    return pd.DataFrame(rows)


def load_all_routes(gpx_dir: str | Path, cfg: RouteWindowConfig = RouteWindowConfig()) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    """
    Parses every .gpx file in gpx_dir as a route (no time/HR/cadence/
    power expected) and returns the same shape of result as
    load_all_rides: a combined distance-windowed feature DataFrame and a
    dict of route_name -> point-level DataFrame.
    """
    gpx_dir = Path(gpx_dir)
    all_windows = []
    point_series = {}
    for path in sorted(gpx_dir.glob("*.gpx")):
        route_name, raw = parse_gpx(path)
        if raw.empty:
            continue
        route_name = _unique_ride_name(route_name, path, point_series.keys())
        points = build_route_point_series(raw)
        point_series[route_name] = points
        all_windows.append(route_windowed_features(points, route_name, cfg))
    combined = pd.concat(all_windows, ignore_index=True) if all_windows else pd.DataFrame()
    return combined, point_series
