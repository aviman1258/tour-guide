import { test } from "node:test";
import assert from "node:assert/strict";
import { pickImage, bannerUrl } from "../server/lib/library.js";

const T = (name) => `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.jpg/330px-${name}.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail`;

test("pickImage prefers a landmark with a picture over a street scene, then priority", () => {
  const stops = [
    { name: "Houston Heights", category: "neighborhood", priority: 4, thumbnail: T("Heights") },
    { name: "Gandhi District", category: "district", priority: 5, thumbnail: T("Gandhi") },
    { name: "BAPS Mandir", category: "temple", priority: 5, thumbnail: "" },
    { name: "Glenwood Cemetery", category: "cemetery", priority: 3, thumbnail: T("Glenwood") },
  ];
  assert.match(pickImage(stops), /Glenwood/, "the cemetery outranks the district and neighbourhood; the temple has no picture");
  assert.ok(!pickImage(stops).includes("?"), "tracking query is stripped");
  stops.push({ name: "San Jacinto Monument", category: "landmark", priority: 2, thumbnail: T("Monument") });
  assert.match(pickImage(stops), /Monument/, "a landmark wins even at lower priority");
});

test("pickImage falls back gracefully", () => {
  assert.equal(pickImage([]), "");
  assert.equal(pickImage([{ name: "x", category: "landmark" }]), "");
  assert.equal(pickImage([{ name: "x", category: "landmark", thumbnail: "http://insecure/x.jpg" }]), "", "only https pictures");
  assert.match(pickImage([{ name: "a", category: "food", priority: 1, thumbnail: T("A") }, { name: "b", category: "food", priority: 5, thumbnail: T("B") }]), /B\.jpg/, "same category: higher priority");
});

test("bannerUrl asks Wikimedia for a wider thumbnail", () => {
  assert.match(bannerUrl(T("X").replace(/\?.*$/, "")), /\/800px-X\.jpg$/);
  assert.equal(bannerUrl("https://example.com/plain.jpg"), "https://example.com/plain.jpg");
});
