import { test } from "node:test";
import assert from "node:assert/strict";
import { wxLabel, pickHour, summarize, wxShort, forStops, modeFor, typicalDates, typicalOf, daysAhead } from "../web/js/weather.js";
const NOW = Date.parse("2026-11-10T15:00:00Z"); // four days before the fixture trip

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
  assert.deepEqual(summarize(result, { date: "2026-11-14", arrive: "13:36" }), { tempF: 73, icon: "🌧️", text: "rain", when: "forecast" });
  assert.deepEqual(summarize(result, { date: "2026-12-25", arrive: "13:00" }), { tempF: 71, icon: "☁️", text: "overcast", when: "now" });
  assert.equal(wxShort(summarize(result, { date: "2026-11-14", arrive: "13:36" })), "🌧️ 73°");
});

test("forStops makes one request for all stops and never throws", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => [result, result] }; };
  const stops = [{ id: "a", lat: 29.8, lon: -95.4 }, { id: "b", lat: 29.7, lon: -95.5 }];
  const m = await forStops(stops, { items: [{ stopId: "a", arrive: "13:00" }] }, "2026-11-14", { fetchImpl, now: NOW });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("latitude=29.8000,29.7000"));
  assert.equal(m.get("a").when, "forecast");
  assert.equal(m.get("b").when, "now");
  // a different date is a different cache key, so this one really hits the failing fetch
  const bad = await forStops(stops, null, "2026-11-20", { fetchImpl: async () => { throw new Error("offline"); }, now: NOW });
  assert.equal(bad.size, 0);
  // same key as the first call → served from the 30-minute cache, no second request
  await forStops(stops, null, "2026-11-14", { fetchImpl, now: NOW });
  assert.equal(calls.length, 1);
});

test("the trip date decides forecast, typical or actual weather", () => {
  assert.equal(daysAhead("2026-11-14", NOW), 4);
  assert.equal(modeFor("2026-11-14", NOW), "forecast");
  assert.equal(modeFor("2026-11-25", NOW), "forecast", "15 days out is still forecast");
  assert.equal(modeFor("2026-11-26", NOW), "typical", "16 days out is past the forecast");
  assert.equal(modeFor("2026-11-01", NOW), "actual");
  assert.equal(modeFor("", NOW), "now");
  assert.deepEqual(typicalDates("2027-03-20", NOW), ["2026-03-20", "2025-03-20", "2024-03-20"], "the last three years the archive covers");
  assert.deepEqual(typicalDates("2026-12-24", NOW), ["2025-12-24", "2024-12-24", "2023-12-24"], "this year's date hasn't happened yet");
  assert.deepEqual(typicalDates("2028-02-29", NOW), ["2026-02-28", "2025-02-28", "2024-02-28"]);
});

test("typical weather averages the temperature and takes the most common sky", () => {
  const year = (d, temp, code) => ({ hourly: { time: [`${d}T13:00`], temperature_2m: [temp], weather_code: [code] } });
  const dates = ["2025-12-24", "2024-12-24", "2023-12-24"];
  const w = typicalOf([year(dates[0], 60, 3), year(dates[1], 66, 61), year(dates[2], 63, 3)], dates, "13:20");
  assert.deepEqual(w, { tempF: 63, icon: "☁️", text: "overcast", when: "typical", years: "2023–2025" });
  assert.equal(typicalOf([{}], ["2025-12-24"], "13:00"), null);
});

test("a far-off trip asks the archive for three years; a past one for that day", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); const d = url.match(/start_date=([\d-]+)/)?.[1] || "2026-11-14"; return { ok: true, json: async () => ({ hourly: { time: [`${d}T13:00`], temperature_2m: [70], weather_code: [0] } }) }; };
  const stops = [{ id: "a", lat: 29.8, lon: -95.4 }];
  const sched = { items: [{ stopId: "a", arrive: "13:10" }] };
  const far = await forStops(stops, sched, "2027-01-20", { fetchImpl, now: NOW });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((u) => u.startsWith("https://archive-api.open-meteo.com/v1/archive?")));
  assert.equal(far.get("a").when, "typical");
  calls.length = 0;
  const past = await forStops(stops, sched, "2026-10-01", { fetchImpl, now: NOW });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("start_date=2026-10-01&end_date=2026-10-01"));
  assert.equal(past.get("a").when, "actual");
});
