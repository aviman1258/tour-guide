// Global "working…" indicator: a little car driving in a pill, the current task label,
// an elapsed timer, an estimate + progress bar when we have one, and a Cancel button
// when the running task can be cancelled. Several tasks can overlap.

const tasks = new Map(); // id → { label, onCancel, estimateMs, startedAt }
let el = null, timer = null, startedAt = 0, seq = 0;

function ensure() {
  if (el) return el;
  el = document.createElement("div");
  el.id = "busy";
  el.className = "busy-pill";
  el.hidden = true;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <span class="busy-road"><span class="busy-car">🚗</span></span>
    <span class="busy-text"><span class="busy-label"></span><span class="busy-time">0:00</span></span>
    <button type="button" class="busy-cancel" hidden>Cancel</button>
    <span class="busy-bar" hidden><span class="busy-fill"></span></span>`;
  el.querySelector(".busy-cancel").addEventListener("click", () => {
    for (const t of [...tasks.values()]) t.onCancel?.();
  });
  document.body.appendChild(el);
  return el;
}

const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function render() {
  ensure();
  if (!tasks.size) {
    el.hidden = true;
    clearInterval(timer);
    timer = null;
    return;
  }
  const list = [...tasks.values()];
  const labels = list.map((t) => t.label);
  el.querySelector(".busy-label").textContent = labels.length === 1 ? labels[0] : `${labels[labels.length - 1]} (+${labels.length - 1})`;
  el.querySelector(".busy-cancel").hidden = !list.some((t) => t.onCancel);
  el.hidden = false;
  tick();
}

function tick() {
  ensure();
  const est = [...tasks.values()].find((t) => t.estimateMs);
  const now = Date.now();
  const elapsed = now - (est?.startedAt || startedAt);
  const time = el.querySelector(".busy-time");
  const bar = el.querySelector(".busy-bar");
  if (est) {
    const remaining = est.estimateMs - elapsed;
    time.textContent = remaining > 0 ? `${fmt(elapsed)} · about ${fmt(remaining)} left` : `${fmt(elapsed)} · running longer than usual`;
    bar.hidden = false;
    el.querySelector(".busy-fill").style.width = `${Math.min(100, Math.round((elapsed / est.estimateMs) * 100))}%`;
    el.classList.toggle("overdue", remaining <= 0);
  } else {
    time.textContent = fmt(elapsed);
    bar.hidden = true;
    el.classList.remove("overdue");
  }
}

/**
 * Mark a task as running. Options: { onCancel, estimateMs, startedAt }.
 * Returns a handle: call it (or .done()) when finished; .update({label, estimateMs}) to refine.
 */
export function begin(label = "Working…", { onCancel, estimateMs, startedAt: t0 } = {}) {
  const id = ++seq;
  if (!tasks.size) {
    startedAt = t0 || Date.now();
    timer = setInterval(tick, 1000);
  }
  tasks.set(id, { label, onCancel, estimateMs: estimateMs || null, startedAt: t0 || Date.now() });
  render();
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    tasks.delete(id);
    render();
  };
  done.done = done;
  done.update = (patch) => {
    const t = tasks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    render();
  };
  return done;
}

/** Run an async fn under a busy label. */
export async function run(label, fn, opts) {
  const end = begin(label, opts);
  try {
    return await fn();
  } finally {
    end();
  }
}

export const isBusy = () => tasks.size > 0;
