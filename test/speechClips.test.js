import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeech } from "../web/js/speech.js";

// Recorded clips: a fake <audio> element stands in for the browser's.
function fakeAudio() {
  const log = [];
  const made = [];
  class Audio {
    constructor() { this.src = ""; this.currentTime = 0; this.duration = 30; this.paused = true; made.push(this); }
    async play() { this.paused = false; log.push(`play@${this.currentTime}:${this.src}`); }
    pause() { this.paused = true; log.push(`pause@${this.currentTime}`); }
    setAttribute() {}
  }
  return { Audio, log, last: () => made.at(-1) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a story with a clip plays through the audio element; a turn prompt pauses it and it resumes where it was", async () => {
  const fake = fakeAudio();
  globalThis.Audio = fake.Audio;
  try {
    const sp = createSpeech({ resolveAudio: async (url) => `blob:${url}` });
    assert.equal(sp.canPlayClips, true);
    const events = [];
    for (const ev of ["pause", "resume", "end"]) sp.on(ev, (e) => events.push(`${ev}:${e.item.id}`));
    sp.enqueue({ id: "stop1", kind: "stop", text: "Sentence one. Sentence two. Sentence three.", audio: { url: "/api/audio/abc.mp3" } });
    await tick(); // the clip resolves
    assert.equal(sp.narrator, "clip");
    assert.deepEqual(fake.log, ["play@0:blob:/api/audio/abc.mp3"]);
    const el = fake.last();
    el.currentTime = 12; // 12 s in, a turn comes up
    sp.enqueue({ id: "turn_1_near", kind: "turn", interrupt: true, text: "In 500 feet, turn left." });
    assert.equal(sp.current.id, "turn_1_near");
    assert.equal(fake.log.at(-1), "pause@12");
    sp.skip(); // prompt done
    await tick();
    assert.equal(sp.current.id, "stop1");
    assert.equal(fake.log.at(-1), "play@12:blob:/api/audio/abc.mp3", "resumes from the same second, not from the start");
    assert.deepEqual(events, ["pause:stop1", "end:turn_1_near", "resume:stop1"]);
    el.onended(); // the clip ends
    assert.equal(sp.current, null);
    assert.ok(events.includes("end:stop1"));
    sp.stop();
  } finally { delete globalThis.Audio; }
});

test("progress along the clip drives the sentence highlight", async () => {
  const fake = fakeAudio();
  globalThis.Audio = fake.Audio;
  try {
    const sp = createSpeech({ resolveAudio: async (url) => `blob:${url}` });
    const chunks = [];
    sp.on("chunk", (c) => chunks.push(c.index));
    sp.enqueue({ id: "s", kind: "stop", text: "One. Two. Three.", audio: { url: "/api/audio/x.mp3" } });
    await tick();
    const el = fake.last();
    el.currentTime = 11; el.ontimeupdate();
    el.currentTime = 21; el.ontimeupdate();
    assert.deepEqual(chunks, [0, 1, 2]);
    sp.stop();
  } finally { delete globalThis.Audio; }
});

test("a clip that cannot be loaded falls back to the phone voice; no resolver means no clips at all", async () => {
  const fake = fakeAudio();
  globalThis.Audio = fake.Audio;
  try {
    const sp = createSpeech({ resolveAudio: async () => null });
    const chunks = [];
    sp.on("chunk", (c) => chunks.push(c.index));
    sp.enqueue({ id: "stop1", kind: "stop", text: "One. Two.", audio: { url: "/api/audio/missing.mp3" } });
    await tick();
    assert.equal(sp.narrator, "phone");
    assert.ok(!fake.log.some((l) => l.startsWith("play")), "nothing was played through the element");
    assert.deepEqual(chunks, [0], "the silent timer took over at sentence one");
    sp.stop();
    const plain = createSpeech();
    assert.equal(plain.canPlayClips, false);
  } finally { delete globalThis.Audio; }
});

test("a stop with a clip still interrupts a playing drive-by clip", async () => {
  const fake = fakeAudio();
  globalThis.Audio = fake.Audio;
  try {
    const sp = createSpeech({ resolveAudio: async (url) => `blob:${url}` });
    const ended = [];
    sp.on("end", (e) => ended.push(`${e.item.id}:${e.interrupted ? "cut" : "done"}`));
    sp.enqueue({ id: "db", kind: "driveby", text: "Drive-by.", audio: { url: "/api/audio/db.mp3" } });
    await tick();
    sp.enqueue({ id: "st", kind: "stop", text: "Stop story.", audio: { url: "/api/audio/st.mp3" } });
    await tick();
    assert.equal(sp.current.id, "st");
    assert.deepEqual(ended, ["db:cut"]);
    assert.equal(fake.log.at(-1), "play@0:blob:/api/audio/st.mp3");
    sp.stop();
  } finally { delete globalThis.Audio; }
});
