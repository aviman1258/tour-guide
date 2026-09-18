/** Tiny TTL cache over a Map with a max size (oldest insert evicted first). */
export class TtlCache {
  constructor(maxEntries = 2000) {
    this.max = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  /** get-or-compute. `null` results are cached too (negative caching). */
  async wrap(key, ttlMs, compute, negativeTtlMs = ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value, value === null ? negativeTtlMs : ttlMs);
    return value;
  }
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
