// Tell the server this page was opened (works from the cache and the installed app too).
// Sends only: page path (+tier), whether we're running as an installed app, and the referrer host.
export function ping(extra = {}) {
  try {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const body = JSON.stringify({
      page: location.pathname + (extra.tier ? `?tier=${extra.tier}` : ""),
      tier: extra.tier || undefined,
      standalone,
      referrer: document.referrer && !document.referrer.startsWith(location.origin) ? new URL(document.referrer).host : "",
    });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/ping", new Blob([body], { type: "text/plain" }));
    else fetch("/api/ping", { method: "POST", body, keepalive: true }).catch(() => {});
  } catch { /* never let analytics break the page */ }
}
