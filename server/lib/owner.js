// Owner mode with brute-force protection.
//
//   POST /api/owner/unlock {passphrase}  →  a random owner token (stored hashed, 180 days)
//   x-app-key: <token>  (or the raw passphrase, for devices unlocked before tokens existed)
//
// Every wrong guess is counted against the caller's IP and against the device id the browser
// sends (x-device). MAX_TRIES wrong guesses in the window locks both for LOCK_MS: unlock answers
// 429 and any key from that caller is ignored. A stale token counts once per key per caller,
// not once per request, so an expired token doesn't lock a legitimate owner out.

import path from "node:path";
import fs from "node:fs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { httpError } from "./http.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");
export const MAX_TRIES = 3;
export const LOCK_MS = 24 * 3600_000;
export const WINDOW_MS = 24 * 3600_000; // wrong guesses are forgotten after this
export const TOKEN_TTL_MS = 180 * 86400_000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return timingSafeEqual(x, y); };

export function createOwner({ secret = () => config.appSecret, file = FILE, now = () => Date.now() } = {}) {
  let db = null;
  function open() {
    if (db) return db;
    if (file !== ":memory:") fs.mkdirSync(DIR, { recursive: true });
    db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS owner_tokens (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS owner_attempts (who TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, first_fail_at TEXT, locked_until TEXT, seen_keys TEXT NOT NULL DEFAULT '[]');
    `);
    return db;
  }
  const iso = (ms = now()) => new Date(ms).toISOString();
  const callers = (ip, device) => [ip ? `ip:${ip}` : null, device ? `dev:${String(device).slice(0, 64)}` : null].filter(Boolean);

  function attempt(who) {
    return open().prepare(`SELECT * FROM owner_attempts WHERE who = ?`).get(who) || { who, fails: 0, first_fail_at: null, locked_until: null, seen_keys: "[]" };
  }
  function saveAttempt(a) {
    open().prepare(`INSERT OR REPLACE INTO owner_attempts (who, fails, first_fail_at, locked_until, seen_keys) VALUES (?, ?, ?, ?, ?)`).run(a.who, a.fails, a.first_fail_at, a.locked_until, a.seen_keys);
  }

  /** Is this IP or device locked out right now? Returns the lock's end (ISO) or null. */
  function lockedUntil({ ip, device } = {}) {
    let until = null;
    for (const who of callers(ip, device)) {
      const a = attempt(who);
      if (a.locked_until && Date.parse(a.locked_until) > now()) until = !until || a.locked_until > until ? a.locked_until : until;
    }
    return until;
  }

  /**
   * Count a wrong guess (`key` dedupes stale tokens: the same wrong key from the same caller is
   * one failure). Returns { locked, triesLeft }.
   */
  function fail({ ip, device, key = "" } = {}) {
    let locked = false, triesLeft = MAX_TRIES;
    for (const who of callers(ip, device)) {
      const a = attempt(who);
      if (a.first_fail_at && now() - Date.parse(a.first_fail_at) > WINDOW_MS) { a.fails = 0; a.first_fail_at = null; a.seen_keys = "[]"; }
      const seen = JSON.parse(a.seen_keys || "[]");
      const k = sha(key).slice(0, 16);
      if (!seen.includes(k)) {
        seen.push(k);
        a.seen_keys = JSON.stringify(seen.slice(-20));
        a.fails += 1;
        a.first_fail_at ||= iso();
        if (a.fails >= MAX_TRIES) { a.locked_until = iso(now() + LOCK_MS); locked = true; }
        saveAttempt(a);
      }
      triesLeft = Math.min(triesLeft, Math.max(0, MAX_TRIES - a.fails));
      if (a.locked_until && Date.parse(a.locked_until) > now()) locked = true;
    }
    return { locked, triesLeft };
  }

  function clear({ ip, device } = {}) {
    for (const who of callers(ip, device)) open().prepare(`DELETE FROM owner_attempts WHERE who = ?`).run(who);
  }

  /** Does this x-app-key grant owner mode? Raw passphrase or a live token. Never counts failures. */
  function keyValid(key) {
    if (!key || !secret()) return false;
    if (same(key, secret())) return true;
    const row = open().prepare(`SELECT expires_at FROM owner_tokens WHERE token_hash = ?`).get(sha(key));
    return Boolean(row && Date.parse(row.expires_at) > now());
  }

  /**
   * Tier for a request: "subscriber" (owner) or "free". A wrong key counts as a guess against
   * the caller; a locked caller is never the owner, even with the right key.
   */
  function tierFor({ key, ip, device }) {
    if (!secret()) return "subscriber"; // no passphrase configured = local development
    if (!key) return "free";
    if (lockedUntil({ ip, device })) return "free";
    if (keyValid(key)) return "subscriber";
    fail({ ip, device, key });
    return "free";
  }

  /** Exchange the passphrase for a token. 401 wrong (with tries left), 429 locked. */
  function unlock({ passphrase, ip, device }) {
    if (!secret()) throw httpError(400, "This server has no owner passphrase.");
    const until = lockedUntil({ ip, device });
    if (until) throw Object.assign(httpError(429, "Too many wrong passphrases from this device. Try again in 24 hours."), { lockedUntil: until });
    if (!passphrase || !same(passphrase, secret())) {
      const r = fail({ ip, device, key: passphrase || "" });
      if (r.locked) throw Object.assign(httpError(429, "Too many wrong passphrases from this device. Try again in 24 hours."), { lockedUntil: lockedUntil({ ip, device }) });
      throw Object.assign(httpError(401, r.triesLeft === 1 ? "Wrong passphrase. One try left." : `Wrong passphrase. ${r.triesLeft} tries left.`), { triesLeft: r.triesLeft });
    }
    clear({ ip, device });
    const token = randomBytes(32).toString("base64url");
    open().prepare(`INSERT INTO owner_tokens (token_hash, created_at, expires_at, ip, device) VALUES (?, ?, ?, ?, ?)`).run(sha(token), iso(), iso(now() + TOKEN_TTL_MS), String(ip || "").slice(0, 64), String(device || "").slice(0, 64));
    return { token, expiresAt: iso(now() + TOKEN_TTL_MS) };
  }

  /** Leaving owner mode on a device: forget its token. */
  function revoke(key) {
    if (!key) return false;
    return open().prepare(`DELETE FROM owner_tokens WHERE token_hash = ?`).run(sha(key)).changes > 0;
  }

  function stats() {
    const d = open();
    return {
      tokens: d.prepare(`SELECT COUNT(*) c FROM owner_tokens WHERE expires_at > ?`).get(iso()).c,
      locked: d.prepare(`SELECT COUNT(*) c FROM owner_attempts WHERE locked_until > ?`).get(iso()).c,
    };
  }

  return { tierFor, unlock, revoke, keyValid, lockedUntil, stats, MAX_TRIES, LOCK_MS };
}

export default createOwner();
