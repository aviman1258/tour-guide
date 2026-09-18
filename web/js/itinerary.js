// Renders the sidebar: form bindings, stop cards, dropped list, status bar.

import * as state from "./state.js";
import * as actions from "./actions.js";
import * as api from "./api.js";
import * as map from "./map.js";
import { AIRPORTS, runtime } from "./config.js";
import { escapeHtml, to12h, fmtDuration, fmtMiles } from "./format.js";

const $ = (id) => document.getElementById(id);

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

export function bindForm() {
  const preset = $("start-preset");
  for (const a of AIRPORTS) {
    const o = document.createElement("option");
    o.value = a.code;
    o.textContent = a.label;
    preset.appendChild(o);
  }
  preset.addEventListener("change", () => {
    const a = AIRPORTS.find((x) => x.code === preset.value);
    if (a) actions.setStart({ label: a.label, lat: a.lat, lon: a.lon });
  });

  $("use-location").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Geolocation not available");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        actions.setStart({ label: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude });
        preset.value = "";
      },
      (err) => toast(`Location failed: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  const endSearch = async () => {
    const q = $("end-query").value.trim();
    if (q.length < 2) return;
    $("end-search").disabled = true;
    try {
      const near = state.get().start;
      const { results } = await api.place(q, near);
      renderResults($("end-results"), results, (s) => {
        actions.setEnd({ label: s.name, lat: s.lat, lon: s.lon });
        $("end-results").innerHTML = "";
      }, "Use as hotel");
      if (!results.length) toast("Nothing found. Try adding the city.");
    } catch (err) {
      toast(err.message);
    } finally {
      $("end-search").disabled = false;
    }
  };
  $("end-search").addEventListener("click", endSearch);
  $("end-query").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); endSearch(); } });

  for (const [id, key] of [["date", "date"], ["arrival", "arrivalTime"], ["deadline", "deadline"], ["interests", "interests"]]) {
    $(id).addEventListener("change", () => {
      actions.setField({ [key]: $(id).value });
      if (key !== "interests") actions.reschedule();
    });
  }

  $("plan-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showMsg("plan-msg", "Asking Claude for stops, then checking each one on Wikipedia… (30-90 s)");
    $("plan-btn").disabled = true;
    try {
      const result = await actions.plan();
      showMsg("plan-msg", "");
      toast(`${result.stops.length} stops planned`);
    } catch (err) {
      showMsg("plan-msg", err.message, true);
    } finally {
      $("plan-btn").disabled = false;
    }
  });

  $("reset-btn").addEventListener("click", () => {
    if (confirm("Clear this trip?")) {
      actions.reset();
      preset.value = "";
      $("end-query").value = "";
    }
  });

  // add-a-stop search
  const addSearch = async () => {
    const q = $("add-query").value.trim();
    if (q.length < 2) return;
    $("add-search").disabled = true;
    try {
      const it = state.get();
      const near = it.stops[0] || it.end || it.start;
      const { results } = await api.place(q, near);
      renderResults($("add-results"), results, (s) => {
        actions.addStop(s);
        $("add-results").innerHTML = "";
        $("add-query").value = "";
        toast(`Added ${s.name}`);
      }, "Add");
      if (!results.length) toast("Nothing found.");
    } catch (err) {
      toast(err.message);
    } finally {
      $("add-search").disabled = false;
    }
  };
  $("add-search").addEventListener("click", addSearch);
  $("add-query").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSearch(); } });

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
      toast(err.message);
    } finally {
      $("suggest-btn").disabled = false;
    }
  });

  // map click → add a pin
  map.onMapClick(async (lat, lon) => {
    if (!confirm("Add a stop here?")) return;
    try {
      const stop = await api.reverse(lat, lon);
      actions.addStop(stop);
      toast(`Added ${stop.name}`);
    } catch (err) {
      toast(err.message);
    }
  });

  actions.onBusy((busy) => document.body.classList.toggle("busy", busy));
}

function renderResults(container, stops, onPick, label) {
  container.innerHTML = "";
  for (const s of stops) {
    const el = document.createElement("div");
    el.className = "result";
    el.dataset.id = s.id;
    el.innerHTML = `
      <span>${CATEGORY_ICON[s.category] || "📍"}</span>
      <div class="grow">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="sub">${escapeHtml(s.whyItMatches || s.blurb || s.approxArea || "")}</div>
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
  const setVal = (id, v) => { const el = $(id); if (el.value !== (v ?? "")) el.value = v ?? ""; };
  setVal("date", it.date);
  setVal("arrival", it.arrivalTime);
  setVal("deadline", it.deadline);
  setVal("interests", it.interests);
  $("start-label").textContent = it.start ? `From: ${it.start.label}` : "";
  $("end-label").textContent = it.end ? `To: ${it.end.label}` : "";
  const preset = $("start-preset");
  const match = AIRPORTS.find((a) => it.start && Math.abs(a.lat - it.start.lat) < 1e-6 && Math.abs(a.lon - it.start.lon) < 1e-6);
  if (match && preset.value !== match.code) preset.value = match.code;

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
  $("plan-btn").disabled = runtime.hasServer === false;
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
  bar.textContent = `Hotel ${to12h(s.hotelArrive)} · ${verdict} · ${fmtMiles(it.route.totalM)} driving`;
  bar.title = (s.warnings || []).join("\n");
}

function renderStops(it) {
  const root = $("stops");
  root.innerHTML = "";
  if (!it.start && !it.stops.length) {
    root.innerHTML = `<div class="hint" style="padding:0 6px">Pick a start and hotel, describe what you like, and hit Plan. Or search a place below to add stops by hand.</div>`;
    return;
  }
  if (it.start) root.appendChild(endpoint("S", `Start: ${it.start.label}`, it.arrivalTime ? `Land ${to12h(it.arrivalTime)} · leave ${to12h(addMin(it.arrivalTime, it.departBufferMinutes))}` : ""));

  it.stops.forEach((s, i) => {
    const sched = it.schedule?.items?.find((x) => x.stopId === s.id);
    const el = document.createElement("article");
    el.className = "stop";
    el.dataset.id = s.id;
    el.innerHTML = `
      <div class="num">${i + 1}</div>
      ${s.thumbnail ? `<img class="thumb" src="${escapeHtml(s.thumbnail)}" alt="" loading="lazy">` : `<div class="thumb empty">${CATEGORY_ICON[s.category] || "📍"}</div>`}
      <div class="body">
        <div class="title">
          <span>${escapeHtml(s.name)}</span>
          ${s.lunch !== "none" ? `<span class="lunch-tag">🍽️ lunch</span>` : ""}
          ${s.wikipediaUrl ? `<a href="${escapeHtml(s.wikipediaUrl)}" target="_blank" rel="noopener">Wikipedia</a>` : ""}
        </div>
        ${s.whyItMatches ? `<div class="why">${escapeHtml(s.whyItMatches)}</div>` : ""}
        ${s.blurb ? `<p class="blurb">${escapeHtml(s.blurb)}</p>` : ""}
        <div class="times">
          ${sched ? `<span>🚗 ${fmtDuration(sched.legMinutes)}</span><span>arrive <b>${to12h(sched.arrive)}</b></span><span>leave <b>${to12h(sched.depart)}</b></span>` : `<span>${s.dwellMinutes} min stop</span>`}
        </div>
        <div class="controls">
          <button type="button" class="btn btn-sm btn-icon" data-act="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="btn btn-sm btn-icon" data-act="down" title="Move down" ${i === it.stops.length - 1 ? "disabled" : ""}>↓</button>
          <label>stay <input type="number" min="5" max="240" step="5" value="${s.dwellMinutes}" data-act="dwell"> min</label>
          <button type="button" class="btn btn-sm" data-act="lunch">${s.lunch === "user" ? "Not lunch" : "Lunch here"}</button>
          <button type="button" class="btn btn-sm btn-icon" data-act="remove" title="Remove">✕</button>
        </div>
      </div>`;
    el.addEventListener("click", (e) => {
      const act = e.target.dataset.act;
      if (!act) { if (e.target.tagName !== "A" && e.target.tagName !== "INPUT") map.focus(s.lat, s.lon); return; }
      if (act === "up") actions.moveStop(s.id, -1);
      else if (act === "down") actions.moveStop(s.id, 1);
      else if (act === "lunch") actions.toggleLunch(s.id);
      else if (act === "remove") actions.removeStop(s.id);
    });
    el.querySelector("[data-act=dwell]").addEventListener("change", (e) => {
      const v = Math.max(5, Math.min(240, Number(e.target.value) || s.dwellMinutes));
      actions.updateStop(s.id, { dwellMinutes: v });
    });
    root.appendChild(el);
  });

  if (it.end) {
    const s = it.schedule;
    root.appendChild(endpoint("H", `Hotel: ${it.end.label}`, s ? `Arrive ${to12h(s.hotelArrive)} · need to be there by ${to12h(it.deadline)}` : `Be there by ${to12h(it.deadline)}`));
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
