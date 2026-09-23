import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForKind } from "../server/photon.js";
import { normalize, searchText, stats } from "../server/places.js";
import { config } from "../server/config.js";

test("OSM / Google kinds map to our categories", () => {
  assert.equal(categoryForKind("place_of_worship"), "temple");
  assert.equal(categoryForKind("hindu_temple"), "temple");
  assert.equal(categoryForKind("museum"), "museum");
  assert.equal(categoryForKind("cafe"), "food");
  assert.equal(categoryForKind("viewpoint"), "viewpoint");
  assert.equal(categoryForKind("suburb"), "neighborhood");
  assert.equal(categoryForKind("tourist_attraction point_of_interest"), "landmark");
  assert.equal(categoryForKind("garbage"), "other");
});

test("Google Places results normalize to our place shape", () => {
  const p = normalize({ id: "x", displayName: { text: "Kali Mandir" }, location: { latitude: 33.54, longitude: -117.78 }, types: ["hindu_temple", "place_of_worship", "point_of_interest"], primaryType: "hindu_temple", formattedAddress: "1 Temple Way, Laguna Beach, CA", editorialSummary: { text: "Small Hindu temple." }, rating: 4.8, userRatingCount: 120 });
  assert.equal(p.name, "Kali Mandir");
  assert.equal(p.category, "temple");
  assert.equal(p.address, "1 Temple Way, Laguna Beach, CA");
});

test("searchText is off without a key, sends the field mask with one, and never throws", async () => {
  config.googlePlacesKey = "";
  assert.deepEqual(await searchText("Kali Mandir", { near: { lat: 33.5, lon: -117.7 }, fetchImpl: async () => { throw new Error("no"); } }), []);
  config.googlePlacesKey = "test-key";
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ places: [{ id: "a", displayName: { text: "Kali Mandir" }, location: { latitude: 33.54, longitude: -117.78 }, types: ["hindu_temple"] }] }) }; };
  const out = await searchText("Kali Mandir Laguna Beach", { near: { lat: 33.5, lon: -117.7 }, fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(calls[0].headers["X-Goog-Api-Key"], "test-key");
  assert.match(calls[0].headers["X-Goog-FieldMask"], /places\.location/);
  assert.equal(calls[0].body.locationBias.circle.center.latitude, 33.5);
  const bad = await searchText("other query", { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.deepEqual(bad, []);
  assert.match(stats().lastError, /403/);
  config.googlePlacesKey = "";
});
