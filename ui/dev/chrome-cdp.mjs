// Dev only: evaluate JS in a running Samo UI target via CDP.
// usage: node ui/dev/chrome-cdp.mjs <chrome|popup> "<expression>" [port=9229]
const [which = "chrome", expr = "1", port = "9229"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = targets.find((x) => x.type === "page" && x.url.startsWith(`samo://ui/${which}`));
if (!t) { console.log("no target", targets.map((x) => x.url)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let n = 0;
const send = (method, params = {}) => new Promise((res) => {
  const id = ++n;
  ws.addEventListener("message", function h(ev) {
    const m = JSON.parse(ev.data);
    if (m.id === id) { ws.removeEventListener("message", h); res(m.result || m.error); }
  });
  ws.send(JSON.stringify({ id, method, params }));
});
// "@[[method, params, delayMs], ...]" runs raw CDP calls (e.g. Input.dispatchMouseEvent) in order.
if (expr.startsWith("@")) {
  for (const [m, p, d] of JSON.parse(expr.slice(1))) {
    const res = await send(m, p || {});
    if (m === "Page.captureScreenshot" && res?.data) (await import("node:fs")).writeFileSync(p.path, Buffer.from(res.data, "base64"));
    if (d) await new Promise((r) => setTimeout(r, d));
  }
  process.exit(0);
}
const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r, null, 1));
process.exit(0);
