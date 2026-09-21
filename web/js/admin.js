// Admin usage dashboard. Password is kept in sessionStorage only (asked again next browser session).

import { escapeHtml } from "./format.js";
import { askSecret } from "./secretPrompt.js";

const $ = (id) => document.getElementById(id);
const KEY = "tourguide.adminKey";
let days = 30;

function key() { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } }
function setKey(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

async function api(path, method = "GET", retried = false) {
  const res = await fetch(path, { method, headers: key() ? { "x-admin-key": key() } : {} });
  if (res.status === 401 && !retried) {
    const entered = await askSecret({ title: "Admin", label: "Admin password", submit: "Sign in" });
    if (!entered) throw new Error("Admin password required.");
    setKey(entered);
    return api(path, method, true);
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString());
const when = (ts) => { const d = new Date(ts); return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`; };
const place = (r) => [r.city, r.region, r.country].filter(Boolean).join(", ") || "unknown";

function table(id, head, rows) {
  const t = $(id);
  t.innerHTML = `<thead><tr>${head.map((h) => `<th class="${h.num ? "num" : ""}">${h.label}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${head.map((h) => `<td class="${h.num ? "num" : ""}">${h.render(r)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${head.length}" class="hint">nothing yet</td></tr>`
  }</tbody>`;
}

function render(s, events) {
  const t = s.totals;
  $("cards").innerHTML = [
    ["Page views", t.pageViews], ["Unique visitors", t.uniqueIps], ["Plans", t.plans], ["Prepares", t.prepares],
    ["Routes published", t.routesPublished], ["Routes used", t.routesUsed], ["Library searches", t.librarySearches],
    ["Subscriber events", t.subscriberEvents], ["Free events", t.freeEvents],
  ].map(([l, n]) => `<div class="stat"><div class="n">${fmt(n)}</div><div class="l">${l}</div></div>`).join("");

  $("range").textContent = `since ${new Date(s.since).toLocaleDateString()}`;
  const max = Math.max(1, ...s.byDay.map((d) => d.visitors));
  $("bars").innerHTML = s.byDay.map((d) => `<div class="bar" style="height:${Math.round((d.visitors / max) * 100)}%" title="${d.day}: ${d.visitors} visitors, ${d.views} views, ${d.events} events"><span>${d.visitors}</span></div>`).join("") || `<div class="hint">no visits in this window</div>`;

  table("places", [{ label: "Place", render: place }, { label: "Visitors", num: true, render: (r) => fmt(r.visitors) }, { label: "Events", num: true, render: (r) => fmt(r.events) }], s.byPlace);
  table("devices", [{ label: "Device", render: (r) => escapeHtml(r.device) }, { label: "Browser", render: (r) => escapeHtml(r.browser) }, { label: "Visitors", num: true, render: (r) => fmt(r.visitors) }, { label: "Events", num: true, render: (r) => fmt(r.events) }], s.byDevice);
  table("pages", [{ label: "Page", render: (r) => escapeHtml(r.page) }, { label: "Views", num: true, render: (r) => fmt(r.views) }, { label: "Visitors", num: true, render: (r) => fmt(r.visitors) }], s.byPage);
  table("kinds", [{ label: "Event", render: (r) => `<span class="kind-${escapeHtml(r.kind)}">${escapeHtml(r.kind)}</span>` }, { label: "Count", num: true, render: (r) => fmt(r.events) }, { label: "Avg time", num: true, render: (r) => (r.avgMs ? `${Math.round(r.avgMs / 1000)} s` : "") }], s.byKind);
  table("visitors", [
    { label: "IP", render: (r) => `<code>${escapeHtml(r.ip)}</code>` }, { label: "Place", render: place }, { label: "Device", render: (r) => escapeHtml(r.device) },
    { label: "Events", num: true, render: (r) => fmt(r.events) }, { label: "First seen", render: (r) => when(r.first) }, { label: "Last seen", render: (r) => when(r.last) },
  ], s.topVisitors);
  table("events", [
    { label: "When", render: (r) => when(r.ts) }, { label: "IP", render: (r) => `<code>${escapeHtml(r.ip)}</code>` }, { label: "Place", render: place },
    { label: "Tier", render: (r) => escapeHtml(r.tier || "") }, { label: "Device", render: (r) => `${escapeHtml(r.device)} · ${escapeHtml(r.browser)}` },
    { label: "Event", render: (r) => `<span class="kind-${escapeHtml(r.kind)}">${escapeHtml(r.kind)}</span>` }, { label: "Detail", render: (r) => escapeHtml(r.detail || "") },
    { label: "Took", num: true, render: (r) => (r.ms ? `${Math.round(r.ms / 1000)} s` : "") },
  ], events);
}

const usd = (n) => (n == null ? "–" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
function renderSales(s) {
  const t = s.totals;
  $("sales-note").textContent = `${s.days} days`;
  $("sales-cards").innerHTML = [
    ["Revenue", usd(t.revenueCents / 100)], ["Routes sold", fmt(t.captured)], ["Plans delivered", fmt(t.plansDelivered)],
    ["Holds open", fmt(t.holdsOpen)], ["Released", fmt(t.released)], ["Started, unpaid", fmt(t.pending)],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("")
    + (s.byTier.length ? `<div class="hint">${s.byTier.map((b) => `${escapeHtml(b.label)}: ${b.captured} sold, ${usd(b.revenueCents / 100)}`).join(" · ")}</div>` : "");
  table("sales", [
    { label: "When", render: (r) => when(r.createdAt) }, { label: "Credit", render: (r) => `<code>${escapeHtml(r.id)}</code>` },
    { label: "Tier", render: (r) => `${escapeHtml(r.label)} · ${escapeHtml(r.price)}` },
    { label: "Status", render: (r) => `<span class="kind-${r.status === "captured" ? "publish" : r.status === "canceled" ? "plan_error" : "page"}">${escapeHtml(r.status)}</span>` },
    { label: "Plans", num: true, render: (r) => `${r.plansUsed}` }, { label: "Captured", render: (r) => (r.capturedAt ? when(r.capturedAt) : "") },
    { label: "Note", render: (r) => escapeHtml(r.lastError || "") },
  ], s.recent);
}
function renderCosts(c) {
  $("costs-note").textContent = `${c.days} days · rates ${c.ratesNote}`;
  const pr = c.perRoute;
  $("cost-cards").innerHTML = [
    ["Claude calls", fmt(c.totals.calls)], ["Failed calls", fmt(c.totals.failed)], ["Total cost", usd(c.totals.costUsd)],
    ["Per route (median)", pr ? usd(pr.total) : "–"], ["…of which plan", pr ? usd(pr.plan) : "–"], ["…of which narration", pr ? usd(pr.narration) : "–"],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("")
    + (c.totals.unpriced ? `<div class="hint">${fmt(c.totals.unpriced)} calls have no rate for their model; set CLAUDE_RATES.</div>` : "");
  table("costs", [
    { label: "Call", render: (r) => `<b>${escapeHtml(r.tool)}</b><div class="desc">${escapeHtml(r.models)}</div>` },
    { label: "Calls", num: true, render: (r) => `${fmt(r.calls)}${r.failed ? `<div class="desc">${r.failed} failed</div>` : ""}` },
    { label: "Tokens in (median)", num: true, render: (r) => `${fmt(r.medianIn)}${r.avgCacheRead ? `<div class="desc">${fmt(Math.round(r.avgCacheRead))} cached</div>` : ""}` },
    { label: "Tokens out (median)", num: true, render: (r) => fmt(r.medianOut) },
    { label: "Cost (median)", num: true, render: (r) => usd(r.medianCost) },
    { label: "Cost (total)", num: true, render: (r) => usd(r.totalCost) },
    { label: "Time (median)", num: true, render: (r) => (r.medianMs ? `${Math.round(r.medianMs / 1000)} s` : "") },
  ], c.tools);
}

function renderRoutes(routes) {
  $("routes-count").textContent = `${routes.length} published`;
  table("routes", [
    { label: "Route", render: (r) => `<b>${escapeHtml(r.title)}</b><div class="desc">${escapeHtml(r.description || "")}</div>` },
    { label: "From → to", render: (r) => `${escapeHtml(r.startLabel)} → ${escapeHtml(r.endLabel)}<div class="desc">${escapeHtml(r.region || "")}</div>` },
    { label: "Stops", num: true, render: (r) => `${fmt(r.stopsCount)}<div class="desc">${escapeHtml(r.stopNames.join(" · "))}</div>` },
    { label: "Miles", num: true, render: (r) => fmt(r.miles) }, { label: "Uses", num: true, render: (r) => fmt(r.uses) },
    { label: "Published", render: (r) => when(r.createdAt) },
    { label: "", render: (r) => `<button type="button" class="btn btn-sm btn-danger" data-delete="${escapeHtml(r.id)}" data-title="${escapeHtml(r.title)}">Delete</button>` },
  ], routes);
}

async function loadRoutes() {
  const r = await api(`/api/admin/routes`);
  renderRoutes(r.routes);
}

async function load() {
  $("msg").hidden = true;
  try {
    const s = await api(`/api/admin/summary?days=${days}`); // first call may prompt for the password
    const e = await api(`/api/admin/events?limit=200`);
    render(s, e.events);
    renderSales(await api(`/api/admin/sales?days=${days}`));
    renderCosts(await api(`/api/admin/costs?days=${days}`));
    await loadRoutes();
  } catch (err) {
    $("msg").textContent = err.message;
    $("msg").hidden = false;
    $("msg").classList.add("error");
  }
}

$("days").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  days = Number(b.dataset.days);
  for (const x of $("days").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  load();
});
$("routes").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-delete]");
  if (!b) return;
  if (!window.confirm(`Delete "${b.dataset.title}" from the shared library? Free-tier drivers won't be able to find it any more.`)) return;
  b.disabled = true;
  try {
    await api(`/api/admin/routes/${encodeURIComponent(b.dataset.delete)}`, "DELETE");
    await loadRoutes();
  } catch (err) {
    b.disabled = false;
    $("msg").textContent = err.message; $("msg").hidden = false; $("msg").classList.add("error");
  }
});
$("refresh").addEventListener("click", load);
$("logout").addEventListener("click", () => { setKey(""); location.reload(); });
load();
