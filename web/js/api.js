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
export const estimate = () => call("GET", "/api/estimate");

/** Streaming plan: resolves to the final itinerary; onEvent(name, data) for progress. */
export const planStream = (input, opts) => stream("/api/plan", input, { ...opts, doneKey: "itinerary" });
/** Streaming prepare-drive: resolves to the DrivePackage; onEvent for progress. */
export const prepareDriveStream = (itinerary, opts) => stream("/api/prepare-drive", { itinerary }, { ...opts, doneKey: "package" });

/**
 * POST with Accept: text/event-stream and parse server-sent events.
 * Resolves to done[doneKey]; rejects on an `error` event or a broken stream.
 */
async function stream(path, body, { onEvent = () => {}, signal, doneKey } = {}) {
  const res = await fetch(apiBase() + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep msg */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", result = null, failure = null;
  const handle = (block) => {
    let event = "message", data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === "done") result = doneKey ? payload[doneKey] : payload;
    if (event === "error") failure = new Error(payload.message || "request failed");
    onEvent(event, payload);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx).replace(/\r/g, "");
      buffer = buffer.slice(idx + 2);
      if (block.trim() && !block.startsWith(":")) handle(block);
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("The connection ended before a result arrived.");
  return result;
}
export const suggest = (itinerary, count = 3) => call("POST", "/api/suggest", { itinerary, count });
export const schedule = (itinerary, trim = false) => call("POST", "/api/schedule", { itinerary, trim });
export const prepareDrive = (itinerary) => call("POST", "/api/prepare-drive", { itinerary });
