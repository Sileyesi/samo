// Chrome height reporting (ui.layout) and compact mode (ANALYSIS §3.7, ARCHITECTURE §2).
import { $, root, dur, fade, raf, safeCall } from "./util.js";

const HOT_STRIP = 4;

export class Layout {
  constructor(app) {
    this.app = app;
    this.height = 0;
    this.sent = "";
  }

  measure() { return Math.ceil($("chrome").offsetHeight); }

  /** Report the current reserve/overlay to Rust (deduped). */
  async update() {
    const H = this.measure();
    this.height = H;
    const c = this.app.compact;
    const args = c?.enabled ? { reserve: 0, overlay: c.expanded ? H : HOT_STRIP } : { reserve: H, overlay: H };
    const key = `${args.reserve}|${args.overlay}`;
    if (key === this.sent) return;
    this.sent = key;
    await safeCall(this.app.samo, "ui.layout", args);
  }
}

export class Compact {
  constructor(app) {
    this.app = app;
    this.enabled = false;
    this.expanded = false;   // overlay is full height
    this.shown = false;      // chrome visible (or animating in)
    this.holds = new Set();
    this.pointerIn = false;
    this.hideT = 0;
    this.chrome = $("chrome");
    const de = document.documentElement;
    de.addEventListener("pointerenter", () => {
      this.pointerIn = true;
      clearTimeout(this.hideT);
      if (this.enabled && !this.shown) this.show();
    });
    de.addEventListener("pointerleave", () => {
      this.pointerIn = false;
      this.scheduleHide();
    });
  }

  get delay() { return this.app.state.config?.compact?.hide_delay_ms ?? 1000; }

  /** Apply the enabled flag (from config or a local toggle). */
  async set(on) {
    on = !!on;
    root.dataset.compact = String(on);
    if (on === this.enabled) return;
    this.enabled = on;
    clearTimeout(this.hideT);
    if (on) {
      // Keep the chrome floating over the page, then hide it unless the pointer is here.
      this.expanded = true;
      this.shown = true;
      root.dataset.compactShown = "true";
      await this.app.layout.update();
      this.scheduleHide(this.pointerIn ? this.delay : 600);
    } else {
      this.expanded = false;
      this.shown = true;
      root.dataset.compactShown = "true";
      delete root.dataset.compactAnim;
      await this.app.layout.update();
    }
  }

  toggle() {
    const on = !this.enabled;
    safeCall(this.app.samo, "compact.set", { enabled: on });
    this.set(on);
  }

  hold(key, on) {
    if (on) { this.holds.add(key); clearTimeout(this.hideT); }
    else if (this.holds.delete(key)) this.scheduleHide();
  }

  /** Make the chrome visible (e.g. urlbar focus, palette) — hides again per the usual rules. */
  reveal() {
    if (!this.enabled) return;
    clearTimeout(this.hideT);
    if (!this.shown) this.show();
    this.scheduleHide();
  }

  /** Keyboard tab switch / new tab: show briefly. */
  flash() {
    if (!this.enabled) return;
    if (!this.shown) this.show();
    this.scheduleHide(800);
  }

  async show() {
    if (!this.enabled) return;
    this.shown = true;
    clearTimeout(this.hideT);
    if (!this.expanded) {
      this.expanded = true;
      await this.app.layout.update();
      await raf();
      if (!this.shown) return;
    }
    root.dataset.compactAnim = "in";
    root.dataset.compactShown = "true";
  }

  scheduleHide(ms = this.delay) {
    clearTimeout(this.hideT);
    if (!this.enabled || !this.shown) return;
    this.hideT = setTimeout(() => this.hide(), ms);
  }

  async hide() {
    if (!this.enabled || !this.shown) return;
    if (this.holds.size || this.pointerIn) return;
    this.shown = false;
    root.dataset.compactAnim = "out";
    root.dataset.compactShown = "false";
    const d = Math.max(dur(150), fade(100));
    await new Promise((r) => setTimeout(r, d + 20));
    if (this.shown || !this.enabled) return;
    this.expanded = false;
    await this.app.layout.update();
  }
}
