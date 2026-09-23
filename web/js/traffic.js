// Typical-traffic model: how much slower a leg runs than the router's free-flow time, given
// when it departs. The public routers (Valhalla, OSRM) have no traffic data, so this is a
// schedule of multipliers shaped like US metro congestion curves: sharp weekday peaks, a
// midday plateau, quiet nights, a mild weekend bulge. Highway legs are damped a little because
// free-flow highway times already assume higher speeds that congestion eats into less, in
// proportion. Deterministic and shared by server and client; not a substitute for a live or
// historical traffic API, which is a later, paid upgrade.

/** Multiplier for a leg leaving at `minuteOfDay` (0-1439) on `dayOfWeek` (0 = Sunday). */
export function trafficFactor(minuteOfDay, dayOfWeek = 3) {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const h = m / 60;
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (weekend) {
    if (h >= 11 && h < 18) return 1.15; // shopping / leisure traffic
    if (h >= 9 && h < 11) return 1.08;
    if (h >= 18 && h < 20) return 1.08;
    return 1.0;
  }
  if (h >= 7.5 && h < 8.75) return 1.45; // morning peak
  if (h >= 6.5 && h < 9.5) return 1.3;
  if (h >= 16.5 && h < 18) return 1.5; // evening peak
  if (h >= 15.5 && h < 19) return 1.35;
  if (h >= 9.5 && h < 15.5) return 1.1; // midday
  if (h >= 19 && h < 21) return 1.12;
  return 1.0; // night
}

/** Highway-ish legs (free-flow average over ~20 m/s ≈ 45 mph) feel congestion a bit less in proportion. */
export function dampenForSpeed(factor, avgSpeedMps) {
  if (!Number.isFinite(avgSpeedMps) || avgSpeedMps < 20) return factor;
  return 1 + (factor - 1) * 0.8;
}

/** Day of week for a "YYYY-MM-DD" date, or a weekday (Wednesday) when missing/invalid. */
export function dayOfWeekFor(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return 3;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * Minutes a leg takes with typical traffic. `freeMinutes` from the router, `departMinute` the
 * clock time it starts, `legMeters` optional (for the highway damping).
 */
export function trafficMinutes(freeMinutes, departMinute, dayOfWeek, legMeters = null) {
  const speed = legMeters != null && freeMinutes > 0 ? legMeters / (freeMinutes * 60) : null;
  return freeMinutes * dampenForSpeed(trafficFactor(departMinute, dayOfWeek), speed);
}
