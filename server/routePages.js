// Public, server-rendered pages for published routes: /routes (index) and /routes/:id/:slug.
// Plain HTML with the stops, a small SVG of the route and a "drive it free" button, so search
// engines index every published route as its own landing page. Everything user-written is
// HTML-escaped here (and was filtered by lib/moderation.js when published).

import { escapeHtml as esc, fmtDuration } from "../web/js/format.js";

export const BASE = "https://deodapper.com";

export const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "route";
export const routeUrl = (r) => `${BASE}/routes/${encodeURIComponent(r.id)}/${slug(r.title)}`;

/** Points of a route geometry: GeoJSON LineString or a bare [lon,lat][] array. */
function pointsOf(geometry) {
  const coords = Array.isArray(geometry) ? geometry : geometry?.coordinates || [];
  return coords.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])).map(([lon, lat]) => ({ lat, lon }));
}

/** A compact inline SVG: the route line, numbered stop dots, start and end markers. */
export function routeSvg(geometry, stops = [], start, end, { width = 640, height = 320 } = {}) {
  const pts = pointsOf(geometry);
  const all = [...pts, ...stops, start, end].filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (all.length < 2) return "";
  const lats = all.map((p) => p.lat), lons = all.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 24;
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180); // shrink longitude so the shape isn't stretched
  const w = (maxLon - minLon) * kx || 1e-6, hgt = (maxLat - minLat) || 1e-6;
  const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / hgt);
  const ox = (width - w * scale) / 2, oy = (height - hgt * scale) / 2;
  const X = (p) => (ox + (p.lon - minLon) * kx * scale).toFixed(1);
  const Y = (p) => (height - oy - (p.lat - minLat) * scale).toFixed(1);
  // thin the line to ~400 points so the page stays small
  const step = Math.max(1, Math.floor(pts.length / 400));
  const line = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p, i) => `${i ? "L" : "M"}${X(p)} ${Y(p)}`).join("");
  const dot = (p, cls, label) => `<g class="${cls}"><circle cx="${X(p)}" cy="${Y(p)}" r="11"/><text x="${X(p)}" y="${Number(Y(p)) + 4}" text-anchor="middle">${esc(label)}</text></g>`;
  return `<svg class="route-map" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Shape of the route with numbered stops">
  <path d="${line}" fill="none" stroke="#1f5f8b" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
  ${start ? dot(start, "start", "S") : ""}${end ? dot(end, "end", "E") : ""}${stops.map((s, i) => dot(s, "stop", String(i + 1))).join("")}
</svg>`;
}

const firstSentence = (t) => { const m = String(t || "").trim().match(/^[^.!?]+[.!?]/); return m ? m[0] : String(t || "").trim().slice(0, 160); };

function shell({ title, description, canonical, body, jsonLd, image = `${BASE}/img/og.png` }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#1f5f8b" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Deodapper" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" type="image/svg+xml" href="/img/deodap.svg" />
  <link rel="stylesheet" href="/css/landing.css" />
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body class="landing doc routes">
  <main class="doc-body">
    <a class="doc-home" href="/"><img src="/img/deodap.svg" alt="" width="36" height="36" /> Deodapper</a>
${body}
    <p class="foot"><a href="/routes">All saved routes</a> · <a href="/">Deodapper home</a> · <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p>
  </main>
</body>
</html>`;
}

/** One published route. `summary` from library.get().summary, `pkg` the drive package. */
export function routePage(summary, pkg) {
  const it = pkg.itinerary;
  const r = summary;
  const canonical = routeUrl(r);
  const hours = fmtDuration(r.minutes);
  const description = (r.description && r.description.trim()) || `A ${r.stopsCount}-stop self-guided drive from ${r.startLabel} to ${r.endLabel}: ${r.stopNames.slice(0, 4).join(", ")}${r.stopNames.length > 4 ? " and more" : ""}. ${r.miles} miles, about ${hours} of driving, narrated as you go.`;
  const narrationFor = (s) => (pkg.narration || []).find((n) => n.kind === "stop" && n.targetId === s.id)?.text || "";
  const stops = it.stops.map((s, i) => `
      <li class="route-stop">
        <div class="route-stop-head"><span class="num">${i + 1}</span><h3>${esc(s.name)}</h3>${s.lunch && s.lunch !== "none" ? `<span class="tag">${s.lunch === "auto" ? "lunch" : "meal"}</span>` : ""}</div>
        ${s.blurb ? `<p>${esc(s.blurb)}</p>` : ""}
        ${narrationFor(s) ? `<p class="route-narr">“${esc(firstSentence(narrationFor(s)))}”</p>` : ""}
        <p class="route-meta">${s.dwellMinutes} min stop${s.wikipediaUrl ? ` · <a href="${esc(s.wikipediaUrl)}" rel="noopener">Wikipedia</a>` : ""}</p>
      </li>`).join("");
  const drivebys = (pkg.narration || []).filter((n) => n.kind === "driveby").length;
  const body = `
    <h1>${esc(r.title)}</h1>
    <p class="doc-date">${esc(r.region || "")}${r.region ? " · " : ""}${r.stopsCount} stops · ${r.miles} mi · about ${esc(hours)} driving · ${r.narrationCount} spoken stories${r.uses ? ` · driven ${r.uses}×` : ""}</p>
    ${r.description ? `<p class="lede-left">${esc(r.description)}</p>` : ""}
    <div class="route-cta">
      <a class="btn-cta" href="/plan.html?tier=free&route=${encodeURIComponent(r.id)}">Drive this route free</a>
      <a class="btn-cta ghost" href="/plan.html?tier=create">Create your own route</a>
    </div>
    ${routeSvg(it.route?.geometry, it.stops, it.start, it.end)}
    <p class="route-ends"><b>From</b> ${esc(r.startLabel)} <b>to</b> ${esc(r.endLabel)}</p>
    <h2>The stops</h2>
    <ol class="route-stops">${stops}
    </ol>
    ${drivebys ? `<p class="route-meta">Plus ${drivebys} short stories about places you pass on the way, spoken when you get there.</p>` : ""}
    <h2>How it works</h2>
    <p>Open the route on your phone, set the day and time you're driving, save it, and put the phone on the mount. Deodapper follows you by GPS and narrates each stop as you arrive, offline once saved. Free for saved routes like this one; creating your own around your interests is $1.99 to $4.49 a route.</p>`;
  const jsonLd = {
    "@context": "https://schema.org", "@type": "TouristTrip", name: r.title, description, url: canonical,
    touristType: "Self-drive", provider: { "@type": "Organization", name: "Deodapper", url: BASE },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Drive this saved route free with narration" },
    itinerary: { "@type": "ItemList", numberOfItems: it.stops.length, itemListElement: it.stops.map((s, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "TouristAttraction", name: s.name, ...(s.wikipediaUrl ? { sameAs: s.wikipediaUrl } : {}), geo: { "@type": "GeoCoordinates", latitude: s.lat, longitude: s.lon } } })) },
  };
  return shell({ title: `${r.title} · a self-guided driving route`, description, canonical, body, jsonLd });
}

/** The index of all published routes. */
export function indexPage(routes) {
  const cards = routes.map((r) => `
      <li class="route-card">
        <a href="${esc(routeUrl(r))}"><b>${esc(r.title)}</b></a>
        <div class="route-meta">${esc(r.region || "")}${r.region ? " · " : ""}${r.stopsCount} stops · ${r.miles} mi · about ${esc(fmtDuration(r.minutes))}${r.uses ? ` · driven ${r.uses}×` : ""}</div>
        ${r.description ? `<p>${esc(r.description)}</p>` : ""}
        <div class="route-meta">${esc(r.startLabel)} → ${esc(r.endLabel)}</div>
      </li>`).join("");
  const description = `${routes.length} self-guided driving routes with spoken narration, free to drive: ${routes.slice(0, 3).map((r) => r.title).join("; ")}${routes.length > 3 ? " and more" : ""}.`;
  const body = `
    <h1>Saved routes, free to drive</h1>
    <p class="doc-date">${routes.length} published route${routes.length === 1 ? "" : "s"} · each narrated stop by stop as you drive</p>
    <p class="lede-left">Routes people built with Deodapper and shared. Pick one near you, set your own day and time, and Deodap tells the stories as you pass each place. Want one built around your own interests? <a href="/plan.html?tier=create">Create your own</a> from $1.99.</p>
    ${routes.length ? `<ul class="route-cards">${cards}\n    </ul>` : `<p>No routes have been published yet. Be the first: <a href="/plan.html?tier=create">create one</a> and publish it.</p>`}`;
  const jsonLd = { "@context": "https://schema.org", "@type": "ItemList", name: "Deodapper saved routes", url: `${BASE}/routes`, numberOfItems: routes.length, itemListElement: routes.map((r, i) => ({ "@type": "ListItem", position: i + 1, url: routeUrl(r), name: r.title })) };
  return shell({ title: "Saved driving routes, free to drive · Deodapper", description, canonical: `${BASE}/routes`, body, jsonLd });
}

/** sitemap.xml: the static pages plus every published route. */
export function sitemap(routes, today = new Date().toISOString().slice(0, 10)) {
  const url = (loc, lastmod, changefreq, priority) => `  <url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  const lines = [
    url(`${BASE}/`, today, "weekly", "1.0"), url(`${BASE}/plan.html`, today, "weekly", "0.8"), url(`${BASE}/routes`, today, "daily", "0.9"),
    url(`${BASE}/terms.html`, "2026-09-21", "yearly", "0.3"), url(`${BASE}/privacy.html`, "2026-09-21", "yearly", "0.3"),
    ...routes.map((r) => url(routeUrl(r), String(r.createdAt || today).slice(0, 10), "monthly", "0.7")),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join("\n")}\n</urlset>\n`;
}

export function notFoundPage() {
  return shell({ title: "Route not found · Deodapper", description: "That saved route is no longer available.", canonical: `${BASE}/routes`, body: `<h1>That route isn't here any more</h1><p>It may have been removed by its author. <a href="/routes">See the routes that are available</a>.</p>` });
}
