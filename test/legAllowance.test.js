import { test } from "node:test";
import assert from "node:assert/strict";
import { legAllowance } from "../server/lib/legAllowance.js";

test("Manhattan legs get stories; the old 3 km rule would have skipped them", () => {
  const a = legAllowance(4 * 60, 1400); // 1.4 km in 4 minutes, midtown traffic
  assert.equal(a.maxDrivebys, 1);
  assert.equal(a.minGapM, 438, "about 75 s of driving at 5.8 m/s");
  const b = legAllowance(9 * 60, 2600); // a longer crawl downtown
  assert.equal(b.maxDrivebys, 2);
});

test("highway legs space stories by time, capped at 2.5 km", () => {
  const h = legAllowance(20 * 60, 30_000); // 30 km in 20 min at 25 m/s
  assert.equal(h.maxDrivebys, 3);
  assert.equal(h.minGapM, 1875);
  assert.equal(legAllowance(30 * 60, 60_000).minGapM, 2500, "capped");
});

test("very short hops stay quiet; missing duration falls back to a city pace", () => {
  assert.equal(legAllowance(90, 600).maxDrivebys, 0);
  const f = legAllowance(0, 1500);
  assert.equal(f.maxDrivebys, 0);
  assert.equal(f.speedMps, 8);
  assert.equal(legAllowance(undefined, undefined).minGapM, 600);
});
