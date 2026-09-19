// Drive screen: follows the car, fires narration by geofence, shows next stop / next turn.
// Works from the DrivePackage in IndexedDB only — no server needed.

import * as storage from "./storage.js";
import { createGeofence } from "./geofence.js";
import { createSpeech } from "./speech.js";
import { createSim } from "./sim.js";
import { lineToPoints, cumulative, project, haversineM, bearingDeg } from "./routeMath.js";
import { fmtMiles, fmtDuration, to12h, escapeHtml, toMinutes as toMin, toHHMM } from "./format.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIM = params.get("sim") === "1";

const state = {
  pkg: null, it: null, points: [], cum: [], total: 0, maneuvers: [], stopAlong: [],
  geofence: null, speech: null, sim: null,
  watchId: null, wakeLock: null, running: false,
  lastFix: null, lastProj: null, offRoute: false, offCount: 0, onCount: 0, nextManeuverIdx: 0,
  nextStopIdx: 0, driveState: { fired: {}, visited: [] }, saveTimer: null, speakTurns: false, spokenTurn: null,
  map: null, car: null, carLayer: null, stopMarkers: [], poiMarkers: new Map(), follow: true, followTimer: null,
};

// ---------- boot ----------

async function boot() {
  initMap();
  bindUi();
  await loadTrip();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

async function loadTrip() {
  const id = params.get("trip") || storage.getActiveTripId();
  let pkg = id ? await storage.getTrip(id).catch(() => null) : null;
  if (!pkg) {
    const trips = await storage.listTrips().catch(() => []);
    if (trips.length === 1) pkg = trips[0];
    else return showTripPicker(trips);
  }
  await usePackage(pkg);
}

function showTripPicker(trips) {
  $("overlay").hidden = false;
  $("overlay-msg").textContent = trips.length ? "Pick a trip:" : "No prepared trip on this device yet. Prepare one on the plan screen, or import a trip file.";
  const box = $("overlay-trips");
  box.innerHTML = "";
  for (const t of trips) {
    const b = document.createElement("button");
    b.className = "btn";
    b.innerHTML = `<span>${escapeHtml(t.itinerary.start?.label || "?")} → ${escapeHtml(t.itinerary.end?.label || "?")}</span><small>${t.itinerary.stops.length} stops · ${t.narration.length} narrations · ${(t.preparedAt || "").slice(0, 10)}</small>`;
    b.addEventListener("click", () => usePackage(t));
    box.appendChild(b);
  }
}

async function usePackage(pkg) {
  state.pkg = pkg;
  state.it = pkg.itinerary;
  storage.setActiveTripId(pkg.tripId);
  // the back arrow reopens this trip on the plan screen instead of a blank form
  document.querySelector(".banner .back").href = `plan.html?trip=${encodeURIComponent(pkg.tripId)}`;
  const route = state.it.route;
  state.points = lineToPoints(route.geometry);
  state.cum = cumulative(state.points);
  state.total = state.cum[state.cum.length - 1];
  state.stopAlong = state.it.stops.map((s) => project(state.points, state.cum, s).progressM);
  state.maneuvers = flattenManeuvers(route, state.points, state.cum, state.it);

  state.driveState = (await storage.getDriveState(pkg.tripId).catch(() => null)) || { fired: {}, visited: [] };
  state.geofence = createGeofence(pkg.narration, { fired: state.driveState.fired, visited: state.driveState.visited });
  state.speech = createSpeech({ isStale: isStaleNarration });
  bindSpeech();

  state.nextStopIdx = state.it.stops.findIndex((s) => !state.geofence.visited.has(s.id));
  if (state.nextStopIdx < 0) state.nextStopIdx = state.it.stops.length;

  drawRoute();
  renderNextStop(null);
  renderStopList();
  $("overlay").hidden = true;
  $("banner-primary").textContent = "Ready to drive";
  $("banner-secondary").textContent = `${state.it.stops.length} stops · ${fmtMiles(state.total)} · ${pkg.narration.length} narrations`;

  if (SIM) setupSim();
  if (!state.speech.supported) notice("This browser has no speech synthesis. Narration will show as text only.");
}

// ---------- map ----------

function initMap() {
  state.map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([39.5, -98.35], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, keepBuffer: 4, updateWhenIdle: true, errorTileUrl: "icons/blank-tile.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);
  state.carLayer = L.layerGroup().addTo(state.map);
  state.map.on("dragstart zoomstart", () => {
    state.follow = false;
    clearTimeout(state.followTimer);
    state.followTimer = setTimeout(() => (state.follow = true), 15000);
  });
}

function drawRoute() {
  const it = state.it;
  L.geoJSON(it.route.geometry, { style: { color: "#5aa5dc", weight: 6, opacity: 0.9 } }).addTo(state.map);
  const num = (label, cls) => L.divIcon({ className: "", html: `<div class="marker-num ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  L.marker([it.start.lat, it.start.lon], { icon: num("S", "start") }).addTo(state.map);
  L.marker([it.end.lat, it.end.lon], { icon: num("E", "end") }).addTo(state.map);
  state.stopMarkers = it.stops.map((s, i) => L.marker([s.lat, s.lon], { icon: num(i + 1, state.geofence.visited.has(s.id) ? "visited" : "") }).bindPopup(`<b>${escapeHtml(s.name)}</b>`).addTo(state.map));
  for (const n of state.pkg.narration) {
    if (n.kind !== "driveby") continue;
    const m = L.marker([n.lat, n.lon], { icon: L.divIcon({ className: "", html: `<div class="marker-poi ${state.geofence.fired[n.id] ? "done" : ""}"></div>`, iconSize: [10, 10], iconAnchor: [5, 5] }) })
      .bindPopup(`<b>${escapeHtml(n.title)}</b><br><small>${escapeHtml(n.text.slice(0, 140))}…</small>`).addTo(state.map);
    state.poiMarkers.set(n.id, m);
  }
  state.map.fitBounds(L.geoJSON(it.route.geometry).getBounds(), { padding: [40, 40] });
}

function updateCar(lat, lon, heading) {
  if (!state.car) {
    state.car = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: `<div class="car">▲</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 1000 }).addTo(state.carLayer);
  } else {
    state.car.setLatLng([lat, lon]);
  }
  const el = state.car.getElement()?.firstElementChild;
  if (el && Number.isFinite(heading)) el.style.transform = `rotate(${heading}deg)`;
  if (state.follow) state.map.setView([lat, lon], Math.max(state.map.getZoom(), 15), { animate: false });
}

function refreshMarkers() {
  state.it.stops.forEach((s, i) => {
    const el = state.stopMarkers[i].getElement()?.firstElementChild;
    if (el) el.classList.toggle("visited", state.geofence.visited.has(s.id));
  });
  for (const [id, m] of state.poiMarkers) m.getElement()?.firstElementChild?.classList.toggle("done", Boolean(state.geofence.fired[id]));
}

// ---------- maneuvers ----------

function flattenManeuvers(route, points, cum, it) {
  const out = [];
  route.legs.forEach((leg, legIndex) => {
    for (const st of leg.steps || []) {
      const m = st.maneuver;
      if (!m || m.type === "depart") continue;
      const loc = { lat: m.location[1], lon: m.location[0] };
      const p = project(points, cum, loc);
      // Valhalla gives ready-made instructions; OSRM steps fall back to our own wording
      const arriveName = legIndex === route.legs.length - 1 ? it.end.label : it.stops[legIndex]?.name;
      const text = m.type === "arrive" ? `Arrive at ${arriveName || "your stop"}` : (st.instruction || "").replace(/\.$/, "") || maneuverText(m, st, arriveName);
      out.push({ legIndex, type: m.type, modifier: m.modifier, exit: m.exit, name: st.name || st.ref || "", atM: p.progressM, text, verbal: st.verbalAlert || "" });
    }
  });
  return out.sort((a, b) => a.atM - b.atM);
}

const MOD = { uturn: "make a U-turn", "sharp right": "sharp right", right: "right", "slight right": "slightly right", straight: "straight", "slight left": "slightly left", left: "left", "sharp left": "sharp left" };

function maneuverText(m, st, arriveName) {
  const road = st.name ? ` onto ${st.name}` : st.ref ? ` onto ${st.ref}` : "";
  const mod = MOD[m.modifier] || m.modifier || "";
  switch (m.type) {
    case "arrive": return `Arrive at ${arriveName || "your stop"}`;
    case "turn": return m.modifier === "uturn" ? "Make a U-turn" : `Turn ${mod}${road}`;
    case "new name": case "continue": return m.modifier && m.modifier !== "straight" ? `Bear ${mod}${road}` : `Continue${road}`;
    case "merge": return `Merge ${mod}${road}`;
    case "on ramp": return `Take the ramp ${mod}${road}`;
    case "off ramp": return `Take the exit ${mod}${road}`;
    case "fork": return `Keep ${mod} at the fork${road}`;
    case "end of road": return `Turn ${mod} at the end of the road${road}`;
    case "roundabout": case "rotary": return `At the roundabout take exit ${m.exit ?? ""}${road}`.replace("exit  ", "the exit ");
    case "roundabout turn": return `At the roundabout turn ${mod}${road}`;
    case "exit roundabout": case "exit rotary": return `Exit the roundabout${road}`;
    default: return `Continue${road}`;
  }
}

// ---------- position pipeline ----------

function onFix(pos) {
  const c = pos.coords;
  if (!Number.isFinite(c.latitude) || (c.accuracy && c.accuracy > 100)) return;
  const nowMs = pos.timestamp || Date.now();
  const here = { lat: c.latitude, lon: c.longitude };

  // speed/heading: trust the fix if present, else derive
  let speed = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
  let heading = Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : null;
  if (state.lastFix) {
    const dt = (nowMs - state.lastFix.nowMs) / 1000;
    const d = haversineM(state.lastFix, here);
    if (dt > 0 && d > 10) {
      if (speed == null) speed = d / dt;
      if (heading == null) heading = bearingDeg(state.lastFix, here);
    }
  }
  if (heading == null && state.lastFix) heading = state.lastFix.heading;
  const fix = { ...here, speed: speed ?? 0, heading, nowMs };

  // project onto the route
  const hint = state.offRoute || !state.lastProj ? null : state.lastProj.segIndex;
  const proj = project(state.points, state.cum, here, hint, 200);
  if (proj.offRouteM > 75) { state.offCount++; state.onCount = 0; } else { state.onCount++; state.offCount = 0; }
  if (!state.offRoute && state.offCount >= 3) { state.offRoute = true; log("offRoute"); }
  if (state.offRoute && proj.offRouteM < 40 && state.onCount >= 1) { state.offRoute = false; log("backOnRoute"); }
  const progressM = state.offRoute ? null : proj.progressM;
  state.lastProj = proj;
  state.lastFix = fix;

  // geofence
  const gf = state.geofence.update({
    lat: here.lat, lon: here.lon, speedMps: fix.speed, progressM, offRoute: state.offRoute, nowMs,
    playingKind: state.speech.current?.kind || null,
  });
  for (const e of gf.events) if (!e.startsWith("blocked:gate")) log(e);
  if (gf.fire) state.speech.enqueue(gf.fire);
  if (gf.visited) onVisited(gf.visited);

  // if progress has moved past the next stop's position by a good margin, offer to skip it
  if (progressM != null && state.nextStopIdx < state.it.stops.length && progressM > state.stopAlong[state.nextStopIdx] + 1200) {
    const s = state.it.stops[state.nextStopIdx];
    if (!state.geofence.visited.has(s.id)) { state.geofence.markVisited(s.id); onVisited(s.id); toast(`Passed ${s.name}; moving on`); }
  }

  updateCar(here.lat, here.lon, heading);
  updateNav(fix, proj, progressM);
  renderNextStop(fix, progressM);
  persistDriveState();
}

function recomputeNext() {
  const i = state.it.stops.findIndex((s) => !state.geofence.visited.has(s.id));
  state.nextStopIdx = i < 0 ? state.it.stops.length : i;
}

function onVisited(stopId) {
  recomputeNext();
  refreshMarkers();
  renderStopList();
  renderNextStop(state.lastFix, state.offRoute ? null : state.lastProj?.progressM);
  log(`visited:${stopId}`);
}

/** Manual "Visited" with an 8-second Undo. */
function markVisitedByUser(stopId) {
  const s = state.it.stops.find((x) => x.id === stopId);
  if (!s) return;
  state.geofence.markVisited(stopId);
  onVisited(stopId);
  persistDriveState();
  showUndo(`Marked ${s.name} as visited`, () => {
    state.geofence.unmarkVisited(stopId);
    recomputeNext();
    refreshMarkers();
    renderStopList();
    renderNextStop(state.lastFix, state.offRoute ? null : state.lastProj?.progressM);
    persistDriveState();
    log(`unvisited:${stopId}`);
  });
}

let undoTimer = null, undoAction = null;
function showUndo(text, action) {
  const el = $("undo");
  $("undo-text").textContent = text;
  undoAction = action;
  el.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { el.hidden = true; undoAction = null; }, 8000);
}

/** Every stop, with status, scheduled times, a Play preview and Visited / Undo. */
function renderStopList() {
  const root = $("stop-list");
  if (!root || !state.it) return;
  const playingId = state.speech.current?.previewOf || null;
  root.innerHTML = `<div class="label">All stops · tap ▶ to hear a stop's narration now</div>`;
  state.it.stops.forEach((s, i) => {
    const visited = state.geofence.visited.has(s.id);
    const isNext = i === state.nextStopIdx;
    const sched = state.it.schedule?.items?.find((x) => x.stopId === s.id);
    const narration = state.pkg.narration.find((n) => n.kind === "stop" && n.targetId === s.id);
    const row = document.createElement("div");
    row.className = `stop-row ${visited ? "visited" : ""} ${isNext ? "next" : ""}`;
    row.innerHTML = `
      <div class="num">${visited ? "✓" : i + 1}</div>
      <div class="grow">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="sub">${visited ? "Visited" : isNext ? "Next up" : "Upcoming"}${sched ? ` · ${to12h(sched.arrive)} – ${to12h(sched.depart)}` : ""}${s.lunch !== "none" ? " · lunch" : ""}</div>
      </div>
      <div class="acts">
        <button type="button" class="btn btn-sm ${playingId === s.id ? "playing" : ""}" data-act="play" title="Hear this stop's narration" ${narration ? "" : "disabled"}>${playingId === s.id ? "■" : "▶"}</button>
        <button type="button" class="btn btn-sm" data-act="${visited ? "unvisit" : "visit"}">${visited ? "Undo" : "Visited"}</button>
      </div>`;
    row.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "play") togglePreview(s.id, narration);
      else if (act === "visit") markVisitedByUser(s.id);
      else if (act === "unvisit") { state.geofence.unmarkVisited(s.id); onVisited(s.id); persistDriveState(); }
      else { state.follow = false; clearTimeout(state.followTimer); state.followTimer = setTimeout(() => (state.follow = true), 15000); state.map.setView([s.lat, s.lon], 15); }
    });
    root.appendChild(row);
  });
}

/** Play a stop's narration on demand (a real geofenced stop will interrupt it). */
function togglePreview(stopId, narration) {
  const sp = state.speech;
  if (sp.current?.previewOf === stopId) { sp.skip(); renderStopList(); return; }
  if (!narration) return;
  if (!sp.unlocked) sp.unlock(" ");
  if (sp.current) sp.skip();
  sp.enqueue({ ...narration, id: `preview_${narration.id}_${Date.now()}`, kind: "preview", previewOf: stopId, title: `${narration.title} (preview)` });
  renderStopList();
}

function isStaleNarration(item) {
  if (item.kind !== "driveby" || !state.lastFix) return false;
  const d = haversineM(state.lastFix, item);
  return d > item.radiusM * 2 && (state.lastProj?.progressM ?? 0) > item.alongM + item.radiusM;
}

function persistDriveState() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    const snap = state.geofence.snapshot();
    storage.putDriveState(state.pkg.tripId, { ...snap, lastFix: state.lastFix, savedAt: Date.now() }).catch(() => {});
  }, 2000);
}

// ---------- nav banner ----------

function updateNav(fix, proj, progressM) {
  const banner = $("banner");
  const arrow = $("banner-arrow");
  if (state.offRoute || progressM == null) {
    banner.classList.add("offroute");
    const s = state.it.stops[state.nextStopIdx] || state.it.end;
    const d = haversineM(fix, s);
    const b = bearingDeg(fix, s);
    $("banner-primary").textContent = `Off route · ${s.name || s.label} ${fmtMiles(d)}`;
    $("banner-secondary").textContent = "Follow the car's navigation; narration keeps working.";
    arrow.hidden = false;
    arrow.style.transform = `rotate(${((b - (fix.heading ?? 0)) + 360) % 360 - 90}deg)`;
    return;
  }
  banner.classList.remove("offroute");
  arrow.hidden = true;

  // advance maneuvers
  while (state.nextManeuverIdx < state.maneuvers.length && state.maneuvers[state.nextManeuverIdx].atM < progressM - 15) state.nextManeuverIdx++;
  const m = state.maneuvers[state.nextManeuverIdx];
  if (!m) {
    $("banner-primary").textContent = "Arrive";
    $("banner-secondary").textContent = state.it.end.label;
    return;
  }
  const dist = Math.max(0, m.atM - progressM);
  $("banner-primary").textContent = m.text;
  $("banner-secondary").textContent = `in ${fmtMiles(dist)}`;

  if (state.speakTurns && !state.speech.current && dist < Math.max(250, fix.speed * 15) && state.spokenTurn !== state.nextManeuverIdx) {
    state.spokenTurn = state.nextManeuverIdx;
    state.speech.enqueue({ id: `turn_${state.nextManeuverIdx}_${Date.now()}`, kind: "turn", text: `${m.text} in ${fmtMiles(dist).replace("mi", "miles").replace("ft", "feet")}.`, title: "Turn" });
  }
}

// ---------- cards ----------

function renderNextStop(fix, progressM) {
  const s = state.it.stops[state.nextStopIdx];
  const sched = state.it.schedule?.items?.find((x) => x.stopId === s?.id);
  const target = s || state.it.end;
  $("next-name").textContent = s ? `${state.nextStopIdx + 1}. ${s.name}` : `End: ${state.it.end.label}`;
  $("skip-stop").hidden = !s;
  const thumb = $("next-thumb");
  if (s?.thumbnail) { thumb.src = s.thumbnail; thumb.hidden = false; } else thumb.hidden = true;

  if (!fix) {
    $("next-meta").textContent = sched ? `planned ${to12h(sched.arrive)} – ${to12h(sched.depart)}` : "";
    return;
  }
  let distM, etaMin;
  if (progressM != null) {
    const targetAlong = s ? state.stopAlong[state.nextStopIdx] : state.total;
    distM = Math.max(0, targetAlong - progressM);
    const leg = state.it.route.legs[Math.min(state.nextStopIdx, state.it.route.legs.length - 1)];
    etaMin = leg?.distanceM ? (leg.durationSec / 60) * (distM / leg.distanceM) : distM / 13 / 60;
  } else {
    distM = haversineM(fix, target);
    etaMin = distM / 13 / 60;
  }
  const now = new Date(fix.nowMs);
  const etaHHMM = toHHMM(now.getHours() * 60 + now.getMinutes() + etaMin);
  let status = "";
  if (sched) {
    const diff = toMin(etaHHMM) - toMin(sched.arrive);
    status = diff <= 5 ? `<span class="ok">on time</span>` : diff <= 20 ? `<span class="tight">${Math.round(diff)} min behind</span>` : `<span class="late">${Math.round(diff)} min behind</span>`;
  } else if (!s) {
    const diff = toMin(etaHHMM) - toMin(state.it.deadline);
    status = diff <= -15 ? `<span class="ok">before check-in</span>` : diff <= 0 ? `<span class="tight">just in time</span>` : `<span class="late">${Math.round(diff)} min past ${to12h(state.it.deadline)}</span>`;
  }
  $("next-meta").innerHTML = `<b>${fmtMiles(distM)}</b> · ${fmtDuration(etaMin)} · ETA ${to12h(etaHHMM)} ${status}`;
}

function bindSpeech() {
  const sp = state.speech;
  const card = $("now-playing");
  sp.on("start", ({ item }) => {
    card.hidden = false;
    $("np-title").textContent = item.title || (item.kind === "stop" ? "Stop" : "Along the way");
    renderNowPlaying(item, -1);
    if (item.kind === "driveby") state.poiMarkers.get(item.id)?.openPopup();
  });
  sp.on("chunk", ({ item, index }) => renderNowPlaying(item, index));
  sp.on("end", ({ item, interrupted }) => {
    state.geofence.onNarrationEnd(item, state.lastFix?.nowMs ?? Date.now());
    log(`${interrupted ? "interrupted" : "ended"}:${item.id}`);
    if (!sp.current) setTimeout(() => { if (!sp.current) card.hidden = true; }, 4000);
    refreshMarkers();
    if (item.kind === "preview") renderStopList();
  });
}

function renderNowPlaying(item, chunkIndex) {
  const chunks = state.speech.chunkText(item.text);
  $("np-text").innerHTML = chunks.map((c, i) => `<span class="${i === chunkIndex ? "cur" : ""}">${escapeHtml(c)}</span>`).join(" ");
  const cur = $("np-text").querySelector(".cur");
  cur?.scrollIntoView?.({ block: "nearest" });
}

// ---------- start / stop / lifecycle ----------

function startDrive() {
  if (state.running) return;
  // 1. speech first, synchronously (iOS unlock)
  state.speech.unlock("Starting tour.");
  // 2. wake lock
  requestWakeLock();
  // 3. position
  if (SIM) state.sim.play();
  else if (navigator.geolocation) {
    state.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  } else notice("No GPS available in this browser.");
  storage.persist();
  state.running = true;
  $("start-btn").hidden = true;
  $("stop-btn").hidden = false;
  $("banner-primary").textContent = "Waiting for GPS…";
  log("start");
}

function stopDrive() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.sim?.pause();
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
  state.speech.stop();
  state.running = false;
  $("start-btn").hidden = false;
  $("stop-btn").hidden = true;
  $("banner-primary").textContent = "Drive ended";
  log("stop");
}

function onGeoError(err) {
  if (err.code === 1) notice("Location permission denied. Allow location for this site, then tap Start again.");
  else if (err.code === 3) $("banner-secondary").textContent = "GPS searching…";
  else notice(`GPS error: ${err.message}`);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    notice("This browser can't keep the screen awake. Set Auto-Lock to Never for the drive.");
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (e) {
    notice(`Couldn't keep the screen awake (${e.name}). Set Auto-Lock to Never.`);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.running) return;
  if (!state.wakeLock) requestWakeLock();
  if (!SIM && navigator.geolocation) {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }
  state.speech.recoverAfterResume();
  log("resumed");
});

// ---------- UI ----------

function bindUi() {
  $("start-btn").addEventListener("click", startDrive);
  $("stop-btn").addEventListener("click", stopDrive);
  $("mute-btn").addEventListener("click", () => {
    const on = !state.speech.muted;
    state.speech.setMuted(on);
    $("mute-btn").textContent = on ? "🔇" : "🔊";
    $("mute-btn").setAttribute("aria-pressed", String(on));
  });
  $("speak-turns").addEventListener("change", (e) => (state.speakTurns = e.target.checked));
  $("np-skip").addEventListener("click", () => state.speech.skip());
  $("np-replay").addEventListener("click", () => state.speech.replay());
  $("skip-stop").addEventListener("click", () => {
    const s = state.it.stops[state.nextStopIdx];
    if (s) markVisitedByUser(s.id);
  });
  $("undo-btn").addEventListener("click", () => {
    undoAction?.();
    undoAction = null;
    $("undo").hidden = true;
    clearTimeout(undoTimer);
  });
  $("overlay-import").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const pkg = JSON.parse(await file.text());
      if (!pkg?.itinerary?.route || !Array.isArray(pkg.narration)) throw new Error("Not a Tour Guide trip file");
      pkg.tripId = pkg.tripId || `trip_${Date.now().toString(36)}`;
      await storage.saveTrip(pkg);
      await usePackage(pkg);
      toast("Trip imported");
    } catch (err) {
      $("overlay-msg").textContent = err.message;
    }
  });
}

function setupSim() {
  const panel = $("sim-panel");
  panel.hidden = false;
  // sim clock starts when the itinerary says you leave the airport, so ETAs compare to the plan
  const start = state.it.date ? new Date(`${state.it.date}T00:00:00`) : new Date();
  if (Number.isNaN(start.getTime())) start.setTime(Date.now());
  const [ah, am] = String(state.it.arrivalTime || "11:30").split(":").map(Number);
  start.setHours(ah, am + (state.it.departBufferMinutes ?? 30), 0, 0);
  state.sim = createSim({ points: state.points, cum: state.cum, onFix, stops: state.it.stops, stopRadiusM: 150, startMs: start.getTime() });
  const targets = [...state.stopAlong, ...state.pkg.narration.map((n) => n.alongM)];
  $("sim-play").addEventListener("click", () => (state.sim.status().running ? state.sim.pause() : state.sim.play()));
  $("sim-speed").addEventListener("change", (e) => state.sim.setFactor(e.target.value));
  state.sim.setFactor($("sim-speed").value);
  $("sim-jump").addEventListener("click", () => state.sim.jumpToNext(targets));
  $("sim-nudge").addEventListener("click", () => state.sim.nudgeOffRoute());
  $("sim-scrub").addEventListener("input", (e) => state.sim.seek(Number(e.target.value) / 1000));
  state.sim.onChange((st) => {
    $("sim-play").textContent = st.running ? "❚❚" : "▶︎";
    if (document.activeElement !== $("sim-scrub")) $("sim-scrub").value = Math.round(st.progress * 1000);
  });
  window.__sim = state.sim;
  window.__state = state;
}

function notice(text) {
  const el = $("notice");
  el.textContent = text;
  el.hidden = !text;
  if (text) setTimeout(() => (el.hidden = true), 12000);
}

function toast(msg, ms = 2500) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), ms);
}

const eventLog = [];
function log(e) {
  const t = state.lastFix ? new Date(state.lastFix.nowMs).toLocaleTimeString() : "";
  eventLog.push(`${t} ${e}`);
  if (eventLog.length > 200) eventLog.shift();
  console.debug("[drive]", e);
  const box = $("sim-log");
  if (box && !box.parentElement.hidden) { box.textContent = eventLog.slice(-8).join("\n"); box.scrollTop = box.scrollHeight; }
}
window.__driveLog = eventLog;

boot();
