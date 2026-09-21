// Route pricing, shared by server and client. One fee per route; the tier follows the time
// window (start → be-there-by), because the number of stops, and so the Claude cost, does.
// A credit is bound to a start/end pair (rounded to ~1 km) and covers PLANS_PER_CREDIT plans
// (the first plus re-plans), edits, narration and publishing for that route.

import { toMinutes } from "./format.js";

export const TIERS = [
  { id: "short", label: "Short outing", blurb: "up to 3 hours", maxMinutes: 180, cents: 199 },
  { id: "half", label: "Half day", blurb: "3 to 6 hours", maxMinutes: 360, cents: 299 },
  { id: "full", label: "Full day", blurb: "over 6 hours", maxMinutes: Infinity, cents: 449 },
];
export const PLANS_PER_CREDIT = 3;
export const CURRENCY = "usd";

export const fmtPrice = (cents) => `$${(cents / 100).toFixed(2)}`;
export const tierById = (id) => TIERS.find((t) => t.id === id) || null;
export const tierRank = (id) => TIERS.findIndex((t) => t.id === id);

/** Minutes between start and deadline (0 when missing or inverted). */
export function windowMinutes(arrivalTime, deadline) {
  if (!/^\d{2}:\d{2}$/.test(arrivalTime || "") || !/^\d{2}:\d{2}$/.test(deadline || "")) return 0;
  return Math.max(0, toMinutes(deadline) - toMinutes(arrivalTime));
}

/** The tier and price for a time window. */
export function quote(arrivalTime, deadline) {
  const minutes = windowMinutes(arrivalTime, deadline);
  const tier = TIERS.find((t) => minutes <= t.maxMinutes) || TIERS[TIERS.length - 1];
  return { tierId: tier.id, label: tier.label, blurb: tier.blurb, cents: tier.cents, price: fmtPrice(tier.cents), currency: CURRENCY, minutes };
}

/** Start/end identity a credit is bound to: coordinates rounded to 0.01° (about 1 km). */
export function routeSig(start, end) {
  const r = (n) => (Number.isFinite(n) ? n.toFixed(2) : "?");
  return `${r(start?.lat)},${r(start?.lon)}|${r(end?.lat)},${r(end?.lon)}`;
}
