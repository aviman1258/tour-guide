// Distance and temperature units, chosen per device: "imperial" (miles, feet, °F) or "metric"
// (kilometres, metres, °C). The default follows the browser's region: the US, Liberia, Myanmar
// and the UK (whose road signs are in miles) start on imperial, everyone else on metric.
// Changing it fires a `tg:units` event so the screens redraw.

const KEY = "tourguide.units";
export const UNITS = ["imperial", "metric"];

export function defaultUnits(lang = globalThis.navigator?.language || "en-US") {
  const region = (String(lang).split(/[-_]/)[1] || "").toUpperCase();
  if (!region) return "imperial";
  return ["US", "LR", "MM", "GB", "PR", "GU", "VI", "AS"].includes(region) ? "imperial" : "metric";
}
export function getUnits() {
  try { const u = globalThis.localStorage?.getItem(KEY); if (UNITS.includes(u)) return u; } catch { /* no storage (server, private mode) */ }
  return defaultUnits();
}
export function setUnits(u) {
  if (!UNITS.includes(u)) return;
  try { globalThis.localStorage?.setItem(KEY, u); } catch { /* ignore */ }
  try { globalThis.dispatchEvent?.(new CustomEvent("tg:units", { detail: { units: u } })); } catch { /* not a browser */ }
}

/** Written distance: "0.3 mi", "450 ft", "4.2 km", "350 m". */
export function fmtDistance(meters, units = getUnits()) {
  const m = Math.max(0, Number(meters) || 0);
  if (units === "metric") {
    if (m < 950) return `${Math.max(10, Math.round(m / (m < 100 ? 10 : 50)) * (m < 100 ? 10 : 50))} m`;
    const km = m / 1000;
    return `${km.toFixed(km < 10 ? 1 : 0)} km`;
  }
  const mi = m / 1609.344;
  if (mi < 0.2) return `${Math.round(m * 3.28084 / 50) * 50} ft`;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

/** A temperature given in °F, shown in the chosen units: "72°" or "22°". */
export function fmtTemp(tempF, units = getUnits()) {
  if (!Number.isFinite(tempF)) return "";
  return units === "metric" ? `${Math.round((tempF - 32) * 5 / 9)}°` : `${Math.round(tempF)}°`;
}
