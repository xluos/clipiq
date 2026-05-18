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
const MODELSCOPE_BASE = "https://modelscope.cn";

// 下载源路径模板。env HF_MIRROR 仍然优先, 让开发期可以临时绕过 UI 配置;
// 否则按调用方传入的 mirror 选: hf-mirror (HF 镜像) 或 modelscope (魔搭).
// ModelScope 的资源路径和 HF 兼容: /models/{owner}/{name}/resolve/master/{file}.
function buildDownloadUrl(mirror, repo, file) {
  const envOverride = process.env.HF_MIRROR;
  if (envOverride) return `${envOverride}/${repo}/resolve/main/${file}`;
  if (mirror === "modelscope") {
    return `${MODELSCOPE_BASE}/models/${repo}/resolve/master/${file}`;
  }
  return `${HF_MIRROR_DEFAULT}/${repo}/resolve/main/${file}`;
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

// 支持断点续传:
// - <dest>.part   未完成的部分文件
// - <dest>.part.url   该 .part 对应的下载 URL (用于检测 mirror 切换 → 不能续)
// 流中断或不完整时不 unlink .part, 让下次 fetch 用 Range 续上。
// rename 成功后两个文件都清掉。
async function downloadFile(url, destPath, onProgress) {
  const tmp = `${destPath}.part`;
  const metaPath = `${destPath}.part.url`;

  // 判断能否续传: 之前的 .part + .part.url 都在, 且 url 一致
  let startBytes = 0;
  try {
    const recordedUrl = (await fs.readFile(metaPath, "utf8")).trim();
    if (recordedUrl === url) {
      const st = await fs.stat(tmp).catch(() => null);
      if (st && st.size > 0) startBytes = st.size;
    } else {
      // url 换了 (mirror 切换 / 模型重命名): 不能用老字节, 清掉
      await fs.unlink(tmp).catch(() => {});
      await fs.unlink(metaPath).catch(() => {});
    }
  } catch {
    // meta 不存在 → 首次下载或老版本残留, 让 status 200 分支正常处理
  }

  let response = await fetch(url, startBytes > 0 ? { headers: { Range: `bytes=${startBytes}-` } } : undefined);
  // 416 = .part 越界 (本地比远程还大, 或远程文件已变), 全部清掉重下
  if (response.status === 416) {
    await fs.unlink(tmp).catch(() => {});
    await fs.unlink(metaPath).catch(() => {});
    startBytes = 0;
    response = await fetch(url);
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status} ${url}`);
  }

  // 总大小: 206 → Content-Range 末尾 /N; 200 → Content-Length 即总; 200 但 startBytes>0 = 服务端忽略 Range
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
  if (streamError) {
    // 保留 .part + meta, 下次续上
    throw streamError;
  }
  if (total > 0 && received !== total) {
    // 流提前结束但未抛错: 保留 .part 让下次续传
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    throw new Error(`下载不完整: 已收到 ${mb(received)} MB / 预期 ${mb(total)} MB (下次重试会续传)`);
  }
  await fs.rename(tmp, destPath);
  await fs.unlink(metaPath).catch(() => {});
  return { received, total };
}

// 同一 modelKey 重入复用老 promise, 避免并发 fetch 把 .part 字节流交错。
// onProgress 通过 IPC channel 自然分发给 renderer 所有 listener, 第二个 caller 的
// onProgress closure 虽不会被直接调用, 但事件流还是能在 renderer 上收到。
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
  const dir = modelDir(modelKey);
  await fs.mkdir(dir, { recursive: true });
  const mirror = options.mirror === "modelscope" ? "modelscope" : "hf-mirror";
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
    const url = buildDownloadUrl(mirror, meta.repo, t.file);
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
  shutdownSync,
};
