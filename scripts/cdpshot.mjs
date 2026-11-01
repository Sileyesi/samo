// Capture every Samo page target (chrome overlay, popup, tabs) via DevTools protocol.
// Works even when the window is on a hidden workspace. Usage:
//   node scripts/cdpshot.mjs <out-prefix> [port=9229]
const [prefix = "samo", port = "9229"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const fs = await import("node:fs");
let n = 0;
for (const t of targets.filter((t) => t.type === "page")) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++n;
    ws.addEventListener("message", function h(ev) {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", h); res(m.result || m.error); }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const name = (t.url.match(/^samo:\/\/ui\/(\w+)/)?.[1]) || `tab${n}`;
  const shot = await Promise.race([send("Page.captureScreenshot", { format: "png" }),
    new Promise((r) => setTimeout(() => r(null), 4000))]);
  if (shot?.data) {
    const file = `${prefix}-${name}.png`;
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(file, t.url.slice(0, 80));
  } else console.log("no frame:", t.url.slice(0, 80), JSON.stringify(shot)?.slice(0, 120));
  ws.close();
}
process.exit(0);
