import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnVoice, speakDist, isMinor, profileFor } from "../web/js/turnVoice.js";

const TURN = { type: "turn", modifier: "left", text: "Turn left onto Jetero Boulevard", short: "Turn left", name: "Jetero Boulevard" };
const EXIT = { type: "off ramp", modifier: "right", text: "Take the exit onto Interstate 405 South", short: "Take the exit onto Interstate 405 South", name: "I-405" };
const ARRIVE = { type: "arrive", text: "Arrive at Houston Heights", short: "Arriving at Houston Heights" };
const CONT = { type: "new name", modifier: "straight", text: "Continue onto Main Street", short: "Continue", name: "Main Street" };

/** Drive toward a maneuver from `fromM` down to 0 in `stepM` steps at `speedMps`; collect what gets said. */
function approach(tv, maneuver, fromM, { idx = 0, stepM = 10, speedMps = 13, roadName = "", t0 = 0, msPerStep = 500 } = {}) {
  const said = [];
  for (let d = fromM, i = 0; d >= 0; d -= stepM, i++) {
    const r = tv.update({ maneuver, idx, distM: d, speedMps, roadName, offRoute: false, nowMs: t0 + i * msPerStep });
    if (r) said.push(r);
  }
  return said;
}

test("speakDist rounds the way people talk", () => {
  assert.equal(speakDist(152), "500 feet");
  assert.equal(speakDist(30), "100 feet");
  assert.equal(speakDist(76), "250 feet");
  assert.equal(speakDist(805), "half a mile");
  assert.equal(speakDist(1609), "one mile");
});

test("profiles follow speed", () => {
  assert.equal(profileFor(30).id, "highway");
  assert.equal(profileFor(13).id, "surface");
  assert.equal(profileFor(5).id, "slow");
  assert.equal(profileFor(undefined).id, "surface", "unknown speed = city pace");
});

test("highway: one mile, half a mile, then take the exit in 500 feet", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  const said = approach(tv, EXIT, 2500, { speedMps: 30, stepM: 5 });
  assert.deepEqual(said.map((s) => s.text), [
    "In one mile, take the exit onto Interstate 405 South.",
    "In half a mile, take the exit onto Interstate 405 South.",
    "Take the exit onto Interstate 405 South in 500 feet.",
  ]);
  assert.ok(said.every((s) => s.interrupt));
});

test("surface streets: 500 feet, then turn now at about 100 feet; a far heads-up only when the turn started far away", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  assert.deepEqual(approach(tv, TURN, 1500, { speedMps: 13 }).map((s) => s.text), [
    "In a quarter mile, turn left onto Jetero Boulevard.", // heads-up at ~500 m: the turn was 1.5 km out when it came up
    "In 500 feet, turn left onto Jetero Boulevard.",
    "Turn left now.",
  ]);
  assert.deepEqual(approach(tv, TURN, 400, { idx: 1, speedMps: 13 }).map((s) => s.text), [
    "In 500 feet, turn left onto Jetero Boulevard.", // started under the heads-up distance: no far prompt
    "Turn left now.",
  ]);
});

test("slow pace: 250 feet, then now at about 60 feet; arrive is phrased as arriving", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  assert.deepEqual(approach(tv, ARRIVE, 300, { speedMps: 5, stepM: 3 }).map((s) => s.text), ["In 250 feet, arrive at Houston Heights.", "Arriving at Houston Heights now."]);
});

test("slowing down on an exit ramp doesn't repeat a stage; speeding up doesn't add one late", () => {
  const tv = createTurnVoice({ mode: "reserved" });
  const said = [];
  // highway approach, then the car slows to surface pace 400 m out
  for (let d = 2000; d >= 0; d -= 10) {
    const r = tv.update({ maneuver: TURN, idx: 0, distM: d, speedMps: d > 400 ? 30 : 12, offRoute: false, nowMs: 0 });
    if (r) said.push(r.text);
  }
  assert.deepEqual(said, ["In one mile, turn left onto Jetero Boulevard.", "In half a mile, turn left onto Jetero Boulevard.", "Turn left now."]);
});

test("reserved says nothing about 'continue' maneuvers; talkative gives one heads-up", () => {
  assert.equal(approach(createTurnVoice({ mode: "reserved" }), CONT, 1500).length, 0);
  assert.deepEqual(approach(createTurnVoice({ mode: "talkative" }), CONT, 800, { idx: 2 }).map((s) => s.text), ["In a quarter mile, continue onto Main Street."]);
});

test("talkative: describes the stretch, reassures every two minutes, then the same approach", () => {
  const tv = createTurnVoice({ mode: "talkative" });
  const said = approach(tv, TURN, 5000, { stepM: 50, speedMps: 13, roadName: "Beltway 8", msPerStep: 6000 });
  assert.equal(said[0].text, "Keep going straight on Beltway 8 for 3.1 miles.");
  assert.ok(said.filter((s) => !s.id.startsWith("turn_")).every((s) => s.interrupt === false), "informational lines never interrupt");
  const reassure = said.filter((s) => s.text.startsWith("You're on the route."));
  assert.ok(reassure.length >= 2 && reassure.length <= 5, `reassurances: ${reassure.length}`);
  assert.deepEqual(said.filter((s) => s.id.startsWith("turn_")).map((s) => s.text), [
    "In a quarter mile, turn left onto Jetero Boulevard.", "In 500 feet, turn left onto Jetero Boulevard.", "Turn left now.",
  ]);
});

test("mute says nothing, but still tracks so switching modes mid-drive works", () => {
  const tv = createTurnVoice({ mode: "mute" });
  assert.equal(approach(tv, TURN, 1500).length, 0);
  tv.setMode("reserved");
  assert.equal(approach(tv, TURN, 1500, { idx: 1 }).length, 3);
});

test("back on the route is announced once, in speaking modes only", () => {
  for (const mode of ["reserved", "talkative"]) {
    const tv = createTurnVoice({ mode });
    tv.update({ maneuver: TURN, idx: 0, distM: 3000, offRoute: true, nowMs: 0 });
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
});
