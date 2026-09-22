// Find interesting Wikipedia articles along a route: a few large geosearches along the
// polyline (serial, to stay under Wikimedia's anonymous rate limit), exact distance-to-route
// filtering, dedupe, prefilter, extracts, scoring. All I/O goes through wikipedia.js.

import * as wikipedia from "../wikipedia.js";
import { mapLimit } from "./http.js";
import { haversineM } from "./geo.js";
import { project } from "../../web/js/routeMath.js";

// 5 km circles every 6 km overlap generously (guaranteed half-width = 4 km), so a 90 km
// route is ~15 requests instead of ~110. The real corridor test is exact distance to the polyline.
// Wikimedia rate-limits anonymous API traffic per IP (shared office egress trips it easily),
// so calls are serial, spaced out, and retried when the API says it's busy.
export const SAMPLE_STEP_M = 6000;
export const SEARCH_RADIUS_M = 5000;
export const CALL_GAP_MS = 700;
export const BUSY_RETRIES = 3;
export const BUSY_WAIT_MS = 12000;
export const CORRIDOR_M = 300;         // "within ~300 m of the road"
export const NEAR_STOP_M = 300;
export const MIN_ARTICLE_BYTES = 3000;
export const MIN_EXTRACT_CHARS = 200;
export const PER_LEG_CAP = 8;
export const MIN_GAP_M = 1500;

const EXCLUDED_TYPES = new Set(["adm1st", "adm2nd", "adm3rd", "adm4th", "satellite", "camera", "country"]);
const TYPE_WEIGHT = { landmark: 2, event: 1.5, waterbody: 1, river: 1, airport: 0.5, railwaystation: 0.5, city: 0.8, edu: 0.3, isle: 1, mountain: 1, forest: 0.8, pass: 0.5 };
const BORING = /^(List of|Category:|.*\b(Independent School District|Elementary School|Middle School|High School|Intermediate School|Charter School|Hospital|Medical Center|Traffic Control Center|Post Office)\b.*|.*\b(FM|SH|Farm to Market Road|Texas State Highway|Interstate|U\.S\. Route|Loop) \d+.*)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** geosearch with retries when Wikipedia reports it's busy (429/5xx surface as thrown 503s). */
async function geosearchPatient(s, log) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await wikipedia.geosearch(s.lat, s.lon, SEARCH_RADIUS_M, 500);
    } catch (err) {
      if (err.status !== 503 || attempt >= BUSY_RETRIES) throw err;
      log(`geosearch busy at ${Math.round(s.alongM / 1000)} km; waiting ${BUSY_WAIT_MS / 1000} s (attempt ${attempt + 1}/${BUSY_RETRIES})`);
      await sleep(BUSY_WAIT_MS);
    }
  }
}

/**
 * @param samples    [{lat, lon, alongM}] points along the route (SAMPLE_STEP_M apart)
 * @param points,cum route polyline + cumulative distances (for exact corridor test)
 * @param boundaries alongM values where legs change: [0, stop1, ..., total]
 * @param stops      planned stops [{lat, lon, wikipediaTitle, name}]
 * @param interests  free text
 * @returns { candidatesByLeg: Map<legIndex, [{pageid,title,type,lat,lon,alongM,alongLegM,extract,score}]>, stats }
 */
export async function findDriveBys({ samples, points, cum, boundaries, stops, interests, minGapByLeg = null, log = () => {}, onProgress = () => {}, signal }) {
  // 1. geosearch each sample, strictly one at a time
  const raw = new Map(); // pageid → hit
  let failures = 0;
  let done = 0;
  await mapLimit(samples, 1, async (s, i) => {
    if (signal?.aborted) return;
    if (i > 0) await sleep(CALL_GAP_MS);
    try {
      const hits = await geosearchPatient(s, log);
      if (!hits.length) failures++;
      for (const h of hits) if (!raw.has(h.pageid)) raw.set(h.pageid, h);
    } catch (err) {
      failures++;
      log(`geosearch failed at ${Math.round(s.alongM / 1000)} km: ${err.message}`);
    }
    onProgress({ stage: "geosearch", done: ++done, total: samples.length, found: raw.size });
  });
  if (signal?.aborted) return { candidatesByLeg: new Map(), stats: { cancelled: true } };
  log(`geosearch: ${samples.length} calls (${failures} empty/failed) → ${raw.size} unique articles`);

  // 2. exact corridor test + cheap prefilter
  const stopTitles = new Set(stops.map((s) => (s.wikipediaTitle || "").toLowerCase()).filter(Boolean));
  const pre = [];
  for (const h of raw.values()) {
    if (EXCLUDED_TYPES.has(h.type) || BORING.test(h.title)) continue;
    if (stopTitles.has(h.title.toLowerCase())) continue;
    if (stops.some((s) => haversineM(s, h) < NEAR_STOP_M)) continue;
    const p = project(points, cum, h);
    if (p.offRouteM > CORRIDOR_M) continue;
    pre.push({ ...h, alongM: p.progressM, offRouteM: Math.round(p.offRouteM) });
  }
  log(`corridor + prefilter: ${pre.length} within ${CORRIDOR_M} m of the road`);

  // 3. quality fetch, 20 pages per call, patient about "busy" replies
  const byId = new Map();
  for (let i = 0; i < pre.length; i += 20) {
    if (signal?.aborted) break;
    if (i > 0) await sleep(CALL_GAP_MS);
    onProgress({ stage: "extracts", done: i, total: pre.length, found: raw.size });
    const chunk = pre.slice(i, i + 20).map((h) => h.pageid);
    for (let attempt = 0; ; attempt++) {
      try {
        for (const e of await wikipedia.extractsBatch(chunk)) byId.set(e.pageid, e);
        break;
      } catch (err) {
        if (err.status !== 503 || attempt >= BUSY_RETRIES) { log(`extracts failed for ${chunk.length} pages: ${err.message}`); break; }
        log(`extracts busy; waiting ${BUSY_WAIT_MS / 1000} s (attempt ${attempt + 1}/${BUSY_RETRIES})`);
        await sleep(BUSY_WAIT_MS);
      }
    }
  }
  const interestWords = tokens(interests);
  const scored = [];
  for (const h of pre) {
    const e = byId.get(h.pageid);
    if (!e || e.isDisambiguation) continue;
    if (e.length < MIN_ARTICLE_BYTES || e.extract.length < MIN_EXTRACT_CHARS) continue;
    const text = `${h.title} ${e.extract}`.toLowerCase();
    let hits = 0;
    for (const w of interestWords) if (text.includes(w)) hits++;
    const score = Math.log10(1 + e.pageviews) + (TYPE_WEIGHT[h.type] || 0.6) + hits * 1.5 + Math.min(e.extract.length / 400, 1.5) - h.offRouteM / 600;
    scored.push({ pageid: h.pageid, title: h.title, type: h.type, lat: h.lat, lon: h.lon, alongM: h.alongM, offRouteM: h.offRouteM, extract: e.extract, pageviews: e.pageviews, score });
  }
  log(`quality: ${scored.length} candidates`);

  // 4. bucket by leg, keep the best few, spread out
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
    const gap = minGapByLeg?.[leg] ?? MIN_GAP_M; // dense city legs allow closer stories than a highway
    candidatesByLeg.set(leg, spreadOut(list, gap).slice(0, PER_LEG_CAP).sort((a, b) => a.alongM - b.alongM));
  }
  return { candidatesByLeg, stats: { samples: samples.length, geosearchEmpty: failures, raw: raw.size, corridor: pre.length, scored: scored.length } };
}

/** Keep best-scored items but never two within `minGapM` of each other along the route. */
function spreadOut(sortedByScore, minGapM) {
  const kept = [];
  for (const c of sortedByScore) {
    if (kept.every((k) => Math.abs(k.alongM - c.alongM) >= minGapM)) kept.push(c);
  }
  return kept;
}

const STOP = new Set(["the", "and", "of", "in", "stuff", "things", "places", "like", "some", "with", "a", "an", "to", "for", "upper"]);
function tokens(s) {
  return [...new Set(String(s || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}
