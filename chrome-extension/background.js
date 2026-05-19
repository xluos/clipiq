// ClipIQ Bridge background service worker
//
// 连接 Electron 桌面端 (ws://127.0.0.1:58713/agent), 用浏览器登录态 + 真实 buvid 指纹替桌面端代发 HTTPS 请求.
// 设计是通用 fetch 代理 (method: "fetch"), 业务逻辑 (wbi 签名 / URL 拼接) 全留在 main.cjs,
// 这样新增平台 (抖音 / 小红书) 不用改插件代码.
//
// 协议见 electron/extension-bridge.cjs.

const ENDPOINT = "ws://127.0.0.1:58713/agent";
const CLIENT_VERSION = 1;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const KEEPALIVE_ALARM = "clipiq-bridge-keepalive";

let ws = null;
let connecting = false;
let reconnectDelay = RECONNECT_BASE_MS;
let lastStatus = { connected: false, error: null, since: null };

async function getToken() {
  const { token } = await chrome.storage.local.get("token");
  return token || "";
}

async function setToken(token) {
  await chrome.storage.local.set({ token: String(token || "").trim() });
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  chrome.runtime.sendMessage({ type: "bridge-status", status: lastStatus }).catch(() => { /* popup 没开 */ });
}

async function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  const token = await getToken();
  if (!token) {
    setStatus({ connected: false, error: "未配置 token, 在 popup 里粘贴桌面端给的 token", since: Date.now() });
    return;
  }
  connecting = true;
  setStatus({ connected: false, error: null, since: Date.now() });

  try {
    ws = new WebSocket(ENDPOINT);
  } catch (e) {
    connecting = false;
    setStatus({ connected: false, error: `创建 WS 失败: ${e?.message || String(e)}` });
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    try {
      ws.send(JSON.stringify({ type: "hello", token, version: CLIENT_VERSION }));
    } catch (e) {
      setStatus({ connected: false, error: `握手失败: ${e?.message || String(e)}` });
    }
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "welcome") {
      connecting = false;
      reconnectDelay = RECONNECT_BASE_MS;
      setStatus({ connected: true, error: null, since: Date.now() });
      return;
    }

    if (msg.type === "request") {
      const { id, method, params } = msg;
      try {
        const data = await handleRequest(method, params || {});
        ws.send(JSON.stringify({ type: "response", id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "response", id, ok: false, error: e?.message || String(e) }));
      }
    }
  });

  ws.addEventListener("close", (event) => {
    connecting = false;
    const wasInvalidToken = event.code === 1008;
    setStatus({
      connected: false,
      error: wasInvalidToken
        ? `token 校验失败 (${event.reason || "invalid token"}), 检查 popup 里 token 是否和桌面端一致`
        : event.reason
          ? `连接关闭: ${event.reason} (${event.code})`
          : `连接关闭 (${event.code})`,
    });
    if (!wasInvalidToken) scheduleReconnect();
  });

  ws.addEventListener("error", () => { /* close 兜底 */ });
}

function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setTimeout(() => {
    connect().catch((e) => console.warn("[clipiq-bridge] reconnect failed:", e));
  }, delay);
}

async function handleRequest(method, params) {
  switch (method) {
    case "ping":
      return { pong: true, at: Date.now() };
    case "fetch":
      return await proxyFetch(params);
    case "douyin.userPosts":
      return await fetchDouyinUserPostsViaTab(params);
    default:
      throw new Error(`未实现的 method: ${method}`);
  }
}

// 通用 fetch 代理 — main.cjs 把签好名的 URL/headers 传进来, 这里只负责借浏览器 cookie 发请求.
//
// 入参: { url, method?, headers?, body?, parse?: "json" | "text" }
// 出参: { status, ok, body }
async function proxyFetch({ url, method = "GET", headers = {}, body = null, parse = "json", timeoutMs = 20_000 }) {
  if (!url || typeof url !== "string") throw new Error("fetch: 缺少 url");
  if (!/^https?:\/\//i.test(url)) throw new Error("fetch: 仅允许 http(s)");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: headers && typeof headers === "object" ? headers : {},
      body: body ?? undefined,
      credentials: "include", // 关键: 带浏览器 cookie (SESSDATA, buvid3, b_nut, ...)
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed;
    if (parse === "json") {
      try { parsed = JSON.parse(text); }
      catch { parsed = { __parseError: true, raw: text.slice(0, 500) }; }
    } else {
      parsed = text;
    }
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 抖音: 借 douyin.com tab 上下文调 fetch ────────────────────────
//
// 抖音 web 的 fetch / XHR 被 webmssdk hook, 自动算 a_bogus 并附到 URL. 在 service worker 里
// 直接 fetch 没有这一层 → 必须在 douyin.com 这个 origin 的 page world 里调 fetch.
//
// 策略 (用户确认):
//   1) 找已开的 douyin.com tab, 有就复用
//   2) 没就 chrome.tabs.create({active:false}) 静默开, 用完关掉
//
// 实际执行: chrome.scripting.executeScript world:"MAIN" 在 page world 执行 fetch.
async function fetchDouyinUserPostsViaTab({ secUid, count = 18, maxCursor = 0 }) {
  if (!secUid) throw new Error("缺少 sec_uid");
  const safeCount = Math.max(1, Math.min(40, Number(count) || 18));

  // 1) 找现有 douyin.com tab
  const existing = await chrome.tabs.query({ url: "*://*.douyin.com/*" });
  let tabId = null;
  let createdTab = false;
  if (existing && existing.length > 0) {
    // 优先选 active 的, 否则选第一个
    tabId = (existing.find((t) => t.active) || existing[0]).id;
  } else {
    // 2) 静默开 tab
    const created = await chrome.tabs.create({
      url: `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
      active: false,
    });
    tabId = created.id;
    createdTab = true;
    // 等加载完 (webmssdk 必须执行完才能 hook fetch)
    await waitForTabComplete(tabId, 15_000);
    // 额外 1s 让 webmssdk 完成 hook (实测脚本注入有时滞后于 onComplete)
    await new Promise((r) => setTimeout(r, 1_000));
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [{ secUid, count: safeCount, maxCursor }],
      func: async ({ secUid, count, maxCursor }) => {
        // 这段在 douyin.com page world 跑, fetch 会被 webmssdk hook 自动加 a_bogus
        const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/post/");
        url.searchParams.set("sec_user_id", secUid);
        url.searchParams.set("count", String(count));
        url.searchParams.set("max_cursor", String(maxCursor));
        url.searchParams.set("device_platform", "webapp");
        url.searchParams.set("aid", "6383");
        url.searchParams.set("channel", "channel_pc_web");
        url.searchParams.set("pc_client_type", "1");
        url.searchParams.set("version_code", "190500");
        url.searchParams.set("version_name", "19.5.0");
        url.searchParams.set("cookie_enabled", "true");
        url.searchParams.set("platform", "PC");
        try {
          const res = await fetch(url.toString(), {
            method: "GET",
            credentials: "include",
            headers: { "Referer": "https://www.douyin.com/" },
          });
          const text = await res.text();
          let json;
          try { json = JSON.parse(text); } catch { json = { __parseError: true, raw: text.slice(0, 300) }; }
          return { ok: res.ok, status: res.status, body: json };
        } catch (e) {
          return { ok: false, status: 0, body: { __error: String(e?.message || e) } };
        }
      },
    });
    if (!result) throw new Error("executeScript 返回为空");
    return result;
  } finally {
    // 自己开的 tab 用完关掉
    if (createdTab && tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch { /* noop */ }
    }
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`tab ${tabId} 加载超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    const listener = (changedId, info) => {
      if (changedId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 兜底: 如果 tab 已经是 complete, 上面的事件不会再触发
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => { /* tab 可能已关 */ });
  });
}

// ─── 启动 + keep-alive ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "get-status") {
    sendResponse(lastStatus);
    return false;
  }
  if (msg?.type === "set-token") {
    setToken(msg.token).then(() => {
      reconnectDelay = RECONNECT_BASE_MS;
      try { ws?.close(); } catch { /* noop */ }
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === "reconnect") {
    reconnectDelay = RECONNECT_BASE_MS;
    try { ws?.close(); } catch { /* noop */ }
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// service worker 加载即触发一次
connect();
