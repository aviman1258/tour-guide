import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTER_ROUTES, nextSaturday, alreadyPublished } from "../server/lib/seed.js";
import { toMinutes } from "../web/js/format.js";

test("the starter routes are complete and plausible", () => {
  assert.equal(STARTER_ROUTES.length, 12);
  const keys = new Set();
  for (const r of STARTER_ROUTES) {
    assert.ok(!keys.has(r.key), `duplicate key ${r.key}`); keys.add(r.key);
    for (const p of [r.start, r.end]) {
      assert.ok(p.label.length > 3);
      assert.ok(p.lat > 24 && p.lat < 50 && p.lon < -66 && p.lon > -125, `${p.label} is in the contiguous US`);
    }
    const km = Math.hypot(r.start.lat - r.end.lat, (r.start.lon - r.end.lon) * Math.cos((r.start.lat * Math.PI) / 180)) * 111;
    assert.ok(km > 5 && km < 120, `${r.key}: ${km.toFixed(0)} km apart`);
    const win = toMinutes(r.deadline) - toMinutes(r.arrivalTime);
    assert.ok(win >= 300 && win <= 360, `${r.key}: ${win} min window`);
    assert.ok(r.interests.split(",").length >= 3);
  }
  assert.equal(STARTER_ROUTES.filter((r) => /\([A-Z]{3}\)$/.test(r.start.label)).length, 8, "eight airport starts");
});

test("nextSaturday is always a Saturday in the future", () => {
  assert.equal(nextSaturday(new Date("2026-09-27T12:00:00Z")), "2026-10-03"); // a Sunday
  assert.equal(nextSaturday(new Date("2026-10-03T12:00:00Z")), "2026-10-10"); // a Saturday → the next one
  assert.equal(new Date(nextSaturday(new Date("2026-09-30T12:00:00Z")) + "T12:00:00Z").getUTCDay(), 6);
});

test("alreadyPublished matches on start and end labels, ignoring airport codes and punctuation", () => {
  const published = [{ id: "r_1", title: "LA: Hollywood", startLabel: "Los Angeles International Airport", endLabel: "Griffith Observatory, Los Angeles" }];
  assert.equal(alreadyPublished(STARTER_ROUTES.find((r) => r.key === "lax-hollywood"), published)?.id, "r_1");
  assert.equal(alreadyPublished(STARTER_ROUTES.find((r) => r.key === "sfo-wharf"), published), null);
});
