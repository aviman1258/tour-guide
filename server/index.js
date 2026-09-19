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
import * as plan from "./plan.js";
import * as timings from "./lib/timings.js";
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

// Claude proposes → Wikipedia/Nominatim ground → route → schedule + trim.
// With `Accept: text/event-stream` the response is a stream of progress events (see server/plan.js);
// otherwise the finished itinerary as one JSON document.
app.post("/api/plan", h(async (req, res) => {
  const input = plan.parsePlanInput(req.body);

  // If the browser cancels (connection closed before we answered), stop the Claude call and skip the rest.
  // Note: `req` emits close as soon as the body is consumed, so listen on `res` and check it never finished.
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) { ac.abort(); console.log("[plan] cancelled by client"); } });

  const streaming = String(req.headers.accept || "").includes("text/event-stream");
  if (!streaming) {
    const result = await plan.runPlan(input, { signal: ac.signal });
    if (result) res.json(result);
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded && !ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  try {
    await plan.runPlan(input, { emit: send, signal: ac.signal });
  } catch (err) {
    if (!ac.signal.aborted) {
      if ((err.status || 500) >= 500) console.error(err);
      send("error", { message: err.message, status: err.status || 500 });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}));

app.get("/api/estimate", h(async (_req, res) => {
  res.json({ plan: timings.planEstimate(), narrate: timings.narrateEstimate() });
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
