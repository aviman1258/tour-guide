// Deodap's voice: Google Cloud Text-to-Speech (Chirp 3 HD by default) turns each narration
// script into an MP3 at prepare time. Clips are cached in SQLite by (voice, text) so a story is
// only ever paid for once, however many times a route is re-prepared or driven; the phone keeps
// its own copy for offline use. Directions stay on the phone's voice (road names are only known
// live). Spend is bounded by a daily budget, and an auth/permission failure pauses the feature
// for 15 minutes instead of failing every prepare in a row.
//
//   synthesize(text) → { hash, bytes, chars, cached }
//   forNarration(items) attaches `audio: {url, hash, bytes, voice}` to every item it could voice
//   GET /api/audio/<hash>.mp3 serves the bytes (index.js)

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { mapLimit } from "./http.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");
const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const PAUSE_MS = 15 * 60_000;
const MAX_CHARS = 4500; // Google's limit is 5,000 bytes per request; scripts are ~900 chars

let db = null;
const state = { pausedUntil: 0, lastError: null };

function open(file = FILE) {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tts_audio (hash TEXT PRIMARY KEY, voice TEXT NOT NULL, chars INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tts_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, voice TEXT NOT NULL, chars INTEGER NOT NULL, cost_usd REAL NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS tts_calls_ts ON tts_calls(ts);
  `);
  return db;
}
export function _useMemoryDb() { db = null; open(":memory:"); state.pausedUntil = 0; state.lastError = null; }

export const enabled = () => Boolean(config.tts.enabled && config.tts.key);
export const hashFor = (text, voice = config.tts.voice) => crypto.createHash("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 32);
export const costOf = (chars, rate = config.tts.ratePerMChars) => (chars / 1e6) * rate;

/** Today's spend (UTC) against the daily cap. */
export function budget(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = open().prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM tts_calls WHERE ts >= ? AND ok = 1").get(`${day}T00:00:00.000Z`);
  const limit = config.tts.dailyBudgetUsd;
  return { limit, today: Number(row?.usd || 0), tripped: limit > 0 && Number(row?.usd || 0) >= limit };
}

/** A cached clip by hash, or null. */
export function get(hash) {
  const row = open().prepare("SELECT voice, chars, bytes FROM tts_audio WHERE hash = ?").get(String(hash || ""));
  return row ? { voice: row.voice, chars: row.chars, bytes: Buffer.from(row.bytes) } : null;
}

function logCall(voice, chars, cost, ms, ok, error) {
  open().prepare("INSERT INTO tts_calls (ts, voice, chars, cost_usd, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), voice, chars, cost, ms, ok ? 1 : 0, error || null);
}

/**
 * One script → one MP3. Cached clips cost nothing and return at once. Throws when the voice is
 * off, paused after an auth failure, over budget, or Google says no.
 */
export async function synthesize(text, { voice = config.tts.voice, fetchImpl = fetch, now = Date.now } = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("nothing to say");
  if (clean.length > MAX_CHARS) throw new Error(`script too long for one clip (${clean.length} chars)`);
  const hash = hashFor(clean, voice);
  const cached = get(hash);
  if (cached) return { hash, bytes: cached.bytes, chars: clean.length, cached: true };
  if (!enabled()) throw new Error("voice is off (no GOOGLE_TTS_KEY)");
  if (now() < state.pausedUntil) throw new Error(`voice paused after an error: ${state.lastError}`);
  const b = budget(now());
  if (b.tripped) throw new Error(`voice budget reached ($${b.limit} a day)`);

  const t = now();
  const body = {
    input: { text: clean },
    voice: { languageCode: voice.split("-").slice(0, 2).join("-"), name: voice },
    audioConfig: { audioEncoding: "MP3", ...(config.tts.speakingRate && config.tts.speakingRate !== 1 ? { speakingRate: config.tts.speakingRate } : {}) },
  };
  let res, data;
  try {
    res = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(config.tts.key)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.httpTimeoutMs * 2),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    state.lastError = err.message;
    logCall(voice, clean.length, 0, now() - t, false, err.message);
    throw new Error(`voice: ${err.message}`);
  }
  if (!res.ok || !data?.audioContent) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    state.lastError = msg;
    if ([400, 401, 403].includes(res.status)) state.pausedUntil = now() + PAUSE_MS; // key / API not enabled / bad voice: don't retry every prepare
    logCall(voice, clean.length, 0, now() - t, false, msg);
    throw new Error(`voice: ${msg}`);
  }
  const bytes = Buffer.from(data.audioContent, "base64");
  open().prepare("INSERT OR REPLACE INTO tts_audio (hash, voice, chars, bytes, created_at) VALUES (?, ?, ?, ?, ?)").run(hash, voice, clean.length, bytes, new Date().toISOString());
  logCall(voice, clean.length, costOf(clean.length), now() - t, true, null);
  state.lastError = null;
  return { hash, bytes, chars: clean.length, cached: false };
}

/**
 * Voice every narration item (3 at a time). Items that fail simply keep no `audio` and the phone
 * reads them with its own voice. Returns counts for the progress event and the log.
 */
export async function forNarration(items, { onItem = () => {}, signal, fetchImpl, voice } = {}) {
  const out = { done: 0, cached: 0, failed: 0, bytes: 0, newChars: 0, costUsd: 0 };
  if (!enabled()) return { ...out, skipped: items.length };
  await mapLimit(items, 3, async (item) => {
    if (signal?.aborted) return;
    try {
      const r = await synthesize(item.text, { fetchImpl, voice });
      item.audio = { url: `/api/audio/${r.hash}.mp3`, hash: r.hash, bytes: r.bytes.length, voice: voice || config.tts.voice };
      out.done++;
      out.bytes += r.bytes.length;
      if (r.cached) out.cached++; else { out.newChars += r.chars; out.costUsd += costOf(r.chars); }
      onItem(item, null);
    } catch (err) {
      out.failed++;
      onItem(item, err);
    }
  });
  return out;
}

/** For the admin cost panel: calls, characters and dollars over the last `days`. */
export function summary(days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const r = open().prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed, COALESCE(SUM(CASE WHEN ok = 1 THEN chars ELSE 0 END), 0) AS chars, COALESCE(SUM(cost_usd), 0) AS usd FROM tts_calls WHERE ts >= ?").get(since);
  const clips = open().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(bytes)), 0) AS bytes FROM tts_audio").get();
  return { days, enabled: enabled(), voice: config.tts.voice, calls: r.calls, failed: r.failed, chars: r.chars, costUsd: r.usd, clips: clips.n, clipBytes: clips.bytes, ratePerMChars: config.tts.ratePerMChars };
}

/** For /api/health. */
export function stats(now = Date.now()) {
  let clips = 0;
  try { clips = open().prepare("SELECT COUNT(*) AS n FROM tts_audio").get().n; } catch { /* no db yet */ }
  return {
    enabled: enabled(), voice: config.tts.voice, keySource: config.tts.keySource,
    budget: enabled() ? budget(now) : null, clips,
    paused: now < state.pausedUntil, pausedUntil: now < state.pausedUntil ? new Date(state.pausedUntil).toISOString() : null, lastError: state.lastError,
  };
}
