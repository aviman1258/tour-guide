// Narration audio on the phone. Clips live at /api/audio/<hash>.mp3 on the server; this keeps a
// copy in the Cache API ("tg-audio") so a prepared or imported trip plays offline, and hands the
// speech queue an object URL to play. Everything degrades: no Cache API, no network, no clip →
// the phone's own voice reads the text instead.

import { apiBase } from "./config.js";

export const CACHE = "tg-audio";
const objectUrls = new Map(); // absolute url → blob: url, for this page's lifetime

export const absUrl = (url) => (/^https?:/i.test(url) ? url : `${apiBase()}${url}`);
export const clipsOf = (pkg) => (pkg?.narration || []).filter((n) => n.audio?.url);

/** Download every clip of a package into the cache (skips what is already there). */
export async function warm(pkg, { onProgress = () => {} } = {}) {
  const clips = clipsOf(pkg);
  if (!clips.length || !globalThis.caches) return { total: clips.length, cached: 0, failed: 0 };
  let cached = 0, failed = 0;
  let cache;
  try { cache = await caches.open(CACHE); } catch { return { total: clips.length, cached: 0, failed: clips.length }; }
  const queue = clips.map((n) => absUrl(n.audio.url));
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await cache.put(url, res);
        }
        cached++;
      } catch { failed++; }
      onProgress({ total: clips.length, done: cached + failed, failed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return { total: clips.length, cached, failed };
}

/** An object URL for a clip: from the cache when we have it, else fetched (and cached). Null when neither works. */
export async function blobUrlFor(url) {
  const abs = absUrl(url);
  if (objectUrls.has(abs)) return objectUrls.get(abs);
  let res = null;
  try { res = globalThis.caches ? await (await caches.open(CACHE)).match(abs) : null; } catch { /* no cache */ }
  if (!res) {
    try {
      res = await fetch(abs);
      if (!res.ok) return null;
      if (globalThis.caches) { try { (await caches.open(CACHE)).put(abs, res.clone()); } catch { /* ignore */ } }
    } catch { return null; }
  }
  try {
    const obj = URL.createObjectURL(await res.blob());
    objectUrls.set(abs, obj);
    return obj;
  } catch { return null; }
}
