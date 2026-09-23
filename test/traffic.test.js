import { test } from "node:test";
import assert from "node:assert/strict";
import { trafficFactor, dampenForSpeed, dayOfWeekFor, trafficMinutes } from "../web/js/traffic.js";
import { walk, estimateLegs } from "../web/js/schedule-core.js";

const at = (h, m = 0) => h * 60 + m;

test("weekday curve: peaks morning and evening, plateau midday, free at night", () => {
  assert.equal(trafficFactor(at(8), 2), 1.45);
  assert.equal(trafficFactor(at(17), 2), 1.5);
  assert.equal(trafficFactor(at(7), 2), 1.3);
  assert.equal(trafficFactor(at(12), 2), 1.1);
  assert.equal(trafficFactor(at(23), 2), 1.0);
  assert.equal(trafficFactor(at(3), 2), 1.0);
});

test("weekends are mild", () => {
  assert.equal(trafficFactor(at(8), 6), 1.0);
  assert.equal(trafficFactor(at(14), 0), 1.15);
});

test("highway legs are damped; date parsing is timezone-proof", () => {
  assert.equal(dampenForSpeed(1.5, 25), 1.4);
  assert.equal(dampenForSpeed(1.5, 10), 1.5);
  assert.equal(dayOfWeekFor("2026-11-14"), 6, "a Saturday");
  assert.equal(dayOfWeekFor("2026-11-16"), 1, "a Monday");
  assert.equal(dayOfWeekFor(""), 3);
  assert.ok(Math.abs(trafficMinutes(20, at(8), 2, 30_000) - 20 * 1.36) < 1e-9, "25 m/s highway leg at the morning peak");
});

test("walk applies typical traffic per leg and reports the total added", () => {
  const it = {
    start: { label: "A", lat: 29.99, lon: -95.34 }, end: { label: "B", lat: 29.74, lon: -95.46 }, date: "2026-11-16", // Monday
    arrivalTime: "07:30", deadline: "12:00", departBufferMinutes: 0, safetyBufferMinutes: 0,
    stops: [{ id: "s1", lat: 29.9, lon: -95.4, dwellMinutes: 30, lunch: "none" }],
  };
  const legs = [20, 20];
  const peak = walk(it, legs);
  assert.ok(peak.trafficMinutes > 15 && peak.trafficMinutes < 20, `added ${peak.trafficMinutes}`); // ×1.45 then ×1.3
  const night = walk({ ...it, arrivalTime: "22:00", deadline: "23:59" }, legs);
  assert.equal(night.trafficMinutes, 0);
  const sat = walk({ ...it, date: "2026-11-14" }, legs);
  assert.equal(sat.trafficMinutes, 0, "Saturday 7:30 is free-flowing");
  const off = walk({ ...it, traffic: false }, legs);
  assert.equal(off.trafficMinutes, 0);
  assert.ok(estimateLegs(it).length === 2);
});
