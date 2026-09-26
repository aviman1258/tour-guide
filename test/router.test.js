import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkPoints, stitch, VALHALLA_MAX_LOCATIONS } from "../server/router.js";

const pts = (n) => Array.from({ length: n }, (_, i) => ({ lat: 34 + i * 0.01, lon: -118 - i * 0.01 }));

test("chunkPoints: up to 10 points is one request; more is split into pieces that share an endpoint", () => {
  assert.equal(chunkPoints(pts(2)).length, 1);
  assert.equal(chunkPoints(pts(10)).length, 1);
  const c = chunkPoints(pts(12));
  assert.deepEqual(c.map((x) => x.length), [10, 3]);
  assert.deepEqual(c[1][0], c[0][9], "the second piece starts where the first ends");
  const d = chunkPoints(pts(20));
  assert.deepEqual(d.map((x) => x.length), [10, 10, 2]);
  assert.equal(d.reduce((n, x) => n + x.length - 1, 0), 19, "19 legs for 20 points, same as one call");
  assert.equal(VALHALLA_MAX_LOCATIONS, 10);
});

test("stitch: one geometry without the duplicated join, legs in order, totals summed, flags OR-ed", () => {
  const part = (coords, legs, sec, m, flags) => ({ geometry: { type: "LineString", coordinates: coords }, legs, totalSec: sec, totalM: m, router: "valhalla", flags });
  const a = part([[0, 0], [1, 1], [2, 2]], [{ durationSec: 60 }, { durationSec: 70 }], 130, 2000, { hasToll: false, hasHighway: true, hasFerry: false });
  const b = part([[2, 2], [3, 3]], [{ durationSec: 80 }], 80, 900, { hasToll: true, hasHighway: false, hasFerry: false });
  const r = stitch([a, b]);
  assert.deepEqual(r.geometry.coordinates, [[0, 0], [1, 1], [2, 2], [3, 3]]);
  assert.equal(r.legs.length, 3);
  assert.equal(r.totalSec, 210);
  assert.equal(r.totalM, 2900);
  assert.deepEqual(r.flags, { hasToll: true, hasHighway: true, hasFerry: false });
  assert.equal(r.router, "valhalla");
  assert.equal(stitch([a]), a);
});
