import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AudioClip,
  CaptionCue,
  EditPlan,
  EditTransition,
  VideoClip,
} from "../../src/types";
import {
  captionCueFromEvidenceSegment,
  captionEventSummaries,
  deriveCaptionHighlights,
} from "./caption-highlights";

const US_PER_SECOND = 1_000_000;
const PROXY_RENDERER_VERSION = 2;

export type ProxySubtitleMode = "external" | "burn" | "none";

export type ProxyVideoSpec = {
  width: number;
  height: number;
  fps: number;
  videoCodec: "libx264";
  audioCodec: "aac";
  audioSampleRate: 48_000;
};

export type ProxyRenderManifest = {
  version: 1;
  planId: string;
  planVersion: number;
  renderDigest: string;
  outputPath: string;
  captionsPath?: string;
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  subtitleMode: ProxySubtitleMode;
  cacheHits: number;
  renderedSegments: number;
  warnings?: string[];
  createdAt: number;
};

export type ProxyProgress = {
  progress: number;
  stage: string;
  message?: string;
};

export type ProxyRendererOptions = {
  ffmpegPath: string;
  ffprobePath?: string | null;
  outputRoot: string;
  cacheRoot: string;
  subtitleMode?: ProxySubtitleMode;
  signal?: AbortSignal;
  onProgress?: (progress: ProxyProgress) => void;
  registerChild?: (child: { kill: (signal?: string) => void }) => void;
  now?: () => number;
};

type ProcessResult = {
  stdout: string;
  stderr: string;
};

type TransitionBoundary = {
  type: EditTransition["type"];
  durationUs: number;
};

function abortError(): Error {
  const error = new Error("代理预览渲染已取消");
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function proxyVideoSpecForCanvas(canvas: EditPlan["canvas"]): ProxyVideoSpec {
  const canvasWidth = Math.max(1, Number(canvas.width) || 1);
  const canvasHeight = Math.max(1, Number(canvas.height) || 1);
  const landscape = canvasWidth >= canvasHeight;
  const maxWidth = landscape ? 1280 : 720;
  const maxHeight = landscape ? 720 : 1280;
  const scale = Math.min(maxWidth / canvasWidth, maxHeight / canvasHeight);
  return {
    width: even(canvasWidth * scale),
    height: even(canvasHeight * scale),
    fps: Math.max(1, Math.min(60, Math.round(Number(canvas.fps) || 30))),
    videoCodec: "libx264",
    audioCodec: "aac",
    audioSampleRate: 48_000,
  };
}

function secondsFromUs(value: number): string {
  return (value / US_PER_SECOND).toFixed(6);
}

function atempoFilters(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters;
}

function clipDurationUs(clip: VideoClip): number {
  return Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
}

function videoTrack(plan: EditPlan): VideoClip[] {
  const track = plan.tracks.find((item) => item.kind === "video");
  return track?.kind === "video" ? track.items : [];
}

function audioTrack(plan: EditPlan): AudioClip[] {
  return plan.tracks
    .filter((item) => item.kind === "audio")
    .flatMap((item) => item.kind === "audio" ? item.items : []);
}

function explicitCaptions(plan: EditPlan): CaptionCue[] {
  return plan.tracks
    .filter((item) => item.kind === "caption")
    .flatMap((item) => item.kind === "caption" ? item.items : []);
}

export function collectProxyWarnings(plan: EditPlan): string[] {
  const unsupportedTts = audioTrack(plan)
    .filter((clip) => clip.kind === "voiceover" && clip.ttsText && !clip.sourcePath);
  return unsupportedTts.length > 0
    ? [`有 ${unsupportedTts.length} 段旁白尚未合成，代理预览已跳过。`]
    : [];
}

export function collectProxyCaptions(plan: EditPlan): CaptionCue[] {
  const explicit = explicitCaptions(plan);
  if (explicit.length > 0) {
    const clipById = new Map(videoTrack(plan).map((clip) => [clip.id, clip]));
    return explicit
      .filter((cue) => cue.text.trim() && cue.endUs > cue.startUs)
      .map((cue) => {
        if (cue.highlights?.length || !cue.sourceClipId) return cue;
        const clip = clipById.get(cue.sourceClipId);
        if (!clip) return cue;
        const highlights = deriveCaptionHighlights(
          cue,
          captionEventSummaries(clip),
        );
        return highlights.length > 0 ? { ...cue, highlights } : cue;
      })
      .sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
  }

  const generated: CaptionCue[] = [];
  for (const clip of videoTrack(plan)) {
    for (const [index, segment] of (clip.evidence?.subtitleSegments || []).entries()) {
      const cue = captionCueFromEvidenceSegment(clip, segment, index);
      if (cue) generated.push(cue);
    }
  }
  return generated.sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
}

function srtTimestamp(timeUs: number): string {
  const totalMs = Math.max(0, Math.round(timeUs / 1_000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function serializeSrt(cues: CaptionCue[]): string {
  return cues.map((cue, index) => [
    String(index + 1),
    `${srtTimestamp(cue.startUs)} --> ${srtTimestamp(cue.endUs)}`,
    cue.text.replace(/\r?\n/g, " "),
    "",
  ].join("\n")).join("\n");
}

function assTimestamp(timeUs: number): string {
  const totalCentiseconds = Math.max(0, Math.round(timeUs / 10_000));
  const hours = Math.floor(totalCentiseconds / 360_000);
  const minutes = Math.floor((totalCentiseconds % 360_000) / 6_000);
  const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function highlightedAssText(cue: CaptionCue): string {
  const highlights = [...(cue.highlights || [])]
    .filter((highlight) =>
      highlight.startOffset >= 0
      && highlight.endOffset > highlight.startOffset
      && highlight.endOffset <= cue.text.length)
    .sort((left, right) => left.startOffset - right.startOffset);
  if (highlights.length === 0) return escapeAssText(cue.text);
  const parts: string[] = [];
  let cursor = 0;
  for (const highlight of highlights) {
    if (highlight.startOffset < cursor) continue;
    parts.push(escapeAssText(cue.text.slice(cursor, highlight.startOffset)));
    parts.push(
      "{\\c&H00E5464F&\\b1}",
      escapeAssText(cue.text.slice(highlight.startOffset, highlight.endOffset)),
      "{\\r}",
    );
    cursor = highlight.endOffset;
  }
  parts.push(escapeAssText(cue.text.slice(cursor)));
  return parts.join("");
}

export function serializeAss(
  cues: CaptionCue[],
  spec: Pick<ProxyVideoSpec, "width" | "height">,
): string {
  const fontSize = Math.max(28, Math.round(spec.height * 0.034));
  const marginV = Math.max(32, Math.round(spec.height * 0.045));
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${spec.width}`,
    `PlayResY: ${spec.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,PingFang SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,36,36,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.map((cue) =>
      `Dialogue: 0,${assTimestamp(cue.startUs)},${assTimestamp(cue.endUs)},Default,,0,0,0,,${highlightedAssText(cue)}`),
    "",
  ].join("\n");
}

function cropFilter(clip: VideoClip): string | null {
  const crop = clip.crop;
  if (!crop) return null;
  if (
    !Number.isFinite(crop.x)
    || !Number.isFinite(crop.y)
    || !Number.isFinite(crop.width)
    || !Number.isFinite(crop.height)
    || crop.width <= 0
    || crop.height <= 0
  ) {
    throw new Error(`片段 ${clip.id} 的裁切参数无效`);
  }
  return `crop=${Math.round(crop.width)}:${Math.round(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)}`;
}

export function buildProxySegmentArgs(
  clip: VideoClip,
  outputPath: string,
  spec: ProxyVideoSpec,
  hasAudio: boolean,
): string[] {
  const durationUs = clipDurationUs(clip);
  if (durationUs <= 0) throw new Error(`片段 ${clip.id} 的时长无效`);
  const videoFilters = [
    cropFilter(clip),
    "setpts=(PTS-STARTPTS)/" + clip.speed.toFixed(6),
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${spec.fps}`,
    "setsar=1",
    "format=yuv420p",
  ].filter(Boolean);
  const audioFilters = hasAudio
    ? [
      `atrim=duration=${secondsFromUs(clip.sourceOutUs - clip.sourceInUs)}`,
      "asetpts=PTS-STARTPTS",
      ...atempoFilters(clip.speed),
      `volume=${Math.max(0, clip.volume).toFixed(6)}`,
      "aresample=48000",
    ]
    : [
      `atrim=duration=${secondsFromUs(durationUs)}`,
      "asetpts=PTS-STARTPTS",
    ];
  const audioInputIndex = hasAudio ? 0 : 1;

  return [
    "-y",
    "-ss", secondsFromUs(clip.sourceInUs),
    "-t", secondsFromUs(clip.sourceOutUs - clip.sourceInUs),
    "-i", clip.sourcePath,
    ...(hasAudio ? [] : [
      "-f", "lavfi",
      "-t", secondsFromUs(durationUs),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    ]),
    "-filter_complex",
    `[0:v:0]${videoFilters.join(",")}[v];[${audioInputIndex}:a:0]${audioFilters.join(",")}[a]`,
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", spec.videoCodec,
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", spec.audioCodec,
    "-b:a", "128k",
    "-ar", String(spec.audioSampleRate),
    "-ac", "2",
    "-movflags", "+faststart",
    "-shortest",
    "-progress", "pipe:2",
    "-nostats",
    outputPath,
  ];
}

function transitionForBoundary(
  transitions: EditTransition[],
  left: VideoClip,
  right: VideoClip,
): TransitionBoundary {
  const transition = transitions.find((item) =>
    item.fromClipId === left.id && item.toClipId === right.id);
  return transition
    ? { type: transition.type, durationUs: transition.durationUs }
    : { type: "cut", durationUs: 0 };
}

export function buildProxyAssemblyArgs(
  segmentPaths: string[],
  clips: VideoClip[],
  transitions: EditTransition[],
  outputPath: string,
  spec: ProxyVideoSpec,
): string[] | null {
  if (segmentPaths.length !== clips.length || segmentPaths.length === 0) {
    throw new Error("代理片段与 EditPlan 视频轨数量不一致");
  }
  if (segmentPaths.length === 1) return null;
  const boundaries = clips.slice(1).map((clip, index) =>
    transitionForBoundary(transitions, clips[index], clip));
  if (clips[0].timelineInUs !== 0) {
    throw new Error("代理预览要求视频轨道从 0 开始");
  }
  boundaries.forEach((boundary, index) => {
    const left = clips[index];
    const right = clips[index + 1];
    const overlapUs = boundary.type === "cut" ? 0 : boundary.durationUs;
    const expectedTimelineInUs = left.timelineInUs + clipDurationUs(left) - overlapUs;
    if (right.timelineInUs !== expectedTimelineInUs) {
      throw new Error(`转场 ${index + 1} 与视频轨时间不一致`);
    }
    if (
      boundary.type !== "cut"
      && boundary.durationUs * 2 > Math.min(clipDurationUs(left), clipDurationUs(right))
    ) {
      throw new Error(`转场 ${index + 1} 时长超过相邻片段的一半`);
    }
  });
  if (boundaries.every((item) => item.type === "cut" || item.durationUs === 0)) {
    return null;
  }

  const inputs = segmentPaths.flatMap((segmentPath) => ["-i", segmentPath]);
  const filters: string[] = [];
  for (let index = 0; index < segmentPaths.length; index++) {
    filters.push(`[${index}:v]setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
  }
  let videoLabel = "v0";
  let audioLabel = "a0";
  let accumulatedUs = clipDurationUs(clips[0]);

  for (let index = 1; index < clips.length; index++) {
    const boundary = boundaries[index - 1];
    const nextVideo = `vx${index}`;
    const nextAudio = `ax${index}`;
    const durationUs = Math.max(0, boundary.durationUs);
    if (boundary.type === "cut" || durationUs === 0) {
      filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0[${nextVideo}]`);
      filters.push(`[${audioLabel}][a${index}]concat=n=2:v=0:a=1[${nextAudio}]`);
      accumulatedUs += clipDurationUs(clips[index]);
    } else {
      const transitionName = boundary.type === "slide"
        ? "slideleft"
        : boundary.type === "fade"
          ? "fadeblack"
          : "fade";
      const offsetUs = Math.max(0, accumulatedUs - durationUs);
      filters.push(
        `[${videoLabel}][v${index}]xfade=transition=${transitionName}:duration=${secondsFromUs(durationUs)}:offset=${secondsFromUs(offsetUs)}[${nextVideo}]`,
      );
      filters.push(
        `[${audioLabel}][a${index}]acrossfade=d=${secondsFromUs(durationUs)}[${nextAudio}]`,
      );
      accumulatedUs += clipDurationUs(clips[index]) - durationUs;
    }
    videoLabel = nextVideo;
    audioLabel = nextAudio;
  }

  return [
    "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", `[${videoLabel}]`,
    "-map", `[${audioLabel}]`,
    "-c:v", spec.videoCodec,
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", spec.audioCodec,
    "-b:a", "128k",
    "-ar", String(spec.audioSampleRate),
    "-ac", "2",
    "-movflags", "+faststart",
    "-progress", "pipe:2",
    "-nostats",
    outputPath,
  ];
}

function escapedConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function escapeSubtitleFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function buildAudioMixArgs(
  basePath: string,
  clips: AudioClip[],
  outputPath: string,
): string[] {
  const usable = clips.filter((clip) => clip.sourcePath);
  const voiceovers = usable.filter((clip) => clip.kind === "voiceover");
  const inputs = usable.flatMap((clip) => ["-i", clip.sourcePath as string]);
  const filters: string[] = ["[0:a]asetpts=PTS-STARTPTS[basea]"];
  const labels = ["[basea]"];

  usable.forEach((clip, index) => {
    const inputIndex = index + 1;
    const durationUs = Math.max(0, clip.sourceOutUs - clip.sourceInUs);
    const delayMs = Math.max(0, Math.round(clip.timelineInUs / 1_000));
    const chain = [
      `atrim=start=${secondsFromUs(clip.sourceInUs)}:duration=${secondsFromUs(durationUs)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${Math.max(0, clip.volume).toFixed(6)}`,
    ];
    if (clip.fadeInUs && clip.fadeInUs > 0) {
      chain.push(`afade=t=in:st=0:d=${secondsFromUs(clip.fadeInUs)}`);
    }
    if (clip.fadeOutUs && clip.fadeOutUs > 0 && durationUs > clip.fadeOutUs) {
      chain.push(
        `afade=t=out:st=${secondsFromUs(durationUs - clip.fadeOutUs)}:d=${secondsFromUs(clip.fadeOutUs)}`,
      );
    }
    chain.push(`adelay=${delayMs}|${delayMs}`);
    if (clip.kind === "music" && clip.ducking?.enabled) {
      for (const voiceover of voiceovers) {
        const startSec = secondsFromUs(voiceover.timelineInUs);
        const endSec = secondsFromUs(
          voiceover.timelineInUs + Math.max(0, voiceover.sourceOutUs - voiceover.sourceInUs),
        );
        chain.push(
          `volume=${Math.max(0, clip.ducking.targetVolume).toFixed(6)}:enable='between(t,${startSec},${endSec})'`,
        );
      }
    }
    const label = `extra${index}`;
    filters.push(`[${inputIndex}:a]${chain.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0[mix]`);

  return [
    "-y",
    "-i", basePath,
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "0:v:0",
    "-map", "[mix]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    "-progress", "pipe:2",
    "-nostats",
    outputPath,
  ];
}

function buildBurnSubtitleArgs(
  inputPath: string,
  captionsPath: string,
  outputPath: string,
  spec: ProxyVideoSpec,
): string[] {
  const escaped = escapeSubtitleFilterPath(captionsPath);
  return [
    "-y",
    "-i", inputPath,
    "-vf", `subtitles=filename='${escaped}'`,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c:v", spec.videoCodec,
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-progress", "pipe:2",
    "-nostats",
    outputPath,
  ];
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    expectedDurationUs?: number;
    onProgress?: (ratio: number) => void;
    registerChild?: ProxyRendererOptions["registerChild"];
  } = {},
): Promise<ProcessResult> {
  ensureNotAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    options.registerChild?.({
      kill: (signal) => {
        child.kill(signal as NodeJS.Signals | number | undefined);
      },
    });
    let stdout = "";
    let stderr = "";
    let progressBuffer = "";
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      progressBuffer += text;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = /^(?:out_time_us|out_time_ms)=(\d+)$/.exec(line.trim());
        if (!match || !options.expectedDurationUs) continue;
        options.onProgress?.(
          Math.max(0, Math.min(1, Number(match[1]) / options.expectedDurationUs)),
        );
      }
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(abortError());
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim().split(/\r?\n/).slice(-8).join("\n");
        reject(new Error(`命令执行失败 (${code ?? "signal"}): ${detail}`));
      }
    });
  });
}

async function probeHasAudio(
  ffprobePath: string | null | undefined,
  sourcePath: string,
  options: Pick<ProxyRendererOptions, "signal" | "registerChild">,
): Promise<boolean> {
  if (!ffprobePath) return true;
  const result = await runProcess(ffprobePath, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    sourcePath,
  ], options);
  return Boolean(result.stdout.trim());
}

async function existingNonEmpty(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

async function sourceFingerprint(sourcePath: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(sourcePath);
  return {
    sourcePath,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  await fs.rm(targetPath, { force: true });
  await fs.rename(sourcePath, targetPath);
}

export async function renderEditPlanProxy(
  plan: EditPlan,
  options: ProxyRendererOptions,
): Promise<ProxyRenderManifest> {
  ensureNotAborted(options.signal);
  if (!/^[A-Za-z0-9._-]+$/.test(plan.id)) {
    throw new Error("EditPlan id 含有不安全的路径字符");
  }
  if (!plan.validation.valid) throw new Error("EditPlan 未通过校验，不能生成代理预览");
  const clips = videoTrack(plan);
  if (clips.length === 0) throw new Error("EditPlan 没有可渲染的视频片段");

  const subtitleMode = options.subtitleMode || "external";
  let effectiveSubtitleMode = subtitleMode;
  const warnings = collectProxyWarnings(plan);
  const spec = proxyVideoSpecForCanvas(plan.canvas);
  const now = options.now || Date.now;
  const fingerprints = await Promise.all(
    [...new Set([
      ...clips.map((clip) => clip.sourcePath),
      ...audioTrack(plan).flatMap((clip) => clip.sourcePath ? [clip.sourcePath] : []),
    ])].map(sourceFingerprint),
  );
  const renderDigest = digest({
    // rendered/exported 是生命周期状态，不应让同一时间线的代理缓存失效。
    plan: { ...plan, status: "validated" },
    fingerprints,
    subtitleMode,
    spec,
    rendererVersion: PROXY_RENDERER_VERSION,
  });
  const outputDir = path.join(options.outputRoot, plan.id);
  const outputPath = path.join(outputDir, `preview-${renderDigest.slice(0, 16)}.mp4`);
  const manifestPath = path.join(outputDir, "preview.json");
  const captionsPath = path.join(outputDir, `captions-${renderDigest.slice(0, 16)}.srt`);
  const burnCaptionsPath = path.join(outputDir, `captions-${renderDigest.slice(0, 16)}.ass`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(options.cacheRoot, { recursive: true });

  if (await existingNonEmpty(outputPath)) {
    try {
      const stored = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ProxyRenderManifest;
      if (
        stored?.renderDigest === renderDigest
        && stored.outputPath === outputPath
      ) {
        const cached = {
          ...stored,
          cacheHits: clips.length,
          renderedSegments: 0,
        };
        options.onProgress?.({ progress: 100, stage: "完成", message: "复用已有代理预览" });
        return cached;
      }
    } catch {
      // 旧 manifest 缺失或损坏时，按现有文件重建。
    }
    const cached: ProxyRenderManifest = {
      version: 1,
      planId: plan.id,
      planVersion: plan.version,
      renderDigest,
      outputPath,
      ...(subtitleMode !== "none" && await existingNonEmpty(captionsPath)
        ? { captionsPath }
        : {}),
      durationUs: plan.actualDurationUs,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      subtitleMode: effectiveSubtitleMode,
      cacheHits: clips.length,
      renderedSegments: 0,
      createdAt: now(),
    };
    await fs.writeFile(manifestPath, JSON.stringify(cached, null, 2), "utf8");
    options.onProgress?.({ progress: 100, stage: "完成", message: "复用已有代理预览" });
    return cached;
  }

  const segmentPaths: string[] = [];
  let cacheHits = 0;
  let renderedSegments = 0;
  options.onProgress?.({ progress: 1, stage: "准备代理素材" });

  for (const [index, clip] of clips.entries()) {
    ensureNotAborted(options.signal);
    const fingerprint = fingerprints.find((item) => item.sourcePath === clip.sourcePath);
    const segmentDigest = digest({
      clip,
      fingerprint,
      spec,
      rendererVersion: PROXY_RENDERER_VERSION,
    });
    const segmentPath = path.join(options.cacheRoot, `${segmentDigest}.mp4`);
    segmentPaths.push(segmentPath);
    if (await existingNonEmpty(segmentPath)) {
      cacheHits += 1;
      options.onProgress?.({
        progress: Math.round(((index + 1) / clips.length) * 70),
        stage: "准备代理素材",
        message: `复用片段 ${index + 1}/${clips.length}`,
      });
      continue;
    }

    const tempPath = `${segmentPath}.tmp-${process.pid}-${Date.now()}.mp4`;
    const hasAudio = await probeHasAudio(options.ffprobePath, clip.sourcePath, options);
    try {
      await runProcess(
        options.ffmpegPath,
        buildProxySegmentArgs(clip, tempPath, spec, hasAudio),
        {
          signal: options.signal,
          expectedDurationUs: clipDurationUs(clip),
          registerChild: options.registerChild,
          onProgress: (ratio) => options.onProgress?.({
            progress: Math.round(((index + ratio) / clips.length) * 70),
            stage: "生成代理片段",
            message: `${index + 1}/${clips.length}`,
          }),
        },
      );
      await replaceFile(tempPath, segmentPath);
      renderedSegments += 1;
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  const cues = collectProxyCaptions(plan);
  if (subtitleMode !== "none" && cues.length > 0) {
    await fs.writeFile(captionsPath, serializeSrt(cues), "utf8");
  }
  if (subtitleMode === "burn" && cues.length > 0) {
    await fs.writeFile(burnCaptionsPath, serializeAss(cues, spec), "utf8");
  }

  const workPrefix = path.join(outputDir, `.preview-${renderDigest.slice(0, 16)}`);
  const assembledPath = `${workPrefix}-assembled.mp4`;
  const mixedPath = `${workPrefix}-mixed.mp4`;
  const burnedPath = `${workPrefix}-subtitled.mp4`;
  const concatPath = `${workPrefix}.ffconcat`;
  const temporaryPaths = [
    assembledPath,
    mixedPath,
    burnedPath,
    concatPath,
    burnCaptionsPath,
  ];
  let completed = false;
  try {
    let currentPath = assembledPath;
    const assemblyArgs = buildProxyAssemblyArgs(
      segmentPaths,
      clips,
      plan.transitions,
      currentPath,
      spec,
    );
    if (assemblyArgs) {
      await runProcess(options.ffmpegPath, assemblyArgs, {
        signal: options.signal,
        expectedDurationUs: plan.actualDurationUs,
        registerChild: options.registerChild,
        onProgress: (ratio) => options.onProgress?.({
          progress: 70 + Math.round(ratio * 12),
          stage: "合并时间线",
        }),
      });
    } else if (segmentPaths.length === 1) {
      await fs.copyFile(segmentPaths[0], currentPath);
      options.onProgress?.({ progress: 82, stage: "合并时间线" });
    } else {
      await fs.writeFile(
        concatPath,
        ["ffconcat version 1.0", ...segmentPaths.map((item) => `file '${escapedConcatPath(item)}'`)].join("\n"),
        "utf8",
      );
      try {
        await runProcess(options.ffmpegPath, [
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", concatPath,
          "-c", "copy",
          "-movflags", "+faststart",
          "-progress", "pipe:2",
          "-nostats",
          currentPath,
        ], {
          signal: options.signal,
          expectedDurationUs: plan.actualDurationUs,
          registerChild: options.registerChild,
          onProgress: (ratio) => options.onProgress?.({
            progress: 70 + Math.round(ratio * 12),
            stage: "合并时间线",
          }),
        });
      } finally {
        await fs.rm(concatPath, { force: true });
      }
    }

    const extraAudio = audioTrack(plan)
      .filter((clip) => clip.kind !== "original" && clip.sourcePath);
    if (extraAudio.length > 0) {
      await runProcess(
        options.ffmpegPath,
        buildAudioMixArgs(currentPath, extraAudio, mixedPath),
        {
          signal: options.signal,
          expectedDurationUs: plan.actualDurationUs,
          registerChild: options.registerChild,
          onProgress: (ratio) => options.onProgress?.({
            progress: 82 + Math.round(ratio * 10),
            stage: "混合配音和音乐",
          }),
        },
      );
      await fs.rm(currentPath, { force: true });
      currentPath = mixedPath;
    } else {
      options.onProgress?.({ progress: 92, stage: "处理音轨" });
    }

    if (subtitleMode === "burn" && cues.length > 0) {
      try {
        await runProcess(
          options.ffmpegPath,
          buildBurnSubtitleArgs(currentPath, burnCaptionsPath, burnedPath, spec),
          {
            signal: options.signal,
            expectedDurationUs: plan.actualDurationUs,
            registerChild: options.registerChild,
            onProgress: (ratio) => options.onProgress?.({
              progress: 92 + Math.round(ratio * 7),
              stage: "烧录字幕",
            }),
          },
        );
        await fs.rm(currentPath, { force: true });
        currentPath = burnedPath;
      } catch (error) {
        await fs.rm(burnedPath, { force: true });
        const message = error instanceof Error ? error.message : String(error);
        if (/No such filter:\s*'subtitles'|Filter not found/i.test(message)) {
          effectiveSubtitleMode = "external";
          warnings.push("当前 FFmpeg 不支持字幕烧录，已输出外挂 SRT。");
          options.onProgress?.({
            progress: 99,
            stage: "字幕已降级",
            message: "当前 FFmpeg 不支持烧录，保留外挂 SRT",
          });
        } else {
          throw error;
        }
      }
    }

    ensureNotAborted(options.signal);
    await replaceFile(currentPath, outputPath);
    const manifest: ProxyRenderManifest = {
      version: 1,
      planId: plan.id,
      planVersion: plan.version,
      renderDigest,
      outputPath,
      ...(subtitleMode !== "none" && cues.length > 0 ? { captionsPath } : {}),
      durationUs: plan.actualDurationUs,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      subtitleMode: effectiveSubtitleMode,
      cacheHits,
      renderedSegments,
      ...(warnings.length > 0 ? { warnings } : {}),
      createdAt: now(),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    completed = true;
    options.onProgress?.({ progress: 100, stage: "完成" });
    return manifest;
  } finally {
    await Promise.all(temporaryPaths.map((filePath) => fs.rm(filePath, { force: true })));
    if (!completed) await fs.rm(captionsPath, { force: true });
  }
}
