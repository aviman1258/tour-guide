import { test } from "node:test";
import assert from "node:assert/strict";
import { createPay, AUTH_TTL_MS } from "../server/lib/pay.js";

/** A fake Stripe: PaymentIntents live in a Map and move through the real statuses. */
function fakeStripe() {
  const pis = new Map();
  let n = 0;
  const calls = [];
  return {
    pis, calls,
    paymentIntents: {
      async create(p) { const pi = { id: `pi_${++n}`, object: "payment_intent", client_secret: `pi_${n}_secret`, status: "requires_payment_method", ...p }; pis.set(pi.id, pi); calls.push(["create", pi.id]); return pi; },
      async retrieve(id) { calls.push(["retrieve", id]); return pis.get(id); },
      async capture(id) { calls.push(["capture", id]); const pi = pis.get(id); if (pi.status !== "requires_capture") throw new Error(`cannot capture ${pi.status}`); pi.status = "succeeded"; return pi; },
      async cancel(id) { calls.push(["cancel", id]); const pi = pis.get(id); pi.status = "canceled"; return pi; },
    },
    webhooks: { constructEvent(raw) { return JSON.parse(raw); } },
    /** the browser confirmed the card */
    authorize(id) { pis.get(id).status = "requires_capture"; },
  };
}

const START = { lat: 29.9902, lon: -95.3368 }, END = { lat: 29.7395, lon: -95.4633 };
const ROUTE = { start: START, end: END, arrivalTime: "09:00", deadline: "14:00" }; // half day

function setup() {
  let t = Date.parse("2026-09-21T12:00:00Z");
  const stripe = fakeStripe();
  const pay = createPay({ stripe, file: ":memory:", now: () => t });
  return { stripe, pay, advance: (ms) => { t += ms; } };
}

test("intent → authorize → verify → first plan captures → re-plans free → allowance runs out", async () => {
  const { stripe, pay } = setup();
  const { token, clientSecret, quote, credit } = await pay.createIntent(ROUTE);
  assert.equal(quote.tierId, "half");
  assert.match(clientSecret, /_secret$/);
  assert.equal(credit.status, "pending");
  assert.throws(() => pay.verify(token, { ...ROUTE, forPlan: true }), /hasn't gone through/);

  stripe.authorize(stripe.calls[0][1]);
  assert.equal((await pay.confirm(token)).status, "authorized");
  const row = pay.verify(token, { ...ROUTE, forPlan: true });
  assert.equal(row.status, "authorized");

  const after = await pay.consume(row);
  assert.equal(after.status, "captured");
  assert.equal(after.plansLeft, 2);
  assert.ok(stripe.calls.some((c) => c[0] === "capture"));

  // two re-plans are free, the fourth plan is refused
  await pay.consume(pay.verify(token, { ...ROUTE, forPlan: true }));
  await pay.consume(pay.verify(token, { ...ROUTE, forPlan: true }));
  assert.equal(pay.status(token).plansLeft, 0);
  assert.throws(() => pay.verify(token, { ...ROUTE, forPlan: true }), (e) => e.status === 402 && e.needsPayment && /used all 3 plans/.test(e.message));
  // but narration / publishing for the route still work
  assert.ok(pay.verify(token, { start: START, end: END }));
  assert.equal(stripe.calls.filter((c) => c[0] === "capture").length, 1, "captured once");
});

test("a credit is bound to its start/end and to the tier paid for", async () => {
  const { stripe, pay } = setup();
  const { token } = await pay.createIntent(ROUTE);
  stripe.authorize(stripe.calls[0][1]);
  await pay.confirm(token);
  assert.throws(() => pay.verify(token, { start: START, end: { lat: 30.5, lon: -95.4 }, forPlan: true }), /different start and end/);
  assert.throws(() => pay.verify(token, { ...ROUTE, deadline: "21:00", forPlan: true }), /Full day route .* paid for a Half day/);
  assert.ok(pay.verify(token, { ...ROUTE, deadline: "11:00", forPlan: true }), "a shorter day is fine");
  assert.ok(pay.verify(token, { start: { lat: 29.993, lon: -95.339 }, end: END, forPlan: true }), "a few hundred metres of drift is the same route");
});

test("release cancels an unused hold; a used credit can't be released", async () => {
  const { stripe, pay } = setup();
  const { token } = await pay.createIntent(ROUTE);
  stripe.authorize(stripe.calls[0][1]);
  await pay.confirm(token);
  assert.equal((await pay.release(token)).status, "canceled");
  assert.ok(stripe.calls.some((c) => c[0] === "cancel"));
  assert.throws(() => pay.verify(token, ROUTE), /released/);

  const second = await pay.createIntent(ROUTE);
  stripe.authorize(stripe.calls.filter((c) => c[0] === "create")[1][1]);
  await pay.confirm(second.token);
  await pay.consume(pay.verify(second.token, { ...ROUTE, forPlan: true }));
  assert.equal((await pay.release(second.token)).status, "captured", "money already taken for a delivered plan stays taken");
});

test("the sweep releases holds before Stripe would let them lapse", async () => {
  const { stripe, pay, advance } = setup();
  const { token } = await pay.createIntent(ROUTE);
  stripe.authorize(stripe.calls[0][1]);
  await pay.confirm(token);
  assert.equal(await pay.sweep(), 0);
  advance(AUTH_TTL_MS + 1000);
  assert.throws(() => pay.verify(token, ROUTE), /hold has expired/);
  assert.equal(await pay.sweep(), 1);
  assert.equal(pay.status(token).status, "canceled");
});

test("webhook events mirror the PaymentIntent onto the credit", async () => {
  const { stripe, pay } = setup();
  const { token } = await pay.createIntent(ROUTE);
  const piId = stripe.calls[0][1];
  // config.stripe.webhookSecret is empty in tests: the fake constructEvent ignores it, so stub the check
  const ev = (status, type) => JSON.stringify({ type, data: { object: { object: "payment_intent", id: piId, status } } });
  const { config } = await import("../server/config.js");
  config.stripe.webhookSecret = "whsec_test";
  assert.deepEqual(pay.handleWebhook(ev("requires_capture", "payment_intent.amount_capturable_updated"), "sig"), { type: "payment_intent.amount_capturable_updated", credit: pay.status(token).id });
  assert.equal(pay.status(token).status, "authorized");
  pay.handleWebhook(ev("succeeded", "payment_intent.succeeded"), "sig");
  assert.equal(pay.status(token).status, "captured");
  pay.handleWebhook(ev("canceled", "payment_intent.canceled"), "sig");
  assert.equal(pay.status(token).status, "canceled");
  assert.equal(pay.handleWebhook(JSON.stringify({ type: "charge.refunded", data: { object: { object: "charge", id: "ch_1" } } }), "sig").credit, null);
});

test("sales summary counts intents, captures and revenue", async () => {
  const { stripe, pay } = setup();
  const a = await pay.createIntent(ROUTE);
  const b = await pay.createIntent({ ...ROUTE, deadline: "21:00" });
  stripe.authorize(stripe.calls.filter((c) => c[0] === "create")[0][1]);
  await pay.confirm(a.token);
  await pay.consume(pay.verify(a.token, { ...ROUTE, forPlan: true }));
  const s = pay.sales(30);
  assert.equal(s.totals.intents, 2);
  assert.equal(s.totals.captured, 1);
  assert.equal(s.totals.revenueCents, 299);
  assert.equal(s.totals.pending, 1);
  assert.equal(s.byTier.find((t) => t.tier === "half").revenueCents, 299);
  void b;
});

test("payments off: intent refuses cleanly", async () => {
  const pay = createPay({ stripe: null, file: ":memory:" });
  assert.equal(pay.enabled(), false);
  await assert.rejects(() => pay.createIntent(ROUTE), /aren't set up/);
});

test("a refund or a dispute from Stripe closes the credit", async () => {
  const { stripe, pay } = setup();
  const { config } = await import("../server/config.js");
  config.stripe.webhookSecret = "whsec_test";
  const { token } = await pay.createIntent(ROUTE);
  const piId = stripe.calls[0][1];
  stripe.authorize(piId);
  await pay.confirm(token);
  await pay.consume(pay.verify(token, { ...ROUTE, forPlan: true }));
  assert.equal(pay.status(token).status, "captured");
  const r = pay.handleWebhook(JSON.stringify({ type: "charge.refunded", data: { object: { object: "charge", id: "ch_1", payment_intent: piId, refunded: true, amount_refunded: 299 } } }), "sig");
  assert.equal(r.credit, pay.status(token).id);
  assert.equal(pay.status(token).status, "refunded");
  assert.throws(() => pay.verify(token, ROUTE), /refunded/);
  assert.equal(pay.sales(30).totals.refunded, 1);
  assert.equal(pay.sales(30).totals.refundedCents, 299);

  const second = await pay.createIntent(ROUTE);
  const pi2 = stripe.calls.filter((c) => c[0] === "create")[1][1];
  stripe.authorize(pi2);
  await pay.confirm(second.token);
  pay.handleWebhook(JSON.stringify({ type: "charge.dispute.created", data: { object: { object: "dispute", id: "dp_1", payment_intent: pi2, reason: "fraudulent" } } }), "sig");
  assert.equal(pay.status(second.token).status, "disputed");
  assert.throws(() => pay.verify(second.token, ROUTE), /dispute/);
});

test("per-credit quotas: 3 narration preps and 10 suggestions, counted only on success", async () => {
  const { stripe, pay } = setup();
  const { token } = await pay.createIntent(ROUTE);
  stripe.authorize(stripe.calls[0][1]);
  await pay.confirm(token);
  for (let i = 0; i < 3; i++) pay.consumeQuota(pay.verify(token, { ...ROUTE, kind: "prepare" }), "prepare");
  assert.equal(pay.status(token).prepsLeft, 0);
  assert.throws(() => pay.verify(token, { ...ROUTE, kind: "prepare" }), (e) => e.status === 402 && /3 times already/.test(e.message));
  for (let i = 0; i < 10; i++) pay.consumeQuota(pay.verify(token, { ...ROUTE, kind: "suggest" }), "suggest");
  assert.throws(() => pay.verify(token, { ...ROUTE, kind: "suggest" }), /10 times/);
  // plans and publishing are separate allowances, untouched
  assert.equal(pay.status(token).plansLeft, 3);
  assert.ok(pay.verify(token, { ...ROUTE, kind: "plan" }));
  assert.ok(pay.verify(token, { ...ROUTE, kind: "publish" }));
  // the old forPlan spelling still means kind "plan"
  assert.ok(pay.verify(token, { ...ROUTE, forPlan: true }));
});
