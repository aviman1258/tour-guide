// Turn-by-turn steps from a routed leg list, flattened into one ordered array with a position
// along the polyline. Pure; used by the drive screen for the main route and for detours.

import { project } from "./routeMath.js";

/**
 * flattenManeuvers(route, points, cum, names) → [{ legIndex, type, modifier, exit, name, atM, text, short, verbal }]
 *   names: { stops: [name per leg end], end: label of the final arrival }
 * Valhalla gives ready-made instructions; OSRM steps fall back to our own wording.
 */
export function flattenManeuvers(route, points, cum, names = {}) {
  const out = [];
  const legs = route.legs || [];
  legs.forEach((leg, legIndex) => {
    for (const st of leg.steps || []) {
      const m = st.maneuver;
      if (!m || m.type === "depart") continue;
      const loc = { lat: m.location[1], lon: m.location[0] };
      const p = project(points, cum, loc);
      const arriveName = legIndex === legs.length - 1 ? names.end : names.stops?.[legIndex];
      const text = m.type === "arrive" ? `Arrive at ${arriveName || "your stop"}` : (st.instruction || "").replace(/\.$/, "") || maneuverText(m, st, arriveName);
      // short form, for "turn left now": Valhalla's succinct line, else our wording without the road
      const short = m.type === "arrive" ? `Arriving at ${arriveName || "your stop"}` : (st.verbalSuccinct || "").replace(/\.$/, "") || maneuverText(m, { ...st, name: "", ref: "" }, arriveName);
      out.push({ legIndex, type: m.type, modifier: m.modifier, exit: m.exit, name: st.name || st.ref || "", atM: p.progressM, text, short, verbal: st.verbalAlert || "" });
    }
  });
  return out.sort((a, b) => a.atM - b.atM);
}

const MOD = { uturn: "make a U-turn", "sharp right": "sharp right", right: "right", "slight right": "slightly right", straight: "straight", "slight left": "slightly left", left: "left", "sharp left": "sharp left" };

export function maneuverText(m, st, arriveName) {
  const road = st.name ? ` onto ${st.name}` : st.ref ? ` onto ${st.ref}` : "";
  const mod = MOD[m.modifier] || m.modifier || "";
  switch (m.type) {
    case "arrive": return `Arrive at ${arriveName || "your stop"}`;
    case "turn": return m.modifier === "uturn" ? "Make a U-turn" : `Turn ${mod}${road}`;
    case "new name": case "continue": return m.modifier && m.modifier !== "straight" ? `Bear ${mod}${road}` : `Continue${road}`;
    case "merge": return `Merge ${mod}${road}`;
    case "on ramp": return `Take the ramp ${mod}${road}`;
    case "off ramp": return `Take the exit ${mod}${road}`;
    case "fork": return `Keep ${mod} at the fork${road}`;
    case "end of road": return `Turn ${mod} at the end of the road${road}`;
    case "roundabout": case "rotary": return `At the roundabout take exit ${m.exit ?? ""}${road}`.replace("exit  ", "the exit ");
    case "roundabout turn": return `At the roundabout turn ${mod}${road}`;
    case "exit roundabout": case "exit rotary": return `Exit the roundabout${road}`;
    default: return `Continue${road}`;
  }
}
