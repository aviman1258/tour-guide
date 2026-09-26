import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as accounts from "../server/lib/accounts.js";
import { loginEmail } from "../server/lib/mail.js";

const PKG = (n = 3) => ({ version: 1, preparedAt: "2026-09-25T10:00:00.000Z", itinerary: { start: { label: "Houston Bush Intercontinental (IAH)", lat: 29.99, lon: -95.34 }, end: { label: "Hyatt Regency Galleria, Houston", lat: 29.74, lon: -95.46 }, date: "2026-11-14", arrivalTime: "11:30", stops: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Stop ${i}` })) }, narration: [{ id: "n1", text: "hi" }], credit: { token: "x" } });

beforeEach(() => accounts._useMemoryDb());

test("the same email always finds the same account; the address itself is never stored", () => {
  const a = accounts.requestLink({ email: "Avi@Example.com " });
  const b = accounts.requestLink({ email: "avi@example.com" });
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, false);
  assert.equal(a.accountId, b.accountId);
  assert.notEqual(a.token, b.token);
  assert.ok(!accounts.emailHash("avi@example.com").includes("example"), "hash, not the address");
  assert.throws(() => accounts.requestLink({ email: "not an email" }), /email address/);
});

test("a link signs in once, within 20 minutes; the session then lasts and can be logged out", () => {
  let now = Date.parse("2026-09-25T12:00:00Z");
  const { token, accountId } = accounts.requestLink({ email: "a@b.co", now });
  const s = accounts.consumeLink({ token, device: "dev1", now: now + 60_000 });
  assert.equal(s.accountId, accountId);
  assert.throws(() => accounts.consumeLink({ token, now: now + 61_000 }), /already used/);
  assert.deepEqual(accounts.sessionFor(s.sessionToken, now + 100 * 86400_000), { accountId });
  assert.equal(accounts.sessionFor(s.sessionToken, now + 181 * 86400_000), null, "sessions last 180 days");
  assert.equal(accounts.sessionFor("nonsense"), null);
  accounts.logout(s.sessionToken);
  assert.equal(accounts.sessionFor(s.sessionToken, now + 2 * 60_000), null);
  const late = accounts.requestLink({ email: "a@b.co", now });
  assert.throws(() => accounts.consumeLink({ token: late.token, now: now + accounts.LINK_TTL_MS + 1000 }), /expired/);
});

test("no more than three links per address in 15 minutes", () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) accounts.requestLink({ email: "spam@me.com", now });
  assert.throws(() => accounts.requestLink({ email: "spam@me.com", now }), /15 minutes/);
  assert.doesNotThrow(() => accounts.requestLink({ email: "spam@me.com", now: now + 16 * 60_000 }));
});

test("routes: put, list with a server-derived summary, get, soft delete, per-account isolation", () => {
  const { token } = accounts.requestLink({ email: "r@x.io" });
  const { accountId } = accounts.consumeLink({ token });
  const other = accounts.consumeLink({ token: accounts.requestLink({ email: "o@x.io" }).token }).accountId;
  const entry = accounts.putRoute(accountId, "trip_abc", { pkg: PKG(4) });
  assert.equal(entry.title, "Houston Bush Intercontinental (IAH) → Hyatt Regency Galleria");
  assert.equal(entry.stopsCount, 4);
  assert.equal(entry.paid, true);
  accounts.putRoute(accountId, "trip_def", { title: "My Sunday loop", pkg: { ...PKG(2), credit: undefined }, now: Date.now() + 5000 });
  const list = accounts.listRoutes(accountId);
  assert.deepEqual(list.map((r) => r.tripId), ["trip_def", "trip_abc"], "newest first");
  assert.equal(list[0].title, "My Sunday loop");
  assert.equal(list[0].paid, false);
  assert.equal(accounts.getRoute(accountId, "trip_abc").package.itinerary.stops.length, 4);
  assert.equal(accounts.getRoute(other, "trip_abc"), null, "another account can't see it");
  assert.deepEqual(accounts.listRoutes(other), []);
  accounts.deleteRoute(accountId, "trip_abc");
  assert.equal(accounts.getRoute(accountId, "trip_abc"), null);
  const afterDelete = accounts.listRoutes(accountId).find((r) => r.tripId === "trip_abc");
  assert.equal(afterDelete.deleted, true, "the deletion is visible to the account's other devices");
  assert.throws(() => accounts.putRoute(accountId, "trip_x", { pkg: { nope: true } }), /drive package/);
  assert.throws(() => accounts.putRoute(accountId, "bad id!", { pkg: PKG() }), /trip id/);
  accounts.sweep(Date.now() + 31 * 86400_000);
  assert.equal(accounts.listRoutes(accountId).some((r) => r.tripId === "trip_abc"), false, "swept after 30 days");
  assert.equal(accounts.stats().routes, 1);
});

test("the sign-in email carries the link and says it expires", () => {
  const m = loginEmail({ link: "https://deodapper.com/plan.html?login=abc", purchase: true });
  assert.match(m.subject, /route/i);
  assert.ok(m.text.includes("https://deodapper.com/plan.html?login=abc"));
  assert.ok(m.html.includes("login=abc") && m.text.includes("20 minutes"));
  assert.match(loginEmail({ link: "x" }).subject, /sign-in link/);
});
