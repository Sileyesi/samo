// Shared runtime for Samo internal pages (samo://newtab, settings, history, downloads).
import { samo } from "samo://ui/shared/bridge.js";
import { icon } from "samo://ui/shared/icons.js";
import { t, translateDom, lang, locale } from "./i18n.js";

export { samo, icon, t, lang, locale };

export const DEV = location.protocol !== "samo:";

/** Resolve a samo:// resource URL (theme css etc.) — identity inside Samo. */
export function samoUrl(url) {
  return DEV && window.__samoDevRewrite ? window.__samoDevRewrite(url) : url;
}

// ---- Accent override (config ui.accent = "#rrggbb") -------------------------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function readableOn(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#000";
  const L = relLum(rgb);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? "#ffffff" : "#000000";
}

export function applyAccent(cfg) {
  const root = document.documentElement;
  const accent = cfg?.ui?.accent;
  if (typeof accent === "string" && /^#[0-9a-f]{6}$/i.test(accent)) {
    root.style.setProperty("--samo-accent", accent);
    root.style.setProperty("--samo-accent-fg", readableOn(accent));
    root.style.setProperty("--samo-accent-text", accent);
    root.style.removeProperty("--samo-accent-hover");
  } else {
    for (const p of ["--samo-accent", "--samo-accent-fg", "--samo-accent-text"]) root.style.removeProperty(p);
  }
}

/**
 * Boot a page: localize the DOM, fetch config, apply it (bridge writes data-* attrs),
 * and keep the accent in sync on config:changed. Resolves to the config.get result.
 */
export async function boot(titleKey) {
  document.documentElement.lang = lang;
  if (titleKey) document.title = t(titleKey);
  translateDom();
  samo.on("config:changed", (p) => applyAccent(p.config));
  let res = { config: null, path: "", defaults: null };
  try {
    res = await samo.call("config.get");
    samo.applyConfig(res.config);
    applyAccent(res.config);
  } catch (e) {
    console.error("[samo] config.get failed", e);
  }
  // Enable transitions only after first paint so nothing animates on load.
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add("is-ready")));
  return res;
}

// ---- DOM helpers ----------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h("div", {class: "x", onclick}, child, "text", [children]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Element from an icon name. */
export function ic(name, size = 16, cls) {
  const tpl = document.createElement("template");
  tpl.innerHTML = icon(name, size, cls ? { class: cls } : undefined);
  return tpl.content.firstElementChild;
}

export function debounce(fn, ms) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}

// ---- Formatting -----------------------------------------------------------------
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** history timestamps may be seconds or ms — normalize to ms. */
export const toMs = (ts) => (ts && ts < 1e12 ? ts * 1000 : ts || 0);

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return lang === "ru" ? "0 Б" : "0 B";
  const units = lang === "ru" ? ["Б", "КБ", "МБ", "ГБ", "ТБ"] : ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toLocaleString(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const ru = lang === "ru";
  if (sec < 60) return ru ? `${sec} с` : `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return ru ? `${m} мин ${s ? s + " с" : ""}`.trim() : `${m}m ${s ? s + "s" : ""}`.trim();
  const hh = Math.floor(m / 60), mm = m % 60;
  return ru ? `${hh} ч ${mm} мин` : `${hh}h ${mm}m`;
}

// ---- Search engine display names ---------------------------------------------------------
const ENGINE_NAMES = { duckduckgo: "DuckDuckGo", google: "Google", brave: "Brave Search", bing: "Bing", yandex: lang === "ru" ? "Яндекс" : "Yandex",
  kagi: "Kagi", startpage: "Startpage", ecosia: "Ecosia", qwant: "Qwant", searxng: "SearXNG", perplexity: "Perplexity", wikipedia: "Wikipedia" };
export function engineName(id) {
  return ENGINE_NAMES[id] || String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Letter avatars + favicons -------------------------------------------------------
const AVATAR_VARS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "cyan"];
export function avatarColor(seed) {
  let hsh = 0;
  for (const ch of seed) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  return `var(--samo-group-${AVATAR_VARS[Math.abs(hsh) % AVATAR_VARS.length]})`;
}

/**
 * A favicon element: tries https://<host>/favicon.ico (or given src), falls back to a
 * colored letter avatar. `size` is the box size in px.
 */
export function favicon(url, { size = 16, src = null, cls = "" } = {}) {
  const host = hostOf(url);
  const letter = (host.replace(/^(m|mobile)\./, "")[0] || "•").toUpperCase();
  const box = h("span", { class: `fav ${cls}`, style: { "--fav-size": `${size}px`, "--fav-color": avatarColor(host || url) } });
  const fallback = h("span", { class: "fav-letter", "aria-hidden": "true" }, letter);
  box.append(fallback);
  const href = src || (host && /^https?:/.test(url) ? `${new URL(url).origin}/favicon.ico` : null);
  if (href) {
    const img = h("img", { class: "fav-img", alt: "", width: size, height: size, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("load", () => {
      if (img.naturalWidth > 1) box.classList.add("has-img"); else img.remove();
    }, { once: true });
    img.addEventListener("error", () => img.remove(), { once: true });
    img.src = href;
    box.append(img);
  }
  return box;
}

// ---- Toast ---------------------------------------------------------------------------
let toastEl, toastTimer;
export function toast(text, kind = "info") {
  if (!toastEl) {
    toastEl = h("div", { class: "page-toast", role: "status", "aria-live": "polite" });
    document.body.append(toastEl);
  }
  toastEl.dataset.kind = kind;
  toastEl.replaceChildren(ic(kind === "error" ? "alert-triangle" : "check", 14), h("span", null, text));
  toastEl.classList.remove("is-shown");
  void toastEl.offsetWidth;
  toastEl.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), 1600);
}

// ---- Confirm dialog -------------------------------------------------------------------
export function confirmDialog({ title, body, ok, danger = false }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "page-dialog", "aria-labelledby": "dlg-title" },
      h("div", { class: "page-dialog__icon" + (danger ? " is-danger" : "") }, ic(danger ? "trash" : "info", 20)),
      h("h2", { id: "dlg-title", class: "page-dialog__title" }, title),
      body ? h("p", { class: "page-dialog__body" }, body) : null,
      h("div", { class: "page-dialog__actions" },
        h("button", { class: "samo-btn samo-btn--text samo-btn--subtle", value: "cancel", onclick: () => close(false) }, t("common.cancel")),
        h("button", { class: `samo-btn samo-btn--text samo-btn--primary${danger ? " samo-btn--danger" : ""}`, onclick: () => close(true) }, ok),
      ));
    const close = (v) => {
      dlg.classList.add("is-closing");
      const done = () => { dlg.close(); dlg.remove(); resolve(v); };
      const dur = parseFloat(getComputedStyle(dlg).getPropertyValue("--_exit")) || 0;
      setTimeout(done, Math.min(dur || 120, 200));
    };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(false); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) close(false); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector(".samo-btn--primary").focus();
  });
}

/** Keyboard list navigation helper: arrow keys move focus among `selector` items in `root`. */
export function arrowNav(root, selector, { columns = 1 } = {}) {
  root.addEventListener("keydown", (e) => {
    const items = $$(selector, root).filter((el) => el.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === "ArrowDown") j = i + columns;
    else if (e.key === "ArrowUp") j = i - columns;
    else if (e.key === "ArrowRight" && columns > 1) j = i + 1;
    else if (e.key === "ArrowLeft" && columns > 1) j = i - 1;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = items.length - 1;
    else return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, j))]?.focus();
  });
}
