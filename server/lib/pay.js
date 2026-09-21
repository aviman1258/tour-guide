// Pay-per-route credits backed by Stripe PaymentIntents with manual capture.
//
//   intent  → the browser gets a client secret; Stripe holds the amount when the card is confirmed
//   authorized (requires_capture) → the credit unlocks planning; nothing has been charged yet
//   captured → captured the moment the first plan succeeds; the credit keeps unlocking re-plans,
//              narration and publishing for that start/end for USE_TTL
//   canceled → released by the user, by the sweep (hold about to expire), or by Stripe
//
// We store a credit id, a hash of the browser token, the PaymentIntent id, tier, status and
// timestamps. No card data, names or emails: Stripe holds those.

import Stripe from "stripe";
import path from "node:path";
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { httpError } from "./http.js";
import { PLANS_PER_CREDIT, CURRENCY, quote, routeSig, tierById, tierRank, fmtPrice } from "../../web/js/pricing.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const FILE = path.join(DIR, "deodapper.db");
export const AUTH_TTL_MS = 6 * 86400_000; // Stripe releases uncaptured holds after 7 days; we cancel a day early
export const USE_TTL_MS = 30 * 86400_000; // a captured credit keeps unlocking its route for a month

function payError(status, message) {
  const e = httpError(status, message);
  e.needsPayment = true;
  return e;
}

/**
 * createPay({ stripe, file, now }) — `stripe` is a Stripe client (or null = payments off);
 * tests pass a fake and file ":memory:".
 */
export function createPay({ stripe = null, file = FILE, now = () => Date.now() } = {}) {
  let db = null;
  function open() {
    if (db) return db;
    if (file !== ":memory:") fs.mkdirSync(DIR, { recursive: true });
    db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS credits (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL,
        cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        pi_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        route_sig TEXT NOT NULL,
        plans_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        authorized_at TEXT,
        captured_at TEXT,
        canceled_at TEXT,
        expires_at TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS credits_status ON credits(status, expires_at);
    `);
    return db;
  }
  const iso = (ms = now()) => new Date(ms).toISOString();
  const hash = (token) => createHash("sha256").update(String(token)).digest("hex");
  const enabled = () => Boolean(stripe);

  const find = (token) => (token ? open().prepare(`SELECT * FROM credits WHERE token_hash = ?`).get(hash(token)) || null : null);
  const byPi = (piId) => open().prepare(`SELECT * FROM credits WHERE pi_id = ?`).get(piId) || null;
  function save(row) {
    // node:sqlite rejects named parameters the statement doesn't use, so pass exactly these
    const { id, status, plans_used, authorized_at, captured_at, canceled_at, expires_at, last_error } = row;
    open().prepare(`UPDATE credits SET status = @status, plans_used = @plans_used, authorized_at = @authorized_at, captured_at = @captured_at,
      canceled_at = @canceled_at, expires_at = @expires_at, last_error = @last_error WHERE id = @id`)
      .run({ id, status, plans_used, authorized_at: authorized_at ?? null, captured_at: captured_at ?? null, canceled_at: canceled_at ?? null, expires_at, last_error: last_error ?? null });
    return row;
  }
  /** What the browser may know about a credit. */
  function view(row) {
    const t = tierById(row.tier);
    return {
      id: row.id, status: row.status, tierId: row.tier, label: t?.label || row.tier, price: fmtPrice(row.cents),
      plansUsed: row.plans_used, plansLeft: Math.max(0, PLANS_PER_CREDIT - row.plans_used), expiresAt: row.expires_at, routeSig: row.route_sig,
    };
  }

  /** Mirror a PaymentIntent's state onto the credit (used by confirm and the webhook). */
  function applyPi(row, pi) {
    if (pi.status === "requires_capture" && row.status === "pending") {
      row.status = "authorized"; row.authorized_at = iso(); row.expires_at = iso(now() + AUTH_TTL_MS);
    } else if (pi.status === "succeeded" && row.status !== "captured") {
      row.status = "captured"; row.captured_at = iso(); row.expires_at = iso(now() + USE_TTL_MS);
    } else if (pi.status === "canceled" && row.status !== "canceled") {
      row.status = "canceled"; row.canceled_at = iso();
    }
    return save(row);
  }

  /** Step 1: a PaymentIntent (manual capture) and a pending credit for this start/end + window. */
  async function createIntent({ start, end, arrivalTime, deadline, ip = "" }) {
    if (!stripe) throw httpError(503, "Payments aren't set up on this server yet.");
    for (const [k, p] of [["start", start], ["end", end]]) if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) throw httpError(400, `${k} needs lat/lon`);
    const q = quote(arrivalTime, deadline);
    if (!q.minutes) throw httpError(400, "The end time must be after the start time.");
    const id = "c_" + randomBytes(6).toString("hex");
    const token = randomBytes(24).toString("base64url");
    const pi = await stripe.paymentIntents.create({
      amount: q.cents, currency: CURRENCY, capture_method: "manual",
      automatic_payment_methods: { enabled: true },
      description: `Deodapper · ${q.label} route`,
      metadata: { credit: id, tier: q.tierId },
    });
    const row = {
      id, token_hash: hash(token), tier: q.tierId, cents: q.cents, currency: CURRENCY, pi_id: pi.id, status: "pending",
      route_sig: routeSig(start, end), plans_used: 0, created_at: iso(), authorized_at: null, captured_at: null, canceled_at: null,
      expires_at: iso(now() + AUTH_TTL_MS), ip: String(ip || "").slice(0, 64), last_error: null,
    };
    open().prepare(`INSERT INTO credits (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((k) => "@" + k).join(",")})`).run(row);
    return { token, clientSecret: pi.client_secret, quote: q, credit: view(row) };
  }

  /** Step 2 (after the browser confirmed the card): read the PaymentIntent back and update the credit. */
  async function confirm(token) {
    const row = find(token);
    if (!row) throw httpError(404, "unknown credit");
    if (!stripe) throw httpError(503, "Payments aren't set up on this server yet.");
    const pi = await stripe.paymentIntents.retrieve(row.pi_id);
    return view(applyPi(row, pi));
  }

  /**
   * Is this credit good for this request? Throws a 402 with `needsPayment` otherwise.
   * `forPlan` also checks the plan allowance and that the day hasn't grown past the tier paid for.
   */
  function verify(token, { start, end, arrivalTime, deadline, forPlan = false } = {}) {
    const row = find(token);
    if (!row) throw payError(402, "This route needs a payment first.");
    if (row.status === "pending") throw payError(402, "Your payment hasn't gone through yet.");
    if (row.status === "canceled" || row.status === "failed") throw payError(402, "That payment was released. Pay again to plan this route.");
    if (Date.parse(row.expires_at) < now()) throw payError(402, row.status === "authorized" ? "That payment hold has expired. Pay again to plan." : "That route credit has expired.");
    if (start && end && routeSig(start, end) !== row.route_sig) throw payError(402, "That payment was for a different start and end. A new route needs its own payment.");
    if (forPlan) {
      if (row.plans_used >= PLANS_PER_CREDIT) throw payError(402, `You've used all ${PLANS_PER_CREDIT} plans for this route. Pay again to plan it afresh.`);
      if (arrivalTime && deadline) {
        const q = quote(arrivalTime, deadline);
        if (tierRank(q.tierId) > tierRank(row.tier)) throw payError(402, `With these times this is a ${q.label} route (${q.price}) and you paid for a ${tierById(row.tier)?.label}. Shorten the day, or pay for the longer route.`);
      }
    }
    return row;
  }

  /** A plan succeeded: count it and, the first time, capture the hold. Never throws. */
  async function consume(row) {
    row.plans_used += 1;
    if (row.status === "authorized" && stripe) {
      try {
        const pi = await stripe.paymentIntents.capture(row.pi_id);
        if (pi.status === "succeeded") { row.status = "captured"; row.captured_at = iso(); row.expires_at = iso(now() + USE_TTL_MS); }
        else row.last_error = `capture returned ${pi.status}`;
      } catch (err) {
        row.last_error = `capture: ${err.message}`.slice(0, 300);
        console.warn(`[pay] capture failed for ${row.id}: ${err.message}`);
      }
    }
    return view(save(row));
  }

  /** The user backed out before planning: cancel the hold. */
  async function release(token) {
    const row = find(token);
    if (!row) throw httpError(404, "unknown credit");
    if ((row.status === "authorized" && row.plans_used === 0) || row.status === "pending") {
      try { if (stripe) await stripe.paymentIntents.cancel(row.pi_id); } catch (err) { row.last_error = `cancel: ${err.message}`.slice(0, 300); }
      row.status = "canceled"; row.canceled_at = iso();
      save(row);
    }
    return view(row);
  }

  const status = (token) => { const row = find(token); return row ? view(row) : null; };

  /** Stripe → us. Verifies the signature, mirrors the PaymentIntent state. Returns what happened. */
  function handleWebhook(rawBody, signature) {
    if (!stripe) throw httpError(503, "payments off");
    if (!config.stripe.webhookSecret) throw httpError(503, "STRIPE_WEBHOOK_SECRET is not set");
    const event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    const pi = event.data?.object;
    const row = pi?.object === "payment_intent" ? byPi(pi.id) : null;
    if (row) applyPi(row, pi);
    return { type: event.type, credit: row ? row.id : null };
  }

  /** Release holds that are about to lapse on Stripe's side. Returns how many. */
  async function sweep() {
    const rows = open().prepare(`SELECT * FROM credits WHERE status IN ('authorized', 'pending') AND expires_at < ?`).all(iso());
    for (const row of rows) {
      try { if (stripe) await stripe.paymentIntents.cancel(row.pi_id); } catch (err) { row.last_error = `sweep: ${err.message}`.slice(0, 300); }
      row.status = "canceled"; row.canceled_at = iso();
      save(row);
    }
    return rows.length;
  }

  /** Admin: purchases and revenue in the window. */
  function sales(days = 30) {
    const d = open();
    const since = iso(now() - days * 86400_000);
    const rows = d.prepare(`SELECT * FROM credits WHERE created_at >= ?`).all(since);
    const by = (f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
    const captured = rows.filter((r) => r.status === "captured");
    return {
      days, since,
      totals: {
        intents: rows.length, captured: captured.length, revenueCents: captured.reduce((a, r) => a + r.cents, 0),
        holdsOpen: rows.filter((r) => r.status === "authorized").length, released: rows.filter((r) => r.status === "canceled").length,
        pending: rows.filter((r) => r.status === "pending").length, plansDelivered: rows.reduce((a, r) => a + r.plans_used, 0),
      },
      byTier: Object.entries(by((r) => r.tier)).map(([tier, n]) => ({ tier, label: tierById(tier)?.label || tier, intents: n, captured: captured.filter((r) => r.tier === tier).length, revenueCents: captured.filter((r) => r.tier === tier).reduce((a, r) => a + r.cents, 0) })),
      recent: rows.sort((a, b) => (b.created_at > a.created_at ? 1 : -1)).slice(0, 25).map((r) => ({ ...view(r), createdAt: r.created_at, capturedAt: r.captured_at, lastError: r.last_error })),
    };
  }

  return { enabled, createIntent, confirm, verify, consume, release, status, handleWebhook, sweep, sales, view };
}

const stripeClient = config.stripe.secretKey ? new Stripe(config.stripe.secretKey, { appInfo: { name: "Deodapper", url: "https://deodapper.com" } }) : null;
export default createPay({ stripe: stripeClient });
