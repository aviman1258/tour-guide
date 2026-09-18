// Ground Claude's candidates: Wikipedia summary → title search → coordinates → Nominatim → drop.

import { config } from "./config.js";
import { mapLimit } from "./lib/http.js";
import { haversineM, bboxCenter } from "./lib/geo.js";
import * as wikipedia from "./wikipedia.js";
import * as nominatim from "./nominatim.js";
import { stopFromSummary, stopFromNominatim, titleSimilarity } from "./stops.js";

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
export async function resolveCandidates(candidates, corridor) {
  const center = bboxCenter(corridor);
  const seen = new Set();

  const resolved = await mapLimit(candidates, config.wikiConcurrency, async (c) => {
    const extra = {
      name: c.name, category: c.category, whyItMatches: c.whyItMatches, dwellMinutes: c.dwellMinutes,
      priority: c.priority, isFoodOption: c.isFoodOption, approxArea: c.approxArea,
    };
    try {
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
        // Article exists but has no coordinates: take the location from Nominatim, keep the article.
        const fromArticle = sum ? { blurb: sum.extract, thumbnail: sum.thumbnail, wikipediaTitle: sum.title, wikipediaUrl: sum.url } : {};
        return { stop: stopFromNominatim(hits[0], { ...extra, ...fromArticle }), c };
      }
      return { drop: { name: c.name, reason: "not_found" }, c };
    } catch (err) {
      console.warn(`[resolve] ${c.name}: ${err.message}`);
      return { drop: { name: c.name, reason: "not_found" }, c };
    }
  });

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
