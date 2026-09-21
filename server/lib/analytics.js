// Privacy-light usage analytics: who opened what, when, from roughly where.
// Stored: time, IP, coarse location (city/region/country from Cloudflare headers or a cached
// IP lookup), tier, device family, event kind + a short detail. No names, no form contents,
// no GPS from the phone. Events older than RETENTION_DAYS are purged.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");
const RETENTION_DAYS = 90;
const GEO_TTL_MS = 7 * 24 * 3600 * 1000;

let db = null;
function open() {
  if (db) return db;
  fs.mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      ip TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS events_ip ON events(ip);
    CREATE TABLE IF NOT EXISTS geo (
      ip TEXT PRIMARY KEY, city TEXT, region TEXT, country TEXT, lat REAL, lon REAL, looked_up TEXT
    );
  `);
  return db;
}

// ---------- device / browser from the User-Agent (family only) ----------

export function deviceOf(ua = "") {
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux";
  if (/bot|crawl|spider|curl|wget|python|node|Go-http|HeadlessChrome/i.test(ua)) return "bot/script";
  return "other";
}
export function browserOf(ua = "") {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung";
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return "Chrome";
  if (/CriOS/i.test(ua)) return "Chrome iOS";
  if (/Firefox|FxiOS/i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua)) return "Safari";
  return "other";
}

// ---------- location ----------

/** Cloudflare "Add visitor location headers" (managed transform) when the domain is proxied. */
function geoFromHeaders(req) {
  const city = req.get("cf-ipcity"), country = req.get("cf-ipcountry"), region = req.get("cf-region");
  if (!city && !country) return null;
  return { city: city || "", region: region || "", country: country || "", lat: Number(req.get("cf-iplatitude")) || null, lon: Number(req.get("cf-iplongitude")) || null };
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i;

/** Cached lookup (one call per IP per week) via ipwho.is when Cloudflare headers are absent. */
async function geoLookup(ip) {
  if (!ip || PRIVATE_IP.test(ip) || !config.geoLookup) return null;
  const d = open();
  const cached = d.prepare(`SELECT * FROM geo WHERE ip = ?`).get(ip);
  const usable = cached && (cached.city || cached.country); // empty rows came from failed lookups; retry those
  if (usable && Date.now() - Date.parse(cached.looked_up) < GEO_TTL_MS) return cached;
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,message,city,region,country_code,latitude,longitude`, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": config.userAgent, Accept: "application/json" } });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`ipwho.is ${r.status}: ${text.slice(0, 80)}`); }
    if (!j.success) throw new Error(`ipwho.is: ${j.message || "lookup failed"}`);
    const row = { ip, city: j.city || "", region: j.region || "", country: j.country_code || "", lat: j.latitude ?? null, lon: j.longitude ?? null, looked_up: new Date().toISOString() };
    d.prepare(`INSERT OR REPLACE INTO geo (ip, city, region, country, lat, lon, looked_up) VALUES (@ip, @city, @region, @country, @lat, @lon, @looked_up)`).run(row);
    return row;
  } catch (err) {
    state.lastError = `geo: ${err.message}`;
    return usable ? cached : null;
  }
}

// ---------- recording ----------

const state = { inserted: 0, geoFilled: 0, lastInsertAt: null, lastError: null };
export const stats = () => ({ ...state });

/**
 * Record an event for a request. The row is written immediately (no location yet); the
 * location is filled in afterwards from Cloudflare headers or the cached IP lookup.
 * Never throws; problems are kept in stats().lastError and logged.
 */
export function track(req, kind, detail = "", ms = null) {
  try {
    const ua = req.get("user-agent") || "";
    const fromHeaders = geoFromHeaders(req);
    const row = {
      ts: new Date().toISOString(), ip: req.ip || "",
      city: fromHeaders?.city || "", region: fromHeaders?.region || "", country: fromHeaders?.country || "",
      tier: req.tier || (req.query?.tier === "free" ? "free" : req.query?.tier === "subscriber" ? "subscriber" : ""),
      device: deviceOf(ua), browser: browserOf(ua), kind, detail: String(detail).slice(0, 200), ms: ms == null ? null : Math.round(ms),
    };
    const r = open().prepare(`INSERT INTO events (ts, ip, city, region, country, tier, device, browser, kind, detail, ms)
      VALUES (@ts, @ip, @city, @region, @country, @tier, @device, @browser, @kind, @detail, @ms)`).run(row);
    state.inserted++;
    state.lastInsertAt = row.ts;
    // Cloudflare always sends cf-ipcountry (Render's edge included); city/region only with the
    // "visitor location headers" transform on. Country alone is not enough: look the city up.
    if (fromHeaders?.city) return;
    const id = r.lastInsertRowid;
    geoLookup(row.ip)
      .then((g) => {
        if (!g || (!g.city && !g.country)) return;
        open().prepare(`UPDATE events SET city = ?, region = ?, country = ? WHERE id = ?`).run(g.city || "", g.region || "", g.country || "", id);
        state.geoFilled++;
      })
      .catch((err) => { state.lastError = `geo: ${err.message}`; });
  } catch (err) {
    state.lastError = `insert: ${err.message}`;
    console.warn("[analytics]", err.message);
  }
}

export function purge() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  return open().prepare(`DELETE FROM events WHERE ts < ?`).run(cutoff).changes;
}

// ---------- reporting (admin) ----------

export function summary(days = 30) {
  const d = open();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const one = (sql, ...p) => d.prepare(sql).get(...p);
  const all = (sql, ...p) => d.prepare(sql).all(...p);
  const count = (where = "", ...p) => one(`SELECT COUNT(*) c FROM events WHERE ts >= ? ${where}`, since, ...p).c;
  return {
    days, since,
    totals: {
      events: count(),
      pageViews: count(`AND kind = 'page'`),
      uniqueIps: one(`SELECT COUNT(DISTINCT ip) c FROM events WHERE ts >= ?`, since).c,
      plans: count(`AND kind = 'plan'`),
      prepares: count(`AND kind = 'prepare'`),
      routesPublished: count(`AND kind = 'publish'`),
      routesUsed: count(`AND kind = 'route_use'`),
      librarySearches: count(`AND kind = 'route_search'`),
      subscriberEvents: count(`AND tier = 'subscriber'`),
      freeEvents: count(`AND tier = 'free'`),
    },
    byDay: all(`SELECT substr(ts,1,10) day, COUNT(*) events, COUNT(DISTINCT ip) visitors, SUM(kind='page') views FROM events WHERE ts >= ? GROUP BY day ORDER BY day`, since),
    byPage: all(`SELECT detail page, COUNT(*) views, COUNT(DISTINCT ip) visitors FROM events WHERE ts >= ? AND kind = 'page' GROUP BY detail ORDER BY views DESC LIMIT 20`, since),
    byPlace: all(`SELECT country, region, city, COUNT(*) events, COUNT(DISTINCT ip) visitors FROM events WHERE ts >= ? GROUP BY country, region, city ORDER BY visitors DESC, events DESC LIMIT 30`, since),
    byDevice: all(`SELECT device, browser, COUNT(*) events, COUNT(DISTINCT ip) visitors FROM events WHERE ts >= ? GROUP BY device, browser ORDER BY visitors DESC LIMIT 20`, since),
    byKind: all(`SELECT kind, COUNT(*) events, AVG(ms) avgMs FROM events WHERE ts >= ? GROUP BY kind ORDER BY events DESC`, since),
    topVisitors: all(`SELECT ip, MAX(city) city, MAX(region) region, MAX(country) country, MAX(device) device, COUNT(*) events, MIN(ts) first, MAX(ts) last FROM events WHERE ts >= ? GROUP BY ip ORDER BY events DESC LIMIT 25`, since),
  };
}

export function recent(limit = 200) {
  return open().prepare(`SELECT ts, ip, city, region, country, tier, device, browser, kind, detail, ms FROM events ORDER BY id DESC LIMIT ?`).all(Math.min(1000, limit));
}
