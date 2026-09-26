import { test } from "node:test";
import assert from "node:assert/strict";
import { rankByDistance } from "../web/js/typeahead.js";
import { distanceM } from "../web/js/here.js";

const la = { lat: 34.05, lon: -118.24 };
const items = [
  { label: "Long Beach", sub: "New York", lat: 40.588, lon: -73.658 },
  { label: "Long Beach Boulevard", sub: "Long Beach, California", lat: 33.79, lon: -118.19 },
  { label: "Long Beach", sub: "California", lat: 33.77, lon: -118.19 },
  { label: "Long Beach", sub: "Washington", lat: 46.35, lon: -124.05 },
];

test("rankByDistance: exact-name matches first, then nearest to the device", () => {
  const out = rankByDistance(items, la, "long beach");
  assert.deepEqual(out.map((i) => `${i.label} · ${i.sub}`), [
    "Long Beach · California",
    "Long Beach · Washington",
    "Long Beach · New York",
    "Long Beach Boulevard · Long Beach, California",
  ]);
  assert.equal(rankByDistance(items, null, "long beach"), items, "no fix: leave the order alone");
});

test("distanceM is a haversine", () => {
  assert.ok(Math.abs(distanceM(la, { lat: 33.77, lon: -118.19 }) - 31500) < 1500);
  assert.equal(distanceM(la, la), 0);
});
