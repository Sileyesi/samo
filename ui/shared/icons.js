// Samo icon set — hand-drawn, lucide-style line icons on a 24x24 grid.
// Usage:
//   import { icon, ICON_NAMES } from "samo://ui/shared/icons.js";
//   button.innerHTML = icon("plus");          // 16px
//   el.innerHTML = icon("settings", 18);
// All icons use stroke="currentColor", so color follows CSS `color`.
// Unknown names render an empty square placeholder (and warn once).

const P = (d) => `<path d="${d}"/>`;
const C = (cx, cy, r, extra = "") => `<circle cx="${cx}" cy="${cy}" r="${r}"${extra}/>`;
const R = (x, y, w, h, rx = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const DOT = ` fill="currentColor" stroke="none"`;

const STAR = "M12 2.6l2.9 5.88 6.5.95-4.7 4.58 1.11 6.47L12 17.43l-5.81 3.05 1.11-6.47-4.7-4.58 6.5-.95z";
const GEAR = "M10.21 4.82 10.66 2.49 13.34 2.49 13.79 4.82 15.81 5.66 17.78 4.33 19.67 6.22 18.34 8.19 19.18 10.21 21.51 10.66 21.51 13.34 19.18 13.79 18.34 15.81 19.67 17.78 17.78 19.67 15.81 18.34 13.79 19.18 13.34 21.51 10.66 21.51 10.21 19.18 8.19 18.34 6.22 19.67 4.33 17.78 5.66 15.81 4.82 13.79 2.49 13.34 2.49 10.66 4.82 10.21 5.66 8.19 4.33 6.22 6.22 4.33 8.19 5.66Z";
const SPEAKER = "M11 5 6 9H3v6h3l5 4z";

const ICONS = {
  // ---- basic actions
  "plus": P("M12 5v14M5 12h14"),
  "minus": P("M5 12h14"),
  "x": P("M18 6 6 18M6 6l12 12"),
  "check": P("M20 6 9 17l-5-5"),
  "square": R(5, 5, 14, 14, 2),
  "copy": R(8, 8, 13, 13, 2) + P("M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"),
  "trash": P("M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6") + P("M18.5 6l-.8 13.1a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6") + P("M10 11v5.5M14 11v5.5"),
  "pencil": P("M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4z") + P("M14.5 5.5l3 3"),
  "external-link": P("M14 4h6v6M20 4l-9 9") + P("M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"),
  "link": P("M10 13.5a4.5 4.5 0 0 0 6.6.3l2.8-2.8a4.6 4.6 0 0 0-6.5-6.5l-1.5 1.5") + P("M14 10.5a4.5 4.5 0 0 0-6.6-.3l-2.8 2.8a4.6 4.6 0 0 0 6.5 6.5l1.5-1.5"),
  "download": P("M12 3.5v11.5M7 10.5l5 5 5-5M5 20.5h14"),
  "upload": P("M12 20V8.5M7 13l5-5 5 5M5 3.5h14"),

  // ---- navigation
  "arrow-left": P("M19 12H5M11.5 5.5 5 12l6.5 6.5"),
  "arrow-right": P("M5 12h14M12.5 5.5 19 12l-6.5 6.5"),
  "arrow-up": P("M12 19V5M5.5 11.5 12 5l6.5 6.5"),
  "arrow-down": P("M12 5v14M5.5 12.5 12 19l6.5-6.5"),
  "arrow-up-right": P("M7 17 17 7M8 7h9v9"),
  "chevron-down": P("m6 9 6 6 6-6"),
  "chevron-up": P("m6 15 6-6 6 6"),
  "chevron-right": P("m9 6 6 6-6 6"),
  "chevron-left": P("m15 6-6 6 6 6"),
  "rotate-cw": P("M20.5 12A8.5 8.5 0 1 1 18 6l2.5 2.5") + P("M20.5 3.5v5h-5"),
  "rotate-ccw": P("M3.5 12A8.5 8.5 0 1 0 6 6L3.5 8.5") + P("M3.5 3.5v5h5"),
  "refresh-ccw": P("M20.5 12A8.5 8.5 0 0 0 6 6L3.5 8.5M3.5 3.5v5h5") + P("M3.5 12A8.5 8.5 0 0 0 18 18l2.5-2.5M20.5 20.5v-5h-5"),
  "home": P("M3.5 10.5 12 3.5l8.5 7") + P("M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"),
  "search": C(11, 11, 7) + P("m20.5 20.5-4.5-4.5"),
  "zoom-in": C(11, 11, 7) + P("m20.5 20.5-4.5-4.5M11 8v6M8 11h6"),
  "zoom-out": C(11, 11, 7) + P("m20.5 20.5-4.5-4.5M8 11h6"),
  "menu": P("M4 6.5h16M4 12h16M4 17.5h16"),
  "more-horizontal": C(5.5, 12, 1.4, DOT) + C(12, 12, 1.4, DOT) + C(18.5, 12, 1.4, DOT),
  "more-vertical": C(12, 5.5, 1.4, DOT) + C(12, 12, 1.4, DOT) + C(12, 18.5, 1.4, DOT),

  // ---- security / site
  "lock": R(4.5, 10.5, 15, 10.5, 2.5) + P("M8 10.5V7.5a4 4 0 0 1 8 0v3"),
  "lock-open": R(4.5, 10.5, 15, 10.5, 2.5) + P("M8 10.5V7.5a4 4 0 0 1 7.6-1.8"),
  "shield": P("M12 21s7.5-3.5 7.5-9.5V5.8L12 3 4.5 5.8v5.7C4.5 17.5 12 21 12 21z"),
  "globe": C(12, 12, 9) + P("M3 12h18") + P("M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"),
  "info": C(12, 12, 9) + P("M12 16.5v-5") + C(12, 8, 1.1, DOT),
  "alert-triangle": P("M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z") + P("M12 9.5v4") + C(12, 17, 1.1, DOT),
  "x-circle": C(12, 12, 9) + P("m15 9-6 6M9 9l6 6"),
  "check-circle": C(12, 12, 9) + P("m8.5 12.2 2.4 2.4 4.6-4.9"),
  "eye": P("M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z") + C(12, 12, 3),
  "eye-off": P("M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.3 3.2M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 5.4-1.9") + P("M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"),

  // ---- favorites / library
  "star": P(STAR),
  "star-filled": `<path d="${STAR}" fill="currentColor"/>`,
  "bookmark": P("M18.5 21 12 16.8 5.5 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2z"),
  "history": P("M3.5 12A8.5 8.5 0 1 0 6 6L3.5 8.5") + P("M3.5 3.5v5h5") + P("M12 7.5V12l3.5 2"),
  "clock": C(12, 12, 9) + P("M12 7v5l3.5 2"),
  "folder": P("M3 6.5A2.5 2.5 0 0 1 5.5 4h3.3a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8h5.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"),
  "file": P("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z") + P("M14 3v5h5"),
  "image": R(3.5, 3.5, 17, 17, 2.5) + C(9, 9, 1.8) + P("m20.5 15-4-4L6 21"),

  // ---- tabs & window
  "pin": P("M9 3.5h6") + P("M10 3.5v5.2l-3 3.6v2.2h10v-2.2l-3-3.6V3.5") + P("M12 14.5v6"),
  "columns": R(3.5, 3.5, 17, 17, 2.5) + P("M12 3.5v17"),
  "rows": R(3.5, 3.5, 17, 17, 2.5) + P("M3.5 12h17"),
  "layout": R(3.5, 3.5, 17, 17, 2.5) + P("M3.5 9h17M9 9v11.5"),
  "panel-top": R(3.5, 3.5, 17, 17, 2.5) + P("M3.5 9h17"),
  "layers": P("m12 3 9 4.5-9 4.5-9-4.5z") + P("m3 12 9 4.5 9-4.5") + P("m3 16.5 9 4.5 9-4.5"),
  "maximize-2": P("M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5l-6.5 6.5M3.5 20.5 10 14"),
  "minimize-2": P("M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M3.5 20.5 10 14"),
  "monitor": R(2.5, 3.5, 19, 13, 2.5) + P("M8 20.5h8M12 16.5v4"),

  // ---- media / permissions
  "volume-2": P(SPEAKER) + P("M15.5 8.8a4.5 4.5 0 0 1 0 6.4") + P("M18.6 5.6a9 9 0 0 1 0 12.8"),
  "volume-x": P(SPEAKER) + P("m22 9.5-5 5M17 9.5l5 5"),
  "play": P("M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5z"),
  "pause": R(6, 4.5, 4, 15, 1) + R(14, 4.5, 4, 15, 1),
  "mic": R(9, 2.5, 6, 12, 3) + P("M18.5 10.5v1a6.5 6.5 0 0 1-13 0v-1M12 18v3.5"),
  "camera": R(2.5, 6, 13.5, 12, 2.5) + P("m16 10.5 5.5-3.5v10L16 13.5"),
  "map-pin": P("M19 10c0 5.5-7 11.5-7 11.5S5 15.5 5 10a7 7 0 0 1 14 0z") + C(12, 10, 2.5),
  "bell": P("M6.5 9a5.5 5.5 0 0 1 11 0c0 6 2.5 8 2.5 8H4s2.5-2 2.5-8") + P("M10.3 20.5a2 2 0 0 0 3.4 0"),

  // ---- app / settings
  "settings": P(GEAR) + C(12, 12, 3),
  "sliders": P("M4 7h9M17 7h3M4 17h3M11 17h9") + C(15, 7, 2) + C(9, 17, 2),
  "puzzle": P("M10 6V5a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 1 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H5V7a1 1 0 0 1 1-1z"),
  "sparkles": P("M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z") + P("M18.5 14.5v5M16 17h5") + P("M5 18.5v3M3.5 20h3"),
  "command": P("M9 6v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H6a3 3 0 1 1 3-3z"),
  "palette": P("M12 21.5a9.5 9.5 0 1 1 9.5-9.5c0 2.4-1.9 4-4.3 4h-1.7a1.8 1.8 0 0 0-1.4 3c.9 1.1.2 2.5-2.1 2.5z") + C(7.5, 11, 1.2, DOT) + C(10, 7, 1.2, DOT) + C(14.5, 7, 1.2, DOT) + C(17, 11, 1.2, DOT),
  "keyboard": R(2.5, 5.5, 19, 13, 2.5) + P("M6.5 9.5h.01M10 9.5h.01M14 9.5h.01M17.5 9.5h.01M6.5 12.5h.01M10 12.5h.01M14 12.5h.01M17.5 12.5h.01M8 15.5h8"),
  "type": P("M5 7V4.5h14V7M12 4.5v15M9 19.5h6"),
  "cpu": R(5, 5, 14, 14, 2) + R(9, 9, 6, 6, 1) + P("M9.5 2v3M14.5 2v3M9.5 19v3M14.5 19v3M2 9.5h3M2 14.5h3M19 9.5h3M19 14.5h3"),
  "power": P("M12 3v8.5") + P("M17.7 6.8a8 8 0 1 1-11.4 0"),
  "sun": C(12, 12, 4) + P("M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"),
  "moon": P("M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"),
  "loader": P("M20.5 12A8.5 8.5 0 1 1 12 3.5"),
  "circle": C(12, 12, 9),
};

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

const warned = new Set();

/**
 * Returns an inline SVG string for `name` at `size` px.
 * @param {string} name
 * @param {number} [size=16]
 * @param {{class?: string, label?: string, strokeWidth?: number}} [opts]
 */
export function icon(name, size = 16, opts = {}) {
  let body = ICONS[name];
  if (body === undefined) {
    if (!warned.has(name)) { warned.add(name); console.warn(`[samo] unknown icon "${name}"`); }
    body = "";
  }
  const cls = `samo-icon samo-icon-${name}${opts.class ? " " + opts.class : ""}`;
  const a11y = opts.label ? ` role="img" aria-label="${String(opts.label).replace(/"/g, "&quot;")}"` : ` aria-hidden="true"`;
  const sw = opts.strokeWidth ?? 1.75;
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${a11y}>${body}</svg>`;
}

/** Same as icon() but returns an SVGElement. */
export function iconEl(name, size = 16, opts = {}) {
  const t = document.createElement("template");
  t.innerHTML = icon(name, size, opts);
  return t.content.firstElementChild;
}

export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(ICONS, name); }
