// iOS-safe narration queue: recorded clips (Deodap's voice, MP3s made at prepare time) when a
// story has one, the phone's own text-to-speech otherwise and for every turn prompt.
// - unlock() must be called synchronously inside a user tap (primes iOS for both TTS and audio).
// - One speaker at a time. A stop narration interrupts a drive-by; drive-bys wait.
// - TTS sentences are spoken as separate utterances so Skip is instant and Chrome's
//   long-utterance cutoff never hits. Strong refs are kept so onend fires.
// - A recorded clip plays in one <audio> element; turn prompts pause it and it resumes where it was.

const MAX_CHUNK = 200;
// a valid, empty WAV: played inside the Start tap so iOS lets the element play later without a gesture
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

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

// How natural a voice sounds, judged from its name. Phones ship a robotic default and hide the
// good ones behind a download ("Samantha (Enhanced)", "Ava (Premium)" on iOS; Google's
// network voices on Android; "Microsoft Aria Online (Natural)" on Windows). Higher is better.
const QUALITY = [
  [/natural|neural|wavenet|studio|journey/i, 4],
  [/premium|enhanced/i, 3],
  [/siri/i, 3],
  [/\bonline\b/i, 1],
  [/google/i, 1],
  [/compact|espeak|eloquence|novelty|whisper|zarvox|trinoids|bells|bubbles|cellos|organ|bad news|good news|boing|bahh|jester|wobble|albert|fred\b/i, -3],
];
export function voiceQuality(v) {
  return QUALITY.reduce((q, [re, w]) => q + (re.test(v.name || "") ? w : 0), 0) + (v.localService ? 0.5 : 0) + (v.default ? 0.25 : 0);
}
const byQuality = (list) => [...list].sort((a, b) => voiceQuality(b) - voiceQuality(a));

/** Best available voice for a preset; null if none of that accent exists on this device. */
export function matchVoice(presetId, voices) {
  const p = VOICE_PRESETS[presetId] || VOICE_PRESETS.auto;
  const norm = (s) => String(s || "").toLowerCase().replace("_", "-");
  const inLang = voices.filter((v) => norm(v.lang).startsWith(norm(p.lang)));
  const pool = byQuality(inLang.length ? inLang : voices.filter((v) => norm(v.lang).startsWith("en")));
  const notAvoided = pool.filter((v) => !(p.avoid || []).some((re) => re.test(v.name)));
  // a named favourite wins, the most natural build of it first ("Samantha (Enhanced)" over "Samantha")
  for (const re of p.prefer) {
    const hit = notAvoided.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  if (presetId === "auto") return pool[0] || null;
  return inLang.length ? (notAvoided[0] || inLang[0]) : null;
}

/**
 * createSpeech({ lang, rate, isStale, resolveAudio })
 *   resolveAudio(url) → Promise<objectUrl|null>: how a clip's URL becomes something <audio> can
 *   play (the cache-aware loader in audioCache.js). Without it, everything uses the phone voice.
 */
export function createSpeech({ lang = "en-US", rate = 1.0, isStale = () => false, resolveAudio = null } = {}) {
  const synth = globalThis.speechSynthesis;
  const player = resolveAudio && globalThis.Audio ? new globalThis.Audio() : null;
  if (player) { player.preload = "auto"; player.setAttribute?.("playsinline", ""); }
  const listeners = { start: new Set(), chunk: new Set(), end: new Set(), voices: new Set(), pause: new Set(), resume: new Set() };
  const keep = []; // strong references to utterances
  let queue = [];
  let current = null;   // { item, chunks, index, utter, audio: null | { url, pending }, audioTime }
  let paused = null;    // narration a turn prompt cut into; resumes (from that sentence / second) when the prompt ends
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

  /** Call synchronously from a tap handler. Speaks a short line to prime the engine and primes the audio element. */
  function unlock(text = "Starting tour.") {
    if (player) {
      try { player.src = SILENT_WAV; player.play().then(() => player.pause()).catch(() => {}); } catch { /* ignore */ }
    }
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

  // ---------- phone voice ----------

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

  // ---------- recorded clip ----------

  function detachPlayer() {
    if (!player) return;
    player.onended = player.onerror = player.ontimeupdate = player.onloadedmetadata = null;
    try { player.pause(); } catch { /* ignore */ }
  }
  function attachPlayer(cur) {
    player.onended = () => { if (current === cur) finish(false); };
    player.onerror = () => { if (current === cur) fallbackToPhone(cur); };
    player.ontimeupdate = () => {
      if (current !== cur || !Number.isFinite(player.duration) || !player.duration) return;
      const idx = Math.min(cur.chunks.length - 1, Math.floor((player.currentTime / player.duration) * cur.chunks.length));
      if (idx !== cur.index) { cur.index = idx; emit("chunk", { item: cur.item, index: idx, total: cur.chunks.length, text: cur.chunks[idx] }); }
    };
  }
  function fallbackToPhone(cur) {
    detachPlayer();
    cur.audio = null;
    speakChunk();
  }
  /** Load and play the clip for `cur` (from a fraction of its length, for un-mute). Falls back to the phone voice on any failure. */
  async function playAudio(cur, fromFrac = 0) {
    let obj = null;
    try { obj = await resolveAudio(cur.audio.url); } catch { obj = null; }
    if (current !== cur) return; // superseded while loading
    if (!obj) return fallbackToPhone(cur);
    cur.audio.pending = false;
    attachPlayer(cur);
    emit("chunk", { item: cur.item, index: cur.index, total: cur.chunks.length, text: cur.chunks[cur.index] });
    try {
      if (player.src !== obj) player.src = obj;
      const seek = () => { if (fromFrac > 0 && Number.isFinite(player.duration) && player.duration > 0) { try { player.currentTime = fromFrac * player.duration; } catch { /* ignore */ } } };
      if (Number.isFinite(player.duration) && player.duration > 0) seek(); else player.onloadedmetadata = seek;
      await player.play();
    } catch {
      if (current === cur) fallbackToPhone(cur);
    }
  }
  async function resumeAudio(cur) {
    attachPlayer(cur);
    try { await player.play(); } catch { if (current === cur) fallbackToPhone(cur); }
  }
  /** Stop whatever is sounding right now (both engines). */
  function halt() {
    synth?.cancel();
    clearTimeout(watchdog);
    detachPlayer();
  }

  // ---------- queue ----------

  function finish(interrupted) {
    clearTimeout(watchdog);
    detachPlayer();
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
        if (p.audio && !p.audio.pending) resumeAudio(p);
        else if (p.audio) playAudio(p);
        else speakChunk();
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
    current = { item, chunks: chunkText(item.text), index: 0, utter: null, audio: null };
    emit("start", { item });
    if (item.audio?.url && player && !muted) {
      current.audio = { url: item.audio.url, pending: true };
      playAudio(current);
    } else speakChunk();
  }

  /**
   * Queue narration. Stops interrupt drive-bys and previews; everything else waits its turn.
   * Turn prompts are special. A newer one replaces any pending or playing one (a stale
   * "in 200 feet" is worse than silence). One flagged `interrupt` (the turn prompts themselves)
   * pauses whatever narration is playing, speaks, and the narration resumes from the sentence
   * (or second) it was on. One without the flag (reassurance, "back on the route") is dropped
   * while narration plays: the banner still shows the turn.
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
        // pause the story (clip: where it is; phone voice: at this sentence), speak the prompt, resume in finish()
        halt();
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
      halt();
      const dropped = current;
      current = null;
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
    halt();
    finish(true);
  }

  function replay() {
    const item = current?.item || lastItem;
    if (!item) return;
    halt();
    current = null;
    queue.unshift(item);
    next();
  }

  function setMuted(on) {
    muted = on;
    if (!current) return;
    halt();
    if (on) {
      current.audio = null; // the silent timer keeps the story's timing from this sentence on
      speakChunk();
    } else if (current.item.audio?.url && player) {
      const frac = current.chunks.length ? current.index / current.chunks.length : 0;
      current.audio = { url: current.item.audio.url, pending: true };
      playAudio(current, frac);
    } else speakChunk();
  }

  /** After the page comes back to the foreground the synth may be wedged: restart current item. */
  function recoverAfterResume() {
    if (current?.audio && !current.audio.pending) { resumeAudio(current); return; }
    if (!synth) return;
    synth.cancel();
    clearTimeout(watchdog);
    if (current) { current.index = 0; speakChunk(); }
    else next();
  }

  function stop() {
    halt();
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
    /** "clip" while a recorded story is playing, "phone" otherwise. */
    get narrator() { return current?.audio && !current.audio.pending ? "clip" : "phone"; },
    get canPlayClips() { return Boolean(player); },
    get muted() { return muted; },
    get supported() { return Boolean(synth) || Boolean(player); },
    get unlocked() { return unlocked; },
    get queueLength() { return queue.length; },
    chunkText,
  };
}
