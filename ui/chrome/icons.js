// Icon access for chrome + popup. Uses ui/shared/icons.js (owned by ui-pages) when present,
// otherwise a tiny built-in fallback so the chrome never renders without its core glyphs.
let shared = null, has = null;
try {
  const mod = await import("../shared/icons.js");
  if (typeof mod.icon === "function") shared = mod.icon;
  if (typeof mod.hasIcon === "function") has = mod.hasIcon;
} catch { /* shared icon set not available yet */ }

// Lucide-style 24-unit paths (stroke icons).
const P = {
  "plus": "M5 12h14M12 5v14",
  "x": "M18 6 6 18M6 6l12 12",
  "minus": "M5 12h14",
  "square": "M5 5h14v14H5z",
  "copy": "M8 8h12v12H8zM4 16V4h12",
  "arrow-left": "m12 19-7-7 7-7M19 12H5",
  "arrow-right": "M5 12h14m-7-7 7 7-7 7",
  "rotate-cw": "M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8M21 3v5h-5",
  "search": "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4.3-4.3",
  "lock": "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  "lock-open": "M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.8-1.2",
  "globe": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18",
  "star": "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  "menu": "M4 7h16M4 12h16M4 17h16",
  "download": "M12 4v11m-5-5 5 5 5-5M5 20h14",
  "volume-2": "M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13",
  "volume-x": "M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6",
  "chevron-down": "m6 9 6 6 6-6",
  "settings": "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  "history": "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2",
  "bookmark": "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  "pin": "M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  "sparkles": "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  "command": "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
  "maximize-2": "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  "minimize-2": "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  "more-horizontal": "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  "layout": "M3 3h18v18H3zM3 9h18M9 21V9",
  "columns": "M3 3h18v18H3zM12 3v18",
  "shield": "M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z",
  "puzzle": "M19.4 13.6a2.5 2.5 0 1 0 0-3.2H17V7a1 1 0 0 0-1-1h-3.4a2.5 2.5 0 1 0-3.2 0H6a1 1 0 0 0-1 1v3.4a2.5 2.5 0 1 1 0 3.2V17a1 1 0 0 0 1 1h3.4a2.5 2.5 0 1 1 3.2 0H16a1 1 0 0 0 1-1v-3.4z",
  "home": "M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  "panel-top": "M3 3h18v18H3zM3 9h18",
};

function fallback(name, size = 16) {
  if (name === "star-filled") {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" aria-hidden="true"><path d="${P.star}"/></svg>`;
  }
  const d = P[name] || P.globe;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

export function icon(name, size = 16) {
  if (shared && (!has || has(name) || !P[name])) {
    try {
      const s = shared(name, size);
      if (s) return s;
    } catch { /* fall through */ }
  }
  return fallback(name, size);
}

/** Fill every `[data-icon]` element under `rootEl` (used for static markup). */
export function hydrateIcons(rootEl = document) {
  for (const el of rootEl.querySelectorAll("[data-icon]")) {
    el.innerHTML = icon(el.dataset.icon, +(el.dataset.iconSize || 16));
  }
}
