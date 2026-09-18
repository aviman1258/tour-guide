// Drive simulation: replays the route geometry as fake GPS fixes at N× speed.

import { interpolateAlong } from "./routeMath.js";

export function createSim({ points, cum, onFix, stops = [], stopRadiusM = 200, speedMps = 15 }) {
  const total = cum[cum.length - 1];
  let factor = 5;
  let distM = 0;
  let timer = null;
  let pauseUntil = 0;       // sim-clock ms
  let simClock = Date.now();
  let offRouteUntil = 0;
  const pausedAt = new Set();
  const listeners = new Set();

  const notify = () => { for (const fn of listeners) fn(status()); };

  function status() {
    return { running: Boolean(timer), factor, distM, total, progress: total ? distM / total : 0 };
  }

  function tick() {
    simClock += 1000 * factor;
    const p = interpolateAlong(points, cum, distM);
    let lat = p.lat, lon = p.lon;
    let speed = speedMps;

    // pause inside each stop radius once, so "visited" logic gets exercised
    const near = stops.find((s) => !pausedAt.has(s.id) && Math.hypot((s.lat - lat) * 110540, (s.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180)) < stopRadiusM);
    if (near && simClock >= pauseUntil) {
      pausedAt.add(near.id);
      pauseUntil = simClock + 25_000; // 25 sim-seconds standing still
    }
    if (simClock < pauseUntil) speed = 0;

    if (simClock < offRouteUntil) {
      // 150 m perpendicular offset
      const off = 150 / 110540;
      const rad = ((p.heading + 90) * Math.PI) / 180;
      lat += off * Math.cos(rad);
      lon += (off * Math.sin(rad)) / Math.cos((lat * Math.PI) / 180);
    }

    onFix({
      coords: { latitude: lat, longitude: lon, accuracy: 5, speed, heading: p.heading },
      timestamp: simClock,
      sim: true,
    });

    if (speed > 0) distM += speed * factor;
    if (distM >= total) { distM = total; pause(); }
    notify();
  }

  function play() {
    if (timer) return;
    timer = setInterval(tick, 1000);
    tick();
    notify();
  }
  function pause() {
    clearInterval(timer);
    timer = null;
    notify();
  }
  function setFactor(f) { factor = Number(f) || 1; notify(); }
  function seek(fraction) { distM = Math.max(0, Math.min(1, fraction)) * total; pauseUntil = 0; tick(); }
  function nudgeOffRoute(ms = 30_000) { offRouteUntil = simClock + ms * factor; }

  /** Jump to just before the next interesting thing (a stop or a narration point). */
  function jumpToNext(targetsAlongM) {
    const next = targetsAlongM.filter((d) => d > distM + 50).sort((a, b) => a - b)[0];
    if (next != null) { distM = Math.max(0, next - 900); pauseUntil = 0; tick(); }
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function now() { return simClock; }

  return { play, pause, setFactor, seek, nudgeOffRoute, jumpToNext, onChange, status, now };
}
