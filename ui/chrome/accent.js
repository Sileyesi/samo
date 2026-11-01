// Page accent (ANALYSIS §3.10): tint the tab strip + toolbar with the active tab's theme
// color, normalised in OKLCH to the theme's lightness band so text contrast holds.
import { root } from "./util.js";

let probe = null;

/** Parse any CSS color into sRGB [r,g,b] in 0..1 (null if unknown). */
export function parseColor(str) {
  if (!str) return null;
  str = String(str).trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(str);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(str);
  if (m) return [m[1], m[2], m[3]].map((v) => +v / 255);
  m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(str);
  if (m) return oklchToSrgb(m[2] ? +m[1] / 100 : +m[1], +m[3], +m[4]);
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(str);
  if (m) return [+m[1], +m[2], +m[3]];
  // Let the engine normalise named / hsl colors.
  if (!probe) { probe = document.createElement("i"); probe.style.display = "none"; document.body.append(probe); }
  probe.style.color = "";
  probe.style.color = str;
  if (!probe.style.color) return null;
  const c = getComputedStyle(probe).color;
  return c === str ? null : parseColor(c);
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function srgbToOklch([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}

export function oklchToSrgb(L, C, H) {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, gam(v))));
}

function lightnessOf(cssValue, fallback) {
  const rgb = parseColor(cssValue);
  return rgb ? srgbToOklch(rgb)[0] : fallback;
}

export class Accent {
  constructor(app) {
    this.app = app;
    this.key = "";
    this.setAccentVar = false;
  }

  apply() {
    const ui = this.app.state.config?.ui || {};
    const mode = ui.accent || "page";
    const style = root.style;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(mode)) { style.setProperty("--samo-accent", mode); this.setAccentVar = true; }
    else if (this.setAccentVar) { style.removeProperty("--samo-accent"); this.setAccentVar = false; }

    const color = mode === "page" ? this.app.activeTab()?.themeColor : null;
    const strength = Math.min(1, Math.max(0, ui.page_tint_strength ?? 0.6));
    const key = `${color}|${strength}|${this.app.themeGen || 0}`;
    if (key === this.key) return;
    this.key = key;
    const rgb = color && parseColor(color);
    if (!rgb || !strength) {
      style.setProperty("--samo-page-tint", "0");
      style.removeProperty("--samo-page-accent");
      delete root.dataset.pageAccent;
      delete root.dataset.pageFg;
      return;
    }
    const cs = getComputedStyle(root);
    const scheme = cs.getPropertyValue("--samo-color-scheme").trim();
    const bgL = lightnessOf(cs.getPropertyValue("--samo-bg-toolbar"), scheme === "light" ? 0.97 : 0.2);
    const dark = scheme ? scheme !== "light" : bgL < 0.6;
    const [L0, C0, H] = srgbToOklch(rgb);
    // Background tint: theme lightness band, low chroma (§3.10).
    const L = dark ? Math.min(0.3, Math.max(0.2, 0.2 + L0 * 0.1)) : Math.min(0.96, Math.max(0.88, 0.88 + L0 * 0.08));
    const C = Math.min(C0, dark ? 0.07 : 0.1);
    style.setProperty("--samo-page-tint-color", `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`);
    style.setProperty("--samo-page-tint", String(strength));
    // Page accent proper (indicator, highlights): readable on the theme's surfaces.
    if (C0 > 0.03) {
      const LA = dark ? Math.max(0.68, Math.min(0.8, L0)) : Math.min(0.55, Math.max(0.42, L0));
      style.setProperty("--samo-page-accent", `oklch(${LA.toFixed(3)} ${Math.min(C0, 0.17).toFixed(3)} ${H.toFixed(1)})`);
    } else style.removeProperty("--samo-page-accent");
    root.dataset.pageAccent = "";
    // Contrast guard: mixed background lightness vs the theme's text lightness.
    const mixL = bgL * (1 - strength) + L * strength;
    const fgL = lightnessOf(cs.getPropertyValue("--samo-fg"), dark ? 0.93 : 0.2);
    if (Math.abs(fgL - mixL) < 0.42) root.dataset.pageFg = mixL > 0.6 ? "dark" : "light";
    else delete root.dataset.pageFg;
  }
}
