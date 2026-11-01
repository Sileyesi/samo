// samo://settings — deep customization hub.
// Every control writes immediately via config.set {key, value} and re-renders from
// config:changed, so edits made in config.toml or another window show up live.
import { samo, boot, t, lang, $, h, ic, debounce, toast, samoUrl, readableOn, engineName } from "./page.js";

let config = {};
let defaults = {};
let configPath = "";
const updaters = new Set();     // (cfg) => void — refresh a control from config
const rows = [];                // { el, text, sectionId } — for the settings filter
let currentSection = "appearance";

// ---- config helpers ---------------------------------------------------------------
const get = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

async function set(key, value) {
  try {
    const res = await samo.call("config.set", { key, value });
    if (res && res.config) { config = res.config; refresh(); }
  } catch (e) {
    console.error("[settings] config.set failed", key, e);
    toast(String(e.message || e).slice(0, 140), "error");
    refresh();
  }
}

function refresh() {
  for (const fn of updaters) {
    try { fn(config); } catch (e) { console.error("[settings] updater failed", e); }
  }
}

// ---- generic row + controls -----------------------------------------------------------
/** A settings row. opts: {key, label, desc, restart, control, stack, showIf, enabledIf} */
function row(opts) {
  const label = h("div", { class: "page-row__label", title: opts.key || null },
    t(opts.label), opts.restart ? h("span", { class: "badge", title: t("common.restart") }, ic("rotate-cw", 10), t("common.restart")) : null);
  const text = h("div", { class: "page-row__text" }, label, opts.desc ? h("div", { class: "page-row__desc" }, t(opts.desc)) : null);
  const el = h("div", { class: "page-row" + (opts.stack ? " page-row--stack" : ""), dataset: opts.key ? { key: opts.key } : undefined },
    text, opts.control ? h("div", { class: "page-row__control" }, opts.control) : null, opts.below || null);
  if (opts.showIf || opts.enabledIf) {
    updaters.add((cfg) => {
      if (opts.showIf) el.classList.toggle("is-hidden", !opts.showIf(cfg));
      if (opts.enabledIf) el.classList.toggle("is-disabled", !opts.enabledIf(cfg));
    });
  }
  el._search = [t(opts.label), opts.desc ? t(opts.desc) : "", opts.key || "", ...(opts.extraSearch || [])].join(" ").toLowerCase();
  return el;
}

function toggle(o) {
  const sw = h("button", { class: "samo-switch", role: "switch", "aria-checked": "false", "aria-label": t(o.label) });
  sw.addEventListener("click", () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    set(o.key, o.invert ? !next : next);
  });
  updaters.add((cfg) => { const v = !!get(cfg, o.key); sw.setAttribute("aria-checked", String(o.invert ? !v : v)); });
  return row({ ...o, control: sw });
}

function segmented(options, { value, onChange, label }) {
  const seg = h("div", { class: "samo-seg", role: "radiogroup", "aria-label": label || null });
  const thumb = h("span", { class: "samo-seg__thumb", "aria-hidden": "true" });
  seg.append(thumb);
  const btns = options.map(([val, lbl, iconName]) => {
    const b = h("button", { role: "radio", "aria-checked": "false", dataset: { value: JSON.stringify(val) } }, iconName ? ic(iconName, 14) : null, t(lbl));
    b.addEventListener("click", () => { select(val); onChange(val); });
    seg.append(b);
    return b;
  });
  const place = () => {
    const on = btns.find((b) => b.getAttribute("aria-checked") === "true");
    if (!on || !on.offsetWidth) { seg.style.setProperty("--_tw", "0px"); return; }
    seg.style.setProperty("--_tw", `${on.offsetWidth}px`);
    seg.style.setProperty("--_tx", `${on.offsetLeft}px`);
  };
  function select(val) {
    for (const b of btns) b.setAttribute("aria-checked", String(b.dataset.value === JSON.stringify(val)));
    place();
  }
  seg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = btns.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const j = (i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
    btns[j].click(); btns[j].focus(); e.preventDefault();
  });
  new ResizeObserver(place).observe(seg);
  seg._select = select;
  if (value !== undefined) select(value);
  return seg;
}

function seg(o) {
  const s = segmented(o.options, { onChange: (v) => set(o.key, v), label: t(o.label) });
  updaters.add((cfg) => s._select(get(cfg, o.key) ?? o.options[0][0]));
  return row({ ...o, control: s });
}

function rangeControl({ min, max, step, fmt, onInput, onCommit }) {
  const input = h("input", { class: "samo-range", type: "range", min, max, step });
  const out = h("output", { class: "samo-range-value" });
  const paint = () => {
    const p = ((input.value - min) / (max - min)) * 100;
    input.style.setProperty("--_p", `${p}%`);
    out.textContent = fmt(Number(input.value));
  };
  const commit = debounce(() => onCommit(Number(input.value)), 140);
  input.addEventListener("input", () => { paint(); onInput?.(Number(input.value)); commit(); });
  const wrap = h("div", { class: "samo-range-wrap" }, input, out);
  wrap._set = (v) => { if (document.activeElement !== input) { input.value = v; paint(); } };
  wrap._input = input;
  return wrap;
}

function slider(o) {
  const r = rangeControl({ min: o.min, max: o.max, step: o.step, fmt: o.fmt || String, onInput: o.onInput, onCommit: (v) => set(o.key, v) });
  updaters.add((cfg) => r._set(get(cfg, o.key) ?? o.min));
  return row({ ...o, control: r });
}

function select(o) {
  const sel = h("select", { "aria-label": t(o.label) }, ...o.options.map(([v, l]) => h("option", { value: v }, t(l))));
  sel.addEventListener("change", () => set(o.key, sel.value));
  updaters.add((cfg) => { sel.value = get(cfg, o.key) ?? o.options[0][0]; });
  return row({ ...o, control: h("div", { class: "samo-select" }, sel, ic("chevron-down", 14)) });
}

function textField(o) {
  const input = h("input", { class: "samo-input" + (o.mono ? " is-mono" : ""), type: "text", spellcheck: "false", placeholder: o.placeholder ? t(o.placeholder) : "", "aria-label": t(o.label) });
  const commit = () => {
    const v = o.parse ? o.parse(input.value) : input.value.trim();
    if (JSON.stringify(v) !== JSON.stringify(get(config, o.key) ?? "")) set(o.key, v);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { input.blur(); } if (e.key === "Escape") { input.value = get(config, o.key) ?? ""; input.blur(); } });
  updaters.add((cfg) => { if (document.activeElement !== input) input.value = get(cfg, o.key) ?? ""; });
  return row({ ...o, control: input });
}

// ---- custom: theme gallery ---------------------------------------------------------------
// Fallback colors for built-in themes when samo://theme/<id>.css is not served.
const BUILTIN_PREVIEW = {
  "samo-dark": ["#18181b", "#1f1f23", "#2a2a30", "#ececef", "#a1a1aa", "#a78bfa", "#141416", "dark"],
  "samo-light": ["#e8e8ec", "#f5f5f7", "#ffffff", "#1b1b20", "#5b5b66", "#7c3aed", "#f7f7f9", "light"],
  "midnight": ["#0b0f17", "#10161f", "#18202e", "#e2e8f2", "#94a3b8", "#22d3ee", "#090c13", "dark"],
  "frost": ["#2a2f3a", "#303643", "#3b4252", "#eceff4", "#b8c0cf", "#88c0d0", "#282d37", "dark"],
  "dusk": ["#1a1724", "#201d2d", "#2b2639", "#e7e2f3", "#aaa4bf", "#ebbcba", "#17141f", "dark"],
  "sakura": ["#f4e8e4", "#fbf4f1", "#fffdfb", "#3a2430", "#775866", "#c2386b", "#fdf8f5", "light"],
  "oled": ["#000000", "#000000", "#161616", "#ffffff", "#b8b8b8", "#f2f2f2", "#000000", "dark"],
};
const themeCssCache = new Map();

async function themeVars(theme) {
  if (themeCssCache.has(theme.id)) return themeCssCache.get(theme.id);
  let vars = null;
  try {
    const res = await fetch(samoUrl(`samo://theme/${encodeURIComponent(theme.id)}.css`), { cache: "no-store" });
    if (res.ok) {
      const css = (await res.text()).replace(/\/\*[\s\S]*?\*\//g, "");
      vars = {};
      for (const m of css.matchAll(/(--samo-[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
      if (!vars["--samo-bg-window"]) vars = null;
    }
  } catch { /* not served — fall back */ }
  if (!vars) {
    const p = BUILTIN_PREVIEW[theme.id] || (theme.scheme === "light" ? BUILTIN_PREVIEW["samo-light"] : BUILTIN_PREVIEW["samo-dark"]);
    vars = {
      "--samo-bg-window": p[0], "--samo-bg-tabstrip": p[0], "--samo-bg-toolbar": p[1], "--samo-tab-bg-active": p[2],
      "--samo-fg": p[3], "--samo-fg-muted": p[4], "--samo-accent": p[5], "--samo-bg-page": p[6], "--samo-color-scheme": p[7],
    };
  }
  themeCssCache.set(theme.id, vars);
  return vars;
}

function themePreview(theme) {
  const tp = h("div", { class: "tp", "aria-hidden": "true" },
    h("div", { class: "tp__strip" }, h("span", { class: "tp__tab is-active" }), h("span", { class: "tp__tab" }), h("span", { class: "tp__tab" })),
    h("div", { class: "tp__bar" }, h("span", { class: "tp__btn" }), h("span", { class: "tp__btn" }), h("span", { class: "tp__url" })),
    h("div", { class: "tp__page" }, h("span", { class: "tp__line" }), h("span", { class: "tp__line is-muted" }), h("span", { class: "tp__line is-muted is-short" }),
      h("span", { class: "tp__cta" }, h("span"), h("span"))));
  themeVars(theme).then((vars) => {
    for (const [k, v] of Object.entries(vars)) tp.style.setProperty(k, v);
  });
  return tp;
}

function themeGallery() {
  const grid = h("div", { class: "st-theme-grid", role: "radiogroup", "aria-label": t("ap.theme") });
  let filter = "all";
  let themes = [];
  const filterSeg = segmented([["all", "ap.theme.all"], ["dark", "ap.theme.dark", "moon"], ["light", "ap.theme.light", "sun"]],
    { value: "all", label: t("ap.theme"), onChange: (v) => { filter = v; applyFilter(); } });
  const applyFilter = () => {
    for (const card of grid.children) card.classList.toggle("is-filtered", filter !== "all" && card.dataset.scheme !== filter);
  };
  const mark = (cfg) => {
    const cur = cfg?.ui?.theme;
    for (const card of grid.children) card.setAttribute("aria-checked", String(card.dataset.id === cur));
  };
  async function load() {
    try { themes = (await samo.call("theme.list")).items || []; } catch (e) { console.error(e); themes = []; }
    themeCssCache.clear();
    grid.replaceChildren(...themes.map((th) => {
      const card = h("button", { class: "st-theme", role: "radio", "aria-checked": "false", dataset: { id: th.id, scheme: th.scheme }, title: th.id },
        themePreview(th),
        h("span", { class: "st-theme__check" }, ic("check", 12)),
        h("span", { class: "st-theme__meta" }, ic(th.scheme === "light" ? "sun" : "moon", 13), h("span", { class: "u-truncate" }, th.name || th.id),
          th.builtin === false ? h("span", { class: "badge badge--muted" }, t("ap.theme.custom")) : null));
      card.addEventListener("click", () => { mark({ ui: { theme: th.id } }); set("ui.theme", th.id); });
      return card;
    }));
    applyFilter();
    mark(config);
  }
  grid.addEventListener("keydown", (e) => {
    const cards = [...grid.children].filter((c) => !c.classList.contains("is-filtered"));
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); cards[(i + d + cards.length) % cards.length].focus(); }
  });
  updaters.add(mark);
  samo.on("theme:changed", load);
  load();

  const el = h("div", { class: "st-themes" },
    h("div", { class: "st-themes__bar" },
      h("div", { class: "page-row__text" }, h("div", { class: "page-row__label", title: "ui.theme" }, t("ap.theme")), h("div", { class: "page-row__desc" }, t("ap.theme.desc"))),
      filterSeg),
    grid);
  el._search = [t("ap.theme"), t("ap.theme.desc"), "ui.theme theme тема"].join(" ").toLowerCase();
  return el;
}

// ---- custom: accent ------------------------------------------------------------------------
const ACCENT_PRESETS = ["#a78bfa", "#60a5fa", "#22d3ee", "#34d399", "#a3e635", "#facc15", "#fb923c", "#f87171", "#f472b6", "#e879f9"];

function accentRow() {
  const mode = (cfg) => { const a = cfg?.ui?.accent ?? "page"; return a === "page" || a === "theme" ? a : "custom"; };
  let lastCustom = "#a78bfa";
  const seg = segmented([["page", "ap.accent.page", "globe"], ["theme", "ap.accent.theme", "palette"], ["custom", "ap.accent.custom", "sparkles"]], {
    label: t("ap.accent"),
    onChange: (v) => set("ui.accent", v === "custom" ? lastCustom : v),
  });
  const picker = h("input", { type: "color", "aria-label": t("ap.accent.custom") });
  const pickerWrap = h("label", { class: "st-swatch st-swatch--picker", title: t("ap.accent.custom") }, picker);
  const hex = h("span", { class: "st-accent-hex" });
  const swatches = ACCENT_PRESETS.map((c) => {
    const b = h("button", { class: "st-swatch", role: "radio", "aria-checked": "false", "aria-label": c, title: c, style: { "--sw": c } });
    b.addEventListener("click", () => set("ui.accent", c));
    return b;
  });
  const commitPicker = debounce((v) => set("ui.accent", v), 160);
  picker.addEventListener("input", () => {
    const v = picker.value;
    document.documentElement.style.setProperty("--samo-accent", v);
    document.documentElement.style.setProperty("--samo-accent-fg", readableOn(v));
    pickerWrap.style.setProperty("--sw-custom", v);
    hex.textContent = v;
    commitPicker(v);
  });
  const swRow = h("div", { class: "st-swatches", role: "radiogroup", "aria-label": t("ap.accent.custom") }, ...swatches, pickerWrap, hex);
  updaters.add((cfg) => {
    const m = mode(cfg);
    seg._select(m);
    const a = String(cfg?.ui?.accent || "").toLowerCase();
    if (m === "custom") { lastCustom = a; picker.value = a; hex.textContent = a; }
    else hex.textContent = "";
    let preset = false;
    for (const b of swatches) { const on = m === "custom" && b.title === a; preset ||= on; b.setAttribute("aria-checked", String(on)); }
    pickerWrap.style.setProperty("--sw-custom", m === "custom" && !preset ? a : "var(--samo-surface-1)");
    pickerWrap.setAttribute("aria-checked", String(m === "custom" && !preset));
  });
  const el = row({ key: "ui.accent", label: "ap.accent", desc: "ap.accent.desc", control: seg, stack: false });
  const wrap = h("div", null, el, h("div", { class: "page-row", style: { paddingTop: "0", minHeight: "0", boxShadow: "none" } }, swRow));
  wrap._search = el._search + " color цвет accent";
  return wrap;
}

// ---- custom: animation speed + live demo -------------------------------------------------------
function speedRow() {
  const el = slider({
    key: "ui.animation_speed", label: "ap.speed", desc: "ap.speed.desc", min: 0.5, max: 2, step: 0.05,
    fmt: (v) => `${v.toFixed(2).replace(/0$/, "")}×`,
    onInput: (v) => document.documentElement.style.setProperty("--samo-anim-speed", String(v)),
  });
  const ind = h("span", { class: "st-demo__ind" });
  const pop = h("span", { class: "st-demo__pop", "aria-hidden": "true" });
  const strip = h("div", { class: "st-demo__strip", "aria-hidden": "true" }, ind, ...[0, 1, 2, 3].map(() => h("span", { class: "st-demo__tab" })));
  const demo = h("div", { class: "st-demo" }, h("span", { class: "st-demo__label" }, t("ap.speed.demo")), strip, pop);
  let i = 0;
  const step = () => {
    i = (i + 1) % 4;
    ind.style.setProperty("--_i", String([0, 2, 1, 3][i]));
    pop.classList.toggle("is-alt", i % 2 === 1);
    const speed = Number(getComputedStyle(document.documentElement).getPropertyValue("--samo-anim-speed")) || 1;
    setTimeout(step, 900 * Math.max(0.6, speed));
  };
  setTimeout(step, 700);
  const wrap = h("div", null, el, demo);
  wrap._search = el._search + " animation анимац motion";
  return wrap;
}

// ---- custom: search engines ---------------------------------------------------------------------
function searchEngines() {
  const list = h("div", { role: "radiogroup", "aria-label": t("se.engine") });
  const nameIn = h("input", { class: "samo-input", type: "text", placeholder: t("se.name"), spellcheck: "false", "aria-label": t("se.name") });
  const urlIn = h("input", { class: "samo-input is-mono", type: "url", placeholder: t("se.url"), spellcheck: "false", "aria-label": "URL" });
  const err = h("div", { class: "st-field-error", role: "alert" });
  const addBtn = h("button", { class: "samo-btn samo-btn--text samo-btn--primary", type: "submit" }, ic("plus", 14), t("common.add"));
  const form = h("form", { class: "st-add-engine" }, nameIn, urlIn, addBtn);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameIn.value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");
    const url = urlIn.value.trim();
    if (!name) { nameIn.focus(); return; }
    if (!/^https?:\/\/\S+$/i.test(url) || !url.includes("{q}")) { err.textContent = t("se.invalid"); urlIn.focus(); return; }
    if (config?.search?.engines?.[name]) { err.textContent = t("se.exists"); nameIn.focus(); return; }
    err.textContent = "";
    set(`search.engines.${name}`, url).then(() => { nameIn.value = ""; urlIn.value = ""; toast(t("settings.saved")); });
  });
  const render = (cfg) => {
    const engines = cfg?.search?.engines || {};
    const active = cfg?.general?.search_engine;
    const builtin = defaults?.search?.engines || {};
    list.replaceChildren(...Object.entries(engines).map(([name, url]) => {
      const item = h("div", { class: "st-engine", role: "radio", tabindex: "0", "aria-checked": String(name === active) },
        h("span", { class: "st-radio" }),
        h("span", { class: "st-engine__text" }, h("span", { class: "st-engine__name" }, engineName(name)), h("span", { class: "st-engine__url", title: url }, url)),
        name === active ? h("span", { class: "badge badge--accent" }, t("se.active")) : null,
        !(name in builtin) && name !== active
          ? h("button", { class: "samo-btn samo-btn--danger samo-btn--sm", title: t("se.remove"), "aria-label": t("se.remove"),
              onclick: (e) => { e.stopPropagation(); set(`search.engines.${name}`, null); } }, ic("trash", 14))
          : null);
      const choose = () => { if (name !== active) set("general.search_engine", name); };
      item.addEventListener("click", choose);
      item.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); choose(); }
        if (e.key === "ArrowDown") { e.preventDefault(); item.nextElementSibling?.focus(); }
        if (e.key === "ArrowUp") { e.preventDefault(); item.previousElementSibling?.focus(); }
      });
      return item;
    }));
  };
  updaters.add(render);
  const card1 = h("div", { class: "page-card" }, list);
  card1._search = [t("se.engine"), "search engine поиск general.search_engine duckduckgo google yandex"].join(" ").toLowerCase();
  const add = row({ label: "se.add", desc: "se.add.desc", stack: true, below: h("div", null, form, err), extraSearch: ["search.engines"] });
  return { list: card1, add };
}

// ---- custom: keyboard shortcuts ---------------------------------------------------------------
const KEY_LABEL = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "Super", plus: "+", minus: "−", comma: ",", period: ".", left: "←", right: "→", up: "↑", down: "↓",
  pageup: "PgUp", pagedown: "PgDn", escape: "Esc", enter: "Enter", space: "Space", delete: "Del", backspace: "⌫", tab: "Tab", home: "Home", end: "End" };
const keyLabel = (k) => KEY_LABEL[k] || (k.length === 1 ? k.toUpperCase() : k.toUpperCase());
const normAccel = (a) => {
  const parts = String(a).toLowerCase().split("+").filter(Boolean);
  const key = parts.pop() || "";
  const mods = ["ctrl", "shift", "alt", "meta"].filter((m) => parts.includes(m));
  return [...mods, key].join("+");
};
const accelList = (a) => (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => String(x).split(/\s*,\s*/)).filter(Boolean).map(normAccel);

/** KeyboardEvent → accelerator string (layout-independent via e.code), or null. */
function eventToAccel(e) {
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^Numpad\d$/.test(c)) key = c.slice(6);
  else if (/^F([1-9]|1[0-2])$/.test(c)) key = c.toLowerCase();
  else key = ({ Tab: "tab", PageUp: "pageup", PageDown: "pagedown", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    Escape: "escape", Enter: "enter", NumpadEnter: "enter", Equal: "plus", NumpadAdd: "plus", Minus: "minus", NumpadSubtract: "minus",
    Comma: "comma", Period: "period", Delete: "delete", Backspace: "backspace", Home: "home", End: "end", Space: "space" })[c] || null;
  if (!key) return null;
  const mods = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt", e.metaKey && "meta"].filter(Boolean);
  return [...mods, key].join("+");
}

function accelChips(accels) {
  if (!accels.length) return [t("keys.none")];
  const out = [];
  accels.forEach((a, i) => {
    if (i) out.push(h("span", { class: "st-accel__sep" }, "/"));
    for (const k of a.split("+")) out.push(h("kbd", { class: "samo-kbd" }, keyLabel(k)));
  });
  return out;
}

const actionLabel = (it) => { const k = `action.${it.action}`; const v = t(k); return v === k ? (it.label || it.action) : v; };

function keyboardSection() {
  const list = h("div", { class: "page-card" });
  const filterIn = h("input", { class: "samo-input", type: "search", placeholder: t("keys.filter"), spellcheck: "false", "aria-label": t("keys.filter") });
  let items = [];
  let recording = null; // { action, btn }

  const stopRecording = (restore = true) => {
    if (!recording) return;
    window.removeEventListener("keydown", onRecordKey, true);
    samo.call("keys.suspend", { suspended: false }).catch(() => {});
    const r = recording; recording = null;
    if (restore) render();
    r.btn.focus();
  };
  function onRecordKey(e) {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) return;
    const { action, btn } = recording;
    if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopRecording(); return; }
    if ((e.code === "Backspace" || e.code === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      stopRecording(false); set(`keys.${action}`, ""); return;
    }
    const accel = eventToAccel(e);
    const hasMod = e.ctrlKey || e.altKey || e.metaKey || /^f\d+$/.test(accel || "");
    if (!accel || !hasMod) {
      btn.classList.remove("is-shake"); void btn.offsetWidth; btn.classList.add("is-shake");
      return;
    }
    const clash = items.find((it) => it.action !== action && accelList(it.accel).includes(accel));
    stopRecording(false);
    set(`keys.${action}`, accel).then(() => { if (clash) toast(t("keys.conflict", { a: actionLabel(clash) }), "error"); });
  }
  const startRecording = (action, btn) => {
    stopRecording();
    recording = { action, btn };
    btn.classList.add("is-recording");
    btn.replaceChildren(t("keys.record"));
    samo.call("keys.suspend", { suspended: true }).catch(() => {});
    window.addEventListener("keydown", onRecordKey, true);
  };

  const render = () => {
    const q = filterIn.value.trim().toLowerCase();
    const counts = new Map();
    for (const it of items) for (const a of accelList(it.accel)) counts.set(a, (counts.get(a) || 0) + 1);
    const overrides = config?.keys || {};
    const shown = items.filter((it) => !q || `${actionLabel(it)} ${it.label} ${it.action} ${accelList(it.accel).join(" ")}`.toLowerCase().includes(q));
    list.replaceChildren(...shown.map((it) => {
      const accels = accelList(it.accel);
      const custom = Object.prototype.hasOwnProperty.call(overrides, it.action);
      const conflict = accels.some((a) => counts.get(a) > 1);
      const btn = h("button", { class: "st-accel" + (accels.length ? "" : " is-empty"), title: t("keys.add"), "aria-label": `${actionLabel(it)}: ${accels.join(", ") || t("keys.none")}` }, accelChips(accels));
      btn.addEventListener("click", () => startRecording(it.action, btn));
      const reset = custom
        ? h("button", { class: "samo-btn samo-btn--sm", title: t("keys.reset"), "aria-label": t("keys.reset"), onclick: () => set(`keys.${it.action}`, null) }, ic("rotate-ccw", 14))
        : h("span", { style: { width: "26px" } });
      const label = h("div", { class: "page-row__label" }, actionLabel(it),
        custom ? h("span", { class: "badge badge--accent" }, t("keys.custom")) : null,
        conflict ? h("span", { class: "badge", title: t("keys.conflict", { a: "" }) }, ic("alert-triangle", 10)) : null);
      return h("div", { class: "page-row st-key" },
        h("div", { class: "page-row__text" }, label, h("div", { class: "st-key__action" }, it.action)),
        h("div", { class: "page-row__control" }, btn, reset));
    }));
    if (!shown.length) list.append(h("div", { class: "page-row" }, h("div", { class: "page-row__desc" }, t("common.nothing"))));
  };
  async function load() {
    try { items = (await samo.call("keys.list")).items || []; } catch (e) { console.error(e); items = []; }
    if (!recording) render();
  }
  filterIn.addEventListener("input", render);
  updaters.add(() => { if (!recording) load(); });
  load();

  const filterWrap = h("label", { class: "page-search st-keys-filter" }, ic("search", 14), filterIn);
  const wrap = h("div", null, filterWrap, list);
  wrap._search = [t("sec.keys"), "keys shortcut клавиш сочетан hotkey"].join(" ").toLowerCase();
  wrap._noCard = true;
  return wrap;
}

// ---- custom: advanced ----------------------------------------------------------------------
function dirname(p) { return p ? p.replace(/\/[^/]*$/, "") : ""; }

function codeBox(text) {
  const LRM = "\u200E"; // keeps leading "/" in place inside the rtl-ellipsis box
  const span = h("span", { title: text }, LRM + text + LRM);
  const btn = h("button", { class: "samo-btn", title: t("common.copy"), "aria-label": t("common.copy") }, ic("copy", 13));
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(span.title); toast(t("common.copied")); } catch { toast(t("common.error"), "error"); }
  });
  const box = h("div", { class: "st-code" }, span, btn);
  box._set = (v) => { span.textContent = LRM + v + LRM; span.title = v; };
  return box;
}

function advancedRows() {
  const dir = () => dirname(configPath) || "~/.config/samo";
  const cfgBox = codeBox(configPath || "~/.config/samo/config.toml");
  const cssBox = codeBox(`${dir()}/user.css`);
  const themesBox = codeBox(`${dir()}/themes/`);
  const openBtn = h("button", { class: "samo-btn samo-btn--text samo-btn--subtle" }, ic("external-link", 14), t("adv.config.open"));
  openBtn.addEventListener("click", () => samo.call("config.openFile").catch((e) => toast(String(e.message || e), "error")));
  const reloadBtn = h("button", { class: "samo-btn samo-btn--text samo-btn--subtle" }, ic("refresh-ccw", 14), t("adv.reload.btn"));
  reloadBtn.addEventListener("click", async () => {
    try { await samo.call("theme.reload"); samo.reloadTheme(); toast(t("adv.reloaded")); } catch (e) { toast(String(e.message || e), "error"); }
  });
  const json = h("pre", { class: "st-json" });
  updaters.add((cfg) => { json.textContent = JSON.stringify(cfg, null, 2); });
  const details = h("details", { class: "st-details" }, h("summary", null, ic("chevron-right", 14), "config.json"), json);
  details._search = "config json конфиг";
  return [
    row({ label: "adv.config", desc: "adv.config.desc", control: h("div", { class: "u-col", style: { gap: "8px", alignItems: "flex-end" } }, openBtn, cfgBox), extraSearch: ["config.toml"] }),
    row({ label: "adv.usercss", desc: "adv.usercss.desc", control: cssBox, extraSearch: ["user.css css userchrome"] }),
    row({ label: "adv.themes", desc: "adv.themes.desc", control: themesBox, extraSearch: ["themes"] }),
    row({ label: "adv.reload", desc: "adv.reload.desc", control: reloadBtn, extraSearch: ["ctrl+alt+r"] }),
    details,
  ];
}

// ---- section schema ---------------------------------------------------------------------------
const pct = (v) => `${Math.round(v * 100)}%`;
const px = (v) => `${v} px`;
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} ${lang === "ru" ? "с" : "s"}` : `${v} ${lang === "ru" ? "мс" : "ms"}`);

function buildSections() {
  const se = searchEngines();
  return [
    { id: "appearance", icon: "palette", groups: [
      { title: "ap.group.theme", rows: [themeGallery()] },
      { title: "ap.group.color", rows: [
        accentRow(),
        slider({ key: "ui.page_tint_strength", label: "ap.tint", desc: "ap.tint.desc", min: 0, max: 1, step: 0.05, fmt: pct, enabledIf: (c) => (c?.ui?.accent ?? "page") === "page" }),
      ] },
      { title: "ap.group.motion", rows: [
        speedRow(),
        toggle({ key: "ui.reduce_motion", label: "ap.reduce", desc: "ap.reduce.desc" }),
      ] },
      { title: "ap.group.layout", rows: [
        seg({ key: "ui.density", label: "ap.density", desc: "ap.density.desc", options: [["normal", "ap.density.normal"], ["compact", "ap.density.compact"]] }),
        slider({ key: "ui.content_inset", label: "ap.inset", desc: "ap.inset.desc", min: 0, max: 16, step: 1, fmt: px }),
        textField({ key: "ui.font_ui", label: "ap.font", desc: "ap.font.desc", placeholder: "ap.font.placeholder" }),
      ] },
      { title: "ap.window", rows: [
        toggle({ key: "ui.frameless", label: "ap.frameless", desc: "ap.frameless.desc", restart: true }),
        seg({ key: "ui.window_controls", label: "ap.controls", desc: "ap.controls.desc", options: [["left", "ap.controls.left"], ["right", "ap.controls.right"], ["none", "ap.controls.none"]] }),
      ] },
    ] },
    { id: "tabs", icon: "panel-top", groups: [{ rows: [
      slider({ key: "tabs.max_width", label: "tabs.maxw", desc: "tabs.maxw.desc", min: 120, max: 400, step: 4, fmt: px }),
      slider({ key: "tabs.min_width", label: "tabs.minw", desc: "tabs.minw.desc", min: 32, max: 160, step: 2, fmt: px }),
      seg({ key: "tabs.close_button", label: "tabs.close", desc: "tabs.close.desc", options: [["always", "tabs.close.always"], ["hover", "tabs.close.hover"], ["active", "tabs.close.active"]] }),
      seg({ key: "tabs.indicator", label: "tabs.indicator", desc: "tabs.indicator.desc", options: [["card", "tabs.indicator.card"], ["underline", "tabs.indicator.underline"]] }),
      toggle({ key: "tabs.hide_throbber", label: "tabs.throbber", desc: "tabs.throbber.desc" }),
      seg({ key: "tabs.new_tab_position", label: "tabs.newpos", desc: "tabs.newpos.desc", options: [["after-current", "tabs.newpos.after"], ["end", "tabs.newpos.end"]] }),
      toggle({ key: "tabs.close_window_with_last_tab", label: "tabs.lastclose", desc: "tabs.lastclose.desc" }),
    ] }] },
    { id: "compact", icon: "minimize-2", groups: [{ rows: [
      toggle({ key: "compact.enabled", label: "cm.enabled", desc: "cm.enabled.desc" }),
      slider({ key: "compact.hide_delay_ms", label: "cm.delay", desc: "cm.delay.desc", min: 100, max: 3000, step: 50, fmt: ms }),
    ] }] },
    { id: "urlbar", icon: "command", groups: [{ rows: [
      seg({ key: "urlbar.ctrl_t", label: "ub.ctrlt", desc: "ub.ctrlt.desc", options: [["palette", "ub.ctrlt.palette"], ["newtab", "ub.ctrlt.newtab"]] }),
      toggle({ key: "urlbar.show_full_url", label: "ub.full", desc: "ub.full.desc" }),
      slider({ key: "urlbar.max_suggestions", label: "ub.max", desc: "ub.max.desc", min: 3, max: 15, step: 1, fmt: String }),
    ] }] },
    { id: "search", icon: "search", groups: [
      { title: "se.engine", rows: [se.list], raw: true },
      { rows: [se.add] },
    ] },
    { id: "startup", icon: "power", groups: [{ rows: [
      seg({ key: "general.startup", label: "st.on", desc: "st.on.desc", options: [["restore", "st.restore"], ["newtab", "st.newtab"], ["homepage", "st.homepage"]] }),
      textField({ key: "general.homepage", label: "st.home", desc: "st.home.desc", mono: true, placeholder: "samo://newtab/" }),
      textField({ key: "general.newtab_url", label: "st.ntp", desc: "st.ntp.desc", mono: true, placeholder: "samo://newtab/" }),
      textField({ key: "general.downloads_dir", label: "st.dl", desc: "st.dl.desc", mono: true, placeholder: "~/Downloads" }),
    ] }] },
    { id: "keys", icon: "keyboard", groups: [{ rows: [keyboardSection()], raw: true }] },
    { id: "engine", icon: "cpu", restart: true, groups: [{ rows: [
      select({ key: "engine.ozone_platform", label: "en.ozone", desc: "en.ozone.desc", restart: true, options: [["auto", "en.ozone.auto"], ["wayland", "Wayland"], ["x11", "X11"]] }),
      toggle({ key: "engine.smooth_scrolling", label: "en.smooth", desc: "en.smooth.desc", restart: true }),
      toggle({ key: "engine.gpu_rasterization", label: "en.gpu", desc: "en.gpu.desc", restart: true }),
      textField({ key: "engine.user_agent", label: "en.ua", desc: "en.ua.desc", restart: true, mono: true, placeholder: "en.ua.placeholder" }),
      flagsRow(),
    ] }] },
    { id: "advanced", icon: "sliders", groups: [{ rows: advancedRows() }] },
  ];
}

function flagsRow() {
  const ta = h("textarea", { class: "st-textarea", spellcheck: "false", rows: 3, placeholder: "--enable-features=VaapiVideoDecoder", "aria-label": t("en.flags") });
  const parse = () => ta.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  ta.addEventListener("change", () => set("engine.extra_flags", parse()));
  updaters.add((cfg) => { if (document.activeElement !== ta) ta.value = (cfg?.engine?.extra_flags || []).join("\n"); });
  return row({ key: "engine.extra_flags", label: "en.flags", desc: "en.flags.desc", restart: true, stack: true, below: ta });
}

// ---- render ----------------------------------------------------------------------------------
const navItems = new Map();
const sectionEls = new Map();

function render() {
  const content = $("#content");
  const nav = $("#nav");
  for (const sec of buildSections()) {
    const title = t(`sec.${sec.id}`);
    const secEl = h("section", { class: "st-section", id: `s-${sec.id}`, dataset: { id: sec.id }, "aria-labelledby": `h-${sec.id}` },
      h("header", { class: "st-section__head" },
        h("h2", { class: "st-section__title", id: `h-${sec.id}` }, title, sec.restart ? h("span", { class: "badge" }, ic("rotate-cw", 10), t("common.restart")) : null),
        h("p", { class: "st-section__desc" }, t(`sec.${sec.id}.desc`))));
    for (const g of sec.groups) {
      const groupEl = h("div", { class: "st-group" }, g.title ? h("h3", { class: "st-group__title" }, t(g.title)) : null);
      const holder = g.raw ? groupEl : h("div", { class: "page-card" });
      for (const r of g.rows) {
        holder.append(r);
        rows.push({ el: r, text: `${r._search || ""} ${title.toLowerCase()}`, sectionId: sec.id, groupEl });
      }
      if (!g.raw) groupEl.append(holder);
      secEl.append(groupEl);
    }
    content.append(secEl);
    sectionEls.set(sec.id, secEl);

    const item = h("a", { class: "st-nav__item", href: `#${sec.id}`, dataset: { id: sec.id } }, ic(sec.icon, 16), h("span", null, title),
      sec.restart ? h("span", { class: "badge", title: t("common.restart") }) : null,
      h("span", { class: "st-nav__count", hidden: true }));
    item.addEventListener("click", (e) => {
      e.preventDefault();
      if ($("#filter").value) { $("#filter").value = ""; applyFilter(); }
      show(sec.id, true);
    });
    nav.append(item);
    navItems.set(sec.id, item);
  }
}

function placePill() {
  const pill = $("#nav-pill");
  const item = navItems.get(currentSection);
  const searching = document.body.classList.contains("st-searching");
  if (!item || searching) { pill.style.setProperty("--_o", "0"); return; }
  pill.style.setProperty("--_y", `${item.offsetTop}px`);
  pill.style.setProperty("--_o", "1");
}

function show(id, pushHash) {
  if (!sectionEls.has(id)) id = "appearance";
  currentSection = id;
  for (const [sid, el] of sectionEls) el.classList.toggle("is-active", sid === id);
  for (const [sid, el] of navItems) {
    if (sid === id) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  }
  placePill();
  $("#main").scrollTop = 0;
  if (pushHash && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  refresh(); // segmented thumbs need layout once visible
}

function applyFilter() {
  const q = $("#filter").value.trim().toLowerCase();
  const searching = q.length > 0;
  document.body.classList.toggle("st-searching", searching);
  const terms = q.split(/\s+/).filter(Boolean);
  const perSection = new Map();
  for (const r of rows) {
    const hit = !searching || terms.every((term) => r.text.includes(term));
    r.el.classList.toggle("is-hidden", !hit && searching);
    if (hit) perSection.set(r.sectionId, (perSection.get(r.sectionId) || 0) + 1);
  }
  for (const g of new Set(rows.map((r) => r.groupEl))) {
    const any = rows.some((r) => r.groupEl === g && !r.el.classList.contains("is-hidden"));
    g.classList.toggle("is-empty", searching && !any);
  }
  for (const [id, el] of sectionEls) {
    const n = perSection.get(id) || 0;
    el.classList.toggle("is-empty", searching && n === 0);
    const item = navItems.get(id);
    item.classList.toggle("is-dim", searching && n === 0);
    const count = item.querySelector(".st-nav__count");
    count.hidden = !searching || n === 0;
    count.textContent = String(n);
  }
  const none = searching && perSection.size === 0;
  const nr = $("#noresults");
  nr.hidden = !none;
  if (none) nr.replaceChildren(h("div", { class: "page-empty" }, h("div", { class: "page-empty__icon" }, ic("search", 24)), h("div", { class: "page-empty__title" }, t("settings.noResults", { q: $("#filter").value.trim() }))));
  if (!searching) {
    // restore conditional visibility (showIf) after clearing the filter
    for (const r of rows) r.el.classList.remove("is-hidden");
    refresh();
    show(currentSection);
  }
  placePill();
  if (searching) refresh();
}

// ---- boot ------------------------------------------------------------------------------------
const res = await boot("settings.title");
config = res.config || {};
defaults = res.defaults || {};
configPath = res.path || "";

$("#brand-logo").append(ic("settings", 16));
$("#filter-icon").append(ic("search", 14));
render();
{
  const foot = $("#side-foot");
  const btn = h("button", { class: "samo-btn samo-btn--text", title: configPath }, ic("file", 14), t("adv.config.open"));
  btn.addEventListener("click", () => samo.call("config.openFile").catch((e) => toast(String(e.message || e), "error")));
  foot.append(btn, h("div", { class: "st-path", title: configPath }, "\u200E" + configPath + "\u200E"));
}

const initial = new URLSearchParams(location.search).get("section") || location.hash.slice(1) || "appearance";
show(initial);
refresh();

samo.on("config:changed", (p) => { config = p.config || config; refresh(); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
window.addEventListener("resize", debounce(placePill, 50));

const filter = $("#filter");
filter.addEventListener("input", applyFilter);
filter.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { filter.value = ""; applyFilter(); filter.blur(); }
  if (e.key === "Enter") { const first = rows.find((r) => !r.el.classList.contains("is-hidden")); first?.el.scrollIntoView({ block: "center" }); first?.el.classList.add("is-flash"); setTimeout(() => first?.el.classList.remove("is-flash"), 1000); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); filter.focus(); filter.select(); }
});
$("#nav").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = [...navItems.values()];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
  n.focus(); n.click();
});
