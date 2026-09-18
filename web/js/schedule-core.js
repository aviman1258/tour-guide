// Pure scheduling math shared by server and client. No I/O, no DOM.
// Times are "HH:MM" local strings in, minutes-since-midnight internally.

import { haversineM, detourM } from "./routeMath.js";
import { toMinutes, toHHMM } from "./format.js";

export const PARKING_MINUTES = 3; // per stop, on top of drive time
export const LUNCH_WINDOW = { start: 11 * 60 + 30, end: 14 * 60, ideal: 12 * 60 + 30 };
export const TIGHT_MINUTES = 15;

/**
 * Rough drive time when we don't have OSRM yet. Road distance ≈ 1.3× straight line,
 * at ~55 km/h average (calibrated against OSRM on a 56-mile Houston mix of highway and streets).
 */
export function estimateLegMinutes(a, b) {
  const km = haversineM(a, b) / 1000;
  return (km * 1.3) / 55 * 60;
}

/** Estimated minutes for each leg of start → stops… → end. */
export function estimateLegs(it) {
  const pts = [it.start, ...it.stops, it.end];
  const legs = [];
  for (let i = 1; i < pts.length; i++) legs.push(estimateLegMinutes(pts[i - 1], pts[i]));
  return legs;
}

/**
 * Walk the day. `legMinutes` has stops.length + 1 entries.
 * Returns { items:[{stopId, arrive, depart, legMinutes}], hotelArrive, slackMinutes, status, lunchStopId, warnings }.
 */
export function walk(it, legMinutes) {
  const warnings = [];
  const depart = toMinutes(it.arrivalTime) + (it.departBufferMinutes ?? 30);
  const deadline = toMinutes(it.deadline);
  let t = depart;
  const items = it.stops.map((s, i) => {
    const leg = legMinutes[i] + PARKING_MINUTES;
    const arrive = t + leg;
    const dep = arrive + s.dwellMinutes;
    t = dep;
    return { stopId: s.id, arrive: toHHMM(arrive), depart: toHHMM(dep), arriveMin: arrive, legMinutes: Math.round(leg) };
  });
  const hotelArrive = t + (legMinutes[it.stops.length] ?? 0);
  const slack = deadline - (it.safetyBufferMinutes ?? 15) - hotelArrive;
  const status = slack >= 0 ? (slack <= TIGHT_MINUTES ? "tight" : "ok") : slack >= -TIGHT_MINUTES ? "tight" : "late";
  const lunchStop = it.stops.find((s) => s.lunch !== "none");
  if (!lunchStop && hotelArrive - depart > 150) warnings.push("No lunch stop fits the 11:30-2:00 window.");
  if (deadline <= toMinutes(it.arrivalTime)) warnings.push("Deadline is before arrival.");
  return {
    items: items.map(({ arriveMin, ...rest }) => rest),
    hotelArrive: toHHMM(hotelArrive),
    slackMinutes: Math.round(slack),
    status,
    lunchStopId: lunchStop?.id || null,
    warnings,
    _arriveMin: items.map((x) => x.arriveMin),
  };
}

/**
 * Decide the lunch stop. Respects lunch:"user"; otherwise picks the food option whose
 * arrival is nearest 12:30 within the window and marks it lunch:"auto" with dwell >= 60.
 * Returns a new stops array.
 */
export function placeLunch(it, legMinutes) {
  const stops = it.stops.map((s) => (s.lunch === "auto" ? { ...s, lunch: "none" } : { ...s }));
  if (stops.some((s) => s.lunch === "user")) return stops;
  const sched = walk({ ...it, stops }, legMinutes);
  // highest-priority food option inside the window wins; ties go to the one nearest 12:30
  let best = -1, bestScore = -Infinity;
  stops.forEach((s, i) => {
    if (!s.isFoodOption) return;
    const a = sched._arriveMin[i];
    if (a < LUNCH_WINDOW.start || a > LUNCH_WINDOW.end) return;
    const score = (s.priority || 3) * 1000 - Math.abs(a - LUNCH_WINDOW.ideal);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0) {
    const s = stops[best];
    // a full hour for lunch, unless the day was already squeezed (then keep at least 45)
    const dwell = s.dwellCompressed ? Math.max(s.dwellMinutes, MIN_LUNCH) : Math.max(s.dwellMinutes, 60);
    stops[best] = { ...s, lunch: "auto", dwellMinutes: dwell };
  }
  return stops;
}

/**
 * Which stop to drop first: lowest priority, then the one costing the most time
 * (dwell + detour). Among equal-priority stops the lunch stop is spared; it never
 * outranks a higher-priority stop though (lunch can move to another food option).
 */
export function pickStopToTrim(it) {
  const { start, end, stops } = it;
  if (!stops.length) return null;
  const minPriority = Math.min(...stops.map((s) => s.priority || 3));
  const lowest = stops.filter((s) => (s.priority || 3) === minPriority);
  const nonLunch = lowest.filter((s) => s.lunch === "none");
  const pool = nonLunch.length ? nonLunch : lowest;
  let worst = null, worstScore = -Infinity;
  for (const s of pool) {
    const i = stops.indexOf(s);
    const prev = i === 0 ? start : stops[i - 1];
    const next = i === stops.length - 1 ? end : stops[i + 1];
    const costMin = s.dwellMinutes + (detourM(prev, s, next) / 1000) * 1.3 / 45 * 60;
    const score = (6 - (s.priority || 3)) * 1000 + costMin;
    if (score > worstScore) { worstScore = score; worst = s; }
  }
  return worst;
}

/** Shortest sensible stay per category, used when the day is still too long at the stop floor. */
export const MIN_DWELL = {
  neighborhood: 10, district: 15, landmark: 15, museum: 30, temple: 30, park: 15,
  cemetery: 15, food: 45, shopping: 15, viewpoint: 10, other: 10,
};
export const MIN_LUNCH = 45;

/**
 * Shrink dwell times toward their category minimums to recover `deficitMin` minutes.
 * Low-priority stops give up their time first (cuts weighted by 6 - priority); the
 * must-sees keep as much of their stay as possible. Returns new stops + minutes saved.
 */
export function compressDwell(stops, deficitMin) {
  if (deficitMin <= 0) return { stops, saved: 0 };
  const floors = stops.map((s) => (s.lunch !== "none" ? Math.max(MIN_LUNCH, MIN_DWELL[s.category] || 10) : MIN_DWELL[s.category] || 10));
  let remaining = deficitMin;
  const dwell = stops.map((s) => s.dwellMinutes);
  // walk priorities from lowest to highest, taking everything above the floor at each level
  for (const p of [1, 2, 3, 4, 5]) {
    if (remaining <= 0) break;
    const idx = stops.map((s, i) => i).filter((i) => (stops[i].priority || 3) === p && dwell[i] > floors[i]);
    const avail = idx.reduce((a, i) => a + (dwell[i] - floors[i]), 0);
    if (!avail) continue;
    const ratio = Math.min(1, remaining / avail);
    for (const i of idx) {
      const cut = Math.min(dwell[i] - floors[i], Math.ceil(((dwell[i] - floors[i]) * ratio) / 5) * 5);
      dwell[i] -= cut;
      remaining -= cut;
    }
  }
  let saved = 0;
  const out = stops.map((s, i) => {
    const cut = s.dwellMinutes - dwell[i];
    saved += cut;
    return cut ? { ...s, dwellMinutes: dwell[i], dwellCompressed: true } : s;
  });
  return { stops: out, saved };
}

/**
 * Build the schedule from estimated legs, trimming (if asked) until it fits.
 * legFn(it) → minutes[]; defaults to haversine estimates.
 * While there are `compressBelow` or more stops, a late day loses its lowest-priority
 * stop. Below that, we first try squeezing dwell times toward category minimums
 * (more quick stops beat fewer long ones); only if that still doesn't fit do we
 * drop another stop, down to `minStops`.
 * Returns { stops, schedule, dropped }.
 */
export function compute(it, { trim = false, minStops = 1, compressBelow = 6, legFn = estimateLegs } = {}) {
  let cur = { ...it, stops: [...it.stops] };
  const dropped = [];
  const done = (stops, schedule) => { delete schedule._arriveMin; return { stops, schedule, dropped }; };
  for (;;) {
    const legs = legFn(cur);
    cur.stops = placeLunch(cur, legs);
    const schedule = walk(cur, legs);
    if (!trim || schedule.status !== "late") return done(cur.stops, schedule);

    const atFloor = cur.stops.length <= minStops;
    if (cur.stops.length < compressBelow || atFloor) {
      const { stops: squeezed, saved } = compressDwell(cur.stops, -schedule.slackMinutes);
      if (saved > 0) {
        const sq = walk({ ...cur, stops: squeezed }, legs);
        if (sq.status !== "late") return done(squeezed, sq);
        if (atFloor) {
          sq.warnings.push("Even with short stops this doesn't fit. Push the deadline or skip the detour.");
          return done(squeezed, sq);
        }
      } else if (atFloor) {
        schedule.warnings.push("This doesn't fit the time window. Push the deadline or pick a closer stop.");
        return done(cur.stops, schedule);
      }
    }
    const victim = pickStopToTrim(cur);
    if (!victim) return done(cur.stops, schedule);
    dropped.push({ name: victim.name, reason: "trimmed", stop: { ...victim, lunch: "none" } });
    cur.stops = cur.stops.filter((s) => s.id !== victim.id);
  }
}
