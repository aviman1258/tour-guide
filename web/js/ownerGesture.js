// Hidden door into owner mode: press and hold the Deodap logo in the header for ~0.8 s.
// Not the owner → passphrase prompt. Owner → offer to leave owner mode on this device (to see
// what a paying visitor sees). Also reachable with ?owner in the URL. Nothing is drawn on screen.

import { askSecret } from "./secretPrompt.js";
import * as api from "./api.js";

const HOLD_MS = 800;

function note(msg, ms = 4000) {
  const el = document.getElementById("toast");
  if (!el) return window.alert(msg);
  el.textContent = msg; el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => (el.hidden = true), ms);
}

export async function toggleOwner({ isOwner }) {
  if (isOwner) {
    if (window.confirm("Leave owner mode on this device? You'll see what a paying visitor sees; hold the logo again to sign back in.")) {
      await api.logoutOwner();
      location.reload();
    }
    return;
  }
  const k = await askSecret({ title: "Owner", label: "Owner passphrase", submit: "Sign in" });
  if (!k) return;
  try {
    await api.unlockOwner(k); // the server counts wrong guesses: 3 per device or IP, then a 24 h lockout
    location.reload();
  } catch (err) {
    note(err.message || "Couldn't sign in.", 5000);
  }
}

/** Attach the long-press to the header logo. `isOwner()` is read at gesture time. */
export function bindOwnerGesture(logo, { isOwner }) {
  if (!logo) return;
  logo.style.webkitTouchCallout = "none";
  logo.style.userSelect = "none";
  let timer = null, fired = false;
  const start = () => {
    fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; toggleOwner({ isOwner: isOwner() }); }, HOLD_MS);
  };
  const stop = () => clearTimeout(timer);
  logo.addEventListener("pointerdown", start);
  logo.addEventListener("pointerup", stop);
  logo.addEventListener("pointercancel", stop);
  logo.addEventListener("pointerleave", stop);
  logo.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press on phones would open the image menu
  // the logo sits inside the home link: swallow the click that follows a completed hold
  logo.closest("a")?.addEventListener("click", (e) => { if (fired) { e.preventDefault(); fired = false; } }, true);
  if (new URLSearchParams(location.search).has("owner")) {
    history.replaceState(null, "", location.pathname);
    setTimeout(() => toggleOwner({ isOwner: isOwner() }), 300);
  }
}
