import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { httpError } from "./lib/http.js";
import { bbox } from "./lib/geo.js";
import * as stops from "./stops.js";
import * as claude from "./claude.js";
import * as resolve from "./resolve.js";
import * as schedule from "./schedule.js";
import * as narrate from "./narrate.js";
import { toMinutes } from "../web/js/format.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const app = express();
app.use(express.json({ limit: "4mb" }));

// wraps async handlers so thrown httpErrors reach the error middleware
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
  return n;
};

app.get("/api/health", h(async (_req, res) => {
  res.json({
    ok: true,
    claude: config.anthropicKey ? "sdk" : "cli",
    models: { strong: config.modelStrong, fast: config.modelFast },
    osrm: config.osrmBase,
  });
}));

// Explicit-submit place search (no autocomplete; Nominatim policy).
app.get("/api/place", h(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) throw httpError(400, "q is required");
  let viewbox;
  if (req.query.near) {
    const [lat, lon] = String(req.query.near).split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) viewbox = bbox([{ lat, lon }], 40);
  }
  res.json({ results: await stops.searchPlace(q, { viewbox }) });
}));

app.get("/api/reverse", h(async (req, res) => {
  const lat = num(req.query.lat, "lat");
  const lon = num(req.query.lon, "lon");
  res.json(await stops.stopAtPoint(lat, lon));
}));

// Claude proposes → Wikipedia/Nominatim ground → OSRM route → schedule + trim.
app.post("/api/plan", h(async (req, res) => {
  const b = req.body || {};
  const input = {
    version: 1,
    start: b.start, end: b.end, date: b.date || "",
    arrivalTime: b.arrivalTime, deadline: b.deadline,
    departBufferMinutes: Number(b.departBufferMinutes) || config.departBufferMinutes,
    safetyBufferMinutes: Number(b.safetyBufferMinutes) || config.safetyBufferMinutes,
    interests: String(b.interests || "").trim(),
    stops: [],
  };
  schedule.validateItinerary(input);
  if (!input.interests) throw httpError(400, "interests is required");

  const corridor = bbox([input.start, input.end], 25);
  const budgetMinutes = toMinutes(input.deadline) - toMinutes(input.arrivalTime) - input.departBufferMinutes - input.safetyBufferMinutes;
  const proposal = await claude.proposeStops({ ...input, budgetMinutes, corridor });
  if (!proposal.stops.length) throw httpError(502, "Claude returned no stops");

  const grounded = await resolve.resolveCandidates(proposal.stops, corridor);
  console.log(`[plan] ${proposal.stops.length} proposed → ${grounded.stops.length} grounded, ${grounded.dropped.length} dropped`);
  if (!grounded.stops.length) throw httpError(502, "None of the proposed stops could be verified");

  const result = await schedule.computeItinerary(
    { ...input, stops: grounded.stops, dropped: grounded.dropped, summary: proposal.summary },
    { trim: true, reorder: true }
  );
  res.json(result);
}));

// Re-route + re-schedule after client edits. Never trims.
app.post("/api/schedule", h(async (req, res) => {
  const { itinerary, trim } = req.body || {};
  if (!itinerary) throw httpError(400, "itinerary is required");
  res.json(await schedule.computeItinerary(itinerary, { trim: Boolean(trim) }));
}));

// A few more grounded candidates that aren't already in the itinerary.
app.post("/api/suggest", h(async (req, res) => {
  const { itinerary, count } = req.body || {};
  if (!itinerary?.start || !itinerary?.end) throw httpError(400, "itinerary with start and end is required");
  const n = Math.min(6, Math.max(1, Number(count) || 3));
  const corridor = bbox([itinerary.start, itinerary.end, ...(itinerary.stops || [])], 20);
  const candidates = await claude.suggestMore({ itinerary, count: n, corridor });
  const existing = new Set((itinerary.stops || []).flatMap((s) => [s.name, s.wikipediaTitle].filter(Boolean).map((x) => x.toLowerCase())));
  const { stops: grounded } = await resolve.resolveCandidates(candidates, corridor);
  res.json({ candidates: grounded.filter((s) => !existing.has(s.name.toLowerCase()) && !existing.has((s.wikipediaTitle || "").toLowerCase())).slice(0, n) });
}));

// Narration package for drive mode.
app.post("/api/prepare-drive", h(async (req, res) => {
  const { itinerary } = req.body || {};
  if (!itinerary?.route?.geometry) throw httpError(400, "itinerary with a route is required");
  res.json(await narrate.prepareDrive(itinerary));
}));

app.use(express.static(WEB_DIR, { extensions: ["html"] }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`tour-guide listening on http://localhost:${config.port} (claude via ${config.anthropicKey ? "sdk" : "cli"})`);
});
