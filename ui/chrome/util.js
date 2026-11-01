// Small shared helpers for the chrome: DOM, motion timing, misc.
export const root = document.documentElement;
export const $ = (id) => document.getElementById(id);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- Motion -----------------------------------------------------------------
// Every duration goes through dur(): multiplied by --samo-anim-speed, zero under reduced
// motion (fades are kept, capped at 100ms, per ANALYSIS §3.3).
const mq = matchMedia("(prefers-reduced-motion: reduce)");
let speed = 1;
let reduced = mq.matches;

export function refreshMotion() {
  const s = parseFloat(root.style.getPropertyValue("--samo-anim-speed") ||
    getComputedStyle(root).getPropertyValue("--samo-anim-speed"));
  speed = Number.isFinite(s) && s >= 0 ? s : 1;
  reduced = root.dataset.reduceMotion === "true" || mq.matches;
}
mq.addEventListener?.("change", refreshMotion);

export const motion = {
  get reduced() { return reduced; },
  get speed() { return speed; },
};

/** Movement duration (0 under reduced motion). */
export const dur = (ms) => (reduced ? 0 : Math.round(ms * speed));
/** Fade duration (kept under reduced motion, capped at 100ms). */
export const fade = (ms) => Math.round((reduced ? Math.min(ms, 100) : ms) * speed);

// Easing strings usable in inline `transition` (var() resolves against the theme).
export const EASE = {
  standard: "var(--samo-ease-standard, cubic-bezier(0.2, 0.8, 0.2, 1))",
  emphasized: "var(--samo-ease-emphasized, cubic-bezier(0.22, 1, 0.36, 1))",
  snap: "var(--samo-ease-snap, cubic-bezier(0.07, 0.95, 0, 1))",
  exit: "var(--samo-ease-exit, cubic-bezier(0.4, 0, 1, 1))",
  spring: "var(--samo-ease-spring, linear(0, 0.34 12%, 0.7 24%, 0.93 38%, 1.03 55%, 1))",
};

export const raf = () => new Promise((r) => requestAnimationFrame(r));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a CSS length custom property (px) from :root with a fallback. */
export function cssPx(name, fallback) {
  const v = parseFloat(getComputedStyle(root).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Fire-and-forget bridge call that logs failures instead of throwing. */
export function safeCall(samo, cmd, args) {
  return samo.call(cmd, args).catch((e) => { console.warn(`[samo] ${cmd} failed`, e); return null; });
}

// ---- URL helpers ------------------------------------------------------------
export function isInternal(url) { return typeof url === "string" && url.startsWith("samo:"); }
export function isNewTabUrl(url, cfg) {
  if (!url || url === "about:blank") return true;
  const nt = cfg?.general?.newtab_url || "samo://newtab/";
  const strip = (u) => u.replace(/\/+$/, "");
  return strip(url) === strip(nt) || strip(url) === "samo://newtab";
}

// ---- Shortcut labels ----------------------------------------------------------
// Defaults (ANALYSIS §5); replaced by `keys.list` when Rust provides it.
const DEFAULT_KEYS = {
  "new-tab": "Ctrl+T", "new-window": "Ctrl+N", "close-tab": "Ctrl+W", "reopen-closed-tab": "Ctrl+Shift+T",
  "back": "Alt+Left", "forward": "Alt+Right", "reload": "Ctrl+R", "hard-reload": "Ctrl+Shift+R",
  "focus-urlbar": "Ctrl+L", "command-palette": "Ctrl+K", "search-tabs": "Ctrl+Shift+A",
  "find": "Ctrl+F", "history": "Ctrl+H", "downloads": "Ctrl+J", "bookmark": "Ctrl+D",
  "zoom-in": "Ctrl+Plus", "zoom-out": "Ctrl+Minus", "zoom-reset": "Ctrl+0", "fullscreen": "F11",
  "devtools": "F12", "settings": "Ctrl+,", "quit": "Ctrl+Q", "toggle-compact": "Ctrl+Alt+C",
  "copy-url": "Ctrl+Shift+C", "copy-url-markdown": "Ctrl+Alt+Shift+C", "pin-tab": "Ctrl+Shift+D",
  "mute-tab": "Ctrl+M", "duplicate-tab": "Ctrl+Shift+X", "split-vertical": "Ctrl+Alt+V",
  "split-horizontal": "Ctrl+Alt+H", "unsplit": "Ctrl+Alt+U", "reload-theme": "Ctrl+Alt+R",
  "close-window": "Ctrl+Shift+W",
};
const keys = { ...DEFAULT_KEYS };

function prettyAccel(a) {
  const map = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "Super", plus: "Plus", minus: "Minus",
    comma: ",", period: ".", escape: "Esc", enter: "Enter", left: "Left", right: "Right", up: "Up",
    down: "Down", pageup: "PgUp", pagedown: "PgDn", space: "Space", delete: "Del", backspace: "Backspace" };
  return String(a).split("+").map((p) => map[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p.toUpperCase())).join("+");
}

export function setKeys(items) {
  for (const it of items || []) {
    const accel = Array.isArray(it.accel) ? it.accel[0] : it.accel;
    if (it.action && accel) keys[it.action] = prettyAccel(accel);
  }
}
export const shortcut = (action) => keys[action] || "";
