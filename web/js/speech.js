// iOS-safe text-to-speech queue on top of the Web Speech API.
// - unlock() must be called synchronously inside a user tap (primes iOS).
// - One speaker at a time. A stop narration interrupts a drive-by; drive-bys wait.
// - Sentences are spoken as separate utterances so Skip is instant and Chrome's
//   long-utterance cutoff never hits. Strong refs are kept so onend fires.

const MAX_CHUNK = 200;

export function createSpeech({ lang = "en-US", rate = 1.0, isStale = () => false } = {}) {
  const synth = globalThis.speechSynthesis;
  const listeners = { start: new Set(), chunk: new Set(), end: new Set() };
  const keep = []; // strong references to utterances
  let queue = [];
  let current = null;   // { item, chunks, index }
  let muted = false;
  let unlocked = false;
  let voice = null;
  let watchdog = null;
  let lastItem = null;

  const emit = (ev, payload) => { for (const fn of listeners[ev]) fn(payload); };
  const on = (ev, fn) => { listeners[ev].add(fn); return () => listeners[ev].delete(fn); };

  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices();
    if (!voices.length) return;
    const en = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    voice =
      en.find((v) => v.localService && /samantha|ava|allison|google us|en-us/i.test(v.name + v.lang)) ||
      en.find((v) => v.localService) ||
      en[0] ||
      null;
  }
  if (synth) {
    pickVoice();
    synth.addEventListener?.("voiceschanged", pickVoice);
    // iOS sometimes never fires voiceschanged: poll briefly
    let tries = 0;
    const t = setInterval(() => { pickVoice(); if (voice || ++tries > 8) clearInterval(t); }, 250);
  }

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
    u.lang = lang;
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

  /** Queue narration. Stops interrupt drive-bys; everything else waits its turn. */
  function enqueue(item) {
    if (!item?.text) return;
    if (current && item.kind === "stop" && current.item.kind === "driveby") {
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
  }

  return {
    on, unlock, enqueue, skip, replay, setMuted, recoverAfterResume, stop,
    get current() { return current?.item || null; },
    get muted() { return muted; },
    get supported() { return Boolean(synth); },
    get unlocked() { return unlocked; },
    get queueLength() { return queue.length; },
    chunkText,
  };
}
