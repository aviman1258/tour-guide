// Getting back on course. When the car leaves the planned line, the drive screen asks the
// server for a short detour from where the car is to a point on the original route a little
// ahead of where it left, then follows that detour (banner + spoken turns) until the car is
// back on the line. Pure helpers here; the fetch and map work live in drive.js.

import { interpolateAlong, haversineM, lineToPoints, cumulative } from "./routeMath.js";
import { flattenManeuvers } from "./maneuvers.js";

export const MIN_GAP_MS = 20_000;   // ask the router again after this long off the line
export const MIN_MOVE_M = 150;      // …or sooner once the car has moved this far (but never inside the floor)
export const FLOOR_MS = 8_000;      // hard floor between asks: no "Rerouting" chatter, no hammering the router
export const MAX_TARGET_M = 50_000; // don't try to route back from another state

/**
 * Where to rejoin: on the original route, a bit ahead of where the car left it
 * (farther at speed), but never past the next unvisited stop.
 * → { lat, lon, atM }
 */
export function rejoinTarget({ points, cum, leftAtM, speedMps = 0, stopAlong = [], nextStopIdx = 0 }) {
  const total = cum[cum.length - 1];
  const aheadM = Math.min(1500, Math.max(400, (Number.isFinite(speedMps) ? speedMps : 0) * 45));
  let atM = Math.min(total, (leftAtM ?? 0) + aheadM);
  const nextStopM = stopAlong[nextStopIdx];
  if (Number.isFinite(nextStopM) && nextStopM > (leftAtM ?? 0) && nextStopM < atM) atM = nextStopM;
  const p = interpolateAlong(points, cum, atM);
  return { lat: p.lat, lon: p.lon, atM };
}

/** Throttle: ask again only after a pause, or once the car has clearly moved. */
export function shouldAsk({ nowMs, lastAskMs = 0, lastAskAt = null, here, busy = false }) {
  if (busy) return false;
  if (!lastAskAt) return true;
  const gap = nowMs - lastAskMs;
  if (gap >= MIN_GAP_MS) return true;
  return gap >= FLOOR_MS && haversineM(lastAskAt, here) >= MIN_MOVE_M;
}

/** Turn the server's answer into something the drive screen can follow. */
export function buildDetour(routeResult) {
  const points = lineToPoints(routeResult.geometry);
  const cum = cumulative(points);
  const maneuvers = flattenManeuvers(routeResult, points, cum, { end: "the route" })
    .map((m) => (m.type === "arrive" ? { ...m, text: "Rejoin the route", short: "Rejoining the route" } : m));
  return { points, cum, total: cum[cum.length - 1], maneuvers, nextIdx: 0, totalSec: routeResult.totalSec ?? null };
}
