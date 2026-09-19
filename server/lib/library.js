// Shared route library: published drive packages that free-tier visitors can search and use.
// SQLite via Node's built-in module, stored on the persistent disk next to timings.json.

import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { httpError } from "./http.js";
import { haversineM } from "./geo.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");

let db = null;
function open() {
  if (db) return db;
  fs.mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      start_label TEXT NOT NULL,
      end_label TEXT NOT NULL,
      start_lat REAL NOT NULL, start_lon REAL NOT NULL,
      end_lat REAL NOT NULL, end_lon REAL NOT NULL,
      interests TEXT NOT NULL DEFAULT '',
      stop_names TEXT NOT NULL DEFAULT '',
      stops_count INTEGER NOT NULL,
      miles REAL NOT NULL,
      minutes INTEGER NOT NULL,
      narration_count INTEGER NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      package_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS routes_start ON routes(start_lat, start_lon);
    CREATE INDEX IF NOT EXISTS routes_created ON routes(created_at);
  `);
  return db;
}

// "27 Larkmead", "1150 Brand Ln", "Current location (…)" → not a publishable label
const ADDRESS_RE = /^\s*\d{1,6}[a-z]?\s+\S|\bcurrent location\b|\b(apt|suite|unit|#)\s*\d/i;
export function looksLikeAddress(label) {
  return ADDRESS_RE.test(String(label || ""));
}

function summarize(row) {
  return {
    id: row.id, title: row.title, description: row.description, region: row.region,
    startLabel: row.start_label, endLabel: row.end_label,
    start: { lat: row.start_lat, lon: row.start_lon }, end: { lat: row.end_lat, lon: row.end_lon },
    interests: row.interests, stopNames: row.stop_names.split(" · ").filter(Boolean),
    stopsCount: row.stops_count, miles: row.miles, minutes: row.minutes, narrationCount: row.narration_count,
    createdAt: row.created_at, uses: row.uses,
  };
}

/**
 * Publish a drive package. Validates labels (no street addresses), strips per-device state.
 * Returns the summary of the stored route.
 */
export function publish({ pkg, title, description = "", region = "", author = "" }) {
  const it = pkg?.itinerary;
  if (!it?.start || !it?.end || !Array.isArray(it.stops) || !it.stops.length) throw httpError(400, "package needs an itinerary with stops");
  if (!Array.isArray(pkg.narration) || !pkg.narration.length) throw httpError(400, "package has no narration; prepare the drive first");
  if (!it.route?.geometry) throw httpError(400, "package has no route");
  const t = String(title || "").trim();
  if (t.length < 4 || t.length > 80) throw httpError(400, "title must be 4-80 characters");
  for (const [what, label] of [["start", it.start.label], ["end", it.end.label]]) {
    if (looksLikeAddress(label)) throw httpError(400, `The ${what} label "${label}" looks like a street address. Rename it to a place (e.g. an airport, hotel or neighborhood) before publishing.`);
  }

  const clean = {
    version: 1,
    preparedAt: pkg.preparedAt || new Date().toISOString(),
    itinerary: { ...it, planning: null },
    narration: pkg.narration,
    stats: pkg.stats || {},
  };
  const id = "r_" + randomUUID().slice(0, 8);
  const row = {
    id, title: t, description: String(description || "").trim().slice(0, 500), region: String(region || "").slice(0, 120),
    start_label: it.start.label, end_label: it.end.label,
    start_lat: it.start.lat, start_lon: it.start.lon, end_lat: it.end.lat, end_lon: it.end.lon,
    interests: String(it.interests || "").slice(0, 200),
    stop_names: it.stops.map((s) => s.name).join(" · "),
    stops_count: it.stops.length,
    miles: Math.round(((it.route.totalM || 0) / 1609.344) * 10) / 10,
    minutes: Math.round((it.route.totalSec || 0) / 60),
    narration_count: pkg.narration.length,
    author, created_at: new Date().toISOString(), uses: 0,
    package_json: JSON.stringify(clean),
  };
  open().prepare(`INSERT INTO routes (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((k) => "@" + k).join(",")})`).run(row);
  return summarize(row);
}

/**
 * Search. `near` = {lat, lon} keeps routes whose start OR end is within `radiusKm`;
 * `q` matches title / description / region / interests / stop names. Newest + most used first.
 */
export function search({ near, radiusKm = 50, q = "", limit = 20 } = {}) {
  const d = open();
  let rows;
  if (near) {
    const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos((near.lat * Math.PI) / 180) || 1);
    rows = d.prepare(`SELECT * FROM routes WHERE (start_lat BETWEEN ? AND ? AND start_lon BETWEEN ? AND ?) OR (end_lat BETWEEN ? AND ? AND end_lon BETWEEN ? AND ?)`)
      .all(near.lat - dLat, near.lat + dLat, near.lon - dLon, near.lon + dLon, near.lat - dLat, near.lat + dLat, near.lon - dLon, near.lon + dLon)
      .filter((r) => Math.min(haversineM(near, { lat: r.start_lat, lon: r.start_lon }), haversineM(near, { lat: r.end_lat, lon: r.end_lon })) <= radiusKm * 1000);
  } else {
    rows = d.prepare(`SELECT * FROM routes ORDER BY created_at DESC LIMIT 500`).all();
  }
  const words = String(q || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (words.length) {
    rows = rows.filter((r) => {
      const hay = `${r.title} ${r.description} ${r.region} ${r.interests} ${r.stop_names} ${r.start_label} ${r.end_label}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  rows.sort((a, b) => b.uses - a.uses || (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0));
  return rows.slice(0, Math.min(50, limit)).map(summarize);
}

export function get(id, { countUse = false } = {}) {
  const d = open();
  const row = d.prepare(`SELECT * FROM routes WHERE id = ?`).get(id);
  if (!row) throw httpError(404, "route not found");
  if (countUse) d.prepare(`UPDATE routes SET uses = uses + 1 WHERE id = ?`).run(id);
  return { summary: summarize(row), package: JSON.parse(row.package_json) };
}

export function remove(id) {
  const r = open().prepare(`DELETE FROM routes WHERE id = ?`).run(id);
  if (!r.changes) throw httpError(404, "route not found");
}

export function count() {
  return open().prepare(`SELECT COUNT(*) c FROM routes`).get().c;
}
