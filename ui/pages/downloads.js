// samo://downloads — list + live `download:updated`, progress, open / show in folder / cancel.
import { samo, boot, t, $, h, ic, hostOf, formatBytes, formatDuration, avatarColor, toast } from "./page.js";

const items = new Map();   // id -> Download
const els = new Map();     // id -> element
let filter = "";

const EXT_ICON = [
  [/^(zip|tar|gz|tgz|bz2|xz|zst|7z|rar)$/, "layers"],
  [/^(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/, "image"],
  [/^(mp4|mkv|webm|mov|avi)$/, "play"],
  [/^(mp3|flac|ogg|opus|wav|m4a)$/, "volume-2"],
  [/^(appimage|deb|rpm|exe|msi|dmg|run|sh|flatpakref)$/, "cpu"],
  [/^(html?|url)$/, "globe"],
];

function extOf(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name || "");
  if (!m) return "";
  // treat .tar.gz etc. as the last segment
  return m[1].toLowerCase();
}

function iconFor(ext) {
  for (const [re, name] of EXT_ICON) if (re.test(ext)) return name;
  return "file";
}

function sep() { return h("span", { class: "sep", "aria-hidden": "true" }); }

function metaFor(d) {
  const host = hostOf(d.url);
  switch (d.state) {
    case "progress": {
      const parts = [d.total > 0 ? t("dl.of", { a: formatBytes(d.received), b: formatBytes(d.total) }) : formatBytes(d.received)];
      if (d.speed > 0) parts.push(`${formatBytes(d.speed)}/s`);
      if (d.speed > 0 && d.total > d.received) parts.push(t("dl.left", { t: formatDuration((d.total - d.received) / d.speed) }));
      return parts.flatMap((p, i) => (i ? [sep(), h("span", null, p)] : [h("span", null, p)]));
    }
    case "complete":
      return [h("span", null, formatBytes(d.total || d.received)), host ? sep() : null, host ? h("span", { class: "host" }, host) : null];
    case "cancelled":
      return [h("span", null, t("dl.cancelled")), host ? sep() : null, host ? h("span", { class: "host" }, host) : null];
    default:
      return [h("span", { class: "is-error" }, t("dl.interrupted")), sep(),
        h("span", null, d.total > 0 ? t("dl.of", { a: formatBytes(d.received), b: formatBytes(d.total) }) : formatBytes(d.received)),
        host ? sep() : null, host ? h("span", { class: "host" }, host) : null];
  }
}

function act(name, label, fn, extra = "") {
  const b = h("button", { class: `samo-btn ${extra}`, title: label, "aria-label": label }, ic(name, 16));
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

const call = (cmd, args) => samo.call(cmd, args).catch((e) => toast(String(e.message || e).slice(0, 120), "error"));

function build(d) {
  const ext = extOf(d.name);
  const el = h("article", { class: "dl-item", tabindex: "0", dataset: { id: d.id } });
  el.style.setProperty("--_c", avatarColor(ext || d.name || "x"));
  el.addEventListener("click", () => { const cur = items.get(d.id); if (cur?.state === "complete") call("downloads.open", { id: d.id }); });
  el.addEventListener("keydown", (e) => {
    const cur = items.get(d.id);
    if (e.key === "Enter" && cur?.state === "complete") call("downloads.open", { id: d.id });
    if (e.key === "Delete" && cur?.state === "progress") call("downloads.cancel", { id: d.id });
    if (e.key === "ArrowDown") { e.preventDefault(); el.nextElementSibling?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); (el.previousElementSibling || $("#q")).focus(); }
  });
  fill(el, d);
  return el;
}

function fill(el, d) {
  const ext = extOf(d.name);
  const pct = d.total > 0 ? Math.min(1, d.received / d.total) : 0;
  // Same state → patch text + progress in place (keeps running animations smooth).
  if (el.dataset.state === d.state && el.firstChild) {
    el.querySelector(".dl-item__meta").replaceChildren(...metaFor(d).filter(Boolean));
    const p = el.querySelector(".dl-progress");
    if (p) {
      p.classList.toggle("is-indeterminate", !(d.total > 0));
      p.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
      p.querySelector(".dl-progress__fill").style.setProperty("--_p", String(pct));
    }
    return;
  }
  el.dataset.state = d.state;
  let progress = el.querySelector(".dl-progress");
  const body = h("div", { class: "dl-item__body" },
    h("div", { class: "dl-item__name", title: d.path || d.name }, d.name || hostOf(d.url)),
    h("div", { class: "dl-item__meta" }, metaFor(d)));
  if (d.state === "progress") {
    // keep the same progress element so the fill transitions smoothly
    if (!progress) progress = h("div", { class: "dl-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, h("div", { class: "dl-progress__fill" }));
    progress.classList.toggle("is-indeterminate", !(d.total > 0));
    progress.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
    requestAnimationFrame(() => progress.querySelector(".dl-progress__fill").style.setProperty("--_p", String(pct)));
    body.append(progress);
  }
  const actions = h("div", { class: "dl-item__actions" },
    d.state === "complete" ? act("folder", t("dl.show"), () => call("downloads.showInFolder", { id: d.id })) : null,
    d.state === "complete" ? act("external-link", t("dl.open"), () => call("downloads.open", { id: d.id })) : null,
    d.state === "progress" ? act("x", t("dl.cancel"), () => call("downloads.cancel", { id: d.id }), "samo-btn--danger") : null,
    act("link", t("dl.copyLink"), async () => {
      try { await navigator.clipboard.writeText(d.url); toast(t("common.copied")); } catch { toast(t("common.error"), "error"); }
    }));
  const iconBox = h("div", { class: "dl-item__icon", "aria-hidden": "true" }, ic(iconFor(ext), 20), ext ? h("span", { class: "dl-item__ext" }, ext.slice(0, 4)) : null);
  el.replaceChildren(iconBox, body, actions);
}

function matches(d) {
  return !filter || `${d.name} ${d.url}`.toLowerCase().includes(filter);
}

function updateHeader() {
  const active = [...items.values()].filter((d) => d.state === "progress").length;
  const badge = $("#active");
  badge.hidden = active === 0;
  badge.textContent = t("dl.active", { n: active });
}

function renderAll() {
  const list = $("#list");
  const sorted = [...items.values()].sort((a, b) => b.id - a.id).filter(matches);
  if (!sorted.length) {
    els.clear();
    list.replaceChildren(h("div", { class: "page-empty" },
      h("div", { class: "page-empty__icon" }, ic(filter ? "search" : "download", 24)),
      h("div", { class: "page-empty__title" }, filter ? t("common.nothing") : t("dl.empty")),
      filter ? null : h("div", null, t("dl.emptyHint"))));
  } else {
    list.replaceChildren(...sorted.map((d) => {
      let el = els.get(d.id);
      if (!el) { el = build(d); els.set(d.id, el); }
      return el;
    }));
  }
  updateHeader();
}

function upsert(d) {
  if (d == null || d.id == null) return;
  const prev = items.get(d.id);
  const next = { ...prev, ...d };
  items.set(d.id, next);
  const el = els.get(d.id);
  if (el && el.isConnected && matches(next)) { fill(el, next); updateHeader(); }
  else renderAll();
}

// ---- boot -----------------------------------------------------------------------------
await boot("dl.title");
$("#title-icon").append(ic("download", 18));
$("#search-icon").append(ic("search", 14));
samo.on("download:updated", upsert);

try {
  const { items: list = [] } = await samo.call("downloads.list");
  for (const d of list) items.set(d.id, d);
} catch (e) { console.error("[downloads] list failed", e); }
renderAll();

const q = $("#q");
q.addEventListener("input", () => { filter = q.value.trim().toLowerCase(); renderAll(); });
q.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && q.value) { q.value = ""; filter = ""; renderAll(); e.stopPropagation(); }
  if (e.key === "ArrowDown") { e.preventDefault(); $(".dl-item")?.focus(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); q.focus(); q.select(); }
});
