const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, protocol, session, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Readable } = require("node:stream");
const llamaRuntime = require("./llama-runtime.cjs");
const llamaManager = require("./llama-manager.cjs");
const whisperCppRuntime = require("./whisper-cpp-runtime.cjs");
const prefilter = require("./prefilter.cjs");
const shotMerger = require("./shot-merger.cjs");
const summarizer = require("./summarizer.cjs");
const danmakuFetcher = require("./danmaku-fetcher.cjs");
const danmakuEmotion = require("./danmaku-emotion.cjs");
const danmakuWordcloud = require("./danmaku-wordcloud.cjs");
const openaiClient = require("./openai-client.cjs");
const etaEstimator = require("./eta-estimator.cjs");
const etaLearner = require("./eta-learner.cjs");
const cacheStore = require("./cache-store.cjs");
const extensionBridge = require("./extension-bridge.cjs");
const log = require("./logger.cjs");
const { getTranscriber } = require("./transcribe/index.cjs");
const OpenCC = require("opencc-js");

const DEFAULT_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
// 每个阶段一份 prompt/输入格式 VERSION 常量, 改 prompt 时手动 bump → 旧 cache 自动失效。
const CACHE_VERSIONS = {
  transcript: "v1",
  prefilter: "v1",
  shotMerger: "v1",
  summarizer: "v1",
  detectGenre: "v1",
  // v1 → v2: buildAnalysisPrompt + buildChunkPrompt 加了"节点划分规则"section
  // (引导小模型把多个 shot 合并成 4-7 个逻辑节点, 不要 1:1 映射)。旧 cache 输出仍是
  // 1 shot=1 node 的退化结果, 必须失效让新 prompt 生效。
  mainAnalysis: "v2",
  danmakuEmotion: "v1",
};

function getDefaultCacheDir() {
  return path.join(app.getPath("userData"), "cache");
}

function resolveCacheConfig(config) {
  const dir = config?.cacheDir && typeof config.cacheDir === "string"
    ? config.cacheDir
    : getDefaultCacheDir();
  const maxBytes = Number.isFinite(Number(config?.cacheMaxBytes))
    ? Number(config.cacheMaxBytes)
    : DEFAULT_CACHE_MAX_BYTES;
  return { dir, maxBytes };
}

async function initializeCacheStore() {
  const raw = await readJson(getConfigPath(), null);
  const { dir, maxBytes } = resolveCacheConfig(raw);
  cacheStore.configure({ dir, maxBytes });
}

// 当前管线运行期间生效的 cachePolicy 快照, analyzeProject 入口设置, 结束清除。
let _activeCachePolicy = null;

function isCacheEnabledForScope(scope) {
  if (!_activeCachePolicy) return true;
  if (!_activeCachePolicy.enabled) return false;
  const stages = _activeCachePolicy.stages;
  if (stages && typeof stages[scope] === "boolean") return stages[scope];
  return true;
}

// 包一个"输入 → output"的纯函数 LLM 调用为 cache-aware 版本。
// scope/key 由 main.cjs 各调用点构造, run 是命中失败时实际跑的副作用函数。
async function runWithCache(scope, key, run, meta = {}) {
  if (!cacheStore.isConfigured() || !key || !isCacheEnabledForScope(scope)) return run();
  try {
    const hit = await cacheStore.get(scope, key);
    if (hit) return hit.payload;
  } catch { /* 缓存读失败 → 走 LLM */ }
  const output = await run();
  if (output != null) {
    try { await cacheStore.set(scope, key, output, { meta }); }
    catch { /* 缓存写失败不阻塞 */ }
  }
  return output;
}

// runWithCache 的"带缓存标记"变体: 返回 { payload, fromCache }, 让上游分支记账时
// 区分"本次 LLM 真的跑了 → 记 tokens" 与 "缓存命中 → 只记一次 cacheHit"。
async function runWithCacheTraced(scope, key, run, meta = {}) {
  let invoked = false;
  const payload = await runWithCache(scope, key, async () => {
    invoked = true;
    return run();
  }, meta);
  return { payload, fromCache: !invoked };
}

// Token 账本: 按 (stage, providerId, model) 维度聚合每次分析消耗的 LLM token。
// - record: 单次调用 / 单 batch 调用完成后投递 usage
// - snapshot: 持久化前快照, 写进 report.tokenUsage 和 token-usage.json
// cache 命中只 +cacheHits, 不加 token; 累计调用次数走 callCount。
function createTokenLedger(priorStages) {
  const buckets = new Map();
  const keyOf = (stage, providerId, model) => `${stage}|${providerId || ""}|${model || ""}`;
  const ensureBucket = (stage, providerId, providerName, model, source) => {
    const k = keyOf(stage, providerId, model);
    let b = buckets.get(k);
    if (!b) {
      b = {
        stage,
        providerId: providerId || null,
        providerName: providerName || null,
        model: model || null,
        source: source || "remote",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        callCount: 0,
        cacheHits: 0,
      };
      buckets.set(k, b);
    }
    return b;
  };
  return {
    record({ stage, provider, model, source, usage, callCount = 1 }) {
      if (!stage) return;
      const m = model || provider?.model || null;
      const src = source || (provider?.source ?? "remote");
      const b = ensureBucket(stage, provider?.id, provider?.name, m, src);
      if (usage) {
        b.promptTokens += Number(usage.promptTokens) || 0;
        b.completionTokens += Number(usage.completionTokens) || 0;
        b.totalTokens += Number(usage.totalTokens) || 0;
        b.cacheReadTokens += Number(usage.cacheReadTokens) || 0;
        b.cacheCreationTokens += Number(usage.cacheCreationTokens) || 0;
      }
      b.callCount += callCount;
    },
    cacheHit({ stage, provider, model, source }) {
      if (!stage) return;
      const m = model || provider?.model || null;
      const src = source || (provider?.source ?? "remote");
      const b = ensureBucket(stage, provider?.id, provider?.name, m, src);
      b.cacheHits += 1;
      if (b.totalTokens === 0 && priorStages) {
        const match = priorStages.find((s) => s.stage === stage && s.model === m);
        if (match && match.totalTokens > 0) {
          b.promptTokens = match.promptTokens || 0;
          b.completionTokens = match.completionTokens || 0;
          b.totalTokens = match.totalTokens || 0;
          b.callCount = match.callCount || 0;
          b.fromPriorRun = true;
        }
      }
    },
    snapshot() {
      const stages = [...buckets.values()];
      const totals = stages.reduce(
        (acc, s) => {
          acc.totalPromptTokens += s.promptTokens;
          acc.totalCompletionTokens += s.completionTokens;
          acc.totalTokens += s.totalTokens;
          return acc;
        },
        { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
      );
      return { stages, ...totals };
    },
  };
}

// 给 prefilter.tagFrames 用的逐帧 cache injector
function makePrefilterCache(modelKey) {
  if (!cacheStore.isConfigured() || !isCacheEnabledForScope("prefilter")) return null;
  return {
    lookup: async (frame) => {
      try {
        const filePath = frame.prefilterFramePath || frame.framePath;
        const sha = await cacheStore.sha256File(filePath);
        const key = cacheStore.makeKey({ sha, modelKey, version: CACHE_VERSIONS.prefilter });
        const hit = await cacheStore.get("prefilter", key);
        return hit ? { tag: hit.payload, meta: hit.meta } : null;
      } catch { return null; }
    },
    store: async (frame, tag, meta) => {
      try {
        const filePath = frame.prefilterFramePath || frame.framePath;
        const sha = await cacheStore.sha256File(filePath);
        const key = cacheStore.makeKey({ sha, modelKey, version: CACHE_VERSIONS.prefilter });
        await cacheStore.set("prefilter", key, tag, { meta: { ...meta, modelKey } });
      } catch { /* ignore */ }
    },
  };
}

function normalizeShotMergerBatch(batch) {
  return batch.map((s) => ({
    startSec: Number(s.startSec).toFixed(2),
    endSec: Number(s.endSec).toFixed(2),
    subtitle: (s.subtitleText || "").trim(),
    frames: Array.isArray(s.frames)
      ? s.frames.map((f) => ({
          caption: f.caption || "",
          subject: f.subject || "",
          signature: f.signature || "",
          salience: f.salience ?? 0,
        }))
      : [],
  }));
}

function makeShotMergerCache(provider) {
  if (!cacheStore.isConfigured() || !provider?.model || !isCacheEnabledForScope("shot-merger")) return null;
  return {
    lookup: async (batch) => {
      try {
        const key = cacheStore.makeKey({
          batch: normalizeShotMergerBatch(batch),
          model: provider.model,
          baseUrl: provider.baseUrl,
          version: CACHE_VERSIONS.shotMerger,
        });
        const hit = await cacheStore.get("shot-merger", key);
        return hit?.payload || null;
      } catch { return null; }
    },
    store: async (batch, payload, meta) => {
      try {
        const key = cacheStore.makeKey({
          batch: normalizeShotMergerBatch(batch),
          model: provider.model,
          baseUrl: provider.baseUrl,
          version: CACHE_VERSIONS.shotMerger,
        });
        await cacheStore.set("shot-merger", key, payload, { meta: { ...meta, model: provider.model } });
      } catch { /* ignore */ }
    },
  };
}

function normalizeDanmakuBatch(batch) {
  return batch.map((b) => ({
    startSec: Number(b.startSec).toFixed(1),
    endSec: Number(b.endSec).toFixed(1),
    totalCount: b.totalCount,
    summaries: (b.summaries || []).map((s) => ({ text: s.text, count: s.count })),
  }));
}

function makeDanmakuEmotionCache(provider) {
  if (!cacheStore.isConfigured() || !provider?.model || !isCacheEnabledForScope("danmaku-emotion")) return null;
  return {
    lookup: async (batch) => {
      try {
        const key = cacheStore.makeKey({
          batch: normalizeDanmakuBatch(batch),
          model: provider.model,
          baseUrl: provider.baseUrl,
          version: CACHE_VERSIONS.danmakuEmotion,
        });
        const hit = await cacheStore.get("danmaku-emotion", key);
        return hit?.payload || null;
      } catch { return null; }
    },
    store: async (batch, payload, meta) => {
      try {
        const key = cacheStore.makeKey({
          batch: normalizeDanmakuBatch(batch),
          model: provider.model,
          baseUrl: provider.baseUrl,
          version: CACHE_VERSIONS.danmakuEmotion,
        });
        await cacheStore.set("danmaku-emotion", key, payload, { meta: { ...meta, model: provider.model } });
      } catch { /* ignore */ }
    },
  };
}

// 云端 whisper 同样会有简繁混排,做一层 t2s 兜底。
const SIMPLIFIED_PROMPT_ZH = "以下是普通话的句子，请使用简体中文输出。";
const t2sConverterMain = OpenCC.Converter({ from: "t", to: "cn" });

function isChineseLangMain(lang) {
  if (!lang) return false;
  const v = String(lang).toLowerCase();
  return v === "zh" || v === "chinese" || v.startsWith("zh-") || v.startsWith("zh_");
}

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
const MEDIA_MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};
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
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    const filePath = ffmpegInstaller?.path;
    if (typeof filePath === "string" && filePath) return filePath;
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

// 云端模型 TPS baseline: 启动时从 userData/eta-baselines.json 加载, 每次 analyzeProject
// 跑完根据 eta-samples.jsonl 重算 + 写回。eta-estimator.computeBudget 把它当成"learned
// hint" 覆盖云端 hardcoded fallback。
let learnedBaselines = { providers: {} };

class AnalysisCancelledError extends Error {
  constructor() {
    super("分析已取消");
    this.name = "AnalysisCancelledError";
  }
}

function registerAnalysis(projectId) {
  const existing = activeAnalyses.get(projectId);
  if (existing) {
    log.warn("analyze:lifecycle", `registerAnalysis: 覆盖已有 handle project=${projectId} existingAnalysisId=${existing.analysisId || "?"} cancelled=${existing.cancelled}`);
  }
  const handle = {
    abortController: new AbortController(),
    children: new Set(),
    cancelled: false,
  };
  activeAnalyses.set(projectId, handle);
  return handle;
}

function clearAnalysis(projectId, expectedHandle) {
  const current = activeAnalyses.get(projectId);
  if (expectedHandle && current !== expectedHandle) {
    log.info("analyze:lifecycle", `clearAnalysis: guard 阻止清除 project=${projectId} — expectedAnalysisId=${expectedHandle?.analysisId || "?"} currentAnalysisId=${current?.analysisId || "?"} (新分析已接管)`);
    return;
  }
  log.info("analyze:lifecycle", `clearAnalysis: 清除 project=${projectId} analysisId=${current?.analysisId || "?"} cancelled=${current?.cancelled}`);
  if (current?.heartbeat) clearInterval(current.heartbeat);
  activeAnalyses.delete(projectId);
  _activeCachePolicy = null;
}

function cancelAnalysis(projectId) {
  const handle = activeAnalyses.get(projectId);
  if (!handle) {
    log.warn("analyze:lifecycle", `cancelAnalysis: 无 handle project=${projectId}, 可能已被清理`);
    return false;
  }
  log.info("analyze:lifecycle", `cancelAnalysis: 取消 project=${projectId} analysisId=${handle.analysisId || "?"} childCount=${handle.children.size}`);
  handle.cancelled = true;
  handle.cancelledAt = Date.now();
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

// macOS 内存采样: vm_stat 给页数, sysctl 给 swap。
// usedBytes 对齐活动监视器 "Memory Used" = App(Anonymous-Purgeable) + Wired + Compressed,
// 不含 File-backed / Speculative,因为这些是 OS 缓存,有压力时会自动让出。
async function sampleDarwinMemory(totalMemBytes) {
  try {
    const [vmRes, swapRes] = await Promise.all([
      execFileAsync("vm_stat", [], { windowsHide: true }),
      execFileAsync("sysctl", ["-n", "vm.swapusage"], { windowsHide: true }).catch(() => ({ stdout: "" })),
    ]);
    const vmOut = vmRes.stdout || "";
    const pageSize = Number(vmOut.match(/page size of (\d+) bytes/)?.[1]) || 4096;
    const pages = (label) => {
      const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s+(\\d+)\\.`);
      return Number(vmOut.match(re)?.[1]) || 0;
    };
    const wired = pages("Pages wired down");
    const compressed = pages("Pages occupied by compressor");
    const purgeable = pages("Pages purgeable");
    const anonymous = pages("Anonymous pages");

    const appBytes = Math.max(0, anonymous - purgeable) * pageSize;
    const wiredBytes = wired * pageSize;
    const compressedBytes = compressed * pageSize;
    const usedBytes = appBytes + wiredBytes + compressedBytes;

    let swapUsedBytes = 0;
    const swapMatch = (swapRes.stdout || "").match(/used\s*=\s*([\d.]+)([KMGT])/);
    if (swapMatch) {
      const n = Number(swapMatch[1]);
      const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[swapMatch[2]] || 1;
      swapUsedBytes = Math.round(n * mult);
    }

    // 真正的 memory pressure 在内核里 (MEMORYSTATUS_VM_PRESSURE),CLI 拿不到实时值。
    // 这里用 swap + compressed 占比做启发: 出现 swap 就是已经在挤了, compressed 占比高
    // 说明系统开始大量压缩冷页。两个信号都不算"已经卡",所以阈值取得保守一点。
    const compressedRatio = totalMemBytes > 0 ? compressedBytes / totalMemBytes : 0;
    const swapGB = swapUsedBytes / (1024 ** 3);
    let pressure = "normal";
    if (swapGB >= 4 || compressedRatio >= 0.4) pressure = "critical";
    else if (swapGB >= 1 || compressedRatio >= 0.2) pressure = "warn";

    return { usedBytes, compressedBytes, swapUsedBytes, pressure };
  } catch {
    return null;
  }
}

// 解析 macOS top 的 MEM 字段 (形如 "506M" / "1.2G" / "8192K" / 裸数字默认 KB)
function parseTopMemToken(token) {
  if (!token) return 0;
  const m = String(token).match(/^([\d.]+)([KMGT])?\+?$/i);
  if (!m) return 0;
  const num = Number(m[1]);
  const unit = (m[2] || "K").toUpperCase();
  const mul = { K: 1024, M: 1024 * 1024, G: 1024 ** 3, T: 1024 ** 4 }[unit] || 1024;
  return Math.round(num * mul);
}

// 单进程 phys_footprint (macOS), 跟 Activity Monitor / vmmap 同口径.
// Electron 的 getAppMetrics().memory.workingSetSize ≈ ps rss, 含共享内存重复计算,
// 跟 sidecar (top mem) 口径不一致; 用这个统一拿 top MEM 让两边对齐.
// 不算 CPU (Electron 进程 CPU 用 getAppMetrics percentCPUUsage 更准).
async function sampleTopMemByPid(pid) {
  try {
    const { stdout } = await execFileAsync(
      "top",
      ["-l", "1", "-pid", String(pid), "-stats", "pid,mem", "-ncols", "2"],
      { windowsHide: true },
    );
    const memLine = stdout.split("\n").reverse().find((l) => /^\s*\d+\s+\S+\s*$/.test(l));
    const memToken = memLine ? memLine.trim().split(/\s+/)[1] : "";
    const bytes = parseTopMemToken(memToken);
    return bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

// 单进程 RSS + CPU 快照。
// pcpu 在 ps 里是进程生命周期均值, 不是瞬时, 但 sidecar 跑起来后基本稳定看量级够用.
//
// 内存:
//   - macOS 上 ps rss 对 mmap 文件 (llama.cpp 用 mmap 加载 GGUF) 统计不准, 只算已 touched
//     的 dirty 页; 同一进程 Activity Monitor 显示 500MB 时 ps rss 可能只有 8MB.
//     用 top 拿 MEM 字段 (= phys_footprint, 跟 Activity Monitor 同口径).
//   - Linux 上 ps rss 已是准的, 保留.
async function samplePsByPid(pid) {
  try {
    if (process.platform === "darwin") {
      const [psResult, topResult] = await Promise.all([
        execFileAsync("ps", ["-p", String(pid), "-o", "pcpu="], { windowsHide: true }),
        execFileAsync(
          "top",
          ["-l", "1", "-pid", String(pid), "-stats", "pid,mem", "-ncols", "2"],
          { windowsHide: true },
        ),
      ]);
      const pcpu = Number(psResult.stdout.trim());
      // top 输出形如:
      //   PID    MEM
      //   23610  506M
      // 倒序找第一条 "<pid> <mem>" 模式的行
      const memLine = topResult.stdout
        .split("\n")
        .reverse()
        .find((l) => /^\s*\d+\s+\S+\s*$/.test(l));
      const memToken = memLine ? memLine.trim().split(/\s+/)[1] : "";
      return {
        cpuPercent: Number.isFinite(pcpu) ? Math.round(pcpu * 10) / 10 : 0,
        memoryBytes: parseTopMemToken(memToken),
      };
    }

    // Linux / 其他 unix: ps rss 够准
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pcpu=,rss="], {
      windowsHide: true,
    });
    const parts = stdout.trim().split(/\s+/);
    const pcpu = Number(parts[0]);
    const rssKB = Number(parts[1]);
    return {
      cpuPercent: Number.isFinite(pcpu) ? Math.round(pcpu * 10) / 10 : 0,
      memoryBytes: Number.isFinite(rssKB) ? rssKB * 1024 : 0,
    };
  } catch {
    return null;
  }
}

function mapElectronProcKind(type) {
  if (type === "Browser") return "main";
  if (type === "Tab") return "renderer";
  if (type === "GPU") return "gpu";
  return "utility";
}

function electronProcLabel(m) {
  if (m.type === "Browser") return "主进程";
  if (m.type === "Tab") return m.name || "渲染进程";
  if (m.type === "GPU") return "GPU";
  if (m.type === "Utility") {
    const svc = m.serviceName || "";
    if (svc.includes("network")) return "网络服务";
    if (svc.includes("storage")) return "存储服务";
    if (svc.includes("audio")) return "音频服务";
    if (svc.includes("video")) return "视频服务";
    if (svc.includes("utility")) return "工具服务";
    return m.name || "工具进程";
  }
  if (m.type === "Zygote") return "Zygote";
  if (m.type === "Sandbox helper") return "沙盒辅助";
  return m.type || "未知";
}

function electronProcDetail(m) {
  if (m.type === "Utility" && m.serviceName) {
    // chromium service name 形如 "network.mojom.NetworkService", 取最后一段简化展示
    const segs = m.serviceName.split(".");
    return segs[segs.length - 1];
  }
  if (m.name && m.type !== "Browser" && m.type !== "Tab") return m.name;
  return undefined;
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

// Two URL shapes carried by the `media://` protocol:
//
//   media://external/<encoded-abs-path>            user-owned file at an arbitrary location
//                                                  (e.g. ~/Downloads/foo.mp4) — must stay
//                                                  absolute because there is no project root
//                                                  to express it against.
//
//   media://project/<projectId>/<encoded-rel>      artifact inside the project's directory
//                                                  under userData. Stored relative so the URL
//                                                  survives userData renames / backups /
//                                                  exported project bundles.
function createExternalMediaUrl(absPath) {
  return `media://external/${encodeURIComponent(absPath)}`;
}

function createProjectMediaUrl(projectId, framePath) {
  const projectDir = getProjectDir(projectId);
  const rel = path.isAbsolute(framePath) ? path.relative(projectDir, framePath) : framePath;
  const encoded = rel.split(path.sep).map(encodeURIComponent).join("/");
  return `media://project/${encodeURIComponent(projectId)}/${encoded}`;
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
    headers: { "user-agent": "clipiq-electron" },
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

function getAnalysisDir(projectId, analysisId) {
  return path.join(getProjectDir(projectId), "analyses", analysisId);
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
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      data TEXT NOT NULL,
      nodes TEXT,
      report TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_project ON analyses(project_id);
    -- v2: 对标账号 (UP 主) 元数据 + 跨视频汇总出的 methodology manifest
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- v2: 剪辑助手会话
    CREATE TABLE IF NOT EXISTS studio_sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- v2: 素材库的镜头索引 (一条 asset 对应多条 shot)
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY,
      asset_project_id TEXT NOT NULL,
      shot_index INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (asset_project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shots_asset ON shots(asset_project_id);
    -- v2.1: 账号下挂的视频元数据 (拉取产物). 真正分析时才派生 Project。
    CREATE TABLE IF NOT EXISTS account_videos (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      data TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_videos_account ON account_videos(account_id);
  `);

  // v3 迁移: 旧 1:1 分析表 → 新 1:N analyses 表
  try {
    const hasOldNodes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_nodes'").get();
    if (hasOldNodes) {
      db.exec("DROP TABLE IF EXISTS analysis_nodes");
      db.exec("DROP TABLE IF EXISTS analysis_reports");
      // 清掉项目根目录下的旧分析文件 (现在放 analyses/<id>/ 子目录)
      try {
        const projectsDir = path.join(app.getPath("userData"), "projects");
        const entries = fsSync.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory());
        for (const entry of entries) {
          for (const name of ["analysis-result.json", "timings.json", "token-usage.json"]) {
            try { fsSync.unlinkSync(path.join(projectsDir, entry.name, name)); } catch { /* noop */ }
          }
        }
      } catch { /* noop */ }
      // 清掉 projects 表里旧的分析字段
      const allProjects = db.prepare("SELECT id, data FROM projects").all();
      for (const row of allProjects) {
        try {
          const proj = JSON.parse(row.data);
          delete proj.providerId;
          delete proj.model;
          delete proj.analysisOptions;
          delete proj.analysisStartedAt;
          delete proj.lastErrorMessage;
          delete proj.lastErrorAt;
          if (proj.status === "completed" || proj.status === "failed" || proj.status === "analyzing") {
            proj.status = "not_analyzed";
          }
          proj.currentAnalysisId = undefined;
          db.prepare("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(proj), row.id);
        } catch { /* noop */ }
      }
      log.info("db", "v3 迁移完成: 旧 analysis_nodes/analysis_reports 表已清除");
    }
  } catch (migErr) {
    log.warn("db", "v3 迁移失败:", migErr?.message || migErr);
  }

  // v2.1 迁移: 旧的 projects(kind='account_video', status='not_analyzed', localVideoPath='')
  // 全部转到 account_videos 表;有 status=completed/analyzing 的保留 project (会被 analysisProjectId 链回去)。
  try {
    const candidates = db.prepare("SELECT id, data FROM projects").all();
    for (const row of candidates) {
      let proj = null;
      try { proj = JSON.parse(row.data); } catch { continue; }
      if (!proj || proj.kind !== "account_video") continue;
      if (!proj.accountId) continue;
      const externalUrl = proj.source && proj.source.type === "url" ? proj.source.url : "";
      const externalId = (proj.id || "").replace(/^acvid-[^-]+-/, "") || externalUrl;
      const avId = `av-${proj.accountId}-${externalId}`;
      const platform = (proj.source && proj.source.type === "url" && proj.source.platform) || "unknown";
      const completed = proj.status === "completed" || proj.status === "analyzing";
      const av = {
        id: avId,
        accountId: proj.accountId,
        externalId,
        externalUrl,
        title: proj.videoName || "(未命名视频)",
        durationSec: proj.durationSec || 0,
        thumbnailUrl: proj.thumbnailUrl,
        uploadDate: null,
        viewCount: 0,
        platform,
        addedAt: proj.createdAt || new Date().toISOString(),
        analysisProjectId: completed ? proj.id : undefined,
      };
      const existing = db.prepare("SELECT id FROM account_videos WHERE id = ?").get(avId);
      if (!existing) {
        db.prepare(
          "INSERT INTO account_videos (id, account_id, data, added_at) VALUES (?, ?, ?, ?)"
        ).run(avId, proj.accountId, JSON.stringify(av), Date.parse(av.addedAt) || Date.now());
      }
      if (!completed) {
        // 删空壳 project (没本地视频、还没分析)
        db.prepare("DELETE FROM projects WHERE id = ?").run(proj.id);
      } else {
        // 把已分析的 project 改成 kind=analysis,保留 accountId 反向引用
        const proj2 = { ...proj, kind: "analysis" };
        db.prepare("UPDATE projects SET data = ? WHERE id = ?")
          .run(JSON.stringify(proj2), proj.id);
      }
    }
  } catch (e) {
    log.warn("migration", "account_video → account_videos 失败:", e?.message || e);
  }

  // 上次进程退出时还停在 fetchPhase=fetching 的账号 → 改 idle (避免 UI 一直转)
  try {
    const rows = db.prepare("SELECT id, data FROM accounts").all();
    for (const row of rows) {
      let acc = null;
      try { acc = JSON.parse(row.data); } catch { continue; }
      if (!acc || acc.fetchPhase !== "fetching") continue;
      const patched = { ...acc, fetchPhase: "idle", fetchError: undefined };
      db.prepare("UPDATE accounts SET data = ? WHERE id = ?").run(JSON.stringify(patched), row.id);
    }
  } catch (e) {
    log.warn("boot", "reset fetching → idle 失败:", e?.message || e);
  }

  // 上次进程退出时还停在 status=analyzing 的项目 → 根据是否有 completed 分析记录
  // 恢复到 completed 或 not_analyzed (避免重启后 UI 重新触发分析)
  try {
    const rows = db.prepare("SELECT id, data FROM projects").all();
    for (const row of rows) {
      let proj = null;
      try { proj = JSON.parse(row.data); } catch { continue; }
      if (!proj || proj.status !== "analyzing") continue;
      // 检查是否有已完成的分析记录
      const aid = proj.currentAnalysisId;
      let hasCompleted = false;
      if (aid) {
        const ar = db.prepare("SELECT data FROM analyses WHERE id = ?").get(aid);
        if (ar) {
          try {
            const rec = JSON.parse(ar.data);
            hasCompleted = rec.status === "completed";
          } catch { /* noop */ }
        }
      }
      const newStatus = hasCompleted ? "completed" : "not_analyzed";
      proj.status = newStatus;
      db.prepare("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(proj), row.id);
      log.info("boot", `project ${row.id} status analyzing → ${newStatus}`);
    }
  } catch (e) {
    log.warn("boot", "reset analyzing projects 失败:", e?.message || e);
  }

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
  const text = JSON.stringify(payload, null, 2);
  try {
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    // rename ENOENT = tmp 在 writeFile 之后被外部移走了 (并发 writeJson 抢同一路径 /
    // 系统 cleanup / 用户取消触发的 reset 等)。不用 atomic 保证, 直接覆写 final 文件让
    // 流程往下走。artifacts JSON 不是关键数据 (内存里 transcript 还在用), 半残文件下次
    // 跑会自愈, 容错优先于 atomicity。
    if (err?.code === "ENOENT") {
      await fs.writeFile(filePath, text, "utf8");
      // 顺手清理可能残留的 tmp (rename 抛 ENOENT 说明大概率 tmp 已经没了, 但 best-effort)
      await fs.unlink(tmp).catch(() => { /* noop */ });
      return;
    }
    throw err;
  }
}

// 主分析失败 catch 里立刻落一次盘。
// 目的:分析后续阶段如果再 crash / Mac sleep 杀掉进程 / 用户关 app,
// 至少 SQLite 和 JSON 都有这次跑的 failed report, 不会停在上次跑的旧数据上。
// 不写 projects 表(让最终成功路径决定 status); 不更新 timings(timings 是 mutable 数组, 最终路径会再写一遍)。
async function persistEarlySnapshot(project, analysisId, nodes, report, timings, analysisStartedAt) {
  const snapshotReport = {
    ...report,
    timings: [...timings],
    totalDurationMs: Date.now() - analysisStartedAt,
  };
  try {
    const analysisDir = getAnalysisDir(project.id, analysisId);
    await fs.mkdir(analysisDir, { recursive: true });
    await writeJson(path.join(analysisDir, "analysis-result.json"), {
      analysisId,
      project,
      nodes,
      report: snapshotReport,
    });
  } catch (err) {
    await appendPersistErrorLog(project.id, "persistEarlySnapshot writeJson", err);
  }
  try {
    const db = getDb();
    db.prepare("UPDATE analyses SET nodes = ?, report = ? WHERE id = ?")
      .run(JSON.stringify(nodes), JSON.stringify(snapshotReport), analysisId);
  } catch (err) {
    await appendPersistErrorLog(project.id, "persistEarlySnapshot SQLite", err);
  }
}

// 落盘错误日志(SQLite 持久化失败 / fallback 自愈失败 等)。
// console 在 packaged app 里没 stdout 落盘, 这里直接 append 到项目目录, 出问题能事后查。
async function appendPersistErrorLog(projectId, where, err) {
  try {
    const dir = getProjectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const msg = err?.stack || err?.message || String(err);
    await fs.appendFile(
      path.join(dir, "persist-error.log"),
      `[${new Date().toISOString()}] [${where}] ${msg}\n\n`,
    );
  } catch {
    // best-effort, 不影响业务
  }
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

// 远程 model id → capabilities 推断,规则表与辅助函数都在 model-detection-rules.cjs.
// 规则集对齐 cherry-studio main 分支 config/models/{vision,reasoning,embedding}.ts,
// 覆盖 GPT-4/5 / Claude 3-4 / Gemini 1.5-3 / Qwen-VL / GLM / Doubao / Kimi 等主流家族.
const { inferCapabilitiesFromRemoteId } = require("./model-detection-rules.cjs");

// 把远程 /models 里的一条原始 entry map 成 ModelDescriptor
function remoteEntryToDescriptor(entry) {
  const id = String(entry?.id || "").trim();
  if (!id) return null;
  const capabilities = inferCapabilitiesFromRemoteId(id);
  // 远程 thinking 模型推断: cherry-studio 的规则表已经把 OpenAI o1/o3、DeepSeek-R1、Qwen3-*、
  // GLM-4-thinking 等映成 capabilities=["reasoning",...], 直接复用。后续如果发现 capabilities
  // 标得不对(例如 R1-distill 系列其实不走 reasoning_content), 在 model-detection-rules.cjs 修。
  return {
    source: "remote",
    id,
    label: id,
    family: id.split(/[-_/]/)[0] || undefined,
    capabilities,
    capabilitiesSource: "inferred",
    availability: { state: "ready" },
    ownedBy: entry?.owned_by || undefined,
    isThinking: capabilities.includes("reasoning"),
  };
}

// 本地 llama manifest entry → ModelDescriptor
// primaryCapabilities 直接映 vision/audio_transcription/text;
// secondary 里有信息密度的(reasoning/long_context/fast)提升进 capabilities,
// 其余(chinese/english/code/video)留在 local.secondaryTags 做 UI hint
function localLlamaEntryToDescriptor(entry) {
  if (!entry) return null;
  const caps = new Set();
  if (entry.primaryCapabilities?.includes("vision")) caps.add("vision");
  if (entry.primaryCapabilities?.includes("audio")) caps.add("audio_transcription");
  if (entry.primaryCapabilities?.includes("text")) caps.add("text");
  if (entry.secondaryTags?.includes("reasoning")) caps.add("reasoning");
  if (entry.secondaryTags?.includes("long_context")) caps.add("long_context");
  if (entry.secondaryTags?.includes("fast")) caps.add("fast");

  let availability;
  if (entry.available === false) {
    availability = { state: "coming_soon" };
  } else if (entry.downloaded) {
    availability = { state: "ready" };
  } else {
    const bytes = entry.quantizations?.[0]?.sizeBytes;
    availability = bytes ? { state: "needs_install", sizeBytes: bytes } : { state: "needs_install" };
  }

  // 已提升到 capabilities 的 secondary key 从 secondaryTags 里剔除,避免 UI 重复展示
  const PROMOTED = new Set(["reasoning", "long_context", "fast"]);
  const remainingSecondary = (entry.secondaryTags || []).filter((t) => !PROMOTED.has(t));

  return {
    source: "local_llama",
    id: entry.key,
    label: entry.name,
    family: entry.family,
    params: entry.params,
    description: entry.description,
    capabilities: Array.from(caps),
    capabilitiesSource: "manifest",
    availability,
    contextSize: entry.contextSize,
    nativeContextSize: entry.nativeContextSize || entry.contextSize,
    isThinking: !!entry.isThinking,
    local: {
      fit: entry.fit,
      memPercent: entry.memPercent,
      tps: entry.tps,
      downloaded: !!entry.downloaded,
      downloadedBytes: (entry.llmBytes || 0) + (entry.mmprojBytes || 0),
      quantizations: entry.quantizations,
      secondaryTags: remainingSecondary,
    },
  };
}

// daemon recommendedModel → localLlamaEntryToDescriptor 输入格式
function daemonModelToLlamaEntry(dm) {
  return {
    key: dm.id,
    family: dm.family,
    params: dm.params,
    name: dm.name,
    description: dm.desc,
    primaryCapabilities: dm.primaryCapabilities || [],
    secondaryTags: dm.secondaryTags || [],
    available: dm.available !== false,
    contextSize: dm.contextSize,
    nativeContextSize: dm.nativeContextSize,
    quantizations: dm.quantizations || [],
    fit: dm.fit,
    memPercent: dm.memPercent,
    tps: dm.tps,
    downloaded: !!dm.ready,
    isThinking: !!dm.isThinking,
    llmBytes: 0,
    mmprojBytes: 0,
  };
}

// 本地 whisper 模型 (whisperCppRuntime.MODELS / listModels) → ModelDescriptor
function localWhisperEntryToDescriptor(entry) {
  if (!entry) return null;
  const fastKeys = new Set(["ggml-tiny", "ggml-base"]);
  const caps = ["audio_transcription"];
  if (fastKeys.has(entry.key)) caps.push("fast");
  return {
    source: "local_whisper",
    id: entry.key,
    label: entry.name || entry.key,
    family: "Whisper",
    description: entry.description,
    capabilities: caps,
    capabilitiesSource: "manifest",
    availability: entry.downloaded
      ? { state: "ready" }
      : { state: "needs_install", sizeBytes: entry.approxBytes },
    local: {
      downloaded: !!entry.downloaded,
      downloadedBytes: entry.downloadedBytes || 0,
    },
  };
}

// builtin local_llama: 内置本地推理 provider,覆盖 manifest 里所有可用模型。
// 每次 loadConfig 强制重写这个 entry,避免用户的旧配置把它覆盖。
// capabilities 派生统一走 localLlamaEntryToDescriptor,跟 listManifest 输出对齐。
//
// contextSize 解析: manifest 默认 > localModelOverrides[modelKey].contextSize (用户覆盖)。
// UI 拿到的 model.contextSize 是 effective 值, 跟 llama-server 启动时实际 --ctx-size 一致。
function buildBuiltinLocalLlamaProvider(localModelOverrides = {}) {
  const llamaRuntime = require("./llama-runtime.cjs");
  const models = Object.values(llamaRuntime.MODELS)
    .filter((meta) => meta._manifest && meta._manifest.available !== false)
    .map((meta) => {
      const descriptor = localLlamaEntryToDescriptor(meta._manifest);
      if (!descriptor) return null;
      const override = Number(localModelOverrides?.[descriptor.id]?.contextSize);
      const effectiveCtx = override > 0 ? override : descriptor.contextSize;
      return {
        id: descriptor.id,
        label: descriptor.label,
        capabilities: descriptor.capabilities,
        capabilitiesSource: descriptor.capabilitiesSource,
        family: descriptor.family,
        contextSize: effectiveCtx,
        defaultContextSize: descriptor.contextSize, // UI 显示"默认 ctx"对比用
        nativeContextSize: descriptor.nativeContextSize, // ctx slider 上限
        localKey: descriptor.id,
        // isThinking 从 manifest 透传到 model 列表, 上层 UI / 任务分配能基于此决定要不要给"启用思考"开关
        isThinking: !!meta._manifest.isThinking,
      };
    })
    .filter(Boolean);
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
  return shapeEffectiveProvider(provider, model, slot);
}

function resolveAudioProvider(config) {
  const slot = config?.audioSlot;
  if (!slot) return null;
  const provider = config.providers?.find((p) => p.id === slot.providerId);
  const model = provider?.models?.find((m) => m.id === slot.modelId);
  if (!provider || !model) return null;
  return shapeEffectiveProvider(provider, model, slot);
}

function shapeEffectiveProvider(provider, model, slot) {
  // local_llama 的 baseUrl / apiKeyRef 由 llama-manager 在请求时动态注入,
  // 这里只占位; openai-client 看到 provider.source === "local_llama" 会自动 acquire slot。
  // 不在这里读 runtime.getStatus(): 那样拿到的 port 是"当前 server", 但当前 server
  // 跑的不一定就是 model.id; 真正切换在 acquire 内做。
  const baseUrl = provider.source === "local_llama" ? "http://127.0.0.1:0/v1" : provider.baseUrl;
  const apiKeyRef = provider.source === "local_llama" ? "local" : provider.apiKeyRef;
  return {
    ...provider,
    baseUrl,
    apiKeyRef,
    model: model.id,
    contextSize: model.contextSize ?? provider.contextSize,
    maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    temperature: model.temperature ?? provider.temperature,
    localWhisperModel: model.localWhisperModel || provider.localWhisperModel,
    localWhisperMirror: model.localWhisperMirror || provider.localWhisperMirror,
    language: model.language || provider.language,
    // thinking 模型挂在 model 上, "是否启用思考"挂在 slot 上 (任务分配维度的运行时开关)。
    // 下游 openai-client 用 effectiveProvider.enableThinking 决定要不要传
    // chat_template_kwargs.enable_thinking=true。slot.enableThinking 不为 true 时 = 默认关。
    isThinking: !!model.isThinking,
    enableThinking: slot?.enableThinking === true,
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

  const localModelOverrides = cfg.localModelOverrides && typeof cfg.localModelOverrides === "object"
    ? cfg.localModelOverrides
    : {};
  const providers = [
    buildBuiltinLocalLlamaProvider(localModelOverrides),
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
    ...cfg,
    providers,
    taskSlots,
    audioSlot,
    localModelOverrides,
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
    log.warn("url-cache", "write failed", err);
  }
}

// 用 medium_text 模型生成项目标题。接受三种证据源, 至少一个有内容才会调 LLM:
//   - rawInput:   用户粘贴的整段分享文案 (URL 拉取场景)
//   - ytdlpInfo:  yt-dlp --write-info-json 拿到的平台 metadata (title/description/uploader)
//   - summary:    分析阶段产出的 globalSummary (本地视频场景, 没有外部文案时的兜底)
// 失败 / 信息都缺 / provider 未配置 都返回 null, 让调用方 fallback。
async function generateProjectTitle(provider, sources = {}, handle = null) {
  if (!provider?.apiKeyRef || !provider?.baseUrl || !provider?.model) {
    log.warn("title-gen",
      `short-circuit: provider 不完整 apiKeyRef=${!!provider?.apiKeyRef} ` +
      `baseUrl=${!!provider?.baseUrl} model=${!!provider?.model}`,
    );
    return null;
  }
  const { rawInput, url, ytdlpInfo, summary } = sources;
  const rawTextOnly = String(rawInput || "").replace(url || "", "").trim();
  const haveYtdlp = !!(ytdlpInfo && (ytdlpInfo.title || ytdlpInfo.description));
  const haveSummary = !!(summary && summary.length >= 10);
  if (rawTextOnly.length < 5 && !haveYtdlp && !haveSummary) {
    log.warn("title-gen",
      `short-circuit: 信息源都不够 rawTextLen=${rawTextOnly.length} ` +
      `haveYtdlp=${haveYtdlp} haveSummary=${haveSummary} summaryLen=${summary?.length || 0}`,
    );
    return null;
  }

  const lines = [];
  if (rawInput) lines.push("# 用户分享文案", rawInput, "");
  if (haveYtdlp) {
    lines.push("# 平台元数据 (来自 yt-dlp)");
    if (ytdlpInfo.title) lines.push(`原标题: ${ytdlpInfo.title}`);
    if (ytdlpInfo.uploader) lines.push(`创作者: ${ytdlpInfo.uploader}`);
    if (ytdlpInfo.description) lines.push(`简介: ${String(ytdlpInfo.description).slice(0, 400)}`);
    lines.push("");
  }
  if (haveSummary) {
    lines.push("# 分析阶段产出的全局摘要", summary, "");
  }
  lines.push("请综合上面信息, 输出 JSON: { \"title\": \"...\" }");

  try {
    const result = await openaiClient.callJsonCompletion(provider, {
      systemText:
        "你是视频拉片助理。我会给你一段视频的若干信息来源 (用户粘贴的分享文案 / 平台 metadata / 分析阶段总结), " +
        "请提炼一个 6-14 个汉字的简洁标题, 用作项目卡片显示。\n" +
        "规则:\n" +
        "- 6-14 汉字, 不带英文字母 / emoji / # 话题 / @用户名\n" +
        "- 概括视频拍什么 / 讲什么 / 风格氛围, 不要简单复读原文\n" +
        "- 多源信息冲突时优先平台原标题, 但去噪 (去口播停顿词 / 平台水印)\n" +
        "- 信息不足以判断时用'未命名视频'\n" +
        "- 直接返回 JSON, 不要 markdown 围栏, 不要思考过程",
      userText: lines.join("\n"),
      temperature: 0.3,
      signal: handle?.abortController?.signal,
    });
    const t = String(result.parsed?.title || "").trim();
    const diagnostic = {
      rawLen: (result.raw || "").length,
      reasoningLen: (result.reasoning || "").length,
      parsedSource: result.parsedSource,
      rawHead: (result.raw || "").slice(0, 200),
      reasoningHead: (result.reasoning || "").slice(0, 200),
      parsedTitle: t,
      parsedTitleLen: t.length,
    };
    if (!t || t.length > 30) {
      log.warn("title-gen",
        `模型返回 title 不合规: title=${JSON.stringify(t)} len=${t.length} ` +
        `rawLen=${diagnostic.rawLen} reasoningLen=${diagnostic.reasoningLen} ` +
        `parsedSource=${result.parsedSource} raw=${JSON.stringify(diagnostic.rawHead)}`,
      );
      // 失败也返回带诊断信息的对象 (title 为 null), 让上层能落到 analysis-error.log
      return { title: null, usage: result.usage, echoedModel: result.model, _diagnostic: diagnostic };
    }
    return { title: t, usage: result.usage, echoedModel: result.model, _diagnostic: diagnostic };
  } catch (err) {
    log.warn("title-gen", "失败:", err.message || err);
    return null;
  }
}

async function loadMediumTextProvider() {
  try {
    const cfg = migrateConfigV1ToV2(await readJson(getConfigPath(), null));
    return resolveSlotProvider(cfg, "medium_text");
  } catch {
    return null;
  }
}

async function loadComplexTextProvider() {
  try {
    const cfg = migrateConfigV1ToV2(await readJson(getConfigPath(), null));
    // v2 任务槽位: complex_text 用于复杂文本(方法论汇总 / Studio steps);
    // 没配的话 fallback 到 medium_text
    return resolveSlotProvider(cfg, "complex_text") || resolveSlotProvider(cfg, "medium_text");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 账号 (UP 主) 信息抓取工具
// 平台 native API 优先拿头像/粉丝/简介 (yt-dlp 的 flat-playlist 输出在不少
// 平台缺这些字段或被反爬拦截), 视频列表用 yt-dlp (它内置 wbi 签名等反爬绕过).

function detectAccountPlatform(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("bilibili.com") || u.includes("b23.tv")) return "bilibili";
  if (u.includes("douyin.com")) return "douyin";
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com")) return "xiaohongshu";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("tiktok.com")) return "tiktok";
  return "unknown";
}

// 从 https://space.bilibili.com/123456/... 提取 mid
function parseBilibiliMid(url) {
  const m = String(url || "").match(/space\.bilibili\.com\/(\d+)/);
  return m ? m[1] : null;
}

// 抖音用户主页 https://www.douyin.com/user/MS4w... 提取 sec_uid
function parseDouyinSecUid(url) {
  const m = String(url || "").match(/douyin\.com\/user\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// 中文/英文格式化粉丝数
function formatFollowersCount(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(n);
}

// 从 yt-dlp thumbnails 列表里选最大尺寸
function pickBestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  let best = null;
  let bestSize = -1;
  for (const t of thumbnails) {
    const size = (Number(t?.width) || 0) + (Number(t?.height) || 0);
    if (size > bestSize) { bestSize = size; best = t; }
  }
  return best?.url || null;
}

// B 站访客 cookie — 不带就是风控-352. 完整流程:
//   1) GET bilibili.com 拿 b_lsid / _uuid 等基础 cookie
//   2) GET /x/frontend/finger/spi 拿 b_3 (buvid3) / b_4 (buvid4) — 关键, 否则 -352
//   3) 拼成完整 Cookie 字符串
const BILI_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const _bilibiliCookieCache = { value: null, fetchedAt: 0 };

function parseSetCookies(res) {
  let arr = [];
  if (typeof res.headers.getSetCookie === "function") {
    arr = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get("set-cookie") || "";
    arr = raw.split(/,(?=\s?[A-Za-z_]+=)/);
  }
  return arr
    .map((c) => String(c).split(";")[0].trim())
    .filter((c) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(c));
}

async function getBilibiliVisitorCookie() {
  if (_bilibiliCookieCache.value && Date.now() - _bilibiliCookieCache.fetchedAt < 60 * 60_000) {
    return _bilibiliCookieCache.value;
  }
  try {
    // step 1: 主站拿基础 cookie
    const homeRes = await fetch("https://www.bilibili.com/", {
      method: "GET",
      headers: {
        "User-Agent": BILI_BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    const baseCookies = parseSetCookies(homeRes);

    // step 2: /x/frontend/finger/spi 拿 b_3/b_4 = buvid3/buvid4
    let buvid3 = "";
    let buvid4 = "";
    try {
      const spiRes = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        method: "GET",
        headers: {
          "User-Agent": BILI_BROWSER_UA,
          "Referer": "https://www.bilibili.com/",
          "Accept": "application/json, text/plain, */*",
          "Cookie": baseCookies.join("; "),
        },
      });
      if (spiRes.ok) {
        const spiData = await spiRes.json();
        buvid3 = spiData?.data?.b_3 || "";
        buvid4 = spiData?.data?.b_4 || "";
      }
    } catch { /* spi 拿不到也继续, 用 baseCookies 兜底 */ }

    const merged = [...baseCookies];
    if (buvid3) merged.push(`buvid3=${buvid3}`);
    if (buvid4) merged.push(`buvid4=${buvid4}`);
    const cookieStr = merged.join("; ");
    if (cookieStr) {
      _bilibiliCookieCache.value = cookieStr;
      _bilibiliCookieCache.fetchedAt = Date.now();
    }
    return cookieStr;
  } catch {
    return "";
  }
}

// B 站 wbi 签名 — Web 端从 2023-03 起所有受保护 API 都要带 wts + w_rid 否则 -403/412
// 算法源: bilibili-API-collect/docs/misc/sign/wbi.md
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const _wbiKeyCache = { mixinKey: null, fetchedAt: 0 };
const _crypto = require("node:crypto");

async function getBilibiliWbiMixinKey() {
  // wbi keys 每天会换, 30 分钟 cache
  if (_wbiKeyCache.mixinKey && Date.now() - _wbiKeyCache.fetchedAt < 30 * 60_000) {
    return _wbiKeyCache.mixinKey;
  }
  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Referer": "https://www.bilibili.com/",
    },
  });
  if (!res.ok) throw new Error(`wbi nav HTTP ${res.status}`);
  const data = await res.json();
  const imgUrl = data?.data?.wbi_img?.img_url || "";
  const subUrl = data?.data?.wbi_img?.sub_url || "";
  const extractKey = (u) => {
    const m = String(u).match(/\/([0-9a-f]+)\.png$/i);
    return m ? m[1] : "";
  };
  const imgKey = extractKey(imgUrl);
  const subKey = extractKey(subUrl);
  if (!imgKey || !subKey) throw new Error("解析 wbi keys 失败");
  const orig = imgKey + subKey;
  const mixinKey = WBI_MIXIN_KEY_ENC_TAB.map((n) => orig[n] || "").join("").slice(0, 32);
  _wbiKeyCache.mixinKey = mixinKey;
  _wbiKeyCache.fetchedAt = Date.now();
  return mixinKey;
}

function signWbiQuery(params, mixinKey) {
  const cleaned = { ...params, wts: Math.round(Date.now() / 1000) };
  const chrFilter = /[!'()*]/g;
  const query = Object.keys(cleaned).sort().map((key) => {
    const value = String(cleaned[key]).replace(chrFilter, "");
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }).join("&");
  const w_rid = _crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${w_rid}`;
}

// "12:34" / "1:02:34" → 秒
function parseBilibiliLengthToSec(len) {
  if (!len || typeof len !== "string") return 0;
  const parts = len.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// 单条视频元数据 — /x/web-interface/view?bvid=BVxxx 对匿名访客开放
// space/arc/search 在匿名模式下只返 bvid 不返 title/length, 所以用 view 单独补全
async function fetchBilibiliVideoView(bvid, cookie) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const data = await biliFetchJson(url, {
    referer: `https://www.bilibili.com/video/${bvid}`,
    cookie,
  });
  if (data?.code !== 0) throw new Error(`view code=${data?.code} ${data?.message || ""}`);
  const v = data?.data || {};
  // B 站封面有时返 http:// , renderer 阻止 mixed content, 强制 https
  const pic = v.pic ? String(v.pic).replace(/^http:\/\//, "https://") : null;
  return {
    bvid: v.bvid || bvid,
    title: v.title || "",
    durationSec: Number(v.duration) || 0,
    uploadDate: v.pubdate
      ? new Date(Number(v.pubdate) * 1000).toISOString().slice(0, 10).replace(/-/g, "")
      : null,
    viewCount: Number(v.stat?.view) || 0,
    thumbnailUrl: pic,
  };
}

// 统一 B 站 fetch — 优先借 Chrome 插件桥 (浏览器登录态 + 真实 buvid, 绕 412/-352),
// 桥未连时回落到 node fetch (带 main 进程的 visitor cookie + UA)
async function biliFetchJson(url, { referer, cookie } = {}) {
  const baseHeaders = {
    "User-Agent": BILI_BROWSER_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "https://space.bilibili.com",
  };
  if (referer) baseHeaders["Referer"] = referer;

  if (extensionBridge.isConnected()) {
    // 走插件代理: 不传 Cookie header, 让 Chrome 自动带 (含 buvid3 / SESSDATA / b_nut)
    const result = await extensionBridge.request("fetch", {
      url,
      method: "GET",
      headers: baseHeaders,
      parse: "json",
    });
    if (!result || typeof result !== "object") throw new Error("插件返回格式错误");
    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    if (result.body?.__parseError) throw new Error(`JSON 解析失败: ${result.body.raw?.slice(0, 200)}`);
    return result.body;
  }

  // 兜底: node fetch (带 visitor cookie)
  const headers = { ...baseHeaders };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// 投稿视频列表 — wbi 签名调 /x/space/wbi/arc/search, 带访客 cookie + dm fingerprint
async function fetchBilibiliSpaceVideos(mid, limit = 20) {
  const [mixinKey, cookie] = await Promise.all([
    getBilibiliWbiMixinKey(),
    getBilibiliVisitorCookie(),
  ]);
  const ps = Math.max(1, Math.min(50, limit));
  // dm_img_* 是 B 站 web 端的 webgl/canvas 指纹参数, 不传会触发 -352.
  // 用固定值容易被 B 站签名指纹库拉黑, 参考 yt-dlp BilibiliSpaceVideoIE 每次随机.
  const randAlnum = (len) => {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < len; i++) out += charset[Math.floor(Math.random() * charset.length)];
    return out;
  };
  const dmImgStr = randAlnum(16 + Math.floor(Math.random() * 48));
  const dmCoverImgStr = randAlnum(32 + Math.floor(Math.random() * 96));
  const dmImgInter = JSON.stringify({
    ds: [],
    wh: [
      5000 + Math.floor(Math.random() * 4000),
      5000 + Math.floor(Math.random() * 4000),
      30 + Math.floor(Math.random() * 10),
    ],
    of: [
      200 + Math.floor(Math.random() * 200),
      400 + Math.floor(Math.random() * 400),
      200 + Math.floor(Math.random() * 200),
    ],
  });
  const qs = signWbiQuery({
    mid: String(mid),
    ps: String(ps),
    tid: "0",
    pn: "1",
    order: "pubdate",
    platform: "web",
    web_location: "1550101",
    order_avoided: "true",
    dm_img_list: "[]",
    dm_img_str: dmImgStr,
    dm_cover_img_str: dmCoverImgStr,
    dm_img_inter: dmImgInter,
  }, mixinKey);
  const url = `https://api.bilibili.com/x/space/wbi/arc/search?${qs}`;
  const data = await biliFetchJson(url, {
    referer: `https://space.bilibili.com/${mid}/video`,
    cookie,
  });
  if (data?.code !== 0) throw new Error(`code=${data?.code} ${data?.message || ""}`);
  const vlist = data?.data?.list?.vlist || [];
  const total = Number(data?.data?.page?.count) || vlist.length;
  let videos = vlist.map((v) => ({
    id: v.bvid || "",
    title: v.title || "",
    durationSec: parseBilibiliLengthToSec(v.length),
    uploadDate: v.created
      ? new Date(Number(v.created) * 1000).toISOString().slice(0, 10).replace(/-/g, "")
      : null,
    viewCount: Number(v.play) || 0,
    externalUrl: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : "",
    thumbnailUrl: v.pic ? String(v.pic).replace(/^http:\/\//, "https://") : null,
  })).filter((v) => v.id);

  // B 站匿名访客的 arc/search 只返 bvid 不返 title/duration. 用 view API 并发补全.
  const incomplete = videos.filter((v) => !v.title || !v.durationSec);
  if (incomplete.length > 0) {
    const enriched = await Promise.all(
      incomplete.map((v) => fetchBilibiliVideoView(v.id, cookie).catch((err) => {
        log.warn("bili-view", `${v.id} failed:`, err?.message || String(err));
        return null;
      }))
    );
    const byBvid = new Map();
    for (const e of enriched) {
      if (e) byBvid.set(e.bvid, e);
    }
    videos = videos.map((v) => {
      const e = byBvid.get(v.id);
      if (!e) return v;
      return {
        ...v,
        title: v.title || e.title || "(未命名视频)",
        durationSec: v.durationSec || e.durationSec,
        uploadDate: v.uploadDate || e.uploadDate,
        viewCount: v.viewCount || e.viewCount,
        thumbnailUrl: v.thumbnailUrl || e.thumbnailUrl,
      };
    });
  }
  // 保底 title
  videos = videos.map((v) => ({ ...v, title: v.title || "(未命名视频)" }));
  return { videos, total };
}

// B 站公开 card API — 不需要登录/签名, 但要 UA + Referer 否则容易 412
// 文档: github.com/SocialSisterYi/bilibili-API-collect /docs/user/info.md
async function fetchBilibiliCard(mid) {
  if (!mid) throw new Error("missing mid");
  const url = `https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=false`;
  const data = await biliFetchJson(url, { referer: "https://www.bilibili.com/" });
  if (data?.code !== 0) throw new Error(`code=${data?.code} ${data?.message || ""}`);
  const card = data?.data?.card || {};
  return {
    mid: String(card.mid || mid),
    name: card.name || null,
    face: card.face ? String(card.face).replace(/^http:\/\//, "https://") : null,
    sign: card.sign || null,
    fansFormatted: formatFollowersCount(card.fans),
    archiveCount: Number(data?.data?.archive_count) || 0,
  };
}

// 抖音 aweme 原始数据 → 标准 video 对象 (含互动数据 + play_url 直链)
function normalizeDouyinAweme(a) {
  const id = String(a?.aweme_id || "");
  const cover =
    a?.video?.cover?.url_list?.[0] ||
    a?.video?.origin_cover?.url_list?.[0] ||
    null;
  const playUrls = a?.video?.play_addr?.url_list || [];
  const dur = Number(a?.video?.duration) || 0; // 抖音 duration 单位是 ms
  const createTs = Number(a?.create_time) || 0; // 秒
  const stats = a?.statistics || {};
  return {
    id,
    title: a?.desc || "(未命名视频)",
    durationSec: Math.round(dur / 1000),
    uploadDate: createTs
      ? new Date(createTs * 1000).toISOString().slice(0, 10).replace(/-/g, "")
      : null,
    viewCount: Number(stats.play_count) || 0,
    likeCount: Number(stats.digg_count) || 0,
    commentCount: Number(stats.comment_count) || 0,
    shareCount: Number(stats.share_count) || 0,
    collectCount: Number(stats.collect_count) || 0,
    externalUrl: id ? `https://www.douyin.com/video/${id}` : "",
    thumbnailUrl: cover ? String(cover).replace(/^http:\/\//, "https://") : null,
    playUrl: playUrls[0] || null,
  };
}

// 解析抖音 extensionBridge 单页响应, 返回 { list, hasMore, maxCursor }
function parseDouyinBridgeResponse(result) {
  if (!result || !result.ok) throw new Error(`HTTP ${result?.status ?? "?"}`);
  const body = result.body;
  if (body?.__parseError) throw new Error(`JSON 解析失败: ${body.raw?.slice(0, 200)}`);
  if (body?.__error) throw new Error(body.__error);
  if (Number(body?.status_code) !== 0 && body?.status_code != null) {
    throw new Error(`status_code=${body.status_code} ${body?.status_msg || ""}`);
  }
  const list = Array.isArray(body?.aweme_list) ? body.aweme_list : [];
  return {
    list,
    hasMore: Boolean(body?.has_more) && list.length > 0,
    maxCursor: String(body?.max_cursor ?? ""),
  };
}

// 抖音用户资料 — 通过 user/profile/other API 获取 (不需要 BrowserWindow / 插件桥, Node.js fetch 即可).
async function fetchDouyinUserProfile(secUid) {
  const DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
  const params = new URLSearchParams({ sec_user_id: secUid, aid: "6383" });
  const res = await fetch(`https://www.douyin.com/aweme/v1/web/user/profile/other/?${params}`, {
    headers: {
      "user-agent": DEFAULT_UA,
      referer: `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
      accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status_code !== 0) throw new Error(`status_code=${data.status_code} ${data.status_msg || ""}`);
  const u = data.user;
  if (!u) throw new Error("API 未返回 user 字段");
  return {
    nickname: u.nickname || null,
    avatarUrl: (u.avatar_larger?.url_list?.[0] || u.avatar_medium?.url_list?.[0] || "").replace(/^http:\/\//, "https://") || null,
    signature: u.signature || null,
    followerCount: Number(u.follower_count) || 0,
    followingCount: Number(u.following_count) || 0,
    awemeCount: Number(u.aweme_count) || 0,
    uid: u.uid || u.short_id || null,
    secUid: u.sec_uid || null,
  };
}

// 抖音用户投稿 — 纯 Node.js fetch (不需要 BrowserWindow / 插件桥).
// 和 douyin-crawler-demo 一样的方案, 直接调 aweme/post API.
async function fetchDouyinUserPostsViaApi(secUid, limit = 18) {
  const DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
  log.info("douyin:api", `开始 API 拉取, secUid=${secUid.slice(0, 20)}... limit=${limit}`);
  const videos = [];
  let maxCursor = "0";
  let hasMore = true;
  let pageNum = 0;
  while (hasMore && videos.length < limit) {
    pageNum++;
    const count = Math.min(20, limit - videos.length);
    log.info("douyin:api", `第 ${pageNum} 页, count=${count} maxCursor=${maxCursor.slice(0, 20)}`);
    const params = new URLSearchParams({
      sec_user_id: secUid,
      max_cursor: maxCursor,
      count: String(count),
      aid: "6383",
    });
    const res = await fetch(`https://www.douyin.com/aweme/v1/web/aweme/post/?${params}`, {
      headers: {
        "user-agent": DEFAULT_UA,
        referer: `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
        accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    log.info("douyin:api", `第 ${pageNum} 页响应 status_code=${data?.status_code} aweme_list.length=${data?.aweme_list?.length ?? 0} has_more=${data?.has_more}`);
    if (data.status_code !== 0 && data.status_code != null) {
      throw new Error(`status_code=${data.status_code} ${data.status_msg || ""}`);
    }
    const list = Array.isArray(data?.aweme_list) ? data.aweme_list : [];
    const batch = list.map(normalizeDouyinAweme).filter((v) => v.id);
    log.info("douyin:api", `第 ${pageNum} 页有效 ${batch.length} 条`);
    videos.push(...batch);
    hasMore = Boolean(data.has_more) && list.length > 0;
    maxCursor = String(data.max_cursor ?? "");
    if (hasMore && videos.length < limit) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  log.info("douyin:api", `API 拉取完成, 共 ${videos.length} 条`);
  return { videos: videos.slice(0, limit), total: videos.length };
}

// 抖音用户投稿 — 经 Chrome 插件桥 (在 douyin.com tab 里调 fetch, 借 webmssdk 自动签 a_bogus).
// 支持分页拉取, limit 为最终目标数量.
async function fetchDouyinUserPosts(secUid, limit = 18) {
  if (!extensionBridge.isConnected()) {
    log.info("douyin:bridge", `插件桥未连接, 跳过 bridge 路径`);
    return null;
  }
  log.info("douyin:bridge", `开始 bridge 拉取, secUid=${secUid.slice(0, 20)}... limit=${limit}`);
  const videos = [];
  let maxCursor = "0";
  let hasMore = true;
  let pageNum = 0;
  while (hasMore && videos.length < limit) {
    pageNum++;
    const count = Math.min(20, limit - videos.length);
    log.info("douyin:bridge", `第 ${pageNum} 页, count=${count} maxCursor=${maxCursor.slice(0, 20)}`);
    const result = await extensionBridge.request(
      "douyin.userPosts",
      { secUid, count, maxCursor },
      { timeoutMs: 25_000 },
    );
    const page = parseDouyinBridgeResponse(result);
    const batch = page.list.map(normalizeDouyinAweme).filter((v) => v.id);
    log.info("douyin:bridge", `第 ${pageNum} 页返回 ${page.list.length} 条原始, 有效 ${batch.length} 条, hasMore=${page.hasMore}`);
    videos.push(...batch);
    hasMore = page.hasMore;
    maxCursor = page.maxCursor;
    if (hasMore && videos.length < limit) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  log.info("douyin:bridge", `bridge 拉取完成, 共 ${videos.length} 条`);
  return { videos: videos.slice(0, limit), total: videos.length };
}

// 抖音用户投稿 — BrowserWindow 兜底 (不需要插件桥, 用 Electron Chromium 在 douyin.com 页面上下文执行 fetch).
async function fetchDouyinUserPostsViaWindow(secUid, limit = 18) {
  log.info("douyin:window", `开始 BrowserWindow 拉取, secUid=${secUid.slice(0, 20)}... limit=${limit}`);
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    const targetUrl = `https://www.douyin.com/user/${encodeURIComponent(secUid)}`;
    log.info("douyin:window", `导航到 ${targetUrl}`);
    await win.loadURL(targetUrl, { timeout: 45_000 });
    log.info("douyin:window", "页面加载完成, 等待 2s webmssdk + 页面渲染");
    await new Promise((r) => setTimeout(r, 2000));

    const videos = [];
    let maxCursor = "0";
    let hasMore = true;
    let pageNum = 0;
    while (hasMore && videos.length < limit) {
      pageNum++;
      const count = Math.min(20, limit - videos.length);
      log.info("douyin:window", `第 ${pageNum} 页, count=${count} maxCursor=${maxCursor.slice(0, 20)}`);
      const pageData = await win.webContents.executeJavaScript(`
        (async () => {
          const params = new URLSearchParams({
            sec_user_id: ${JSON.stringify(secUid)},
            max_cursor: ${JSON.stringify(maxCursor)},
            count: String(${count}),
            aid: '6383',
          });
          const res = await fetch(
            'https://www.douyin.com/aweme/v1/web/aweme/post/?' + params,
            { method: 'GET', credentials: 'include', headers: { 'content-type': 'application/json' }, referrer: 'https://www.douyin.com/' }
          );
          return res.json();
        })()
      `);
      log.info("douyin:window", `第 ${pageNum} 页响应 status_code=${pageData?.status_code} aweme_list.length=${pageData?.aweme_list?.length ?? 0} has_more=${pageData?.has_more}`);
      if (Number(pageData?.status_code) !== 0 && pageData?.status_code != null) {
        throw new Error(`status_code=${pageData.status_code} ${pageData?.status_msg || ""}`);
      }
      const list = Array.isArray(pageData?.aweme_list) ? pageData.aweme_list : [];
      const batch = list.map(normalizeDouyinAweme).filter((v) => v.id);
      log.info("douyin:window", `第 ${pageNum} 页有效 ${batch.length} 条`);
      videos.push(...batch);
      hasMore = Boolean(pageData?.has_more) && list.length > 0;
      maxCursor = String(pageData?.max_cursor ?? "");
      if (hasMore && videos.length < limit) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    log.info("douyin:window", `BrowserWindow 拉取完成, 共 ${videos.length} 条`);
    return { videos: videos.slice(0, limit), total: videos.length };
  } finally {
    log.info("douyin:window", "销毁 BrowserWindow");
    win.destroy();
  }
}

// 从分享文案/URL 中提取第一个 URL
function extractFirstUrl(input) {
  const text = String(input || "");
  const match = text.match(/https?:\/\/[^\s，。)）\]】'"]+/i);
  return match ? match[0].replace(/[.,;)]+$/, "") : null;
}

// 解析抖音短链 (v.douyin.com) → 完整 URL
// 如果短链指向视频页面 (/video/xxx), 会尝试通过 BrowserWindow 抓取 author 的 sec_uid 并转为用户页 URL
async function resolveDouyinShortUrl(url) {
  const DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
  if (!/v\.douyin\.com/i.test(url)) {
    log.info("douyin:resolve", `非短链, 原样返回: ${url.slice(0, 80)}`);
    return url;
  }
  log.info("douyin:resolve", `检测到短链, 尝试解析: ${url.slice(0, 80)}`);
  let resolved = url;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": DEFAULT_UA, referer: "https://www.douyin.com/" },
    });
    resolved = res.url || url;
    log.info("douyin:resolve", `短链解析结果: ${resolved.slice(0, 120)}`);
  } catch (e) {
    log.warn("douyin:resolve", `短链 redirect 失败: ${e?.message || e}`);
    return url;
  }
  // 如果解析到了视频页面, 通过 aweme/detail API 获取 author sec_uid
  const videoMatch = resolved.match(/douyin\.com\/video\/(\d+)/);
  if (videoMatch) {
    const awemeId = videoMatch[1];
    log.info("douyin:resolve", `短链指向视频页面 (aweme_id=${awemeId}), 调 detail API 提取 author`);
    try {
      const params = new URLSearchParams({ aweme_id: awemeId, aid: "6383" });
      const detailRes = await fetch(`https://www.douyin.com/aweme/v1/web/aweme/detail/?${params}`, {
        headers: {
          "user-agent": DEFAULT_UA,
          referer: `https://www.douyin.com/video/${awemeId}`,
          accept: "application/json, text/plain, */*",
        },
      });
      if (detailRes.ok) {
        const detailData = await detailRes.json();
        const authorSecUid = detailData?.aweme_detail?.author?.sec_uid;
        if (authorSecUid) {
          const userUrl = `https://www.douyin.com/user/${authorSecUid}`;
          log.info("douyin:resolve", `从 detail API 提取到 author sec_uid, 转为用户页: ${userUrl.slice(0, 80)}`);
          return userUrl;
        }
        log.warn("douyin:resolve", `detail API 未返回 author sec_uid`);
      }
    } catch (e) {
      log.warn("douyin:resolve", `detail API 调用失败: ${e?.message || e}`);
    }
  }
  return resolved;
}

// yt-dlp 跑一次 flat-playlist + dump-single-json, 抽出账号元数据 + 视频列表
async function fetchYtDlpAccountJson(url, safeLimit) {
  const ytDlp = await commandPath("yt-dlp");
  if (!ytDlp) throw new Error("未安装 yt-dlp");
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(ytDlp, [
      "--flat-playlist",
      "--dump-single-json",
      "--no-warnings",
      "-I", `1:${safeLimit}`,
      url,
    ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdoutBuf, stderrBuf) => {
      if (err) return reject(new Error(stderrBuf?.toString().slice(0, 400) || err.message));
      resolve({ stdout: stdoutBuf?.toString() || "" });
    });
  });
  return JSON.parse(stdout);
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
    mediaUrl: createExternalMediaUrl(filePath),
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

// 本地初筛单帧推理时间 (Qwen3.5-0.8B @ Apple Silicon Metal 实测 ~1.1s)。
const PREFILTER_PER_FRAME_MS = 1100;

// 预筛选时间预算: 按视频时长动态计算, 保证每秒至少 1 帧被预处理。
// density 只影响倍率 (稀疏档可以少看点, 密集档多看点), 不再是固定秒数。
function prefilterBudgetSec(durationSec, options) {
  const density = options?.density || "standard";
  const multiplier = density === "dense" ? 1.5 : density === "sparse" ? 0.5 : 1.0;
  const framesToCover = Math.ceil(durationSec * multiplier);
  return Math.max(15, framesToCover * PREFILTER_PER_FRAME_MS / 1000);
}

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

// 候选抽帧数。抽帧很便宜 (~50ms/帧), 后面有 dHash 去重兜底, 所以宁可多抽。
// 下限 = max(时长公式, 镜头数, 每秒 1 帧), prefilter 预算约束在标注阶段而非抽帧阶段。
// 无 prefilter 时仍走时长公式 (全部帧直接送主分析, 抽太多会超 token 预算)。
function candidateFrameCount(durationSec, options, hasLocalPrefilter, scenesCount) {
  const finalCount = targetFrameCount(durationSec, options);
  if (!hasLocalPrefilter) return finalCount;
  const perSecFloor = Math.ceil(durationSec);
  const floor = Math.max(finalCount, scenesCount || 0, perSecFloor);
  const desired = Math.max(Math.round(floor * 1.5), floor + 8);
  return Math.max(floor, desired);
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
//   1. 每个 shot 至少 1 张(锚帧,中点), 不丢弃任何镜头
//   2. 配额 > 镜头数时, 剩余按 "duration/(count+1)" 最大的 shot 不断加点(长镜头多分)
//   3. shot 内多张时按等距均分
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

  if (shots.length === 0) {
    const count = Math.max(1, targetCount);
    return Array.from({ length: count }, (_, i) => {
      const sec = (safeDuration * (i + 1)) / (count + 1);
      return { index: i, startSec: sec, endSec: sec, midSec: Math.min(safeDuration - 0.1, sec) };
    });
  }

  // 每个 shot 至少 1 帧; 实际配额 = max(targetCount, shots.length)
  const effectiveTarget = Math.max(targetCount, shots.length);
  const counts = shots.map(() => 1);
  let remaining = effectiveTarget - shots.length;
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
function attachShotEvidenceToNodes(nodes, shots, projectId) {
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
      thumbnailUrl: createProjectMediaUrl(projectId, f.framePath),
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

// 主分析 throw 后, 把场景骨架节点重写成"分析失败"形态: 时间区间 / 字幕 / 缩略图 / prefilterTag 这些
// 是切镜头阶段的真实产物, 保留; 但 title / shotDescription / editIntent / cameraMovement / emotionLabel /
// narrativeFunction 这些需要模型才能填的字段, 一律改为"—"。避免让人误以为 "等待模型生成镜头描述。"
// 是还在跑的中间态。
function markFallbackNodesAsFailed(fallbackNodes) {
  return fallbackNodes.map((n) => {
    const idStr = String(n.id || "").replace(/^node-/, "");
    return {
      ...n,
      title: idStr ? `节点 ${idStr}` : (n.title || "未分析节点"),
      shotDescription: "—",
      editIntent: "—",
      cameraMovement: "—",
      emotionLabel: "—",
      narrativeFunction: "—",
      confidence: 0,
    };
  });
}

// 主分析 throw 后, 覆盖 fallbackReport 里那些"等待模型分析"占位文案, 改写明确的失败原因。
// report.analysisError 是新加字段, UI 可以根据它显示一个明确的失败 banner。
function markFallbackReportAsFailed(fallbackReport, errorMessage, provider) {
  const reason = String(errorMessage || "未知错误").slice(0, 500);
  return {
    ...fallbackReport,
    analysisError: {
      stage: "main-analysis",
      message: reason,
      providerId: provider?.id || null,
      model: provider?.model || null,
      occurredAt: new Date().toISOString(),
    },
    summary: `主模型分析失败：${reason}。下面的节点只是镜头切分骨架,没有模型语义分析。`,
    structure: {
      hook: "—",
      development: "—",
      turn: "—",
      climax: "—",
      ending: "—",
    },
    pacing: "—",
    editingStyle: "—",
    composition: "—",
    takeaways: [`主模型分析失败：${reason}`],
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

// JSON 解析 / SSE 拼流 / chat&responses 分流 全部抽到 openai-client.cjs,
// 这里只保留薄的转发, 避免改动太多调用点。
const { tryParseJsonFromText } = openaiClient;

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

  // 目标节点数 = 时长 / 18s 上下浮动, 钉死 2-10 的硬区间。
  // 短视频 (<30s) 不要超过 4 个; 中等 (60-120s) 4-7 个; 长 (>180s) 不超过 12 个。
  const targetNodeMin = Math.max(2, Math.round(project.durationSec / 25));
  const targetNodeMax = Math.min(12, Math.max(targetNodeMin + 2, Math.round(project.durationSec / 15)));

  const userText = [
    `请分析视频《${project.videoName}》。`,
    `时长 ${Math.round(project.durationSec)}s（lengthBucket=${methodology.lengthBucket}）, 画幅 ${project.width}x${project.height} (${project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"})。`,
    `${focusHint} ${modeHint}`,
    "",
    pyramidBlock,
    pyramidBlock ? "" : null,
    "# 节点划分规则（本规则优先级最高，违反此规则的输出会被驳回）",
    "逻辑节点 ≠ 镜头(shot)。一个逻辑节点表达「同一个目的 / 同一个信息块 / 同一段叙事意图」，通常会跨越多个连续 shot。",
    `本视频时长 ${Math.round(project.durationSec)}s, 目标节点数 ${targetNodeMin}-${targetNodeMax} 个。**禁止**给每个 shot 都建一个 node (那是镜头列表, 不是逻辑节点)。`,
    "切分规则:",
    "- 把「演示同一个参数 / 同一段示范 / 同一个情绪段 / 同一个信息点」的连续 shot 合并成 1 个 node",
    "- 每个 node 的 startSec = 该 node 覆盖的第一个 shot 的 startSec; endSec = 该 node 覆盖的最后一个 shot 的 endSec",
    "- nodeTypes 不要全部用 shot_change。按节点真实功能选: info_point (信息点/科普) / edit_intent (剪辑意图段) / emotion_turn (情绪转折) / shot_change (单纯镜头切换, 谨慎使用) / audio_change",
    "- title 写「这一段在做什么」, 不是单镜头描述。例如「参数设置详解 (ISO + 快门 + 光圈联调)」, 不是「特写相机屏幕」",
    `自检: 输出的 nodes 数组长度必须在 [${targetNodeMin}, ${targetNodeMax}] 区间内, 否则重新合并。`,
    "",
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
      "endSec":8,
      "title":"开场 hook: 抛出问题钩子",
      "nodeTypes":["info_point"],
      "shotDescription":"(本节点覆盖多个连续 shot 的画面要点)",
      "shotType":"近景",
      "cameraMovement":"固定",
      "visualElements":[],
      "audioElements":[],
      "editIntent":"建立期待 + 锁定观看意图",
      "emotionLabel":"好奇",
      "emotionIntensity":7,
      "narrativeFunction":"Hook",
      "confidence":0.9,
      "isHighlight":true,
      "methodologyTags":[
        {"ruleId":"R-HOOK-001","ruleName":"黄金 3 秒钩子","category":"hook","status":"hit","evidence":"开头特写 + 字幕 'XX' + 旁白 'YY'","confidence":0.9}
      ]
    },
    {
      "id":"node-2",
      "startSec":8,
      "endSec":33,
      "title":"参数设置详解",
      "nodeTypes":["info_point","edit_intent"],
      "shotDescription":"(本节点合并了 4 个连续 shot, 都在讲同一个参数演示)",
      "narrativeFunction":"Development",
      "isHighlight":false,
      "methodologyTags":[]
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

// 每帧 vision token 估算: 本地 llama.cpp mmproj 520px 实测 ~250 tok/帧,
// 云端模型 (GPT-4o / Gemini / Claude) tile 编码 ~600-1200, 取 800 保守估算。
const VISION_TOKENS_PER_FRAME_LOCAL = 280;
const VISION_TOKENS_PER_FRAME_REMOTE = 800;
let VISION_TOKENS_PER_FRAME = VISION_TOKENS_PER_FRAME_REMOTE;
const HARD_FRAME_CAP_FALLBACK = 12;
const HARD_FRAME_MIN = 1;

const CHUNK_SYSTEM_PROMPT =
  "你是一名视频拉片分析师, 当前正在处理整段视频的某一片段。基于本片段的镜头描述 / 关键帧 / 字幕产出本片段的节点列表。" +
  "**只产 nodes, 不要做方法论打标 (后续步骤会单独做)**。所有回答必须是合法 JSON, 不要 markdown 围栏, 不要解释。";

const AUDIT_SYSTEM_PROMPT =
  "你是一名剪辑方法论审计师。已经有完整的节点列表 + 全局摘要, 你的工作是: " +
  "(1) 对照规则集为每个节点打方法论标签 (命中 / 违反, 缺失放在 report 里), " +
  "(2) 产出全局剪辑报告 (summary / structure / pacing / takeaways / methodologyAudit)。" +
  "所有回答必须是合法 JSON, 不要 markdown 围栏, 不要解释。";

// 给 chat/completions response_format 用的宽松 schema。strict:false 让云端 OpenAI 不强制
// additionalProperties:false 等约束 (那是 strict 模式特有), llama.cpp 端编出 GBNF 强制
// 顶层结构 — probe 实测 0.8B 自由 JSON 1/3 invalid, 上 json_schema strict:false 后 4/4 valid。
// 字段内部不约束, 模型自由发挥, 后续 normalizeModelResult 兜底。
const SINGLE_PASS_OUTPUT_SCHEMA = {
  type: "object",
  properties: { nodes: { type: "array" }, report: { type: "object" } },
  required: ["nodes"],
};
const CHUNK_PASS_OUTPUT_SCHEMA = {
  type: "object",
  properties: { nodes: { type: "array" } },
  required: ["nodes"],
};
const AUDIT_PASS_OUTPUT_SCHEMA = {
  type: "object",
  properties: { nodeTags: { type: "array" }, report: { type: "object" } },
};

function buildGlobalContextBlock(project, methodology, globalContext) {
  const lines = [];
  lines.push("# 整体上下文 (帮助你理解本片段在全片中的位置)");
  lines.push(
    `视频《${project.videoName}》总时长 ${Math.round(project.durationSec)}s (lengthBucket=${methodology.lengthBucket}), 画幅 ${project.width}x${project.height} (${project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"})。`,
  );
  if (methodology.forcedGenre) lines.push(`类型: ${methodology.forcedGenre} (用户/前序识别已锁定)`);
  if (globalContext?.detectedGenre) lines.push(`类型: ${globalContext.detectedGenre} (置信度 ${(globalContext.genreConfidence || 0).toFixed(2)})`);
  if (globalContext?.globalSummary) {
    lines.push("");
    lines.push("全局摘要:");
    lines.push(globalContext.globalSummary);
  }
  if (globalContext?.structureHint) {
    const sh = globalContext.structureHint;
    lines.push("");
    lines.push("结构线索 (供参考, 不一定准):");
    if (sh.hook) lines.push(`  开场 hook: ${sh.hook}`);
    if (sh.climax) lines.push(`  高潮: ${sh.climax}`);
    if (sh.ending) lines.push(`  结尾: ${sh.ending}`);
  }
  return lines.join("\n");
}

function buildChunkShotsBlock(chunkShots) {
  if (!Array.isArray(chunkShots) || chunkShots.length === 0) return "";
  const lines = ["# 本片段镜头 (主 evidence; 已综合画面+字幕)"];
  chunkShots.forEach((sc, i) => {
    lines.push(`S${i + 1} [${sc.startSec.toFixed(1)}-${sc.endSec.toFixed(1)}s] 帧数=${sc.framesInShot || (sc.frames?.length || 0)}`);
    lines.push(`  画面: ${sc.shotDescription || "(空)"}`);
    if (sc.subtitleText) lines.push(`  字幕: ${sc.subtitleText}`);
  });
  return lines.join("\n");
}

function buildChunkFramesBlock(chunkFrames) {
  if (!Array.isArray(chunkFrames) || chunkFrames.length === 0) {
    return "# 本片段关键帧\n(无)";
  }
  const lines = ["# 本片段关键帧 (与下方图片顺序一一对应)"];
  chunkFrames.forEach((f, i) => {
    const cap = f.prefilterTag?.caption?.trim();
    const tag = f.prefilterTag?.signature?.trim();
    const meta = cap ? `\n  画面: ${cap}` : tag ? `\n  签名: ${tag}` : "";
    lines.push(`#${i + 1}  t=${(f.midSec || 0).toFixed(1)}s  范围 ${(f.startSec || 0).toFixed(1)}-${(f.endSec || 0).toFixed(1)}s${meta}`);
  });
  return lines.join("\n");
}

function buildChunkTranscriptBlock(segs) {
  if (!Array.isArray(segs) || segs.length === 0) {
    return "# 本片段字幕\n(无)";
  }
  const lines = segs.map((s) =>
    `[${Number(s.start || 0).toFixed(1)}-${Number(s.end || 0).toFixed(1)}] ${String(s.text || "").trim()}`,
  );
  return `# 本片段字幕 (带时间戳, 共 ${segs.length} 段)\n${lines.join("\n")}`;
}

function buildChunkPrompt(project, methodology, globalContext, chunk, totalChunks, options) {
  const focusHint =
    options?.focus === "rhythm" ? "重点关注剪辑节奏、镜头切换密度、停顿停滞。" :
    options?.focus === "emotion" ? "重点关注情绪曲线、表达强度和观众共鸣点。" :
    options?.focus === "narrative" ? "重点关注叙事结构、信息递进、转折设置。" :
    "综合关注叙事结构、剪辑节奏、情绪曲线和画面信息。";
  const modeHint = options?.mode === "detailed" ? "拆解到尽可能细的镜头级。" : options?.mode === "quick" ? "只覆盖关键节点, 不要面面俱到。" : "覆盖主要剪辑节点。";

  // chunk 本段时长 → 该段内建议节点数 (大致 1 node / 20s, 2-5 区间)
  const chunkDur = Math.max(1, chunk.endSec - chunk.startSec);
  const chunkNodeMin = Math.max(1, Math.round(chunkDur / 25));
  const chunkNodeMax = Math.min(5, Math.max(chunkNodeMin + 1, Math.round(chunkDur / 12)));
  const chunkShotCount = Array.isArray(chunk.shots) ? chunk.shots.length : 0;

  const parts = [
    `请分析视频的第 ${chunk.index + 1}/${totalChunks} 片段, 时间区间 [${chunk.startSec.toFixed(1)}, ${chunk.endSec.toFixed(1)}]s。`,
    `${focusHint} ${modeHint}`,
    "",
    buildGlobalContextBlock(project, methodology, globalContext),
    "",
    buildChunkShotsBlock(chunk.shots),
    "",
    buildChunkFramesBlock(chunk.frames),
    "",
    buildChunkTranscriptBlock(chunk.transcriptSegments),
    "",
    "# 节点划分规则（本规则优先级最高）",
    "逻辑节点 ≠ 镜头(shot)。一个逻辑节点表达「同一个目的 / 同一个信息块」, 通常跨越多个连续 shot。",
    `本片段 ${chunkDur.toFixed(0)}s 含 ${chunkShotCount} 个 shot, 目标输出 ${chunkNodeMin}-${chunkNodeMax} 个 node。**禁止**每个 shot 都建一个 node。`,
    "- 把演示同一参数 / 同一情绪段 / 同一信息点的连续 shot 合并成 1 个 node",
    "- nodeTypes 优先用 info_point / edit_intent / emotion_turn, 不要全用 shot_change",
    "",
    "# 输出格式 (必须严格遵守)",
    "只返回 JSON (不要 markdown 围栏), 结构:",
    `{
  "nodes":[
    {
      "id":"chunk-${chunk.index + 1}-node-1",
      "startSec":${chunk.startSec.toFixed(1)},
      "endSec":${(chunk.startSec + Math.min(chunkDur, 15)).toFixed(1)},
      "title":"该段在做什么 (跨多个 shot)",
      "nodeTypes":["info_point"],
      "shotDescription":"(覆盖该 node 范围内多个 shot 的画面要点)",
      "shotType":"近景",
      "cameraMovement":"固定",
      "visualElements":[],
      "audioElements":[],
      "editIntent":"...",
      "emotionLabel":"...",
      "emotionIntensity":7,
      "narrativeFunction":"Hook|Setup|Development|Turn|Climax|Ending|Other",
      "confidence":0.9,
      "isHighlight":true
    }
  ]
}`,
    "",
    "硬性要求:",
    `- nodes 数组长度必须在 [${chunkNodeMin}, ${chunkNodeMax}] 区间内 (不是 shot 数!)。`,
    `- nodes 时间戳 startSec/endSec 必须严格落在本片段 [${chunk.startSec.toFixed(1)}, ${chunk.endSec.toFixed(1)}]s 内, 不要跨段。`,
    "- nodes 按时间升序。",
    "- 不要返回 methodologyTags 字段 (后续步骤做)。",
    "- 不要返回 report 字段 (后续步骤做)。",
    "- evidence 要引用具体画面/字幕/时间, 不要写「看起来」「可能」等含糊词。",
  ];

  return parts.filter((x) => x !== null && x !== undefined).join("\n");
}

// audit pass 需要把每个 node 序列化成一行精简描述喂给模型
function serializeNodeForAudit(node, compact = false) {
  const parts = [
    `${node.id || ""} [${(node.startSec || 0).toFixed(1)}-${(node.endSec || 0).toFixed(1)}s]`,
    node.title ? `「${node.title}」` : "",
    node.narrativeFunction ? `narrative=${node.narrativeFunction}` : "",
    node.emotionLabel ? `emotion=${node.emotionLabel}/${node.emotionIntensity || 0}` : "",
  ];
  if (!compact) {
    if (node.shotType) parts.push(`shot=${node.shotType}`);
    if (node.editIntent) parts.push(`editIntent=${node.editIntent}`);
  }
  if (node.shotDescription) {
    const desc = compact && node.shotDescription.length > 60
      ? node.shotDescription.slice(0, 60) + "…"
      : node.shotDescription;
    parts.push(`画面=${desc}`);
  }
  return parts.filter(Boolean).join(" ");
}

function buildAuditPrompt(project, methodology, globalContext, nodes, transcript, options, { compactNodes = false } = {}) {
  const nodeLines = nodes.map((n) => serializeNodeForAudit(n, compactNodes)).join("\n");
  const transcriptBlock = formatTranscriptBlock(transcript);
  const focusHint =
    options?.focus === "rhythm" ? "重点关注剪辑节奏、镜头切换密度、停顿停滞。" :
    options?.focus === "emotion" ? "重点关注情绪曲线、表达强度和观众共鸣点。" :
    options?.focus === "narrative" ? "重点关注叙事结构、信息递进、转折设置。" :
    "综合关注叙事结构、剪辑节奏、情绪曲线和画面信息。";

  return [
    `请对视频《${project.videoName}》做剪辑方法论审计。`,
    `总时长 ${Math.round(project.durationSec)}s (lengthBucket=${methodology.lengthBucket})。`,
    focusHint,
    "",
    buildGlobalContextBlock(project, methodology, globalContext),
    "",
    "# 全部节点 (来自前序分段拉片)",
    nodeLines || "(无节点)",
    "",
    transcriptBlock,
    "",
    "# 剪辑方法论规则集 (必读, 严格对照)",
    "下面是当前视频所属的时长档位 + 类型对应的剪辑方法论。每条规则有唯一 ruleId, 例如 R-HOOK-001。",
    "你要做的事: ",
    "- 对每个 node, 给出它命中 (hit) 或违反 (violation) 的规则, 写到 nodeTags 数组里。",
    "- 视频里完全缺失的规则 (应有未有) 写到 report.methodologyAudit.misses 数组。",
    "- 同时产出全局报告 (summary/structure/pacing/editingStyle/composition/takeaways/methodologyAudit)。",
    "",
    methodology.text,
    "",
    "# 输出格式 (必须严格遵守)",
    "只返回 JSON (不要 markdown 围栏), 结构:",
    `{
  "nodeTags":[
    {
      "id":"node-1",
      "methodologyTags":[
        {"ruleId":"R-HOOK-001","ruleName":"...","category":"hook","status":"hit","evidence":"开头特写 + 字幕 'XX'","confidence":0.9},
        {"ruleId":"R-HOOK-002","ruleName":"...","category":"hook","status":"violation","evidence":"...","confidence":0.8,"fixSuggestion":"..."}
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
        {"ruleId":"R-STRUCT-001","ruleName":"...","category":"structure","expectedAt":"视频中后段","reason":"...","fixSuggestion":"..."}
      ],
      "overallScore":78
    }
  }
}`,
    "",
    "硬性要求:",
    "- nodeTags 数组里的 id 必须来自上面的节点列表; 不要新增/删除/重命名节点。",
    "- methodologyTags 的 ruleId 必须来自上述方法论规则集, 不要编造。",
    "- 每条 violation 必须给 fixSuggestion; 每条 miss 必须给 fixSuggestion + reason。",
    "- evidence 必须引用具体节点 id 或时间区间。",
    "- detectedGenre 必须从清单中选一个。",
    "- overallScore 0-100。",
    "",
    "软约束 (避免误报):",
    "- 如果一条规则的 when 触发条件在本视频里前提不成立 (例如规则只适用 8 分钟以上但本视频只有 6 分钟), 跳过这条规则。",
    "- 如果规则需要听到 BGM beat sync 等你无法判断的信号, 不要硬给 miss; 在 takeaways 里温和提示。",
  ].filter(Boolean).join("\n");
}

// 估算 token: 中文 ~0.5 token/字, 英文 ~0.25 token/字。粗估按 0.4 平均偏保守。
// 偏保守 (估高) → 提前触发裁剪, 避免实际请求超 ctx; 这是安全方向。
function estimatePromptTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length * 0.4);
}

// 估算单个 shotContext 在 prompt 里占多少 token
function estimateShotContextTokens(sc) {
  if (!sc) return 0;
  const desc = sc.shotDescription || "";
  const sub = sc.subtitleText || (Array.isArray(sc.subtitleSegments)
    ? sc.subtitleSegments.map((s) => s.text || "").join(" ")
    : "");
  // 元信息 (时间/帧数) 大约 30 char + 描述 + 字幕
  return estimatePromptTokens(`${desc} ${sub}`) + 20;
}

function estimateTranscriptSegmentTokens(segs) {
  if (!Array.isArray(segs) || segs.length === 0) return 0;
  const text = segs.map((s) => `[${(s.start || 0).toFixed(1)}-${(s.end || 0).toFixed(1)}] ${s.text || ""}`).join("\n");
  return estimatePromptTokens(text);
}

// 取落在 [start, end] 内的 frames / transcript segments
function pickFramesInRange(frames, startSec, endSec) {
  if (!Array.isArray(frames)) return [];
  return frames.filter((f) => {
    const mid = Number(f.midSec) || 0;
    return mid >= startSec && mid < endSec;
  });
}

function pickTranscriptSegmentsInRange(transcript, startSec, endSec) {
  if (!transcript || !Array.isArray(transcript.segments)) return [];
  return transcript.segments.filter((s) => {
    const segStart = Number(s.start) || 0;
    const segEnd = Number(s.end) || segStart;
    // 段与 chunk 时间区间有交集即算
    return segEnd >= startSec && segStart <= endSec;
  });
}

// 按 ctx 预算把 shotContexts 切成 N 段, 每段附带其时间区间内的 frames + transcript segments。
//
// 输入:
//   ctxSize, reserveOutput, overheadTokens (每段固定占用: system + 全局上下文 + schema 模板)
//   shotContexts (有序), frames (按 midSec 升序), transcript
//
// 输出:
//   [{ index, startSec, endSec, shots, frames, transcriptSegments, estTokens }]
//
// 算法:
//   逐 shot 累加, 加上该 shot 范围内的 frames(*800) 和 transcript segments(估算字符)。
//   超 budgetPerChunk 就把当前累计切出去, 开新段。
//   边界: 单个 shot 已超 budget 时, 单独占一段并降级 (砍其 frames 数)。
function planAnalysisChunks({
  ctxSize,
  reserveOutput,
  overheadTokens,
  safetyMargin,
  shotContexts,
  frames,
  transcript,
  durationSec,
}) {
  const budget = ctxSize - reserveOutput - overheadTokens - safetyMargin;
  if (budget <= 0) {
    throw new Error(`模型 ctx ${ctxSize} 太小, 扣掉输出 reserve / 全局上下文 / safety margin 后预算 ${budget} token, 无法分段。`);
  }

  // 每段帧数上限: 用 budget 的 70% 留给图片 (剩余给字幕+shot 描述), 至少 HARD_FRAME_CAP_FALLBACK
  const frameCapByBudget = Math.max(HARD_FRAME_CAP_FALLBACK, Math.floor((budget * 0.7) / VISION_TOKENS_PER_FRAME));

  const chunks = [];
  // 没有 shotContexts: 退化按时间等分。先估总 token, 算需要多少段。
  if (!Array.isArray(shotContexts) || shotContexts.length === 0) {
    const totalFrameTokens = frames.length * VISION_TOKENS_PER_FRAME;
    const totalTranscriptTokens = estimateTranscriptSegmentTokens(transcript?.segments || []);
    const total = totalFrameTokens + totalTranscriptTokens;
    const numChunks = Math.max(1, Math.ceil(total / budget));
    const chunkDuration = (durationSec || 0) / numChunks;
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkDuration;
      const end = i === numChunks - 1 ? (durationSec || start + chunkDuration) : (i + 1) * chunkDuration;
      const chunkFrames = pickFramesInRange(frames, start, end);
      const chunkSegs = pickTranscriptSegmentsInRange(transcript, start, end);
      const est = chunkFrames.length * VISION_TOKENS_PER_FRAME + estimateTranscriptSegmentTokens(chunkSegs);
      chunks.push({
        index: i,
        startSec: start,
        endSec: end,
        shots: [],
        frames: chunkFrames.slice(0, frameCapByBudget),
        transcriptSegments: chunkSegs,
        estTokens: est,
      });
    }
    return chunks;
  }

  // 有 shotContexts: 逐 shot 累加
  let current = null;
  const flush = () => {
    if (current && current.shots.length > 0) chunks.push(current);
    current = null;
  };
  for (const sc of shotContexts) {
    const scTokens = estimateShotContextTokens(sc);
    const scFrames = pickFramesInRange(frames, sc.startSec, sc.endSec);
    const scSegs = pickTranscriptSegmentsInRange(transcript, sc.startSec, sc.endSec);
    const scFrameTokens = scFrames.length * VISION_TOKENS_PER_FRAME;
    const scSegTokens = estimateTranscriptSegmentTokens(scSegs);
    const scTotal = scTokens + scFrameTokens + scSegTokens;

    // 单 shot 就超 budget → 单独成段, 降级砍 frames
    if (scTotal > budget) {
      flush();
      const maxFrames = Math.max(HARD_FRAME_MIN, Math.floor((budget - scTokens - scSegTokens) / VISION_TOKENS_PER_FRAME));
      const trimmedFrames = scFrames.slice(0, Math.max(HARD_FRAME_MIN, maxFrames));
      chunks.push({
        index: chunks.length,
        startSec: sc.startSec,
        endSec: sc.endSec,
        shots: [sc],
        frames: trimmedFrames,
        transcriptSegments: scSegs,
        estTokens: scTokens + trimmedFrames.length * VISION_TOKENS_PER_FRAME + scSegTokens,
        degraded: true,
      });
      continue;
    }

    if (!current) {
      current = {
        index: chunks.length,
        startSec: sc.startSec,
        endSec: sc.endSec,
        shots: [],
        frames: [],
        transcriptSegments: [],
        estTokens: 0,
      };
    }

    // 加上该 shot 后超 budget → 先 flush 当前, 开新段
    if (current.estTokens + scTotal > budget && current.shots.length > 0) {
      flush();
      current = {
        index: chunks.length,
        startSec: sc.startSec,
        endSec: sc.endSec,
        shots: [],
        frames: [],
        transcriptSegments: [],
        estTokens: 0,
      };
    }

    current.shots.push(sc);
    current.frames.push(...scFrames);
    // transcript segments 可能跨 shot 边界, 用 Set 去重
    for (const seg of scSegs) {
      if (!current.transcriptSegments.some((x) => x.start === seg.start && x.end === seg.end)) {
        current.transcriptSegments.push(seg);
      }
    }
    current.endSec = sc.endSec;
    current.estTokens += scTotal;
  }
  flush();

  for (const c of chunks) {
    if (c.frames.length > frameCapByBudget) {
      c.frames = c.frames.slice(0, frameCapByBudget);
    }
  }

  return chunks;
}

// 估算"每段固定 overhead"。chunk pass 每段都要带:
//   - system prompt
//   - 全局上下文 (类型/lengthBucket/globalSummary/structureHint)
//   - 输出 schema 模板
//   - hard 要求 + 软约束文本
// 不带 methodology, 不带帧描述/字幕(那部分按 chunk 数据动态算)
function estimateChunkOverheadTokens(globalContext) {
  // 系统 prompt + schema 模板 + 硬性要求 文本约 800 token
  const FIXED_PROMPT_FOOTPRINT = 800;
  let dynamic = 0;
  if (globalContext) {
    if (globalContext.globalSummary) dynamic += estimatePromptTokens(globalContext.globalSummary);
    if (globalContext.structureHint) {
      const sh = globalContext.structureHint;
      dynamic += estimatePromptTokens([sh.hook, sh.climax, sh.ending].filter(Boolean).join(" "));
    }
    if (globalContext.detectedGenre) dynamic += 20;
  }
  return FIXED_PROMPT_FOOTPRINT + dynamic;
}

// 一次性 pass: 把所有内容(含 methodology + frames + transcript + shotContexts)
// 塞进单个 chat/completions 请求, 模型一次出 { nodes, report }。
// 适合短视频 / 信息量小、能装进 ctx 的场景。
async function runSinglePassAnalysis({
  effectiveProvider, project, frames, transcript, scenes, options, methodology,
  reserveOutput,
  handle, fallbackNodes, fallbackReport,
}) {
  const { userText } = await buildAnalysisPrompt(project, frames, transcript, scenes, options);
  const systemText =
    "你是一名严谨的视频拉片分析师。你既要描述视频内容，又要严格按照提供的剪辑方法论规则集对视频打标（命中 / 违反 / 缺失）。所有回答必须是合法 JSON，不要使用 Markdown 围栏，不要解释。";

  const imageDataUrls = [];
  for (const frame of frames) {
    const base64 = await fs.readFile(frame.framePath, "base64");
    imageDataUrls.push(`data:image/jpeg;base64,${base64}`);
  }

  const useResponses = effectiveProvider.endpointType === "openai_responses";
  // probe 实测: json_object 不足以让 llama.cpp 编 grammar (它只对 json_schema 生效);
  // 走宽松 json_schema strict:false, 0.8B 8 帧 chunk-pass 从 2/3 valid 提升到 4/4。
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "single_pass_output", strict: false, schema: SINGLE_PASS_OUTPUT_SCHEMA },
  };
  // single-pass 输出量 = 14 shots × shotDescription + nodes + report ≈ 5K+ tok,
  // 远超 openai-client default 2500。用 callOpenAICompatible 已经算好的 reserveOutput,
  // 让"留给 output 的 ctx 预算"和"实际 max_tokens"对齐,避免输出被截断成残 JSON。
  const callOpts = {
    responseFormat,
    maxTokens: reserveOutput,
    maxOutputTokens: reserveOutput,
    enableThinking: effectiveProvider.enableThinking === true,
  };
  const callResult = useResponses
    ? await callOpenAIResponses(effectiveProvider, systemText, userText, imageDataUrls, handle, callOpts)
    : await callOpenAIChatCompletions(effectiveProvider, systemText, userText, imageDataUrls, handle, callOpts);
  const parsed = callResult.parsed;
  // Layer 3 reasoning fallback 命中时这里能看到, 顺便记入 token-usage 让用户察觉异常
  if (callResult.parsedSource === "reasoning") {
    log.warn("main-analysis",
      `Layer 3 fallback: content 没出 JSON, 已从 reasoning 末尾兜底提到 (reasoningLen=${callResult.reasoning?.length || 0})。` +
      `检查 model.isThinking / slot.enableThinking 配置, 或 server 不接受 chat_template_kwargs.enable_thinking=false。`,
    );
  }

  if (!parsed || (!Array.isArray(parsed.nodes) && !parsed.report)) {
    // 诊断: 把模型真实吐出的内容 + thinking 长度 + usage 全打出来 ——
    // (a) raw 空 + reasoning 长 = thinking 模型把内容全塞 reasoning_content (chat_template_kwargs 没生效)
    // (b) raw 空 + reasoning 空 = stream 完全没出 (grammar 编译失败 / mmproj 没加载 / ctx 满)
    // (c) raw 看着像 JSON 但被截断 = 输出超过 max_tokens
    // (d) raw 非空但不是 JSON = markdown 围栏 / 自由文字
    const raw = typeof callResult.raw === "string" ? callResult.raw : "";
    const reasoning = typeof callResult.reasoning === "string" ? callResult.reasoning : "";
    const usage = callResult.usage || null;
    log.error("main-analysis",
      `parse 失败诊断: rawLen=${raw.length} reasoningLen=${reasoning.length} ` +
      `usage=${usage ? JSON.stringify(usage) : "n/a"} model=${callResult.model || effectiveProvider.model}`,
    );
    if (raw.length > 0) {
      log.error("main-analysis", `raw head: ${JSON.stringify(raw.slice(0, 200))}`);
      log.error("main-analysis", `raw tail: ${JSON.stringify(raw.slice(-200))}`);
    }
    if (reasoning.length > 0) {
      log.error("main-analysis", `reasoning head: ${JSON.stringify(reasoning.slice(0, 200))}`);
    }
    const completionTokens = usage?.completionTokens ?? 0;
    const hint =
      raw.length === 0 && reasoning.length > 0
        ? `模型在 thinking 模式没出 content (reasoning ${reasoning.length} 字符) — chat_template_kwargs.enable_thinking=false 可能没被 server 接受,需要换 server 版本或关 reasoning 模型`
        : raw.length === 0
          ? "模型 stream 0 字节 (grammar 编译失败 / mmproj 未加载 / ctx 满 / max_tokens=0)"
          : completionTokens >= reserveOutput - 50
            ? `输出被 max_tokens=${reserveOutput} 截断 (completion=${completionTokens})`
            : "模型吐了内容但不是合法 JSON (markdown 围栏 / 自由文字)";
    const sample = raw.length > 0
      ? ` head=${JSON.stringify(raw.slice(0, 120))} tail=${JSON.stringify(raw.slice(-120))}`
      : "";
    throw new Error(
      `模型未返回可解析的 JSON。${hint} ` +
      `(rawLen=${raw.length} reasoningLen=${reasoning.length} completion=${completionTokens} max=${reserveOutput})${sample}`,
    );
  }
  return {
    ...normalizeModelResult(parsed, fallbackNodes, fallbackReport, project, effectiveProvider, methodology),
    usedModel: true,
    usage: callResult.usage,
    echoedModel: callResult.model,
  };
}

// 跑单个 chunk: 只产 nodes, 不带 methodology
async function runChunkPass({ effectiveProvider, project, methodology, globalContext, chunk, totalChunks, options, reserveOutput, handle }) {
  const userText = buildChunkPrompt(project, methodology, globalContext, chunk, totalChunks, options);
  const imageDataUrls = [];
  for (const frame of chunk.frames) {
    const base64 = await fs.readFile(frame.framePath, "base64");
    imageDataUrls.push(`data:image/jpeg;base64,${base64}`);
  }
  const useResponses = effectiveProvider.endpointType === "openai_responses";
  // 见 runSinglePassAnalysis 同位置注释: json_schema strict:false 让 llama.cpp 编 GBNF
  // 强制顶层 nodes 数组结构, 字段内部不约束。
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "chunk_pass_output", strict: false, schema: CHUNK_PASS_OUTPUT_SCHEMA },
  };
  // 同 runSinglePassAnalysis: 预算和 max_tokens 对齐,避免大节点数 chunk 输出被截断。
  const callOpts = {
    responseFormat,
    maxTokens: reserveOutput,
    maxOutputTokens: reserveOutput,
    enableThinking: effectiveProvider.enableThinking === true,
  };
  const callResult = useResponses
    ? await callOpenAIResponses(effectiveProvider, CHUNK_SYSTEM_PROMPT, userText, imageDataUrls, handle, callOpts)
    : await callOpenAIChatCompletions(effectiveProvider, CHUNK_SYSTEM_PROMPT, userText, imageDataUrls, handle, callOpts);
  const parsed = callResult.parsed;
  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new Error(`chunk ${chunk.index + 1} 返回不是合法 JSON 或缺少 nodes 字段`);
  }
  return parsed.nodes;
}

// 跑 audit pass: 不带 frames, 只读 nodes + methodology + transcript + 全局
async function runAuditPass({ effectiveProvider, project, methodology, globalContext, nodes, transcript, options, ctxSize, reserveOutput, safetyMargin, handle }) {
  const auditSystemTokens = estimatePromptTokens(AUDIT_SYSTEM_PROMPT);
  const budget = ctxSize - reserveOutput - auditSystemTokens - safetyMargin;
  if (budget <= 0) {
    throw new Error(`audit pass: 模型 ctx ${ctxSize} 不够装 audit prompt`);
  }

  // 先尝试完整 nodes; 装不下就 compactNodes (砍冗余字段); 还不下就截短 shotDescription
  let compactNodes = false;
  let workingTranscript = transcript;
  let userText;
  let promptTokens;
  let attempt = 0;
  let lastDecision = "";
  while (true) {
    attempt += 1;
    if (attempt > 20) {
      throw new Error(`audit pass 裁剪 ${attempt - 1} 轮仍无法装入 ctx=${ctxSize}; 最后: ${lastDecision}`);
    }
    userText = buildAuditPrompt(project, methodology, globalContext, nodes, workingTranscript, options, { compactNodes });
    promptTokens = estimatePromptTokens(userText);
    lastDecision = `prompt=${promptTokens}tok budget=${budget} compactNodes=${compactNodes} transcript=${workingTranscript?.text?.length || 0}字`;
    if (promptTokens <= budget) break;

    // 1) 先 compactNodes
    if (!compactNodes) {
      compactNodes = true;
      continue;
    }
    // 2) 再砍 transcript
    if (workingTranscript?.text && workingTranscript.text.length > 200) {
      const next = Math.max(0, Math.floor(workingTranscript.text.length / 2));
      const trimmed = trimTranscriptForBudget(
        workingTranscript.text, workingTranscript.segments, Math.ceil(next),
      );
      workingTranscript = { ...workingTranscript, text: trimmed.text, segments: trimmed.segments };
      continue;
    }
    throw new Error(`audit pass 无法装入 ctx=${ctxSize}: ${lastDecision}`);
  }

  log.info("analyze:main", `audit pass prompt=${promptTokens}tok budget=${budget} compactNodes=${compactNodes} attempts=${attempt}`);

  const useResponses = effectiveProvider.endpointType === "openai_responses";
  // 同 chunk-pass: json_schema strict:false。audit 输出 { nodeTags, report } 两个 optional 顶层字段。
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "audit_pass_output", strict: false, schema: AUDIT_PASS_OUTPUT_SCHEMA },
  };
  // 同 runSinglePassAnalysis: 预算和 max_tokens 对齐;audit 输出 nodeTags + report,
  // 节点多时同样会超 openai-client default 2500。
  const callOpts = {
    responseFormat,
    maxTokens: reserveOutput,
    maxOutputTokens: reserveOutput,
    enableThinking: effectiveProvider.enableThinking === true,
  };
  const callResult = useResponses
    ? await callOpenAIResponses(effectiveProvider, AUDIT_SYSTEM_PROMPT, userText, [], handle, callOpts)
    : await callOpenAIChatCompletions(effectiveProvider, AUDIT_SYSTEM_PROMPT, userText, [], handle, callOpts);
  const parsed = callResult.parsed;
  if (!parsed) {
    throw new Error("audit pass 返回不是合法 JSON");
  }
  // audit usage / echoedModel 一并带回, 给 mergeChunkedResult 拼到最终 result 里
  return { parsed, usage: callResult.usage, echoedModel: callResult.model };
}

// 把 chunk pass 出来的 nodes + audit pass 的 nodeTags 和 report 合并成最终 result。
// auditResult 是 runAuditPass 返回的 { parsed, usage, echoedModel }
function mergeChunkedResult({ chunkNodes, auditResult, project, effectiveProvider, methodology, fallbackNodes, fallbackReport }) {
  const auditParsed = auditResult?.parsed || null;
  // 1) chunkNodes 已经按时间排序, 重新编号 id
  const allNodes = [...chunkNodes].sort((a, b) => (a.startSec || 0) - (b.startSec || 0));
  allNodes.forEach((n, i) => {
    n.id = `node-${i + 1}`;
  });

  // 2) 把 audit 的 methodologyTags 按"原 chunk-level id 或时间近邻" 合回去
  const tagsByOriginalId = new Map();
  const tagsByTime = []; // fallback: 时间最近匹配
  if (Array.isArray(auditParsed?.nodeTags)) {
    for (const nt of auditParsed.nodeTags) {
      if (!nt?.id) continue;
      tagsByOriginalId.set(nt.id, nt.methodologyTags || []);
      tagsByTime.push(nt);
    }
  }

  // 3) audit 用的是重编号后的 id (node-1..N), 也可能用 chunk 原 id (chunk-1-node-1)
  //    优先 node-1..N 匹配, 否则尝试原 id
  allNodes.forEach((n, i) => {
    const finalId = `node-${i + 1}`;
    const tagsFromFinalId = tagsByOriginalId.get(finalId);
    const tagsFromOriginal = n._originalId ? tagsByOriginalId.get(n._originalId) : null;
    n.methodologyTags = tagsFromFinalId || tagsFromOriginal || [];
    delete n._originalId;
  });

  // 4) 拼最终 payload, 跑现有的 normalizeModelResult 把字段规整
  const payload = {
    nodes: allNodes,
    report: auditParsed?.report || {},
  };
  return {
    ...normalizeModelResult(payload, fallbackNodes, fallbackReport, project, effectiveProvider, methodology),
    usedModel: true,
    // chunked 模式 usage 只反映 audit 阶段(chunk 阶段每段 usage 独立, 调用方暂不需要逐段)
    usage: auditResult?.usage || null,
    echoedModel: auditResult?.echoedModel || null,
  };
}

// 分段拉片: chunk pass × N + audit pass × 1。
async function runChunkedAnalysis({
  effectiveProvider, project, frames, transcript, scenes, options, methodology, globalContext,
  ctxSize, reserveOutput, safetyMargin,
  handle, fallbackNodes, fallbackReport, sendProgress,
}) {
  const overheadTokens = estimateChunkOverheadTokens(globalContext);
  const chunks = planAnalysisChunks({
    ctxSize,
    reserveOutput,
    overheadTokens,
    safetyMargin,
    shotContexts: options?.shotContexts,
    frames,
    transcript,
    durationSec: project.durationSec,
  });
  if (chunks.length === 0) {
    throw new Error("planAnalysisChunks 切出 0 段, 检查 shotContexts/frames 是否为空。");
  }

  log.info("analyze:main",
    `chunked: ctx=${ctxSize} overhead=${overheadTokens}tok 切 ${chunks.length} 段; ` +
    chunks.map((c, i) => `#${i + 1}[${c.startSec.toFixed(0)}-${c.endSec.toFixed(0)}s shots=${c.shots.length} frames=${c.frames.length} ~${c.estTokens}tok]`).join(" "),
  );

  const CHUNK_MAX_RETRIES = 2;
  const allChunkNodes = [];
  for (let i = 0; i < chunks.length; i++) {
    if (handle?.cancelled) throw new AnalysisCancelledError();
    const chunk = chunks[i];
    sendProgress?.(i, chunks.length, "chunk", chunk);
    let chunkOk = false;
    for (let attempt = 0; attempt <= CHUNK_MAX_RETRIES; attempt++) {
      if (handle?.cancelled) throw new AnalysisCancelledError();
      try {
        const nodes = await runChunkPass({
          effectiveProvider, project, methodology, globalContext, chunk,
          totalChunks: chunks.length, options, reserveOutput, handle,
        });
        nodes.forEach((n, j) => {
          n._originalId = n.id || `chunk-${i + 1}-node-${j + 1}`;
        });
        allChunkNodes.push(...nodes);
        chunkOk = true;
        break;
      } catch (err) {
        if (err instanceof AnalysisCancelledError || err?.name === "AbortError") throw new AnalysisCancelledError();
        if (attempt < CHUNK_MAX_RETRIES) {
          log.warn("analyze:main", `chunk ${i + 1}/${chunks.length} 第 ${attempt + 1} 次失败, 重试: ${err?.message || err}`);
          continue;
        }
        log.warn("analyze:main", `chunk ${i + 1}/${chunks.length} 重试 ${CHUNK_MAX_RETRIES} 次仍失败: ${err?.message || err}`);
        allChunkNodes.push({
          _originalId: `chunk-${i + 1}-failed`,
          startSec: chunk.startSec,
          endSec: chunk.endSec,
          title: `第 ${i + 1} 段分析失败`,
          nodeTypes: ["shot_change"],
          shotDescription: `本段分析失败: ${err?.message || err}`,
          narrativeFunction: "Other",
        });
      }
    }
  }

  sendProgress?.(chunks.length, chunks.length, "audit", null);

  // audit pass — 最多重试 2 次,全部失败则降级为不带审计的结果
  const AUDIT_MAX_RETRIES = 2;
  let auditResult = null;
  for (let attempt = 0; attempt <= AUDIT_MAX_RETRIES; attempt++) {
    if (handle?.cancelled) throw new AnalysisCancelledError();
    try {
      auditResult = await runAuditPass({
        effectiveProvider, project, methodology, globalContext,
        nodes: allChunkNodes, transcript, options,
        ctxSize, reserveOutput, safetyMargin,
        handle,
      });
      break;
    } catch (auditErr) {
      if (auditErr instanceof AnalysisCancelledError || auditErr?.name === "AbortError") throw new AnalysisCancelledError();
      if (attempt < AUDIT_MAX_RETRIES) {
        log.warn("analyze:main", `audit pass 第 ${attempt + 1} 次失败, 重试: ${auditErr?.message || auditErr}`);
        continue;
      }
      log.warn("analyze:main", `audit pass 重试 ${AUDIT_MAX_RETRIES} 次仍失败, 降级为不带审计的结果: ${auditErr?.message || auditErr}`);
    }
  }

  return mergeChunkedResult({
    chunkNodes: allChunkNodes, auditResult,
    project, effectiveProvider, methodology, fallbackNodes, fallbackReport,
  });
}

async function callOpenAICompatible(provider, project, frames, transcript, scenes, fallbackNodes, fallbackReport, options, handle = null, sendProgress = null) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    return { nodes: fallbackNodes, report: fallbackReport, usedModel: false };
  }
  log.info("analyze:main", `[analysis:${handle?.analysisId || "?"}] 主分析开始, provider=${provider.id} model=${provider.model} frames=${frames.length}`);

  // 本地 llama: 显式 acquire 拿到 slot, 这样能读到 server 实际启动时的 --ctx-size,
  // 用真实 ctx 做预算才准。同时给 provider 打 _preacquired 标记, 让 openai-client 不再二次 acquire。
  let preacquiredSlot = null;
  let effectiveProvider = provider;
  if (provider.source === "local_llama") {
    preacquiredSlot = await llamaManager.acquire(provider.model, {
      signal: handle?.abortController?.signal,
    });
    effectiveProvider = {
      ...provider,
      baseUrl: preacquiredSlot.baseUrl,
      apiKeyRef: preacquiredSlot.apiKey,
      contextSize: preacquiredSlot.contextSize,
      _preacquired: true,
    };
  }

  try {
    VISION_TOKENS_PER_FRAME = effectiveProvider.source === "local_llama"
      ? VISION_TOKENS_PER_FRAME_LOCAL
      : VISION_TOKENS_PER_FRAME_REMOTE;

    const ctxSize = Number(effectiveProvider?.contextSize) > 0 ? Number(effectiveProvider.contextSize) : 8192;
    // reserveForOutput 跟 ctx 走 (×0.25, 下限 1500, **无上限**):settings 里 ctx slider 调多大就给多大 output 预算。
    // 在线大模型 (Claude 200K / Gemini 1M / Qwen3.5 256K) 和本地大 ctx 模型都按比例伸缩,
    // thinking 模型也有足够空间 (thinking 占一半 content 占一半的极端 case)。
    const reserveForOutput = Math.max(1500, Math.floor(ctxSize * 0.25));
    const safetyMargin = Math.max(256, Math.floor(ctxSize * 0.05));
    const globalContext = {
      globalSummary: options?.globalSummary || null,
      structureHint: options?.structureHint || null,
      detectedGenre: options?.detectedGenre || options?.manualGenre || null,
      genreConfidence: options?.genreConfidence || 0,
    };

    // 先估算"一次性 pass"需要多少 token (含 methodology), 看 ctx 是否能装下。
    const { userText: singleUserText, methodology } = await buildAnalysisPrompt(
      project, frames, transcript, scenes, options,
    );
    const singleSystemText =
      "你是一名严谨的视频拉片分析师。你既要描述视频内容，又要严格按照提供的剪辑方法论规则集对视频打标（命中 / 违反 / 缺失）。所有回答必须是合法 JSON，不要使用 Markdown 围栏，不要解释。";
    const singleSystemTokens = estimatePromptTokens(singleSystemText);
    const singlePromptTokens = estimatePromptTokens(singleUserText);
    const singleImageTokens = frames.length * VISION_TOKENS_PER_FRAME;
    const singleTotal = singleSystemTokens + singlePromptTokens + singleImageTokens;
    const singleBudget = ctxSize - reserveForOutput - safetyMargin;

    log.info("analyze:main",
      `provider=${effectiveProvider.id} model=${effectiveProvider.model} ctx=${ctxSize} ` +
      `single-pass=${singleTotal}tok (sys=${singleSystemTokens} user=${singlePromptTokens} images=${frames.length}*${VISION_TOKENS_PER_FRAME}=${singleImageTokens}) ` +
      `budget=${singleBudget} → ${singleTotal <= singleBudget ? "走单次" : "走分段"}`,
    );

    if (singleTotal <= singleBudget) {
      const SINGLE_MAX_RETRIES = 2;
      for (let attempt = 0; attempt <= SINGLE_MAX_RETRIES; attempt++) {
        if (handle?.cancelled) throw new AnalysisCancelledError();
        try {
          return await runSinglePassAnalysis({
            effectiveProvider, project, frames, transcript, scenes, options, methodology,
            reserveOutput: reserveForOutput,
            handle, fallbackNodes, fallbackReport,
          });
        } catch (err) {
          if (err instanceof AnalysisCancelledError || err?.name === "AbortError") throw new AnalysisCancelledError();
          if (attempt < SINGLE_MAX_RETRIES) {
            log.warn("analyze:main", `single-pass 第 ${attempt + 1} 次失败, 重试: ${err?.message?.slice(0, 200) || err}`);
            continue;
          }
          throw err;
        }
      }
    }

    // 装不下 → 分段
    return await runChunkedAnalysis({
      effectiveProvider, project, frames, transcript, scenes, options, methodology, globalContext,
      ctxSize, reserveOutput: reserveForOutput, safetyMargin,
      handle, fallbackNodes, fallbackReport, sendProgress,
    });
  } finally {
    preacquiredSlot?.release();
  }
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
    const callResult = useResponses
      ? await callOpenAIResponses(provider, systemText, userText, [], handle)
      : await callOpenAIChatCompletions(provider, systemText, userText, [], handle);
    const parsed = callResult.parsed;
    const genre = String(parsed?.detectedGenre || "").trim();
    if (!ALLOWED_GENRES.has(genre)) return null;
    const conf = Number(parsed?.genreConfidence);
    return {
      detectedGenre: genre,
      genreConfidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      reasoning: String(parsed?.reasoning || "").slice(0, 500),
      usage: callResult.usage,
      echoedModel: callResult.model,
    };
  } catch (error) {
    if (handle?.cancelled) throw error;
    return null;
  }
}

// 这两个函数现在转发到 openai-client.cjs, 保留兼容签名避免改动 callOpenAICompatible 等调用点
const callOpenAIChatCompletions = openaiClient.callOpenAIChatCompletions;
const callOpenAIResponses = openaiClient.callOpenAIResponses;

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
  if (isChineseLangMain(audioProvider.language)) form.append("prompt", SIMPLIFIED_PROMPT_ZH);

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
  const detectedLang = data?.language || audioProvider.language || null;
  const shouldSimplify = isChineseLangMain(detectedLang) || isChineseLangMain(audioProvider.language);
  const normalize = (s) => {
    const t = String(s || "").trim();
    return shouldSimplify && t ? t2sConverterMain(t) : t;
  };
  const segments = Array.isArray(data?.segments)
    ? data.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: normalize(s.text) }))
    : [];
  const fullText = typeof data?.text === "string" ? normalize(data.text) : segments.map((s) => s.text).join(" ").trim();
  return {
    language: detectedLang,
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
    const mirror = await getLocalModelMirror();
    await whisperCppRuntime.ensureModel(modelId, (p) => {
      if (p.percent != null && onProgress) {
        onProgress({ stage: "download", message: p.message });
      }
    }, { mirror });
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
    const mirror = await getLocalModelMirror();
    await whisperCppRuntime.ensureModel(modelId, undefined, { mirror });
  }
  await whisperCppRuntime.start(modelId);
  return { modelId, elapsedMs: Date.now() - t0 };
}

async function analyzeProject(event, { project, provider: _legacyProvider, audioProvider: _legacyAudio, options }) {
  if (activeAnalyses.has(project.id)) {
    const stale = activeAnalyses.get(project.id);
    if (stale?.cancelled) {
      log.info("analyze:lifecycle", `analyzeProject: 发现已取消的旧 handle project=${project.id} staleAnalysisId=${stale.analysisId || "?"} cancelledAt=${stale.cancelledAt ? new Date(stale.cancelledAt).toISOString() : "?"}`);
      clearAnalysis(project.id, stale);
    } else {
      log.warn("analyze:lifecycle", `analyzeProject: 拒绝启动 — 已有未取消的分析在运行 project=${project.id} analysisId=${stale?.analysisId || "?"}`);
      throw new Error("该项目已有分析任务在运行。");
    }
  }
  // 立即注册 handle 占位, 在后续任何 await 之前——防止第二个并发 IPC 调用通过 has() 检查。
  // 前置校验失败时在 catch 里 clearAnalysis 清掉。
  const handle = registerAnalysis(project.id);
  const analysisId = _crypto.randomUUID();
  handle.analysisId = analysisId;
  const analysisStartedAt = Date.now();
  log.info("analyze", `[analysis:${analysisId}] 开始分析 project=${project.id} title="${project.videoName || project.title || ""}"`);

  // 在管线开始时一次性快照 config + 从 taskSlots/audioSlot 解析各任务的 effective provider,
  // 避免运行中用户改设置导致竞争。renderer 传入的 provider/audioProvider 入参作废。
  let cfgSnapshot, complexVisionProvider, mediumTextProvider, audioProvider, provider;
  try {
    cfgSnapshot = migrateConfigV1ToV2(await readJson(getConfigPath(), null));
    _activeCachePolicy = cfgSnapshot?.cachePolicy || null;
    complexVisionProvider = resolveSlotProvider(cfgSnapshot, "complex_vision");
    mediumTextProvider = resolveSlotProvider(cfgSnapshot, "medium_text");
    audioProvider = resolveAudioProvider(cfgSnapshot);
    provider = complexVisionProvider;

    // 前置校验: 本地模型 provider 必须引擎已装 + 模型已下载,否则直接拦截
    const localProviders = [complexVisionProvider, mediumTextProvider].filter(
      (p) => p?.source === "local_llama",
    );
    if (localProviders.length > 0) {
      const localStatus = llamaRuntime.getStatus();
      if (!localStatus.binaryFound) {
        const binaryPath = await llamaRuntime.resolveLlamaServerPath();
        if (!binaryPath) {
          const err = new Error("当前选择了本地模型,但推理引擎还没安装,需要先到设置页安装。");
          err.code = "LOCAL_SETUP_REQUIRED";
          throw err;
        }
      }
      const manifest = llamaRuntime.getManifest();
      const installedModels = await llamaRuntime.listModels();
      const installedMap = new Map(installedModels.map((m) => [m.key, m]));
      for (const lp of localProviders) {
        const m = installedMap.get(lp.model);
        if (!m || !m.downloaded) {
          const displayName = manifest?.[lp.model]?.name || lp.model;
          const err = new Error(`当前选择的本地模型「${displayName}」还没下载完成,需要先到设置页下载。`);
          err.code = "LOCAL_SETUP_REQUIRED";
          throw err;
        }
      }
    }
  } catch (setupErr) {
    clearAnalysis(project.id, handle);
    throw setupErr;
  }

  // 创建分析记录骨架
  const analysisRecord = {
    id: analysisId,
    projectId: project.id,
    status: "analyzing",
    providerId: complexVisionProvider?.id,
    model: complexVisionProvider?.model,
    analysisOptions: options,
    startedAt: new Date(analysisStartedAt).toISOString(),
    createdAt: new Date(analysisStartedAt).toISOString(),
  };
  {
    const db = getDb();
    db.prepare(
      "INSERT INTO analyses (id, project_id, data, created_at) VALUES (?, ?, ?, ?)"
    ).run(analysisId, project.id, JSON.stringify(analysisRecord), analysisStartedAt);
    // 更新 project.currentAnalysisId + status
    const projRow = db.prepare("SELECT data FROM projects WHERE id = ?").get(project.id);
    if (projRow) {
      const proj = JSON.parse(projRow.data);
      proj.currentAnalysisId = analysisId;
      proj.status = "analyzing";
      proj.updatedAt = new Date().toISOString();
      db.prepare("UPDATE projects SET data = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(proj), Date.now(), project.id);
    }
  }

  // 阶段耗时记录:每次 send 检测 stage 字符串变化,把上一个 stage 的 duration 推入
  // stage 内可通过 handle.attachStageMeta({...}) 注入额外元数据 (frames 数、shots 数、
  // model 名、tok/s 之类), 关 stage 时跟 durationMs 一起持久化, 用于 ETA 标定。
  const timings = [];
  let currentStage = null;
  let currentStageStartedAt = analysisStartedAt;
  let currentStageMeta = {};
  // tokenLedger 是累加全程的, 关 stage 时跟上一次快照算 delta 挂到 timings, 让 eta-learner
  // 能 join (stage durationMs, completion tokens) 出 effective TPS, 不需要专门记 wall time。
  const lastBucketSnapshot = new Map(); // key = `${stage}|${providerId}|${model}`
  const collectTokenDelta = () => {
    if (!handle.tokenLedger) return null;
    const snap = handle.tokenLedger.snapshot();
    const delta = [];
    for (const bucket of snap.stages) {
      const k = `${bucket.stage}|${bucket.providerId || ""}|${bucket.model || ""}`;
      const last = lastBucketSnapshot.get(k) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 0 };
      const d = {
        stage: bucket.stage,
        providerId: bucket.providerId,
        model: bucket.model,
        source: bucket.source,
        promptTokens: bucket.promptTokens - last.promptTokens,
        completionTokens: bucket.completionTokens - last.completionTokens,
        totalTokens: bucket.totalTokens - last.totalTokens,
        callCount: bucket.callCount - last.callCount,
      };
      if (d.completionTokens > 0 || d.callCount > 0) delta.push(d);
      lastBucketSnapshot.set(k, {
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        totalTokens: bucket.totalTokens,
        callCount: bucket.callCount,
      });
    }
    return delta.length > 0 ? delta : null;
  };
  const closeCurrentStage = (note) => {
    if (currentStage) {
      const tokenDelta = collectTokenDelta();
      timings.push({
        stage: currentStage,
        durationMs: Date.now() - currentStageStartedAt,
        ...(Object.keys(currentStageMeta).length ? { meta: currentStageMeta } : {}),
        ...(tokenDelta ? { tokenDelta } : {}),
        ...(note ? { note } : {}),
      });
      currentStage = null; // 幂等: finally 路径会再 close 一次, 避免重复 push
      try {
        const db = getDb();
        db.prepare("UPDATE analyses SET data = json_set(data, '$.stageSnapshot', json(?)) WHERE id = ?")
          .run(JSON.stringify(timings), analysisId);
      } catch { /* best-effort */ }
    }
    currentStageMeta = {};
  };
  handle.timings = timings;
  handle.attachStageMeta = (partial) => {
    if (!partial || typeof partial !== "object") return;
    currentStageMeta = { ...currentStageMeta, ...partial };
  };

  // Token 账本: 每个 LLM 阶段调用完后 record(usage), cache 命中走 cacheHit(); 收尾时
  // snapshot 进 report.tokenUsage 持久化。缓存命中时从上一次成功分析的 token-usage
  // 里回填对应 stage 的消耗量，让 UI 上能看到"这段如果不走缓存要花多少 token"。
  let priorTokenStages = null;
  try {
    const db = getDb();
    const priorRow = db.prepare(
      "SELECT id FROM analyses WHERE project_id = ? AND id != ? ORDER BY created_at DESC LIMIT 1"
    ).get(project.id, analysisId);
    if (priorRow?.id) {
      const priorUsage = await readJson(
        path.join(getAnalysisDir(project.id, priorRow.id), "token-usage.json"), null
      );
      if (priorUsage?.stages?.length) priorTokenStages = priorUsage.stages;
    }
  } catch { /* best-effort */ }
  const tokenLedger = createTokenLedger(priorTokenStages);
  handle.tokenLedger = tokenLedger;

  // stageIndex 映射: stage 中文名 → 流水线 UI 阶段索引 (0-8), 与 renderer PIPELINE_STAGE_DEFS 对齐。
  // timing 系统仍用细粒度的 stage 字符串做 key (eta-samples / DiagnosticsScreen 依赖它)。
  const STAGE_INDEX_MAP = {
    "下载视频": 0, "下载完成": 0,
    "读取视频信息": 1, "校验视频": 1,
    "检测镜头切换": 2,
    "挑选关键画面": 3, "抽取关键画面": 3, "画面去重": 3,
    "本地推理预检": 3, "本地初筛": 3, "本地初筛失败": 3, "精挑画面": 3,
    "提取音轨": 4, "字幕识别": 4, "字幕识别完成": 4, "字幕识别失败": 4, "字幕识别跳过": 4,
    "镜头合并": 5, "镜头缩略图": 5, "镜头缩略图就绪": 5, "镜头合并完成": 5, "镜头合并失败": 5,
    "全局聚合": 6, "全局聚合完成": 6, "全局聚合跳过": 6, "全局聚合失败": 6,
    "准备分析素材": 6, "识别视频类型": 6, "识别视频类型完成": 6, "类型识别跳过": 6, "类型识别完成": 6,
    "模型分析画面": 7, "主分析(分段)": 7, "主分析(审计)": 7, "分析失败": 7,
    "拉取弹幕": 7, "弹幕情绪聚合": 7, "弹幕情绪聚合完成": 7, "弹幕分析完成": 7, "弹幕分析失败": 7,
    "整理结果": 8, "保存失败快照": 8,
    "完成": 9, "已结束": 9, "生成最终报告": 9,
  };

  const send = (progress, stage, message, meta = {}) => {
    if (handle.cancelled) {
      if (!handle._cancelSkipLogged) {
        handle._cancelSkipLogged = true;
        log.info("analyze:lifecycle", `[analysis:${analysisId}] send() 首次跳过: 已取消, stage="${stage}" progress=${progress} (后续跳过不再打印)`);
      }
      return;
    }
    if (stage !== currentStage) {
      closeCurrentStage();
      currentStage = stage;
      currentStageStartedAt = Date.now();
    }
    const payload = { projectId: project.id, analysisId, progress, stage, message };
    const si = STAGE_INDEX_MAP[stage];
    if (si != null) payload.stageIndex = si;
    if (meta && meta.fromCache) payload.fromCache = true;
    handle.lastProgress = payload;
    handle.lastProgressAt = Date.now();
    broadcastToWindows("analysis:progress", payload);
  };

  // ETA baseline: 根据 project.durationSec + providers + machine baseline 算出各 stage 预算,
  // 立刻广播一次。ProgressScreen 用它替换 "elapsed/progress 线性外推" 的粗算法。
  // 实际跑到某 stage 时 baseline 偏低 / 偏高都由 renderer 端的 已完成 stage 实测时长去校准。
  try {
    const prefilterModelKey = cfgSnapshot?.lastLlamaModelKey || null;
    const budget = etaEstimator.computeBudget({
      durationSec: project.durationSec,
      hasAudio: project.hasAudio !== false,
      platform: project.source?.platform,
      complexVisionProvider,
      mediumTextProvider,
      audioProvider,
      prefilterEnabled: !!prefilterModelKey,
      prefilterModelKey,
      contextSize: complexVisionProvider?.contextSize,
      options,
      // 学习器拟合的云端 TPS — 覆盖 hardcoded fallback。本地模型不受影响。
      learnedBaselines,
    });
    if (budget.totalMs > 0) {
      handle.budget = { projectId: project.id, analysisId, budget };
      broadcastToWindows("analysis:budget", handle.budget);
    }
  } catch (err) {
    log.warn("analyze:budget", "计算 ETA budget 失败:", err?.message || err);
  }

  // 心跳:某些阶段(本地 whisper 加载/推理)单次任务 30s+,
  // 中间没有事件 UI 看起来卡死。每 2s 重发最近一次 progress 并附累计等待时长。
  const heartbeat = setInterval(() => {
    if (handle.cancelled || !handle.lastProgress) return;
    const idle = Date.now() - (handle.lastProgressAt || 0);
    if (idle < 1500) return;
    const elapsed = formatDuration(idle);
    const base = handle.lastProgress;
    const baseMsg = base.message || "";
    // 已经带过 "已等待 ..." 后缀,只更新时长 (匹配 23s / 23.6s / 3分05秒 三种格式)
    const stripped = baseMsg.replace(/\s*·?\s*已等待 (?:\d+(?:\.\d+)?s|\d+ms|\d+分\d+秒)$/, "");
    const msg = stripped ? `${stripped} · 已等待 ${elapsed}` : `已等待 ${elapsed}`;
    broadcastToWindows("analysis:progress", { ...base, message: msg });
  }, 2000);
  handle.heartbeat = heartbeat;

  // ETA 埋点: 在分析全部生命周期里记录 ok / cancelled / failed, 结束时 append 一行到
  // userData/eta-samples.jsonl, 用于离线推算各阶段耗时模型 (视频时长/帧数/shot数/tok-s)。
  let analysisOutcome = "failed";
  let analysisFailureMsg = null;

  try {
    let inputPath = resolveProjectVideoPath(project);
    if (!inputPath || !fsSync.existsSync(inputPath)) {
      const sourceUrl = project?.source?.type === "url" ? project.source.url : null;
      if (!sourceUrl) {
        throw new Error("找不到本地视频文件，无法开始分析。");
      }
      send(1, "下载视频", "视频文件缺失,正在重新下载…");
      const projectDir = getProjectDir(project.id);
      const mediaDir = path.join(projectDir, "media");
      await fs.mkdir(mediaDir, { recursive: true });
      const video = await performUrlDownloadFlow(sourceUrl, {
        projectId: project.id,
        mediaDir,
        handle,
        onProgress: (pct, stage, msg) => send(Math.min(9, Math.round(pct * 0.09)), stage, msg),
      });
      inputPath = video.filePath;
      if (!inputPath || !fsSync.existsSync(inputPath)) {
        throw new Error("视频重新下载后仍找不到文件。");
      }
      project.localFilePath = inputPath;
      project.localVideoPath = video.mediaUrl;
      project.durationSec = video.durationSec;
      project.width = video.width;
      project.height = video.height;
      project.orientation = video.orientation;
      if (video.title || video.filename) project.videoName = video.title || video.filename;
    }

    const ffmpeg = await commandPath("ffmpeg");
    const ffprobe = await commandPath("ffprobe");
    if (!ffmpeg || !ffprobe) {
      throw new Error("未检测到 ffmpeg/ffprobe，无法生成关键帧和媒体清单。");
    }

    const projectDir = getProjectDir(project.id);
    const artifactDir = path.join(projectDir, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });

    // 本地初筛预检(始终重新评估,不从 checkpoint 恢复)
    let localPrefilterReady = false;
    let prefilterModelKey = null;
    {
      const cfg = await readJson(getConfigPath(), null).catch(() => null);
      const preferredModel = cfg?.lastLlamaModelKey;
      const localStatus = llamaRuntime.getStatus();
      if (preferredModel) {
        if (!localStatus.binaryFound) {
          send(7, "本地推理预检", "推理引擎未安装,本次跳过初筛(去设置 → 本地推理可安装)。");
        } else {
          const models = await llamaRuntime.listModels();
          const target = models.find((m) => m.key === preferredModel);
          if (!target || !target.downloaded) {
            send(8, "本地推理预检", `模型 ${preferredModel} 未下载完成,本次跳过初筛。`);
          } else {
            localPrefilterReady = true;
            prefilterModelKey = preferredModel;
          }
        }
      }
    }

    // --- Checkpoint Phase 1: 视频检测 + 场景分析 + 帧计划 ---
    const manifestPath = path.join(projectDir, "media-manifest.json");
    const savedManifest = await readJson(manifestPath, null).catch(() => null);
    const manifestValid = savedManifest
      && savedManifest.pipelineVersion === PIPELINE_VERSION
      && savedManifest.scenes?.length > 0
      && savedManifest.plan?.length > 0;

    let inspected, scenes, plan, finalCount, candidateCount, inputFileSize;
    if (manifestValid) {
      send(3, "读取视频信息", "已有可复用的检测结果，跳过。", { fromCache: true });
      send(5, "检测镜头切换", `${savedManifest.scenes.length} 个镜头 · 计划抽 ${savedManifest.candidateFrameCount || savedManifest.plan.length} 帧，复用缓存。`, { fromCache: true });
      inspected = {
        durationSec: savedManifest.durationSec,
        width: savedManifest.width,
        height: savedManifest.height,
        orientation: savedManifest.orientation,
        hasAudio: savedManifest.hasAudio,
      };
      scenes = savedManifest.scenes;
      inputFileSize = await fs.stat(inputPath).then((s) => s.size).catch(() => 0);
      handle.attachStageMeta({ fileSizeBytes: inputFileSize, durationSec: inspected.durationSec, width: inspected.width, height: inspected.height, resumed: true });
      // prefilter 状态可能变了,重新算帧数和计划
      finalCount = targetFrameCount(inspected.durationSec || project.durationSec || 1, options);
      candidateCount = candidateFrameCount(inspected.durationSec || project.durationSec || 1, options, localPrefilterReady, scenes.length);
      if (savedManifest.localPrefilterReady === localPrefilterReady && savedManifest.candidateFrameCount === candidateCount) {
        plan = savedManifest.plan;
      } else {
        plan = planFramePlan(scenes, inspected.durationSec || project.durationSec || 1, candidateCount);
      }
      // 用实际 sceneCount + candidateCount 重算 budget，ETA 更准
      try {
        const recomputed = etaEstimator.computeBudget({
          durationSec: inspected.durationSec || project.durationSec,
          hasAudio: inspected.hasAudio !== false,
          platform: project.source?.platform,
          complexVisionProvider, mediumTextProvider, audioProvider,
          prefilterEnabled: !!prefilterModelKey, prefilterModelKey,
          contextSize: complexVisionProvider?.contextSize,
          options, learnedBaselines,
          actualScenesCount: scenes.length,
          actualCandidateFrames: candidateCount,
        });
        if (recomputed.totalMs > 0) {
          handle.budget = { projectId: project.id, analysisId, budget: recomputed };
          broadcastToWindows("analysis:budget", handle.budget);
        }
      } catch (err) {
        log.warn("analyze:budget-recompute", "场景检测后重算 budget 失败:", err?.message || err);
      }
    } else {
      send(3, "读取视频信息", "正在校验视频时长、分辨率、音轨。");
      ensureNotCancelled(handle);
      inputFileSize = await fs.stat(inputPath).then((s) => s.size).catch(() => 0);
      inspected = await inspectVideo(inputPath, handle);
      handle.attachStageMeta({ fileSizeBytes: inputFileSize, durationSec: inspected.durationSec, width: inspected.width, height: inspected.height });

      send(5, "检测镜头切换", "扫描视频中的镜头切换点。");
      ensureNotCancelled(handle);
      const sceneThreshold = sceneThresholdFor(options);
      scenes = await detectScenes(ffmpeg, inputPath, sceneThreshold, handle);
      handle.attachStageMeta({ scenesCount: scenes.length, durationSec: inspected.durationSec });

      finalCount = targetFrameCount(inspected.durationSec || project.durationSec || 1, options);
      candidateCount = candidateFrameCount(inspected.durationSec || project.durationSec || 1, options, localPrefilterReady, scenes.length);
      plan = planFramePlan(scenes, inspected.durationSec || project.durationSec || 1, candidateCount);

      try {
        const recomputed = etaEstimator.computeBudget({
          durationSec: inspected.durationSec || project.durationSec,
          hasAudio: inspected.hasAudio !== false,
          platform: project.source?.platform,
          complexVisionProvider, mediumTextProvider, audioProvider,
          prefilterEnabled: !!prefilterModelKey, prefilterModelKey,
          contextSize: complexVisionProvider?.contextSize,
          options, learnedBaselines,
          actualScenesCount: scenes.length,
          actualCandidateFrames: candidateCount,
        });
        if (recomputed.totalMs > 0) {
          handle.budget = { projectId: project.id, analysisId, budget: recomputed };
          broadcastToWindows("analysis:budget", handle.budget);
        }
      } catch (err) {
        log.warn("analyze:budget-recompute", "场景检测后重算 budget 失败:", err?.message || err);
      }

      await writeJson(manifestPath, {
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
    }
    const projectMeta = { ...project, ...inspected, hasAudio: inspected.hasAudio };
    send(
      8,
      "挑选关键画面",
      localPrefilterReady
        ? `本地初筛已就绪,从 ${scenes.length} 个镜头里先抽 ${plan.length} 张候选。`
        : `从 ${scenes.length} 个镜头里挑出 ${plan.length} 张关键画面。`,
    );

    // --- Checkpoint Phase 2: 抽帧 ---
    const framesCheckpointPath = path.join(projectDir, "frames-checkpoint.json");
    const savedFrames = await readJson(framesCheckpointPath, null).catch(() => null);
    const framesValid = savedFrames?.frames?.length > 0
      && savedFrames.pipelineVersion === PIPELINE_VERSION
      && savedFrames.frames.every((f) => fsSync.existsSync(f.framePath));
    let candidateFrames, skipped;
    if (framesValid) {
      send(9, "挑选关键画面", `复用 ${savedFrames.frames.length} 张关键画面，跳过抽帧。`, { fromCache: true });
      candidateFrames = savedFrames.frames;
      skipped = savedFrames.skipped || 0;
    } else {
      send(9, "抽取关键画面", `准备抽取 ${plan.length} 张关键画面,会自动去掉相似画面。`);
      handle.attachStageMeta({ planned: plan.length, durationSec: inspected.durationSec });
      ({ frames: candidateFrames, skipped } = await buildFrames(
        ffmpeg,
        inputPath,
        plan,
        artifactDir,
        handle,
        (i, total, sec) => {
          send(9 + Math.round((i / total) * 5), "抽取关键画面", `已抽 ${i + 1} / ${total} 张 · 第 ${sec.toFixed(1)} 秒`);
        },
        { withPrefilterFrame: localPrefilterReady },
      ));
      await writeJson(framesCheckpointPath, { frames: candidateFrames, skipped, pipelineVersion: PIPELINE_VERSION });
    }
    handle.attachStageMeta({ candidateFrames: candidateFrames.length, skipped });
    if (skipped > 0) {
      send(15, "画面去重", `去掉 ${skipped} 张相似画面,保留 ${candidateFrames.length} 张。`);
    }

    // ---- PIVOT: 固定段结束 (0-15%), 用 budget 给后续 LLM 阶段分配 15-98% ----
    const PIVOT_PCT = 15;
    const END_PCT = 98;
    let stageRanges = null;
    let lastBudgetPct = PIVOT_PCT;
    try {
      const pivotBudget = etaEstimator.computeBudget({
        durationSec: inspected.durationSec || project.durationSec,
        hasAudio: inspected.hasAudio !== false,
        platform: project.source?.platform,
        complexVisionProvider, mediumTextProvider, audioProvider,
        prefilterEnabled: !!prefilterModelKey, prefilterModelKey,
        contextSize: complexVisionProvider?.contextSize,
        options, learnedBaselines,
        actualScenesCount: scenes.length,
        actualCandidateFrames: candidateFrames.length,
      });
      const FIXED_STAGES = new Set([
        "读取视频信息", "检测镜头切换", "本地推理预检", "挑选关键画面", "抽取关键画面",
      ]);
      const lateStages = pivotBudget.stages.filter(s => !FIXED_STAGES.has(s.stage));
      const lateTotalMs = lateStages.reduce((sum, s) => sum + s.estMs, 0);
      if (lateTotalMs > 0) {
        stageRanges = {};
        let cumMs = 0;
        for (const s of lateStages) {
          stageRanges[s.stage] = {
            start: PIVOT_PCT + (cumMs / lateTotalMs) * (END_PCT - PIVOT_PCT),
            end: PIVOT_PCT + ((cumMs + s.estMs) / lateTotalMs) * (END_PCT - PIVOT_PCT),
          };
          cumMs += s.estMs;
        }
      }
      handle.budget = { projectId: project.id, analysisId, budget: pivotBudget };
      broadcastToWindows("analysis:budget", handle.budget);
    } catch (err) {
      log.warn("analyze:pivot-budget", "计算后续阶段进度分配失败:", err?.message || err);
    }

    const STAGE_BUDGET_ALIAS = {
      "主分析(分段)": "模型分析画面",
      "分析失败": "模型分析画面",
      "镜头缩略图": "镜头合并",
      "镜头缩略图就绪": "镜头合并",
      "类型识别跳过": "识别视频类型",
      "类型识别完成": "识别视频类型",
      "弹幕分析完成": "弹幕情绪聚合",
      "弹幕分析失败": "弹幕情绪聚合",
      "保存失败快照": "整理结果",
    };

    function pct(stage, fraction) {
      if (!stageRanges) return lastBudgetPct;
      const resolved = STAGE_BUDGET_ALIAS[stage] || stage;
      let match = null, matchLen = 0;
      for (const key of Object.keys(stageRanges)) {
        if (resolved.startsWith(key) && key.length > matchLen) {
          match = stageRanges[key]; matchLen = key.length;
        }
      }
      if (!match) return lastBudgetPct;
      const f = Math.max(0, Math.min(1, fraction));
      const p = Math.round(match.start + (match.end - match.start) * f);
      lastBudgetPct = Math.max(lastBudgetPct, p);
      return lastBudgetPct;
    }

    // 本地初筛 + 精筛:让 Qwen3.5-0.8B 给每帧打标,据此 dedup / 删空镜 / cap 总数。
    // 候选帧数可能远超 prefilter 时间预算 (每个镜头至少 1 帧, 高密度视频帧很多),
    // 预算内均匀覆盖镜头: 优先每镜头 1 帧, 剩余预算给长镜头多帧。
    let frames = candidateFrames;
    let prefilterStats = null;
    if (localPrefilterReady && candidateFrames.length > 0) {
      try {
        const pfBudgetSec = prefilterBudgetSec(inspected.durationSec || project.durationSec || 1, options);
        const prefilterCap = Math.floor((pfBudgetSec * 1000) / PREFILTER_PER_FRAME_MS);

        let framesToTag = candidateFrames;
        if (candidateFrames.length > prefilterCap) {
          // 按镜头分组 (startSec-endSec 唯一标识一个镜头)
          const shotGroups = new Map();
          for (const f of candidateFrames) {
            const key = `${f.startSec}-${f.endSec}`;
            if (!shotGroups.has(key)) shotGroups.set(key, []);
            shotGroups.get(key).push(f);
          }
          const shotKeys = [...shotGroups.keys()];
          const selected = [];
          const selectedSet = new Set();

          if (shotKeys.length <= prefilterCap) {
            // 预算够覆盖所有镜头: 每镜头取中点帧, 剩余给长镜头
            for (const key of shotKeys) {
              const group = shotGroups.get(key);
              const mid = (group[0].startSec + group[0].endSec) / 2;
              const best = group.reduce((a, b) =>
                Math.abs(a.midSec - mid) < Math.abs(b.midSec - mid) ? a : b
              );
              selected.push(best);
              selectedSet.add(best.index);
            }
            // 剩余预算给长镜头的额外帧
            const extras = candidateFrames
              .filter((f) => !selectedSet.has(f.index))
              .sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec));
            for (const f of extras) {
              if (selected.length >= prefilterCap) break;
              selected.push(f);
              selectedSet.add(f.index);
            }
          } else {
            // 预算不够覆盖所有镜头: 均匀间隔采样镜头
            const stride = shotKeys.length / prefilterCap;
            for (let i = 0; i < prefilterCap; i++) {
              const shotIdx = Math.min(shotKeys.length - 1, Math.floor(i * stride));
              const group = shotGroups.get(shotKeys[shotIdx]);
              const mid = (group[0].startSec + group[0].endSec) / 2;
              const best = group.reduce((a, b) =>
                Math.abs(a.midSec - mid) < Math.abs(b.midSec - mid) ? a : b
              );
              if (!selectedSet.has(best.index)) {
                selected.push(best);
                selectedSet.add(best.index);
              }
            }
          }
          selected.sort((a, b) => (a.midSec ?? 0) - (b.midSec ?? 0));
          framesToTag = selected;
        }

        send(pct("本地初筛", 0), "本地初筛", framesToTag.length < candidateFrames.length
          ? `让本地模型给 ${framesToTag.length} / ${candidateFrames.length} 张候选画面快速打标 (预算覆盖)。`
          : `让本地模型给 ${candidateFrames.length} 张候选画面快速打标。`
        );
        handle.attachStageMeta({ candidateFrames: candidateFrames.length, framesToTag: framesToTag.length, modelKey: prefilterModelKey });
        const prefilterStartedAt = Date.now();
        const tagResult = await prefilter.tagFrames(framesToTag, {
          modelKey: prefilterModelKey,
          acquireSlot: (mk, opts) => llamaManager.acquire(mk, opts),
          perFrameTimeoutMs: 30_000,
          cache: makePrefilterCache(prefilterModelKey),
          analysisId,
          abortSignal: handle.abortController?.signal,
          onProgress: (i, total, _tag, _elapsedMs, fromCache) => {
            ensureNotCancelled(handle);
            const avgMs = Math.round((Date.now() - prefilterStartedAt) / (i + 1));
            send(
              pct("本地初筛", (i + 1) / total),
              "本地初筛",
              `已打标 ${i + 1} / ${total} 张 · 平均 ${avgMs} ms/帧${fromCache ? " · 命中缓存" : ""}`,
            );
          },
        });
        const refined = prefilter.refineByTags(tagResult.frames, {
          maxKeep: finalCount,
          minKeep: Math.min(4, framesToTag.length),
          similarityThreshold: 0.7,
        });
        frames = refined.kept;
        prefilterStats = {
          totalElapsedMs: tagResult.totalElapsedMs,
          totalTokens: tagResult.totalTokens,
          candidate: candidateFrames.length,
          tagged: framesToTag.length,
          kept: refined.kept.length,
          dropped: refined.dropped.length,
        };
        const droppedDetails = refined.dropped.map((f) => ({
          index: f.index,
          midSec: f.midSec,
          reason: refined.reasons[f.index] || "未知",
          salience: f.prefilterTag?.salience ?? null,
          sceneType: f.prefilterTag?.sceneType ?? null,
          caption: f.prefilterTag?.caption ?? null,
        }));
        const callCount = Math.max(0, framesToTag.length - tagResult.cacheHits);
        if (callCount > 0) {
          tokenLedger.record({
            stage: "prefilter",
            provider: {
              id: "local-llama",
              name: "本地推理",
              source: "local_llama",
            },
            model: prefilterModelKey,
            source: "local_llama",
            usage: tagResult.totalTokens > 0
              ? {
                  promptTokens: tagResult.totalPromptTokens || 0,
                  completionTokens: tagResult.totalCompletionTokens || 0,
                  totalTokens: tagResult.totalTokens,
                }
              : null,
            callCount,
          });
        }
        for (let h = 0; h < tagResult.cacheHits; h++) {
          tokenLedger.cacheHit({
            stage: "prefilter",
            provider: { id: "local-llama", name: "本地推理", source: "local_llama" },
            model: prefilterModelKey,
            source: "local_llama",
          });
        }
        handle.attachStageMeta({ tagged: framesToTag.length, kept: refined.kept.length, dropped: refined.dropped.length, totalElapsedMs: tagResult.totalElapsedMs, totalTokens: tagResult.totalTokens, droppedDetails });
        {
          const allCached = (tagResult.cacheHits || 0) >= framesToTag.length && framesToTag.length > 0;
          send(
            pct("本地初筛", 1),
            "精挑画面",
            `从 ${framesToTag.length} 张标注帧里精选 ${refined.kept.length} 张送给视觉模型 · 本地初筛用时 ${(tagResult.totalElapsedMs / 1000).toFixed(1)}s`,
            { fromCache: allCached },
          );
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        send(pct("本地初筛", 1), "本地初筛失败", `${msg}（已回退到全部候选画面）`);
        frames = candidateFrames;
      }
    }

    // --- Checkpoint Phase 3: 音频转录 ---
    let transcript = null;
    let transcriptError = null;
    const transcriptPath = path.join(artifactDir, "transcript.json");
    const savedTranscript = await readJson(transcriptPath, null).catch(() => null);
    if (savedTranscript?.segments?.length > 0) {
      transcript = savedTranscript;
      send(pct("字幕识别", 1), "字幕识别", `命中缓存，复用 ${transcript.segments.length} 段已有字幕。`, { fromCache: true });
    }
    const audioReady = !transcript && audioProvider && inspected.hasAudio && (
      audioProvider.source === "local_whisper" ||
      audioProvider.endpointType === "local_whisper_cpp" ||
      audioProvider.endpointType === "local_whisper_wasm" ||
      audioProvider.apiKeyRef
    );
    if (!audioReady && !transcript) {
      const skipReasons = [];
      if (!audioProvider) skipReasons.push("未配置语音识别供应商");
      else if (!inspected.hasAudio) skipReasons.push("视频无音轨");
      else {
        const src = audioProvider.source || audioProvider.endpointType;
        if (src !== "local_whisper" && src !== "local_whisper_cpp" && src !== "local_whisper_wasm" && !audioProvider.apiKeyRef) {
          skipReasons.push(`供应商 ${audioProvider.name || src} 无 API Key 且非本地 whisper`);
        }
      }
      const reason = skipReasons.length > 0 ? skipReasons.join("; ") : "未知原因";
      send(50, "字幕识别跳过", reason);
      handle.attachStageMeta({ transcriptSkipped: true, transcriptSkipReason: reason });
      log.info("clipiq", `转录跳过: ${reason} (audioProvider=${audioProvider ? audioProvider.name : "null"}, hasAudio=${inspected.hasAudio})`);
    }
    if (audioReady) {
      try {
        send(pct("提取音轨", 0), "提取音轨", "从视频里分离出音频,准备识别字幕。");
        const wavPath = path.join(artifactDir, "audio.wav");
        await extractAudioWav(ffmpeg, inputPath, wavPath, handle);
        send(pct("字幕识别", 0), "字幕识别", `${audioProvider.name} 准备就绪`);
        handle.attachStageMeta({
          audioSec: inspected.durationSec,
          providerName: audioProvider.name,
          model: audioProvider.localWhisperModel || audioProvider.model,
          source: audioProvider.source || audioProvider.endpointType,
        });
        ensureNotCancelled(handle);

        // 缓存 key: 音频文件 sha + 模型 + 语言 + 后端来源 + prompt 版本
        let transcriptCacheKey = null;
        try {
          const audioSha = await cacheStore.sha256File(wavPath);
          transcriptCacheKey = cacheStore.makeKey({
            sha: audioSha,
            model: audioProvider.localWhisperModel || audioProvider.model,
            lang: audioProvider.language || null,
            source: audioProvider.source || audioProvider.endpointType,
            version: CACHE_VERSIONS.transcript,
          });
        } catch { /* sha 失败 → 跳过缓存 */ }

        const transcribeMeta = {
          model: audioProvider.localWhisperModel || audioProvider.model,
          lang: audioProvider.language || null,
          source: audioProvider.source || audioProvider.endpointType,
        };
        transcript = await runWithCache("transcript", transcriptCacheKey, async () => {
          return await transcribeAudio(audioProvider, wavPath, handle, (p) => {
            send(pct("字幕识别", 0.5), "字幕识别", p.message);
          });
        }, transcribeMeta);

        if (transcript) {
          await writeJson(path.join(artifactDir, "transcript.json"), transcript);
          handle.attachStageMeta({ transcriptSegments: transcript.segments.length, transcriptChars: transcript.text.length });
          send(pct("字幕识别", 1), "字幕识别完成", `共 ${transcript.segments.length} 段字幕、${transcript.text.length} 个字。`);
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        transcriptError = error?.message || String(error);
        send(pct("字幕识别", 1), "字幕识别失败", `${transcriptError}（不影响后续画面分析）`);
      }
    }

    const fallbackNodes = frames.map((frame) =>
      localNodeForSegment(
        frame,
        projectMeta,
        createProjectMediaUrl(project.id, frame.framePath),
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
        send(pct("镜头合并", 0), "镜头合并", `让 ${mediumTextProvider.name} 把 ${shots.length} 个镜头合成可读描述。`);
        handle.attachStageMeta({
          shots: shots.length,
          providerName: mediumTextProvider.name,
          model: mediumTextProvider.model,
          endpointType: mediumTextProvider.endpointType,
          contextSize: mediumTextProvider.contextSize,
        });
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
        // 并发数: 在线模型用 config 配置(默认 3),本地模型强制 1
        const isLocalMedium = mediumTextProvider.source === "local_llama";
        const cfgConcurrency = Number(cfgSnapshot?.pipelineConcurrency) || 0;
        const mergeConcurrency = isLocalMedium ? 1 : (cfgConcurrency > 0 ? cfgConcurrency : 3);
        log.info("shot-merger", `[analysis:${analysisId}] 开始合并 ${mergeInputs.length} 个镜头, concurrency=${mergeConcurrency}`);
        const mergeResults = await shotMerger.mergeShots({
          shots: mergeInputs,
          provider: mediumTextProvider,
          concurrency: mergeConcurrency,
          handle,
          cache: makeShotMergerCache(mediumTextProvider),
          onProgress: ({ done, total, batchIndex, batchSize, mode }) => {
            ensureNotCancelled(handle);
            const p = pct("镜头合并", done / total);
            const tail = mode === "cache-hit" ? " · 命中缓存" : "";
            send(p, "镜头合并", `已合并 ${done}/${total} (第 ${batchIndex} 轮 · 每轮 ${batchSize} 个, 平均 ${formatDuration((Date.now()-mergeStart)/done)}/镜头)${tail}`);
          },
        });
        if (mergeResults.usage && mergeResults.usage.callCount > 0) {
          tokenLedger.record({
            stage: "shot-merger",
            provider: mediumTextProvider,
            model: mergeResults.echoedModel || mediumTextProvider.model,
            usage: {
              promptTokens: mergeResults.usage.promptTokens,
              completionTokens: mergeResults.usage.completionTokens,
              totalTokens: mergeResults.usage.totalTokens,
            },
            callCount: mergeResults.usage.callCount,
          });
        }
        for (let h = 0; h < (mergeResults.cacheHits || 0); h++) {
          tokenLedger.cacheHit({
            stage: "shot-merger",
            provider: mediumTextProvider,
            model: mediumTextProvider.model,
          });
        }
        // 写回 shots: shotDescription + representativeFrameIndex
        for (let i = 0; i < shots.length; i++) {
          shots[i].shotDescription = mergeResults[i]?.shotDescription || "";
          shots[i].representativeFrameIndex = mergeResults[i]?.representativeFrameIndex || [];
        }
        handle.attachStageMeta({
          cacheHits: mergeResults.cacheHits || 0,
          mergeElapsedMs: Date.now() - mergeStart,
          avgMsPerShot: Math.round((Date.now() - mergeStart) / Math.max(shots.length, 1)),
        });
        // 兜底: scene detector 切出的镜头数 >> prefilter 保留的关键帧数时,
        // 大多数镜头会 frames=[]; 在镜头中点抽一张轻量缩略图, 让 UI 镜头时间线每个 card
        // 都有图, 也让 attachShotEvidenceToNodes 在帧稀疏时不至于完全失配。
        const shotsNeedingThumb = shots.filter(
          (s) => !Array.isArray(s.frames) || s.frames.length === 0
        );
        if (shotsNeedingThumb.length > 0) {
          const thumbStart = Date.now();
          let thumbDone = 0;
          const concurrency = 6;
          for (let i = 0; i < shotsNeedingThumb.length; i += concurrency) {
            ensureNotCancelled(handle);
            const batch = shotsNeedingThumb.slice(i, i + concurrency);
            await Promise.all(
              batch.map(async (s) => {
                const midSec = Math.max(0, (Number(s.startSec) + Number(s.endSec)) / 2);
                const framePath = path.join(
                  artifactDir,
                  `shot-${String(s.shotIndex + 1).padStart(3, "0")}.jpg`
                );
                try {
                  await extractFrame(ffmpeg, inputPath, framePath, midSec, 360, handle, 4);
                  s.frames = [{ framePath, midSec, isShotThumbBackfill: true }];
                } catch (err) {
                  if (err instanceof AnalysisCancelledError || err?.name === "AbortError") throw err;
                  // 单帧失败不阻断, 该镜头仍然 frames=[]
                }
              })
            );
            thumbDone += batch.length;
            send(
              pct("镜头缩略图", thumbDone / shotsNeedingThumb.length),
              "镜头缩略图",
              `已为 ${thumbDone}/${shotsNeedingThumb.length} 个无关键帧镜头抽兜底缩略图`
            );
          }
          send(
            pct("镜头缩略图就绪", 1),
            "镜头缩略图就绪",
            `${shotsNeedingThumb.length} 张兜底缩略图 · ${((Date.now() - thumbStart) / 1000).toFixed(1)}s`
          );
        }
        // shotContexts 完整形态: 带帧 URL + 字幕分段, 供 UI 镜头时间线渲染
        // (旧 report 里只存了 framesInShot 数量和 subtitleText 字符串, 现在保留向后兼容字段)
        const toFrameCtx = (f) => ({
          thumbnailUrl: createProjectMediaUrl(project.id, f.framePath),
          framePath: f.framePath,
          midSec: Number(f.midSec) || 0,
          caption: f.prefilterTag?.caption,
          salience: f.prefilterTag?.salience,
          signature: f.prefilterTag?.signature,
        });
        shotContexts = shots.map((s) => {
          const framesCtx = Array.isArray(s.frames) ? s.frames.map(toFrameCtx) : [];
          const repIdxs = Array.isArray(s.representativeFrameIndex) ? s.representativeFrameIndex : [];
          const repFrames = repIdxs
            .map((i) => framesCtx[i])
            .filter(Boolean);
          return {
            shotIndex: s.shotIndex,
            startSec: s.startSec,
            endSec: s.endSec,
            shotDescription: s.shotDescription,
            frames: framesCtx,
            representativeFrames: repFrames.length > 0 ? repFrames : framesCtx.slice(0, 1),
            subtitleSegments: Array.isArray(s.subtitleSegments)
              ? s.subtitleSegments.map((seg) => ({
                  start: Number(seg.start) || 0,
                  end: Number(seg.end) || 0,
                  text: String(seg.text || "").trim(),
                }))
              : [],
            subtitleText: s.subtitleText || undefined,
            framesInShot: framesCtx.length,
          };
        });
        {
          const cacheHits = mergeResults.cacheHits || 0;
          const allCached = cacheHits >= shots.length && shots.length > 0;
          const cacheTail = cacheHits > 0 ? ` · 命中缓存 ${cacheHits}/${shots.length}` : "";
          send(
            pct("镜头合并", 1),
            "镜头合并完成",
            `${shots.length} 个镜头描述就绪 · ${formatDuration(Date.now()-mergeStart)}${cacheTail}`,
            { fromCache: allCached },
          );
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(pct("镜头合并", 1), "镜头合并失败", `${error.message || error}。降级到旧的逐帧路径。`);
        shotContexts = null;
      }

      // 全局聚合 (genre + summary + 叙事结构): 优先用大模型以提高叙事结构线索的准确度,
      // 大模型不可用时 fallback 到中等文本模型。
      if (shotContexts && shotContexts.length > 0) {
        const summarizerProvider = (complexVisionProvider?.apiKeyRef && complexVisionProvider?.baseUrl && complexVisionProvider?.model)
          ? complexVisionProvider
          : mediumTextProvider;
        try {
          ensureNotCancelled(handle);
          send(pct("全局聚合", 0), "全局聚合", `综合 ${shotContexts.length} 个镜头描述 + 字幕推断视频类型和摘要 (${summarizerProvider.name})。`);
          const sumStart = Date.now();
          const stats = computeShotStats(
            buildShotListFromScenes(scenes, projectMeta.durationSec, []),
            projectMeta.durationSec,
          );
          const summarizerCacheKey = cacheStore.isConfigured() && summarizerProvider?.model
            ? cacheStore.makeKey({
                shots: shotContexts.map((c) => ({
                  idx: c.shotIndex,
                  start: Number(c.startSec).toFixed(1),
                  end: Number(c.endSec).toFixed(1),
                  desc: c.shotDescription || "",
                })),
                transcriptText: (transcript?.text || "").slice(0, 4000),
                stats,
                allowedGenres: [...ALLOWED_GENRES],
                model: summarizerProvider.model,
                baseUrl: summarizerProvider.baseUrl,
                version: CACHE_VERSIONS.summarizer,
              })
            : null;
          const summarizerTraced = await runWithCacheTraced("summarizer", summarizerCacheKey, () => summarizer.summarizeVideo({
            shotContexts,
            transcript,
            shotStats: stats,
            project: projectMeta,
            provider: summarizerProvider,
            genreCatalog: GENRE_CATALOG,
            allowedGenres: [...ALLOWED_GENRES],
            handle,
          }), { model: summarizerProvider?.model });
          globalContext = summarizerTraced.payload;
          if (summarizerTraced.fromCache) {
            tokenLedger.cacheHit({
              stage: "summarizer",
              provider: summarizerProvider,
              model: summarizerProvider.model,
            });
          } else if (globalContext?.usage) {
            tokenLedger.record({
              stage: "summarizer",
              provider: summarizerProvider,
              model: globalContext.echoedModel || summarizerProvider.model,
              usage: globalContext.usage,
            });
          }
          if (globalContext?.detectedGenre) {
            send(
              pct("全局聚合", 1),
              "全局聚合完成",
              `判定 ${globalContext.detectedGenre} (${Math.round((globalContext.genreConfidence||0)*100)}%) · 摘要 ${globalContext.globalSummary?.length || 0} 字 · ${((Date.now()-sumStart)/1000).toFixed(1)}s`,
              { fromCache: summarizerTraced.fromCache },
            );
          } else {
            send(pct("全局聚合", 1), "全局聚合跳过", "未能从镜头描述推断, 让主分析自行识别。", { fromCache: summarizerTraced.fromCache });
          }
        } catch (error) {
          if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
          send(pct("全局聚合", 1), "全局聚合失败", `${error.message || error}。降级到 detectGenreLightweight。`);
          globalContext = null;
        }
      }
    }

    let nodes = fallbackNodes;
    let report = fallbackReport;
    // 主分析(callOpenAICompatible)失败时置 true, 后续耗时的 best-effort stage (弹幕情绪聚合 /
    // 标题生成) 一律 skip 直接进收尾。failed nodes/report 已经在 catch 里 persistEarlySnapshot
    // 写盘, renderer 拿到的 result 是 failed 标记的骨架, Workspace 屏能正常展示 failed 状态。
    let mainAnalysisFailed = false;
    ensureNotCancelled(handle);
    send(pct("准备分析素材", 0), "准备分析素材", provider?.apiKeyRef ? `已整理好 ${frames.length} 张关键画面${transcript ? " + 字幕" : ""}${shotContexts ? ` + ${shotContexts.length} 个镜头描述` : ""},准备送给模型。` : "未配置视觉模型,本次只生成时间线骨架。");

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
          send(pct("识别视频类型", 0), "识别视频类型", `根据字幕和镜头切换让 ${genreProvider.name} 推断视频类型。`);
          const detectStartedAt = Date.now();
          const detectGenreCacheKey = cacheStore.isConfigured() && genreProvider?.model
            ? cacheStore.makeKey({
                scenes: (scenes || []).map((s) => Math.round(Number(s) * 1000)),
                duration: Math.round(projectMeta.durationSec || 0),
                width: projectMeta.width,
                height: projectMeta.height,
                transcriptText: (transcript?.text || "").slice(0, 4000),
                model: genreProvider.model,
                baseUrl: genreProvider.baseUrl,
                version: CACHE_VERSIONS.detectGenre,
              })
            : null;
          const detectTraced = await runWithCacheTraced("detect-genre", detectGenreCacheKey,
            () => detectGenreLightweight(genreProvider, projectMeta, scenes, transcript, handle),
            { model: genreProvider?.model });
          const detected = detectTraced.payload;
          if (detectTraced.fromCache) {
            tokenLedger.cacheHit({
              stage: "detect-genre",
              provider: genreProvider,
              model: genreProvider?.model,
            });
          } else if (detected?.usage) {
            tokenLedger.record({
              stage: "detect-genre",
              provider: genreProvider,
              model: detected.echoedModel || genreProvider?.model,
              usage: detected.usage,
            });
          }
          if (detected?.detectedGenre) {
            effectiveOptions = { ...options, detectedGenre: detected.detectedGenre };
            send(
              pct("类型识别完成", 1),
              "识别视频类型完成",
              `判定为 ${detected.detectedGenre}（置信度 ${(detected.genreConfidence * 100).toFixed(0)}%，耗时 ${Math.round((Date.now() - detectStartedAt) / 1000)}s）。`,
              { fromCache: detectTraced.fromCache },
            );
          } else {
            send(pct("类型识别跳过", 1), "类型识别跳过", "未能从字幕推断类型，将让主分析在 catalog 中识别。");
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

        send(pct("模型分析画面", 0), "模型分析画面", `正在请 ${provider.name} 分析这段视频。`);
        handle.attachStageMeta({
          frames: frames.length,
          transcriptChars: transcript?.text?.length || 0,
          shots: Array.isArray(shots) ? shots.length : 0,
          providerName: provider.name,
          model: provider.model,
          endpointType: provider.endpointType,
          contextSize: provider.contextSize,
        });
        let mainAnalysisCacheKey = null;
        if (cacheStore.isConfigured() && provider?.model) {
          try {
            const frameShas = await Promise.all(
              frames.map((f) => cacheStore.sha256File(f.framePath).catch(() => null)),
            );
            // 任何一帧 sha 算不出来 → 整段跳过缓存, 避免误命中
            if (frameShas.every(Boolean)) {
              mainAnalysisCacheKey = cacheStore.makeKey({
                frames: frameShas,
                transcriptText: (transcript?.text || "").slice(0, 4000),
                scenes: (scenes || []).map((s) => Math.round(Number(s) * 1000)),
                options: {
                  detectedGenre: effectiveOptions?.detectedGenre,
                  manualGenre: effectiveOptions?.manualGenre,
                  preset: effectiveOptions?.preset,
                  globalSummary: effectiveOptions?.globalSummary || null,
                  structureHint: effectiveOptions?.structureHint || null,
                },
                model: provider.model,
                baseUrl: provider.baseUrl,
                inputMode: provider.inputMode,
                version: CACHE_VERSIONS.mainAnalysis,
              });
            }
          } catch { /* 算 key 失败 → 不缓存 */ }
        }
        const mainAnalysisTraced = await runWithCacheTraced("main-analysis", mainAnalysisCacheKey,
          () => callOpenAICompatible(
            provider, projectMeta, frames, transcript, scenes, fallbackNodes, fallbackReport,
            effectiveOptions, handle,
            // 分段进度回调: chunk 阶段用 78-83 进度区间, audit 用 84
            (done, total, phase, chunk) => {
              if (phase === "chunk") {
                const frac = total > 0 ? done / total : 0;
                send(
                  pct("主分析(分段)", frac),
                  "主分析(分段)",
                  `第 ${done + 1}/${total} 段 · [${(chunk?.startSec || 0).toFixed(0)}-${(chunk?.endSec || 0).toFixed(0)}s] · shots=${chunk?.shots?.length || 0} frames=${chunk?.frames?.length || 0}`,
                );
              } else if (phase === "audit") {
                send(pct("主分析(审计)", 0), "主分析(审计)", "全部分段拉片完成, 跑方法论审计与全局报告…");
              }
            },
          ),
          { model: provider?.model });
        const modelResult = mainAnalysisTraced.payload;
        if (mainAnalysisTraced.fromCache) {
          tokenLedger.cacheHit({
            stage: "main-analysis",
            provider,
            model: provider?.model,
          });
          // 让 log 上有一行 "(缓存)" 标记 — 避免用户误以为模型这次真跑了 5 分钟
          send(pct("模型分析画面", 1), "模型分析画面", `命中缓存,跳过 LLM 调用。`, { fromCache: true });
        } else if (modelResult?.usage) {
          tokenLedger.record({
            stage: "main-analysis",
            provider,
            model: modelResult.echoedModel || provider?.model,
            usage: modelResult.usage,
          });
        }
        nodes = modelResult.nodes;
        // 把金字塔中间产物 (代表帧 / 帧 captions / 字幕段) 挂到节点上, 让 UI 能渲染镜头级 evidence
        if (Array.isArray(shots) && shots.length > 0) {
          attachShotEvidenceToNodes(nodes, shots, project.id);
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
        const stackOrMsg = error?.stack || error?.message || String(error);
        const shortMsg = error?.message || String(error);
        log.error("analyze:main", `provider=${provider?.id} model=${provider?.model} 主分析失败:\n${stackOrMsg}`);
        try {
          await fs.appendFile(
            path.join(projectDir, "analysis-error.log"),
            `[${new Date().toISOString()}] [main-analysis] provider=${provider?.id} model=${provider?.model}\n${stackOrMsg}\n\n`,
          );
        } catch (writeErr) {
          log.warn("analyze:main", "写 analysis-error.log 失败:", writeErr?.message || writeErr);
        }
        nodes = markFallbackNodesAsFailed(fallbackNodes);
        report = markFallbackReportAsFailed(fallbackReport, shortMsg, provider);
        mainAnalysisFailed = true;
        // failureMsg 同步给 outer finally 写 eta-samples 用 (现在没 throw, finally 里
        // 拿不到 err.message), outcome 也提前置 failed 让 learner 跳过这次样本。
        analysisOutcome = "failed";
        analysisFailureMsg = shortMsg;
        send(pct("分析失败", 1), "分析失败", `${shortMsg}。已保留镜头骨架,节点字段标记为分析失败,跳过后续弹幕/标题阶段。`);
        // 立刻把 failed 快照写到 JSON + SQLite。
        // 后续弹幕情绪聚合 / 整理结果如果跑到一半 crash 或被 Mac sleep 杀进程,
        // 至少 ReportScreen 加载到的是这次的 failed report, 而不是上次跑的脏数据。
        await persistEarlySnapshot(project, analysisId, nodes, report, timings, analysisStartedAt);
      }
    } else if (globalContext || shotContexts) {
      // 视觉主分析未配置, 但中间层有产物, 让 fallback report 至少能带上 globalSummary
      if (globalContext?.globalSummary) report.globalSummary = globalContext.globalSummary;
      if (shotContexts) report.shotContexts = shotContexts;
    }

    // ----- B 站弹幕 → 时间轴情绪 + 词云 ----------------------------------
    // 触发条件: project.source 是 URL 且 platform=bilibili。其他平台不进。
    // 失败一律降级 (拉取/解析/LLM 任一阶段错都跳过, 不阻断主流程)。
    // 主分析已失败时跳过 —— 弹幕情绪挂到 failed nodes 上没意义, 且 LLM 聚合可能再花 1-2 分钟。
    if (
      !mainAnalysisFailed &&
      project.source?.type === "url" &&
      project.source.platform === "bilibili" &&
      project.source.url
    ) {
      try {
        ensureNotCancelled(handle);
        send(pct("拉取弹幕", 0), "拉取弹幕", "向 B 站请求弹幕分段…");
        const danmakuStart = Date.now();
        const danmakuRaw = await danmakuFetcher.fetchDanmakuWithCache({
          url: project.source.url,
          userDataDir: app.getPath("userData"),
          abortSignal: handle.abortController?.signal,
          onProgress: ({ segment, total, count, fromCache }) => {
            if (handle.cancelled) return;
            if (fromCache) {
              send(pct("拉取弹幕", 1), "拉取弹幕", `已有 ${count} 条可复用的历史弹幕，跳过拉取。`);
            } else {
              send(pct("拉取弹幕", segment / Math.max(total, 1)), "拉取弹幕", `已拉 ${segment}/${total} 段 · 累计 ${count} 条`);
            }
          },
        });
        await writeJson(path.join(projectDir, "danmaku.json"), danmakuRaw);

        let windows = [];
        let danmakuSummary = "";
        if (mediumTextProvider?.apiKeyRef && danmakuRaw.messages.length > 0) {
          ensureNotCancelled(handle);
          send(pct("弹幕情绪聚合", 0), "弹幕情绪聚合", `让 ${mediumTextProvider.name} 给 ${danmakuRaw.totalCount} 条弹幕分段评分。`);
          const aggStart = Date.now();
          const agg = await danmakuEmotion.aggregateEmotions({
            messages: danmakuRaw.messages,
            shots: Array.isArray(shots) ? shots : [],
            durationSec: projectMeta.durationSec || inspected.durationSec,
            provider: mediumTextProvider,
            handle,
            cache: makeDanmakuEmotionCache(mediumTextProvider),
            onProgress: ({ done, total }) => {
              if (handle.cancelled) return;
              send(pct("弹幕情绪聚合", done / total), "弹幕情绪聚合", `已评 ${done}/${total} 个时间桶`);
            },
          });
          windows = agg.windows;
          danmakuSummary = agg.summary;
          if (agg.usage && agg.usage.callCount > 0) {
            tokenLedger.record({
              stage: "danmaku-emotion",
              provider: mediumTextProvider,
              model: agg.echoedModel || mediumTextProvider.model,
              usage: {
                promptTokens: agg.usage.promptTokens,
                completionTokens: agg.usage.completionTokens,
                totalTokens: agg.usage.totalTokens,
              },
              callCount: agg.usage.callCount,
            });
          }
          send(pct("弹幕情绪聚合", 1), "弹幕情绪聚合完成", `${windows.filter((w) => w.danmakuCount > 0).length} 个时间桶 · ${((Date.now() - aggStart) / 1000).toFixed(1)}s`);
        }

        // 词云 (LLM 不可用也能跑, 纯本地启发式)
        const wordCloud = danmakuWordcloud.buildWordCloud(danmakuRaw.messages);
        const nodeTopTerms = danmakuWordcloud.buildNodeTopTerms(danmakuRaw.messages, nodes);

        // emotion windows → 节点级 AudienceReaction
        if (windows.length > 0) {
          danmakuEmotion.attachReactionsToNodes(nodes, windows, danmakuRaw.messages);
        }
        // 把节点 mini 词云挂上
        for (const node of nodes) {
          const top = nodeTopTerms.get(node.id);
          if (top && top.length > 0) {
            node.audienceReaction = node.audienceReaction || {
              dominantEmotion: "neutral",
              intensities: { joy: 0, surprise: 0, anger: 0, sadness: 0, disgust: 0 },
              danmakuCount: 0,
              summary: "反应平淡",
            };
            node.audienceReaction.topTerms = top;
          }
        }

        report.danmaku = {
          platform: "bilibili",
          totalCount: danmakuRaw.totalCount,
          windows,
          wordCloud,
          fetchedAt: danmakuRaw.fetchedAt || new Date().toISOString(),
          summary: danmakuSummary || undefined,
        };

        send(
          pct("弹幕分析完成", 1),
          "弹幕分析完成",
          `${danmakuRaw.totalCount} 条弹幕 · 词云 ${wordCloud.length} 词 · ${((Date.now() - danmakuStart) / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(pct("弹幕分析失败", 1), "弹幕分析失败", `${error?.message || error}（不影响主分析结果）`);
      }
    }

    ensureNotCancelled(handle);
    send(pct("整理结果", 0), mainAnalysisFailed ? "保存失败快照" : "整理结果", "正在保存分析结果。");

    // 本地选取的视频 (没经过 URL 拉取那条路, videoName 是磁盘文件名) 在这里补标题。
    // URL 拉取场景在 downloadVideo handler 里已经生成过 → titleAutoGenerated:true → 跳过。
    // 主分析失败时不再补标题: globalContext 可能没有 / 标题用 LLM 又要 5-10s, 用户已经知道失败了
    let generatedTitle = null;
    const titleCanRun =
      !mainAnalysisFailed &&
      !project.titleAutoGenerated &&
      !!globalContext?.globalSummary &&
      !!mediumTextProvider?.apiKeyRef;
    // 诊断: 把 gate + result 也写到 projectDir/analysis-error.log, 这样开发期能直接 Read 文件查看,
    // 不依赖 main 进程 stdout (那个只在 electron:dev 终端窗口里, 调试断了之后看不到)。
    const titleGenLogPath = path.join(projectDir, "analysis-error.log");
    const appendTitleGenLog = async (line) => {
      try {
        await fs.appendFile(titleGenLogPath, `[${new Date().toISOString()}] [title-gen] ${line}\n`);
      } catch { /* noop */ }
    };
    const gateLine =
      `gate: mainFailed=${mainAnalysisFailed} ` +
      `alreadyGenerated=${!!project.titleAutoGenerated} ` +
      `hasSummary=${!!globalContext?.globalSummary} summaryLen=${globalContext?.globalSummary?.length || 0} ` +
      `hasProvider=${!!mediumTextProvider?.apiKeyRef} providerModel=${mediumTextProvider?.model || "n/a"} ` +
      `→ canRun=${titleCanRun}`;
    log.info("analyze:title-gen", gateLine);
    await appendTitleGenLog(gateLine);
    if (titleCanRun) {
      try {
        const titleResult = await generateProjectTitle(mediumTextProvider, {
          summary: globalContext.globalSummary,
        }, handle);
        const resultLine =
          `result: title=${JSON.stringify(titleResult?.title)} ` +
          `usage=${titleResult?.usage ? JSON.stringify(titleResult.usage) : "n/a"} ` +
          `rawLen=${(titleResult?._diagnostic?.rawLen) ?? "n/a"} ` +
          `reasoningLen=${(titleResult?._diagnostic?.reasoningLen) ?? "n/a"} ` +
          `parsedSource=${titleResult?._diagnostic?.parsedSource ?? "n/a"} ` +
          `rawHead=${JSON.stringify(titleResult?._diagnostic?.rawHead || "")}`;
        log.info("analyze:title-gen", resultLine);
        await appendTitleGenLog(resultLine);
        generatedTitle = titleResult?.title || null;
        if (titleResult?.usage) {
          tokenLedger.record({
            stage: "title-gen",
            provider: mediumTextProvider,
            model: titleResult.echoedModel || mediumTextProvider.model,
            usage: titleResult.usage,
          });
        }
      } catch (err) {
        if (err instanceof AnalysisCancelledError || err?.name === "AbortError") throw new AnalysisCancelledError();
        const errLine = `失败: ${err?.message || err}`;
        log.warn("analyze:title-gen", errLine);
        await appendTitleGenLog(errLine);
      }
    }

    const updatedProject = {
      ...project,
      localFilePath: inputPath,
      localVideoPath: createExternalMediaUrl(inputPath),
      durationSec: inspected.durationSec || project.durationSec,
      width: inspected.width || project.width,
      height: inspected.height || project.height,
      orientation: inspected.orientation || project.orientation,
      status: mainAnalysisFailed ? "failed" : "completed",
      currentAnalysisId: analysisId,
      thumbnailUrl: frames[0]?.framePath ? createProjectMediaUrl(project.id, frames[0].framePath) : project.thumbnailUrl,
      ...(generatedTitle ? { videoName: generatedTitle, titleAutoGenerated: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    send(100, mainAnalysisFailed ? "已结束" : "完成", mainAnalysisFailed ? "主分析失败, 已跳过弹幕/标题, 保留镜头骨架。" : "分析结果已生成。");
    closeCurrentStage();
    const totalDurationMs = Date.now() - analysisStartedAt;
    const finalTimings = [...timings];
    const top = finalTimings
      .filter((t) => t.durationMs > 0 && t.stage !== "完成")
      .sort((a, b) => b.durationMs - a.durationMs)[0];
    const topLabel = top ? ` · 最耗时 ${top.stage} ${(top.durationMs / 1000).toFixed(1)}s` : "";
    if (!handle.cancelled) {
      broadcastToWindows("analysis:progress", {
        projectId: project.id,
        analysisId,
        progress: 100,
        stage: mainAnalysisFailed ? "已结束" : "完成",
        message: `${mainAnalysisFailed ? "失败兜底耗时 " : "总耗时 "}${(totalDurationMs / 1000).toFixed(1)}s${topLabel}`,
      });
    }
    const tokenUsage = tokenLedger.snapshot();
    report = { ...report, timings: finalTimings, totalDurationMs, tokenUsage };
    // 写到 per-analysis 目录
    const analysisDir = getAnalysisDir(project.id, analysisId);
    await fs.mkdir(analysisDir, { recursive: true });
    await writeJson(path.join(analysisDir, "analysis-result.json"), { analysisId, project: updatedProject, nodes, report });
    await writeJson(path.join(analysisDir, "timings.json"), { totalDurationMs, timings: finalTimings });
    await writeJson(path.join(analysisDir, "token-usage.json"), tokenUsage);
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const finalRecord = {
        ...analysisRecord,
        status: mainAnalysisFailed ? "failed" : "completed",
        completedAt: now,
        totalDurationMs,
        ...(mainAnalysisFailed ? { lastErrorMessage: "主分析失败", lastErrorAt: now } : {}),
      };
      db.prepare("UPDATE analyses SET data = ?, nodes = ?, report = ? WHERE id = ?")
        .run(JSON.stringify(finalRecord), JSON.stringify(nodes), JSON.stringify(report), analysisId);
      db.prepare(
        "INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      ).run(updatedProject.id, JSON.stringify(updatedProject), Date.now());
    } catch (persistError) {
      log.warn("clipiq", "main 端 SQLite 持久化失败,JSON 会兜底:", persistError);
      await appendPersistErrorLog(project.id, "analyzeProject finalize", persistError);
    }
    if (!mainAnalysisFailed) analysisOutcome = "ok";
    log.info("analyze", `[analysis:${analysisId}] 分析完成, 耗时 ${formatDuration(Date.now() - analysisStartedAt)}, outcome=${analysisOutcome}`);
    return { analysisId, project: updatedProject, nodes, report };
  } catch (err) {
    analysisFailureMsg = String(err?.message || err).slice(0, 300);
    log.info("analyze", `[analysis:${analysisId}] 分析异常: ${analysisFailureMsg}`);
    if (err && typeof err === "object") err._analysisId = analysisId;
    throw err;
  } finally {
    const currentHandle = activeAnalyses.get(project.id);
    const takenOver = currentHandle && currentHandle !== handle;
    log.info("analyze:lifecycle", `[analysis:${analysisId}] finally: outcome=${analysisOutcome} cancelled=${handle.cancelled} takenOverByNew=${takenOver} newAnalysisId=${takenOver ? currentHandle.analysisId : "n/a"} elapsed=${formatDuration(Date.now() - analysisStartedAt)}`);
    if (handle.cancelled) {
      analysisOutcome = "cancelled";
      try {
        const db = getDb();
        const now = new Date().toISOString();
        const cancelledRecord = { ...analysisRecord, status: "failed", completedAt: now, lastErrorMessage: "用户取消了分析。", lastErrorAt: now };
        db.prepare("UPDATE analyses SET data = ? WHERE id = ?").run(JSON.stringify(cancelledRecord), analysisId);
      } catch { /* best-effort */ }
    }
    try {
      closeCurrentStage();
      await appendEtaSample({
        project,
        analysisStartedAt,
        outcome: analysisOutcome,
        failureMsg: analysisFailureMsg,
        timings,
        providers: { complexVision: complexVisionProvider, mediumText: mediumTextProvider, audio: audioProvider },
      });
      // 只有 ok 样本才参与学习 (失败 / 取消的 timing 偏短); 学习器自己也会过滤
      if (analysisOutcome === "ok") {
        try {
          learnedBaselines = await etaLearner.updateAndSave(app.getPath("userData"));
          const count = Object.keys(learnedBaselines.providers || {}).length;
          if (count > 0) log.info("eta-learner", `baseline 更新, 当前 ${count} 个 provider`);
        } catch (learnErr) {
          log.warn("eta-learner", "学习失败:", learnErr?.message || learnErr);
        }
      }
    } catch (sampleErr) {
      log.warn("eta-samples", "写埋点失败:", sampleErr?.message || sampleErr);
    }
    clearAnalysis(project.id, handle);
  }
}

// ETA 埋点 jsonl 落盘 helper - 每次 analyzeProject 结束 append 一行 (ok/failed/cancelled 都写)
async function appendEtaSample({ project, analysisStartedAt, outcome, failureMsg, timings, providers }) {
  let machine;
  try {
    const daemonClient = require("./daemon-client.cjs");
    machine = await daemonClient.getHardware();
  } catch {
    machine = {
      platform: process.platform, arch: process.arch,
      cpuModel: os.cpus()?.[0]?.model || "unknown", backend: "cpu",
      totalMemoryBytes: os.totalmem(), availableMemoryBytes: os.totalmem() - 6 * 1024 ** 3,
    };
  }
  const summarizeProvider = (p) => p ? {
    id: p.id,
    name: p.name,
    model: p.model,
    endpointType: p.endpointType,
    contextSize: p.contextSize,
    maxOutputTokens: p.maxOutputTokens,
    source: p.source,
  } : null;
  const sample = {
    schemaVersion: 1,
    projectId: project.id,
    startedAt: new Date(analysisStartedAt).toISOString(),
    totalDurationMs: Date.now() - analysisStartedAt,
    outcome,
    ...(failureMsg ? { failureMsg } : {}),
    machine: {
      platform: machine.platform,
      arch: machine.arch,
      cpuModel: machine.cpuModel,
      backend: machine.backend,
      totalMemoryGB: Math.round(machine.totalMemoryBytes / (1024 ** 3) * 10) / 10,
      availableMemoryGB: Math.round(machine.availableMemoryBytes / (1024 ** 3) * 10) / 10,
    },
    project: {
      platform: project.source?.platform || (project.source?.type === "url" ? "url" : "local"),
      sourceType: project.source?.type,
    },
    providers: {
      complexVision: summarizeProvider(providers.complexVision),
      mediumText: summarizeProvider(providers.mediumText),
      audio: summarizeProvider(providers.audio),
    },
    stages: timings,
  };
  const filePath = path.join(app.getPath("userData"), "eta-samples.jsonl");
  await fs.appendFile(filePath, JSON.stringify(sample) + "\n");
}

function formatTime(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 进度消息里"耗时/平均/已等待"的统一格式化:
// - 小于 1s → "950ms" (毫秒, 用于很快的批次)
// - 小于 60s → "23.6s" (一位小数, 跟现有 (ms/1000).toFixed(1) 风格一致)
// - 大于等于 60s → "3分05秒" (中文 m分ss秒, 比 m:ss 更易读)
function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const totalSec = Math.round(n / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
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

// 系统栏托盘 + 真退出标志。
// 关闭主窗口默认 = 隐藏到托盘,仅 isQuitting=true 时才真销毁;Cmd+Q / 托盘"退出"会设此标志。
let trayInstance = null;
let isQuitting = false;
let mainWindowRef = null;

function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try {
      wc.send(channel, payload);
    } catch {
      // 渲染端正在销毁,忽略
    }
  }
}

function showMainWindow() {
  const win = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    createWindow();
    if (process.platform === "darwin" && app.dock?.show) app.dock.show();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  if (process.platform === "darwin" && app.dock?.show) app.dock.show();
  rebuildTrayMenu();
}

function toggleMainWindow() {
  const win = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  if (win && win.isVisible() && !win.isMinimized()) {
    win.hide();
    rebuildTrayMenu();
  } else {
    showMainWindow();
  }
}

function rebuildTrayMenu() {
  if (!trayInstance || trayInstance.isDestroyed?.()) return;
  const win = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  const visible = !!(win && win.isVisible() && !win.isMinimized());
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? "隐藏主窗口" : "显示主窗口",
      click: () => toggleMainWindow(),
    },
    { type: "separator" },
    {
      label: "退出 ClipIQ",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  trayInstance.setContextMenu(menu);
}

function createTray() {
  if (trayInstance) return;
  // macOS 用模板图像(纯黑 + 镂空 alpha),系统按 menubar 主题反色,自动加载 @2x。
  // 其他平台沿用彩色 app 图标。
  if (process.platform === "darwin") {
    const tplPath = path.join(__dirname, "assets", "tray-iconTemplate.png");
    const tplImg = nativeImage.createFromPath(tplPath);
    if (tplImg.isEmpty()) {
      log.warn("tray", "tray-iconTemplate.png 不可用,跳过托盘创建");
      return;
    }
    tplImg.setTemplateImage(true);
    trayInstance = new Tray(tplImg);
  } else {
    const sourcePath = path.join(__dirname, "assets", "icon-256.png");
    let trayImg = nativeImage.createFromPath(sourcePath);
    if (trayImg.isEmpty()) {
      log.warn("tray", "icon-256.png 不可用,跳过托盘创建");
      return;
    }
    trayImg = trayImg.resize({ width: 16, height: 16, quality: "best" });
    trayInstance = new Tray(trayImg);
  }
  trayInstance.setToolTip("ClipIQ");
  trayInstance.on("click", () => toggleMainWindow());
  rebuildTrayMenu();
}

// "后台" 判定: 没有任何窗口处于聚焦+可见+未最小化状态。
// 覆盖: macOS Cmd+H 隐藏 / minimize / 切到别的 app / 单显示器另一桌面 / 关窗后隐藏到托盘。
function isAppInBackground() {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0) return true;
  return !wins.some((w) => w.isFocused() && w.isVisible() && !w.isMinimized());
}

// 仅当应用不在前台时弹系统通知。点击通知把主窗口拉到前台。
// macOS 首次需要在系统设置中允许通知;Notification.isSupported 返回 false 时静默。
function notifyIfBackground({ title, body, urgency } = {}) {
  if (!isAppInBackground()) return;
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: title || "ClipIQ",
      body: body || "",
      silent: false,
      urgency: urgency || "normal",
    });
    n.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      if (process.platform === "darwin" && app.dock?.show) app.dock.show();
    });
    n.show();
  } catch (err) {
    log.warn("notify", "通知失败:", err?.message || err);
  }
}

async function createWindow() {
  const icon = getAppIcon();
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "ClipIQ · 看懂每一帧的逻辑",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0F172A",
    icon: icon || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindowRef = mainWindow;

  // 关窗 = 隐藏到托盘,真退出走 isQuitting 标志(托盘"退出"或 Cmd+Q before-quit 会设)。
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (process.platform === "darwin" && app.dock?.hide) app.dock.hide();
      rebuildTrayMenu();
    }
  });

  mainWindow.on("show", rebuildTrayMenu);
  mainWindow.on("hide", rebuildTrayMenu);
  mainWindow.on("minimize", rebuildTrayMenu);
  mainWindow.on("restore", rebuildTrayMenu);

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
    rebuildTrayMenu();
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
  log.init(app.getPath("userData"));

  // macOS Dock 图标
  if (process.platform === "darwin" && app.dock) {
    const icon = getAppIcon();
    if (icon) app.dock.setIcon(icon);
  }
  app.setName("ClipIQ");

  // 加载已学习的云端模型 TPS baseline (没文件就是空 baselines, 一切走 hardcoded fallback)
  try {
    learnedBaselines = await etaLearner.loadBaselines(app.getPath("userData"));
    const count = Object.keys(learnedBaselines.providers || {}).length;
    if (count > 0) log.info("eta-learner", `加载 ${count} 个 provider baseline`);
  } catch (err) {
    log.warn("eta-learner", "加载 baseline 失败:", err?.message || err);
  }

  // 生产环境注入严格 CSP — dev 下 Vite HMR 需要 unsafe-eval,跳过。
  // packaged app 加载 file:// 的 dist/index.html,React 已编译为静态 JS,不需要 eval。
  if (app.isPackaged) {
    const csp = [
      "default-src 'self'",
      "img-src 'self' data: blob: media:",
      "media-src 'self' blob: media:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self' data:",
      "connect-src 'self' https:",
    ].join("; ");
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });
  }

  try {
    await initializeCacheStore();
  } catch (err) {
    log.warn("cache-store", "初始化失败:", err?.message || err);
  }

  // 本地 llama 接线: ctx override 解析 + openai-client 自动 acquire/release。
  // 业务方零改动: 任何 provider.source === "local_llama" 的请求都会被 manager 调度。
  llamaRuntime.setContextResolver(async (modelKey) => {
    try {
      const cfg = (await readJson(getConfigPath(), null)) || {};
      const override = cfg?.localModelOverrides?.[modelKey]?.contextSize;
      return Number(override) > 0 ? Number(override) : null;
    } catch {
      return null;
    }
  });
  openaiClient.setLocalProviderAdapter((modelKey, opts) =>
    llamaManager.acquire(modelKey, opts),
  );

  try {
    await extensionBridge.start(app.getPath("userData"));
    extensionBridge.onStatusChange((s) => {
      // 广播给所有 renderer 窗口
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send("extensionBridge:status", s); } catch { /* noop */ }
      }
    });
    log.info("extension-bridge", "已启动 ws://127.0.0.1:58713/agent");
  } catch (err) {
    log.warn("extension-bridge", "启动失败:", err?.message || err);
  }

  protocol.handle("media", async (request) => {
    const url = new URL(request.url);
    let filePath;
    if (url.host === "project") {
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length < 2) return new Response("Bad project URL", { status: 400 });
      const projectId = decodeURIComponent(segs[0]);
      const rel = segs.slice(1).map(decodeURIComponent).join(path.sep);
      filePath = path.join(getProjectDir(projectId), rel);
    } else if (url.host === "external") {
      filePath = decodeURIComponent(url.pathname.slice(1));
    } else {
      return new Response(`Unknown media host: ${url.host}`, { status: 400 });
    }
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    const size = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MEDIA_MIME_TYPES[ext] || "application/octet-stream";
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (Number.isNaN(start) || start > end || start >= size) {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        }
        const stream = fsSync.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
            "Content-Type": contentType,
          },
        });
      }
    }
    const fullStream = fsSync.createReadStream(filePath);
    return new Response(Readable.toWeb(fullStream), {
      status: 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(size),
        "Content-Type": contentType,
      },
    });
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

  ipcMain.handle("extensionBridge:getStatus", async () => {
    return extensionBridge.getStatus();
  });

  ipcMain.handle("extensionBridge:rotateToken", async () => {
    return { token: extensionBridge.rotateToken() };
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
      db.exec("DELETE FROM analyses; DELETE FROM projects;");
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipcMain.handle("cache:getStats", async () => {
    try {
      return cacheStore.stats();
    } catch (err) {
      return {
        totalEntries: 0,
        totalBytes: 0,
        maxBytes: 0,
        cacheDir: null,
        byScope: {},
        error: err?.message || String(err),
      };
    }
  });

  ipcMain.handle("cache:list", async (_event, params) => {
    try {
      return cacheStore.list(params || {});
    } catch {
      return [];
    }
  });

  ipcMain.handle("cache:clear", async (_event, params) => {
    try {
      return await cacheStore.clear(params || {});
    } catch (err) {
      return { freedBytes: 0, freedEntries: 0, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("cache:setMaxBytes", async (_event, bytes) => {
    const next = Math.max(0, Math.floor(Number(bytes) || 0));
    const cur = await readJson(getConfigPath(), null);
    if (cur) {
      await writeJson(getConfigPath(), { ...cur, cacheMaxBytes: next, savedAt: new Date().toISOString() });
    }
    cacheStore.configure({
      dir: cacheStore.getCacheDir() || getDefaultCacheDir(),
      maxBytes: next,
    });
    return { ok: true, maxBytes: next };
  });

  ipcMain.handle("cache:setDir", async (_event, rawDir) => {
    const dir = typeof rawDir === "string" && rawDir.trim() ? rawDir.trim() : null;
    if (!dir) return { ok: false, message: "目录路径为空" };
    try {
      const result = await cacheStore.migrate(dir);
      const cur = await readJson(getConfigPath(), null);
      if (cur) {
        await writeJson(getConfigPath(), { ...cur, cacheDir: cacheStore.getCacheDir(), savedAt: new Date().toISOString() });
      }
      return { ok: true, cacheDir: cacheStore.getCacheDir(), mode: result.mode };
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  });

  ipcMain.handle("cache:browseDir", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择缓存目录",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: cacheStore.getCacheDir() || getDefaultCacheDir(),
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    return { canceled: false, dir: result.filePaths[0] };
  });

  ipcMain.handle("cache:openDir", async () => {
    const target = cacheStore.getCacheDir() || getDefaultCacheDir();
    await fs.mkdir(target, { recursive: true });
    await shell.openPath(target);
    return { ok: true, path: target };
  });

  ipcMain.handle("cache:getPolicy", async () => {
    const cfg = await readJson(getConfigPath(), null);
    return cfg?.cachePolicy || { enabled: true, stages: {} };
  });

  ipcMain.handle("cache:setPolicy", async (_event, policy) => {
    const cur = await readJson(getConfigPath(), null) || {};
    cur.cachePolicy = policy;
    cur.savedAt = new Date().toISOString();
    await writeJson(getConfigPath(), cur);
    return { ok: true };
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

  // 系统资源采样。
  //
  // 内存口径: macOS 上 os.freemem() 只算 Pages free,完全忽略 Inactive/Cached/Compressed,
  // 长期接近 0,1-free/total 会长期吊 100% 而无意义。这里在 darwin 上改走 vm_stat,
  // 对齐活动监视器的 "Memory Used" = App(Anonymous - Purgeable) + Wired + Compressed,
  // 再用 sysctl vm.swapusage 拿 swap, 综合启发出 normal/warn/critical 压力档位。
  // 其他平台 fallback 回 Node os 原口径。
  let lastCpuSample = null;
  ipcMain.handle("system:getStats", async () => {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const [type, value] of Object.entries(cpu.times)) {
        total += value;
        if (type === "idle") idle += value;
      }
    }
    let cpuPercent = 0;
    if (lastCpuSample) {
      const idleDiff = idle - lastCpuSample.idle;
      const totalDiff = total - lastCpuSample.total;
      if (totalDiff > 0) {
        cpuPercent = Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
      }
    }
    lastCpuSample = { idle, total };

    const totalMem = os.totalmem();
    let memoryUsedBytes;
    let memoryCompressedBytes;
    let swapUsedBytes;
    let memoryPressure = "normal";

    if (process.platform === "darwin") {
      const mac = await sampleDarwinMemory(totalMem);
      if (mac) {
        memoryUsedBytes = mac.usedBytes;
        memoryCompressedBytes = mac.compressedBytes;
        swapUsedBytes = mac.swapUsedBytes;
        memoryPressure = mac.pressure;
      } else {
        memoryUsedBytes = Math.max(0, totalMem - os.freemem());
      }
    } else {
      memoryUsedBytes = Math.max(0, totalMem - os.freemem());
      const ratio = totalMem > 0 ? memoryUsedBytes / totalMem : 0;
      if (ratio >= 0.92) memoryPressure = "critical";
      else if (ratio >= 0.8) memoryPressure = "warn";
    }

    const memoryPercent = totalMem > 0
      ? Math.max(0, Math.min(100, Math.round((memoryUsedBytes / totalMem) * 100)))
      : 0;

    return {
      cpuPercent,
      cpuCount: cpus.length,
      memoryPercent,
      memoryUsedBytes,
      memoryTotalBytes: totalMem,
      memoryPressure,
      memoryCompressedBytes,
      swapUsedBytes,
      platform: process.platform,
    };
  });

  // 进程占用列表: electron 自身所有进程 (Browser/Renderer/GPU/Utility) + sidecar (llama/whisper)。
  // electron 部分用 app.getAppMetrics() —— chromium 内置, percentCPUUsage 是上次调用以来的均值。
  // sidecar 部分跑 ps 一次性快照拿 RSS 和 pcpu。
  ipcMain.handle("system:listProcesses", async () => {
    const metrics = app.getAppMetrics();
    // macOS: 内存全部走 top phys_footprint (Activity Monitor 同口径), 不再用
    //   workingSetSize ≈ ps rss (含共享内存重复算).
    //   实测 10 个并行 spawn top 合计 ~8ms, 不影响 1.5s 轮询.
    // 其他平台: workingSetSize 保留.
    const isMac = process.platform === "darwin";
    const electronProcs = await Promise.all(
      metrics.map(async (m) => {
        let memoryBytes = (m.memory?.workingSetSize || 0) * 1024;
        if (isMac) {
          const corrected = await sampleTopMemByPid(m.pid);
          if (corrected != null) memoryBytes = corrected;
        }
        return {
          pid: m.pid,
          kind: mapElectronProcKind(m.type),
          label: electronProcLabel(m),
          detail: electronProcDetail(m),
          cpuPercent: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10,
          memoryBytes,
        };
      }),
    );

    // ps 失败说明 PID 已死/runtime 还没清理掉,跳过避免显示 0/0 假条目
    const sidecars = [];
    const llamaPid = llamaRuntime.getRuntimePid?.();
    if (llamaPid) {
      const stats = await samplePsByPid(llamaPid);
      if (stats) {
        sidecars.push({
          pid: llamaPid,
          kind: "sidecar",
          label: "llama-server",
          detail: llamaRuntime.getStatus?.()?.modelKey || undefined,
          cpuPercent: stats.cpuPercent,
          memoryBytes: stats.memoryBytes,
        });
      }
    }
    const whisperPid = whisperCppRuntime.getRuntimePid?.();
    if (whisperPid) {
      const stats = await samplePsByPid(whisperPid);
      if (stats) {
        sidecars.push({
          pid: whisperPid,
          kind: "sidecar",
          label: "whisper-server",
          detail: whisperCppRuntime.getStatus?.()?.modelKey || undefined,
          cpuPercent: stats.cpuPercent,
          memoryBytes: stats.memoryBytes,
        });
      }
    }

    return [...electronProcs, ...sidecars];
  });

  ipcMain.handle("ytdlp:checkUpdate", async () => {
    return checkYtDlpUpdate();
  });

  ipcMain.handle("ytdlp:install", async (event) => {
    const result = await downloadYtDlp((stage, message) => {
      event.sender.send("ytdlp:progress", { stage, message });
    });
    event.sender.send("ytdlp:update-status", {
      installed: true,
      installedVersion: result.installedVersion,
      isBundled: true,
      latestVersion: result.latestVersion,
      updateAvailable: false,
    });
    return result;
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

  ipcMain.handle("config:getField", async (_event, key) => {
    const cfg = await readJson(getConfigPath(), null);
    return cfg?.[key] ?? null;
  });

  ipcMain.handle("config:setField", async (_event, key, value) => {
    const cfg = (await readJson(getConfigPath(), null)) || {};
    cfg[key] = value;
    await writeJson(getConfigPath(), { ...cfg, savedAt: new Date().toISOString() });
    return { ok: true };
  });

  ipcMain.handle("config:save", async (_event, config) => {
    // 落盘前再过一次 migrate,保证 builtin 永远存在 + schema 永远是 v2
    // 合并磁盘上的 lastLlamaModelKey / localModelOverrides 等 renderer 可能不持有的字段,
    // 避免单字段更新打回时把别的字段抹掉。
    const cur = await readJson(getConfigPath(), null);
    const merged = {
      ...cur,
      ...config,
      lastLlamaModelKey: config?.lastLlamaModelKey ?? cur?.lastLlamaModelKey ?? null,
      localModelOverrides: config?.localModelOverrides ?? cur?.localModelOverrides ?? {},
    };
    const migrated = migrateConfigV1ToV2(merged);
    await writeJson(getConfigPath(), { ...migrated, savedAt: new Date().toISOString() });
    // maxBytes 改了就同步 cache-store; cacheDir 走专门的 cache:setDir IPC, 这里不动
    try {
      const { maxBytes } = resolveCacheConfig(migrated);
      if (cacheStore.isConfigured() && maxBytes !== cacheStore.getMaxBytes()) {
        cacheStore.configure({ dir: cacheStore.getCacheDir(), maxBytes });
      }
    } catch (err) {
      log.warn("cache-store", "同步 maxBytes 失败:", err?.message || err);
    }
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
    cancelAnalysis(projectId);
    clearAnalysis(projectId);
    const db = getDb();
    db.prepare("DELETE FROM analyses WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    try {
      await fs.rm(getProjectDir(projectId), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return { ok: true };
  });

  // --- analyses (1:N per project) ---

  ipcMain.handle("analyses:list", async (_event, projectId) => {
    const db = getDb();
    const rows = db.prepare("SELECT data FROM analyses WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
    return rows.map((row) => JSON.parse(row.data));
  });

  ipcMain.handle("analyses:get", async (_event, analysisId) => {
    const db = getDb();
    const row = db.prepare("SELECT data, nodes, report FROM analyses WHERE id = ?").get(analysisId);
    if (!row) return null;
    const record = JSON.parse(row.data);
    const nodes = row.nodes ? JSON.parse(row.nodes) : [];
    const report = row.report ? JSON.parse(row.report) : null;
    return { record, nodes, report };
  });

  ipcMain.handle("analyses:delete", async (_event, analysisId) => {
    const db = getDb();
    const row = db.prepare("SELECT data FROM analyses WHERE id = ?").get(analysisId);
    if (row) {
      const record = JSON.parse(row.data);
      db.prepare("DELETE FROM analyses WHERE id = ?").run(analysisId);
      try {
        await fs.rm(getAnalysisDir(record.projectId, analysisId), { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    return { ok: true };
  });

  ipcMain.handle("nodes:get", async (_event, analysisId) => {
    const db = getDb();
    const row = db.prepare("SELECT nodes FROM analyses WHERE id = ?").get(analysisId);
    if (!row || !row.nodes) return [];
    return JSON.parse(row.nodes);
  });

  ipcMain.handle("nodes:set", async (_event, analysisId, nodes) => {
    const db = getDb();
    db.prepare("UPDATE analyses SET nodes = ? WHERE id = ?")
      .run(JSON.stringify(Array.isArray(nodes) ? nodes : []), analysisId);
    return { ok: true };
  });

  ipcMain.handle("report:get", async (_event, analysisId) => {
    const db = getDb();
    const row = db.prepare("SELECT report FROM analyses WHERE id = ?").get(analysisId);
    if (!row) return null;
    return row.report ? JSON.parse(row.report) : null;
  });

  ipcMain.handle("report:set", async (_event, analysisId, report) => {
    const db = getDb();
    if (report === null || report === undefined) {
      db.prepare("UPDATE analyses SET report = NULL WHERE id = ?").run(analysisId);
    } else {
      db.prepare("UPDATE analyses SET report = ? WHERE id = ?")
        .run(JSON.stringify(report), analysisId);
    }
    return { ok: true };
  });

  // v2: accounts (对标账号)
  ipcMain.handle("accounts:list", async () => {
    const db = getDb();
    const rows = db.prepare("SELECT data FROM accounts ORDER BY updated_at DESC").all();
    return rows.map((row) => JSON.parse(row.data));
  });

  ipcMain.handle("accounts:upsert", async (_event, account) => {
    if (!account?.id) throw new Error("accounts:upsert 需要 account.id");
    const db = getDb();
    const updatedAt = account.updatedAt ? Date.parse(account.updatedAt) || Date.now() : Date.now();
    db.prepare(
      "INSERT INTO accounts (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).run(account.id, JSON.stringify(account), updatedAt);
    return { ok: true };
  });

  ipcMain.handle("accounts:delete", async (_event, accountId) => {
    if (!accountId) return { ok: false, message: "缺少 accountId" };
    const db = getDb();
    db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    return { ok: true };
  });

  // v2: studio sessions (剪辑会话)
  ipcMain.handle("sessions:list", async () => {
    const db = getDb();
    const rows = db.prepare("SELECT data FROM studio_sessions ORDER BY updated_at DESC").all();
    return rows.map((row) => JSON.parse(row.data));
  });

  ipcMain.handle("sessions:upsert", async (_event, session) => {
    if (!session?.id) throw new Error("sessions:upsert 需要 session.id");
    const db = getDb();
    const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) || Date.now() : Date.now();
    db.prepare(
      "INSERT INTO studio_sessions (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).run(session.id, JSON.stringify(session), updatedAt);
    return { ok: true };
  });

  ipcMain.handle("sessions:delete", async (_event, sessionId) => {
    if (!sessionId) return { ok: false, message: "缺少 sessionId" };
    const db = getDb();
    db.prepare("DELETE FROM studio_sessions WHERE id = ?").run(sessionId);
    return { ok: true };
  });

  // v2: 多策略拉取 UP 主账号信息 + 视频列表
  // 策略: 平台 native API (头像/粉丝/简介) ∥ yt-dlp (视频列表 + 兜底元数据)
  const fetchAccountVideosCore = async ({ url: rawInput, limit = 20, onProgress, cancelled }) => {
    if (!rawInput || typeof rawInput !== "string") throw new Error("fetchAccountVideosCore 需要 url");
    // 从分享文案中提取 URL
    const extractedUrl = extractFirstUrl(rawInput) || rawInput;
    log.info("accounts:fetch", `原始输入: ${rawInput.slice(0, 80)} → 提取URL: ${extractedUrl.slice(0, 80)}`);
    // 短链解析 (v.douyin.com → www.douyin.com/user/...)
    const url = await resolveDouyinShortUrl(extractedUrl);
    const platform = detectAccountPlatform(url);
    log.info("accounts:fetch", `解析后URL: ${url.slice(0, 120)} → 平台: ${platform}`);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
    const report = (progress, stage, message) => {
      if (cancelled && cancelled()) return;
      if (onProgress) try { onProgress({ progress, stage, message }); } catch { /* noop */ }
    };
    const checkCancelled = () => { if (cancelled && cancelled()) throw new Error("__cancelled__"); };

    let nativeCard = null;
    let nativeCardError = null;
    let nativeVideos = null;
    let nativeVideosError = null;
    let nativeMid = null;

    report(8, "解析账号", `平台 · ${platform}`);
    checkCancelled();

    if (platform === "bilibili") {
      nativeMid = parseBilibiliMid(url);
      if (nativeMid) {
        report(15, "请求 B 站接口", `card + space arc/search · mid ${nativeMid}`);
        const cardPromise = fetchBilibiliCard(nativeMid).catch((e) => {
          nativeCardError = `bilibili card: ${e?.message || String(e)}`;
          return null;
        });
        const fetchWithRetry = async () => {
          let lastErr = null;
          for (let i = 0; i < 3; i++) {
            checkCancelled();
            try { return await fetchBilibiliSpaceVideos(nativeMid, safeLimit); }
            catch (e) {
              lastErr = e;
              if (i < 2) {
                report(20 + i * 5, "B 站接口重试", `第 ${i + 2} 次, 等待 3s`);
                await new Promise((r) => setTimeout(r, 3000));
              }
            }
          }
          throw lastErr;
        };
        const videosPromise = fetchWithRetry().catch((e) => {
          nativeVideosError = `bilibili space: ${e?.message || String(e)}`;
          return null;
        });
        [nativeCard, nativeVideos] = await Promise.all([cardPromise, videosPromise]);
      } else {
        nativeCardError = "无法从 B 站 URL 解析出 mid (期望格式: space.bilibili.com/<UID>)";
      }
    }

    if (platform === "douyin") {
      const secUid = parseDouyinSecUid(url);
      log.info("accounts:fetch", `抖音 secUid=${secUid ? secUid.slice(0, 20) + "..." : "(null)"} bridgeConnected=${extensionBridge.isConnected()}`);
      if (secUid) {
        // 并行: 拉取账号资料 + 视频列表 (都走纯 API, 不需要 BrowserWindow)
        const profilePromise = fetchDouyinUserProfile(secUid).catch((e) => {
          nativeCardError = `douyin profile: ${e?.message || String(e)}`;
          log.warn("accounts:fetch", `抖音资料 API 失败: ${e?.message || e}`);
          return null;
        });

        // 优先级: 纯 API → bridge → BrowserWindow
        report(20, "请求抖音接口", "拉取视频列表");
        try {
          const result = await fetchDouyinUserPostsViaApi(secUid, safeLimit);
          if (result && result.videos.length > 0) nativeVideos = result;
          log.info("accounts:fetch", `纯 API 拉取${nativeVideos ? "成功" : "无结果"}`);
        } catch (e) {
          nativeVideosError = `douyin API: ${e?.message || String(e)}`;
          log.warn("accounts:fetch", `纯 API 失败: ${e?.message || e}`);
        }
        if (!nativeVideos && extensionBridge.isConnected()) {
          report(25, "请求抖音接口", "经 Chrome 插件桥");
          try {
            const result = await fetchDouyinUserPosts(secUid, safeLimit);
            if (result && result.videos.length > 0) nativeVideos = result;
          } catch (e) {
            const prevErr = nativeVideosError ? nativeVideosError + "; " : "";
            nativeVideosError = prevErr + `douyin bridge: ${e?.message || String(e)}`;
          }
        }
        if (!nativeVideos) {
          report(30, "请求抖音接口", "BrowserWindow 兜底");
          try {
            const result = await fetchDouyinUserPostsViaWindow(secUid, safeLimit);
            if (result && result.videos.length > 0) nativeVideos = result;
          } catch (e) {
            const prevErr = nativeVideosError ? nativeVideosError + "; " : "";
            nativeVideosError = prevErr + `douyin BrowserWindow: ${e?.message || String(e)}`;
          }
        }

        const profile = await profilePromise;
        if (profile) {
          nativeCard = {
            name: profile.nickname || null,
            face: profile.avatarUrl || null,
            sign: profile.signature || null,
            fansFormatted: profile.followerCount > 0 ? formatFollowersCount(profile.followerCount) : null,
            mid: profile.uid || null,
            archiveCount: profile.awemeCount || 0,
          };
          log.info("accounts:fetch", `抖音账号: ${profile.nickname} 粉丝=${profile.followerCount} 作品=${profile.awemeCount}`);
        }
      } else {
        nativeCardError = "无法从抖音 URL 解析出 sec_user_id (期望格式: douyin.com/user/MS4w...)";
      }
    }

    checkCancelled();
    let ytDlpParsed = null;
    let ytDlpError = null;
    const skipYtDlp =
      (platform === "bilibili" && nativeCard && nativeVideos) ||
      (platform === "douyin" && nativeVideos && nativeVideos.videos.length > 0);
    log.info("accounts:fetch", `nativeVideos=${nativeVideos ? nativeVideos.videos.length + "条" : "null"} nativeVideosError=${nativeVideosError || "无"} skipYtDlp=${skipYtDlp}`);
    if (!skipYtDlp) {
      report(45, "yt-dlp 兜底", "调 yt-dlp --flat-playlist 拉视频清单");
      try {
        ytDlpParsed = await fetchYtDlpAccountJson(url, safeLimit);
      } catch (e) {
        ytDlpError = e?.message || String(e);
      }
    }

    let videos = [];
    let totalVideoCount = 0;
    let accountTitle = null;
    let accountUploader = null;
    let accountAvatarUrl = null;
    let accountFollowers = null;
    let accountBio = null;
    let accountExternalId = null;

    if (ytDlpParsed) {
      const entries = Array.isArray(ytDlpParsed.entries) ? ytDlpParsed.entries : [];
      videos = entries.map((e) => ({
        id: String(e.id || e.video_id || ""),
        title: e.title || e.fulltitle || "(未命名视频)",
        durationSec: Math.round(Number(e.duration) || 0),
        uploadDate: e.upload_date || null,
        viewCount: Number(e.view_count) || 0,
        externalUrl: (typeof e.url === "string" && e.url.startsWith("http")
          ? e.url
          : platform === "bilibili" && e.id
          ? `https://www.bilibili.com/video/${e.id}`
          : platform === "youtube" && e.id
          ? `https://www.youtube.com/watch?v=${e.id}`
          : platform === "douyin" && e.id
          ? `https://www.douyin.com/video/${e.id}`
          : ""),
        thumbnailUrl: e.thumbnail || pickBestThumbnail(e.thumbnails),
      })).filter((v) => v.id);
      totalVideoCount = Number(ytDlpParsed.playlist_count) || videos.length;
      accountTitle = ytDlpParsed.title || null;
      accountUploader = ytDlpParsed.uploader || ytDlpParsed.channel || null;
      accountAvatarUrl = pickBestThumbnail(ytDlpParsed.thumbnails);
      if (Number(ytDlpParsed.channel_follower_count) > 0) {
        accountFollowers = formatFollowersCount(ytDlpParsed.channel_follower_count);
      }
      if (typeof ytDlpParsed.description === "string" && ytDlpParsed.description.trim()) {
        accountBio = ytDlpParsed.description.trim().slice(0, 200);
      }
      accountExternalId = ytDlpParsed.channel_id || ytDlpParsed.uploader_id || null;
    }

    if (nativeVideos && nativeVideos.videos.length > 0) {
      videos = nativeVideos.videos;
      totalVideoCount = nativeVideos.total;
    }

    if (nativeCard) {
      if (nativeCard.face) accountAvatarUrl = nativeCard.face;
      if (nativeCard.fansFormatted) accountFollowers = nativeCard.fansFormatted;
      if (nativeCard.sign) accountBio = nativeCard.sign;
      if (nativeCard.name && !accountUploader) accountUploader = nativeCard.name;
      if (nativeCard.mid) accountExternalId = nativeCard.mid;
      if (nativeCard.archiveCount && nativeCard.archiveCount > totalVideoCount) {
        totalVideoCount = nativeCard.archiveCount;
      }
    }

    // B 站: 如果走的是 yt-dlp --flat-playlist (因 wbi 接口 412), entry 只有 id 没 title/thumbnail.
    // 用 view API 并发补全 (匿名访客开放, 通常稳).
    if (platform === "bilibili" && videos.length > 0) {
      const cookie = await getBilibiliVisitorCookie().catch(() => null);
      const needFill = videos.filter((v) => v.id && (!v.title || !v.thumbnailUrl || !v.durationSec));
      if (needFill.length > 0) {
        const totalNeed = needFill.length;
        report(70, "补全 B 站元数据", `view API ×${totalNeed}`);
        const batchSize = 8;
        const byBvid = new Map();
        for (let i = 0; i < needFill.length; i += batchSize) {
          if (cancelled && cancelled()) break;
          const slice = needFill.slice(i, i + batchSize);
          const enriched = await Promise.all(slice.map((v) =>
            fetchBilibiliVideoView(v.id, cookie).catch(() => null),
          ));
          for (const e of enriched) if (e) byBvid.set(e.bvid, e);
          report(70 + Math.round(20 * Math.min(1, (i + batchSize) / Math.max(1, totalNeed))),
                 "补全 B 站元数据", `${Math.min(i + batchSize, totalNeed)} / ${totalNeed}`);
        }
        videos = videos.map((v) => {
          const e = byBvid.get(v.id);
          if (!e) return v;
          return {
            ...v,
            title: v.title || e.title || "(未命名视频)",
            durationSec: v.durationSec || e.durationSec,
            uploadDate: v.uploadDate || e.uploadDate,
            viewCount: v.viewCount || e.viewCount,
            thumbnailUrl: v.thumbnailUrl || e.thumbnailUrl,
          };
        });
      }
      // 保底 title
      videos = videos.map((v) => ({ ...v, title: v.title || "(未命名视频)" }));
    }

    const noVideos = videos.length === 0;
    const noCard = !nativeCard && !accountUploader && !accountAvatarUrl;
    if (noVideos && noCard) {
      const msgs = [];
      if (ytDlpError) msgs.push(`yt-dlp: ${ytDlpError.slice(0, 220)}`);
      if (nativeVideosError) msgs.push(nativeVideosError.slice(0, 220));
      if (nativeCardError) msgs.push(nativeCardError.slice(0, 220));
      if (msgs.length === 0) msgs.push("所有抓取通道都返回空");
      throw new Error(`账号拉取失败 [${platform}]\n${msgs.join("\n")}`);
    }

    const warnings = [];
    if (noVideos && ytDlpError) warnings.push(`视频列表抓取失败 (${ytDlpError.slice(0, 120)})`);
    if (noVideos && nativeVideosError) {
      const label = platform === "douyin" ? "抖音用户投稿接口" : "B 站投稿接口";
      warnings.push(`${label}失败 (${nativeVideosError.slice(0, 120)})`);
    }
    if (platform === "douyin" && noVideos && !extensionBridge.isConnected()) {
      warnings.push("抖音风控较严, 装上 Chrome 插件后大幅更稳 (设置 → 浏览器插件桥)");
    }

    report(90, "整理元数据", `视频 ${videos.length} 条`);

    return {
      ok: true,
      accountTitle,
      accountUploader,
      accountAvatarUrl,
      accountFollowers,
      accountBio,
      accountExternalId,
      accountPlatform: platform,
      totalVideoCount,
      videos,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  };

  // 旧入口 (内部 still 兼容; renderer 已迁到 accounts:startFetch)
  ipcMain.handle("accounts:fetchVideos", async (_event, { url, limit = 20 } = {}) => {
    return fetchAccountVideosCore({ url, limit });
  });

  // ── 账号下挂的视频 (account_videos 表) ──
  ipcMain.handle("accountVideos:list", async (_event, accountId) => {
    if (!accountId) return [];
    const db = getDb();
    const rows = db.prepare(
      "SELECT data FROM account_videos WHERE account_id = ? ORDER BY added_at DESC"
    ).all(accountId);
    return rows.map((r) => JSON.parse(r.data));
  });

  ipcMain.handle("accountVideos:upsert", async (_event, video) => {
    if (!video?.id || !video?.accountId) throw new Error("accountVideos:upsert 需要 id + accountId");
    const db = getDb();
    const addedAt = video.addedAt ? Date.parse(video.addedAt) || Date.now() : Date.now();
    db.prepare(
      "INSERT INTO account_videos (id, account_id, data, added_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, added_at = excluded.added_at"
    ).run(video.id, video.accountId, JSON.stringify(video), addedAt);
    return { ok: true };
  });

  ipcMain.handle("accountVideos:delete", async (_event, videoId) => {
    if (!videoId) return { ok: true };
    const db = getDb();
    db.prepare("DELETE FROM account_videos WHERE id = ?").run(videoId);
    return { ok: true };
  });

  // ── 后台拉取驱动 ──
  // in-flight: accountId → { url, range, stage, progress, message, cancelled, startedAt }
  if (!global.__accountFetchInFlight) global.__accountFetchInFlight = new Map();
  const accountFetchInFlight = global.__accountFetchInFlight;

  const limitOfRange = (range) => (range === "top10" ? 10 : range === "recent20" ? 20 : 80);

  const runAccountFetch = async ({ accountId, url, range }) => {
    const state = { url, range, stage: "排队", progress: 0, message: "", cancelled: false, startedAt: Date.now() };
    accountFetchInFlight.set(accountId, state);
    const broadcast = (channel, payload) => broadcastToWindows(channel, payload);
    const sendProgress = (p, stage, message) => {
      state.stage = stage;
      state.progress = p;
      state.message = message || "";
      broadcast("account:fetch:progress", { accountId, stage, progress: p, message });
    };
    sendProgress(0, "排队", "");
    try {
      const result = await fetchAccountVideosCore({
        url,
        limit: limitOfRange(range),
        onProgress: ({ progress, stage, message }) => sendProgress(progress, stage, message),
        cancelled: () => state.cancelled,
      });
      sendProgress(95, "落库", `${result.videos.length} 条视频`);

      // 把视频写入 account_videos 表 (按 externalUrl/externalId 去重)
      // 先清理: 该账号下没被分析过的旧 av 行删除, 已分析过的保留 (analysisProjectId 链回报告)
      // 这样接口变更 / 范围切换不会留下"上次拉到但这次没拉到"的尸位
      const db = getDb();
      try {
        const oldRows = db.prepare("SELECT id, data FROM account_videos WHERE account_id = ?").all(accountId);
        const stmtDel = db.prepare("DELETE FROM account_videos WHERE id = ?");
        for (const row of oldRows) {
          try {
            const old = JSON.parse(row.data);
            if (!old?.analysisProjectId) stmtDel.run(row.id);
          } catch { stmtDel.run(row.id); }
        }
      } catch (e) {
        log.warn("accounts:fetch", "清理旧 av 失败:", e?.message || e);
      }
      const existsStmt = db.prepare("SELECT id FROM account_videos WHERE id = ?");
      const insertStmt = db.prepare(
        "INSERT INTO account_videos (id, account_id, data, added_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data"
      );
      const now = Date.now();
      const platform = result.accountPlatform;
      const newAccountVideos = [];
      for (const v of result.videos) {
        const avId = `av-${accountId}-${v.id}`;
        const av = {
          id: avId,
          accountId,
          externalId: v.id,
          externalUrl: v.externalUrl,
          title: v.title,
          durationSec: v.durationSec,
          thumbnailUrl: v.thumbnailUrl || undefined,
          uploadDate: v.uploadDate || null,
          viewCount: v.viewCount || 0,
          likeCount: v.likeCount || undefined,
          commentCount: v.commentCount || undefined,
          shareCount: v.shareCount || undefined,
          collectCount: v.collectCount || undefined,
          playUrl: v.playUrl || undefined,
          platform,
          addedAt: new Date(now).toISOString(),
        };
        // 保留已有 analysisProjectId + 摘要数据
        const existing = existsStmt.get(avId);
        if (existing) {
          const oldRow = db.prepare("SELECT data FROM account_videos WHERE id = ?").get(avId);
          if (oldRow) {
            try {
              const old = JSON.parse(oldRow.data);
              if (old.analysisProjectId) av.analysisProjectId = old.analysisProjectId;
              if (old.videoSummary) av.videoSummary = old.videoSummary;
              if (old.summaryStatus) av.summaryStatus = old.summaryStatus;
              if (old.localVideoPath) av.localVideoPath = old.localVideoPath;
              av.addedAt = old.addedAt || av.addedAt;
            } catch { /* noop */ }
          }
        }
        insertStmt.run(avId, accountId, JSON.stringify(av), Date.parse(av.addedAt) || now);
        newAccountVideos.push(av);
      }

      // 更新 Account 元数据
      const accRow = db.prepare("SELECT data FROM accounts WHERE id = ?").get(accountId);
      let accountPatch = {};
      if (accRow) {
        try {
          const acc = JSON.parse(accRow.data);
          const patched = {
            ...acc,
            name: acc.name || result.accountUploader || result.accountTitle || acc.name,
            avatarUrl: result.accountAvatarUrl || acc.avatarUrl,
            followers: result.accountFollowers || acc.followers,
            bio: result.accountBio || acc.bio,
            externalId: result.accountExternalId || acc.externalId,
            platform: result.accountPlatform || acc.platform,
            totalVideoCount: result.totalVideoCount || acc.totalVideoCount,
            fetchPhase: "ready",
            fetchError: undefined,
            lastFetchedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          accountPatch = patched;
          db.prepare(
            "INSERT INTO accounts (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
          ).run(accountId, JSON.stringify(patched), Date.now());
        } catch (e) {
          log.warn("accounts:fetch", "update Account 失败", e?.message || e);
        }
      }

      sendProgress(100, "完成", `${newAccountVideos.length} 条视频`);
      broadcast("account:fetch:done", {
        accountId,
        videos: newAccountVideos,
        account: accountPatch,
        warnings: result.warnings,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      const isCancel = msg === "__cancelled__" || state.cancelled;
      const finalMsg = isCancel ? "已取消" : msg;
      // 写 fetchPhase=failed 到 Account
      try {
        const db = getDb();
        const accRow = db.prepare("SELECT data FROM accounts WHERE id = ?").get(accountId);
        if (accRow) {
          const acc = JSON.parse(accRow.data);
          const patched = {
            ...acc,
            fetchPhase: isCancel ? "idle" : "failed",
            fetchError: isCancel ? undefined : finalMsg,
            updatedAt: new Date().toISOString(),
          };
          db.prepare(
            "INSERT INTO accounts (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
          ).run(accountId, JSON.stringify(patched), Date.now());
        }
      } catch { /* noop */ }
      broadcast("account:fetch:failed", { accountId, error: finalMsg });
    } finally {
      accountFetchInFlight.delete(accountId);
    }
  };

  ipcMain.handle("accounts:startFetch", async (_event, { accountId, url, range = "top10" } = {}) => {
    if (!accountId) throw new Error("accounts:startFetch 需要 accountId");
    if (!url) throw new Error("accounts:startFetch 需要 url");
    if (accountFetchInFlight.has(accountId)) {
      return { ok: true, accepted: false, reason: "already in flight" };
    }
    // 把 Account.fetchPhase 立即标 fetching
    try {
      const db = getDb();
      const accRow = db.prepare("SELECT data FROM accounts WHERE id = ?").get(accountId);
      if (accRow) {
        const acc = JSON.parse(accRow.data);
        const patched = { ...acc, fetchPhase: "fetching", fetchError: undefined, updatedAt: new Date().toISOString() };
        db.prepare(
          "INSERT INTO accounts (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
        ).run(accountId, JSON.stringify(patched), Date.now());
      }
    } catch { /* noop */ }
    // fire-and-forget
    runAccountFetch({ accountId, url, range }).catch((err) => {
      log.warn("accounts:startFetch", "runAccountFetch unhandled", err?.message || err);
    });
    return { ok: true, accepted: true };
  });

  ipcMain.handle("accounts:cancelFetch", async (_event, accountId) => {
    const state = accountFetchInFlight.get(accountId);
    if (!state) return { ok: true, cancelled: false };
    state.cancelled = true;
    return { ok: true, cancelled: true };
  });

  ipcMain.handle("accounts:listFetchInFlight", async () => {
    const out = [];
    for (const [accountId, state] of accountFetchInFlight) {
      out.push({ accountId, stage: state.stage, progress: state.progress, message: state.message });
    }
    return out;
  });

  // ── 轻量视频摘要管线 ──
  if (!global.__summaryInFlight) global.__summaryInFlight = new Map();
  const summaryInFlight = global.__summaryInFlight;

  async function summarizeAccountVideo(accountVideoId) {
    log.info("summary", `开始摘要 accountVideoId=${accountVideoId}`);
    const db = getDb();
    const row = db.prepare("SELECT data FROM account_videos WHERE id = ?").get(accountVideoId);
    if (!row) throw new Error("视频不存在");
    const av = JSON.parse(row.data);
    log.info("summary", `视频: ${av.title?.slice(0, 40)} url=${av.externalUrl?.slice(0, 60)}`);

    const state = { cancelled: false, startedAt: Date.now() };
    summaryInFlight.set(accountVideoId, state);

    const sendStatus = (status, extra) => {
      broadcastToWindows("account:video:summary:status", { accountVideoId, status, ...extra });
    };
    const updateAv = (patch) => {
      Object.assign(av, patch);
      db.prepare("UPDATE account_videos SET data = ? WHERE id = ?")
        .run(JSON.stringify(av), accountVideoId);
    };

    updateAv({ summaryStatus: "summarizing", summaryError: undefined });
    sendStatus("summarizing", { progress: 0 });

    try {
      const checkCancel = () => { if (state.cancelled) throw new Error("__cancelled__"); };
      const handle = { get cancelled() { return state.cancelled; }, abortController: new AbortController(), children: new Set() };

      // 1) 下载视频
      sendStatus("summarizing", { progress: 5, message: "下载视频" });
      const artifactDir = path.join(app.getPath("userData"), "accounts", av.accountId, "videos", av.externalId);
      await fs.mkdir(artifactDir, { recursive: true });

      let videoPath = av.localVideoPath;
      log.info("summary", `本地路径=${videoPath || "(无)"} 存在=${videoPath ? fsSync.existsSync(videoPath) : false}`);
      if (!videoPath || !fsSync.existsSync(videoPath)) {
        log.info("summary", "需要下载视频");
        try {
          const dl = await performUrlDownloadFlow(av.externalUrl, {
            projectId: `summary-${accountVideoId}`,
            mediaDir: artifactDir,
            handle,
            onProgress: (p, s, m) => sendStatus("summarizing", { progress: 5 + Math.round(p * 0.2), message: m || s }),
          });
          videoPath = dl.filePath;
        } catch (dlErr) {
          log.warn("summary", `yt-dlp 下载失败: ${dlErr?.message || dlErr}, 尝试 play_url 直连`);
          // fallback: 用 play_url 直连下载 (参考 douyin-crawler-demo)
          if (av.playUrl) {
            sendStatus("summarizing", { progress: 10, message: "直连下载" });
            const filePath = path.join(artifactDir, `${av.externalId || "video"}.mp4`);
            const partPath = filePath + ".part";
            const res = await fetch(av.playUrl, {
              headers: {
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
                referer: "https://www.douyin.com/",
                range: "bytes=0-",
              },
            });
            if (!res.ok) throw new Error(`直连下载失败: HTTP ${res.status}`);
            const { createWriteStream } = require("node:fs");
            const { pipeline } = require("node:stream/promises");
            const { Readable } = require("node:stream");
            await pipeline(Readable.fromWeb(res.body), createWriteStream(partPath));
            await fs.rename(partPath, filePath);
            videoPath = filePath;
            log.info("summary", `play_url 直连下载完成: ${filePath}`);
          } else {
            throw dlErr;
          }
        }
      }
      checkCancel();

      // 2) 读取视频信息
      log.info("summary", `视频下载完成: ${videoPath}`);
      sendStatus("summarizing", { progress: 28, message: "读取视频信息" });
      const ffmpegPath = await commandPath("ffmpeg");
      log.info("summary", `ffmpeg=${ffmpegPath || "(未安装)"}`);
      const inspected = await inspectVideo(videoPath);
      log.info("summary", `视频: ${inspected.durationSec}s ${inspected.width}x${inspected.height} hasAudio=${inspected.hasAudio}`);
      checkCancel();

      // 3) 检测镜头切换
      sendStatus("summarizing", { progress: 32, message: "检测镜头" });
      let scenes = [];
      if (ffmpegPath) {
        scenes = await detectScenes(ffmpegPath, videoPath, 0.3, handle);
      }
      checkCancel();

      // 4) 抽取关键画面 (8-12 帧)
      sendStatus("summarizing", { progress: 38, message: "抽取关键画面" });
      const targetCount = Math.min(12, Math.max(6, scenes.length || 6));
      const plan = planFramePlan(scenes, inspected.durationSec, targetCount);
      const framesDir = path.join(artifactDir, "frames");
      await fs.mkdir(framesDir, { recursive: true });
      const { frames } = await buildFrames(ffmpegPath, videoPath, plan, framesDir, handle,
        (i, total) => sendStatus("summarizing", { progress: 38 + Math.round((i / total) * 12), message: `抽帧 ${i + 1}/${total}` }),
      );
      checkCancel();

      // 5) 识别字幕
      sendStatus("summarizing", { progress: 52, message: "识别字幕" });
      let transcript = null;
      if (inspected.hasAudio) {
        const cfg = migrateConfigV1ToV2(await readJson(getConfigPath(), null));
        const audioProvider = resolveAudioProvider(cfg);
        if (audioProvider) {
          const wavPath = path.join(artifactDir, "audio.wav");
          await extractAudioWav(ffmpegPath, videoPath, wavPath, handle);
          checkCancel();
          transcript = await transcribeAudio(audioProvider, wavPath, handle,
            (p) => sendStatus("summarizing", { progress: 52 + Math.round(18 * (p?.progress || 0)), message: "识别字幕" }),
          );
        }
      }
      checkCancel();

      log.info("summary", `抽帧完成: ${frames.length} 帧, 字幕: ${transcript ? transcript.text?.length + "字" : "无"}`);

      // 6) LLM 生成摘要
      sendStatus("summarizing", { progress: 75, message: "生成摘要" });
      const cfg = migrateConfigV1ToV2(await readJson(getConfigPath(), null));
      const visionProvider = resolveSlotProvider(cfg, "complex_vision");
      const textProvider = resolveSlotProvider(cfg, "medium_text");

      const transcriptText = transcript?.text || transcript?.segments?.map((s) => s.text).join(" ") || "";
      log.info("summary", `visionProvider=${visionProvider?.id || "(null)"} textProvider=${textProvider?.id || "(null)"}`);
      let summaryText;

      if (visionProvider?.baseUrl && visionProvider?.apiKeyRef && visionProvider?.model) {
        log.info("summary", `使用视觉路径: ${visionProvider.id} model=${visionProvider.model}`);
        // 视觉路径: 发帧图片 + 字幕
        const imageDataUrls = [];
        for (const f of frames.slice(0, 10)) {
          try {
            const buf = await fs.readFile(f.framePath);
            imageDataUrls.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
          } catch { /* skip broken frames */ }
        }
        checkCancel();
        const transcriptPart = transcriptText ? `\n\n字幕全文:\n${transcriptText.slice(0, 3000)}` : "\n\n(该视频无字幕)";
        const result = await callOpenAIChatCompletions(
          visionProvider,
          "你是视频内容分析师。基于关键帧画面和字幕,用 200-400 字中文描述这个视频讲了什么内容,包括主题、风格和亮点。直接输出描述文本,不要 JSON 包裹,不要 Markdown 格式。",
          `视频标题: ${av.title}\n时长: ${inspected.durationSec} 秒${transcriptPart}`,
          imageDataUrls,
          { abortController: new AbortController() },
        );
        summaryText = result?.raw || result?.parsed;
      } else if (textProvider?.baseUrl && textProvider?.apiKeyRef && textProvider?.model) {
        log.info("summary", `使用纯文本路径: ${textProvider.id} model=${textProvider.model}`);
        const frameDesc = frames.map((f) => `${(f.midSec || 0).toFixed(1)}s`).join(", ");
        const result = await openaiClient.callJsonCompletion(textProvider, {
          systemText:
            "你是视频内容分析师。基于字幕和关键帧时间戳,用 200-400 字中文描述视频讲了什么内容。" +
            "返回 JSON: {\"summary\": \"...\"}。不要 Markdown 围栏。",
          userText: `标题: ${av.title}\n时长: ${inspected.durationSec}s\n关键帧时刻: ${frameDesc}\n字幕: ${transcriptText.slice(0, 3000) || "(无字幕)"}`,
          temperature: 0.4,
        });
        summaryText = result?.parsed?.summary || result?.raw;
      } else {
        throw new Error("未配置视觉或文本模型,无法生成摘要。请在设置 → 任务分配中配置。");
      }

      if (typeof summaryText !== "string") summaryText = JSON.stringify(summaryText);
      summaryText = summaryText.trim();
      log.info("summary", `摘要生成完成, 长度=${summaryText.length}字`);

      // 7) 落库
      updateAv({
        videoSummary: summaryText,
        summaryStatus: "done",
        summaryError: undefined,
        localVideoPath: videoPath,
      });
      sendStatus("done", { summary: summaryText, progress: 100 });
      return { ok: true, summary: summaryText };

    } catch (err) {
      const msg = err?.message || String(err);
      const isCancel = msg === "__cancelled__" || state.cancelled;
      updateAv({
        summaryStatus: isCancel ? "idle" : "failed",
        summaryError: isCancel ? undefined : msg,
      });
      sendStatus(isCancel ? "idle" : "failed", { error: isCancel ? undefined : msg });
      if (!isCancel) throw err;
    } finally {
      summaryInFlight.delete(accountVideoId);
    }
  }

  ipcMain.handle("accounts:summarizeVideo", async (_event, { accountVideoId } = {}) => {
    if (!accountVideoId) throw new Error("accounts:summarizeVideo 需要 accountVideoId");
    if (summaryInFlight.has(accountVideoId)) {
      return { ok: true, accepted: false, reason: "already in flight" };
    }
    summarizeAccountVideo(accountVideoId).catch((err) => {
      log.warn("accounts:summarizeVideo", "unhandled", err?.message || err);
    });
    return { ok: true, accepted: true };
  });

  ipcMain.handle("accounts:cancelSummarize", async (_event, accountVideoId) => {
    const state = summaryInFlight.get(accountVideoId);
    if (!state) return { ok: true, cancelled: false };
    state.cancelled = true;
    return { ok: true, cancelled: true };
  });

  // v2: 跨视频 methodology LLM 汇总
  // 输入: { accountId, videoSummaries: [{title, summary, structure, pacing, editingStyle, composition}] }
  // 输出: AccountMethodology
  ipcMain.handle("accounts:generateMethodology", async (_event, { accountName, videoSummaries } = {}) => {
    const provider = await loadComplexTextProvider();
    if (!provider?.apiKeyRef || !provider?.baseUrl || !provider?.model) {
      throw new Error("未配置 complex_text 任务槽位的 LLM 供应商");
    }
    if (!Array.isArray(videoSummaries) || videoSummaries.length === 0) {
      throw new Error("methodology 汇总至少需要 1 条已分析视频");
    }
    const lines = [`# 账号: ${accountName || "未知"}`, `# 已分析视频数: ${videoSummaries.length}`, ""];
    videoSummaries.slice(0, 12).forEach((v, i) => {
      lines.push(`## 视频 ${i + 1} · ${v.title || "未命名"}`);
      if (v.summary) lines.push(`摘要: ${String(v.summary).slice(0, 400)}`);
      if (v.structure) lines.push(`结构: ${typeof v.structure === "string" ? v.structure.slice(0, 200) : JSON.stringify(v.structure).slice(0, 300)}`);
      if (v.pacing) lines.push(`节奏: ${String(v.pacing).slice(0, 200)}`);
      if (v.editingStyle) lines.push(`剪辑: ${String(v.editingStyle).slice(0, 200)}`);
      if (v.composition) lines.push(`构图: ${String(v.composition).slice(0, 200)}`);
      lines.push("");
    });
    lines.push("请汇总该账号的视频方法论,输出 JSON:");
    lines.push('{"hooks":{"summary":"开场风格画像 (1-2 句)","sampleVideoIds":[]},');
    lines.push(' "pacing":{"summary":"节奏画像 (1-2 句)","sampleVideoIds":[]},');
    lines.push(' "structure":{"summary":"结构模板 (1-2 句)","sampleVideoIds":[]},');
    lines.push(' "visual":{"summary":"视觉风格 (1-2 句)","sampleVideoIds":[]}}');
    try {
      const result = await openaiClient.callJsonCompletion(provider, {
        systemText:
          "你是视频方法论分析师。给定一位 UP 主的若干视频分析摘要,请跨视频汇总出可复用的方法论 manifest。\n" +
          "规则:\n" +
          "- 4 个维度都要给(hooks/pacing/structure/visual),每个维度 summary 1-2 句中文,具体可操作\n" +
          "- sampleVideoIds 留空数组即可\n" +
          "- 直接返回 JSON,不要 markdown 围栏,不要思考过程",
        userText: lines.join("\n"),
        temperature: 0.4,
        // max_tokens 走 openai-client deriveDefaultMaxTokens (ctx 派生)
      });
      const parsed = result.parsed;
      const methodology = {
        hooks: parsed?.hooks?.summary ? { summary: String(parsed.hooks.summary), sampleVideoIds: [] } : undefined,
        pacing: parsed?.pacing?.summary ? { summary: String(parsed.pacing.summary), sampleVideoIds: [] } : undefined,
        structure: parsed?.structure?.summary ? { summary: String(parsed.structure.summary), sampleVideoIds: [] } : undefined,
        visual: parsed?.visual?.summary ? { summary: String(parsed.visual.summary), sampleVideoIds: [] } : undefined,
        generatedAt: new Date().toISOString(),
      };
      return { ok: true, methodology };
    } catch (err) {
      throw new Error(`methodology LLM 失败: ${err?.message || String(err)}`);
    }
  });

  // v2: Studio steps LLM 生成
  // 输入: { goal, targetDurationSec, methodologies: [{name, summary}], assets: [{name, durationSec, shotCount}] }
  // 输出: StudioStep[]
  ipcMain.handle("sessions:generateSteps", async (_event, { goal, targetDurationSec, methodologies, assets } = {}) => {
    const provider = await loadComplexTextProvider();
    if (!provider?.apiKeyRef || !provider?.baseUrl || !provider?.model) {
      throw new Error("未配置 complex_text 任务槽位的 LLM 供应商");
    }
    if (!goal || !String(goal).trim()) throw new Error("缺少剪辑目标");
    const totalSec = Number(targetDurationSec) || 600;
    const lines = [];
    lines.push(`# 剪辑目标`); lines.push(String(goal).trim()); lines.push("");
    lines.push(`# 目标时长 (秒): ${totalSec}`); lines.push("");
    if (Array.isArray(methodologies) && methodologies.length > 0) {
      lines.push("# 应用的对标账号方法论");
      methodologies.forEach((m) => lines.push(`- ${m.name}: ${m.summary || "(无摘要)"}`));
      lines.push("");
    }
    if (Array.isArray(assets) && assets.length > 0) {
      lines.push("# 可用素材池");
      assets.forEach((a, i) => lines.push(`- 素材 ${i + 1}: ${a.name} · ${a.durationSec || 0}s · ${a.shotCount || 0} 个镜头`));
      lines.push("");
    }
    lines.push("请输出 JSON,steps 数组按时间顺序排列,总时长加起来等于目标时长:");
    lines.push('{"steps":[{"index":1,"label":"开场钩子 · 0:00-0:30","startSec":0,"endSec":30,"body":"具体剪辑指令","shotRefs":[{"assetIndex":0,"rangeStart":0,"rangeEnd":30,"note":"素材1·主播半身"}],"missing":"如果缺关键镜头描述,否则省略"}]}');
    try {
      const result = await openaiClient.callJsonCompletion(provider, {
        systemText:
          "你是视频剪辑师助理。基于剪辑目标 + 对标账号方法论 + 可用素材池,给出叙事骨架 (4-7 段)。\n" +
          "规则:\n" +
          "- 每段 label 形如 '开场钩子 · 0:00-0:30',包含名字 + 时间范围\n" +
          "- startSec/endSec 必填,所有段时间连续不重叠,合计=目标时长\n" +
          "- body 是给剪辑师的具体指令 (1-2 句),引用方法论时直接说要点\n" +
          "- shotRefs 用 assetIndex 引用素材池序号(从 0 开始),note 形如 '素材1 · 主播半身 0:00-0:08'\n" +
          "- 没有可用素材时 shotRefs=[],并在 missing 里描述需要补什么镜头\n" +
          "- 直接返回 JSON,不要 markdown 围栏,不要思考过程",
        userText: lines.join("\n"),
        temperature: 0.5,
        // max_tokens 走 openai-client deriveDefaultMaxTokens (ctx 派生)
      });
      const parsed = result.parsed;
      const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const steps = rawSteps.map((s, i) => ({
        index: Number(s.index) || i + 1,
        label: String(s.label || `段 ${i + 1}`),
        startSec: Math.round(Number(s.startSec) || 0),
        endSec: Math.round(Number(s.endSec) || 0),
        body: String(s.body || ""),
        shotRefs: Array.isArray(s.shotRefs) ? s.shotRefs.map((r) => {
          const idx = Number(r.assetIndex);
          const asset = Array.isArray(assets) && Number.isInteger(idx) ? assets[idx] : null;
          return {
            assetProjectId: asset?.id || "",
            rangeStart: Math.round(Number(r.rangeStart) || 0),
            rangeEnd: Math.round(Number(r.rangeEnd) || 0),
            note: String(r.note || (asset?.name ? `${asset.name}` : "")),
          };
        }) : [],
        missing: s.missing ? String(s.missing) : undefined,
      }));
      return { ok: true, steps };
    } catch (err) {
      throw new Error(`Studio steps LLM 失败: ${err?.message || String(err)}`);
    }
  });

  // v2: 素材自动分镜 (复用 ffprobe + ffmpeg scenedetect,不需要 LLM)
  // 输入: { assetProjectId, filePath, durationSec }
  // 输出: Shot[] 写入 shots 表
  ipcMain.handle("assets:analyzeShots", async (_event, { assetProjectId, filePath, durationSec } = {}) => {
    if (!assetProjectId || !filePath) throw new Error("assets:analyzeShots 需要 assetProjectId + filePath");
    const ffmpeg = await commandPath("ffmpeg");
    if (!ffmpeg) throw new Error("未找到 ffmpeg");
    // 用 ffmpeg scenedetect filter 输出场景切换帧时间戳
    const total = Math.max(1, Number(durationSec) || 0);
    let boundaries = [];
    try {
      const { stderr } = await new Promise((resolve) => {
        execFile(ffmpeg, [
          "-i", filePath,
          "-filter:v", "select='gt(scene,0.3)',showinfo",
          "-f", "null", "-",
        ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ stderr: stderr?.toString() || "" });
        });
      });
      const re = /pts_time:([\d.]+)/g;
      let m;
      while ((m = re.exec(stderr)) !== null) {
        const t = Number(m[1]);
        if (Number.isFinite(t) && t > 0.5) boundaries.push(t);
      }
    } catch {
      boundaries = [];
    }
    // 没拿到场景切换 / 太少 → fallback 按 8 秒等分
    if (boundaries.length === 0 || total / Math.max(boundaries.length, 1) > 20) {
      const segSec = 8;
      const n = Math.max(1, Math.min(20, Math.ceil(total / segSec)));
      boundaries = Array.from({ length: n - 1 }, (_, i) => (i + 1) * (total / n));
    }
    const cuts = [0, ...boundaries.filter((t) => t < total - 0.5), total];
    const shots = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const startSec = Math.round(cuts[i] * 10) / 10;
      const endSec = Math.round(cuts[i + 1] * 10) / 10;
      const dur = endSec - startSec;
      const shotType = dur < 2 ? "close" : dur < 6 ? "medium" : "wide";
      shots.push({
        id: `${assetProjectId}-shot-${i + 1}`,
        assetProjectId,
        shotIndex: i + 1,
        startSec,
        endSec,
        description: `镜头 ${i + 1} · ${formatTime(startSec)}-${formatTime(endSec)} · ${dur.toFixed(1)}s`,
        shotType,
        usageTags: i === 0 ? ["开场"] : i === cuts.length - 2 ? ["收束"] : ["B-roll"],
        createdAt: new Date().toISOString(),
      });
    }
    // 落库
    const db = getDb();
    const tx = db.prepare("DELETE FROM shots WHERE asset_project_id = ?");
    const ins = db.prepare("INSERT INTO shots (id, asset_project_id, shot_index, data) VALUES (?, ?, ?, ?)");
    tx.run(assetProjectId);
    for (const s of shots) {
      ins.run(s.id, assetProjectId, s.shotIndex, JSON.stringify(s));
    }
    return { ok: true, shots };
  });

  function formatTime(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }


  // v2: shots (素材分镜索引)
  ipcMain.handle("shots:list", async (_event, assetProjectId) => {
    const db = getDb();
    const rows = assetProjectId
      ? db.prepare("SELECT data FROM shots WHERE asset_project_id = ? ORDER BY shot_index").all(assetProjectId)
      : db.prepare("SELECT data FROM shots ORDER BY asset_project_id, shot_index").all();
    return rows.map((row) => JSON.parse(row.data));
  });

  ipcMain.handle("shots:setForAsset", async (_event, assetProjectId, shots) => {
    if (!assetProjectId) throw new Error("shots:setForAsset 需要 assetProjectId");
    const db = getDb();
    const tx = db.prepare("DELETE FROM shots WHERE asset_project_id = ?");
    const ins = db.prepare("INSERT INTO shots (id, asset_project_id, shot_index, data) VALUES (?, ?, ?, ?)");
    tx.run(assetProjectId);
    for (const s of Array.isArray(shots) ? shots : []) {
      if (!s?.id) continue;
      ins.run(s.id, assetProjectId, Number(s.shotIndex) || 0, JSON.stringify(s));
    }
    return { ok: true };
  });

  ipcMain.handle("analysis:start", async (event, args) => {
    const projectName = args?.project?.videoName || args?.project?.title || "视频";
    const projectId = args?.project?.id;
    try {
      const result = await analyzeProject(event, args);
      notifyIfBackground({
        title: "ClipIQ · 分析完成",
        body: `「${projectName}」分析已完成,可以查看报告了`,
      });
      return result;
    } catch (err) {
      // 用户主动取消不弹通知,失败才弹
      if (!(err instanceof AnalysisCancelledError)) {
        const msg = String(err?.message || err).slice(0, 200);
        const handle = activeAnalyses.get(projectId);
        // 如果当前 handle 已经是一个新分析(重试触发的),不要用新的 analysisId 广播旧分析的失败
        const failedAnalysisId = err?._analysisId || handle?.analysisId;
        if (handle && !handle.cancelled && handle.analysisId !== failedAnalysisId) {
          log.warn("analyze:lifecycle", `analysis:start catch: 旧分析失败但新分析已在跑, 跳过失败广播 failedId=${failedAnalysisId} currentId=${handle.analysisId}`);
        } else if (projectId) {
          broadcastToWindows("analysis:progress", {
            projectId,
            analysisId: failedAnalysisId,
            progress: 0,
            stage: "失败",
            message: msg,
          });
        }
        notifyIfBackground({
          title: "ClipIQ · 分析失败",
          body: `「${projectName}」: ${msg.slice(0, 140)}`,
          urgency: "critical",
        });
      } else {
        log.info("analyze:lifecycle", `analysis:start catch: AnalysisCancelledError project=${projectId}`);
      }
      throw err;
    }
  });

  ipcMain.handle("analysis:cancel", async (_event, projectId) => {
    return { cancelled: cancelAnalysis(projectId) };
  });

  ipcMain.handle("analysis:isActive", async (_event, projectId) => {
    const handle = activeAnalyses.get(projectId);
    return handle != null && !handle.cancelled;
  });

  ipcMain.handle("analysis:getLastProgress", async (_event, projectId) => {
    const handle = activeAnalyses.get(projectId);
    return handle?.lastProgress || null;
  });

  ipcMain.handle("analysis:getLastBudget", async (_event, projectId) => {
    const handle = activeAnalyses.get(projectId);
    return handle?.budget || null;
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
        const rawList = Array.isArray(data?.data) ? data.data : [];
        const descriptors = rawList
          .map((entry) => remoteEntryToDescriptor(entry))
          .filter(Boolean);
        return {
          ok: true,
          message: descriptors.length > 0
            ? `连接成功，发现 ${descriptors.length} 个可用模型。`
            : "连接成功。",
          models: descriptors,
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

  // ---- URL 拉取共用底座 ------------------------------------------------
  // 解析 yt-dlp stdout 里的进度行,形如 "[download]  35.4% of 12.34MiB at  500KiB/s ETA 00:10"
  function parseYtDlpProgressLine(line) {
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    return m ? parseFloat(m[1]) : null;
  }

  // spawn yt-dlp + 解析进度,handle 用来支持 cancelAnalysis 的 SIGTERM kill。
  // onProgress(pct 0-100, line) 在每条新的百分比行触发。
  function runYtDlpWithProgress(ytDlpBin, args, handle, onProgress) {
    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpBin, args, { windowsHide: true });
      if (handle) handle.children.add(child);
      let stderr = "";
      let lastPct = -1;
      const consume = (chunk) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n|\r/)) {
          if (!line) continue;
          const pct = parseYtDlpProgressLine(line);
          if (pct != null && Math.abs(pct - lastPct) >= 0.5) {
            lastPct = pct;
            try { onProgress?.(pct, line.trim()); } catch { /* swallow */ }
          }
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); consume(chunk); });
      child.on("error", (err) => {
        if (handle) handle.children.delete(child);
        reject(err);
      });
      child.on("close", (code) => {
        if (handle) handle.children.delete(child);
        if (handle?.cancelled) return reject(new AnalysisCancelledError());
        if (code === 0) return resolve();
        const err = new Error(stderr.slice(-2000).trim() || `yt-dlp 退出码 ${code}`);
        err.stderr = stderr;
        reject(err);
      });
    });
  }

  // URL 拉取核心流程:解析 URL → 查 cache → (cache 命中走快路径 / miss 跑 yt-dlp) →
  // 读 info.json → inspectVideo → 生成项目标题 → 写 cache。返回 DownloadedVideo。
  // onProgress(pct 0-100, stage, message) 在每个里程碑触发,sync 路径传 null 即可。
  async function performUrlDownloadFlow(rawInput, { projectId, mediaDir, handle, onProgress }) {
    const ytDlp = await commandPath("yt-dlp");
    if (!ytDlp) {
      throw new Error("未找到 yt-dlp，无法通过链接拉取视频。请先安装 yt-dlp，或改用本地视频。");
    }

    const urlMatch = String(rawInput || "").match(/https?:\/\/[^\s'"<>，。、）]+/);
    const url = urlMatch ? urlMatch[0].replace(/[.,;)]+$/, "") : "";
    if (!url) {
      throw new Error("未从输入中识别到视频链接,请确认粘贴的内容里包含 http(s):// 开头的链接。");
    }

    onProgress?.(2, "下载视频", "解析链接");

    const cache = await readUrlCache();
    const cached = cache[url];
    if (cached?.filePath) {
      try {
        await fs.access(cached.filePath);
        onProgress?.(85, "下载视频", "已有本地文件，跳过下载。");
        const inspected = await inspectVideo(cached.filePath);
        let title = cached.title;
        if (!title) {
          let ytdlpInfo = cached.ytdlpInfo || null;
          if (!ytdlpInfo) {
            const infoJsonPath = cached.filePath.replace(/\.[^.]+$/, ".info.json");
            try {
              const infoRaw = await fs.readFile(infoJsonPath, "utf8");
              const j = JSON.parse(infoRaw);
              ytdlpInfo = {
                title: j.title || j.fulltitle,
                description: j.description,
                uploader: j.uploader || j.channel || j.creator,
              };
            } catch { /* 老缓存没有 info.json */ }
          }
          onProgress?.(92, "下载视频", "生成标题");
          const mp = await loadMediumTextProvider();
          const titleResult = await generateProjectTitle(mp, { rawInput, url, ytdlpInfo });
          title = titleResult?.title || null;
          if (title) {
            cache[url] = { ...cached, title, ytdlpInfo: ytdlpInfo || cached.ytdlpInfo };
            await writeUrlCache(cache);
          }
        }
        return {
          projectId: projectId || `proj-url-${Date.now()}`,
          platform: inferPlatform(url),
          ...inspected,
          title: title || null,
          fromCache: true,
        };
      } catch {
        delete cache[url];
        await writeUrlCache(cache);
      }
    }

    const useProjectId = projectId || `proj-url-${Date.now()}`;
    const useMediaDir = mediaDir || path.join(app.getPath("userData"), "projects", useProjectId, "media");
    await fs.mkdir(useMediaDir, { recursive: true });

    const outputPattern = path.join(useMediaDir, "%(extractor)s_%(id)s.%(ext)s");
    const ffmpegForYtdlp = bundledFfmpegPath();
    const ytdlpArgs = [
      "--no-playlist",
      "--restrict-filenames",
      "--write-info-json",
      "--newline",
      "--progress",
      ...(ffmpegForYtdlp ? ["--ffmpeg-location", path.dirname(ffmpegForYtdlp)] : []),
      "-o", outputPattern,
      url,
    ];

    onProgress?.(5, "下载视频", "启动 yt-dlp");
    try {
      // 有 onProgress 走 streaming spawn(解析百分比);没有则用旧的一次性 run(更轻)。
      if (onProgress) {
        await runYtDlpWithProgress(ytDlp, ytdlpArgs, handle, (pct, line) => {
          // yt-dlp 0-100 映射到 5-85,留 15% 给 inspect / 生成标题 / cache 写入。
          const mapped = Math.min(85, Math.max(5, Math.round(5 + pct * 0.8)));
          onProgress(mapped, "下载视频", line.slice(0, 160));
        });
      } else {
        await run(ytDlp, ytdlpArgs, {}, handle);
      }
    } catch (error) {
      if (error instanceof AnalysisCancelledError) throw error;
      const detail = String(error.stderr || error.stdout || error.message || error).trim();
      throw new Error(detail || "yt-dlp 下载失败");
    }

    onProgress?.(88, "下载视频", "扫描产物");
    const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".flv", ".avi"]);
    const files = await fs.readdir(useMediaDir);
    const candidates = await Promise.all(
      files
        .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
        .map(async (file) => {
          const filePath = path.join(useMediaDir, file);
          const stat = await fs.stat(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        })
    );
    const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!latest) throw new Error("yt-dlp 执行完成，但没有生成视频文件。");

    let ytdlpInfo = null;
    const infoJsonPath = latest.filePath.replace(/\.[^.]+$/, ".info.json");
    try {
      const infoRaw = await fs.readFile(infoJsonPath, "utf8");
      const j = JSON.parse(infoRaw);
      ytdlpInfo = {
        title: j.title || j.fulltitle,
        description: j.description,
        uploader: j.uploader || j.channel || j.creator,
        uploadDate: j.upload_date,
        duration: j.duration,
      };
    } catch { /* info.json 缺失 */ }

    onProgress?.(92, "下载视频", "读取视频信息");
    const inspected = await inspectVideo(latest.filePath);
    onProgress?.(96, "下载视频", "生成标题");
    const mp = await loadMediumTextProvider();
    const titleResult = await generateProjectTitle(mp, { rawInput, url, ytdlpInfo });
    const title = titleResult?.title || null;
    cache[url] = {
      filePath: latest.filePath,
      savedAt: Date.now(),
      title: title || undefined,
      ytdlpInfo: ytdlpInfo || undefined,
    };
    await writeUrlCache(cache);
    onProgress?.(100, "下载完成", "");
    return {
      projectId: useProjectId,
      platform: inferPlatform(url),
      ...inspected,
      title: title || null,
      fromCache: false,
    };
  }

  // 阻塞版本:整段 await 完才返回 DownloadedVideo。AccountScreen 仍在用。
  ipcMain.handle("video:downloadUrl", async (_event, rawInput) => {
    return performUrlDownloadFlow(rawInput, {
      projectId: null,
      mediaDir: null,
      handle: null,
      onProgress: null,
    });
  });

  // 异步版本:同步 return { projectId, url, platform },下载在后台进行,
  // 进度通过 analysis:progress 广播,完成 / 失败通过 download:complete 广播。
  ipcMain.handle("video:downloadUrlAsync", async (_event, rawInput) => {
    const urlMatch = String(rawInput || "").match(/https?:\/\/[^\s'"<>，。、）]+/);
    const url = urlMatch ? urlMatch[0].replace(/[.,;)]+$/, "") : "";
    if (!url) {
      throw new Error("未从输入中识别到视频链接,请确认粘贴的内容里包含 http(s):// 开头的链接。");
    }
    const ytDlp = await commandPath("yt-dlp");
    if (!ytDlp) {
      throw new Error("未找到 yt-dlp，无法通过链接拉取视频。请先安装 yt-dlp，或改用本地视频。");
    }

    const projectId = `proj-url-${Date.now()}`;
    const mediaDir = path.join(app.getPath("userData"), "projects", projectId, "media");
    await fs.mkdir(mediaDir, { recursive: true });

    const handle = registerAnalysis(projectId);
    const emitProgress = (progress, stage, message) => {
      if (handle.cancelled) return;
      // 下载进度 0-100 映射到整体管线的 0-2%，与分析起始进度(2%)衔接
      const scaled = Math.min(2, Math.round(progress * 0.02));
      const payload = { projectId, progress: scaled, stage, message: message || "", stageIndex: 0 };
      handle.lastProgress = payload;
      handle.lastProgressAt = Date.now();
      broadcastToWindows("analysis:progress", payload);
    };

    emitProgress(0, "下载视频", "排队中");

    // 后台跑,不 await
    (async () => {
      try {
        const video = await performUrlDownloadFlow(rawInput, {
          projectId,
          mediaDir,
          handle,
          onProgress: emitProgress,
        });
        broadcastToWindows("download:complete", { projectId, success: true, video });
      } catch (err) {
        if (err instanceof AnalysisCancelledError) {
          broadcastToWindows("download:complete", { projectId, success: false, cancelled: true, error: "已取消" });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          emitProgress(0, "失败", msg);
          broadcastToWindows("download:complete", { projectId, success: false, error: msg });
        }
      } finally {
        clearAnalysis(projectId);
      }
    })();

    return { projectId, url, platform: inferPlatform(url) };
  });

  await llamaRuntime.init();
  await whisperCppRuntime.init();

  // 从 config 读 localModelOverrides[*].contextSize → { modelKey: ctx } 给 annotateManifest 用
  // 让 fit/memPercent 反映用户实际调过的 ctx 值, 不是 manifest 默认。
  async function readCtxOverrides() {
    try {
      const cfg = (await readJson(getConfigPath(), null)) || {};
      const overrides = cfg.localModelOverrides || {};
      const out = {};
      for (const [k, v] of Object.entries(overrides)) {
        const ctx = Number(v?.contextSize);
        if (ctx > 0) out[k] = ctx;
      }
      return out;
    } catch {
      return {};
    }
  }

  // listModels 与 listManifest 共用同一映射,差别只在不带 machine 字段
  ipcMain.handle("llama:listModels", async () => {
    const daemonClient = require("./daemon-client.cjs");
    const ctxOverrides = await readCtxOverrides();
    const { models } = await daemonClient.getRecommendedModels("clipiq", ctxOverrides);
    return (models || [])
      .map((dm) => localLlamaEntryToDescriptor(daemonModelToLlamaEntry(dm)))
      .filter(Boolean);
  });

  ipcMain.handle("llama:getStatus", async () => llamaRuntime.getStatus());

  // SettingsScreen ctx slider onChange 实时调:用新 ctx 重算单个 model 的 fit/memPercent/tps,
  // 返回 { fit, memPercent, tps, totalMemBytes, weightBytes, kvBytes, memCapBytes }。
  // 不持久化 — slider 改完用户点保存才会写到 config.localModelOverrides。
  ipcMain.handle("llama:recomputeFit", async (_evt, { modelKey, contextSize }) => {
    const daemonClient = require("./daemon-client.cjs");
    return daemonClient.recomputeFit(modelKey, contextSize);
  });

  // 返回 ModelDescriptor[] + 机器规格. daemon 统一算 fit + 下载状态
  ipcMain.handle("llama:listManifest", async () => {
    const daemonClient = require("./daemon-client.cjs");
    const ctxOverrides = await readCtxOverrides();
    const { machine, models } = await daemonClient.getRecommendedModels("clipiq", ctxOverrides);
    const descriptors = (models || [])
      .map((dm) => localLlamaEntryToDescriptor(daemonModelToLlamaEntry(dm)))
      .filter(Boolean);
    return { machine, models: descriptors };
  });

  ipcMain.handle("llama:ensureBinary", async (event) => {
    const path = await llamaRuntime.ensureLlamaServer((progress) => {
      event.sender.send("llama:progress", { scope: "binary", ...progress });
    });
    return { ok: true, binaryPath: path };
  });

  ipcMain.handle("llama:ensureModel", async (event, modelKey) => {
    const mirror = await getLocalModelMirror();
    return llamaRuntime.ensureModel(modelKey, (progress) => {
      event.sender.send("llama:progress", { scope: "model", modelKey, ...progress });
    }, { mirror });
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
      log.warn("clipiq", "持久化 lastLlamaModelKey 失败:", e),
    );
    return result;
  });

  ipcMain.handle("llama:stop", async () => llamaRuntime.stop());

  ipcMain.handle("llama:cancelDownload", async (_event, modelKey) => {
    const daemonClient = require("./daemon-client.cjs");
    return daemonClient.cancelDownload(modelKey);
  });

  ipcMain.handle("llama:selfTest", async (_event, payload) => {
    return llamaRuntime.selfTest(payload || {});
  });

  // whisper.cpp runtime IPC ----------------------------------------------------
  ipcMain.handle("whisperCpp:listModels", async () => {
    const raws = await whisperCppRuntime.listModels();
    return raws.map((e) => localWhisperEntryToDescriptor(e)).filter(Boolean);
  });

  ipcMain.handle("whisperCpp:getStatus", async () => whisperCppRuntime.getStatus());

  ipcMain.handle("whisperCpp:ensureModel", async (event, modelKey) => {
    const mirror = await getLocalModelMirror();
    return whisperCppRuntime.ensureModel(modelKey, (progress) => {
      event.sender.send("whisperCpp:progress", { scope: "model", modelKey, ...progress });
    }, { mirror });
  });

  ipcMain.handle("mirror:get", async () => {
    return { mirror: await getLocalModelMirror() };
  });

  ipcMain.handle("mirror:set", async (_event, value) => {
    const saved = await persistLocalModelMirror(value);
    return { ok: true, mirror: saved };
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

  ipcMain.handle("whisperCpp:cancelDownload", async (_event, modelKey) => {
    return whisperCppRuntime.cancelDownload(modelKey);
  });

  // 诊断: 读 eta-samples.jsonl, 返回历史分析执行记录 (含 timing/token/provider 信息)
  ipcMain.handle("diagnostics:getAnalysisSamples", async () => {
    const filePath = path.join(app.getPath("userData"), "eta-samples.jsonl");
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const samples = [];
      for (const line of lines) {
        try { samples.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return { ok: true, samples };
    } catch (err) {
      if (err?.code === "ENOENT") return { ok: true, samples: [] };
      return { ok: false, error: err?.message || String(err), samples: [] };
    }
  });

  // 诊断: 按 analysisId 读 token-usage.json
  ipcMain.handle("diagnostics:getTokenUsage", async (_event, analysisId) => {
    const db = getDb();
    const row = db.prepare("SELECT data FROM analyses WHERE id = ?").get(analysisId);
    if (!row) return { ok: true, data: null };
    const record = JSON.parse(row.data);
    const analysisDir = getAnalysisDir(record.projectId, analysisId);
    try {
      return { ok: true, data: await readJson(path.join(analysisDir, "token-usage.json"), null) };
    } catch {
      return { ok: true, data: null };
    }
  });

  ipcMain.handle("diagnostics:getFramesCheckpoint", async (_event, projectId) => {
    const projectDir = path.join(app.getPath("userData"), "projects", projectId);
    try {
      return { ok: true, data: await readJson(path.join(projectDir, "frames-checkpoint.json"), null) };
    } catch {
      return { ok: true, data: null };
    }
  });

  ipcMain.handle("diagnostics:getTranscript", async (_event, projectId) => {
    const projectDir = path.join(app.getPath("userData"), "projects", projectId);
    try {
      return { ok: true, data: await readJson(path.join(projectDir, "artifacts", "transcript.json"), null) };
    } catch {
      return { ok: true, data: null };
    }
  });

  ipcMain.handle("diagnostics:deleteSample", async (_event, projectId, startedAt) => {
    const filePath = path.join(app.getPath("userData"), "eta-samples.jsonl");
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const kept = [];
      let removed = 0;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.projectId === projectId && obj.startedAt === startedAt) { removed++; continue; }
        } catch { /* keep malformed lines as-is */ }
        kept.push(line);
      }
      await fs.writeFile(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "");
      return { ok: true, removed };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), removed: 0 };
    }
  });

  ipcMain.handle("diagnostics:clearAllSamples", async () => {
    const filePath = path.join(app.getPath("userData"), "eta-samples.jsonl");
    try {
      await fs.writeFile(filePath, "");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  await createWindow();
  createTray();

  scheduleYtDlpAutoCheck();
  scheduleLlamaAutoResume();

  app.on("activate", () => {
    // 关窗后是 hide 不是 destroy,所以 getAllWindows() 通常非空。
    // 点 Dock 图标(macOS)或重新打开 app 时,把已有窗口 show 回来;真的没有了再重建。
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
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

async function getLocalModelMirror() {
  const cfg = (await readJson(getConfigPath(), null)) || {};
  return cfg.localModelMirror === "modelscope" ? "modelscope" : "hf-mirror";
}

async function persistLocalModelMirror(value) {
  const next = value === "modelscope" ? "modelscope" : "hf-mirror";
  const cur = (await readJson(getConfigPath(), null)) || {};
  await writeJson(getConfigPath(), {
    ...cur,
    localModelMirror: next,
    savedAt: new Date().toISOString(),
  });
  return next;
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
        log.info("clipiq", "llama auto-resume 跳过:推理引擎未安装");
        return;
      }
      const models = await llamaRuntime.listModels();
      const target = models.find((m) => m.key === lastKey);
      if (!target) {
        log.info("clipiq", `llama auto-resume 跳过:未知模型 ${lastKey}`);
        return;
      }
      if (!target.downloaded) {
        log.info("clipiq", `llama auto-resume 跳过:模型 ${lastKey} 未下载完成`);
        return;
      }
      log.info("clipiq", `llama auto-resume: 启动 ${lastKey}`);
      await llamaRuntime.start(lastKey, {
        onLog: (entry) => {
          // 自启动期间日志只走主进程 stdout,不打扰 renderer
          if (entry.channel === "stderr" && /error|fatal/i.test(entry.line)) {
            log.warn("llama auto-resume", entry.line);
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
      log.info("clipiq", "llama auto-resume 完成");
    } catch (error) {
      log.warn("clipiq", `llama auto-resume 失败: ${error?.message || error}`);
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

// 所有可能的退出路径都收敛到这个清理函数:
// 1) Electron 自己 app.quit() / Cmd+Q → before-quit
// 2) 终端 Ctrl+C / kill 主进程 → SIGINT / SIGTERM / SIGHUP (concurrently -k 用 SIGTERM)
// 3) Node 主循环退出 → exit
// 同一个 cleanup 可以被多次调用, shutdownSync 内部已经判 state.process 是否存在, 幂等。
let _cleanedUp = false;
function cleanupSidecars(reason) {
  if (_cleanedUp) return;
  _cleanedUp = true;
  try { log.info("clipiq", `cleanupSidecars: ${reason}`); } catch {}
  try { llamaRuntime.shutdownSync(); } catch {}
  try { whisperCppRuntime.shutdownSync(); } catch {}
}
app.on("before-quit", () => {
  isQuitting = true;
  cleanupSidecars("before-quit");
});
process.on("exit", () => cleanupSidecars("process.exit"));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanupSidecars(sig);
    // 重新发信号给自己, 让 Node 默认行为接管退出 (避免吞掉信号导致 hang)
    // app.quit() 不可靠: 在 dev 模式下被 concurrently -k 时 electron 已经处于半死状态
    setTimeout(() => process.exit(0), 100);
  });
}

// 关窗后默认 hide 而非 destroy,所以 window-all-closed 通常不会触发。
// 仅在窗口真销毁后才进入这里;此时如果用户已经走"退出"路径(isQuitting=true),交给 app.quit() 流转。
// 否则保留 app 进程在托盘里(包括非 darwin 平台,行为也按"驻留托盘"对齐)。
app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});
