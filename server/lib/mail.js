// Outbound email, only for sign-in links. Resend's HTTP API (RESEND_API_KEY, MAIL_FROM). With no
// key the server can't send; in development the link is handed back to the page instead.

import { config } from "../config.js";

const ENDPOINT = "https://api.resend.com/emails";
let lastError = null;
let sent = 0;

export const enabled = () => Boolean(config.mail.resendKey && config.mail.from);
export const stats = () => ({ enabled: enabled(), from: enabled() ? config.mail.from : null, sent, lastError });

/** The sign-in email. `purchase` = sent right after paying for a route. */
export function loginEmail({ link, purchase = false }) {
  const subject = purchase ? "Your Deodapper route, and a link to keep it" : "Your Deodapper sign-in link";
  const intro = purchase
    ? "Thanks for your purchase. Tap the link below to sign in on this device; your route is then kept in your account and follows you to any phone or laptop you sign in on."
    : "Tap the link below to sign in to Deodapper. Your saved routes follow you to any device you sign in on.";
  const text = `${intro}\n\n${link}\n\nThe link works once and expires in 20 minutes. If you didn't ask for it, ignore this email; nothing happens without the link.\n\nDeodapper · support@deodapper.com`;
  const html = `<div style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c2430;max-width:520px;margin:0 auto;padding:24px">
  <p style="font-size:20px;font-weight:700;margin:0 0 12px">Deodapper</p>
  <p>${intro}</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#2b6cb0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Sign in to Deodapper</a></p>
  <p style="color:#5b6672;font-size:14px">The link works once and expires in 20 minutes. If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${link}</span></p>
  <p style="color:#5b6672;font-size:14px">If you didn't ask for this, ignore it; nothing happens without the link.<br>Deodapper · support@deodapper.com</p>
</div>`;
  return { subject, text, html };
}

/** Send one email. Throws with a readable message when Resend refuses. */
export async function send({ to, subject, text, html }, { fetchImpl = fetch } = {}) {
  if (!enabled()) throw new Error("email isn't configured (RESEND_API_KEY / MAIL_FROM)");
  let res, data;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${config.mail.resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.mail.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(config.httpTimeoutMs),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    lastError = err.message;
    throw new Error(`email: ${err.message}`);
  }
  if (!res.ok) {
    lastError = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(`email: ${lastError}`);
  }
  sent++;
  lastError = null;
  return { id: data?.id || null };
}
