import type {
  AudioBeatAnalysis,
  AudioClip,
  BeatSyncSuggestion,
  EditPlan,
  VideoClip,
} from "../../src/types";

export type BeatDetectionOptions = {
  analyzedStartUs?: number;
  frameSize?: number;
  hopSize?: number;
  minimumBpm?: number;
  maximumBpm?: number;
  minimumUsableConfidence?: number;
};

const US_PER_SECOND = 1_000_000;
const MINIMUM_EDITABLE_CLIP_DURATION_US = 200_000;
export const MAXIMUM_BEAT_SYNC_SPEED_CHANGE_RATIO = 0.05;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function standardDeviation(values: number[], average: number): number {
  if (values.length === 0) return 0;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function localOnsetEnvelope(
  pcm: Float32Array,
  frameSize: number,
  hopSize: number,
): number[] {
  const rms: number[] = [];
  for (let start = 0; start + frameSize <= pcm.length; start += hopSize) {
    let sumSquares = 0;
    for (let index = start; index < start + frameSize; index += 1) {
      const value = Number.isFinite(pcm[index]) ? pcm[index] : 0;
      sumSquares += value * value;
    }
    rms.push(Math.sqrt(sumSquares / frameSize));
  }
  return rms.map((value, index) => {
    const history = rms.slice(Math.max(0, index - 8), index);
    return Math.max(0, value - mean(history));
  });
}

function onsetPeaks(envelope: number[]): number[] {
  const average = mean(envelope);
  const deviation = standardDeviation(envelope, average);
  const threshold = average + deviation * 0.6;
  return envelope.flatMap((value, index) => {
    if (
      index === 0
      || index === envelope.length - 1
      || value <= threshold
      || value < envelope[index - 1]
      || value < envelope[index + 1]
    ) {
      return [];
    }
    return [index];
  });
}

function normalizedAutocorrelation(envelope: number[], lag: number): number {
  let dot = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let index = lag; index < envelope.length; index += 1) {
    const left = envelope[index];
    const right = envelope[index - lag];
    dot += left * right;
    leftPower += left * left;
    rightPower += right * right;
  }
  const denominator = Math.sqrt(leftPower * rightPower);
  return denominator > 0 ? dot / denominator : 0;
}

function bestTempoLag(
  envelope: number[],
  envelopeRate: number,
  minimumBpm: number,
  maximumBpm: number,
): { lag: number; correlation: number } | null {
  const minimumLag = Math.max(1, Math.floor(envelopeRate * 60 / maximumBpm));
  const maximumLag = Math.min(
    envelope.length - 2,
    Math.ceil(envelopeRate * 60 / minimumBpm),
  );
  if (maximumLag <= minimumLag) return null;

  let best: { lag: number; correlation: number } | null = null;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const correlation = normalizedAutocorrelation(envelope, lag);
    if (
      !best
      || correlation > best.correlation + 0.000001
      || (Math.abs(correlation - best.correlation) <= 0.000001 && lag < best.lag)
    ) {
      best = { lag, correlation };
    }
  }
  return best;
}

function beatPhase(
  envelope: number[],
  peaks: number[],
  lag: number,
): number | null {
  const candidates = peaks.filter((index) => index < lag * 2);
  if (candidates.length === 0) return null;
  return candidates
    .map((candidate) => {
      let score = 0;
      let count = 0;
      for (let index = candidate; index < envelope.length; index += lag) {
        const rounded = Math.round(index);
        score += Math.max(
          envelope[rounded] || 0,
          envelope[rounded - 1] || 0,
          envelope[rounded + 1] || 0,
        );
        count += 1;
      }
      return { candidate, score: count ? score / count : 0 };
    })
    .sort((a, b) => b.score - a.score || a.candidate - b.candidate)[0]?.candidate ?? null;
}

function refinedTempoLag(peaks: number[], coarseLag: number): number {
  const intervals = peaks.slice(1)
    .map((peak, index) => peak - peaks[index])
    .filter((interval) =>
      interval >= coarseLag * 0.65 && interval <= coarseLag * 1.35);
  return intervals.length >= 3 ? mean(intervals) : coarseLag;
}

export function detectAudioBeats(
  pcm: Float32Array,
  sampleRate: number,
  options: BeatDetectionOptions = {},
): AudioBeatAnalysis {
  const analyzedStartUs = Math.max(0, Math.round(options.analyzedStartUs || 0));
  const durationUs = Number.isFinite(sampleRate) && sampleRate > 0
    ? Math.round(pcm.length / sampleRate * US_PER_SECOND)
    : 0;
  const base = {
    algorithmVersion: "energy-onset-v1" as const,
    sampleRate,
    analyzedStartUs,
    analyzedEndUs: analyzedStartUs + durationUs,
  };
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || pcm.length < sampleRate * 3) {
    return {
      ...base,
      status: "insufficient_audio",
      confidence: 0,
      beatTimesUs: [],
      reason: "有效音频不足 3 秒或采样率无效",
    };
  }

  const frameSize = Math.max(256, Math.round(options.frameSize || 1_024));
  const hopSize = Math.max(128, Math.min(frameSize, Math.round(options.hopSize || 512)));
  const minimumBpm = Math.max(40, Math.min(240, options.minimumBpm || 70));
  const maximumBpm = Math.max(minimumBpm + 1, Math.min(300, options.maximumBpm || 180));
  const envelope = localOnsetEnvelope(pcm, frameSize, hopSize);
  const peaks = onsetPeaks(envelope);
  if (peaks.length < 4 || Math.max(...envelope, 0) < 0.0001) {
    return {
      ...base,
      status: "insufficient_audio",
      confidence: 0,
      beatTimesUs: [],
      reason: "未检测到足够的周期性起音",
    };
  }

  const envelopeRate = sampleRate / hopSize;
  const tempo = bestTempoLag(envelope, envelopeRate, minimumBpm, maximumBpm);
  const phase = tempo ? beatPhase(envelope, peaks, tempo.lag) : null;
  if (!tempo || phase == null) {
    return {
      ...base,
      status: "low_confidence",
      confidence: 0,
      beatTimesUs: [],
      reason: "无法建立稳定节拍网格",
    };
  }

  const periodSec = refinedTempoLag(peaks, tempo.lag) / envelopeRate;
  const bpm = 60 / periodSec;
  const beatTimesUs: number[] = [];
  let firstBeatSec = (phase * hopSize + frameSize) / sampleRate;
  while (firstBeatSec - periodSec >= 0) firstBeatSec -= periodSec;
  for (
    // RMS 起音峰值落在包含瞬态的窗口起点附近，用窗口末端近似实际起音时间。
    let timeSec = firstBeatSec;
    timeSec <= pcm.length / sampleRate;
    timeSec += periodSec
  ) {
    beatTimesUs.push(analyzedStartUs + Math.round(timeSec * US_PER_SECOND));
  }
  const expectedBeats = Math.max(1, Math.floor(durationUs / US_PER_SECOND / periodSec));
  const peakCoverage = Math.min(1, peaks.length / expectedBeats);
  const confidence = clamp01(tempo.correlation * 0.75 + peakCoverage * 0.25);
  const minimumUsableConfidence = clamp01(options.minimumUsableConfidence ?? 0.45);
  return {
    ...base,
    status: confidence >= minimumUsableConfidence ? "usable" : "low_confidence",
    bpm: Math.round(bpm * 10) / 10,
    confidence,
    beatTimesUs,
    ...(confidence >= minimumUsableConfidence
      ? {}
      : { reason: "周期性不足，仅保留为低置信度分析证据" }),
  };
}

function videoClips(plan: EditPlan): VideoClip[] {
  const track = plan.tracks.find((item) => item.kind === "video");
  return track?.kind === "video" ? track.items : [];
}

function timelineBeatTimes(clip: AudioClip): number[] {
  const analysis = clip.beatAnalysis;
  if (!analysis || analysis.status !== "usable") return [];
  return analysis.beatTimesUs.flatMap((beatTimeUs) => {
    if (beatTimeUs < clip.sourceInUs || beatTimeUs > clip.sourceOutUs) return [];
    return [clip.timelineInUs + beatTimeUs - clip.sourceInUs];
  });
}

export function beatAlignedClipSpeed(
  clip: VideoClip,
  offsetUs: number,
  options: {
    maximumSpeedChangeRatio?: number;
    minimumDurationUs?: number;
  } = {},
): number | null {
  if (!Number.isSafeInteger(offsetUs)) return null;
  const sourceDurationUs = clip.sourceOutUs - clip.sourceInUs;
  if (
    !Number.isSafeInteger(sourceDurationUs)
    || sourceDurationUs <= 0
    || !Number.isFinite(clip.speed)
    || clip.speed <= 0
  ) {
    return null;
  }
  const currentDurationUs = Math.round(sourceDurationUs / clip.speed);
  const targetDurationUs = currentDurationUs + offsetUs;
  const minimumDurationUs = Math.max(
    MINIMUM_EDITABLE_CLIP_DURATION_US,
    Math.round(options.minimumDurationUs ?? MINIMUM_EDITABLE_CLIP_DURATION_US),
  );
  if (targetDurationUs < minimumDurationUs) return null;
  const nextSpeed = sourceDurationUs / targetDurationUs;
  const maximumSpeedChangeRatio = Math.max(
    0,
    Number.isFinite(options.maximumSpeedChangeRatio)
      ? Number(options.maximumSpeedChangeRatio)
      : MAXIMUM_BEAT_SYNC_SPEED_CHANGE_RATIO,
  );
  // EditPlan 当前的默认播放速度是 1；对同一边界反复确认时也不能累计越过安全范围。
  const changeRatio = Math.abs(nextSpeed - 1);
  if (
    !Number.isFinite(nextSpeed)
    || nextSpeed <= 0
    || changeRatio > maximumSpeedChangeRatio + Number.EPSILON
  ) {
    return null;
  }
  return nextSpeed;
}

/**
 * 为现有硬切边界寻找附近节拍，只返回建议，不改动源入出点或时间线。
 */
export function suggestBeatAlignedCuts(
  plan: EditPlan,
  musicClip: AudioClip,
  options: {
    maximumOffsetUs?: number;
    maximumSpeedChangeRatio?: number;
  } = {},
): BeatSyncSuggestion[] {
  const analysis = musicClip.beatAnalysis;
  if (!analysis || analysis.status !== "usable") return [];
  const maximumOffsetUs = Math.max(0, Math.round(options.maximumOffsetUs ?? 150_000));
  const beats = timelineBeatTimes(musicClip);
  if (beats.length === 0) return [];
  const clips = videoClips(plan);
  return clips.slice(1).flatMap((clip, index) => {
    const previous = clips[index];
    const transition = plan.transitions.find((item) =>
      item.fromClipId === previous.id && item.toClipId === clip.id);
    if (transition && transition.type !== "cut") return [];
    const boundaryTimeUs = clip.timelineInUs;
    const beatTimeUs = beats.reduce((nearest, candidate) =>
      Math.abs(candidate - boundaryTimeUs) < Math.abs(nearest - boundaryTimeUs)
        ? candidate
        : nearest);
    const offsetUs = beatTimeUs - boundaryTimeUs;
    if (Math.abs(offsetUs) > maximumOffsetUs) return [];
    if (beatAlignedClipSpeed(previous, offsetUs, {
      maximumSpeedChangeRatio: options.maximumSpeedChangeRatio,
    }) == null) {
      return [];
    }
    return [{
      fromClipId: previous.id,
      toClipId: clip.id,
      boundaryTimeUs,
      beatTimeUs,
      offsetUs,
      confidence: analysis.confidence,
    }];
  });
}

export function refreshBeatSyncSuggestions(plan: EditPlan): void {
  for (const track of plan.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.items) {
      if (clip.kind !== "music") continue;
      clip.beatSyncSuggestions = suggestBeatAlignedCuts(plan, clip);
    }
  }
}
