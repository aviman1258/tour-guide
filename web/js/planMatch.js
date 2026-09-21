// Does a stored drive package belong to the plan on screen? Same start and end (within ~10 m)
// and the same stops in the same order. Dates and times may differ (re-timing is allowed);
// stops may not, because the narration is tied to them. Pure, shared with tests.

const near = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

export function samePlan(a, b) {
  if (!a || !b) return false;
  if (!near(a.start, b.start) || !near(a.end, b.end)) return false;
  const sa = a.stops || [], sb = b.stops || [];
  if (sa.length !== sb.length) return false;
  return sa.every((s, i) => (s.id && sb[i].id ? s.id === sb[i].id : s.name === sb[i].name && near(s, sb[i])));
}

/** Pick the stored package that matches `it`, preferring the most recently prepared or saved one. */
export function matchingPackage(it, packages) {
  const stamp = (p) => p.savedAt || p.preparedAt || "";
  return (packages || []).filter((p) => samePlan(p.itinerary, it)).sort((x, y) => (stamp(y) > stamp(x) ? 1 : stamp(y) < stamp(x) ? -1 : 0))[0] || null;
}
