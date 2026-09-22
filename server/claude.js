// Claude calls. Uses the Anthropic SDK when ANTHROPIC_API_KEY is set, otherwise shells
// out to the Claude Code CLI (`claude -p --json-schema`) so the app works on a subscription.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import * as usage from "./lib/usage.js";
import { httpError } from "./lib/http.js";
import { CATEGORIES } from "./stops.js";

// ---------- tool schemas (strict: additionalProperties false, enums instead of min/max) ----------

const STOP_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["name", "wikipediaTitle", "searchHint", "category", "whyItMatches", "dwellMinutes", "priority", "isFoodOption", "approxArea"],
  properties: {
    name: { type: "string", description: "Common name of the place." },
    wikipediaTitle: { type: "string", description: "Exact English Wikipedia article title, including any disambiguator, e.g. 'Montrose, Houston' or 'Glenwood Cemetery (Houston, Texas)'." },
    searchHint: { type: "string", description: "Name, the actual municipality it sits in (the suburb, not the metro name), and state. E.g. 'BAPS Shri Swaminarayan Mandir, Stafford, Texas'. Used for geocoding if the article has no coordinates." },
    category: { type: "string", enum: CATEGORIES },
    whyItMatches: { type: "string", description: "One sentence tying this stop to the traveler's interests." },
    dwellMinutes: { type: "integer", enum: [10, 15, 20, 30, 45, 60, 90] },
    priority: { type: "integer", enum: [1, 2, 3, 4, 5], description: "5 = the reason they came; 1 = drop first." },
    isFoodOption: { type: "boolean", description: "True if a lunch stop here is realistic." },
    approxArea: { type: "string", description: "Neighborhood / side of town, e.g. 'Hillcroft & Harwin, SW Houston'." },
  },
};

export const PROPOSE_TOOL = {
  name: "propose_itinerary",
  description: "Return candidate stops for the day, ordered from start to end.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "stops"],
    properties: {
      summary: { type: "string", description: "One or two sentences framing the day for the traveler." },
      stops: { type: "array", items: STOP_ITEM },
    },
  },
};

export const NARRATION_TOOL = {
  name: "write_narration",
  description: "Return spoken tour-guide scripts for the planned stops and the chosen drive-by places.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["scripts"],
    properties: {
      scripts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "targetId", "text", "factsUsed"],
          properties: {
            kind: { type: "string", enum: ["stop", "driveby"] },
            targetId: { type: "string", description: "The stop id (for kind=stop) or the candidate pageid as a string (for kind=driveby)." },
            text: { type: "string", description: "The script, plain sentences, ready for text-to-speech." },
            factsUsed: { type: "array", items: { type: "string" }, description: "Short quotes/paraphrases from the supplied extract that the script relies on." },
          },
        },
      },
    },
  },
};

// ---------- prompts ----------

const PROPOSE_SYSTEM = `You are a sharp local guide planning a self-drive day between two points for a traveler with a few free hours before hotel check-in.

Rules:
- Every stop must be a real place that has an English Wikipedia article. Give the exact article title in wikipediaTitle, with disambiguators ("Montrose, Houston", "BAPS Shri Swaminarayan Mandir Houston"). If unsure of the exact title, give your best guess and a precise searchHint. Never invent places.
- Stops must sit along or near the corridor between start and end (a bounding box is provided). Prefer things that make a coherent drive with little backtracking, and list them in a sensible driving order from start to end.
- Match the traveler's interests literally and generously: "Indian" means temples, Indian commercial districts, restaurants; "historic neighborhoods" means named historic districts and their landmarks; "affluent" means the upscale neighborhoods and master-planned communities of the area, including suburbs.
- Prefer variety: neighborhoods to drive through, one or two places to get out and walk, and at least two realistic food options (isFoodOption=true) so lunch can land between 11:30 and 2:00.
- Overproduce a little: return 10 to 14 candidates. The server trims to what fits the clock, using priority (5 = must-see, 1 = nice if there's time).
- Dwell guidance: neighborhood/district drive-through 10-20, park/cemetery 20-30, temple/museum 45-60, meal 60.
- Keep whyItMatches to one plain sentence. Keep summary to two sentences max.
- You must call the propose_itinerary tool with your answer.`;

const SUGGEST_SYSTEM = `You are a sharp local guide. The traveler already has an itinerary (listed) and wants a few more candidate stops that match their interests and sit near the existing route. Do not repeat anything already listed or dropped. Same grounding rules: real places with English Wikipedia articles, exact article titles, honest priority. Return exactly the number requested. You must call the propose_itinerary tool with your answer.`;

const LISTING_TOOL = {
  name: "write_listing",
  description: "Return the public title and description for a shared driving route.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["title", "description"],
    properties: {
      title: { type: "string", description: "4-80 characters. '<City>: <two or three highlights>'. No quotes, no emojis, no words like route, tour, itinerary, journey." },
      description: { type: "string", description: "One or two plain sentences, 120-300 characters, for a search result and a listing card." },
    },
  },
};
const LISTING_SYSTEM = `You write the public listing for a self-guided driving route that other people can pick and drive with spoken narration.

Title: "<City>: <two or three highlights>", the highlights being the most recognisable stop names, shortened (drop "Houston" from "BAPS Shri Swaminarayan Mandir, Houston"). Four to eighty characters. No quotes, no emojis, no exclamation marks, and never the words route, tour, itinerary, journey, experience or adventure.

Description: one or two plain sentences, 120 to 300 characters. Say who it suits and what they'll see, name the start and end places in short form, and give the rough driving time if supplied. Specific beats flattering: no "breathtaking", "hidden gem", "must-see", "unforgettable", no exclamation marks, no mention of AI or of Deodapper. Write like a knowledgeable friend, not a brochure.

You must call the write_listing tool with your answer.`;

const NARRATION_SYSTEM = `You write short spoken scripts for an audio tour guide app. The scripts play through a phone's text-to-speech while the traveler drives.

Voice: warm, knowledgeable local friend riding along. Use "we" and "you". Plain sentences. No headings, lists, parentheses, URLs, or markdown. Spell out numbers under a hundred and abbreviations (Street not St, Boulevard not Blvd). No emojis.

Grounding: use only facts present in the extract supplied for that place. If the extract is thin, keep the script short and general rather than inventing dates, names or numbers. Put the specific phrases you relied on into factsUsed.

Do not say "on your left" or "on your right"; you don't know which side. Use "coming up", "just off the road here", "as we pass", "up ahead".

Tie to the traveler's interests when natural, never forced. End each stop script with one sentence about what to notice or do there.

Lengths: kind=stop scripts 90 to 150 words. kind=driveby scripts 40 to 70 words.

Selection: write one script for every planned stop. For drive-bys, each leg states how many it has room for (maxDrivebys, from its driving time) and how far apart they must be (minGapKm): pick up to that many, favoring the strongest stories, and skip weak candidates entirely; quiet stretches are fine. In a dense city that means a story every few blocks; on a highway, every few miles. Legs with no room are not listed.

Tone guard: this is a pleasure drive. Skip tragedies, crimes, disasters, accidents and deaths as drive-by subjects, and leave them out of stop scripts too, unless the place is historically defined by that event (a memorial, a battlefield, a famous cemetery) and the traveler's interests point there. A hotel fire or a shooting is not a story for this ride; pick something else or stay quiet.

You must call the write_narration tool with your answer.`;

// ---------- transport ----------

function cliModelAlias(model) {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  return "opus";
}

async function viaSdk({ model, system, user, tool, maxTokens, signal }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.anthropicKey, timeout: 240_000 });
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    tools: [{ ...tool, strict: true }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    output_config: { effort: "medium" },
  }, { signal });
  const meta = { usage: res.usage, model: res.model || model, transport: "sdk" };
  const fail = (msg) => Object.assign(httpError(502, msg), { claudeMeta: meta });
  if (res.stop_reason === "refusal") throw fail("Deodap couldn't help with that request");
  if (res.stop_reason === "max_tokens") throw fail("Deodap ran out of room; try fewer stops");
  const block = res.content.find((b) => b.type === "tool_use" && b.name === tool.name);
  if (block) return { data: block.input, ...meta };
  // fall back: JSON in text
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw fail("Deodap didn't return a usable answer; try again");
  return { data: JSON.parse(m[0]), ...meta };
}

// Empty scratch cwd so the CLI doesn't pick up any repo's CLAUDE.md or files.
const CLI_CWD = path.join(os.tmpdir(), "tour-guide-claude-cli");
fs.mkdirSync(CLI_CWD, { recursive: true });

function cliBinary() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform === "win32") {
    const local = path.join(os.homedir(), ".local", "bin", "claude.exe");
    if (fs.existsSync(local)) return local;
    return "claude.exe";
  }
  return "claude";
}

function viaCli({ model, system, user, tool, signal }) {
  // The user message goes over stdin: no shell quoting, no argv length limits.
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(tool.input_schema),
    "--system-prompt", system.replace(/You must call the \w+ tool with your answer\./, "Answer only with the requested JSON."),
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    "--model", cliModelAlias(model),
    "--max-budget-usd", "1.50",
    "--no-session-persistence",
    "--disallowedTools", "Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Read", "Glob", "Grep", "Agent",
  ];
  return new Promise((resolve, reject) => {
    // `signal` (an AbortSignal) kills the CLI process if the caller cancels, so a cancelled plan stops costing money.
    const child = execFile(cliBinary(), args, { cwd: CLI_CWD, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        if (err?.name === "AbortError" || signal?.aborted) return reject(Object.assign(new Error("cancelled"), { status: 499, name: "AbortError" }));
        if (err && !stdout) return reject(httpError(502, `Deodap is unavailable right now: ${(stderr || err.message).slice(0, 300)}`));
        let out;
        try { out = JSON.parse(stdout); } catch { return reject(httpError(502, `Deodap gave an unreadable answer; try again (${stdout.slice(0, 120)})`)); }
        // the CLI reports what the call cost it (subscription or API), plus token usage
        const meta = { usage: out.usage || null, costUsd: Number.isFinite(out.total_cost_usd) ? out.total_cost_usd : null, model, transport: "cli" };
        if (out.is_error) return reject(Object.assign(httpError(502, `Deodap hit a problem: ${String(out.result || "").slice(0, 300)}`), { claudeMeta: meta }));
        const data = out.structured_output ?? (() => { try { return JSON.parse(out.result); } catch { return null; } })();
        if (!data) return reject(Object.assign(httpError(502, "Deodap didn't return a usable answer; try again"), { claudeMeta: meta }));
        resolve({ data, ...meta });
      });
    child.stdin.on("error", () => {});
    child.stdin.end(user);
  });
}

async function structuredWithTool(opts) {
  const started = Date.now();
  const transport = config.anthropicKey ? "sdk" : "cli";
  const label = opts.purpose || opts.tool.name; // suggest_more shares the propose tool; log it under its own name
  try {
    const { data, ...meta } = transport === "sdk" ? await viaSdk(opts) : await viaCli(opts);
    const ms = Date.now() - started;
    usage.record({ tool: label, model: meta.model || opts.model, transport, usage: meta.usage, costUsd: meta.costUsd, ms, ok: true });
    const u = meta.usage;
    console.log(`[claude] ${label} via ${transport} (${opts.model}) in ${Math.round(ms / 1000)}s${u ? ` · ${u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)} in / ${u.output_tokens} out` : ""}`);
    return data;
  } catch (err) {
    // a failed or refused call still cost tokens: log it so the average includes it (cancelled calls have no meta)
    if (err.claudeMeta) usage.record({ tool: label, model: err.claudeMeta.model || opts.model, transport, usage: err.claudeMeta.usage, costUsd: err.claudeMeta.costUsd, ms: Date.now() - started, ok: false });
    throw err;
  }
}

/**
 * Generic structured-output call for other modules (e.g. narration).
 * `schema` is a strict JSON schema (object, additionalProperties:false, required[]).
 * Works with the SDK (ANTHROPIC_API_KEY) or the Claude Code CLI fallback.
 * Returns the parsed object.
 */
export function structured({ system, user, schema, model = config.modelStrong, maxTokens = 8000, name = "respond", description = "Return the structured answer." }) {
  const sys = /You must call the \w+ tool/.test(system) ? system : `${system}\n\nYou must call the ${name} tool with your answer.`;
  return structuredWithTool({ model, system: sys, user, maxTokens, tool: { name, description, input_schema: schema } });
}

const structuredCall = structuredWithTool;

// ---------- public API ----------

export async function proposeStops({ start, end, arrivalTime, deadline, budgetMinutes, interests, date, corridor, signal }) {
  const user = JSON.stringify({
    start, end, arrivalTime, deadline, date: date || null,
    timeAvailableMinutes: budgetMinutes, interests, corridorBoundingBox: corridor,
    note: "Return 10-14 candidates in driving order. Call the propose_itinerary tool.",
  }, null, 1);
  const data = await structuredCall({ model: config.modelStrong, system: PROPOSE_SYSTEM, user, tool: PROPOSE_TOOL, maxTokens: 6000, signal, purpose: "propose_itinerary" });
  return { summary: String(data.summary || ""), stops: Array.isArray(data.stops) ? data.stops : [] };
}

export async function suggestMore({ itinerary, count = 3, corridor }) {
  const user = JSON.stringify({
    interests: itinerary.interests,
    start: itinerary.start, end: itinerary.end, corridorBoundingBox: corridor,
    alreadyPlanned: itinerary.stops.map((s) => ({ name: s.name, wikipediaTitle: s.wikipediaTitle })),
    alreadyRejected: (itinerary.dropped || []).map((d) => d.name),
    wanted: count,
    note: `Return exactly ${count} new candidates. Call the propose_itinerary tool.`,
  }, null, 1);
  const data = await structuredCall({ model: config.modelFast, system: SUGGEST_SYSTEM, user, tool: PROPOSE_TOOL, maxTokens: 3000, purpose: "suggest_more" });
  return Array.isArray(data.stops) ? data.stops.slice(0, count + 2) : [];
}

/** Draft the public title + description for a route (Haiku; the caller shapes and filters it). */
export async function describeRoute({ itinerary, region = "", signal }) {
  const it = itinerary;
  const user = JSON.stringify({
    region, start: it.start?.label, end: it.end?.label, interests: it.interests || "",
    drivingMinutes: it.route?.totalSec ? Math.round(it.route.totalSec / 60) : null, miles: it.route?.totalM ? Math.round(it.route.totalM / 1609) : null,
    stops: (it.stops || []).map((s) => ({ name: s.name, category: s.category, why: s.whyItMatches || "", blurb: String(s.blurb || "").slice(0, 200) })),
  }, null, 1);
  const data = await structuredCall({ model: config.modelFast, system: LISTING_SYSTEM, user, tool: LISTING_TOOL, maxTokens: 400, signal, purpose: "describe_route" });
  return { title: data?.title || "", description: data?.description || "" };
}

export async function writeNarration({ interests, stops, legs, signal }) {
  const user = JSON.stringify({
    interests,
    stops: stops.map((s) => ({ id: s.id, name: s.name, category: s.category, whyItMatches: s.whyItMatches, dwellMinutes: s.dwellMinutes, extract: s.extract })),
    legs: legs.map((l) => ({
      legIndex: l.legIndex, from: l.from, to: l.to, lengthKm: Math.round(l.lengthM / 100) / 10,
      minutes: l.minutes, maxDrivebys: l.maxDrivebys, minGapKm: Math.round((l.minGapM || 0) / 100) / 10,
      candidates: l.candidates.map((c) => ({ pageid: String(c.pageid), title: c.title, type: c.type, kmAlongLeg: Math.round(c.alongLegM / 100) / 10, extract: c.extract })),
    })),
    note: "Call the write_narration tool. targetId = stop id for stops, pageid string for drive-bys.",
  }, null, 1);
  const data = await structuredCall({ model: config.modelStrong, system: NARRATION_SYSTEM, user, tool: NARRATION_TOOL, maxTokens: 16000, signal, purpose: "write_narration" });
  return Array.isArray(data.scripts) ? data.scripts : [];
}
