// iOS-safe text-to-speech queue on top of the Web Speech API.
// - unlock() must be called synchronously inside a user tap (primes iOS).
// - One speaker at a time. A stop narration interrupts a drive-by; drive-bys wait.
// - Sentences are spoken as separate utterances so Skip is instant and Chrome's
//   long-utterance cutoff never hits. Strong refs are kept so onend fires.

const MAX_CHUNK = 200;

// Voice presets: accent + gender, matched against whatever voices this device has.
// Names are what iOS / Android / Windows ship; gender words appear in Android voice names.
export const VOICE_PRESETS = {
  auto: { label: "Device default", lang: "en", prefer: [] },
  "us-male": { label: "American · male", lang: "en-US", prefer: [/aaron/i, /fred/i, /alex\b/i, /guy/i, /davis/i, /male/i], avoid: [/female/i] },
  "us-female": { label: "American · female", lang: "en-US", prefer: [/samantha/i, /ava/i, /allison/i, /zira/i, /jenny/i, /aria/i, /female/i] },
  "gb-female": { label: "British · female", lang: "en-GB", prefer: [/kate/i, /serena/i, /martha/i, /stephanie/i, /hazel/i, /sonia/i, /libby/i, /female/i] },
  "gb-male": { label: "British · male", lang: "en-GB", prefer: [/daniel/i, /arthur/i, /oliver/i, /george/i, /ryan/i, /male/i], avoid: [/female/i] },
  "in-female": { label: "Indian · female", lang: "en-IN", prefer: [/veena/i, /neerja/i, /heera/i, /isha/i, /female/i] },
  "in-male": { label: "Indian · male", lang: "en-IN", prefer: [/rishi/i, /prabhat/i, /ravi/i, /male/i], avoid: [/female/i] },
};
const VOICE_KEY = "tourguide.voice";
export function getVoicePreset() { try { return localStorage.getItem(VOICE_KEY) || "auto"; } catch { return "auto"; } }
export function setVoicePreset(id) { try { localStorage.setItem(VOICE_KEY, id); } catch { /* ignore */ } }

/** Best available voice for a preset; null if none of that accent exists on this device. */
export function matchVoice(presetId, voices) {
  const p = VOICE_PRESETS[presetId] || VOICE_PRESETS.auto;
  const norm = (s) => String(s || "").toLowerCase().replace("_", "-");
  const inLang = voices.filter((v) => norm(v.lang).startsWith(norm(p.lang)));
  const pool = inLang.length ? inLang : voices.filter((v) => norm(v.lang).startsWith("en"));
  const notAvoided = pool.filter((v) => !(p.avoid || []).some((re) => re.test(v.name)));
  for (const re of p.prefer) {
    const hit = notAvoided.find((v) => re.test(v.name) && v.localService) || notAvoided.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  if (presetId === "auto") return pool.find((v) => v.default) || pool.find((v) => v.localService) || pool[0] || null;
  return inLang.length ? (notAvoided.find((v) => v.localService) || notAvoided[0] || inLang[0]) : null;
}

export function createSpeech({ lang = "en-US", rate = 1.0, isStale = () => false } = {}) {
  const synth = globalThis.speechSynthesis;
  const listeners = { start: new Set(), chunk: new Set(), end: new Set(), voices: new Set(), pause: new Set(), resume: new Set() };
  const keep = []; // strong references to utterances
  let queue = [];
  let current = null;   // { item, chunks, index }
  let paused = null;    // narration a turn prompt cut into; resumes (from that sentence) when the prompt ends
  let muted = false;
  let unlocked = false;
  let voice = null;
  let presetId = getVoicePreset();
  let watchdog = null;
  let lastItem = null;

  const emit = (ev, payload) => { for (const fn of listeners[ev]) fn(payload); };
  const on = (ev, fn) => { listeners[ev].add(fn); return () => listeners[ev].delete(fn); };

  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices();
    if (!voices.length) return;
    voice = matchVoice(presetId, voices) || matchVoice("auto", voices);
    emit("voices", { voices, voice, presetId });
  }
  if (synth) {
    pickVoice();
    synth.addEventListener?.("voiceschanged", pickVoice);
    // iOS sometimes never fires voiceschanged: poll briefly
    let tries = 0;
    const t = setInterval(() => { pickVoice(); if (voice || ++tries > 8) clearInterval(t); }, 250);
  }

  /** Switch preset (persisted) and re-pick. Returns the matched voice or null. */
  function setPreset(id) {
    presetId = VOICE_PRESETS[id] ? id : "auto";
    setVoicePreset(presetId);
    pickVoice();
    return voice;
  }
  const availableVoices = () => (synth?.getVoices() || []).filter((v) => /^en/i.test(v.lang));

  function chunkText(text) {
    const sentences = String(text).replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
    const out = [];
    for (let s of sentences) {
      s = s.trim();
      while (s.length > MAX_CHUNK) {
        let cut = s.lastIndexOf(", ", MAX_CHUNK);
        if (cut < MAX_CHUNK / 2) cut = s.lastIndexOf(" ", MAX_CHUNK);
        if (cut <= 0) cut = MAX_CHUNK;
        out.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if (s) out.push(s);
    }
    return out;
  }

  function makeUtterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang || lang;
    u.rate = rate;
    if (voice) u.voice = voice;
    keep.push(u);
    if (keep.length > 50) keep.splice(0, keep.length - 50);
    return u;
  }

  /** Call synchronously from a tap handler. Speaks a short line to prime the engine. */
  function unlock(text = "Starting tour.") {
    if (!synth) return false;
    try {
      synth.cancel();
      const u = makeUtterance(text);
      synth.speak(u);
      unlocked = true;
    } catch (e) {
      console.warn("speech unlock failed", e);
    }
    return unlocked;
  }

  function speakChunk() {
    if (!current) return;
    if (current.index >= current.chunks.length) return finish(false);
    const text = current.chunks[current.index];
    emit("chunk", { item: current.item, index: current.index, total: current.chunks.length, text });
    if (muted || !synth) {
      // silently "play" at reading pace so timing/interrupt logic still works
      const ms = Math.max(800, (text.split(/\s+/).length / 2.5) * 1000);
      watchdog = setTimeout(() => { current.index++; speakChunk(); }, ms);
      return;
    }
    const u = makeUtterance(text);
    const expected = (text.split(/\s+/).length / 2.5) * 1500 + 2000;
    const advance = () => {
      clearTimeout(watchdog);
      if (!current || current.utter !== u) return;
      current.index++;
      speakChunk();
    };
    u.onend = advance;
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") advance(); };
    watchdog = setTimeout(advance, expected);
    current.utter = u;
    synth.speak(u);
  }

  function finish(interrupted) {
    clearTimeout(watchdog);
    const done = current;
    current = null;
    if (done) {
      lastItem = done.item;
      emit("end", { item: done.item, interrupted });
    }
    if (paused && done?.item.kind === "turn") {
      // the prompt is over: pick the story back up, unless a stop narration arrived meanwhile
      // (stops outrank drive-bys and previews) or the car has left the drive-by behind
      const p = paused;
      paused = null;
      const stopWaiting = queue.some((q) => q.kind === "stop");
      const outranked = stopWaiting && (p.item.kind === "driveby" || p.item.kind === "preview");
      if (!outranked && !isStale(p.item)) {
        current = p;
        emit("resume", { item: p.item, index: p.index });
        speakChunk();
        return;
      }
      emit("end", { item: p.item, interrupted: true, stale: !outranked });
    }
    next();
  }

  function next() {
    if (current) return;
    while (queue.length) {
      const item = queue.shift();
      if (isStale(item)) { emit("end", { item, interrupted: true, stale: true }); continue; }
      start(item);
      return;
    }
  }

  function start(item) {
    current = { item, chunks: chunkText(item.text), index: 0, utter: null };
    emit("start", { item });
    speakChunk();
  }

  /**
   * Queue narration. Stops interrupt drive-bys and previews; everything else waits its turn.
   * Turn prompts are special. A newer one replaces any pending or playing one (a stale
   * "in 200 feet" is worse than silence). One flagged `interrupt` (the turn prompts themselves)
   * pauses whatever narration is playing, speaks, and the narration resumes from the sentence it
   * was on. One without the flag (reassurance, "back on the route") is dropped while narration
   * plays: the banner still shows the turn.
   */
  function enqueue(item) {
    if (!item?.text) return;
    if (item.kind === "turn") {
      queue = queue.filter((q) => q.kind !== "turn");
      if (current) {
        if (current.item.kind === "turn") { // replace the playing prompt, keep whatever it paused
          synth?.cancel();
          const dropped = current;
          current = null;
          clearTimeout(watchdog);
          emit("end", { item: dropped.item, interrupted: true });
          start(item);
          return;
        }
        if (!item.interrupt) return;
        // pause the story mid-sentence boundary: remember it, speak the prompt, resume in finish()
        synth?.cancel();
        clearTimeout(watchdog);
        paused = current;
        current = null;
        emit("pause", { item: paused.item });
        start(item);
        return;
      }
      queue.push(item);
      next();
      return;
    }
    if (current && item.kind === "stop" && (current.item.kind === "driveby" || current.item.kind === "preview")) {
      synth?.cancel();
      const dropped = current;
      current = null;
      clearTimeout(watchdog);
      emit("end", { item: dropped.item, interrupted: true });
      queue = queue.filter((q) => q.kind !== "driveby"); // stale drive-bys go too
      queue.unshift(item);
      next();
      return;
    }
    queue.push(item);
    // stops jump ahead of queued drive-bys
    queue.sort((a, b) => (a.kind === "stop" ? 0 : 1) - (b.kind === "stop" ? 0 : 1));
    next();
  }

  function skip() {
    if (!current) return;
    synth?.cancel();
    finish(true);
  }

  function replay() {
    const item = current?.item || lastItem;
    if (!item) return;
    synth?.cancel();
    clearTimeout(watchdog);
    current = null;
    queue.unshift(item);
    next();
  }

  function setMuted(on) {
    muted = on;
    if (on && synth) { synth.cancel(); clearTimeout(watchdog); if (current) speakChunk(); }
    else if (current && synth) { synth.cancel(); speakChunk(); }
  }

  /** After the page comes back to the foreground the synth may be wedged: restart current item. */
  function recoverAfterResume() {
    if (!synth) return;
    synth.cancel();
    clearTimeout(watchdog);
    if (current) { current.index = 0; speakChunk(); }
    else next();
  }

  function stop() {
    synth?.cancel();
    clearTimeout(watchdog);
    queue = [];
    current = null;
    paused = null;
  }

  return {
    on, unlock, enqueue, skip, replay, setMuted, recoverAfterResume, stop,
    setPreset, availableVoices,
    get preset() { return presetId; },
    get voice() { return voice; },
    get current() { return current?.item || null; },
    get muted() { return muted; },
    get supported() { return Boolean(synth); },
    get unlocked() { return unlocked; },
    get queueLength() { return queue.length; },
    chunkText,
  };
}
