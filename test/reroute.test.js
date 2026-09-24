import { test } from "node:test";
import assert from "node:assert/strict";
import { rejoinTarget, shouldAsk, buildDetour, MIN_GAP_MS } from "../web/js/reroute.js";
import { lineToPoints, cumulative } from "../web/js/routeMath.js";

// a straight 10 km line heading east along 29.75° N
const geometry = { type: "LineString", coordinates: Array.from({ length: 101 }, (_, i) => [-95.5 + i * 0.001, 29.75]) };
const points = lineToPoints(geometry);
const cum = cumulative(points);
const total = cum[cum.length - 1];

test("rejoin target sits ahead of where the car left the line, farther at speed", () => {
  const slow = rejoinTarget({ points, cum, leftAtM: 2000, speedMps: 5 });
  const fast = rejoinTarget({ points, cum, leftAtM: 2000, speedMps: 30 });
  assert.equal(slow.atM, 2400, "400 m minimum");
  assert.equal(fast.atM, 3350, "45 s of travel at speed");
  assert.ok(fast.lon > slow.lon, "both on the line, the fast one farther east");
  assert.ok(Math.abs(slow.lat - 29.75) < 1e-6);
});

test("rejoin target never skips the next stop and never runs past the end", () => {
  const t = rejoinTarget({ points, cum, leftAtM: 2000, speedMps: 30, stopAlong: [2600, 8000], nextStopIdx: 0 });
  assert.equal(t.atM, 2600, "stops at the next stop instead of overshooting it");
  const end = rejoinTarget({ points, cum, leftAtM: total - 100, speedMps: 30 });
  assert.equal(end.atM, total);
});

test("shouldAsk throttles by time and by distance", () => {
  const here = { lat: 29.75, lon: -95.5 };
  assert.equal(shouldAsk({ nowMs: 0, here }), true, "first ask is immediate");
  assert.equal(shouldAsk({ nowMs: 5000, lastAskMs: 0, lastAskAt: here, here }), false, "too soon, hasn't moved");
  assert.equal(shouldAsk({ nowMs: 5000, lastAskMs: 0, lastAskAt: here, here: { lat: 29.75, lon: -95.498 } }), false, "moved ~200 m but inside the 8 s floor");
  assert.equal(shouldAsk({ nowMs: 9000, lastAskMs: 0, lastAskAt: here, here: { lat: 29.75, lon: -95.498 } }), true, "moved ~200 m after the floor");
  assert.equal(shouldAsk({ nowMs: 9000, lastAskMs: 0, lastAskAt: here, here: { lat: 29.75, lon: -95.4995 } }), false, "only ~50 m: wait for the gap");
  assert.equal(shouldAsk({ nowMs: MIN_GAP_MS, lastAskMs: 0, lastAskAt: here, here }), true, "gap elapsed");
  assert.equal(shouldAsk({ nowMs: MIN_GAP_MS, lastAskMs: 0, lastAskAt: here, here, busy: true }), false, "a request is in flight");
});

test("buildDetour flattens the server's steps into maneuvers along the detour", () => {
  const detour = buildDetour({
    geometry: { type: "LineString", coordinates: [[-95.5, 29.75], [-95.5, 29.755], [-95.49, 29.755]] },
    legs: [{ durationSec: 120, distanceM: 1500, steps: [
      { maneuver: { type: "depart", location: [-95.5, 29.75] }, name: "Elm St" },
      { maneuver: { type: "turn", modifier: "right", location: [-95.5, 29.755] }, name: "Oak Ave", instruction: "Turn right onto Oak Ave." },
      { maneuver: { type: "arrive", location: [-95.49, 29.755] }, name: "" },
    ] }],
    totalSec: 120,
  });
  assert.equal(detour.maneuvers.length, 2);
  assert.equal(detour.maneuvers[0].text, "Turn right onto Oak Ave");
  assert.ok(detour.maneuvers[0].atM > 500 && detour.maneuvers[0].atM < 600);
  assert.equal(detour.maneuvers[1].text, "Rejoin the route");
  assert.ok(detour.total > 1400);
});
