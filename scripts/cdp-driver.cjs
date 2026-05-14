#!/usr/bin/env node
// Tiny CDP driver: connects to ws debugger URL, runs Runtime.evaluate, prints JSON result.
// Usage: node cdp-driver.cjs <port> '<js expression returning a JSON-serializable value>'
const WebSocket = require("ws");

async function main() {
  const port = process.argv[2] || "9223";
  const expr = process.argv[3];
  if (!expr) {
    console.error("usage: cdp-driver.cjs <port> '<expression>'");
    process.exit(2);
  }
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await res.json();
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
      const handler = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) handler.reject(new Error(msg.error.message));
      else handler.resolve(msg.result);
    }
  });
  await send("Runtime.enable");
  const wrapped = `(async () => { return (${expr}); })()`;
  const result = await send("Runtime.evaluate", {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (result.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result.result.value, null, 2));
  ws.close();
}
main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
