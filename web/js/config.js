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

