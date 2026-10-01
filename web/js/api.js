import { apiBase, runtime, getAppKey, setAppKey, getCreditToken, deviceId, getSession } from "./config.js";
import { askSecret } from "./secretPrompt.js";

const authHeaders = () => ({ ...(deviceId() ? { "x-device": deviceId() } : {}), ...(getAppKey() ? { "x-app-key": getAppKey() } : {}), ...(getCreditToken() ? { "x-credit": getCreditToken() } : {}), ...(getSession() ? { "x-session": getSession() } : {}) });

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
export const stopFromPlace = (place) => call("POST", "/api/stop-from-place", place);
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
// ---------- long jobs (plan, prepare): a stream that survives a dropped connection ----------
// The server runs planning as a job and tells us its id first. If the connection dies (the phone's
// screen went dark, the network blipped) we reattach to the job and pick up the events we missed;
// only an explicit cancel stops the work. The pending job is remembered so a reloaded page can
// resume it too (see pendingJob / actions.resumePlan / drivePrep.resumePrepare).

const PENDING_KEY = "tourguide.pendingJob";
export function pendingJob() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); } catch { return null; } }
export function clearPendingJob() { try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } }
const savePending = (j) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(j)); } catch { /* ignore */ } };
export const jobStatus = (id, after = 0) => call("GET", `/api/jobs/${encodeURIComponent(id)}?after=${after}`);
export const cancelJob = (id) => call("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`, {});

const isNetworkError = (err) => err && err.name !== "AbortError" && (err instanceof TypeError || /network|fetch|load failed|connection/i.test(err.message || ""));
const sleep = (ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });

/** Read one SSE response, calling onBlock(event, payload) per event. Resolves when the stream ends. */
async function readSse(res, onBlock) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx).replace(/\r/g, "");
      buffer = buffer.slice(idx + 2);
      if (!block.trim() || block.startsWith(":")) continue;
      let event = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onBlock(event, JSON.parse(data));
    }
  }
}

/**
 * Follow a job's stream to its end. `open()` returns the fetch Response (the POST that starts the
 * job, or a GET that reattaches). Handles reconnects; throws the job's error; resolves the result.
 */
async function followJob(open, { onEvent = () => {}, signal, doneKey, kind, path }) {
  let jobId = null, seen = 0, result = null, failure = null, finished = false;
  const onBlock = (event, payload) => {
    if (event === "job") { jobId = payload.id; savePending({ id: jobId, kind, doneKey, path, at: Date.now() }); return; }
    seen++;
    if (event === "done") result = doneKey ? payload[doneKey] : payload;
    else if (event === "error") failure = new Error(payload.message || "request failed");
    else if (event === "cancelled") { failure = new Error("Planning cancelled."); failure.cancelled = true; }
    if (event === "done" || event === "error" || event === "cancelled") finished = true;
    onEvent(event, payload);
  };
  signal?.addEventListener("abort", () => { if (jobId && !finished) cancelJob(jobId).catch(() => {}); clearPendingJob(); }, { once: true });
  let res = await open();
  let attempts = 0;
  for (;;) {
    try {
      await readSse(res, onBlock);
      if (finished || signal?.aborted) break;
      // the server closed without a verdict (a proxy timeout, a sleeping tab): reattach
    } catch (err) {
      if (signal?.aborted) break;
      if (!isNetworkError(err) || !jobId) throw err;
    }
    if (!jobId) throw new Error("The connection ended before a result arrived.");
    if (++attempts > 200) throw new Error("Lost the connection to the server for too long. Your plan may still be finishing; reload to check.");
    await sleep(Math.min(8000, 1500 + attempts * 500), signal);
    if (signal?.aborted) break;
    try {
      res = await fetch(apiBase() + `/api/jobs/${encodeURIComponent(jobId)}?after=${seen}`, { headers: { accept: "text/event-stream", ...authHeaders() }, signal });
      if (res.status === 404) throw new Error("That planning job is gone from the server. Please try again.");
      if (!res.ok) throw new Error(`reattach failed (${res.status})`);
    } catch (err) {
      if (signal?.aborted) break;
      if (isNetworkError(err)) { res = null; continue; }
      throw err;
    }
    if (!res) continue;
  }
  clearPendingJob();
  if (signal?.aborted) { const e = new Error("Cancelled."); e.name = "AbortError"; throw e; }
  if (failure) throw failure;
  if (result == null) throw new Error("The connection ended before a result arrived.");
  return result;
}

async function stream(path, body, opts = {}) {
  const { signal, retried = false } = opts;
  const open = async () => {
    const res = await fetch(apiBase() + path, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders() }, body: JSON.stringify(body), signal });
    if (!retried && (await askForKey(res))) return stream(path, body, { ...opts, retried: true });
    if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
      let data = null;
      try { data = await res.json(); } catch { /* keep msg */ }
      throw apiError(res, data, `${res.status} ${res.statusText}`);
    }
    return res;
  };
  return followJob(open, { ...opts, kind: opts.doneKey, path });
}

/** Resume a job started earlier (this page or a previous load): replays its events, then streams live. */
export function jobStream(id, opts = {}) {
  const open = async () => {
    const res = await fetch(apiBase() + `/api/jobs/${encodeURIComponent(id)}?after=0`, { headers: { accept: "text/event-stream", ...authHeaders() }, signal: opts.signal });
    if (!res.ok) { let data = null; try { data = await res.json(); } catch { /* keep msg */ } throw apiError(res, data, `${res.status} ${res.statusText}`); }
    return res;
  };
  return followJob(open, { ...opts, kind: opts.doneKey, path: null });
}
export const suggest = (itinerary, count = 3) => call("POST", "/api/suggest", { itinerary, count });
export const schedule = (itinerary, trim = false) => call("POST", "/api/schedule", { itinerary, trim });
export const reroute = ({ from, to, routeOptions }) => call("POST", "/api/reroute", { from, to, routeOptions });

// accounts: sign in with an email link, keep routes on the server
export const authRequest = (email, purchase = false) => call("POST", "/api/auth/request", { email, purchase });
export const authConsume = (token) => call("POST", "/api/auth/consume", { token });
export const authMe = () => call("GET", "/api/auth/me");
export const authLogout = () => call("POST", "/api/auth/logout", {});
export const myRoutes = () => call("GET", "/api/me/routes");
export const myRoute = (tripId) => call("GET", `/api/me/routes/${encodeURIComponent(tripId)}`);
export const putMyRoute = (tripId, title, pkg) => call("PUT", `/api/me/routes/${encodeURIComponent(tripId)}`, { title, package: pkg });
export const deleteMyRoute = (tripId) => call("DELETE", `/api/me/routes/${encodeURIComponent(tripId)}`);
export const prepareDrive = (itinerary) => call("POST", "/api/prepare-drive", { itinerary });
export const whoami = () => call("GET", "/api/whoami");

// pay-per-route
export const payQuote = (arrivalTime, deadline) => call("GET", `/api/pay/quote?arrivalTime=${encodeURIComponent(arrivalTime || "")}&deadline=${encodeURIComponent(deadline || "")}`);
export const payIntent = (body) => call("POST", "/api/pay/intent", body);
export const payConfirm = (token, receiptEmail = "") => call("POST", "/api/pay/confirm", { token, receiptEmail });
export const payCredit = ({ start, end, arrivalTime, deadline }) => call("GET", `/api/pay/credit?start=${start?.lat},${start?.lon}&end=${end?.lat},${end?.lon}&arrivalTime=${encodeURIComponent(arrivalTime || "")}&deadline=${encodeURIComponent(deadline || "")}`);
export const payRelease = (token) => call("POST", "/api/pay/release", { token });

// shared route library
export const searchRoutes = ({ near, q, radiusKm, live } = {}, signal) => {
  const p = new URLSearchParams();
  if (live) p.set("live", "1");
  if (near) p.set("near", `${near.lat},${near.lon}`);
  if (q) p.set("q", q);
  if (radiusKm) p.set("radiusKm", String(radiusKm));
  return call("GET", `/api/routes?${p}`, undefined, signal);
};
export const getRoute = (id) => call("GET", `/api/routes/${encodeURIComponent(id)}`);
export const publishRoute = (pkg, title, description) => call("POST", "/api/routes", { package: pkg, title, description });
export const describeRoute = (itinerary, again = false) => call("POST", `/api/routes/describe${again ? "?again=1" : ""}`, { itinerary });
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
