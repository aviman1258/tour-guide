// Ground Claude's candidates: Wikipedia summary → title search → coordinates → Nominatim → drop.

import { config } from "./config.js";
import { mapLimit, sleep } from "./lib/http.js";
import { haversineM, bboxCenter } from "./lib/geo.js";
import * as wikipedia from "./wikipedia.js";
import * as nominatim from "./nominatim.js";
import { stopFromSummary, stopFromNominatim, stopFromPlace, titleSimilarity } from "./stops.js";
import * as photon from "./photon.js";
import * as places from "./places.js";

async function findSummary(c) {
  let sum = c.wikipediaTitle ? await wikipedia.summary(c.wikipediaTitle) : null;
  if (!sum) {
    const hits = await wikipedia.search(`${c.name} ${c.approxArea || ""}`.trim(), 3);
    for (const h of hits) {
      if (titleSimilarity(c.name, h.title) < 0.34) continue;
      sum = await wikipedia.summary(h.title);
      if (sum) break;
    }
  }
  if (sum && !sum.coordinates) {
    const batch = await wikipedia.coordinatesBatch([sum.title]);
    const hit = batch.get(sum.title.toLowerCase());
    if (hit?.coordinates) sum = { ...sum, coordinates: hit.coordinates, thumbnail: sum.thumbnail || hit.thumbnail };
  }
  return sum;
}

const US_STATES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming";
const CITY_RE = new RegExp(`\\b(?:in|of|near|at) ([A-Z][\\w.'-]+(?: [A-Z][\\w.'-]+){0,2}), (${US_STATES})\\b`);

/** "… in Stafford, Texas …" → "Stafford, Texas". Null when no such phrase. */
export function cityFromText(text) {
  const m = CITY_RE.exec(String(text || ""));
  return m ? `${m[1]}, ${m[2]}` : null;
}

/**
 * Resolve candidates (Claude tool output items) into Stops.
 * Returns { stops, dropped:[{name, reason}] } preserving candidate order.
 */
export async function resolveCandidates(candidates, corridor, { onResult } = {}) {
  const center = bboxCenter(corridor);
  const seen = new Set();

  const resolved = await mapLimit(candidates, config.wikiConcurrency, async (c) => {
    const r = await resolveWithRetry(c);
    try { onResult?.(r); } catch { /* a listener must never break grounding */ }
    return r;
  });

  async function resolveWithRetry(c) {
    const extra = {
      name: c.name, category: c.category, whyItMatches: c.whyItMatches, dwellMinutes: c.dwellMinutes,
      priority: c.priority, isFoodOption: c.isFoodOption, approxArea: c.approxArea,
    };
    // one retry after a pause when Wikipedia rate-limits us; never call that "not found"
    for (let attempt = 0; ; attempt++) {
      try {
        return await resolveOne(c, extra, corridor);
      } catch (err) {
        const busy = err.status === 503 || err.status === 429;
        if (busy && attempt === 0) {
          console.warn(`[resolve] ${c.name}: ${err.message}; retrying in ${config.wikiRetryDelayMs} ms`);
          await sleep(config.wikiRetryDelayMs);
          continue;
        }
        console.warn(`[resolve] ${c.name}: ${err.message}`);
        return { drop: { name: c.name, reason: busy ? "lookup_failed" : "not_found" }, c };
      }
    }
  }

  const stops = [], dropped = [];
  for (const r of resolved) {
    if (r.drop) { dropped.push(r.drop); continue; }
    const s = r.stop;
    const key = (s.wikipediaTitle || s.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (haversineM(s, center) > config.maxCorridorKm * 1000) {
      dropped.push({ name: s.name, reason: "too_far" });
      continue;
    }
    stops.push(s);
  }
  return { stops, dropped };
}

/** Wikipedia (with coords) → Nominatim by hint → Nominatim by the article's own city → not_found. */
async function resolveOne(c, extra, corridor) {
  const sum = await findSummary(c);
  if (sum?.coordinates) return { stop: stopFromSummary(sum, extra), c };

  let hits = await nominatim.search(c.searchHint || `${c.name} ${c.approxArea || ""}`, { viewbox: corridor, limit: 1 });
  if (!hits[0] && sum) {
    // Article exists but has no coordinates and the hint missed (often the metro name
    // instead of the real suburb). Use the city the article itself names.
    const place = cityFromText(`${sum.description}. ${sum.extract}`);
    if (place) hits = await nominatim.search(`${sum.title}, ${place}`, { viewbox: corridor, limit: 1 });
    if (!hits[0] && place) hits = await nominatim.search(`${c.name}, ${place}`, { viewbox: corridor, limit: 1 });
  }
  if (hits[0]) {
    // Location from Nominatim; keep the article's text and link when we have one.
    const fromArticle = sum ? { blurb: sum.extract, thumbnail: sum.thumbnail, wikipediaTitle: sum.title, wikipediaUrl: sum.url } : {};
    return { stop: stopFromNominatim(hits[0], { ...extra, ...fromArticle }), c };
  }
  // Small local places (a neighbourhood temple, a bakery) often have no article and Nominatim's
  // free-text search misses them: try Photon (OSM points of interest), then Google Places if configured.
  const center = bboxCenter(corridor);
  const query = c.searchHint || `${c.name} ${c.approxArea || ""}`.trim();
  const nearEnough = (p) => haversineM(p, center) <= config.maxCorridorKm * 1000;
  const ph = (await photon.search(query, { near: center, limit: 3 }).catch(() => [])).filter((p) => nearEnough(p) && titleSimilarity(c.name, p.name) >= 0.5);
  if (ph[0]) return { stop: await stopFromPlace({ ...ph[0], source: "photon" }).then((s) => ({ ...s, ...extraText(extra, sum), category: extra.category || s.category })), c };
  if (places.enabled()) {
    const g = (await places.searchText(query, { near: center, radiusM: config.maxCorridorKm * 1000, limit: 3 })).filter((p) => nearEnough(p) && titleSimilarity(c.name, p.name) >= 0.5);
    if (g[0]) return { stop: await stopFromPlace({ ...g[0], sub: g[0].address, source: "google" }).then((s) => ({ ...s, ...extraText(extra, sum), category: extra.category || s.category })), c };
  }
  return { drop: { name: c.name, reason: "not_found" }, c };
}

/** Claude's own words for the stop win over a bare place record; an article's text wins over both. */
function extraText(extra, sum) {
  const out = { whyItMatches: extra.whyItMatches, dwellMinutes: extra.dwellMinutes, priority: extra.priority, isFoodOption: extra.isFoodOption };
  if (sum) Object.assign(out, { blurb: sum.extract, thumbnail: sum.thumbnail, wikipediaTitle: sum.title, wikipediaUrl: sum.url });
  return out;
}
