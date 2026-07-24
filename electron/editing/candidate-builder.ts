import type {
  PersonAppearance,
  Shot,
  ShotTranscriptSegment,
  SpeakerTrack,
  TimedWordEvidence,
  Video,
  VideoClipEvidence,
  VideoClipEventEvidence,
  VideoClipEvidenceSegment,
  VideoClipPersonEvidence,
  VideoClipSpeakerEvidence,
  VideoClipSubtitleEvidence,
} from "../../src/types";
import {
  buildAlignedEvidenceSegments,
  clipVideoEvidenceToRange,
} from "./aligned-evidence";
import { buildCandidateWindows } from "./candidate-windows";
import { hasUsableWordTimings } from "./transcript-evidence";

export type VlogCandidate = {
  candidateId: string;
  shotId: string;
  videoId: string;
  sourcePath: string;
  startUs: number;
  endUs: number;
  durationUs: number;
  description: string;
  eventSegments: VideoClipEventEvidence[];
  subtitleSegments: VideoClipSubtitleEvidence[];
  transcriptGranularity?: "segment" | "word";
  personAppearances: VideoClipPersonEvidence[];
  speakerTracks: VideoClipSpeakerEvidence[];
  alignedSegments: VideoClipEvidenceSegment[];
  boundaryReason: "shot" | "evidence" | "duration";
  personIds: string[];
  speakerIds: string[];
  usageTags: string[];
  qualityScore: number;
  qualitySignals: string[];
};

export type CandidateRejection = {
  shotId: string;
  candidateId?: string;
  code:
    | "INVALID_TIME"
    | "MISSING_VIDEO"
    | "MISSING_SOURCE_PATH"
    | "TOO_SHORT"
    | "DUPLICATE_SHOT"
    | "OVERLAPPING_DUPLICATE"
    | "FILTER_PERSON"
    | "FILTER_SPEAKER"
    | "FILTER_EVENT"
    | "FILTER_DIALOGUE"
    | "FILTER_TIME_RANGE";
  message: string;
};

export type CandidateSourceTimeRange = {
  videoId: string;
  startUs: number;
  endUs: number;
};

export type BuildVlogCandidatesOptions = {
  videoIds?: string[];
  minimumDurationUs?: number;
  maximumCandidates?: number;
  minimumIdentityConfidence?: number;
  personIds?: string[];
  speakerIds?: string[];
  eventQuery?: string;
  dialogueQuery?: string;
  sourceTimeRanges?: CandidateSourceTimeRange[];
  maximumWindowDurationUs?: number;
  minimumWindowDurationUs?: number;
};

export type VlogCandidateBuildResult = {
  candidates: VlogCandidate[];
  rejected: CandidateRejection[];
};

const US_PER_SECOND = 1_000_000;

function secondsToUs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * US_PER_SECOND);
  return Number.isSafeInteger(result) ? result : null;
}

function transcriptSegments(
  segments: ShotTranscriptSegment[] | undefined,
  shotStartUs: number,
  shotEndUs: number,
): VlogCandidate["subtitleSegments"] {
  return (segments || [])
    .map((segment) => ({
      startUs: secondsToUs(segment.startSec),
      endUs: secondsToUs(segment.endSec),
      text: String(segment.text || "").trim(),
      speakerId: segment.speakerId,
      wordTimingUsable: hasUsableWordTimings(segment),
      words: (segment.words || [])
        .map((word) => ({
          text: String(word.text || "").trim(),
          startUs: secondsToUs(word.startSec),
          endUs: secondsToUs(word.endSec),
          ...(word.speakerId ? { speakerId: word.speakerId } : {}),
          ...(Number.isFinite(word.confidence)
            ? { confidence: Number(word.confidence) }
            : {}),
        }))
        .filter((word): word is TimedWordEvidence =>
          word.startUs != null
          && word.endUs != null
          && word.endUs > word.startUs
          && Boolean(word.text)),
    }))
    .filter((segment): segment is {
      startUs: number;
      endUs: number;
      text: string;
      speakerId: string | undefined;
      words: TimedWordEvidence[];
      wordTimingUsable: boolean;
    } =>
      segment.startUs != null
      && segment.endUs != null
      && segment.endUs > segment.startUs
      && segment.startUs < shotEndUs
      && segment.endUs > shotStartUs
      && Boolean(segment.text))
    .map((segment) => {
      const words = segment.wordTimingUsable
        ? segment.words.filter((word) =>
          word.startUs >= segment.startUs
          && word.endUs <= segment.endUs
          && word.startUs >= shotStartUs
          && word.endUs <= shotEndUs)
        : [];
      return {
        startUs: segment.startUs,
        endUs: segment.endUs,
        text: segment.text,
        ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
        ...(words.length
          ? {
            words: words.map((word) => ({
              text: word.text,
              startUs: word.startUs,
              endUs: word.endUs,
              ...(word.speakerId ? { speakerId: word.speakerId } : {}),
              ...(Number.isFinite(word.confidence)
                ? { confidence: Number(word.confidence) }
                : {}),
            })),
          }
          : {}),
      };
    });
}

function timedEventSegments(
  segments: Shot["eventSegments"],
  shotStartUs: number,
  shotEndUs: number,
): VideoClipEventEvidence[] {
  return (segments || []).flatMap((segment) => {
    const range = clippedRange(
      segment.startSec,
      segment.endSec,
      shotStartUs,
      shotEndUs,
    );
    const summary = String(segment.summary || "").trim();
    if (!range || !summary) return [];
    return [{
      ...range,
      summary,
      granularity: segment.granularity,
      source: segment.source,
      ...(segment.sourceNodeId ? { sourceNodeId: segment.sourceNodeId } : {}),
      ...(Number.isFinite(segment.confidence)
        ? { confidence: Number(segment.confidence) }
        : {}),
    }];
  });
}

function trustedPersonId(
  appearance: PersonAppearance,
  minimumIdentityConfidence: number | undefined,
): string | undefined {
  if (!appearance.personId) return undefined;
  if (appearance.manualLocked) return appearance.personId;
  return minimumIdentityConfidence != null
    && appearance.identityConfidence != null
    && appearance.identityConfidence >= minimumIdentityConfidence
    ? appearance.personId
    : undefined;
}

function clippedRange(
  itemStartSec: number,
  itemEndSec: number,
  rangeStartUs: number,
  rangeEndUs: number,
): { startUs: number; endUs: number } | null {
  const itemStartUs = secondsToUs(itemStartSec);
  const itemEndUs = secondsToUs(itemEndSec);
  if (itemStartUs == null || itemEndUs == null) return null;
  const startUs = Math.max(itemStartUs, rangeStartUs);
  const endUs = Math.min(itemEndUs, rangeEndUs);
  return endUs > startUs ? { startUs, endUs } : null;
}

function temporalOverlapRatio(a: VlogCandidate, b: VlogCandidate): number {
  if (a.videoId !== b.videoId) return 0;
  const overlap = Math.max(0, Math.min(a.endUs, b.endUs) - Math.max(a.startUs, b.startUs));
  const shorter = Math.min(a.durationUs, b.durationUs);
  return shorter > 0 ? overlap / shorter : 0;
}

function normalizedQuery(value: unknown): string {
  return String(value || "").trim().toLocaleLowerCase();
}

function filterCandidate(
  candidate: VlogCandidate,
  options: BuildVlogCandidatesOptions,
): Pick<CandidateRejection, "code" | "message"> | null {
  const requestedPeople = [...new Set((options.personIds || []).map(String).filter(Boolean))];
  if (
    requestedPeople.length > 0
    && !requestedPeople.some((personId) => candidate.personIds.includes(personId))
  ) {
    return { code: "FILTER_PERSON", message: "未命中指定人物。" };
  }

  const requestedSpeakers = [...new Set((options.speakerIds || []).map(String).filter(Boolean))];
  if (
    requestedSpeakers.length > 0
    && !requestedSpeakers.some((speakerId) => candidate.speakerIds.includes(speakerId))
  ) {
    return { code: "FILTER_SPEAKER", message: "未命中指定说话人。" };
  }

  const eventQuery = normalizedQuery(options.eventQuery);
  if (eventQuery) {
    const eventText = normalizedQuery([
      candidate.description,
      ...candidate.usageTags,
    ].join(" "));
    if (!eventText.includes(eventQuery)) {
      return { code: "FILTER_EVENT", message: "未命中指定事件或镜头语义。" };
    }
  }

  const dialogueQuery = normalizedQuery(options.dialogueQuery);
  if (dialogueQuery) {
    const dialogueText = normalizedQuery(
      candidate.subtitleSegments.map((segment) => segment.text).join(" "),
    );
    if (!dialogueText.includes(dialogueQuery)) {
      return { code: "FILTER_DIALOGUE", message: "未命中指定对白。" };
    }
  }

  const requestedRanges = (options.sourceTimeRanges || []).filter((range) => (
    range
    && typeof range.videoId === "string"
    && Number.isSafeInteger(range.startUs)
    && Number.isSafeInteger(range.endUs)
    && range.startUs >= 0
    && range.endUs > range.startUs
  ));
  if (
    requestedRanges.length > 0
    && !requestedRanges.some((range) => (
      range.videoId === candidate.videoId
      && range.startUs < candidate.endUs
      && range.endUs > candidate.startUs
    ))
  ) {
    return { code: "FILTER_TIME_RANGE", message: "不在指定素材时间范围内。" };
  }
  return null;
}

function scoreShot(
  shot: Shot,
  durationUs: number,
  subtitleCount: number,
): { score: number; signals: string[] } {
  let score = 0.25;
  const signals: string[] = ["valid_time"];
  const description = String(shot.description || "").trim();
  if (description && !/^镜头\s*\d+$/.test(description)) {
    score += 0.2;
    signals.push("semantic_description");
  }
  if (subtitleCount > 0) {
    score += 0.15;
    signals.push("timed_transcript");
  }
  if (shot.thumbnailUrl) {
    score += 0.1;
    signals.push("thumbnail");
  }
  if (shot.isFavorite) {
    score += 0.15;
    signals.push("favorite");
  }
  if (shot.usageTags?.some((tag) => tag === "highlight" || tag === "hook" || tag === "ending")) {
    score += 0.1;
    signals.push("narrative_role");
  }
  if (durationUs >= 1_000_000 && durationUs <= 12_000_000) {
    score += 0.05;
    signals.push("usable_duration");
  }
  return { score: Math.min(1, score), signals };
}

export function buildVlogCandidates(
  shots: Shot[],
  videos: Video[],
  appearances: PersonAppearance[],
  speakerTracks: SpeakerTrack[],
  options: BuildVlogCandidatesOptions = {},
): VlogCandidateBuildResult {
  for (const range of options.sourceTimeRanges || []) {
    if (
      !range
      || typeof range.videoId !== "string"
      || !range.videoId
      || !Number.isSafeInteger(range.startUs)
      || !Number.isSafeInteger(range.endUs)
      || range.startUs < 0
      || range.endUs <= range.startUs
    ) {
      throw new Error("候选素材时间范围无效");
    }
  }
  const rejected: CandidateRejection[] = [];
  const allowedVideoIds = options.videoIds?.length
    ? new Set(options.videoIds)
    : null;
  const videoById = new Map(
    videos
      .filter((video) => !allowedVideoIds || allowedVideoIds.has(video.id))
      .map((video) => [video.id, video]),
  );
  const seenShotIds = new Set<string>();
  const rawCandidates: VlogCandidate[] = [];
  const minimumDurationUs = options.minimumDurationUs ?? 400_000;

  for (const shot of shots) {
    const videoId = shot.videoId || shot.assetProjectId;
    if (allowedVideoIds && !allowedVideoIds.has(videoId)) continue;
    if (!shot.id || seenShotIds.has(shot.id)) {
      rejected.push({
        shotId: shot.id || "(missing)",
        code: "DUPLICATE_SHOT",
        message: "重复 shotId 已过滤。",
      });
      continue;
    }
    seenShotIds.add(shot.id);

    const startUs = secondsToUs(shot.startSec);
    const endUs = secondsToUs(shot.endSec);
    if (startUs == null || endUs == null || endUs <= startUs) {
      rejected.push({ shotId: shot.id, code: "INVALID_TIME", message: "Shot 时间范围无效。" });
      continue;
    }
    const durationUs = endUs - startUs;
    if (durationUs < minimumDurationUs) {
      rejected.push({ shotId: shot.id, code: "TOO_SHORT", message: "Shot 时长过短。" });
      continue;
    }
    const video = videoById.get(videoId);
    if (!video) {
      rejected.push({ shotId: shot.id, code: "MISSING_VIDEO", message: "Shot 对应素材不存在。" });
      continue;
    }
    const sourcePath = video.localPath || video.localFilePath;
    if (!sourcePath) {
      rejected.push({
        shotId: shot.id,
        code: "MISSING_SOURCE_PATH",
        message: "素材没有本地文件路径，无法进入可执行剪辑方案。",
      });
      continue;
    }

    const events = timedEventSegments(shot.eventSegments, startUs, endUs);
    const subtitles = transcriptSegments(shot.subtitleSegments, startUs, endUs);
    const personAppearances = appearances.flatMap((appearance) => {
      if (appearance.videoId !== videoId) return [];
      const range = clippedRange(appearance.startSec, appearance.endSec, startUs, endUs);
      if (!range) return [];
      const personId = trustedPersonId(appearance, options.minimumIdentityConfidence);
      return [{
        appearanceId: appearance.id,
        trackId: appearance.trackId,
        ...(personId ? { personId } : {}),
        ...range,
        detectionConfidence: appearance.confidence,
        ...(appearance.identityConfidence == null
          ? {}
          : { identityConfidence: appearance.identityConfidence }),
        ...(appearance.manualLocked ? { manualConfirmed: true } : {}),
        ...(appearance.focusBounds ? { focusBounds: appearance.focusBounds } : {}),
      }];
    });
    const timedSpeakerTracks = speakerTracks.flatMap((track) => {
      if (track.videoId !== videoId) return [];
      const range = clippedRange(track.startSec, track.endSec, startUs, endUs);
      if (!range) return [];
      const linkedPersonId = track.personId && (
        track.manualLocked
        || (
          options.minimumIdentityConfidence != null
          && track.linkConfidence != null
          && track.linkConfidence >= options.minimumIdentityConfidence
        )
      )
        ? track.personId
        : undefined;
      return [{
        trackId: track.id,
        speakerId: track.speakerId,
        ...(linkedPersonId ? { personId: linkedPersonId } : {}),
        ...range,
        confidence: track.confidence,
        ...(track.linkConfidence == null ? {} : { linkConfidence: track.linkConfidence }),
        ...(track.manualLocked ? { manualConfirmed: true } : {}),
      }];
    });
    const transcriptGranularity = subtitles.length
      ? subtitles.every((segment) => segment.words?.length)
        ? "word" as const
        : "segment" as const
      : undefined;
    const alignedSegments = buildAlignedEvidenceSegments({
      startUs,
      endUs,
      eventSummary: String(shot.description || "").trim(),
      eventSegments: events,
      transcriptGranularity,
      subtitleSegments: subtitles,
      personAppearances,
      speakerTracks: timedSpeakerTracks,
    });
    const baseEvidence: VideoClipEvidence = {
      ...(shot.description ? { eventSummary: shot.description } : {}),
      ...(events.length ? { eventSegments: events } : {}),
      ...(transcriptGranularity ? { transcriptGranularity } : {}),
      ...(subtitles.length ? { subtitleSegments: subtitles } : {}),
      ...(personAppearances.length ? { personAppearances } : {}),
      ...(timedSpeakerTracks.length ? { speakerTracks: timedSpeakerTracks } : {}),
      alignedSegments,
    };
    const windows = buildCandidateWindows(
      shot.id,
      startUs,
      endUs,
      alignedSegments,
      {
        maximumDurationUs: options.maximumWindowDurationUs,
        minimumDurationUs: options.minimumWindowDurationUs,
      },
    );
    for (const window of windows) {
      const windowEvidence = clipVideoEvidenceToRange(
        baseEvidence,
        window.startUs,
        window.endUs,
      );
      const windowEvents = windowEvidence.eventSegments || [];
      const windowSubtitles = windowEvidence.subtitleSegments || [];
      const windowAppearances = windowEvidence.personAppearances || [];
      const windowSpeakerTracks = windowEvidence.speakerTracks || [];
      const windowPersonIds = windowEvidence.personIds || [];
      const windowSpeakerIds = windowEvidence.speakerIds || [];
      const windowDurationUs = window.endUs - window.startUs;
      const { score, signals } = scoreShot(
        shot,
        windowDurationUs,
        windowSubtitles.length,
      );
      const candidate: VlogCandidate = {
        candidateId: window.candidateId,
        shotId: shot.id,
        videoId,
        sourcePath,
        startUs: window.startUs,
        endUs: window.endUs,
        durationUs: windowDurationUs,
        description: String(windowEvidence.eventSummary || shot.description || "").trim(),
        eventSegments: windowEvents,
        subtitleSegments: windowSubtitles,
        ...(windowEvidence.transcriptGranularity
          ? { transcriptGranularity: windowEvidence.transcriptGranularity }
          : {}),
        personAppearances: windowAppearances,
        speakerTracks: windowSpeakerTracks,
        alignedSegments: windowEvidence.alignedSegments || [],
        boundaryReason: window.boundaryReason,
        personIds: windowPersonIds,
        speakerIds: windowSpeakerIds,
        usageTags: [...new Set(shot.usageTags || [])].sort(),
        qualityScore: score,
        qualitySignals: signals,
      };
      const filtered = filterCandidate(candidate, options);
      if (filtered) {
        rejected.push({
          shotId: shot.id,
          candidateId: window.candidateId,
          ...filtered,
        });
        continue;
      }
      rawCandidates.push(candidate);
    }
  }

  const ranked = rawCandidates.sort((a, b) =>
    b.qualityScore - a.qualityScore
    || b.durationUs - a.durationUs
    || a.videoId.localeCompare(b.videoId)
    || a.startUs - b.startUs
    || a.shotId.localeCompare(b.shotId));
  const deduplicated: VlogCandidate[] = [];
  for (const candidate of ranked) {
    if (deduplicated.some((kept) => temporalOverlapRatio(kept, candidate) >= 0.8)) {
      rejected.push({
        shotId: candidate.shotId,
        candidateId: candidate.candidateId,
        code: "OVERLAPPING_DUPLICATE",
        message: "与同素材中更高质量的候选时间范围高度重叠。",
      });
      continue;
    }
    deduplicated.push(candidate);
  }

  const maximumCandidates = Math.max(1, options.maximumCandidates ?? 120);
  return {
    candidates: deduplicated.slice(0, maximumCandidates),
    rejected,
  };
}
