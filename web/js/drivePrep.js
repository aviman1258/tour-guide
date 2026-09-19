// "Prepare drive": streams the narration build (route → corridor scan → Claude → assemble)
// with live progress, an estimate learned from earlier runs, and a Cancel. Stores the
// DrivePackage in IndexedDB. Also export / import of the package as a JSON file.

import * as state from "./state.js";
import * as api from "./api.js";
import * as storage from "./storage.js";
import * as busy from "./busy.js";
import { toast } from "./itinerary.js";
import { escapeHtml } from "./format.js";

const $ = (id) => document.getElementById(id);
let controller = null;

function msg(text, isError = false) {
  const el = $("prepare-msg");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

const PHASE = {
  route: "Getting the route with turn-by-turn steps",
  scan: "Scanning Wikipedia along the route for things worth a mention",
  claude: "Claude is writing the narration",
  assemble: "Assembling the drive package",
};

function renderProgress(p) {
  const box = $("prepare-progress");
  if (!p) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  const est = p.estimate ? ` <small>· usually about ${Math.max(1, Math.round(p.estimate.totalMs / 60000))} min${p.estimate.basedOnRuns ? ` (from your last ${p.estimate.basedOnRuns} run${p.estimate.basedOnRuns === 1 ? "" : "s"})` : ""}</small>` : "";
  let html = `<div class="phase"><span class="dot checking"></span><span>${PHASE[p.phase] || "Working"}…${est}</span></div>`;
  if (p.phase === "scan" && p.scan) {
    const label = p.scan.stage === "extracts" ? `Reading ${p.scan.total} articles near the road` : `Searched ${p.scan.done} of ${p.scan.total} stretches of road`;
    html += `<div class="more">${label} · ${p.scan.found} places found so far</div>`;
  }
  if (p.legs.length) {
    html += `<ul>`;
    for (const leg of p.legs) {
      html += `<li class="ok"><span class="dot ok">✓</span><div><div>${escapeHtml(leg.from)} → ${escapeHtml(leg.to)}</div><div class="why">${leg.places.length ? escapeHtml(leg.places.map((x) => x.title).join(" · ")) : "nothing worth a mention on this stretch"}</div></div></li>`;
    }
    html += `</ul>`;
  }
  if (p.narration.length) {
    html += `<div class="more">Narration written:</div><ul>`;
    for (const n of p.narration) {
      html += `<li class="ok"><span class="dot ok">${n.kind === "stop" ? "🛑" : "🔊"}</span><div><div>${escapeHtml(n.title)}</div><div class="why">${n.text.split(/\s+/).length} words · ${n.kind === "stop" ? "at the stop" : "drive-by"}</div></div></li>`;
    }
    html += `</ul>`;
  }
  box.innerHTML = html;
}

export async function prepare() {
  const it = state.get();
  if (!it.start || !it.end || !it.stops.length) throw new Error("Plan a route first.");
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  const startedAt = Date.now();
  const task = busy.begin("Preparing the drive…", { onCancel: () => ctrl.abort(), startedAt });
  const progress = { phase: "route", estimate: null, scan: null, legs: [], narration: [] };
  renderProgress(progress);
  try {
    const pkg = await api.prepareDriveStream(it, {
      signal: ctrl.signal,
      onEvent: (event, data) => {
        if (event === "estimate") { progress.estimate = data; task.update({ estimateMs: data.totalMs, startedAt }); }
        else if (event === "phase" && data.status === "start") { progress.phase = data.phase; task.update({ label: `${PHASE[data.phase] || "Working"}…` }); }
        else if (event === "scan") { progress.scan = data; task.update({ label: data.stage === "extracts" ? `Reading ${data.total} nearby articles…` : `Scanning the road: ${data.done}/${data.total}, ${data.found} places…` }); }
        else if (event === "candidates") progress.legs = data;
        else if (event === "narration") progress.narration.push(data.item);
        renderProgress(progress);
      },
    });
    if (ctrl.signal.aborted) return null;
    pkg.tripId = state.tripId(it);
    pkg.preparedAt = pkg.preparedAt || new Date().toISOString();
    await storage.saveTrip(pkg);
    // keep the plan screen in sync with the route (steps) the server used
    state.set({ route: pkg.itinerary.route, schedule: pkg.itinerary.schedule });
    return pkg;
  } catch (err) {
    if (ctrl.signal.aborted || err.name === "AbortError") {
      const e = new Error("Prepare cancelled.");
      e.cancelled = true;
      throw e;
    }
    throw err;
  } finally {
    task.done();
    renderProgress(null);
    if (controller === ctrl) controller = null;
  }
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
    $("cancel-prepare-btn").hidden = false;
    msg("");
    try {
      const pkg = await prepare();
      if (pkg) {
        const stops = pkg.narration.filter((n) => n.kind === "stop").length;
        const drivebys = pkg.narration.filter((n) => n.kind === "driveby").length;
        msg(`Ready: ${stops} stop narrations, ${drivebys} drive-by facts. Open Drive mode, or export to your phone.`);
        $("drive-link").href = `drive.html?trip=${encodeURIComponent(pkg.tripId)}`;
      }
    } catch (err) {
      if (err.cancelled) toast("Prepare cancelled");
      else msg(err.message, true);
    } finally {
      $("prepare-btn").disabled = false;
      $("cancel-prepare-btn").hidden = true;
    }
  });
  $("cancel-prepare-btn").addEventListener("click", () => controller?.abort());

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
