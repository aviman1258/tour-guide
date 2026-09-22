// Shape a route's public listing (title + description). Claude drafts it; this module keeps it
// within the limits the library enforces, strips decoration, runs the content filter, and falls
// back to a plain generated listing when the draft is unusable. Pure, so it is unit-tested.

import { check } from "./moderation.js";

export const TITLE_MAX = 80;
export const DESC_MAX = 500;

const cleanLine = (s) => String(s || "").replace(/\s+/g, " ").replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").replace(/[!]+/g, ".").trim();

/** A serviceable listing from the itinerary alone, when Claude is unavailable or its draft failed. */
export function fallbackListing(it, region = "") {
  const city = (region || "").split(",")[0].trim() || (it.end?.label || it.start?.label || "").split(",")[0].trim();
  const names = (it.stops || []).map((s) => String(s.name || "").split(",")[0].trim()).filter(Boolean);
  const highlights = names.slice(0, 3).join(", ");
  let title = [city, highlights].filter(Boolean).join(": ");
  if (title.length > TITLE_MAX) title = [city, names.slice(0, 2).join(", ")].filter(Boolean).join(": ").slice(0, TITLE_MAX);
  const from = String(it.start?.label || "").split("(")[0].trim(), to = String(it.end?.label || "").split("(")[0].trim();
  const description = `${names.length} stops from ${from || "the start"} to ${to || "the end"}${highlights ? `: ${highlights}${names.length > 3 ? " and more" : ""}` : ""}. Narrated as you drive.`.slice(0, DESC_MAX);
  return { title: title || "A self-guided drive", description, source: "fallback" };
}

/**
 * Tidy a drafted listing. Returns { title, description, source: "claude" } when the draft is
 * usable, otherwise the fallback (so the caller always gets something publishable).
 */
export function shapeListing(draft, it, region = "") {
  const fb = fallbackListing(it, region);
  let title = cleanLine(draft?.title).replace(/\.$/, "");
  let description = cleanLine(draft?.description);
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX).replace(/[\s,;:–-]+\S*$/, "").trim();
  if (description.length > DESC_MAX) description = description.slice(0, DESC_MAX).replace(/\s+\S*$/, "").trim() + "…";
  const titleOk = title.length >= 4 && !check(title);
  const descOk = description.length >= 20 && !check(description);
  if (!titleOk && !descOk) return fb;
  return { title: titleOk ? title : fb.title, description: descOk ? description : fb.description, source: titleOk && descOk ? "claude" : "mixed" };
}
