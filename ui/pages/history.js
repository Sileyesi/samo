// samo://history — grouped by day, search, delete entry, clear all.
import { samo, boot, t, locale, $, $$, h, ic, debounce, favicon, hostOf, toMs, confirmDialog, toast } from "./page.js";

const PAGE = 150;
let items = [];
let query = "";
let offset = 0;
let done = false;
let loading = false;
let gen = 0;

const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" });
const dayFmtYear = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (dayKey(ms) === dayKey(today.getTime())) return t("history.today");
  if (dayKey(ms) === dayKey(yest.getTime())) return t("history.yesterday");
  return (d.getFullYear() === today.getFullYear() ? dayFmt : dayFmtYear).format(d);
}

function open(url, newTab) { samo.call("nav.go", { input: url, newTab: !!newTab }).catch(console.error); }

async function remove(entry, rowEl) {
  const next = rowEl.nextElementSibling || rowEl.previousElementSibling;
  rowEl.classList.add("is-removing");
  try {
    await samo.call("history.delete", { url: entry.url });
    items = items.filter((i) => i !== entry);
    setTimeout(() => {
      const card = rowEl.parentElement;
      rowEl.remove();
      if (card && !card.children.length) card.closest(".li-day")?.remove();
      else updateDayCounts();
      if (next?.isConnected) next.focus();
      updateCount();
      if (!items.length) render();
    }, 130);
  } catch (e) {
    rowEl.classList.remove("is-removing");
    toast(t("common.error"), "error");
  }
}

function rowFor(entry) {
  const ms = toMs(entry.lastVisit);
  const host = hostOf(entry.url);
  const del = h("button", { class: "samo-btn", tabindex: "-1", title: t("history.remove"), "aria-label": t("history.remove") }, ic("x", 14));
  const row = h("a", { class: "li-row", href: entry.url, title: `${entry.title || entry.url}\n${entry.url}${entry.visits ? "\n" + t("history.visits", { n: entry.visits }) : ""}` },
    h("span", { class: "li-row__time" }, ms ? timeFmt.format(ms) : ""),
    favicon(entry.url, { size: 16 }),
    h("span", { class: "li-row__title" }, entry.title || entry.url),
    h("span", { class: "li-row__host" }, host),
    del);
  row.addEventListener("click", (e) => {
    e.preventDefault();
    if (e.target.closest(".samo-btn")) return;
    open(entry.url, e.ctrlKey || e.metaKey || e.shiftKey);
  });
  row.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); open(entry.url, true); } });
  del.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); remove(entry, row); });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || (e.key === "Backspace" && !e.ctrlKey)) { e.preventDefault(); remove(entry, row); }
  });
  return row;
}

function updateCount() {
  $("#count").textContent = items.length ? String(items.length) + (done ? "" : "+") : "";
}
function updateDayCounts() {
  for (const day of $$(".li-day")) day.querySelector(".li-day__count").textContent = String(day.querySelector(".li-card").children.length);
}

function render() {
  const list = $("#list");
  updateCount();
  if (!items.length && done) {
    list.replaceChildren(h("div", { class: "page-empty" },
      h("div", { class: "page-empty__icon" }, ic(query ? "search" : "history", 24)),
      h("div", { class: "page-empty__title" }, query ? t("history.noMatch", { q: query }) : t("history.empty")),
      query ? null : h("div", null, t("history.emptyHint"))));
    $("#clear").hidden = !query ? true : $("#clear").hidden;
    return;
  }
  $("#clear").hidden = false;
  const groups = new Map();
  for (const it of items) {
    const ms = toMs(it.lastVisit);
    const k = dayKey(ms);
    if (!groups.has(k)) groups.set(k, { ms, rows: [] });
    groups.get(k).rows.push(it);
  }
  list.replaceChildren(...[...groups.values()].map((g) =>
    h("section", { class: "li-day" },
      h("h2", { class: "li-day__title" }, dayLabel(g.ms), h("span", { class: "li-day__count" }, String(g.rows.length))),
      h("div", { class: "page-card li-card" }, g.rows.map(rowFor)))));
  if (!done) list.append(h("div", { class: "li-more" }, ic("loader", 18)));
}

async function load(reset) {
  if (reset) { offset = 0; done = false; items = []; gen++; }
  if (loading && !reset) return;
  if (done) return;
  loading = true;
  const my = gen;
  try {
    const res = await samo.call("history.list", { query: query || undefined, limit: PAGE, offset });
    if (my !== gen) return;
    const batch = res.items || [];
    items = items.concat(batch);
    offset += batch.length;
    done = batch.length < PAGE;
  } catch (e) {
    console.error("[history] list failed", e);
    done = true;
  } finally {
    if (my === gen) loading = false;
  }
  if (my !== gen) return;
  const hadFocus = document.activeElement?.closest?.(".li-row")?.getAttribute("href");
  render();
  if (hadFocus) $$(".li-row").find((r) => r.getAttribute("href") === hadFocus)?.focus();
}

// ---- boot ---------------------------------------------------------------------------
await boot("history.title");
$("#title-icon").append(ic("history", 18));
$("#search-icon").append(ic("search", 14));
const clearBtn = $("#clear");
clearBtn.append(ic("trash", 14), t("history.clear"));
clearBtn.addEventListener("click", async () => {
  const ok = await confirmDialog({ title: t("history.confirmTitle"), body: t("history.confirmBody"), ok: t("history.confirmOk"), danger: true });
  if (!ok) return;
  try { await samo.call("history.clear"); query = ""; $("#q").value = ""; await load(true); } catch { toast(t("common.error"), "error"); }
});

const q = $("#q");
q.addEventListener("input", debounce(() => { query = q.value.trim(); load(true); }, 150));
q.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && q.value) { q.value = ""; query = ""; load(true); e.stopPropagation(); }
  if (e.key === "ArrowDown") { e.preventDefault(); $(".li-row")?.focus(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); q.focus(); q.select(); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = $$(".li-row:not(.is-removing)");
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  if (e.key === "ArrowUp" && i === 0) { q.focus(); return; }
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
});

new IntersectionObserver((entries) => {
  if (entries.some((en) => en.isIntersecting) && !loading && !done) load(false);
}, { rootMargin: "600px" }).observe($("#sentinel"));

await load(true);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });
