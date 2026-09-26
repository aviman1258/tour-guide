// Accounts that are nothing but an email: sign in with a one-tap link, keep your routes on the
// server so they follow you to any device. We never store the address itself, only an HMAC of it
// (enough to find the account again when the same address is typed); the link goes to whatever
// address was just typed. Sessions are random tokens (hashed at rest) that live 180 days.
//
//   requestLink({email, ip})       → { token, accountId, isNew }   (caller emails the link)
//   consumeLink({token, device})   → { sessionToken, accountId, expiresAt }
//   sessionFor(sessionToken)       → { accountId } | null
//   listRoutes / getRoute / putRoute / deleteRoute  — the account's private route packages

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { httpError } from "./http.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");

export const LINK_TTL_MS = 20 * 60_000;
export const SESSION_TTL_MS = 180 * 86400_000;
export const MAX_ROUTES = 100;
export const MAX_PACKAGE_BYTES = 2_500_000;
const LINKS_PER_EMAIL = 3;          // per 15 minutes
const LINK_WINDOW_MS = 15 * 60_000;
const DELETED_KEEP_MS = 30 * 86400_000; // soft-deleted routes stay this long so other devices learn of the deletion

let db = null;
const recent = new Map(); // emailHash → [timestamps] of link requests

function open(file = FILE) {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_login_at TEXT);
    CREATE TABLE IF NOT EXISTS login_links (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, ip TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
    CREATE TABLE IF NOT EXISTS user_routes (
      account_id TEXT NOT NULL, trip_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', summary_json TEXT NOT NULL DEFAULT '{}',
      package_json TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY (account_id, trip_id)
    );
  `);
  return db;
}
export function _useMemoryDb() { db = null; open(":memory:"); recent.clear(); }

const iso = (ms) => new Date(ms).toISOString();
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,24}$/i.test(normalizeEmail(e));
/** One-way, keyed: the same address always maps to the same account, but the table can't be read back to addresses. */
export const emailHash = (email) => createHmac("sha256", `deodapper-accounts|${config.appSecret || "dev"}`).update(normalizeEmail(email)).digest("hex");

/** Find or create the account for this address and mint a single-use sign-in token. Throws 400 / 429. */
export function requestLink({ email, ip = "", now = Date.now() } = {}) {
  if (!validEmail(email)) throw httpError(400, "That doesn't look like an email address.");
  const h = emailHash(email);
  const times = (recent.get(h) || []).filter((t) => now - t < LINK_WINDOW_MS);
  if (times.length >= LINKS_PER_EMAIL) throw httpError(429, "A few links were sent already. Check your inbox and spam folder, or try again in 15 minutes.");
  times.push(now);
  recent.set(h, times);
  const d = open();
  let acct = d.prepare(`SELECT id FROM accounts WHERE email_hash = ?`).get(h);
  const isNew = !acct;
  if (!acct) {
    acct = { id: "a_" + randomBytes(6).toString("hex") };
    d.prepare(`INSERT INTO accounts (id, email_hash, created_at) VALUES (?, ?, ?)`).run(acct.id, h, iso(now));
  }
  const token = randomBytes(32).toString("base64url");
  d.prepare(`INSERT INTO login_links (token_hash, account_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)`).run(sha(token), acct.id, iso(now), iso(now + LINK_TTL_MS), String(ip || ""));
  return { token, accountId: acct.id, isNew };
}

/** Trade a link token for a session. Single use, 20 minutes. Throws 401. */
export function consumeLink({ token, device = "", now = Date.now() } = {}) {
  const d = open();
  const row = d.prepare(`SELECT account_id, expires_at, used_at FROM login_links WHERE token_hash = ?`).get(sha(String(token || "")));
  if (!row) throw httpError(401, "This sign-in link isn't valid. Ask for a new one.");
  if (row.used_at) throw httpError(401, "This sign-in link was already used. Ask for a new one.");
  if (row.expires_at < iso(now)) throw httpError(401, "This sign-in link has expired (they last 20 minutes). Ask for a new one.");
  d.prepare(`UPDATE login_links SET used_at = ? WHERE token_hash = ?`).run(iso(now), sha(token));
  d.prepare(`UPDATE accounts SET last_login_at = ? WHERE id = ?`).run(iso(now), row.account_id);
  const sessionToken = randomBytes(32).toString("base64url");
  const expiresAt = iso(now + SESSION_TTL_MS);
  d.prepare(`INSERT INTO sessions (token_hash, account_id, device, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`).run(sha(sessionToken), row.account_id, String(device || "").slice(0, 80), iso(now), expiresAt, iso(now));
  return { sessionToken, accountId: row.account_id, expiresAt };
}

/** The account behind a session token, or null. Touches last_seen at most once an hour. */
export function sessionFor(sessionToken, now = Date.now()) {
  if (!sessionToken) return null;
  const d = open();
  const row = d.prepare(`SELECT account_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?`).get(sha(String(sessionToken)));
  if (!row || row.expires_at < iso(now)) return null;
  if (new Date(row.last_seen_at).getTime() < now - 3600_000) d.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(iso(now), sha(sessionToken));
  return { accountId: row.account_id };
}

export function logout(sessionToken) {
  if (!sessionToken) return;
  open().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha(String(sessionToken)));
}

// ---------- the account's routes ----------

/** What the list shows, derived from the package so the client can't lie about "paid". */
export function summarize(pkg, title = "") {
  const it = pkg?.itinerary || {};
  const short = (l) => String(l || "").split(",")[0].trim();
  return {
    title: String(title || pkg?.title || `${short(it.start?.label) || "?"} → ${short(it.end?.label) || "?"}`).slice(0, 120),
    startLabel: it.start?.label || "", endLabel: it.end?.label || "", date: it.date || "", arrivalTime: it.arrivalTime || "",
    stopsCount: Array.isArray(it.stops) ? it.stops.length : 0, narrationCount: Array.isArray(pkg?.narration) ? pkg.narration.length : 0,
    paid: Boolean(pkg?.credit), libraryId: pkg?.libraryId || null, preparedAt: pkg?.preparedAt || null, voiced: Boolean(pkg?.voice?.clips),
  };
}

export function listRoutes(accountId) {
  return open().prepare(`SELECT trip_id, title, summary_json, updated_at, deleted_at FROM user_routes WHERE account_id = ? ORDER BY updated_at DESC`).all(accountId)
    .map((r) => ({ tripId: r.trip_id, title: r.title, updatedAt: r.updated_at, deleted: Boolean(r.deleted_at), ...(r.deleted_at ? {} : JSON.parse(r.summary_json || "{}")) }));
}

export function getRoute(accountId, tripId) {
  const r = open().prepare(`SELECT package_json, updated_at FROM user_routes WHERE account_id = ? AND trip_id = ? AND deleted_at IS NULL`).get(accountId, String(tripId));
  return r ? { package: JSON.parse(r.package_json), updatedAt: r.updated_at } : null;
}

/** Store or replace one route. Throws 400 / 413 / 429. Returns the list entry. */
export function putRoute(accountId, tripId, { title = "", pkg, now = Date.now() } = {}) {
  if (!/^[a-z0-9_\-]{3,64}$/i.test(String(tripId || ""))) throw httpError(400, "bad trip id");
  if (!pkg?.itinerary?.stops || !Array.isArray(pkg.narration)) throw httpError(400, "not a drive package");
  const json = JSON.stringify(pkg);
  if (json.length > MAX_PACKAGE_BYTES) throw httpError(413, "This route is too large to keep in your account.");
  const d = open();
  const exists = d.prepare(`SELECT 1 FROM user_routes WHERE account_id = ? AND trip_id = ?`).get(accountId, tripId);
  if (!exists) {
    const n = d.prepare(`SELECT COUNT(*) AS n FROM user_routes WHERE account_id = ? AND deleted_at IS NULL`).get(accountId).n;
    if (n >= MAX_ROUTES) throw httpError(429, `Your account holds ${MAX_ROUTES} routes already; delete some first.`);
  }
  const summary = summarize(pkg, title);
  d.prepare(`INSERT INTO user_routes (account_id, trip_id, title, summary_json, package_json, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(account_id, trip_id) DO UPDATE SET title = excluded.title, summary_json = excluded.summary_json, package_json = excluded.package_json, updated_at = excluded.updated_at, deleted_at = NULL`)
    .run(accountId, tripId, summary.title, JSON.stringify(summary), json, iso(now));
  return { tripId, title: summary.title, updatedAt: iso(now), deleted: false, ...summary };
}

/** Soft delete: the row stays (empty) for 30 days so the account's other devices delete their copy too. */
export function deleteRoute(accountId, tripId, now = Date.now()) {
  open().prepare(`UPDATE user_routes SET deleted_at = ?, updated_at = ?, package_json = '', summary_json = '{}' WHERE account_id = ? AND trip_id = ? AND deleted_at IS NULL`).run(iso(now), iso(now), accountId, String(tripId));
}

export function stats() {
  try {
    const d = open();
    return {
      accounts: d.prepare(`SELECT COUNT(*) AS n FROM accounts`).get().n,
      sessions: d.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?`).get(iso(Date.now())).n,
      routes: d.prepare(`SELECT COUNT(*) AS n FROM user_routes WHERE deleted_at IS NULL`).get().n,
      bytes: d.prepare(`SELECT COALESCE(SUM(LENGTH(package_json)), 0) AS b FROM user_routes`).get().b,
    };
  } catch (err) { return { error: err.message }; }
}

/** Hourly: expired links and sessions go, long-deleted routes go. */
export function sweep(now = Date.now()) {
  const d = open();
  d.prepare(`DELETE FROM login_links WHERE expires_at < ?`).run(iso(now));
  d.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(iso(now));
  d.prepare(`DELETE FROM user_routes WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(iso(now - DELETED_KEEP_MS));
  for (const [h, times] of recent) { const keep = times.filter((t) => now - t < LINK_WINDOW_MS); if (keep.length) recent.set(h, keep); else recent.delete(h); }
}
