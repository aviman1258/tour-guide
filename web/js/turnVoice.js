// Spoken directions state machine. Pure: feed it the next maneuver and the distance to it on
// every GPS fix; it hands back a line to speak (or null). Three modes:
//   talkative — everything below, plus "keep going straight for x miles" after each turn and a
//               "you're on the route" reassurance every couple of minutes on long stretches
//   reserved  — only the approach to a turn: "in half a mile", "in 200 feet", "in 100 feet", "now"
//   mute      — nothing spoken; the banner still shows the next turn
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

// Prompts on the approach, metres before the maneuver. "far" is phrased from the real distance
// (a quarter mile / half a mile) and skipped when the turn is already closer than FAR_MIN.
export const STAGES = [
  { id: "far", atM: 850 },
  { id: "near", atM: 61 }, // 200 ft
  { id: "close", atM: 30 }, // 100 ft
  { id: "now", atM: 18 },
];
const FAR_MIN_M = 320; // below ~0.2 mi "in a quarter mile" would already be wrong
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
 * update({ maneuver, idx, distM, roadName, offRoute, nowMs }) → { id, text, interrupt } | null
 *   maneuver: { type, modifier, text, short, name } (null when there is nothing ahead)
 *   idx: index of that maneuver (changes when one is passed)
 *   roadName: the road we're on now (the previous maneuver's street)
 */
export function createTurnVoice({ mode = "reserved" } = {}) {
  let st = fresh();
  function fresh() { return { idx: -1, stage: -1, lastTalkAt: 0, wasOffRoute: false }; }

  function update(p) {
    if (p.offRoute) { st.wasOffRoute = true; return null; }
    if (mode === "mute") { st.idx = p.idx ?? -1; st.wasOffRoute = false; return null; }
    if (st.wasOffRoute) { st.wasOffRoute = false; st.idx = -1; return { id: "backOnRoute", text: "Back on the route.", interrupt: false }; }
    const m = p.maneuver;
    if (!m) return null;
    const now = p.nowMs ?? Date.now();

    if (p.idx !== st.idx) { // a new maneuver is ahead: reset stages, maybe describe the stretch
      st = { ...fresh(), idx: p.idx, lastTalkAt: now, wasOffRoute: false };
      if (p.distM < FAR_MIN_M) st.stage = 0; // too close to say "in a quarter mile"
      if (mode === "talkative" && p.distM > STRETCH_M) {
        return { id: `stretch_${p.idx}`, text: `Keep going straight${p.roadName ? ` on ${p.roadName}` : ""} for ${speakDist(p.distM)}.`, interrupt: false };
      }
    }

    if (isMinor(m)) {
      // "Continue on Main Street": reserved says nothing, talkative mentions it once at the far mark
      if (mode === "talkative" && st.stage < 0 && p.distM <= STAGES[0].atM) { st.stage = STAGES.length; st.lastTalkAt = now; return { id: `turn_${p.idx}_far`, text: `In ${speakDist(p.distM)}, ${lowerFirst(clean(m.text))}.`, interrupt: false }; }
      return talkativeReassure(p, now);
    }

    let due = -1;
    for (let i = 0; i < STAGES.length; i++) if (p.distM <= STAGES[i].atM) due = i;
    if (due > st.stage) {
      st.stage = due;
      st.lastTalkAt = now;
      const stage = STAGES[due];
      if (stage.id === "now") return { id: `turn_${p.idx}_now`, text: `${clean(m.short || m.text)} now.`, interrupt: true };
      return { id: `turn_${p.idx}_${stage.id}`, text: `In ${speakDist(stage.id === "far" ? p.distM : stage.atM)}, ${lowerFirst(clean(m.text))}.`, interrupt: true };
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
