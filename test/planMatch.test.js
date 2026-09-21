import { test } from "node:test";
import assert from "node:assert/strict";
import { samePlan, matchingPackage } from "../web/js/planMatch.js";

const A = { start: { lat: 29.99, lon: -95.33 }, end: { lat: 29.74, lon: -95.46 }, date: "2026-11-14", stops: [{ id: "s_1", name: "Heights", lat: 29.8, lon: -95.4 }, { id: "s_2", name: "Mandir", lat: 29.6, lon: -95.6 }] };

test("same stops, different date/time = same plan", () => {
  assert.equal(samePlan(A, { ...A, date: "2026-12-01", arrivalTime: "10:00" }), true);
});

test("different stops, order, count or endpoints = different plan", () => {
  assert.equal(samePlan(A, { ...A, stops: [A.stops[1], A.stops[0]] }), false);
  assert.equal(samePlan(A, { ...A, stops: [A.stops[0]] }), false);
  assert.equal(samePlan(A, { ...A, stops: [A.stops[0], { id: "s_9", name: "Other", lat: 29.6, lon: -95.6 }] }), false);
  assert.equal(samePlan(A, { ...A, end: { lat: 30.2, lon: -95.46 } }), false);
  assert.equal(samePlan(A, null), false);
});

test("stops without ids fall back to name + position", () => {
  const strip = (it) => ({ ...it, stops: it.stops.map(({ id, ...s }) => s) });
  assert.equal(samePlan(strip(A), A), true);
  assert.equal(samePlan(strip(A), { ...A, stops: [A.stops[0], { ...A.stops[1], name: "Temple" }] }), false);
});

test("matchingPackage picks the newest matching one and ignores the rest", () => {
  const other = { ...A, stops: [A.stops[0]] };
  const pkgs = [
    { itinerary: other, preparedAt: "2026-09-21T10:00:00Z" },
    { itinerary: A, preparedAt: "2026-09-19T10:00:00Z" },
    { itinerary: { ...A, date: "2026-12-01" }, preparedAt: "2026-09-20T10:00:00Z" },
  ];
  assert.equal(matchingPackage(A, pkgs).preparedAt, "2026-09-20T10:00:00Z");
  assert.equal(matchingPackage({ ...A, stops: [] }, pkgs), null);
});
