// Leaflet map for the plan/edit screen: numbered markers, route polyline, click-to-add.

import { escapeHtml } from "./format.js";

let map, layer, routeLayer, onClickHandler = null;
let lastKey = "";

export function init(el) {
  // no trip yet: show the continental US; render() fits to the trip as soon as there are points
  map = L.map(el, { zoomControl: true, preferCanvas: true }).setView([39.5, -98.35], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    errorTileUrl: "icons/blank-tile.png",
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  map.on("click", (e) => onClickHandler?.(e.latlng.lat, e.latlng.lng));
  return map;
}

export function onMapClick(fn) {
  onClickHandler = fn;
}

function icon(label, cls) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-num ${cls}"><span>${label}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [4, 28],
    popupAnchor: [10, -26],
  });
}

function popup(stop, extra = "") {
  return `
    ${stop.thumbnail ? `<img src="${escapeHtml(stop.thumbnail)}" alt="" loading="lazy">` : ""}
    <b>${escapeHtml(stop.name)}</b>${extra}
    ${stop.blurb ? `<div>${escapeHtml(stop.blurb)}</div>` : ""}
    ${stop.wikipediaUrl ? `<a href="${escapeHtml(stop.wikipediaUrl)}" target="_blank" rel="noopener">Wikipedia</a> · ` : ""}
    <a href="https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}&dir_action=navigate" target="_blank" rel="noopener">Navigate</a>
  `;
}

/** Redraw markers + route from the itinerary. Fits bounds only when the set of points changed. */
export function render(it) {
  if (!map) return;
  layer.clearLayers();
  routeLayer.clearLayers();
  const pts = [];

  if (it.start) {
    L.marker([it.start.lat, it.start.lon], { icon: icon("S", "start") }).bindPopup(`<b>${escapeHtml(it.start.label)}</b>`).addTo(layer);
    pts.push([it.start.lat, it.start.lon]);
  }
  it.stops.forEach((s, i) => {
    const sched = it.schedule?.items?.find((x) => x.stopId === s.id);
    const extra = sched ? `<div style="color:#888">${sched.arrive} – ${sched.depart}</div>` : "";
    const cls = s.lunch !== "none" ? "lunch" : "";
    L.marker([s.lat, s.lon], { icon: icon(String(i + 1), cls) }).bindPopup(popup(s, extra)).addTo(layer);
    pts.push([s.lat, s.lon]);
  });
  if (it.end) {
    L.marker([it.end.lat, it.end.lon], { icon: icon("E", "end") }).bindPopup(`<b>${escapeHtml(it.end.label)}</b>`).addTo(layer);
    pts.push([it.end.lat, it.end.lon]);
  }

  if (it.route?.geometry) {
    L.geoJSON(it.route.geometry, { style: { color: "#1f5f8b", weight: 5, opacity: 0.85 } }).addTo(routeLayer);
  } else if (pts.length > 1) {
    L.polyline(pts, { color: "#1f5f8b", weight: 3, dashArray: "6 8", opacity: 0.6 }).addTo(routeLayer);
  }

  const key = pts.map((p) => p.join(",")).join("|");
  if (pts.length && key !== lastKey) {
    lastKey = key;
    map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  }
}

export function focus(lat, lon, zoom = 15) {
  map?.setView([lat, lon], zoom);
}
