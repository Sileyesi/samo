// Popup surface: one opaque overlay view that renders whatever the chrome asks for
// (`popup:data {kind, data}`): suggest | palette | menu | permission.
// Picks go back through `popup.pick {payload}`; the chrome performs them.
import { samo } from "./shared/bridge.js";
import { icon } from "./chrome/icons.js";
import { esc, debounce } from "./chrome/util.js";
import { typedRow, isTypedSearch } from "./chrome/urlbar.js";

const host = document.getElementById("popup");
let view = null;
let lastOpen = -1;

const pick = (payload) => samo.call("popup.pick", { payload }).catch(() => {});

// ---- Fit the native surface to the content ------------------------------------------
let fitT = 0;
function fit(lazyShrink = false) {
  cancelAnimationFrame(fitT);
  fitT = requestAnimationFrame(() => {
    const h = Math.ceil(host.getBoundingClientRect().height);
    if (!h || Math.abs(h - innerHeight) < 1) return;
    if (h < innerHeight && lazyShrink) { shrinkLater(h); return; }
    shrinkLater.cancel();
    samo.call("popup.resize", { h }).catch(() => {});
  });
}
const shrinkLater = debounce((h) => samo.call("popup.resize", { h }).catch(() => {}), 160);

// ---- Shared row helpers -------------------------------------------------------------
const TYPE_ICON = { tab: "layers", history: "history", bookmark: "star", search: "search", url: "globe", command: "command" };

function mark(text, query) {
  const s = String(text ?? "");
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0 && !/^[>@]/.test(w)).slice(0, 4);
  if (!words.length) return esc(s);
  const lower = s.toLowerCase();
  const hits = new Array(s.length).fill(false);
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) { for (let k = i; k < i + w.length; k++) hits[k] = true; i = lower.indexOf(w, i + w.length); }
  }
  let out = "", on = false;
  for (let i = 0; i < s.length; i++) {
    if (hits[i] !== on) { out += on ? "</mark>" : "<mark>"; on = hits[i]; }
    out += esc(s[i]);
  }
  return on ? out + "</mark>" : out;
}

function prettyUrl(u) {
  if (!u) return "";
  return String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

function rowIcon(it, size = 16) {
  if (it.favicon) return `<img src="${esc(it.favicon)}" alt="" width="${size}" height="${size}" draggable="false" data-fb="${esc(TYPE_ICON[it.type] || "globe")}">`;
  return icon(it.icon || TYPE_ICON[it.type] || "globe", size);
}

function badge(it, selected) {
  if (it.type === "tab") return `<span class="samo-row-badge">Switch to tab</span>`;
  if (it.type === "command" && it.shortcut) return `<kbd class="samo-row-kbd">${esc(it.shortcut)}</kbd>`;
  if (it.typed && it.badge) return `<span class="samo-row-badge" data-soft="${selected ? "" : "1"}">${esc(it.badge)}</span>`;
  return "";
}

function rowHtml(it, i, sel, query) {
  const title = it.title || prettyUrl(it.url) || "";
  const showUrl = it.url && !it.typed && it.type !== "search" && it.type !== "command";
  return `<div class="samo-row" role="option" data-i="${i}" data-type="${esc(it.type)}" aria-selected="${i === sel}">
    <span class="samo-row-icon">${rowIcon(it)}</span>
    <span class="samo-row-text"><span class="samo-row-title">${mark(title, query)}</span>${showUrl ? `<span class="samo-row-url">${mark(prettyUrl(it.url), query)}</span>` : ""}</span>
    ${badge(it, i === sel)}
  </div>`;
}

// ---- Suggest (attached under the URL bar) -------------------------------------------------
const suggestView = {
  render(d) {
    host.dataset.kind = "suggest";
    const items = d.items || [];
    host.style.setProperty("--row-h", `${d.rowH || 36}px`);
    host.innerHTML = `<div class="samo-suggest" role="listbox">${items.map((it, i) => rowHtml(it, i, d.selected, d.query)).join("")}</div>`;
    fit();
  },
  bind() {
    host.onmousedown = (e) => {
      const row = e.target.closest(".samo-row");
      e.preventDefault();
      if (!row) return;
      pick({ type: "suggest", index: +row.dataset.i, middle: e.button === 1, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, newTab: e.button === 1 || e.ctrlKey });
    };
  },
  escape() { pick({ type: "dismiss" }); },
};

// ---- Command palette ---------------------------------------------------------------------
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return 1;
  const direct = s.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 || s[direct - 1] === " " ? 50 : 0);
  let score = 0, j = 0, prev = -2;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { score += i === prev + 1 ? 3 : (i === 0 || s[i - 1] === " ") ? 4 : 1; prev = i; j++; }
  }
  return j === q.length ? score : -1;
}

const paletteView = {
  d: null, items: [], sel: 0, seq: 0, lastEsc: 0,
  render(d) {
    this.d = d;
    host.dataset.kind = "palette";
    host.innerHTML = `<div class="samo-palette" data-enter>
      <div class="samo-palette-head">
        <span class="samo-palette-glyph">${icon("search", 18)}</span>
        <span class="samo-palette-scope" hidden></span>
        <input class="samo-palette-input" type="text" spellcheck="false" autocomplete="off" aria-label="Search, enter address, or type > for commands" placeholder="Search or enter address — type > for commands">
        <kbd class="samo-row-kbd">Esc</kbd>
      </div>
      <div class="samo-palette-list" role="listbox"></div>
      <div class="samo-palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span class="samo-foot-enter"><kbd>↵</kbd> <b></b></span>
        <span class="samo-foot-shift"><kbd>⇧</kbd><kbd>↵</kbd> current tab</span>
        <span class="samo-foot-end"><kbd>&gt;</kbd> commands <kbd>@tabs</kbd> tabs</span>
      </div>
    </div>`;
    this.input = host.querySelector(".samo-palette-input");
    this.list = host.querySelector(".samo-palette-list");
    this.input.value = d.input || "";
    this.input.addEventListener("input", () => this.query());
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.list.addEventListener("mousemove", (e) => {
      const row = e.target.closest(".samo-row");
      if (row && +row.dataset.i !== this.sel) { this.sel = +row.dataset.i; this.paintSel(); }
    });
    this.list.addEventListener("mousedown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      const row = e.target.closest(".samo-row");
      if (row) this.commit(+row.dataset.i, { shift: e.shiftKey });
    });
    this.list.addEventListener("auxclick", (e) => {
      const row = e.target.closest(".samo-row");
      if (row && e.button === 1) this.commit(+row.dataset.i, { forceNew: true });
    });
    requestAnimationFrame(() => {
      this.input.focus();
      // A prefilled scope (">", "@tabs ") keeps the caret at the end; a remembered query is selected.
      if (/^[>@]/.test(this.input.value)) this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      else this.input.select();
    });
    this.query();
  },

  mode() {
    const v = this.input.value;
    if (v.startsWith(">")) return ["commands", v.slice(1).trim()];
    const m = /^@tabs\b\s*/i.exec(v);
    if (m) return ["tabs", v.slice(m[0].length).trim()];
    return ["default", v];
  },

  async query() {
    const seq = ++this.seq;
    const [mode, q] = this.mode();
    const d = this.d;
    const limit = d.limit || 8;
    const scope = host.querySelector(".samo-palette-scope");
    scope.hidden = mode === "default";
    scope.textContent = mode === "commands" ? "Commands" : mode === "tabs" ? "Tabs" : "";
    host.querySelector(".samo-palette-glyph").innerHTML = icon(mode === "commands" ? "command" : mode === "tabs" ? "layers" : "search", 18);
    let items;
    if (mode === "commands") {
      items = (d.commands || []).map((c) => [fuzzy(q, c.title), c]).filter(([s]) => s >= 0)
        .sort((a, b) => b[0] - a[0]).slice(0, Math.max(limit, 10)).map(([, c]) => c);
    } else if (mode === "tabs" || !q.trim()) {
      const tabs = (d.tabs || []).filter((t) => mode === "tabs" || !t.active);
      items = tabs.map((t) => [fuzzy(q, `${t.title} ${t.url}`), t]).filter(([s]) => s >= 0)
        .sort((a, b) => (q ? b[0] - a[0] : 0)).slice(0, limit)
        .map(([, t]) => ({ type: "tab", tabId: t.id, title: t.title, url: t.url, favicon: t.favicon }));
    } else {
      const typed = typedRow(q, null);
      if (typed.type === "search") typed.badge = `Search ${d.engine || ""}`.trim();
      const cmds = q.trim().length >= 2
        ? (d.commands || []).map((c) => [fuzzy(q, c.title), c]).filter(([s]) => s >= 40).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, c]) => c)
        : [];
      this.setItems([typed, ...cmds], q, true);
      let r = null;
      try { r = await samo.call("suggest", { query: q.trim(), limit }); } catch { r = null; }
      if (seq !== this.seq) return;
      const seen = new Set([typed.url, typed.title.trim()]);
      const rest = (r?.items || []).filter((it) => {
        if (it.type === "search" && (seen.has((it.title || "").trim()) || isTypedSearch(it, q.trim()))) return false;
        if (it.url && seen.has(it.url)) return false;
        return true;
      });
      items = [typed, ...rest.slice(0, Math.max(0, limit - 1 - cmds.length)), ...cmds];
    }
    if (seq !== this.seq) return;
    this.setItems(items, q, false);
  },

  setItems(items, q, provisional) {
    this.items = items;
    this.sel = Math.min(this.sel, Math.max(0, items.length - 1));
    if (!provisional) this.sel = 0;
    const [mode] = this.mode();
    if (!items.length) {
      this.list.innerHTML = `<div class="samo-palette-empty">${mode === "tabs" ? "No matching tabs" : mode === "commands" ? "No matching commands" : "Start typing to search"}</div>`;
    } else {
      this.list.innerHTML = items.map((it, i) => rowHtml(it, i, this.sel, q)).join("");
    }
    this.paintFoot();
    fit(provisional);
  },

  paintSel() {
    for (const row of this.list.children) row.setAttribute("aria-selected", String(+row.dataset.i === this.sel));
    const r = this.list.children[this.sel];
    r?.scrollIntoView?.({ block: "nearest" });
    this.paintFoot();
  },

  paintFoot() {
    const it = this.items[this.sel];
    const label = !it ? "open" : it.type === "command" ? "run command" : it.type === "tab" ? "switch to tab" : this.d.newTabDefault ? "open in new tab" : "open";
    const b = host.querySelector(".samo-foot-enter b");
    if (b) b.textContent = label;
    const sh = host.querySelector(".samo-foot-shift");
    if (sh) sh.hidden = !it || it.type === "command" || it.type === "tab" || !this.d.newTabDefault;
  },

  key(e) {
    if (e.isComposing) return;
    const n = this.items.length;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) || (e.ctrlKey && e.key === "n")) {
      e.preventDefault(); if (n) { this.sel = (this.sel + 1) % n; this.paintSel(); }
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) || (e.ctrlKey && e.key === "p")) {
      e.preventDefault(); if (n) { this.sel = (this.sel - 1 + n) % n; this.paintSel(); }
    } else if (e.key === "Enter") {
      e.preventDefault(); this.commit(this.sel, { shift: e.shiftKey, alt: e.altKey });
    } else if (e.key === "Escape") {
      e.preventDefault(); this.lastEsc = performance.now(); this.escape(true);
    } else if (e.key === "Backspace" && !this.input.value && this.mode()[0] === "default") {
      /* nothing to clear */
    }
  },

  commit(i, { shift = false, alt = false, forceNew = false } = {}) {
    const it = this.items[i];
    const input = this.input.value;
    if (!it) { if (!input.trim()) return; }
    const newTab = forceNew || alt || (this.d.newTabDefault ? !shift : false);
    pick({ type: "palette", item: it || typedRow(input, null), input, newTab });
  },

  escape(local = false) {
    if (!local && performance.now() - this.lastEsc < 150) return; // already handled the key itself
    if (this.input.value) { this.input.value = ""; this.query(); return; }
    pick({ type: "dismiss", input: "" });
  },
};

// ---- Menus -------------------------------------------------------------------------------
const menuView = {
  d: null, act: -1,
  render(d, fresh) {
    this.d = d;
    host.dataset.kind = "menu";
    const items = d.items || [];
    host.innerHTML = `<div class="samo-menu" role="menu"${fresh ? " data-enter" : ""}>${items.map((it) => this.item(it)).join("")}</div>`;
    this.rows = [...host.querySelectorAll("[data-mi]")];
    this.act = -1;
    const m = host.firstElementChild;
    m.addEventListener("pointermove", (e) => {
      const r = e.target.closest("[data-mi]");
      const i = r ? this.rows.indexOf(r) : -1;
      if (i !== this.act) this.setAct(i, false);
    });
    m.addEventListener("pointerleave", () => this.setAct(-1, false));
    m.addEventListener("mousedown", (e) => e.preventDefault());
    m.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (b && !b.hasAttribute("aria-disabled")) pick({ type: "menu", id: b.dataset.pick });
    });
    m.tabIndex = -1;
    requestAnimationFrame(() => m.focus({ preventScroll: true }));
    m.addEventListener("keydown", (e) => this.key(e));
    fit();
  },
  item(it) {
    if (it.type === "separator") return `<div class="samo-menu-sep" role="separator"></div>`;
    if (it.type === "zoom") {
      return `<div class="samo-menu-zoom" role="group" aria-label="Zoom">
        <span class="samo-menu-icon">${icon("zoom-in", 16)}</span><span class="samo-menu-label">${esc(it.label || "Zoom")}</span>
        <span class="samo-zoom-ctrl">
          <button class="samo-zoom-btn" data-mi data-pick="zoom-out" aria-label="Zoom out" title="Zoom out">${icon("minus", 14)}</button>
          <button class="samo-zoom-value" data-mi data-pick="zoom-reset" title="Reset zoom">${esc(it.value || "100%")}</button>
          <button class="samo-zoom-btn" data-mi data-pick="zoom-in" aria-label="Zoom in" title="Zoom in">${icon("plus", 14)}</button>
          <span class="samo-zoom-sep"></span>
          <button class="samo-zoom-btn" data-mi data-pick="fullscreen" aria-label="Full screen" title="Full screen">${icon("maximize-2", 14)}</button>
        </span></div>`;
    }
    const role = typeof it.checked === "boolean" ? "menuitemcheckbox" : "menuitem";
    const dis = it.disabled ? ` aria-disabled="true"` : "";
    const checked = typeof it.checked === "boolean" ? ` aria-checked="${it.checked}"` : "";
    const ic = it.icon ? icon(it.icon, 16) : "";
    const right = it.submenu ? icon("chevron-right", 14)
      : typeof it.checked === "boolean" ? `<span class="samo-menu-check">${it.checked ? icon("check", 14) : ""}</span>${it.shortcut ? `<span class="samo-menu-kbd">${esc(it.shortcut)}</span>` : ""}`
      : it.shortcut ? `<span class="samo-menu-kbd">${esc(it.shortcut)}</span>` : "";
    return `<div class="samo-menu-item${it.type === "back" ? " samo-menu-back" : ""}" role="${role}" data-mi data-pick="${esc(it.id)}"${dis}${checked}>
      <span class="samo-menu-icon">${ic}</span>
      <span class="samo-menu-label">${esc(it.label)}${it.sub ? `<span class="samo-menu-sub">${esc(prettyUrl(it.sub))}</span>` : ""}</span>
      <span class="samo-menu-right">${right}</span></div>`;
  },
  setAct(i, scroll = true) {
    this.rows[this.act]?.removeAttribute("data-active");
    this.act = i;
    const r = this.rows[i];
    if (r) { r.setAttribute("data-active", ""); if (scroll) r.scrollIntoView({ block: "nearest" }); }
  },
  key(e) {
    const n = this.rows.length;
    const step = (d) => {
      for (let k = 1; k <= n; k++) {
        const i = ((this.act < 0 ? (d > 0 ? -1 : 0) : this.act) + d * k + n) % n;
        if (!this.rows[i].hasAttribute("aria-disabled")) { this.setAct(i); return; }
      }
    };
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Home") { e.preventDefault(); this.act = -1; step(1); }
    else if (e.key === "End") { e.preventDefault(); this.act = 0; step(-1); }
    else if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      const r = this.rows[this.act];
      if (e.key === "ArrowRight" && !r?.querySelector(".samo-icon-chevron-right")) return;
      e.preventDefault();
      if (r && !r.hasAttribute("aria-disabled")) pick({ type: "menu", id: r.dataset.pick });
    } else if (e.key === "Escape" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (e.key === "Escape") this.lastEsc = performance.now();
      this.escape(true, e.key === "ArrowLeft");
    }
  },
  escape(local = false, leftOnly = false) {
    if (!local && performance.now() - (this.lastEsc || 0) < 150) return;
    if (this.d?.menu === "bookmarks") { pick({ type: "menu", id: "back" }); return; }
    if (!leftOnly) pick({ type: "dismiss" });
  },
};

// ---- Permission prompt ------------------------------------------------------------------------
const PERM = {
  camera: ["camera", "Use your camera"],
  microphone: ["mic", "Use your microphone"],
  geolocation: ["map-pin", "Know your location"],
  notifications: ["bell", "Show notifications"],
  clipboard: ["copy", "See text and images copied to the clipboard"],
  midi: ["sliders", "Use MIDI devices"],
};
const permissionView = {
  render(d, fresh) {
    host.dataset.kind = "permission";
    const kinds = (d.kinds || []).map((k) => PERM[k] || ["shield", `Use ${String(k).replace(/[-_]/g, " ")}`]);
    let origin = d.origin || "This site";
    try { origin = new URL(d.origin).host || origin; } catch { /* keep */ }
    host.innerHTML = `<div class="samo-perm"${fresh ? " data-enter" : ""} role="alertdialog" aria-labelledby="perm-title">
      <div class="samo-perm-head">
        <span class="samo-perm-badge">${icon("shield", 18)}</span>
        <div><div class="samo-perm-title" id="perm-title">${esc(origin)}</div><div class="samo-perm-sub">wants to</div></div>
      </div>
      <ul class="samo-perm-list">${kinds.map(([ic, label]) => `<li><span>${icon(ic, 16)}</span>${esc(label)}</li>`).join("")}</ul>
      <div class="samo-perm-actions">
        <button class="samo-btn samo-btn--text samo-btn--subtle" data-allow="0">Block</button>
        <button class="samo-btn samo-btn--text samo-btn--primary" data-allow="1">Allow</button>
      </div></div>`;
    host.querySelector(".samo-perm-actions").addEventListener("click", (e) => {
      const b = e.target.closest("[data-allow]");
      if (b) pick({ type: "permission", reqId: d.reqId, allow: b.dataset.allow === "1" });
    });
    host.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); pick({ type: "dismiss" }); } }, { once: true });
    requestAnimationFrame(() => host.querySelector('[data-allow="0"]').focus());
    fit();
  },
  escape() { pick({ type: "dismiss" }); },
};

// Broken favicons fall back to the row's type icon.
host.addEventListener("error", (e) => {
  const img = e.target;
  if (img?.tagName === "IMG" && img.dataset.fb) img.outerHTML = icon(img.dataset.fb, 16);
}, true);

const VIEWS = { suggest: suggestView, palette: paletteView, menu: menuView, permission: permissionView };

samo.on("popup:data", (p) => {
  const kind = p?.kind, d = p?.data || {};
  if (d.__cmd) { if (d.__cmd === "escape") view?.escape?.(); return; }
  const next = VIEWS[kind];
  if (!next) { host.innerHTML = ""; host.dataset.kind = kind || ""; view = null; return; }
  const fresh = view !== next || (d._open != null && d._open !== lastOpen);
  if (d._open != null) lastOpen = d._open;
  if (next === paletteView && !fresh) return; // palette owns its state after opening
  view = next;
  if (next === suggestView) next.bind();
  next.render(d, fresh);
});

// Config (density, motion) without pulling the whole browser state.
samo.call("config.get").then((r) => r?.config && samo.applyConfig(r.config)).catch(() => {});
