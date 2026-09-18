// Global "working…" indicator: a little car driving in a pill, the current task label,
// and an elapsed timer. Several tasks can overlap; the timer runs from the first one.

const tasks = new Map();
let el = null, timer = null, startedAt = 0, seq = 0;

function ensure() {
  if (el) return el;
  el = document.createElement("div");
  el.id = "busy";
  el.className = "busy-pill";
  el.hidden = true;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `<span class="busy-road"><span class="busy-car">🚗</span></span><span class="busy-label"></span><span class="busy-time">0:00</span>`;
  document.body.appendChild(el);
  return el;
}

function render() {
  ensure();
  if (!tasks.size) {
    el.hidden = true;
    clearInterval(timer);
    timer = null;
    return;
  }
  const labels = [...tasks.values()];
  el.querySelector(".busy-label").textContent = labels.length === 1 ? labels[0] : `${labels[labels.length - 1]} (+${labels.length - 1})`;
  el.hidden = false;
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  ensure().querySelector(".busy-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Mark a task as running. Returns a function to call when it finishes. */
export function begin(label = "Working…") {
  const id = ++seq;
  if (!tasks.size) {
    startedAt = Date.now();
    tick();
    timer = setInterval(tick, 1000);
  }
  tasks.set(id, label);
  render();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    tasks.delete(id);
    render();
  };
}

/** Run an async fn under a busy label. */
export async function run(label, fn) {
  const end = begin(label);
  try {
    return await fn();
  } finally {
    end();
  }
}

export const isBusy = () => tasks.size > 0;
