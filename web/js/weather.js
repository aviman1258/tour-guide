import { fmtTemp } from "./units.js";
// Weather at the stops, from Open-Meteo (free, no key, called from the browser), for the hour
// you're planned to arrive, chosen by how far away the trip is:
//   up to 15 days ahead  → the hourly forecast                     (when: "forecast")
//   further ahead        → typical weather: the same date and hour averaged over the last three
//                          years from the historical archive        (when: "typical")
//   a date in the past   → what the weather actually was that day    (when: "actual")
//   no date / no times   → current conditions                        (when: "now")
// Pure helpers are exported for tests; `forStops` does the network calls (one, or three for typical).

const WX = [
  [[0], "☀️", "clear"], [[1], "🌤️", "mostly clear"], [[2], "⛅", "partly cloudy"], [[3], "☁️", "overcast"],
  [[45, 48], "🌫️", "fog"], [[51, 53, 55, 56, 57], "🌦️", "drizzle"], [[61, 63, 65, 66, 67], "🌧️", "rain"],
  [[71, 73, 75, 77], "🌨️", "snow"], [[80, 81, 82], "🌦️", "showers"], [[85, 86], "🌨️", "snow showers"],
  [[95], "⛈️", "thunderstorm"], [[96, 99], "⛈️", "thunderstorm with hail"],
];
/** WMO weather code → { icon, text }. */
export function wxLabel(code) {
  const row = WX.find(([codes]) => codes.includes(Number(code)));
  return row ? { icon: row[1], text: row[2] } : { icon: "🌡️", text: "" };
}

/** Index of the hourly entry for `date` + `hhmm` in Open-Meteo's local-time list, or -1. */
export function pickHour(times, date, hhmm) {
  if (!Array.isArray(times) || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(hhmm || "")) return -1;
  const hour = hhmm.slice(0, 2);
  return times.findIndex((t) => t.startsWith(`${date}T${hour}:`));
}

/** Weather summary for one stop from its Open-Meteo result: the arrival hour, else current. */
export function summarize(result, { date, arrive, when = "forecast" } = {}) {
  if (!result) return null;
  const i = pickHour(result.hourly?.time, date, arrive);
  if (i >= 0 && Number.isFinite(result.hourly.temperature_2m[i])) {
    const { icon, text } = wxLabel(result.hourly.weather_code[i]);
    return { tempF: Math.round(result.hourly.temperature_2m[i]), icon, text, when };
  }
  if (result.current) {
    const { icon, text } = wxLabel(result.current.weather_code);
    return { tempF: Math.round(result.current.temperature_2m), icon, text, when: "now" };
  }
  return null;
}
export const wxShort = (w) => (w ? `${w.icon} ${fmtTemp(w.tempF)}` : "");
/** What the reading is, in words, for tooltips: "forecast", "typical for Nov 14 (2023–2025)", … */
export function wxWhen(w) {
  if (!w) return "";
  if (w.when === "typical") return `typical for this date (${w.years || "last three years"})`;
  if (w.when === "actual") return "what it was that day";
  if (w.when === "now") return "right now";
  return "forecast for your arrival";
}

const DAY = 86400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Days from today (UTC calendar) to `date`; NaN when it isn't a date. */
export function daysAhead(date, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return NaN;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ymd(now)}T00:00:00Z`)) / DAY);
}
export const FORECAST_DAYS = 16;
/** Which kind of weather a trip date gets. */
export function modeFor(date, now = Date.now()) {
  const d = daysAhead(date, now);
  if (!Number.isFinite(d)) return "now";
  if (d < 0) return "actual";
  return d < FORECAST_DAYS ? "forecast" : "typical";
}
/** The same month-day in the last three years the archive already covers (it lags about five days). */
export function typicalDates(date, now = Date.now()) {
  const md = date.slice(5) === "02-29" ? "02-28" : date.slice(5);
  const latest = ymd(now - 6 * DAY);
  const out = [];
  for (let y = Number(date.slice(0, 4)); out.length < 3 && y > 1950; y--) { const d = `${y}-${md}`; if (d <= latest) out.push(d); }
  return out;
}
/** Average several years' results for the arrival hour: mean temperature, most frequent sky. */
export function typicalOf(results, dates, arrive) {
  const temps = [], codes = [];
  results.forEach((r, k) => {
    const i = pickHour(r?.hourly?.time, dates[k], arrive || "12:00");
    if (i >= 0 && Number.isFinite(r.hourly.temperature_2m[i])) { temps.push(r.hourly.temperature_2m[i]); codes.push(r.hourly.weather_code[i]); }
  });
  if (!temps.length) return null;
  const count = new Map();
  for (const c of codes) count.set(c, (count.get(c) || 0) + 1);
  const code = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]; // ties go to the wetter sky
  const { icon, text } = wxLabel(code);
  const ys = dates.map((d) => d.slice(0, 4)).sort();
  return { tempF: Math.round(temps.reduce((a, b) => a + b, 0) / temps.length), icon, text, when: "typical", years: ys.length > 1 ? `${ys[0]}–${ys.at(-1)}` : ys[0] };
}

let cache = { key: "", at: 0, data: null };
const TTL_MS = 30 * 60_000;

/**
 * One request for all stops. `stops` [{id, lat, lon}], `schedule.items` [{stopId, arrive}], `date`.
 * Resolves to Map<stopId, summary>; empty on any failure (offline, blocked) so callers can ignore it.
 */
export async function forStops(stops, schedule, date, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const out = new Map();
  const pts = (stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!pts.length || !fetchImpl) return out;
  const mode = modeFor(date, now);
  const lat = pts.map((s) => s.lat.toFixed(4)).join(","), lon = pts.map((s) => s.lon.toFixed(4)).join(",");
  const common = `latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
  const get = async (url) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout?.(8000) });
    if (!r.ok) throw new Error(`weather ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : [j];
  };
  const key = `${mode}|${date}|` + pts.map((s) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`).join("|");
  const arriveOf = (s) => schedule?.items?.find((x) => x.stopId === s.id)?.arrive;
  try {
    let data = cache.key === key && Date.now() - cache.at < TTL_MS ? cache.data : null;
    if (!data) {
      if (mode === "typical") {
        const dates = typicalDates(date, now);
        const years = await Promise.all(dates.map((d) => get(`https://archive-api.open-meteo.com/v1/archive?${common}&start_date=${d}&end_date=${d}`)));
        data = { dates, years };
      } else if (mode === "actual") {
        data = await get(`https://archive-api.open-meteo.com/v1/archive?${common}&start_date=${date}&end_date=${date}`);
      } else {
        const days = mode === "forecast" ? Math.min(FORECAST_DAYS, Math.max(1, daysAhead(date, now) + 1)) : 1;
        data = await get(`https://api.open-meteo.com/v1/forecast?${common}&current=temperature_2m,weather_code&forecast_days=${days}`);
      }
      cache = { key, at: Date.now(), data };
    }
    pts.forEach((s, i) => {
      const w = mode === "typical"
        ? typicalOf(data.years.map((y) => y[i]), data.dates, arriveOf(s))
        : summarize(data[i], { date, arrive: arriveOf(s), when: mode === "actual" ? "actual" : "forecast" });
      if (w) out.set(s.id, w);
    });
  } catch { /* weather is decoration: never break the plan or the drive */ }
  return out;
}
