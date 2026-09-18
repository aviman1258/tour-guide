// Server-side itinerary computation: order → estimate/trim → OSRM confirm → re-trim.

import { config } from "./config.js";
import { httpError } from "./lib/http.js";
import { orderStops, pathLengthM, bestInsertIndex } from "./lib/geo.js";
import * as osrm from "./osrm.js";
import { compute, estimateLegs } from "../web/js/schedule-core.js";
import { toMinutes } from "../web/js/format.js";

export function validateItinerary(it) {
  for (const k of ["start", "end"]) {
    const p = it[k];
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) throw httpError(400, `${k} needs lat/lon`);
  }
  if (!/^\d{2}:\d{2}$/.test(it.arrivalTime || "") || !/^\d{2}:\d{2}$/.test(it.deadline || "")) {
    throw httpError(400, "arrivalTime and deadline must be HH:MM");
  }
  if (toMinutes(it.deadline) <= toMinutes(it.arrivalTime)) throw httpError(400, "deadline must be after arrival");
  if (!Array.isArray(it.stops)) throw httpError(400, "stops must be an array");
}

/** Keep Claude's order unless a geometric re-order is clearly shorter. */
export function maybeReorder(it) {
  if (it.stops.length < 3) return it.stops;
  const claudeLen = pathLengthM([it.start, ...it.stops, it.end]);
  const reordered = orderStops(it.start, it.stops, it.end);
  const geoLen = pathLengthM([it.start, ...reordered, it.end]);
  return geoLen < claudeLen * 0.85 ? reordered : it.stops;
}

/**
 * Full pipeline. `trim` removes low-priority stops until the day fits (plan only).
 * Returns the itinerary with stops, route, schedule and dropped filled in.
 */
export async function computeItinerary(input, { trim = false, reorder = false } = {}) {
  validateItinerary(input);
  const it = {
    departBufferMinutes: config.departBufferMinutes,
    safetyBufferMinutes: config.safetyBufferMinutes,
    ...input,
    dropped: [...(input.dropped || [])],
  };
  if (reorder) it.stops = maybeReorder(it);

  // 1. estimate + trim by haversine
  const trimOpts = { trim, minStops: config.minStopsAfterTrim, compressBelow: config.compressBelowStops };
  let result = compute(it, trimOpts);
  it.stops = result.stops;
  it.dropped.push(...result.dropped);

  // 2. confirm with OSRM; if real durations still run late, trim again and re-route (bounded)
  let route = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    route = await osrm.route([it.start, ...it.stops, it.end], { steps: true });
    const routedCount = it.stops.length;
    const realLegs = route.legs.map((l) => l.durationSec / 60);
    // real legs while the stop set matches the routed one; haversine estimates once compute() drops stops
    const legFn = (cur) => (cur.stops.length === routedCount ? realLegs : estimateLegs(cur));
    result = compute(it, { ...trimOpts, legFn });
    it.dropped.push(...result.dropped);
    const changed = result.stops.length !== it.stops.length;
    it.stops = result.stops;
    if (!changed) break; // route matches the final stop set
  }

  // 3. estimates run pessimistic: if real timings leave room, try giving back the best trimmed stop
  if (trim && result.schedule.slackMinutes >= 20) {
    const idx = it.dropped.findLastIndex((d) => d.reason === "trimmed" && d.stop);
    if (idx >= 0) {
      const back = it.dropped[idx].stop;
      const at = bestInsertIndex(it.start, it.stops, it.end, back);
      const trial = { ...it, stops: [...it.stops.slice(0, at), back, ...it.stops.slice(at)] };
      const est = compute(trial, { trim: false });
      if (est.schedule.status !== "late") {
        const trialRoute = await osrm.route([trial.start, ...trial.stops, trial.end], { steps: true });
        const real = compute(trial, { trim: false, legFn: () => trialRoute.legs.map((l) => l.durationSec / 60) });
        if (real.schedule.status !== "late") {
          it.stops = real.stops;
          it.dropped.splice(idx, 1);
          route = trialRoute;
          result = real;
        }
      }
    }
  }

  return { ...it, route, schedule: result.schedule };
}

export { estimateLegs };
