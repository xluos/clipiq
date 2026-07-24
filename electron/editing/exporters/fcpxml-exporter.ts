import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AudioClip,
  EditPlan,
  VideoClip,
} from "../../../src/types";

const MICROSECONDS_PER_SECOND = 1_000_000;
const FCPXML_VERSION = "1.10";

export type FcpxmlExportWarning = {
  code:
    | "FCPXML_TRANSITION_DOWNGRADED"
    | "FCPXML_CROP_NOT_INCLUDED"
    | "FCPXML_TRANSFORM_NOT_INCLUDED"
    | "FCPXML_AUDIO_MIX_PARTIAL"
    | "FCPXML_OVERLAY_NOT_INCLUDED"
    | "FCPXML_CAPTIONS_AS_SRT"
    | "FCPXML_AUDIO_NOT_INCLUDED";
  message: string;
  itemId?: string;
};

export type FcpxmlExportResult = {
  xml: string;
  warnings: FcpxmlExportWarning[];
  refs: string[];
  durationUs: number;
};

export type FcpxmlExportOptions = {
  packagePath: string;
  projectName?: string;
};

type Resource = {
  id: string;
  relativePath: string;
  kind: "video" | "audio";
  durationUs: number;
  refs: string[];
};

type TimelineClip = {
  clip: VideoClip;
  timelineInUs: number;
  durationUs: number;
  resource: Resource;
  anchoredAudio: AudioClip[];
};

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

export function fcpxmlTime(timeUs: number): string {
  const numerator = Math.max(0, Math.round(timeUs));
  if (numerator === 0) return "0s";
  const divisor = gcd(numerator, MICROSECONDS_PER_SECOND);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = MICROSECONDS_PER_SECOND / divisor;
  return reducedDenominator === 1
    ? `${reducedNumerator}s`
    : `${reducedNumerator}/${reducedDenominator}s`;
}

function frameDuration(fps: number): string {
  if (!(Number.isFinite(fps) && fps > 0)) {
    throw new Error("FCPXML 导出需要有效帧率");
  }
  const scaledFps = Math.round(fps * MICROSECONDS_PER_SECOND);
  const divisor = gcd(MICROSECONDS_PER_SECOND, scaledFps);
  return `${MICROSECONDS_PER_SECOND / divisor}/${scaledFps / divisor}s`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clipDurationUs(clip: VideoClip): number {
  return Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
}

function volumeAdjustment(volume: number): string | null {
  if (!Number.isFinite(volume) || Math.abs(volume - 1) < 0.000_001) return null;
  const amount = volume <= 0
    ? -96
    : Math.max(-96, Math.min(12, 20 * Math.log10(volume)));
  return `<adjust-volume amount="${amount.toFixed(2)}dB"/>`;
}

function resourceKey(kind: Resource["kind"], relativePath: string): string {
  return `${kind}:${relativePath}`;
}

function collectResources(plan: EditPlan): {
  resources: Resource[];
  resourceByKey: Map<string, Resource>;
} {
  const resourceByKey = new Map<string, Resource>();
  const add = (
    kind: Resource["kind"],
    relativePath: string | undefined,
    durationUs: number,
    ref: string,
  ) => {
    if (!relativePath) return;
    const key = resourceKey(kind, relativePath);
    const existing = resourceByKey.get(key);
    if (existing) {
      existing.durationUs = Math.max(existing.durationUs, durationUs);
      existing.refs.push(ref);
      return;
    }
    resourceByKey.set(key, {
      id: "",
      relativePath,
      kind,
      durationUs,
      refs: [ref],
    });
  };

  for (const track of plan.tracks) {
    if (track.kind === "video") {
      for (const clip of track.items) {
        add("video", clip.sourcePath, clip.sourceOutUs, clip.id);
      }
    } else if (track.kind === "audio") {
      for (const clip of track.items) {
        add("audio", clip.sourcePath, clip.sourceOutUs, clip.id);
      }
    }
  }

  const resources = [...resourceByKey.values()]
    .sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || left.relativePath.localeCompare(right.relativePath))
    .map((resource, index) => ({
      ...resource,
      id: `r${index + 2}`,
      refs: [...new Set(resource.refs)].sort(),
    }));
  return {
    resources,
    resourceByKey: new Map(resources.map((resource) => [
      resourceKey(resource.kind, resource.relativePath),
      resource,
    ])),
  };
}

function audioRole(audio: AudioClip): string {
  if (audio.kind === "music") return "music";
  if (audio.kind === "voiceover") return "dialogue.voiceover";
  return "dialogue.original";
}

function renderAnchoredAudio(
  audio: AudioClip,
  parent: TimelineClip,
  resource: Resource,
  warnings: FcpxmlExportWarning[],
): string[] {
  const durationUs = audio.sourceOutUs - audio.sourceInUs;
  if (!(durationUs > 0)) {
    warnings.push({
      code: "FCPXML_AUDIO_NOT_INCLUDED",
      message: "音频区间无效，FCPXML 未包含该音频。",
      itemId: audio.id,
    });
    return [];
  }
  if (
    (audio.fadeInUs || 0) > 0
    || (audio.fadeOutUs || 0) > 0
    || audio.ducking?.enabled
  ) {
    warnings.push({
      code: "FCPXML_AUDIO_MIX_PARTIAL",
      message: "FCPXML 保留了音频位置和音量，但淡入淡出与自动压低仍需在剪辑软件中确认。",
      itemId: audio.id,
    });
  }
  const parentLocalOffsetUs = parent.clip.sourceInUs
    + Math.round((audio.timelineInUs - parent.clip.timelineInUs) * parent.clip.speed);
  const adjustment = volumeAdjustment(audio.volume);
  const attributes = [
    `name="${escapeXml(path.basename(resource.relativePath))}"`,
    `ref="${resource.id}"`,
    `lane="-1"`,
    `offset="${fcpxmlTime(parentLocalOffsetUs)}"`,
    `start="${fcpxmlTime(audio.sourceInUs)}"`,
    `duration="${fcpxmlTime(durationUs)}"`,
    `srcEnable="audio"`,
    `audioRole="${audioRole(audio)}"`,
  ].join(" ");
  if (!adjustment) return [`<asset-clip ${attributes}/>`];
  return [
    `<asset-clip ${attributes}>`,
    `  ${adjustment}`,
    "</asset-clip>",
  ];
}

function renderVideoClip(
  timelineClip: TimelineClip,
  resourceByKey: Map<string, Resource>,
  warnings: FcpxmlExportWarning[],
): string[] {
  const {
    clip,
    timelineInUs,
    durationUs,
    resource,
  } = timelineClip;
  const attributes = [
    `name="${escapeXml(path.basename(resource.relativePath))}"`,
    `ref="${resource.id}"`,
    `offset="${fcpxmlTime(timelineInUs)}"`,
    `start="${fcpxmlTime(clip.sourceInUs)}"`,
    `duration="${fcpxmlTime(durationUs)}"`,
    `srcEnable="all"`,
    `audioRole="dialogue.original"`,
  ].join(" ");
  const children: string[] = [];
  if (Math.abs(clip.speed - 1) > 0.000_001) {
    children.push(
      '<timeMap frameSampling="frame-blending" preservesPitch="1">',
      `  <timept time="${fcpxmlTime(clip.sourceInUs)}" value="${fcpxmlTime(clip.sourceInUs)}" interp="linear"/>`,
      `  <timept time="${fcpxmlTime(clip.sourceInUs + durationUs)}" value="${fcpxmlTime(clip.sourceOutUs)}" interp="linear"/>`,
      "</timeMap>",
    );
  }
  const adjustment = volumeAdjustment(clip.volume);
  if (adjustment) children.push(adjustment);
  for (const audio of timelineClip.anchoredAudio) {
    if (!audio.sourcePath) continue;
    const audioResource = resourceByKey.get(resourceKey("audio", audio.sourcePath));
    if (!audioResource) continue;
    children.push(...renderAnchoredAudio(audio, timelineClip, audioResource, warnings));
  }
  if (children.length === 0) return [`<asset-clip ${attributes}/>`];
  return [
    `<asset-clip ${attributes}>`,
    ...children.map((line) => `  ${line}`),
    "</asset-clip>",
  ];
}

function buildTimeline(
  plan: EditPlan,
  resourceByKey: Map<string, Resource>,
  warnings: FcpxmlExportWarning[],
): TimelineClip[] {
  const videoClips = plan.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.items)
    .sort((left, right) =>
      left.timelineInUs - right.timelineInUs || left.id.localeCompare(right.id));
  const timeline: TimelineClip[] = [];
  let cursorUs = 0;
  for (const clip of videoClips) {
    const durationUs = clipDurationUs(clip);
    const resource = resourceByKey.get(resourceKey("video", clip.sourcePath));
    if (!resource || durationUs <= 0) continue;
    const timelineInUs = Math.max(cursorUs, clip.timelineInUs);
    timeline.push({
      clip,
      timelineInUs,
      durationUs,
      resource,
      anchoredAudio: [],
    });
    cursorUs = timelineInUs + durationUs;
  }

  const audioClips = plan.tracks
    .filter((track) => track.kind === "audio")
    .flatMap((track) => track.items)
    .filter((audio) => audio.sourcePath);
  for (const audio of audioClips) {
    const parent = (
      audio.anchorClipId
        ? timeline.find((item) => item.clip.id === audio.anchorClipId)
        : undefined
    ) || timeline.find((item) =>
      audio.timelineInUs >= item.clip.timelineInUs
      && audio.timelineInUs < item.clip.timelineInUs + item.durationUs);
    if (!parent) {
      warnings.push({
        code: "FCPXML_AUDIO_NOT_INCLUDED",
        message: "音频起点不在主视频时间线内，FCPXML 未包含该音频。",
        itemId: audio.id,
      });
      continue;
    }
    parent.anchoredAudio.push(audio);
  }
  return timeline;
}

function collectFeatureWarnings(
  plan: EditPlan,
  warnings: FcpxmlExportWarning[],
): void {
  for (const transition of plan.transitions) {
    if (transition.type === "cut") continue;
    warnings.push({
      code: "FCPXML_TRANSITION_DOWNGRADED",
      message: "FCPXML 将未验证的非硬切转场降级为硬切，时间线可能相应延长。",
      itemId: transition.id,
    });
  }
  let hasOverlay = false;
  let hasCaption = false;
  for (const track of plan.tracks) {
    if (track.kind === "video") {
      for (const clip of track.items) {
        if (clip.crop) {
          warnings.push({
            code: "FCPXML_CROP_NOT_INCLUDED",
            message: "FCPXML 未写入像素裁切；代理预览仍保留 ClipIQ 的人物构图结果。",
            itemId: clip.id,
          });
        }
        if (clip.transform) {
          warnings.push({
            code: "FCPXML_TRANSFORM_NOT_INCLUDED",
            message: "FCPXML 未写入该片段的变换参数。",
            itemId: clip.id,
          });
        }
      }
    } else if (track.kind === "overlay" && track.items.length > 0) {
      hasOverlay = true;
    } else if (track.kind === "caption" && track.items.length > 0) {
      hasCaption = true;
    }
  }
  if (hasOverlay) {
    warnings.push({
      code: "FCPXML_OVERLAY_NOT_INCLUDED",
      message: "FCPXML 暂不包含贴图和花字，相关资源仍保留在素材包中。",
    });
  }
  if (hasCaption) {
    warnings.push({
      code: "FCPXML_CAPTIONS_AS_SRT",
      message: "字幕以 captions.srt 交付，暂未写入 FCPXML 字幕轨。",
    });
  }
}

export function renderEditPlanFcpxml(
  plan: EditPlan,
  options: FcpxmlExportOptions,
): FcpxmlExportResult {
  if (!plan?.id) throw new Error("FCPXML 导出需要有效的 EditPlan");
  const packagePath = path.resolve(options.packagePath || "");
  const projectName = options.projectName?.trim()
    || `ClipIQ ${plan.id} r${plan.revision || 1}`;
  const warnings: FcpxmlExportWarning[] = [];
  const {
    resources,
    resourceByKey,
  } = collectResources(plan);
  const timeline = buildTimeline(plan, resourceByKey, warnings);
  if (timeline.length === 0) throw new Error("FCPXML 导出需要至少一个有效视频片段");
  collectFeatureWarnings(plan, warnings);

  const resourceLines = resources.flatMap((resource) => {
    const absolutePath = path.join(
      packagePath,
      ...resource.relativePath.split("/"),
    );
    const mediaUrl = escapeXml(pathToFileURL(absolutePath).href);
    return [
      `    <asset id="${resource.id}" name="${escapeXml(path.basename(resource.relativePath))}" start="0s" duration="${fcpxmlTime(resource.durationUs)}" ${resource.kind === "video" ? 'hasVideo="1"' : 'hasAudio="1"'}>`,
      `      <media-rep kind="original-media" src="${mediaUrl}"/>`,
      "    </asset>",
    ];
  });

  const spineLines: string[] = [];
  let cursorUs = 0;
  for (const item of timeline) {
    if (item.timelineInUs > cursorUs) {
      spineLines.push(
        `        <gap name="ClipIQ Gap" offset="${fcpxmlTime(cursorUs)}" start="0s" duration="${fcpxmlTime(item.timelineInUs - cursorUs)}"/>`,
      );
    }
    spineLines.push(
      ...renderVideoClip(item, resourceByKey, warnings)
        .map((line) => `        ${line}`),
    );
    cursorUs = item.timelineInUs + item.durationUs;
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    `<fcpxml version="${FCPXML_VERSION}">`,
    "  <resources>",
    `    <format id="r1" frameDuration="${frameDuration(plan.canvas.fps)}" width="${Math.round(plan.canvas.width)}" height="${Math.round(plan.canvas.height)}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...resourceLines,
    "  </resources>",
    `  <project name="${escapeXml(projectName)}">`,
    `    <sequence format="r1" duration="${fcpxmlTime(cursorUs)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    "      <spine>",
    ...spineLines,
    "      </spine>",
    "    </sequence>",
    "  </project>",
    "</fcpxml>",
    "",
  ].join("\n");

  return {
    xml,
    warnings,
    refs: [...new Set(resources.flatMap((resource) => resource.refs))].sort(),
    durationUs: cursorUs,
  };
}
