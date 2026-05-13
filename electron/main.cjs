const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell } = require("electron");
const { execFile } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");
const llamaRuntime = require("./llama-runtime.cjs");
const whisperCppRuntime = require("./whisper-cpp-runtime.cjs");
const prefilter = require("./prefilter.cjs");
const shotMerger = require("./shot-merger.cjs");
const summarizer = require("./summarizer.cjs");
const { getTranscriber } = require("./transcribe/index.cjs");

const REMOTE_DEBUG_PORT = process.env.VIDEO_ANALYZER_DEBUG_PORT || "";
if (REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUG_PORT);
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const PIPELINE_VERSION = "mvp-local-2026-05-13";
const SCHEMA_VERSION = "analysis-v2-methodology";

const METHODOLOGY_DIR = path.join(__dirname, "..", "prompts", "methodology");
const methodologyCache = new Map();
const GENRE_CATALOG = {
  vlog: "日常 / 生活 / 旅行 vlog，情绪线优先，BGM 主导节奏",
  review: "测评 / 开箱 / 对比 / 好物推荐，结构强、可跳读、要证据",
  travel: "风景 / 旅拍 / 城市漫游，意境优先，BGM 节拍剪辑",
  tutorial: "教程 / DIY / 技能演示，deliberate pacing、步骤化",
  knowledge: "知识科普 / 视频论文 / 行业分析，论证链 + 情绪曲线",
  documentary: "纪录片 / 人物专题 / 深度叙事，三幕情绪 + 章节化",
  "short-drama": "短剧 / 剧情段子 / 带货剧情，高密度反转、字幕主导",
};
const ALLOWED_GENRES = new Set([...Object.keys(GENRE_CATALOG), "other"]);

function computeLengthBucket(durationSec) {
  const d = Number(durationSec) || 0;
  if (d < 60) return "short";
  if (d < 180) return "mid";
  if (d < 600) return "long";
  return "deep";
}

async function loadMethodologyMd(relPath) {
  if (methodologyCache.has(relPath)) return methodologyCache.get(relPath);
  const full = path.join(METHODOLOGY_DIR, relPath);
  try {
    const content = await fs.readFile(full, "utf8");
    methodologyCache.set(relPath, content);
    return content;
  } catch {
    methodologyCache.set(relPath, "");
    return "";
  }
}

async function buildMethodologyContext(durationSec, manualGenre, preResolvedGenre) {
  const lengthBucket = computeLengthBucket(durationSec);
  const isAuto = !manualGenre || manualGenre === "auto";
  // 优先级：用户手选 > pass1 预识别 > LLM 自行 catalog 选
  const effectiveGenre = (!isAuto && manualGenre && manualGenre !== "auto")
    ? manualGenre
    : (preResolvedGenre && ALLOWED_GENRES.has(preResolvedGenre) ? preResolvedGenre : null);

  const appliedRuleSets = ["_common", `length/${lengthBucket}`];
  const blocks = [];
  const commonText = await loadMethodologyMd("_common.md");
  if (commonText) blocks.push(commonText);
  const lengthText = await loadMethodologyMd(`length/${lengthBucket}.md`);
  if (lengthText) blocks.push(lengthText);

  if (effectiveGenre && effectiveGenre !== "other") {
    const genreText = await loadMethodologyMd(`genre/${effectiveGenre}.md`);
    if (genreText) {
      blocks.push(genreText);
      appliedRuleSets.push(`genre/${effectiveGenre}`);
    }
  } else {
    // 没有预识别 + 用户也没指定 → 让 LLM 自己挑（fallback，理论上 two-pass 走通后不会进这里）
    const catalogLines = Object.entries(GENRE_CATALOG)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    blocks.push(
      `# 视频类型自动识别清单\n\n请从以下 7 类中选出一个最匹配的视频类型作为 detectedGenre。如果都不匹配填 "other"。\n\n${catalogLines}`
    );
  }

  return {
    text: blocks.join("\n\n---\n\n"),
    lengthBucket,
    appliedRuleSets,
    isAuto,
    forcedGenre: effectiveGenre,
  };
}
const YT_DLP_LATEST_REDIRECT = "https://github.com/yt-dlp/yt-dlp/releases/latest";
const YT_DLP_LATEST_DOWNLOAD = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

function bundledFfmpegPath() {
  try {
    const ffmpegStatic = require("ffmpeg-static");
    if (typeof ffmpegStatic === "string" && ffmpegStatic) return ffmpegStatic;
  } catch {
    // package not installed; fall through
  }
  return null;
}

function bundledFfprobePath() {
  try {
    const ffprobeStatic = require("ffprobe-static");
    const filePath = typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic?.path;
    if (typeof filePath === "string" && filePath) return filePath;
  } catch {
    // package not installed; fall through
  }
  return null;
}

function getBinDir() {
  return path.join(app.getPath("userData"), "bin");
}

function ytDlpAssetName() {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp_linux";
}

function ytDlpLocalPath() {
  return path.join(getBinDir(), ytDlpAssetName());
}

async function resolveYtDlp() {
  const local = ytDlpLocalPath();
  if (fsSync.existsSync(local)) return local;
  return await commandPath("yt-dlp");
}

const activeAnalyses = new Map();

class AnalysisCancelledError extends Error {
  constructor() {
    super("分析已取消");
    this.name = "AnalysisCancelledError";
  }
}

function registerAnalysis(projectId) {
  const handle = {
    abortController: new AbortController(),
    children: new Set(),
    cancelled: false,
  };
  activeAnalyses.set(projectId, handle);
  return handle;
}

function clearAnalysis(projectId) {
  const handle = activeAnalyses.get(projectId);
  if (handle?.heartbeat) clearInterval(handle.heartbeat);
  activeAnalyses.delete(projectId);
}

function cancelAnalysis(projectId) {
  const handle = activeAnalyses.get(projectId);
  if (!handle) return false;
  handle.cancelled = true;
  handle.abortController.abort();
  for (const child of handle.children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
  return true;
}

function ensureNotCancelled(handle) {
  if (handle?.cancelled) throw new AnalysisCancelledError();
}

function run(command, args, options = {}, handle = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (handle) handle.children.delete(child);
      if (handle?.cancelled) {
        reject(new AnalysisCancelledError());
        return;
      }
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (handle) handle.children.add(child);
  });
}

async function commandPath(command) {
  if (command === "ffmpeg") {
    const bundled = bundledFfmpegPath();
    if (bundled && fsSync.existsSync(bundled)) return bundled;
  }
  if (command === "ffprobe") {
    const bundled = bundledFfprobePath();
    if (bundled && fsSync.existsSync(bundled)) return bundled;
  }
  if (command === "yt-dlp") {
    const local = ytDlpLocalPath();
    if (fsSync.existsSync(local)) return local;
  }
  try {
    const { stdout } = await run("/bin/zsh", ["-lc", `command -v ${command}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function createMediaUrl(filePath) {
  return `media://local/${encodeURIComponent(filePath)}`;
}

function getYtDlpVersionCachePath() {
  return path.join(getBinDir(), "yt-dlp.version.json");
}

async function readCachedYtDlpVersion(binaryPath) {
  try {
    const cached = await readJson(getYtDlpVersionCachePath(), null);
    if (cached && cached.binaryPath === binaryPath && cached.version) {
      return cached.version;
    }
  } catch {
    // ignore
  }
  return null;
}

async function writeCachedYtDlpVersion(binaryPath, version) {
  try {
    await writeJson(getYtDlpVersionCachePath(), { binaryPath, version, cachedAt: new Date().toISOString() });
  } catch {
    // ignore
  }
}

async function getYtDlpVersion(binaryPath, { useCache = true, timeoutMs = 60000 } = {}) {
  if (!binaryPath) return null;
  if (useCache) {
    const cached = await readCachedYtDlpVersion(binaryPath);
    if (cached) return cached;
  }
  try {
    const { stdout } = await run(binaryPath, ["--version"], { timeout: timeoutMs });
    const version = stdout.trim();
    if (version) await writeCachedYtDlpVersion(binaryPath, version);
    return version || null;
  } catch {
    return null;
  }
}

async function fetchLatestYtDlpRelease() {
  // Use the redirect on /releases/latest to discover the tag without the rate-limited API.
  const response = await fetch(YT_DLP_LATEST_REDIRECT, {
    method: "HEAD",
    redirect: "follow",
    headers: { "user-agent": "video-analyzer-electron" },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}`);
  }
  const finalUrl = response.url || "";
  const match = finalUrl.match(/releases\/tag\/([^/?#]+)/);
  if (!match) throw new Error(`无法从 ${finalUrl} 解析版本号`);
  const version = decodeURIComponent(match[1]);
  return {
    version,
    assetUrl: `${YT_DLP_LATEST_DOWNLOAD}/${ytDlpAssetName()}`,
    htmlUrl: finalUrl,
  };
}

async function checkYtDlpUpdate() {
  const installed = await commandPath("yt-dlp");
  const installedVersion = installed ? await getYtDlpVersion(installed) : null;
  let latest = null;
  try {
    latest = await fetchLatestYtDlpRelease();
  } catch (error) {
    return {
      installed: !!installed,
      installedVersion,
      isBundled: installed === ytDlpLocalPath(),
      latestVersion: null,
      error: error?.message || String(error),
    };
  }
  const normalize = (v) => String(v || "").replace(/^v/, "").trim();
  const updateAvailable = !!installedVersion && !!latest.version && normalize(installedVersion) !== normalize(latest.version);
  return {
    installed: !!installed,
    installedVersion,
    isBundled: installed === ytDlpLocalPath(),
    latestVersion: latest.version,
    releaseUrl: latest.htmlUrl,
    updateAvailable,
  };
}

async function downloadYtDlp(onProgress = () => {}) {
  onProgress("resolve", "查询 yt-dlp 最新版本");
  const latest = await fetchLatestYtDlpRelease();
  await fs.mkdir(getBinDir(), { recursive: true });
  const target = ytDlpLocalPath();
  const tmp = `${target}.download`;

  onProgress("download", `下载 ${ytDlpAssetName()} ${latest.version}`);
  const response = await fetch(latest.assetUrl);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 ${response.status}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const writeHandle = await fs.open(tmp, "w");
  let received = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeHandle.write(value);
      received += value.byteLength;
      if (total) {
        onProgress("download", `${Math.round((received / total) * 100)}% (${(received / 1024 / 1024).toFixed(1)}MB)`);
      }
    }
  } finally {
    await writeHandle.close();
  }

  await fs.rename(tmp, target);
  if (process.platform !== "win32") {
    await fs.chmod(target, 0o755);
  }

  // Persist the version we just installed up-front. yt-dlp_macos is a PyInstaller bundle that
  // can take 20-30s on first launch (Gatekeeper scan + extracting the bundled python), so we
  // don't want to block the user on running it once just to discover the version.
  await writeCachedYtDlpVersion(target, latest.version);
  onProgress("done", `安装完成 ${latest.version}`);
  return {
    ok: true,
    binaryPath: target,
    installedVersion: latest.version,
    latestVersion: latest.version,
  };
}

async function directorySize(dirPath) {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const sub = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += await directorySize(sub).catch(() => 0);
    else if (entry.isFile()) {
      const stat = await fs.stat(sub).catch(() => null);
      if (stat) total += stat.size;
    }
  }
  return total;
}

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function getDbPath() {
  return path.join(app.getPath("userData"), "data.db");
}

function getProjectDir(projectId) {
  return path.join(app.getPath("userData"), "projects", projectId);
}

let _db = null;
function getDb() {
  if (_db) return _db;
  const dbPath = getDbPath();
  fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_nodes (
      project_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_reports (
      project_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
  _db = db;
  return db;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

// 把单个 v1 provider 转新 schema (含 source/models/[]/builtin)。幂等。
function migrateProviderV1(raw) {
  if (!raw || typeof raw !== "object") return null;
  // 已经是 v2 形态 (有 models 数组) 直接补 source 兜底
  if (Array.isArray(raw.models) && raw.models.length > 0) {
    const localWhisperEndpoint =
      raw.endpointType === "local_whisper_wasm" || raw.endpointType === "local_whisper_cpp";
    return {
      ...raw,
      source: raw.source || (localWhisperEndpoint ? "local_whisper" : "remote"),
    };
  }
  const endpointType = raw.endpointType || "openai_chat_completions";
  const isLocalWhisper =
    endpointType === "local_whisper_wasm" || endpointType === "local_whisper_cpp";
  const source = isLocalWhisper
    ? "local_whisper"
    : endpointType === "local_llama_server"
    ? "local_llama"
    : "remote";
  const isAudio = endpointType === "openai_audio_transcriptions" || isLocalWhisper;
  const capabilities = isAudio ? ["audio_transcription", "fast"] : ["vision", "reasoning"];
  const modelId = raw.model || raw.id;
  const model = {
    id: modelId,
    label: modelId,
    capabilities,
    maxOutputTokens: raw.maxOutputTokens,
    temperature: raw.temperature,
    localWhisperModel: raw.localWhisperModel,
    localWhisperMirror: raw.localWhisperMirror,
    language: raw.language,
  };
  return {
    id: raw.id,
    name: raw.name,
    source,
    builtin: false,
    baseUrl: raw.baseUrl || "",
    apiKeyRef: raw.apiKeyRef || "",
    endpointType,
    inputMode: raw.inputMode || "auto",
    models: [model],
    // 保留 deprecated 字段供仍依赖它们的旧代码读取(本批次 PR-1 仍有读取点)
    model: modelId,
    kind: raw.kind || (isAudio ? "audio" : "video"),
    localWhisperModel: raw.localWhisperModel,
    localWhisperMirror: raw.localWhisperMirror,
    language: raw.language,
    maxOutputTokens: raw.maxOutputTokens,
    temperature: raw.temperature,
  };
}

// builtin local_llama: 内置本地推理 provider,3 个 Qwen3.5-VL 规格。
// 每次 loadConfig 强制重写这个 entry,避免用户的旧配置把它覆盖。
function buildBuiltinLocalLlamaProvider() {
  const llamaRuntime = require("./llama-runtime.cjs");
  const models = Object.values(llamaRuntime.MODELS).map((meta) => ({
    id: meta.key,
    label: meta.name,
    capabilities: ["vision", "fast"],
    localKey: meta.key,
  }));
  return {
    id: "builtin-local-llama",
    name: "本地模型",
    source: "local_llama",
    builtin: true,
    baseUrl: "",
    apiKeyRef: "",
    endpointType: "local_llama_server",
    inputMode: "keyframe_sequence",
    models,
    // 保留 deprecated 字段
    model: models[0]?.id,
    kind: "video",
  };
}

// builtin local_whisper: 内置 whisper.cpp + ggml 模型 provider。
// 每次 loadConfig 都强制重写,把旧 transformers.js (Xenova/whisper-*) 配置自然替换掉。
function buildBuiltinLocalWhisperProvider() {
  const FAST_KEYS = new Set(["ggml-tiny", "ggml-base"]);
  const models = Object.values(whisperCppRuntime.MODELS).map((meta) => ({
    id: meta.key,
    label: meta.name,
    capabilities: FAST_KEYS.has(meta.key)
      ? ["audio_transcription", "fast"]
      : ["audio_transcription"],
    language: "zh",
  }));
  return {
    id: "builtin-local-whisper",
    name: "本地音频识别",
    source: "local_whisper",
    builtin: true,
    baseUrl: "",
    apiKeyRef: "",
    endpointType: "local_whisper_cpp",
    inputMode: "keyframe_sequence",
    models,
    // 保留 deprecated 字段供旧 audio 路径读取
    model: "ggml-base",
    kind: "audio",
    language: "zh",
  };
}

const TASK_SLOT_KEYS = [
  "simple_vision",
  "simple_text",
  "medium_vision",
  "medium_text",
  "complex_vision",
  "complex_text",
];

// 把 (config, slotKey) 解析成"看起来像 v1 ModelProvider"的 effective provider 对象,
// 供下游 callOpenAICompatible/callOpenAIResponses/transcribeAudio 等无感复用。
// local_llama 的 baseUrl 从 llama-runtime.getStatus().port 拼。
function resolveSlotProvider(config, slotKey) {
  const slot = config?.taskSlots?.[slotKey];
  if (!slot) return null;
  const provider = config.providers?.find((p) => p.id === slot.providerId);
  const model = provider?.models?.find((m) => m.id === slot.modelId);
  if (!provider || !model) return null;
  return shapeEffectiveProvider(provider, model);
}

function resolveAudioProvider(config) {
  const slot = config?.audioSlot;
  if (!slot) return null;
  const provider = config.providers?.find((p) => p.id === slot.providerId);
  const model = provider?.models?.find((m) => m.id === slot.modelId);
  if (!provider || !model) return null;
  return shapeEffectiveProvider(provider, model);
}

function shapeEffectiveProvider(provider, model) {
  let baseUrl = provider.baseUrl;
  let apiKeyRef = provider.apiKeyRef;
  if (provider.source === "local_llama") {
    const llamaRuntime = require("./llama-runtime.cjs");
    const status = llamaRuntime.getStatus();
    if (status?.running && status?.port) {
      baseUrl = `http://127.0.0.1:${status.port}/v1`;
      apiKeyRef = "local"; // llama-server 不验证 key
    }
  }
  return {
    ...provider,
    baseUrl,
    apiKeyRef,
    model: model.id,
    maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    temperature: model.temperature ?? provider.temperature,
    localWhisperModel: model.localWhisperModel || provider.localWhisperModel,
    localWhisperMirror: model.localWhisperMirror || provider.localWhisperMirror,
    language: model.language || provider.language,
  };
}

function emptyTaskSlots() {
  return TASK_SLOT_KEYS.reduce((acc, k) => ({ ...acc, [k]: null }), {});
}

// v1 → v2 迁移。幂等。
function migrateConfigV1ToV2(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const isV2 = cfg.schemaVersion === 2 && cfg.taskSlots && typeof cfg.taskSlots === "object";

  // 用户自定义 providers (剔除旧的 builtin id,后面强制注入)
  const rawProviders = Array.isArray(cfg.providers) ? cfg.providers : [];
  const userProviders = rawProviders
    .filter((p) => p && p.id !== "builtin-local-llama" && p.id !== "builtin-local-whisper" && p.id !== "local-whisper")
    .map(migrateProviderV1)
    .filter(Boolean);

  const providers = [
    buildBuiltinLocalLlamaProvider(),
    buildBuiltinLocalWhisperProvider(),
    ...userProviders,
  ];

  let taskSlots = emptyTaskSlots();
  let audioSlot = null;

  if (isV2) {
    // 已经是 v2,只是 builtin 被覆盖。slot 直接读 raw。
    for (const k of TASK_SLOT_KEYS) {
      taskSlots[k] = cfg.taskSlots[k] || null;
    }
    audioSlot = cfg.audioSlot || null;

    // builtin provider 重新注入后, audioSlot.modelId 可能指向已下线的 model id
    // (典型: 从 transformers.js 时代的 Xenova/whisper-* 升到 whisper.cpp 的 ggml-*)。
    // 兜底: 优先做 Xenova → ggml 映射, 否则落到 provider.models[0]。
    if (audioSlot?.providerId && audioSlot?.modelId) {
      const audioProv = providers.find((p) => p.id === audioSlot.providerId);
      if (audioProv) {
        const modelOk = audioProv.models.some((m) => m.id === audioSlot.modelId);
        if (!modelOk) {
          const xenovaToGgml = {
            "Xenova/whisper-tiny": "ggml-tiny",
            "Xenova/whisper-base": "ggml-base",
            "Xenova/whisper-small": "ggml-small",
            "Xenova/whisper-medium": "ggml-medium",
          };
          const mapped = xenovaToGgml[audioSlot.modelId];
          const fallback =
            (mapped && audioProv.models.find((m) => m.id === mapped)?.id) ||
            audioProv.models[0]?.id ||
            null;
          if (fallback) audioSlot = { providerId: audioSlot.providerId, modelId: fallback };
        }
      }
    }
  } else {
    // v1: 用 activeVideoProviderId/activeAudioProviderId 推 default 槽位
    const videoProviderId = cfg.activeVideoProviderId || null;
    const audioProviderId = cfg.activeAudioProviderId || null;
    const rawAudioProvider = rawProviders.find((p) => p && p.id === audioProviderId) || null;
    const findProvider = (id) => providers.find((p) => p.id === id);
    const videoProvider = videoProviderId ? findProvider(videoProviderId) : null;
    let audioProvider = audioProviderId ? findProvider(audioProviderId) : null;
    // local-whisper 旧 id 已被剔除,迁移到 builtin-local-whisper
    const wasLocalWhisper =
      rawAudioProvider?.endpointType === "local_whisper_wasm" ||
      rawAudioProvider?.endpointType === "local_whisper_cpp";
    if (!audioProvider && (audioProviderId === "local-whisper" || wasLocalWhisper)) {
      audioProvider = findProvider("builtin-local-whisper");
    }

    const complexVisionSlot = videoProvider
      ? { providerId: videoProvider.id, modelId: videoProvider.models[0]?.id }
      : null;
    const lastLlamaKey = cfg.lastLlamaModelKey || "qwen3_5_0_8b_q4km";
    const simpleVisionSlot = { providerId: "builtin-local-llama", modelId: lastLlamaKey };

    taskSlots.complex_vision = complexVisionSlot;
    taskSlots.simple_vision = simpleVisionSlot;
    taskSlots.simple_text = complexVisionSlot;
    taskSlots.medium_vision = complexVisionSlot;
    taskSlots.medium_text = complexVisionSlot;
    taskSlots.complex_text = complexVisionSlot;

    if (audioProvider) {
      // 优先用旧 provider 的 model id 在新 provider.models 里匹配。
      // transformers.js 时代的 Xenova/whisper-* → whisper.cpp 时代的 ggml-* 映射。
      const oldModelId = rawAudioProvider?.localWhisperModel || rawAudioProvider?.model || null;
      const xenovaToGgml = {
        "Xenova/whisper-tiny": "ggml-tiny",
        "Xenova/whisper-base": "ggml-base",
        "Xenova/whisper-small": "ggml-small",
        "Xenova/whisper-medium": "ggml-medium",
      };
      const mapped = oldModelId ? xenovaToGgml[oldModelId] || oldModelId : null;
      const match = mapped && audioProvider.models.find((m) => m.id === mapped);
      audioSlot = {
        providerId: audioProvider.id,
        modelId: match?.id || audioProvider.models[0]?.id,
      };
    } else {
      audioSlot = { providerId: "builtin-local-whisper", modelId: "ggml-base" };
    }
  }

  return {
    providers,
    taskSlots,
    audioSlot,
    lastLlamaModelKey: cfg.lastLlamaModelKey || null,
    schemaVersion: 2,
  };
}

function resolveProjectVideoPath(project) {
  if (project?.localFilePath) return project.localFilePath;
  if (project?.source?.type === "local_file") return project.source.originalPath;
  if (project?.localVideoPath?.startsWith("media://local/")) {
    const parsed = new URL(project.localVideoPath);
    return decodeURIComponent(parsed.pathname.slice(1));
  }
  return "";
}

function inferPlatform(source) {
  const value = String(source).toLowerCase();
  if (value.includes("douyin")) return "douyin";
  if (value.includes("xiaohongshu") || value.includes("xhslink") || value.includes("xhs")) return "xiaohongshu";
  if (value.includes("bilibili") || value.includes("b23.tv")) return "bilibili";
  if (value.includes("tiktok")) return "tiktok";
  return "unknown";
}

function getUrlCachePath() {
  return path.join(app.getPath("userData"), "url-cache.json");
}

async function readUrlCache() {
  try {
    const raw = await fs.readFile(getUrlCachePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUrlCache(cache) {
  try {
    await fs.writeFile(getUrlCachePath(), JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.warn("[url-cache] write failed", err);
  }
}

function getRotation(videoStream) {
  const tagRotation = Number(videoStream?.tags?.rotate);
  if (Number.isFinite(tagRotation)) return tagRotation;

  const displayMatrix = videoStream?.side_data_list?.find((item) =>
    typeof item?.rotation === "number"
  );
  return displayMatrix?.rotation ?? 0;
}

async function inspectVideo(filePath, handle = null) {
  const ffprobe = await commandPath("ffprobe");
  const fallback = {
    filePath,
    mediaUrl: createMediaUrl(filePath),
    filename: path.basename(filePath),
    durationSec: 0,
    width: 0,
    height: 0,
    orientation: "landscape",
    hasAudio: false,
  };

  if (!ffprobe) return fallback;

  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ], {}, handle);

  const payload = JSON.parse(stdout);
  const videoStream = payload.streams?.find((stream) => stream.codec_type === "video");
  const hasAudio = Boolean(payload.streams?.some((stream) => stream.codec_type === "audio"));
  const rotation = Math.abs(getRotation(videoStream)) % 180;
  const rawWidth = Number(videoStream?.width) || 0;
  const rawHeight = Number(videoStream?.height) || 0;
  const width = rotation === 90 ? rawHeight : rawWidth;
  const height = rotation === 90 ? rawWidth : rawHeight;
  const durationSec = Number(payload.format?.duration) || Number(videoStream?.duration) || 0;
  const orientation = width > height ? "landscape" : width < height ? "portrait" : "square";

  return {
    ...fallback,
    filePath,
    durationSec,
    width,
    height,
    rotation,
    orientation,
    hasAudio,
  };
}

// 用户接受的本地初筛 (prefilter) 时间预算 (秒), 按 density 档分级。
// candidateCount 由此推回, 而不是写死的帧数 —— 长视频自然扩张, 短视频不变,
// prefilter 时间被 budget 而非帧数硬顶。
const PREFILTER_BUDGET_SEC = {
  sparse: 30,
  standard: 60,
  dense: 120,
};
// 本地初筛单帧推理时间 (Qwen3.5-0.8B @ Apple Silicon Metal 实测 ~1.1s)。
// 后续可以改成基于 prefilterStats 滚动 EMA, 自适应不同模型 / 机器。
const PREFILTER_PER_FRAME_MS = 1100;

// 精筛后(送时间轴 + 主分析)的目标帧/节点数。
// 旧版死 cap 32, 长视频节点密度 ≤ 1/min 体感跳; 改成跟时长线性,
// 让 30min 视频也能产 100+ 节点骨架 (主分析帧数另由 token budget 限制, 见 callOpenAICompatible)。
function targetFrameCount(durationSec, options) {
  const density = options?.density || "standard";
  const mode = options?.mode || "standard";
  const base = density === "dense" ? 6 : density === "sparse" ? 2 : 4;
  const detailBoost = mode === "detailed" ? 1 : mode === "quick" ? -1 : 0;
  const durationMin = Math.max(0.5, durationSec / 60);
  const target = Math.round(durationMin * (base + detailBoost));
  // 上限不死 cap 32, 跟时长走但有合理上限 (4 节点/分钟做基础密度)。
  const upper = Math.max(32, Math.round(durationMin * 4));
  return Math.max(6, Math.min(upper, target));
}

// 候选抽帧数。本地初筛 ready 时多抽, 给初筛更多选材。
// 旧版死 cap 30 长视频被压扁; 改成 budget driven, 仍保 ≥ finalCount + 8 留去重空间。
function candidateFrameCount(durationSec, options, hasLocalPrefilter) {
  const finalCount = targetFrameCount(durationSec, options);
  if (!hasLocalPrefilter) return finalCount;
  const density = options?.density || "standard";
  const budgetSec = PREFILTER_BUDGET_SEC[density] ?? PREFILTER_BUDGET_SEC.standard;
  const capByBudget = Math.floor((budgetSec * 1000) / PREFILTER_PER_FRAME_MS);
  const desired = Math.max(Math.round(finalCount * 2.5), finalCount + 8);
  return Math.max(finalCount, Math.min(desired, capByBudget));
}

function sceneThresholdFor(options) {
  const density = options?.density || "standard";
  // ffmpeg select 的 scene 阈值，0~1，越小越敏感
  if (density === "dense") return 0.18;
  if (density === "sparse") return 0.45;
  return 0.3;
}

// 用 ffmpeg select='gt(scene,T)',showinfo 解析 pts_time，拿到镜头切换的时间戳列表。
async function detectScenes(ffmpeg, inputPath, threshold, handle) {
  const filter = `select='gt(scene,${threshold})',showinfo`;
  // 不写出帧文件，只跑 filter 拿 stderr 里的 showinfo 行
  let stderr = "";
  try {
    const result = await run(
      ffmpeg,
      ["-hide_banner", "-nostats", "-i", inputPath, "-vf", filter, "-f", "null", "-"],
      { maxBuffer: 16 * 1024 * 1024 },
      handle
    );
    stderr = result.stderr || "";
  } catch (error) {
    stderr = error?.stderr || "";
    if (handle?.cancelled) throw error;
    // showinfo 在某些 ffmpeg 版本会把 return code 标 1，但仍可解析 stderr
  }
  const matches = [...stderr.matchAll(/pts_time:([0-9.]+)/g)];
  const scenes = matches.map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t >= 0);
  // 第 0 秒永远算作第一个 scene 开始
  if (scenes.length === 0 || scenes[0] > 0.5) scenes.unshift(0);
  return scenes;
}

// 根据 scene 时间戳 + 目标帧数，分配最终抽帧时刻。
// 策略:
//   1. 每个 shot 先分 1 张(锚帧,中点)
//   2. 剩余配额按 "duration/(count+1)" 最大的 shot 不断加点(长镜头多分)
//   3. shot 内多张时按等距均分
//   4. shot 数本身 > target 时,挑 duration 最长的 target 个
function planFramePlan(scenes, durationSec, targetCount) {
  const safeDuration = Math.max(durationSec, 1);
  const sorted = [...new Set(scenes)].filter((t) => t < safeDuration).sort((a, b) => a - b);
  if (sorted.length === 0 || sorted[0] > 0.5) sorted.unshift(0);

  const shots = sorted
    .map((start, i) => {
      const end = sorted[i + 1] ?? safeDuration;
      return { start, end, duration: Math.max(0, end - start) };
    })
    .filter((s) => s.duration >= 0.4);

  // 兜底:没有合理 shot,均匀分布
  if (shots.length === 0) {
    return Array.from({ length: targetCount }, (_, i) => {
      const sec = (safeDuration * (i + 1)) / (targetCount + 1);
      return { index: i, startSec: sec, endSec: sec, midSec: Math.min(safeDuration - 0.1, sec) };
    });
  }

  // shot 数已 >= target,挑 duration 最长的
  if (shots.length >= targetCount) {
    const chosen = [...shots]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, targetCount)
      .map((shot) => ({ shot, sec: shot.start + shot.duration / 2 }));
    chosen.sort((a, b) => a.sec - b.sec);
    return chosen.map((p, index) => ({
      index,
      startSec: p.shot.start,
      endSec: p.shot.end,
      midSec: Math.min(safeDuration - 0.1, Math.max(0, p.sec)),
    }));
  }

  // 每 shot 分配采样数: 先各 1,剩余按 "duration / (count+1)" 贪心
  const counts = shots.map(() => 1);
  let remaining = targetCount - shots.length;
  while (remaining > 0) {
    let bestIdx = 0;
    let bestScore = shots[0].duration / (counts[0] + 1);
    for (let i = 1; i < shots.length; i++) {
      const score = shots[i].duration / (counts[i] + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    counts[bestIdx] += 1;
    remaining -= 1;
  }

  const picks = [];
  shots.forEach((shot, i) => {
    const n = counts[i];
    for (let k = 1; k <= n; k++) {
      const sec = shot.start + (shot.duration * k) / (n + 1);
      picks.push({ shot, sec });
    }
  });
  picks.sort((a, b) => a.sec - b.sec);
  return picks.map((p, index) => ({
    index,
    startSec: p.shot.start,
    endSec: p.shot.end,
    midSec: Math.min(safeDuration - 0.1, Math.max(0, p.sec)),
  }));
}

// 8x8 dHash：缩放到 9x8 灰度图，相邻像素比较生成 64bit 哈希。
// 用 ffmpeg 抽缩略图后我们在 JS 里读 jpeg 反编码代价高，所以让 ffmpeg 直接给我们 9x8 rawgray
async function dHashOfFrame(ffmpeg, inputPath, second, handle) {
  const result = await run(
    ffmpeg,
    [
      "-y",
      "-ss",
      String(Math.max(0, second)),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=9:8,format=gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 4096, encoding: "buffer" },
    handle
  );
  const buf = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "", "binary");
  if (buf.length < 72) return null;
  const bits = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = buf[row * 9 + col];
      const right = buf[row * 9 + col + 1];
      bits.push(left > right ? 1 : 0);
    }
  }
  return bits.join("");
}

function makeSilenceWav(seconds = 0.1) {
  const sampleRate = 16000;
  const numSamples = Math.max(1, Math.round(sampleRate * seconds));
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // body already zero-initialized = silence
  return buffer;
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function buildFrames(ffmpeg, inputPath, plan, artifactDir, handle, onProgress, { withPrefilterFrame = false } = {}) {
  const HAMMING_MIN_DISTINCT = 5;
  const out = [];
  let lastHash = null;
  let skipped = 0;
  for (let i = 0; i < plan.length; i++) {
    if (handle?.cancelled) throw new AnalysisCancelledError();
    const segment = plan[i];
    const framePath = path.join(artifactDir, `keyframe-${String(i + 1).padStart(2, "0")}.jpg`);
    onProgress?.(i, plan.length, segment.midSec);
    const hash = await dHashOfFrame(ffmpeg, inputPath, segment.midSec, handle);
    if (lastHash && hash && hammingDistance(hash, lastHash) < HAMMING_MIN_DISTINCT) {
      skipped++;
      continue;
    }
    await extractFrame(ffmpeg, inputPath, framePath, segment.midSec, 520, handle);
    let prefilterFramePath = null;
    if (withPrefilterFrame) {
      prefilterFramePath = path.join(artifactDir, `prefilter-${String(i + 1).padStart(2, "0")}.jpg`);
      await extractFrame(ffmpeg, inputPath, prefilterFramePath, segment.midSec, 320, handle, 5);
    }
    out.push({ ...segment, framePath, prefilterFramePath, hash });
    lastHash = hash || lastHash;
  }
  return { frames: out, skipped };
}

async function extractFrame(ffmpeg, inputPath, outputPath, second, width = 420, handle = null, qvalue = 3) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await run(ffmpeg, [
    "-y",
    "-ss",
    String(Math.max(0, second)),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    String(qvalue),
    outputPath,
  ], {}, handle);
}

// PR2 金字塔管线: 把 shots 里的 representativeFrameIndex / frames / subtitleSegments
// 按时间区间 overlap 匹配, 挂到大模型出的 nodes 上, 让 UI 能渲染镜头级 evidence。
function attachShotEvidenceToNodes(nodes, shots) {
  if (!Array.isArray(nodes) || !Array.isArray(shots)) return;
  for (const node of nodes) {
    const ns = Number(node.startSec);
    const ne = Number(node.endSec);
    if (!Number.isFinite(ns) || !Number.isFinite(ne)) continue;
    // 找时间区间 overlap 最大的 shot
    let best = null;
    let bestOverlap = 0;
    for (const s of shots) {
      const overlap = Math.max(0, Math.min(s.endSec, ne) - Math.max(s.startSec, ns));
      if (overlap > bestOverlap) {
        best = s;
        bestOverlap = overlap;
      }
    }
    if (!best) continue;

    const toFrameCtx = (f) => ({
      thumbnailUrl: createMediaUrl(f.framePath),
      framePath: f.framePath,
      midSec: f.midSec,
      caption: f.prefilterTag?.caption,
      salience: f.prefilterTag?.salience,
      signature: f.prefilterTag?.signature,
    });
    const repIdxs = Array.isArray(best.representativeFrameIndex) ? best.representativeFrameIndex : [];
    const repFrames = repIdxs
      .map((i) => best.frames[i])
      .filter(Boolean)
      .map(toFrameCtx);
    if (repFrames.length > 0) node.representativeFrames = repFrames;
    if (Array.isArray(best.frames) && best.frames.length > 0) {
      node.framesInShot = best.frames.map(toFrameCtx);
    }
    if (Array.isArray(best.subtitleSegments) && best.subtitleSegments.length > 0) {
      node.subtitleSegments = best.subtitleSegments.map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || ""),
      }));
    }
    // 用 shot 内代表帧 / 第一帧的 prefilterTag 覆盖按 fallbackNodes[index] 兜底挂错位的 tag
    // (主分析切的节点数跟 frames 不是 1:1, 旧逻辑 fallbackNodes[index] 会把 frame[0] 的 caption
    // 错挂到 node[0] 上, 即使该 frame 时间上不在 node[0] 区间内)
    const sourceFrame = best.frames[repIdxs[0]] || best.frames[0];
    if (sourceFrame?.prefilterTag) {
      node.prefilterTag = sourceFrame.prefilterTag;
    }
  }
}

// PR2 金字塔管线: 把精筛后的 frames + scenes + transcript 切成"镜头" 单元,
// 喂给 shot-merger 做合并。scenes 已经是相邻切换时间戳。
// 边界处理: 短于 0.4s 的极短 shot 跳过 (跟 planFramePlan 一致); 落到 shot 区间外的
// frame (理论上不该发生, dHash 跳过或边界四舍五入误差) 不参与, 由 fallback 兜底。
function buildShotsFromFrames(frames, scenes, durationSec, transcriptSegments) {
  const safeDuration = Math.max(durationSec || 0, 1);
  const sorted = [...new Set(scenes || [])].filter((t) => Number.isFinite(t) && t < safeDuration).sort((a, b) => a - b);
  if (sorted.length === 0 || sorted[0] > 0.5) sorted.unshift(0);

  const shots = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = sorted[i + 1] ?? safeDuration;
    if (end - start < 0.4) continue;
    const shotFrames = (frames || []).filter((f) => {
      const m = Number(f.midSec);
      return Number.isFinite(m) && m >= start && m < end;
    });
    const subSegs = Array.isArray(transcriptSegments)
      ? transcriptSegments.filter((s) => Number(s.end) > start && Number(s.start) < end)
      : [];
    const subtitleText = subSegs.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ");
    shots.push({
      shotIndex: shots.length,
      startSec: start,
      endSec: end,
      frames: shotFrames,
      subtitleText,
      subtitleSegments: subSegs,
    });
  }
  return shots;
}

// 仅当模型未返回结果时用作骨架节点；不再用位置百分比硬编码语义。
function localNodeForSegment(segment, project, frameUrl, transcriptSegments) {
  const id = segment.index + 1;
  const startSec = Number(segment.startSec.toFixed(2));
  const endSec = Number(segment.endSec.toFixed(2));
  // 把 transcript 中落在这一段时间区间内的文字拼起来，没有就空
  const subtitleText = Array.isArray(transcriptSegments)
    ? transcriptSegments
        .filter((s) => Number(s.end) > startSec && Number(s.start) < endSec)
        .map((s) => String(s.text || "").trim())
        .filter(Boolean)
        .join(" ")
    : "";

  return {
    id: `node-${id}`,
    startSec,
    endSec,
    title: `片段 ${id}`,
    nodeTypes: ["shot_change"],
    shotDescription: "等待模型生成镜头描述。",
    shotType: project.orientation === "portrait" ? "竖屏画幅" : "横屏画幅",
    cameraMovement: "未分析",
    visualElements: [],
    audioElements: subtitleText ? ["有人声"] : project.hasAudio === false ? ["无音轨"] : ["待分析"],
    subtitleText: subtitleText || undefined,
    editIntent: "等待模型生成剪辑意图。",
    emotionLabel: "未标注",
    emotionIntensity: 5,
    narrativeFunction: "未分析",
    confidence: 0.3,
    isHighlight: false,
    thumbnailUrl: frameUrl,
    prefilterTag: segment.prefilterTag || undefined,
  };
}

function buildLocalReport(project, nodes, provider, audioProvider, transcriptSummary, options) {
  const transcriptHint = transcriptSummary
    ? `音轨已转录 ${transcriptSummary.segmentCount ?? 0} 段（${transcriptSummary.language || "auto"}），但视觉模型未配置或失败，没有生成完整语义分析。`
    : "未启用语音转录，且视觉模型未配置或失败，结果仅基于场景检测的关键帧骨架。";

  const lengthBucket = computeLengthBucket(project.durationSec);
  const manualGenre = options?.manualGenre && options.manualGenre !== "auto" ? options.manualGenre : null;
  const appliedRuleSets = ["_common", `length/${lengthBucket}`];
  if (manualGenre && ALLOWED_GENRES.has(manualGenre) && manualGenre !== "other") {
    appliedRuleSets.push(`genre/${manualGenre}`);
  }

  return {
    summary: `已对 ${project.videoName} 完成场景切分和关键帧抽取（共 ${nodes.length} 个候选片段）。${transcriptHint}请在设置里配置视觉模型或语音模型后重新分析以获得完整结果。`,
    structure: {
      hook: nodes[0] ? `${Math.round(nodes[0].startSec)}-${Math.round(nodes[0].endSec)}s：候选片段 1` : "暂无",
      development: "等待模型分析",
      turn: "等待模型分析",
      climax: "等待模型分析",
      ending: nodes[nodes.length - 1] ? `${Math.round(nodes[nodes.length - 1].startSec)}-${Math.round(nodes[nodes.length - 1].endSec)}s：候选片段 ${nodes.length}` : "暂无",
    },
    pacing: `场景切分共识别 ${nodes.length} 个片段，平均时长约 ${Math.round((project.durationSec || 0) / Math.max(nodes.length, 1))} 秒。`,
    editingStyle: "等待模型分析。",
    composition: `${project.width}x${project.height}，${project.orientation}。等待模型分析具体构图风格。`,
    takeaways: [
      "当前结果只完成了场景切分 + 关键帧抽取，未生成节点级语义。",
      "在 设置 → 默认视觉模型 配置一个支持多图理解的 OpenAI 兼容模型后，可获得真实的剪辑意图/情绪/叙事分析。",
      "可选：在 设置 → 默认语音模型 配置 OpenAI 兼容 Whisper 接口，能给视觉模型补充语音上下文。",
    ],
    providerSnapshot: provider ? {
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      inputMode: provider.inputMode,
    } : undefined,
    audioProviderSnapshot: audioProvider ? {
      name: audioProvider.name,
      baseUrl: audioProvider.baseUrl,
      model: audioProvider.model,
    } : null,
    transcript: transcriptSummary ? {
      language: transcriptSummary.language,
      segmentCount: transcriptSummary.segmentCount,
      textPreview: transcriptSummary.textPreview,
    } : null,
    pipelineVersion: PIPELINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    methodologyAudit: {
      detectedGenre: manualGenre || "other",
      lengthBucket,
      appliedRuleSets,
      hits: [],
      violations: [],
      misses: [],
    },
  };
}

function tryParseJsonFromText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function sanitizeMethodologyTag(tag) {
  if (!tag || typeof tag !== "object") return null;
  const status = tag.status === "violation" ? "violation" : tag.status === "hit" ? "hit" : null;
  if (!status) return null;
  const ruleId = String(tag.ruleId || "").trim();
  if (!ruleId) return null;
  const confidence = Number.isFinite(Number(tag.confidence)) ? Math.max(0, Math.min(1, Number(tag.confidence))) : 0.6;
  // 软抗议过滤：confidence < 0.2 的 violation 视为「不适用」，drop 掉。
  // hit 不过滤，因为 hit 通常 confidence 都不低，而且 hit 多一些不伤。
  if (status === "violation" && confidence < 0.2) return null;
  return {
    ruleId,
    ruleName: String(tag.ruleName || ruleId),
    category: String(tag.category || "structure"),
    status,
    evidence: String(tag.evidence || ""),
    confidence,
    ...(status === "violation" && tag.fixSuggestion ? { fixSuggestion: String(tag.fixSuggestion) } : {}),
  };
}

function sanitizeMethodologyMiss(miss) {
  if (!miss || typeof miss !== "object") return null;
  const ruleId = String(miss.ruleId || "").trim();
  if (!ruleId) return null;
  return {
    ruleId,
    ruleName: String(miss.ruleName || ruleId),
    category: String(miss.category || "structure"),
    expectedAt: miss.expectedAt ? String(miss.expectedAt) : undefined,
    reason: String(miss.reason || ""),
    fixSuggestion: String(miss.fixSuggestion || ""),
  };
}

function normalizeModelResult(payload, fallbackNodes, fallbackReport, project, provider, methodology) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : fallbackNodes;
  const normalizedNodes = nodes.map((node, index) => {
    const tags = Array.isArray(node.methodologyTags)
      ? node.methodologyTags.map(sanitizeMethodologyTag).filter(Boolean)
      : [];
    const fallbackNode = fallbackNodes[Math.min(index, fallbackNodes.length - 1)] || {};
    return {
      ...fallbackNode,
      ...node,
      id: String(node.id || `node-${index + 1}`),
      startSec: Number.isFinite(Number(node.startSec)) ? Number(node.startSec) : fallbackNodes[index]?.startSec ?? 0,
      endSec: Number.isFinite(Number(node.endSec)) ? Number(node.endSec) : fallbackNodes[index]?.endSec ?? project.durationSec,
      visualElements: Array.isArray(node.visualElements) ? node.visualElements : fallbackNodes[index]?.visualElements ?? [],
      audioElements: Array.isArray(node.audioElements) ? node.audioElements : fallbackNodes[index]?.audioElements ?? [],
      nodeTypes: Array.isArray(node.nodeTypes) ? node.nodeTypes : fallbackNodes[index]?.nodeTypes ?? ["info_point"],
      isHighlight: Boolean(node.isHighlight),
      methodologyTags: tags,
      prefilterTag: fallbackNode.prefilterTag, // 始终用本地初筛结果,不允许 model 覆盖
    };
  });

  // Aggregate hits/violations from node-level tags into report.methodologyAudit
  const auditFromModel = payload?.report?.methodologyAudit || {};
  const allTags = normalizedNodes.flatMap((n) => n.methodologyTags || []);
  const hits = allTags.filter((t) => t.status === "hit");
  const violations = allTags.filter((t) => t.status === "violation");
  const misses = Array.isArray(auditFromModel.misses)
    ? auditFromModel.misses.map(sanitizeMethodologyMiss).filter(Boolean)
    : [];

  const forcedGenre = methodology?.forcedGenre && ALLOWED_GENRES.has(methodology.forcedGenre) ? methodology.forcedGenre : null;
  const rawDetected = String(auditFromModel.detectedGenre || "").trim();
  const detectedGenre = forcedGenre
    || (ALLOWED_GENRES.has(rawDetected) ? rawDetected : "other");

  const methodologyAudit = methodology ? {
    detectedGenre,
    lengthBucket: methodology.lengthBucket,
    appliedRuleSets: methodology.appliedRuleSets,
    hits,
    violations,
    misses,
    overallScore: Number.isFinite(Number(auditFromModel.overallScore))
      ? Math.max(0, Math.min(100, Number(auditFromModel.overallScore)))
      : undefined,
    genreConfidence: Number.isFinite(Number(auditFromModel.genreConfidence))
      ? Math.max(0, Math.min(1, Number(auditFromModel.genreConfidence)))
      : undefined,
  } : undefined;

  return {
    nodes: normalizedNodes.length ? normalizedNodes : fallbackNodes,
    report: {
      ...fallbackReport,
      ...(payload?.report || {}),
      methodologyAudit,
      providerSnapshot: provider ? {
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: provider.model,
        inputMode: provider.inputMode,
      } : undefined,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
    },
  };
}

function estimateTokenCost(framesCount, transcriptText) {
  // 粗估：每张 jpeg 关键帧 ≈ 250 vision token；transcript 按 1 字 ≈ 0.5 token（中英平均）
  return framesCount * 250 + Math.ceil(String(transcriptText || "").length * 0.5);
}

function trimTranscriptForBudget(transcriptText, segments, maxChars) {
  if (!transcriptText) return { text: "", segments: [] };
  const safeSegments = Array.isArray(segments) ? segments : [];
  if (transcriptText.length <= maxChars) return { text: transcriptText, segments: safeSegments };
  // 截前 60% + 后 40%，中间换 [...]
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen - 8;
  const head = transcriptText.slice(0, headLen);
  const tail = transcriptText.slice(-tailLen);
  // segments 按比例截一段头 + 一段尾
  let trimmedSegments = safeSegments;
  if (safeSegments.length > 0) {
    const ratio = maxChars / transcriptText.length;
    const target = Math.max(2, Math.floor(safeSegments.length * ratio));
    const headCount = Math.max(1, Math.floor(target * 0.6));
    const tailCount = Math.max(1, target - headCount);
    const headSeg = safeSegments.slice(0, headCount);
    const tailSeg = safeSegments.slice(-tailCount);
    const gapStart = headSeg[headSeg.length - 1]?.end ?? 0;
    const gapEnd = tailSeg[0]?.start ?? gapStart;
    trimmedSegments = [
      ...headSeg,
      { start: gapStart, end: gapEnd, text: "[...省略中段...]" },
      ...tailSeg,
    ];
  }
  return { text: `${head}\n[...省略中段...]\n${tail}`, segments: trimmedSegments };
}

// 从 detectScenes 输出的时间戳数组 + frames 反推完整镜头切换表。
// 标记哪些镜头被采样成了关键帧。
function buildShotListFromScenes(scenes, durationSec, frames) {
  const safeDuration = Math.max(Number(durationSec) || 0, 0);
  if (!safeDuration) return [];
  const sorted = [...new Set((Array.isArray(scenes) ? scenes : []).map(Number))]
    .filter((t) => Number.isFinite(t) && t >= 0 && t < safeDuration)
    .sort((a, b) => a - b);
  if (sorted[0] !== 0) sorted.unshift(0);
  const shots = sorted.map((start, i) => {
    const end = sorted[i + 1] ?? safeDuration;
    return { index: i, startSec: start, endSec: end, durationSec: end - start };
  });
  // 标记关键帧采样
  shots.forEach((shot) => {
    const fIndex = (frames || []).findIndex((f) => f.midSec >= shot.startSec && f.midSec < shot.endSec);
    if (fIndex >= 0) shot.sampledFrameIndex = fIndex + 1;
  });
  return shots;
}

function computeShotStats(shots, durationSec) {
  if (!shots.length) return null;
  const durations = shots.map((s) => s.durationSec).slice().sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const mean = sum / durations.length;
  const median = durations[Math.floor(durations.length / 2)];
  const variance = durations.reduce((acc, d) => acc + (d - mean) ** 2, 0) / durations.length;
  const stddev = Math.sqrt(variance);
  const minutes = Math.max(Number(durationSec) / 60, 1 / 60);
  return {
    count: shots.length,
    mean,
    median,
    stddev,
    minDur: durations[0],
    maxDur: durations[durations.length - 1],
    densityPerMin: shots.length / minutes,
    bucketShort: shots.filter((s) => s.durationSec < 2).length,
    bucketMid: shots.filter((s) => s.durationSec >= 2 && s.durationSec < 4).length,
    bucketLong: shots.filter((s) => s.durationSec >= 4).length,
  };
}

function formatShotListBlock(shots) {
  if (!shots.length) return "";
  // 限制最大行数避免 prompt 爆炸；对超长视频按段抽样
  const MAX_ROWS = 80;
  let displayShots = shots;
  if (shots.length > MAX_ROWS) {
    const step = shots.length / MAX_ROWS;
    displayShots = [];
    for (let i = 0; i < MAX_ROWS; i++) {
      displayShots.push(shots[Math.min(shots.length - 1, Math.floor(i * step))]);
    }
  }
  const head = "| # | start | end | dur | sampled |\n|---|---|---|---|---|";
  const lines = displayShots.map((s) =>
    `| ${s.index + 1} | ${s.startSec.toFixed(1)}s | ${s.endSec.toFixed(1)}s | ${s.durationSec.toFixed(1)}s | ${s.sampledFrameIndex ? `frame#${s.sampledFrameIndex}` : "—"} |`
  );
  const truncatedNote = shots.length > MAX_ROWS
    ? `\n（共 ${shots.length} 个镜头，上表按等距抽样展示 ${MAX_ROWS} 条；完整时长分布见统计区。）`
    : "";
  return `# 镜头切换全量列表（共 ${shots.length} 个镜头）\n\n${head}\n${lines.join("\n")}${truncatedNote}`;
}

function formatShotStatsBlock(stats) {
  if (!stats) return "";
  return [
    "# 镜头时长分布统计",
    `- 总镜头数: ${stats.count} | 平均: ${stats.mean.toFixed(2)}s | 中位: ${stats.median.toFixed(2)}s | 标准差: ${stats.stddev.toFixed(2)}s`,
    `- 最短: ${stats.minDur.toFixed(2)}s | 最长: ${stats.maxDur.toFixed(2)}s`,
    `- 切换密度: ${stats.densityPerMin.toFixed(1)} 次/分钟`,
    `- 时长分布桶: <2s: ${stats.bucketShort} 个 | 2-4s: ${stats.bucketMid} 个 | ≥4s: ${stats.bucketLong} 个`,
  ].join("\n");
}

function formatTranscriptBlock(transcript) {
  if (!transcript?.text) {
    return "# 音轨转录\n（无 / 未配置语音模型）";
  }
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  if (segments.length > 0) {
    const lines = segments.map((s) =>
      `[${Number(s.start || 0).toFixed(1)}-${Number(s.end || 0).toFixed(1)}] ${String(s.text || "").trim()}`
    );
    return `# 音轨转录（带时间戳，语言: ${transcript.language || "auto"}，共 ${segments.length} 段）\n${lines.join("\n")}`;
  }
  return `# 音轨转录（语言: ${transcript.language || "auto"}）\n${transcript.text}`;
}

async function buildAnalysisPrompt(project, frames, transcript, scenes, options) {
  const focusHint =
    options?.focus === "rhythm" ? "重点关注剪辑节奏、镜头切换密度、停顿停滞。" :
    options?.focus === "emotion" ? "重点关注情绪曲线、表达强度和观众共鸣点。" :
    options?.focus === "narrative" ? "重点关注叙事结构、信息递进、转折设置。" :
    "综合关注叙事结构、剪辑节奏、情绪曲线和画面信息。";
  const modeHint = options?.mode === "detailed" ? "拆解到尽可能细的镜头级。" : options?.mode === "quick" ? "只覆盖关键节点，不要面面俱到。" : "覆盖主要剪辑节点。";

  const frameDescriptions = frames.map((f, i) => {
    const cap = f.prefilterTag?.caption?.trim();
    const tag = f.prefilterTag?.signature?.trim();
    const meta = cap ? `  画面: ${cap}` : tag ? `  签名: ${tag}` : "";
    return `#${i + 1}  t=${f.midSec.toFixed(1)}s  范围 ${f.startSec.toFixed(1)}-${f.endSec.toFixed(1)}s${meta ? "\n" + meta : ""}`;
  }).join("\n");

  const shots = buildShotListFromScenes(scenes, project.durationSec, frames);
  const shotStats = computeShotStats(shots, project.durationSec);
  const shotListBlock = formatShotListBlock(shots);
  const shotStatsBlock = formatShotStatsBlock(shotStats);
  const transcriptBlock = formatTranscriptBlock(transcript);

  const methodology = await buildMethodologyContext(project.durationSec, options?.manualGenre, options?.detectedGenre);

  // 金字塔管线上下文 (PR2): 如果中间层 (shot-merger + summarizer) 已经把镜头/全局都合并好,
  // 把这些"已知 evidence"喂给大模型, 让它做评审而不是从零看视频。
  const pyramidBlock = (() => {
    const lines = [];
    if (options?.globalSummary) {
      lines.push("# 中间层产出 - 全局摘要");
      lines.push(options.globalSummary);
      if (options?.structureHint) {
        lines.push("");
        lines.push("中间层提供的结构线索 (供参考, 不一定准, 你要自己判断):");
        if (options.structureHint.hook) lines.push(`  开场 hook: ${options.structureHint.hook}`);
        if (options.structureHint.climax) lines.push(`  高潮: ${options.structureHint.climax}`);
        if (options.structureHint.ending) lines.push(`  结尾: ${options.structureHint.ending}`);
      }
    }
    if (Array.isArray(options?.shotContexts) && options.shotContexts.length > 0) {
      lines.push("");
      lines.push("# 中间层产出 - 镜头级描述 (medium 模型合并 帧 caption + 字幕)");
      lines.push("以下镜头描述已经综合了画面 + 字幕信息, 是你做剪辑审计的主要 evidence base。");
      options.shotContexts.forEach((sc, i) => {
        lines.push(`S${i + 1} [${sc.startSec.toFixed(1)}-${sc.endSec.toFixed(1)}s] 帧数=${sc.framesInShot}`);
        lines.push(`  画面: ${sc.shotDescription || "(空)"}`);
        if (sc.subtitleText) lines.push(`  字幕: ${sc.subtitleText}`);
      });
    }
    return lines.length > 0 ? lines.join("\n") : "";
  })();

  const userText = [
    `请分析视频《${project.videoName}》。`,
    `时长 ${Math.round(project.durationSec)}s（lengthBucket=${methodology.lengthBucket}）, 画幅 ${project.width}x${project.height} (${project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"})。`,
    `${focusHint} ${modeHint}`,
    "",
    pyramidBlock,
    pyramidBlock ? "" : null,
    "# 关键帧时间表（与下面图片顺序一一对应）",
    "(图片是 镜头描述/字幕 之外的视觉补充, 重点用来确认主体细节和画面构图; 数量受 token 预算限制, 不代表全部画面信息)",
    frameDescriptions,
    "",
    shotListBlock,
    "",
    shotStatsBlock,
    "",
    transcriptBlock,
    "",
    "# 剪辑方法论规则集（必读，分析时严格对照）",
    "下面是当前视频所属的时长档位 + 类型对应的剪辑方法论。每条规则有唯一 ruleId，例如 R-HOOK-001。",
    "你必须在分析时对照这些规则给视频打标：命中（hit）挂在对应节点的 methodologyTags 上；违反（violation）也挂在节点的 methodologyTags 上并给出 fixSuggestion；缺失（miss，即规则要求出现但视频里完全没有的）写到 report.methodologyAudit.misses 数组里（注意 miss 没有具体节点）。",
    "",
    methodology.text,
    "",
    "# 输出格式（必须严格遵守）",
    "请只返回 JSON（不要 markdown 围栏），结构如下：",
    `{
  "nodes":[
    {
      "id":"node-1",
      "startSec":0,
      "endSec":3,
      "title":"...",
      "nodeTypes":["shot_change"],
      "shotDescription":"...",
      "shotType":"近景",
      "cameraMovement":"固定",
      "visualElements":[],
      "audioElements":[],
      "editIntent":"...",
      "emotionLabel":"...",
      "emotionIntensity":7,
      "narrativeFunction":"Hook",
      "confidence":0.9,
      "isHighlight":true,
      "methodologyTags":[
        {"ruleId":"R-HOOK-001","ruleName":"黄金 3 秒钩子","category":"hook","status":"hit","evidence":"开头特写 + 字幕 'XX' + 旁白 'YY'","confidence":0.9},
        {"ruleId":"R-HOOK-002","ruleName":"钩子三层同步","category":"hook","status":"violation","evidence":"画面拍 A、字幕讲 B、旁白讲 C","confidence":0.8,"fixSuggestion":"统一首屏字幕和旁白都聚焦同一钩子"}
      ]
    }
  ],
  "report":{
    "summary":"...",
    "structure":{"hook":"...","development":"...","turn":"...","climax":"...","ending":"..."},
    "pacing":"...",
    "editingStyle":"...",
    "composition":"...",
    "takeaways":[],
    "methodologyAudit":{
      "detectedGenre":"vlog | review | travel | tutorial | knowledge | documentary | short-drama | other",
      "genreConfidence":0.9,
      "misses":[
        {"ruleId":"R-STRUCT-001","ruleName":"起承转合完整","category":"structure","expectedAt":"视频中后段","reason":"全片节奏一条直线，无明显转折","fixSuggestion":"在中后段补一个反转或对比"}
      ],
      "overallScore":78
    }
  }
}`,
    "",
    "硬性要求：",
    "- 时间戳 startSec/endSec 必须严格落在视频时长内，且节点按时间升序。可对照上面的「镜头切换全量列表」来确定节点边界。",
    "- methodologyTags 的 ruleId 必须来自上述方法论规则集，不要编造。",
    "- 每条 violation 必须给 fixSuggestion；每条 miss 必须给 fixSuggestion + reason。",
    "- evidence 必须引用具体画面/旁白/时间段（可引用镜头编号 #N 或字幕时间区间），不要写「看起来」「可能」这种含糊词。",
    "- detectedGenre 必须从清单中选一个；如果用户已在 prompt 中指定类型，把它原样回填。",
    "- overallScore 0-100，反映对应方法论的总体符合度。",
    "",
    "软约束（避免误报）：",
    "- 如果一条规则的 when 触发条件在本视频里前提不成立（例如规则只适用 8 分钟以上但本视频只有 6 分钟、或规则要求 BGM 存在但本视频没有 BGM），请直接跳过这条规则，既不要打 violation 也不要打 miss。",
    "- 如果一条规则的判断需要依赖你看不到的信号（例如 BGM beat sync 需要听到完整音轨节拍、但你只能看到关键帧 + 字幕），不要硬给 miss；可在 takeaways 里温和提示「无法基于现有素材判断」。",
    "- 节奏类规则（R-PACE-*、R-LONG-002/003 等）请优先依据上方「镜头切换全量列表 + 时长分布统计」客观数据判断，而非靠 12 张关键帧脑补。",
    "- 如果上方提供了「中间层产出」(全局摘要 + 镜头级描述), 它已经覆盖了画面+字幕的语义信息, 请把它作为主要 evidence base; 12 张关键帧只用来核对主体识别和构图细节, 不要把它当唯一信息源。",
  ].filter((line) => line !== null).join("\n");

  return { userText, methodology };
}

async function callOpenAICompatible(provider, project, frames, transcript, scenes, fallbackNodes, fallbackReport, options, handle = null) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    return { nodes: fallbackNodes, report: fallbackReport, usedModel: false };
  }

  // Token budget: 估计开销 + 截 transcript
  const maxBudget = 8000;
  let visibleTranscript = transcript;
  if (transcript?.text) {
    const trimmed = trimTranscriptForBudget(transcript.text, transcript.segments, 4000);
    visibleTranscript = { ...transcript, text: trimmed.text, segments: trimmed.segments };
  }
  const estimated = estimateTokenCost(Math.min(frames.length, 12), visibleTranscript?.text || "");
  if (estimated > maxBudget) {
    const maxImages = Math.max(4, Math.floor((maxBudget - (visibleTranscript?.text || "").length * 0.5) / 250));
    frames = frames.slice(0, maxImages);
  } else {
    frames = frames.slice(0, 12);
  }

  const imageDataUrls = [];
  for (const frame of frames) {
    const base64 = await fs.readFile(frame.framePath, "base64");
    imageDataUrls.push(`data:image/jpeg;base64,${base64}`);
  }

  const { userText, methodology } = await buildAnalysisPrompt(project, frames, visibleTranscript, scenes, options);
  const systemText =
    "你是一名严谨的视频拉片分析师。你既要描述视频内容，又要严格按照提供的剪辑方法论规则集对视频打标（命中 / 违反 / 缺失）。所有回答必须是合法 JSON，不要使用 Markdown 围栏，不要解释。";

  const useResponses = provider.endpointType === "openai_responses";
  const parsed = useResponses
    ? await callOpenAIResponses(provider, systemText, userText, imageDataUrls, handle)
    : await callOpenAIChatCompletions(provider, systemText, userText, imageDataUrls, handle);

  return { ...normalizeModelResult(parsed, fallbackNodes, fallbackReport, project, provider, methodology), usedModel: true };
}

// Pass 1（轻量、无图）：仅靠字幕分段 + 镜头列表识别 genre。失败时返回 null。
async function detectGenreLightweight(provider, project, scenes, transcript, handle = null) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) return null;
  const shots = buildShotListFromScenes(scenes, project.durationSec, []);
  const stats = computeShotStats(shots, project.durationSec);
  const shotListBlock = formatShotListBlock(shots);
  const shotStatsBlock = formatShotStatsBlock(stats);
  const transcriptBlock = formatTranscriptBlock(transcript);
  const catalogLines = Object.entries(GENRE_CATALOG)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const systemText = "你是一名严谨的视频类型识别助手。基于提供的字幕分段（带时间戳）和镜头切换数据推断视频类型。只返回合法 JSON，不要 markdown 围栏，不要解释。";
  const userText = [
    `请基于以下信息推断视频《${project.videoName}》的类型。`,
    `视频时长 ${Math.round(project.durationSec)}s，画幅 ${project.width}x${project.height}（${project.orientation}）。`,
    "",
    shotListBlock,
    "",
    shotStatsBlock,
    "",
    transcriptBlock,
    "",
    "# 候选类型清单",
    catalogLines,
    "- other: 都不匹配",
    "",
    "请只返回 JSON：",
    `{"detectedGenre":"vlog|review|travel|tutorial|knowledge|documentary|short-drama|other","genreConfidence":0.0-1.0,"reasoning":"..."}`,
  ].join("\n");

  try {
    const useResponses = provider.endpointType === "openai_responses";
    const parsed = useResponses
      ? await callOpenAIResponses(provider, systemText, userText, [], handle)
      : await callOpenAIChatCompletions(provider, systemText, userText, [], handle);
    const genre = String(parsed?.detectedGenre || "").trim();
    if (!ALLOWED_GENRES.has(genre)) return null;
    const conf = Number(parsed?.genreConfidence);
    return {
      detectedGenre: genre,
      genreConfidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      reasoning: String(parsed?.reasoning || "").slice(0, 500),
    };
  } catch (error) {
    if (handle?.cancelled) throw error;
    return null;
  }
}

async function streamSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // skip malformed chunk
      }
    }
  }
}

async function callOpenAIChatCompletions(provider, systemText, userText, imageDataUrls, handle) {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: handle?.abortController?.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKeyRef}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: provider.model,
      stream: true,
      temperature: provider.temperature ?? 0.2,
      max_tokens: provider.maxOutputTokens ?? 12000,
      messages: [
        { role: "system", content: systemText },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败 ${response.status}: ${detail.slice(0, 500)}`);
  }
  let text = "";
  await streamSSE(response, (event) => {
    const delta = event?.choices?.[0]?.delta?.content;
    if (typeof delta === "string") text += delta;
  });
  return tryParseJsonFromText(text);
}

async function callOpenAIResponses(provider, systemText, userText, imageDataUrls, handle) {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: handle?.abortController?.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKeyRef}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: provider.model,
      stream: true,
      temperature: provider.temperature ?? 0.2,
      max_output_tokens: provider.maxOutputTokens ?? 12000,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemText }],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: userText },
            ...imageDataUrls.map((url) => ({ type: "input_image", image_url: url })),
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败 ${response.status}: ${detail.slice(0, 500)}`);
  }
  let text = "";
  await streamSSE(response, (event) => {
    // Responses stream events: response.output_text.delta carries { delta: "..." }
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
    }
    // Some gateways emit completed response with final output array
    if (event?.type === "response.completed" && Array.isArray(event?.response?.output)) {
      if (!text) {
        for (const item of event.response.output) {
          if (item?.type === "message" && Array.isArray(item.content)) {
            for (const block of item.content) {
              if ((block?.type === "output_text" || block?.type === "text") && typeof block.text === "string") {
                text += block.text;
              }
            }
          }
        }
      }
    }
  });
  return tryParseJsonFromText(text);
}

async function extractAudioWav(ffmpeg, inputPath, outputPath, handle) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await run(
    ffmpeg,
    ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath],
    {},
    handle
  );
}

async function transcribeAudio(audioProvider, wavPath, handle, onProgress) {
  if (!audioProvider) return null;
  // local_whisper_wasm 是老 schema 残留, 与新 local_whisper_cpp 都走 whisper.cpp 后端
  if (
    audioProvider.endpointType === "local_whisper_cpp" ||
    audioProvider.endpointType === "local_whisper_wasm" ||
    audioProvider.source === "local_whisper"
  ) {
    return transcribeLocalWhisperCpp(audioProvider, wavPath, handle, onProgress);
  }
  if (!audioProvider.baseUrl || !audioProvider.apiKeyRef || !audioProvider.model) {
    return null;
  }
  const fileBytes = await fs.readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: "audio/wav" }), "audio.wav");
  form.append("model", audioProvider.model);
  form.append("response_format", "verbose_json");
  if (audioProvider.language) form.append("language", audioProvider.language);

  const endpoint = `${audioProvider.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: handle?.abortController?.signal,
    headers: { authorization: `Bearer ${audioProvider.apiKeyRef}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${response.status}: ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const segments = Array.isArray(data?.segments)
    ? data.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || "").trim() }))
    : [];
  const fullText = typeof data?.text === "string" ? data.text.trim() : segments.map((s) => s.text).join(" ").trim();
  return {
    language: data?.language || audioProvider.language || null,
    text: fullText,
    segments,
    duration: Number(data?.duration) || 0,
  };
}

// 把任意旧/新 modelId 规范化成 whisper.cpp 的 ggml-* key。
// 老 Xenova/whisper-* 配置在 migrate 时已经被改写, 这里是双保险。
function normalizeWhisperCppModelId(rawId) {
  if (!rawId) return "ggml-base";
  const xenovaMap = {
    "Xenova/whisper-tiny": "ggml-tiny",
    "Xenova/whisper-base": "ggml-base",
    "Xenova/whisper-small": "ggml-small",
    "Xenova/whisper-medium": "ggml-medium",
  };
  return xenovaMap[rawId] || rawId;
}

async function transcribeLocalWhisperCpp(audioProvider, wavPath, handle, onProgress) {
  const modelId = normalizeWhisperCppModelId(
    audioProvider.localWhisperModel || audioProvider.model,
  );
  // 没下过模型就先下
  const status = await whisperCppRuntime.listModels();
  const target = status.find((m) => m.key === modelId);
  if (!target) throw new Error(`未知 whisper.cpp 模型: ${modelId}`);
  if (!target.downloaded) {
    if (onProgress) onProgress({ stage: "download", message: `${target.name} 首次使用,下载模型中` });
    await whisperCppRuntime.ensureModel(modelId, (p) => {
      if (p.percent != null && onProgress) {
        onProgress({ stage: "download", message: p.message });
      }
    });
  }
  const transcriber = getTranscriber("whisper_cpp");
  return transcriber.transcribe({
    wavPath,
    modelId,
    language: audioProvider.language || null,
    onProgress,
    handle,
  });
}

async function warmupLocalWhisperCpp(audioProvider) {
  const modelId = normalizeWhisperCppModelId(
    audioProvider.localWhisperModel || audioProvider.model,
  );
  const t0 = Date.now();
  // ensureBinary 不存在 → 提示开发者跑 build script
  if (!whisperCppRuntime.resolveBinaryPath()) {
    throw new Error(
      "找不到 whisper-server 可执行文件,请先运行 scripts/build-whisper-cpp.sh 编译。",
    );
  }
  const models = await whisperCppRuntime.listModels();
  const target = models.find((m) => m.key === modelId);
  if (!target) throw new Error(`未知 whisper.cpp 模型: ${modelId}`);
  if (!target.downloaded) {
    await whisperCppRuntime.ensureModel(modelId);
  }
  await whisperCppRuntime.start(modelId);
  return { modelId, elapsedMs: Date.now() - t0 };
}

async function analyzeProject(event, { project, provider: _legacyProvider, audioProvider: _legacyAudio, options }) {
  if (activeAnalyses.has(project.id)) {
    throw new Error("该项目已有分析任务在运行。");
  }
  // 在管线开始时一次性快照 config + 从 taskSlots/audioSlot 解析各任务的 effective provider,
  // 避免运行中用户改设置导致竞争。renderer 传入的 provider/audioProvider 入参作废。
  const cfgSnapshot = migrateConfigV1ToV2(await readJson(getConfigPath(), null));
  const complexVisionProvider = resolveSlotProvider(cfgSnapshot, "complex_vision");
  const mediumTextProvider = resolveSlotProvider(cfgSnapshot, "medium_text");
  const audioProvider = resolveAudioProvider(cfgSnapshot);
  // 兼容旧主流程变量名
  const provider = complexVisionProvider;
  const handle = registerAnalysis(project.id);
  const analysisStartedAt = Date.now();

  // 阶段耗时记录:每次 send 检测 stage 字符串变化,把上一个 stage 的 duration 推入
  const timings = [];
  let currentStage = null;
  let currentStageStartedAt = analysisStartedAt;
  const closeCurrentStage = (note) => {
    if (currentStage) {
      timings.push({
        stage: currentStage,
        durationMs: Date.now() - currentStageStartedAt,
        ...(note ? { note } : {}),
      });
    }
  };
  handle.timings = timings;

  const send = (progress, stage, message) => {
    if (handle.cancelled) return;
    if (stage !== currentStage) {
      closeCurrentStage();
      currentStage = stage;
      currentStageStartedAt = Date.now();
    }
    const payload = { projectId: project.id, progress, stage, message };
    handle.lastProgress = payload;
    handle.lastProgressAt = Date.now();
    event.sender.send("analysis:progress", payload);
  };

  // 心跳:某些阶段(本地 whisper 加载/推理)单次任务 30s+,
  // 中间没有事件 UI 看起来卡死。每 2s 重发最近一次 progress 并附累计等待时长。
  const heartbeat = setInterval(() => {
    if (handle.cancelled || !handle.lastProgress) return;
    const idle = Date.now() - (handle.lastProgressAt || 0);
    if (idle < 1500) return;
    const elapsed = Math.floor(idle / 1000);
    const base = handle.lastProgress;
    const baseMsg = base.message || "";
    // 已经带过 "已等待 Ns" 后缀,只更新数字
    const stripped = baseMsg.replace(/\s*·?\s*已等待 \d+s$/, "");
    const msg = stripped ? `${stripped} · 已等待 ${elapsed}s` : `已等待 ${elapsed}s`;
    event.sender.send("analysis:progress", { ...base, message: msg });
  }, 2000);
  handle.heartbeat = heartbeat;

  try {
    const inputPath = resolveProjectVideoPath(project);
    if (!inputPath || !fsSync.existsSync(inputPath)) {
      throw new Error("找不到本地视频文件，无法开始分析。");
    }

    const ffmpeg = await commandPath("ffmpeg");
    const ffprobe = await commandPath("ffprobe");
    if (!ffmpeg || !ffprobe) {
      throw new Error("未检测到 ffmpeg/ffprobe，无法生成关键帧和媒体清单。");
    }

    send(5, "读取视频信息", "正在校验视频时长、分辨率、音轨。");
    ensureNotCancelled(handle);
    const inspected = await inspectVideo(inputPath, handle);
    const projectDir = getProjectDir(project.id);
    const artifactDir = path.join(projectDir, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    const projectMeta = { ...project, ...inspected, hasAudio: inspected.hasAudio };

    send(12, "检测镜头切换", "扫描视频中的镜头切换点。");
    ensureNotCancelled(handle);
    const sceneThreshold = sceneThresholdFor(options);
    const scenes = await detectScenes(ffmpeg, inputPath, sceneThreshold, handle);
    // 本地初筛预检: 用户希望用(lastLlamaModelKey 存在) → 主动确认/启动 server,
    // 失败一律降级为"跳过初筛但继续分析",绝不阻断主流程。
    let localStatus = llamaRuntime.getStatus();
    let localPrefilterReady = !!(localStatus.running && localStatus.port);
    if (!localPrefilterReady) {
      const cfg = await readJson(getConfigPath(), null).catch(() => null);
      const preferredModel = cfg?.lastLlamaModelKey;
      if (preferredModel) {
        if (!localStatus.binaryFound) {
          send(10, "本地推理预检", "推理引擎未安装,本次跳过初筛(去设置 → 本地推理可安装)。");
        } else {
          const models = await llamaRuntime.listModels();
          const target = models.find((m) => m.key === preferredModel);
          if (!target || !target.downloaded) {
            send(10, "本地推理预检", `模型 ${preferredModel} 未下载完成,本次跳过初筛。`);
          } else if (localStatus.status === "starting") {
            send(10, "本地推理预检", "本地模型启动中,等待就绪(最多 15 秒)。");
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 500));
              localStatus = llamaRuntime.getStatus();
              if (localStatus.running) break;
              ensureNotCancelled(handle);
            }
            localPrefilterReady = !!(localStatus.running && localStatus.port);
            if (!localPrefilterReady) {
              send(10, "本地推理预检", "本地模型 15 秒内未就绪,本次跳过初筛。");
            }
          } else {
            send(10, "本地推理预检", `本地模型未启动,正在自动拉起 ${preferredModel}…`);
            try {
              await llamaRuntime.start(preferredModel);
              localStatus = llamaRuntime.getStatus();
              localPrefilterReady = !!(localStatus.running && localStatus.port);
            } catch (error) {
              send(10, "本地推理预检", `本地模型启动失败: ${error?.message || error}。本次跳过初筛。`);
            }
          }
        }
      }
    }
    const finalCount = targetFrameCount(inspected.durationSec || project.durationSec || 1, options);
    const candidateCount = candidateFrameCount(
      inspected.durationSec || project.durationSec || 1,
      options,
      localPrefilterReady,
    );
    const plan = planFramePlan(scenes, inspected.durationSec || project.durationSec || 1, candidateCount);
    send(
      20,
      "挑选关键画面",
      localPrefilterReady
        ? `本地初筛已就绪,从 ${scenes.length} 个镜头里先抽 ${plan.length} 张候选。`
        : `从 ${scenes.length} 个镜头里挑出 ${plan.length} 张关键画面。`,
    );

    await writeJson(path.join(projectDir, "media-manifest.json"), {
      source: project.source,
      filePath: inputPath,
      durationSec: inspected.durationSec,
      width: inspected.width,
      height: inspected.height,
      orientation: inspected.orientation,
      hasAudio: inspected.hasAudio,
      scenes,
      plan,
      sceneThreshold,
      finalFrameCount: finalCount,
      candidateFrameCount: candidateCount,
      localPrefilterReady,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
    });

    send(24, "抽取关键画面", `准备抽取 ${plan.length} 张关键画面,会自动去掉相似画面。`);
    const { frames: candidateFrames, skipped } = await buildFrames(
      ffmpeg,
      inputPath,
      plan,
      artifactDir,
      handle,
      (i, total, sec) => {
        send(24 + Math.round((i / total) * 22), "抽取关键画面", `已抽 ${i + 1} / ${total} 张 · 第 ${sec.toFixed(1)} 秒`);
      },
      { withPrefilterFrame: localPrefilterReady },
    );
    if (skipped > 0) {
      send(46, "画面去重", `去掉 ${skipped} 张相似画面,保留 ${candidateFrames.length} 张。`);
    }

    // 本地初筛 + 精筛:让 Qwen3.5-0.8B 给每帧打标,据此 dedup / 删空镜 / cap 总数。
    // 本地模型未启动时直接走老路径,行为与之前一致。
    let frames = candidateFrames;
    let prefilterStats = null;
    if (localPrefilterReady && candidateFrames.length > 0) {
      try {
        send(48, "本地初筛", `让本地模型给 ${candidateFrames.length} 张候选画面快速打标。`);
        const prefilterStartedAt = Date.now();
        const tagResult = await prefilter.tagFrames(candidateFrames, {
          port: localStatus.port,
          modelKey: localStatus.modelKey,
          perFrameTimeoutMs: 30_000,
          onProgress: (i, total) => {
            ensureNotCancelled(handle);
            const avgMs = Math.round((Date.now() - prefilterStartedAt) / (i + 1));
            send(
              48 + Math.round(((i + 1) / total) * 6),
              "本地初筛",
              `已打标 ${i + 1} / ${total} 张 · 平均 ${avgMs} ms/帧`,
            );
          },
        });
        const refined = prefilter.refineByTags(tagResult.frames, {
          maxKeep: finalCount,
          minKeep: Math.min(4, candidateFrames.length),
          similarityThreshold: 0.7,
        });
        frames = refined.kept;
        prefilterStats = {
          totalElapsedMs: tagResult.totalElapsedMs,
          totalTokens: tagResult.totalTokens,
          candidate: candidateFrames.length,
          kept: refined.kept.length,
          dropped: refined.dropped.length,
        };
        send(
          54,
          "精挑画面",
          `从 ${candidateFrames.length} 张候选里精选 ${refined.kept.length} 张送给视觉模型 · 本地初筛用时 ${(tagResult.totalElapsedMs / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        if (error instanceof AnalysisCancelledError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        send(54, "本地初筛失败", `${msg}（已回退到全部候选画面）`);
        frames = candidateFrames;
      }
    }

    // 音频转录（可选）
    let transcript = null;
    let transcriptError = null;
    const audioReady = audioProvider && inspected.hasAudio && (
      audioProvider.source === "local_whisper" ||
      audioProvider.endpointType === "local_whisper_cpp" ||
      audioProvider.endpointType === "local_whisper_wasm" ||
      audioProvider.apiKeyRef
    );
    if (audioReady) {
      try {
        send(55, "提取音轨", "从视频里分离出音频,准备识别字幕。");
        const wavPath = path.join(artifactDir, "audio.wav");
        await extractAudioWav(ffmpeg, inputPath, wavPath, handle);
        send(60, "字幕识别", `${audioProvider.name} 准备就绪`);
        ensureNotCancelled(handle);
        transcript = await transcribeAudio(audioProvider, wavPath, handle, (p) => {
          send(62, "字幕识别", p.message);
        });
        if (transcript) {
          await writeJson(path.join(artifactDir, "transcript.json"), transcript);
          send(66, "字幕识别完成", `共 ${transcript.segments.length} 段字幕、${transcript.text.length} 个字。`);
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        transcriptError = error?.message || String(error);
        send(66, "字幕识别失败", `${transcriptError}（不影响后续画面分析）`);
      }
    }

    const fallbackNodes = frames.map((frame) =>
      localNodeForSegment(
        frame,
        projectMeta,
        createMediaUrl(frame.framePath),
        transcript?.segments
      )
    );
    const transcriptSummary = transcript
      ? {
          language: transcript.language,
          segmentCount: transcript.segments.length,
          textPreview: transcript.text.slice(0, 240),
        }
      : null;
    const fallbackReport = buildLocalReport(projectMeta, fallbackNodes, provider, audioProvider, transcriptSummary, options);

    // 金字塔管线 (PR2): 镜头合并 + 全局聚合, 输出 shotContexts/globalSummary 给主分析。
    // medium_text 不可用时整段跳过, 走 detectGenreLightweight 兜底; 失败一律降级不阻断。
    let shots = buildShotsFromFrames(frames, scenes, projectMeta.durationSec || project.durationSec || 1, transcript?.segments);
    let shotContexts = null;
    let globalContext = null;
    const canUseMedium =
      mediumTextProvider?.apiKeyRef &&
      mediumTextProvider?.baseUrl &&
      mediumTextProvider?.model &&
      shots.length > 0;
    if (canUseMedium) {
      try {
        ensureNotCancelled(handle);
        send(67, "镜头合并", `让 ${mediumTextProvider.name} 把 ${shots.length} 个镜头合成可读描述。`);
        const mergeStart = Date.now();
        const mergeInputs = shots.map((s) => ({
          startSec: s.startSec,
          endSec: s.endSec,
          subtitleText: s.subtitleText || "",
          frames: s.frames.map((f) => ({
            caption: f.prefilterTag?.caption,
            subject: f.prefilterTag?.subject,
            signature: f.prefilterTag?.signature,
            salience: f.prefilterTag?.salience,
            midSec: f.midSec,
          })),
        }));
        const mergeResults = await shotMerger.mergeShots({
          shots: mergeInputs,
          provider: mediumTextProvider,
          batchSize: 6,
          handle,
          onProgress: ({ done, total, batchIndex }) => {
            ensureNotCancelled(handle);
            const pct = 67 + Math.round((done / total) * 4);
            send(pct, "镜头合并", `已合并 ${done}/${total} (batch ${batchIndex}, 平均 ${Math.round((Date.now()-mergeStart)/done)}ms/镜头)`);
          },
        });
        // 写回 shots: shotDescription + representativeFrameIndex
        for (let i = 0; i < shots.length; i++) {
          shots[i].shotDescription = mergeResults[i]?.shotDescription || "";
          shots[i].representativeFrameIndex = mergeResults[i]?.representativeFrameIndex || [];
        }
        shotContexts = shots.map((s) => ({
          shotIndex: s.shotIndex,
          startSec: s.startSec,
          endSec: s.endSec,
          shotDescription: s.shotDescription,
          framesInShot: s.frames.length,
          subtitleText: s.subtitleText || undefined,
        }));
        send(71, "镜头合并完成", `${shots.length} 个镜头描述就绪 · ${((Date.now()-mergeStart)/1000).toFixed(1)}s`);
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(71, "镜头合并失败", `${error.message || error}。降级到旧的逐帧路径。`);
        shotContexts = null;
      }

      // 全局聚合 (genre + summary): shotContexts 在手时做, 否则跳过让 detectGenreLightweight 兜底
      if (shotContexts && shotContexts.length > 0) {
        try {
          ensureNotCancelled(handle);
          send(72, "全局聚合", `综合 ${shotContexts.length} 个镜头描述 + 字幕推断视频类型和摘要。`);
          const sumStart = Date.now();
          const stats = computeShotStats(
            buildShotListFromScenes(scenes, projectMeta.durationSec, []),
            projectMeta.durationSec,
          );
          globalContext = await summarizer.summarizeVideo({
            shotContexts,
            transcript,
            shotStats: stats,
            project: projectMeta,
            provider: mediumTextProvider,
            genreCatalog: GENRE_CATALOG,
            allowedGenres: [...ALLOWED_GENRES],
            handle,
          });
          if (globalContext?.detectedGenre) {
            send(74, "全局聚合完成", `判定 ${globalContext.detectedGenre} (${Math.round((globalContext.genreConfidence||0)*100)}%) · 摘要 ${globalContext.globalSummary?.length || 0} 字 · ${((Date.now()-sumStart)/1000).toFixed(1)}s`);
          } else {
            send(74, "全局聚合跳过", "未能从镜头描述推断, 让主分析自行识别。");
          }
        } catch (error) {
          if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
          send(74, "全局聚合失败", `${error.message || error}。降级到 detectGenreLightweight。`);
          globalContext = null;
        }
      }
    }

    let nodes = fallbackNodes;
    let report = fallbackReport;
    ensureNotCancelled(handle);
    send(76, "准备分析素材", provider?.apiKeyRef ? `已整理好 ${frames.length} 张关键画面${transcript ? " + 字幕" : ""}${shotContexts ? ` + ${shotContexts.length} 个镜头描述` : ""},准备送给模型。` : "未配置视觉模型,本次只生成时间线骨架。");

    if (provider?.apiKeyRef && provider.inputMode !== "direct_video") {
      try {
        ensureNotCancelled(handle);

        let effectiveOptions = options;
        const isAutoGenre = !options?.manualGenre || options.manualGenre === "auto";

        // Genre 优先级: globalContext > detectGenreLightweight fallback > 让主分析在 catalog 里判
        if (globalContext?.detectedGenre) {
          effectiveOptions = { ...options, detectedGenre: globalContext.detectedGenre };
        } else if (isAutoGenre && (transcript || scenes?.length)) {
          const genreProvider = mediumTextProvider || provider;
          send(77, "识别视频类型", `根据字幕和镜头切换让 ${genreProvider.name} 推断视频类型。`);
          const detectStartedAt = Date.now();
          const detected = await detectGenreLightweight(genreProvider, projectMeta, scenes, transcript, handle);
          if (detected?.detectedGenre) {
            effectiveOptions = { ...options, detectedGenre: detected.detectedGenre };
            send(77, "识别视频类型完成", `判定为 ${detected.detectedGenre}（置信度 ${(detected.genreConfidence * 100).toFixed(0)}%，耗时 ${Math.round((Date.now() - detectStartedAt) / 1000)}s）。`);
          } else {
            send(77, "类型识别跳过", "未能从字幕推断类型，将让主分析在 catalog 中识别。");
          }
        }

        // 把 shotContexts + globalSummary 传给主分析 prompt (callOpenAICompatible 内部会消费)
        if (shotContexts && shotContexts.length > 0) {
          effectiveOptions = {
            ...effectiveOptions,
            shotContexts,
            globalSummary: globalContext?.globalSummary,
            structureHint: globalContext?.structureHint,
          };
        }

        send(78, "模型分析画面", `正在请 ${provider.name} 分析这段视频。`);
        const modelResult = await callOpenAICompatible(provider, projectMeta, frames, transcript, scenes, fallbackNodes, fallbackReport, effectiveOptions, handle);
        nodes = modelResult.nodes;
        // 把金字塔中间产物 (代表帧 / 帧 captions / 字幕段) 挂到节点上, 让 UI 能渲染镜头级 evidence
        if (Array.isArray(shots) && shots.length > 0) {
          attachShotEvidenceToNodes(nodes, shots);
        }
        report = {
          ...modelResult.report,
          audioProviderSnapshot: fallbackReport.audioProviderSnapshot,
          transcript: fallbackReport.transcript,
        };
        if (globalContext?.globalSummary) report.globalSummary = globalContext.globalSummary;
        if (shotContexts) report.shotContexts = shotContexts;
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(85, "分析失败", `${error.message || error}。已回退到本地基础结果。`);
      }
    } else if (globalContext || shotContexts) {
      // 视觉主分析未配置, 但中间层有产物, 让 fallback report 至少能带上 globalSummary
      if (globalContext?.globalSummary) report.globalSummary = globalContext.globalSummary;
      if (shotContexts) report.shotContexts = shotContexts;
    }

    ensureNotCancelled(handle);
    send(90, "整理结果", "正在保存分析结果。");
    const updatedProject = {
      ...project,
      localFilePath: inputPath,
      localVideoPath: createMediaUrl(inputPath),
      durationSec: inspected.durationSec || project.durationSec,
      width: inspected.width || project.width,
      height: inspected.height || project.height,
      orientation: inspected.orientation || project.orientation,
      status: "completed",
      providerId: provider?.id,
      model: provider?.model,
      thumbnailUrl: frames[0]?.framePath ? createMediaUrl(frames[0].framePath) : project.thumbnailUrl,
      updatedAt: new Date().toISOString(),
    };
    send(100, "完成", "分析结果已生成。");
    closeCurrentStage();
    const totalDurationMs = Date.now() - analysisStartedAt;
    const finalTimings = [...timings];
    // 找出耗时 top 1 阶段(剔除 0ms 边界)
    const top = finalTimings
      .filter((t) => t.durationMs > 0 && t.stage !== "完成")
      .sort((a, b) => b.durationMs - a.durationMs)[0];
    const topLabel = top ? ` · 最耗时 ${top.stage} ${(top.durationMs / 1000).toFixed(1)}s` : "";
    if (!handle.cancelled) {
      event.sender.send("analysis:progress", {
        projectId: project.id,
        progress: 100,
        stage: "完成",
        message: `总耗时 ${(totalDurationMs / 1000).toFixed(1)}s${topLabel}`,
      });
    }
    report = { ...report, timings: finalTimings, totalDurationMs };
    await writeJson(path.join(projectDir, "analysis-result.json"), { project: updatedProject, nodes, report });
    await writeJson(path.join(projectDir, "timings.json"), { totalDurationMs, timings: finalTimings });
    // main 端直接落盘 SQLite,避免依赖 renderer 走 ProgressScreen 才能同步。
    // 与 renderer 端 setNodesForProject/setReportForProject 的 IPC 写是幂等的(INSERT OR UPDATE)。
    try {
      const db = getDb();
      db.prepare(
        "INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      ).run(updatedProject.id, JSON.stringify(updatedProject), Date.now());
      db.prepare(
        "INSERT INTO analysis_nodes (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data",
      ).run(project.id, JSON.stringify(nodes));
      db.prepare(
        "INSERT INTO analysis_reports (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data",
      ).run(project.id, JSON.stringify(report));
    } catch (persistError) {
      // 不阻断返回:JSON 文件已经写了,renderer 路径仍可兜底
      console.warn("[clipiq] main 端 SQLite 持久化失败,renderer 路径会兜底:", persistError);
    }
    return { project: updatedProject, nodes, report };
  } finally {
    clearAnalysis(project.id);
  }
}

function formatTime(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function exportMarkdown(project, nodes, report, provider) {
  return [
    `# ${project.videoName}`,
    "",
    `- 来源: ${project.source?.type === "url" ? project.source.url : project.source?.originalPath || project.localFilePath || ""}`,
    `- 视频: ${project.durationSec ? `${Math.round(project.durationSec)}s` : "未知"} / ${project.width}x${project.height} / ${project.orientation}`,
    `- Provider: ${provider?.name || report.providerSnapshot?.name || "未配置"} / ${provider?.model || report.providerSnapshot?.model || project.model || "未配置"}`,
    `- Pipeline: ${report.pipelineVersion || PIPELINE_VERSION}`,
    `- Schema: ${report.schemaVersion || SCHEMA_VERSION}`,
    `- 生成时间: ${report.generatedAt || new Date().toISOString()}`,
    "",
    "## 整体摘要",
    "",
    report.summary || "",
    "",
    "## 结构拆解",
    "",
    `- 开头: ${report.structure?.hook || ""}`,
    `- 发展: ${report.structure?.development || ""}`,
    `- 转折: ${report.structure?.turn || ""}`,
    `- 高潮: ${report.structure?.climax || ""}`,
    `- 结尾: ${report.structure?.ending || ""}`,
    "",
    "## 节点",
    "",
    ...nodes.flatMap((node) => [
      `### ${formatTime(node.startSec)}-${formatTime(node.endSec)} ${node.title}`,
      "",
      `- 叙事功能: ${node.narrativeFunction}`,
      `- 情绪: ${node.emotionLabel} (${node.emotionIntensity}/10)`,
      `- 重点: ${node.isHighlight ? "是" : "否"}`,
      `- 画面: ${node.shotDescription}`,
      `- 剪辑意图: ${node.editIntent}`,
      node.note ? `- 备注: ${node.note}` : "",
      "",
    ]),
  ].join("\n");
}

function exportCsv(nodes) {
  const rows = [
    ["start", "end", "title", "narrativeFunction", "emotionLabel", "emotionIntensity", "isHighlight", "description", "note"],
    ...nodes.map((node) => [
      formatTime(node.startSec),
      formatTime(node.endSec),
      node.title,
      node.narrativeFunction,
      node.emotionLabel,
      String(node.emotionIntensity),
      node.isHighlight ? "true" : "false",
      node.shotDescription,
      node.note || "",
    ]),
  ];
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
}

function getAppIcon() {
  const candidates = [
    path.join(__dirname, "assets", "icon-1024.png"),
    path.join(__dirname, "assets", "icon-512.png"),
    path.join(__dirname, "assets", "icon-256.png"),
  ];
  for (const p of candidates) {
    if (fsSync.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return null;
}

async function createWindow() {
  const icon = getAppIcon();
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "ClipIQ · 自动拉片分析工具",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0F172A",
    icon: icon || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  // macOS Dock 图标
  if (process.platform === "darwin" && app.dock) {
    const icon = getAppIcon();
    if (icon) app.dock.setIcon(icon);
  }
  app.setName("ClipIQ");

  protocol.handle("media", (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.slice(1));
    return net.fetch(pathToFileURL(filePath).toString());
  });

  ipcMain.handle("data:getInfo", async () => {
    const userData = app.getPath("userData");
    const projectsDir = path.join(userData, "projects");
    let projectCount = 0;
    let totalBytes = 0;
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        projectCount += 1;
        const projectPath = path.join(projectsDir, entry.name);
        totalBytes += await directorySize(projectPath).catch(() => 0);
      }
    } catch {
      // projects dir not created yet
    }
    let dbBytes = 0;
    try {
      dbBytes = (await fs.stat(getDbPath())).size;
    } catch {
      // db not created yet
    }
    let dbProjectCount = 0;
    try {
      dbProjectCount = getDb().prepare("SELECT COUNT(*) AS n FROM projects").get().n;
    } catch {
      // db not opened
    }
    return {
      userDataPath: userData,
      projectsPath: projectsDir,
      configPath: getConfigPath(),
      dbPath: getDbPath(),
      projectCount,
      dbProjectCount,
      totalBytes,
      dbBytes,
    };
  });

  ipcMain.handle("data:openFolder", async (_event, which) => {
    const target = which === "projects" ? path.join(app.getPath("userData"), "projects") : app.getPath("userData");
    await fs.mkdir(target, { recursive: true });
    await shell.openPath(target);
    return { ok: true, path: target };
  });

  ipcMain.handle("data:purgeProjects", async () => {
    const projectsDir = path.join(app.getPath("userData"), "projects");
    try {
      await fs.rm(projectsDir, { recursive: true, force: true });
      await fs.mkdir(projectsDir, { recursive: true });
      const db = getDb();
      db.exec("DELETE FROM analysis_nodes; DELETE FROM analysis_reports; DELETE FROM projects;");
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipcMain.handle("runtime:getStatus", async () => {
    const [ffmpeg, ffprobe, ytDlp] = await Promise.all([
      commandPath("ffmpeg"),
      commandPath("ffprobe"),
      commandPath("yt-dlp"),
    ]);
    return {
      ffmpeg,
      ffprobe,
      ytDlp,
      ffmpegBundled: ffmpeg ? ffmpeg === bundledFfmpegPath() : false,
      ffprobeBundled: ffprobe ? ffprobe === bundledFfprobePath() : false,
      ytDlpBundled: ytDlp ? ytDlp === ytDlpLocalPath() : false,
      ytDlpVersion: ytDlp ? await getYtDlpVersion(ytDlp).catch(() => null) : null,
    };
  });

  ipcMain.handle("ytdlp:checkUpdate", async () => {
    return checkYtDlpUpdate();
  });

  ipcMain.handle("ytdlp:install", async (event) => {
    return downloadYtDlp((stage, message) => {
      event.sender.send("ytdlp:progress", { stage, message });
    });
  });

  ipcMain.handle("video:openFile", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择要拉片的视频",
      properties: ["openFile"],
      filters: [{ name: "Videos", extensions: VIDEO_EXTENSIONS }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return inspectVideo(result.filePaths[0]);
  });

  ipcMain.handle("video:inspectPath", async (_event, filePath) => {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("无效的文件路径");
    }
    if (!fsSync.existsSync(filePath)) {
      throw new Error("文件不存在或无法访问");
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      throw new Error(`不支持的视频格式: .${ext}`);
    }
    return inspectVideo(filePath);
  });

  ipcMain.handle("config:load", async () => {
    const raw = await readJson(getConfigPath(), null);
    return migrateConfigV1ToV2(raw);
  });

  ipcMain.handle("config:save", async (_event, config) => {
    // 落盘前再过一次 migrate,保证 builtin 永远存在 + schema 永远是 v2
    // 合并磁盘上的 lastLlamaModelKey 等 renderer 不持有的字段,避免被覆盖
    const cur = await readJson(getConfigPath(), null);
    const merged = {
      ...config,
      lastLlamaModelKey: config?.lastLlamaModelKey ?? cur?.lastLlamaModelKey ?? null,
    };
    const migrated = migrateConfigV1ToV2(merged);
    await writeJson(getConfigPath(), { ...migrated, savedAt: new Date().toISOString() });
    return { ok: true };
  });

  ipcMain.handle("projects:list", async () => {
    const db = getDb();
    const rows = db.prepare("SELECT data FROM projects ORDER BY updated_at DESC").all();
    return rows.map((row) => JSON.parse(row.data));
  });

  ipcMain.handle("projects:upsert", async (_event, project) => {
    if (!project?.id) throw new Error("projects:upsert 需要 project.id");
    const db = getDb();
    const parsed = project.updatedAt ? Date.parse(project.updatedAt) : NaN;
    const updatedAt = Number.isFinite(parsed) ? parsed : Date.now();
    db.prepare(
      "INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).run(project.id, JSON.stringify(project), updatedAt);
    return { ok: true };
  });

  ipcMain.handle("projects:delete", async (_event, projectId) => {
    if (!projectId) return { ok: false, message: "缺少 projectId" };
    const db = getDb();
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    db.prepare("DELETE FROM analysis_nodes WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM analysis_reports WHERE project_id = ?").run(projectId);
    try {
      await fs.rm(getProjectDir(projectId), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return { ok: true };
  });

  ipcMain.handle("nodes:get", async (_event, projectId) => {
    const db = getDb();
    const row = db.prepare("SELECT data FROM analysis_nodes WHERE project_id = ?").get(projectId);
    return row ? JSON.parse(row.data) : [];
  });

  ipcMain.handle("nodes:set", async (_event, projectId, nodes) => {
    const db = getDb();
    db.prepare(
      "INSERT INTO analysis_nodes (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data"
    ).run(projectId, JSON.stringify(Array.isArray(nodes) ? nodes : []));
    return { ok: true };
  });

  ipcMain.handle("report:get", async (_event, projectId) => {
    const db = getDb();
    const row = db.prepare("SELECT data FROM analysis_reports WHERE project_id = ?").get(projectId);
    return row ? JSON.parse(row.data) : null;
  });

  ipcMain.handle("report:set", async (_event, projectId, report) => {
    const db = getDb();
    if (report === null || report === undefined) {
      db.prepare("DELETE FROM analysis_reports WHERE project_id = ?").run(projectId);
    } else {
      db.prepare(
        "INSERT INTO analysis_reports (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data"
      ).run(projectId, JSON.stringify(report));
    }
    return { ok: true };
  });

  ipcMain.handle("analysis:start", analyzeProject);

  ipcMain.handle("analysis:cancel", async (_event, projectId) => {
    return { cancelled: cancelAnalysis(projectId) };
  });

  ipcMain.handle("analysis:isActive", async (_event, projectId) => {
    return activeAnalyses.has(projectId);
  });

  ipcMain.handle("analysis:getLastProgress", async (_event, projectId) => {
    const handle = activeAnalyses.get(projectId);
    return handle?.lastProgress || null;
  });

  ipcMain.handle("project:export", async (_event, { project, nodes, report, provider, format }) => {
    const extension = format === "json" ? "json" : format === "csv" ? "csv" : "md";
    const defaultPath = path.join(
      app.getPath("documents"),
      `${path.parse(project.videoName || "video-analysis").name || "video-analysis"}-analysis.${extension}`
    );
    const result = await dialog.showSaveDialog({
      title: "导出拉片结果",
      defaultPath,
      filters: [
        { name: format.toUpperCase(), extensions: [extension] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const content =
      format === "json"
        ? JSON.stringify({ project, nodes, report, provider, exportedAt: new Date().toISOString() }, null, 2)
        : format === "csv"
          ? exportCsv(nodes)
          : exportMarkdown(project, nodes, report, provider);
    await fs.writeFile(result.filePath, content, "utf8");
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle("provider:testConnection", async (_event, provider) => {
    if (
      provider?.endpointType === "local_whisper_cpp" ||
      provider?.endpointType === "local_whisper_wasm" ||
      provider?.source === "local_whisper"
    ) {
      const modelId = normalizeWhisperCppModelId(
        provider.localWhisperModel || provider.model,
      );
      try {
        const result = await warmupLocalWhisperCpp(provider);
        return {
          ok: true,
          message: `本地模型 ${modelId} 已就绪 (${(result.elapsedMs / 1000).toFixed(1)}s)。`,
        };
      } catch (error) {
        return { ok: false, message: `本地模型加载失败: ${error?.message || error}` };
      }
    }
    if (!provider?.baseUrl) {
      return { ok: false, message: "请先填写 Base URL。" };
    }
    if (!provider?.apiKeyRef) {
      return { ok: false, message: "请先填写 API Key。" };
    }
    const base = String(provider.baseUrl).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${provider.apiKeyRef}` };

    // Stage 1: GET /models（OpenAI 兼容生态通常都支持）
    try {
      const response = await fetch(`${base}/models`, { method: "GET", headers });
      if (response.ok) {
        const data = await response.json().catch(() => null);
        const modelCount = Array.isArray(data?.data) ? data.data.length : null;
        return {
          ok: true,
          message: modelCount != null ? `连接成功，发现 ${modelCount} 个可用模型。` : "连接成功。",
        };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `认证失败 (${response.status})，请检查 API Key。` };
      }
      if (response.status !== 404 && response.status !== 405) {
        const detail = (await response.text()).slice(0, 300);
        return { ok: false, message: `GET /models 返回 ${response.status}: ${detail}` };
      }
    } catch (error) {
      return { ok: false, message: `连接失败: ${error?.message || error}` };
    }

    if (!provider?.model) {
      return { ok: false, message: "Base URL 可达，但未配置模型名，无法继续验证。" };
    }

    // Stage 2: kind-specific probe
    if (provider.kind === "audio") {
      // POST 一个 0.1s 静音 WAV 到 /audio/transcriptions 作为存在性探测
      const silenceWav = makeSilenceWav(0.1);
      const form = new FormData();
      form.append("file", new Blob([silenceWav], { type: "audio/wav" }), "ping.wav");
      form.append("model", provider.model);
      if (provider.language) form.append("language", provider.language);
      try {
        const audioResponse = await fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers,
          body: form,
        });
        if (audioResponse.ok) return { ok: true, message: `连接成功 (${provider.model} 可用)。` };
        const detail = (await audioResponse.text()).slice(0, 300);
        // 短/静音 WAV 在某些服务会返回 400 但说明 endpoint 存在
        if (audioResponse.status === 400) {
          return { ok: true, message: `endpoint 可达 (${audioResponse.status})，但服务拒绝了静音探测包；模型本身待真实音频验证。` };
        }
        return { ok: false, message: `/audio/transcriptions ${audioResponse.status}: ${detail}` };
      } catch (error) {
        return { ok: false, message: `连接失败: ${error?.message || error}` };
      }
    }

    // video: chat/completions ping
    try {
      const chatResponse = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (chatResponse.ok) return { ok: true, message: `连接成功 (${provider.model} 可用)。` };
      const detail = (await chatResponse.text()).slice(0, 300);
      return { ok: false, message: `chat/completions ${chatResponse.status}: ${detail}` };
    } catch (error) {
      return { ok: false, message: `连接失败: ${error?.message || error}` };
    }
  });

  ipcMain.handle("video:downloadUrl", async (_event, rawInput) => {
    const ytDlp = await commandPath("yt-dlp");
    if (!ytDlp) {
      throw new Error("未找到 yt-dlp，无法通过链接拉取视频。请先安装 yt-dlp，或改用本地视频。");
    }

    // 抖音/小红书等平台的分享文案是「中文 + URL + 时间戳 + 口令」混排,
    // 用户经常整段粘贴。这里提取首个 http(s) URL,允许整段输入。
    const urlMatch = String(rawInput || "").match(/https?:\/\/[^\s'"<>，。、）]+/);
    const url = urlMatch ? urlMatch[0].replace(/[.,;)]+$/, "") : "";
    if (!url) {
      throw new Error("未从输入中识别到视频链接,请确认粘贴的内容里包含 http(s):// 开头的链接。");
    }

    const cache = await readUrlCache();
    const cached = cache[url];
    if (cached?.filePath) {
      try {
        await fs.access(cached.filePath);
        const inspected = await inspectVideo(cached.filePath);
        return {
          projectId: `proj-url-${Date.now()}`,
          platform: inferPlatform(url),
          ...inspected,
        };
      } catch {
        delete cache[url];
        await writeUrlCache(cache);
      }
    }

    const projectId = `proj-url-${Date.now()}`;
    const mediaDir = path.join(app.getPath("userData"), "projects", projectId, "media");
    await fs.mkdir(mediaDir, { recursive: true });

    const outputPattern = path.join(mediaDir, "%(extractor)s_%(id)s.%(ext)s");
    try {
      await run(ytDlp, ["--no-playlist", "--restrict-filenames", "-o", outputPattern, url]);
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message || error).trim();
      throw new Error(detail || "yt-dlp 下载失败");
    }

    const files = await fs.readdir(mediaDir);
    const candidates = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(mediaDir, file);
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      })
    );
    const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!latest) throw new Error("yt-dlp 执行完成，但没有生成视频文件。");

    const inspected = await inspectVideo(latest.filePath);
    cache[url] = { filePath: latest.filePath, savedAt: Date.now() };
    await writeUrlCache(cache);
    return {
      projectId,
      platform: inferPlatform(url),
      ...inspected,
    };
  });

  await llamaRuntime.init();
  await whisperCppRuntime.init();

  ipcMain.handle("llama:listModels", async () => llamaRuntime.listModels());

  ipcMain.handle("llama:getStatus", async () => llamaRuntime.getStatus());

  ipcMain.handle("llama:ensureBinary", async (event) => {
    const path = await llamaRuntime.ensureLlamaServer((progress) => {
      event.sender.send("llama:progress", { scope: "binary", ...progress });
    });
    return { ok: true, binaryPath: path };
  });

  ipcMain.handle("llama:ensureModel", async (event, modelKey) => {
    return llamaRuntime.ensureModel(modelKey, (progress) => {
      event.sender.send("llama:progress", { scope: "model", modelKey, ...progress });
    });
  });

  ipcMain.handle("llama:start", async (event, modelKey) => {
    const result = await llamaRuntime.start(modelKey, {
      onLog: (entry) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("llama:log", entry);
        }
      },
    });
    // 持久化最近一次启动的模型,下次开应用时自动恢复
    persistLastLlamaModelKey(modelKey).catch((e) =>
      console.warn("[clipiq] 持久化 lastLlamaModelKey 失败:", e),
    );
    return result;
  });

  ipcMain.handle("llama:stop", async () => llamaRuntime.stop());

  ipcMain.handle("llama:selfTest", async (_event, payload) => {
    return llamaRuntime.selfTest(payload || {});
  });

  // whisper.cpp runtime IPC ----------------------------------------------------
  ipcMain.handle("whisperCpp:listModels", async () => whisperCppRuntime.listModels());

  ipcMain.handle("whisperCpp:getStatus", async () => whisperCppRuntime.getStatus());

  ipcMain.handle("whisperCpp:ensureModel", async (event, modelKey) => {
    return whisperCppRuntime.ensureModel(modelKey, (progress) => {
      event.sender.send("whisperCpp:progress", { scope: "model", modelKey, ...progress });
    });
  });

  ipcMain.handle("whisperCpp:start", async (event, modelKey) => {
    return whisperCppRuntime.start(modelKey, {
      onLog: (entry) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("whisperCpp:log", entry);
        }
      },
    });
  });

  ipcMain.handle("whisperCpp:stop", async () => whisperCppRuntime.stop());

  await createWindow();

  scheduleYtDlpAutoCheck();
  scheduleLlamaAutoResume();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function persistLastLlamaModelKey(modelKey) {
  const cur = (await readJson(getConfigPath(), null)) || {};
  await writeJson(getConfigPath(), {
    ...cur,
    lastLlamaModelKey: modelKey || null,
    savedAt: new Date().toISOString(),
  });
}

function scheduleLlamaAutoResume() {
  // 不阻塞主流程,稍微延迟一点让窗口先呈现给用户
  setTimeout(async () => {
    try {
      const cfg = await readJson(getConfigPath(), null);
      const lastKey = cfg?.lastLlamaModelKey;
      if (!lastKey) return;
      const status = llamaRuntime.getStatus();
      if (!status.binaryFound) {
        console.log("[clipiq] llama auto-resume 跳过:推理引擎未安装");
        return;
      }
      const models = await llamaRuntime.listModels();
      const target = models.find((m) => m.key === lastKey);
      if (!target) {
        console.log(`[clipiq] llama auto-resume 跳过:未知模型 ${lastKey}`);
        return;
      }
      if (!target.downloaded) {
        console.log(`[clipiq] llama auto-resume 跳过:模型 ${lastKey} 未下载完成`);
        return;
      }
      console.log(`[clipiq] llama auto-resume: 启动 ${lastKey}`);
      await llamaRuntime.start(lastKey, {
        onLog: (entry) => {
          // 自启动期间日志只走主进程 stdout,不打扰 renderer
          if (entry.channel === "stderr" && /error|fatal/i.test(entry.line)) {
            console.warn("[llama auto-resume]", entry.line);
          }
        },
      });
      // 通知 renderer 更新状态卡片(如果已打开 Settings 本地推理 section)
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send("llama:progress", {
          scope: "auto-resume",
          stage: "ready",
          label: "本地推理",
          message: `自动恢复模型 ${lastKey}`,
        });
      }
      console.log(`[clipiq] llama auto-resume 完成`);
    } catch (error) {
      console.warn(`[clipiq] llama auto-resume 失败: ${error?.message || error}`);
    }
  }, 1500);
}

function scheduleYtDlpAutoCheck() {
  setTimeout(async () => {
    try {
      const info = await checkYtDlpUpdate();
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed()) {
        window.webContents.send("ytdlp:update-status", info);
      }
    } catch {
      // network failure is non-fatal
    }
  }, 2000);
}

app.on("before-quit", () => {
  llamaRuntime.shutdownSync();
  whisperCppRuntime.shutdownSync();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
