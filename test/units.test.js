import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDistance, fmtTemp, defaultUnits } from "../web/js/units.js";
import { createTurnVoice, speakDist, profileFor } from "../web/js/turnVoice.js";

test("written distances and temperatures in both systems", () => {
  assert.equal(fmtDistance(482, "imperial"), "0.3 mi");
  assert.equal(fmtDistance(120, "imperial"), "400 ft");
  assert.equal(fmtDistance(90_000, "imperial"), "56 mi");
  assert.equal(fmtDistance(4200, "metric"), "4.2 km");
  assert.equal(fmtDistance(340, "metric"), "350 m");
  assert.equal(fmtDistance(42, "metric"), "40 m");
  assert.equal(fmtDistance(90_000, "metric"), "90 km");
  assert.equal(fmtTemp(72, "imperial"), "72°");
  assert.equal(fmtTemp(72, "metric"), "22°");
  assert.equal(fmtTemp(NaN), "");
});

test("the default follows the browser's region", () => {
  assert.equal(defaultUnits("en-US"), "imperial");
  assert.equal(defaultUnits("en-GB"), "imperial", "UK road signs are in miles");
  assert.equal(defaultUnits("fr-FR"), "metric");
  assert.equal(defaultUnits("en-IN"), "metric");
  assert.equal(defaultUnits("en"), "imperial", "no region: the US default");
});

test("spoken metric distances are round", () => {
  assert.equal(speakDist(200, "metric"), "200 metres");
  assert.equal(speakDist(1000, "metric"), "one kilometre");
  assert.equal(speakDist(2400, "metric"), "2.4 kilometres");
  assert.equal(speakDist(30, "metric"), "30 metres");
  assert.equal(profileFor(30, "metric").near, 1000);
});

test("a metric driver hears 2 km, 1 km, then the exit in 200 metres", () => {
  const tv = createTurnVoice({ mode: "reserved", units: "metric" });
  const exit = { type: "off ramp", modifier: "right", text: "Take the exit onto the A1", short: "Take the exit onto the A1" };
  const said = [];
  for (let d = 3000; d >= 0; d -= 5) { const r = tv.update({ maneuver: exit, idx: 0, distM: d, speedMps: 30, offRoute: false, nowMs: 0 }); if (r) said.push(r.text); }
  assert.deepEqual(said, ["In 2 kilometres, take the exit onto the A1.", "In one kilometre, take the exit onto the A1.", "Take the exit onto the A1 in 200 metres."]);
  tv.setUnits("imperial");
  const later = [];
  for (let d = 2500; d >= 0; d -= 5) { const r = tv.update({ maneuver: exit, idx: 1, distM: d, speedMps: 30, offRoute: false, nowMs: 0 }); if (r) later.push(r.text); }
  assert.equal(later[0], "In one mile, take the exit onto the A1.", "switching units mid-drive takes effect on the next turn");
});
