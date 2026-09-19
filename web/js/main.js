import * as state from "./state.js";
import * as api from "./api.js";
import * as map from "./map.js";
import * as itinerary from "./itinerary.js";
import * as share from "./share.js";
import * as drivePrep from "./drivePrep.js";
import * as storage from "./storage.js";
import { runtime } from "./config.js";

async function boot() {
  map.init(document.getElementById("map"));
  itinerary.bindForm();
  share.bind();
  drivePrep.bind();

  // a shared link (#i=…) or ?trip=<id> (back from drive mode) restores a trip;
  // otherwise the form starts clean, with an offer to reopen the last prepared trip.
  const fromHash = await share.loadFromHash();
  const tripParam = new URLSearchParams(location.search).get("trip");
  if (fromHash) {
    state.replace(fromHash);
    history.replaceState(null, "", location.pathname);
    itinerary.toast("Loaded trip from link");
  } else if (tripParam) {
    const pkg = await storage.getTrip(tripParam).catch(() => null);
    if (pkg) state.replace(pkg.itinerary);
    history.replaceState(null, "", location.pathname);
  } else {
    const activeId = storage.getActiveTripId();
    const pkg = activeId ? await storage.getTrip(activeId).catch(() => null) : null;
    if (pkg) {
      const it = pkg.itinerary;
      document.getElementById("resume-sub").textContent = `${it.start?.label || "?"} → ${it.end?.label || "?"} · ${it.stops.length} stops · prepared ${(pkg.preparedAt || "").slice(0, 10)}`;
      document.getElementById("resume-banner").hidden = false;
      document.getElementById("resume-open").addEventListener("click", () => { state.replace(it); document.getElementById("resume-banner").hidden = true; });
      document.getElementById("resume-dismiss").addEventListener("click", () => { document.getElementById("resume-banner").hidden = true; });
    }
  }

  state.subscribe((it) => {
    itinerary.render(it);
    map.render(it);
  });

  const ok = await api.probe();
  if (!ok) {
    itinerary.toast("No planning server here. Drive mode and import still work.", 5000);
    document.getElementById("plan-msg").hidden = false;
    document.getElementById("plan-msg").textContent = "Planning needs the laptop server (npm run dev). This copy can still import a trip and run drive mode.";
  } else {
    // pick up any real schedule if we have stops but no route yet
    const it = state.get();
    if (it.start && it.end && it.stops.length && !it.route) {
      const { reschedule } = await import("./actions.js");
      reschedule();
    }
  }
  itinerary.render(state.get());

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  void runtime;
}

boot();
