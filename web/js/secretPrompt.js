// Masked replacement for window.prompt() when asking for a passphrase or password.
// askSecret({ title, label, submit }) → Promise<string | null> (null on Cancel / Escape).
// Self-contained: builds a <dialog> and injects its own styles so every page can use it.

let styled = false;
function ensureStyles() {
  if (styled) return;
  styled = true;
  const css = `
    dialog.secret { border: 1px solid var(--line, #d7dbe0); border-radius: var(--radius, 12px); padding: 0; max-width: min(92vw, 380px); width: 100%;
      background: var(--card, #fff); color: inherit; box-shadow: 0 18px 50px rgba(0,0,0,.25); }
    dialog.secret::backdrop { background: rgba(10, 20, 30, .45); }
    dialog.secret form { display: grid; gap: 12px; padding: 18px; margin: 0; }
    dialog.secret h2 { margin: 0; font-size: 17px; }
    dialog.secret label { display: grid; gap: 6px; font-size: 13px; color: var(--muted, #5a6572); }
    dialog.secret .row { display: flex; gap: 8px; }
    dialog.secret input { flex: 1; min-width: 0; font: inherit; font-size: 16px; padding: 10px 12px; border: 1px solid var(--line, #d7dbe0); border-radius: 8px; background: transparent; color: inherit; }
    dialog.secret .actions { display: flex; justify-content: flex-end; gap: 8px; }
    dialog.secret .actions button { font: inherit; font-size: 14px; padding: 9px 14px; border-radius: 8px; border: 1px solid var(--line, #d7dbe0); background: transparent; color: inherit; cursor: pointer; min-height: 40px; }
    dialog.secret .actions button.primary { background: var(--accent, #1f5f8b); border-color: var(--accent, #1f5f8b); color: var(--accent-text, #fff); font-weight: 600; }
    dialog.secret .eye { font: inherit; font-size: 13px; padding: 0 10px; border: 1px solid var(--line, #d7dbe0); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

export function askSecret({ title = "Passphrase", label = "Enter the passphrase", submit = "Continue" } = {}) {
  ensureStyles();
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "secret";
    dlg.innerHTML = `
      <form method="dialog">
        <h2></h2>
        <label><span></span>
          <span class="row"><input type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required /><button type="button" class="eye" aria-label="Show passphrase">Show</button></span>
        </label>
        <div class="actions"><button type="button" class="cancel">Cancel</button><button type="submit" class="primary"></button></div>
      </form>`;
    dlg.querySelector("h2").textContent = title;
    dlg.querySelector("label > span").textContent = label;
    dlg.querySelector(".primary").textContent = submit;
    const input = dlg.querySelector("input");
    const eye = dlg.querySelector(".eye");
    eye.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.textContent = show ? "Hide" : "Show";
      eye.setAttribute("aria-label", show ? "Hide passphrase" : "Show passphrase");
      input.focus();
    });
    let result = null;
    dlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); result = input.value.trim() || null; dlg.close(); });
    dlg.querySelector(".cancel").addEventListener("click", () => { result = null; dlg.close(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else { // very old browser: fall back to the plain prompt rather than lock the user out
      dlg.remove();
      resolve((window.prompt(label, "") || "").trim() || null);
      return;
    }
    input.focus();
  });
}
