// Find bar: third chrome row, slides in under the toolbar.
import { $, dur, fade, debounce, safeCall } from "./util.js";

export class FindBar {
  constructor(app) {
    this.app = app;
    this.samo = app.samo;
    this.el = $("findbar");
    this.input = $("find-input");
    this.count = $("find-count");
    this.caseBtn = $("find-case");
    this.isOpen = false;
    this.matchCase = false;
    this.result = null;
    this.search = debounce(() => this.start(false, true), 60);
    this.bind();
    app.samo.on("find:result", (r) => this.onResult(r));
  }

  async open() {
    this.app.compact.reveal();
    this.app.compact.hold("find", true);
    if (this.isOpen) { this.focus(); return; }
    this.isOpen = true;
    const el = this.el;
    el.hidden = false;
    el.getAnimations().forEach((a) => a.cancel());
    await this.app.layout.update();
    const d = dur(200);
    el.animate(
      [{ transform: "translateY(-100%)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: Math.max(d, fade(120)), easing: d ? "cubic-bezier(0.22, 1, 0.36, 1)" : "linear" },
    );
    this.focus();
    if (this.input.value) this.start(true, true);
  }

  focus() { this.input.focus(); this.input.select(); }

  async close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.search.cancel();
    safeCall(this.samo, "find.stop", { clear: true });
    const el = this.el;
    const a = el.animate(
      [{ transform: "none", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }],
      { duration: Math.max(dur(140), fade(90)), easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    try { await a.finished; } catch { /* cancelled */ }
    if (this.isOpen) return;
    a.cancel();
    el.hidden = true;
    this.result = null;
    this.render();
    this.app.compact.hold("find", false);
    await this.app.layout.update();
  }

  start(findNext, forward = true) {
    const text = this.input.value;
    if (!text) {
      safeCall(this.samo, "find.stop", { clear: true });
      this.result = null;
      this.render();
      return;
    }
    safeCall(this.samo, "find.start", { text, forward, matchCase: this.matchCase, findNext });
  }

  step(forward) {
    if (!this.isOpen) { this.open(); return; }
    this.start(true, forward);
  }

  onResult(r) {
    this.result = r;
    this.render();
  }

  render() {
    const r = this.result, has = !!this.input.value;
    if (!has || !r) { this.count.textContent = ""; this.el.removeAttribute("data-nomatch"); return; }
    this.count.textContent = !r.count ? "0/0" : r.active ? `${r.active}/${r.count}` : `${r.count}`;
    this.el.toggleAttribute("data-nomatch", !!r.final && !r.count);
  }

  bind() {
    this.input.addEventListener("input", () => { this.result = null; this.render(); this.search(); });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.search.cancel(); this.start(true, !e.shiftKey); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    $("find-next").addEventListener("click", () => this.start(true, true));
    $("find-prev").addEventListener("click", () => this.start(true, false));
    $("find-close").addEventListener("click", () => this.close());
    this.caseBtn.addEventListener("click", () => {
      this.matchCase = !this.matchCase;
      this.caseBtn.setAttribute("aria-pressed", String(this.matchCase));
      this.start(false, true);
    });
    $("find-next").title = "Next match (Enter)";
    $("find-prev").title = "Previous match (Shift+Enter)";
    $("find-close").title = "Close (Esc)";
    this.caseBtn.title = "Match case";
  }
}
