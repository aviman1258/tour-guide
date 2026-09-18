// Nominatim geocoding. Policy: max 1 req/s, identifying User-Agent, cache results,
// no autocomplete. Every call goes through one serial queue.

import { config } from "./config.js";
import { fetchJson } from "./lib/http.js";
import { TtlCache, HOUR, DAY } from "./lib/cache.js";
import { SerialQueue } from "./lib/queue.js";

const cache = new TtlCache(5000);
const queue = new SerialQueue({ minIntervalMs: config.nominatimMinIntervalMs });

function normalize(r) {
  return {
    placeId: r.place_id,
    name: r.name || r.display_name?.split(",")[0] || "",
    displayName: r.display_name || "",
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    category: r.category || "",
    type: r.type || "",
    importance: r.importance || 0,
    address: r.address || {},
  };
}

/**
 * Free-text search. `viewbox` = {minLat,minLon,maxLat,maxLon} biases (not filters) results.
 * Returns up to `limit` normalized results.
 */
export async function search(q, { viewbox, countrycodes = "us", limit = 3 } = {}) {
  const key = `s:${q.toLowerCase()}:${limit}:${viewbox ? [viewbox.minLon, viewbox.minLat, viewbox.maxLon, viewbox.maxLat].map((n) => n.toFixed(2)).join(",") : ""}`;
  return cache.wrap(key, 7 * DAY, async () => {
    const params = new URLSearchParams({ q, format: "jsonv2", limit: String(limit), addressdetails: "1" });
    if (countrycodes) params.set("countrycodes", countrycodes);
    if (viewbox) {
      params.set("viewbox", `${viewbox.minLon},${viewbox.minLat},${viewbox.maxLon},${viewbox.maxLat}`);
      params.set("bounded", "0");
    }
    const { status, data } = await queue.run(() => fetchJson(`${config.nominatimBase}/search?${params}`));
    if (status !== 200 || !Array.isArray(data)) return [];
    return data.map(normalize);
  }, HOUR);
}

/** Reverse geocode. zoom 14 = neighbourhood, 16 = street, 18 = building. */
export async function reverse(lat, lon, zoom = 16) {
  const key = `r:${lat.toFixed(4)},${lon.toFixed(4)}:${zoom}`;
  return cache.wrap(key, 7 * DAY, async () => {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", zoom: String(zoom), addressdetails: "1" });
    const { status, data } = await queue.run(() => fetchJson(`${config.nominatimBase}/reverse?${params}`));
    if (status !== 200 || !data || data.error) return null;
    return normalize(data);
  }, HOUR);
}
