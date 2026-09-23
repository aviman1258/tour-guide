import { test } from "node:test";
import assert from "node:assert/strict";
import { wxLabel, pickHour, summarize, wxShort, forStops } from "../web/js/weather.js";

const times = Array.from({ length: 48 }, (_, i) => `2026-11-14T${String(i % 24).padStart(2, "0")}:00`).map((t, i) => (i < 24 ? t : t.replace("2026-11-14", "2026-11-15")));
const result = { current: { temperature_2m: 71.4, weather_code: 3 }, hourly: { time: times, temperature_2m: times.map((_, i) => 60 + i), weather_code: times.map((_, i) => (i === 13 ? 61 : 0)) } };

test("weather codes map to an icon and words", () => {
  assert.deepEqual(wxLabel(0), { icon: "☀️", text: "clear" });
  assert.deepEqual(wxLabel(95), { icon: "⛈️", text: "thunderstorm" });
  assert.equal(wxLabel(999).text, "");
});

test("the arrival hour is picked from the forecast when the trip day is in range", () => {
  assert.equal(pickHour(times, "2026-11-14", "13:36"), 13);
  assert.equal(pickHour(times, "2026-11-15", "02:00"), 26);
  assert.equal(pickHour(times, "2026-12-25", "13:00"), -1);
  assert.deepEqual(summarize(result, { date: "2026-11-14", arrive: "13:36" }), { tempF: 73, icon: "🌧️", text: "rain", when: "at arrival" });
  assert.deepEqual(summarize(result, { date: "2026-12-25", arrive: "13:00" }), { tempF: 71, icon: "☁️", text: "overcast", when: "now" });
  assert.equal(wxShort(summarize(result, { date: "2026-11-14", arrive: "13:36" })), "🌧️ 73°");
});

test("forStops makes one request for all stops and never throws", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => [result, result] }; };
  const stops = [{ id: "a", lat: 29.8, lon: -95.4 }, { id: "b", lat: 29.7, lon: -95.5 }];
  const m = await forStops(stops, { items: [{ stopId: "a", arrive: "13:00" }] }, "2026-11-14", { fetchImpl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("latitude=29.8000,29.7000"));
  assert.equal(m.get("a").when, "at arrival");
  assert.equal(m.get("b").when, "now");
  // a different date is a different cache key, so this one really hits the failing fetch
  const bad = await forStops(stops, null, "2026-11-20", { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(bad.size, 0);
  // same key as the first call → served from the 30-minute cache, no second request
  await forStops(stops, null, "2026-11-14", { fetchImpl });
  assert.equal(calls.length, 1);
});
