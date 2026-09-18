// "Prepare drive": ask the server for narration, store the package, export/import trips.

import * as state from "./state.js";
import * as api from "./api.js";
import * as storage from "./storage.js";
import { toast } from "./itinerary.js";

const $ = (id) => document.getElementById(id);

function showMsg(text, isError = false) {
  const el = $("prepare-msg");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

export async function savePackage(pkg) {
  await storage.putTrip(pkg);
  storage.setActiveTripId(pkg.tripId);
}

export function bind() {
  $("prepare-btn").addEventListener("click", async () => {
    const it = state.get();
    if (!it.route) return toast("Plan or add stops first.");
    $("prepare-btn").disabled = true;
    showMsg("Scanning the route on Wikipedia and writing narration… (1-2 min)");
    try {
      const pkg = await api.prepareDrive(it);
      pkg.tripId = state.tripId(it);
      await savePackage(pkg);
      const stopsN = pkg.narration.filter((n) => n.kind === "stop").length;
      const dbN = pkg.narration.length - stopsN;
      showMsg(`Ready: ${stopsN} stop narrations, ${dbN} drive-by facts. Saved on this device.`);
      $("drive-link").classList.add("btn-primary");
    } catch (err) {
      showMsg(err.message, true);
    } finally {
      $("prepare-btn").disabled = false;
    }
  });

  $("export-btn").addEventListener("click", async () => {
    const it = state.get();
    const id = state.tripId(it);
    const pkg = (await storage.getTrip(id).catch(() => null)) || { tripId: id, preparedAt: null, itinerary: it, narration: [] };
    pkg.itinerary = it; // latest edits win
    const blob = new Blob([JSON.stringify(pkg)], { type: "application/json" });
    const file = new File([blob], `trip-${(it.end?.label || "tour").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Tour Guide trip" }); return; } catch { /* fall through */ }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const pkg = JSON.parse(await file.text());
      await importPackage(pkg);
      toast("Trip imported");
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    } finally {
      e.target.value = "";
    }
  });
}

export async function importPackage(pkg) {
  const it = pkg.itinerary || pkg;
  if (!it || it.version !== 1 || !Array.isArray(it.stops)) throw new Error("not a Tour Guide trip file");
  state.replace(it);
  const id = pkg.tripId || state.tripId(it);
  await savePackage({ tripId: id, preparedAt: pkg.preparedAt || null, itinerary: it, narration: pkg.narration || [] });
  showMsg(pkg.narration?.length ? `Imported with ${pkg.narration.length} narration items. Drive mode is ready.` : "Imported. Run “Prepare drive” on the laptop to add narration.");
}
