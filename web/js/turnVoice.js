// Spoken directions state machine. Pure: feed it the next maneuver, the distance to it and the
// current speed on every GPS fix; it hands back a line to speak (or null). Three modes:
//   talkative — everything below, plus "keep going straight for x miles" after each turn and a
//               "you're on the route" reassurance every couple of minutes on long stretches
//   reserved  — only the approach to a turn
//   mute      — nothing spoken; the banner still shows the next turn
// The approach prompts scale with speed:
//   highway (≥ 50 mph): "in one mile", "in half a mile", then "take the exit … in 500 feet"
//   surface (18-50 mph): a heads-up around a quarter mile when the turn is far, "in 500 feet",
//                        then "turn left now" at about 100 feet
//   slow (< 18 mph):     "in 250 feet", then "now" at about 60 feet
// Coming back after being off route says "Back on the route" in both speaking modes.
// Every line carries `interrupt`: true for the turn prompts themselves (they cut into narration,
// which resumes afterwards), false for the informational lines (stretch, reassurance, back on
// route, "continue" heads-up), which wait or are dropped.

export const MODES = ["talkative", "reserved", "mute"];
export const MODE_LABEL = {
  talkative: "Talkative · what's ahead, plus reassurance on long stretches",
  reserved: "Reserved · speaks only as a turn comes up",
  mute: "Mute · banner only, no spoken directions",
};

const KEY = "tourguide.turnVoice";
export function loadTurnMode() { try { const m = localStorage.getItem(KEY); return MODES.includes(m) ? m : "reserved"; } catch { return "reserved"; } }
export function saveTurnMode(m) { try { localStorage.setItem(KEY, m); } catch { /* ignore */ } }

export const HIGHWAY_MPS = 22.4; // 50 mph
export const SURFACE_MPS = 8;    // 18 mph

/** Prompt distances (metres) for the current speed. `far` may be null (no heads-up at this pace). */
export function profileFor(speedMps) {
  const v = Number.isFinite(speedMps) ? speedMps : 12;
  if (v >= HIGHWAY_MPS) return { id: "highway", far: 1609, near: 805, now: 152, nowWord: "in" };   // 1 mi, ½ mi, 500 ft
  if (v >= SURFACE_MPS) return { id: "surface", far: 500, near: 152, now: 30, nowWord: "now" };    // ~⅓ mi heads-up, 500 ft, 100 ft
  return { id: "slow", far: null, near: 76, now: 18, nowWord: "now" };                             // 250 ft, 60 ft
}

const STRETCH_M = 1200; // a turn farther than this counts as a long stretch worth talking about
const REASSURE_MS = 120_000;

/** Distance the way a person says it. */
export function speakDist(m) {
  const ft = m * 3.28084;
  if (ft < 950) return `${Math.max(50, Math.round(ft / 50) * 50)} feet`;
  const mi = m / 1609.344;
  if (mi < 0.38) return "a quarter mile";
  if (mi < 0.63) return "half a mile";
  if (mi < 0.88) return "three quarters of a mile";
  if (mi < 1.15) return "one mile";
  return mi < 10 ? `${mi.toFixed(1).replace(/\.0$/, "")} miles` : `${Math.round(mi)} miles`;
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const clean = (s) => String(s || "").replace(/\.$/, "").trim();

/** "Continue" / "new name" with no real turn: noise for reserved, one heads-up for talkative. */
export function isMinor(m) {
  return (m.type === "new name" || m.type === "continue") && (!m.modifier || m.modifier === "straight");
}

/**
 * createTurnVoice({ mode }) → { update, setMode, getMode, reset }
 * update({ maneuver, idx, distM, speedMps, roadName, offRoute, nowMs }) → { id, text, interrupt } | null
 *   maneuver: { type, modifier, text, short, name } (null when there is nothing ahead)
 *   idx: index of that maneuver (changes when one is passed)
 *   speedMps: current speed; picks the highway / surface / slow prompt distances
 *   roadName: the road we're on now (the previous maneuver's street)
 */
export function createTurnVoice({ mode = "reserved" } = {}) {
  let st = fresh();
  function fresh() { return { idx: -1, said: new Set(), firstDistM: null, lastTalkAt: 0, wasOffRoute: false }; }

  function update(p) {
    if (p.offRoute) { st.wasOffRoute = true; return null; }
    if (mode === "mute") { st.idx = p.idx ?? -1; st.wasOffRoute = false; return null; }
    if (st.wasOffRoute) { st.wasOffRoute = false; st.idx = -1; return { id: "backOnRoute", text: "Back on the route.", interrupt: false }; }
    const m = p.maneuver;
    if (!m) return null;
    const now = p.nowMs ?? Date.now();
    const prof = profileFor(p.speedMps);

    if (p.idx !== st.idx) { // a new maneuver is ahead: reset, maybe describe the stretch
      st = { ...fresh(), idx: p.idx, firstDistM: p.distM, lastTalkAt: now };
      if (mode === "talkative" && p.distM > STRETCH_M) {
        return { id: `stretch_${p.idx}`, text: `Keep going straight${p.roadName ? ` on ${p.roadName}` : ""} for ${speakDist(p.distM)}.`, interrupt: false };
      }
    }

    if (isMinor(m)) {
      // "Continue on Main Street": reserved says nothing, talkative mentions it once as it comes up
      if (mode === "talkative" && !st.said.has("minor") && p.distM <= (prof.far || prof.near)) { st.said.add("minor"); st.lastTalkAt = now; return { id: `turn_${p.idx}_far`, text: `In ${speakDist(p.distM)}, ${lowerFirst(clean(m.text))}.`, interrupt: false }; }
      return talkativeReassure(p, now);
    }

    const say = (stage, text) => { st.said.add(stage); st.lastTalkAt = now; return { id: `turn_${p.idx}_${stage}`, text, interrupt: true }; };
    // "now": at highway pace this is "take the exit … in 500 feet", elsewhere "turn left now"
    if (p.distM <= prof.now && !st.said.has("now")) {
      return say("now", prof.nowWord === "in" ? `${clean(m.short || m.text)} in ${speakDist(prof.now)}.` : `${clean(m.short || m.text)} now.`);
    }
    // "near": the definite call, quoted at its nominal distance so it is consistent trip to trip
    if (p.distM <= prof.near && !st.said.has("near") && !st.said.has("now")) {
      return say("near", `In ${speakDist(prof.near)}, ${lowerFirst(clean(m.text))}.`);
    }
    // "far": a heads-up, only when the maneuver was still farther than that when it first came up
    if (prof.far && p.distM <= prof.far && !st.said.has("far") && !st.said.has("near") && !st.said.has("now") && st.firstDistM > prof.far * 1.15) {
      return say("far", `In ${speakDist(p.distM)}, ${lowerFirst(clean(m.text))}.`);
    }
    return talkativeReassure(p, now);
  }

  function talkativeReassure(p, now) {
    if (mode !== "talkative" || p.distM <= STRETCH_M || now - st.lastTalkAt < REASSURE_MS) return null;
    st.lastTalkAt = now;
    const what = p.maneuver.type === "arrive" ? clean(p.maneuver.text) : lowerFirst(clean(p.maneuver.text));
    return { id: `reassure_${p.idx}_${now}`, text: `You're on the route. ${p.maneuver.type === "arrive" ? what : `Next, ${what}`} in ${speakDist(p.distM)}.`, interrupt: false };
  }

  return {
    update,
    setMode(m) { if (MODES.includes(m)) mode = m; },
    getMode() { return mode; },
    reset() { st = fresh(); },
  };
}
