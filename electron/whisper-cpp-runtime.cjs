// 本地音频识别 runtime: 内嵌 whisper.cpp 的 whisper-server 二进制。
//
// 设计:
// - 单例 server 实例,同一时刻只跑一个模型;切换模型先 stop 再 start。
// - 端口动态分配,避免冲突。
// - 模型文件按 modelKey 隔离到 userData/models/whisper/<file>.bin。
// - 对外暴露 multipart /inference endpoint (whisper.cpp server 原生)。
//
// binary 路径优先级:
//   1. WHISPER_SERVER_PATH 环境变量(开发期最快路径)
//   2. packaged: process.resourcesPath/bin/<platform-arch>/whisper-server
//   3. dev:      <repo>/resources/bin/<platform-arch>/whisper-server
//   4. PATH 兜底
//
// binary 不走 ensureBinary 自动下载: 项目内置静态编译, 缺失时给"开发者运行 build script"
// 的明确提示。打包后 binary 必须存在于 process.resourcesPath/bin/。

const { app } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:net");
const sidecarUtils = require("./sidecar-utils.cjs");

function pidFilePath() {
  return path.join(app.getPath("userData"), "sidecars", "whisper.json");
}

const HF_MIRROR_DEFAULT = "https://hf-mirror.com";
const MODELSCOPE_BASE = "https://modelscope.cn";
const GGERGANOV_WHISPER_REPO = "ggerganov/whisper.cpp";
// 魔搭上 whisper.cpp 模型由 ggerganov 同名空间镜像; 路径结构和 HF 兼容。
const MODELSCOPE_WHISPER_REPO = "ggerganov/whisper.cpp";

function buildDownloadUrl(mirror, file) {
  const envOverride = process.env.HF_MIRROR;
  if (envOverride) return `${envOverride}/${GGERGANOV_WHISPER_REPO}/resolve/main/${file}`;
  if (mirror === "modelscope") {
    return `${MODELSCOPE_BASE}/models/${MODELSCOPE_WHISPER_REPO}/resolve/master/${file}`;
  }
  return `${HF_MIRROR_DEFAULT}/${GGERGANOV_WHISPER_REPO}/resolve/main/${file}`;
}

// 预设 ggml 模型清单。来源: https://huggingface.co/ggerganov/whisper.cpp
// 命名沿用 whisper.cpp 上游惯例: ggml-<size>.bin
const MODELS = {
  "ggml-tiny": {
    key: "ggml-tiny",
    name: "Whisper Tiny",
    description: "约 75MB · 极速档,适合实时识别 / 演示",
    file: "ggml-tiny.bin",
    approxBytes: 75 * 1024 * 1024,
  },
  "ggml-base": {
    key: "ggml-base",
    name: "Whisper Base",
    description: "约 142MB · 平衡档,推荐起步",
    file: "ggml-base.bin",
    approxBytes: 142 * 1024 * 1024,
  },
  "ggml-small": {
    key: "ggml-small",
    name: "Whisper Small",
    description: "约 466MB · 中文识别更稳",
    file: "ggml-small.bin",
    approxBytes: 466 * 1024 * 1024,
  },
  "ggml-medium": {
    key: "ggml-medium",
    name: "Whisper Medium",
    description: "约 1.5GB · 高准确度,适合大内存机器",
    file: "ggml-medium.bin",
    approxBytes: 1500 * 1024 * 1024,
  },
};

function modelsRootDir() {
  return path.join(app.getPath("userData"), "models", "whisper");
}

function modelPath(modelKey) {
  const meta = MODELS[modelKey];
  if (!meta) return null;
  return path.join(modelsRootDir(), meta.file);
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function binaryName() {
  return process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
}

function resolveBinaryPath() {
  const envPath = process.env.WHISPER_SERVER_PATH;
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  const binName = binaryName();
  const platform = platformKey();

  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "bin", platform, binName);
    if (fsSync.existsSync(packaged)) return packaged;
  }

  const devPath = path.join(__dirname, "..", "resources", "bin", platform, binName);
  if (fsSync.existsSync(devPath)) return devPath;

  const which = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(which, ["whisper-server"], { encoding: "utf8" });
  if (result.status === 0) {
    const first = (result.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fsSync.existsSync(first)) return first;
  }

  return null;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const state = {
  binaryPath: null,
  process: null,
  // borrowedPid: 跨会话接管的 sidecar (上次 electron 强退留下的孤儿), 没有 ChildProcess 句柄。
  borrowedPid: null,
  port: null,
  modelKey: null,
  startedAt: 0,
  status: "idle", // idle | starting | ready | stopping | error
  lastError: null,
  logBuffer: [],
};

function pushLog(channel, line) {
  state.logBuffer.push({ ts: Date.now(), channel, line });
  if (state.logBuffer.length > 200) state.logBuffer.shift();
}

function getStatus() {
  return {
    binaryPath: state.binaryPath,
    binaryFound: !!state.binaryPath,
    running: state.status === "ready",
    status: state.status,
    modelKey: state.modelKey,
    port: state.port,
    startedAt: state.startedAt,
    lastError: state.lastError,
    recentLogs: state.logBuffer.slice(-30),
  };
}

async function listModels() {
  const items = [];
  for (const [key, meta] of Object.entries(MODELS)) {
    const p = modelPath(key);
    const stat = p ? await fs.stat(p).catch(() => null) : null;
    items.push({
      key,
      name: meta.name,
      description: meta.description,
      approxBytes: meta.approxBytes,
      downloaded: !!stat,
      downloadedBytes: stat?.size || 0,
      modelPath: p,
    });
  }
  return items;
}

// 断点续传: 同 llama-runtime.cjs 的实现。<dest>.part + <dest>.part.url 配对。
async function downloadFile(url, destPath, onProgress) {
  const tmp = `${destPath}.part`;
  const metaPath = `${destPath}.part.url`;

  let startBytes = 0;
  try {
    const recordedUrl = (await fs.readFile(metaPath, "utf8")).trim();
    if (recordedUrl === url) {
      const st = await fs.stat(tmp).catch(() => null);
      if (st && st.size > 0) startBytes = st.size;
    } else {
      await fs.unlink(tmp).catch(() => {});
      await fs.unlink(metaPath).catch(() => {});
    }
  } catch {
    // first download or legacy .part without meta
  }

  let response = await fetch(url, startBytes > 0 ? { headers: { Range: `bytes=${startBytes}-` } } : undefined);
  if (response.status === 416) {
    await fs.unlink(tmp).catch(() => {});
    await fs.unlink(metaPath).catch(() => {});
    startBytes = 0;
    response = await fetch(url);
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status} ${url}`);
  }

  let total = 0;
  let appendMode = false;
  if (response.status === 206 && startBytes > 0) {
    const cr = response.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)$/);
    if (m) total = Number(m[1]);
    appendMode = true;
  } else {
    total = Number(response.headers.get("content-length")) || 0;
    startBytes = 0;
  }

  await fs.writeFile(metaPath, url, "utf8");

  const reader = response.body.getReader();
  const fh = await fs.open(tmp, appendMode ? "a" : "w");
  let received = startBytes;
  let streamError = null;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
      received += value.byteLength;
      if (onProgress) onProgress({ received, total });
    }
  } catch (e) {
    streamError = e;
  } finally {
    await fh.close();
  }
  if (streamError) throw streamError;
  if (total > 0 && received !== total) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    throw new Error(`下载不完整: 已收到 ${mb(received)} MB / 预期 ${mb(total)} MB (下次重试会续传)`);
  }
  await fs.rename(tmp, destPath);
  await fs.unlink(metaPath).catch(() => {});
  return { received, total };
}

// 同一 modelKey 重入复用老 promise, 避免并发 fetch 把 .part 字节流交错。
const inflightEnsures = new Map();

async function ensureModel(modelKey, onProgress = () => {}, options = {}) {
  const existing = inflightEnsures.get(modelKey);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await doEnsureModel(modelKey, onProgress, options);
    } finally {
      inflightEnsures.delete(modelKey);
    }
  })();
  inflightEnsures.set(modelKey, promise);
  return promise;
}

async function doEnsureModel(modelKey, onProgress, options = {}) {
  const meta = MODELS[modelKey];
  if (!meta) throw new Error(`未知模型: ${modelKey}`);
  const dir = modelsRootDir();
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, meta.file);
  if (await fileExists(dest)) {
    onProgress({ stage: "skip", file: meta.file, label: meta.name, message: `${meta.name} 已就绪` });
    return { ok: true, modelKey };
  }
  const mirror = options.mirror === "modelscope" ? "modelscope" : "hf-mirror";
  const url = buildDownloadUrl(mirror, meta.file);
  onProgress({ stage: "start", file: meta.file, label: meta.name, message: `开始下载 ${meta.name}` });
  await downloadFile(url, dest, (p) => {
    const pct = p.total > 0 ? Math.floor((p.received / p.total) * 100) : 0;
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    onProgress({
      stage: "progress",
      file: meta.file,
      label: meta.name,
      receivedBytes: p.received,
      totalBytes: p.total,
      percent: pct,
      message:
        p.total > 0
          ? `${meta.name} ${pct}% (${mb(p.received)}MB / ${mb(p.total)}MB)`
          : `${meta.name} ${mb(p.received)}MB`,
    });
  });
  onProgress({ stage: "done", file: meta.file, label: meta.name, message: `${meta.name} 下载完成` });
  return { ok: true, modelKey };
}

async function stop() {
  // 接管的 sidecar: 只有 pid 没有句柄, 用 pid 操作
  if (!state.process && state.borrowedPid) {
    state.status = "stopping";
    await sidecarUtils.killPidAsyncWait(state.borrowedPid, 2000);
    sidecarUtils.clearPidFile(pidFilePath());
    state.borrowedPid = null;
    state.port = null;
    state.modelKey = null;
    state.status = "idle";
    return { ok: true };
  }
  if (!state.process) {
    state.status = "idle";
    state.modelKey = null;
    state.port = null;
    return { ok: true };
  }
  state.status = "stopping";
  const proc = state.process;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      state.process = null;
      state.port = null;
      state.modelKey = null;
      state.status = "idle";
      sidecarUtils.clearPidFile(pidFilePath());
      resolve({ ok: true });
    };
    proc.once("exit", finish);
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!settled) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish();
      }
    }, 3000);
  });
}

async function waitForReady(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!state.process) {
      throw new Error(state.lastError || "whisper-server 启动后立即退出");
    }
    try {
      // whisper.cpp server: GET / 返回 HTML (200);未就绪时连接拒绝
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok || r.status === 404) return true;
    } catch {
      // 继续轮询
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("whisper-server 启动超时(60s)");
}

async function start(modelKey, { onLog } = {}) {
  // 复用: 本会话句柄 或 跨会话接管 (borrowedPid) 都算
  if (state.process || state.borrowedPid) {
    if (state.modelKey === modelKey && state.status === "ready") {
      return { ok: true, port: state.port, reused: true, adopted: !!state.borrowedPid };
    }
    await stop();
  }
  const meta = MODELS[modelKey];
  if (!meta) throw new Error(`未知模型: ${modelKey}`);
  const binary = state.binaryPath || resolveBinaryPath();
  if (!binary) {
    const err = new Error(
      "找不到 whisper-server 可执行文件。开发期请运行 scripts/build-whisper-cpp.sh 编译,或设置 WHISPER_SERVER_PATH 环境变量。",
    );
    state.lastError = err.message;
    throw err;
  }
  state.binaryPath = binary;
  const model = modelPath(modelKey);
  if (!model || !fsSync.existsSync(model)) {
    throw new Error(`模型未下载: ${meta.file}`);
  }

  const port = await findFreePort();
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--model", model,
    // whisper-server 其他默认参数已合理 (--threads 自适应, --inference-path /inference 默认开启)
  ];

  state.status = "starting";
  state.lastError = null;
  state.logBuffer = [];
  state.startedAt = Date.now();
  state.modelKey = modelKey;
  state.port = port;

  const child = spawn(binary, args, {
    cwd: modelsRootDir(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.process = child;
  sidecarUtils.writePidFile(pidFilePath(), {
    pid: child.pid,
    port,
    modelKey,
    parentPid: process.pid,
    startedAt: state.startedAt,
    binaryPath: binary,
  });

  const handleLine = (channel) => (chunk) => {
    const text = chunk.toString();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      pushLog(channel, line);
      // eslint-disable-next-line no-console
      console.log(`[whisper-server:${channel}]`, line);
      if (onLog) onLog({ channel, line });
    }
  };
  child.stdout.on("data", handleLine("stdout"));
  child.stderr.on("data", handleLine("stderr"));

  child.once("exit", (code, signal) => {
    // eslint-disable-next-line no-console
    console.log(`[whisper-server] exit code=${code} signal=${signal}`);
    const wasStopping = state.status === "stopping";
    state.process = null;
    state.port = null;
    state.modelKey = null;
    sidecarUtils.clearPidFile(pidFilePath());
    if (wasStopping) {
      state.status = "idle";
    } else {
      state.status = "error";
      state.lastError = `whisper-server 异常退出 (code=${code}, signal=${signal})`;
    }
  });

  try {
    await waitForReady(port);
  } catch (error) {
    await stop().catch(() => {});
    state.lastError = error instanceof Error ? error.message : String(error);
    state.status = "error";
    throw error;
  }
  state.status = "ready";
  return { ok: true, port, reused: false };
}

async function init() {
  state.binaryPath = resolveBinaryPath();
  await fs.mkdir(modelsRootDir(), { recursive: true });
  await reapOrAdopt();
}

async function reapOrAdopt() {
  const filePath = pidFilePath();
  const result = await sidecarUtils.inspectPidFile(filePath, { pathSuffix: "/", timeoutMs: 600 });
  if (result.mode === "none") return;
  const { info } = result;
  if (result.mode === "stale") {
    // eslint-disable-next-line no-console
    console.log("[whisper-runtime] PID file stale, clearing");
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  if (result.mode === "kill") {
    // eslint-disable-next-line no-console
    console.log(`[whisper-runtime] orphan pid ${info.pid} unresponsive on :${info.port}, killing`);
    await sidecarUtils.killPidAsyncWait(info.pid, 1500);
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  if (!MODELS[info.modelKey]) {
    // eslint-disable-next-line no-console
    console.log(`[whisper-runtime] orphan modelKey ${info.modelKey} not in MODELS map, killing`);
    await sidecarUtils.killPidAsyncWait(info.pid, 1500);
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  state.borrowedPid = info.pid;
  state.port = info.port;
  state.modelKey = info.modelKey;
  state.startedAt = info.startedAt || Date.now();
  state.status = "ready";
  // eslint-disable-next-line no-console
  console.log(`[whisper-runtime] adopted orphan pid=${info.pid} port=${info.port} model=${info.modelKey}`);
}

function shutdownSync() {
  if (state.process) {
    try { state.process.kill("SIGTERM"); } catch { /* ignore */ }
    sidecarUtils.clearPidFile(pidFilePath());
    return;
  }
  if (state.borrowedPid) {
    sidecarUtils.killPidSyncWait(state.borrowedPid, 600);
    sidecarUtils.clearPidFile(pidFilePath());
    state.borrowedPid = null;
  }
}

module.exports = {
  MODELS,
  init,
  listModels,
  ensureModel,
  start,
  stop,
  getStatus,
  resolveBinaryPath,
  shutdownSync,
};
