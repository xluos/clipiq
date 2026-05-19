const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, protocol, session, shell } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Readable } = require("node:stream");
const llamaRuntime = require("./llama-runtime.cjs");
const whisperCppRuntime = require("./whisper-cpp-runtime.cjs");
const prefilter = require("./prefilter.cjs");
const shotMerger = require("./shot-merger.cjs");
const summarizer = require("./summarizer.cjs");
const danmakuFetcher = require("./danmaku-fetcher.cjs");
const danmakuEmotion = require("./danmaku-emotion.cjs");
const danmakuWordcloud = require("./danmaku-wordcloud.cjs");
const openaiClient = require("./openai-client.cjs");
const cacheStore = require("./cache-store.cjs");
const extensionBridge = require("./extension-bridge.cjs");
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
  mainAnalysis: "v1",
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

// 包一个"输入 → output"的纯函数 LLM 调用为 cache-aware 版本。
// scope/key 由 main.cjs 各调用点构造, run 是命中失败时实际跑的副作用函数。
async function runWithCache(scope, key, run, meta = {}) {
  if (!cacheStore.isConfigured() || !key) return run();
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

// 给 prefilter.tagFrames 用的逐帧 cache injector
function makePrefilterCache(modelKey) {
  if (!cacheStore.isConfigured()) return null;
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
  if (!cacheStore.isConfigured() || !provider?.model) return null;
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
  if (!cacheStore.isConfigured() || !provider?.model) return null;
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
    console.warn("[migration] account_video → account_videos 失败:", e?.message || e);
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
    console.warn("[boot] reset fetching → idle 失败:", e?.message || e);
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

// 远程 model id → capabilities 推断,规则表与辅助函数都在 model-detection-rules.cjs.
// 规则集对齐 cherry-studio main 分支 config/models/{vision,reasoning,embedding}.ts,
// 覆盖 GPT-4/5 / Claude 3-4 / Gemini 1.5-3 / Qwen-VL / GLM / Doubao / Kimi 等主流家族.
const { inferCapabilitiesFromRemoteId } = require("./model-detection-rules.cjs");

// 把远程 /models 里的一条原始 entry map 成 ModelDescriptor
function remoteEntryToDescriptor(entry) {
  const id = String(entry?.id || "").trim();
  if (!id) return null;
  return {
    source: "remote",
    id,
    label: id,
    family: id.split(/[-_/]/)[0] || undefined,
    capabilities: inferCapabilitiesFromRemoteId(id),
    capabilitiesSource: "inferred",
    availability: { state: "ready" },
    ownedBy: entry?.owned_by || undefined,
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
function buildBuiltinLocalLlamaProvider() {
  const llamaRuntime = require("./llama-runtime.cjs");
  const models = Object.values(llamaRuntime.MODELS)
    .filter((meta) => meta._manifest && meta._manifest.available !== false)
    .map((meta) => {
      const descriptor = localLlamaEntryToDescriptor(meta._manifest);
      if (!descriptor) return null;
      return {
        id: descriptor.id,
        label: descriptor.label,
        capabilities: descriptor.capabilities,
        capabilitiesSource: descriptor.capabilitiesSource,
        family: descriptor.family,
        contextSize: descriptor.contextSize,
        localKey: descriptor.id,
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
    defaultAnalysis: cfg.defaultAnalysis || null,
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

// 用 medium_text 模型生成项目标题。接受三种证据源, 至少一个有内容才会调 LLM:
//   - rawInput:   用户粘贴的整段分享文案 (URL 拉取场景)
//   - ytdlpInfo:  yt-dlp --write-info-json 拿到的平台 metadata (title/description/uploader)
//   - summary:    分析阶段产出的 globalSummary (本地视频场景, 没有外部文案时的兜底)
// 失败 / 信息都缺 / provider 未配置 都返回 null, 让调用方 fallback。
async function generateProjectTitle(provider, sources = {}) {
  if (!provider?.apiKeyRef || !provider?.baseUrl || !provider?.model) return null;
  const { rawInput, url, ytdlpInfo, summary } = sources;
  // 各 source 的总信息量, 太少就别浪费 LLM call
  const rawTextOnly = String(rawInput || "").replace(url || "", "").trim();
  const haveYtdlp = !!(ytdlpInfo && (ytdlpInfo.title || ytdlpInfo.description));
  const haveSummary = !!(summary && summary.length >= 10);
  if (rawTextOnly.length < 5 && !haveYtdlp && !haveSummary) return null;

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
    const parsed = await openaiClient.callJsonCompletion(provider, {
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
      maxTokens: 300,
      maxOutputTokens: 300,
    });
    const t = String(parsed?.title || "").trim();
    if (!t || t.length > 30) return null;
    return t;
  } catch (err) {
    console.warn("[title-gen] 失败:", err.message || err);
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
        console.warn(`[bili-view] ${v.id} failed:`, err?.message || String(err));
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

// 抖音用户投稿 — 必须经 Chrome 插件桥 (在 douyin.com tab 里调 fetch, 借 webmssdk 自动签 a_bogus).
// main 进程没有 webmssdk, 自己签 a_bogus 工作量大且抖音常变签名, 不在 node 里实现.
async function fetchDouyinUserPosts(secUid, count = 18) {
  if (!extensionBridge.isConnected()) return null;
  try {
    const result = await extensionBridge.request(
      "douyin.userPosts",
      { secUid, count, maxCursor: 0 },
      { timeoutMs: 25_000 },
    );
    if (!result || !result.ok) {
      throw new Error(`HTTP ${result?.status ?? "?"}`);
    }
    const body = result.body;
    if (body?.__parseError) throw new Error(`JSON 解析失败: ${body.raw?.slice(0, 200)}`);
    if (body?.__error) throw new Error(body.__error);
    if (Number(body?.status_code) !== 0 && body?.status_code != null) {
      // 抖音业务码; status_code 0 是 OK
      throw new Error(`status_code=${body.status_code} ${body?.status_msg || ""}`);
    }
    const list = Array.isArray(body?.aweme_list) ? body.aweme_list : [];
    const videos = list.map((a) => {
      const id = String(a?.aweme_id || "");
      const cover =
        a?.video?.cover?.url_list?.[0] ||
        a?.video?.origin_cover?.url_list?.[0] ||
        null;
      const dur = Number(a?.video?.duration) || 0; // 抖音 duration 单位是 ms
      const createTs = Number(a?.create_time) || 0; // 秒
      return {
        id,
        title: a?.desc || "(未命名视频)",
        durationSec: Math.round(dur / 1000),
        uploadDate: createTs
          ? new Date(createTs * 1000).toISOString().slice(0, 10).replace(/-/g, "")
          : null,
        viewCount: Number(a?.statistics?.play_count) || 0,
        externalUrl: id ? `https://www.douyin.com/video/${id}` : "",
        thumbnailUrl: cover ? String(cover).replace(/^http:\/\//, "https://") : null,
      };
    }).filter((v) => v.id);
    return { videos, total: videos.length };
  } catch (e) {
    // 让上层把错误 surface 到 warnings, 别在这里吞
    throw e;
  }
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
    // 广播到所有窗口,允许关窗后重开的新 renderer 继续接收进度。
    broadcastToWindows("analysis:progress", payload);
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
    broadcastToWindows("analysis:progress", { ...base, message: msg });
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
          cache: makePrefilterCache(localStatus.modelKey),
          onProgress: (i, total, _tag, _elapsedMs, fromCache) => {
            ensureNotCancelled(handle);
            const avgMs = Math.round((Date.now() - prefilterStartedAt) / (i + 1));
            send(
              48 + Math.round(((i + 1) / total) * 6),
              "本地初筛",
              `已打标 ${i + 1} / ${total} 张 · 平均 ${avgMs} ms/帧${fromCache ? " · 命中缓存" : ""}`,
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
            send(62, "字幕识别", p.message);
          });
        }, transcribeMeta);

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
          cache: makeShotMergerCache(mediumTextProvider),
          onProgress: ({ done, total, batchIndex, mode }) => {
            ensureNotCancelled(handle);
            const pct = 67 + Math.round((done / total) * 4);
            const tail = mode === "cache-hit" ? " · 命中缓存" : "";
            send(pct, "镜头合并", `已合并 ${done}/${total} (batch ${batchIndex}, 平均 ${Math.round((Date.now()-mergeStart)/done)}ms/镜头)${tail}`);
          },
        });
        // 写回 shots: shotDescription + representativeFrameIndex
        for (let i = 0; i < shots.length; i++) {
          shots[i].shotDescription = mergeResults[i]?.shotDescription || "";
          shots[i].representativeFrameIndex = mergeResults[i]?.representativeFrameIndex || [];
        }
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
              71,
              "镜头缩略图",
              `已为 ${thumbDone}/${shotsNeedingThumb.length} 个无关键帧镜头抽兜底缩略图`
            );
          }
          send(
            71,
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
          const summarizerCacheKey = cacheStore.isConfigured() && mediumTextProvider?.model
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
                model: mediumTextProvider.model,
                baseUrl: mediumTextProvider.baseUrl,
                version: CACHE_VERSIONS.summarizer,
              })
            : null;
          globalContext = await runWithCache("summarizer", summarizerCacheKey, () => summarizer.summarizeVideo({
            shotContexts,
            transcript,
            shotStats: stats,
            project: projectMeta,
            provider: mediumTextProvider,
            genreCatalog: GENRE_CATALOG,
            allowedGenres: [...ALLOWED_GENRES],
            handle,
          }), { model: mediumTextProvider?.model });
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
          const detected = await runWithCache("detect-genre", detectGenreCacheKey,
            () => detectGenreLightweight(genreProvider, projectMeta, scenes, transcript, handle),
            { model: genreProvider?.model });
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
        const modelResult = await runWithCache("main-analysis", mainAnalysisCacheKey,
          () => callOpenAICompatible(provider, projectMeta, frames, transcript, scenes, fallbackNodes, fallbackReport, effectiveOptions, handle),
          { model: provider?.model });
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
        send(85, "分析失败", `${error.message || error}。已回退到本地基础结果。`);
      }
    } else if (globalContext || shotContexts) {
      // 视觉主分析未配置, 但中间层有产物, 让 fallback report 至少能带上 globalSummary
      if (globalContext?.globalSummary) report.globalSummary = globalContext.globalSummary;
      if (shotContexts) report.shotContexts = shotContexts;
    }

    // ----- B 站弹幕 → 时间轴情绪 + 词云 ----------------------------------
    // 触发条件: project.source 是 URL 且 platform=bilibili。其他平台不进。
    // 失败一律降级 (拉取/解析/LLM 任一阶段错都跳过, 不阻断主流程)。
    if (
      project.source?.type === "url" &&
      project.source.platform === "bilibili" &&
      project.source.url
    ) {
      try {
        ensureNotCancelled(handle);
        send(86, "拉取弹幕", "向 B 站请求弹幕分段…");
        const danmakuStart = Date.now();
        const danmakuRaw = await danmakuFetcher.fetchDanmakuWithCache({
          url: project.source.url,
          userDataDir: app.getPath("userData"),
          abortSignal: handle.abortController?.signal,
          onProgress: ({ segment, total, count, fromCache }) => {
            if (handle.cancelled) return;
            if (fromCache) {
              send(87, "拉取弹幕", `命中缓存,直接使用 ${count} 条历史弹幕。`);
            } else {
              const pct = 86 + Math.min(1, Math.round((segment / Math.max(total, 1)) * 1));
              send(pct, "拉取弹幕", `已拉 ${segment}/${total} 段 · 累计 ${count} 条`);
            }
          },
        });
        await writeJson(path.join(projectDir, "danmaku.json"), danmakuRaw);

        let windows = [];
        let danmakuSummary = "";
        if (mediumTextProvider?.apiKeyRef && danmakuRaw.messages.length > 0) {
          ensureNotCancelled(handle);
          send(88, "弹幕情绪聚合", `让 ${mediumTextProvider.name} 给 ${danmakuRaw.totalCount} 条弹幕分段评分。`);
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
              send(88, "弹幕情绪聚合", `已评 ${done}/${total} 个时间桶`);
            },
          });
          windows = agg.windows;
          danmakuSummary = agg.summary;
          send(89, "弹幕情绪聚合完成", `${windows.filter((w) => w.danmakuCount > 0).length} 个时间桶 · ${((Date.now() - aggStart) / 1000).toFixed(1)}s`);
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
          89,
          "弹幕分析完成",
          `${danmakuRaw.totalCount} 条弹幕 · 词云 ${wordCloud.length} 词 · ${((Date.now() - danmakuStart) / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(89, "弹幕分析失败", `${error?.message || error}（不影响主分析结果）`);
      }
    }

    ensureNotCancelled(handle);
    send(90, "整理结果", "正在保存分析结果。");

    // 本地选取的视频 (没经过 URL 拉取那条路, videoName 是磁盘文件名) 在这里补标题。
    // URL 拉取场景在 downloadVideo handler 里已经生成过 → titleAutoGenerated:true → 跳过。
    let generatedTitle = null;
    if (!project.titleAutoGenerated && globalContext?.globalSummary && mediumTextProvider?.apiKeyRef) {
      try {
        generatedTitle = await generateProjectTitle(mediumTextProvider, {
          summary: globalContext.globalSummary,
        });
      } catch (err) {
        console.warn("[analyze] 标题生成失败:", err?.message || err);
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
      status: "completed",
      providerId: provider?.id,
      model: provider?.model,
      thumbnailUrl: frames[0]?.framePath ? createProjectMediaUrl(project.id, frames[0].framePath) : project.thumbnailUrl,
      ...(generatedTitle ? { videoName: generatedTitle, titleAutoGenerated: true } : {}),
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
      broadcastToWindows("analysis:progress", {
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
  const sourcePath = path.join(__dirname, "assets", "icon-256.png");
  let trayImg = nativeImage.createFromPath(sourcePath);
  if (trayImg.isEmpty()) {
    console.warn("[tray] icon-256.png 不可用,跳过托盘创建");
    return;
  }
  const size = process.platform === "darwin" ? 18 : 16;
  trayImg = trayImg.resize({ width: size, height: size, quality: "best" });
  trayInstance = new Tray(trayImg);
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
    console.warn("[notify] 通知失败:", err?.message || err);
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
  // macOS Dock 图标
  if (process.platform === "darwin" && app.dock) {
    const icon = getAppIcon();
    if (icon) app.dock.setIcon(icon);
  }
  app.setName("ClipIQ");

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
    console.warn("[cache-store] 初始化失败:", err?.message || err);
  }

  try {
    await extensionBridge.start(app.getPath("userData"));
    extensionBridge.onStatusChange((s) => {
      // 广播给所有 renderer 窗口
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send("extensionBridge:status", s); } catch { /* noop */ }
      }
    });
    console.log("[extension-bridge] 已启动 ws://127.0.0.1:58713/agent");
  } catch (err) {
    console.warn("[extension-bridge] 启动失败:", err?.message || err);
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
      db.exec("DELETE FROM analysis_nodes; DELETE FROM analysis_reports; DELETE FROM projects;");
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
    // maxBytes 改了就同步 cache-store; cacheDir 走专门的 cache:setDir IPC, 这里不动
    try {
      const { maxBytes } = resolveCacheConfig(migrated);
      if (cacheStore.isConfigured() && maxBytes !== cacheStore.getMaxBytes()) {
        cacheStore.configure({ dir: cacheStore.getCacheDir(), maxBytes });
      }
    } catch (err) {
      console.warn("[cache-store] 同步 maxBytes 失败:", err?.message || err);
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
  const fetchAccountVideosCore = async ({ url, limit = 20, onProgress, cancelled }) => {
    if (!url || typeof url !== "string") throw new Error("fetchAccountVideosCore 需要 url");
    const platform = detectAccountPlatform(url);
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
      if (secUid && extensionBridge.isConnected()) {
        report(20, "请求抖音接口", "经 Chrome 插件 douyin.com tab 调 fetch");
        try {
          const result = await fetchDouyinUserPosts(secUid, safeLimit);
          if (result && result.videos.length > 0) nativeVideos = result;
        } catch (e) {
          nativeVideosError = `douyin user posts: ${e?.message || String(e)}`;
        }
      } else if (!secUid) {
        nativeCardError = "无法从抖音 URL 解析出 sec_user_id (期望格式: douyin.com/user/MS4w...)";
      }
    }

    checkCancelled();
    let ytDlpParsed = null;
    let ytDlpError = null;
    const skipYtDlp =
      (platform === "bilibili" && nativeCard && nativeVideos) ||
      (platform === "douyin" && nativeVideos && nativeVideos.videos.length > 0);
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
        console.warn("[accounts:fetch] 清理旧 av 失败:", e?.message || e);
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
          platform,
          addedAt: new Date(now).toISOString(),
        };
        // 保留已有 analysisProjectId
        const existing = existsStmt.get(avId);
        if (existing) {
          const oldRow = db.prepare("SELECT data FROM account_videos WHERE id = ?").get(avId);
          if (oldRow) {
            try {
              const old = JSON.parse(oldRow.data);
              if (old.analysisProjectId) av.analysisProjectId = old.analysisProjectId;
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
          console.warn("[accounts:fetch] update Account 失败", e?.message || e);
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
      console.warn("[accounts:startFetch] runAccountFetch unhandled", err?.message || err);
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
      const parsed = await openaiClient.callJsonCompletion(provider, {
        systemText:
          "你是视频方法论分析师。给定一位 UP 主的若干视频分析摘要,请跨视频汇总出可复用的方法论 manifest。\n" +
          "规则:\n" +
          "- 4 个维度都要给(hooks/pacing/structure/visual),每个维度 summary 1-2 句中文,具体可操作\n" +
          "- sampleVideoIds 留空数组即可\n" +
          "- 直接返回 JSON,不要 markdown 围栏,不要思考过程",
        userText: lines.join("\n"),
        temperature: 0.4,
        maxTokens: 800,
        maxOutputTokens: 800,
      });
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
      const parsed = await openaiClient.callJsonCompletion(provider, {
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
        maxTokens: 2000,
        maxOutputTokens: 2000,
      });
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
        // 广播失败,让 attach 模式的 renderer (关窗后重开) 也能感知
        if (projectId) {
          broadcastToWindows("analysis:progress", {
            projectId,
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
      }
      throw err;
    }
  });

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
        // 老 cache (无 title) 懒迁移: 命中时补一次, 写回 cache。
        // 若磁盘上还有 .info.json 也读一下, 给 LLM 多一份证据。
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
            } catch {
              // 老缓存没有 info.json: 仅用 rawInput
            }
          }
          const mp = await loadMediumTextProvider();
          title = await generateProjectTitle(mp, { rawInput, url, ytdlpInfo });
          if (title) {
            cache[url] = { ...cached, title, ytdlpInfo: ytdlpInfo || cached.ytdlpInfo };
            await writeUrlCache(cache);
          }
        }
        return {
          projectId: `proj-url-${Date.now()}`,
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

    const projectId = `proj-url-${Date.now()}`;
    const mediaDir = path.join(app.getPath("userData"), "projects", projectId, "media");
    await fs.mkdir(mediaDir, { recursive: true });

    const outputPattern = path.join(mediaDir, "%(extractor)s_%(id)s.%(ext)s");
    try {
      // --write-info-json 让 yt-dlp 把视频元数据 (title/description/uploader/upload_date 等)
      // 落到 <basename>.info.json, 后面解析出来喂给 medium_text 生成项目标题。
      await run(ytDlp, [
        "--no-playlist",
        "--restrict-filenames",
        "--write-info-json",
        "-o", outputPattern,
        url,
      ]);
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message || error).trim();
      throw new Error(detail || "yt-dlp 下载失败");
    }

    // 只挑视频文件 (排除 .info.json / .description / .live_chat.json 等附件)
    const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".flv", ".avi"]);
    const files = await fs.readdir(mediaDir);
    const candidates = await Promise.all(
      files
        .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
        .map(async (file) => {
          const filePath = path.join(mediaDir, file);
          const stat = await fs.stat(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        })
    );
    const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!latest) throw new Error("yt-dlp 执行完成，但没有生成视频文件。");

    // 读 .info.json 拿平台 metadata (失败不阻断, 文件可能因为平台限制没拿到)
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
    } catch {
      // info.json 缺失 / 损坏: 让 medium_text 仅用 rawInput
    }

    const inspected = await inspectVideo(latest.filePath);
    const mp = await loadMediumTextProvider();
    const title = await generateProjectTitle(mp, { rawInput, url, ytdlpInfo });
    cache[url] = {
      filePath: latest.filePath,
      savedAt: Date.now(),
      title: title || undefined,
      ytdlpInfo: ytdlpInfo || undefined,
    };
    await writeUrlCache(cache);
    return {
      projectId,
      platform: inferPlatform(url),
      ...inspected,
      title: title || null,
      fromCache: false,
    };
  });

  await llamaRuntime.init();
  await whisperCppRuntime.init();

  // listModels 与 listManifest 共用同一映射,差别只在不带 machine 字段
  ipcMain.handle("llama:listModels", async () => {
    const machineDetect = require("./machine-detect.cjs");
    const machine = machineDetect.detectMachine();
    const annotated = machineDetect.annotateManifest(llamaRuntime.getManifest(), machine);
    const installed = await llamaRuntime.listModels();
    const installedMap = Object.fromEntries(installed.map((m) => [m.key, m]));
    return Object.values(annotated)
      .map((entry) => {
        const inst = installedMap[entry.key] || {};
        return localLlamaEntryToDescriptor({
          ...entry,
          downloaded: !!inst.downloaded,
          llmBytes: inst.llmBytes || 0,
          mmprojBytes: inst.mmprojBytes || 0,
        });
      })
      .filter(Boolean);
  });

  ipcMain.handle("llama:getStatus", async () => llamaRuntime.getStatus());

  // 返回 ModelDescriptor[] + 机器规格. annotated manifest 合并 downloaded 状态后投影成统一 schema
  ipcMain.handle("llama:listManifest", async () => {
    const machineDetect = require("./machine-detect.cjs");
    const machine = machineDetect.detectMachine();
    const manifest = llamaRuntime.getManifest();
    const annotated = machineDetect.annotateManifest(manifest, machine);
    const installed = await llamaRuntime.listModels();
    const installedMap = Object.fromEntries(installed.map((m) => [m.key, m]));
    const descriptors = Object.values(annotated)
      .map((entry) => {
        const inst = installedMap[entry.key] || {};
        return localLlamaEntryToDescriptor({
          ...entry,
          downloaded: !!inst.downloaded,
          llmBytes: inst.llmBytes || 0,
          mmprojBytes: inst.mmprojBytes || 0,
        });
      })
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
      console.warn("[clipiq] 持久化 lastLlamaModelKey 失败:", e),
    );
    return result;
  });

  ipcMain.handle("llama:stop", async () => llamaRuntime.stop());

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

// 所有可能的退出路径都收敛到这个清理函数:
// 1) Electron 自己 app.quit() / Cmd+Q → before-quit
// 2) 终端 Ctrl+C / kill 主进程 → SIGINT / SIGTERM / SIGHUP (concurrently -k 用 SIGTERM)
// 3) Node 主循环退出 → exit
// 同一个 cleanup 可以被多次调用, shutdownSync 内部已经判 state.process 是否存在, 幂等。
let _cleanedUp = false;
function cleanupSidecars(reason) {
  if (_cleanedUp) return;
  _cleanedUp = true;
  try { console.log(`[clipiq] cleanupSidecars: ${reason}`); } catch {}
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
