import type {
  EditPlan,
  EmotionTone,
  VideoClip,
} from "../../src/types";

export type EmotionSegment = NonNullable<EditPlan["emotionSegments"]>[number];

type MutableEmotionSegment = EmotionSegment & {
  weightedIntensity: number;
  weightedConfidence: number;
  weightUs: number;
  reasons: string[];
};

function clipDurationUs(clip: VideoClip): number {
  return Math.max(
    0,
    Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed),
  );
}

function mergeInto(
  left: MutableEmotionSegment,
  right: MutableEmotionSegment,
): MutableEmotionSegment {
  const weightUs = left.weightUs + right.weightUs;
  const dominant = left.weightUs >= right.weightUs ? left : right;
  return {
    ...dominant,
    id: left.id,
    startUs: left.startUs,
    endUs: right.endUs,
    clipIds: [...left.clipIds, ...right.clipIds],
    weightUs,
    weightedIntensity: left.weightedIntensity + right.weightedIntensity,
    weightedConfidence: left.weightedConfidence + right.weightedConfidence,
    intensity: weightUs > 0
      ? (left.weightedIntensity + right.weightedIntensity) / weightUs
      : dominant.intensity,
    confidence: weightUs > 0
      ? (left.weightedConfidence + right.weightedConfidence) / weightUs
      : dominant.confidence,
    reasons: [...left.reasons, ...right.reasons],
    reason: dominant.reason,
  };
}

function finalize(segment: MutableEmotionSegment, index: number): EmotionSegment {
  return {
    id: `emotion-${String(index + 1).padStart(2, "0")}`,
    startUs: segment.startUs,
    endUs: segment.endUs,
    tone: segment.tone,
    intensity: Number(segment.intensity.toFixed(4)),
    confidence: Number(segment.confidence.toFixed(4)),
    clipIds: [...new Set(segment.clipIds)],
    reason: [...new Set(segment.reasons)].join("；").slice(0, 240),
  };
}

function closestMergeIndex(
  segments: MutableEmotionSegment[],
  index: number,
): number {
  if (index <= 0) return 0;
  if (index >= segments.length - 1) return index - 1;
  const current = segments[index];
  const leftDistance = Math.abs(
    current.intensity - segments[index - 1].intensity,
  );
  const rightDistance = Math.abs(
    current.intensity - segments[index + 1].intensity,
  );
  return leftDistance <= rightDistance ? index - 1 : index;
}

export function buildEmotionSegments(
  clips: VideoClip[],
  actualDurationUs: number,
  options: {
    maximumSegments?: number;
    minimumSegmentDurationUs?: number;
  } = {},
): EmotionSegment[] {
  if (!Number.isSafeInteger(actualDurationUs) || actualDurationUs <= 0) return [];
  const ordered = [...clips]
    .filter((clip) => clip.emotion)
    .sort((left, right) =>
      left.timelineInUs - right.timelineInUs || left.id.localeCompare(right.id));
  if (ordered.length === 0) return [];
  const segments: MutableEmotionSegment[] = [];
  for (const clip of ordered) {
    const emotion = clip.emotion!;
    const durationUs = clipDurationUs(clip);
    if (durationUs <= 0) continue;
    const previous = segments.at(-1);
    if (previous && previous.tone === emotion.tone) {
      const current: MutableEmotionSegment = {
        id: "",
        startUs: clip.timelineInUs,
        endUs: Math.min(actualDurationUs, clip.timelineInUs + durationUs),
        tone: emotion.tone,
        intensity: emotion.intensity,
        confidence: emotion.confidence,
        clipIds: [clip.id],
        reason: emotion.reason,
        weightUs: durationUs,
        weightedIntensity: emotion.intensity * durationUs,
        weightedConfidence: emotion.confidence * durationUs,
        reasons: [emotion.reason],
      };
      segments[segments.length - 1] = mergeInto(previous, current);
    } else {
      const startUs = previous
        ? Math.max(previous.startUs, clip.timelineInUs)
        : 0;
      if (previous) previous.endUs = startUs;
      segments.push({
        id: "",
        startUs,
        endUs: Math.min(actualDurationUs, clip.timelineInUs + durationUs),
        tone: emotion.tone,
        intensity: emotion.intensity,
        confidence: emotion.confidence,
        clipIds: [clip.id],
        reason: emotion.reason,
        weightUs: durationUs,
        weightedIntensity: emotion.intensity * durationUs,
        weightedConfidence: emotion.confidence * durationUs,
        reasons: [emotion.reason],
      });
    }
  }
  if (segments.length === 0) return [];
  segments[0].startUs = 0;
  segments[segments.length - 1].endUs = actualDurationUs;

  const minimumDurationUs = Math.max(
    0,
    Math.round(options.minimumSegmentDurationUs ?? 3_000_000),
  );
  const maximumSegments = Math.max(
    1,
    Math.round(options.maximumSegments ?? 4),
  );
  while (segments.length > 1) {
    const shortIndex = segments.findIndex((segment) =>
      segment.endUs - segment.startUs < minimumDurationUs);
    const shouldReduceCount = segments.length > maximumSegments;
    if (shortIndex < 0 && !shouldReduceCount) break;
    const targetIndex = shortIndex >= 0
      ? shortIndex
      : segments
        .map((segment, index) => ({
          index,
          durationUs: segment.endUs - segment.startUs,
        }))
        .sort((left, right) =>
          left.durationUs - right.durationUs || left.index - right.index)[0].index;
    const leftIndex = closestMergeIndex(segments, targetIndex);
    segments.splice(
      leftIndex,
      2,
      mergeInto(segments[leftIndex], segments[leftIndex + 1]),
    );
  }

  segments[0].startUs = 0;
  segments[segments.length - 1].endUs = actualDurationUs;
  for (let index = 1; index < segments.length; index += 1) {
    segments[index].startUs = segments[index - 1].endUs;
  }
  return segments.map(finalize);
}

export const EMOTION_TONE_LABELS: Record<EmotionTone, string> = {
  neutral: "中性",
  calm: "平静",
  warm: "温暖",
  upbeat: "轻快",
  tense: "紧张",
  reflective: "回味",
};
