// Claude usage log: one row per model call (tokens, cost, duration, which tool). This is what
// route pricing is calibrated against. Cost is computed from per-million-token rates in
// config.claudeRates (env CLAUDE_RATES); the CLI path reports its own cost, which wins when present.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");

let db = null;
function open() {
  if (db) return db;
  fs.mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS claude_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      transport TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      ms INTEGER NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS claude_calls_ts ON claude_calls(ts);
  `);
  return db;
}

/** Rates for a model: the exact id, else the first rate key the id contains ("opus", "haiku"). */
export function ratesFor(model, rates = config.claudeRates) {
  if (!rates) return null;
  if (rates[model]) return rates[model];
  const m = String(model).toLowerCase();
  const key = Object.keys(rates).find((k) => m.includes(k.toLowerCase()));
  return key ? rates[key] : null;
}

/**
 * USD for one call from an Anthropic-style usage object. Cache writes bill at 1.25× input,
 * cache reads at 0.1× input (Anthropic's standard multipliers). Null when no rate is known.
 */
export function costOf(model, usage, rates = config.claudeRates) {
  const r = ratesFor(model, rates);
  if (!r || !usage) return null;
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0, cr = usage.cache_read_input_tokens || 0;
  return (inTok * r.in + cw * r.in * 1.25 + cr * r.in * 0.1 + outTok * r.out) / 1e6;
}

/** Record one call. Never throws. */
export function record({ tool, model, transport, usage, costUsd, ms, ok = true }) {
  try {
    const u = usage || {};
    const cost = costUsd ?? costOf(model, u);
    open().prepare(`INSERT INTO claude_calls (ts, tool, model, transport, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ms, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      new Date().toISOString(), tool, model, transport,
      u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
      cost, Math.round(ms || 0), ok ? 1 : 0,
    );
  } catch (err) {
    console.warn("[usage]", err.message);
  }
}

/**
 * Admin summary for the last `days`: per tool (calls, median/avg tokens, avg + total cost), totals,
 * and the cost of one finished route = median plan call + median narration call.
 */
export function summary(days = 30) {
  const d = open();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = d.prepare(`SELECT tool, model, transport, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ms, ok FROM claude_calls WHERE ts >= ?`).all(since);
  const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const avg = (xs) => { const s = xs.filter((x) => x != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
  const byTool = {};
  for (const r of rows) {
    const t = (byTool[r.tool] ||= { tool: r.tool, models: new Set(), calls: 0, failed: 0, inTok: [], outTok: [], cacheRead: [], cost: [], ms: [] });
    t.models.add(r.model); t.calls++; if (!r.ok) t.failed++;
    t.inTok.push(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens); t.outTok.push(r.output_tokens); t.cacheRead.push(r.cache_read_tokens); t.cost.push(r.cost_usd); t.ms.push(r.ms);
  }
  const tools = Object.values(byTool).map((t) => ({
    tool: t.tool, models: [...t.models].join(", "), calls: t.calls, failed: t.failed,
    medianIn: median(t.inTok), medianOut: median(t.outTok), avgCacheRead: avg(t.cacheRead),
    medianCost: median(t.cost), avgCost: avg(t.cost), totalCost: t.cost.reduce((a, b) => a + (b || 0), 0), medianMs: median(t.ms),
  })).sort((a, b) => b.totalCost - a.totalCost);
  const cost = (tool) => tools.find((t) => t.tool === tool)?.medianCost ?? null;
  const plan = cost("propose_itinerary"), narration = cost("write_narration"), suggest = cost("suggest_more");
  return {
    days, since,
    rates: config.claudeRates, ratesNote: config.claudeRatesFromEnv ? "from CLAUDE_RATES" : "built-in defaults: verify against the Anthropic console",
    totals: { calls: rows.length, failed: rows.filter((r) => !r.ok).length, costUsd: rows.reduce((a, r) => a + (r.cost_usd || 0), 0), unpriced: rows.filter((r) => r.cost_usd == null).length },
    tools,
    perRoute: plan == null && narration == null ? null : { plan, narration, suggest, total: (plan || 0) + (narration || 0) },
  };
}

export function count() { return open().prepare(`SELECT COUNT(*) c FROM claude_calls`).get().c; }
