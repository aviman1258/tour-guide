// Mutations on the itinerary. Every stop edit re-schedules through the server
// (or silently keeps the old schedule if the server is unavailable).

import * as state from "./state.js";
import * as api from "./api.js";
import * as busy from "./busy.js";
import * as timings from "./timings.js";
import { runtime } from "./config.js";
import { bestInsertIndex } from "./routeMath.js";

let rescheduleTimer = null;

export function setField(patch) {
  state.set(patch);
}

export function setStart(start) {
  state.set({ start });
  reschedule();
}

export function setEnd(end) {
  state.set({ end });
  reschedule();
}

export function setRouteOptions(patch) {
  state.set((it) => ({ ...it, routeOptions: { ...(it.routeOptions || {}), ...patch } }));
  reschedule();
}

export function addStop(stop, index) {
  state.set((it) => {
    const stops = [...it.stops];
    const at = index ?? (it.start && it.end ? bestInsertIndex(it.start, stops, it.end, stop) : stops.length);
    stops.splice(at, 0, { ...stop, lunch: stop.lunch || "none" });
    return { ...it, stops, dropped: it.dropped.filter((d) => d.name !== stop.name) };
  });
  reschedule();
}

export function removeStop(id) {
  state.set((it) => ({ ...it, stops: it.stops.filter((s) => s.id !== id) }));
  reschedule();
}

export function moveStop(id, delta) {
  state.set((it) => {
    const stops = [...it.stops];
    const i = stops.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= stops.length) return it;
    [stops[i], stops[j]] = [stops[j], stops[i]];
    return { ...it, stops };
  });
  reschedule();
}

export function updateStop(id, patch) {
  state.set((it) => ({ ...it, stops: it.stops.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  reschedule();
}

export function toggleLunch(id) {
  state.set((it) => ({
    ...it,
    stops: it.stops.map((s) => {
      if (s.id === id) return { ...s, lunch: s.lunch === "user" ? "none" : "user", dwellMinutes: s.lunch === "user" ? s.dwellMinutes : Math.max(s.dwellMinutes, 60) };
      return s.lunch === "user" || s.lunch === "auto" ? { ...s, lunch: "none" } : s;
    }),
  }));
  reschedule();
}

export function addBack(dropped) {
  if (dropped.stop) addStop(dropped.stop);
}

/** Debounced re-route + re-schedule (never trims). */
export function reschedule() {
  clearTimeout(rescheduleTimer);
  rescheduleTimer = setTimeout(async () => {
    const it = state.get();
    if (!it.start || !it.end) {
      state.set({ route: null, schedule: null });
      return;
    }
    if (runtime.hasServer === false) return;
    const end = busy.begin("Routing and re-timing the day…");
    try {
      const next = await api.schedule(it, false);
      // only apply if the stops haven't changed while we waited
      const cur = state.get();
      const norm = (o) => `${Boolean(o?.avoidTolls)}|${Boolean(o?.avoidHighways)}`;
      const same = cur.stops.map((s) => s.id).join() === next.stops.map((s) => s.id).join()
        && norm(cur.routeOptions) === norm(next.routeOptions)
        && cur.arrivalTime === it.arrivalTime && cur.deadline === it.deadline;
      if (same) state.set({ route: next.route, schedule: next.schedule, stops: next.stops, routeOptions: next.routeOptions });
    } catch (err) {
      console.warn("reschedule failed:", err.message);
    } finally {
      end();
    }
  }, 350);
}

let planController = null;

/** Abort an in-flight plan. The server notices the dropped connection and stops its work too. */
export function cancelPlan() {
  planController?.abort();
}
export const isPlanning = () => Boolean(planController);

export async function plan() {
  const it = state.get();
  if (!it.start || !it.end) throw new Error("Pick a start and an end first.");
  if (!it.interests.trim()) throw new Error("Tell me what you're interested in.");
  planController?.abort();
  const ctrl = new AbortController();
  planController = ctrl;
  const startedAt = Date.now();
  const task = busy.begin("Asking Claude for stops…", { onCancel: () => ctrl.abort() });

  // progress shown in the sidebar while we wait: candidates appear, then turn into real stops
  const progress = { startedAt, phase: "claude", estimate: null, candidates: [], found: [], dropped: [] };
  const publish = () => state.set({ planning: { ...progress, candidates: [...progress.candidates], found: [...progress.found], dropped: [...progress.dropped] } });
  publish();

  const PHASE_LABEL = { claude: "Asking Claude for stops…", ground: "Checking each place on Wikipedia and the map…", route: "Routing and timing the day…" };
  let serverEstimate = null;
  const refreshEstimate = () => {
    progress.estimate = timings.planEstimate(serverEstimate, progress.candidates.length || serverEstimate?.candidateCount || 12);
    task.update({ estimateMs: progress.estimate.totalMs, startedAt });
  };
  refreshEstimate();
  try {
    const result = await api.planStream({
      start: it.start, end: it.end, date: it.date, arrivalTime: it.arrivalTime, deadline: it.deadline,
      interests: it.interests, departBufferMinutes: it.departBufferMinutes, safetyBufferMinutes: it.safetyBufferMinutes,
      routeOptions: it.routeOptions,
    }, {
      signal: ctrl.signal,
      onEvent: (event, data) => {
        if (event === "estimate") { serverEstimate = data; refreshEstimate(); }
        else if (event === "phase") {
          if (data.status === "start") { progress.phase = data.phase; task.update({ label: PHASE_LABEL[data.phase] || "Working…" }); }
          else if (data.status === "end" && data.ms) {
            // remember how long it really took, on this device
            if (data.phase === "ground") timings.record("plan.groundPerCandidate", data.ms / Math.max(1, progress.candidates.length));
            else timings.record(`plan.${data.phase}`, data.ms);
          }
        }
        else if (event === "candidates") { progress.candidates = data.map((c) => ({ ...c, status: "checking" })); refreshEstimate(); }
        else if (event === "stop") {
          progress.found.push(data.stop);
          const c = progress.candidates.find((x) => x.status === "checking" && x.name.toLowerCase() === data.stop.name.toLowerCase());
          if (c) { c.status = "ok"; c.stopId = data.stop.id; }
          task.update({ label: `Verified ${progress.found.length} of ${progress.candidates.length} places…` });
        }
        else if (event === "dropped") {
          progress.dropped.push(data);
          const c = progress.candidates.find((x) => x.status === "checking" && x.name.toLowerCase() === data.name.toLowerCase());
          if (c) { c.status = "dropped"; c.reason = data.reason; }
        }
        publish();
      },
    });
    if (ctrl.signal.aborted) return null;
    state.replace({ ...it, ...result, planning: null });
    return result;
  } catch (err) {
    state.set({ planning: null });
    if (ctrl.signal.aborted || err.name === "AbortError") {
      const e = new Error("Planning cancelled.");
      e.cancelled = true;
      throw e;
    }
    throw err;
  } finally {
    task.done();
    if (planController === ctrl) planController = null;
  }
}

export async function suggest(count = 3) {
  return busy.run("Asking Claude for more ideas…", async () => {
    const { candidates } = await api.suggest(state.get(), count);
    return candidates;
  });
}

export function reset() {
  state.replace(state.emptyItinerary());
}
