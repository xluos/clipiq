#!/usr/bin/env node
const WebSocket = require("ws");
const fs = require("fs");

async function main() {
  const port = process.argv[2] || "9223";
  const outPath = process.argv[3] || "/tmp/electron.png";
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await res.json();
  // Pick the real renderer (not DevTools): prefer page targets whose URL is not a devtools:// scheme.
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://")) || targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(method, params = {}) {
    id += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await new Promise((resolve) => ws.once("open", resolve));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const h = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) h.reject(new Error(msg.error.message));
      else h.resolve(msg.result);
    }
  });
  const result = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(outPath, Buffer.from(result.data, "base64"));
  console.log("saved", outPath, fs.statSync(outPath).size, "bytes");
  ws.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
