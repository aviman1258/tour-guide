// "My routes": everything prepared, paid for, saved or imported on this device (and, signed in,
// in the account), with Open / Drive / Delete. Plus the sign-in row that keeps them on every device.

import * as state from "./state.js";
import * as storage from "./storage.js";
import * as account from "./account.js";
import { toast } from "./itinerary.js";
import { escapeHtml, to12h } from "./format.js";

const $ = (id) => document.getElementById(id);
const titleOf = (pkg) => pkg.title || `${String(pkg.itinerary?.start?.label || "?").split(",")[0]} → ${String(pkg.itinerary?.end?.label || "?").split(",")[0]}`;
const when = (pkg) => pkg.savedAt || pkg.preparedAt || "";

export async function render() {
  const box = $("my-routes-list");
  if (!box) return;
  let trips = [];
  try { trips = await storage.listTrips(); } catch { trips = []; }
  trips.sort((a, b) => (when(b) > when(a) ? 1 : when(b) < when(a) ? -1 : 0));
  box.innerHTML = "";
  $("my-routes-empty").hidden = trips.length > 0;
  for (const pkg of trips) {
    const it = pkg.itinerary || {};
    const el = document.createElement("div");
    el.className = "result mine";
    const tags = [pkg.credit ? `<span class="tag paid">paid</span>` : "", pkg.libraryId ? `<span class="tag">from the library</span>` : "", pkg.voice?.clips ? `<span class="tag">Deodap's voice</span>` : "", pkg.syncedAt ? `<span class="tag">in your account</span>` : ""].join("");
    el.innerHTML = `
      <div class="grow">
        <div class="name">${escapeHtml(titleOf(pkg))} ${tags}</div>
        <div class="sub">${it.date ? `${escapeHtml(it.date)} · ` : ""}${it.arrivalTime ? `${to12h(it.arrivalTime)} · ` : ""}${(it.stops || []).length} stops · ${(pkg.narration || []).length} narrations</div>
        <div class="sub">${escapeHtml(it.start?.label || "")} → ${escapeHtml(it.end?.label || "")}</div>
      </div>
      <div class="acts">
        <button type="button" class="btn btn-sm" data-act="open">Open</button>
        <a class="btn btn-sm btn-primary" href="drive.html?trip=${encodeURIComponent(pkg.tripId)}">Drive</a>
        <button type="button" class="btn btn-sm btn-ghost" data-act="delete">Delete</button>
      </div>`;
    el.querySelector('[data-act="open"]').addEventListener("click", () => {
      state.replace({ ...it, planning: null });
      storage.setActiveTripId(pkg.tripId);
      $("drive-link").href = `drive.html?trip=${encodeURIComponent(pkg.tripId)}`;
      toast(`Opened ${titleOf(pkg)}`);
      document.getElementById("stops")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const del = el.querySelector('[data-act="delete"]');
    del.addEventListener("click", async () => {
      if (del.dataset.armed !== "1") { // two taps, four seconds apart at most: no confirm() dialogs
        del.dataset.armed = "1"; del.textContent = "Really delete?"; del.classList.add("btn-danger");
        setTimeout(() => { del.dataset.armed = ""; del.textContent = "Delete"; del.classList.remove("btn-danger"); }, 4000);
        return;
      }
      await storage.deleteTrip(pkg.tripId);
      toast(`Deleted ${titleOf(pkg)}${account.isSignedIn() ? " from this device and your account" : ""}`);
      render();
    });
    box.appendChild(el);
  }
}

function renderSignIn() {
  const st = account.status();
  const signedIn = $("my-routes-signed-in"), form = $("my-routes-signin");
  signedIn.hidden = !st.signedIn;
  form.hidden = st.signedIn;
  $("my-routes-sync").textContent = st.syncing ? "Syncing…" : st.error ? st.error : st.lastSync ? "Your routes are kept in your account and follow you to any device you sign in on." : "";
}

export function bind() {
  if (!$("my-routes-list")) return;
  render();
  renderSignIn();
  account.onChange(() => { renderSignIn(); render(); });
  window.addEventListener("tg:trips-changed", () => render());
  window.addEventListener("tg:trip-deleted", () => render());

  $("my-routes-signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("signin-email"), btn = $("signin-send"), msg = $("signin-msg");
    const email = input.value.trim();
    if (!email) { input.focus(); return; }
    btn.disabled = true;
    msg.textContent = "Sending…";
    try {
      const r = await account.requestLink(email);
      msg.innerHTML = `Check your email for the sign-in link (it lasts 20 minutes; look in spam if it's not there).${r.devLink ? ` <a href="${escapeHtml(r.devLink)}">Dev: open the link</a>` : ""}`;
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("signout-btn").addEventListener("click", async () => { await account.signOut(); toast("Signed out. Your routes stay on this device."); });
}
