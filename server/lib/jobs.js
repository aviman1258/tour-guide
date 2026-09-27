// Long-running work (planning, preparing a drive) as server-side jobs. The browser's connection
// is only a window onto a job: when a phone's screen goes dark and the connection drops, the job
// keeps running, every progress event is kept, and the page picks the job back up where it left
// off (GET /api/jobs/:id?after=N replays what it missed and then streams live). A job belongs to
// the device that started it. Finished jobs are kept for two hours.
//
//   create({ kind, owner, run })  run({ emit, signal }) → result | null (cancelled)
//   get(id, owner) · cancel(id, owner) · subscribe(job, fn) · sweep()

import { randomBytes } from "node:crypto";

export const KEEP_MS = 2 * 3600_000;
const MAX_JOBS = 300;
const MAX_EVENTS = 3000;
const jobs = new Map();

export const ownerOf = (req) => String(req.get?.("x-device") || req.ip || "");

export function create({ kind, owner = "", run, onError }) {
  if (jobs.size >= MAX_JOBS) sweep(Date.now(), true);
  const id = `j_${randomBytes(12).toString("base64url")}`;
  const ac = new AbortController();
  const job = {
    id, kind, owner, status: "running", events: [], result: null, error: null,
    createdAt: Date.now(), updatedAt: Date.now(), listeners: new Set(), ac,
    promise: null,
  };
  const emit = (event, data) => {
    if (job.events.length >= MAX_EVENTS) return;
    const e = { event, data };
    job.events.push(e);
    job.updatedAt = Date.now();
    for (const fn of job.listeners) { try { fn(e); } catch { /* listener's problem */ } }
  };
  const finish = (status) => { job.status = status; job.updatedAt = Date.now(); for (const fn of job.listeners) { try { fn(null); } catch { /* ignore */ } } job.listeners.clear(); };
  job.promise = (async () => {
    try {
      const result = await run({ emit, signal: ac.signal });
      if (ac.signal.aborted || result == null) { emit("cancelled", {}); finish("cancelled"); return null; }
      job.result = result;
      finish("done");
      return result;
    } catch (err) {
      if (ac.signal.aborted) { emit("cancelled", {}); finish("cancelled"); return null; }
      job.error = { message: err.message, status: err.status || 500 };
      onError?.(err);
      emit("error", job.error);
      finish("error");
      return null;
    }
  })();
  jobs.set(id, job);
  return job;
}

/** The job, if it exists and belongs to this owner (an empty owner on the job means anyone with the id). */
export function get(id, owner = "") {
  const job = jobs.get(String(id || ""));
  if (!job) return null;
  if (job.owner && owner && job.owner !== owner) return null;
  return job;
}

export function cancel(id, owner = "") {
  const job = get(id, owner);
  if (!job) return false;
  if (job.status === "running") job.ac.abort();
  return true;
}

/** Live events for a running job; `fn(null)` when it finishes. Returns an unsubscribe. */
export function subscribe(job, fn) {
  if (job.status !== "running") { fn(null); return () => {}; }
  job.listeners.add(fn);
  return () => job.listeners.delete(fn);
}

/** What a client sees: status and the events after the ones it already has. */
export function view(job, after = 0) {
  const n = Math.max(0, Math.min(job.events.length, Number(after) || 0));
  return { id: job.id, kind: job.kind, status: job.status, createdAt: new Date(job.createdAt).toISOString(), total: job.events.length, events: job.events.slice(n), error: job.error };
}

export function sweep(now = Date.now(), force = false) {
  for (const [id, job] of jobs) {
    if (job.status !== "running" && (now - job.updatedAt > KEEP_MS || force)) jobs.delete(id);
  }
}

export const stats = () => ({ jobs: jobs.size, running: [...jobs.values()].filter((j) => j.status === "running").length });
