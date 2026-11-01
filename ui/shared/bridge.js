// Samo JS <-> Rust bridge. FROZEN contract — see docs/ARCHITECTURE.md §4, §8.
// Usage: import { samo } from "samo://ui/shared/bridge.js";

const listeners = new Map();

function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) {
    try { fn(payload); } catch (e) { console.error(`[samo] listener for ${event} failed`, e); }
  }
  const any = listeners.get("*");
  if (any) for (const fn of [...any]) {
    try { fn(event, payload); } catch (e) { console.error("[samo] wildcard listener failed", e); }
  }
}

// Rust calls: window.__samoDispatch("event", {payload})
window.__samoDispatch = (event, payload) => emit(event, payload);

async function call(cmd, args = {}) {
  // Dev harness outside Samo (file:// or http://) may install a mock: window.__samoMock(cmd, args).
  if (window.__samoMock) return window.__samoMock(cmd, args);
  // text/plain keeps it a CORS "simple request" (no preflight).
  const res = await fetch(`samo://api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${cmd}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

// ---- Theme hot reload -------------------------------------------------------
function reloadLink(id) {
  const old = document.getElementById(id);
  if (!old) return;
  const base = old.getAttribute("href").split("?")[0];
  const next = old.cloneNode();
  next.href = `${base}?t=${Date.now()}`;
  // Swap after load to avoid a flash of unstyled chrome.
  next.addEventListener("load", () => old.remove(), { once: true });
  next.addEventListener("error", () => old.remove(), { once: true });
  old.after(next);
}

function reloadTheme() {
  reloadLink("samo-theme");
  reloadLink("samo-user");
}

// ---- Config -> <html> attributes -------------------------------------------
let config = null;

function applyConfig(cfg) {
  if (!cfg) return;
  config = cfg;
  const root = document.documentElement;
  const ui = cfg.ui || {}, tabs = cfg.tabs || {}, compact = cfg.compact || {};
  root.dataset.density = ui.density || "normal";
  root.dataset.reduceMotion = String(!!ui.reduce_motion);
  root.dataset.indicator = tabs.indicator || "card";
  root.dataset.closeButton = tabs.close_button || "hover";
  root.dataset.compact = String(!!compact.enabled);
  root.dataset.windowControls = ui.window_controls || "right";
  root.style.setProperty("--samo-anim-speed", String(ui.animation_speed ?? 1));
  if (ui.font_ui) root.style.setProperty("--samo-font-ui", ui.font_ui);
  else root.style.removeProperty("--samo-font-ui");
  if (tabs.max_width) root.style.setProperty("--samo-tab-max-width", `${tabs.max_width}px`);
  if (tabs.min_width) root.style.setProperty("--samo-tab-min-width", `${tabs.min_width}px`);
  root.style.setProperty("--samo-content-inset", `${ui.content_inset ?? 0}px`);
  emit("config:applied", cfg);
}

on("theme:changed", reloadTheme);
on("config:changed", (p) => { applyConfig(p.config); reloadTheme(); });

export const samo = {
  call,
  on,
  get config() { return config; },
  applyConfig,
  reloadTheme,
};

window.samo = samo;
