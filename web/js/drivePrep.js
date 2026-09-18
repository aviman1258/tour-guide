// "Prepare drive" (server writes narration → IndexedDB) plus export / import of the package.

import * as state from "./state.js";
import * as api from "./api.js";
import * as storage from "./storage.js";
import { toast } from "./itinerary.js";

const $ = (id) => document.getElementById(id);

function msg(text, isError = false) {
  const el = $("prepare-msg");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

export async function prepare() {
  const it = state.get();
  if (!it.start || !it.end || !it.stops.length) throw new Error("Plan a route first.");
  const pkg = await api.prepareDrive(it);
  pkg.tripId = state.tripId(it);
  pkg.preparedAt = new Date().toISOString();
  await storage.saveTrip(pkg);
  // keep the plan screen in sync with the route (steps) the server used
  state.set({ route: pkg.itinerary.route, schedule: pkg.itinerary.schedule });
  return pkg;
}

export function exportPackage(pkg) {
  const blob = new Blob([JSON.stringify(pkg)], { type: "application/json" });
  const name = `trip-${(pkg.itinerary.end?.label || "tour").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${(pkg.itinerary.date || "").slice(0, 10)}.json`;
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file], title: "Tour Guide trip" }).catch(() => {});
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function importPackage(file) {
  const text = await file.text();
  const pkg = JSON.parse(text);
  if (!pkg?.itinerary?.stops || !Array.isArray(pkg.narration)) throw new Error("That file isn't a Tour Guide trip.");
  pkg.tripId = pkg.tripId || state.tripId(pkg.itinerary);
  await storage.saveTrip(pkg);
  state.replace(pkg.itinerary);
  return pkg;
}

export function bind() {
  $("prepare-btn").addEventListener("click", async () => {
    $("prepare-btn").disabled = true;
    msg("Scanning the route for interesting places and writing narration… (1-2 min)");
    try {
      const pkg = await prepare();
      const stops = pkg.narration.filter((n) => n.kind === "stop").length;
      const drivebys = pkg.narration.filter((n) => n.kind === "driveby").length;
      msg(`Ready: ${stops} stop narrations, ${drivebys} drive-by facts. Open Drive mode, or export to your phone.`);
      $("drive-link").href = `drive.html?trip=${encodeURIComponent(pkg.tripId)}`;
    } catch (err) {
      msg(err.message, true);
    } finally {
      $("prepare-btn").disabled = false;
    }
  });

  $("export-btn").addEventListener("click", async () => {
    const id = state.tripId(state.get());
    const pkg = (await storage.getTrip(id)) || (await storage.getTrip(storage.getActiveTripId()));
    if (!pkg) return toast("Prepare the drive first, then export.");
    exportPackage(pkg);
  });

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const pkg = await importPackage(file);
      toast(`Imported trip with ${pkg.narration.length} narrations`);
      $("drive-link").href = `drive.html?trip=${encodeURIComponent(pkg.tripId)}`;
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      e.target.value = "";
    }
  });

  // point the Drive link at the active trip, if any
  const active = storage.getActiveTripId();
  if (active) $("drive-link").href = `drive.html?trip=${encodeURIComponent(active)}`;
}
