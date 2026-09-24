// Single itinerary store with subscribe(). Starts fresh on every page load (a refresh
// clears the form); a shared link (#i=…) still restores a trip, and prepared drive
// packages live in IndexedDB, so nothing needed for the drive is lost.

const subs = new Set();
let itinerary = emptyItinerary();

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function emptyItinerary() {
  return {
    version: 1,
    start: null,
    end: null,
    date: todayLocal(),
    arrivalTime: "09:00",
    deadline: "21:00",
    departBufferMinutes: 0, // 30 is added when the start is an airport (bags, rental car)
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

/** Shallow patch or updater function. Notifies subscribers. */
export function set(patch) {
  itinerary = typeof patch === "function" ? patch(itinerary) : { ...itinerary, ...patch };
  notify();
}

export function replace(next) {
  itinerary = { ...emptyItinerary(), ...next };
  notify();
}

export function subscribe(fn) {
  subs.add(fn);
  fn(itinerary);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) fn(itinerary);
}

/** Stable id for a planned trip (used as IndexedDB key for the drive package). */
export function tripId(it = itinerary) {
  const s = `${it.start?.lat},${it.start?.lon}|${it.end?.lat},${it.end?.lon}|${it.date}|${it.stops.map((x) => x.id).join(",")}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "trip_" + (h >>> 0).toString(36);
}
