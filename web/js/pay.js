// Pay-per-route on the plan screen. Owner (passphrase) and servers without Stripe skip all of
// this. Otherwise: the Plan button shows the price for the current time window; pressing it
// opens a card with Stripe's Payment Element, the amount is held (not charged), planning runs,
// and the server captures the hold when the route is ready. The credit (an opaque token) lives
// in localStorage and unlocks re-plans, narration and publishing for that start/end.

import * as api from "./api.js";
import { setCreditToken } from "./config.js";
import { quote, routeSig, tierRank } from "./pricing.js";

const $ = (id) => document.getElementById(id);
const CREDIT_KEY = "tourguide.credit"; // { token, sig, tierId, label, plansLeft, status }
const PENDING_KEY = "tourguide.creditPending"; // token of an intent the bank redirected us away from

const info = { owner: null, enabled: null, publishableKey: null };
export const isOwner = () => info.owner === true;
export const enabled = () => info.enabled === true;

function credit() { try { return JSON.parse(localStorage.getItem(CREDIT_KEY) || "null"); } catch { return null; } }
function saveCredit(c) {
  try { c ? localStorage.setItem(CREDIT_KEY, JSON.stringify(c)) : localStorage.removeItem(CREDIT_KEY); } catch { /* ignore */ }
  setCreditToken(c?.token || "");
}

/** Learn whether this device is the owner and whether the server takes payments. */
export async function init() {
  const [who, q] = await Promise.all([api.whoami().catch(() => null), api.payQuote("09:00", "21:00").catch(() => null)]);
  info.owner = who?.tier === "subscriber";
  info.enabled = Boolean(q?.enabled);
  info.publishableKey = q?.publishableKey || null;
  if (credit()?.token) setCreditToken(credit().token);
  await handleReturn();
  return { ...info };
}

/** Back from a bank redirect (3-D Secure): finish the confirmation we started. */
async function handleReturn() {
  const params = new URLSearchParams(location.search);
  if (!params.get("payment_intent")) return;
  let pending = null;
  try { pending = localStorage.getItem(PENDING_KEY); localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  history.replaceState(null, "", location.pathname);
  if (!pending) return;
  try {
    const c = await api.payConfirm(pending);
    if (c.status === "authorized" || c.status === "captured") saveCredit({ token: pending, sig: c.routeSig, tierId: c.tierId, label: c.label, plansLeft: c.plansLeft, status: c.status });
  } catch { /* the credit check on the next plan will say what's wrong */ }
}

function usableFor(c, it) {
  if (!c?.token || !it.start || !it.end) return false;
  if (c.sig !== routeSig(it.start, it.end)) return false;
  if (c.plansLeft <= 0) return false;
  return tierRank(quote(it.arrivalTime, it.deadline).tierId) <= tierRank(c.tierId);
}

/** Plan button label + the line under it. Called on every render. */
export function renderPrice(it) {
  const btn = $("plan-btn"), line = $("price-line");
  if (!btn) return;
  if (info.owner || !info.enabled) { // the owner plans for free (owner mode: hold the logo, see ownerGesture.js)
    btn.textContent = "Plan my tour";
    if (line) line.hidden = true;
    return;
  }
  const q = quote(it.arrivalTime, it.deadline);
  const c = credit();
  if (usableFor(c, it)) {
    btn.textContent = "Plan my tour · paid";
    if (line) { line.hidden = false; line.textContent = `${c.label} route paid · ${c.plansLeft} plan${c.plansLeft === 1 ? "" : "s"} left for this start and end · narration and publishing included`; }
  } else {
    btn.textContent = `Plan my tour · ${q.price}`;
    if (line) { line.hidden = false; line.textContent = `${q.label} (${q.blurb}) · ${q.price}, charged when you press Plan · cancelled automatically if planning fails`; }
  }
}

/** Ask the server for the truth about the stored credit and refresh the label. */
export async function refresh(it) {
  const c = credit();
  if (!c?.token || info.owner || !info.enabled) return renderPrice(it);
  try {
    const s = await api.payCredit({ start: it.start, end: it.end, arrivalTime: it.arrivalTime, deadline: it.deadline });
    if (s?.credit) saveCredit({ ...c, sig: s.credit.routeSig, tierId: s.credit.tierId, label: s.credit.label, plansLeft: s.credit.plansLeft, status: s.credit.status });
  } catch { /* keep what we have */ }
  renderPrice(it);
}

/**
 * Make sure planning this itinerary is paid for. Resolves when it is (or when no payment is
 * needed); rejects with `.cancelled` if the user backs out.
 */
export async function ensureCredit(it) {
  if (info.owner || !info.enabled) return null;
  const c = credit();
  if (c?.token) {
    const s = await api.payCredit({ start: it.start, end: it.end, arrivalTime: it.arrivalTime, deadline: it.deadline }).catch(() => null);
    if (s?.usable) { saveCredit({ ...c, sig: s.credit.routeSig, tierId: s.credit.tierId, label: s.credit.label, plansLeft: s.credit.plansLeft, status: s.credit.status }); return c.token; }
  }
  return payDialog(it);
}

/** Run `fn` with a valid credit; if the server still says "pay", pay and run once more. */
export async function withCredit(it, fn) {
  await ensureCredit(it);
  try {
    return await fn();
  } catch (err) {
    if (!err?.needsPayment || info.owner) throw err;
    saveCredit(null);
    await payDialog(it, err.message);
    return fn();
  }
}

// ---------- Stripe.js + the payment card ----------

function note(msg, ms = 4000) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => (el.hidden = true), ms);
}

let stripeJs = null;
function loadStripeJs() {
  if (stripeJs) return stripeJs;
  stripeJs = new Promise((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe);
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error("Stripe.js didn't load")));
    s.onerror = () => reject(new Error("Couldn't load the payment form. Check your connection and try again."));
    document.head.appendChild(s);
  });
  return stripeJs;
}

function payDialog(it, reason = "") {
  const q = quote(it.arrivalTime, it.deadline);
  return new Promise(async (resolve, reject) => {
    const dlg = document.createElement("dialog");
    dlg.className = "pay";
    dlg.innerHTML = `
      <form method="dialog">
        <h2>Pay for this route</h2>
        <div class="pay-quote"><span class="pay-tier"></span><b class="pay-price"></b></div>
        <p class="pay-reason" hidden></p>
        <ul class="pay-includes">
          <li>Deodap plans the day around your interests, up to 3 times for this start and end</li>
          <li>Spoken narration for every stop and the road between</li>
        </ul>
        <p class="pay-hold">${q.price} is charged when you press Pay. If planning fails for any reason, the charge is cancelled automatically.</p>
        <div class="pay-element"><div class="pay-loading">Loading secure payment form…</div></div>
        <label class="pay-email">Email for a receipt (optional)<input type="email" name="receipt" autocomplete="email" placeholder="you@example.com" /></label>
        <p class="pay-error" role="alert" hidden></p>
        <div class="actions"><button type="button" class="cancel">Cancel</button><button type="submit" class="primary" disabled>Pay ${q.price} and plan my tour</button></div>
        <p class="pay-fine">Payments are handled by Stripe. Deodapper keeps a payment reference only, never your card or contact details. <a href="terms.html" target="_blank" rel="noopener">Terms &amp; refunds</a> · <a href="privacy.html" target="_blank" rel="noopener">Privacy</a></p>
      </form>`;
    dlg.querySelector(".pay-tier").textContent = `${q.label} · ${q.blurb}`;
    dlg.querySelector(".pay-price").textContent = q.price;
    if (reason) { const r = dlg.querySelector(".pay-reason"); r.textContent = reason; r.hidden = false; }
    const errBox = dlg.querySelector(".pay-error");
    const showErr = (m) => { errBox.textContent = m; errBox.hidden = !m; };
    const submit = dlg.querySelector(".primary");
    document.body.appendChild(dlg);
    dlg.showModal();

    let token = null, intentMade = false, settled = false;
    const finish = (fn) => { if (settled) return; settled = true; dlg.close(); dlg.remove(); fn(); };
    const cancel = () => {
      if (intentMade && token) api.payRelease(token).catch(() => {});
      finish(() => { const e = new Error("Payment cancelled."); e.cancelled = true; reject(e); });
    };
    dlg.querySelector(".cancel").addEventListener("click", cancel);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); cancel(); }); // Escape

    let stripe, elements;
    try {
      const [Stripe, intent] = await Promise.all([loadStripeJs(), api.payIntent({ start: it.start, end: it.end, arrivalTime: it.arrivalTime, deadline: it.deadline })]);
      token = intent.token; intentMade = true;
      stripe = Stripe(info.publishableKey);
      elements = stripe.elements({ clientSecret: intent.clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#1f5f8b", borderRadius: "10px" } } });
      const el = elements.create("payment", { layout: "tabs", terms: { card: "never" } });
      dlg.querySelector(".pay-element").innerHTML = "";
      el.mount(dlg.querySelector(".pay-element"));
      el.on("ready", () => { submit.disabled = false; });
      el.on("change", (e) => showErr(e.error?.message || ""));
    } catch (err) {
      dlg.querySelector(".pay-element").innerHTML = "";
      showErr(err.message);
      return;
    }

    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true; submit.textContent = "Paying…"; showErr("");
      const receiptEmail = dlg.querySelector('input[name="receipt"]').value.trim();
      try { localStorage.setItem(PENDING_KEY, token); } catch { /* ignore */ }
      const { error } = await stripe.confirmPayment({ elements, redirect: "if_required", confirmParams: { return_url: location.origin + location.pathname } });
      if (error) {
        showErr(error.message || "The payment didn't go through.");
        submit.disabled = false; submit.textContent = `Pay ${q.price} and plan my tour`;
        return;
      }
      try {
        const c = await api.payConfirm(token, receiptEmail);
        try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
        if (c.status !== "authorized" && c.status !== "captured") throw new Error("Your bank hasn't confirmed the payment yet. Give it a moment and press Plan again.");
        saveCredit({ token, sig: c.routeSig, tierId: c.tierId, label: c.label, plansLeft: c.plansLeft, status: c.status });
        note(`Payment of ${q.price} accepted${receiptEmail ? `; receipt to ${receiptEmail}` : ""}.${c.signInSent ? " We also emailed you a sign-in link so this route stays in your account on any device." : ""} Planning your route…`, 8000);
        finish(() => resolve(token));
      } catch (err) {
        showErr(err.message);
        submit.disabled = false; submit.textContent = `Pay ${q.price} and plan my tour`;
      }
    });
  });
}

export { credit as storedCredit };
