import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnVoice, speakDist, isMinor } from "../web/js/turnVoice.js";

const TURN = { type: "turn", modifier: "left", text: "Turn left onto Jetero Boulevard", short: "Turn left", name: "Jetero Boulevard" };
const ARRIVE = { type: "arrive", text: "Arrive at Houston Heights", short: "Arriving at Houston Heights" };
const CONT = { type: "new name", modifier: "straight", text: "Continue onto Main Street", short: "Continue", name: "Main Street" };

/** Drive toward a maneuver from `fromM` down to 0 in `stepM` steps; collect what gets said. */
function approach(tv, maneuver, fromM, { idx = 0, stepM = 10, roadName = "", t0 = 0, msPerStep = 500 } = {}) {
  const said = [];
  for (let d = fromM, i = 0; d >= 0; d -= stepM, i++) {
    const r = tv.update({ maneuver, idx, distM: d, roadName, offRoute: false, nowMs: t0 + i * msPerStep });
    if (r) said.push(r);
  }
  return said;
}

test("speakDist rounds the way people talk", () => {
  assert.equal(speakDist(61), "200 feet");
  assert.equal(speakDist(30), "100 feet");
  assert.equal(speakDist(400), "a quarter mile");
  assert.equal(speakDist(805), "half a mile");
  assert.equal(speakDist(1609), "one mile");
  assert.equal(speakDist(2100), "1.3 miles");
});

test("reserved: half a mile, 200 ft, 100 ft, now", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  const said = approach(tv, TURN, 1500);
  assert.deepEqual(said.map((s) => s.text), [
    "In half a mile, turn left onto Jetero Boulevard.",
    "In 200 feet, turn left onto Jetero Boulevard.",
    "In 100 feet, turn left onto Jetero Boulevard.",
    "Turn left now.",
  ]);
  assert.deepEqual(said.map((s) => s.urgent), [false, true, true, true]);
});

test("reserved: a turn that starts close skips the far prompt; arrive is phrased as arriving", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  assert.deepEqual(approach(tv, TURN, 250).map((s) => s.text), ["In 200 feet, turn left onto Jetero Boulevard.", "In 100 feet, turn left onto Jetero Boulevard.", "Turn left now."]);
  assert.deepEqual(approach(tv, ARRIVE, 100, { idx: 1 }).map((s) => s.text), ["In 200 feet, arrive at Houston Heights.", "In 100 feet, arrive at Houston Heights.", "Arriving at Houston Heights now."]);
});

test("reserved: says nothing about 'continue' maneuvers and nothing on long stretches", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  assert.equal(approach(tv, CONT, 1500).length, 0);
  // 5 km straight, ten minutes: silence until the turn comes up
  const said = approach(tv, TURN, 5000, { idx: 1, stepM: 50, msPerStep: 6000 });
  assert.equal(said[0].text, "In half a mile, turn left onto Jetero Boulevard.");
});

test("talkative: describes the stretch, reassures every two minutes, then the same approach", () => {
  const tv = createTurnVoice({ mode: "talkative" });
  const said = approach(tv, TURN, 5000, { stepM: 50, roadName: "Beltway 8", msPerStep: 6000 }); // 100 steps ≈ 10 min
  assert.equal(said[0].text, "Keep going straight on Beltway 8 for 3.1 miles.");
  const reassure = said.filter((s) => s.text.startsWith("You're on the route."));
  assert.ok(reassure.length >= 2 && reassure.length <= 5, `reassurances: ${reassure.length}`);
  assert.match(reassure[0].text, /Next, turn left onto Jetero Boulevard in .* miles?\./);
  // 50 m steps jump over the 100 ft mark; the prompts that are hit come in order
  assert.deepEqual(said.filter((s) => s.id.startsWith("turn_")).map((s) => s.text), [
    "In half a mile, turn left onto Jetero Boulevard.", "In 200 feet, turn left onto Jetero Boulevard.", "Turn left now.",
  ]);
});

test("talkative: 'continue' gets one heads-up, no more", () => {
  const tv = createTurnVoice({ mode: "talkative" });
  const said = approach(tv, CONT, 800, { idx: 2 });
  assert.deepEqual(said.map((s) => s.text), ["In half a mile, continue onto Main Street."]);
});

test("mute says nothing, but still tracks so switching modes mid-drive works", () => {
  const tv = createTurnVoice({ mode: "mute" });
  assert.equal(approach(tv, TURN, 1500).length, 0);
  tv.setMode("reserved");
  assert.equal(approach(tv, TURN, 1500, { idx: 1 }).length, 4);
});

test("back on the route is announced once, in speaking modes only", () => {
  for (const mode of ["reserved", "talkative"]) {
    const tv = createTurnVoice({ mode });
    tv.update({ maneuver: TURN, idx: 0, distM: 3000, offRoute: true, nowMs: 0 });
    tv.update({ maneuver: TURN, idx: 0, distM: 3000, offRoute: true, nowMs: 1000 });
    const back = tv.update({ maneuver: TURN, idx: 0, distM: 3000, offRoute: false, nowMs: 2000 });
    assert.equal(back?.text, "Back on the route.", mode);
    const again = tv.update({ maneuver: TURN, idx: 0, distM: 2990, offRoute: false, nowMs: 3000 });
    assert.ok(!again || !/Back on/.test(again.text));
  }
  const mute = createTurnVoice({ mode: "mute" });
  mute.update({ maneuver: TURN, idx: 0, distM: 3000, offRoute: true, nowMs: 0 });
  assert.equal(mute.update({ maneuver: TURN, idx: 0, distM: 3000, offRoute: false, nowMs: 1 }), null);
});

test("isMinor", () => {
  assert.equal(isMinor(CONT), true);
  assert.equal(isMinor(TURN), false);
  assert.equal(isMinor({ type: "new name", modifier: "slight right" }), false);
});
