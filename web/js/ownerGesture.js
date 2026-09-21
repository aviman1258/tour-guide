// Hidden door into owner mode: press and hold the Deodap logo in the header for ~0.8 s.
// Not the owner → passphrase prompt. Owner → offer to leave owner mode on this device (to see
// what a paying visitor sees). Also reachable with ?owner in the URL. Nothing is drawn on screen.

import { askSecret } from "./secretPrompt.js";
import { setAppKey, getAppKey } from "./config.js";

const HOLD_MS = 800;

export async function toggleOwner({ isOwner }) {
  if (isOwner) {
    if (window.confirm("Leave owner mode on this device? You'll see what a paying visitor sees; hold the logo again to sign back in.")) {
      setAppKey("");
      location.reload();
    }
    return;
  }
  const k = await askSecret({ title: "Owner", label: "Owner passphrase", submit: "Sign in" });
  if (k) { setAppKey(k); location.reload(); }
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
  void getAppKey;
}
