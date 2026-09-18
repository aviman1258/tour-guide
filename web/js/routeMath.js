// Geo math shared by the plan screen and drive mode. Points are {lat, lon}; meters.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function detourM(prev, s, next) {
  return haversineM(prev, s) + haversineM(s, next) - haversineM(prev, next);
}

/** Index in `stops` at which inserting `s` adds the least distance. */
export function bestInsertIndex(start, stops, end, s) {
  const path = [start, ...stops, end];
  let best = 0, bestCost = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const c = detourM(path[i], s, path[i + 1]);
    if (c < bestCost) { bestCost = c; best = i; }
  }
  return best;
}

/** GeoJSON LineString coords ([lon,lat][]) → {lat,lon}[] */
export function lineToPoints(geometry) {
  return (geometry?.coordinates || []).map(([lon, lat]) => ({ lat, lon }));
}

/** Cumulative distance along a point list; cum[i] = meters from start to point i. */
export function cumulative(points) {
  const cum = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + haversineM(points[i - 1], points[i]);
  return cum;
}

/** Local flat projection helpers (good enough over city scale). */
function toXY(p, ref) {
  const k = Math.cos(toRad(ref.lat));
  return { x: (p.lon - ref.lon) * 111320 * k, y: (p.lat - ref.lat) * 110540 };
}

/**
 * Project `p` onto the polyline. Searches ±window vertices around `hint` (or all).
 * Returns { segIndex, t (0-1 along segment), progressM, offRouteM, point }.
 */
export function project(points, cum, p, hint = null, window = 200) {
  const lo = hint == null ? 0 : Math.max(0, hint - window);
  const hi = hint == null ? points.length - 2 : Math.min(points.length - 2, hint + window);
  let best = null;
  for (let i = lo; i <= hi; i++) {
    const a = points[i], b = points[i + 1];
    const A = toXY(a, p), B = toXY(b, p); // p is origin → P = (0,0)
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? (-(A.x * dx + A.y * dy)) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = A.x + t * dx, qy = A.y + t * dy;
    const d = Math.hypot(qx, qy);
    if (!best || d < best.offRouteM) {
      best = {
        segIndex: i, t, offRouteM: d,
        progressM: cum[i] + t * (cum[i + 1] - cum[i]),
        point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
      };
    }
  }
  return best;
}

/** Point at `distM` along the polyline, plus heading of that segment. */
export function interpolateAlong(points, cum, distM) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, distM));
  let i = 0;
  // binary search for the segment
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  i = lo;
  const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
  const segLen = cum[i + 1] - cum[i] || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i]) / segLen));
  return {
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    heading: bearingDeg(a, b),
    segIndex: i,
  };
}

/** Sample points every `stepM` along the polyline. Returns [{lat, lon, alongM, segIndex}]. */
export function sampleAlong(points, cum, stepM) {
  const total = cum[cum.length - 1];
  const out = [];
  for (let d = 0; d <= total; d += stepM) {
    const p = interpolateAlong(points, cum, d);
    out.push({ lat: p.lat, lon: p.lon, alongM: d, segIndex: p.segIndex });
  }
  return out;
}
