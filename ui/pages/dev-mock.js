// Samo internal pages — DEV PREVIEW HARNESS (never active inside Samo).
// Loaded only when location.protocol !== "samo:" by the inline loader in each page.
// It:
//   1. maps absolute samo://ui/... imports to local files via an import map,
//   2. rewrites samo:// stylesheet links (theme from ?theme=<id>, default samo-dark),
//   3. with ?mock=1 installs window.__samoMock (fake API per ARCHITECTURE §4/§5).
// Serve the repo root:  python3 -m http.server  →  /ui/pages/settings.html?mock=1&theme=frost
// Extra params: &lang=en|ru, &density=compact, &section=<id> (settings).
(function () {
  "use strict";
  if (location.protocol === "samo:") return;
  const params = new URLSearchParams(location.search);
  const shared = new URL("../shared/", location.href).href;
  const themesDir = new URL("../../themes/", location.href).href;
  let themeId = params.get("theme") || "samo-dark";

  // 1. import map: samo://ui/shared/* → ../shared/*
  // Prefix keys don't work for non-special schemes, so map each shared module exactly.
  const mods = {};
  for (const f of ["bridge.js", "icons.js"]) mods["samo://ui/shared/" + f] = shared + f;
  const imports = JSON.stringify({ imports: mods });
  document.write(`<script type="importmap">${imports}<\/script>`);

  // 2. stylesheet links
  const rewrite = (href) => {
    if (href.startsWith("samo://ui/shared/")) return shared + href.slice("samo://ui/shared/".length);
    if (href.startsWith("samo://theme/current.css")) return themesDir + themeId + ".css";
    if (href.startsWith("samo://theme/user.css")) return "data:text/css,";
    const m = href.match(/^samo:\/\/theme\/([\w.-]+)\.css/);
    if (m) return themesDir + m[1] + ".css";
    return href;
  };
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    const h = l.getAttribute("href");
    if (h && h.startsWith("samo://")) l.setAttribute("href", rewrite(h));
  }
  window.__samoDevRewrite = rewrite;

  if (params.get("mock") !== "1") return;

  // 3. mock API ------------------------------------------------------------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const defaults = {
    general: { startup: "restore", homepage: "samo://newtab/", newtab_url: "samo://newtab/", search_engine: "duckduckgo", downloads_dir: "~/Downloads" },
    search: { engines: {
      duckduckgo: "https://duckduckgo.com/?q={q}",
      google: "https://www.google.com/search?q={q}",
      brave: "https://search.brave.com/search?q={q}",
      bing: "https://www.bing.com/search?q={q}",
      yandex: "https://yandex.ru/search/?text={q}",
    } },
    ui: { theme: "samo-dark", density: "normal", accent: "page", page_tint_strength: 0.6, reduce_motion: false, animation_speed: 1.0,
      font_ui: "", content_inset: 0, frameless: true, window_controls: "right" },
    tabs: { max_width: 240, min_width: 44, close_button: "hover", indicator: "card", hide_throbber: false, new_tab_position: "after-current", close_window_with_last_tab: false },
    compact: { enabled: false, hide_delay_ms: 1000 },
    urlbar: { ctrl_t: "palette", show_full_url: false, max_suggestions: 8 },
    engine: { ozone_platform: "auto", smooth_scrolling: true, gpu_rasterization: true, user_agent: "", extra_flags: [] },
    keys: {},
  };
  const config = clone(defaults);
  config.ui.theme = themeId;
  if (params.get("density")) config.ui.density = params.get("density");
  config.search.engines.kagi = "https://kagi.com/search?q={q}";
  config.keys["toggle-compact"] = "ctrl+alt+x";

  const themes = [
    { id: "samo-dark", name: "Samo Dark", scheme: "dark", builtin: true },
    { id: "samo-light", name: "Samo Light", scheme: "light", builtin: true },
    { id: "midnight", name: "Midnight", scheme: "dark", builtin: true },
    { id: "frost", name: "Frost", scheme: "dark", builtin: true },
    { id: "dusk", name: "Dusk", scheme: "dark", builtin: true },
    { id: "sakura", name: "Sakura", scheme: "light", builtin: true },
    { id: "oled", name: "OLED", scheme: "dark", builtin: true },
  ];

  const now = Date.now();
  const H = 3600e3, D = 24 * H;
  const sites = [
    ["https://github.com/zen-browser/desktop", "zen-browser/desktop: Welcome to a calmer internet", 42],
    ["https://news.ycombinator.com/", "Hacker News", 37],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "Rick Astley — Never Gonna Give You Up", 25],
    ["https://developer.mozilla.org/en-US/docs/Web/CSS/linear-gradient", "linear-gradient() — CSS | MDN", 19],
    ["https://habr.com/ru/articles/", "Статьи / Хабр", 18],
    ["https://docs.rs/cef/latest/cef/", "cef — Rust", 15],
    ["https://www.reddit.com/r/unixporn/", "r/unixporn — Linux desktop ricing", 12],
    ["https://ru.wikipedia.org/wiki/Chromium", "Chromium — Википедия", 9],
    ["https://music.yandex.ru/home", "Яндекс Музыка — собираем музыку для вас", 8],
    ["https://archlinux.org/news/", "Arch Linux — News", 6],
    ["https://crates.io/crates/serde", "serde — crates.io: Rust Package Registry", 5],
    ["https://figma.com/files/recent", "Recent — Figma", 4],
  ];
  let history = [];
  for (let i = 0; i < 64; i++) {
    const [url, title, visits] = sites[(i * 7) % sites.length];
    history.push({ url: i < sites.length ? url : url + (url.includes("?") ? "&" : "?") + "p=" + i, title, visits: Math.max(1, visits - i), lastVisit: now - i * 1.7 * H - (i > 30 ? 3 * D : 0) });
  }

  const downloads = [
    { id: 4, name: "helium-0.6.4-x86_64.AppImage", url: "https://github.com/imputnet/helium-linux/releases/download/0.6.4/helium.AppImage", path: "/home/user/Downloads/helium-0.6.4-x86_64.AppImage", received: 61e6, total: 148e6, speed: 6.2e6, state: "progress" },
    { id: 3, name: "Отчёт за квартал.pdf", url: "https://example.com/report.pdf", path: "/home/user/Downloads/Отчёт за квартал.pdf", received: 2.4e6, total: 2.4e6, speed: 0, state: "complete" },
    { id: 2, name: "wallpaper-mountains-4k.jpg", url: "https://images.example.org/wallpaper.jpg", path: "/home/user/Downloads/wallpaper-mountains-4k.jpg", received: 3.1e6, total: 8.8e6, speed: 0, state: "interrupted" },
    { id: 1, name: "cef_binary_154.0.34_linux64.tar.bz2", url: "https://cef-builds.spotifycdn.com/cef.tar.bz2", path: "/home/user/Downloads/cef_binary_154.0.34_linux64.tar.bz2", received: 412e6, total: 412e6, speed: 0, state: "complete" },
    { id: 0, name: "setup.exe", url: "https://example.com/setup.exe", path: "", received: 1e6, total: 0, speed: 0, state: "cancelled" },
  ];

  const keyDefs = [
    ["new-tab", "ctrl+t", "New tab"], ["close-tab", "ctrl+w", "Close tab"], ["reopen-closed-tab", "ctrl+shift+t", "Reopen closed tab"],
    ["next-tab", "ctrl+tab", "Next tab"], ["prev-tab", "ctrl+shift+tab", "Previous tab"], ["focus-urlbar", "ctrl+l", "Focus address bar"],
    ["command-palette", "ctrl+k", "Command palette"], ["search-tabs", "ctrl+shift+a", "Search tabs"], ["toggle-compact", "ctrl+alt+c", "Toggle compact mode"],
    ["copy-url", "ctrl+shift+c", "Copy URL"], ["copy-url-markdown", "ctrl+alt+shift+c", "Copy URL as Markdown"], ["pin-tab", "ctrl+shift+d", "Pin tab"],
    ["mute-tab", "ctrl+m", "Mute tab"], ["duplicate-tab", "ctrl+shift+x", "Duplicate tab"], ["split-vertical", "ctrl+alt+v", "Split vertically"],
    ["split-horizontal", "ctrl+alt+h", "Split horizontally"], ["unsplit", "ctrl+alt+u", "Unsplit"], ["reload", "ctrl+r", "Reload"],
    ["hard-reload", "ctrl+shift+r", "Hard reload"], ["back", "alt+left", "Back"], ["forward", "alt+right", "Forward"], ["find", "ctrl+f", "Find in page"],
    ["zoom-in", "ctrl+plus", "Zoom in"], ["zoom-out", "ctrl+minus", "Zoom out"], ["zoom-reset", "ctrl+0", "Reset zoom"], ["fullscreen", "f11", "Fullscreen"],
    ["devtools", "f12", "Developer tools"], ["history", "ctrl+h", "History"], ["downloads", "ctrl+j", "Downloads"], ["settings", "ctrl+comma", "Settings"],
    ["reload-theme", "ctrl+alt+r", "Reload theme"], ["new-window", "ctrl+n", "New window"], ["quit", "ctrl+q", "Quit"],
  ];

  const dispatch = (ev, payload) => setTimeout(() => window.__samoDispatch && window.__samoDispatch(ev, payload), 0);

  function setKey(obj, dotted, value) {
    const parts = dotted.split(".");
    let o = obj;
    // keys.<action> and search.engines.<name> may contain dots/dashes: only split the known prefix
    if (parts[0] === "keys") { parts.splice(1, parts.length, parts.slice(1).join(".")); }
    if (parts[0] === "search" && parts[1] === "engines") { parts.splice(2, parts.length, parts.slice(2).join(".")); }
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
    const last = parts[parts.length - 1];
    if (value === null) delete o[last]; else o[last] = value;
  }

  // Simulated live download progress
  setInterval(() => {
    const d = downloads.find((x) => x.state === "progress");
    if (!d) return;
    d.speed = 4e6 + Math.random() * 4e6;
    d.received = Math.min(d.total, d.received + d.speed * 0.8);
    if (d.received >= d.total) { d.state = "complete"; d.speed = 0; }
    dispatch("download:updated", clone(d));
  }, 800);

  const log = (...a) => console.debug("[samo mock]", ...a);

  window.__samoMock = async function (cmd, args = {}) {
    log(cmd, args);
    await new Promise((r) => setTimeout(r, 8));
    switch (cmd) {
      case "config.get": return { config: clone(config), path: "/home/user/.config/samo/config.toml", defaults: clone(defaults) };
      case "config.set": {
        setKey(config, args.key, args.value);
        if (args.key === "ui.theme") {
          themeId = args.value;
          const link = document.getElementById("samo-theme");
          if (link) link.setAttribute("href", themesDir + themeId + ".css");
        }
        dispatch("config:changed", { config: clone(config) });
        return { config: clone(config) };
      }
      case "config.openFile": return {};
      case "theme.list": return { items: clone(themes) };
      case "theme.reload": dispatch("theme:changed", {}); return {};
      case "history.list": {
        const q = (args.query || "").toLowerCase();
        const items = history.filter((h) => !q || h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q));
        const off = args.offset || 0, lim = args.limit ?? 100;
        return { items: clone(items.slice(off, off + lim)) };
      }
      case "history.delete": history = history.filter((h) => h.url !== args.url); return {};
      case "history.clear": history = []; return {};
      case "downloads.list": return { items: clone(downloads) };
      case "downloads.cancel": {
        const d = downloads.find((x) => x.id === args.id);
        if (d) { d.state = "cancelled"; d.speed = 0; dispatch("download:updated", clone(d)); }
        return {};
      }
      case "downloads.open": case "downloads.showInFolder": return {};
      case "keys.list": return { items: keyDefs.map(([action, accel, label]) => ({ action, accel: config.keys[action] ?? accel, label })) };
      case "nav.go": return { url: args.input };
      case "tab.new": return { id: 99 };
      default: log("unhandled", cmd); return {};
    }
  };
})();
