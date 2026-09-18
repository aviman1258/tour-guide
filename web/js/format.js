// Time and distance formatting. Times are local "HH:MM" strings.

export function toMinutes(hhmm) {
  if (!hhmm) return NaN;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function toHHMM(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function to12h(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ap}`;
}

export function fmtDuration(minutes) {
  const m = Math.round(Math.abs(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + " min" : ""}`.trim();
}

export function fmtMiles(meters) {
  const mi = meters / 1609.344;
  if (mi < 0.2) return `${Math.round(meters * 3.28084 / 50) * 50} ft`;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
