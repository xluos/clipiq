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
  if (!clip.candidateId) {
    add(
      target,
      "warning",
      "LEGACY_CANDIDATE_ID_MISSING",
      "旧粗剪片段缺少 candidateId，重新生成或替换后将补齐。",
      `${path}.candidateId`,
    );
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

  for (const [index, segment] of (clip.evidence?.eventSegments || []).entries()) {
    const segmentPath = `${path}.evidence.eventSegments[${index}]`;
    if (!validateTimeRange(target, segment.startUs, segment.endUs, segmentPath)) continue;
    if (
      rangeValid
      && (segment.startUs < clip.sourceInUs || segment.endUs > clip.sourceOutUs)
    ) {
      add(target, "error", "EVENT_OUTSIDE_CLIP", "事件语义证据超出了片段来源范围。", segmentPath);
    }
    if (!segment.summary.trim()) {
      add(target, "error", "EVENT_SUMMARY_MISSING", "事件语义证据缺少摘要。", `${segmentPath}.summary`);
    }
    if (segment.granularity !== "shot" && segment.granularity !== "segment") {
      add(target, "error", "EVENT_GRANULARITY_INVALID", "事件语义粒度无效。", `${segmentPath}.granularity`);
    }
    if (segment.source !== "analysis_node" && segment.source !== "shot_description") {
      add(target, "error", "EVENT_SOURCE_INVALID", "事件语义来源无效。", `${segmentPath}.source`);
    }
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
  const alignedSegments = clip.evidence?.alignedSegments;
  if (alignedSegments) {
    const appearanceById = new Map(
      (clip.evidence?.personAppearances || []).map((appearance) => [
        appearance.appearanceId,
        appearance,
      ]),
    );
    const speakerTrackById = new Map(
      (clip.evidence?.speakerTracks || []).map((track) => [track.trackId, track]),
    );
    let expectedStartUs = clip.sourceInUs;
    for (const [index, segment] of alignedSegments.entries()) {
      const segmentPath = `${path}.evidence.alignedSegments[${index}]`;
      if (!validateTimeRange(target, segment.startUs, segment.endUs, segmentPath)) continue;
      if (
        rangeValid
        && (segment.startUs < clip.sourceInUs || segment.endUs > clip.sourceOutUs)
      ) {
        add(target, "error", "ALIGNED_EVIDENCE_OUTSIDE_CLIP", "对齐证据超出了片段来源范围。", segmentPath);
      }
      if (segment.eventSummary && clip.evidence?.eventSegments?.length) {
        const matchedEvent = clip.evidence.eventSegments.some((event) =>
          event.summary === segment.eventSummary
          && event.granularity === segment.eventGranularity
          && event.startUs < segment.endUs
          && event.endUs > segment.startUs);
        if (!matchedEvent) {
          add(
            target,
            "error",
            "ALIGNED_EVENT_REFERENCE_INVALID",
            "对齐证据引用了不存在或粒度不一致的事件语义分段。",
            `${segmentPath}.eventSummary`,
          );
        }
      }
      if (segment.startUs !== expectedStartUs) {
        add(
          target,
          "error",
          segment.startUs < expectedStartUs
            ? "ALIGNED_EVIDENCE_OVERLAP"
            : "ALIGNED_EVIDENCE_GAP",
          segment.startUs < expectedStartUs
            ? "相邻对齐证据存在重叠。"
            : "相邻对齐证据存在空白。",
          segmentPath,
          { expectedStartUs, actualStartUs: segment.startUs },
        );
      }
      expectedStartUs = segment.endUs;
      for (const [personIndex, person] of segment.visiblePeople.entries()) {
        const personPath = `${segmentPath}.visiblePeople[${personIndex}]`;
        const appearance = appearanceById.get(person.appearanceId);
        if (!appearance || appearance.trackId !== person.trackId) {
          add(
            target,
            "error",
            "ALIGNED_PERSON_REFERENCE_INVALID",
            "对齐证据引用了不存在或不匹配的人物出镜记录。",
            personPath,
          );
        } else if (person.personId && appearance.personId !== person.personId) {
          add(
            target,
            "error",
            "ALIGNED_PERSON_ID_MISMATCH",
            "对齐证据中的人物身份与出镜记录不一致。",
            personPath,
          );
        }
      }
      for (const [speakerIndex, speaker] of segment.activeSpeakers.entries()) {
        const speakerPath = `${segmentPath}.activeSpeakers[${speakerIndex}]`;
        const track = speakerTrackById.get(speaker.trackId);
        if (!track || track.speakerId !== speaker.speakerId) {
          add(
            target,
            "error",
            "ALIGNED_SPEAKER_REFERENCE_INVALID",
            "对齐证据引用了不存在或不匹配的说话人轨迹。",
            speakerPath,
          );
        } else if (speaker.personId && track.personId !== speaker.personId) {
          add(
            target,
            "error",
            "ALIGNED_SPEAKER_PERSON_MISMATCH",
            "对齐证据中的说话人物身份与说话人轨迹不一致。",
            speakerPath,
          );
        }
      }
    }
    if (alignedSegments.length === 0 || expectedStartUs !== clip.sourceOutUs) {
      add(
        target,
        "error",
        "ALIGNED_EVIDENCE_INCOMPLETE",
        "对齐证据必须连续覆盖整个片段来源范围。",
        `${path}.evidence.alignedSegments`,
        { expectedEndUs: clip.sourceOutUs, actualEndUs: expectedStartUs },
      );
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

function validateBeatAnalysis(
  target: IssueTarget,
  analysis: NonNullable<AudioClip["beatAnalysis"]>,
  path: string,
): void {
  const rangeValid = validateTimeRange(
    target,
    analysis.analyzedStartUs,
    analysis.analyzedEndUs,
    `${path}.range`,
  );
  if (analysis.algorithmVersion !== "energy-onset-v1") {
    add(target, "error", "UNSUPPORTED_BEAT_ALGORITHM", "不支持的节拍分析算法版本。", `${path}.algorithmVersion`);
  }
  if (!["usable", "low_confidence", "insufficient_audio"].includes(analysis.status)) {
    add(target, "error", "INVALID_BEAT_STATUS", "节拍分析状态无效。", `${path}.status`);
  }
  if (!Number.isSafeInteger(analysis.sampleRate) || analysis.sampleRate < 8_000) {
    add(target, "error", "INVALID_BEAT_SAMPLE_RATE", "节拍分析采样率无效。", `${path}.sampleRate`);
  }
  if (
    !Number.isFinite(analysis.confidence)
    || analysis.confidence < 0
    || analysis.confidence > 1
  ) {
    add(target, "error", "INVALID_BEAT_CONFIDENCE", "节拍置信度必须在 0 到 1 之间。", `${path}.confidence`);
  }
  const beatTimesUs = Array.isArray(analysis.beatTimesUs) ? analysis.beatTimesUs : [];
  if (!Array.isArray(analysis.beatTimesUs)) {
    add(target, "error", "INVALID_BEAT_TIMES", "节拍点必须是数组。", `${path}.beatTimesUs`);
  }
  if (
    analysis.status === "usable"
    && (!(Number.isFinite(analysis.bpm) && Number(analysis.bpm) > 0)
      || beatTimesUs.length < 2)
  ) {
    add(target, "error", "INCOMPLETE_USABLE_BEAT_GRID", "可用节拍必须包含 BPM 和至少两个节拍点。", path);
  }
  let previousBeatUs = -1;
  for (const [index, beatTimeUs] of beatTimesUs.entries()) {
    const beatPath = `${path}.beatTimesUs[${index}]`;
    if (!validIntegerTime(beatTimeUs)) {
      add(target, "error", "INVALID_BEAT_TIME", "节拍点必须是非负整数微秒。", beatPath);
      continue;
    }
    if (beatTimeUs <= previousBeatUs) {
      add(target, "error", "UNSORTED_BEAT_TIMES", "节拍点必须严格递增。", beatPath);
    }
    if (
      rangeValid
      && (beatTimeUs < analysis.analyzedStartUs || beatTimeUs > analysis.analyzedEndUs)
    ) {
      add(target, "error", "BEAT_OUTSIDE_ANALYSIS", "节拍点超出了分析范围。", beatPath);
    }
    previousBeatUs = beatTimeUs;
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
  if (
    plan.revision != null
    && (!Number.isSafeInteger(plan.revision) || plan.revision < 1)
  ) {
    add(target, "error", "INVALID_REVISION", "EditPlan revision 必须是正整数。", "revision");
  }
  if (plan.parentPlanId != null && !plan.parentPlanId.trim()) {
    add(target, "error", "INVALID_PARENT_PLAN_ID", "父版本 ID 不能为空。", "parentPlanId");
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
  const audioClips: AudioClip[] = [];
  const videoClipDurationUs = new Map<string, number>();
  const captionCues: CaptionCue[] = [];
  let computedDurationUs = 0;

  for (const [trackIndex, track] of (plan.tracks || []).entries()) {
    const trackPath = `tracks[${trackIndex}]`;
    if (!track.id || seenTrackIds.has(track.id)) {
      add(target, "error", "DUPLICATE_TRACK_ID", "轨道 ID 为空或重复。", `${trackPath}.id`);
    }
    seenTrackIds.add(track.id);

    let previousEndUs = 0;
    let previousVideoClip: VideoClip | undefined;
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
        const previousClip = previousVideoClip;
        if (clip.timelineInUs < previousEndUs) {
          const overlapUs = previousEndUs - clip.timelineInUs;
          const boundary = previousClip
            ? (plan.transitions || []).find((transition) =>
              transition.fromClipId === previousClip.id
              && transition.toClipId === clip.id)
            : undefined;
          if (
            !boundary
            || boundary.type === "cut"
            || boundary.durationUs !== overlapUs
          ) {
            add(
              target,
              "error",
              "VIDEO_TRACK_OVERLAP",
              "视频片段重叠必须与相邻叠化转场时长一致。",
              itemPath,
              { overlapUs },
            );
          }
        } else if (previousClip && clip.timelineInUs > previousEndUs) {
          add(
            target,
            "error",
            "VIDEO_TRACK_GAP",
            "视频轨道存在空白时间，代理预览无法确定画面内容。",
            itemPath,
            { gapUs: clip.timelineInUs - previousEndUs },
          );
        }
        previousEndUs = Math.max(previousEndUs, endUs);
        computedDurationUs = Math.max(computedDurationUs, endUs);
        videoClips.push(clip);
        videoClipDurationUs.set(clip.id, durationUs);
        previousVideoClip = clip;
      } else if (track.kind === "caption") {
        const cue = item as CaptionCue;
        validateCaption(target, cue, itemPath);
        captionCues.push(cue);
      } else if (track.kind === "audio") {
        const audio = item as AudioClip;
        audioClips.push(audio);
        if (!validIntegerTime(audio.timelineInUs)) {
          add(target, "error", "AUDIO_TIMELINE_NOT_INTEGER_US", "音频位置必须是非负整数微秒。", `${itemPath}.timelineInUs`);
        }
        const audioRangeValid = validateTimeRange(
          target,
          audio.sourceInUs,
          audio.sourceOutUs,
          `${itemPath}.source`,
        );
        if (
          !(Number.isFinite(audio.volume) && audio.volume >= 0 && audio.volume <= 4)
        ) {
          add(target, "error", "INVALID_AUDIO_VOLUME", "音轨音量必须在 0 到 4 之间。", `${itemPath}.volume`);
        }
        if (audio.kind !== "voiceover" && !audio.sourcePath) {
          add(target, "error", "MISSING_AUDIO_SOURCE", "音轨缺少本地音频路径。", `${itemPath}.sourcePath`);
        } else if (audio.kind === "voiceover" && !audio.ttsText?.trim()) {
          add(target, "error", "MISSING_VOICEOVER_TEXT", "旁白缺少合成文本。", `${itemPath}.ttsText`);
        } else if (audio.kind === "voiceover" && !audio.sourcePath) {
          add(target, "warning", "VOICEOVER_NOT_SYNTHESIZED", "旁白尚未合成音频，预览将跳过该段旁白。", itemPath);
        } else if (
          audio.sourcePath
          && options.sourceExists
          && !options.sourceExists(audio.sourcePath)
        ) {
          add(target, "error", "AUDIO_SOURCE_NOT_FOUND", "音频文件不存在。", `${itemPath}.sourcePath`);
        }
        if (
          audio.fadeInUs != null
          && (!validIntegerTime(audio.fadeInUs)
            || (audioRangeValid && audio.fadeInUs > audio.sourceOutUs - audio.sourceInUs))
        ) {
          add(target, "error", "INVALID_AUDIO_FADE_IN", "音轨淡入时长无效。", `${itemPath}.fadeInUs`);
        }
        if (
          audio.fadeOutUs != null
          && (!validIntegerTime(audio.fadeOutUs)
            || (audioRangeValid && audio.fadeOutUs > audio.sourceOutUs - audio.sourceInUs))
        ) {
          add(target, "error", "INVALID_AUDIO_FADE_OUT", "音轨淡出时长无效。", `${itemPath}.fadeOutUs`);
        }
        if (audio.beatAnalysis) {
          validateBeatAnalysis(target, audio.beatAnalysis, `${itemPath}.beatAnalysis`);
        }
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
  const videoClipById = new Map(videoClips.map((clip) => [clip.id, clip]));
  for (const audio of audioClips) {
    if (audio.kind === "voiceover") {
      const anchor = audio.anchorClipId
        ? videoClipById.get(audio.anchorClipId)
        : undefined;
      const voiceoverPath = `audio.${audio.id}`;
      if (!audio.anchorClipId) {
        add(target, "error", "VOICEOVER_ANCHOR_MISSING", "旁白缺少锚定的视频片段。", `${voiceoverPath}.anchorClipId`);
      } else if (!anchor) {
        add(target, "error", "VOICEOVER_ANCHOR_INVALID", "旁白引用了不存在的视频片段。", `${voiceoverPath}.anchorClipId`);
      } else {
        if (audio.timelineInUs !== anchor.timelineInUs) {
          add(target, "error", "VOICEOVER_TIMELINE_STALE", "旁白位置与锚定镜头不一致。", `${voiceoverPath}.timelineInUs`);
        }
        const maximumDurationUs = videoClipDurationUs.get(anchor.id) || 0;
        const voiceoverDurationUs = audio.sourceOutUs - audio.sourceInUs;
        if (voiceoverDurationUs > maximumDurationUs) {
          add(target, "error", "VOICEOVER_TOO_LONG", "旁白时长超过锚定镜头。", voiceoverPath, {
            maximumDurationUs,
            voiceoverDurationUs,
          });
        }
      }
    }
    for (const [index, suggestion] of (audio.beatSyncSuggestions || []).entries()) {
      const suggestionPath = `audio.${audio.id}.beatSyncSuggestions[${index}]`;
      const fromIndex = clipIndex.get(suggestion.fromClipId);
      const toIndex = clipIndex.get(suggestion.toClipId);
      if (
        fromIndex == null
        || toIndex == null
        || toIndex !== fromIndex + 1
      ) {
        add(target, "error", "BEAT_SUGGESTION_CLIPS_INVALID", "卡点建议必须引用相邻镜头。", suggestionPath);
        continue;
      }
      const toClip = videoClips[toIndex];
      const transition = (plan.transitions || []).find((item) =>
        item.fromClipId === suggestion.fromClipId
        && item.toClipId === suggestion.toClipId);
      if (transition && transition.type !== "cut") {
        add(target, "error", "BEAT_SUGGESTION_TRANSITION_INVALID", "卡点建议只能引用硬切边界。", suggestionPath);
      }
      if (
        !validIntegerTime(suggestion.boundaryTimeUs)
        || suggestion.boundaryTimeUs !== toClip.timelineInUs
      ) {
        add(target, "error", "BEAT_SUGGESTION_BOUNDARY_STALE", "卡点建议与当前镜头边界不一致。", suggestionPath);
      }
      if (
        !validIntegerTime(suggestion.beatTimeUs)
        || !Number.isSafeInteger(suggestion.offsetUs)
        || suggestion.beatTimeUs - suggestion.boundaryTimeUs !== suggestion.offsetUs
      ) {
        add(target, "error", "BEAT_SUGGESTION_OFFSET_INVALID", "卡点建议偏移量无效。", suggestionPath);
      }
      if (
        !Number.isFinite(suggestion.confidence)
        || suggestion.confidence < 0
        || suggestion.confidence > 1
      ) {
        add(target, "error", "BEAT_SUGGESTION_CONFIDENCE_INVALID", "卡点建议置信度无效。", `${suggestionPath}.confidence`);
      }
    }
  }
  for (const [index, cue] of captionCues.entries()) {
    if (!cue.sourceClipId) continue;
    const cuePath = `captionCues[${index}]`;
    const clip = videoClipById.get(cue.sourceClipId);
    if (!clip) {
      add(target, "error", "CAPTION_SOURCE_CLIP_MISSING", "字幕引用了不存在的视频片段。", cuePath);
      continue;
    }
    if (
      !validIntegerTime(cue.sourceStartUs)
      || !validIntegerTime(cue.sourceEndUs)
      || cue.sourceEndUs <= cue.sourceStartUs
      || cue.sourceStartUs < clip.sourceInUs
      || cue.sourceEndUs > clip.sourceOutUs
    ) {
      add(target, "error", "CAPTION_SOURCE_RANGE_INVALID", "字幕来源时间超出了视频片段。", cuePath);
      continue;
    }
    const expectedStartUs = clip.timelineInUs
      + Math.round((cue.sourceStartUs - clip.sourceInUs) / clip.speed);
    const expectedEndUs = clip.timelineInUs
      + Math.round((cue.sourceEndUs - clip.sourceInUs) / clip.speed);
    if (cue.startUs !== expectedStartUs || cue.endUs !== expectedEndUs) {
      add(
        target,
        "error",
        "CAPTION_TIMELINE_MISMATCH",
        "字幕时间与来源片段时间不一致。",
        cuePath,
        { expectedStartUs, expectedEndUs },
      );
    }
  }
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
    } else if (transition.type !== "cut") {
      if (transition.durationUs <= 0) {
        add(target, "error", "TRANSITION_HAS_NO_DURATION", "非硬切转场必须有正时长。", `${path}.durationUs`);
      } else if (fromIndex != null && toIndex != null) {
        const fromClip = videoClips[fromIndex];
        const toClip = videoClips[toIndex];
        const fromDurationUs = videoClipDurationUs.get(fromClip.id) || 0;
        const toDurationUs = videoClipDurationUs.get(toClip.id) || 0;
        if (transition.durationUs * 2 > Math.min(fromDurationUs, toDurationUs)) {
          add(
            target,
            "error",
            "TRANSITION_TOO_LONG",
            "转场时长不能超过任一相邻片段时长的一半。",
            `${path}.durationUs`,
          );
        }
        const expectedTimelineInUs = fromClip.timelineInUs + fromDurationUs - transition.durationUs;
        if (toClip.timelineInUs !== expectedTimelineInUs) {
          add(
            target,
            "error",
            "TRANSITION_TIMELINE_MISMATCH",
            "叠化转场必须由相邻片段按转场时长重叠。",
            path,
            {
              expectedTimelineInUs,
              actualTimelineInUs: toClip.timelineInUs,
            },
          );
        }
      }
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
