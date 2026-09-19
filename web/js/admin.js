// Admin usage dashboard. Password is kept in sessionStorage only (asked again next browser session).

import { escapeHtml } from "./format.js";

const $ = (id) => document.getElementById(id);
const KEY = "tourguide.adminKey";
let days = 30;

function key() { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } }
function setKey(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

async function api(path, retried = false) {
  const res = await fetch(path, { headers: key() ? { "x-admin-key": key() } : {} });
  if (res.status === 401 && !retried) {
    const entered = window.prompt("Admin password:", "");
    if (!entered) throw new Error("Admin password required.");
    setKey(entered.trim());
    return api(path, true);
  }
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

async function load() {
  $("msg").hidden = true;
  try {
    const s = await api(`/api/admin/summary?days=${days}`); // first call may prompt for the password
    const e = await api(`/api/admin/events?limit=200`);
    render(s, e.events);
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
$("refresh").addEventListener("click", load);
$("logout").addEventListener("click", () => { setKey(""); location.reload(); });
load();
