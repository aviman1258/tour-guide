import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { httpError } from "./lib/http.js";
import { bbox } from "./lib/geo.js";
import * as stops from "./stops.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const app = express();
app.use(express.json({ limit: "2mb" }));

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

app.use(express.static(WEB_DIR, { extensions: ["html"] }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`tour-guide listening on http://localhost:${config.port} (claude via ${config.anthropicKey ? "sdk" : "cli"})`);
});
