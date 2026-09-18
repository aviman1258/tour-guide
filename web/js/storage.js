// IndexedDB wrapper for the prepared drive package and in-drive state.
// Stores: trips (key tripId), driveState (key tripId), settings (key name).

const DB_NAME = "tourguide";
const DB_VERSION = 1;
const ACTIVE_KEY = "tourguide.activeTripId";
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["trips", "driveState", "settings"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
export const put = (store, key, value) => tx(store, "readwrite", (s) => s.put(value, key));
export const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
export const keys = (store) => tx(store, "readonly", (s) => s.getAllKeys());
export const all = (store) => tx(store, "readonly", (s) => s.getAll());

export async function saveTrip(pkg) {
  await put("trips", pkg.tripId, pkg);
  setActiveTripId(pkg.tripId);
  return pkg;
}
export const getTrip = (tripId) => get("trips", tripId);
export const listTrips = () => all("trips");

export const getDriveState = (tripId) => get("driveState", tripId);
export const putDriveState = (tripId, st) => put("driveState", tripId, st);
export const clearDriveState = (tripId) => del("driveState", tripId);

export function getActiveTripId() {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}
export function setActiveTripId(id) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
}

/** Ask the browser not to evict our data (best-effort). */
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
