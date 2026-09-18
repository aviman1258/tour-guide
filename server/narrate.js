// POST /api/prepare-drive: build the DrivePackage — route with turn steps, drive-by
// candidates along the way, and Claude-written narration for stops + drive-bys.

import { httpError } from "./lib/http.js";
import { routeFor } from "./schedule.js";
import * as wikipedia from "./wikipedia.js";
import * as claude from "./claude.js";
import { findDriveBys, SAMPLE_STEP_M } from "./lib/wikiGeo.js";
import { lineToPoints, cumulative, project, sampleAlong } from "../web/js/routeMath.js";

const STOP_RADIUS = { neighborhood: 600, district: 600, shopping: 400, park: 350 };
const DEFAULT_STOP_RADIUS = 250;
const DRIVEBY_RADIUS = 300;
const WORDS = { stop: [60, 200], driveby: [25, 110] };

export async function prepareDrive(itinerary) {
  const t0 = Date.now();
  const log = (m) => console.log(`[prepare-drive] ${m}`);
  const { start, end, stops = [] } = itinerary;
  if (!start || !end) throw httpError(400, "itinerary needs start and end");
  if (!stops.length) throw httpError(400, "add at least one stop before preparing the drive");

  // 1. route with turn-by-turn steps
  let route = itinerary.route;
  if (!route?.geometry || !route.legs?.[0]?.steps) {
    route = await routeFor(itinerary);
  }
  const points = lineToPoints(route.geometry);
  const cum = cumulative(points);
  const total = cum[cum.length - 1];

  // 2. where each stop sits along the polyline → leg boundaries
  const stopAlong = stops.map((s) => project(points, cum, s).progressM);
  const boundaries = [0, ...stopAlong, total];

  // 3. drive-by candidates
  const samples = sampleAlong(points, cum, SAMPLE_STEP_M);
  const { candidatesByLeg, stats } = await findDriveBys({ samples, points, cum, boundaries, stops, interests: itinerary.interests, log });

  // 4. fuller text for each stop (REST summary extract; blurb as fallback)
  const stopExtracts = await Promise.all(stops.map(async (s) => {
    if (s.wikipediaTitle) {
      try { const sum = await wikipedia.summary(s.wikipediaTitle); if (sum?.extract) return sum.extract; } catch { /* fall through */ }
    }
    return s.blurb || s.whyItMatches || s.name;
  }));

  // 5. Claude writes everything in one call
  const legs = [];
  for (let i = 0; i < stops.length + 1; i++) {
    const from = i === 0 ? start.label : stops[i - 1].name;
    const to = i === stops.length ? end.label : stops[i].name;
    const lengthM = boundaries[i + 1] - boundaries[i];
    const candidates = candidatesByLeg.get(i) || [];
    if (lengthM < 3000) continue; // quiet: too short for a drive-by
    legs.push({ legIndex: i, from, to, lengthM, candidates });
  }
  const scripts = await claude.writeNarration({
    interests: itinerary.interests,
    stops: stops.map((s, i) => ({ id: s.id, name: s.name, category: s.category, whyItMatches: s.whyItMatches, dwellMinutes: s.dwellMinutes, extract: stopExtracts[i] })),
    legs,
  });
  log(`claude returned ${scripts.length} scripts`);

  // 6. validate + assemble narration items
  const candidateById = new Map();
  for (const list of candidatesByLeg.values()) for (const c of list) candidateById.set(String(c.pageid), c);
  const narration = [];
  const seen = new Set();
  const perLeg = new Map();
  for (const sc of scripts) {
    const text = tidy(sc.text);
    const words = text.split(/\s+/).filter(Boolean).length;
    const [min, max] = WORDS[sc.kind] || WORDS.driveby;
    if (words < min) continue;
    const finalText = words > max ? clampWords(text, max) : text;

    if (sc.kind === "stop") {
      const s = stops.find((x) => x.id === sc.targetId);
      if (!s || seen.has(`stop:${s.id}`)) continue;
      seen.add(`stop:${s.id}`);
      narration.push({
        id: `n_${s.id}`, kind: "stop", targetId: s.id, title: s.name, text: finalText,
        lat: s.lat, lon: s.lon, radiusM: STOP_RADIUS[s.category] || DEFAULT_STOP_RADIUS,
        alongM: stopAlong[stops.indexOf(s)], legIndex: stops.indexOf(s), wikipediaUrl: s.wikipediaUrl || null,
        factsUsed: sc.factsUsed || [],
      });
    } else {
      const c = candidateById.get(String(sc.targetId));
      if (!c || seen.has(`db:${c.pageid}`)) continue;
      const n = perLeg.get(c.legIndex) || 0;
      if (n >= 2) continue;
      perLeg.set(c.legIndex, n + 1);
      seen.add(`db:${c.pageid}`);
      narration.push({
        id: `n_p${c.pageid}`, kind: "driveby", pageid: c.pageid, title: c.title, text: finalText,
        lat: c.lat, lon: c.lon, radiusM: DRIVEBY_RADIUS, alongM: c.alongM, legIndex: c.legIndex,
        wikipediaUrl: `https://en.wikipedia.org/?curid=${c.pageid}`, factsUsed: sc.factsUsed || [],
      });
    }
  }

  // 7. any stop Claude skipped gets a plain fallback so it's never silent
  for (const [i, s] of stops.entries()) {
    if (seen.has(`stop:${s.id}`)) continue;
    const text = tidy(`We're arriving at ${s.name}. ${stopExtracts[i]}`);
    narration.push({
      id: `n_${s.id}`, kind: "stop", targetId: s.id, title: s.name, text: clampWords(text, 150),
      lat: s.lat, lon: s.lon, radiusM: STOP_RADIUS[s.category] || DEFAULT_STOP_RADIUS,
      alongM: stopAlong[i], legIndex: i, wikipediaUrl: s.wikipediaUrl || null, factsUsed: [], fallback: true,
    });
  }
  narration.sort((a, b) => a.alongM - b.alongM);

  const drivebys = narration.filter((n) => n.kind === "driveby").length;
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s: ${narration.length - drivebys} stop scripts, ${drivebys} drive-bys`);

  return {
    version: 1,
    preparedAt: new Date().toISOString(),
    itinerary: { ...itinerary, route },
    narration,
    stats: { ...stats, scripts: scripts.length, seconds: Math.round((Date.now() - t0) / 1000) },
  };
}

/** TTS-friendly cleanup: strip markup, parentheses, URLs, collapse whitespace. */
function tidy(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;!?])/g, "$1")
    .trim();
}

function clampWords(text, max) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let out = "";
  for (const s of sentences) {
    if ((out + s).split(/\s+/).filter(Boolean).length > max) break;
    out += s;
  }
  return out.trim() || text.split(/\s+/).slice(0, max).join(" ") + ".";
}
