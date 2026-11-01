// Samo chrome entry: owns the tab model, wires Rust events to the UI modules.
import { samo } from "./shared/bridge.js";
import { hydrateIcons } from "./chrome/icons.js";
import { root, refreshMotion, safeCall, setKeys } from "./chrome/util.js";
import { TabStrip } from "./chrome/tabstrip.js";
import { UrlBar } from "./chrome/urlbar.js";
import { Toolbar } from "./chrome/toolbar.js";
import { PopupClient } from "./chrome/popup-client.js";
import { Commands, Permissions } from "./chrome/commands.js";
import { FindBar } from "./chrome/findbar.js";
import { Layout, Compact } from "./chrome/compact.js";
import { Accent } from "./chrome/accent.js";

const state = {
  tabs: new Map(),   // id -> Tab (ARCHITECTURE §4.1), mutated in place
  order: [],         // tab ids in strip order (pinned first)
  activeId: null,
  config: null,
  window: {},
  platform: {},
};

const app = {
  samo,
  state,
  activeTab: () => state.tabs.get(state.activeId),

  activate(id, { pointer = false } = {}) {
    if (!state.tabs.has(id)) return;
    if (state.activeId !== id) {
      const prev = state.activeId;
      state.activeId = id;
      app.strip.activated(id, prev);
      onActiveChanged();
    }
    if (pointer) safeCall(samo, "tab.activate", { id });
  },

  closeTab(id, { mouse = false } = {}) {
    if (!state.tabs.has(id)) return;
    if (mouse) app.strip.prepareMouseClose(id);
    if (state.activeId === id) {
      // Predict Rust's choice (right neighbour, else left) so the strip never shows "no active tab".
      const i = state.order.indexOf(id);
      const next = state.order[i + 1] ?? state.order[i - 1] ?? null;
      dropTab(id);
      if (next != null) { state.activeId = next; app.strip.activated(next, null); }
      else state.activeId = null;
      onActiveChanged();
    } else {
      dropTab(id);
    }
    samo.call("tab.close", { id }).catch(resync);
  },

  setMuted(id, muted) {
    const t = state.tabs.get(id);
    if (!t) return;
    t.muted = muted;
    app.strip.tabUpdated(id, { muted });
    safeCall(samo, "tab.mute", { id, muted });
  },

  runAction: (a, args) => app.commands.run(a, args),
  toast: (text, kind) => app.toolbar.toast(text, kind),

  async copyUrl(markdown) {
    const t = app.activeTab();
    if (!t?.url) return;
    const title = (t.title || t.url).replace(/([[\]])/g, "\\$1");
    const text = markdown ? `[${title}](${t.url})` : t.url;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    app.toast(ok ? (markdown ? "Copied as Markdown" : "Copied URL") : "Couldn't copy to clipboard", ok ? "info" : "error");
  },
};

function dropTab(id) {
  state.tabs.delete(id);
  const i = state.order.indexOf(id);
  if (i >= 0) state.order.splice(i, 1);
  app.strip.removed(id);
}

function onActiveChanged() {
  if (app.urlbar.editing && !app.urlbar.focused) app.urlbar.revert();
  app.urlbar.sync();
  app.toolbar.sync();
  app.accent.apply();
}

function setModel(tabs, activeId) {
  state.tabs = new Map((tabs || []).map((t) => [t.id, { ...t }]));
  state.order = (tabs || []).map((t) => t.id);
  state.activeId = activeId ?? state.order[0] ?? null;
}

let resyncing = null;
function resync() {
  if (resyncing) return resyncing;
  resyncing = samo.call("state.get").then((s) => {
    setModel(s.tabs, s.activeId);
    app.strip.rebuild();
    onActiveChanged();
  }).catch(() => {}).finally(() => { resyncing = null; });
  return resyncing;
}

// ---- Rust events -------------------------------------------------------------------
samo.on("tabs:created", ({ tab, index, active }) => {
  if (!tab || state.tabs.has(tab.id)) return;
  state.tabs.set(tab.id, { ...tab });
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, state.order.length)) : state.order.length;
  state.order.splice(i, 0, tab.id);
  let prev = null;
  if (active) { prev = state.activeId; state.activeId = tab.id; }
  app.strip.tabCreated(tab.id, prev);
  if (active) { onActiveChanged(); app.compact.flash(); }
});

samo.on("tabs:updated", (p) => {
  const t = p && state.tabs.get(p.id);
  if (!t) return;
  const changed = {};
  for (const k in p) if (k !== "id" && t[k] !== p[k]) { changed[k] = p[k]; t[k] = p[k]; }
  if (!Object.keys(changed).length) return;
  app.strip.tabUpdated(p.id, changed);
  if (p.id === state.activeId) {
    app.urlbar.sync();
    app.toolbar.sync();
    if ("themeColor" in changed) app.accent.apply();
  }
});

samo.on("tabs:closed", ({ id }) => {
  if (!state.tabs.has(id)) return;
  dropTab(id);
  if (state.activeId === id) { state.activeId = null; onActiveChanged(); }
});

samo.on("tabs:activated", ({ id }) => {
  if (state.activeId === id || !state.tabs.has(id)) return;
  const prev = state.activeId;
  state.activeId = id;
  app.strip.activated(id, prev);
  onActiveChanged();
  app.compact.flash();
});

samo.on("tabs:moved", ({ id, index }) => {
  const i = state.order.indexOf(id);
  if (i < 0 || i === index) return;
  state.order.splice(i, 1);
  state.order.splice(Math.max(0, Math.min(index, state.order.length)), 0, id);
  app.strip.tabMoved();
});

samo.on("tabs:sync", ({ tabs, activeId }) => {
  setModel(tabs, activeId);
  app.strip.rebuild();
  onActiveChanged();
});

samo.on("window:state", (s) => {
  Object.assign(state.window, s || {});
  root.toggleAttribute("data-maximized", !!state.window.maximized);
  root.toggleAttribute("data-fullscreen", !!state.window.fullscreen);
  root.dataset.windowFocused = String(state.window.focused !== false);
  app.strip.renderWindowControls(state.window);
});

samo.on("toast", (p) => p?.text && app.toast(p.text, p.kind));

samo.on("command", ({ action, args } = {}) => {
  switch (action) {
    case "find-next": return app.find.step(true);
    case "find-prev": return app.find.step(false);
    case "escape": return escape();
    default: return app.commands.run(action, args);
  }
});

function escape() {
  const p = app.popup;
  if (p.is("suggest")) return app.urlbar.escape();
  if (p.open) return p.update({ __cmd: "escape" }); // popup document decides (clear input / close)
  if (app.find.isOpen && document.activeElement === app.find.input) return app.find.close();
  app.urlbar.escape();
}

let lastCompactCfg = null;
samo.on("config:applied", (cfg) => {
  state.config = cfg;
  refreshMotion();
  root.dataset.hideThrobber = String(!!cfg?.tabs?.hide_throbber);
  const cc = !!cfg?.compact?.enabled;
  if (lastCompactCfg !== null && cc !== lastCompactCfg) app.compact.set(cc);
  else root.dataset.compact = String(app.compact.enabled);
  lastCompactCfg = cc;
  if (!booted) return;
  app.strip.readMetrics();
  app.strip.renderWindowControls(state.window);
  app.strip.measureFixed();
  app.strip.layout("base");
  for (const id of state.tabs.keys()) app.strip.tabUpdated(id, {});
  app.urlbar.sync(true);
  app.accent.apply();
  app.layout.update();
});

samo.on("theme:changed", () => {
  // bridge.js swaps the <link>; re-measure once the new sheet is in.
  const links = document.querySelectorAll("link#samo-theme, link#samo-user");
  let n = 0;
  const done = () => {
    if (++n < links.length) return;
    app.themeGen = (app.themeGen || 0) + 1;
    app.strip.readMetrics();
    app.strip.measureFixed();
    app.strip.layout("none");
    app.accent.apply();
    app.layout.update();
  };
  links.forEach((l) => { l.addEventListener("load", done, { once: true }); l.addEventListener("error", done, { once: true }); });
  setTimeout(() => { n = links.length - 1; done(); }, 400);
});

// ---- Chrome-local input ---------------------------------------------------------
addEventListener("contextmenu", (e) => {
  if (!e.target.closest?.("input, textarea")) e.preventDefault();
});

// ---- Boot ---------------------------------------------------------------------------
let booted = false;
async function boot() {
  hydrateIcons(document);
  app.popup = new PopupClient(app);
  app.layout = new Layout(app);
  app.compact = new Compact(app);
  app.accent = new Accent(app);
  app.strip = new TabStrip(app);
  app.urlbar = new UrlBar(app);
  app.toolbar = new Toolbar(app);
  app.commands = new Commands(app);
  app.menus = app.commands;
  app.permissions = new Permissions(app);
  app.find = new FindBar(app);

  let s = {};
  try { s = await samo.call("state.get"); } catch (e) { console.error("[samo] state.get failed", e); }
  Object.assign(state.window, s.window || {});
  state.platform = s.platform || {};
  if (s.config) samo.applyConfig(s.config);
  state.config = s.config || state.config || {};
  refreshMotion();
  const compactOn = s.compact ?? !!state.config?.compact?.enabled;
  app.compact.enabled = compactOn;
  root.dataset.compact = String(compactOn);
  root.dataset.compactShown = String(!compactOn);
  root.toggleAttribute("data-maximized", !!state.window.maximized);
  root.toggleAttribute("data-fullscreen", !!state.window.fullscreen);
  root.dataset.platform = state.platform.os || "linux";

  setModel(s.tabs, s.activeId);
  app.strip.readMetrics();
  app.strip.renderWindowControls(state.window);
  app.strip.rebuild();
  app.toolbar.titles();
  onActiveChanged();
  booted = true;

  await app.layout.update();
  await safeCall(samo, "ui.ready");
  root.dataset.ready = "true";

  // Non-critical data after first paint.
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 50));
  idle(async () => {
    const k = await safeCall(samo, "keys.list");
    if (k?.items) { setKeys(k.items); app.toolbar.titles(); }
    const d = await safeCall(samo, "downloads.list");
    if (d?.items) app.toolbar.seedDownloads(d.items);
  });
}

window.__samoChrome = app; // debugging handle (devtools / CDP)
boot();
