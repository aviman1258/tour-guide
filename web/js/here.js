// Best-known position of this device, for ranking search results by distance. Never prompts:
// it uses the last fix any part of the app got (remembered in localStorage for a week) and, when
// the site already has location permission, quietly refreshes it once per page load.

const KEY = "tourguide.lastFix";
const MAX_AGE_MS = 7 * 86400_000;
let cached = null;
let refreshed = false;

export function remember(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  cached = { lat, lon, at: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* ignore */ }
}

/** { lat, lon } or null. Synchronous, so it can be used as a search bias on every keystroke. */
export function here() {
  if (!cached) {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Date.now() - (v.at || 0) < MAX_AGE_MS) cached = v;
    } catch { /* ignore */ }
  }
  if (!refreshed) { refreshed = true; refreshIfAllowed(); }
  return cached ? { lat: cached.lat, lon: cached.lon } : null;
}

/** Update the fix without asking: only when the browser says permission is already granted. */
async function refreshIfAllowed() {
  try {
    if (!navigator.geolocation || !navigator.permissions?.query) return;
    const p = await navigator.permissions.query({ name: "geolocation" });
    if (p.state !== "granted") return;
    navigator.geolocation.getCurrentPosition((pos) => remember(pos.coords.latitude, pos.coords.longitude), () => {}, { enableHighAccuracy: false, maximumAge: 600_000, timeout: 8000 });
  } catch { /* ignore */ }
}

export function distanceM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
