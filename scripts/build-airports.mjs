// Regenerates web/data/airports.json from OurAirports (public domain).
// Keeps airports with an IATA code and scheduled passenger service.
// Usage: node scripts/build-airports.mjs
import fs from "node:fs";

const SRC = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const OUT = new URL("../web/data/airports.json", import.meta.url);

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const res = await fetch(SRC, { headers: { "User-Agent": "TourGuide/0.1 build script" } });
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const rows = parseCsv(await res.text());
const head = rows.shift();
const col = Object.fromEntries(head.map((h, i) => [h, i]));

const out = [];
for (const r of rows) {
  if (r.length < head.length) continue;
  const iata = r[col.iata_code];
  if (!/^[A-Z]{3}$/.test(iata)) continue;
  if (r[col.scheduled_service] !== "yes") continue;
  if (!["large_airport", "medium_airport", "small_airport"].includes(r[col.type])) continue;
  out.push({
    c: iata,
    n: r[col.name].replace(/\s+/g, " ").trim(),
    m: r[col.municipality] || "",
    r: (r[col.iso_region] || "").replace(/^[A-Z]{2}-/, ""),
    k: r[col.iso_country],
    lat: Math.round(parseFloat(r[col.latitude_deg]) * 1e4) / 1e4,
    lon: Math.round(parseFloat(r[col.longitude_deg]) * 1e4) / 1e4,
    s: r[col.type] === "large_airport" ? 3 : r[col.type] === "medium_airport" ? 2 : 1,
  });
}
out.sort((a, b) => b.s - a.s || a.c.localeCompare(b.c));
// compact rows: [code, name, city, region, country, lat, lon, size]
fs.writeFileSync(OUT, JSON.stringify(out.map((a) => [a.c, a.n, a.m, a.r, a.k, a.lat, a.lon, a.s])));
console.log(`wrote ${out.length} airports (${Math.round(fs.statSync(OUT).size / 1024)} KB) to ${OUT.pathname}`);
