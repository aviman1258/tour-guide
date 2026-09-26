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

// Tier chosen on the landing page: "free" (saved routes only) or "subscriber" (create your own:
// AI planning, paid per route or unlocked by the owner passphrase). ?tier=… in the URL wins and
// is remembered per device; "create" is the public name for "subscriber".
const TIER_KEY = "tourguide.tier";
export function tier() {
  let fromUrl = new URLSearchParams(location.search).get("tier");
  if (fromUrl === "create") fromUrl = "subscriber";
  if (fromUrl === "free" || fromUrl === "subscriber") {
    try { localStorage.setItem(TIER_KEY, fromUrl); } catch { /* ignore */ }
    return fromUrl;
  }
  try { return localStorage.getItem(TIER_KEY) === "free" ? "free" : "subscriber"; } catch { return "subscriber"; }
}
export const isFree = () => tier() === "free";

// Random id for this browser, sent as x-device so the owner-passphrase lockout follows the device.
const DEVICE_KEY = "tourguide.deviceId";
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return ""; }
}

// Sign-in session (email link): an opaque token, sent as x-session. Empty = not signed in.
const SESSION_KEY = "tourguide.session";
export function getSession() {
  try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; }
}
export function setSession(v) {
  try { if (v) localStorage.setItem(SESSION_KEY, v); else localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// Route credit (pay-per-route): an opaque token the server issued after a payment hold.
const CREDIT_TOKEN_KEY = "tourguide.creditToken";
export function getCreditToken() {
  try { return localStorage.getItem(CREDIT_TOKEN_KEY) || ""; } catch { return ""; }
}
export function setCreditToken(v) {
  try { if (v) localStorage.setItem(CREDIT_TOKEN_KEY, v); else localStorage.removeItem(CREDIT_TOKEN_KEY); } catch { /* ignore */ }
}

/** Resolved at boot by pinging /api/health. */
export const runtime = {
  hasServer: null, // null = unknown, true/false after probe
  claude: null,
};

