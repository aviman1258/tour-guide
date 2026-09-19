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

// Passphrase for a hosted server (APP_SECRET). Asked for once per device, kept in localStorage.
const KEY_KEY = "tourguide.appKey";
export function getAppKey() {
  try { return localStorage.getItem(KEY_KEY) || ""; } catch { return ""; }
}
export function setAppKey(v) {
  try { if (v) localStorage.setItem(KEY_KEY, v); else localStorage.removeItem(KEY_KEY); } catch { /* ignore */ }
}

// Tier chosen on the landing page: "free" (saved routes only) or "subscriber" (AI planning).
// ?tier=… in the URL wins and is remembered per device.
const TIER_KEY = "tourguide.tier";
export function tier() {
  const fromUrl = new URLSearchParams(location.search).get("tier");
  if (fromUrl === "free" || fromUrl === "subscriber") {
    try { localStorage.setItem(TIER_KEY, fromUrl); } catch { /* ignore */ }
    return fromUrl;
  }
  try { return localStorage.getItem(TIER_KEY) === "free" ? "free" : "subscriber"; } catch { return "subscriber"; }
}
export const isFree = () => tier() === "free";

/** Resolved at boot by pinging /api/health. */
export const runtime = {
  hasServer: null, // null = unknown, true/false after probe
  claude: null,
};

