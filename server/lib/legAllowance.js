// How many drive-by stories a leg can carry, and how far apart they must be. Based on driving
// TIME, not distance: a two-minute Manhattan block-hop and a two-minute highway sprint both
// have room for one short story, even though one is 800 m and the other 3 km. The old rule
// ("skip legs under 3 km, 2 km apart") produced zero drive-bys for a whole Manhattan day.

const STORY_SECONDS = 75; // one 40-70 word drive-by plus a breath, at speaking pace

/**
 * @param {number} durationSec  routed driving time of the leg
 * @param {number} lengthM      routed length of the leg
 * @returns {{ minutes: number, maxDrivebys: number, minGapM: number, speedMps: number }}
 */
export function legAllowance(durationSec, lengthM) {
  const sec = Math.max(0, Number(durationSec) || 0);
  const m = Math.max(0, Number(lengthM) || 0);
  const minutes = sec / 60;
  // fall back to a city pace when the router gave no time
  const speedMps = sec > 0 ? m / sec : 8;
  const maxDrivebys = minutes < 2 ? 0 : minutes < 6 ? 1 : minutes < 15 ? 2 : 3;
  // a story every STORY_SECONDS of driving at this leg's pace, never closer than 400 m or farther than 2.5 km apart
  const minGapM = Math.round(Math.min(2500, Math.max(400, speedMps * STORY_SECONDS)));
  return { minutes: Math.round(minutes * 10) / 10, maxDrivebys, minGapM, speedMps };
}
