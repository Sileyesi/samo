// samo://newtab — clock, greeting, search, top sites.
import { samo, boot, t, locale, engineName, $, h, ic, favicon, hostOf, toMs } from "./page.js";

const HIDDEN_KEY = "samo.newtab.hidden";
const MAX_TILES = 8;

let config = null;

// ---- Clock --------------------------------------------------------------------
const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" });

function greetingKey(hour) {
  if (hour >= 5 && hour < 12) return "newtab.greet.morning";
  if (hour >= 12 && hour < 17) return "newtab.greet.day";
  if (hour >= 17 && hour < 23) return "newtab.greet.evening";
  return "newtab.greet.night";
}

function tick() {
  const now = new Date();
  const clock = $("#clock");
  const parts = timeFmt.formatToParts(now);
  const main = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
  const period = parts.find((p) => p.type === "dayPeriod");
  clock.replaceChildren(main, ...(period ? [h("span", { class: "nt-ampm" }, period.value)] : []));
  clock.dateTime = now.toISOString();
  $("#greet").textContent = t(greetingKey(now.getHours()));
  $("#date").textContent = dateFmt.format(now);
  setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 20);
}

// ---- Search ---------------------------------------------------------------------
const looksLikeUrl = (s) => /^[a-z][\w+.-]*:\/\//i.test(s) || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(s);


function updateHint() {
  const v = $("#q").value.trim();
  $("#search").classList.toggle("has-value", !!v);
  $("#hint-text").textContent = looksLikeUrl(v) ? t("newtab.go") : t("newtab.searchWith", { engine: engineName(config?.general?.search_engine || "duckduckgo") });
}

function setupSearch() {
  $("#search-icon").append(ic("search", 18));
  const q = $("#q");
  q.addEventListener("input", updateHint);
  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = q.value.trim();
    if (input) samo.call("nav.go", { input }).catch(console.error);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && q.value) { q.value = ""; updateHint(); e.stopPropagation(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); $(".nt-tile")?.focus(); }
    else if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      const input = q.value.trim();
      if (input) samo.call("nav.go", { input, newTab: true }).catch(console.error);
    }
  });
  // Type anywhere → search box
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement === q) return;
    if (e.key === "/" ) { e.preventDefault(); q.focus(); q.select(); return; }
    if (e.key.length === 1 && !/\s/.test(e.key) && !(document.activeElement instanceof HTMLInputElement)) q.focus();
  });
  q.focus();
}

// ---- Top sites --------------------------------------------------------------------
function hiddenHosts() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")); } catch { return new Set(); }
}
function hideHost(host) {
  const s = hiddenHosts(); s.add(host);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s])); } catch {}
}

function topSites(items) {
  const hidden = hiddenHosts();
  const now = Date.now();
  const byHost = new Map();
  for (const it of items) {
    if (!/^https?:/.test(it.url)) continue;
    const host = hostOf(it.url);
    if (!host || hidden.has(host)) continue;
    const ageDays = Math.max(0, (now - toMs(it.lastVisit)) / 864e5);
    // frecency-ish: visits weighted by recency (half-life ~2 weeks)
    const score = (it.visits || 1) * Math.pow(0.5, ageDays / 14);
    const e = byHost.get(host) || { host, score: 0, best: it, bestVisits: -1 };
    e.score += score;
    if ((it.visits || 0) > e.bestVisits) { e.best = it; e.bestVisits = it.visits || 0; }
    byHost.set(host, e);
  }
  return [...byHost.values()].sort((a, b) => b.score - a.score).slice(0, MAX_TILES).map((e) => {
    let url;
    try { url = new URL(e.best.url).origin + "/"; } catch { url = e.best.url; }
    return { host: e.host, url, title: e.best.title || e.host };
  });
}

function open(url, newTab) {
  samo.call("nav.go", { input: url, newTab: !!newTab }).catch(console.error);
}

function renderSites(sites) {
  const grid = $("#grid");
  grid.replaceChildren(...sites.map((s, i) => {
    const tile = h("a", { class: "nt-tile", href: s.url, role: "listitem", title: `${s.title}\n${s.url}`, style: { "--i": i } },
      h("span", { class: "nt-tile__icon" }, favicon(s.url, { size: 28 })),
      h("span", { class: "nt-tile__label" }, s.host),
      h("button", {
        class: "samo-btn nt-tile__remove", type: "button", tabindex: "-1",
        title: t("newtab.removeTile"), "aria-label": t("newtab.removeTile"),
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          hideHost(s.host);
          tile.classList.add("is-removing");
          setTimeout(loadSites, 160);
        },
      }, ic("x", 12)),
    );
    tile.addEventListener("click", (e) => { e.preventDefault(); open(s.url, e.ctrlKey || e.metaKey || e.shiftKey); });
    tile.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); open(s.url, true); } });
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Delete") { e.preventDefault(); tile.querySelector(".nt-tile__remove").click(); }
      if (e.key === "ArrowUp" && [...grid.children].indexOf(tile) < columns()) { e.preventDefault(); e.stopPropagation(); $("#q").focus(); }
    });
    return tile;
  }));
  $("#sites-empty").hidden = sites.length > 0;
}

function columns() {
  const grid = $("#grid");
  return getComputedStyle(grid).gridTemplateColumns.split(" ").length || 4;
}

async function loadSites() {
  try {
    const { items = [] } = await samo.call("history.list", { limit: 400 });
    renderSites(topSites(items));
  } catch (e) {
    console.error("[newtab] history.list failed", e);
    renderSites([]);
  }
}

// ---- Boot -----------------------------------------------------------------------------
tick();
const res = await boot("newtab.title");
config = res.config;
samo.on("config:changed", (p) => { config = p.config; updateHint(); });
setupSearch();
updateHint();

$("#btn-history").append(ic("history", 16));
$("#btn-settings").append(ic("settings", 16));
$("#btn-history").addEventListener("click", () => open("samo://history/"));
$("#btn-settings").addEventListener("click", () => open("samo://settings/"));

// Arrow navigation over the grid (column count follows the responsive layout)
$("#grid").addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const tiles = [...$("#grid").children];
  const i = tiles.indexOf(document.activeElement);
  if (i < 0) return;
  const c = columns();
  const j = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - c, ArrowDown: i + c }[e.key];
  if (j >= 0 && j < tiles.length) { e.preventDefault(); tiles[j].focus(); }
});

await loadSites();
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadSites(); });
