// Actions, command palette, menus (app / tab / strip) and permission prompts — all rendered
// in the popup surface; this module builds their data and performs the picks.
import { $, safeCall, shortcut, isNewTabUrl } from "./util.js";
import { engineName } from "./urlbar.js";

// Palette ">" commands. `action` is a key-action name (ARCHITECTURE §6) or a UI-local one.
const COMMANDS = [
  ["new-tab", "New tab", "plus"],
  ["new-window", "New window", "panel-top"],
  ["reopen-closed-tab", "Reopen closed tab", "history"],
  ["close-tab", "Close tab", "x"],
  ["duplicate-tab", "Duplicate tab", "copy"],
  ["pin-tab", "Pin / unpin tab", "pin"],
  ["mute-tab", "Mute / unmute tab", "volume-x"],
  ["toggle-compact", "Toggle compact mode", "minimize-2"],
  ["copy-url", "Copy URL", "copy"],
  ["copy-url-markdown", "Copy URL as Markdown", "copy"],
  ["find", "Find in page", "search"],
  ["reload", "Reload", "rotate-cw"],
  ["hard-reload", "Hard reload", "rotate-cw"],
  ["zoom-in", "Zoom in", "zoom-in"],
  ["zoom-out", "Zoom out", "zoom-out"],
  ["zoom-reset", "Reset zoom", "zoom-out"],
  ["fullscreen", "Toggle full screen", "maximize-2"],
  ["split-vertical", "Split view: side by side", "columns"],
  ["split-horizontal", "Split view: stacked", "layout"],
  ["unsplit", "Close split view", "rows"],
  ["bookmark", "Bookmark this tab", "star"],
  ["history", "History", "history"],
  ["downloads", "Downloads", "download"],
  ["settings", "Settings", "settings"],
  ["toggle-density", "Toggle compact density", "layout"],
  ["reload-theme", "Reload theme and user.css", "sparkles"],
  ["devtools", "Developer tools", "command"],
  ["quit", "Quit Samo", "power"],
];

const PALETTE_KEEP_MS = 45_000;

export class Commands {
  constructor(app) {
    this.app = app;
    this.samo = app.samo;
    this.lastPalette = { input: "", at: 0 };
  }

  get tab() { return this.app.activeTab(); }

  // ---- Actions ------------------------------------------------------------------
  run(action, args = {}) {
    const app = this.app, v = this.samo, t = this.tab, id = args.id ?? t?.id;
    switch (action) {
      case "new-tab": return safeCall(v, "tab.new", {});
      case "new-window": return safeCall(v, "window.new");
      case "close-tab": return id != null && app.closeTab(id);
      case "reopen-closed-tab": return safeCall(v, "tab.reopenClosed");
      case "duplicate-tab": return safeCall(v, "tab.duplicate", { id });
      case "pin-tab": return t && safeCall(v, "tab.pin", { id, pinned: !app.state.tabs.get(id)?.pinned });
      case "mute-tab": return t && app.setMuted(id, !app.state.tabs.get(id)?.muted);
      case "reload": return safeCall(v, "nav.reload", { id });
      case "hard-reload": return safeCall(v, "nav.reloadHard", { id });
      case "zoom-in": return safeCall(v, "zoom.change", { delta: 1 });
      case "zoom-out": return safeCall(v, "zoom.change", { delta: -1 });
      case "zoom-reset": return safeCall(v, "zoom.change", { reset: true });
      case "fullscreen": return safeCall(v, "window.toggleFullscreen");
      case "devtools": return safeCall(v, "devtools.open", { id });
      case "quit": return safeCall(v, "app.quit");
      case "bookmark": return app.urlbar.toggleBookmark();
      case "toggle-compact": return app.compact.toggle();
      case "toggle-density": {
        const next = app.state.config?.ui?.density === "compact" ? "normal" : "compact";
        return safeCall(v, "config.set", { key: "ui.density", value: next });
      }
      case "copy-url": return app.copyUrl(false);
      case "copy-url-markdown": return app.copyUrl(true);
      case "find": return app.find.open();
      case "focus-urlbar": return app.urlbar.focus();
      case "open-palette": return this.palette("default");
      case "command-palette": return this.palette("commands");
      case "search-tabs": return this.palette("tabs");
      default: return safeCall(v, "app.action", { action });
    }
  }

  commandList() {
    return COMMANDS.map(([action, title, icon]) => ({ type: "command", action, title, icon, shortcut: shortcut(action) }));
  }

  // ---- Command palette ---------------------------------------------------------
  palette(mode = "default") {
    const app = this.app;
    app.urlbar.closeSuggestions();
    app.compact.reveal();
    let input = "";
    if (mode === "commands") input = "> ";
    else if (mode === "tabs") input = "@tabs ";
    else if (performance.now() - this.lastPalette.at < PALETTE_KEEP_MS) input = this.lastPalette.input;
    const st = app.state;
    const tabs = st.order.map((id) => st.tabs.get(id)).filter(Boolean).map((t) => ({
      id: t.id, title: t.title || t.url, url: t.url, favicon: t.favicon, active: t.id === st.activeId, pinned: t.pinned,
    }));
    const vw = innerWidth;
    const w = Math.round(Math.max(Math.min(vw / 1.5, 720), Math.min(480, vw - 32)));
    const winH = st.window?.height || (outerHeight > innerHeight + 100 ? outerHeight : 0) || Math.round(screen.availHeight * 0.92);
    const y = Math.max(app.layout.height + 24, Math.round(winH * 0.2));
    const data = {
      mode, input, tabs, commands: this.commandList(), engine: engineName(st.config),
      limit: st.config?.urlbar?.max_suggestions || 8,
      newTabDefault: mode !== "tabs",
    };
    app.popup.show("palette", { x: (vw - w) / 2, y, w, h: 56 + 8 * 44 + 48 }, data, {
      owner: "palette",
      focus: true,
      onPick: (p) => this.palettePick(p),
      onHide: () => {},
    });
  }

  palettePick(p) {
    if (!p) return;
    if (typeof p.input === "string") this.lastPalette = { input: p.input.startsWith(">") || p.input.startsWith("@") ? "" : p.input, at: performance.now() };
    if (p.type === "dismiss") { this.app.popup.hide("palette"); return; }
    if (p.type !== "palette") return;
    const it = p.item || {};
    this.app.popup.hide("palette");
    this.lastPalette = { input: "", at: 0 };
    if (it.type === "command" && it.action) { this.run(it.action); return; }
    if (it.type === "tab" && it.tabId != null) { this.app.activate(it.tabId, { pointer: true }); return; }
    const input = (it.typed ? p.input : it.url || it.title || p.input || "").trim();
    if (!input) return;
    let newTab = !!p.newTab;
    if (newTab && isNewTabUrl(this.tab?.url, this.app.state.config)) newTab = false; // reuse a blank tab
    safeCall(this.samo, "nav.go", { input, newTab });
  }

  // ---- Menus ---------------------------------------------------------------------
  showMenu(menu, items, anchor, ctx = {}) {
    const w = 272;
    const h = 12 + items.reduce((s, it) => s + (it.type === "separator" ? 9 : it.type === "zoom" ? 40 : 32), 0);
    const x = Math.max(4, Math.min(anchor.x, innerWidth - w - 4));
    this.menuState = { menu, items, ctx };
    this.app.popup.show("menu", { x, y: anchor.y, w, h }, { menu, items, ctx }, {
      owner: "menu", focus: true,
      onPick: (p) => this.menuPick(p),
    });
  }

  appMenu() {
    const btn = $("btn-menu").getBoundingClientRect();
    const st = this.app.state;
    const zoom = this.tab?.zoom || 0;
    const items = [
      { id: "new-tab", label: "New tab", icon: "plus", shortcut: shortcut("new-tab") },
      { id: "new-window", label: "New window", icon: "panel-top", shortcut: shortcut("new-window") },
      { type: "separator" },
      { id: "history", label: "History", icon: "history", shortcut: shortcut("history") },
      { id: "downloads", label: "Downloads", icon: "download", shortcut: shortcut("downloads") },
      { id: "bookmarks", label: "Bookmarks", icon: "bookmark", submenu: true },
      { type: "separator" },
      { type: "zoom", id: "zoom", label: "Zoom", value: `${Math.round(Math.pow(1.2, zoom) * 100)}%` },
      { id: "find", label: "Find in page…", icon: "search", shortcut: shortcut("find") },
      { id: "toggle-compact", label: "Compact mode", icon: "minimize-2", shortcut: shortcut("toggle-compact"), checked: this.app.compact.enabled },
      { type: "separator" },
      { id: "settings", label: "Settings", icon: "settings", shortcut: shortcut("settings") },
      { id: "devtools", label: "Developer tools", icon: "command", shortcut: shortcut("devtools") },
      { type: "separator" },
      { id: "quit", label: "Quit Samo", icon: "power", shortcut: shortcut("quit") },
    ];
    this.showMenu("app", items, { x: btn.right - 272, y: btn.bottom + 4 });
  }

  tabMenu(id, x, y) {
    const st = this.app.state, t = st.tabs.get(id);
    if (!t) return;
    const idx = st.order.indexOf(id);
    const items = [
      { id: "new-right", label: "New tab to the right", icon: "plus" },
      { type: "separator" },
      { id: "reload", label: "Reload", icon: "rotate-cw", shortcut: shortcut("reload") },
      { id: "duplicate", label: "Duplicate", icon: "copy", shortcut: shortcut("duplicate-tab") },
      { id: "pin", label: t.pinned ? "Unpin tab" : "Pin tab", icon: "pin", shortcut: shortcut("pin-tab") },
      { id: "mute", label: t.muted ? "Unmute tab" : "Mute tab", icon: t.muted ? "volume-2" : "volume-x", shortcut: shortcut("mute-tab") },
      { type: "separator" },
      { id: "close", label: "Close tab", icon: "x", shortcut: shortcut("close-tab") },
      { id: "close-others", label: "Close other tabs", disabled: st.order.length < 2 },
      { id: "close-right", label: "Close tabs to the right", disabled: idx === st.order.length - 1 },
      { type: "separator" },
      { id: "reopen", label: "Reopen closed tab", icon: "history", shortcut: shortcut("reopen-closed-tab") },
    ];
    this.showMenu("tab", items, { x, y }, { tabId: id });
  }

  stripMenu(x, y) {
    const items = [
      { id: "new-tab", label: "New tab", icon: "plus", shortcut: shortcut("new-tab") },
      { id: "reopen", label: "Reopen closed tab", icon: "history", shortcut: shortcut("reopen-closed-tab") },
      { type: "separator" },
      { id: "toggle-compact", label: "Compact mode", icon: "minimize-2", checked: this.app.compact.enabled },
    ];
    this.showMenu("strip", items, { x, y });
  }

  async menuPick(p) {
    if (!p) return;
    const app = this.app, v = this.samo;
    if (p.type === "dismiss") { app.popup.hide("menu"); return; }
    const ms = this.menuState || {};
    const id = p.id;
    const tabId = ms.ctx?.tabId;
    // Items that keep the menu open.
    if (id === "zoom-in" || id === "zoom-out" || id === "zoom-reset") {
      const r = await safeCall(v, "zoom.change", id === "zoom-reset" ? { reset: true } : { delta: id === "zoom-in" ? 1 : -1 });
      const z = r?.zoom ?? app.activeTab()?.zoom ?? 0;
      const zi = ms.items?.find((it) => it.type === "zoom");
      if (zi) { zi.value = `${Math.round(Math.pow(1.2, z) * 100)}%`; app.popup.update({ menu: ms.menu, items: ms.items, ctx: ms.ctx }); }
      return;
    }
    if (id === "bookmarks") {
      const r = await safeCall(v, "bookmarks.list");
      const list = (r?.items || []).slice(0, 24);
      const items = [{ id: "back", label: "Bookmarks", icon: "arrow-left", type: "back" }, { type: "separator" }];
      if (!list.length) items.push({ id: "none", label: "No bookmarks yet", disabled: true });
      list.forEach((b, i) => items.push({ id: `bm:${i}`, label: b.title || b.url, sub: b.url, icon: "star", url: b.url }));
      this.menuState = { menu: "bookmarks", items, ctx: {} };
      app.popup.update({ menu: "bookmarks", items, ctx: {} });
      return;
    }
    if (id === "back") { app.popup.hide("menu"); this.appMenu(); return; }
    app.popup.hide("menu");
    if (id?.startsWith("bm:")) {
      const it = ms.items.find((x) => x.id === id);
      if (it?.url) safeCall(v, "nav.go", { input: it.url });
      return;
    }
    const st = app.state;
    switch (id) {
      case "fullscreen": return this.run("fullscreen");
      case "new-right": {
        const idx = st.order.indexOf(tabId);
        return safeCall(v, "tab.new", { index: idx + 1 });
      }
      case "reload": return safeCall(v, "nav.reload", { id: tabId ?? app.activeTab()?.id });
      case "duplicate": return safeCall(v, "tab.duplicate", { id: tabId });
      case "pin": return safeCall(v, "tab.pin", { id: tabId, pinned: !st.tabs.get(tabId)?.pinned });
      case "mute": return app.setMuted(tabId, !st.tabs.get(tabId)?.muted);
      case "close": return app.closeTab(tabId);
      case "close-others":
        for (const o of [...st.order]) if (o !== tabId && !st.tabs.get(o)?.pinned) app.closeTab(o);
        return;
      case "close-right": {
        const idx = st.order.indexOf(tabId);
        for (const o of st.order.slice(idx + 1)) app.closeTab(o);
        return;
      }
      case "reopen": return safeCall(v, "tab.reopenClosed");
      default: return this.run(id);
    }
  }
}

// ---- Permission prompts ----------------------------------------------------------
export class Permissions {
  constructor(app) {
    this.app = app;
    this.pending = [];
    app.samo.on("permission:request", (req) => {
      if (!req?.reqId && req?.reqId !== 0) return;
      this.pending.push(req);
      app.urlbar.sync(true);
      if (!app.popup.open) this.show(req);
    });
  }

  show(req) {
    const r = $("urlbar").getBoundingClientRect();
    const h = 64 + 32 * Math.max(1, req.kinds?.length || 1) + 56;
    this.app.popup.show("permission", { x: r.left, y: r.bottom + 4, w: 340, h }, req, {
      owner: "permission", focus: true,
      onPick: (p) => {
        if (p?.type === "dismiss") { this.app.popup.hide("permission"); return; }
        if (p?.type !== "permission") return;
        safeCall(this.app.samo, "permission.respond", { reqId: p.reqId, allow: !!p.allow });
        this.pending = this.pending.filter((x) => x.reqId !== p.reqId);
        this.app.popup.hide("permission");
        this.app.urlbar.sync(true);
        if (this.pending.length) setTimeout(() => this.show(this.pending[0]), 120);
      },
    });
  }

  reopen() { if (this.pending.length) this.show(this.pending[0]); }
}
