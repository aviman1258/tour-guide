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
  assert.deepEqual(pic.credit, { artist: "Jane Photographer", license: "CC BY-SA 4.0", page: "https://commons.wikimedia.org/wiki/File:Sacre_Coeur.jpg", title: "Sacré-Cœur, Paris" });
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
