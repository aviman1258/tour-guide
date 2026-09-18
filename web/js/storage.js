// IndexedDB wrapper for the prepared drive package and drive-time state.
// Stores: trips (key tripId), driveState (key tripId), settings (key name).

const DB_NAME = "tourguide";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("trips")) db.createObjectStore("trips", { keyPath: "tripId" });
      if (!db.objectStoreNames.contains("driveState")) db.createObjectStore("driveState", { keyPath: "tripId" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "name" });
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
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const getTrip = (tripId) => tx("trips", "readonly", (s) => s.get(tripId));
export const putTrip = (pkg) => tx("trips", "readwrite", (s) => s.put(pkg));
export const listTrips = () => tx("trips", "readonly", (s) => s.getAll());
export const deleteTrip = (tripId) => tx("trips", "readwrite", (s) => s.delete(tripId));

export const getDriveState = (tripId) => tx("driveState", "readonly", (s) => s.get(tripId));
export const putDriveState = (st) => tx("driveState", "readwrite", (s) => s.put(st));
export const clearDriveState = (tripId) => tx("driveState", "readwrite", (s) => s.delete(tripId));

export const getSetting = (name) => tx("settings", "readonly", (s) => s.get(name)).then((r) => r?.value);
export const putSetting = (name, value) => tx("settings", "readwrite", (s) => s.put({ name, value }));

const ACTIVE_KEY = "tourguide.activeTripId";
export function activeTripId() {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}
export function setActiveTripId(id) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}
