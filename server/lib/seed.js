// Starter routes: a server-side job that plans, narrates, records and publishes a list of routes
// one after another, started from the admin page. Each one is exactly what a subscriber would get
// pressing Plan → Prepare drive → Publish, so the library fills with real, drivable, narrated
// routes without anyone clicking through twelve times. Runs in the background; GET status polls it.
// Re-running is safe: a route whose start and end are already published is skipped.

import * as plan from "../plan.js";
import * as narrate from "../narrate.js";
import * as claude from "../claude.js";
import * as library from "./library.js";
import * as usage from "./usage.js";
import * as nominatim from "../nominatim.js";
import { shapeListing, fallbackListing } from "./describe.js";

// Airport starts get the 30-minute bags-and-rental-car buffer automatically (label says "Airport").
const A = (code, name, lat, lon) => ({ label: `${name} (${code})`, lat, lon });
export const STARTER_ROUTES = [
  { key: "pch-malibu", start: { label: "Santa Monica Pier", lat: 34.0094, lon: -118.4973 }, end: { label: "Point Dume State Beach, Malibu", lat: 34.0014, lon: -118.8065 }, arrivalTime: "10:00", deadline: "15:00", interests: "Pacific Coast Highway scenery, beaches and ocean viewpoints, Getty Villa, Malibu landmarks and surf history" },
  { key: "oc-coast", start: { label: "Newport Beach Pier", lat: 33.6073, lon: -117.9297 }, end: { label: "Dana Point Harbor", lat: 33.4609, lon: -117.6985 }, arrivalTime: "10:00", deadline: "15:00", interests: "coastal viewpoints, Crystal Cove, Laguna Beach art galleries and coves, beaches, harbor towns" },
  { key: "lax-hollywood", start: A("LAX", "Los Angeles International Airport", 33.9425, -118.408), end: { label: "Griffith Observatory, Los Angeles", lat: 34.1184, lon: -118.3004 }, arrivalTime: "11:30", deadline: "16:30", interests: "Hollywood landmarks, Sunset Strip, movie and music history, iconic viewpoints of the city" },
  { key: "anaheim-balboa", start: { label: "Disneyland Hotel, Anaheim", lat: 33.8095, lon: -117.9227 }, end: { label: "Balboa Island, Newport Beach", lat: 33.6062, lon: -117.8968 }, arrivalTime: "10:00", deadline: "15:00", interests: "family-friendly sights, harbor and beach, Balboa Fun Zone, local ice cream, Newport Beach landmarks" },
  { key: "dtla-pasadena", start: { label: "Union Station, Los Angeles", lat: 34.0561, lon: -118.2365 }, end: { label: "Old Pasadena", lat: 34.1458, lon: -118.1508 }, arrivalTime: "10:00", deadline: "15:00", interests: "historic architecture, Arts District murals, Dodger Stadium overlook, Rose Bowl, Gamble House, Old Pasadena" },
  { key: "san-lajolla", start: A("SAN", "San Diego International Airport", 32.7336, -117.19), end: { label: "La Jolla Cove", lat: 32.8503, lon: -117.2727 }, arrivalTime: "11:30", deadline: "16:30", interests: "Coronado and the Hotel del Coronado, Point Loma and Cabrillo, Sunset Cliffs, La Jolla Cove and its sea lions" },
  { key: "sfo-wharf", start: A("SFO", "San Francisco International Airport", 37.6198, -122.3748), end: { label: "Fisherman's Wharf, San Francisco", lat: 37.808, lon: -122.4177 }, arrivalTime: "11:30", deadline: "16:30", interests: "Twin Peaks viewpoint, Painted Ladies, Haight-Ashbury, Golden Gate Bridge vista point, the Presidio, historic landmarks" },
  { key: "las-redrock", start: A("LAS", "Harry Reid International Airport", 36.0834, -115.1518), end: { label: "Red Rock Canyon Visitor Center", lat: 36.1357, lon: -115.4275 }, arrivalTime: "11:30", deadline: "17:00", interests: "the Strip and its landmarks, Fremont Street, Las Vegas history, Red Rock Canyon scenic loop viewpoints" },
  { key: "mia-southbeach", start: A("MIA", "Miami International Airport", 25.796, -80.2898), end: { label: "Ocean Drive, Miami Beach", lat: 25.7806, lon: -80.13 }, arrivalTime: "11:30", deadline: "16:30", interests: "Little Havana and Calle Ocho, Cuban coffee, Wynwood Walls murals, the Art Deco district, Ocean Drive" },
  { key: "ord-navypier", start: A("ORD", "Chicago O'Hare International Airport", 41.9786, -87.9048), end: { label: "Navy Pier, Chicago", lat: 41.8917, lon: -87.6086 }, arrivalTime: "11:30", deadline: "16:30", interests: "Chicago architecture, Lake Shore Drive skyline views, Lincoln Park, Wrigley Field, Millennium Park" },
  { key: "sav-tybee", start: A("SAV", "Savannah Hilton Head International Airport", 32.1266, -81.2), end: { label: "Tybee Island Light Station", lat: 32.0222, lon: -80.8457 }, arrivalTime: "11:30", deadline: "17:00", interests: "the historic squares of Savannah, Forsyth Park, Bonaventure Cemetery, colonial and Civil War history, Tybee Island" },
  { key: "bna-bellemeade", start: A("BNA", "Nashville International Airport", 36.1245, -86.6782), end: { label: "Belle Meade Historic Site, Nashville", lat: 36.105, lon: -86.862 }, arrivalTime: "11:30", deadline: "16:30", interests: "country music history, Music Row, Broadway honky-tonks, the Ryman Auditorium, Belle Meade, historic neighborhoods" },
];

/** The coming Saturday (or the one after, if today is Saturday), as YYYY-MM-DD: a real day for traffic and weather. */
export function nextSaturday(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
/** Already in the library? Same start and end labels (ignoring codes in brackets). */
export function alreadyPublished(spec, published = library.list()) {
  return published.find((r) => norm(r.startLabel) === norm(spec.start.label) && norm(r.endLabel) === norm(spec.end.label)) || null;
}

const job = { running: false, startedAt: null, finishedAt: null, current: null, done: [], failed: [], skipped: [], total: 0 };
export const status = () => ({ ...job, presets: STARTER_ROUTES.map((r) => ({ key: r.key, start: r.start.label, end: r.end.label, window: `${r.arrivalTime}–${r.deadline}`, published: Boolean(alreadyPublished(r)) })) });

/**
 * Start the job for the given preset keys (or custom specs). Throws 409 while one is running.
 * `deps.publish(pkg, title, description, region)` does the library write + IndexNow ping, so this
 * module never needs the web server's plumbing; `deps.log` is optional.
 */
export function start(keys, deps) {
  if (job.running) { const e = new Error("A seed job is already running."); e.status = 409; throw e; }
  const specs = STARTER_ROUTES.filter((r) => !keys?.length || keys.includes(r.key));
  if (!specs.length) { const e = new Error("no routes selected"); e.status = 400; throw e; }
  Object.assign(job, { running: true, startedAt: new Date().toISOString(), finishedAt: null, current: null, done: [], failed: [], skipped: [], total: specs.length });
  run(specs, deps).catch((err) => deps.log?.(`seed job crashed: ${err.message}`)).finally(() => { job.running = false; job.current = null; job.finishedAt = new Date().toISOString(); });
  return status();
}

async function run(specs, deps) {
  const log = deps.log || (() => {});
  const date = nextSaturday();
  for (const spec of specs) {
    const name = `${spec.start.label} → ${spec.end.label}`;
    const existing = alreadyPublished(spec);
    if (existing) { job.skipped.push({ key: spec.key, name, id: existing.id, title: existing.title }); continue; }
    if (usage.budget().tripped) { job.failed.push({ key: spec.key, name, error: "daily Claude budget reached; run again tomorrow" }); continue; }
    job.current = { key: spec.key, name, phase: "plan", since: new Date().toISOString() };
    const t0 = Date.now();
    try {
      const input = plan.parsePlanInput({ start: spec.start, end: spec.end, date, arrivalTime: spec.arrivalTime, deadline: spec.deadline, interests: spec.interests, routeOptions: { avoidTolls: false, avoidHighways: false } });
      const it = await plan.runPlan(input);
      if (!it?.stops?.length) throw new Error("planning found no stops");
      job.current.phase = "narrate";
      const pkg = await narrate.prepareDrive(it);
      job.current.phase = "publish";
      let region = "";
      try {
        const r = await nominatim.reverse(it.start.lat, it.start.lon, 10);
        region = [r?.address?.city || r?.address?.town || r?.address?.county, r?.address?.state, r?.address?.country_code?.toUpperCase()].filter(Boolean).join(", ");
      } catch { /* optional */ }
      let listing;
      try { listing = shapeListing(await claude.describeRoute({ itinerary: pkg.itinerary, region }), pkg.itinerary, region); }
      catch { listing = fallbackListing(pkg.itinerary, region); }
      const summary = await deps.publish(pkg, listing.title, listing.description, region);
      job.done.push({ key: spec.key, name, id: summary.id, title: summary.title, stops: summary.stopsCount, narrations: summary.narrationCount, seconds: Math.round((Date.now() - t0) / 1000) });
      log(`seeded ${summary.id} "${summary.title}" in ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) {
      job.failed.push({ key: spec.key, name, error: err.message.slice(0, 200), seconds: Math.round((Date.now() - t0) / 1000) });
      log(`seed failed for ${name}: ${err.message}`);
    }
  }
}
