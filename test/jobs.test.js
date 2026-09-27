import { test } from "node:test";
import assert from "node:assert/strict";
import * as jobs from "../server/lib/jobs.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("a job records its events, finishes with a result, and replays from any point", async () => {
  const job = jobs.create({ kind: "plan", owner: "dev1", run: async ({ emit }) => { emit("phase", { p: 1 }); await tick(); emit("phase", { p: 2 }); emit("done", { itinerary: { stops: [1, 2] } }); return { stops: [1, 2] }; } });
  assert.equal(job.status, "running");
  const live = [];
  jobs.subscribe(job, (e) => live.push(e ? e.event : "END"));
  await job.promise;
  assert.equal(job.status, "done");
  assert.deepEqual(job.result, { stops: [1, 2] });
  assert.deepEqual(live.slice(-2), ["done", "END"]);
  const v = jobs.view(job, 1);
  assert.equal(v.total, 3);
  assert.deepEqual(v.events.map((e) => e.event), ["phase", "done"], "after=1 skips the first recorded event");
  assert.equal(jobs.get(job.id, "dev1"), job);
  assert.equal(jobs.get(job.id, "someone-else"), null, "another device cannot read it");
});

test("a failing job records the error as an event too, so a reconnecting client sees it", async () => {
  const errors = [];
  const job = jobs.create({ kind: "prepare", owner: "d", run: async () => { const e = new Error("Claude is busy"); e.status = 503; throw e; }, onError: (e) => errors.push(e.message) });
  await job.promise;
  assert.equal(job.status, "error");
  assert.deepEqual(job.error, { message: "Claude is busy", status: 503 });
  assert.deepEqual(jobs.view(job).events.at(-1), { event: "error", data: { message: "Claude is busy", status: 503 } });
  assert.deepEqual(errors, ["Claude is busy"]);
});

test("cancel aborts the run; a run that returns null counts as cancelled", async () => {
  let aborted = false;
  const job = jobs.create({ kind: "plan", owner: "d", run: ({ signal }) => new Promise((resolve) => { signal.addEventListener("abort", () => { aborted = true; resolve(null); }); }) });
  assert.equal(jobs.cancel(job.id, "other"), false, "not yours");
  assert.equal(jobs.cancel(job.id, "d"), true);
  await job.promise;
  assert.equal(aborted, true);
  assert.equal(job.status, "cancelled");
  assert.equal(jobs.view(job).events.at(-1).event, "cancelled");
});

test("sweep drops finished jobs after two hours but never running ones", async () => {
  const done = jobs.create({ kind: "plan", owner: "d", run: async () => ({}) });
  await done.promise;
  const running = jobs.create({ kind: "plan", owner: "d", run: () => new Promise(() => {}) });
  jobs.sweep(Date.now() + jobs.KEEP_MS + 1000);
  assert.equal(jobs.get(done.id, "d"), null);
  assert.equal(jobs.get(running.id, "d"), running);
  running.ac.abort();
});
