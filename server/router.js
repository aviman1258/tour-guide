// Routing with preferences. Valhalla (FOSSGIS public server) is primary because it supports
// avoiding tolls and highways and returns spoken-style instructions; the OSRM demo server is
// the fallback for plain routes (it rejects every `exclude` option). Both normalise to:
//   { geometry (GeoJSON LineString), legs:[{durationSec, distanceM, steps[]}], totalSec, totalM,
//     router, flags:{hasToll, hasHighway, hasFerry} }
// step = { distanceM, durationSec, name, instruction?, verbalAlert?, maneuver:{type, modifier, exit, location:[lon,lat], bearingAfter} }

import { config } from "./config.js";
import { fetchJson, httpError } from "./lib/http.js";
import { TtlCache, HOUR } from "./lib/cache.js";
import { SerialQueue } from "./lib/queue.js";
import * as osrm from "./osrm.js";

const cache = new TtlCache(500);
const queue = new SerialQueue({ minIntervalMs: 600 });

export function normalizeOptions(o = {}) {
  return { avoidTolls: Boolean(o?.avoidTolls), avoidHighways: Boolean(o?.avoidHighways) };
}

/**
 * Drive route through `points` ({lat,lon}[]) in order.
 * @param opts { steps, avoidTolls, avoidHighways }
 */
export async function route(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) throw httpError(400, "route needs at least 2 points");
  const o = { steps: Boolean(opts.steps), ...normalizeOptions(opts) };
  const key = `${points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";")}|${o.steps ? 1 : 0}|${o.avoidTolls ? "T" : ""}${o.avoidHighways ? "H" : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result;
  try {
    result = await valhalla(points, o);
  } catch (err) {
    if (o.avoidTolls || o.avoidHighways) throw err; // only Valhalla can honour these
    console.warn(`[router] valhalla failed (${err.message}); falling back to OSRM`);
    result = { ...(await osrm.route(points, { steps: o.steps })), router: "osrm", flags: {} };
  }
  cache.set(key, result, HOUR);
  return result;
}

// ---------- Valhalla ----------

async function valhalla(points, o) {
  const body = {
    locations: points.map((p) => ({ lat: p.lat, lon: p.lon, type: "break" })),
    costing: "auto",
    costing_options: { auto: { ...(o.avoidTolls ? { use_tolls: 0 } : {}), ...(o.avoidHighways ? { use_highways: 0 } : {}) } },
    units: "kilometers",
    directions_options: { units: "kilometers", language: "en-US" },
    shape_format: "polyline6",
  };
  const { status, data } = await queue.run(() =>
    fetchJson(`${config.valhallaBase}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  if (status !== 200 || !data?.trip) {
    const msg = data?.error || data?.raw || `HTTP ${status}`;
    throw httpError(status === 400 ? 422 : 502, `routing failed: ${msg}`);
  }
  const trip = data.trip;
  const coords = [];
  const legs = trip.legs.map((leg) => {
    const shape = decodePolyline(leg.shape, 1e6); // [[lon,lat],...]
    // stitch legs without duplicating the shared break point
    const startAt = coords.length ? 1 : 0;
    coords.push(...shape.slice(startAt));
    return {
      durationSec: Math.round(leg.summary.time),
      distanceM: Math.round(leg.summary.length * 1000),
      steps: o.steps
        ? leg.maneuvers.map((m) => {
            const [type, modifier] = mapManeuver(m.type);
            return {
              distanceM: Math.round((m.length || 0) * 1000),
              durationSec: Math.round(m.time || 0),
              name: (m.street_names || []).join(" / "),
              instruction: m.instruction || "",
              verbalAlert: m.verbal_transition_alert_instruction || m.verbal_pre_transition_instruction || "",
              maneuver: {
                type, modifier,
                exit: m.roundabout_exit_count ?? null,
                location: shape[Math.min(m.begin_shape_index ?? 0, shape.length - 1)],
                bearingAfter: m.bearing_after ?? null,
                toll: Boolean(m.toll),
                highway: Boolean(m.highway),
              },
            };
          })
        : undefined,
    };
  });
  return {
    geometry: { type: "LineString", coordinates: coords },
    legs,
    totalSec: Math.round(trip.summary.time),
    totalM: Math.round(trip.summary.length * 1000),
    router: "valhalla",
    flags: { hasToll: Boolean(trip.summary.has_toll), hasHighway: Boolean(trip.summary.has_highway), hasFerry: Boolean(trip.summary.has_ferry) },
  };
}

// Valhalla maneuver type → OSRM-ish (type, modifier), which drive mode already understands.
const VALHALLA_TYPES = {
  0: ["continue", "straight"], 1: ["depart", null], 2: ["depart", "right"], 3: ["depart", "left"],
  4: ["arrive", null], 5: ["arrive", "right"], 6: ["arrive", "left"], 7: ["new name", "straight"],
  8: ["continue", "straight"], 9: ["turn", "slight right"], 10: ["turn", "right"], 11: ["turn", "sharp right"],
  12: ["turn", "uturn"], 13: ["turn", "uturn"], 14: ["turn", "sharp left"], 15: ["turn", "left"], 16: ["turn", "slight left"],
  17: ["on ramp", "straight"], 18: ["on ramp", "right"], 19: ["on ramp", "left"], 20: ["off ramp", "right"], 21: ["off ramp", "left"],
  22: ["fork", "straight"], 23: ["fork", "right"], 24: ["fork", "left"], 25: ["merge", "straight"],
  26: ["roundabout", null], 27: ["exit roundabout", null], 28: ["notification", null], 29: ["notification", null],
  37: ["merge", "right"], 38: ["merge", "left"],
};
function mapManeuver(t) {
  return VALHALLA_TYPES[t] || ["continue", "straight"];
}

/** Google encoded polyline → [[lon,lat],...] at the given precision (1e5 or 1e6). */
export function decodePolyline(str, precision = 1e6) {
  const out = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lon / precision, lat / precision]);
  }
  return out;
}
