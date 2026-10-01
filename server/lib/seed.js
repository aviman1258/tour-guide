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
import * as tts from "./tts.js";

// Airport starts get the 30-minute bags-and-rental-car buffer automatically (label says "Airport").
const A = (code, name, lat, lon) => ({ label: `${name} (${code})`, lat, lon });
export const STARTER_ROUTES = [
  { key: "pch-malibu", city: "Los Angeles", area: "US", start: { label: "Santa Monica Pier", lat: 34.0094, lon: -118.4973 }, end: { label: "Point Dume State Beach, Malibu", lat: 34.0014, lon: -118.8065 }, arrivalTime: "10:00", deadline: "15:00", interests: "Pacific Coast Highway scenery, beaches and ocean viewpoints, Getty Villa, Malibu landmarks and surf history" },
  { key: "oc-coast", city: "Orange County", area: "US", start: { label: "Newport Beach Pier", lat: 33.6073, lon: -117.9297 }, end: { label: "Dana Point Harbor", lat: 33.4609, lon: -117.6985 }, arrivalTime: "10:00", deadline: "15:00", interests: "coastal viewpoints, Crystal Cove, Laguna Beach art galleries and coves, beaches, harbor towns" },
  { key: "lax-hollywood", city: "Los Angeles", area: "US", start: A("LAX", "Los Angeles International Airport", 33.9425, -118.408), end: { label: "Griffith Observatory, Los Angeles", lat: 34.1184, lon: -118.3004 }, arrivalTime: "11:30", deadline: "16:30", interests: "Hollywood landmarks, Sunset Strip, movie and music history, iconic viewpoints of the city" },
  { key: "anaheim-balboa", city: "Orange County", area: "US", start: { label: "Disneyland Hotel, Anaheim", lat: 33.8095, lon: -117.9227 }, end: { label: "Balboa Island, Newport Beach", lat: 33.6062, lon: -117.8968 }, arrivalTime: "10:00", deadline: "15:00", interests: "family-friendly sights, harbor and beach, Balboa Fun Zone, local ice cream, Newport Beach landmarks" },
  { key: "dtla-pasadena", city: "Los Angeles", area: "US", start: { label: "Union Station, Los Angeles", lat: 34.0561, lon: -118.2365 }, end: { label: "Old Pasadena", lat: 34.1458, lon: -118.1508 }, arrivalTime: "10:00", deadline: "15:00", interests: "historic architecture, Arts District murals, Dodger Stadium overlook, Rose Bowl, Gamble House, Old Pasadena" },
  { key: "san-lajolla", city: "San Diego", area: "US", start: A("SAN", "San Diego International Airport", 32.7336, -117.19), end: { label: "La Jolla Cove", lat: 32.8503, lon: -117.2727 }, arrivalTime: "11:30", deadline: "16:30", interests: "Coronado and the Hotel del Coronado, Point Loma and Cabrillo, Sunset Cliffs, La Jolla Cove and its sea lions" },
  { key: "sfo-wharf", city: "San Francisco", area: "US", start: A("SFO", "San Francisco International Airport", 37.6198, -122.3748), end: { label: "Fisherman's Wharf, San Francisco", lat: 37.808, lon: -122.4177 }, arrivalTime: "11:30", deadline: "16:30", interests: "Twin Peaks viewpoint, Painted Ladies, Haight-Ashbury, Golden Gate Bridge vista point, the Presidio, historic landmarks" },
  { key: "las-redrock", city: "Las Vegas", area: "US", start: A("LAS", "Harry Reid International Airport", 36.0834, -115.1518), end: { label: "Red Rock Canyon Visitor Center", lat: 36.1357, lon: -115.4275 }, arrivalTime: "11:30", deadline: "17:00", interests: "the Strip and its landmarks, Fremont Street, Las Vegas history, Red Rock Canyon scenic loop viewpoints" },
  { key: "mia-southbeach", city: "Miami", area: "US", start: A("MIA", "Miami International Airport", 25.796, -80.2898), end: { label: "Ocean Drive, Miami Beach", lat: 25.7806, lon: -80.13 }, arrivalTime: "11:30", deadline: "16:30", interests: "Little Havana and Calle Ocho, Cuban coffee, Wynwood Walls murals, the Art Deco district, Ocean Drive" },
  { key: "ord-navypier", city: "Chicago", area: "US", start: A("ORD", "Chicago O'Hare International Airport", 41.9786, -87.9048), end: { label: "Navy Pier, Chicago", lat: 41.8917, lon: -87.6086 }, arrivalTime: "11:30", deadline: "16:30", interests: "Chicago architecture, Lake Shore Drive skyline views, Lincoln Park, Wrigley Field, Millennium Park" },
  { key: "sav-tybee", city: "Savannah", area: "US", start: A("SAV", "Savannah Hilton Head International Airport", 32.1266, -81.2), end: { label: "Tybee Island Light Station", lat: 32.0222, lon: -80.8457 }, arrivalTime: "11:30", deadline: "17:00", interests: "the historic squares of Savannah, Forsyth Park, Bonaventure Cemetery, colonial and Civil War history, Tybee Island" },
  { key: "bna-bellemeade", city: "Nashville", area: "US", start: A("BNA", "Nashville International Airport", 36.1245, -86.6782), end: { label: "Belle Meade Historic Site, Nashville", lat: 36.105, lon: -86.862 }, arrivalTime: "11:30", deadline: "16:30", interests: "country music history, Music Row, Broadway honky-tonks, the Ryman Auditorium, Belle Meade, historic neighborhoods" },
];

// More cities, each with a highlights drive and one built around what the city is known for.
const P = (lat, lon, label) => ({ label, lat, lon });
const R = (key, city, area, start, end, arrivalTime, deadline, interests) => ({ key, city, area, start, end, arrivalTime, deadline, interests });
STARTER_ROUTES.push(
  // ----- United States -----
  R("nyc-highlights", "New York", "US", A("JFK", "John F. Kennedy International Airport", 40.6413, -73.7781), P(40.7681, -73.9819, "Columbus Circle, Central Park"), "11:30", "17:00", "iconic Manhattan landmarks, Brooklyn Bridge, Statue of Liberty views, Times Square, skyscrapers, Central Park"),
  R("nyc-food", "New York", "US", P(40.6962, -73.9969, "Brooklyn Heights Promenade"), P(40.81, -73.95, "Apollo Theater, Harlem"), "10:00", "15:00", "neighborhood food culture, Brooklyn, Chinatown and Little Italy, Greenwich Village jazz, Harlem soul food and music history"),
  R("dc-highlights", "Washington, DC", "US", A("DCA", "Ronald Reagan Washington National Airport", 38.8512, -77.0402), P(38.8893, -77.0502, "Lincoln Memorial"), "11:30", "16:30", "monuments and memorials, the Capitol, the White House, Smithsonian museums, Arlington"),
  R("dc-history", "Washington, DC", "US", P(38.8977, -77.0063, "Union Station, Washington"), P(38.9019, -77.059, "Georgetown Waterfront"), "10:00", "15:00", "political history, Embassy Row, Dupont Circle, U Street jazz history, historic Georgetown"),
  R("bos-highlights", "Boston", "US", A("BOS", "Boston Logan International Airport", 42.3656, -71.0096), P(42.3732, -71.1189, "Harvard Square, Cambridge"), "11:30", "16:30", "Freedom Trail sites, Revolutionary War history, Beacon Hill, Back Bay, harbor views, Harvard"),
  R("bos-salem", "Boston", "US", P(42.36, -71.0545, "Faneuil Hall, Boston"), P(42.5235, -70.8914, "Salem Witch Museum"), "10:00", "15:30", "maritime history, New England seafood, coastal towns, Salem witch trials history"),
  R("msy-highlights", "New Orleans", "US", A("MSY", "Louis Armstrong New Orleans International Airport", 29.9934, -90.258), P(29.9575, -90.063, "Jackson Square, New Orleans"), "11:30", "16:30", "French Quarter, Garden District mansions, jazz history, St. Charles streetcar, historic cemeteries"),
  R("nola-music", "New Orleans", "US", P(29.964, -90.0575, "Frenchmen Street, New Orleans"), P(29.9932, -90.0966, "City Park, New Orleans"), "10:00", "15:00", "jazz and blues history, Creole and Cajun food, po'boys and beignets, Tremé, Mardi Gras culture"),
  R("sea-highlights", "Seattle", "US", A("SEA", "Seattle-Tacoma International Airport", 47.4502, -122.3088), P(47.6205, -122.3493, "Space Needle"), "11:30", "16:30", "Pike Place Market, the waterfront, Pioneer Square, views of Mount Rainier and Puget Sound"),
  R("sea-music", "Seattle", "US", P(47.6253, -122.3222, "Capitol Hill, Seattle"), P(47.651, -122.3473, "Fremont Troll"), "10:00", "14:30", "coffee culture, grunge and music history, quirky neighborhoods, Lake Union houseboats, Gas Works Park"),
  R("aus-highlights", "Austin", "US", A("AUS", "Austin-Bergstrom International Airport", 30.1975, -97.6664), P(30.2747, -97.7404, "Texas State Capitol"), "11:30", "16:30", "Texas Capitol, Congress Avenue bat colony, Lady Bird Lake, South Congress, University of Texas"),
  R("aus-music", "Austin", "US", P(30.2495, -97.75, "South Congress Avenue, Austin"), P(30.3509, -97.7859, "Pennybacker Bridge overlook"), "11:00", "16:00", "live music venues, Texas barbecue, food trucks, swimming holes, Hill Country views"),
  R("den-highlights", "Denver", "US", A("DEN", "Denver International Airport", 39.8561, -104.6737), P(39.6654, -105.2057, "Red Rocks Amphitheatre"), "11:30", "17:00", "Denver landmarks, LoDo and Union Station, the mile-high Capitol steps, Red Rocks"),
  R("den-mountains", "Denver", "US", P(39.7527, -105.0003, "Union Station, Denver"), P(39.999, -105.2817, "Chautauqua Park, Boulder"), "10:00", "15:30", "Rocky Mountain viewpoints, craft breweries, Golden and Boulder, hiking trailheads"),
  R("chs-highlights", "Charleston", "US", A("CHS", "Charleston International Airport", 32.8986, -80.0405), P(32.77, -79.93, "The Battery, Charleston"), "11:30", "16:30", "historic downtown, Rainbow Row, antebellum homes, Fort Sumter views, Civil War and Gullah history"),
  R("chs-lowcountry", "Charleston", "US", P(32.781, -79.931, "Charleston City Market"), P(32.6552, -79.9404, "Folly Beach"), "10:00", "15:00", "Lowcountry food, shrimp and grits, marsh and live-oak scenery, Angel Oak, beaches"),
  R("phl-highlights", "Philadelphia", "US", A("PHL", "Philadelphia International Airport", 39.8744, -75.2424), P(39.9656, -75.181, "Philadelphia Museum of Art"), "11:30", "16:30", "Independence Hall, the Liberty Bell, Old City, the Rocky Steps, cheesesteaks"),
  R("phl-art", "Philadelphia", "US", P(39.9533, -75.159, "Reading Terminal Market"), P(40.0262, -75.224, "Main Street, Manayunk"), "10:00", "15:00", "Mural Arts, Philadelphia's Magic Gardens, the Italian Market, the cheesesteak rivalry, Fishtown"),
  R("hnl-highlights", "Honolulu", "US", A("HNL", "Daniel K. Inouye International Airport", 21.3245, -157.9251), P(21.2614, -157.8059, "Diamond Head State Monument"), "11:30", "16:30", "Pearl Harbor, Iolani Palace, Waikiki, Hawaiian history"),
  R("hnl-northshore", "Honolulu", "US", P(21.276, -157.827, "Waikiki Beach"), P(21.5928, -158.1031, "Haleiwa, North Shore"), "09:00", "15:00", "surf culture, beaches and lookouts, Hawaiian food and shave ice, the North Shore"),
  // ----- International -----
  R("lhr-highlights", "London", "International", A("LHR", "London Heathrow Airport", 51.47, -0.4543), P(51.5055, -0.0754, "Tower Bridge, London"), "11:30", "17:00", "Buckingham Palace, Westminster and Big Ben, St Paul's Cathedral, the Thames, the Tower of London"),
  R("ldn-literary", "London", "International", P(51.5194, -0.127, "British Museum, London"), P(51.5713, -0.1676, "Kenwood House, Hampstead Heath"), "10:00", "15:00", "literary London, historic pubs, Bloomsbury, Camden markets, Hampstead"),
  R("cdg-highlights", "Paris", "International", A("CDG", "Paris Charles de Gaulle Airport", 49.0097, 2.5479), P(48.8584, 2.2945, "Eiffel Tower, Paris"), "11:30", "17:00", "Notre-Dame, the Louvre, the Champs-Élysées and Arc de Triomphe, Seine bridges, the Eiffel Tower"),
  R("paris-art", "Paris", "International", P(48.8867, 2.3431, "Sacré-Cœur, Montmartre"), P(48.86, 2.3266, "Musée d'Orsay, Paris"), "10:00", "15:00", "painters' Paris, Montmartre, the cafés of Saint-Germain, the Marais, bakeries"),
  R("fco-highlights", "Rome", "International", A("FCO", "Rome Fiumicino Airport", 41.8003, 12.2389), P(41.9022, 12.4573, "St. Peter's Square, Vatican City"), "11:30", "17:00", "the Colosseum, the Roman Forum, the Pantheon, Trevi Fountain, ancient Rome"),
  R("rome-food", "Rome", "International", P(41.8897, 12.47, "Trastevere, Rome"), P(41.859, 12.511, "Catacombs of San Callisto"), "10:00", "15:00", "Roman food, Trastevere, Testaccio market, the Appian Way, the catacombs"),
  R("bcn-highlights", "Barcelona", "International", A("BCN", "Barcelona El Prat Airport", 41.2974, 2.0833), P(41.4145, 2.1527, "Park Güell, Barcelona"), "11:30", "17:00", "Gaudí architecture, the Sagrada Família, the Gothic Quarter, La Rambla, Montjuïc"),
  R("bcn-coast", "Barcelona", "International", P(41.3784, 2.1925, "Barceloneta Beach"), P(41.235, 1.811, "Sitges seafront"), "10:00", "15:30", "Mediterranean beaches, tapas and vermouth, Catalan culture, coastal views"),
  R("hnd-highlights", "Tokyo", "International", A("HND", "Tokyo Haneda Airport", 35.5494, 139.7798), P(35.7148, 139.7967, "Senso-ji, Asakusa"), "11:30", "17:00", "Tokyo Tower, the Imperial Palace, Shibuya Crossing, Meiji Shrine, Senso-ji"),
  R("tokyo-pop", "Tokyo", "International", P(35.6984, 139.7731, "Akihabara, Tokyo"), P(35.6618, 139.668, "Shimokitazawa, Tokyo"), "10:00", "15:00", "anime and pop culture, Harajuku fashion, ramen and izakaya streets, retro Tokyo"),
  R("dxb-highlights", "Dubai", "International", A("DXB", "Dubai International Airport", 25.2532, 55.3657), P(25.1412, 55.1853, "Burj Al Arab, Dubai"), "14:00", "19:00", "the Burj Khalifa, Dubai Creek, old Dubai souks, Palm Jumeirah, the Burj Al Arab"),
  R("dubai-desert", "Dubai", "International", P(25.08, 55.14, "Dubai Marina"), P(24.837, 55.372, "Al Qudra Lakes"), "14:00", "19:00", "desert landscapes, modern architecture, camel racing, a desert sunset"),
  R("bom-highlights", "Mumbai", "International", A("BOM", "Chhatrapati Shivaji Maharaj International Airport", 19.0896, 72.8656), P(18.922, 72.8347, "Gateway of India, Mumbai"), "11:30", "17:00", "the Gateway of India, Marine Drive, colonial architecture, Chhatrapati Shivaji Terminus, Bandra"),
  R("mumbai-food", "Mumbai", "International", P(19.0988, 72.8267, "Juhu Beach, Mumbai"), P(18.9474, 72.8346, "Crawford Market, Mumbai"), "10:00", "15:00", "Bollywood, street food, Dhobi Ghat, temples, markets"),
  R("syd-highlights", "Sydney", "International", A("SYD", "Sydney Kingsford Smith Airport", -33.9399, 151.1753), P(-33.8568, 151.2153, "Sydney Opera House"), "11:30", "16:30", "the Opera House, the Harbour Bridge, The Rocks, Bondi Beach"),
  R("syd-beaches", "Sydney", "International", P(-33.8908, 151.2743, "Bondi Beach"), P(-33.5803, 151.329, "Barrenjoey Lighthouse, Palm Beach"), "09:00", "15:00", "beaches and surf culture, coastal lookouts, the Northern Beaches"),
  R("yyz-highlights", "Toronto", "International", A("YYZ", "Toronto Pearson International Airport", 43.6777, -79.6248), P(43.6426, -79.3871, "CN Tower, Toronto"), "11:30", "16:30", "the CN Tower, the Distillery District, Kensington Market, Casa Loma, the waterfront"),
  R("tor-niagara", "Toronto", "International", P(43.6426, -79.3871, "CN Tower, Toronto"), P(43.0896, -79.0849, "Niagara Falls"), "09:00", "16:00", "Niagara wine country, Niagara-on-the-Lake, lakeshore towns, Niagara Falls"),
  R("mex-highlights", "Mexico City", "International", A("MEX", "Mexico City International Airport", 19.4361, -99.0719), P(19.4204, -99.1819, "Chapultepec Castle, Mexico City"), "11:30", "16:30", "the Zócalo, Templo Mayor, Palacio de Bellas Artes, Paseo de la Reforma, Chapultepec"),
  R("mex-art", "Mexico City", "International", P(19.3551, -99.1625, "Frida Kahlo Museum, Coyoacán"), P(19.2856, -99.1032, "Cuemanco, Xochimilco"), "10:00", "15:00", "Frida Kahlo and Diego Rivera, murals, tacos and markets, Coyoacán, the Xochimilco canals"),
  R("lis-highlights", "Lisbon", "International", A("LIS", "Lisbon Humberto Delgado Airport", 38.7742, -9.1342), P(38.6916, -9.216, "Belém Tower, Lisbon"), "11:30", "16:30", "Alfama, São Jorge Castle, the Baixa, the Belém monuments, pastéis de nata"),
  R("lis-coast", "Lisbon", "International", P(38.6916, -9.216, "Belém Tower, Lisbon"), P(38.7804, -9.4989, "Cabo da Roca"), "10:00", "16:00", "the Atlantic coast, Cascais, Sintra's palaces, seafood"),
);

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
export const status = () => {
  const published = library.list();
  return { ...job, presets: STARTER_ROUTES.map((r) => ({ key: r.key, city: r.city, area: r.area, start: r.start.label, end: r.end.label, window: `${r.arrivalTime}–${r.deadline}`, published: Boolean(alreadyPublished(r, published)) })) };
};

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
    // stop at the daily caps instead of half-making routes: no Claude left, or no voice left (a route
    // published without its recorded voice would stay on the phone voice for good)
    const b = usage.budget();
    if (b.tripped || (b.limit > 0 && b.today + 0.9 > b.limit)) { job.failed.push({ key: spec.key, name, error: `daily Claude budget nearly used ($${b.today.toFixed(2)} of $${b.limit}); press the button again tomorrow` }); continue; }
    if (tts.enabled()) { const v = tts.budget(); if (v.tripped || (v.limit > 0 && v.today + 0.25 > v.limit)) { job.failed.push({ key: spec.key, name, error: `daily voice budget nearly used ($${v.today.toFixed(2)} of $${v.limit}); press the button again tomorrow` }); continue; } }
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
