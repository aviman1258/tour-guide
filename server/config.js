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
  // Research before narration: web search (Anthropic's server tool, ~1¢ a search) for stops whose
  // Wikipedia + website material is thin. Off with RESEARCH_WEB_SEARCH=0. Model for that call:
  modelResearch: process.env.MODEL_RESEARCH || process.env.MODEL_FAST || "claude-haiku-4-5",
  researchWebSearch: (process.env.RESEARCH_WEB_SEARCH ?? "1") !== "0",
  researchMaxSearches: Number(process.env.RESEARCH_MAX_SEARCHES ?? "3"),
  // Optional Google Places API (New) key: last-resort search for small local places the free
  // sources don't know. Empty = off.
  googlePlacesKey: process.env.GOOGLE_PLACES_KEY || "",
  // Deodap's voice: Google Cloud Text-to-Speech clips for the narration, made at prepare time.
  // Uses GOOGLE_TTS_KEY, or the Places key when that one is allowed to call the Text-to-Speech API.
  // No key = the phone's own voice reads everything. TTS_ENABLED=0 turns it off with a key present.
  tts: {
    key: process.env.GOOGLE_TTS_KEY || process.env.GOOGLE_PLACES_KEY || "",
    keySource: process.env.GOOGLE_TTS_KEY ? "GOOGLE_TTS_KEY" : process.env.GOOGLE_PLACES_KEY ? "GOOGLE_PLACES_KEY" : "",
    enabled: (process.env.TTS_ENABLED ?? "1") !== "0",
    voice: process.env.TTS_VOICE || "en-US-Chirp3-HD-Aoede",
    speakingRate: Number(process.env.TTS_SPEAKING_RATE ?? "1") || 1,
    ratePerMChars: Number(process.env.TTS_RATE_PER_M_CHARS ?? "30"), // USD per million characters (Chirp 3 HD list price)
    dailyBudgetUsd: Number(process.env.DAILY_TTS_BUDGET_USD ?? "5"),
  },
  // IndexNow key (any 8-128 hex/letters; served at /<key>.txt). Empty = no search-engine pings.
  indexNowKey: String(process.env.INDEXNOW_KEY || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 128),
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
  // Sign-in emails (Resend). Without a key a production server can't sign people in; a dev server
  // hands the link back to the page instead. MAIL_FROM must be on a domain verified in Resend.
  mail: { resendKey: process.env.RESEND_API_KEY || "", from: process.env.MAIL_FROM || "Deodapper <no-reply@deodapper.com>" },
  publicBase: (process.env.PUBLIC_BASE_URL || "https://deodapper.com").replace(/\/$/, ""),
  production: process.env.NODE_ENV === "production",
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
