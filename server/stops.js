// Builders for the shared Stop shape (see README "Shapes").

import { randomUUID } from "node:crypto";
import * as wikipedia from "./wikipedia.js";
import * as nominatim from "./nominatim.js";

export const newId = () => "s_" + randomUUID().slice(0, 8);

export const CATEGORIES = [
  "neighborhood", "landmark", "museum", "temple", "park", "cemetery",
  "district", "food", "shopping", "viewpoint", "other",
];

const DEFAULT_DWELL = {
  neighborhood: 15, district: 20, landmark: 20, museum: 60, temple: 45, park: 30,
  cemetery: 20, food: 60, shopping: 30, viewpoint: 15, other: 20,
};

export function trimText(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("."));
  return (end > n * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd() + "…");
}

export function makeStop(fields) {
  const category = CATEGORIES.includes(fields.category) ? fields.category : "other";
  return {
    id: fields.id || newId(),
    name: fields.name,
    lat: fields.lat,
    lon: fields.lon,
    category,
    whyItMatches: fields.whyItMatches || "",
    blurb: trimText(fields.blurb || "", 320),
    thumbnail: fields.thumbnail || null,
    wikipediaTitle: fields.wikipediaTitle || null,
    wikipediaUrl: fields.wikipediaUrl || null,
    source: fields.source || "pin",
    dwellMinutes: fields.dwellMinutes || DEFAULT_DWELL[category],
    priority: fields.priority || 3,
    isFoodOption: Boolean(fields.isFoodOption) || category === "food",
    lunch: fields.lunch || "none",
    approxArea: fields.approxArea || "",
  };
}

/** Stop from a Wikipedia summary that has coordinates. */
export function stopFromSummary(sum, extra = {}) {
  return makeStop({
    ...extra,
    name: extra.name || sum.title,
    lat: sum.coordinates.lat,
    lon: sum.coordinates.lon,
    blurb: sum.extract,
    thumbnail: sum.thumbnail,
    wikipediaTitle: sum.title,
    wikipediaUrl: sum.url,
    source: "wikipedia",
  });
}

/** Stop from a Nominatim result. */
export function stopFromNominatim(r, extra = {}) {
  const parts = r.displayName.split(",").map((s) => s.trim());
  return makeStop({
    ...extra,
    name: extra.name || r.name || parts[0],
    lat: r.lat,
    lon: r.lon,
    blurb: extra.blurb || parts.slice(1, 4).join(", "),
    approxArea: extra.approxArea || [r.address.suburb || r.address.neighbourhood, r.address.city || r.address.town].filter(Boolean).join(", "),
    source: "nominatim",
  });
}

/**
 * Try to attach a Wikipedia article to a Nominatim result by name search, then by
 * proximity (geosearch within `radiusM`). Returns a Stop either way.
 */
export async function enrichWithWikipedia(r, { radiusM = 250, extra = {} } = {}) {
  // 1. An article whose title actually matches the place name, nearby.
  const hits = await wikipedia.search(`${r.name} ${r.address.city || r.address.town || r.address.state || ""}`.trim(), 3);
  for (const h of hits) {
    if (titleSimilarity(r.name, h.title) < 0.5) continue;
    const sum = await wikipedia.summary(h.title);
    if (sum?.coordinates && distanceOk(sum.coordinates, r, 3000)) {
      return stopFromSummary(sum, { name: r.name || sum.title, ...extra });
    }
  }
  // 2. Something right on top of it: keep Nominatim's name and location, borrow the article text.
  const near = await wikipedia.geosearch(r.lat, r.lon, radiusM, 3);
  for (const g of near) {
    const sum = await wikipedia.summary(g.title);
    if (sum?.coordinates) {
      return makeStop({
        ...extra,
        name: extra.name || r.name || sum.title, lat: r.lat, lon: r.lon,
        blurb: sum.extract, thumbnail: sum.thumbnail, wikipediaTitle: sum.title, wikipediaUrl: sum.url,
        source: "nominatim",
        approxArea: [r.address.suburb || r.address.neighbourhood, r.address.city || r.address.town].filter(Boolean).join(", "),
      });
    }
  }
  return stopFromNominatim(r, extra);
}

const STOP_WORDS = new Set(["the", "of", "in", "at", "and", "a", "an", "houston", "texas", "tx", "city", "town"]);
function tokens(s) {
  return new Set(String(s || "").toLowerCase().replace(/\(.*?\)/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w)));
}
/** Share of the place-name tokens that appear in the article title (0-1). */
export function titleSimilarity(name, title) {
  const a = tokens(name), b = tokens(title);
  if (!a.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

function distanceOk(a, b, maxM) {
  const dLat = (a.lat - b.lat) * 111000;
  const dLon = (a.lon - b.lon) * 111000 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon) <= maxM;
}

/** Search a place by name: Nominatim top results, each enriched with Wikipedia. */
export async function searchPlace(q, { viewbox, limit = 3 } = {}) {
  const results = await nominatim.search(q, { viewbox, limit });
  const stops = [];
  for (const r of results) stops.push(await enrichWithWikipedia(r));
  if (stops.length) return stops;

  // Nominatim is weak on POI names (temples, restaurants). Fall back to Wikipedia search.
  const hits = await wikipedia.search(q, limit);
  for (const h of hits) {
    let sum = await wikipedia.summary(h.title);
    if (sum && !sum.coordinates) {
      // some summaries omit coordinates even when the article has them
      const batch = await wikipedia.coordinatesBatch([sum.title]);
      const hit = batch.get(sum.title.toLowerCase());
      if (hit?.coordinates) sum = { ...sum, coordinates: hit.coordinates, thumbnail: sum.thumbnail || hit.thumbnail };
    }
    if (sum?.coordinates) stops.push(stopFromSummary(sum));
  }
  return stops;
}

/** Reverse geocode a map click into a Stop, attaching a nearby article if any. */
export async function stopAtPoint(lat, lon) {
  const r = await nominatim.reverse(lat, lon, 16);
  const base = r || { name: "Dropped pin", displayName: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon, address: {} };
  const near = await wikipedia.geosearch(lat, lon, 1000, 3);
  for (const g of near) {
    const sum = await wikipedia.summary(g.title);
    if (sum?.coordinates) {
      // keep the clicked point as the stop location, but borrow the article
      return makeStop({
        name: sum.title, lat, lon, blurb: sum.extract, thumbnail: sum.thumbnail,
        wikipediaTitle: sum.title, wikipediaUrl: sum.url, source: "wikipedia",
        approxArea: base.address?.suburb || base.address?.city || "",
      });
    }
  }
  return stopFromNominatim(base);
}
