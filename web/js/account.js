// Sign in with an email link; keep this device's routes in the account and pull the account's
// routes onto this device. The session token lives in localStorage (config.getSession) and rides
// on every API call as x-session. Nothing here blocks the page: sync runs in the background and
// failures just leave things as they were on the device.

import * as api from "./api.js";
import * as storage from "./storage.js";
import { getSession, setSession } from "./config.js";

const listeners = new Set();
let syncing = false;
let lastSync = null;
let lastError = null;
let queued = false;

export const isSignedIn = () => Boolean(getSession());
export const status = () => ({ signedIn: isSignedIn(), syncing, lastSync, error: lastError });
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) { try { fn(status()); } catch { /* ignore */ } } };

/** Ask the server to email a sign-in link. Resolves to { ok, devLink? } (devLink only on a dev server with no mail). */
export function requestLink(email, { purchase = false } = {}) {
  return api.authRequest(email, purchase);
}

/** plan.html?login=<token>: trade it for a session. Returns null (no token), {ok} or {error}. */
export async function consumeFromUrl() {
  const params = new URLSearchParams(location.search);
  const token = params.get("login");
  if (!token) return null;
  params.delete("login");
  history.replaceState(null, "", location.pathname + (params.toString() ? `?${params}` : "") + location.hash);
  try {
    const s = await api.authConsume(token);
    setSession(s.sessionToken);
    notify();
    sync().catch(() => {});
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function signOut() {
  try { await api.authLogout(); } catch { /* the token may already be dead */ }
  setSession("");
  lastSync = null;
  notify();
}

const titleOf = (pkg) => pkg.title || `${String(pkg.itinerary?.start?.label || "?").split(",")[0]} → ${String(pkg.itinerary?.end?.label || "?").split(",")[0]}`;

/** Store one local package in the account and remember that it is synced. */
export async function pushTrip(pkg) {
  if (!isSignedIn() || !pkg?.tripId) return;
  const { syncedAt, ...clean } = pkg;
  const entry = await api.putMyRoute(pkg.tripId, titleOf(pkg), clean);
  await storage.put("trips", pkg.tripId, { ...pkg, syncedAt: entry.updatedAt });
}

export async function deleteRemote(tripId) {
  if (!isSignedIn()) return;
  try { await api.deleteMyRoute(tripId); } catch { /* ignore */ }
}

/**
 * Two-way sync. Local routes the account doesn't have are pushed; account routes this device
 * lacks are pulled; routes deleted from the account (on another device) are deleted here too.
 */
export async function sync() {
  if (!isSignedIn()) return { skipped: true };
  if (syncing) { queued = true; return { queued: true }; }
  syncing = true; lastError = null; notify();
  const out = { pushed: 0, pulled: 0, deleted: 0 };
  try {
    const { routes } = await api.myRoutes();
    const remote = new Map(routes.map((r) => [r.tripId, r]));
    const local = await storage.listTrips();
    const localIds = new Set(local.map((p) => p.tripId));
    for (const pkg of local) {
      const r = remote.get(pkg.tripId);
      if (r?.deleted && pkg.syncedAt) { // deleted on another device after we synced it
        await storage.deleteTrip(pkg.tripId, { quiet: true });
        out.deleted++;
      } else if (!r || (!r.deleted && !pkg.syncedAt)) {
        await pushTrip(pkg);
        out.pushed++;
      }
    }
    for (const r of routes) {
      if (r.deleted || localIds.has(r.tripId)) continue;
      const got = await api.myRoute(r.tripId);
      if (!got?.package) continue;
      await storage.put("trips", r.tripId, { ...got.package, tripId: r.tripId, syncedAt: got.updatedAt });
      out.pulled++;
    }
    lastSync = new Date().toISOString();
    if (out.pulled || out.deleted) storage.announce("tg:trips-changed", { remote: true });
  } catch (err) {
    if (err.status === 401) { setSession(""); lastError = "Your sign-in expired. Sign in again."; }
    else lastError = err.message;
  } finally {
    syncing = false;
    notify();
    if (queued) { queued = false; sync().catch(() => {}); }
  }
  return out;
}

/** Wire up: anything saved or deleted on this device is mirrored to the account. */
export function bind() {
  window.addEventListener("tg:trips-changed", (e) => {
    if (e.detail?.remote || !e.detail?.tripId || !isSignedIn()) return;
    storage.getTrip(e.detail.tripId).then((pkg) => pkg && pushTrip(pkg)).catch((err) => { lastError = err.message; notify(); });
  });
  window.addEventListener("tg:trip-deleted", (e) => { if (e.detail?.tripId && !e.detail.quiet) deleteRemote(e.detail.tripId); });
}
