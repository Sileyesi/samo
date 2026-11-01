// Toolbar buttons (back / forward / reload-stop / downloads / menu) and inline toasts.
import { icon } from "./icons.js";
import { $, dur, fade, safeCall, shortcut } from "./util.js";

const RING_C = 2 * Math.PI * 13;

export class Toolbar {
  constructor(app) {
    this.app = app;
    this.samo = app.samo;
    this.back = $("btn-back");
    this.fwd = $("btn-forward");
    this.reload = $("btn-reload");
    this.dl = $("btn-downloads");
    this.menu = $("btn-menu");
    this.downloads = new Map();
    this.c = {};
    this.bind();
  }

  titles() {
    this.back.title = `Back (${shortcut("back")})`;
    this.fwd.title = `Forward (${shortcut("forward")})`;
    this.dl.title = `Downloads (${shortcut("downloads")})`;
    this.menu.title = "Menu";
    $("newtab-btn").title = `New tab (${shortcut("new-tab")})`;
    this.c.loading = undefined;
    this.sync();
  }

  sync() {
    const t = this.app.activeTab();
    const back = !!t?.canBack, fwd = !!t?.canForward, loading = !!t?.loading;
    if (this.c.back !== back) { this.c.back = back; this.back.disabled = !back; }
    if (this.c.fwd !== fwd) { this.c.fwd = fwd; this.fwd.disabled = !fwd; }
    if (this.c.loading !== loading) {
      this.c.loading = loading;
      this.reload.toggleAttribute("data-loading", loading);
      this.reload.setAttribute("aria-label", loading ? "Stop" : "Reload");
      this.reload.title = loading ? "Stop loading (Esc)" : `Reload (${shortcut("reload")})`;
    }
  }

  bind() {
    const v = this.samo;
    const id = () => this.app.activeTab()?.id;
    this.back.addEventListener("click", () => safeCall(v, "nav.back", { id: id() }));
    this.fwd.addEventListener("click", () => safeCall(v, "nav.forward", { id: id() }));
    this.reload.addEventListener("click", (e) => {
      if (this.app.activeTab()?.loading) safeCall(v, "nav.stop", { id: id() });
      else safeCall(v, e.shiftKey || e.ctrlKey ? "nav.reloadHard" : "nav.reload", { id: id() });
    });
    this.dl.addEventListener("click", () => safeCall(v, "app.action", { action: "downloads" }));
    this.menu.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (this.app.popup.is("menu")) { this.app.popup.hide("menu"); this.menuJustClosed = true; }
    });
    this.menu.addEventListener("click", () => {
      if (this.menuJustClosed) { this.menuJustClosed = false; return; }
      this.app.commands.appMenu();
    });
    v.on("download:updated", (d) => this.onDownload(d));
  }

  // ---- Downloads ------------------------------------------------------------------
  seedDownloads(items) {
    for (const d of items || []) this.downloads.set(d.id, d);
    this.renderDownloads();
  }

  onDownload(d) {
    if (!d || d.id == null) return;
    const prev = this.downloads.get(d.id);
    this.downloads.set(d.id, d);
    this.renderDownloads();
    if (d.state === "complete" && prev?.state !== "complete") {
      this.app.toast(`Downloaded ${d.name || "file"}`);
      this.dl.animate(
        [{ scale: 1 }, { scale: 1.18 }, { scale: 1 }],
        { duration: Math.max(dur(360), fade(1)), easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      );
    } else if (d.state === "interrupted" && prev?.state !== "interrupted") {
      this.app.toast(`Download failed: ${d.name || "file"}`, "error");
    }
  }

  renderDownloads() {
    const all = [...this.downloads.values()];
    const wasHidden = this.dl.hidden;
    this.dl.hidden = all.length === 0;
    if (wasHidden && !this.dl.hidden) {
      this.dl.animate([{ opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1 }],
        { duration: Math.max(dur(250), fade(100)), easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    }
    const active = all.filter((d) => d.state === "progress");
    let total = 0, got = 0;
    for (const d of active) { if (d.total > 0) { total += d.total; got += d.received || 0; } }
    const state = active.length ? (total ? "progress" : "indeterminate") : "idle";
    this.dl.dataset.state = state;
    const p = total ? Math.min(1, got / total) : 0.25;
    this.dl.querySelector(".samo-ring-value").style.strokeDashoffset = String(RING_C * (1 - p));
    this.dl.setAttribute("aria-label", active.length ? `Downloads, ${active.length} in progress` : "Downloads");
  }

  // ---- Toasts -----------------------------------------------------------------------
  toast(text, kind = "info", ms) {
    const host = $("toast-host");
    for (const old of host.children) this.dismissToast(old, true);
    const el = document.createElement("div");
    el.className = "samo-toast";
    el.dataset.kind = kind;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = `<span class="samo-toast-icon">${icon(kind === "error" ? "x" : "sparkles", 14)}</span><span class="samo-toast-text"></span>`;
    el.lastChild.textContent = text;
    host.append(el);
    el.animate(
      [{ opacity: 0, transform: "translateX(10px) scale(0.96)" }, { opacity: 1, transform: "none" }],
      { duration: Math.max(dur(420), fade(100)), easing: "linear(0, 0.34 12%, 0.7 24%, 0.93 38%, 1.03 55%, 1)" },
    );
    const life = ms ?? Math.min(2500, Math.max(1500, 900 + text.length * 30));
    el._t = setTimeout(() => this.dismissToast(el), life);
  }

  dismissToast(el, fast = false) {
    clearTimeout(el._t);
    if (el._gone) return;
    el._gone = true;
    const a = el.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(6px) scale(0.98)" }],
      { duration: fade(fast ? 90 : 150), easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    a.finished.then(() => el.remove(), () => el.remove());
  }
}
