// English Wikipedia: REST summary + MediaWiki action API.
// All calls cached; negative results cached for 1 hour.

import { config } from "./config.js";
import { fetchJson, httpError } from "./lib/http.js";
import { TtlCache, HOUR, DAY } from "./lib/cache.js";

const cache = new TtlCache(5000);

/** Rate limits and server errors must never be cached as "not found": throw instead. */
function guard(status, what) {
  if (status === 429 || status >= 500) throw httpError(503, `Wikipedia is busy (${status}) during ${what}; try again in a minute`);
}

const api = (params) => {
  const u = new URL(config.wikiApiBase);
  u.search = new URLSearchParams({ format: "json", formatversion: "2", ...params }).toString();
  return u.toString();
};

export const wikiUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

/**
 * REST page summary. Returns null when missing, disambiguation, or not standard.
 * { title, description, extract, thumbnail, coordinates:{lat,lon}|null, url }
 */
export async function summary(title) {
  const key = `sum:${title.toLowerCase()}`;
  return cache.wrap(key, DAY, async () => {
    const slug = encodeURIComponent(title.trim().replace(/ /g, "_"));
    const { status, data } = await fetchJson(`${config.wikiRestBase}/page/summary/${slug}`);
    guard(status, "summary");
    if (status !== 200 || !data || data.type !== "standard") return null;
    return {
      title: data.title,
      pageid: data.pageid,
      description: data.description || "",
      extract: data.extract || "",
      thumbnail: data.thumbnail?.source || null,
      coordinates: data.coordinates ? { lat: data.coordinates.lat, lon: data.coordinates.lon } : null,
      url: data.content_urls?.desktop?.page || wikiUrl(data.title),
    };
  }, HOUR);
}

/** Full-text title search. Returns [{title, pageid, snippet}]. */
export async function search(q, limit = 3) {
  const key = `search:${q.toLowerCase()}:${limit}`;
  return cache.wrap(key, DAY, async () => {
    const { status, data } = await fetchJson(api({ action: "query", list: "search", srsearch: q, srlimit: String(limit) }));
    guard(status, "search");
    if (status !== 200) return [];
    return (data?.query?.search || []).map((s) => ({ title: s.title, pageid: s.pageid, snippet: s.snippet }));
  });
}

/**
 * Coordinates + thumbnail + description for up to 50 titles in one call.
 * Returns Map<normalizedTitle, {title, pageid, coordinates|null, thumbnail|null, description}>.
 */
export async function coordinatesBatch(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const { status, data } = await fetchJson(api({
      action: "query", prop: "coordinates|pageimages|description", titles: chunk.join("|"),
      redirects: "1", piprop: "thumbnail", pithumbsize: "400",
    }));
    guard(status, "coordinates");
    if (status !== 200) continue;
    for (const p of data?.query?.pages || []) {
      if (p.missing) continue;
      const c = p.coordinates?.[0];
      out.set(p.title.toLowerCase(), {
        title: p.title, pageid: p.pageid,
        coordinates: c ? { lat: c.lat, lon: c.lon } : null,
        thumbnail: p.thumbnail?.source || null,
        description: p.description || "",
      });
    }
    // map redirected source titles to their targets too
    for (const r of data?.query?.redirects || []) {
      const t = out.get(r.to.toLowerCase());
      if (t) out.set(r.from.toLowerCase(), t);
    }
  }
  return out;
}

/** Articles near a point. Returns [{pageid, title, lat, lon, dist, type}]. */
export async function geosearch(lat, lon, radiusM = 1000, limit = 10) {
  const key = `geo:${lat.toFixed(4)},${lon.toFixed(4)}:${radiusM}:${limit}`;
  return cache.wrap(key, DAY, async () => {
    const { status, data } = await fetchJson(api({
      action: "query", list: "geosearch", gscoord: `${lat}|${lon}`,
      gsradius: String(Math.min(10000, radiusM)), gslimit: String(Math.min(500, limit)),
      gsprop: "type|name", maxlag: "5",
    }));
    guard(status, "geosearch");
    if (status !== 200) return [];
    return (data?.query?.geosearch || []).map((g) => ({
      pageid: g.pageid, title: g.title, lat: g.lat, lon: g.lon, dist: g.dist, type: g.type || null,
    }));
  });
}

/**
 * Intro extracts + disambiguation flag + page length + 30-day pageviews for up to 20 pageids.
 * Returns [{pageid, title, extract, isDisambiguation, length, pageviews}].
 */
export async function extractsBatch(pageids) {
  const out = [];
  for (let i = 0; i < pageids.length; i += 20) {
    const chunk = pageids.slice(i, i + 20);
    const { status, data } = await fetchJson(api({
      action: "query", prop: "extracts|pageprops|info|pageviews", pageids: chunk.join("|"),
      exintro: "1", explaintext: "1", exsentences: "4", exlimit: "20",
      ppprop: "disambiguation", pvipdays: "30", maxlag: "5",
    }));
    guard(status, "extracts");
    if (status !== 200) continue;
    for (const p of data?.query?.pages || []) {
      if (p.missing) continue;
      const views = Object.values(p.pageviews || {}).reduce((a, b) => a + (b || 0), 0);
      out.push({
        pageid: p.pageid, title: p.title, extract: (p.extract || "").trim(),
        isDisambiguation: p.pageprops?.disambiguation !== undefined,
        length: p.length || 0, pageviews: views,
      });
    }
  }
  return out;
}
