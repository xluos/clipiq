// Chrome 插件 ↔ Electron 通信桥
//
// 架构: Electron 在 127.0.0.1:58713 起 WS server, 插件 background service worker
// 连过来用浏览器原生 cookie + fetch 调平台 API (B 站 / 抖音), 绕开 wbi 风控.
//
// 握手: 客户端首条 { type:"hello", token, version } → 验 token → 回 welcome 或 close(1008)
// 请求: server → client { type:"request", id, method, params }, 30s 超时
// 响应: client → server { type:"response", id, ok, data | error }
// 心跳: WS protocol-level ping/pong (ws 包内置, 30s)

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const PORT = 58713;
const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SERVER_VERSION = 1;

let tokenCachePath = null;
let cachedToken = null;
let wss = null;
let httpServer = null;
let activeClient = null; // 同一时刻只接受一个插件连接 (后连的踢前一个)
let activeClientMeta = null;
let nextRequestId = 1;
const pendingRequests = new Map(); // id → { resolve, reject, timer }
const listeners = new Set(); // status change listener (renderer 订阅)

function getTokenPath(userDataDir) {
  return path.join(userDataDir, "extension-bridge.json");
}

function loadOrCreateToken(userDataDir) {
  const file = getTokenPath(userDataDir);
  tokenCachePath = file;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && parsed.token.length >= 32) {
      cachedToken = parsed.token;
      return cachedToken;
    }
  } catch {
    /* fall through, regenerate */
  }
  const token = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (e) {
    console.warn("[extension-bridge] 写 token 文件失败:", e?.message || String(e));
  }
  cachedToken = token;
  return token;
}

function rotateToken() {
  if (!tokenCachePath) throw new Error("bridge 未初始化");
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenCachePath, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  cachedToken = token;
  // 踢掉现有连接, 强制重新握手
  if (activeClient) {
    try { activeClient.close(1000, "token rotated"); } catch { /* noop */ }
  }
  notifyStatus();
  return token;
}

function notifyStatus() {
  const s = getStatus();
  for (const fn of listeners) {
    try { fn(s); } catch { /* noop */ }
  }
}

function onStatusChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getStatus() {
  return {
    port: PORT,
    host: HOST,
    token: cachedToken,
    connected: Boolean(activeClient),
    clientVersion: activeClientMeta?.version ?? null,
    clientUserAgent: activeClientMeta?.userAgent ?? null,
    connectedAt: activeClientMeta?.connectedAt ?? null,
  };
}

async function start(userDataDir) {
  if (wss) return getStatus();
  loadOrCreateToken(userDataDir);

  httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: SERVER_VERSION }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  wss = new WebSocketServer({ server: httpServer, path: "/agent" });

  wss.on("connection", (ws, req) => {
    let helloTimer = setTimeout(() => {
      try { ws.close(1008, "hello timeout"); } catch { /* noop */ }
    }, 5_000);

    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch {
        try { ws.close(1003, "invalid json"); } catch { /* noop */ }
        return;
      }

      // 第一条必须是 hello
      if (activeClient !== ws) {
        if (msg.type !== "hello") {
          try { ws.close(1008, "expect hello first"); } catch { /* noop */ }
          return;
        }
        if (typeof msg.token !== "string" || msg.token !== cachedToken) {
          try { ws.close(1008, "invalid token"); } catch { /* noop */ }
          return;
        }
        clearTimeout(helloTimer);
        helloTimer = null;

        // 踢前一个连接 (同一时刻只允许一个插件)
        if (activeClient && activeClient !== ws) {
          try { activeClient.close(1000, "superseded"); } catch { /* noop */ }
        }
        activeClient = ws;
        activeClientMeta = {
          version: Number(msg.version) || 0,
          userAgent: req.headers["user-agent"] || null,
          connectedAt: new Date().toISOString(),
        };
        try {
          ws.send(JSON.stringify({ type: "welcome", serverVersion: SERVER_VERSION }));
        } catch { /* noop */ }
        notifyStatus();
        return;
      }

      // 已认证后只接受 response (插件不主动发别的)
      if (msg.type === "response") {
        const pending = pendingRequests.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(String(msg.error || "插件返回错误")));
      } else if (msg.type === "log") {
        // 插件可选地推日志, 仅打到 main 进程 console
        console.log(`[ext-bridge] ${msg.level || "info"}: ${msg.message}`);
      }
    };

    ws.on("message", onMessage);
    ws.on("close", () => {
      if (helloTimer) clearTimeout(helloTimer);
      if (activeClient === ws) {
        activeClient = null;
        activeClientMeta = null;
        // 把当前所有挂着的请求 reject
        for (const [id, pending] of pendingRequests.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("浏览器插件已断开"));
          pendingRequests.delete(id);
        }
        notifyStatus();
      }
    });
    ws.on("error", () => { /* close 事件会兜底, 这里忽略 */ });
  });

  // WS 心跳: ws 包的 ping/pong
  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.ping(); } catch { /* noop */ }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  await new Promise((resolve, reject) => {
    const onError = (e) => {
      httpServer.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(PORT, HOST);
  });

  return getStatus();
}

async function stop() {
  if (wss) {
    for (const ws of wss.clients) {
      try { ws.close(1001, "server stopping"); } catch { /* noop */ }
    }
    wss.close();
    wss = null;
  }
  if (httpServer) {
    await new Promise((r) => httpServer.close(() => r()));
    httpServer = null;
  }
  activeClient = null;
  activeClientMeta = null;
  for (const [id, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("bridge 已停止"));
    pendingRequests.delete(id);
  }
}

function isConnected() {
  return Boolean(activeClient && activeClient.readyState === activeClient.OPEN);
}

// 向插件下发请求, 返 Promise<data>
function request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!isConnected()) {
    return Promise.reject(new Error("浏览器插件未连接, 请确认插件已加载并填入 token"));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`插件请求超时 (${method}, ${timeoutMs}ms)`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
    try {
      activeClient.send(JSON.stringify({ type: "request", id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(e);
    }
  });
}

module.exports = {
  start,
  stop,
  request,
  isConnected,
  getStatus,
  onStatusChange,
  rotateToken,
};
