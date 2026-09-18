import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeech } from "../web/js/speech.js";

// No speechSynthesis in Node: the queue runs in its silent timer-driven mode.

test("chunkText splits on sentences and keeps chunks under 200 chars", () => {
  const sp = createSpeech();
  const long = "A".repeat(150) + ", " + "B".repeat(120) + ". Second sentence here! Third? Yes.";
  const chunks = sp.chunkText(long);
  assert.ok(chunks.length >= 4, `got ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 201, `chunk too long: ${c.length}`);
  assert.equal(chunks.at(-1), "Yes.");
});

test("a stop narration interrupts a playing drive-by and drops queued drive-bys", () => {
  const sp = createSpeech();
  const ended = [];
  sp.on("end", (e) => ended.push(e));
  sp.enqueue({ id: "db1", kind: "driveby", text: "First drive by fact. It has two sentences." });
  sp.enqueue({ id: "db2", kind: "driveby", text: "Second drive by." });
  assert.equal(sp.current.id, "db1");
  assert.equal(sp.queueLength, 1);
  sp.enqueue({ id: "stop1", kind: "stop", text: "Welcome to the stop." });
  assert.equal(sp.current.id, "stop1");
  assert.equal(sp.queueLength, 0, "queued drive-by should be dropped");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].item.id, "db1");
  assert.equal(ended[0].interrupted, true);
  sp.stop();
});

test("drive-bys wait behind a stop and stops jump ahead of queued drive-bys", () => {
  const sp = createSpeech();
  sp.enqueue({ id: "stop1", kind: "stop", text: "Stop one." });
  sp.enqueue({ id: "db1", kind: "driveby", text: "Drive by." });
  sp.enqueue({ id: "stop2", kind: "stop", text: "Stop two." });
  assert.equal(sp.current.id, "stop1");
  assert.equal(sp.queueLength, 2);
  sp.skip(); // finish stop1 → stop2 should come before db1
  assert.equal(sp.current.id, "stop2");
  sp.skip();
  assert.equal(sp.current.id, "db1");
  sp.stop();
});

test("stale drive-bys are skipped when dequeued", () => {
  const sp = createSpeech({ isStale: (item) => item.id === "old" });
  const ended = [];
  sp.on("end", (e) => ended.push(e));
  sp.enqueue({ id: "stop1", kind: "stop", text: "Stop." });
  sp.enqueue({ id: "old", kind: "driveby", text: "Too late." });
  sp.enqueue({ id: "fresh", kind: "driveby", text: "Still relevant." });
  sp.skip();
  assert.equal(sp.current.id, "fresh");
  assert.ok(ended.some((e) => e.item.id === "old" && e.stale));
  sp.stop();
});
