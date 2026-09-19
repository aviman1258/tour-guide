// The planning pipeline as a stream of events, so the browser can show progress and
// list stops as they are verified instead of waiting for everything.
// emit(event, data) is called with:
//   estimate   {phases, totalMs, basedOnRuns}
//   phase      {phase:"claude"|"ground"|"route", status:"start"|"end", ms?, count?}
//   candidates [{name, category, whyItMatches, approxArea}]     (right after Claude answers)
//   stop       {stop}                                            (each grounded stop, in resolve order)
//   dropped    {name, reason}
//   done       {itinerary}

import { config } from "./config.js";
import { httpError } from "./lib/http.js";
import { bbox, bboxCenter, haversineM } from "./lib/geo.js";
import * as timings from "./lib/timings.js";
import * as claude from "./claude.js";
import * as resolve from "./resolve.js";
import * as schedule from "./schedule.js";
import { toMinutes } from "../web/js/format.js";

export function parsePlanInput(b = {}) {
  const input = {
    version: 1,
    start: b.start, end: b.end, date: b.date || "",
    arrivalTime: b.arrivalTime, deadline: b.deadline,
    departBufferMinutes: Number(b.departBufferMinutes) || config.departBufferMinutes,
    safetyBufferMinutes: Number(b.safetyBufferMinutes) || config.safetyBufferMinutes,
    interests: String(b.interests || "").trim(),
    routeOptions: b.routeOptions || {},
    stops: [],
  };
  schedule.validateItinerary(input);
  if (!input.interests) throw httpError(400, "interests is required");
  return input;
}

/**
 * Run the whole plan. Resolves to the final itinerary (also emitted as `done`).
 * Returns null if `signal` aborted (the caller has gone away).
 */
export async function runPlan(input, { emit = () => {}, signal } = {}) {
  const gone = () => Boolean(signal?.aborted);
  const corridor = bbox([input.start, input.end], 25);
  const center = bboxCenter(corridor);
  const budgetMinutes = toMinutes(input.deadline) - toMinutes(input.arrivalTime) - input.departBufferMinutes - input.safetyBufferMinutes;

  emit("estimate", timings.planEstimate());

  // 1. Claude proposes candidates
  emit("phase", { phase: "claude", status: "start" });
  let t = Date.now();
  let proposal;
  try {
    proposal = await claude.proposeStops({ ...input, budgetMinutes, corridor, signal });
  } catch (err) {
    if (gone()) return null;
    throw err;
  }
  if (gone()) return null;
  timings.record("plan.claude", Date.now() - t);
  emit("phase", { phase: "claude", status: "end", ms: Date.now() - t, count: proposal.stops.length });
  if (!proposal.stops.length) throw httpError(502, "Claude returned no stops");
  emit("candidates", proposal.stops.map((c) => ({ name: c.name, category: c.category, whyItMatches: c.whyItMatches, approxArea: c.approxArea })));
  emit("estimate", timings.planEstimate(proposal.stops.length));

  // 2. Ground each candidate; stream them out as they land (mirroring resolve's dedupe/too-far rules)
  emit("phase", { phase: "ground", status: "start", count: proposal.stops.length });
  t = Date.now();
  const seen = new Set();
  const grounded = await resolve.resolveCandidates(proposal.stops, corridor, {
    onResult: (r) => {
      if (gone()) return;
      if (r.drop) return emit("dropped", r.drop);
      const s = r.stop;
      const key = (s.wikipediaTitle || s.name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      if (haversineM(s, center) > config.maxCorridorKm * 1000) return emit("dropped", { name: s.name, reason: "too_far" });
      emit("stop", { stop: s });
    },
  });
  if (gone()) return null;
  timings.record("plan.groundPerCandidate", (Date.now() - t) / Math.max(1, proposal.stops.length));
  emit("phase", { phase: "ground", status: "end", ms: Date.now() - t, count: grounded.stops.length });
  console.log(`[plan] ${proposal.stops.length} proposed → ${grounded.stops.length} grounded, ${grounded.dropped.length} dropped`);
  if (!grounded.stops.length) throw httpError(502, "None of the proposed stops could be verified");

  // 3. Route, schedule, trim
  emit("phase", { phase: "route", status: "start" });
  t = Date.now();
  const result = await schedule.computeItinerary(
    { ...input, stops: grounded.stops, dropped: grounded.dropped, summary: proposal.summary },
    { trim: true, reorder: true }
  );
  if (gone()) return null;
  timings.record("plan.route", Date.now() - t);
  emit("phase", { phase: "route", status: "end", ms: Date.now() - t });
  emit("done", { itinerary: result });
  return result;
}
