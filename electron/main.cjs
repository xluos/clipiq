const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, utilityProcess } = require("electron");
const { execFile } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");

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
const PIPELINE_VERSION = "mvp-local-2026-05-12";
const SCHEMA_VERSION = "analysis-v1";
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

function targetFrameCount(durationSec, options) {
  const density = options?.density || "standard";
  const mode = options?.mode || "standard";
  // base "frames per minute" 启发，参考 OpenSceneSense 的 fps_per_minute=4
  const base = density === "dense" ? 6 : density === "sparse" ? 2 : 4;
  const detailBoost = mode === "detailed" ? 1 : mode === "quick" ? -1 : 0;
  const target = Math.round((durationSec / 60) * (base + detailBoost));
  return Math.max(6, Math.min(32, target));
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
// 若场景数 >= 目标：取最显著的目标个（用相邻时长权重）
// 若场景数 <  目标：在每个场景中点的基础上补均匀样
function planFramePlan(scenes, durationSec, targetCount) {
  const safeDuration = Math.max(durationSec, 1);
  const sorted = [...new Set(scenes)].filter((t) => t < safeDuration).sort((a, b) => a - b);

  // 每个 scene 取中点（更稳定，避开切换瞬间的运动模糊）
  const midpoints = sorted.map((start, i) => {
    const end = sorted[i + 1] ?? safeDuration;
    return { sceneStart: start, sceneEnd: end, sampleSec: Math.min(safeDuration - 0.1, start + (end - start) / 2) };
  });

  let picks;
  if (midpoints.length >= targetCount) {
    // 按 scene 长度从大到小排，取前 target 个；保留时间顺序
    picks = [...midpoints]
      .sort((a, b) => (b.sceneEnd - b.sceneStart) - (a.sceneEnd - a.sceneStart))
      .slice(0, targetCount)
      .sort((a, b) => a.sampleSec - b.sampleSec);
  } else {
    picks = [...midpoints];
    const need = targetCount - picks.length;
    if (need > 0) {
      const step = safeDuration / (need + 1);
      for (let i = 1; i <= need; i++) picks.push({ sceneStart: i * step, sceneEnd: i * step, sampleSec: i * step });
      picks.sort((a, b) => a.sampleSec - b.sampleSec);
    }
  }

  return picks.map((p, index) => ({
    index,
    startSec: p.sceneStart,
    endSec: p.sceneEnd,
    midSec: p.sampleSec,
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

async function buildFrames(ffmpeg, inputPath, plan, artifactDir, handle, onProgress) {
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
    out.push({ ...segment, framePath, hash });
    lastHash = hash || lastHash;
  }
  return { frames: out, skipped };
}

async function extractFrame(ffmpeg, inputPath, outputPath, second, width = 420, handle = null) {
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
    "3",
    outputPath,
  ], {}, handle);
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
  };
}

function buildLocalReport(project, nodes, provider, audioProvider, transcriptSummary) {
  const transcriptHint = transcriptSummary
    ? `音轨已转录 ${transcriptSummary.segmentCount ?? 0} 段（${transcriptSummary.language || "auto"}），但视觉模型未配置或失败，没有生成完整语义分析。`
    : "未启用语音转录，且视觉模型未配置或失败，结果仅基于场景检测的关键帧骨架。";

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

function normalizeModelResult(payload, fallbackNodes, fallbackReport, project, provider) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : fallbackNodes;
  const normalizedNodes = nodes.map((node, index) => ({
    ...fallbackNodes[Math.min(index, fallbackNodes.length - 1)],
    ...node,
    id: String(node.id || `node-${index + 1}`),
    startSec: Number.isFinite(Number(node.startSec)) ? Number(node.startSec) : fallbackNodes[index]?.startSec ?? 0,
    endSec: Number.isFinite(Number(node.endSec)) ? Number(node.endSec) : fallbackNodes[index]?.endSec ?? project.durationSec,
    visualElements: Array.isArray(node.visualElements) ? node.visualElements : fallbackNodes[index]?.visualElements ?? [],
    audioElements: Array.isArray(node.audioElements) ? node.audioElements : fallbackNodes[index]?.audioElements ?? [],
    nodeTypes: Array.isArray(node.nodeTypes) ? node.nodeTypes : fallbackNodes[index]?.nodeTypes ?? ["info_point"],
    isHighlight: Boolean(node.isHighlight),
  }));

  return {
    nodes: normalizedNodes.length ? normalizedNodes : fallbackNodes,
    report: {
      ...fallbackReport,
      ...(payload?.report || {}),
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
  if (transcriptText.length <= maxChars) return { text: transcriptText, segments: segments || [] };
  // 截前 60% + 后 40%，中间换 [...]
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen - 8;
  const head = transcriptText.slice(0, headLen);
  const tail = transcriptText.slice(-tailLen);
  return { text: `${head}\n[...省略中段...]\n${tail}`, segments: segments || [] };
}

function buildAnalysisPrompt(project, frames, transcript, options) {
  const focusHint =
    options?.focus === "rhythm" ? "重点关注剪辑节奏、镜头切换密度、停顿停滞。" :
    options?.focus === "emotion" ? "重点关注情绪曲线、表达强度和观众共鸣点。" :
    options?.focus === "narrative" ? "重点关注叙事结构、信息递进、转折设置。" :
    "综合关注叙事结构、剪辑节奏、情绪曲线和画面信息。";
  const modeHint = options?.mode === "detailed" ? "拆解到尽可能细的镜头级。" : options?.mode === "quick" ? "只覆盖关键节点，不要面面俱到。" : "覆盖主要剪辑节点。";

  const frameDescriptions = frames.map((f, i) =>
    `#${i + 1}  t=${f.midSec.toFixed(1)}s  范围 ${f.startSec.toFixed(1)}-${f.endSec.toFixed(1)}s`
  ).join("\n");

  const transcriptBlock = transcript?.text
    ? `\n# 音轨转录（语言: ${transcript.language || "auto"}）\n${transcript.text}\n`
    : "\n# 音轨转录\n（无 / 未配置语音模型）\n";

  const userText = [
    `请分析短视频《${project.videoName}》。`,
    `时长 ${Math.round(project.durationSec)}s, 画幅 ${project.width}x${project.height} (${project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"})。`,
    `${focusHint} ${modeHint}`,
    "",
    "# 关键帧时间表（与下面图片顺序一一对应）",
    frameDescriptions,
    transcriptBlock,
    "请只返回 JSON（不要 markdown），结构: {\"nodes\":[节点...],\"report\":{summary,structure:{hook,development,turn,climax,ending},pacing,editingStyle,composition,takeaways:[]}}.",
    "每个 node 必须包含: id, startSec, endSec, title, nodeTypes(数组,可选 shot_change/emotion_turn/info_point/edit_intent/audio_change), shotDescription, shotType, cameraMovement, visualElements(数组), audioElements(数组), editIntent, emotionLabel, emotionIntensity(0-10整数), narrativeFunction, confidence(0-1), isHighlight(布尔)。",
    "时间戳 startSec/endSec 必须严格落在视频时长内，且节点按时间升序。",
  ].join("\n");

  return userText;
}

async function callOpenAICompatible(provider, project, frames, transcript, fallbackNodes, fallbackReport, options, handle = null) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    return { nodes: fallbackNodes, report: fallbackReport, usedModel: false };
  }

  // Token budget: 估计开销 + 截 transcript
  const maxBudget = 8000;
  let visibleTranscript = transcript;
  if (transcript?.text) {
    const trimmed = trimTranscriptForBudget(transcript.text, transcript.segments, 4000);
    visibleTranscript = { ...transcript, text: trimmed.text };
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

  const userText = buildAnalysisPrompt(project, frames, visibleTranscript, options);
  const systemText =
    "你是一名严谨的短视频拉片分析师。所有回答必须是合法 JSON，不要使用 Markdown 围栏，不要解释。";

  const useResponses = provider.endpointType === "openai_responses";
  const parsed = useResponses
    ? await callOpenAIResponses(provider, systemText, userText, imageDataUrls, handle)
    : await callOpenAIChatCompletions(provider, systemText, userText, imageDataUrls, handle);

  return { ...normalizeModelResult(parsed, fallbackNodes, fallbackReport, project, provider), usedModel: true };
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
      max_tokens: provider.maxOutputTokens ?? 2400,
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
      max_output_tokens: provider.maxOutputTokens ?? 2400,
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
  if (audioProvider.endpointType === "local_whisper_wasm") {
    return transcribeLocalWhisper(audioProvider, wavPath, handle, onProgress);
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

// whisper 推理跑在独立 utilityProcess 里，崩溃不会拖垮主进程。
// 每次任务 spawn 一个 worker，收到 result/error 后 kill。
function runWhisperWorker({ type, payload, onProgress, handle }) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "whisper-worker.cjs");
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: "whisper-asr",
      stdio: "pipe",
      env: {
        ...process.env,
        HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || "",
        HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || "",
      },
    });

    if (child.stdout) child.stdout.on("data", (chunk) => console.log("[whisper]", chunk.toString().trimEnd()));
    if (child.stderr) child.stderr.on("data", (chunk) => console.error("[whisper]", chunk.toString().trimEnd()));

    let settled = false;
    let cancelWatcher = null;
    const requestId = `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (cancelWatcher) clearInterval(cancelWatcher);
      try { child.kill(); } catch { /* ignore */ }
      fn();
    };

    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        child.postMessage({ type, requestId, payload });
      } else if (msg.type === "progress") {
        if (onProgress) onProgress({ stage: msg.stage, message: msg.message });
      } else if (msg.type === "result") {
        finish(() => resolve(msg));
      } else if (msg.type === "error" || msg.type === "fatal") {
        finish(() => reject(new Error(msg.message || "whisper worker error")));
      }
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (cancelWatcher) clearInterval(cancelWatcher);
      reject(new Error(`whisper worker 退出 (code=${code})`));
    });

    if (handle) {
      cancelWatcher = setInterval(() => {
        if (handle.cancelled) finish(() => reject(new Error("cancelled")));
      }, 200);
    }
  });
}

async function transcribeLocalWhisper(audioProvider, wavPath, handle, onProgress) {
  const modelId = audioProvider.localWhisperModel || audioProvider.model || "Xenova/whisper-base";
  const mirror = audioProvider.localWhisperMirror || "https://hf-mirror.com";
  const cacheDir = path.join(app.getPath("userData"), "whisper-cache");
  const result = await runWhisperWorker({
    type: "transcribe",
    payload: {
      wavPath,
      modelId,
      mirror,
      cacheDir,
      language: audioProvider.language || null,
    },
    onProgress,
    handle,
  });
  return result.transcript;
}

async function warmupLocalWhisper(audioProvider) {
  const modelId = audioProvider.localWhisperModel || audioProvider.model || "Xenova/whisper-base";
  const mirror = audioProvider.localWhisperMirror || "https://hf-mirror.com";
  const cacheDir = path.join(app.getPath("userData"), "whisper-cache");
  const result = await runWhisperWorker({
    type: "warmup",
    payload: { modelId, mirror, cacheDir },
  });
  return result.warmup;
}

async function analyzeProject(event, { project, provider, audioProvider, options }) {
  if (activeAnalyses.has(project.id)) {
    throw new Error("该项目已有分析任务在运行。");
  }
  const handle = registerAnalysis(project.id);

  const send = (progress, stage, message) => {
    if (handle.cancelled) return;
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

    send(5, "读取视频元数据", "使用 ffprobe 校验时长、尺寸、音轨。");
    ensureNotCancelled(handle);
    const inspected = await inspectVideo(inputPath, handle);
    const projectDir = getProjectDir(project.id);
    const artifactDir = path.join(projectDir, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    const projectMeta = { ...project, ...inspected, hasAudio: inspected.hasAudio };

    send(12, "检测镜头切换", "ffmpeg scene filter 扫描所有 cut 点。");
    ensureNotCancelled(handle);
    const sceneThreshold = sceneThresholdFor(options);
    const scenes = await detectScenes(ffmpeg, inputPath, sceneThreshold, handle);
    const targetCount = targetFrameCount(inspected.durationSec || project.durationSec || 1, options);
    const plan = planFramePlan(scenes, inspected.durationSec || project.durationSec || 1, targetCount);
    send(20, "规划候选帧", `场景 ${scenes.length} 个 → 目标 ${plan.length} 个候选帧`);

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
      targetFrameCount: targetCount,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
    });

    send(24, "抽取关键帧", `${plan.length} 张候选帧 + dHash 去重`);
    const { frames, skipped } = await buildFrames(ffmpeg, inputPath, plan, artifactDir, handle, (i, total, sec) => {
      send(24 + Math.round((i / total) * 26), "抽取关键帧", `${i + 1}/${total} · ${sec.toFixed(1)}s`);
    });
    if (skipped > 0) send(50, "去重", `dHash 去掉 ${skipped} 张冗余帧，剩 ${frames.length} 张`);

    // 音频转录（可选）
    let transcript = null;
    let transcriptError = null;
    const audioReady = audioProvider && inspected.hasAudio && (
      audioProvider.endpointType === "local_whisper_wasm" || audioProvider.apiKeyRef
    );
    if (audioReady) {
      try {
        send(55, "提取音轨", "ffmpeg 提取 16kHz 单声道 WAV。");
        const wavPath = path.join(artifactDir, "audio.wav");
        await extractAudioWav(ffmpeg, inputPath, wavPath, handle);
        send(60, "语音转录", `${audioProvider.name} / ${audioProvider.model}`);
        ensureNotCancelled(handle);
        transcript = await transcribeAudio(audioProvider, wavPath, handle, (p) => {
          send(62, "语音转录", p.message);
        });
        if (transcript) {
          await writeJson(path.join(artifactDir, "transcript.json"), transcript);
          send(66, "转录完成", `${transcript.segments.length} 段, ${transcript.text.length} 字`);
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        transcriptError = error?.message || String(error);
        send(66, "转录失败", `${transcriptError}（继续走纯视觉分析）`);
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
    const fallbackReport = buildLocalReport(projectMeta, fallbackNodes, provider, audioProvider, transcriptSummary);

    let nodes = fallbackNodes;
    let report = fallbackReport;
    ensureNotCancelled(handle);
    send(72, "准备模型输入", provider?.apiKeyRef ? `构建 keyframe_sequence 请求（${frames.length} 帧${transcript ? " + 转录" : ""}）。` : "未配置视觉模型，将仅返回骨架结果。");

    if (provider?.apiKeyRef && provider.inputMode !== "direct_video") {
      try {
        ensureNotCancelled(handle);
        send(78, "调用模型分析", `${provider.name} / ${provider.model}`);
        const modelResult = await callOpenAICompatible(provider, projectMeta, frames, transcript, fallbackNodes, fallbackReport, options, handle);
        nodes = modelResult.nodes;
        report = {
          ...modelResult.report,
          audioProviderSnapshot: fallbackReport.audioProviderSnapshot,
          transcript: fallbackReport.transcript,
        };
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(85, "模型回退", `${error.message || error}。已回退到骨架结果。`);
      }
    }

    ensureNotCancelled(handle);
    send(90, "合并节点与报告", "写入项目产物。");
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
    await writeJson(path.join(projectDir, "analysis-result.json"), { project: updatedProject, nodes, report });
    send(100, "完成", "分析结果已生成。");
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

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "自动拉片分析工具",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0A0A0B",
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
    return readJson(getConfigPath(), null);
  });

  ipcMain.handle("config:save", async (_event, config) => {
    await writeJson(getConfigPath(), { ...config, savedAt: new Date().toISOString() });
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
    db.prepare(
      "INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).run(project.id, JSON.stringify(project), Date.now());
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

  ipcMain.handle("whisper:isModelCached", async (_event, modelId) => {
    if (!modelId || typeof modelId !== "string") return { cached: false };
    const cacheDir = path.join(app.getPath("userData"), "whisper-cache");
    const modelDir = path.join(cacheDir, modelId);
    try {
      const entries = await fs.readdir(modelDir, { withFileTypes: true });
      // 至少要有 onnx 子目录或 model.onnx 文件，且有 config.json
      let hasConfig = false;
      let hasOnnx = false;
      for (const entry of entries) {
        if (entry.name === "config.json") hasConfig = true;
        if (entry.name === "onnx") {
          const onnxFiles = await fs.readdir(path.join(modelDir, entry.name)).catch(() => []);
          if (onnxFiles.some((f) => f.endsWith(".onnx") || f.endsWith(".onnx_data"))) hasOnnx = true;
        }
        if (entry.name.endsWith(".onnx")) hasOnnx = true;
      }
      if (!hasConfig || !hasOnnx) return { cached: false };
      let totalBytes = 0;
      async function walk(p) {
        const items = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
        for (const i of items) {
          const full = path.join(p, i.name);
          if (i.isDirectory()) await walk(full);
          else if (i.isFile()) {
            const stat = await fs.stat(full).catch(() => null);
            if (stat) totalBytes += stat.size;
          }
        }
      }
      await walk(modelDir);
      return { cached: true, sizeBytes: totalBytes };
    } catch {
      return { cached: false };
    }
  });

  ipcMain.handle("provider:testConnection", async (_event, provider) => {
    if (provider?.endpointType === "local_whisper_wasm") {
      const modelId = provider.localWhisperModel || provider.model || "Xenova/whisper-base";
      try {
        const t0 = Date.now();
        await warmupLocalWhisper(provider);
        return { ok: true, message: `本地模型 ${modelId} 已就绪 (${((Date.now() - t0) / 1000).toFixed(1)}s)。` };
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

  ipcMain.handle("video:downloadUrl", async (_event, url) => {
    const ytDlp = await commandPath("yt-dlp");
    if (!ytDlp) {
      throw new Error("未找到 yt-dlp，无法通过链接拉取视频。请先安装 yt-dlp，或改用本地视频。");
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
    return {
      projectId,
      platform: inferPlatform(url),
      ...inspected,
    };
  });

  await createWindow();

  scheduleYtDlpAutoCheck();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
