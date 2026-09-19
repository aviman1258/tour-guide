// Small in-memory per-IP rate limiter for the routes free visitors can call.
// Sliding window: at most `max` hits per `windowMs` per key.

export function createLimiter({ max = 60, windowMs = 10 * 60_000 } = {}) {
  const hits = new Map(); // key → [timestamps]
  let sweep = 0;

  function check(key) {
    const now = Date.now();
    if (++sweep % 500 === 0) for (const [k, arr] of hits) if (arr[arr.length - 1] < now - windowMs) hits.delete(k);
    const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.ceil((arr[0] + windowMs - now) / 1000) };
    }
    arr.push(now);
    hits.set(key, arr);
    return { ok: true, remaining: max - arr.length };
  }

  return { check };
}

/** Express middleware: skip for subscribers, limit everyone else by IP. */
export function limitFree(limiter) {
  return (req, res, next) => {
    if (req.tier === "subscriber") return next();
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const r = limiter.check(key);
    if (r.ok) return next();
    res.set("retry-after", String(r.retryAfterSec));
    res.status(429).json({ error: `Too many requests from this connection. Try again in ${Math.ceil(r.retryAfterSec / 60)} min.` });
  };
}
