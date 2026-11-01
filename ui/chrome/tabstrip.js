// Tab strip: own layout engine (absolute tabs, JS-computed x/width, CSS transitions on
// `translate`/`width` which retarget from the current value on interruption), Chrome-style
// close-width freeze, drag-to-reorder, overflow scrolling, pinned tabs, window controls.
import { icon } from "./icons.js";
import { $, root, clamp, dur, fade, EASE, cssPx, safeCall, isNewTabUrl, isInternal, motion, shortcut } from "./util.js";

// [duration ms, easing] per kind of relayout (ANALYSIS §3.3).
const MOTION = {
  none: [0, "linear"],
  base: [200, EASE.standard],
  open: [180, EASE.standard],
  close: [160, EASE.standard],
  reorder: [200, EASE.snap],
  pin: [220, EASE.emphasized],
  drop: [180, EASE.spring],
  indicator: [220, EASE.standard],
};
const CLOSE_HIDE_BELOW = 72;
const TITLE_HIDE_BELOW = 60;
const DRAG_THRESHOLD = 5;
const UNFREEZE_DELAY = 300;
const FADE_EDGE = 24;
const DRAG_MIN_SPACE = 24;
const PADX = 2; // scroller inline padding so the active tab's ring/shadow is not clipped

const TPL = document.createElement("template");
TPL.innerHTML = `<div class="samo-tab" role="tab" tabindex="-1" aria-selected="false" data-icon-state="fallback"><div class="samo-tab-bg"></div><div class="samo-tab-content"><span class="samo-tab-icon"><img class="samo-tab-favicon" alt="" draggable="false" decoding="async"><span class="samo-tab-fallback"></span><svg class="samo-tab-spinner" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/></svg></span><span class="samo-tab-title"></span><button class="samo-btn samo-tab-audio" tabindex="-1" hidden></button><button class="samo-btn samo-tab-close" tabindex="-1" aria-label="Close tab"></button></div></div>`;

function computeWidths(n, avail, m, ai) {
  if (!n) return [];
  const space = avail - m.gap * (n - 1);
  const w = clamp(space / n, m.min, m.max);
  const out = new Array(n).fill(w);
  const amin = Math.min(m.activeMin, m.max);
  if (ai >= 0 && w < amin) {
    out[ai] = amin;
    if (n > 1) {
      const o = clamp((space - amin) / (n - 1), m.min, m.max);
      for (let i = 0; i < n; i++) if (i !== ai) out[i] = o;
    }
  }
  return out;
}

export class TabStrip {
  constructor(app) {
    this.app = app;
    this.samo = app.samo;
    this.strip = $("tabstrip");
    this.pinnedEl = $("tabs-pinned");
    this.scroller = $("tabs-scroll");
    this.track = $("tabs-track");
    this.indicator = $("tab-indicator");
    this.newBtn = $("newtab-btn");
    this.recs = new Map();        // id -> record
    this.freeze = null;           // {avail, anchorRight}
    this.unfreezeT = 0;
    this.pointerIn = false;
    this.press = null;            // pending press / drag
    this.stripW = 0;
    this.fixedW = 0;
    this.last = { pinnedW: -1, scrollW: -1, trackW: -1, contentW: 0, realAvail: 0 };
    this.trackT = 0;
    this.sPos = 0; this.sTarget = 0; this.sRaf = 0;
    this.readMetrics();
    this.bind();
  }

  readMetrics() {
    this.m = {
      max: cssPx("--samo-tab-max-width", 240),
      min: cssPx("--samo-tab-min-width", 44),
      pinned: cssPx("--samo-tab-pinned-width", 40),
      gap: cssPx("--samo-tab-gap", 4),
      activeMin: cssPx("--samo-tab-min-width-active", 88),
    };
  }

  measureFixed() {
    const cs = getComputedStyle(this.strip);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const nb = this.newBtn.offsetWidth + parseFloat(getComputedStyle(this.newBtn).marginLeft || 0);
    const wcL = $("wc-left").hidden ? 0 : $("wc-left").offsetWidth;
    const wcR = $("wc-right").hidden ? 0 : $("wc-right").offsetWidth;
    this.fixedW = pad + nb + wcL + wcR + DRAG_MIN_SPACE;
    this.stripW = this.strip.clientWidth;
  }

  availWidth(pinnedW) { return Math.max(0, this.stripW - this.fixedW - pinnedW - 2 * PADX); }

  // ---- Records -----------------------------------------------------------------
  createRec(id) {
    const el = TPL.content.firstElementChild.cloneNode(true);
    el.dataset.id = id;
    const rec = {
      id, el,
      img: el.querySelector(".samo-tab-favicon"),
      fallback: el.querySelector(".samo-tab-fallback"),
      title: el.querySelector(".samo-tab-title"),
      audio: el.querySelector(".samo-tab-audio"),
      close: el.querySelector(".samo-tab-close"),
      x: NaN, w: NaN, t: "", size: "", c: {}, favErr: false, isNew: true, pinnedIn: null,
    };
    rec.close.innerHTML = icon("x", 14);
    rec.close.title = `Close tab (${shortcut("close-tab")})`;
    rec.img.addEventListener("load", () => rec.img.setAttribute("data-ok", ""));
    rec.img.addEventListener("error", () => { rec.favErr = true; rec.img.removeAttribute("data-ok"); this.updateIconState(rec); });
    this.recs.set(id, rec);
    return rec;
  }

  /** Apply tab data to its element (diffed against a small cache). */
  update(rec, t) {
    const c = rec.c, el = rec.el;
    const cfg = this.app.state.config;
    const nt = isNewTabUrl(t.url, cfg);
    const title = t.title || (nt ? "New Tab" : t.url) || "Untitled";
    if (c.title !== title) {
      c.title = title;
      rec.title.textContent = title;
      el.setAttribute("aria-label", title);
      el.title = title;
    }
    const active = t.id === this.app.state.activeId;
    if (c.active !== active) {
      c.active = active;
      el.toggleAttribute("active", active);
      el.setAttribute("aria-selected", String(active));
      el.tabIndex = active ? 0 : -1;
    }
    for (const k of ["pinned", "loading", "audible", "muted", "crashed"]) {
      const v = !!t[k];
      if (c[k] !== v) { c[k] = v; el.toggleAttribute(k, v); }
    }
    if (c.fav !== t.favicon) {
      c.fav = t.favicon;
      rec.favErr = false;
      rec.img.removeAttribute("data-ok");
      if (t.favicon) rec.img.src = t.favicon; else rec.img.removeAttribute("src");
    }
    const fb = t.crashed ? "alert-triangle" : nt || isInternal(t.url) ? "sparkles" : "globe";
    if (c.fb !== fb) { c.fb = fb; rec.fallback.innerHTML = icon(fb, 16); }
    const aud = t.muted ? "muted" : t.audible ? "audible" : "";
    if (c.aud !== aud) {
      c.aud = aud;
      rec.audio.hidden = !aud;
      if (aud) {
        rec.audio.innerHTML = icon(t.muted ? "volume-x" : "volume-2", 14);
        rec.audio.setAttribute("aria-label", t.muted ? "Unmute tab" : "Mute tab");
        rec.audio.title = `${t.muted ? "Unmute" : "Mute"} tab (${shortcut("mute-tab")})`;
      }
    }
    rec.tab = t;
    this.updateIconState(rec);
  }

  updateIconState(rec) {
    const t = rec.tab;
    if (!t) return;
    const hide = !!this.app.state.config?.tabs?.hide_throbber;
    const s = t.crashed ? "crashed"
      : t.loading && !hide ? ((t.progress ?? 1) < 0.1 ? "waiting" : "loading")
      : t.favicon && !rec.favErr ? "favicon" : "fallback";
    if (rec.c.icon !== s) { rec.c.icon = s; rec.el.dataset.iconState = s; }
  }

  // ---- Layout ------------------------------------------------------------------
  /** Recompute every tab's x/width and transition to it. `kind` picks duration/easing. */
  layout(kind = "base") {
    const st = this.app.state, m = this.m;
    const pinned = [], normal = [];
    for (const id of st.order) {
      const t = st.tabs.get(id);
      if (t) (t.pinned ? pinned : normal).push(id);
    }
    const p = this.press;
    if (p?.moved) {
      const list = p.pinned ? pinned : normal;
      const i = list.indexOf(p.id);
      if (i >= 0) { list.splice(i, 1); list.splice(clamp(p.index, 0, list.length), 0, p.id); }
    }
    const targets = [];
    const pinnedW = pinned.length ? pinned.length * (m.pinned + m.gap) : 0;
    pinned.forEach((id, i) => targets.push([id, i * (m.pinned + m.gap), m.pinned, this.pinnedEl]));

    const realAvail = this.availWidth(pinnedW);
    const fz = this.freeze;
    const avail = fz ? fz.avail : realAvail;
    const widths = computeWidths(normal.length, avail, m, normal.indexOf(st.activeId));
    let sum = 0;
    for (const w of widths) sum += w;
    const rawContent = sum + m.gap * Math.max(0, normal.length - 1);
    const offset = fz?.anchorRight ? Math.max(0, avail - rawContent) : 0;
    let acc = offset;
    normal.forEach((id, i) => {
      const x0 = Math.round(acc);
      acc += widths[i];
      targets.push([id, x0, Math.round(acc) - x0, this.track]);
      acc += m.gap;
    });
    const contentW = normal.length ? Math.round(acc - m.gap) : 0;

    // 1) bring new / re-parented records into their starting state.
    const [d0] = MOTION[kind] || MOTION.base;
    const animate = dur(d0) > 0;
    let flush = false;
    for (const [id, x, w, parent] of targets) {
      let rec = this.recs.get(id);
      if (!rec) rec = this.createRec(id);
      const t = st.tabs.get(id);
      if (t !== rec.tab || rec.isNew) this.update(rec, t);
      if (rec.isNew) {
        rec.isNew = false;
        parent.appendChild(rec.el);
        if (animate) {
          rec.el.style.transition = "none";
          rec.el.style.translate = `${x}px 0`;
          rec.el.style.width = "0px";
          rec.el.classList.add("samo-tab-opening");
          rec.x = x; rec.w = 0; rec.t = "none";
          rec.opening = true;
          flush = true;
        }
      } else if (rec.el.parentNode !== parent) {
        // Pin/unpin: FLIP across containers from the current on-screen position.
        const from = rec.el.getBoundingClientRect();
        parent.appendChild(rec.el);
        const base = parent.getBoundingClientRect();
        rec.el.style.transition = "none";
        rec.el.style.translate = `${from.left - base.left}px 0`;
        rec.el.style.width = `${from.width}px`;
        rec.x = from.left - base.left; rec.w = from.width; rec.t = "none";
        rec.reparented = true;
        flush = true;
      }
    }
    if (flush) getComputedStyle(this.track).width; // one style flush commits the start states

    // 2) transition everything to the targets.
    for (const [id, x, w] of targets) {
      const rec = this.recs.get(id);
      if (rec.opening) {
        rec.opening = false;
        rec.el.classList.remove("samo-tab-opening");
      }
      if (p?.moved && p.id === id) { rec.w = w; continue; } // dragged tab follows the pointer
      const k = rec.reparented ? "pin" : kind;
      rec.reparented = false;
      this.place(rec, x, w, k);
    }

    // 3) containers.
    const [d, e] = MOTION[kind] || MOTION.base;
    const dd = dur(d);
    this.setBox(this.pinnedEl, "pinnedW", pinnedW, dd, e);
    const scrollW = Math.max(contentW, fz ? Math.round(fz.avail) : 0);
    this.setBox(this.scroller, "scrollW", scrollW + 2 * PADX, dd, e);
    clearTimeout(this.trackT);
    if (scrollW >= this.last.trackW || !dd) this.setTrack(scrollW);
    else this.trackT = setTimeout(() => this.setTrack(scrollW), dd + 20);

    this.last.contentW = contentW;
    this.last.realAvail = realAvail;
    this.last.normal = normal;
    this.last.pinned = pinned;
    const overflow = contentW > realAvail + 0.5;
    if (overflow !== this.overflow) {
      this.overflow = overflow;
      this.strip.toggleAttribute("overflow", overflow);
    }
    if (!overflow && !fz && this.scroller.scrollLeft) {
      clearTimeout(this.trackT);
      this.setTrack(scrollW);
      this.scrollTo(0, true);
    }
    this.updateIndicator(kind);
    requestAnimationFrame(() => this.updateFades());
  }

  setBox(el, key, w, d, e) {
    if (this.last[key] === w) return;
    const first = this.last[key] < 0;
    this.last[key] = w;
    el.style.transition = d && !first ? `width ${d}ms ${e}` : "none";
    el.style.width = `${w}px`;
  }

  setTrack(w) {
    if (this.last.trackW === w) return;
    this.last.trackW = w;
    this.track.style.width = `${w}px`;
  }

  place(rec, x, w, kind) {
    if (rec.x === x && rec.w === w) return;
    const [d0, e] = MOTION[kind] || MOTION.base;
    const d = Number.isNaN(rec.x) ? 0 : dur(d0);
    const t = d ? `translate ${d}ms ${e}, width ${d}ms ${e}` : "none";
    if (rec.t !== t) { rec.el.style.transition = t; rec.t = t; }
    if (rec.x !== x) rec.el.style.translate = `${x}px 0`;
    if (rec.w !== w) rec.el.style.width = `${w}px`;
    rec.x = x; rec.w = w;
    const size = w < TITLE_HIDE_BELOW ? "tiny" : w < CLOSE_HIDE_BELOW ? "narrow" : "";
    if (rec.size !== size) { rec.size = size; rec.el.dataset.size = size; }
  }

  updateIndicator(kind = "indicator") {
    const rec = this.recs.get(this.app.state.activeId);
    const show = root.dataset.indicator === "underline" && rec && rec.el.parentNode === this.track && !rec.closing;
    this.indicator.toggleAttribute("visible", !!show);
    if (!show) return;
    const p = this.press;
    const dragging = p?.moved && p.id === rec.id;
    const [d0, e] = kind === "base" || kind === "none" ? MOTION.indicator : (MOTION[kind] || MOTION.indicator);
    const d = dragging || kind === "none" ? 0 : dur(d0);
    const x = rec.x + 8, s = Math.max(0, rec.w - 16) / 100;
    const key = `${x}|${s}`;
    if (this.indKey === key) return;
    this.indKey = key;
    this.indicator.style.transition = d ? `translate ${d}ms ${e}, scale ${d}ms ${e}` : "none";
    this.indicator.style.translate = `${x}px 0`;
    this.indicator.style.scale = `${s} 1`;
  }

  // ---- Model hooks (called by the app) -----------------------------------------
  /** Full rebuild without animation (init / tabs:sync). */
  rebuild() {
    const st = this.app.state;
    for (const [id, rec] of this.recs) {
      if (!st.tabs.has(id)) { rec.el.remove(); this.recs.delete(id); }
    }
    this.measureFixed();
    this.layout("none");
    this.ensureVisible(st.activeId, true);
  }

  tabUpdated(id, changed) {
    const rec = this.recs.get(id), t = this.app.state.tabs.get(id);
    if (!rec || !t) return;
    this.update(rec, t);
    if ("pinned" in changed) this.layout("pin");
  }

  tabCreated(id, prev = null) {
    const pr = this.recs.get(prev), pt = this.app.state.tabs.get(prev);
    if (pr && pt) this.update(pr, pt);
    this.unfreeze(false);
    this.layout("open");
    this.ensureVisible(id);
  }

  tabMoved() { this.layout("base"); }

  activated(id, prev) {
    for (const pid of [prev, id]) {
      const rec = this.recs.get(pid), t = this.app.state.tabs.get(pid);
      if (rec && t) this.update(rec, t);
    }
    this.layout("base");
    this.updateIndicator("indicator");
    this.ensureVisible(id);
  }

  /** Called before the model drops a tab that is being closed with the mouse. */
  prepareMouseClose(id) {
    const t = this.app.state.tabs.get(id), rec = this.recs.get(id);
    if (!t || !rec || t.pinned || !this.pointerIn) return;
    const normal = this.last.normal || [];
    const isLast = normal[normal.length - 1] === id;
    if (!this.freeze) this.freeze = { avail: Math.max(this.last.contentW, 0), anchorRight: false };
    if (isLast) this.freeze.anchorRight = true;
    else this.freeze.avail = Math.max(0, this.freeze.avail - rec.w - this.m.gap);
    clearTimeout(this.unfreezeT);
  }

  /** Animate the element of a tab that left the model. */
  removed(id) {
    const rec = this.recs.get(id);
    if (!rec) return;
    this.recs.delete(id);
    if (this.press?.id === id) this.press = null;
    rec.closing = true;
    const el = rec.el;
    el.setAttribute("closing", "");
    el.removeAttribute("role");
    el.inert = true;
    const d = dur(MOTION.close[0]);
    if (d) {
      el.style.transition = `width ${d}ms ${EASE.standard}`;
      el.style.width = "0px";
    }
    setTimeout(() => el.remove(), Math.max(d, fade(90)) + 40);
    this.layout("close");
  }

  unfreeze(relayout = true) {
    clearTimeout(this.unfreezeT);
    if (!this.freeze) return;
    this.freeze = null;
    if (relayout) this.layout("base");
  }

  // ---- Overflow scrolling --------------------------------------------------------
  scrollTo(target, immediate = false) {
    const sc = this.scroller;
    const max = Math.max(0, this.last.trackW - sc.clientWidth);
    this.sTarget = clamp(target, 0, max);
    if (immediate || motion.reduced) {
      cancelAnimationFrame(this.sRaf); this.sRaf = 0;
      sc.scrollLeft = this.sPos = this.sTarget;
      return;
    }
    if (!this.sRaf) {
      this.sPos = sc.scrollLeft;
      this.sLast = performance.now();
      this.sRaf = requestAnimationFrame(this.sStep);
    }
  }

  sStep = (now) => {
    const dt = Math.min(64, now - this.sLast);
    this.sLast = now;
    const k = 1 - Math.exp(-dt / (45 * Math.max(0.2, motion.speed)));
    this.sPos += (this.sTarget - this.sPos) * k;
    if (Math.abs(this.sTarget - this.sPos) < 0.5) {
      this.sPos = this.sTarget;
      this.sRaf = 0;
    } else {
      this.sRaf = requestAnimationFrame(this.sStep);
    }
    this.scroller.scrollLeft = this.sPos;
  };

  ensureVisible(id, immediate = false) {
    const rec = this.recs.get(id);
    if (!rec || rec.el.parentNode !== this.track) return;
    requestAnimationFrame(() => {
      if (!this.overflow) return;
      const sc = this.scroller, cw = sc.clientWidth;
      const cur = this.sRaf ? this.sTarget : sc.scrollLeft;
      if (rec.x < cur + FADE_EDGE) this.scrollTo(rec.x - FADE_EDGE, immediate);
      else if (rec.x + rec.w > cur + cw - FADE_EDGE) this.scrollTo(rec.x + rec.w - cw + FADE_EDGE, immediate);
    });
  }

  updateFades() {
    const sc = this.scroller;
    const max = sc.scrollWidth - sc.clientWidth;
    const l = this.overflow && sc.scrollLeft > 1;
    const r = this.overflow && sc.scrollLeft < max - 1;
    if (l !== this.fadeL) { this.fadeL = l; sc.toggleAttribute("data-fade-l", l); }
    if (r !== this.fadeR) { this.fadeR = r; sc.toggleAttribute("data-fade-r", r); }
  }

  // ---- Drag to reorder -------------------------------------------------------------
  beginDrag(p) {
    p.moved = true;
    const rec = this.recs.get(p.id);
    if (!rec) { this.press = null; return; }
    p.rec = rec;
    p.pinned = rec.el.parentNode === this.pinnedEl;
    const list = (p.pinned ? this.last.pinned : this.last.normal) || [];
    p.index = Math.max(0, list.indexOf(p.id));
    p.startIndex = p.index;
    rec.el.style.transition = "none";
    rec.t = "none";
    rec.el.setAttribute("dragging", "");
    root.dataset.dragging = "true";
    this.app.compact?.hold("drag", true);
  }

  dragFrame = () => {
    this.dragRaf = 0;
    const p = this.press;
    if (!p?.moved) return;
    const rec = p.rec, m = this.m;
    // Edge auto-scroll while dragging in an overflowing strip.
    if (!p.pinned && this.overflow) {
      const r = this.scroller.getBoundingClientRect();
      const edge = 36;
      let v = 0;
      if (p.cx < r.left + edge) v = -(r.left + edge - p.cx);
      else if (p.cx > r.right - edge) v = p.cx - (r.right - edge);
      if (v) {
        cancelAnimationFrame(this.sRaf); this.sRaf = 0;
        this.scroller.scrollLeft += clamp(v, -edge, edge) * 0.35;
        this.dragRaf = requestAnimationFrame(this.dragFrame);
      }
    }
    const scrollDelta = p.pinned ? 0 : this.scroller.scrollLeft - p.scroll0;
    const list = (p.pinned ? this.last.pinned : this.last.normal) || [];
    const groupW = p.pinned ? this.last.pinnedW - m.gap : Math.max(this.last.contentW, rec.w);
    const x = clamp(p.startX + (p.cx - p.x0) + scrollDelta, 0, Math.max(0, groupW - rec.w));
    rec.el.style.translate = `${x}px 0`;
    rec.x = x;
    // Slot = number of other tabs whose (target) centre is left of the dragged centre.
    const center = x + rec.w / 2;
    let index = 0;
    for (const id of list) {
      if (id === p.id) continue;
      const o = this.recs.get(id);
      if (o && o.x + o.w / 2 < center) index++;
    }
    if (index !== p.index) {
      p.index = index;
      this.layout("reorder");
    }
    this.updateIndicator("none");
  };

  endDrag(cancelled = false) {
    const p = this.press;
    this.press = null;
    if (!p?.moved) return;
    cancelAnimationFrame(this.dragRaf);
    const rec = p.rec;
    rec.el.removeAttribute("dragging");
    delete root.dataset.dragging;
    this.app.compact?.hold("drag", false);
    const st = this.app.state;
    const index = cancelled ? p.startIndex : p.index;
    if (index !== p.startIndex) {
      const pinned = st.order.filter((id) => st.tabs.get(id)?.pinned && id !== p.id);
      const normal = st.order.filter((id) => !st.tabs.get(id)?.pinned && id !== p.id);
      (p.pinned ? pinned : normal).splice(index, 0, p.id);
      st.order = [...pinned, ...normal];
      safeCall(this.samo, "tab.move", { id: p.id, index: st.order.indexOf(p.id) });
    }
    rec.x = -1; // force placement: settle into the slot with the drop spring
    this.layout("drop");
  }

  // ---- Events -----------------------------------------------------------------
  bind() {
    const s = this.strip;
    new ResizeObserver(() => {
      const w = this.strip.clientWidth;
      if (w === this.stripW) return;
      this.stripW = w;
      this.unfreeze(false);
      this.layout("none");
    }).observe(s);

    s.addEventListener("pointerenter", () => { this.pointerIn = true; clearTimeout(this.unfreezeT); });
    s.addEventListener("pointerleave", () => {
      this.pointerIn = false;
      if (this.freeze) this.unfreezeT = setTimeout(() => this.unfreeze(), UNFREEZE_DELAY);
    });

    s.addEventListener("pointerdown", (e) => {
      const tabEl = e.target.closest(".samo-tab");
      if (!tabEl || tabEl.hasAttribute("closing")) return;
      if (e.button === 1) { e.preventDefault(); return; }
      if (e.button !== 0) return;
      if (e.target.closest(".samo-tab-close, .samo-tab-audio")) return;
      const id = +tabEl.dataset.id;
      const rec = this.recs.get(id);
      if (!rec) return;
      this.app.activate(id, { pointer: true });
      this.press = {
        id, pointerId: e.pointerId, x0: e.clientX, cx: e.clientX,
        startX: rec.x, scroll0: this.scroller.scrollLeft, moved: false,
      };
      try { tabEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    s.addEventListener("pointermove", (e) => {
      const p = this.press;
      if (!p || e.pointerId !== p.pointerId) return;
      p.cx = e.clientX;
      if (!p.moved) {
        if (Math.abs(p.cx - p.x0) < DRAG_THRESHOLD) return;
        this.beginDrag(p);
      }
      if (!this.dragRaf) this.dragRaf = requestAnimationFrame(this.dragFrame);
    });
    const up = (e) => {
      if (this.press && e.pointerId === this.press.pointerId) this.endDrag(e.type === "pointercancel");
    };
    s.addEventListener("pointerup", up);
    s.addEventListener("pointercancel", up);
    s.addEventListener("lostpointercapture", up);
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.press?.moved) this.endDrag(true);
    });

    // Middle click closes; close / audio buttons.
    s.addEventListener("auxclick", (e) => {
      const tabEl = e.target.closest(".samo-tab");
      if (e.button === 1 && tabEl && !tabEl.hasAttribute("closing")) {
        e.preventDefault();
        this.app.closeTab(+tabEl.dataset.id, { mouse: true });
      } else if (e.button === 1 && !tabEl && e.target.closest(".samo-newtab-btn, .samo-drag-space, .samo-tabs-track")) {
        safeCall(this.samo, "tab.new", {});
      }
    });
    s.addEventListener("click", (e) => {
      const tabEl = e.target.closest(".samo-tab");
      if (!tabEl) return;
      const id = +tabEl.dataset.id;
      if (e.target.closest(".samo-tab-close")) {
        e.stopPropagation();
        this.app.closeTab(id, { mouse: true });
      } else if (e.target.closest(".samo-tab-audio")) {
        e.stopPropagation();
        const t = this.app.state.tabs.get(id);
        if (t) this.app.setMuted(id, !t.muted);
      }
    });
    // Keep close/audio presses from starting drags or activating.
    s.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".samo-tab-close, .samo-tab-audio")) e.stopPropagation();
    }, true);

    s.addEventListener("dblclick", (e) => {
      if (e.target.closest(".samo-tab, .samo-btn, .samo-wc")) return;
      safeCall(this.samo, "window.toggleMaximize");
    });

    s.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const tabEl = e.target.closest(".samo-tab");
      if (tabEl && !tabEl.hasAttribute("closing")) this.app.menus.tabMenu(+tabEl.dataset.id, e.clientX, e.clientY);
      else if (!e.target.closest(".samo-wc")) this.app.menus.stripMenu(e.clientX, e.clientY);
    });

    this.newBtn.addEventListener("click", () => safeCall(this.samo, "tab.new", {}));

    // Wheel: vertical -> horizontal, smoothed. Native horizontal (touchpad) passes through.
    this.scroller.addEventListener("wheel", (e) => {
      if (!this.overflow) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.scroller.clientWidth : 1;
      const base = this.sRaf ? this.sTarget : this.scroller.scrollLeft;
      if (e.deltaMode === 0 && Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY)) {
        this.scrollTo(base + e.deltaY, true); // precise touchpad: follow directly
      } else {
        this.scrollTo(base + e.deltaY * unit);
      }
    }, { passive: false });
    this.scroller.addEventListener("scroll", () => {
      if (!this.fadeRaf) this.fadeRaf = requestAnimationFrame(() => { this.fadeRaf = 0; this.updateFades(); });
    }, { passive: true });

    // Keyboard navigation inside the tablist (roving tabindex).
    s.addEventListener("keydown", (e) => {
      const tabEl = e.target.closest?.(".samo-tab");
      if (!tabEl) return;
      const id = +tabEl.dataset.id;
      const order = [...(this.last.pinned || []), ...(this.last.normal || [])];
      const i = order.indexOf(id);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = order[clamp(i + (e.key === "ArrowRight" ? 1 : -1), 0, order.length - 1)];
        this.recs.get(next)?.el.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.app.activate(id, { pointer: true });
      } else if (e.key === "Delete") {
        e.preventDefault();
        this.app.closeTab(id);
      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const r = tabEl.getBoundingClientRect();
        this.app.menus.tabMenu(id, r.left + 8, r.bottom);
      }
    });
  }

  // ---- Window controls ---------------------------------------------------------
  renderWindowControls(state) {
    const mode = root.dataset.windowControls || "right";
    const frameless = this.app.state.config?.ui?.frameless !== false;
    const left = $("wc-left"), right = $("wc-right");
    const host = mode === "left" ? left : right;
    const other = host === left ? right : left;
    const show = frameless && mode !== "none" && !state?.fullscreen;
    other.hidden = true; other.innerHTML = "";
    host.hidden = !show;
    const max = !!state?.maximized;
    const key = `${mode}|${show}|${max}`;
    if (this.wcKey !== key) {
      this.wcKey = key;
      if (show) {
        const btns = [
          ["minimize", "minus", "Minimize", "window.minimize"],
          ["maximize", max ? "copy" : "square", max ? "Restore" : "Maximize", "window.toggleMaximize"],
          ["close", "x", "Close window", "window.close"],
        ];
        if (mode === "left") btns.reverse();
        host.innerHTML = btns.map(([k, ic, label]) =>
          `<button class="samo-btn samo-wc-btn samo-wc-${k}" data-wc="${k}" aria-label="${label}" title="${label}">${icon(ic, 14)}</button>`).join("");
        host.onclick = (e) => {
          const b = e.target.closest("[data-wc]");
          if (!b) return;
          const cmd = btns.find(([k]) => k === b.dataset.wc)?.[3];
          if (cmd) safeCall(this.samo, cmd);
        };
      } else host.innerHTML = "";
      this.measureFixed();
      this.layout("none");
    }
  }
}
