// Service worker: offline app shell, polite tile cache (only tiles the map asked for),
// network-only API. Bump SHELL_VERSION when shipping changes so clients refresh.

const SHELL_VERSION = "v38"; // bump on every deploy that changes web/ — the shell is cache-first
const SHELL = `tg-shell-${SHELL_VERSION}`;
const TILES = "tg-tiles";
const IMAGES = "tg-images";
const TILE_CAP = 600;
const IMAGE_CAP = 100;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./plan.html",
  "./drive.html",
  "./terms.html",
  "./privacy.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./css/drive.css",
  "./css/landing.css",
  "./js/library.js",
  "./js/main.js", "./js/state.js", "./js/api.js", "./js/actions.js", "./js/itinerary.js", "./js/map.js",
  "./js/share.js", "./js/format.js", "./js/config.js", "./js/schedule-core.js", "./js/routeMath.js", "./js/planMatch.js",
  "./js/storage.js", "./js/drivePrep.js", "./js/drive.js", "./js/geofence.js", "./js/speech.js", "./js/sim.js", "./js/busy.js", "./js/typeahead.js", "./js/timings.js", "./js/ping.js", "./js/secretPrompt.js", "./js/turnVoice.js", "./js/pricing.js", "./js/pay.js", "./js/ownerGesture.js",
  "./data/airports.json", "./img/deodap.svg",
  "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/marker-icon.png", "./vendor/leaflet/images/marker-icon-2x.png", "./vendor/leaflet/images/marker-shadow.png",
  "./vendor/leaflet/images/layers.png", "./vendor/leaflet/images/layers-2x.png",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-512-maskable.png", "./icons/apple-touch-icon-180.png", "./icons/blank-tile.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f)))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("tg-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  if (url.origin === location.origin && (url.pathname.includes("/api/") || url.pathname.includes("/admin"))) return; // network only

  if (url.hostname === "tile.openstreetmap.org") {
    event.respondWith(networkFirst(event.request, TILES, TILE_CAP));
    return;
  }
  if (/upload\.wikimedia\.org$|thumb\.wikimedia\.org$/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event.request, IMAGES, IMAGE_CAP));
    return;
  }
  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    if (request.mode === "navigate") return (await cache.match("./drive.html")) || Response.error();
    return Response.error();
  }
}

async function networkFirst(request, cacheName, cap) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) { cache.put(request, res.clone()); trim(cache, cap); }
    return res;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const net = fetch(request).then((res) => { if (res.ok) { cache.put(request, res.clone()); trim(cache, cap); } return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function trim(cache, cap) {
  const keys = await cache.keys();
  if (keys.length <= cap) return;
  for (const k of keys.slice(0, keys.length - cap)) await cache.delete(k);
}

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
