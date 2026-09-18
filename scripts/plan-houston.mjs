// Dev helper: run the Houston example through a local server and print a readable summary.
// Usage: node scripts/plan-houston.mjs [http://localhost:3001] [--save plan-out.json]

import fs from "node:fs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3001";
const saveIdx = process.argv.indexOf("--save");
const savePath = saveIdx > -1 ? process.argv[saveIdx + 1] : null;

const body = {
  start: { label: "Houston Bush Intercontinental (IAH)", lat: 29.9902, lon: -95.3368 },
  end: { label: "Hyatt Regency Houston Galleria", lat: 29.7395, lon: -95.4633 },
  date: "2026-11-14",
  arrivalTime: "11:30",
  deadline: "15:00",
  interests: "indian stuff, historic neighborhoods, upper affluent",
};

const t0 = Date.now();
const res = await fetch(`${base}/api/plan`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(420_000),
});
const r = await res.json();
console.log(`HTTP ${res.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
if (savePath) fs.writeFileSync(savePath, JSON.stringify(r, null, 1));
if (r.error) {
  console.log("ERROR:", r.error);
  process.exit(1);
}

console.log("SUMMARY:", r.summary);
const s = r.schedule;
console.log(`SCHEDULE: hotel ${s.hotelArrive}, slack ${s.slackMinutes} min, ${s.status}, lunch=${s.lunchStopId}, warnings=${JSON.stringify(s.warnings)}`);
for (const st of r.stops) {
  const it = s.items.find((x) => x.stopId === st.id);
  console.log(`- ${st.name} [${st.category} p${st.priority} ${st.dwellMinutes}m ${st.lunch}] ${st.source} "${st.wikipediaTitle || ""}" ${it ? `${it.arrive}-${it.depart} (+${it.legMinutes}m drive)` : ""} thumb:${Boolean(st.thumbnail)}`);
}
console.log("DROPPED:", r.dropped.map((d) => `${d.name} (${d.reason})`).join(", ") || "none");
console.log(`ROUTE: ${r.route.legs.length} legs, ${(r.route.totalM / 1609).toFixed(1)} mi, ${Math.round(r.route.totalSec / 60)} min driving, steps in leg 0: ${r.route.legs[0].steps?.length}`);
