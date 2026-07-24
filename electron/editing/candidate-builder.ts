import type {
  PersonAppearance,
  Shot,
  ShotTranscriptSegment,
  SpeakerTrack,
  Video,
} from "../../src/types";

export type VlogCandidate = {
  shotId: string;
  videoId: string;
  sourcePath: string;
  startUs: number;
  endUs: number;
  durationUs: number;
  description: string;
  subtitleSegments: Array<{
    startUs: number;
    endUs: number;
    text: string;
    speakerId?: string;
  }>;
  personIds: string[];
  speakerIds: string[];
  usageTags: string[];
  qualityScore: number;
  qualitySignals: string[];
};

export type CandidateRejection = {
  shotId: string;
  code:
    | "INVALID_TIME"
    | "MISSING_VIDEO"
    | "MISSING_SOURCE_PATH"
    | "TOO_SHORT"
    | "DUPLICATE_SHOT"
    | "OVERLAPPING_DUPLICATE";
  message: string;
};

export type BuildVlogCandidatesOptions = {
  videoIds?: string[];
  minimumDurationUs?: number;
  maximumCandidates?: number;
  minimumIdentityConfidence?: number;
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
    }))
    .filter((segment): segment is {
      startUs: number;
      endUs: number;
      text: string;
      speakerId: string | undefined;
    } =>
      segment.startUs != null
      && segment.endUs != null
      && segment.endUs > segment.startUs
      && segment.startUs < shotEndUs
      && segment.endUs > shotStartUs
      && Boolean(segment.text))
    .map((segment) => ({
      startUs: segment.startUs,
      endUs: segment.endUs,
      text: segment.text,
      ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
    }));
}

function overlapsRange(
  startUs: number,
  endUs: number,
  startSec: number,
  endSec: number,
): boolean {
  const otherStartUs = secondsToUs(startSec);
  const otherEndUs = secondsToUs(endSec);
  return otherStartUs != null
    && otherEndUs != null
    && otherStartUs < endUs
    && otherEndUs > startUs;
}

function temporalOverlapRatio(a: VlogCandidate, b: VlogCandidate): number {
  if (a.videoId !== b.videoId) return 0;
  const overlap = Math.max(0, Math.min(a.endUs, b.endUs) - Math.max(a.startUs, b.startUs));
  const shorter = Math.min(a.durationUs, b.durationUs);
  return shorter > 0 ? overlap / shorter : 0;
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

    const subtitles = transcriptSegments(shot.subtitleSegments, startUs, endUs);
    const trustedPeople = appearances
      .filter((appearance) =>
        appearance.videoId === videoId
        && appearance.personId
        && (
          appearance.manualLocked
          || (
            options.minimumIdentityConfidence != null
            && appearance.identityConfidence != null
            && appearance.identityConfidence >= options.minimumIdentityConfidence
          )
        )
        && overlapsRange(startUs, endUs, appearance.startSec, appearance.endSec))
      .map((appearance) => appearance.personId as string);
    const speakers = speakerTracks
      .filter((track) =>
        track.videoId === videoId
        && overlapsRange(startUs, endUs, track.startSec, track.endSec))
      .map((track) => track.speakerId);
    const { score, signals } = scoreShot(shot, durationUs, subtitles.length);
    rawCandidates.push({
      shotId: shot.id,
      videoId,
      sourcePath,
      startUs,
      endUs,
      durationUs,
      description: String(shot.description || "").trim(),
      subtitleSegments: subtitles,
      personIds: [...new Set(trustedPeople)].sort(),
      speakerIds: [...new Set(speakers)].sort(),
      usageTags: [...new Set(shot.usageTags || [])].sort(),
      qualityScore: score,
      qualitySignals: signals,
    });
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
