// Drive a running Samo (with --remote-debugging-port) through a visual tour and save
// composited screenshots (chrome overlay drawn over the active tab). Dev tool.
//   node scripts/demo.mjs <out-dir> [port=9229]
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [out = "demo", port = "9229"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
  let n = 0;
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++n;
    ws.addEventListener("message", function h(ev) {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", h); res(m.result ?? m.error); }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
  const shot = async (file) => {
    const r = await Promise.race([send("Page.captureScreenshot", { format: "png" }), sleep(4000)]);
    if (r?.data) writeFileSync(file, Buffer.from(r.data, "base64"));
    return !!r?.data;
  };
  return { ws, send, evaluate, shot };
}

const find = async (re) => (await targets()).find((t) => re.test(t.url));
const chrome = await connect(await find(/^samo:\/\/ui\/chrome/));
const call = (cmd, args = {}) => chrome.evaluate(`window.samo.call(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(r => r, e => ({error: String(e)}))`);

async function composite(name, { popup = false } = {}) {
  const st = await call("state.get");
  const active = st.tabs.find((t) => t.id === st.activeId);
  const tabT = (await targets()).find((t) => t.url === active?.url && !t.url.startsWith("samo://ui/"));
  const files = [];
  await chrome.shot(`${out}/${name}-chrome.png`); files.push(`${out}/${name}-chrome.png`);
  if (tabT) { const c = await connect(tabT); await c.shot(`${out}/${name}-page.png`); c.ws.close(); }
  let popRect = null;
  if (popup) {
    const p = await connect(await find(/^samo:\/\/ui\/popup/));
    await p.shot(`${out}/${name}-popup.png`); p.ws.close();
    popRect = await chrome.evaluate(`JSON.stringify(window.__samoLastPopupRect || null)`);
  }
  execFileSync("python3", ["-I", "-c", `
import sys, json
from PIL import Image
out, name, reserve, rect = sys.argv[1], sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4])
ch = Image.open(f"{out}/{name}-chrome.png")
try: pg = Image.open(f"{out}/{name}-page.png")
except Exception: pg = None
W = ch.width; H = reserve + (pg.height if pg else 600)
img = Image.new("RGB", (W, H), (30, 30, 34))
if pg: img.paste(pg, (0, reserve))
img.paste(ch, (0, 0))
if rect:
    po = Image.open(f"{out}/{name}-popup.png"); img.paste(po, (int(rect["x"]), int(rect["y"])))
img.save(f"{out}/{name}.png"); print(f"{out}/{name}.png")
`, out, name, String(st.layout?.reserve ?? 84), popRect || "null"], { stdio: "inherit" });
}

// Remember popup rects so the composite can place the popup surface.
await chrome.evaluate(`(() => { const s = window.samo, o = s.call.bind(s);
  s.call = (c, a) => { if (c === "popup.show") window.__samoLastPopupRect = a.rect; return o(c, a); }; })()`);

// --- tour ---------------------------------------------------------------
const sites = ["https://en.wikipedia.org/wiki/Chromium_(web_browser)", "https://github.com/chromiumembedded/cef", "https://www.rust-lang.org/", "https://news.ycombinator.com/"];
for (const url of sites) await call("tab.new", { url });
await sleep(5000);
const st = await call("state.get");
await call("tab.activate", { id: st.tabs[1].id });
await sleep(1200);
await composite("01-tabs");
await chrome.evaluate(`window.__samoDispatch("command", {action: "open-palette"})`);
await sleep(700);
await composite("02-palette", { popup: true });
await chrome.evaluate(`window.__samoDispatch("command", {action: "escape"})`);
await call("popup.hide");
await call("tab.new", { url: "samo://settings/" });
await sleep(1500);
await composite("03-settings");
await call("config.set", { key: "ui.theme", value: "samo-light" });
await sleep(1200);
await composite("04-settings-light");
await call("tab.activate", { id: st.tabs[2].id });
await sleep(800);
await composite("05-light-github");
await call("config.set", { key: "ui.theme", value: "dusk" });
await call("config.set", { key: "ui.density", value: "compact" });
await sleep(1200);
await composite("06-dusk-compact");
process.exit(0);
