// Weather at the stops, from Open-Meteo (free, no key, called from the browser). For each stop
// we show the forecast for the hour you're planned to arrive when that hour is inside the
// forecast window (the trip date within the next 7 days), else the current conditions. Pure
// helpers are exported for tests; `forStops` does the one network call.

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

/** Weather summary for one stop from its Open-Meteo result: forecast at arrival, else current. */
export function summarize(result, { date, arrive } = {}) {
  if (!result) return null;
  const i = pickHour(result.hourly?.time, date, arrive);
  if (i >= 0) {
    const { icon, text } = wxLabel(result.hourly.weather_code[i]);
    return { tempF: Math.round(result.hourly.temperature_2m[i]), icon, text, when: "at arrival" };
  }
  if (result.current) {
    const { icon, text } = wxLabel(result.current.weather_code);
    return { tempF: Math.round(result.current.temperature_2m), icon, text, when: "now" };
  }
  return null;
}
export const wxShort = (w) => (w ? `${w.icon} ${w.tempF}°` : "");

let cache = { key: "", at: 0, data: null };
const TTL_MS = 30 * 60_000;

/**
 * One request for all stops. `stops` [{id, lat, lon}], `schedule.items` [{stopId, arrive}], `date`.
 * Resolves to Map<stopId, summary>; empty on any failure (offline, blocked) so callers can ignore it.
 */
export async function forStops(stops, schedule, date, { fetchImpl = globalThis.fetch } = {}) {
  const out = new Map();
  const pts = (stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!pts.length || !fetchImpl) return out;
  const key = pts.map((s) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`).join("|") + `|${date}`;
  try {
    let data = cache.key === key && Date.now() - cache.at < TTL_MS ? cache.data : null;
    if (!data) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map((s) => s.lat.toFixed(4)).join(",")}&longitude=${pts.map((s) => s.lon.toFixed(4)).join(",")}` +
        `&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&forecast_days=7&temperature_unit=fahrenheit&timezone=auto`;
      const r = await fetchImpl(url, { signal: AbortSignal.timeout?.(8000) });
      if (!r.ok) return out;
      const j = await r.json();
      data = Array.isArray(j) ? j : [j];
      cache = { key, at: Date.now(), data };
    }
    pts.forEach((s, i) => {
      const arrive = schedule?.items?.find((x) => x.stopId === s.id)?.arrive;
      const w = summarize(data[i], { date, arrive });
      if (w) out.set(s.id, w);
    });
  } catch { /* weather is decoration: never break the drive */ }
  return out;
}
