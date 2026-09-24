import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../server/config.js";
import * as tts from "../server/lib/tts.js";

const MP3 = Buffer.from("ID3fake-mp3-bytes").toString("base64");
const okFetch = (calls = []) => async (url, init) => {
  calls.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ audioContent: MP3 }) };
};
const failFetch = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });

beforeEach(() => {
  tts._useMemoryDb();
  config.tts = { enabled: true, key: "test-key", keySource: "GOOGLE_TTS_KEY", voice: "en-US-Chirp3-HD-Aoede", ratePerMChars: 30, dailyBudgetUsd: 1, speakingRate: 1 };
});

test("synthesize calls Google once per distinct text and serves the cache afterwards", async () => {
  const calls = [];
  const a = await tts.synthesize("Welcome to the Heights.", { fetchImpl: okFetch(calls) });
  const b = await tts.synthesize("Welcome  to the Heights. ", { fetchImpl: okFetch(calls) });
  assert.equal(calls.length, 1, "whitespace-normalised repeat is a cache hit");
  assert.equal(a.hash, b.hash);
  assert.equal(b.cached, true);
  assert.equal(calls[0].voice.name, "en-US-Chirp3-HD-Aoede");
  assert.equal(calls[0].voice.languageCode, "en-US");
  assert.equal(calls[0].audioConfig.audioEncoding, "MP3");
  assert.equal(tts.get(a.hash).bytes.toString(), "ID3fake-mp3-bytes");
  assert.equal(tts.summary(1).calls, 1);
  assert.ok(Math.abs(tts.summary(1).costUsd - tts.costOf("Welcome to the Heights.".length)) < 1e-9);
});

test("a different voice is a different clip", async () => {
  const calls = [];
  await tts.synthesize("Hello.", { fetchImpl: okFetch(calls) });
  await tts.synthesize("Hello.", { fetchImpl: okFetch(calls), voice: "en-US-Chirp3-HD-Charon" });
  assert.equal(calls.length, 2);
});

test("the daily budget stops new clips but cached ones still play", async () => {
  config.tts.dailyBudgetUsd = 0.00001; // one call of any length trips it
  const calls = [];
  const first = await tts.synthesize("A long enough story to cost something.", { fetchImpl: okFetch(calls) });
  await assert.rejects(tts.synthesize("Another story.", { fetchImpl: okFetch(calls) }), /budget/);
  const again = await tts.synthesize("A long enough story to cost something.", { fetchImpl: okFetch(calls) });
  assert.equal(again.cached, true);
  assert.equal(first.hash, again.hash);
  assert.equal(tts.budget().tripped, true);
});

test("a permission error pauses the voice for 15 minutes instead of failing every request", async () => {
  let now = 1_000_000;
  const clock = () => now;
  await assert.rejects(tts.synthesize("Hi.", { fetchImpl: failFetch(403, "Cloud Text-to-Speech API has not been used in project"), now: clock }), /has not been used/);
  assert.equal(tts.stats(now).paused, true);
  await assert.rejects(tts.synthesize("Hi again.", { fetchImpl: okFetch(), now: clock }), /paused/);
  now += 16 * 60_000;
  const r = await tts.synthesize("Hi again.", { fetchImpl: okFetch(), now: clock });
  assert.equal(r.cached, false);
  assert.equal(tts.stats(now).paused, false);
});

test("forNarration attaches audio to what it could voice and leaves the rest to the phone", async () => {
  let n = 0;
  const flaky = async (url, init) => { n++; return n === 2 ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ audioContent: MP3 }) }; };
  const items = [{ id: "a", text: "Story one." }, { id: "b", text: "Story two." }, { id: "c", text: "Story three." }];
  const out = await tts.forNarration(items, { fetchImpl: flaky });
  assert.equal(out.done, 2);
  assert.equal(out.failed, 1);
  const voiced = items.filter((i) => i.audio);
  assert.equal(voiced.length, 2);
  assert.match(voiced[0].audio.url, /^\/api\/audio\/[0-9a-f]{32}\.mp3$/);
  assert.equal(voiced[0].audio.voice, "en-US-Chirp3-HD-Aoede");
  assert.ok(items.some((i) => !i.audio));
});

test("with no key the feature is off and forNarration is a no-op", async () => {
  config.tts.key = "";
  assert.equal(tts.enabled(), false);
  const items = [{ id: "a", text: "Story." }];
  const out = await tts.forNarration(items, { fetchImpl: okFetch() });
  assert.equal(out.skipped, 1);
  assert.equal(items[0].audio, undefined);
  assert.equal(tts.stats().budget, null);
});
