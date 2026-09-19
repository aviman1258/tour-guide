// Pure geofence state machine for narration triggers. No DOM, no timers.
// Items: narration entries {id, kind:"stop"|"driveby", targetId?, lat, lon, radiusM, alongM?}.

import { haversineM } from "./routeMath.js";

export const DEFAULTS = {
  approachDeltaM: 5,        // must be at least this much closer than the previous fix
  driveByLookaheadSec: 20,  // start a drive-by this many seconds before passing at current speed
  driveByMaxRadiusM: 800,
  driveByGateBehindM: 1500, // drive-by may fire when progress is within [alongM - behind, alongM + ahead]
  driveByGateAheadM: 500,
  cooldownAfterStopMs: 60_000,
  stopExclusionScale: 1.5,  // no drive-bys inside 1.5x a stop's radius
  visitedDwellMs: 20_000,   // inside radius and slow for this long → visited
  visitedSlowMps: 2,
  visitedLeaveScale: 1.5,   // was inside, now beyond this × radius → visited
};

export function createGeofence(items, { fired = {}, visited = [], options = {} } = {}) {
  const opt = { ...DEFAULTS, ...options };
  const state = {
    fired: { ...fired },                 // id → timestamp
    visited: new Set(visited),           // stop ids
    hist: new Map(),                     // id → last 3 distances
    seenOutside: new Set(),              // ids we've observed outside their radius (so "inside" means we drove in)
    lastStopNarrationEndMs: -Infinity,
    insideSince: new Map(),              // stopId → ms when we came inside & slow
    wasInside: new Set(),                // stopIds we've been inside of
  };
  const stops = items.filter((i) => i.kind === "stop");

  function pushDist(id, d) {
    const h = state.hist.get(id) || [];
    h.push(d);
    if (h.length > 3) h.shift();
    state.hist.set(id, h);
    return h;
  }

  // Approaching = closer than last fix. The "already deep inside" shortcut only counts
  // when we started the drive inside the radius, never after we've been outside it —
  // otherwise a place we just passed would fire on the way out.
  function approaching(id, h, d, radius) {
    if (d <= radius * 0.5 && !state.seenOutside.has(id)) return true;
    if (h.length < 2) return false;
    return d < h[h.length - 2] - opt.approachDeltaM;
  }

  /**
   * Feed one fix. Returns { fire: item|null, visited: stopId|null, events: string[] }.
   * fix = { lat, lon, speedMps, progressM|null, offRoute, nowMs, playingKind: "stop"|"driveby"|null }
   */
  function update(fix) {
    const events = [];
    const here = { lat: fix.lat, lon: fix.lon };
    const speed = Number.isFinite(fix.speedMps) && fix.speedMps > 0 ? fix.speedMps : 0;

    // --- stop visit tracking ---
    let newlyVisited = null;
    for (const s of stops) {
      if (state.visited.has(s.targetId)) continue;
      const d = haversineM(here, s);
      if (d <= s.radiusM) {
        state.wasInside.add(s.targetId);
        if (speed < opt.visitedSlowMps) {
          if (!state.insideSince.has(s.targetId)) state.insideSince.set(s.targetId, fix.nowMs);
          else if (fix.nowMs - state.insideSince.get(s.targetId) >= opt.visitedDwellMs) newlyVisited = s.targetId;
        } else {
          state.insideSince.delete(s.targetId);
        }
      } else {
        state.insideSince.delete(s.targetId);
        if (state.wasInside.has(s.targetId) && d > s.radiusM * opt.visitedLeaveScale) newlyVisited = s.targetId;
      }
      if (newlyVisited) break;
    }
    if (newlyVisited) {
      state.visited.add(newlyVisited);
      events.push(`visited:${newlyVisited}`);
    }

    // --- candidate triggers ---
    const inStopExclusion = stops.some((s) => haversineM(here, s) <= s.radiusM * opt.stopExclusionScale);
    const cooling = fix.nowMs - state.lastStopNarrationEndMs < opt.cooldownAfterStopMs;
    let best = null;

    for (const it of items) {
      if (state.fired[it.id]) continue;
      const d = haversineM(here, it);
      const h = pushDist(it.id, d);

      let radius = it.radiusM;
      if (it.kind === "driveby") {
        radius = Math.min(Math.max(it.radiusM, speed * opt.driveByLookaheadSec), opt.driveByMaxRadiusM);
      }
      if (d > radius) { state.seenOutside.add(it.id); continue; }
      if (!approaching(it.id, h, d, radius)) continue;

      if (it.kind === "driveby") {
        if (fix.playingKind === "stop") { events.push(`blocked:playing-stop:${it.id}`); continue; }
        if (cooling) { events.push(`blocked:cooldown:${it.id}`); continue; }
        if (inStopExclusion) { events.push(`blocked:near-stop:${it.id}`); continue; }
        if (Number.isFinite(fix.progressM) && Number.isFinite(it.alongM) && !fix.offRoute) {
          if (fix.progressM < it.alongM - opt.driveByGateBehindM || fix.progressM > it.alongM + opt.driveByGateAheadM) {
            events.push(`blocked:gate:${it.id}`);
            continue;
          }
        }
      }
      // stops beat drive-bys; then nearest
      const rank = (it.kind === "stop" ? 0 : 1) * 1e6 + d;
      if (!best || rank < best.rank) best = { it, rank };
    }

    if (best) {
      state.fired[best.it.id] = fix.nowMs;
      events.push(`fired:${best.it.kind}:${best.it.id}`);
    }
    return { fire: best?.it || null, visited: newlyVisited, events };
  }

  function onNarrationEnd(item, nowMs) {
    if (item?.kind === "stop") state.lastStopNarrationEndMs = nowMs;
  }

  function markVisited(stopId) {
    state.visited.add(stopId);
  }

  /** Undo a visit; also forget that we were inside, so it isn't re-marked the moment we move. */
  function unmarkVisited(stopId) {
    state.visited.delete(stopId);
    state.wasInside.delete(stopId);
    state.insideSince.delete(stopId);
  }

  function snapshot() {
    return { fired: { ...state.fired }, visited: [...state.visited] };
  }

  return { update, onNarrationEnd, markVisited, unmarkVisited, snapshot, get fired() { return state.fired; }, get visited() { return state.visited; } };
}
