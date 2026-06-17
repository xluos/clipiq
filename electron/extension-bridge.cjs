// Chrome 插件 ↔ Electron 通信桥
//
// 架构: Electron 在 127.0.0.1:58713 起 WS server, 插件 background service worker
// 连过来用浏览器原生 cookie + fetch 调平台 API (B 站 / 抖音), 绕开 wbi 风控.
//
// 握手: 客户端首条 { type:"hello", token, version } → 验 Origin + (token 或 TOFU 配对) → 回 welcome 或 close(1008)
// 请求: server → client { type:"request", id, method, params }, 30s 超时
// 响应: client → server { type:"response", id, ok, data | error }
// 心跳: WS protocol-level ping/pong (ws 包内置, 30s)
//
// 认证模型 (为什么不是裸 localhost 放行):
//   ws://127.0.0.1:58713 任何浏览器网页都连得上 (localhost 不受 mixed-content 限制), 裸放行 = 恶意网页
//   能借这个桥发带你登录 cookie 的请求 (localhost CSRF). 防御分两层:
//   ① Origin 闸门: WS 握手浏览器必带 Origin 头且 JS 无法伪造. 只认 chrome-extension:// → 网页一律连不上.
//   ② TOFU 配对: 记住第一个连上来的扩展 origin, 之后只认它 → 防你装的另一个恶意扩展.
//   token 仍保留作纵深防御 (防本地非浏览器进程伪造 Origin): 首连用 Origin+TOFU 引导, server 在 welcome
//   里把 token 下发给扩展, 扩展存下来后续带 token 连 —— 全程零手动复制.

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const log = require("./logger.cjs");

const PORT = 58713;
const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SERVER_VERSION = 1;

let tokenCachePath = null;
let cachedToken = null;
let pairedOrigin = null; // TOFU: 首个配对的扩展 origin, 之后只认它
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

function persistState() {
  if (!tokenCachePath) return;
  try {
    fs.writeFileSync(
      tokenCachePath,
      JSON.stringify({ token: cachedToken, pairedOrigin, updatedAt: new Date().toISOString() }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (e) {
    log.warn("extension-bridge", "写 token 文件失败:", e?.message || String(e));
  }
}

function loadOrCreateToken(userDataDir) {
  const file = getTokenPath(userDataDir);
  tokenCachePath = file;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && parsed.token.length >= 32) {
      cachedToken = parsed.token;
      pairedOrigin = typeof parsed?.pairedOrigin === "string" ? parsed.pairedOrigin : null;
      return cachedToken;
    }
  } catch {
    /* fall through, regenerate */
  }
  cachedToken = crypto.randomBytes(32).toString("hex");
  pairedOrigin = null;
  persistState();
  return cachedToken;
}

// 重置: 换 token + 清除配对, 下一个连上来的扩展重新 TOFU 配对.
function rotateToken() {
  if (!tokenCachePath) throw new Error("bridge 未初始化");
  cachedToken = crypto.randomBytes(32).toString("hex");
  pairedOrigin = null;
  persistState();
  // 踢掉现有连接, 强制重新握手
  if (activeClient) {
    try { activeClient.close(1000, "token rotated"); } catch { /* noop */ }
  }
  notifyStatus();
  return cachedToken;
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
    pairedOrigin,
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
    const origin = String(req.headers.origin || "");
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

        // 认证: 持有正确 token 一律放行 (手动兜底路径, 不受 Origin 影响);
        // 无 token 则走自动配对, 必须过 Origin 闸门 + TOFU.
        const tokenOk = typeof msg.token === "string" && msg.token === cachedToken;
        const isExtOrigin = origin.startsWith("chrome-extension://");
        if (!tokenOk) {
          // ① Origin 闸门: 只认浏览器扩展, 把所有网页挡在外面 (Origin 头 JS 无法伪造)
          if (!isExtOrigin) {
            log.warn("extension-bridge", `拒绝无 token 的非扩展 origin: ${origin || "(空)"}`);
            try { ws.close(1008, "origin not allowed"); } catch { /* noop */ }
            return;
          }
          // ② TOFU 配对: 已配对则只认同一 origin
          if (pairedOrigin && origin !== pairedOrigin) {
            log.warn("extension-bridge", `拒绝未配对扩展: ${origin} (已配对 ${pairedOrigin})`);
            try { ws.close(1008, "not paired, 在设置里点重新配对"); } catch { /* noop */ }
            return;
          }
        }

        // 记住扩展 origin (首次配对, 或持 token 换绑到新扩展)
        if (isExtOrigin && origin !== pairedOrigin) {
          pairedOrigin = origin;
          persistState();
          log.info("extension-bridge", `已配对扩展 origin=${origin}`);
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
          // welcome 带 token: 首次配对的扩展据此自动存下 token, 之后无需手动复制
          ws.send(JSON.stringify({ type: "welcome", serverVersion: SERVER_VERSION, token: cachedToken }));
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
        log.info("ext-bridge", `${msg.level || "info"}: ${msg.message}`);
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
    const server = httpServer;
    const wsServer = wss;
    let settled = false;
    const onError = (e) => {
      if (settled) return;
      settled = true;
      server.off("listening", onListening);
      server.off("error", onError);
      wsServer.off("error", onError);
      if (wsServer) {
        try { wsServer.close(); } catch { /* noop */ }
        wss = null;
      }
      if (server) {
        try { server.close(); } catch { /* noop */ }
        httpServer = null;
      }
      reject(e);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      wsServer.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    wsServer.once("error", onError);
    server.once("listening", onListening);
    server.listen(PORT, HOST);
  });

  httpServer.on("error", (e) => {
    log.warn("extension-bridge", "服务异常:", e?.message || String(e));
  });
  wss.on("error", (e) => {
    log.warn("extension-bridge", "WS 服务异常:", e?.message || String(e));
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
