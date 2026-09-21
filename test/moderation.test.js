import { test } from "node:test";
import assert from "node:assert/strict";
import { check, assertClean } from "../server/lib/moderation.js";

test("plain descriptions pass", () => {
  for (const s of [
    "Houston: Heights, Little India and the Mandir",
    "A relaxed afternoon for anyone who loves historic neighborhoods and good chaat.",
    "Drop by Dick's Sporting Goods, then Scunthorpe and Cockburn Street; spicy food at the end.",
    "Select the best stops from Denver airport; update your start time if you land late.",
    "Assassination Rocks trail, then fire-retardant museum. Class act.",
    "Mrs Robinson's cafe — 'the best' pie in town & a view",
    "Coordinates 29.99, -95.33 → 29.74, -95.46 (1 pm–3 pm)",
    "",
  ]) assert.equal(check(s), null, s);
});

test("markup and script are rejected", () => {
  for (const s of [
    "<script>alert(1)</script>",
    "nice route <img src=x onerror=alert(1)>",
    "click <a href='javascript:alert(1)'>here</a>",
    "onload=alert(1)",
    "&lt;script&gt;",
    "{{constructor.constructor('alert(1)')()}}",
  ]) assert.equal(check(s), "markup", s);
});

test("SQL-shaped text is rejected", () => {
  for (const s of [
    "x' OR '1'='1",
    "1; DROP TABLE routes; --",
    "' UNION SELECT password FROM users --",
    "delete from routes",
    "admin'--",
    "1=1--",
  ]) assert.equal(check(s), "sql", s);
});

test("profanity and slurs are rejected, including disguised spellings", () => {
  for (const s of [
    "this route is shit",
    "F*ck the traffic",
    "fuuuuuck",
    "sh1t route",
    "a$$hole drivers everywhere",
    "no n.i.g.g.e.r.s here",
    "N I G G E R",
    "F4gg0t",
    "white power tour",
    "Bunch of retards planned this",
  ]) assert.equal(check(s), "language", s);
});

test("assertClean names the field and sets status 400", () => {
  assertClean({ title: "Fine title", description: "Fine description" });
  assert.throws(() => assertClean({ title: "ok", description: "<b>x</b>" }), (err) => err.status === 400 && /description/.test(err.message) && err.reason === "markup");
  assert.throws(() => assertClean({ title: "shit", description: "ok" }), (err) => /title/.test(err.message) && err.reason === "language");
});
