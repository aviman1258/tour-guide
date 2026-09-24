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
import * as usage from "./lib/usage.js";
import pay from "./lib/pay.js";
import owner from "./lib/owner.js";
import * as routePages from "./routePages.js";
import { shapeListing, fallbackListing } from "./lib/describe.js";
import * as indexnow from "./lib/indexnow.js";
import * as places from "./places.js";
import { quote as priceQuote, PLANS_PER_CREDIT } from "../web/js/pricing.js";
import * as nominatim from "./nominatim.js";
import { createLimiter, limitFree } from "./lib/ratelimit.js";
import { toMinutes } from "../web/js/format.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const app = express();
app.set("trust proxy", config.trustProxy); // see config.trustProxy; GET /api/whoami echoes ip + forwarded chain
// Stripe → us. Raw body (signature check) so it sits before the JSON parser. Never log the payload: it carries the payer's details.
app.post("/api/pay/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  try {
    const r = pay.handleWebhook(req.body, req.get("stripe-signature") || "");
    res.json({ received: true, ...r });
  } catch (err) {
    console.warn("[pay] webhook rejected:", err.message);
    res.status(err.status || 400).json({ error: "webhook rejected" });
  }
});
app.use(express.json({ limit: "4mb" }));

// ---------- usage analytics ----------
// Page opens are reported by the page itself (POST /api/ping) so visits served from the
// offline cache or the installed app are counted too; the server only sees API calls otherwise.
setInterval(() => { try { analytics.purge(); } catch { /* ignore */ } }, 6 * 3600_000).unref();
// repair locations that failed to resolve earlier (a few seconds after boot, then daily)
const backfill = () => analytics.backfillGeo().then((r) => { if (r.checked) console.log(`[analytics] geo backfill: ${r.filled}/${r.checked} IPs located`); }).catch(() => {});
setTimeout(backfill, 15_000).unref();
setInterval(backfill, 24 * 3600_000).unref();

// wraps async handlers so thrown httpErrors reach the error middleware
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
  return n;
};

// Tiers. Every /api request is stamped "subscriber" (knows APP_SECRET, or no secret set = local dev)
// or "free". AI routes require subscriber; the rest are open but rate-limited per IP for free traffic.
// Owner mode: a token from POST /api/owner/unlock (or the raw passphrase on older devices) in
// x-app-key. Wrong keys count as guesses; 3 from one IP or device = 24 h lockout (lib/owner.js).
app.use("/api", (req, _res, next) => {
  req.tier = owner.tierFor({ key: req.get("x-app-key") || req.query.key || "", ip: req.ip, device: req.get("x-device") || "" });
  next();
});
const requireSubscriber = (req, res, next) => {
  if (req.tier === "subscriber") return next();
  res.status(401).json({ error: "This feature is for subscribers. Enter the app passphrase.", needsKey: true });
};
const freeLimiter = createLimiter({ max: 90, windowMs: 10 * 60_000 });
app.use(["/api/place", "/api/reverse", "/api/stop-from-place", "/api/schedule", "/api/routes", "/api/ping", "/api/owner/unlock", "/api/pay/quote", "/api/pay/intent", "/api/pay/confirm", "/api/pay/credit", "/api/pay/release"], limitFree(freeLimiter));

// Paid features: the owner (passphrase) always passes. Otherwise a valid route credit is needed
// (x-credit header). Without Stripe configured the passphrase is the only door, as before.
const itineraryOf = (req) => req.body?.package?.itinerary || req.body?.itinerary || req.body || {};
const requireAccess = (kind) => (req, res, next) => {
  if (req.tier === "subscriber") return next();
  if (!pay.enabled()) return res.status(401).json({ error: "This feature is for subscribers. Enter the app passphrase.", needsKey: true });
  const it = itineraryOf(req);
  try {
    req.credit = pay.verify(req.get("x-credit") || "", { start: it.start, end: it.end, arrivalTime: it.arrivalTime, deadline: it.deadline, kind });
    next();
  } catch (err) {
    if (!err.needsPayment) return next(err);
    analytics.track(req, "pay_required", err.message.slice(0, 120));
    res.status(402).json({ error: err.message, needsPayment: true, quote: priceQuote(it.arrivalTime, it.deadline) });
  }
};
// Three guards on the routes that cost Claude money, in order: the daily budget breaker (everyone,
// owner included), an hourly per-IP cap for non-owners, then the credit check with its quotas.
const budgetBreaker = (req, res, next) => {
  const b = usage.budget();
  if (!b.tripped) return next();
  analytics.track(req, "budget_tripped", `$${b.today.toFixed(2)} of $${b.limit}`);
  res.set("retry-after", String(Math.max(60, Math.round((Date.parse(b.resetsAt) - Date.now()) / 1000))));
  res.status(503).json({ error: "Deodap has done all the planning it can afford today. Try again tomorrow; nothing has been charged.", budget: b });
};
const aiLimiter = createLimiter({ max: config.aiCallsPerHour, windowMs: 3600_000 });
app.use(["/api/plan", "/api/suggest", "/api/prepare-drive", "/api/routes/describe"], budgetBreaker, limitFree(aiLimiter));
app.use("/api/routes/describe", requireAccess("publish"));
app.use("/api/plan", requireAccess("plan"));
app.use("/api/suggest", requireAccess("suggest"));
app.use("/api/prepare-drive", requireAccess("prepare"));
// A plan succeeded on a credit: count it and capture the hold the first time.
async function settleCredit(req) {
  const v = await pay.consume(req.credit);
  analytics.track(req, v.status === "captured" ? "pay_captured" : "pay_plan", `${v.id} ${v.label} ${v.price} · plan ${v.plansUsed}/${PLANS_PER_CREDIT}`);
  return v;
}
setInterval(() => { pay.sweep().then((n) => { if (n) console.log(`[pay] released ${n} expiring hold(s)`); }).catch(() => {}); }, 3600_000).unref();

// ---------- pay-per-route ----------
app.get("/api/pay/quote", h(async (req, res) => {
  res.json({ enabled: pay.enabled(), publishableKey: pay.enabled() ? config.stripe.publishableKey : null, quote: priceQuote(String(req.query.arrivalTime || ""), String(req.query.deadline || "")), plansPerCredit: PLANS_PER_CREDIT });
}));
app.post("/api/pay/intent", h(async (req, res) => {
  const { start, end, arrivalTime, deadline } = req.body || {};
  const r = await pay.createIntent({ start, end, arrivalTime, deadline, ip: req.ip });
  analytics.track(req, "pay_intent", `${r.credit.id} ${r.quote.label} ${r.quote.price}`);
  res.json(r);
}));
app.post("/api/pay/confirm", h(async (req, res) => {
  const v = await pay.confirm(req.body?.token || req.get("x-credit") || "", { receiptEmail: req.body?.receiptEmail || "" });
  analytics.track(req, `pay_${v.status}`, `${v.id} ${v.label} ${v.price}`);
  res.json(v);
}));
// Is the stored credit good for this start/end and time window? ?start=lat,lon&end=lat,lon&arrivalTime=&deadline=
app.get("/api/pay/credit", h(async (req, res) => {
  const token = req.get("x-credit") || "";
  const credit = pay.status(token);
  if (!credit) return res.status(404).json({ error: "unknown credit" });
  const pt = (s) => { const [lat, lon] = String(s || "").split(",").map(Number); return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null; };
  let usable = true, reason = null;
  try { pay.verify(token, { start: pt(req.query.start), end: pt(req.query.end), arrivalTime: String(req.query.arrivalTime || ""), deadline: String(req.query.deadline || ""), forPlan: true }); }
  catch (err) { usable = false; reason = err.message; }
  res.json({ credit, usable, reason });
}));
app.post("/api/pay/release", h(async (req, res) => {
  const v = await pay.release(req.body?.token || req.get("x-credit") || "");
  analytics.track(req, "pay_released", `${v.id} ${v.label} ${v.price}`);
  res.json(v);
}));

// Exchange the passphrase for an owner token. 401 wrong (tries left in the message), 429 locked.
app.post("/api/owner/unlock", h(async (req, res) => {
  try {
    const r = owner.unlock({ passphrase: String(req.body?.passphrase || ""), ip: req.ip, device: req.get("x-device") || "" });
    analytics.track(req, "owner_unlock", "ok");
    res.json(r);
  } catch (err) {
    analytics.track(req, err.status === 429 ? "owner_locked" : "owner_wrong", err.message.slice(0, 80));
    res.status(err.status || 500).json({ error: err.message, triesLeft: err.triesLeft ?? null, lockedUntil: err.lockedUntil ?? null });
  }
}));
app.post("/api/owner/logout", h(async (req, res) => {
  res.json({ revoked: owner.revoke(req.get("x-app-key") || "") });
}));

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
// Claude usage and cost, for pricing routes.
// Submit every public page to IndexNow (Bing, Yandex, Naver, Seznam) in one go.
app.post("/api/admin/indexnow", requireAdmin, h(async (_req, res) => {
  const urls = [...STATIC_PAGES, ...library.list().map((r) => routePages.routeUrl(r))];
  const status = await indexnow.submit(urls);
  res.json({ submitted: status ? urls.length : 0, status, ...indexnow.stats() });
}));
app.get("/api/admin/sales", requireAdmin, h(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json(pay.sales(days));
}));
// Run the research step for one place, on demand, so the admin can see it working (or why not).
app.get("/api/admin/research-test", requireAdmin, h(async (req, res) => {
  const name = String(req.query.name || "").trim().slice(0, 120);
  if (!name) throw httpError(400, "name is required");
  const t0 = Date.now();
  const facts = await claude.researchPlace({ name, area: String(req.query.area || "").slice(0, 120), interests: String(req.query.interests || "").slice(0, 120) });
  res.json({ name, facts, ms: Date.now() - t0, research: claude.researchStats(), recentErrors: claude.stats().recentErrors });
}));
app.get("/api/admin/costs", requireAdmin, h(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json({ ...usage.summary(days), budget: usage.budget() });
}));
// Shared-route moderation: list everything, delete anything.
app.get("/api/admin/routes", requireAdmin, h(async (_req, res) => {
  res.json({ routes: library.list() });
}));
app.delete("/api/admin/routes/:id", requireAdmin, h(async (req, res) => {
  const { summary } = library.get(req.params.id, { countUse: false });
  library.remove(req.params.id);
  pingIndexNow([routePages.routeUrl(summary), `${routePages.BASE}/routes`]); // IndexNow takes removed URLs too
  console.log(`[admin] deleted route ${summary.id} "${summary.title}"`);
  analytics.track(req, "admin_delete", `${summary.id} ${summary.title}`);
  res.status(204).end();
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
    owner: owner.stats(),
    pay: pay.enabled(),
    budget: usage.budget(),
    research: claude.researchStats(),
    claudeErrors: claude.stats().recentErrors,
    indexnow: indexnow.stats(),
    places: places.stats(),
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
  const nearPt = viewbox ? { lat: (viewbox.minLat + viewbox.maxLat) / 2, lon: (viewbox.minLon + viewbox.maxLon) / 2 } : undefined;
  res.json({ results: await stops.searchPlace(q, { viewbox, near: nearPt }) });
}));

// A stop from a place picked in the add-a-stop type-ahead. Body: { name, lat, lon, kind, sub }.
app.post("/api/stop-from-place", h(async (req, res) => {
  const { name, lat, lon, kind, sub } = req.body || {};
  if (!name || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) throw httpError(400, "name, lat and lon are required");
  res.json(await stops.stopFromPlace({ name: String(name).slice(0, 120), lat: Number(lat), lon: Number(lon), kind: String(kind || ""), sub: String(sub || "").slice(0, 160) }));
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
    if (result && req.credit) result.credit = await settleCredit(req);
    if (result) res.json(result);
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded && !ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  try {
    const result = await plan.runPlan(input, { emit: send, signal: ac.signal });
    done(result);
    if (result && req.credit) send("credit", await settleCredit(req));
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

// Draft the public title + description for the publish form. Body: { itinerary }. Cached per set of stops.
const listingCache = new Map(); // key → { title, description, source }
app.post("/api/routes/describe", h(async (req, res) => {
  const it = req.body?.itinerary;
  if (!it?.start || !it?.end || !Array.isArray(it.stops) || !it.stops.length) throw httpError(400, "itinerary with stops is required");
  const key = JSON.stringify([it.start.label, it.end.label, it.stops.map((s) => s.name)]);
  if (!req.query.again && listingCache.has(key)) return res.json({ ...listingCache.get(key), cached: true });
  let region = "";
  try {
    const r = await nominatim.reverse(it.start.lat, it.start.lon, 10);
    region = [r?.address?.city || r?.address?.town || r?.address?.county, r?.address?.state, r?.address?.country_code?.toUpperCase()].filter(Boolean).join(", ");
  } catch { /* optional */ }
  let listing;
  try {
    listing = shapeListing(await claude.describeRoute({ itinerary: it, region }), it, region);
  } catch (err) {
    console.warn("[describe] Claude failed, using the fallback:", err.message);
    listing = fallbackListing(it, region);
  }
  if (listingCache.size > 200) listingCache.delete(listingCache.keys().next().value);
  listingCache.set(key, listing);
  analytics.track(req, "describe", listing.source);
  res.json(listing);
}));

// Publish (subscriber). Body: { package, title, description }. Region is derived from the start point.
app.post("/api/routes", requireAccess("publish"), h(async (req, res) => {
  const { package: pkg, title, description } = req.body || {};
  if (!pkg) throw httpError(400, "package is required");
  let region = "";
  try {
    const r = await nominatim.reverse(pkg.itinerary.start.lat, pkg.itinerary.start.lon, 10);
    region = [r?.address?.city || r?.address?.town || r?.address?.county, r?.address?.state, r?.address?.country_code?.toUpperCase()].filter(Boolean).join(", ");
  } catch { /* region is optional */ }
  const summary = library.publish({ pkg, title, description, region, author: "subscriber" });
  console.log(`[library] published ${summary.id} "${summary.title}" (${summary.stopsCount} stops, ${summary.region})`);
  pingIndexNow([routePages.routeUrl(summary), `${routePages.BASE}/routes`, `${routePages.BASE}/sitemap.xml`]);
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
  const credit = req.credit ? pay.consumeQuota(req.credit, "suggest") : undefined;
  res.json({ candidates: grounded.filter((s) => !existing.has(s.name.toLowerCase()) && !existing.has((s.wikipediaTitle || "").toLowerCase())).slice(0, n), credit });
}));

// Narration package for drive mode. Streams progress events with Accept: text/event-stream.
app.post("/api/prepare-drive", h(async (req, res) => {
  const { itinerary } = req.body || {};
  if (!itinerary?.start || !itinerary?.end) throw httpError(400, "itinerary with start and end is required");

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) { ac.abort(); console.log("[prepare-drive] cancelled by client"); } });

  const t0 = Date.now();
  const done = (pkg) => {
    analytics.track(req, "prepare", pkg ? `${pkg.narration.length} narrations` : "cancelled", Date.now() - t0);
    if (pkg && req.credit) pkg.credit = pay.consumeQuota(req.credit, "prepare");
  };
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

// IndexNow ownership file: the key itself, at /<key>.txt
if (config.indexNowKey) {
  app.get(`/${config.indexNowKey}.txt`, (_req, res) => res.type("text/plain").send(config.indexNowKey));
}
const STATIC_PAGES = ["/", "/plan.html", "/routes", "/terms.html", "/privacy.html"].map((p) => `${routePages.BASE}${p}`);
const pingIndexNow = (urls) => indexnow.submit(urls).then((s) => { if (s) console.log(`[indexnow] ${urls.length} url(s) → ${s}`); });

// ---------- public route pages (server-rendered, indexable) ----------
app.get("/routes", h(async (req, res) => {
  const routes = library.list();
  analytics.track(req, "route_index", `${routes.length} routes`);
  res.type("html").send(routePages.indexPage(routes));
}));
app.get("/routes/:id/:slug?", h(async (req, res) => {
  let r;
  try { r = library.get(req.params.id, { countUse: false }); } catch { return res.status(404).type("html").send(routePages.notFoundPage()); }
  const canonicalSlug = routePages.slug(r.summary.title);
  if (req.params.slug !== canonicalSlug) return res.redirect(301, `/routes/${encodeURIComponent(r.summary.id)}/${canonicalSlug}`);
  analytics.track(req, "route_page", `${r.summary.id} ${r.summary.title}`);
  res.type("html").send(routePages.routePage(r.summary, r.package));
}));
app.get("/sitemap.xml", h(async (_req, res) => {
  res.type("application/xml").send(routePages.sitemap(library.list()));
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
