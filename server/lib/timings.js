// Remembers how long each planning phase actually took (last 20 runs per phase) so the
// UI can show a realistic estimate instead of a guess. Stored in data/timings.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "timings.json");
const KEEP = 20;

// Sensible priors for a first run (ms); replaced by real data as it arrives.
const PRIORS = {
  "plan.claude": [95_000],
  "plan.groundPerCandidate": [6_000],
  "plan.route": [12_000],
  "narrate.scan": [90_000],
  "narrate.claude": [140_000],
};

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    store = {};
  }
  return store;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store));
  } catch (err) {
    console.warn("[timings] could not save:", err.message);
  }
}

/** Record one observation (ms) for a phase. */
export function record(phase, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const s = load();
  s[phase] = [...(s[phase] || []), Math.round(ms)].slice(-KEEP);
  save();
}

function median(arr) {
  if (!arr?.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** Median of recorded values (or the prior). */
export function typical(phase) {
  const s = load();
  return median(s[phase]) ?? median(PRIORS[phase]) ?? null;
}

export function samples(phase) {
  return (load()[phase] || []).length;
}

/** Everything the client needs to draw a progress bar for a plan. */
export function planEstimate(candidateCount = 12) {
  const claude = typical("plan.claude");
  const perCand = typical("plan.groundPerCandidate");
  const route = typical("plan.route");
  return {
    phases: { claude, ground: perCand * candidateCount, route },
    perCandidateMs: perCand,
    candidateCount,
    totalMs: claude + perCand * candidateCount + route,
    basedOnRuns: samples("plan.claude"),
  };
}

export function narrateEstimate() {
  const scan = typical("narrate.scan"), claude = typical("narrate.claude");
  return { phases: { scan, claude }, totalMs: scan + claude, basedOnRuns: samples("narrate.claude") };
}
