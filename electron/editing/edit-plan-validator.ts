import type {
  AudioClip,
  CaptionCue,
  EditPlan,
  EditPlanIssue,
  OverlayItem,
  VideoClip,
} from "../../src/types";

export type ShotValidationSource = {
  shotId: string;
  videoId: string;
  sourcePath: string;
  startUs: number;
  endUs: number;
};

export type EditPlanValidationOptions = {
  shots?: Map<string, ShotValidationSource>;
  sourceExists?: (sourcePath: string) => boolean;
  durationToleranceRatio?: number;
};

type IssueTarget = {
  warnings: EditPlanIssue[];
  errors: EditPlanIssue[];
};

function add(
  target: IssueTarget,
  severity: "warning" | "error",
  code: string,
  message: string,
  path?: string,
  meta?: Record<string, unknown>,
): void {
  target[severity === "error" ? "errors" : "warnings"].push({
    code,
    message,
    ...(path ? { path } : {}),
    ...(meta ? { meta } : {}),
  });
}

function validIntegerTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateTimeRange(
  target: IssueTarget,
  start: unknown,
  end: unknown,
  path: string,
): boolean {
  if (!validIntegerTime(start) || !validIntegerTime(end)) {
    add(target, "error", "TIME_NOT_INTEGER_US", "时间必须是非负整数微秒。", path);
    return false;
  }
  if (end <= start) {
    add(target, "error", "INVALID_TIME_RANGE", "结束时间必须晚于开始时间。", path);
    return false;
  }
  return true;
}

function validateClip(
  target: IssueTarget,
  clip: VideoClip,
  path: string,
  options: EditPlanValidationOptions,
): number {
  const rangeValid = validateTimeRange(
    target,
    clip.sourceInUs,
    clip.sourceOutUs,
    `${path}.source`,
  );
  if (!validIntegerTime(clip.timelineInUs)) {
    add(target, "error", "TIMELINE_NOT_INTEGER_US", "时间线位置必须是非负整数微秒。", `${path}.timelineInUs`);
  }
  if (!clip.shotId) add(target, "error", "MISSING_SHOT_ID", "视频片段缺少 shotId。", `${path}.shotId`);
  if (!clip.videoId) add(target, "error", "MISSING_VIDEO_ID", "视频片段缺少 videoId。", `${path}.videoId`);
  if (!clip.sourcePath) {
    add(target, "error", "MISSING_SOURCE_PATH", "视频片段缺少本地素材路径。", `${path}.sourcePath`);
  } else if (options.sourceExists && !options.sourceExists(clip.sourcePath)) {
    add(target, "error", "SOURCE_NOT_FOUND", "视频素材文件不存在。", `${path}.sourcePath`, {
      sourcePath: clip.sourcePath,
    });
  }
  if (!(Number.isFinite(clip.speed) && clip.speed > 0)) {
    add(target, "error", "INVALID_SPEED", "播放速度必须大于 0。", `${path}.speed`);
  }
  if (!(Number.isFinite(clip.volume) && clip.volume >= 0)) {
    add(target, "error", "INVALID_VOLUME", "音量必须是非负数。", `${path}.volume`);
  }
  if (!(Number.isFinite(clip.confidence) && clip.confidence >= 0 && clip.confidence <= 1)) {
    add(target, "error", "INVALID_CONFIDENCE", "选择置信度必须在 0 到 1 之间。", `${path}.confidence`);
  }

  const source = options.shots?.get(clip.shotId);
  if (source) {
    if (clip.videoId !== source.videoId) {
      add(target, "error", "SHOT_VIDEO_MISMATCH", "shotId 与 videoId 不属于同一素材。", path);
    }
    if (clip.sourcePath !== source.sourcePath) {
      add(target, "error", "SHOT_PATH_MISMATCH", "片段路径与 Shot 来源不一致。", `${path}.sourcePath`);
    }
    if (
      rangeValid
      && (clip.sourceInUs < source.startUs || clip.sourceOutUs > source.endUs)
    ) {
      add(target, "error", "SOURCE_OUTSIDE_SHOT", "片段时间超出了真实 Shot 范围。", `${path}.source`, {
        shotStartUs: source.startUs,
        shotEndUs: source.endUs,
      });
    }
  } else if (options.shots) {
    add(target, "error", "UNKNOWN_SHOT", "片段引用了不存在的 Shot。", `${path}.shotId`, {
      shotId: clip.shotId,
    });
  }

  for (const [index, segment] of (clip.evidence?.subtitleSegments || []).entries()) {
    const segmentPath = `${path}.evidence.subtitleSegments[${index}]`;
    if (!validateTimeRange(target, segment.startUs, segment.endUs, segmentPath)) continue;
    if (
      rangeValid
      && (segment.startUs < clip.sourceInUs || segment.endUs > clip.sourceOutUs)
    ) {
      add(target, "error", "SUBTITLE_OUTSIDE_CLIP", "字幕证据超出了片段来源范围。", segmentPath);
    }
  }

  if (!rangeValid || !(Number.isFinite(clip.speed) && clip.speed > 0)) return 0;
  return Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
}

function validateCaption(target: IssueTarget, cue: CaptionCue, path: string): void {
  const rangeValid = validateTimeRange(target, cue.startUs, cue.endUs, path);
  if (!cue.text.trim()) add(target, "warning", "EMPTY_CAPTION", "字幕文本为空。", `${path}.text`);
  for (const [index, word] of (cue.wordTimings || []).entries()) {
    const wordPath = `${path}.wordTimings[${index}]`;
    if (!validateTimeRange(target, word.startUs, word.endUs, wordPath)) continue;
    if (rangeValid && (word.startUs < cue.startUs || word.endUs > cue.endUs)) {
      add(target, "error", "WORD_OUTSIDE_CAPTION", "词级时间超出了字幕范围。", wordPath);
    }
  }
}

export function validateEditPlan(
  plan: EditPlan,
  options: EditPlanValidationOptions = {},
): EditPlan["validation"] {
  const target: IssueTarget = { warnings: [], errors: [] };
  if (!plan || typeof plan !== "object") {
    add(target, "error", "INVALID_PLAN", "EditPlan 不是有效对象。");
    return { valid: false, ...target };
  }
  if (plan.version !== 1) {
    add(target, "error", "UNSUPPORTED_VERSION", "不支持的 EditPlan schema 版本。", "version");
  }
  if (!plan.id) add(target, "error", "MISSING_PLAN_ID", "EditPlan 缺少 id。", "id");
  if (!plan.sessionId) add(target, "error", "MISSING_SESSION_ID", "EditPlan 缺少 sessionId。", "sessionId");
  if (
    !Number.isInteger(plan.canvas?.width)
    || plan.canvas.width <= 0
    || !Number.isInteger(plan.canvas?.height)
    || plan.canvas.height <= 0
    || !(Number.isFinite(plan.canvas?.fps) && plan.canvas.fps > 0)
  ) {
    add(target, "error", "INVALID_CANVAS", "画布宽高和帧率必须为正数。", "canvas");
  }
  if (!validIntegerTime(plan.targetDurationUs) || plan.targetDurationUs <= 0) {
    add(target, "error", "INVALID_TARGET_DURATION", "目标时长必须是正整数微秒。", "targetDurationUs");
  }
  if (!validIntegerTime(plan.actualDurationUs)) {
    add(target, "error", "INVALID_ACTUAL_DURATION", "实际时长必须是非负整数微秒。", "actualDurationUs");
  }

  const seenTrackIds = new Set<string>();
  const seenItemIds = new Set<string>();
  const videoClips: VideoClip[] = [];
  let computedDurationUs = 0;

  for (const [trackIndex, track] of (plan.tracks || []).entries()) {
    const trackPath = `tracks[${trackIndex}]`;
    if (!track.id || seenTrackIds.has(track.id)) {
      add(target, "error", "DUPLICATE_TRACK_ID", "轨道 ID 为空或重复。", `${trackPath}.id`);
    }
    seenTrackIds.add(track.id);

    let previousEndUs = 0;
    for (const [itemIndex, item] of (track.items || []).entries()) {
      const itemPath = `${trackPath}.items[${itemIndex}]`;
      if (!item.id || seenItemIds.has(item.id)) {
        add(target, "error", "DUPLICATE_ITEM_ID", "时间线项目 ID 为空或重复。", `${itemPath}.id`);
      }
      seenItemIds.add(item.id);

      if (track.kind === "video") {
        const clip = item as VideoClip;
        const durationUs = validateClip(target, clip, itemPath, options);
        const endUs = validIntegerTime(clip.timelineInUs)
          ? clip.timelineInUs + durationUs
          : previousEndUs;
        if (clip.timelineInUs < previousEndUs) {
          add(target, "error", "VIDEO_TRACK_OVERLAP", "同一视频轨道上的片段发生重叠。", itemPath);
        }
        previousEndUs = Math.max(previousEndUs, endUs);
        computedDurationUs = Math.max(computedDurationUs, endUs);
        videoClips.push(clip);
      } else if (track.kind === "caption") {
        validateCaption(target, item as CaptionCue, itemPath);
      } else if (track.kind === "audio") {
        const audio = item as AudioClip;
        if (!validIntegerTime(audio.timelineInUs)) {
          add(target, "error", "AUDIO_TIMELINE_NOT_INTEGER_US", "音频位置必须是非负整数微秒。", `${itemPath}.timelineInUs`);
        }
        validateTimeRange(target, audio.sourceInUs, audio.sourceOutUs, `${itemPath}.source`);
      } else if (track.kind === "overlay") {
        const overlay = item as OverlayItem;
        validateTimeRange(target, overlay.startUs, overlay.endUs, itemPath);
      }
    }
  }

  if (videoClips.length === 0) {
    add(target, "error", "EMPTY_VIDEO_TRACK", "EditPlan 没有可渲染的视频片段。", "tracks");
  }
  if (computedDurationUs !== plan.actualDurationUs) {
    add(target, "error", "ACTUAL_DURATION_MISMATCH", "actualDurationUs 与视频轨道计算结果不一致。", "actualDurationUs", {
      expected: computedDurationUs,
      actual: plan.actualDurationUs,
    });
  }

  const clipIndex = new Map(videoClips.map((clip, index) => [clip.id, index]));
  const transitionIds = new Set<string>();
  for (const [index, transition] of (plan.transitions || []).entries()) {
    const path = `transitions[${index}]`;
    if (!transition.id || transitionIds.has(transition.id)) {
      add(target, "error", "DUPLICATE_TRANSITION_ID", "转场 ID 为空或重复。", `${path}.id`);
    }
    transitionIds.add(transition.id);
    const fromIndex = clipIndex.get(transition.fromClipId);
    const toIndex = clipIndex.get(transition.toClipId);
    if (fromIndex == null || toIndex == null) {
      add(target, "error", "UNKNOWN_TRANSITION_CLIP", "转场引用了不存在的视频片段。", path);
    } else if (toIndex !== fromIndex + 1) {
      add(target, "error", "NON_ADJACENT_TRANSITION", "转场只能连接相邻视频片段。", path);
    }
    if (!validIntegerTime(transition.durationUs)) {
      add(target, "error", "INVALID_TRANSITION_DURATION", "转场时长必须是非负整数微秒。", `${path}.durationUs`);
    } else if (transition.type === "cut" && transition.durationUs !== 0) {
      add(target, "error", "CUT_HAS_DURATION", "硬切转场时长必须为 0。", `${path}.durationUs`);
    }
  }

  if (validIntegerTime(plan.targetDurationUs) && plan.targetDurationUs > 0) {
    const tolerance = options.durationToleranceRatio ?? 0.05;
    const ratio = Math.abs(plan.actualDurationUs - plan.targetDurationUs) / plan.targetDurationUs;
    if (ratio > tolerance) {
      add(target, "warning", "TARGET_DURATION_MISS", "实际时长与目标时长偏差超过容差。", "actualDurationUs", {
        targetDurationUs: plan.targetDurationUs,
        actualDurationUs: plan.actualDurationUs,
        tolerance,
      });
    }
  }

  return {
    valid: target.errors.length === 0,
    warnings: target.warnings,
    errors: target.errors,
  };
}
