// Remembers how long planning / prepare-drive phases took on THIS device (last 20 runs per
// phase, localStorage), so estimates survive server restarts, redeploys and host changes.
// The server keeps its own history too; local numbers win when we have them.

const KEY = "tourguide.timings.v1";
const KEEP = 20;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

export function record(phase, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const data = load();
  data[phase] = [...(data[phase] || []), Math.round(ms)].slice(-KEEP);
  save(data);
}

function median(arr) {
  if (!arr?.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

export const typical = (phase) => median(load()[phase]);
export const runs = (phase) => (load()[phase] || []).length;

/**
 * Plan estimate: local medians per phase, falling back to the server's numbers.
 * `server` is the server's estimate event ({phases:{claude, ground, route}, perCandidateMs, basedOnRuns}).
 */
export function planEstimate(server, candidateCount = 12) {
  const claude = typical("plan.claude") ?? server?.phases?.claude ?? 95_000;
  const perCand = typical("plan.groundPerCandidate") ?? server?.perCandidateMs ?? 6_000;
  const route = typical("plan.route") ?? server?.phases?.route ?? 12_000;
  const local = runs("plan.claude");
  return {
    phases: { claude, ground: perCand * candidateCount, route },
    totalMs: claude + perCand * candidateCount + route,
    basedOnRuns: local || server?.basedOnRuns || 0,
    source: local ? "device" : server?.basedOnRuns ? "server" : "default",
  };
}

export function narrateEstimate(server) {
  const scan = typical("narrate.scan") ?? server?.phases?.scan ?? 90_000;
  const claude = typical("narrate.claude") ?? server?.phases?.claude ?? 140_000;
  const local = runs("narrate.claude") || runs("narrate.scan");
  return {
    phases: { scan, claude },
    totalMs: scan + claude,
    basedOnRuns: local || server?.basedOnRuns || 0,
    source: local ? "device" : server?.basedOnRuns ? "server" : "default",
  };
}
