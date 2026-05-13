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

// 预设模型清单。3 档可选,按机器配置 / 质量诉求选用。
// 体积 = 权重 + mmproj-F16,首次下载会被缓存到 userData/models/llama/<key>/。
const MODELS = {
  qwen3_5_0_8b_q4km: {
    key: "qwen3_5_0_8b_q4km",
    name: "Qwen3.5-0.8B (Q4_K_M)",
    description: "约 1.2GB · 单帧 ~1s · 极速档,适合海量画面初筛",
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    llmFile: "Qwen3.5-0.8B-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxBytes: 1180 * 1024 * 1024,
    contextSize: 8192,
  },
  qwen3_5_2b_q4km: {
    key: "qwen3_5_2b_q4km",
    name: "Qwen3.5-2B (Q4_K_M)",
    description: "约 1.9GB · 单帧 ~2s · 中文识别和叙事更稳,推荐档",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    llmFile: "Qwen3.5-2B-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxBytes: 1860 * 1024 * 1024,
    contextSize: 8192,
  },
  qwen3_5_4b_q4km: {
    key: "qwen3_5_4b_q4km",
    name: "Qwen3.5-4B (Q4_K_M)",
    description: "约 3.3GB · 单帧 ~3-4s · 准确度最高,适合大内存机器",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    llmFile: "Qwen3.5-4B-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxBytes: 3250 * 1024 * 1024,
    contextSize: 8192,
  },
};

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
  if (state.process) {
    if (state.modelKey === modelKey && state.status === "ready") {
      return { ok: true, port: state.port, reused: true };
    }
    await stop();
  }
  const meta = MODELS[modelKey];
  if (!meta) throw new Error(`未知模型: ${modelKey}`);
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
}

async function shutdownSync() {
  if (!state.process) return;
  try {
    state.process.kill("SIGTERM");
  } catch {
    // ignore
  }
}

module.exports = {
  MODELS,
  LLAMA_CPP_RELEASE,
  init,
  listModels,
  ensureModel,
  ensureLlamaServer,
  start,
  stop,
  getStatus,
  selfTest,
  resolveLlamaServerPath,
  shutdownSync,
};
