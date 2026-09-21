import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, routeSig, windowMinutes, PLANS_PER_CREDIT, tierRank } from "../web/js/pricing.js";

test("tiers follow the time window, boundaries inclusive at the low side", () => {
  assert.equal(quote("09:00", "11:00").tierId, "short");
  assert.equal(quote("09:00", "12:00").tierId, "short"); // exactly 3 h
  assert.equal(quote("09:00", "12:01").tierId, "half");
  assert.equal(quote("09:00", "15:00").tierId, "half"); // exactly 6 h
  assert.equal(quote("09:00", "15:01").tierId, "full");
  assert.equal(quote("09:00", "21:00").tierId, "full");
  assert.deepEqual([quote("09:00", "11:00").price, quote("09:00", "14:00").price, quote("09:00", "21:00").price], ["$1.99", "$2.99", "$4.49"]);
});

test("bad or inverted windows quote as the smallest tier with zero minutes", () => {
  assert.equal(windowMinutes("15:00", "09:00"), 0);
  assert.equal(windowMinutes("", "09:00"), 0);
  assert.equal(quote("15:00", "09:00").minutes, 0);
});

test("routeSig ignores tiny coordinate drift and separates different endpoints", () => {
  const a = routeSig({ lat: 29.9902, lon: -95.3368 }, { lat: 29.7395, lon: -95.4633 });
  assert.equal(a, routeSig({ lat: 29.9931, lon: -95.3390 }, { lat: 29.7380, lon: -95.4610 })); // same 0.01° cells
  assert.notEqual(a, routeSig({ lat: 29.9902, lon: -95.3368 }, { lat: 29.60, lon: -95.4633 }));
  assert.equal(routeSig(null, null), "?,?|?,?");
});

test("constants", () => {
  assert.equal(PLANS_PER_CREDIT, 3);
  assert.ok(tierRank("full") > tierRank("half") && tierRank("half") > tierRank("short"));
});
