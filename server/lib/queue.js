import { sleep } from "./http.js";

/**
 * Runs jobs one at a time with a minimum gap between job *starts*.
 * Used for Nominatim and the OSRM demo server (both: max 1 request/second).
 */
export class SerialQueue {
  constructor({ minIntervalMs = 1100 } = {}) {
    this.minInterval = minIntervalMs;
    this.lastStart = 0;
    this.tail = Promise.resolve();
  }

  run(fn) {
    const job = this.tail.then(async () => {
      const wait = this.lastStart + this.minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
      return fn();
    });
    // keep the chain alive even if a job rejects
    this.tail = job.catch(() => {});
    return job;
  }
}
