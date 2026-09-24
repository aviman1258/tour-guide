// Fetch a place's own web page and reduce it to plain text for grounding narration. Small,
// defensive: http(s) only, no private hosts (SSRF guard), 8 s timeout, 1.5 MB cap, scripts,
// styles, navigation and footers dropped, whitespace collapsed, output capped. Size cap 6 MB.

import dns from "node:dns/promises";
import { config } from "../config.js";

const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

/** Reject anything that isn't a public http(s) URL. Resolves DNS to catch private targets. */
export async function isSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (PRIVATE.test(host)) return false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => PRIVATE.test(a.address))) return false;
  } catch { return false; }
  return true;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", "#160": " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp|#160|ldquo|rdquo|lsquo|rsquo|hellip|mdash|ndash|copy|reg|trade|middot|bull);/g, (m, e) => ENT[e])
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));

/** HTML → { title, description, text }. Pure, so it is unit-tested. */
export function htmlToText(html, { maxChars = 2000 } = {}) {
  let h = String(html || "");
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] || "").replace(/\s+/g, " ").trim());
  const description = decode((/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(h)?.[1] || /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(h)?.[1] || "").trim());
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  h = h.replace(/<(script|style|noscript|svg|iframe|nav|footer|header|aside|form|button|select)[\s\S]*?<\/\1>/gi, " ");
  // prefer the main content region when the page marks one
  const main = /<(main|article)[\s>][\s\S]*?<\/\1>/i.exec(h);
  if (main && main[0].replace(/<[^>]+>/g, "").trim().length > 300) h = main[0];
  h = h.replace(/<(br|p|div|li|h[1-6]|tr|section|blockquote)[^>]*>/gi, "\n");
  const text = decode(h.replace(/<[^>]+>/g, " "))
    .split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 40 && !/^(cookie|accept|subscribe|sign in|log in|menu|skip to)/i.test(l)) // skip chrome
    .filter((l, i, arr) => arr.indexOf(l) === i)
    .join("\n");
  return { title, description, text: text.length > maxChars ? text.slice(0, maxChars).replace(/\s+\S*$/, "") + "…" : text };
}

/** Fetch and reduce. Resolves to { url, title, description, text } or null (never throws). */
export async function fetchPageText(url, { maxChars = 2000, timeoutMs = 8000, fetchImpl = globalThis.fetch, safe = isSafeUrl } = {}) {
  try {
    if (!(await safe(url))) return null;
    const r = await fetchImpl(url, { headers: { "User-Agent": config.userAgent, Accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout?.(timeoutMs) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "";
    if (type && !/html|xml|text\/plain/i.test(type)) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 6_000_000) return null; // site-builder pages run to 2 MB of markup; the text extractor copes
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const out = htmlToText(html, { maxChars });
    if (!out.text && !out.description) return null;
    return { url: r.url || url, ...out };
  } catch {
    return null;
  }
}
