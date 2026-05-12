const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require("electron");
const { execFile } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
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

function getAppStatePath() {
  return path.join(app.getPath("userData"), "app-state.json");
}

function getProjectDir(projectId) {
  return path.join(app.getPath("userData"), "projects", projectId);
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

function segmentCountFor(durationSec, options) {
  const density = options?.density || "standard";
  const mode = options?.mode || "standard";
  const base = density === "dense" ? 8 : density === "sparse" ? 4 : 6;
  const detailBoost = mode === "detailed" ? 2 : mode === "quick" ? -1 : 0;
  const durationBoost = durationSec > 240 ? 2 : durationSec > 90 ? 1 : 0;
  return Math.max(3, Math.min(12, base + detailBoost + durationBoost));
}

function buildSegments(durationSec, options) {
  const safeDuration = Math.max(1, durationSec || 1);
  const count = segmentCountFor(safeDuration, options);
  const step = safeDuration / count;
  return Array.from({ length: count }, (_, index) => {
    const startSec = Math.max(0, index * step);
    const endSec = index === count - 1 ? safeDuration : Math.min(safeDuration, (index + 1) * step);
    return {
      index,
      startSec,
      endSec,
      midSec: Math.min(safeDuration - 0.1, startSec + (endSec - startSec) / 2),
    };
  });
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

function localNodeForSegment(segment, project, frameUrl, options) {
  const progress = segment.startSec / Math.max(project.durationSec || 1, 1);
  const label =
    progress < 0.15 ? "开头引子" :
    progress < 0.45 ? "信息铺垫" :
    progress < 0.7 ? "转折推进" :
    progress < 0.9 ? "高潮表达" :
    "收束结尾";
  const emotion =
    progress < 0.15 ? "好奇" :
    progress < 0.45 ? "平稳" :
    progress < 0.7 ? "期待" :
    progress < 0.9 ? "高能" :
    "明确";
  const isHighlight = progress < 0.15 || progress > 0.68 && progress < 0.9;
  const focusHint =
    options?.focus === "rhythm" ? "重点关注剪辑节奏与停顿。" :
    options?.focus === "emotion" ? "重点关注情绪变化与表达强度。" :
    options?.focus === "narrative" ? "重点关注叙事功能与信息递进。" :
    "综合关注叙事、节奏、情绪和画面信息。";

  return {
    id: `node-${segment.index + 1}`,
    startSec: Number(segment.startSec.toFixed(2)),
    endSec: Number(segment.endSec.toFixed(2)),
    title: `${label} ${segment.index + 1}`,
    nodeTypes: segment.index === 0 ? ["shot_change", "info_point"] : isHighlight ? ["emotion_turn", "edit_intent"] : ["info_point"],
    shotDescription: `基于 ${project.videoName} 的关键帧和时间段自动生成的 MVP 节点。${focusHint}`,
    shotType: project.orientation === "portrait" ? "竖屏短视频画幅" : "横屏/常规画幅",
    cameraMovement: "待人工复核",
    visualElements: ["关键帧截图", `${project.width}x${project.height}`, project.orientation],
    audioElements: project.hasAudio === false ? ["未检测到音轨"] : ["音轨存在", "MVP 暂未做语音转写"],
    editIntent: `${label}阶段用于承接观众注意力，并为后续内容提供节奏锚点。`,
    emotionLabel: emotion,
    emotionIntensity: isHighlight ? 8 : 5,
    narrativeFunction: label,
    confidence: 0.62,
    isHighlight,
    thumbnailUrl: frameUrl,
  };
}

function buildLocalReport(project, nodes, provider) {
  const highlights = nodes.filter((node) => node.isHighlight);
  return {
    summary: `已完成 ${project.videoName} 的 MVP 自动拉片：共识别 ${nodes.length} 个时间节点，其中 ${highlights.length} 个重点节点。当前结果基于 ffprobe 元数据、ffmpeg 抽帧和可选模型分析生成，适合作为第一版审片草稿。`,
    structure: {
      hook: nodes[0] ? `${Math.round(nodes[0].startSec)}-${Math.round(nodes[0].endSec)}s：开头引子与注意力建立。` : "暂无",
      development: nodes[1] ? `${Math.round(nodes[1].startSec)}-${Math.round(nodes[Math.min(2, nodes.length - 1)].endSec)}s：信息铺垫与内容展开。` : "暂无",
      turn: nodes[Math.floor(nodes.length / 2)] ? `${Math.round(nodes[Math.floor(nodes.length / 2)].startSec)}s 附近：中段转折或节奏变化。` : "暂无",
      climax: highlights[highlights.length - 1] ? `${Math.round(highlights[highlights.length - 1].startSec)}s 附近：重点表达段落。` : "暂无",
      ending: nodes[nodes.length - 1] ? `${Math.round(nodes[nodes.length - 1].startSec)}-${Math.round(nodes[nodes.length - 1].endSec)}s：收束结尾。` : "暂无",
    },
    pacing: `节点平均长度约 ${Math.round((project.durationSec || 0) / Math.max(nodes.length, 1))} 秒；MVP 暂以均匀候选段落作为初始节奏切分。`,
    editingStyle: project.orientation === "portrait" ? "竖屏短视频审片模式，优先保留主体画面和时间点联动。" : "常规横屏审片模式，优先保留时间线节点和关键帧证据。",
    composition: `${project.width}x${project.height}，${project.orientation}，后续可结合模型结果细化主体位置和字幕安全区。`,
    takeaways: [
      "把重点节点作为二次复核入口，人工补充备注后可直接导出。",
      "若要提升语义准确度，请在设置里配置支持图像序列理解的 OpenAI-compatible 模型。",
      "当前版本不承诺所有模型都能直接读取视频，MVP 默认走关键帧序列。",
    ],
    providerSnapshot: provider ? {
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      inputMode: provider.inputMode,
    } : undefined,
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

async function callOpenAICompatible(provider, project, framePaths, fallbackNodes, fallbackReport, handle = null) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    return { nodes: fallbackNodes, report: fallbackReport, usedModel: false };
  }

  const images = [];
  for (const framePath of framePaths.slice(0, 8)) {
    const base64 = await fs.readFile(framePath, "base64");
    images.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${base64}` },
    });
  }

  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: handle?.abortController?.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKeyRef}`,
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: provider.temperature ?? 0.2,
      max_tokens: provider.maxOutputTokens ?? 1800,
      messages: [
        {
          role: "system",
          content: "你是短视频拉片分析助手。只输出 JSON，不要 Markdown。",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `请基于关键帧分析视频 ${project.videoName}。输出 JSON: {"nodes":[AnalysisNode...],"report":AnalysisReport}。节点字段必须包含 id,startSec,endSec,title,nodeTypes,shotDescription,visualElements,audioElements,editIntent,emotionLabel,emotionIntensity,narrativeFunction,confidence,isHighlight。`,
            },
            ...images,
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败 ${response.status}: ${detail.slice(0, 500)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = tryParseJsonFromText(typeof content === "string" ? content : JSON.stringify(content));
  return { ...normalizeModelResult(parsed, fallbackNodes, fallbackReport, project, provider), usedModel: true };
}

async function analyzeProject(event, { project, provider, options }) {
  if (activeAnalyses.has(project.id)) {
    throw new Error("该项目已有分析任务在运行。");
  }
  const handle = registerAnalysis(project.id);

  const send = (progress, stage, message) => {
    if (handle.cancelled) return;
    event.sender.send("analysis:progress", { projectId: project.id, progress, stage, message });
  };

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

    send(8, "读取视频元数据", "使用 ffprobe 校验时长、尺寸、音轨。");
    ensureNotCancelled(handle);
    const inspected = await inspectVideo(inputPath, handle);
    const projectDir = getProjectDir(project.id);
    const artifactDir = path.join(projectDir, "artifacts");
    const segments = buildSegments(inspected.durationSec || project.durationSec, options);
    const framePaths = [];

    send(22, "检测候选段落", `生成 ${segments.length} 个候选分析段。`);
    ensureNotCancelled(handle);
    await fs.mkdir(artifactDir, { recursive: true });
    await writeJson(path.join(projectDir, "media-manifest.json"), {
      source: project.source,
      filePath: inputPath,
      durationSec: inspected.durationSec,
      width: inspected.width,
      height: inspected.height,
      orientation: inspected.orientation,
      hasAudio: inspected.hasAudio,
      segments,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
    });

    for (const segment of segments) {
      ensureNotCancelled(handle);
      const framePath = path.join(artifactDir, `keyframe-${String(segment.index + 1).padStart(2, "0")}.jpg`);
      send(28 + Math.round((segment.index / segments.length) * 28), "抽取关键帧", `${segment.index + 1}/${segments.length}`);
      await extractFrame(ffmpeg, inputPath, framePath, segment.midSec, 520, handle);
      framePaths.push(framePath);
    }

    const fallbackNodes = segments.map((segment, index) =>
      localNodeForSegment(segment, { ...project, ...inspected, hasAudio: inspected.hasAudio }, createMediaUrl(framePaths[index]), options)
    );
    const fallbackReport = buildLocalReport({ ...project, ...inspected }, fallbackNodes, provider);

    let nodes = fallbackNodes;
    let report = fallbackReport;
    ensureNotCancelled(handle);
    send(66, "准备模型输入", provider?.apiKeyRef ? "构建 keyframe_sequence 请求。" : "未配置 API Key，使用本地启发式结果。");

    if (provider?.apiKeyRef && provider.inputMode !== "direct_video") {
      try {
        ensureNotCancelled(handle);
        send(74, "调用模型分析", `${provider.name} / ${provider.model}`);
        const modelResult = await callOpenAICompatible(provider, { ...project, ...inspected }, framePaths, fallbackNodes, fallbackReport, handle);
        nodes = modelResult.nodes;
        report = modelResult.report;
      } catch (error) {
        if (error instanceof AnalysisCancelledError || error?.name === "AbortError") throw new AnalysisCancelledError();
        send(82, "模型回退", `${error.message || error}。已回退到本地启发式分析。`);
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
      thumbnailUrl: framePaths[0] ? createMediaUrl(framePaths[0]) : project.thumbnailUrl,
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

  ipcMain.handle("project:loadAppState", async () => {
    return readJson(getAppStatePath(), null);
  });

  ipcMain.handle("project:saveAppState", async (_event, state) => {
    await writeJson(getAppStatePath(), {
      ...state,
      savedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
    });
    return { ok: true };
  });

  ipcMain.handle("analysis:start", analyzeProject);

  ipcMain.handle("analysis:cancel", async (_event, projectId) => {
    return { cancelled: cancelAnalysis(projectId) };
  });

  ipcMain.handle("analysis:isActive", async (_event, projectId) => {
    return activeAnalyses.has(projectId);
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
    if (!provider?.baseUrl) {
      return { ok: false, message: "请先填写 Base URL。" };
    }
    if (!provider?.apiKeyRef) {
      return { ok: false, message: "请先填写 API Key。" };
    }
    const base = String(provider.baseUrl).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${provider.apiKeyRef}` };
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
