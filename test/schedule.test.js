import test from "node:test";
import assert from "node:assert/strict";
import { walk, placeLunch, pickStopToTrim, compute, estimateLegs } from "../web/js/schedule-core.js";
import { toMinutes } from "../web/js/format.js";

const IAH = { label: "IAH", lat: 29.9902, lon: -95.3368 };
const HOTEL = { label: "Hyatt Regency Galleria", lat: 29.7395, lon: -95.4633 };

const stop = (id, name, lat, lon, extra = {}) => ({
  id, name, lat, lon, category: "neighborhood", dwellMinutes: 15, priority: 3, isFoodOption: false, lunch: "none", ...extra,
});

function houston() {
  return {
    version: 1, start: IAH, end: HOTEL, arrivalTime: "11:30", deadline: "15:00",
    departBufferMinutes: 30, safetyBufferMinutes: 15, interests: "indian stuff, historic neighborhoods, upper affluent",
    stops: [
      stop("heights", "Houston Heights", 29.7989, -95.3983, { priority: 4 }),
      stop("glenwood", "Glenwood Cemetery", 29.7656, -95.3862, { category: "cemetery", dwellMinutes: 20, priority: 2 }),
      stop("montrose", "Montrose", 29.7425, -95.3905, { priority: 3, isFoodOption: true }),
      stop("riveroaks", "River Oaks", 29.7561, -95.4183, { priority: 4 }),
      stop("gandhi", "Mahatma Gandhi District", 29.7190, -95.5010, { category: "district", dwellMinutes: 30, priority: 5, isFoodOption: true }),
      stop("baps", "BAPS Shri Swaminarayan Mandir", 29.6296, -95.5837, { category: "temple", dwellMinutes: 45, priority: 5 }),
      stop("mocity", "Missouri City", 29.6186, -95.5377, { priority: 2 }),
      stop("riverstone", "Riverstone", 29.5600, -95.5600, { priority: 2 }),
      stop("firstcolony", "First Colony", 29.5960, -95.6210, { priority: 3 }),
      stop("telfair", "Telfair", 29.6060, -95.6450, { priority: 1 }),
    ],
  };
}

test("walk: times add up and status reflects the deadline", () => {
  const it = { ...houston(), stops: houston().stops.slice(0, 2) };
  const legs = [20, 10, 25];
  const s = walk(it, legs);
  assert.equal(s.items.length, 2);
  // depart 12:00, +20 +3 parking → 12:23 arrive, +15 dwell → 12:38
  assert.equal(s.items[0].arrive, "12:23");
  assert.equal(s.items[0].depart, "12:38");
  // +10 +3 → 12:51, +20 → 13:11; +25 → 13:36 hotel
  assert.equal(s.hotelArrive, "13:36");
  assert.equal(s.slackMinutes, toMinutes("15:00") - 15 - toMinutes("13:36"));
  assert.equal(s.status, "ok");
});

test("placeLunch: picks the food option nearest 12:30 within the window", () => {
  const it = houston();
  const legs = estimateLegs(it);
  const stops = placeLunch(it, legs);
  const lunch = stops.filter((s) => s.lunch === "auto");
  assert.equal(lunch.length, 1);
  assert.ok(lunch[0].isFoodOption);
  assert.ok(lunch[0].dwellMinutes >= 60);
});

test("placeLunch: a user meal inside the lunch window replaces the automatic pick", () => {
  const it = houston();
  it.stops[0].lunch = "user"; // Heights, reached ~12:45: not a food option, but the user insists
  it.stops[0].dwellMinutes = 60;
  const stops = placeLunch(it, estimateLegs(it));
  assert.equal(stops.filter((s) => s.lunch !== "none").length, 1);
  assert.equal(stops[0].lunch, "user");
});

test("placeLunch: a user meal outside the window (dinner) keeps the automatic lunch", () => {
  const it = houston();
  it.deadline = "21:00";
  it.stops[9].lunch = "user"; // Telfair, the last stop, well after 2 pm
  it.stops[9].dwellMinutes = 60;
  const stops = placeLunch(it, estimateLegs(it));
  assert.equal(stops[9].lunch, "user");
  assert.equal(stops.filter((s) => s.lunch === "auto").length, 1, "lunch is still placed at midday");
});

test("placeLunch: several user meals all survive", () => {
  const it = houston();
  it.deadline = "21:00";
  for (const i of [0, 4, 9]) { it.stops[i].lunch = "user"; it.stops[i].dwellMinutes = 60; }
  const stops = placeLunch(it, estimateLegs(it));
  assert.deepEqual(stops.filter((s) => s.lunch === "user").map((s) => s.id), ["heights", "gandhi", "telfair"]);
  assert.equal(stops.filter((s) => s.lunch === "auto").length, 0);
  const sched = walk({ ...it, stops }, estimateLegs(it));
  assert.deepEqual(sched.mealStopIds, ["heights", "gandhi", "telfair"]);
});

test("pickStopToTrim: lowest priority goes first, never the lunch stop", () => {
  const it = houston();
  it.stops[4].lunch = "auto";
  it.stops[4].priority = 1; // even at priority 1, lunch survives
  const victim = pickStopToTrim(it);
  assert.equal(victim.id, "telfair");
});

test("compute with trim: the full Houston list is cut down to fit and drops are recorded", () => {
  const it = houston();
  const full = compute(it, { trim: false });
  assert.equal(full.schedule.status, "late", "10 stops in 3.5 h should not fit");

  // with the real 15:00 deadline: below 6 stops we squeeze dwell (low priority first) before
  // dropping further, so the result is several quick stops that fit rather than two long ones
  const floor = compute(it, { trim: true, minStops: 1, compressBelow: 6 });
  assert.notEqual(floor.schedule.status, "late");
  assert.ok(floor.stops.length >= 2, `expected a few quick stops, got ${floor.stops.length}`);
  assert.ok(floor.stops.some((s) => s.dwellCompressed), "dwell should be compressed");
  assert.ok(floor.stops.every((s) => s.dwellMinutes >= 10));
  assert.ok(floor.stops.some((s) => s.id === "gandhi"), "the must-see lunch district survives");
  const lunch = floor.stops.find((s) => s.lunch !== "none");
  assert.ok(lunch && lunch.dwellMinutes >= 45, "lunch keeps at least 45 min");
  assert.equal(lunch.id, "gandhi", "lunch prefers the highest-priority food option in the window");

  // give the day until 17:00 and it trims down to a set that fits
  it.deadline = "17:00";
  const trimmed = compute(it, { trim: true, minStops: 1, compressBelow: 6 });
  assert.notEqual(trimmed.schedule.status, "late");
  assert.ok(trimmed.stops.length >= 3);
  assert.ok(trimmed.stops.length < it.stops.length);
  assert.equal(trimmed.dropped.length, it.stops.length - trimmed.stops.length);
  assert.ok(trimmed.dropped.every((d) => d.reason === "trimmed" && d.stop));
  // must-sees survive
  const names = trimmed.stops.map((s) => s.id);
  assert.ok(names.includes("gandhi"));
  assert.ok(names.includes("baps"));
  // the first drop is the priority-1 stop
  assert.equal(trimmed.dropped[0].name, "Telfair");
});

test("compute without trim never removes stops", () => {
  const it = houston();
  const r = compute(it, { trim: false });
  assert.equal(r.stops.length, 10);
  assert.equal(r.dropped.length, 0);
});
