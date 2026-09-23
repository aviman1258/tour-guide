// IndexNow: tell Bing (and Yandex, Naver, Seznam, which share the protocol) about new or
// changed URLs the moment they exist, instead of waiting to be crawled. The key is not a
// secret: it must be served at https://<host>/<key>.txt so the engines can check we own the
// site. Fire-and-forget, never throws, off when INDEXNOW_KEY is unset.

import { config } from "../config.js";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const state = { submitted: 0, lastAt: null, lastStatus: null, lastError: null };
export const stats = () => ({ enabled: Boolean(config.indexNowKey), ...state });

/** Submit up to 10,000 absolute URLs (same host). Resolves to the HTTP status or null. */
export async function submit(urls, { fetchImpl = globalThis.fetch, base = "https://deodapper.com" } = {}) {
  if (!config.indexNowKey || !urls?.length) return null;
  const host = new URL(base).host;
  const list = [...new Set(urls)].filter((u) => { try { return new URL(u).host === host; } catch { return false; } }).slice(0, 10000);
  if (!list.length) return null;
  try {
    const r = await fetchImpl(ENDPOINT, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key: config.indexNowKey, keyLocation: `${base}/${config.indexNowKey}.txt`, urlList: list }),
      signal: AbortSignal.timeout?.(8000),
    });
    state.lastStatus = r.status; state.lastAt = new Date().toISOString();
    if (r.status >= 200 && r.status < 300) { state.submitted += list.length; state.lastError = null; }
    else state.lastError = `IndexNow answered ${r.status}`;
    return r.status;
  } catch (err) {
    state.lastError = err.message; state.lastAt = new Date().toISOString();
    return null;
  }
}
