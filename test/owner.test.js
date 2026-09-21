import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwner, LOCK_MS, TOKEN_TTL_MS } from "../server/lib/owner.js";

function setup(secret = "correct horse") {
  let t = Date.parse("2026-09-21T12:00:00Z");
  const o = createOwner({ secret: () => secret, file: ":memory:", now: () => t });
  return { o, advance: (ms) => { t += ms; } };
}
const A = { ip: "1.2.3.4", device: "dev-a" };

test("right passphrase → token; token and raw passphrase both grant owner", () => {
  const { o } = setup();
  const { token } = o.unlock({ passphrase: "correct horse", ...A });
  assert.ok(token.length > 30);
  assert.equal(o.tierFor({ key: token, ...A }), "subscriber");
  assert.equal(o.tierFor({ key: "correct horse", ...A }), "subscriber");
  assert.equal(o.tierFor({ key: "", ...A }), "free");
  assert.equal(o.tierFor({ key: "nope", ...A }), "free");
});

test("three wrong passphrases lock the device and the IP for 24 hours, even for the right one", () => {
  const { o, advance } = setup();
  assert.throws(() => o.unlock({ passphrase: "a", ...A }), (e) => e.status === 401 && /2 tries left/.test(e.message));
  assert.throws(() => o.unlock({ passphrase: "b", ...A }), (e) => e.status === 401 && /One try left/.test(e.message));
  assert.throws(() => o.unlock({ passphrase: "c", ...A }), (e) => e.status === 429 && Boolean(e.lockedUntil));
  assert.throws(() => o.unlock({ passphrase: "correct horse", ...A }), (e) => e.status === 429, "locked: right answer refused");
  // same IP, new device id → still locked (the IP is locked); same device, new IP → still locked
  assert.throws(() => o.unlock({ passphrase: "correct horse", ip: A.ip, device: "dev-b" }), (e) => e.status === 429);
  assert.throws(() => o.unlock({ passphrase: "correct horse", ip: "9.9.9.9", device: A.device }), (e) => e.status === 429);
  // a different device on a different IP is unaffected
  assert.ok(o.unlock({ passphrase: "correct horse", ip: "9.9.9.9", device: "dev-z" }).token);
  // even the raw passphrase in the header is ignored while locked
  assert.equal(o.tierFor({ key: "correct horse", ...A }), "free");
  advance(LOCK_MS + 1000);
  assert.ok(o.unlock({ passphrase: "correct horse", ...A }).token, "lock expires");
});

test("wrong keys in the header count as guesses, but the same stale key counts once", () => {
  const { o } = setup();
  for (let i = 0; i < 10; i++) assert.equal(o.tierFor({ key: "stale-token", ...A }), "free");
  assert.equal(o.lockedUntil(A), null, "one stale token is one failure");
  o.tierFor({ key: "guess-2", ...A });
  o.tierFor({ key: "guess-3", ...A });
  assert.ok(o.lockedUntil(A), "three distinct wrong keys lock the caller");
});

test("a correct unlock clears earlier failures; revoke forgets a token; tokens expire", () => {
  const { o, advance } = setup();
  o.tierFor({ key: "x", ...A });
  o.tierFor({ key: "y", ...A });
  const { token } = o.unlock({ passphrase: "correct horse", ...A });
  assert.equal(o.lockedUntil(A), null);
  o.tierFor({ key: "z", ...A }); // one new failure after a clean unlock: not locked
  assert.equal(o.lockedUntil(A), null);
  assert.equal(o.revoke(token), true);
  assert.equal(o.tierFor({ key: token, ...A }), "free");
  const { token: t2 } = o.unlock({ passphrase: "correct horse", ...A });
  advance(TOKEN_TTL_MS + 1000);
  assert.equal(o.tierFor({ key: t2, ...A }), "free", "expired token");
});

test("no passphrase configured = everyone is the owner (local dev)", () => {
  const { o } = setup("");
  assert.equal(o.tierFor({ key: "", ...A }), "subscriber");
  assert.throws(() => o.unlock({ passphrase: "x", ...A }), /no owner passphrase/);
});
