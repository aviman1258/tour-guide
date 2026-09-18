// Mutations on the itinerary. Every stop edit re-schedules through the server
// (or silently keeps the old schedule if the server is unavailable).

import * as state from "./state.js";
import * as api from "./api.js";
import * as busy from "./busy.js";
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
      const same = cur.stops.map((s) => s.id).join() === next.stops.map((s) => s.id).join()
        && JSON.stringify(cur.routeOptions) === JSON.stringify(next.routeOptions);
      if (same) state.set({ route: next.route, schedule: next.schedule, stops: next.stops });
    } catch (err) {
      console.warn("reschedule failed:", err.message);
    } finally {
      end();
    }
  }, 350);
}

export async function plan() {
  const it = state.get();
  if (!it.start || !it.end) throw new Error("Pick a start and an end first.");
  if (!it.interests.trim()) throw new Error("Tell me what you're interested in.");
  return busy.run("Asking Claude for stops, then checking each one…", async () => {
    const result = await api.plan({
      start: it.start, end: it.end, date: it.date, arrivalTime: it.arrivalTime, deadline: it.deadline,
      interests: it.interests, departBufferMinutes: it.departBufferMinutes, safetyBufferMinutes: it.safetyBufferMinutes,
      routeOptions: it.routeOptions,
    });
    state.replace({ ...it, ...result });
    return result;
  });
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
