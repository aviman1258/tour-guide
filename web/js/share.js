// Shareable link (itinerary compressed into the URL hash) + Google Maps links.

import * as state from "./state.js";
import { toast } from "./itinerary.js";

const $ = (id) => document.getElementById(id);

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function compress(str) {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str));
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function decompress(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}

/** Compact copy: drop geometry and trim long text. The receiver re-schedules. */
function compact(it) {
  return {
    ...it,
    route: null,
    schedule: null,
    stops: it.stops.map((s) => ({
      ...s,
      blurb: (s.blurb || "").slice(0, 300),
      whyItMatches: (s.whyItMatches || "").slice(0, 200),
    })),
  };
}

export async function encode(it) {
  return "#i=" + b64url(await compress(JSON.stringify(compact(it))));
}

export async function loadFromHash() {
  const m = location.hash.match(/^#i=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const it = JSON.parse(await decompress(unb64url(m[1])));
    return it && it.version === 1 ? it : null;
  } catch (err) {
    console.warn("bad share link", err);
    return null;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// ---------- Google Maps ----------

const gm = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

/** Full-route URL. Google caps waypoints (9 desktop, 3 mobile browsers). */
export function googleMapsUrl(origin, waypoints, destination) {
  const u = new URL("https://www.google.com/maps/dir/?api=1");
  u.searchParams.set("origin", gm(origin));
  u.searchParams.set("destination", gm(destination));
  u.searchParams.set("travelmode", "driving");
  if (waypoints.length) u.searchParams.set("waypoints", waypoints.map(gm).join("|"));
  return u.toString();
}

/** Split into legs of at most `max` waypoints; each leg's destination is the next leg's origin. */
export function googleMapsLegs(it, max) {
  const pts = [it.start, ...it.stops, it.end];
  const legs = [];
  let i = 0;
  while (i < pts.length - 1) {
    const end = Math.min(pts.length - 1, i + max + 1);
    legs.push({ from: pts[i], to: pts[end], via: pts.slice(i + 1, end), url: googleMapsUrl(pts[i], pts.slice(i + 1, end), pts[end]) });
    i = end;
  }
  return legs;
}

export function bind() {
  $("share-btn").addEventListener("click", async () => {
    const it = state.get();
    const url = location.origin + location.pathname + (await encode(it));
    if (url.length > 8000) toast("Link is long; some apps may truncate it", 4000);
    toast((await copyText(url)) ? "Link copied" : "Couldn't copy; see console");
    console.log(url);
  });

  $("gmaps-btn").addEventListener("click", () => {
    const it = state.get();
    const mobile = matchMedia("(pointer:coarse)").matches;
    const legs = googleMapsLegs(it, mobile ? 3 : 9);
    const box = $("gmaps-legs");
    box.innerHTML = "";
    if (legs.length === 1) {
      window.open(legs[0].url, "_blank", "noopener");
      return;
    }
    legs.forEach((leg, i) => {
      const a = document.createElement("a");
      a.className = "btn btn-sm";
      a.href = leg.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `Leg ${i + 1}: ${leg.from.label || leg.from.name} → ${leg.to.label || leg.to.name}`;
      box.appendChild(a);
    });
    toast(`Google Maps limits waypoints, so the route is split into ${legs.length} legs`, 4000);
  });
}
