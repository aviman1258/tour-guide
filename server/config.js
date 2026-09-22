// Environment + constants. Everything env-driven is read once here.

const contact = process.env.CONTACT || "tour-guide dev";

function parseRates(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return Object.keys(o).length && Object.values(o).every((r) => Number.isFinite(r.in) && Number.isFinite(r.out)) ? o : null;
  } catch { return null; }
}

export const config = {
  port: Number(process.env.PORT) || 3001,

  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  // When set, every /api route except /api/health needs `x-app-key: <secret>` (hosted deployments).
  appSecret: process.env.APP_SECRET || "",
  // Separate password for the /admin usage dashboard. Empty = admin disabled.
  adminSecret: process.env.ADMIN_SECRET || "",
  // Fall back to a cached ipwho.is lookup for visitor location when Cloudflare headers are absent.
  geoLookup: (process.env.GEO_LOOKUP ?? "1") !== "0",
  // Proxy hops between the visitor and this process. Render's edge runs through Cloudflare, so
  // X-Forwarded-For arrives as "visitor, cloudflare-edge" = 2 hops. Add one more if you also proxy
  // your own domain through Cloudflare. Wrong value = every visitor logged (and rate-limited) as the proxy.
  trustProxy: Number(process.env.TRUST_PROXY ?? "2"),
  // USD per million tokens {in, out}, keyed by model id or a fragment of it. Used only to price the
  // usage log for the admin cost panel. Defaults are placeholders: verify in the Anthropic console.
  claudeRates: parseRates(process.env.CLAUDE_RATES) || { "claude-opus-5": { in: 5, out: 25 }, "claude-haiku-4-5": { in: 1, out: 5 } },
  claudeRatesFromEnv: Boolean(parseRates(process.env.CLAUDE_RATES)),
  // Daily Claude spend (USD, by the rates above) after which AI routes refuse until midnight UTC. 0 = off.
  dailyClaudeBudgetUsd: Number(process.env.DAILY_CLAUDE_BUDGET_USD ?? "25"),
  // AI calls (plan / suggest / prepare) per IP per hour for non-owners, on top of per-credit quotas.
  aiCallsPerHour: Number(process.env.AI_CALLS_PER_HOUR ?? "20"),
  // Stripe (pay-per-route). All three empty = payments off; the passphrase is then the only door.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  },
  modelStrong: process.env.MODEL_STRONG || "claude-opus-5",
  modelFast: process.env.MODEL_FAST || "claude-haiku-4-5",

  osrmBase: (process.env.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/$/, ""),
  // Valhalla supports avoid-tolls / avoid-highways and spoken turn instructions; OSRM is the fallback.
  valhallaBase: (process.env.VALHALLA_BASE_URL || "https://valhalla1.openstreetmap.de").replace(/\/$/, ""),
  wikiRestBase: "https://en.wikipedia.org/api/rest_v1",
  wikiApiBase: "https://en.wikipedia.org/w/api.php",
  nominatimBase: "https://nominatim.openstreetmap.org",

  // Wikimedia and OSM both require an identifying User-Agent with contact info.
  userAgent: `TourGuide/0.1 (${contact}) node-fetch`,

  // Itinerary defaults (minutes)
  departBufferMinutes: 30, // bags, rental car, getting out of the airport
  safetyBufferMinutes: 15, // arrive at the hotel this early
  minStopsAfterTrim: 1, // never trim below this many stops
  compressBelowStops: 6, // with fewer stops than this, shorten stays before dropping more
  maxCorridorKm: 120, // drop candidates farther than this from the corridor center

  // Politeness
  nominatimMinIntervalMs: 1100,
  osrmMinIntervalMs: 1100,
  wikiConcurrency: 2, // Wikimedia starts sending 429s when we burst; 2 in flight is safe
  wikiRetryDelayMs: 35000, // Wikimedia's Retry-After is 30-60 s; wait it out once rather than lose the stop
  httpTimeoutMs: 12000,
};
