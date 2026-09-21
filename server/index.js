import express from "express";
import fs from "node:fs";
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
import * as library from "./lib/library.js";
import * as analytics from "./lib/analytics.js";
import * as nominatim from "./nominatim.js";
import { createLimiter, limitFree } from "./lib/ratelimit.js";
import { toMinutes } from "../web/js/format.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const app = express();
app.set("trust proxy", config.trustProxy); // see config.trustProxy; GET /api/whoami echoes ip + forwarded chain
app.use(express.json({ limit: "4mb" }));

// ---------- usage analytics ----------
// Page opens are reported by the page itself (POST /api/ping) so visits served from the
// offline cache or the installed app are counted too; the server only sees API calls otherwise.
setInterval(() => { try { analytics.purge(); } catch { /* ignore */ } }, 6 * 3600_000).unref();

// wraps async handlers so thrown httpErrors reach the error middleware
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
  return n;
};

// Tiers. Every /api request is stamped "subscriber" (knows APP_SECRET, or no secret set = local dev)
// or "free". AI routes require subscriber; the rest are open but rate-limited per IP for free traffic.
app.use("/api", (req, _res, next) => {
  const key = req.get("x-app-key") || req.query.key;
  req.tier = !config.appSecret || key === config.appSecret ? "subscriber" : "free";
  next();
});
const requireSubscriber = (req, res, next) => {
  if (req.tier === "subscriber") return next();
  res.status(401).json({ error: "This feature is for subscribers. Enter the app passphrase.", needsKey: true });
};
const freeLimiter = createLimiter({ max: 90, windowMs: 10 * 60_000 });
app.use(["/api/place", "/api/reverse", "/api/schedule", "/api/routes", "/api/ping"], limitFree(freeLimiter));
app.use(["/api/plan", "/api/suggest", "/api/prepare-drive"], requireSubscriber);

app.get("/api/whoami", h(async (req, res) => {
  // ip/forwarded echo the caller's own address chain, so the proxy setup can be checked in production.
  const cf = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("cf-")));
  res.json({ tier: req.tier, protected: Boolean(config.appSecret), ip: req.ip, forwarded: req.get("x-forwarded-for") || null, cf });
}));

// Page-open beacon from the client: { page, tier?, standalone?, referrer? }. No response body needed.
app.post("/api/ping", express.text({ type: "*/*", limit: "2kb" }), (req, res) => {
  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); } catch { /* ignore */ }
  const page = String(b.page || "").replace(/[^\w./?=&-]/g, "").slice(0, 80) || "/";
  const bits = [page, b.standalone ? "installed" : "", b.referrer ? `from ${String(b.referrer).replace(/^https?:\/\//, "").slice(0, 60)}` : ""].filter(Boolean).join(" · ");
  if (b.tier === "free" || b.tier === "subscriber") req.tier = b.tier;
  analytics.track(req, "page", bits);
  res.status(204).end();
});

// ---------- admin dashboard (own password) ----------
const requireAdmin = (req, res, next) => {
  if (!config.adminSecret) return res.status(404).json({ error: "admin is not enabled on this server" });
  const key = req.get("x-admin-key") || req.query.adminKey;
  if (key === config.adminSecret) return next();
  res.status(401).json({ error: "admin password required", needsAdmin: true });
};
app.get("/api/admin/summary", requireAdmin, h(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json(analytics.summary(days));
}));
app.get("/api/admin/events", requireAdmin, h(async (req, res) => {
  res.json({ events: analytics.recent(Number(req.query.limit) || 200) });
}));

app.get("/api/health", h(async (_req, res) => {
  // storage diagnostics: is the data dir writable, and are events actually being recorded?
  let data = {};
  try {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
    let writable = false;
    try { fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch { /* not writable / missing */ }
    data = { dir, exists: fs.existsSync(dir), writable, events: analytics.recent(1).length ? analytics.summary(3650).totals.events : 0, routes: library.count(), admin: Boolean(config.adminSecret), analytics: analytics.stats() };
  } catch (err) {
    data = { error: err.message };
  }
  res.json({
    ok: true,
    protected: Boolean(config.appSecret),
    claude: config.anthropicKey ? "sdk" : "cli",
    data,
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

  const t0 = Date.now();
  const done = (result) => analytics.track(req, "plan", result ? `${result.stops.length} stops · ${Math.round((result.route?.totalM || 0) / 1609)} mi` : "cancelled", Date.now() - t0);

  const streaming = String(req.headers.accept || "").includes("text/event-stream");
  if (!streaming) {
    const result = await plan.runPlan(input, { signal: ac.signal });
    done(result);
    if (result) res.json(result);
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded && !ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  try {
    done(await plan.runPlan(input, { emit: send, signal: ac.signal }));
  } catch (err) {
    analytics.track(req, "plan_error", err.message, Date.now() - t0);
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

// ---------- shared route library ----------

// Search: ?near=lat,lon (routes starting/ending within 50 km) and/or ?q=text.
app.get("/api/routes", h(async (req, res) => {
  let near;
  if (req.query.near) {
    const [lat, lon] = String(req.query.near).split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) near = { lat, lon };
  }
  const radiusKm = Math.min(300, Math.max(5, Number(req.query.radiusKm) || 50));
  const routes = library.search({ near, radiusKm, q: String(req.query.q || ""), limit: Number(req.query.limit) || 20 });
  analytics.track(req, "route_search", `${near ? "near" : ""}${req.query.q ? ` q=${String(req.query.q).slice(0, 40)}` : ""} → ${routes.length}`);
  res.json({ routes, total: library.count() });
}));

// Full package for one route (counts a use).
app.get("/api/routes/:id", h(async (req, res) => {
  const r = library.get(req.params.id, { countUse: req.query.use !== "0" });
  analytics.track(req, "route_use", `${req.params.id} ${r.summary.title}`);
  res.json(r);
}));

// Publish (subscriber). Body: { package, title, description }. Region is derived from the start point.
app.post("/api/routes", requireSubscriber, h(async (req, res) => {
  const { package: pkg, title, description } = req.body || {};
  if (!pkg) throw httpError(400, "package is required");
  let region = "";
  try {
    const r = await nominatim.reverse(pkg.itinerary.start.lat, pkg.itinerary.start.lon, 10);
    region = [r?.address?.city || r?.address?.town || r?.address?.county, r?.address?.state, r?.address?.country_code?.toUpperCase()].filter(Boolean).join(", ");
  } catch { /* region is optional */ }
  const summary = library.publish({ pkg, title, description, region, author: "subscriber" });
  console.log(`[library] published ${summary.id} "${summary.title}" (${summary.stopsCount} stops, ${summary.region})`);
  analytics.track(req, "publish", `${summary.id} ${summary.title}`);
  res.status(201).json(summary);
}));

app.delete("/api/routes/:id", requireSubscriber, h(async (req, res) => {
  library.remove(req.params.id);
  res.status(204).end();
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

// Narration package for drive mode. Streams progress events with Accept: text/event-stream.
app.post("/api/prepare-drive", h(async (req, res) => {
  const { itinerary } = req.body || {};
  if (!itinerary?.start || !itinerary?.end) throw httpError(400, "itinerary with start and end is required");

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) { ac.abort(); console.log("[prepare-drive] cancelled by client"); } });

  const t0 = Date.now();
  const done = (pkg) => analytics.track(req, "prepare", pkg ? `${pkg.narration.length} narrations` : "cancelled", Date.now() - t0);
  if (!String(req.headers.accept || "").includes("text/event-stream")) {
    const pkg = await narrate.prepareDrive(itinerary, { signal: ac.signal });
    done(pkg);
    if (pkg) res.json(pkg);
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded && !ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  try {
    done(await narrate.prepareDrive(itinerary, { emit: send, signal: ac.signal }));
  } catch (err) {
    analytics.track(req, "prepare_error", err.message, Date.now() - t0);
    if (!ac.signal.aborted) {
      if ((err.status || 500) >= 500) console.error(err);
      send("error", { message: err.message, status: err.status || 500 });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
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
