// Environment + constants. Everything env-driven is read once here.

const contact = process.env.CONTACT || "tour-guide dev";

export const config = {
  port: Number(process.env.PORT) || 3001,

  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  // When set, every /api route except /api/health needs `x-app-key: <secret>` (hosted deployments).
  appSecret: process.env.APP_SECRET || "",
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
