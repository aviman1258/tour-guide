import { apiBase, runtime, getAppKey, setAppKey, getCreditToken, deviceId } from "./config.js";
import { askSecret } from "./secretPrompt.js";

const authHeaders = () => ({ ...(deviceId() ? { "x-device": deviceId() } : {}), ...(getAppKey() ? { "x-app-key": getAppKey() } : {}), ...(getCreditToken() ? { "x-credit": getCreditToken() } : {}) });

/**
 * Owner sign-in: exchange the passphrase for a token (POST /api/owner/unlock) and keep the token,
 * never the passphrase. Throws with .status 401 (wrong; message says tries left) or 429 (locked).
 */
export async function unlockOwner(passphrase) {
  const r = await call("POST", "/api/owner/unlock", { passphrase });
  setAppKey(r.token);
  return r;
}
export async function logoutOwner() {
  try { await call("POST", "/api/owner/logout"); } catch { /* token may already be gone */ }
  setAppKey("");
}

/** Error carrying the server's payment hint (402 needsPayment) so the UI can open the pay card. */
function apiError(res, data, fallback) {
  const e = new Error(data?.error || fallback);
  e.status = res.status;
  if (data?.needsPayment) { e.needsPayment = true; e.quote = data.quote; }
  return e;
}

/** On a 401 from a protected server, ask for the passphrase once and let the caller retry. */
async function askForKey(res) {
  if (res.status !== 401) return false;
  let needs = false;
  try { needs = Boolean((await res.clone().json()).needsKey); } catch { /* not ours */ }
  if (!needs) return false;
  const entered = await askSecret({ title: "App passphrase", label: "This server needs the app passphrase", submit: "Unlock" });
  if (!entered) return false;
  try { await unlockOwner(entered); return true; } catch { return false; }
}

async function call(method, path, body, signal, retried = false) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!retried && (await askForKey(res))) return call(method, path, body, signal, true);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw apiError(res, data, `${res.status} ${res.statusText}`);
  return data;
}

export async function probe() {
  try {
    const h = await call("GET", "/api/health");
    runtime.hasServer = Boolean(h?.ok);
    runtime.claude = h?.claude || null;
  } catch {
    runtime.hasServer = false;
  }
  return runtime.hasServer;
}

export const health = () => call("GET", "/api/health");
export const place = (q, near) => call("GET", `/api/place?q=${encodeURIComponent(q)}${near ? `&near=${near.lat},${near.lon}` : ""}`);
export const reverse = (lat, lon) => call("GET", `/api/reverse?lat=${lat}&lon=${lon}`);
export const plan = (input, signal) => call("POST", "/api/plan", input, signal);
export const estimate = () => call("GET", "/api/estimate");

/** Streaming plan: resolves to the final itinerary; onEvent(name, data) for progress. */
export const planStream = (input, opts) => stream("/api/plan", input, { ...opts, doneKey: "itinerary" });
/** Streaming prepare-drive: resolves to the DrivePackage; onEvent for progress. */
export const prepareDriveStream = (itinerary, opts) => stream("/api/prepare-drive", { itinerary }, { ...opts, doneKey: "package" });

/**
 * POST with Accept: text/event-stream and parse server-sent events.
 * Resolves to done[doneKey]; rejects on an `error` event or a broken stream.
 */
async function stream(path, body, opts = {}) {
  const { onEvent = () => {}, signal, doneKey, retried = false } = opts;
  const res = await fetch(apiBase() + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!retried && (await askForKey(res))) return stream(path, body, { ...opts, retried: true });
  if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
    let data = null;
    try { data = await res.json(); } catch { /* keep msg */ }
    throw apiError(res, data, `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", result = null, failure = null;
  const handle = (block) => {
    let event = "message", data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === "done") result = doneKey ? payload[doneKey] : payload;
    if (event === "error") failure = new Error(payload.message || "request failed");
    onEvent(event, payload);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx).replace(/\r/g, "");
      buffer = buffer.slice(idx + 2);
      if (block.trim() && !block.startsWith(":")) handle(block);
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("The connection ended before a result arrived.");
  return result;
}
export const suggest = (itinerary, count = 3) => call("POST", "/api/suggest", { itinerary, count });
export const schedule = (itinerary, trim = false) => call("POST", "/api/schedule", { itinerary, trim });
export const prepareDrive = (itinerary) => call("POST", "/api/prepare-drive", { itinerary });
export const whoami = () => call("GET", "/api/whoami");

// pay-per-route
export const payQuote = (arrivalTime, deadline) => call("GET", `/api/pay/quote?arrivalTime=${encodeURIComponent(arrivalTime || "")}&deadline=${encodeURIComponent(deadline || "")}`);
export const payIntent = (body) => call("POST", "/api/pay/intent", body);
export const payConfirm = (token) => call("POST", "/api/pay/confirm", { token });
export const payCredit = ({ start, end, arrivalTime, deadline }) => call("GET", `/api/pay/credit?start=${start?.lat},${start?.lon}&end=${end?.lat},${end?.lon}&arrivalTime=${encodeURIComponent(arrivalTime || "")}&deadline=${encodeURIComponent(deadline || "")}`);
export const payRelease = (token) => call("POST", "/api/pay/release", { token });

// shared route library
export const searchRoutes = ({ near, q, radiusKm } = {}) => {
  const p = new URLSearchParams();
  if (near) p.set("near", `${near.lat},${near.lon}`);
  if (q) p.set("q", q);
  if (radiusKm) p.set("radiusKm", String(radiusKm));
  return call("GET", `/api/routes?${p}`);
};
export const getRoute = (id) => call("GET", `/api/routes/${encodeURIComponent(id)}`);
export const publishRoute = (pkg, title, description) => call("POST", "/api/routes", { package: pkg, title, description });
export const deleteRoute = (id) => call("DELETE", `/api/routes/${encodeURIComponent(id)}`);

/**
 * For the subscriber tier: make sure this device is recognised as a subscriber, prompting for
 * the passphrase if the server is protected and we don't have it. Returns true if subscriber.
 */
export async function ensureSubscriber() {
  let me = await whoami().catch(() => null);
  if (!me) return false;
  if (me.tier === "subscriber") return true;
  const entered = await askSecret({ title: "Owner passphrase", label: "This server needs the owner passphrase", submit: "Unlock" });
  if (!entered) return false;
  try { await unlockOwner(entered); } catch { return false; }
  me = await whoami().catch(() => null);
  return me?.tier === "subscriber";
}
