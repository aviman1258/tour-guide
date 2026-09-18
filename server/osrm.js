// OSRM routing. Coordinates go out as lon,lat. Demo server: 1 req/s.

import { config } from "./config.js";
import { fetchJson, httpError } from "./lib/http.js";
import { TtlCache, HOUR } from "./lib/cache.js";
import { SerialQueue } from "./lib/queue.js";

const cache = new TtlCache(500);
const queue = new SerialQueue({ minIntervalMs: config.osrmMinIntervalMs });

/**
 * Drive route through `points` ({lat,lon}[]) in order.
 * Returns { geometry (GeoJSON LineString), legs:[{durationSec, distanceM, steps}], totalSec, totalM }.
 * Throws httpError(422) when OSRM reports NoRoute.
 */
export async function route(points, { steps = false } = {}) {
  if (points.length < 2) throw httpError(400, "route needs at least 2 points");
  const coords = points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const key = `${coords}|${steps ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const params = new URLSearchParams({ overview: "full", geometries: "geojson", steps: steps ? "true" : "false", annotations: "false" });
  const url = `${config.osrmBase}/route/v1/driving/${coords}?${params}`;
  const { status, data } = await queue.run(() => fetchJson(url));

  if (status !== 200 || data?.code !== "Ok") {
    const code = data?.code || status;
    throw httpError(code === "NoRoute" ? 422 : 502, `routing failed: ${code} ${data?.message || ""}`.trim());
  }
  const r = data.routes[0];
  const result = {
    geometry: r.geometry,
    legs: r.legs.map((l) => ({
      durationSec: Math.round(l.duration),
      distanceM: Math.round(l.distance),
      steps: steps
        ? l.steps.map((s) => ({
            distanceM: Math.round(s.distance),
            durationSec: Math.round(s.duration),
            name: s.name || "",
            ref: s.ref || "",
            maneuver: {
              type: s.maneuver.type,
              modifier: s.maneuver.modifier || null,
              exit: s.maneuver.exit ?? null,
              location: s.maneuver.location, // [lon, lat]
              bearingAfter: s.maneuver.bearing_after,
            },
          }))
        : undefined,
    })),
    totalSec: Math.round(r.duration),
    totalM: Math.round(r.distance),
  };
  cache.set(key, result, HOUR);
  return result;
}
