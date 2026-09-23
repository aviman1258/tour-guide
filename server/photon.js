// Server-side Photon (komoot) search: OpenStreetMap places by name, biased to a point. Photon
// knows POIs Nominatim's free-text search misses (temples, cafés, small museums) and allows
// fast repeated queries. Used as a grounding fallback and by the add-a-stop endpoint.

import { fetchJson } from "./lib/http.js";
import { TtlCache, DAY } from "./lib/cache.js";

const BASE = "https://photon.komoot.io/api/";
const cache = new TtlCache(3000);

/** OSM value (from Photon's osm_value / Google types) → our stop category. */
export function categoryForKind(kind = "") {
  const k = String(kind).toLowerCase();
  if (/place_of_worship|temple|church|mosque|synagogue|shrine|monastery|gurdwara|hindu_temple/.test(k)) return "temple";
  if (/museum|gallery|art_gallery/.test(k)) return "museum";
  if (/park|garden|nature_reserve|beach|national_park/.test(k)) return "park";
  if (/restaurant|cafe|bakery|fast_food|food_court|ice_cream|bar|pub|coffee/.test(k)) return "food";
  if (/mall|marketplace|shopping|department_store|market|supermarket|store/.test(k)) return "shopping";
  if (/viewpoint|scenic|lookout|observation/.test(k)) return "viewpoint";
  if (/cemetery|grave/.test(k)) return "cemetery";
  if (/suburb|neighbourhood|neighborhood|quarter|residential|hamlet|village/.test(k)) return "neighborhood";
  if (/attraction|monument|memorial|castle|historic|landmark|lighthouse|pier|bridge|stadium|theatre|theater|zoo|aquarium|university|library|tourist/.test(k)) return "landmark";
  return "other";
}

function normalize(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry?.coordinates || [];
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || "";
  return {
    name, lat, lon,
    kind: p.osm_value || p.type || "",
    osmKey: p.osm_key || "",
    city: p.city || p.county || "", state: p.state || "", country: p.country || "",
    street: p.street || "",
    sub: [p.street && p.name ? p.street : null, p.city || p.county, p.state].filter(Boolean).join(", "),
  };
}

/** Search by name near a point. Returns normalized places with a name and coordinates. */
export async function search(q, { near, limit = 6 } = {}) {
  const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ""}|${limit}`;
  return cache.wrap(key, DAY, async () => {
    const u = new URL(BASE);
    u.searchParams.set("q", q);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("lang", "en");
    if (near) { u.searchParams.set("lat", String(near.lat)); u.searchParams.set("lon", String(near.lon)); }
    const { status, data } = await fetchJson(u.toString());
    if (status !== 200 || !Array.isArray(data?.features)) return [];
    return data.features.map(normalize).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  });
}
