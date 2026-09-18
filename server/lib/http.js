import { config } from "../config.js";

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * fetch JSON with our User-Agent, a timeout, and one retry on 429/5xx.
 * Returns { status, data } and never throws on non-2xx (callers decide).
 */
export async function fetchJson(url, { headers = {}, retry = 1, method = "GET", body } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: { "User-Agent": config.userAgent, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
    } catch (err) {
      if (attempt < retry) {
        await sleep(2000);
        continue;
      }
      throw httpError(502, `upstream unreachable: ${new URL(url).host} (${err.cause?.code || err.name})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retry) {
      const ra = Number(res.headers.get("retry-after"));
      // Wikimedia sends Retry-After of 30-60 s when rate-limited; cap so one hot call can't stall a request.
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 15) * 1000 : 2000;
      console.warn(`[http] ${res.status} from ${new URL(url).host}; retrying in ${wait} ms`);
      await sleep(wait);
      continue;
    }
    if (res.status === 429) console.warn(`[http] 429 from ${new URL(url).host} (giving up)`);
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, data };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async fn over items with at most `limit` in flight. Preserves order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
