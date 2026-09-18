import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineM, bearingDeg, cumulative, project, interpolateAlong, sampleAlong, bestInsertIndex } from "../web/js/routeMath.js";

// A straight west→east line through Houston, ~1.9 km per 0.02° lon at 29.75°N
const line = [
  { lat: 29.75, lon: -95.40 },
  { lat: 29.75, lon: -95.38 },
  { lat: 29.75, lon: -95.36 },
  { lat: 29.75, lon: -95.34 },
];

test("haversine: IAH to Galleria is about 33 km", () => {
  const d = haversineM({ lat: 29.9902, lon: -95.3368 }, { lat: 29.7395, lon: -95.4633 });
  assert.ok(d > 30000 && d < 36000, `got ${d}`);
});

test("bearing: due east is ~90°", () => {
  const b = bearingDeg(line[0], line[1]);
  assert.ok(Math.abs(b - 90) < 1, `got ${b}`);
});

test("cumulative distance is monotonic and ends at total length", () => {
  const cum = cumulative(line);
  assert.equal(cum[0], 0);
  for (let i = 1; i < cum.length; i++) assert.ok(cum[i] > cum[i - 1]);
  assert.ok(Math.abs(cum[3] - 3 * haversineM(line[0], line[1])) < 1);
});

test("project: a point just north of the second segment snaps onto it", () => {
  const cum = cumulative(line);
  const p = project(line, cum, { lat: 29.7505, lon: -95.37 });
  assert.equal(p.segIndex, 1);
  assert.ok(p.offRouteM > 50 && p.offRouteM < 60, `off-route ${p.offRouteM}`);
  assert.ok(Math.abs(p.progressM - cum[1] - (cum[2] - cum[1]) / 2) < 5, `progress ${p.progressM}`);
});

test("project: windowed search around a hint finds the same segment", () => {
  const cum = cumulative(line);
  const full = project(line, cum, { lat: 29.7501, lon: -95.35 });
  const hinted = project(line, cum, { lat: 29.7501, lon: -95.35 }, 2, 1);
  assert.equal(full.segIndex, hinted.segIndex);
  assert.ok(Math.abs(full.progressM - hinted.progressM) < 1);
});

test("interpolateAlong: halfway lands on the middle vertex with east heading", () => {
  const cum = cumulative(line);
  const total = cum[cum.length - 1];
  const p = interpolateAlong(line, cum, total / 2);
  assert.ok(Math.abs(p.lon - -95.37) < 1e-4, `lon ${p.lon}`);
  assert.ok(Math.abs(p.heading - 90) < 1);
  const end = interpolateAlong(line, cum, total + 1000);
  assert.ok(Math.abs(end.lon - -95.34) < 1e-6);
});

test("sampleAlong: 800 m spacing over ~5.8 km gives 8 samples with increasing alongM", () => {
  const cum = cumulative(line);
  const s = sampleAlong(line, cum, 800);
  assert.equal(s.length, Math.floor(cum[cum.length - 1] / 800) + 1);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].alongM > s[i - 1].alongM);
});

test("bestInsertIndex: a point between stop 1 and 2 goes to index 1", () => {
  const start = { lat: 29.99, lon: -95.34 };
  const end = { lat: 29.74, lon: -95.46 };
  const stops = [{ lat: 29.90, lon: -95.38 }, { lat: 29.80, lon: -95.42 }];
  assert.equal(bestInsertIndex(start, stops, end, { lat: 29.85, lon: -95.40 }), 1);
  assert.equal(bestInsertIndex(start, stops, end, { lat: 29.95, lon: -95.36 }), 0);
});
