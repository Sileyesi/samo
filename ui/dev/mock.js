// Mock of the Rust side for the dev harness (ARCHITECTURE §4). Dev only.
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const chromeFrame = $("chrome"), popupFrame = $("popup"), page = $("page");
const UI_BASE = new URL("../", location.href).pathname;          // "/ui/"
const THEMES = new URL("../../themes/", location.href).pathname;  // "/themes/" (repo root served)
let theme = params.get("theme") || "samo-dark";

// ---- Fake data ---------------------------------------------------------------------
const fav = (bg, ch, fg = "#fff") => "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${bg}"/><text x="16" y="22" font-family="Arial" font-weight="700" font-size="17" text-anchor="middle" fill="${fg}">${ch}</text></svg>`);
const SITES = [
  { url: "https://github.com/zen-browser/desktop", title: "zen-browser/desktop: Welcome to a calmer internet", favicon: fav("#24292f", "G"), themeColor: "#24292f" },
  { url: "https://developer.mozilla.org/en-US/docs/Web/CSS/linear()", title: "linear() - CSS: Cascading Style Sheets | MDN", favicon: fav("#1b1b1b", "M"), themeColor: null },
  { url: "https://news.ycombinator.com/", title: "Hacker News", favicon: fav("#ff6600", "Y"), themeColor: "#ff6600" },
  { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Never Gonna Give You Up — Official Video", favicon: fav("#ff0033", "▶"), themeColor: "#0f0f0f", audible: true },
  { url: "https://docs.rs/cef/latest/cef/", title: "cef - Rust", favicon: fav("#e57324", "R"), themeColor: null },
  { url: "https://www.figma.com/design/samo-ui", title: "Samo UI – Figma", favicon: fav("#a259ff", "F"), themeColor: "#2c2c2c" },
  { url: "https://linear.app/samo/inbox", title: "Inbox · Linear", favicon: fav("#5e6ad2", "L"), themeColor: "#5e6ad2" },
  { url: "https://en.wikipedia.org/wiki/Spring_(device)", title: "Spring (device) - Wikipedia", favicon: fav("#eee", "W", "#111"), themeColor: null },
  { url: "https://mail.proton.me/u/0/inbox", title: "Inbox | Proton Mail", favicon: fav("#6d4aff", "P"), themeColor: "#1b1340" },
  { url: "https://open.spotify.com/", title: "Spotify – Web Player", favicon: fav("#1db954", "S"), themeColor: "#121212" },
  { url: "https://crates.io/crates/serde", title: "serde - crates.io: Rust Package Registry", favicon: fav("#264323", "C"), themeColor: "#264323" },
  { url: "https://archlinux.org/", title: "Arch Linux", favicon: fav("#1793d1", "A"), themeColor: "#1793d1" },
];
const HISTORY = [...SITES, { url: "https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/tabs/tab_style.cc", title: "tab_style.cc - chromium/src" },
  { url: "https://wiki.archlinux.org/title/Wayland", title: "Wayland - ArchWiki" }, { url: "https://github.com/niri-wm/niri", title: "niri: A scrollable-tiling Wayland compositor" }];

const DEFAULT_CONFIG = {
  general: { startup: "restore", homepage: "samo://newtab/", newtab_url: "samo://newtab/", search_engine: "duckduckgo" },
  ui: { theme, density: params.get("density") || "normal", accent: params.get("accent") || "page", page_tint_strength: 0.6,
    reduce_motion: params.get("reduce") === "1", animation_speed: +(params.get("motion") || 1), font_ui: "", content_inset: 0,
    frameless: true, window_controls: params.get("wc") || "right" },
  tabs: { max_width: 240, min_width: 44, close_button: params.get("close") || "hover", indicator: params.get("indicator") || "card",
    hide_throbber: false, new_tab_position: "after-current", close_window_with_last_tab: false },
  compact: { enabled: params.get("compact") === "1", hide_delay_ms: 1000 },
  urlbar: { ctrl_t: "palette", show_full_url: params.get("fullurl") === "1", max_suggestions: 8 },
};

const S = {
  config: structuredClone(DEFAULT_CONFIG),
  tabs: [], activeId: null, nextId: 1, closed: [],
  window: { maximized: false, fullscreen: false, focused: true },
  bookmarks: new Map([[SITES[0].url, { url: SITES[0].url, title: SITES[0].title, added: 0 }], [SITES[1].url, { url: SITES[1].url, title: SITES[1].title, added: 0 }]]),
  downloads: new Map(),
  popup: { kind: null, visible: false },
};

function mkTab(site = {}, extra = {}) {
  return {
    id: S.nextId++, url: site.url || "samo://newtab/", title: site.title || (site.url ? site.url : "New Tab"),
    favicon: site.favicon || null, loading: false, progress: 1, canBack: !!site.url, canForward: false,
    pinned: false, muted: false, audible: !!site.audible, themeColor: site.themeColor ?? null, zoom: 0, crashed: false,
    secure: !site.url || site.url.startsWith("samo:") ? "internal" : site.url.startsWith("https:") ? "https" : "http",
    ...extra,
  };
}

const nTabs = +(params.get("tabs") || 7);
for (let i = 0; i < nTabs; i++) S.tabs.push(mkTab(SITES[i % SITES.length], i < (params.has("pinned") ? +params.get("pinned") : 2) ? { pinned: true } : {}));
if (nTabs > 4) { S.tabs[4].loading = true; S.tabs[4].progress = 0.45; }
if (nTabs > 6) { S.tabs[6].crashed = params.get("crashed") === "1"; }
S.activeId = S.tabs[Math.min(+(params.get("active") ?? 2), S.tabs.length - 1)]?.id ?? null;

// ---- Dispatch -------------------------------------------------------------------------
const toChrome = (ev, p) => chromeFrame.contentWindow?.__samoDispatch?.(ev, p);
const toPopup = (ev, p) => popupFrame.contentWindow?.__samoDispatch?.(ev, p);
const tab = (id) => S.tabs.find((t) => t.id === (id ?? S.activeId));
const idx = (id) => S.tabs.findIndex((t) => t.id === id);
const later = (ms, f) => setTimeout(f, ms);

function update(t, fields) {
  Object.assign(t, fields);
  toChrome("tabs:updated", { id: t.id, ...fields });
}

function activate(id) {
  if (!tab(id) || S.activeId === id) return;
  S.activeId = id;
  toChrome("tabs:activated", { id });
  hidePopup(true);
}

function simulateLoad(t, site) {
  update(t, { loading: true, progress: 0.05, url: site.url, title: site.url.replace(/^https?:\/\//, ""), favicon: null, themeColor: null, canBack: true,
    secure: site.url.startsWith("samo:") ? "internal" : site.url.startsWith("https:") ? "https" : "http" });
  later(250, () => update(t, { progress: 0.35 }));
  later(600, () => update(t, { progress: 0.7, title: site.title || t.title, favicon: site.favicon || null }));
  later(1000, () => update(t, { loading: false, progress: 1, themeColor: site.themeColor ?? null }));
}

function resolve(input) {
  const s = input.trim();
  const site = SITES.find((x) => x.url === s || x.url.replace(/^https:\/\/(www\.)?/, "").startsWith(s));
  if (site) return site;
  if (/^[a-z]+:\/\//i.test(s)) return { url: s, title: s };
  if (/^[^\s]+\.[a-z]{2,}/i.test(s)) return { url: `https://${s}/`, title: s };
  return { url: `https://duckduckgo.com/?q=${encodeURIComponent(s)}`, title: `${s} at DuckDuckGo`, favicon: fav("#de5833", "D"), themeColor: null };
}

function newTab({ url, active = true, index } = {}) {
  const t = mkTab({}, {});
  const cur = idx(S.activeId);
  let i = Number.isInteger(index) ? index : S.config.tabs.new_tab_position === "end" ? S.tabs.length : cur + 1;
  const firstUnpinned = S.tabs.findIndex((x) => !x.pinned);
  i = Math.max(i, firstUnpinned < 0 ? S.tabs.length : firstUnpinned);
  S.tabs.splice(i, 0, t);
  toChrome("tabs:created", { tab: { ...t }, index: i, active });
  if (active) S.activeId = t.id;
  if (url) later(30, () => simulateLoad(t, resolve(url)));
  return t;
}

function closeTab(id) {
  const i = idx(id);
  if (i < 0) return;
  const [t] = S.tabs.splice(i, 1);
  S.closed.push(t);
  toChrome("tabs:closed", { id });
  if (S.activeId === id) {
    const next = S.tabs[i] || S.tabs[i - 1];
    S.activeId = null;
    if (next) activate(next.id); else newTab({});
  }
}

function suggest(q, limit = 8) {
  const ql = q.toLowerCase();
  const out = [];
  for (const t of S.tabs) if (t.id !== S.activeId && (t.title + t.url).toLowerCase().includes(ql)) out.push({ type: "tab", title: t.title, url: t.url, tabId: t.id, score: 90 });
  for (const h of HISTORY) if ((h.title + h.url).toLowerCase().includes(ql) && !out.some((o) => o.url === h.url))
    out.push({ type: S.bookmarks.has(h.url) ? "bookmark" : "history", title: h.title, url: h.url, score: 70 });
  for (const s of [`${q} tutorial`, `${q} vs`, `${q} documentation`]) out.push({ type: "search", title: s, score: 40 });
  if ("compact".startsWith(ql) && ql.length > 2) out.push({ type: "command", title: "Toggle compact mode", action: "toggle-compact", score: 30 });
  return out.slice(0, limit);
}

// ---- Popup surface -------------------------------------------------------------------
function showPopup({ kind, rect, data, focus }) {
  S.popup = { kind, visible: true };
  Object.assign(popupFrame.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  popupFrame.hidden = false;
  toPopup("popup:data", { kind, data });
  if (focus) popupFrame.contentWindow?.focus();
}
function hidePopup(notify) {
  if (!S.popup.visible) return;
  S.popup.visible = false;
  popupFrame.hidden = true;
  if (notify) toChrome("popup:hidden", {});
}

// ---- Commands ----------------------------------------------------------------------------
async function handle(cmd, a = {}, from = "chrome") {
  switch (cmd) {
    case "state.get": return { tabs: S.tabs.map((t) => ({ ...t })), activeId: S.activeId, window: { ...S.window, height: innerHeight }, config: structuredClone(S.config), compact: S.config.compact.enabled, split: null, platform: { os: "linux" } };
    case "config.get": return { config: structuredClone(S.config), path: "~/.config/samo/config.toml", defaults: DEFAULT_CONFIG };
    case "config.set": {
      const [sec, key] = a.key.split(".");
      S.config[sec][key] = a.value;
      broadcast("config:changed", { config: structuredClone(S.config) });
      return { config: S.config };
    }
    case "compact.set": S.config.compact.enabled = !!a.enabled; broadcast("config:changed", { config: structuredClone(S.config) }); return {};
    case "ui.layout":
      chromeFrame.style.height = `${a.overlay}px`;
      page.style.top = `${a.reserve}px`;
      return {};
    case "ui.ready": document.documentElement.dataset.ready = "1"; return {};
    case "tab.new": return { id: newTab(a).id };
    case "tab.close": closeTab(a.id ?? S.activeId); return {};
    case "tab.activate": activate(a.id); return {};
    case "tab.move": {
      const i = idx(a.id); if (i < 0) return {};
      const [t] = S.tabs.splice(i, 1); S.tabs.splice(a.index, 0, t);
      toChrome("tabs:moved", { id: a.id, index: a.index }); return {};
    }
    case "tab.pin": {
      const t = tab(a.id); if (!t) return {};
      const i = idx(t.id); S.tabs.splice(i, 1);
      const pinnedCount = S.tabs.filter((x) => x.pinned).length;
      S.tabs.splice(pinnedCount, 0, t);
      update(t, { pinned: !!a.pinned });
      toChrome("tabs:moved", { id: t.id, index: pinnedCount });
      return {};
    }
    case "tab.mute": { const t = tab(a.id); t && update(t, { muted: !!a.muted }); return {}; }
    case "tab.duplicate": { const t = tab(a.id); const n = newTab({ index: idx(t.id) + 1 }); simulateLoad(n, t); return { id: n.id }; }
    case "tab.reopenClosed": { const t = S.closed.pop(); if (!t) return {}; const n = newTab({}); simulateLoad(n, t); return { id: n.id }; }
    case "nav.go": {
      const site = resolve(a.input);
      const t = a.newTab ? newTab({}) : tab(a.id);
      simulateLoad(t, site);
      return { url: site.url };
    }
    case "nav.reload": case "nav.reloadHard": { const t = tab(a.id); simulateLoad(t, { ...t }); return {}; }
    case "nav.stop": { const t = tab(a.id); update(t, { loading: false, progress: 1 }); return {}; }
    case "nav.back": case "nav.forward": { const t = tab(a.id); simulateLoad(t, SITES[(idx(t.id) + 3) % SITES.length]); return {}; }
    case "zoom.change": { const t = tab(a.id); const z = a.reset ? 0 : Math.round(((t.zoom || 0) + (a.delta || 0) * 0.5) * 100) / 100; update(t, { zoom: z }); return { zoom: z }; }
    case "find.start": {
      const count = a.text.length > 6 ? 0 : 23 - a.text.length * 3;
      S.find = { count, active: a.findNext ? (((S.find?.active || 1) + (a.forward ? 0 : -2) + count) % Math.max(count, 1)) + 1 : 1 };
      later(20, () => toChrome("find:result", { count, active: count ? S.find.active : 0, final: true }));
      return {};
    }
    case "find.stop": return {};
    case "popup.show": showPopup(a); return {};
    case "popup.update": toPopup("popup:data", { kind: S.popup.kind, data: a.data }); return {};
    case "popup.hide": hidePopup(false); return {};
    case "popup.pick": toChrome("popup:pick", { payload: a.payload }); return {};
    case "popup.resize": popupFrame.style.height = `${a.h}px`; return {};
    case "window.minimize": toast("(mock) minimize"); return {};
    case "window.toggleMaximize": S.window.maximized = !S.window.maximized; toChrome("window:state", { ...S.window }); return {};
    case "window.toggleFullscreen": S.window.fullscreen = !S.window.fullscreen; toChrome("window:state", { ...S.window }); return {};
    case "window.close": toast("(mock) close window"); return {};
    case "window.new": toast("(mock) new window"); return {};
    case "suggest": await new Promise((r) => setTimeout(r, 8)); return { items: suggest(a.query, a.limit) };
    case "bookmarks.isBookmarked": return { bookmarked: S.bookmarks.has(a.url) };
    case "bookmarks.toggle": {
      const on = !S.bookmarks.has(a.url);
      if (on) S.bookmarks.set(a.url, { url: a.url, title: a.title, added: Date.now() }); else S.bookmarks.delete(a.url);
      return { bookmarked: on };
    }
    case "bookmarks.list": return { items: [...S.bookmarks.values()] };
    case "keys.list": return { items: [] };
    case "downloads.list": return { items: [...S.downloads.values()] };
    case "permission.respond": toast(`(mock) permission ${a.allow ? "allowed" : "blocked"}`); return {};
    case "app.action": toast(`(mock) action: ${a.action}`); return {};
    case "devtools.open": toast("(mock) devtools"); return {};
    case "app.quit": toast("(mock) quit"); return {};
    case "history.list": return { items: HISTORY.map((h) => ({ ...h, lastVisit: Date.now(), visits: 3 })) };
    default:
      console.warn("[mock] unhandled", cmd, a, from);
      return {};
  }
}

function broadcast(ev, p) { toChrome(ev, p); toPopup(ev, p); }
function toast(text, kind) { toChrome("toast", { text, kind }); }

window.__samoMock_chrome = (cmd, a) => handle(cmd, a, "chrome");
window.__samoMock_popup = (cmd, a) => handle(cmd, a, "popup");
window.mock = { S, handle, toChrome, toPopup, newTab, closeTab, update, tab, toast };

// ---- Simulated Rust key handling (on_pre_key_event for all views) ---------------------------
const KEYS = [
  ["ctrl+t", () => toChrome("command", { action: "open-palette" })],
  ["ctrl+k", () => toChrome("command", { action: "command-palette" })],
  ["ctrl+shift+a", () => toChrome("command", { action: "search-tabs" })],
  ["ctrl+l", () => toChrome("command", { action: "focus-urlbar" })],
  ["ctrl+f", () => toChrome("command", { action: "find" })],
  ["ctrl+g", () => toChrome("command", { action: "find-next" })],
  ["ctrl+alt+c", () => toChrome("command", { action: "toggle-compact" })],
  ["ctrl+shift+c", () => toChrome("command", { action: "copy-url" })],
  ["ctrl+w", () => closeTab(S.activeId)],
  ["ctrl+shift+t", () => handle("tab.reopenClosed")],
  ["ctrl+tab", () => { const i = idx(S.activeId); activate(S.tabs[(i + 1) % S.tabs.length].id); }],
  ["ctrl+shift+tab", () => { const i = idx(S.activeId); activate(S.tabs[(i - 1 + S.tabs.length) % S.tabs.length].id); }],
];
function accel(e) {
  return [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt"].filter(Boolean).concat(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()).join("+");
}
function keyHook(win) {
  win.addEventListener("keydown", (e) => {
    const a = accel(e);
    const hit = KEYS.find(([k]) => k === a);
    if (hit) { e.preventDefault(); e.stopPropagation(); hit[1](); }
  }, true);
}

// ---- Load the real documents with the mock injected ---------------------------------------------
async function load(frame, file, kind) {
  let html = await (await fetch(`${UI_BASE}${file}`, { cache: "no-store" })).text();
  html = html
    .replace("<head>", `<head><base href="${UI_BASE}"><script>window.__samoMock=(c,a)=>parent.__samoMock_${kind}(c,a);<\/script>`)
    .replace("samo://theme/current.css", `${THEMES}${theme}.css`)
    .replace("samo://theme/user.css", `${UI_BASE}dev/user.css`);
  return new Promise((resolve) => {
    frame.addEventListener("load", () => { keyHook(frame.contentWindow); resolve(); }, { once: true });
    frame.srcdoc = html;
  });
}

function setTheme(id) {
  theme = id;
  S.config.ui.theme = id;
  for (const f of [chromeFrame, popupFrame]) {
    const l = f.contentDocument?.getElementById("samo-theme");
    if (l) l.href = `${THEMES}${id}.css`;
  }
  page.style.background = id.includes("light") || id === "frost" || id === "sakura" ? "linear-gradient(160deg,#ffffff,#f1f1f4)" : "linear-gradient(160deg,#f6f5f2,#ecebe6)";
  setTimeout(() => broadcast("theme:changed", {}), 50);
}

page.addEventListener("pointerdown", () => hidePopup(true));
keyHook(window);

// ---- Scenarios (for headless screenshots) ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdoc = () => chromeFrame.contentDocument;

async function scenario(name) {
  const d = cdoc();
  switch (name) {
    case "suggest": {
      const inp = d.getElementById("url-input");
      inp.focus(); inp.value = "git"; inp.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      break;
    }
    case "palette": toChrome("command", { action: "open-palette" }); await sleep(200);
      { const pd = popupFrame.contentDocument; const i = pd.querySelector(".samo-palette-input"); if (i) { i.value = params.get("q") || "rust"; i.dispatchEvent(new Event("input")); } }
      break;
    case "palette-empty": toChrome("command", { action: "open-palette" }); break;
    case "commands": toChrome("command", { action: "command-palette" }); break;
    case "menu": d.getElementById("btn-menu").click(); break;
    case "tabmenu": {
      const el = d.querySelectorAll(".samo-tab")[3];
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 30, clientY: r.bottom - 6 }));
      break;
    }
    case "find": toChrome("command", { action: "find" }); await sleep(300);
      { const i = d.getElementById("find-input"); i.value = "spring"; i.dispatchEvent(new Event("input")); }
      break;
    case "permission": toChrome("permission:request", { reqId: 1, origin: "https://meet.example.com", kinds: ["camera", "microphone"] }); break;
    case "toast": toast("Copied URL"); break;
    case "downloads":
      toChrome("download:updated", { id: 1, name: "samo-0.1.tar.gz", url: "", path: "", received: 6e6, total: 1e7, speed: 1e6, state: "progress" });
      break;
    case "drag": {
      const el = d.querySelectorAll(".samo-tab")[3];
      const r = el.getBoundingClientRect();
      const opts = (x) => ({ bubbles: true, pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: r.top + 10, pointerType: "mouse" });
      el.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + 20)));
      for (let k = 1; k <= 8; k++) { el.dispatchEvent(new PointerEvent("pointermove", opts(r.left + 20 + k * 20))); await sleep(30); }
      break;
    }
    case "overflow": break;
    case "freeze": {
      const strip = d.getElementById("tabstrip");
      strip.dispatchEvent(new PointerEvent("pointerenter"));
      const el = d.querySelectorAll(".samo-tabs-track .samo-tab")[1];
      el.querySelector(".samo-tab-close").click();
      break;
    }
    case "compact-shown": d.documentElement.dispatchEvent(new PointerEvent("pointerenter")); break;
    case "loading": for (const t of S.tabs.slice(2, 5)) simulateLoad(t, { ...t }); break;
    case "audio": update(S.tabs[3], { audible: true }); update(S.tabs[5], { muted: true, audible: true }); break;
  }
}

// ---- Panel (interactive use) ------------------------------------------------------------------------------
function panel() {
  const p = $("panel");
  p.hidden = false;
  const btn = (label, f) => { const b = document.createElement("button"); b.textContent = label; b.onclick = f; p.append(b); };
  const head = (t) => { const b = document.createElement("b"); b.textContent = t; p.append(b); };
  head("Tabs");
  btn("+ tab", () => newTab({ url: SITES[Math.floor(Math.random() * SITES.length)].url }));
  btn("+5 tabs", () => { for (let i = 0; i < 5; i++) setTimeout(() => newTab({ url: SITES[(i * 3) % SITES.length].url, active: i === 4 }), i * 60); });
  btn("close active", () => closeTab(S.activeId));
  btn("load active", () => simulateLoad(tab(), { ...tab() }));
  btn("audio", () => { const t = tab(); update(t, { audible: !t.audible }); });
  btn("crash", () => { const t = tab(); update(t, { crashed: !t.crashed }); });
  btn("pin", () => handle("tab.pin", { id: S.activeId, pinned: !tab().pinned }));
  btn("next (kbd)", () => { const i = idx(S.activeId); activate(S.tabs[(i + 1) % S.tabs.length].id); });
  head("UI");
  btn("palette", () => toChrome("command", { action: "open-palette" }));
  btn("commands", () => toChrome("command", { action: "command-palette" }));
  btn("find", () => toChrome("command", { action: "find" }));
  btn("toast", () => toast("Copied URL"));
  btn("perm", () => toChrome("permission:request", { reqId: Date.now(), origin: "https://meet.example.com", kinds: ["camera", "microphone"] }));
  btn("download", () => {
    const id = Date.now(); let got = 0;
    const tick = () => { got += 1.5e6; const done = got >= 1e7; toChrome("download:updated", { id, name: "file.zip", url: "", path: "", received: Math.min(got, 1e7), total: 1e7, speed: 1e6, state: done ? "complete" : "progress" }); if (!done) setTimeout(tick, 250); };
    tick();
  });
  head("Config");
  btn("compact mode", () => toChrome("command", { action: "toggle-compact" }));
  btn("density", () => handle("config.set", { key: "ui.density", value: S.config.ui.density === "compact" ? "normal" : "compact" }));
  btn("indicator", () => handle("config.set", { key: "tabs.indicator", value: S.config.tabs.indicator === "card" ? "underline" : "card" }));
  btn("close btn", () => handle("config.set", { key: "tabs.close_button", value: { hover: "always", always: "active", active: "hover" }[S.config.tabs.close_button] }));
  btn("wc side", () => handle("config.set", { key: "ui.window_controls", value: { right: "left", left: "none", none: "right" }[S.config.ui.window_controls] }));
  btn("slow-mo", () => handle("config.set", { key: "ui.animation_speed", value: S.config.ui.animation_speed === 1 ? 4 : 1 }));
  btn("reduce motion", () => handle("config.set", { key: "ui.reduce_motion", value: !S.config.ui.reduce_motion }));
  for (const t of ["samo-dark", "samo-light", "midnight", "oled", "frost", "sakura", "dusk"]) btn(t, () => setTheme(t));
}

(async () => {
  await Promise.all([load(chromeFrame, "chrome.html", "chrome"), load(popupFrame, "popup.html", "popup")]);
  setTheme(theme);
  if (params.get("panel") === "1") panel();
  const sc = params.get("scenario");
  if (sc) {
    const t0 = performance.now();
    while (!document.documentElement.dataset.ready && performance.now() - t0 < 3000) await sleep(20);
    await sleep(150);
    for (const s of sc.split(",")) { await scenario(s); await sleep(250); }
  }
  if (params.get("debug") === "1") {
    await sleep(600);
    const d = cdoc();
    const pre = document.createElement("pre");
    pre.id = "debug";
    pre.textContent = JSON.stringify({
      strip: d.getElementById("tabstrip").clientWidth,
      scroller: d.getElementById("tabs-scroll").style.width, track: d.getElementById("tabs-track").style.width,
      tabs: [...d.querySelectorAll(".samo-tab")].map((t) => ({ id: t.dataset.id, x: t.style.translate, w: t.style.width, a: t.hasAttribute("active"), drag: t.hasAttribute("dragging"), parent: t.parentNode.id })),
    }, null, 1);
    document.body.append(pre);
  }
  document.documentElement.dataset.scenarioDone = "1";
})();
