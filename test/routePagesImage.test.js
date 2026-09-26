import { test } from "node:test";
import assert from "node:assert/strict";
import { routePage, indexPage } from "../server/routePages.js";

const base = {
  id: "r_img00001", title: "Irvine: Mission and Pier", description: "", region: "Irvine, California, US",
  startLabel: "Irvine", endLabel: "Huntington Beach", stopNames: ["Mission San Juan Capistrano"], stopsCount: 1, miles: 30, minutes: 50, narrationCount: 2, uses: 0, createdAt: "2026-09-25T10:00:00Z",
};
const pkg = { itinerary: { start: { label: "Irvine", lat: 33.68, lon: -117.82 }, end: { label: "HB", lat: 33.65, lon: -117.99 }, route: null, stops: [{ id: "s1", name: "Mission San Juan Capistrano", lat: 33.5, lon: -117.66, dwellMinutes: 10, lunch: "none" }] }, narration: [] };
const image = "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/Jewel_of_the_Missions.jpg/330px-Jewel_of_the_Missions.jpg";

test("route pages show the landmark picture as a card banner, a hero and the social image; none without one", () => {
  const withPic = { ...base, image };
  const idx = indexPage([withPic]);
  assert.ok(idx.includes("/800px-Jewel_of_the_Missions.jpg"), "asks for the wide version");
  assert.ok(idx.includes(`this.src='${image}'`), "falls back to the stored size");
  assert.ok(!idx.includes("no-image"));
  const page = routePage(withPic, pkg);
  assert.ok(page.includes('class="route-hero"'));
  assert.ok(page.includes(`<meta property="og:image" content="${image}"`), "the stored size is the safe social image");

  const plain = indexPage([base]);
  assert.ok(plain.includes("no-image") && plain.includes("<span>Irvine</span>"), "a coloured banner naming the region instead");
  assert.ok(!routePage(base, pkg).includes("route-hero"));
  assert.ok(routePage(base, pkg).includes("/img/og.png"));
});
