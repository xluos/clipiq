// ai-model-daemon IPC 客户端。
// 通过 Unix socket 与 daemon 通信,管理模型下载生命周期。
// daemon 未运行时自动拉起。

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const log = require("./logger.cjs");
const sidecarUtils = require("./sidecar-utils.cjs");

const DEFAULT_HTTP_PORT = 19190;
const CLIENT_NAME = "clipiq";

function daemonStorageDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AIModels");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AIModels");
  }
  return path.join(os.homedir(), ".local", "share", "AIModels");
}

function socketPath() {
  return path.join(daemonStorageDir(), ".daemon.sock");
}

function pidPath() {
  return path.join(daemonStorageDir(), ".daemon.pid");
}

function tokenPath() {
  return path.join(daemonStorageDir(), ".daemon.token");
}

let cachedToken = null;

function readToken() {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = fsSync.readFileSync(tokenPath(), "utf8").trim();
    return cachedToken;
  } catch {
    return null;
  }
}

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = readToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: socketPath(),
      path: urlPath,
      method,
      headers: authHeaders(),
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function isDaemonRunning() {
  try {
    const res = await request("GET", "/status");
    if (res.status === 401) {
      // daemon 在跑但 token 对不上,重新从文件读
      cachedToken = null;
      const res2 = await request("GET", "/status");
      return res2.status === 200 && res2.data?.ready === true;
    }
    return res.status === 200 && res.data?.ready === true;
  } catch {
    return false;
  }
}

async function findDaemonBinary() {
  // 1. Electron 打包内置
  if (process.resourcesPath) {
    const exe = process.platform === "win32" ? "ai-model-daemon.exe" : "ai-model-daemon";
    const bundled = path.join(process.resourcesPath, "daemon", exe);
    if (fsSync.existsSync(bundled)) return bundled;
  }

  // 2. 环境变量
  const envPath = process.env.AI_MODEL_DAEMON_PATH;
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  // 3. dev 模式: build 产物 / daemon 源码目录
  const exe = process.platform === "win32" ? "ai-model-daemon.exe" : "ai-model-daemon";
  const osKey = { darwin: "mac", linux: "linux", win32: "win" }[process.platform] || "mac";
  const archKey = process.arch === "arm64" ? "arm64" : "x64";
  const repoRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(repoRoot, "build", "daemon", `${osKey}-${archKey}`, exe),
    path.resolve(repoRoot, "..", "ai-model-daemon", exe),
    path.join(os.homedir(), ".local", "bin", exe),
    path.join(os.homedir(), "go", "bin", exe),
    `/usr/local/bin/${exe}`,
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }

  // 4. PATH
  return new Promise((resolve) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, ["ai-model-daemon"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.on("close", () => {
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
    child.on("error", () => resolve(null));
  });
}

let daemonProcess = null;
let registeredClientId = null;

function clientId() {
  return `${CLIENT_NAME}-${process.pid}`;
}

function httpPort() {
  const env = process.env.AI_DAEMON_HTTP_PORT;
  if (env && Number.isFinite(Number(env))) return Number(env);
  return DEFAULT_HTTP_PORT;
}

function registerClientSync() {
  try {
    const body = JSON.stringify({ id: clientId(), name: CLIENT_NAME, pid: process.pid });
    const req = http.request({
      socketPath: socketPath(),
      path: "/api/clients/register",
      method: "POST",
      headers: { ...authHeaders(), "Content-Length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    req.write(body);
    req.end();
    registeredClientId = clientId();
  } catch { /* best effort */ }
}

async function registerClient() {
  if (registeredClientId === clientId()) return;
  try {
    await request("POST", "/api/clients/register", { id: clientId(), name: CLIENT_NAME, pid: process.pid });
    registeredClientId = clientId();
    log.info("daemon-client", `registered as client ${clientId()}`);
  } catch (err) {
    log.warn("daemon-client", `register failed: ${err.message}`);
  }
}

function deregisterClientSync() {
  if (!registeredClientId) return;
  try {
    const body = JSON.stringify({ id: registeredClientId });
    const req = http.request({
      socketPath: socketPath(),
      path: "/api/clients/deregister",
      method: "POST",
      headers: { ...authHeaders(), "Content-Length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch { /* best effort */ }
  registeredClientId = null;
}

function shutdownSync() {
  deregisterClientSync();
  daemonProcess = null;
}

async function ensureDaemon() {
  if (await isDaemonRunning()) {
    await registerClient();
    return;
  }

  const binary = await findDaemonBinary();
  if (!binary) {
    throw new Error(
      "ai-model-daemon 未找到。请构建并安装: cd ../ai-model-daemon && go build -o ~/.local/bin/ai-model-daemon .",
    );
  }

  await fs.mkdir(daemonStorageDir(), { recursive: true });

  const port = httpPort();
  const child = spawn(binary, ["serve", "--http", `:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  await new Promise((resolve, reject) => {
    let stdout = "";
    const onData = (chunk) => {
      stdout += chunk.toString();
      try {
        const ready = JSON.parse(stdout.trim());
        if (ready.socket || ready.pid) {
          if (ready.token) cachedToken = ready.token;
          child.stdout.removeListener("data", onData);
          resolve(ready);
        }
      } catch { /* not complete yet */ }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    const timer = setTimeout(() => reject(new Error("daemon 启动超时 (10s)")), 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon 退出 code=${code}`));
    });
  });

  child.unref();
  daemonProcess = child;
  log.info("daemon-client", `daemon started pid=${child.pid}, http=:${port}`);

  await registerClient();
}

async function getStatus() {
  await ensureDaemon();
  const res = await request("GET", "/status");
  return res.data;
}

async function listModels(appFilter) {
  await ensureDaemon();
  const urlPath = appFilter ? `/models?app=${encodeURIComponent(appFilter)}` : "/models";
  const res = await request("GET", urlPath);
  return res.data;
}

async function getModelStatus(modelId) {
  await ensureDaemon();
  const res = await request("GET", `/models/${encodeURIComponent(modelId)}`);
  if (res.status === 404) return null;
  return res.data;
}

async function getModelPaths(modelId) {
  await ensureDaemon();
  const res = await request("GET", `/models/${encodeURIComponent(modelId)}/path`);
  if (res.status === 404) return null;
  return res.data?.paths || null;
}

async function cancelDownload(modelId) {
  await ensureDaemon();
  const res = await request("POST", `/models/${encodeURIComponent(modelId)}/cancel-download`);
  return res.data;
}

async function deleteModel(modelId) {
  await ensureDaemon();
  const res = await request("DELETE", `/models/${encodeURIComponent(modelId)}`);
  return res.data;
}

async function setMirrorPreference(mirror) {
  await ensureDaemon();
  const res = await request("POST", "/config", { preferMirror: mirror });
  return res.data;
}

async function getHardware() {
  await ensureDaemon();
  const res = await request("GET", "/hardware");
  return res.data;
}

async function getRecommendedModels(appFilter, ctxOverrides = {}) {
  await ensureDaemon();
  const params = [];
  if (appFilter) params.push(`app=${encodeURIComponent(appFilter)}`);
  for (const [key, val] of Object.entries(ctxOverrides)) {
    if (Number(val) > 0) params.push(`ctx.${encodeURIComponent(key)}=${val}`);
  }
  const qs = params.length ? `?${params.join("&")}` : "";
  const res = await request("GET", `/models/recommended${qs}`);
  return res.data;
}

async function recomputeFit(modelId, contextSize) {
  await ensureDaemon();
  const res = await request("POST", `/models/${encodeURIComponent(modelId)}/recompute-fit`, { contextSize });
  return res.data;
}

// SSE 下载,解析 event stream 回调 onProgress / onSkip / onDone。
// 返回 Promise<{ok, error?}>
function downloadModel(modelId, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDaemon();
    } catch (err) {
      return reject(err);
    }

    const opts = {
      socketPath: socketPath(),
      path: `/models/${encodeURIComponent(modelId)}/download?progressInterval=3000`,
      method: "POST",
      headers: { ...authHeaders(), "Accept": "text/event-stream" },
    };

    const req = http.request(opts, (res) => {
      // 非 SSE 响应: 可能是 already_ready / conflict / 404
      const contentType = res.headers["content-type"] || "";
      if (!contentType.includes("text/event-stream")) {
        let data = "";
        res.on("data", (chunk) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.status === "already_ready") return resolve({ ok: true, alreadyReady: true });
            if (json.error) return reject(new Error(json.error));
            resolve({ ok: true, data: json });
          } catch {
            reject(new Error(`daemon 响应异常: ${data.slice(0, 200)}`));
          }
        });
        return;
      }

      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const blocks = buf.split("\n\n");
        buf = blocks.pop();
        for (const block of blocks) {
          if (!block.trim()) continue;
          const eventMatch = block.match(/^event:\s*(.+)$/m);
          const dataMatch = block.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const eventType = eventMatch[1].trim();
          let payload;
          try { payload = JSON.parse(dataMatch[1]); } catch { continue; }

          if (eventType === "progress" && onProgress) {
            onProgress(payload);
          } else if (eventType === "done") {
            if (payload.ok) {
              resolve({ ok: true });
            } else if (payload.cancelled) {
              resolve({ ok: false, cancelled: true });
            } else {
              reject(new Error(payload.error || "下载失败"));
            }
          }
          // skip events are informational, ignored
        }
      });
      res.on("end", () => {
        // 流结束但没收到 done event → 可能连接断了
        resolve({ ok: true });
      });
    });

    req.on("error", (err) => {
      if (/cancel|abort|socket hang up/i.test(err?.message)) {
        resolve({ ok: false, cancelled: true });
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// --- 推理运行时管理 ---

async function getRuntimeStatus() {
  await ensureDaemon();
  const res = await request("GET", "/api/runtime/status");
  return res.data;
}

async function startLLM(modelId, opts = {}) {
  await ensureDaemon();
  const body = { modelId };
  if (opts.contextSize > 0) body.contextSize = opts.contextSize;
  if (opts.gpuLayers > 0) body.gpuLayers = opts.gpuLayers;
  if (opts.parallel > 0) body.parallel = opts.parallel;
  const res = await request("POST", "/api/runtime/llm/start", body);
  if (res.status >= 400) throw new Error(res.data?.error || `startLLM failed: ${res.status}`);
  return res.data;
}

async function stopLLM() {
  await ensureDaemon();
  const res = await request("POST", "/api/runtime/llm/stop");
  return res.data;
}

async function startWhisper(modelId, opts = {}) {
  await ensureDaemon();
  const body = { modelId };
  if (opts.threads > 0) body.threads = opts.threads;
  const res = await request("POST", "/api/runtime/whisper/start", body);
  if (res.status >= 400) throw new Error(res.data?.error || `startWhisper failed: ${res.status}`);
  return res.data;
}

async function stopWhisper() {
  await ensureDaemon();
  const res = await request("POST", "/api/runtime/whisper/stop");
  return res.data;
}

async function getLLMLogs() {
  await ensureDaemon();
  const res = await request("GET", "/api/runtime/llm/logs");
  return res.data?.logs || [];
}

async function getWhisperLogs() {
  await ensureDaemon();
  const res = await request("GET", "/api/runtime/whisper/logs");
  return res.data?.logs || [];
}

// --- 推理引擎二进制管理 ---

async function getBinariesStatus() {
  await ensureDaemon();
  const res = await request("GET", "/api/binaries/status");
  return res.data;
}

// SSE 下载推理引擎二进制。kind = "llama-server" | "whisper-server"
function downloadBinary(kind, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDaemon();
    } catch (err) {
      return reject(err);
    }

    const opts = {
      socketPath: socketPath(),
      path: `/api/binaries/${encodeURIComponent(kind)}/download`,
      method: "POST",
      headers: { ...authHeaders(), "Accept": "text/event-stream" },
    };

    const req = http.request(opts, (res) => {
      const contentType = res.headers["content-type"] || "";
      if (!contentType.includes("text/event-stream")) {
        let data = "";
        res.on("data", (chunk) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.available || json.ok) return resolve({ ok: true, alreadyInstalled: true, data: json });
            if (json.error) return reject(new Error(json.error));
            resolve({ ok: true, data: json });
          } catch {
            reject(new Error(`daemon 响应异常: ${data.slice(0, 200)}`));
          }
        });
        return;
      }

      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const blocks = buf.split("\n\n");
        buf = blocks.pop();
        for (const block of blocks) {
          if (!block.trim()) continue;
          const eventMatch = block.match(/^event:\s*(.+)$/m);
          const dataMatch = block.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const eventType = eventMatch[1].trim();
          let payload;
          try { payload = JSON.parse(dataMatch[1]); } catch { continue; }

          if (eventType === "progress" && onProgress) {
            onProgress(payload);
          } else if (eventType === "done") {
            if (payload.ok || !payload.error) {
              resolve({ ok: true });
            } else {
              reject(new Error(payload.error || "下载失败"));
            }
          }
        }
      });
      res.on("end", () => resolve({ ok: true }));
    });

    req.on("error", (err) => {
      if (/cancel|abort|socket hang up/i.test(err?.message)) {
        resolve({ ok: false, cancelled: true });
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// --- Whisper 转写 (multipart over Unix socket) ---

function transcribe(audioBuffer, options = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDaemon();
    } catch (err) {
      return reject(err);
    }

    const boundary = `----DaemonTranscribe${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts = [];

    // file part
    const fileHeader = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="audio.wav"`,
      `Content-Type: audio/wav`,
      ``,
    ].join("\r\n");
    parts.push(Buffer.from(fileHeader + "\r\n"));
    parts.push(Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer));
    parts.push(Buffer.from("\r\n"));

    // text fields
    const fields = {
      model: options.model || "whisper-large-v3-turbo",
      response_format: options.response_format || "verbose_json",
    };
    if (options.language) fields.language = options.language;
    if (options.prompt) fields.prompt = options.prompt;
    if (options.temperature != null) fields.temperature = String(options.temperature);

    for (const [key, val] of Object.entries(fields)) {
      const fieldPart = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${key}"`,
        ``,
        val,
      ].join("\r\n");
      parts.push(Buffer.from(fieldPart + "\r\n"));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const reqOpts = {
      socketPath: socketPath(),
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = http.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(json?.error?.message || json?.error || `转写失败: ${res.statusCode}`));
          }
          resolve(json);
        } catch {
          reject(new Error(`转写响应解析失败: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  ensureDaemon,
  isDaemonRunning,
  shutdownSync,
  registerClient,
  deregisterClientSync,
  getStatus,
  listModels,
  getModelStatus,
  getModelPaths,
  downloadModel,
  cancelDownload,
  deleteModel,
  setMirrorPreference,
  getHardware,
  getRecommendedModels,
  recomputeFit,
  socketPath,
  daemonStorageDir,
  // 运行时管理
  getRuntimeStatus,
  startLLM,
  stopLLM,
  startWhisper,
  stopWhisper,
  getLLMLogs,
  getWhisperLogs,
  // 推理引擎二进制
  getBinariesStatus,
  downloadBinary,
  // 转写
  transcribe,
};
