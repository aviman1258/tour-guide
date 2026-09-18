// Client config: where the API lives, and whether we're on a static host.

const SERVER_KEY = "tourguide.serverUrl";

/** Base URL for /api calls. Empty string = same origin. */
export function apiBase() {
  try {
    return (localStorage.getItem(SERVER_KEY) || "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function setServerUrl(url) {
  try {
    if (url) localStorage.setItem(SERVER_KEY, url);
    else localStorage.removeItem(SERVER_KEY);
  } catch { /* ignore */ }
}

/** Resolved at boot by pinging /api/health. */
export const runtime = {
  hasServer: null, // null = unknown, true/false after probe
  claude: null,
};

export const AIRPORTS = [
  { code: "IAH", label: "Houston Bush Intercontinental (IAH)", lat: 29.9902, lon: -95.3368 },
  { code: "HOU", label: "Houston Hobby (HOU)", lat: 29.6454, lon: -95.2789 },
  { code: "DFW", label: "Dallas/Fort Worth (DFW)", lat: 32.8998, lon: -97.0403 },
  { code: "DAL", label: "Dallas Love Field (DAL)", lat: 32.8471, lon: -96.8518 },
  { code: "AUS", label: "Austin (AUS)", lat: 30.1975, lon: -97.6664 },
  { code: "SAT", label: "San Antonio (SAT)", lat: 29.5337, lon: -98.4698 },
  { code: "ATL", label: "Atlanta (ATL)", lat: 33.6407, lon: -84.4277 },
  { code: "ORD", label: "Chicago O'Hare (ORD)", lat: 41.9742, lon: -87.9073 },
  { code: "LAX", label: "Los Angeles (LAX)", lat: 33.9416, lon: -118.4085 },
  { code: "SFO", label: "San Francisco (SFO)", lat: 37.6213, lon: -122.379 },
  { code: "JFK", label: "New York JFK", lat: 40.6413, lon: -73.7781 },
  { code: "EWR", label: "Newark (EWR)", lat: 40.6895, lon: -74.1745 },
  { code: "IAD", label: "Washington Dulles (IAD)", lat: 38.9531, lon: -77.4565 },
  { code: "DCA", label: "Washington Reagan (DCA)", lat: 38.8512, lon: -77.0402 },
  { code: "MIA", label: "Miami (MIA)", lat: 25.7959, lon: -80.287 },
  { code: "SEA", label: "Seattle (SEA)", lat: 47.4502, lon: -122.3088 },
  { code: "DEN", label: "Denver (DEN)", lat: 39.8561, lon: -104.6737 },
  { code: "PHX", label: "Phoenix (PHX)", lat: 33.4373, lon: -112.0078 },
  { code: "LAS", label: "Las Vegas (LAS)", lat: 36.086, lon: -115.1537 },
  { code: "BOS", label: "Boston (BOS)", lat: 42.3656, lon: -71.0096 },
];
