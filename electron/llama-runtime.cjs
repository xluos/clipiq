// 本地推理 runtime: 内嵌 llama.cpp 的 llama-server 二进制,作为初筛模型推理后端。
// 设计:
// - 单例 server 实例,同一时刻只跑一个模型;切换模型先 stop 再 start
// - 端口动态分配,避免冲突
// - 模型文件按 modelKey 隔离到 userData/models/llama/<key>/,GGUF + mmproj 各一份
// - 对外暴露 OpenAI-compatible 接口,renderer 侧 provider 抽象零改动直接复用

const { app } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:net");
const sidecarUtils = require("./sidecar-utils.cjs");

function pidFilePath() {
  return path.join(app.getPath("userData"), "sidecars", "llama.json");
}

const HF_MIRROR_DEFAULT = "https://hf-mirror.com";

// llama.cpp 官方 release。PIN 版本号,升级时改这里;tar.gz/zip 顶层目录是 llama-${REL}。
const LLAMA_CPP_RELEASE = "b9128";
const LLAMA_CPP_BASE = "https://github.com/ggml-org/llama.cpp/releases/download";

const LLAMA_CPP_ASSETS = {
  "darwin-arm64": { name: "llama-${REL}-bin-macos-arm64.tar.gz", format: "tar.gz" },
  "darwin-x64": { name: "llama-${REL}-bin-macos-x64.tar.gz", format: "tar.gz" },
  "linux-arm64": { name: "llama-${REL}-bin-ubuntu-arm64.tar.gz", format: "tar.gz" },
  "linux-x64": { name: "llama-${REL}-bin-ubuntu-x64.tar.gz", format: "tar.gz" },
  "win32-arm64": { name: "llama-${REL}-bin-win-cpu-arm64.zip", format: "zip" },
  "win32-x64": { name: "llama-${REL}-bin-win-cpu-x64.zip", format: "zip" },
};

// 模型清单从 manifest 文件读取。新增 / 修改模型 → 编辑 local-models.manifest.cjs。
// runtime 内部沿用扁平的 MODELS 形状(key/name/description/repo/llmFile/mmprojFile/
// approxBytes/contextSize),其余 manifest 字段(family/params/primaryCapabilities/
// secondaryTags/available/quantizations)通过 getManifest() 单独暴露给上层 IPC。
const { PRESETS: MANIFEST } = require("./local-models.manifest.cjs");

function manifestToRuntimeModel(entry) {
  // 默认选第一个量化档(目前每个模型只有一档)
  const q = entry.quantizations && entry.quantizations[0];
  return {
    key: entry.key,
    name: entry.name,
    description: entry.description,
    repo: q?.repo || "",
    llmFile: q?.llmFile || "",
    mmprojFile: q?.mmprojFile || "",
    approxBytes: q?.sizeBytes || 0,
    contextSize: entry.contextSize || 8192,
    // runtime 不直接用,但保留给 listModels 透传给上层
    _manifest: entry,
  };
}

const MODELS = Object.fromEntries(
  Object.entries(MANIFEST).map(([key, entry]) => [key, manifestToRuntimeModel(entry)]),
);

function getManifest() {
  return MANIFEST;
}

function modelsRootDir() {
  return path.join(app.getPath("userData"), "models", "llama");
}

function modelDir(modelKey) {
  return path.join(modelsRootDir(), modelKey);
}

function llamaCppPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function llamaCppInstallDir() {
  return path.join(app.getPath("userData"), "bin", `llama-cpp-${LLAMA_CPP_RELEASE}`);
}

function llamaServerInstalledPath() {
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  return path.join(llamaCppInstallDir(), exe);
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

// llama-server 二进制定位优先级:
//   1. LLAMA_SERVER_PATH 环境变量(开发期最快路径)
//   2. userData/bin/llama-cpp-<release>/llama-server (内嵌自动下载安装)
//   3. PATH (brew install llama.cpp / 用户手动安装)
async function resolveLlamaServerPath() {
  const envPath = process.env.LLAMA_SERVER_PATH;
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  const installed = llamaServerInstalledPath();
  if (await fileExists(installed)) return installed;

  return new Promise((resolve) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, ["llama-server"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.on("close", () => {
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
    child.on("error", () => resolve(null));
  });
}

async function ensureLlamaServer(onProgress = () => {}) {
  // 已经能找到就直接复用(env 或 PATH 也算 ok)
  const existing = await resolveLlamaServerPath();
  if (existing) {
    state.binaryPath = existing;
    return existing;
  }

  const key = llamaCppPlatformKey();
  const asset = LLAMA_CPP_ASSETS[key];
  if (!asset) {
    throw new Error(
      `当前平台 ${key} 暂未提供内嵌的 llama-server 安装包,请手动安装 llama.cpp 并设置 LLAMA_SERVER_PATH。`,
    );
  }

  const assetName = asset.name.replace(/\$\{REL\}/g, LLAMA_CPP_RELEASE);
  const url = `${LLAMA_CPP_BASE}/${LLAMA_CPP_RELEASE}/${assetName}`;
  const binRoot = path.join(app.getPath("userData"), "bin");
  await fs.mkdir(binRoot, { recursive: true });
  const archivePath = path.join(binRoot, assetName);

  onProgress({
    stage: "binary-start",
    label: "推理引擎",
    message: `开始下载推理引擎 ${LLAMA_CPP_RELEASE}`,
  });

  try {
    await downloadFile(url, archivePath, (p) => {
      const pct = p.total > 0 ? Math.floor((p.received / p.total) * 100) : 0;
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      onProgress({
        stage: "binary-progress",
        label: "推理引擎",
        percent: pct,
        receivedBytes: p.received,
        totalBytes: p.total,
        message: p.total > 0
          ? `推理引擎 ${pct}% (${mb(p.received)}MB / ${mb(p.total)}MB)`
          : `推理引擎 ${mb(p.received)}MB`,
      });
    });
  } catch (error) {
    await fs.unlink(archivePath).catch(() => {});
    throw error;
  }

  onProgress({ stage: "binary-extract", label: "推理引擎", message: "正在解压推理引擎" });

  // 解到临时目录,再 rename 到 install dir,避免半成品状态
  const tmpExtract = path.join(binRoot, `.extract-${Date.now()}`);
  await fs.mkdir(tmpExtract, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const args = asset.format === "tar.gz"
        ? ["-xzf", archivePath, "-C", tmpExtract]
        : ["-xf", archivePath, "-C", tmpExtract];
      const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`tar 解压失败 (code=${code}): ${stderr.slice(0, 300)}`));
      });
    });

    const entries = await fs.readdir(tmpExtract);
    const topDir = entries.find((e) => e.startsWith("llama-") || e.startsWith("build")) || entries[0];
    if (!topDir) throw new Error("解压后未找到 llama-cpp 目录");
    const extracted = path.join(tmpExtract, topDir);

    const finalDir = llamaCppInstallDir();
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(finalDir), { recursive: true });
    await fs.rename(extracted, finalDir);
  } finally {
    await fs.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(archivePath).catch(() => {});
  }

  // macOS: 兜底清掉 quarantine 属性,避免 Gatekeeper 拦截(失败忽略)
  if (process.platform === "darwin") {
    await new Promise((resolve) => {
      const child = spawn("xattr", ["-dr", "com.apple.quarantine", llamaCppInstallDir()], {
        stdio: "ignore",
      });
      child.on("error", () => resolve(undefined));
      child.on("exit", () => resolve(undefined));
    });
  }

  const installed = llamaServerInstalledPath();
  if (!(await fileExists(installed))) {
    throw new Error(`安装完成但未找到 llama-server 可执行文件: ${installed}`);
  }
  // tar 解压保留权限位,Linux/macOS 通常已经是 0755;Windows 不需要 chmod
  if (process.platform !== "win32") {
    await fs.chmod(installed, 0o755).catch(() => {});
  }

  state.binaryPath = installed;
  onProgress({ stage: "binary-done", label: "推理引擎", message: "推理引擎安装完成" });
  return installed;
}

const state = {
  binaryPath: null,
  process: null,
  // borrowedPid: 跨会话接管时设置 —— 表示这个 sidecar 不是本会话 spawn 的,
  // 没有 ChildProcess 句柄, 只能通过 pid 操作。stop/shutdownSync 要分支处理。
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
    const dir = modelDir(key);
    const llmPath = path.join(dir, meta.llmFile);
    const mmprojPath = path.join(dir, meta.mmprojFile);
    const llmStat = await fs.stat(llmPath).catch(() => null);
    const mmprojStat = await fs.stat(mmprojPath).catch(() => null);
    items.push({
      key,
      name: meta.name,
      description: meta.description,
      approxBytes: meta.approxBytes,
      llmDownloaded: !!llmStat,
      llmBytes: llmStat?.size || 0,
      mmprojDownloaded: !!mmprojStat,
      mmprojBytes: mmprojStat?.size || 0,
      downloaded: !!llmStat && !!mmprojStat,
      llmPath,
      mmprojPath,
    });
  }
  return items;
}

async function downloadFile(url, destPath, onProgress) {
  const tmp = `${destPath}.part`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status} ${url}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const fh = await fs.open(tmp, "w");
  let received = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
      received += value.byteLength;
      if (onProgress) onProgress({ received, total });
    }
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, destPath);
  return { received, total };
}

async function ensureModel(modelKey, onProgress = () => {}) {
  const meta = MODELS[modelKey];
  if (!meta) throw new Error(`未知模型: ${modelKey}`);
  if (meta._manifest && meta._manifest.available === false) {
    throw new Error(`${meta.name} 暂未实装,即将上线`);
  }
  const dir = modelDir(modelKey);
  await fs.mkdir(dir, { recursive: true });
  const mirror = process.env.HF_MIRROR || HF_MIRROR_DEFAULT;
  const targets = [
    { file: meta.llmFile, label: "模型权重" },
    { file: meta.mmprojFile, label: "视觉编码器" },
  ];
  for (const t of targets) {
    const dest = path.join(dir, t.file);
    if (await fileExists(dest)) {
      onProgress({ stage: "skip", file: t.file, label: t.label, message: `${t.label}已就绪` });
      continue;
    }
    const url = `${mirror}/${meta.repo}/resolve/main/${t.file}`;
    onProgress({ stage: "start", file: t.file, label: t.label, message: `开始下载${t.label}` });
    await downloadFile(url, dest, (p) => {
      const pct = p.total > 0 ? Math.floor((p.received / p.total) * 100) : 0;
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      onProgress({
        stage: "progress",
        file: t.file,
        label: t.label,
        receivedBytes: p.received,
        totalBytes: p.total,
        percent: pct,
        message: p.total > 0
          ? `${t.label} ${pct}% (${mb(p.received)}MB / ${mb(p.total)}MB)`
          : `${t.label} ${mb(p.received)}MB`,
      });
    });
    onProgress({ stage: "done", file: t.file, label: t.label, message: `${t.label}下载完成` });
  }
  return { ok: true, modelKey };
}

async function stop() {
  // 接管的 sidecar (没有 ChildProcess 句柄, 只有 PID) —— 用 pid 操作
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
      throw new Error(state.lastError || "llama-server 启动后立即退出");
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      // 继续轮询
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server 启动超时(60s)");
}

async function start(modelKey, { onLog } = {}) {
  // 复用: 当前会话或上一会话残留 (borrowedPid) 都算; 模型对得上就直接返回
  if (state.process || state.borrowedPid) {
    if (state.modelKey === modelKey && state.status === "ready") {
      return { ok: true, port: state.port, reused: true, adopted: !!state.borrowedPid };
    }
    await stop();
  }
  const meta = MODELS[modelKey];
  if (!meta) throw new Error(`未知模型: ${modelKey}`);
  if (meta._manifest && meta._manifest.available === false) {
    throw new Error(`${meta.name} 暂未实装,即将上线`);
  }
  const binary = state.binaryPath || (await resolveLlamaServerPath());
  if (!binary) {
    const err = new Error(
      "找不到 llama-server 可执行文件。请先安装 llama.cpp(macOS: brew install llama.cpp),或设置 LLAMA_SERVER_PATH 环境变量。",
    );
    state.lastError = err.message;
    throw err;
  }
  state.binaryPath = binary;
  const dir = modelDir(modelKey);
  const llmPath = path.join(dir, meta.llmFile);
  const mmprojPath = path.join(dir, meta.mmprojFile);
  if (!fsSync.existsSync(llmPath)) throw new Error(`模型权重未下载: ${meta.llmFile}`);
  if (!fsSync.existsSync(mmprojPath)) throw new Error(`视觉编码器未下载: ${meta.mmprojFile}`);

  const port = await findFreePort();
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--model", llmPath,
    "--mmproj", mmprojPath,
    "--ctx-size", String(meta.contextSize || 8192),
    // Apple Silicon 上让所有层 offload 到 Metal;CPU 后端会忽略该参数
    "--n-gpu-layers", "999",
  ];

  state.status = "starting";
  state.lastError = null;
  state.logBuffer = [];
  state.startedAt = Date.now();
  state.modelKey = modelKey;
  state.port = port;

  const child = spawn(binary, args, {
    cwd: dir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.process = child;
  // 落盘 PID 文件: 下次 electron 启动能识别这个 sidecar (即便我们这次被强杀)
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
      console.log(`[llama-server:${channel}]`, line);
      if (onLog) onLog({ channel, line });
    }
  };
  child.stdout.on("data", handleLine("stdout"));
  child.stderr.on("data", handleLine("stderr"));

  child.once("exit", (code, signal) => {
    // eslint-disable-next-line no-console
    console.log(`[llama-server] exit code=${code} signal=${signal}`);
    const wasStopping = state.status === "stopping";
    state.process = null;
    state.port = null;
    state.modelKey = null;
    sidecarUtils.clearPidFile(pidFilePath());
    if (wasStopping) {
      state.status = "idle";
    } else {
      state.status = "error";
      state.lastError = `llama-server 异常退出 (code=${code}, signal=${signal})`;
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

async function selfTest({ imageDataUrl, prompt } = {}) {
  if (state.status !== "ready" || !state.port) {
    throw new Error("本地推理服务未就绪,请先启动模型");
  }
  const messages = [
    {
      role: "user",
      content: [
        ...(imageDataUrl ? [{ type: "image_url", image_url: { url: imageDataUrl } }] : []),
        { type: "text", text: prompt || "用一句话描述这张图片里看到的画面、人物或场景。" },
      ],
    },
  ];
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: state.modelKey || "local",
      messages,
      max_tokens: 200,
      temperature: 0.3,
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`本地推理调用失败 HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || "";
  return {
    ok: true,
    latencyMs,
    text,
    modelKey: state.modelKey,
    usage: json?.usage || null,
  };
}

async function init() {
  state.binaryPath = await resolveLlamaServerPath();
  await fs.mkdir(modelsRootDir(), { recursive: true });
  await reapOrAdopt();
}

// init() 时检查 PID 文件: 上次的 sidecar 是否还能接管? 不能就杀掉残留。
async function reapOrAdopt() {
  const filePath = pidFilePath();
  const result = await sidecarUtils.inspectPidFile(filePath, { pathSuffix: "/v1/models", timeoutMs: 600 });
  if (result.mode === "none") return;
  const { info } = result;
  if (result.mode === "stale") {
    // pid 已死 (上次进程 clean exit 但没清文件, 或机器重启过)
    // eslint-disable-next-line no-console
    console.log("[llama-runtime] PID file stale, clearing");
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  if (result.mode === "kill") {
    // pid 活但 HTTP 不响应 —— 僵尸状态, 杀掉
    // eslint-disable-next-line no-console
    console.log(`[llama-runtime] orphan pid ${info.pid} unresponsive on :${info.port}, killing`);
    await sidecarUtils.killPidAsyncWait(info.pid, 1500);
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  // adopt: pid + port 都活, 接管
  if (!MODELS[info.modelKey]) {
    // 配置变了 / 不认识的 modelKey → 杀掉, 不接管
    // eslint-disable-next-line no-console
    console.log(`[llama-runtime] orphan modelKey ${info.modelKey} not in current MODELS map, killing`);
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
  console.log(`[llama-runtime] adopted orphan pid=${info.pid} port=${info.port} model=${info.modelKey}`);
}

// 同步退出路径 (process.exit / SIGTERM hook) 调用。要尽快释放 sidecar, 不能用 async。
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
  LLAMA_CPP_RELEASE,
  init,
  listModels,
  getManifest,
  ensureModel,
  ensureLlamaServer,
  start,
  stop,
  getStatus,
  selfTest,
  resolveLlamaServerPath,
  shutdownSync,
};
