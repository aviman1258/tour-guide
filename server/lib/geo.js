// Pure geo math. Points are {lat, lon}. Distances in meters unless noted.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Initial bearing from a to b, degrees 0-360. */
export function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Bounding box around points, padded by `padKm`. Returns {minLat,minLon,maxLat,maxLon}. */
export function bbox(points, padKm = 0) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const dLat = padKm / 111;
  const midLat = (minLat + maxLat) / 2;
  const dLon = padKm / (111 * Math.cos(toRad(midLat)) || 1);
  return { minLat: minLat - dLat, minLon: minLon - dLon, maxLat: maxLat + dLat, maxLon: maxLon + dLon };
}

export function bboxCenter(b) {
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

/** Extra distance added by visiting s between prev and next. */
export function detourM(prev, s, next) {
  return haversineM(prev, s) + haversineM(s, next) - haversineM(prev, next);
}

export function pathLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

/**
 * Order `stops` between fixed `start` and `end` using nearest-neighbor then 2-opt.
 * Returns a new array of stops.
 */
export function orderStops(start, stops, end) {
  if (stops.length < 2) return [...stops];
  // nearest neighbor
  const remaining = [...stops];
  const ordered = [];
  let cur = start;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineM(cur, s);
      if (d < bd) { bd = d; bi = i; }
    });
    cur = remaining.splice(bi, 1)[0];
    ordered.push(cur);
  }
  // 2-opt with fixed endpoints
  const path = [start, ...ordered, end];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < path.length - 2; i++) {
      for (let k = i + 1; k < path.length - 1; k++) {
        const before = haversineM(path[i - 1], path[i]) + haversineM(path[k], path[k + 1]);
        const after = haversineM(path[i - 1], path[k]) + haversineM(path[i], path[k + 1]);
        if (after < before - 1) {
          path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path.slice(1, -1);
}

/** Index in `stops` order at which inserting `s` adds the least distance. */
export function bestInsertIndex(start, stops, end, s) {
  const path = [start, ...stops, end];
  let best = 0, bestCost = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const c = detourM(path[i], s, path[i + 1]);
    if (c < bestCost) { bestCost = c; best = i; }
  }
  return best;
}
