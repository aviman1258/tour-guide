import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf, ratesFor } from "../server/lib/usage.js";

const RATES = { "claude-opus-5": { in: 5, out: 25 }, haiku: { in: 1, out: 5 } };

test("costOf prices input, output and cache tokens per million", () => {
  const c = costOf("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0 }, RATES);
  assert.equal(c, 5);
  const o = costOf("claude-opus-5", { input_tokens: 0, output_tokens: 1_000_000 }, RATES);
  assert.equal(o, 25);
  // typical route: 2k plain input, 8k cache read, 1k cache write, 11k output
  const r = costOf("claude-opus-5", { input_tokens: 2000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000, output_tokens: 11000 }, RATES);
  assert.ok(Math.abs(r - (2000 * 5 + 8000 * 0.5 + 1000 * 6.25 + 11000 * 25) / 1e6) < 1e-9);
});

test("web searches add a cent each", () => {
  assert.ok(Math.abs(costOf("claude-opus-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }, RATES) - 0.03) < 1e-9);
});

test("ratesFor matches the exact id, then a contained key, else null", () => {
  assert.deepEqual(ratesFor("claude-opus-5", RATES), { in: 5, out: 25 });
  assert.deepEqual(ratesFor("claude-haiku-4-5-20251001", RATES), { in: 1, out: 5 });
  assert.equal(ratesFor("claude-sonnet-5", RATES), null);
  assert.equal(costOf("claude-sonnet-5", { input_tokens: 10 }, RATES), null);
});
