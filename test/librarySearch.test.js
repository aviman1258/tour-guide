import { test } from "node:test";
import assert from "node:assert/strict";
import { routePoints, passesNear, isPlaceLike } from "../server/lib/library.js";

// Burbank → Long Beach, straight down through downtown LA (roughly), one stop in Hollywood
const pkg = {
  itinerary: {
    start: { label: "Burbank", lat: 34.1808, lon: -118.309 }, end: { label: "Long Beach", lat: 33.7701, lon: -118.1937 },
    stops: [{ id: "s1", name: "Hollywood Sign viewpoint", lat: 34.1341, lon: -118.3215 }],
    route: { geometry: { type: "LineString", coordinates: [[-118.309, 34.1808], [-118.3215, 34.1341], [-118.2437, 34.0522], [-118.1937, 33.7701]] } },
  },
  narration: [],
};

test("routePoints covers start, end, stops and the road every 3 km", () => {
  const pts = routePoints(pkg);
  assert.deepEqual(pts[0], [34.1808, -118.309]);
  assert.deepEqual(pts[1], [33.7701, -118.1937]);
  assert.deepEqual(pts[2], [34.1341, -118.3215]);
  assert.ok(pts.length > 15 && pts.length < 40, `sampled the ~55 km road: ${pts.length} points`);
  assert.ok(pts.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)));
  assert.deepEqual(routePoints({ itinerary: { start: { lat: 1, lon: 2 }, end: { lat: 3, lon: 4 }, stops: [] } }), [[1, 2], [3, 4]], "no geometry: just the ends");
});

test("passesNear: downtown LA is on the way, San Diego is not", () => {
  const pts = routePoints(pkg);
  assert.equal(passesNear(pts, { lat: 34.0522, lon: -118.2437 }, 50), true, "Los Angeles");
  assert.equal(passesNear(pts, { lat: 33.8366, lon: -117.9143 }, 50), true, "Anaheim, 30 km off the line but inside 50 km");
  assert.equal(passesNear(pts, { lat: 32.7157, lon: -117.1611 }, 50), false, "San Diego");
  assert.equal(passesNear([], { lat: 0, lon: 0 }, 50), false);
});

test("isPlaceLike accepts cities, neighbourhoods, counties and airports, not shops or obscure hits", () => {
  assert.equal(isPlaceLike({ category: "boundary", type: "administrative", importance: 0.9, lat: 34.05, lon: -118.24 }), true, "Los Angeles");
  assert.equal(isPlaceLike({ category: "place", type: "suburb", importance: 0.5, lat: 34.1, lon: -118.3 }), true, "Hollywood");
  assert.equal(isPlaceLike({ category: "aeroway", type: "aerodrome", importance: 0.6, lat: 33.94, lon: -118.4 }), true, "LAX");
  assert.equal(isPlaceLike({ category: "amenity", type: "place_of_worship", importance: 0.3, lat: 1, lon: 1 }), false, "a temple");
  assert.equal(isPlaceLike({ category: "place", type: "city", importance: 0.2, lat: 1, lon: 1 }), false, "too obscure");
  assert.equal(isPlaceLike(undefined), false);
});
