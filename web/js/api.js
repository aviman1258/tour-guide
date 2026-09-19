import { apiBase, runtime } from "./config.js";

async function call(method, path, body, signal) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export async function probe() {
  try {
    const h = await call("GET", "/api/health");
    runtime.hasServer = Boolean(h?.ok);
    runtime.claude = h?.claude || null;
  } catch {
    runtime.hasServer = false;
  }
  return runtime.hasServer;
}

export const health = () => call("GET", "/api/health");
export const place = (q, near) => call("GET", `/api/place?q=${encodeURIComponent(q)}${near ? `&near=${near.lat},${near.lon}` : ""}`);
export const reverse = (lat, lon) => call("GET", `/api/reverse?lat=${lat}&lon=${lon}`);
export const plan = (input, signal) => call("POST", "/api/plan", input, signal);
export const suggest = (itinerary, count = 3) => call("POST", "/api/suggest", { itinerary, count });
export const schedule = (itinerary, trim = false) => call("POST", "/api/schedule", { itinerary, trim });
export const prepareDrive = (itinerary) => call("POST", "/api/prepare-drive", { itinerary });
