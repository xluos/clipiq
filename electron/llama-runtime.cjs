// 本地推理 runtime: 内嵌 llama.cpp 的 llama-server 二进制,作为初筛模型推理后端。
// 设计:
// - 单例 server 实例,同一时刻只跑一个模型;切换模型先 stop 再 start
// - 端口动态分配,避免冲突
// - 模型文件由 ai-model-daemon 集中管理(~/Library/Application Support/AIModels/<modelId>/)
// - 对外暴露 OpenAI-compatible 接口,renderer 侧 provider 抽象零改动直接复用

const { app } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:net");
const sidecarUtils = require("./sidecar-utils.cjs");
const daemonClient = require("./daemon-client.cjs");
const log = require("./logger.cjs");

function pidFilePath() {
  return path.join(app.getPath("userData"), "sidecars", "llama.json");
}


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

// 校验 GGUF 文件是否完整: magic 头 + 大小下限。任何远小于 minBytes 的"GGUF"
// 大概率是 ① 半截下载 ② HF mirror 返回错误页 ③ 旧版 manifest 残留。
async function validateGgufFile(filePath, minBytes = 1024 * 1024) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, reason: "missing", filePath };
  }
  if (stat.size < minBytes) {
    return { ok: false, reason: "tooSmall", filePath, size: stat.size, minBytes };
  }
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    if (buf.toString("ascii") !== "GGUF") {
      return { ok: false, reason: "magic", filePath, size: stat.size };
    }
  } catch (e) {
    return { ok: false, reason: "read", filePath, error: e?.message };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return { ok: true, size: stat.size };
}

function describeValidation(result, label) {
  if (result.ok) return "";
  const fmt = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  switch (result.reason) {
    case "missing":
      return `${label}未下载`;
    case "tooSmall":
      return `${label}文件损坏 (大小 ${fmt(result.size)}, 预期 ≥ ${fmt(result.minBytes)})`;
    case "magic":
      return `${label}文件损坏 (缺少 GGUF 头)`;
    case "read":
      return `${label}文件无法读取${result.error ? ": " + result.error : ""}`;
    default:
      return `${label}文件异常`;
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
  // 实际启动 llama-server 时生效的 --ctx-size。manifest 默认 + config override 解析后落定。
  contextSize: 0,
  startedAt: 0,
  status: "idle", // idle | starting | ready | stopping | error
  lastError: null,
  logBuffer: [],
};

// 外部 (main.cjs) 注册的 ctx 解析器: modelKey → number | null。
// 用于把 config.json 里 localModelOverrides[modelKey].contextSize 注入到 --ctx-size。
// null 时回落到 manifest 默认。
let contextResolver = null;
function setContextResolver(fn) {
  contextResolver = typeof fn === "function" ? fn : null;
}

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
    contextSize: state.contextSize || 0,
    startedAt: state.startedAt,
    lastError: state.lastError,
    recentLogs: state.logBuffer.slice(-30),
  };
}

async function listModels() {
  const items = [];
  let daemonModels = null;
  try {
    daemonModels = await daemonClient.listModels("clipiq");
  } catch {
    // daemon 不可用时 fallback 为全部未下载
  }
  const daemonMap = new Map();
  if (daemonModels) {
    for (const dm of daemonModels) daemonMap.set(dm.id, dm);
  }

  for (const [key, meta] of Object.entries(MODELS)) {
    const dm = daemonMap.get(key);
    const llmFile = dm?.files?.find((f) => f.role === "llm");
    const mmprojFile = dm?.files?.find((f) => f.role === "mmproj");
    items.push({
      key,
      name: meta.name,
      description: meta.description,
      approxBytes: meta.approxBytes,
      llmDownloaded: !!llmFile?.ready,
      llmBytes: llmFile?.bytes || 0,
      mmprojDownloaded: !!mmprojFile?.ready,
      mmprojBytes: mmprojFile?.bytes || 0,
      downloaded: dm?.ready || false,
      llmPath: llmFile?.path || "",
      mmprojPath: mmprojFile?.path || "",
    });
  }
  return items;
}


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
  if (meta._manifest && meta._manifest.available === false) {
    throw new Error(`${meta.name} 暂未实装,即将上线`);
  }

  if (options.mirror) {
    await daemonClient.setMirrorPreference(
      options.mirror === "modelscope" ? "modelscope" : "hf-mirror",
    ).catch(() => {});
  }

  const roleLabels = { llm: "模型权重", mmproj: "视觉编码器" };

  onProgress({ stage: "start", label: meta.name, message: `开始下载 ${meta.name}` });

  const result = await daemonClient.downloadModel(modelKey, (p) => {
    const label = roleLabels[p.fileRole] || p.fileRole || meta.name;
    const pct = p.pct || 0;
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    onProgress({
      stage: "progress",
      file: p.fileRole || "",
      label,
      receivedBytes: p.done,
      totalBytes: p.total,
      percent: pct,
      speed: p.speed || 0,
      message: p.total > 0
        ? `${label} ${pct}% (${mb(p.done)}MB / ${mb(p.total)}MB)`
        : `${label} ${mb(p.done)}MB`,
    });
  });

  if (result?.cancelled) {
    onProgress({ stage: "cancelled", label: meta.name, message: `${meta.name} 下载已取消` });
    return { ok: false, cancelled: true, modelKey };
  }
  onProgress({ stage: "done", label: meta.name, message: `${meta.name} 下载完成` });
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

async function start(modelKey, { onLog, contextSize } = {}) {
  // 复用: 当前会话或上一会话残留 (borrowedPid) 都算; 模型对得上就直接返回
  if (state.process || state.borrowedPid) {
    if (state.modelKey === modelKey && state.status === "ready") {
      return {
        ok: true,
        port: state.port,
        contextSize: state.contextSize,
        reused: true,
        adopted: !!state.borrowedPid,
      };
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
  const daemonPaths = await daemonClient.getModelPaths(modelKey);
  if (!daemonPaths || !daemonPaths.llm || !daemonPaths.mmproj) {
    throw new Error(`模型文件未就绪,请先在设置页下载 ${meta.name}`);
  }
  const llmPath = daemonPaths.llm;
  const mmprojPath = daemonPaths.mmproj;

  // 启动前校验: 拦住损坏 / 半截下载的 GGUF, 避免 llama-server 拿到坏文件再 exit code=1
  // 不抛 raw "异常退出 (code=1)" 消息, 改成可操作的中文提示, 顺手清掉坏文件,
  // 这样下一次 listModels 会把模型标记成"未下载", UI 回到下载按钮态。
  const llmCheck = await validateGgufFile(llmPath);
  const mmprojCheck = await validateGgufFile(mmprojPath);
  if (!llmCheck.ok || !mmprojCheck.ok) {
    let cleaned = false;
    if (!llmCheck.ok && llmCheck.reason !== "missing") {
      await fs.unlink(llmPath).catch(() => {});
      cleaned = true;
    }
    if (!mmprojCheck.ok && mmprojCheck.reason !== "missing") {
      await fs.unlink(mmprojPath).catch(() => {});
      cleaned = true;
    }
    const issues = [];
    if (!llmCheck.ok) issues.push(describeValidation(llmCheck, "模型权重"));
    if (!mmprojCheck.ok) issues.push(describeValidation(mmprojCheck, "视觉编码器"));
    const action = cleaned
      ? "已自动清理损坏文件, 请重新点击下载"
      : "请先在设置页下载该模型";
    throw new Error(`${meta.name} 启动前校验未通过: ${issues.join("; ")}。${action}。`);
  }

  const port = await findFreePort();

  // ctx 解析优先级: 显式传入 > setContextResolver 注册的 hook > manifest 默认 > 8192 兜底
  let effectiveCtx = Number(contextSize) > 0 ? Number(contextSize) : 0;
  if (!effectiveCtx && contextResolver) {
    try {
      const fromHook = await contextResolver(modelKey);
      if (Number(fromHook) > 0) effectiveCtx = Number(fromHook);
    } catch (err) {
      log.warn("llama-runtime", `contextResolver(${modelKey}) 失败:`, err?.message || err);
    }
  }
  if (!effectiveCtx) effectiveCtx = Number(meta.contextSize) > 0 ? Number(meta.contextSize) : 8192;

  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--model", llmPath,
    "--mmproj", mmprojPath,
    "--ctx-size", String(effectiveCtx),
    // Apple Silicon 上让所有层 offload 到 Metal;CPU 后端会忽略该参数
    "--n-gpu-layers", "999",
  ];

  state.status = "starting";
  state.lastError = null;
  state.logBuffer = [];
  state.startedAt = Date.now();
  state.modelKey = modelKey;
  state.port = port;
  state.contextSize = effectiveCtx;

  const child = spawn(binary, args, {
    cwd: path.dirname(llmPath),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.process = child;
  // 落盘 PID 文件: 下次 electron 启动能识别这个 sidecar (即便我们这次被强杀)
  sidecarUtils.writePidFile(pidFilePath(), {
    pid: child.pid,
    port,
    modelKey,
    contextSize: effectiveCtx,
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
      log.info(`llama-server:${channel}`, line);
      if (onLog) onLog({ channel, line });
    }
  };
  child.stdout.on("data", handleLine("stdout"));
  child.stderr.on("data", handleLine("stderr"));

  child.once("exit", (code, signal) => {
    log.info("llama-server", `exit code=${code} signal=${signal}`);
    const wasStopping = state.status === "stopping";
    state.process = null;
    state.port = null;
    state.modelKey = null;
    state.contextSize = 0;
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
  return { ok: true, port, contextSize: effectiveCtx, reused: false };
}

async function selfTest({ imageDataUrl, prompt, port, modelKey } = {}) {
  const targetPort = port || state.port;
  const targetModel = modelKey || state.modelKey;
  if (!targetPort) {
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
  const res = await fetch(`http://127.0.0.1:${targetPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel || "local",
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
    modelKey: targetModel,
    usage: json?.usage || null,
  };
}

async function init() {
  state.binaryPath = await resolveLlamaServerPath();
  try { await daemonClient.ensureDaemon(); } catch (err) {
    log.warn("llama-runtime", "daemon 未启动:", err?.message || err);
  }
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
    log.info("llama-runtime", "PID file stale, clearing");
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  if (result.mode === "kill") {
    // pid 活但 HTTP 不响应 —— 僵尸状态, 杀掉
    log.info("llama-runtime", `orphan pid ${info.pid} unresponsive on :${info.port}, killing`);
    await sidecarUtils.killPidAsyncWait(info.pid, 1500);
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  // adopt: pid + port 都活, 接管
  if (!MODELS[info.modelKey]) {
    // 配置变了 / 不认识的 modelKey → 杀掉, 不接管
    log.info("llama-runtime", `orphan modelKey ${info.modelKey} not in current MODELS map, killing`);
    await sidecarUtils.killPidAsyncWait(info.pid, 1500);
    sidecarUtils.clearPidFile(filePath);
    return;
  }
  state.borrowedPid = info.pid;
  state.port = info.port;
  state.modelKey = info.modelKey;
  // 接管时 ctx 从 PID 文件读; 老版本 PID 文件没有这个字段就用 manifest 默认作为近似
  state.contextSize = Number(info.contextSize) > 0
    ? Number(info.contextSize)
    : (Number(MODELS[info.modelKey]?.contextSize) > 0 ? Number(MODELS[info.modelKey].contextSize) : 8192);
  state.startedAt = info.startedAt || Date.now();
  state.status = "ready";
  log.info("llama-runtime", `adopted orphan pid=${info.pid} port=${info.port} model=${info.modelKey}`);
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

// 拿当前 sidecar PID: 本会话 spawn 的取 child.pid, 跨会话接管的取 borrowedPid。
function getRuntimePid() {
  return state.process?.pid || state.borrowedPid || null;
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
  getRuntimePid,
  selfTest,
  resolveLlamaServerPath,
  setContextResolver,
  shutdownSync,
};
