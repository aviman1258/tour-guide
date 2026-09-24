// Renders the sidebar: form bindings, stop cards, dropped list, status bar.

import * as state from "./state.js";
import * as actions from "./actions.js";
import * as api from "./api.js";
import * as map from "./map.js";
import * as busy from "./busy.js";
import * as typeahead from "./typeahead.js";
import { runtime } from "./config.js";
import { escapeHtml, to12h, fmtDuration, fmtMiles } from "./format.js";
import { haversineM } from "./routeMath.js";
import * as pay from "./pay.js";

const $ = (id) => document.getElementById(id);
const boxes = {}; // typeahead handles for start / end

export function toast(msg, ms = 2500) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), ms);
}

function showMsg(id, text, isError = false) {
  const el = $(id);
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

const CATEGORY_ICON = {
  neighborhood: "🏘️", district: "🛍️", landmark: "🏛️", museum: "🖼️", temple: "🛕", park: "🌳",
  cemetery: "🪦", food: "🍽️", shopping: "🛒", viewpoint: "🌆", other: "📍",
};

// ---------- form ----------

/** Start/end boxes: type-ahead (biased to the other endpoint) + current-location icon. */
function bindEndpoint(which) {
  const input = $(`${which}-query`);
  const other = () => (which === "start" ? state.get().end : state.get().start);
  const set = which === "start" ? actions.setStart : actions.setEnd;

  boxes[which] = typeahead.attach(input, {
    near: other,
    onPick: (it) => set({ label: it.label, lat: it.lat, lon: it.lon }),
  });

  const btn = $(`${which}-loc`);
  btn.addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location isn't available in this browser");
    btn.classList.add("locating");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        set({ label: "Current location", lat, lon });
        input.value = "Current location";
        const nice = await typeahead.reverseLabel(lat, lon);
        btn.classList.remove("locating");
        if (nice) {
          set({ label: `Current location (${nice})`, lat, lon });
          if (document.activeElement !== input) input.value = `Current location (${nice})`;
        }
      },
      (err) => {
        btn.classList.remove("locating");
        toast(err.code === 1 ? "Location permission was denied. Allow it for this site and try again." : `Location failed: ${err.message}`, 4000);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

/** Explicit search (Nominatim + Wikipedia enrichment) for adding stops; biased and sorted by `near`. */
async function searchPlace(q, near, label) {
  return busy.run(label, async () => {
    const { results } = await api.place(q, near);
    if (near) results.sort((a, b) => haversineM(a, near) - haversineM(b, near));
    const seen = new Set();
    return results.filter((s) => {
      const key = (s.wikipediaTitle || `${s.name}@${s.lat.toFixed(3)},${s.lon.toFixed(3)}`).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

function bindSearch({ input, button, results, near, pickLabel, onPick, busyLabel }) {
  const go = async () => {
    const q = $(input).value.trim();
    if (q.length < 2) return;
    $(button).disabled = true;
    try {
      const found = await searchPlace(q, near(), busyLabel);
      renderResults($(results), found, (s) => {
        onPick(s);
        $(results).innerHTML = "";
      }, pickLabel, near());
      if (!found.length) toast("Nothing found. Try adding the city or state.");
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      $(button).disabled = false;
    }
  };
  $(button).addEventListener("click", go);
  $(input).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
}

/** Times are dropdowns in 15-minute steps: one tap on any phone, and no native clock dialog
 *  (Android's overflowed the screen on some devices). Odd values (from a shared link) get their own option. */
function fillTimeSelect(sel, defaultValue) {
  for (let m = 5 * 60; m < 24 * 60; m += 15) {
    const v = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const o = document.createElement("option");
    o.value = v; o.textContent = to12h(v);
    sel.appendChild(o);
  }
  sel.value = defaultValue;
}
function ensureTimeOption(sel, v) {
  if (!v || [...sel.options].some((o) => o.value === v)) return;
  const o = document.createElement("option");
  o.value = v; o.textContent = to12h(v);
  const after = [...sel.options].find((x) => x.value > v);
  sel.insertBefore(o, after || null);
}

export function bindForm() {
  bindEndpoint("start");
  bindEndpoint("end");
  fillTimeSelect($("arrival"), "09:00");
  fillTimeSelect($("deadline"), "21:00");

  for (const [id, key] of [["date", "date"], ["arrival", "arrivalTime"], ["deadline", "deadline"], ["interests", "interests"]]) {
    $(id).addEventListener("change", () => {
      actions.setField({ [key]: $(id).value });
      if (key !== "interests") actions.reschedule();
    });
  }
  $("avoid-tolls").addEventListener("change", (e) => actions.setRouteOptions({ avoidTolls: e.target.checked }));
  $("avoid-highways").addEventListener("change", (e) => actions.setRouteOptions({ avoidHighways: e.target.checked }));

  $("plan-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showMsg("plan-msg", ""); // progress (phase, estimate, places as they're verified) shows in the stops list
    $("plan-btn").disabled = true;
    $("cancel-plan-btn").hidden = false;
    try {
      // pay-per-route: hold the fee first (owner and Stripe-less servers skip this), then plan
      const result = await pay.withCredit(state.get(), () => actions.plan());
      showMsg("plan-msg", "");
      if (result) toast(`${result.stops.length} stops planned`);
      pay.refresh(state.get());
    } catch (err) {
      if (err.cancelled) { showMsg("plan-msg", ""); toast(err.message === "Payment cancelled." ? "No charge. Plan when you're ready." : "Planning cancelled"); }
      else showMsg("plan-msg", `${err.message}${pay.storedCredit()?.status === "authorized" && pay.storedCredit()?.plansLeft === 3 ? " You haven't been charged: your payment stays ready for another try and is cancelled on its own if you don't." : ""}`, true);
    } finally {
      $("plan-btn").disabled = false;
      $("cancel-plan-btn").hidden = true;
    }
  });
  $("cancel-plan-btn").addEventListener("click", () => {
    $("cancel-plan-btn").disabled = true;
    actions.cancelPlan();
    setTimeout(() => ($("cancel-plan-btn").disabled = false), 500);
  });

  $("reset-btn").addEventListener("click", () => {
    if (confirm("Clear this trip?")) {
      actions.reset();
      $("start-query").value = "";
      $("end-query").value = "";
    }
  });

  // add-a-stop: the same type-ahead as start/end (biased to the middle of the trip), plus the
  // Find button for a deeper search (Nominatim → Photon → Wikipedia → Google when configured)
  const midTrip = () => { const it = state.get(); return it.stops[Math.floor(it.stops.length / 2)] || it.end || it.start; };
  typeahead.attach($("add-query"), {
    near: midTrip,
    onPick: async (p) => {
      try {
        const stop = await busy.run("Adding the stop…", () => api.stopFromPlace({ name: p.label, lat: p.lat, lon: p.lon, kind: p.kind, sub: p.sub }));
        actions.addStop(stop);
        $("add-query").value = "";
        toast(`Added ${stop.name}`);
      } catch (err) { toast(err.message, 4000); }
    },
  });
  bindSearch({
    input: "add-query", button: "add-search", results: "add-results",
    near: () => { const it = state.get(); return it.stops[Math.floor(it.stops.length / 2)] || it.end || it.start; },
    pickLabel: "Add", busyLabel: "Searching…",
    onPick: (s) => { actions.addStop(s); $("add-query").value = ""; toast(`Added ${s.name}`); },
  });

  $("suggest-btn").addEventListener("click", async () => {
    $("suggest-btn").disabled = true;
    try {
      const candidates = await actions.suggest(3);
      renderResults($("suggest-results"), candidates, (s) => {
        actions.addStop(s);
        toast(`Added ${s.name}`);
        $("suggest-results").querySelector(`[data-id="${s.id}"]`)?.remove();
      }, "Add");
      if (!candidates.length) toast("No new suggestions.");
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      $("suggest-btn").disabled = false;
    }
  });

  // map click → add a pin
  map.onMapClick(async (lat, lon) => {
    if (!confirm("Add a stop here?")) return;
    try {
      const stop = await busy.run("Looking up that spot…", () => api.reverse(lat, lon));
      actions.addStop(stop);
      toast(`Added ${stop.name}`);
    } catch (err) {
      toast(err.message, 4000);
    }
  });
}

function renderResults(container, stops, onPick, label, near) {
  container.innerHTML = "";
  for (const s of stops) {
    const el = document.createElement("div");
    el.className = "result";
    el.dataset.id = s.id;
    const dist = near ? ` · ${fmtMiles(haversineM(s, near))} away` : "";
    el.innerHTML = `
      <span>${CATEGORY_ICON[s.category] || "📍"}</span>
      <div class="grow">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="sub">${escapeHtml(s.whyItMatches || s.blurb || s.approxArea || "")}${escapeHtml(dist)}</div>
      </div>
      <button type="button" class="btn btn-sm">${label}</button>`;
    el.querySelector("button").addEventListener("click", () => onPick(s));
    el.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON") map.focus(s.lat, s.lon); });
    container.appendChild(el);
  }
}

// ---------- render ----------

export function render(it) {
  // form values (only when they differ, to avoid clobbering typing)
  const setVal = (id, v) => { const el = $(id); if (el.tagName === "SELECT") ensureTimeOption(el, v); if (el.value !== (v ?? "")) el.value = v ?? ""; };
  pay.renderPrice(it);
  setVal("date", it.date);
  setVal("arrival", it.arrivalTime);
  setVal("deadline", it.deadline);
  setVal("interests", it.interests);
  $("avoid-tolls").checked = Boolean(it.routeOptions?.avoidTolls);
  $("avoid-highways").checked = Boolean(it.routeOptions?.avoidHighways);
  boxes.start?.setValue(it.start?.label || "");
  boxes.end?.setValue(it.end?.label || "");
  $("start-label").textContent = it.start ? `From: ${it.start.label}` : "";
  $("end-label").textContent = it.end ? `To: ${it.end.label}` : "";

  $("summary").textContent = it.summary || "";
  $("summary").hidden = !it.summary;

  renderStatus(it);
  renderStops(it);
  renderDropped(it);

  const hasRoute = it.stops.length > 0 && it.start && it.end;
  $("prepare-btn").disabled = !hasRoute;
  $("gmaps-btn").disabled = !hasRoute;
  $("share-btn").disabled = !hasRoute;
  $("suggest-btn").disabled = !(it.start && it.end) || runtime.hasServer === false;
  $("plan-btn").disabled = runtime.hasServer === false || Boolean(it.planning); // stays off while a plan is running
}

function renderStatus(it) {
  const bar = $("status-bar");
  const s = it.schedule;
  if (!s || !it.route) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.className = `status-bar ${s.status}`;
  const slack = s.slackMinutes;
  const verdict = slack < 0 ? `${fmtDuration(-slack)} over` : `${fmtDuration(slack)} spare`;
  const flags = [];
  if (it.route.flags?.hasToll) flags.push("tolls");
  if (it.routeOptions?.avoidHighways && it.route.flags?.hasHighway) flags.push("highway");
  const traffic = s.trafficMinutes > 0 ? ` · incl. ${fmtDuration(s.trafficMinutes)} typical traffic` : "";
  bar.textContent = `Arrive ${to12h(s.hotelArrive)} · ${verdict} · ${fmtMiles(it.route.totalM)} driving${traffic}${flags.length ? ` · ⚠ ${flags.join(", ")}` : ""}`;
  bar.title = [...(s.warnings || []), s.trafficMinutes > 0 ? "Drive times include typical traffic for the day and hour each leg starts (weekday rush hours run up to 50% slower). Not live traffic." : ""].filter(Boolean).join("\n");
}

/** While a plan streams in: phase, estimate, and every candidate with its verification status. */
function renderPlanning(it, root) {
  const p = it.planning;
  const card = document.createElement("section");
  card.className = "card planning";
  const PHASE = { claude: "Deodap is choosing stops for your interests", ground: "Checking each place on Wikipedia and the map", route: "Routing and timing the day" };
  const est = p.estimate ? ` <small>· usually about ${Math.max(1, Math.round(p.estimate.totalMs / 60000))} min${p.estimate.basedOnRuns ? ` (from your last ${p.estimate.basedOnRuns} run${p.estimate.basedOnRuns === 1 ? "" : "s"}${p.estimate.source === "device" ? " on this device" : ""})` : ""}</small>` : "";
  card.innerHTML = `<div class="phase"><span class="dot checking"></span><span>${PHASE[p.phase] || "Working"}…${est}</span></div>`;

  if (!p.candidates.length) {
    card.insertAdjacentHTML("beforeend", `<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:55%"></div><div class="skeleton" style="width:62%"></div>`);
  } else {
    const ul = document.createElement("ul");
    for (const c of p.candidates) {
      const li = document.createElement("li");
      li.className = c.status;
      li.innerHTML = `<span class="dot ${c.status}">${c.status === "ok" ? "✓" : c.status === "dropped" ? "✕" : ""}</span><div><div>${escapeHtml(c.name)}</div>${c.whyItMatches ? `<div class="why">${escapeHtml(c.whyItMatches)}</div>` : ""}</div>`;
      ul.appendChild(li);
    }
    card.appendChild(ul);
    const pending = p.candidates.filter((c) => c.status === "checking").length;
    if (pending) card.insertAdjacentHTML("beforeend", `<div class="more">Still checking ${pending} more place${pending === 1 ? "" : "s"}…</div>`);
    else if (p.phase === "route") card.insertAdjacentHTML("beforeend", `<div class="more">All places checked. Working out the route and what fits in the day…</div>`);
  }
  root.appendChild(card);

  // verified stops so far, as real cards (read-only until the schedule lands)
  p.found.forEach((s, i) => root.appendChild(stopCard(it, s, i, null, { readOnly: true })));
}

function renderStops(it) {
  const root = $("stops");
  root.innerHTML = "";
  if (it.planning) {
    if (it.start) root.appendChild(endpoint("S", `Start: ${it.start.label}`, ""));
    renderPlanning(it, root);
    if (it.end) root.appendChild(endpoint("E", `End: ${it.end.label}`, `Be there by ${to12h(it.deadline)}`));
    return;
  }
  if (!it.start && !it.stops.length) {
    root.innerHTML = document.body.classList.contains("free")
      ? `<div class="hint" style="padding:0 6px">Find a saved route above. Once it's loaded you'll see every stop and the times here.</div>`
      : `<div class="hint" style="padding:0 6px">Pick where you start and where you need to end up, describe what you like, and hit Plan. Works for any city. Or search a place below to add stops by hand.</div>`;
    return;
  }
  if (it.start) root.appendChild(endpoint("S", `Start: ${it.start.label}`, it.arrivalTime ? `Arrive ${to12h(it.arrivalTime)} · on the road by ${to12h(addMin(it.arrivalTime, it.departBufferMinutes))}` : ""));

  it.stops.forEach((s, i) => {
    const sched = it.schedule?.items?.find((x) => x.stopId === s.id);
    root.appendChild(stopCard(it, s, i, sched));
  });

  if (it.end) {
    const s = it.schedule;
    root.appendChild(endpoint("E", `End: ${it.end.label}`, s ? `Arrive ${to12h(s.hotelArrive)} · need to be there by ${to12h(it.deadline)}` : `Be there by ${to12h(it.deadline)}`));
  }
}

function stopCard(it, s, i, sched, { readOnly = false } = {}) {
  {
    const el = document.createElement("article");
    el.className = "stop";
    el.dataset.id = s.id;
    el.innerHTML = `
      <div class="num">${i + 1}</div>
      ${s.thumbnail ? `<img class="thumb" src="${escapeHtml(s.thumbnail)}" alt="" loading="lazy">` : `<div class="thumb empty">${CATEGORY_ICON[s.category] || "📍"}</div>`}
      <div class="body">
        <div class="title">
          <span>${escapeHtml(s.name)}</span>
          ${s.lunch !== "none" ? `<span class="lunch-tag">🍽️ ${s.lunch === "auto" ? "lunch" : "meal"}</span>` : ""}
          ${s.wikipediaUrl ? `<a href="${escapeHtml(s.wikipediaUrl)}" target="_blank" rel="noopener">Wikipedia</a>` : ""}
        </div>
        ${s.whyItMatches ? `<div class="why">${escapeHtml(s.whyItMatches)}</div>` : ""}
        ${s.blurb ? `<p class="blurb">${escapeHtml(s.blurb)}</p>` : ""}
        <div class="times">
          ${sched ? `<span>🚗 ${fmtDuration(sched.legMinutes)}</span><span>arrive <b>${to12h(sched.arrive)}</b></span><span>leave <b>${to12h(sched.depart)}</b></span>` : `<span>${s.dwellMinutes} min stop</span>`}${s.website ? `<a class="attrib" href="${escapeHtml(s.website)}" target="_blank" rel="noopener nofollow">website</a>` : ""}${s.source === "google" ? `<span class="attrib">place data: Google</span>` : ""}
        </div>
        ${readOnly ? "" : `<div class="controls">
          <button type="button" class="btn btn-sm btn-icon" data-act="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="btn btn-sm btn-icon" data-act="down" title="Move down" ${i === it.stops.length - 1 ? "disabled" : ""}>↓</button>
          <label>stay <input type="number" min="5" max="240" step="5" value="${s.dwellMinutes}" data-act="dwell"> min</label>
          <button type="button" class="btn btn-sm" data-act="lunch" title="Mark a meal break here (breakfast, lunch or dinner). Pick as many stops as you like; each gets at least an hour">${s.lunch === "user" ? "Not eating here" : "Stop here to eat"}</button>
          <button type="button" class="btn btn-sm btn-icon" data-act="remove" title="Remove">✕</button>
        </div>`}
      </div>`;
    el.addEventListener("click", (e) => {
      const act = e.target.dataset.act;
      if (!act) { if (e.target.tagName !== "A" && e.target.tagName !== "INPUT") map.focus(s.lat, s.lon); return; }
      if (act === "up") actions.moveStop(s.id, -1);
      else if (act === "down") actions.moveStop(s.id, 1);
      else if (act === "lunch") actions.toggleLunch(s.id);
      else if (act === "remove") actions.removeStop(s.id);
    });
    el.querySelector("[data-act=dwell]")?.addEventListener("change", (e) => {
      const v = Math.max(5, Math.min(240, Number(e.target.value) || s.dwellMinutes));
      actions.updateStop(s.id, { dwellMinutes: v });
    });
    return el;
  }
}

function endpoint(label, title, sub) {
  const el = document.createElement("article");
  el.className = "stop endpoint";
  el.innerHTML = `<div class="num">${label}</div><div class="body"><div class="title">${escapeHtml(title)}</div><div class="times">${escapeHtml(sub)}</div></div>`;
  return el;
}

function renderDropped(it) {
  const sec = $("dropped");
  const list = $("dropped-list");
  list.innerHTML = "";
  const items = it.dropped || [];
  sec.hidden = items.length === 0;
  const REASON = { trimmed: "didn't fit the time window", not_found: "couldn't verify on Wikipedia or the map", no_coords: "no location found", too_far: "too far off the route", lookup_failed: "Wikipedia was busy; try Add a stop → search for it in a minute" };
  for (const d of items) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="grow"><div>${escapeHtml(d.name)}</div><div class="reason">${REASON[d.reason] || d.reason}</div></div>`;
    if (d.stop) {
      const b = document.createElement("button");
      b.className = "btn btn-sm";
      b.textContent = "Add back";
      b.addEventListener("click", () => actions.addBack(d));
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

function addMin(hhmm, m) {
  const [h, mm] = hhmm.split(":").map(Number);
  const t = h * 60 + mm + m;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
