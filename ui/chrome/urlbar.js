// URL bar: pretty display, security/zoom/bookmark state, typing suggestions in the popup surface.
import { icon } from "./icons.js";
import { $, root, esc, safeCall, isInternal, isNewTabUrl, shortcut } from "./util.js";

const ENGINES = { duckduckgo: "DuckDuckGo", google: "Google", brave: "Brave", bing: "Bing", yandex: "Yandex" };
const SUGGEST_DEBOUNCE = 40;

export function engineName(cfg) {
  const k = cfg?.general?.search_engine || "duckduckgo";
  return ENGINES[k] || k.charAt(0).toUpperCase() + k.slice(1);
}

export function looksLikeUrl(text) {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]+:\d/i.test(t) ? true
    : /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(t) || /^[^./][^/]*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t);
}

/** The synthetic first row: "what you typed". */
export function typedRow(text, cfg) {
  return looksLikeUrl(text)
    ? { type: "url", title: text.trim(), url: text.trim(), typed: true, badge: "Visit" }
    : { type: "search", title: text, typed: true, badge: `Search ${engineName(cfg)}` };
}

/** A search suggestion that only repeats the typed query (e.g. `Search X for "q"`). */
export function isTypedSearch(it, q) {
  if (it.type !== "search") return false;
  const title = (it.title || "").trim();
  return title === q || title.includes(`“${q}”`) || title.includes(`"${q}"`);
}

export function mergeSuggestions(text, items, cfg, limit) {
  const t = text.trim();
  const out = [typedRow(text, cfg)];
  for (const it of items || []) {
    if (isTypedSearch(it, t)) continue;
    if (it.url && (it.url === t || it.url === out[0].url)) continue;
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/** HTML for the at-rest URL (domain emphasised, the rest dimmed). */
function prettyHtml(url, full) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "samo:") {
      const scheme = full || u.protocol === "samo:" ? `${u.protocol}//` : "";
      let host = u.host;
      let sub = "";
      if (!full && host.startsWith("www.")) { host = host.slice(4); }
      const parts = host.split(".");
      if (!full && parts.length > 2 && !/^\d+$/.test(parts[parts.length - 1])) {
        sub = parts.slice(0, -2).join(".") + ".";
        host = parts.slice(-2).join(".");
      }
      let rest = u.pathname + u.search + u.hash;
      if (!full && rest === "/") rest = "";
      return `<span class="samo-url-dim">${esc(scheme)}</span><span class="samo-url-sub">${esc(sub)}</span><span class="samo-url-host">${esc(host)}</span><span class="samo-url-dim">${esc(rest)}</span>`;
    }
    if (u.protocol === "file:") return `<span class="samo-url-dim">file://</span><span class="samo-url-host">${esc(decodeURIComponent(u.pathname))}</span>`;
  } catch { /* fall through */ }
  return `<span class="samo-url-host">${esc(url)}</span>`;
}

export class UrlBar {
  constructor(app) {
    this.app = app;
    this.samo = app.samo;
    this.bar = $("urlbar");
    this.input = $("url-input");
    this.display = $("url-display");
    this.security = $("url-security");
    this.star = $("url-star");
    this.zoom = $("url-zoom");
    this.progress = $("url-progress");
    this.editing = false;
    this.text = "";
    this.items = [];
    this.sel = 0;
    this.seq = 0;
    this.c = {};
    this.bookmarked = new Map();
    this.bind();
  }

  get tab() { return this.app.activeTab(); }

  // ---- State -> view --------------------------------------------------------------
  sync(force = false) {
    const t = this.tab;
    const cfg = this.app.state.config;
    const url = t?.url || "";
    const nt = isNewTabUrl(url, cfg);
    if (!this.editing && (force || this.c.url !== url)) {
      this.input.value = nt ? "" : url;
      if (document.activeElement === this.input) this.input.select();
    }
    const full = !!cfg?.urlbar?.show_full_url;
    const dkey = `${url}|${full}`;
    if (this.c.dkey !== dkey) {
      this.c.dkey = dkey;
      this.display.innerHTML = nt ? "" : prettyHtml(url, full);
    }
    this.bar.toggleAttribute("data-empty", nt);
    // Security
    const sec = nt ? "search" : t?.secure || (url.startsWith("https:") ? "https" : isInternal(url) ? "internal" : "http");
    const pending = this.app.permissions?.pending.length > 0;
    const skey = `${sec}|${this.focused && this.editing}|${pending}`;
    if (this.c.skey !== skey) {
      this.c.skey = skey;
      const name = this.focused && this.editing ? "search"
        : { https: "lock", http: "lock-open", internal: "sparkles", file: "globe", search: "search" }[sec] || "globe";
      this.security.innerHTML = icon(name, 16);
      this.security.dataset.secure = this.focused && this.editing ? "search" : sec;
      this.security.toggleAttribute("data-pending", pending);
      this.security.title = { https: "Connection is secure", http: "Connection is not secure", internal: "Samo page", file: "Local file" }[sec] || "";
    }
    // Zoom badge
    const z = t?.zoom || 0;
    if (this.c.zoom !== z) {
      this.c.zoom = z;
      const show = Math.abs(z) > 0.001;
      this.zoom.hidden = !show;
      if (show) {
        const pct = Math.round(Math.pow(1.2, z) * 100);
        this.zoom.textContent = `${pct}%`;
        this.zoom.title = `Zoom ${pct}% — click to reset (${shortcut("zoom-reset")})`;
      }
    }
    // Bookmark star
    this.star.hidden = nt || !url || isInternal(url);
    if (this.c.url !== url) {
      this.c.url = url;
      this.setStar(this.bookmarked.get(url) || false, false);
      if (url && !this.star.hidden) {
        safeCall(this.samo, "bookmarks.isBookmarked", { url }).then((r) => {
          if (!r) return;
          this.bookmarked.set(url, !!r.bookmarked);
          if (this.tab?.url === url) this.setStar(!!r.bookmarked, false);
        });
      }
    }
    // Load progress
    const loading = !!t?.loading;
    const prog = loading ? Math.max(0.08, Math.min(1, t.progress ?? 0.1)) : 1;
    if (this.c.loading !== loading || this.c.prog !== prog) {
      const was = this.c.loading;
      this.c.loading = loading; this.c.prog = prog;
      const bar = this.progress.firstElementChild;
      if (loading) {
        if (!was) { bar.style.transition = "none"; bar.style.scale = "0 1"; getComputedStyle(bar).scale; bar.style.transition = ""; }
        this.progress.setAttribute("active", "");
        bar.style.scale = `${prog} 1`;
      } else if (was) {
        bar.style.scale = "1 1";
        this.progress.removeAttribute("active");
      }
    }
  }

  setStar(on, animate) {
    this.star.toggleAttribute("data-on", on);
    this.star.setAttribute("aria-pressed", String(on));
    this.star.title = `${on ? "Edit bookmark" : "Bookmark this tab"} (${shortcut("bookmark")})`;
    if (animate) {
      this.star.classList.remove("samo-pop");
      void this.star.offsetWidth;
      this.star.classList.add("samo-pop");
    }
  }

  async toggleBookmark() {
    const t = this.tab;
    if (!t?.url) return;
    const r = await safeCall(this.samo, "bookmarks.toggle", { url: t.url, title: t.title || t.url });
    if (!r) return;
    this.bookmarked.set(t.url, !!r.bookmarked);
    this.setStar(!!r.bookmarked, true);
    this.app.toast(r.bookmarked ? "Added to bookmarks" : "Removed from bookmarks");
  }

  get focused() { return document.activeElement === this.input; }

  // ---- Focus / editing ------------------------------------------------------------
  focus({ select = true, suggest = true } = {}) {
    this.app.compact?.reveal();
    this.input.focus();
    if (select) this.input.select();
    if (suggest && this.input.value.trim()) this.request(this.input.value, true);
  }

  revert() {
    this.editing = false;
    this.bar.removeAttribute("data-editing");
    this.text = "";
    this.sync(true);
  }

  finish() {
    this.closeSuggestions();
    this.revert();
    this.input.blur();
  }

  // ---- Suggestions --------------------------------------------------------------------
  request = (text, fromFocus = false) => {
    const seq = ++this.seq;
    const q = text;
    if (!q.trim()) { this.closeSuggestions(); return; }
    const cfg = this.app.state.config;
    const limit = cfg?.urlbar?.max_suggestions || 8;
    this.samo.call("suggest", { query: q.trim(), limit }).catch(() => ({ items: [] })).then((r) => {
      if (seq !== this.seq || !this.focused) return;
      if (!fromFocus && !this.editing) return;
      this.items = mergeSuggestions(q, r?.items, cfg, limit);
      this.sel = 0;
      this.showSuggestions();
    });
  };

  debounced = (() => {
    let t = 0;
    return (text) => { clearTimeout(t); t = setTimeout(() => this.request(text), SUGGEST_DEBOUNCE); };
  })();

  rowH() { return root.dataset.density === "compact" ? 32 : 36; }

  rect() {
    const r = this.bar.getBoundingClientRect();
    const n = this.items.length;
    return { x: r.left - 1, y: r.bottom, w: r.width + 2, h: n * this.rowH() + 11 };
  }

  payload() {
    return { items: this.items, selected: this.sel, rowH: this.rowH(), query: this.text || this.input.value };
  }

  showSuggestions() {
    const popup = this.app.popup;
    if (!this.items.length) { this.closeSuggestions(); return; }
    this.bar.setAttribute("data-open", "");
    // While open, the popup document fits its own height (popup.resize) after each update.
    if (popup.is("suggest")) popup.update(this.payload());
    else popup.show("suggest", this.rect(), this.payload(), this.popupOpts());
  }

  popupOpts() {
    return {
      owner: "suggest",
      onPick: (p) => {
        if (p?.type === "dismiss") { this.closeSuggestions(); return; }
        const item = this.items[p?.index];
        if (item) this.commit(item, { newTab: !!(p.newTab || p.alt || p.middle), ctrl: !!p.ctrl });
      },
      onHide: () => { this.bar.removeAttribute("data-open"); },
    };
  }

  closeSuggestions() {
    this.seq++;
    this.bar.removeAttribute("data-open");
    this.app.popup.hide("suggest");
  }

  move(delta) {
    if (!this.app.popup.is("suggest") || !this.items.length) {
      if (this.input.value.trim()) this.request(this.input.value, true);
      return;
    }
    const n = this.items.length;
    this.sel = (this.sel + delta + n) % n;
    const it = this.items[this.sel];
    const base = this.text || this.input.value;
    this.input.value = it.typed ? base : it.type === "search" ? it.title : it.url || it.title;
    this.app.popup.update(this.payload());
  }

  commit(item, { newTab = false, ctrl = false } = {}) {
    const raw = this.input.value;
    if (!item) item = typedRow(raw, this.app.state.config);
    if (item.type === "tab" && item.tabId != null && !newTab) {
      this.app.activate(item.tabId, { pointer: true });
    } else if (item.type === "command" && item.action) {
      this.finish();
      this.app.runAction(item.action);
      return;
    } else {
      let input = item.typed ? (this.text || raw) : item.url || item.title;
      if (ctrl && item.typed && /^[\w-]+$/.test(input.trim())) input = `www.${input.trim()}.com`;
      if (!input.trim()) return;
      safeCall(this.samo, "nav.go", { input: input.trim(), newTab });
    }
    this.finish();
  }

  // ---- Events ---------------------------------------------------------------------
  bind() {
    const inp = this.input;
    let selectOnUp = false;
    inp.addEventListener("pointerdown", () => { selectOnUp = !this.focused; });
    inp.addEventListener("mouseup", (e) => {
      if (selectOnUp && inp.selectionStart === inp.selectionEnd) { e.preventDefault(); inp.select(); }
      selectOnUp = false;
    });
    inp.addEventListener("focus", () => {
      clearTimeout(this.blurT);
      this.bar.setAttribute("data-focused", "");
      this.app.compact?.hold("urlbar", true);
      if (!this.editing) this.sync(true);
      this.c.skey = null; this.sync();
    });
    inp.addEventListener("blur", () => {
      this.bar.removeAttribute("data-focused");
      this.app.compact?.hold("urlbar", false);
      // Delay so a click inside the popup surface can still deliver popup:pick.
      clearTimeout(this.blurT);
      this.blurT = setTimeout(() => {
        if (this.focused) return;
        this.closeSuggestions();
        if (!this.input.value.trim()) this.revert();
        this.c.skey = null; this.sync();
      }, 220);
    });
    inp.addEventListener("input", () => {
      this.editing = true;
      this.bar.setAttribute("data-editing", "");
      this.text = inp.value;
      this.c.skey = null; this.sync();
      this.debounced(inp.value);
    });
    inp.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); this.move(1); break;
        case "ArrowUp": e.preventDefault(); this.move(-1); break;
        case "Tab":
          if (this.app.popup.is("suggest")) { e.preventDefault(); this.move(e.shiftKey ? -1 : 1); }
          break;
        case "Enter": {
          e.preventDefault();
          const open = this.app.popup.is("suggest");
          const item = open ? this.items[this.sel] : null;
          this.commit(item, { newTab: e.altKey, ctrl: e.ctrlKey });
          break;
        }
        case "Escape":
          e.preventDefault();
          this.escape();
          break;
      }
    });
    this.star.addEventListener("click", () => this.toggleBookmark());
    this.zoom.addEventListener("click", () => safeCall(this.samo, "zoom.change", { reset: true }));
    this.security.addEventListener("click", () => this.app.permissions?.reopen());
    this.bar.addEventListener("pointerdown", (e) => {
      if (e.target === this.bar || e.target.closest(".samo-urlbar-display, .samo-urlbar-field")) {
        if (e.target !== inp) { e.preventDefault(); this.focus({ suggest: false }); }
      }
    });
  }

  /** Returns true if it consumed the escape. */
  escape() {
    if (this.app.popup.is("suggest") || this.editing) {
      this.closeSuggestions();
      this.revert();
      if (this.focused) this.input.select();
      return true;
    }
    if (this.focused) { this.input.blur(); return true; }
    return false;
  }
}
