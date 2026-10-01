import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTER_ROUTES, nextSaturday, alreadyPublished } from "../server/lib/seed.js";
import { toMinutes } from "../web/js/format.js";

test("the starter routes are complete and plausible", () => {
  assert.ok(STARTER_ROUTES.length >= 50, `${STARTER_ROUTES.length} presets`);
  const keys = new Set();
  for (const r of STARTER_ROUTES) {
    assert.ok(!keys.has(r.key), `duplicate key ${r.key}`); keys.add(r.key);
    for (const p of [r.start, r.end]) {
      assert.ok(p.label.length > 3);
      assert.ok(Math.abs(p.lat) <= 70 && Math.abs(p.lon) <= 180 && p.label.length > 3, `${p.label} has sane coordinates`);
    }
    const km = Math.hypot(r.start.lat - r.end.lat, (r.start.lon - r.end.lon) * Math.cos((r.start.lat * Math.PI) / 180)) * 111;
    assert.ok(km > 3 && km < 120, `${r.key}: ${km.toFixed(0)} km apart`);
    assert.ok(r.city && ["US", "International"].includes(r.area), `${r.key} has a city and area`);
    const win = toMinutes(r.deadline) - toMinutes(r.arrivalTime);
    assert.ok(win >= 240 && win <= 420, `${r.key}: ${win} min window`);
    assert.ok(r.interests.split(",").length >= 3);
  }
  const cities = new Set(STARTER_ROUTES.map((r) => r.city));
  for (const c of cities) if (!["Orange County", "San Diego", "San Francisco", "Las Vegas", "Miami", "Chicago", "Savannah", "Nashville"].includes(c)) assert.ok(STARTER_ROUTES.filter((r) => r.city === c).length >= 2, `${c} has a highlights and a vibe route`);
  assert.ok(STARTER_ROUTES.filter((r) => r.area === "International").length >= 20, "international routes");
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
