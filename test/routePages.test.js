import { test } from "node:test";
import assert from "node:assert/strict";
import { routePage, indexPage, sitemap, routeSvg, slug, routeUrl } from "../server/routePages.js";
import { deviceOf, browserOf } from "../server/lib/analytics.js";

const summary = {
  id: "r_abc12345", title: "Houston: Heights & the <Mandir>", description: "Indian food and \"historic\" streets", region: "Houston, Texas, US",
  startLabel: "Houston Bush Intercontinental (IAH)", endLabel: "Hyatt Regency Houston Galleria", stopNames: ["Houston Heights", "Mahatma Gandhi District"],
  stopsCount: 2, miles: 41.2, minutes: 95, narrationCount: 7, uses: 3, createdAt: "2026-09-19T10:00:00Z",
};
const pkg = {
  itinerary: {
    start: { label: "IAH", lat: 29.9902, lon: -95.3368 }, end: { label: "Hyatt", lat: 29.7395, lon: -95.4633 },
    route: { geometry: { type: "LineString", coordinates: [[-95.3368, 29.9902], [-95.40, 29.80], [-95.4633, 29.7395]] } },
    stops: [
      { id: "s1", name: "Houston Heights", lat: 29.7989, lon: -95.3983, blurb: "A community in <b>northwest</b> Houston.", dwellMinutes: 20, wikipediaUrl: "https://en.wikipedia.org/wiki/Houston_Heights", lunch: "none" },
      { id: "s2", name: "Mahatma Gandhi District", lat: 29.719, lon: -95.501, blurb: "Little India on Hillcroft.", dwellMinutes: 60, lunch: "auto" },
    ],
  },
  narration: [{ kind: "stop", targetId: "s1", text: "We're rolling into the Heights. Second sentence here." }, { kind: "driveby", text: "A quick fact." }],
};

test("slug and url are clean and stable", () => {
  assert.equal(slug("Houston: Heights & the <Mandir>"), "houston-heights-the-mandir");
  assert.equal(routeUrl(summary), "https://deodapper.com/routes/r_abc12345/houston-heights-the-mandir");
  assert.equal(slug("!!!"), "route");
});

test("route page escapes user text, lists stops, embeds the map and structured data", () => {
  const html = routePage(summary, pkg);
  assert.ok(!html.includes("<Mandir>"), "raw angle brackets from the title must not survive");
  assert.ok(html.includes("&lt;Mandir&gt;"));
  assert.ok(html.includes("&lt;b&gt;northwest&lt;/b&gt;"), "blurb markup is escaped");
  assert.ok(html.includes("<svg class=\"route-map\""));
  assert.ok(html.includes(">1</text>") && html.includes(">2</text>"), "numbered stop dots");
  assert.ok(html.includes("We&#39;re rolling into the Heights."), "first sentence of the narration, escaped");
  assert.ok(html.includes(`href="/plan.html?tier=free&route=r_abc12345"`));
  assert.ok(html.includes(`<link rel="canonical" href="https://deodapper.com/routes/r_abc12345/houston-heights-the-mandir"`));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld["@type"], "TouristTrip");
  assert.equal(ld.itinerary.itemListElement.length, 2);
  assert.ok(html.includes("Plus 1 short stor"));
});

test("index page and sitemap list every route", () => {
  const html = indexPage([summary]);
  assert.ok(html.includes("1 published route") && html.includes("houston-heights-the-mandir"));
  const xml = sitemap([summary], "2026-09-22");
  assert.ok(xml.includes("<loc>https://deodapper.com/routes</loc>"));
  assert.ok(xml.includes("<loc>https://deodapper.com/routes/r_abc12345/houston-heights-the-mandir</loc>"));
  assert.ok(xml.includes("<lastmod>2026-09-19</lastmod>"));
  assert.ok(indexPage([]).includes("No routes have been published yet"));
});

test("routeSvg copes with missing geometry", () => {
  assert.equal(routeSvg(null, [], null, null), "");
  assert.ok(routeSvg([[-95.3, 29.9], [-95.4, 29.8]], [], null, null).startsWith("<svg"));
});

test("crawlers are classified as bots before the phone/desktop guess", () => {
  assert.equal(deviceOf("Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), "bot/script");
  assert.equal(deviceOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116 Safari/537.36"), "bot/script");
  assert.equal(deviceOf("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"), "bot/script");
  assert.equal(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), "iPhone");
  assert.equal(browserOf("Mozilla/5.0 (compatible; Googlebot/2.1)"), "crawler");
});
