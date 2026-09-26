import * as state from "./state.js";
import * as api from "./api.js";
import * as map from "./map.js";
import * as itinerary from "./itinerary.js";
import * as share from "./share.js";
import * as drivePrep from "./drivePrep.js";
import * as storage from "./storage.js";
import * as library from "./library.js";
import { ping } from "./ping.js";
import { runtime, tier, isFree } from "./config.js";
import * as pay from "./pay.js";
import { bindOwnerGesture } from "./ownerGesture.js";
import * as account from "./account.js";
import * as myRoutes from "./myRoutes.js";

async function boot() {
  // tier decides which controls exist on this screen (CSS hides the other tier's)
  document.body.classList.add(tier());
  ping({ tier: tier() });
  const badge = document.getElementById("tier-badge");
  if (badge) badge.textContent = isFree() ? "Free · saved routes" : "Create your own route";
  // tidy ?tier= out of the address bar, but keep params later steps still need (?trip=, ?route=)
  const keepQuery = ["trip", "route", "login"].some((k) => new URLSearchParams(location.search).get(k));
  history.replaceState(null, "", location.pathname + (keepQuery ? location.search : "") + location.hash);

  map.init(document.getElementById("map"));
  itinerary.bindForm();
  share.bind();
  drivePrep.bind();
  library.bind();
  account.bind();
  myRoutes.bind();

  // an emailed sign-in link lands here as ?login=<token>
  const login = await account.consumeFromUrl();
  if (login?.error) itinerary.toast(login.error, 7000);
  else if (login?.ok) { myRoutes.open(); itinerary.toast("Signed in. Your routes now follow you to any device you sign in on.", 6000); }

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
  if (ok) account.sync().catch(() => {});
  // a public route page's "Drive this route free" button lands here with ?route=<id>
  const routeParam = new URLSearchParams(location.search).get("route");
  if (ok && routeParam) {
    history.replaceState(null, "", location.pathname);
    library.useRoute(routeParam).catch((err) => itinerary.toast(err.message, 5000));
  }
  if (ok && !isFree()) {
    const p = await pay.init();
    if (!p.owner && !p.enabled) { // a hosted server without Stripe: the passphrase is the only door
      const sub = await api.ensureSubscriber();
      if (!sub) itinerary.toast("Without the passphrase you can still use saved routes.", 6000);
    }
    pay.renderPrice(state.get());
  }
  bindOwnerGesture(document.querySelector(".brand-logo"), { isOwner: () => pay.isOwner() });
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
