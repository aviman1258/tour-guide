import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeListing, fallbackListing, TITLE_MAX } from "../server/lib/describe.js";

const it = {
  start: { label: "Houston Bush Intercontinental (IAH)" }, end: { label: "Hyatt Regency Houston Galleria" },
  stops: [{ name: "Houston Heights" }, { name: "Mahatma Gandhi District" }, { name: "BAPS Shri Swaminarayan Mandir, Houston" }, { name: "River Oaks" }],
};

test("a good draft is kept, tidied", () => {
  const r = shapeListing({ title: "“Houston: Heights, Little India and the Mandir.”", description: "  A relaxed afternoon between IAH and the Galleria!! Historic streets, Indian food, and a marble temple.  " }, it, "Houston, Texas, US");
  assert.equal(r.title, "Houston: Heights, Little India and the Mandir");
  assert.equal(r.description, "A relaxed afternoon between IAH and the Galleria. Historic streets, Indian food, and a marble temple.");
  assert.equal(r.source, "claude");
});

test("over-long drafts are cut at a word boundary within the library limits", () => {
  const long = "Houston: " + Array(20).fill("Heights").join(", ");
  const r = shapeListing({ title: long, description: "x".repeat(30) + " " + "word ".repeat(200) }, it);
  assert.ok(r.title.length <= TITLE_MAX && !r.title.endsWith(","), r.title);
  assert.ok(r.description.length <= 501 && r.description.endsWith("…"));
});

test("abusive or markup drafts fall back field by field", () => {
  const r = shapeListing({ title: "<script>alert(1)</script>", description: "A relaxed afternoon between IAH and the Galleria with Indian food." }, it, "Houston, Texas, US");
  assert.equal(r.title, "Houston: Houston Heights, Mahatma Gandhi District, BAPS Shri Swaminarayan Mandir");
  assert.equal(r.source, "mixed");
  const both = shapeListing({ title: "shit", description: "x" }, it, "Houston, Texas, US");
  assert.equal(both.source, "fallback");
});

test("fallback listing is specific and within limits", () => {
  const f = fallbackListing(it, "Houston, Texas, US");
  assert.equal(f.title, "Houston: Houston Heights, Mahatma Gandhi District, BAPS Shri Swaminarayan Mandir");
  assert.equal(f.description, "4 stops from Houston Bush Intercontinental to Hyatt Regency Houston Galleria: Houston Heights, Mahatma Gandhi District, BAPS Shri Swaminarayan Mandir and more. Narrated as you drive.");
  assert.ok(fallbackListing({ stops: [] }).title.length >= 4);
});
