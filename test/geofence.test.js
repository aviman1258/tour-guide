import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeofence } from "../web/js/geofence.js";

// helpers: move along a west→east line at 29.75N; 0.001° lon ≈ 96.7 m
const at = (lonOffsetM) => ({ lat: 29.75, lon: -95.4 + lonOffsetM / 96700 });

const stopItem = { id: "n_stop", kind: "stop", targetId: "s1", lat: 29.75, lon: -95.4 + 2000 / 96700, radiusM: 250, alongM: 2000 };
const driveBy = { id: "n_db", kind: "driveby", pageid: 1, lat: 29.7505, lon: -95.4 + 5000 / 96700, radiusM: 300, alongM: 5000 };

function drive(gf, fromM, toM, stepM, { speed = 15, progress = true, t0 = 0, playingKind = null, offRoute = false } = {}) {
  const out = [];
  let now = t0;
  for (let d = fromM; d <= toM; d += stepM) {
    const p = at(d);
    const r = gf.update({ lat: p.lat, lon: p.lon, speedMps: speed, progressM: progress ? d : null, offRoute, nowMs: now, playingKind });
    out.push({ d, ...r });
    now += 1000;
  }
  return out;
}

test("stop fires once when approaching within its radius, never again", () => {
  const gf = createGeofence([stopItem]);
  const res = drive(gf, 0, 4000, 100);
  const fired = res.filter((r) => r.fire);
  assert.equal(fired.length, 1);
  assert.ok(fired[0].d >= 1750 && fired[0].d <= 2000, `fired at ${fired[0].d}`);
  // driving back through it does nothing
  const again = drive(gf, 4000, 0, -100, { t0: 60_000 });
  assert.equal(again.filter((r) => r.fire).length, 0);
});

test("drive-by radius grows with speed (20 s lookahead) but caps at 800 m", () => {
  const slow = createGeofence([driveBy]);
  const s = drive(slow, 3000, 5000, 50, { speed: 5 }).find((r) => r.fire);
  assert.ok(5000 - s.d <= 300 + 50, `slow fired ${5000 - s.d} m out`);

  const fast = createGeofence([driveBy]);
  const f = drive(fast, 3000, 5000, 50, { speed: 30 }).find((r) => r.fire);
  assert.ok(5000 - f.d >= 550 && 5000 - f.d <= 650, `fast fired ${5000 - f.d} m out`);

  const vfast = createGeofence([driveBy]);
  const v = drive(vfast, 3000, 5000, 50, { speed: 60 }).find((r) => r.fire);
  assert.ok(5000 - v.d <= 800 + 50, `very fast fired ${5000 - v.d} m out`);
});

test("drive-by is blocked while a stop narration is playing", () => {
  const gf = createGeofence([driveBy]);
  const res = drive(gf, 4000, 5000, 100, { playingKind: "stop" });
  assert.equal(res.filter((r) => r.fire).length, 0);
  assert.ok(res.some((r) => r.events.some((e) => e.startsWith("blocked:playing-stop"))));
});

test("drive-by respects the 60 s cooldown after a stop narration ends", () => {
  const gf = createGeofence([driveBy]);
  gf.onNarrationEnd({ kind: "stop" }, 0);
  const blocked = drive(gf, 4000, 5000, 100, { t0: 10_000 });
  assert.equal(blocked.filter((r) => r.fire).length, 0);
  const gf2 = createGeofence([driveBy]);
  gf2.onNarrationEnd({ kind: "stop" }, 0);
  const ok = drive(gf2, 4000, 5000, 100, { t0: 61_000 });
  assert.equal(ok.filter((r) => r.fire).length, 1);
});

test("drive-by is gated by route progress unless off route", () => {
  const gf = createGeofence([driveBy]);
  // physically near but progress says we're 4 km further along (loop-shaped route)
  const p = at(4900);
  const r1 = gf.update({ lat: p.lat, lon: p.lon, speedMps: 15, progressM: 9000, offRoute: false, nowMs: 0 });
  const r2 = gf.update({ lat: p.lat, lon: p.lon, speedMps: 15, progressM: 9000, offRoute: false, nowMs: 1000 });
  assert.equal(r1.fire, null);
  assert.equal(r2.fire, null);
  assert.ok(r2.events.some((e) => e.startsWith("blocked:gate")));
  // off route: gate ignored, raw distance wins
  const gf2 = createGeofence([driveBy]);
  gf2.update({ lat: p.lat, lon: p.lon, speedMps: 15, progressM: null, offRoute: true, nowMs: 0 });
  const r3 = gf2.update({ lat: p.lat, lon: p.lon, speedMps: 15, progressM: null, offRoute: true, nowMs: 1000 });
  assert.ok(r3.fire, "should fire on raw distance when off route");
});

test("stop beats drive-by when both are in range on the same tick", () => {
  // same spot, same radius, slow enough that the drive-by's speed lookahead doesn't widen it
  const near = { ...driveBy, id: "n_db2", lat: stopItem.lat, lon: stopItem.lon, radiusM: 250, alongM: 2000 };
  const gf = createGeofence([near, stopItem], { options: { stopExclusionScale: 0 } });
  const res = drive(gf, 1000, 2000, 100, { speed: 10 });
  const first = res.find((r) => r.fire);
  assert.equal(first.fire.kind, "stop");
});

test("no drive-by inside 1.5× a stop radius", () => {
  const near = { ...driveBy, id: "n_db3", lat: stopItem.lat, lon: stopItem.lon + 300 / 96700, alongM: 2300 };
  const gf = createGeofence([near, stopItem]);
  const res = drive(gf, 1500, 2400, 50);
  assert.equal(res.filter((r) => r.fire?.kind === "driveby").length, 0);
  assert.ok(res.some((r) => r.events.some((e) => e.startsWith("blocked:near-stop"))));
});

test("stop is visited after standing still inside its radius for 20 s", () => {
  const gf = createGeofence([stopItem], { fired: { n_stop: 1 } });
  const p = at(2000);
  let visited = null;
  for (let t = 0; t <= 25_000; t += 1000) {
    const r = gf.update({ lat: p.lat, lon: p.lon, speedMps: 0, progressM: 2000, offRoute: false, nowMs: t });
    if (r.visited) visited = { id: r.visited, t };
  }
  assert.equal(visited?.id, "s1");
  assert.ok(visited.t >= 20_000 && visited.t <= 21_000, `visited at ${visited.t}`);
});

test("stop is visited after driving through and leaving beyond 1.5× radius", () => {
  const gf = createGeofence([stopItem], { fired: { n_stop: 1 } });
  const res = drive(gf, 1000, 3000, 50);
  const v = res.find((r) => r.visited);
  assert.ok(v, "should be visited");
  assert.ok(v.d > 2000 + 250 * 1.5, `visited at ${v.d}`);
});

test("snapshot round-trips fired + visited state", () => {
  const gf = createGeofence([stopItem, driveBy]);
  drive(gf, 0, 6000, 100);
  const snap = gf.snapshot();
  assert.deepEqual(Object.keys(snap.fired).sort(), ["n_db", "n_stop"]);
  const gf2 = createGeofence([stopItem, driveBy], snap);
  assert.equal(drive(gf2, 0, 6000, 100, { t0: 999_999 }).filter((r) => r.fire).length, 0);
});
