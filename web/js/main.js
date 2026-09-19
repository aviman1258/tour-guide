import * as state from "./state.js";
import * as api from "./api.js";
import * as map from "./map.js";
import * as itinerary from "./itinerary.js";
import * as share from "./share.js";
import * as drivePrep from "./drivePrep.js";
import { runtime } from "./config.js";

async function boot() {
  map.init(document.getElementById("map"));
  itinerary.bindForm();
  share.bind();
  drivePrep.bind();

  // a shared link (#i=…) restores a trip; otherwise every load starts with a clean form
  const fromHash = await share.loadFromHash();
  if (fromHash) {
    state.replace(fromHash);
    history.replaceState(null, "", location.pathname);
    itinerary.toast("Loaded trip from link");
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
