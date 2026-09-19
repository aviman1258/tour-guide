// Type-ahead place search on Komoot's Photon (OpenStreetMap data, built for autocomplete;
// Nominatim's policy forbids autocomplete, so it is only used for explicit searches).
// attach(input, { near, onPick }) → { setValue, destroy }

const PHOTON = "https://photon.komoot.io/api/";
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;
const cache = new Map();

function labelOf(f) {
  const p = f.properties || {};
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.city || p.state || "Unnamed place";
  const sub = [p.street && p.name ? p.street : null, p.city || p.county, p.state, p.country === "United States" ? null : p.country].filter(Boolean).join(", ");
  return { name, sub, kind: p.osm_value || p.type || "" };
}

async function query(q, near, signal) {
  const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ""}`;
  if (cache.has(key)) return cache.get(key);
  const u = new URL(PHOTON);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "8");
  u.searchParams.set("lang", "en");
  if (near) { u.searchParams.set("lat", near.lat); u.searchParams.set("lon", near.lon); }
  const res = await fetch(u, { signal });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const data = await res.json();
  const seen = new Set();
  const items = [];
  for (const f of data.features || []) {
    const [lon, lat] = f.geometry.coordinates;
    const { name, sub, kind } = labelOf(f);
    // same name in the same city (station + attraction + neighbourhood, sign + terminal…) → one entry
    const p = f.properties || {};
    const dupe = `${name.toLowerCase()}|${String(p.city || p.county || "").toLowerCase()}|${String(p.state || "").toLowerCase()}`;
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    items.push({ label: name, sub, kind, lat, lon });
    if (items.length >= 6) break;
  }
  cache.set(key, items);
  return items;
}

// ---------- airports (bundled, so IATA codes like SNA work, offline too) ----------

let airportsPromise = null;
function airports() {
  if (!airportsPromise) {
    // rows are [code, name, city, region, country, lat, lon, size]
    airportsPromise = fetch(new URL("../data/airports.json", import.meta.url))
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => rows.map(([c, n, m, r, k, lat, lon, s]) => ({ c, n, m, r, k, lat, lon, s })))
      .catch(() => []);
  }
  return airportsPromise;
}

const US_STATE_NAMES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "Washington DC" };

/**
 * Airport matches for a query: an exact IATA code ("SNA", "sna airport") wins outright;
 * otherwise name / city prefix matches, biggest airports first. Returns typeahead items.
 */
async function airportMatches(q, near) {
  const list = await airports();
  if (!list.length) return [];
  const raw = q.trim().toLowerCase();
  const stripped = raw.replace(/\b(airport|intl|international)\b/g, "").trim();
  const toItem = (a) => ({
    label: `${a.n} (${a.c})`,
    sub: [a.m, a.k === "US" ? US_STATE_NAMES[a.r] || a.r : a.r, a.k === "US" ? null : a.k].filter(Boolean).join(", "),
    kind: "airport", lat: a.lat, lon: a.lon, code: a.c,
  });
  if (/^[a-z]{3}$/.test(stripped)) {
    const exact = list.filter((a) => a.c.toLowerCase() === stripped);
    if (exact.length) return exact.map(toItem);
  }
  if (stripped.length < 3) return [];
  const words = stripped.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const a of list) {
    const hay = `${a.n} ${a.m} ${a.c}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    let score = a.s * 10 + (a.c.toLowerCase() === stripped ? 100 : 0) + (a.n.toLowerCase().startsWith(stripped) || a.m.toLowerCase().startsWith(stripped) ? 5 : 0);
    if (near) score -= Math.min(20, Math.hypot(a.lat - near.lat, (a.lon - near.lon) * Math.cos((near.lat * Math.PI) / 180)) / 5);
    scored.push({ a, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, 3).map(({ a }) => toItem(a));
}

/** Reverse geocode for a friendly "current location" label; null on failure. */
export async function reverseLabel(lat, lon) {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`);
    const f = (await res.json()).features?.[0];
    if (!f) return null;
    const { name, sub } = labelOf(f);
    return [name, sub].filter(Boolean).join(", ");
  } catch {
    return null;
  }
}

export function attach(input, { near = () => null, onPick }) {
  const wrap = input.parentElement;
  const list = document.createElement("ul");
  list.className = "suggest";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.appendChild(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");

  let items = [], active = -1, timer = null, ctrl = null, blurTimer = null;
  let pickWhenReady = false; // Enter pressed while a search was still running

  function hide() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  }

  function render(status) {
    list.innerHTML = "";
    if (status) {
      const li = document.createElement("li");
      li.className = "status";
      li.textContent = status;
      list.appendChild(li);
    }
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      li.innerHTML = `<div class="name"></div><div class="sub"></div>`;
      li.querySelector(".name").textContent = it.label;
      li.querySelector(".sub").textContent = [it.kind && it.kind !== "yes" ? it.kind.replace(/_/g, " ") : null, it.sub].filter(Boolean).join(" · ");
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus so blur doesn't hide first
      li.addEventListener("click", () => pick(i));
      list.appendChild(li);
    });
    list.hidden = !list.children.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    input.value = it.label;
    hide();
    onPick(it);
  }

  async function search() {
    const q = input.value.trim();
    if (q.length < MIN_CHARS) { items = []; hide(); return; }
    ctrl?.abort();
    ctrl = new AbortController();
    items = []; // never leave the previous query's rows pickable while the new one is in flight
    render("Searching…");
    try {
      const [fromAirports, fromPhoton] = await Promise.all([
        airportMatches(q, near()),
        query(q, near(), ctrl.signal).catch((err) => { if (err.name === "AbortError") throw err; return []; }),
      ]);
      // airports first (a code like SNA should win), then Photon minus its own copy of the same airfield
      const sameAirport = (p) => p.kind === "aerodrome" && fromAirports.some((a) => Math.hypot(a.lat - p.lat, (a.lon - p.lon) * Math.cos((a.lat * Math.PI) / 180)) < 0.04);
      items = [...fromAirports, ...fromPhoton.filter((p) => !sameAirport(p))].slice(0, 7);
      active = -1;
      if (pickWhenReady && items.length) { pickWhenReady = false; pick(0); return; }
      pickWhenReady = false;
      render(items.length ? "" : "No matches. Try adding the city.");
    } catch (err) {
      if (err.name === "AbortError") return;
      items = [];
      render("Search unavailable right now.");
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });
  input.addEventListener("focus", () => { if (items.length && input.value.trim().length >= MIN_CHARS) render(""); });
  input.addEventListener("blur", () => { blurTimer = setTimeout(hide, 150); });
  input.addEventListener("keydown", (e) => {
    if (list.hidden && e.key === "ArrowDown" && items.length) { render(""); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (items.length) pick(active >= 0 ? active : 0);
      else if (input.value.trim().length >= MIN_CHARS) { pickWhenReady = true; clearTimeout(timer); search(); } // results are cached, so re-searching is cheap
      return;
    }
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(""); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(""); }
    else if (e.key === "Escape") { hide(); }
  });

  return {
    setValue(v) { if (document.activeElement !== input) input.value = v ?? ""; },
    destroy() { clearTimeout(timer); clearTimeout(blurTimer); ctrl?.abort(); list.remove(); },
  };
}
