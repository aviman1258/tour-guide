import { test } from "node:test";
import assert from "node:assert/strict";
import { bestPicture, PictureLookupFailed } from "../server/lib/routeImage.js";

// A fake Wikipedia API: three Paris stops, one found only by search, one with a fair-use photo.
const pages = {
  "Place du Tertre": { title: "Place du Tertre", pageimage: "Place_du_Tertre.jpg", coordinates: [{ lat: 48.8865, lon: 2.3408 }], pageviews: { a: 300, b: 200 } },
  "Sacré-Cœur, Paris": { title: "Sacré-Cœur, Paris", pageimage: "Sacre_Coeur.jpg", coordinates: [{ lat: 48.8867, lon: 2.3431 }], pageviews: { a: 9000, b: 8000 } },
  "Le Grenier à Pain": { title: "Le Grenier à Pain", pageimage: "Grenier_logo.png", coordinates: [{ lat: 48.885, lon: 2.339 }], pageviews: { a: 50 } },
  "Musée d'Orsay": { title: "Musée d'Orsay", pageimage: "Orsay_poster.jpg", coordinates: [{ lat: 48.86, lon: 2.3266 }], pageviews: { a: 20000 } },
};
const files = {
  "File:Sacre_Coeur.jpg": { thumburl: "https://upload.wikimedia.org/thumb/Sacre_Coeur.jpg/1280px-Sacre_Coeur.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Sacre_Coeur.jpg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: '<a href="//x">Jane Photographer</a>' } } },
  "File:Orsay_poster.jpg": { thumburl: "https://upload.wikimedia.org/Orsay.jpg", extmetadata: { LicenseShortName: { value: "Fair use" }, NonFree: { value: "true" } } },
  "File:Place_du_Tertre.jpg": { thumburl: "https://upload.wikimedia.org/Tertre.jpg", extmetadata: { LicenseShortName: { value: "Public domain" } } },
};
function fakeGet(log = []) {
  return async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    log.push(q);
    if (q.list === "search") return { status: 200, data: { query: { search: q.srsearch.startsWith("Sacré-Cœur") ? [{ title: "Sacré-Cœur, Paris" }] : [] } } };
    if (q.prop === "imageinfo") return { status: 200, data: { query: { pages: [{ imageinfo: files[q.titles] ? [files[q.titles]] : [] }] } } };
    const titles = q.titles.split("|");
    return { status: 200, data: { query: { pages: titles.map((t) => pages[t] || { title: t, missing: true }) } } };
  };
}
const stops = [
  { name: "Place du Tertre", wikipediaTitle: "Place du Tertre", lat: 48.8865, lon: 2.3408 },
  { name: "Sacré-Cœur", wikipediaTitle: "", approxArea: "Montmartre, Paris", lat: 48.8867, lon: 2.3431 },
  { name: "Le Grenier à Pain", wikipediaTitle: "Le Grenier à Pain", lat: 48.885, lon: 2.339 },
  { name: "Musée d'Orsay", wikipediaTitle: "Musée d'Orsay", lat: 48.86, lon: 2.3266 },
];

test("picks the most-read stop with a free photo, credits its author and licence", async () => {
  const pic = await bestPicture(stops, { get: fakeGet() });
  assert.equal(pic.url, "https://upload.wikimedia.org/thumb/Sacre_Coeur.jpg/1280px-Sacre_Coeur.jpg", "Orsay has more readers but its photo is fair use; the logo is skipped");
  assert.deepEqual(pic.credit, { artist: "Jane Photographer", license: "CC BY-SA 4.0", page: "https://commons.wikimedia.org/wiki/File:Sacre_Coeur.jpg", title: "Sacré-Cœur, Paris", v: 3 });
});

test("a searched article far from the stop is not used", async () => {
  const far = [{ name: "Sacré-Cœur", wikipediaTitle: "", lat: 45.76, lon: 4.83 }]; // Lyon, not Paris
  assert.equal(await bestPicture(far, { get: fakeGet() }), null);
});

test("no stops means no picture; Wikipedia busy or down is an error, so nothing gets wiped", async () => {
  assert.equal(await bestPicture([]), null);
  await assert.rejects(bestPicture(stops, { get: async () => { throw new Error("offline"); } }), PictureLookupFailed);
  await assert.rejects(bestPicture(stops, { get: async () => ({ status: 429, data: null }) }), PictureLookupFailed);
});

test("a landmark beats the town it sits in, even with fewer readers", async () => {
  const town = { title: "Culver City, California", pageimage: "Culver_City.jpg", coordinates: [{ lat: 34.02, lon: -118.39 }], pageviews: { a: 40000 } };
  const stage = { title: "Kirk Douglas Theatre", pageimage: "Kirk_Douglas_Theatre.jpg", coordinates: [{ lat: 34.023, lon: -118.395 }], pageviews: { a: 12000 } };
  const free = { thumburl: "https://upload.wikimedia.org/x.jpg", extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, Artist: { value: "A" } } };
  const get = async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    if (q.prop === "imageinfo") return { status: 200, data: { query: { pages: [{ imageinfo: [free] }] } } };
    return { status: 200, data: { query: { pages: q.titles.split("|").map((t) => (t === town.title ? town : stage)) } } };
  };
  const pic = await bestPicture([
    { name: "Culver City", wikipediaTitle: "Culver City, California", category: "neighborhood", lat: 34.02, lon: -118.39 },
    { name: "Kirk Douglas Theatre", wikipediaTitle: "Kirk Douglas Theatre", category: "landmark", lat: 34.023, lon: -118.395 },
  ], { get });
  assert.equal(pic.credit.title, "Kirk Douglas Theatre");
});

test("a file that is several pictures in one is skipped for the next best stop", async () => {
  const wh = { title: "White House", pageimage: "White_House_north_and_south_sides.jpg", coordinates: [{ lat: 38.8977, lon: -77.0365 }], pageviews: { a: 90000 } };
  const lm = { title: "Lincoln Memorial", pageimage: "Lincoln_Memorial_east_side.jpg", coordinates: [{ lat: 38.8893, lon: -77.0502 }], pageviews: { a: 30000 } };
  const free = { thumburl: "https://upload.wikimedia.org/lm.jpg", extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, Artist: { value: "B" } } };
  const get = async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    if (q.prop === "imageinfo") return { status: 200, data: { query: { pages: [{ imageinfo: [free] }] } } };
    return { status: 200, data: { query: { pages: q.titles.split("|").map((t) => (t === "White House" ? wh : lm)) } } };
  };
  const pic = await bestPicture([
    { name: "White House", wikipediaTitle: "White House", category: "landmark", lat: 38.8977, lon: -77.0365 },
    { name: "Lincoln Memorial", wikipediaTitle: "Lincoln Memorial", category: "landmark", lat: 38.8893, lon: -77.0502 },
  ], { get });
  assert.equal(pic.credit.title, "Lincoln Memorial");
});
