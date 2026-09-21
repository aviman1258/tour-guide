// Global "working…" indicator: Deodap running in a pill, the current task label,
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
    <span class="busy-road" aria-hidden="true"><svg class="busy-deodap" viewBox="0 0 96 48" width="84" height="42">
      <g class="dust"><circle cx="14" cy="43" r="2.2"/><circle cx="8" cy="41" r="1.6"/></g>
      <g class="body-bob">
        <path class="tail" d="M23 24 q-7 3 -6 11" fill="none" stroke="#7c879a" stroke-width="2.4" stroke-linecap="round"/>
        <g class="leg back a"><rect x="27" y="32" width="7.5" height="14" rx="3.4" fill="#6f7a8d"/></g>
        <g class="leg front a"><rect x="49" y="32" width="7.5" height="14" rx="3.4" fill="#6f7a8d"/></g>
        <ellipse cx="44" cy="26" rx="22" ry="13.5" fill="#8a95a8"/>
        <g class="leg back b"><rect x="35" y="32" width="7.5" height="14" rx="3.4" fill="#7c879a"/></g>
        <g class="leg front b"><rect x="57" y="32" width="7.5" height="14" rx="3.4" fill="#7c879a"/></g>
        <g class="head">
          <circle cx="70" cy="20" r="12.5" fill="#98a3b4"/>
          <g class="ear"><ellipse cx="62" cy="19" rx="7.5" ry="9.5" fill="#7c879a"/><ellipse cx="62.5" cy="19.5" rx="4.8" ry="6.6" fill="#eaa3b5"/><circle cx="61" cy="17" r=".8" fill="#6b5560" opacity=".6"/><circle cx="63.5" cy="21.5" r=".7" fill="#6b5560" opacity=".6"/></g>
          <path d="M64 11 Q70 7 76 11" stroke="#e0b64c" stroke-width="1.2" fill="none"/>
          <g fill="#f7b731"><circle cx="65" cy="10.8" r="1.5"/><circle cx="70" cy="8.6" r="1.6"/><circle cx="75" cy="10.8" r="1.5"/></g>
          <circle cx="75" cy="18" r="1.9" fill="#2b2f36"/><circle cx="75.7" cy="17.3" r=".7" fill="#fff"/>
          <circle cx="72" cy="24" r="2" fill="#f2a9bb" opacity=".45"/>
          <path class="trunk" d="M80 23 C 86 26, 88 32, 84 39" fill="none" stroke="#7c879a" stroke-width="5.5" stroke-linecap="round"/>
        </g>
      </g>
    </svg></span>
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
