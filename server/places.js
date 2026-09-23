// Google Places API (New), optional. The free sources (Wikipedia, OpenStreetMap via Nominatim
// and Photon) don't know many small local places: a neighbourhood temple, a family bakery. With
// GOOGLE_PLACES_KEY set, Text Search is the last fallback when grounding a candidate or searching
// for a stop to add. Field mask keeps each call in the cheapest SKU that still returns location,
// a one-line summary and the types. Off (returns []) when the key is empty.

import { config } from "./config.js";
import { TtlCache, DAY } from "./lib/cache.js";
import { categoryForKind } from "./photon.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = "places.id,places.displayName,places.location,places.types,places.primaryType,places.formattedAddress,places.editorialSummary,places.rating,places.userRatingCount";
const cache = new TtlCache(2000);
const state = { calls: 0, lastStatus: null, lastError: null };
export const stats = () => ({ enabled: Boolean(config.googlePlacesKey), ...state });
export const enabled = () => Boolean(config.googlePlacesKey);

export function normalize(p) {
  const types = p.types || [];
  return {
    id: p.id, name: p.displayName?.text || "", lat: p.location?.latitude, lon: p.location?.longitude,
    address: p.formattedAddress || "", summary: p.editorialSummary?.text || "",
    kind: p.primaryType || types[0] || "", types,
    category: categoryForKind([p.primaryType, ...types].filter(Boolean).join(" ")),
    rating: p.rating ?? null, ratings: p.userRatingCount ?? null,
  };
}

/**
 * Text search biased to `near` within `radiusM`. Returns normalized places (may be empty).
 * Never throws; failures are recorded in stats().
 */
export async function searchText(q, { near, radiusM = 30_000, limit = 5, fetchImpl = globalThis.fetch } = {}) {
  if (!config.googlePlacesKey || !q) return [];
  const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ""}|${radiusM}|${limit}`;
  return cache.wrap(key, DAY, async () => {
    const body = { textQuery: q, maxResultCount: Math.min(20, limit), languageCode: "en" };
    if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: Math.min(50_000, radiusM) } };
    try {
      const r = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Goog-Api-Key": config.googlePlacesKey, "X-Goog-FieldMask": FIELDS },
        body: JSON.stringify(body), signal: AbortSignal.timeout?.(8000),
      });
      state.calls++; state.lastStatus = r.status;
      if (!r.ok) { state.lastError = `Places answered ${r.status}`; return []; }
      const j = await r.json();
      state.lastError = null;
      return (j.places || []).map(normalize).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    } catch (err) {
      state.lastError = err.message;
      return [];
    }
  });
}
