// Research a stop before narrating it: Wikipedia extract (as before) + the place's own website
// + web-searched facts when the material is thin. Everything is labelled by source so the
// narration writer can only use what's here, and the result is cached for 30 days so re-preps
// and other travellers don't pay twice.
//
//   forStop(stop, { interests, region, deps }) → { extract, sources:[{kind,url}], thin, from:[...] }

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");
export const TTL_MS = 30 * 86400_000;
const THIN_CHARS = 700;   // less than this from Wikipedia + website → go looking on the web
const WEB_CHARS = 1500;   // how much of a website we keep
const MAX_CHARS = 3200;   // total handed to the narration writer per stop

let db = null;
function open(file = FILE) {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS research (key TEXT PRIMARY KEY, json TEXT NOT NULL, at TEXT NOT NULL)`);
  return db;
}
export function _useMemoryDb() { db = null; open(":memory:"); }

export const keyFor = (s) => (s.wikipediaTitle ? `w:${s.wikipediaTitle.toLowerCase()}` : `p:${String(s.name).toLowerCase()}@${Number(s.lat).toFixed(3)},${Number(s.lon).toFixed(3)}`);

const clip = (t, n) => (String(t || "").length > n ? String(t).slice(0, n).replace(/\s+\S*$/, "") + "…" : String(t || ""));

/**
 * deps (all optional, injected for tests):
 *   wikiSummary(title) → {extract, url, wikibaseItem}
 *   officialSite(wikibaseItem) → url | null
 *   fetchPage(url) → {url, title, description, text} | null
 *   webFacts({name, area, interests}) → [{fact, source}]
 */
export async function forStop(stop, { interests = "", region = "", deps = {}, now = () => Date.now() } = {}) {
  const key = keyFor(stop);
  const d = open();
  const cached = d.prepare(`SELECT json, at FROM research WHERE key = ?`).get(key);
  if (cached && now() - Date.parse(cached.at) < TTL_MS) return { ...JSON.parse(cached.json), cached: true };

  const sources = [], parts = [], from = [];
  let chars = 0;

  // 1. Wikipedia
  let wiki = null;
  if (stop.wikipediaTitle && deps.wikiSummary) {
    try { wiki = await deps.wikiSummary(stop.wikipediaTitle); } catch { wiki = null; }
    if (wiki?.extract) {
      parts.push(`From Wikipedia (${wiki.url || stop.wikipediaUrl || "en.wikipedia.org"}):\n${clip(wiki.extract, 1600)}`);
      sources.push({ kind: "wikipedia", url: wiki.url || stop.wikipediaUrl || null });
      from.push("wikipedia"); chars += Math.min(wiki.extract.length, 1600);
    }
  } else if (stop.blurb && stop.source === "wikipedia") {
    parts.push(`From Wikipedia:\n${clip(stop.blurb, 600)}`); chars += Math.min(stop.blurb.length, 600); from.push("wikipedia");
  }

  // 2. the place's own website: from the stop (Google / OSM) or Wikidata's "official website"
  let site = stop.website || null;
  if (!site && wiki?.wikibaseItem && deps.officialSite) {
    try { site = await deps.officialSite(wiki.wikibaseItem); } catch { site = null; }
  }
  if (site && deps.fetchPage) {
    const page = await deps.fetchPage(site);
    const body = [page?.description, page?.text].filter(Boolean).join("\n");
    if (body.length >= 80) {
      parts.push(`From the place's own website (${page.url || site}):\n${clip(body, WEB_CHARS)}`);
      sources.push({ kind: "website", url: page.url || site });
      from.push("website"); chars += Math.min(body.length, WEB_CHARS);
    }
  }

  // 3. the web, when what we have is thin, or when there is no Wikipedia article at all: a place's
  //    own site says what it wants to say; a second, independent source keeps the guide honest
  const thin = chars < THIN_CHARS || !from.includes("wikipedia");
  if (thin && deps.webFacts) {
    let facts = [];
    try { facts = (await deps.webFacts({ name: stop.name, area: stop.approxArea || region, interests })) || []; } catch { facts = []; }
    facts = facts.filter((f) => f?.fact && f.fact.length > 15).slice(0, 8);
    if (facts.length) {
      parts.push(`From the web (each fact with its source):\n${facts.map((f) => `- ${clip(f.fact, 220)}${f.source ? ` (${f.source})` : ""}`).join("\n")}`);
      for (const f of facts) if (f.source && !sources.some((s) => s.url === f.source)) sources.push({ kind: "web", url: f.source });
      from.push("web"); chars += facts.reduce((a, f) => a + f.fact.length, 0);
    }
  }

  if (!parts.length) parts.push(clip(stop.blurb || stop.whyItMatches || `${stop.name}, ${stop.approxArea || region || "a stop on the route"}.`, 400));
  const extract = clip(parts.join("\n\n"), MAX_CHARS);
  const result = { extract, sources, thin, from, at: new Date(now()).toISOString() };
  d.prepare(`INSERT OR REPLACE INTO research (key, json, at) VALUES (?, ?, ?)`).run(key, JSON.stringify(result), result.at);
  return result;
}
