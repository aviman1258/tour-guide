// The picture for a route: a free, reusable photo of its most iconic stop.
//
// "Most iconic" = the stop whose Wikipedia article people read most (30-day pageviews), among the
// stops whose article has a lead photo. Stops without a Wikipedia title are looked up by name and
// accepted only if the article sits within a few km of the stop. The photo must be freely
// licensed on Wikimedia Commons (no fair-use images, no maps, logos, flags or seals), and we keep
// its author and licence so pages can credit it as the licence requires. Asked for at 1280 px.
//
//   bestPicture(stops) → { url, credit: { artist, license, page, title } } | null

import { config } from "../config.js";
import { fetchJson } from "./http.js";
import { haversineM } from "./geo.js";

const WIDTH = 1280;
/** Bumped when the choice rules change; routes picked under an older version are re-picked at start-up. */
export const PICTURE_VERSION = 3;
// A whole town or neighbourhood article out-reads any single landmark in it, but a photo of "Culver City"
// says less than one of the place you'll stop at: those count for a fraction of their readers.
const AREA_CATEGORIES = new Set(["neighborhood", "district"]);
const AREA_WEIGHT = 0.25;
const looksLikeTown = (title) => /,\s*(California|Texas|Colorado|Nevada|Florida|New York|[A-Z][a-z]+ [A-Z][a-z]+)$/.test(title) && !/\b(park|museum|bridge|pier|beach|tower|cathedral|temple|church|palace|castle|market|station|theatre|theater|stadium|monument|memorial|house|hall|gardens?|zoo|aquarium|lighthouse|fort|mission)\b/i.test(title);
const SKIP_FILE = /\.(svg|gif|tiff?)$|(^|[\s_\-(.,])(map|locator|logo|flag|seal|coat[ _]of[ _]arms|emblem|diagram|plan|icon|signature|montage|collage|composite|drawing|illustration|engraving|lithograph|painting|sketch|plate|postcard|poster|book|walk)(?=[\s_\-).,]|$)/i; // photos only; file names use _ for spaces
const MAX_KM = { titled: 8, searched: 3 };
// several pictures in one file ("White House north and south sides", "day and night", "views"): any crop shows halves
const COMBINED = /(north|south|east|west|front|back|day|night|summer|winter|before|then|old)[ _-]+(and|&|vs\.?|to)[ _-]+(north|south|east|west|front|back|rear|day|night|summer|winter|after|now|new)|[ _-](sides|views|facades|faces|panels|composite|triptych|diptych|comparison)(?=[ _.-]|$)/i;

const api = (params) => {
  const u = new URL(config.wikiApiBase);
  u.search = new URLSearchParams({ format: "json", formatversion: "2", ...params }).toString();
  return u.toString();
};
/** Wikipedia busy or down: that's "try again later", never "this route has no picture". */
export class PictureLookupFailed extends Error {}
const busy = (status) => { if (status === 429 || status >= 500 || !status) throw new PictureLookupFailed(`Wikipedia answered ${status || "nothing"}`); };
const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

/** Wikipedia title for a stop without one: the top search hit for its name. */
async function titleFor(stop, get) {
  const q = [stop.name, String(stop.approxArea || "").split(",")[0]].filter(Boolean).join(" ");
  const { status, data } = await get(api({ action: "query", list: "search", srsearch: q, srlimit: "1" }));
  busy(status);
  return status === 200 ? data?.query?.search?.[0]?.title || null : null;
}

/** Score every candidate article: pageviews, lead image, and whether it's really at the stop. */
async function candidates(stops, get) {
  const wanted = [];
  for (const s of stops) {
    const title = s.wikipediaTitle || (await titleFor(s, get));
    if (title) wanted.push({ stop: s, title, searched: !s.wikipediaTitle });
  }
  if (!wanted.length) return [];
  const pages = new Map();
  for (let i = 0; i < wanted.length; i += 40) {
    const chunk = wanted.slice(i, i + 40);
    const { status, data } = await get(api({
      action: "query", titles: chunk.map((w) => w.title).join("|"), redirects: "1",
      prop: "pageimages|pageviews|coordinates", piprop: "name|thumbnail", pithumbsize: String(WIDTH), pvipdays: "30",
    }));
    busy(status);
    if (status !== 200) continue;
    const redirect = new Map((data?.query?.redirects || []).map((r) => [r.from, r.to]));
    const normal = new Map((data?.query?.normalized || []).map((r) => [r.from, r.to]));
    for (const p of data?.query?.pages || []) if (!p.missing) pages.set(p.title, p);
    for (const w of chunk) {
      let t = normal.get(w.title) || w.title;
      t = redirect.get(t) || t;
      w.page = pages.get(t) || null;
    }
  }
  const out = [];
  for (const w of wanted) {
    const p = w.page;
    if (!p?.pageimage || SKIP_FILE.test(p.pageimage) || COMBINED.test(p.pageimage)) continue;
    const c = p.coordinates?.[0];
    if (c && Number.isFinite(w.stop.lat) && haversineM({ lat: c.lat, lon: c.lon }, w.stop) > (w.searched ? MAX_KM.searched : MAX_KM.titled) * 1000) continue;
    if (w.searched && !c) continue; // a guessed article with no position could be anything
    const read = Object.values(p.pageviews || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    const area = AREA_CATEGORIES.has(w.stop.category) || looksLikeTown(p.title);
    out.push({ stop: w.stop, title: p.title, file: p.pageimage, thumb: p.thumbnail?.source || null, views: area ? read * AREA_WEIGHT : read });
  }
  return out.sort((a, b) => b.views - a.views);
}

/** Author, licence and a sized URL for a Commons file; null when it isn't freely licensed. */
async function fileInfo(file, get) {
  const { status, data } = await get(api({ action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: String(WIDTH) }));
  busy(status);
  if (status !== 200) return null;
  const ii = data?.query?.pages?.[0]?.imageinfo?.[0];
  const m = ii?.extmetadata || {};
  const license = stripHtml(m.LicenseShortName?.value);
  if (!ii || m.NonFree?.value === "true" || !license || /fair use|non-free/i.test(license)) return null;
  // old scans (pre-1930 dates, "public domain" artwork) are usually illustrations, not photographs
  const made = Number(String(stripHtml(m.DateTimeOriginal?.value)).match(/\b(1[5-9]\d\d)\b/)?.[1]);
  if (Number.isFinite(made) && made < 1930) return null;
  return {
    url: String(ii.thumburl || ii.url).split("?")[0],
    credit: { artist: stripHtml(m.Artist?.value).slice(0, 80) || "Unknown author", license, page: ii.descriptionurl || "" },
  };
}

/**
 * The best free picture, or null when the route really has none. Throws PictureLookupFailed when
 * Wikipedia is busy or unreachable, so callers can keep what they have and try again later.
 */
export async function bestPicture(stops = [], { get = fetchJson } = {}) {
  const list = (stops || []).filter((s) => s?.name);
  if (!list.length) return null;
  const wrap = async (fn) => { try { return await fn(); } catch (err) { throw err instanceof PictureLookupFailed ? err : new PictureLookupFailed(err.message); } };
  const cands = await wrap(() => candidates(list, get));
  for (const c of cands.slice(0, 4)) { // the most-read first; skip any whose photo isn't free to reuse
    const info = await wrap(() => fileInfo(c.file, get));
    if (info) return { url: info.url, credit: { ...info.credit, title: c.title, v: PICTURE_VERSION } };
  }
  return null;
}
