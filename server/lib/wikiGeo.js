// Find interesting Wikipedia articles along a route: sample the polyline, geosearch
// each sample, dedupe, prefilter, fetch extracts, score. Pure-ish (all I/O via wikipedia.js).

import * as wikipedia from "../wikipedia.js";
import { mapLimit } from "./http.js";
import { haversineM } from "./geo.js";

export const SAMPLE_STEP_M = 800;
export const SEARCH_RADIUS_M = 500;   // 500 m circles at 800 m spacing → guaranteed 300 m corridor
export const NEAR_STOP_M = 300;
export const MIN_ARTICLE_BYTES = 3000;
export const MIN_EXTRACT_CHARS = 200;
export const PER_LEG_CAP = 8;

const EXCLUDED_TYPES = new Set(["adm1st", "adm2nd", "adm3rd", "satellite", "camera", "country", "adm4th"]);
const TYPE_WEIGHT = { landmark: 2, event: 1.5, waterbody: 1, river: 1, airport: 0.5, railwaystation: 0.5, city: 0.8, edu: 0.3, isle: 1, mountain: 1, forest: 0.8, glacier: 0.5, pass: 0.5 };
const BORING = /^(List of|Category:|.*\b(Independent School District|Elementary School|Middle School|High School)\b.*|.*\b(FM|SH|Farm to Market Road|Texas State Highway|Interstate) \d+.*)$/i;

/**
 * @param samples [{lat, lon, alongM}] points along the route
 * @param boundaries alongM values where legs change: [0, stop1, stop2, ..., total]
 * @param stops planned stops [{lat, lon, wikipediaTitle, name}]
 * @param interests free text
 * @returns { candidatesByLeg: Map<legIndex, [{pageid,title,type,lat,lon,alongM,alongLegM,extract,score}]>, stats }
 */
export async function findDriveBys({ samples, boundaries, stops, interests, log = () => {} }) {
  // 1. geosearch every sample, 3 in flight
  const raw = new Map(); // pageid → hit
  const results = await mapLimit(samples, 3, async (s) => {
    try { return await wikipedia.geosearch(s.lat, s.lon, SEARCH_RADIUS_M, 50); } catch { return []; }
  });
  results.forEach((hits, i) => {
    for (const h of hits) {
      const prev = raw.get(h.pageid);
      if (!prev || h.dist < prev.dist) raw.set(h.pageid, { ...h, alongM: samples[i].alongM });
    }
  });
  log(`geosearch: ${samples.length} samples → ${raw.size} unique articles`);

  // 2. cheap prefilter
  const stopTitles = new Set(stops.map((s) => (s.wikipediaTitle || "").toLowerCase()).filter(Boolean));
  const pre = [...raw.values()].filter((h) => {
    if (EXCLUDED_TYPES.has(h.type)) return false;
    if (BORING.test(h.title)) return false;
    if (stopTitles.has(h.title.toLowerCase())) return false;
    if (stops.some((s) => haversineM(s, h) < NEAR_STOP_M)) return false;
    return true;
  });
  log(`prefilter: ${pre.length} remain`);

  // 3. quality fetch
  const ex = await wikipedia.extractsBatch(pre.map((h) => h.pageid));
  const byId = new Map(ex.map((e) => [e.pageid, e]));
  const interestWords = tokens(interests);
  const scored = [];
  for (const h of pre) {
    const e = byId.get(h.pageid);
    if (!e || e.isDisambiguation) continue;
    if (e.length < MIN_ARTICLE_BYTES || e.extract.length < MIN_EXTRACT_CHARS) continue;
    const text = `${h.title} ${e.extract}`.toLowerCase();
    let hits = 0;
    for (const w of interestWords) if (text.includes(w)) hits++;
    const score = Math.log10(1 + e.pageviews) + (TYPE_WEIGHT[h.type] || 0.6) + hits * 1.5 + Math.min(e.extract.length / 400, 1.5);
    scored.push({ pageid: h.pageid, title: h.title, type: h.type, lat: h.lat, lon: h.lon, alongM: h.alongM, extract: e.extract, pageviews: e.pageviews, score });
  }
  log(`quality: ${scored.length} candidates`);

  // 4. bucket by leg, cap per leg
  const candidatesByLeg = new Map();
  for (const c of scored) {
    let leg = boundaries.findIndex((b, i) => i < boundaries.length - 1 && c.alongM >= b && c.alongM < boundaries[i + 1]);
    if (leg < 0) leg = boundaries.length - 2;
    c.legIndex = leg;
    c.alongLegM = c.alongM - boundaries[leg];
    if (!candidatesByLeg.has(leg)) candidatesByLeg.set(leg, []);
    candidatesByLeg.get(leg).push(c);
  }
  for (const [leg, list] of candidatesByLeg) {
    list.sort((a, b) => b.score - a.score);
    candidatesByLeg.set(leg, spreadOut(list.slice(0, PER_LEG_CAP * 2), 1500).slice(0, PER_LEG_CAP).sort((a, b) => a.alongM - b.alongM));
  }
  return { candidatesByLeg, stats: { samples: samples.length, raw: raw.size, prefiltered: pre.length, scored: scored.length } };
}

/** Keep the best-scored items but never two within `minGapM` of each other along the route. */
function spreadOut(sortedByScore, minGapM) {
  const kept = [];
  for (const c of sortedByScore) {
    if (kept.every((k) => Math.abs(k.alongM - c.alongM) >= minGapM)) kept.push(c);
  }
  return kept;
}

const STOP = new Set(["the", "and", "of", "in", "stuff", "things", "places", "like", "some", "with", "a", "an", "to", "for"]);
function tokens(s) {
  return [...new Set(String(s || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}
