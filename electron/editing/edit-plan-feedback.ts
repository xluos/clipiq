import type {
  CaptionCue,
  EditFeedbackAction,
  EditPlan,
  EditTransition,
  VideoClip,
} from "../../src/types";
import {
  beatAlignedClipSpeed,
  refreshBeatSyncSuggestions,
} from "./audio-beat-analysis";
import { clipVideoEvidenceToRange } from "./aligned-evidence";
import {
  validateEditPlan,
  type EditPlanValidationOptions,
} from "./edit-plan-validator";

type ResolvedFeedbackOptions = {
  newPlanId: string;
  now: number;
  replacementClip?: VideoClip;
  sourceExists?: EditPlanValidationOptions["sourceExists"];
};

function clipDurationUs(clip: VideoClip): number {
  return Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
}

function getVideoTrack(plan: EditPlan) {
  const track = plan.tracks.find((item) => item.kind === "video");
  if (!track || track.kind !== "video") throw new Error("EditPlan 没有视频轨道");
  return track;
}

function captionCuesFromClip(clip: VideoClip): CaptionCue[] {
  return (clip.evidence?.subtitleSegments || [])
    .filter((segment) =>
      segment.text.trim()
      && segment.endUs > segment.startUs
      && segment.startUs < clip.sourceOutUs
      && segment.endUs > clip.sourceInUs)
    .map((segment, index) => {
      const sourceStartUs = Math.max(clip.sourceInUs, segment.startUs);
      const sourceEndUs = Math.min(clip.sourceOutUs, segment.endUs);
      return {
        id: `${clip.id}-caption-${index + 1}`,
        startUs: clip.timelineInUs
          + Math.round((sourceStartUs - clip.sourceInUs) / clip.speed),
        endUs: clip.timelineInUs
          + Math.round((sourceEndUs - clip.sourceInUs) / clip.speed),
        text: segment.text.trim(),
        styleId: "proxy-default",
        sourceClipId: clip.id,
        sourceStartUs,
        sourceEndUs,
      };
    });
}

function attachCaptionSources(cues: CaptionCue[], clips: VideoClip[]): CaptionCue[] {
  return cues.map((cue) => {
    if (cue.sourceClipId && cue.sourceStartUs != null && cue.sourceEndUs != null) {
      return cue;
    }
    const clip = clips.find((item) => {
      const endUs = item.timelineInUs + clipDurationUs(item);
      return cue.startUs >= item.timelineInUs && cue.endUs <= endUs;
    });
    if (!clip) return cue;
    return {
      ...cue,
      sourceClipId: clip.id,
      sourceStartUs: clip.sourceInUs
        + Math.round((cue.startUs - clip.timelineInUs) * clip.speed),
      sourceEndUs: clip.sourceInUs
        + Math.round((cue.endUs - clip.timelineInUs) * clip.speed),
    };
  });
}

function getOrCreateCaptionTrack(plan: EditPlan, clips: VideoClip[]) {
  const existing = plan.tracks.find((item) => item.kind === "caption");
  if (existing?.kind === "caption") {
    existing.items = attachCaptionSources(existing.items, clips);
    return existing;
  }
  const track = {
    id: `${plan.id}-caption-track-1`,
    kind: "caption" as const,
    items: clips.flatMap(captionCuesFromClip),
  };
  plan.tracks.push(track);
  return track;
}

function getOrCreateAudioTrack(plan: EditPlan) {
  const existing = plan.tracks.find((item) => item.kind === "audio");
  if (existing?.kind === "audio") return existing;
  const track = {
    id: `${plan.id}-audio-track-1`,
    kind: "audio" as const,
    items: [],
  };
  plan.tracks.push(track);
  return track;
}

function transitionFor(
  transitions: EditTransition[],
  leftId: string,
  rightId: string,
): EditTransition | undefined {
  return transitions.find((item) =>
    item.fromClipId === leftId && item.toClipId === rightId);
}

function reflowPlan(plan: EditPlan): void {
  const video = getVideoTrack(plan);
  const captions = getOrCreateCaptionTrack(plan, video.items);
  const oldTransitions = plan.transitions;
  const nextTransitions: EditTransition[] = [];
  let timelineUs = 0;

  for (const [index, clip] of video.items.entries()) {
    if (index === 0) {
      clip.timelineInUs = 0;
    } else {
      const left = video.items[index - 1];
      const existing = transitionFor(oldTransitions, left.id, clip.id);
      const transition = existing || {
        id: `${plan.id}-transition-${index}`,
        fromClipId: left.id,
        toClipId: clip.id,
        type: "cut" as const,
        durationUs: 0,
      };
      const maxTransitionUs = Math.floor(
        Math.min(clipDurationUs(left), clipDurationUs(clip)) / 2,
      );
      if (transition.type === "cut") {
        transition.durationUs = 0;
      } else if (
        transition.durationUs <= 0
        || transition.durationUs > maxTransitionUs
      ) {
        throw new Error("转场时长超过相邻片段可用范围");
      }
      clip.timelineInUs = timelineUs - transition.durationUs;
      nextTransitions.push(transition);
    }
    timelineUs = Math.max(timelineUs, clip.timelineInUs + clipDurationUs(clip));
  }
  plan.transitions = nextTransitions;
  plan.actualDurationUs = timelineUs;

  const clipById = new Map(video.items.map((clip) => [clip.id, clip]));
  for (const track of plan.tracks) {
    if (track.kind !== "audio") continue;
    track.items = track.items.flatMap((audio) => {
      if (audio.kind !== "voiceover" || !audio.anchorClipId) return [audio];
      const anchor = clipById.get(audio.anchorClipId);
      if (!anchor) return [];
      audio.timelineInUs = anchor.timelineInUs;
      return [audio];
    });
  }
  captions.items = captions.items
    .filter((cue) => !cue.sourceClipId || clipById.has(cue.sourceClipId))
    .flatMap((cue) => {
      if (!cue.sourceClipId) return [cue];
      const clip = clipById.get(cue.sourceClipId);
      if (!clip) return [];
      const sourceStartUs = Math.max(
        clip.sourceInUs,
        cue.sourceStartUs ?? clip.sourceInUs,
      );
      const sourceEndUs = Math.min(
        clip.sourceOutUs,
        cue.sourceEndUs ?? clip.sourceOutUs,
      );
      if (sourceEndUs <= sourceStartUs) return [];
      return [{
        ...cue,
        sourceStartUs,
        sourceEndUs,
        startUs: clip.timelineInUs
          + Math.round((sourceStartUs - clip.sourceInUs) / clip.speed),
        endUs: clip.timelineInUs
          + Math.round((sourceEndUs - clip.sourceInUs) / clip.speed),
      }];
    })
    .sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
}

function replaceTransitionClipId(
  transitions: EditTransition[],
  oldClipId: string,
  newClipId: string,
): void {
  for (const transition of transitions) {
    if (transition.fromClipId === oldClipId) transition.fromClipId = newClipId;
    if (transition.toClipId === oldClipId) transition.toClipId = newClipId;
  }
}

function replaceVoiceoverAnchorClipId(
  plan: EditPlan,
  oldClipId: string,
  newClipId: string,
): void {
  for (const track of plan.tracks) {
    if (track.kind !== "audio") continue;
    for (const audio of track.items) {
      if (audio.kind === "voiceover" && audio.anchorClipId === oldClipId) {
        audio.anchorClipId = newClipId;
      }
    }
  }
}

export function applyEditPlanFeedback(
  sourcePlan: EditPlan,
  action: EditFeedbackAction,
  options: ResolvedFeedbackOptions,
): EditPlan {
  if (!sourcePlan.validation.valid) throw new Error("只能编辑已通过校验的 EditPlan");
  const plan = structuredClone(sourcePlan);
  const video = getVideoTrack(plan);
  const originalClips = structuredClone(video.items);
  const captions = getOrCreateCaptionTrack(plan, originalClips);
  const clipIndex = video.items.findIndex((clip) => clip.id === ("clipId" in action ? action.clipId : ""));

  if ("clipId" in action && clipIndex < 0) {
    throw new Error(`视频片段不存在: ${action.clipId}`);
  }

  switch (action.type) {
    case "keep_clip":
      break;
    case "delete_clip":
      if (video.items.length <= 1) throw new Error("粗剪至少需要保留一个镜头");
      video.items.splice(clipIndex, 1);
      captions.items = captions.items.filter((cue) => cue.sourceClipId !== action.clipId);
      plan.transitions = plan.transitions.filter((transition) =>
        transition.fromClipId !== action.clipId && transition.toClipId !== action.clipId);
      break;
    case "move_clip": {
      if (
        !Number.isInteger(action.toIndex)
        || action.toIndex < 0
        || action.toIndex >= video.items.length
      ) {
        throw new Error("镜头目标位置无效");
      }
      const [clip] = video.items.splice(clipIndex, 1);
      video.items.splice(action.toIndex, 0, clip);
      break;
    }
    case "trim_clip": {
      const clip = video.items[clipIndex];
      if (
        !Number.isSafeInteger(action.sourceInUs)
        || !Number.isSafeInteger(action.sourceOutUs)
        || action.sourceInUs < clip.sourceInUs
        || action.sourceOutUs > clip.sourceOutUs
        || action.sourceOutUs - action.sourceInUs < 200_000
      ) {
        throw new Error("缩短后的镜头必须位于原片段内且至少保留 0.2 秒");
      }
      clip.sourceInUs = action.sourceInUs;
      clip.sourceOutUs = action.sourceOutUs;
      clip.evidence = clip.evidence
        ? clipVideoEvidenceToRange(clip.evidence, clip.sourceInUs, clip.sourceOutUs)
        : undefined;
      break;
    }
    case "replace_clip": {
      const replacement = options.replacementClip;
      if (
        !replacement
        || replacement.candidateId !== action.replacementCandidateId
      ) {
        throw new Error("替换镜头尚未解析为真实候选窗口");
      }
      const oldClip = video.items[clipIndex];
      const replacementClip = {
        ...structuredClone(replacement),
        timelineInUs: oldClip.timelineInUs,
      };
      video.items[clipIndex] = replacementClip;
      captions.items = [
        ...captions.items.filter((cue) => cue.sourceClipId !== oldClip.id),
        ...captionCuesFromClip(replacementClip),
      ];
      replaceTransitionClipId(plan.transitions, oldClip.id, replacementClip.id);
      replaceVoiceoverAnchorClipId(plan, oldClip.id, replacementClip.id);
      break;
    }
    case "update_caption": {
      const cue = captions.items.find((item) => item.id === action.cueId);
      if (!cue) throw new Error(`字幕不存在: ${action.cueId}`);
      const text = action.text.trim();
      if (!text) throw new Error("字幕文本不能为空");
      cue.text = text;
      break;
    }
    case "set_music": {
      const music = structuredClone(action.music);
      if (
        music.kind !== "music"
        || !music.id
        || !music.sourcePath
        || !Number.isSafeInteger(music.timelineInUs)
        || !Number.isSafeInteger(music.sourceInUs)
        || !Number.isSafeInteger(music.sourceOutUs)
        || music.timelineInUs < 0
        || music.sourceInUs < 0
        || music.sourceOutUs <= music.sourceInUs
      ) {
        throw new Error("BGM 音轨无效");
      }
      const audio = getOrCreateAudioTrack(plan);
      audio.items = [
        ...audio.items.filter((item) => item.kind !== "music"),
        music,
      ];
      break;
    }
    case "remove_music": {
      const audio = plan.tracks.find((item) => item.kind === "audio");
      if (audio?.kind !== "audio") throw new Error("EditPlan 没有 BGM 音轨");
      const before = audio.items.length;
      audio.items = audio.items.filter((item) =>
        !(item.kind === "music" && item.id === action.audioClipId));
      if (audio.items.length === before) throw new Error("BGM 音轨不存在");
      if (audio.items.length === 0) {
        plan.tracks = plan.tracks.filter((item) => item !== audio);
      }
      break;
    }
    case "apply_beat_sync": {
      const audio = plan.tracks.find((item) => item.kind === "audio");
      const music = audio?.kind === "audio"
        ? audio.items.find((item) =>
          item.kind === "music" && item.id === action.audioClipId)
        : undefined;
      if (!music) throw new Error("待卡点的 BGM 音轨不存在");
      const suggestion = music.beatSyncSuggestions?.find((item) =>
        item.fromClipId === action.fromClipId
        && item.toClipId === action.toClipId
        && item.beatTimeUs === action.beatTimeUs);
      if (!suggestion) throw new Error("卡点建议已过期，请使用最新建议");
      if (Math.abs(suggestion.offsetUs) <= 1_000) {
        throw new Error("当前切点已对齐节拍");
      }
      const fromIndex = video.items.findIndex((clip) => clip.id === action.fromClipId);
      if (
        fromIndex < 0
        || video.items[fromIndex + 1]?.id !== action.toClipId
      ) {
        throw new Error("卡点建议必须引用相邻镜头");
      }
      const nextSpeed = beatAlignedClipSpeed(
        video.items[fromIndex],
        suggestion.offsetUs,
      );
      if (nextSpeed == null) {
        throw new Error("卡点所需变速超过安全范围");
      }
      video.items[fromIndex].speed = nextSpeed;
      break;
    }
    case "set_voiceover": {
      const voiceover = structuredClone(action.voiceover);
      if (
        voiceover.kind !== "voiceover"
        || !voiceover.id
        || !voiceover.anchorClipId
        || !voiceover.ttsText?.trim()
        || !voiceover.sourcePath
        || !Number.isSafeInteger(voiceover.sourceInUs)
        || !Number.isSafeInteger(voiceover.sourceOutUs)
        || voiceover.sourceInUs < 0
        || voiceover.sourceOutUs <= voiceover.sourceInUs
      ) {
        throw new Error("已合成旁白音轨无效");
      }
      const anchor = video.items.find((clip) => clip.id === voiceover.anchorClipId);
      if (!anchor) throw new Error("旁白锚定的视频片段不存在");
      voiceover.timelineInUs = anchor.timelineInUs;
      const audio = getOrCreateAudioTrack(plan);
      audio.items = [
        ...audio.items.filter((item) => item.id !== voiceover.id),
        voiceover,
      ];
      break;
    }
    case "remove_voiceover": {
      const audio = plan.tracks.find((item) => item.kind === "audio");
      if (audio?.kind !== "audio") throw new Error("EditPlan 没有旁白音轨");
      const before = audio.items.length;
      audio.items = audio.items.filter((item) =>
        !(item.kind === "voiceover" && item.id === action.audioClipId));
      if (audio.items.length === before) throw new Error("旁白音轨不存在");
      if (audio.items.length === 0) {
        plan.tracks = plan.tracks.filter((item) => item !== audio);
      }
      break;
    }
    case "set_transition": {
      const leftIndex = video.items.findIndex((clip) => clip.id === action.fromClipId);
      if (
        leftIndex < 0
        || video.items[leftIndex + 1]?.id !== action.toClipId
      ) {
        throw new Error("转场只能设置在相邻镜头之间");
      }
      if (!Number.isSafeInteger(action.durationUs) || action.durationUs < 0) {
        throw new Error("转场时长必须是非负整数微秒");
      }
      const existing = transitionFor(
        plan.transitions,
        action.fromClipId,
        action.toClipId,
      );
      const next: EditTransition = {
        id: existing?.id || `${options.newPlanId}-transition-${leftIndex + 1}`,
        fromClipId: action.fromClipId,
        toClipId: action.toClipId,
        type: action.transitionType,
        durationUs: action.transitionType === "cut" ? 0 : action.durationUs,
      };
      plan.transitions = plan.transitions.filter((transition) =>
        !(transition.fromClipId === action.fromClipId
          && transition.toClipId === action.toClipId));
      plan.transitions.push(next);
      break;
    }
    default:
      throw new Error("不支持的粗剪反馈操作");
  }

  plan.id = options.newPlanId;
  plan.parentPlanId = sourcePlan.id;
  plan.revision = (sourcePlan.revision || 1) + 1;
  plan.status = "draft";
  reflowPlan(plan);
  refreshBeatSyncSuggestions(plan);
  const validation = validateEditPlan(plan, {
    sourceExists: options.sourceExists,
  });
  plan.validation = validation;
  plan.status = validation.valid ? "validated" : "draft";
  if (!validation.valid) {
    throw new Error(
      `反馈后的 EditPlan 无效: ${validation.errors.map((issue) => issue.message).join("；")}`,
    );
  }
  return plan;
}
