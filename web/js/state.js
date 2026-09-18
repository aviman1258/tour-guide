// Single itinerary store with subscribe() and debounced localStorage autosave.

const KEY = "tourguide.itinerary.v1";
const subs = new Set();
let itinerary = load() || emptyItinerary();
let saveTimer = null;

export function emptyItinerary() {
  return {
    version: 1,
    start: null,
    end: null,
    date: "",
    arrivalTime: "11:30",
    deadline: "15:00",
    departBufferMinutes: 30,
    safetyBufferMinutes: 15,
    interests: "",
    routeOptions: { avoidTolls: false, avoidHighways: false },
    stops: [],
    route: null,
    schedule: null,
    dropped: [],
    summary: "",
  };
}

export function get() {
  return itinerary;
}

/** Shallow patch or updater function. Notifies subscribers and autosaves. */
export function set(patch) {
  itinerary = typeof patch === "function" ? patch(itinerary) : { ...itinerary, ...patch };
  notify();
  scheduleSave();
}

export function replace(next) {
  itinerary = { ...emptyItinerary(), ...next };
  notify();
  scheduleSave();
}

export function subscribe(fn) {
  subs.add(fn);
  fn(itinerary);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) fn(itinerary);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(itinerary));
    } catch { /* storage unavailable */ }
  }, 300);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 ? { ...emptyItinerary(), ...parsed } : null;
  } catch {
    return null;
  }
}

/** Stable id for a planned trip (used as IndexedDB key for the drive package). */
export function tripId(it = itinerary) {
  const s = `${it.start?.lat},${it.start?.lon}|${it.end?.lat},${it.end?.lon}|${it.date}|${it.stops.map((x) => x.id).join(",")}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "trip_" + (h >>> 0).toString(36);
}
