// Shared route library on the plan screen: search / use a saved route (any tier),
// save it to this phone for driving (free tier), publish your own (subscribers).

import * as state from "./state.js";
import * as api from "./api.js";
import * as storage from "./storage.js";
import * as busy from "./busy.js";
import * as map from "./map.js";
import { isFree } from "./config.js";
import { toast } from "./itinerary.js";
import { escapeHtml, fmtDuration } from "./format.js";
import { samePlan, matchingPackage } from "./planMatch.js";

const $ = (id) => document.getElementById(id);
let loaded = null; // { summary, package } of the library route currently in the itinerary

function msg(id, text, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

// ---------- search & use ----------

function renderResults(routes) {
  const box = $("library-results");
  box.innerHTML = "";
  for (const r of routes) {
    const el = document.createElement("div");
    el.className = "result route";
    el.innerHTML = `
      <span>🗺️</span>
      <div class="grow">
        <div class="name">${escapeHtml(r.title)}</div>
        <div class="sub">${escapeHtml(r.region || "")}${r.region ? " · " : ""}${r.stopsCount} stops · ${r.miles} mi · ${fmtDuration(r.minutes)} driving · ${r.narrationCount} narrations${r.uses ? ` · used ${r.uses}×` : ""}</div>
        ${r.description ? `<div class="sub desc">${escapeHtml(r.description)}</div>` : ""}
        <div class="sub">${escapeHtml(r.startLabel)} → ${escapeHtml(r.endLabel)}</div>
      </div>
      <button type="button" class="btn btn-sm btn-primary">Use</button>`;
    el.querySelector("button").addEventListener("click", () => useRoute(r.id));
    el.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON") map.focus(r.start.lat, r.start.lon, 9); });
    box.appendChild(el);
  }
}

async function search({ near, q } = {}) {
  const { routes, total } = await busy.run("Looking for saved routes…", () => api.searchRoutes({ near, q }));
  renderResults(routes);
  if (!routes.length) $("library-msg").textContent = total ? `No saved routes match. ${total} route${total === 1 ? "" : "s"} exist so far; try a different city or word.` : "No routes have been published yet.";
  else $("library-msg").textContent = "";
}

export async function useRoute(id) {
  const res = await busy.run("Loading the route…", () => api.getRoute(id));
  loaded = res;
  const it = { ...res.package.itinerary, planning: null };
  // free drivers set their own day; keep the author's times as a starting point
  state.replace(it);
  $("library-results").innerHTML = "";
  $("library-msg").textContent = `Loaded "${res.summary.title}". Adjust the date and start time if you like, then save it to your phone.`;
  toast(`Loaded ${res.summary.title}`);
  document.getElementById("stops")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Free tier: store the loaded route (with the user's re-timed schedule) as a drive package. */
export async function saveToPhone() {
  const it = state.get();
  if (!it.start || !it.end || !it.stops.length) throw new Error("Pick a saved route first.");
  // `loaded` is whatever was last picked from the library; the plan on screen may have moved on
  // (resume banner, back from drive mode, another route). Only ever save a package for THESE stops.
  if (loaded && !samePlan(loaded.package.itinerary, it)) loaded = null;
  if (!loaded) {
    // maybe the itinerary came from an earlier package on this device
    const existing = (await storage.getTrip(state.tripId(it)).catch(() => null)) || matchingPackage(it, await storage.listTrips().catch(() => []));
    if (!existing) throw new Error("Pick a saved route first.");
    loaded = { package: existing, summary: { title: "your trip", id: existing.libraryId || null } };
  }
  const pkg = {
    ...loaded.package,
    tripId: state.tripId(it),
    preparedAt: loaded.package.preparedAt,
    savedAt: new Date().toISOString(),
    itinerary: { ...loaded.package.itinerary, date: it.date, arrivalTime: it.arrivalTime, deadline: it.deadline, schedule: it.schedule || loaded.package.itinerary.schedule },
    libraryId: loaded.summary?.id || loaded.package.libraryId || null,
  };
  await storage.saveTrip(pkg);
  $("drive-link").href = `drive.html?trip=${encodeURIComponent(pkg.tripId)}`;
  return pkg;
}

// ---------- publish (subscriber) ----------

/**
 * The prepared package for the plan on screen, or null. Looked up by trip id first, then by
 * content (same start/end/stops, any date) across everything on this device. Never falls back
 * to "the last active trip": that published old stops under a new title.
 */
async function currentPackage() {
  const it = state.get();
  const byId = await storage.getTrip(state.tripId(it)).catch(() => null);
  if (byId && samePlan(byId.itinerary, it)) return byId;
  return matchingPackage(it, await storage.listTrips().catch(() => []));
}

async function publish(title, description) {
  const current = state.get();
  const stored = await currentPackage();
  if (!stored) {
    const any = await storage.listTrips().catch(() => []);
    throw new Error(any.length
      ? "This plan has changed since it was prepared (or was never prepared). Tap Prepare drive first so the narration matches these stops, then publish."
      : "Prepare the drive first; publishing shares the narration too.");
  }
  // publish a copy carrying the times shown on screen; stops/narration come from the prepared package
  const pkg = { ...stored, itinerary: { ...stored.itinerary, date: current.date, arrivalTime: current.arrivalTime, deadline: current.deadline, schedule: current.schedule || stored.itinerary.schedule } };
  const it = pkg.itinerary;
  // street addresses can't be published: ask for a place name instead
  for (const key of ["start", "end"]) {
    const label = it[key]?.label || "";
    if (/^\s*\d{1,6}[a-z]?\s+\S|\bcurrent location\b/i.test(label)) {
      const renamed = window.prompt(`The ${key} "${label}" looks like an address. Give it a public place name (e.g. "Denver airport", "Union Station"):`, "");
      if (!renamed) throw new Error("Publishing cancelled.");
      it[key] = { ...it[key], label: renamed.trim() };
    }
  }
  const summary = await busy.run("Publishing…", () => api.publishRoute(pkg, title, description));
  state.set({ start: it.start, end: it.end });
  return summary;
}

// ---------- wiring ----------

export function bind() {
  const go = async () => {
    const q = $("library-query").value.trim();
    try { await search({ q }); } catch (err) { toast(err.message, 4000); }
  };
  $("library-search").addEventListener("click", go);
  $("library-query").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  $("library-near").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location isn't available in this browser");
    $("library-near").classList.add("locating");
    navigator.geolocation.getCurrentPosition(
      async (pos) => { $("library-near").classList.remove("locating"); try { await search({ near: { lat: pos.coords.latitude, lon: pos.coords.longitude }, q: $("library-query").value.trim() }); } catch (err) { toast(err.message, 4000); } },
      (err) => { $("library-near").classList.remove("locating"); toast(`Location failed: ${err.message}`, 4000); },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });

  $("save-phone-btn")?.addEventListener("click", async () => {
    try {
      const pkg = await saveToPhone();
      toast("Saved. Open Drive mode when you're in the car.", 4000);
      msg("prepare-msg", `Saved to this device with ${pkg.narration.length} narrations. Tap Drive mode to start.`);
    } catch (err) {
      toast(err.message, 4000);
    }
  });

  $("publish-btn")?.addEventListener("click", () => {
    const f = $("publish-form");
    f.hidden = !f.hidden;
    if (!f.hidden) { $("publish-title").value ||= defaultTitle(); $("publish-title").focus(); }
  });
  $("publish-cancel")?.addEventListener("click", () => ($("publish-form").hidden = true));
  $("publish-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg("publish-msg", "");
    try {
      const s = await publish($("publish-title").value, $("publish-desc").value);
      msg("publish-msg", `Published as "${s.title}" (${s.region || "region unknown"}): ${s.stopsCount} stops, ${s.startLabel} → ${s.endLabel}. Free-tier drivers can find it now.`);
      setTimeout(() => ($("publish-form").hidden = true), 2500);
    } catch (err) {
      msg("publish-msg", err.message, true);
    }
  });

  // free tier opens with the library front and centre; show what's nearby if allowed later
  if (isFree()) search({}).catch(() => {});
}

function defaultTitle() {
  const it = state.get();
  const city = (it.end?.label || it.start?.label || "").split(",")[0];
  const first = it.stops.slice(0, 2).map((s) => s.name.split(",")[0]).join(" and ");
  return [city, first].filter(Boolean).join(": ").slice(0, 80);
}
