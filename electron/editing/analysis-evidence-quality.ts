import type {
  AnalysisEvidenceQualityIssue,
  AnalysisEvidenceQualityReport,
  PersonAppearance,
  Shot,
  SpeakerTrack,
  Video,
} from "../../src/types";
import type { VlogCandidateBuildResult } from "./candidate-builder";
import {
  hasUsableWordTimings,
  wordTimingTextCoverage,
} from "./transcript-evidence";

export type BuildAnalysisEvidenceQualityOptions = {
  generatedAt?: number;
  minimumIdentityConfidence?: number;
};

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function validRange(start: number, end: number, maximum?: number): boolean {
  return Number.isFinite(start)
    && Number.isFinite(end)
    && start >= 0
    && end > start
    && (maximum == null || end <= maximum + 0.001);
}

function isMeaningfulDescription(value: unknown): boolean {
  const text = String(value || "").trim();
  return Boolean(text) && !/^镜头\s*\d+$/.test(text) && text !== "未分析" && text !== "—";
}

function isTrustedAppearance(
  appearance: PersonAppearance,
  minimumIdentityConfidence: number | undefined,
): boolean {
  return Boolean(
    appearance.personId
    && (
      appearance.manualLocked
      || (
        minimumIdentityConfidence != null
        && appearance.identityConfidence != null
        && appearance.identityConfidence >= minimumIdentityConfidence
      )
    ),
  );
}

export function buildAnalysisEvidenceQualityReport(
  videos: Video[],
  shots: Shot[],
  appearances: PersonAppearance[],
  speakerTracks: SpeakerTrack[],
  candidateResult: VlogCandidateBuildResult,
  options: BuildAnalysisEvidenceQualityOptions = {},
): AnalysisEvidenceQualityReport {
  const videoById = new Map(videos.map((video) => [video.id, video]));
  const scopedVideoIds = new Set(videoById.keys());
  const scopedShots = shots.filter((shot) =>
    scopedVideoIds.has(shot.videoId || shot.assetProjectId));
  const scopedAppearances = appearances.filter((appearance) =>
    scopedVideoIds.has(appearance.videoId));
  const scopedSpeakers = speakerTracks.filter((track) =>
    scopedVideoIds.has(track.videoId));

  let transcriptSegmentCount = 0;
  let wordTimedSegmentCount = 0;
  let wordTimingCoverageSum = 0;
  let invalidSegmentCount = 0;
  let shotsWithTranscript = 0;
  const videosWithTranscript = new Set<string>();

  for (const shot of scopedShots) {
    const videoId = shot.videoId || shot.assetProjectId;
    const videoDuration = videoById.get(videoId)?.durationSec;
    let validSegmentsInShot = 0;
    for (const segment of shot.subtitleSegments || []) {
      const segmentValid = validRange(segment.startSec, segment.endSec, videoDuration)
        && segment.endSec > shot.startSec
        && segment.startSec < shot.endSec
        && Boolean(String(segment.text || "").trim());
      if (!segmentValid) {
        invalidSegmentCount += 1;
        continue;
      }
      transcriptSegmentCount += 1;
      validSegmentsInShot += 1;
      const wordTimingCoverage = wordTimingTextCoverage(segment);
      wordTimingCoverageSum += wordTimingCoverage;
      if (hasUsableWordTimings(segment)) {
        wordTimedSegmentCount += 1;
      }
    }
    if (validSegmentsInShot > 0) {
      shotsWithTranscript += 1;
      videosWithTranscript.add(videoId);
    }
  }

  let invalidAppearanceCount = 0;
  let trustedAppearanceCount = 0;
  let unassignedAppearanceCount = 0;
  let untrustedAppearanceCount = 0;
  const videosWithIdentityTracks = new Set<string>();
  const trustedPersonVideos = new Map<string, Set<string>>();

  for (const appearance of scopedAppearances) {
    const videoDuration = videoById.get(appearance.videoId)?.durationSec;
    if (!validRange(appearance.startSec, appearance.endSec, videoDuration)) {
      invalidAppearanceCount += 1;
      continue;
    }
    videosWithIdentityTracks.add(appearance.videoId);
    if (!appearance.personId) {
      unassignedAppearanceCount += 1;
      continue;
    }
    if (!isTrustedAppearance(appearance, options.minimumIdentityConfidence)) {
      untrustedAppearanceCount += 1;
      continue;
    }
    trustedAppearanceCount += 1;
    const videoIds = trustedPersonVideos.get(appearance.personId) || new Set<string>();
    videoIds.add(appearance.videoId);
    trustedPersonVideos.set(appearance.personId, videoIds);
  }
  const crossVideoPersonCount = [...trustedPersonVideos.values()]
    .filter((videoIds) => videoIds.size >= 2)
    .length;

  let invalidSpeakerTrackCount = 0;
  let linkedSpeakerTrackCount = 0;
  const videosWithSpeakerTracks = new Set<string>();
  for (const track of scopedSpeakers) {
    const videoDuration = videoById.get(track.videoId)?.durationSec;
    if (!validRange(track.startSec, track.endSec, videoDuration) || !track.speakerId) {
      invalidSpeakerTrackCount += 1;
      continue;
    }
    videosWithSpeakerTracks.add(track.videoId);
    if (
      track.personId
      && (
        track.manualLocked
        || (
          options.minimumIdentityConfidence != null
          && track.linkConfidence != null
          && track.linkConfidence >= options.minimumIdentityConfidence
        )
      )
    ) {
      linkedSpeakerTrackCount += 1;
    }
  }

  const describedShotCount = scopedShots.filter((shot) =>
    isMeaningfulDescription(shot.description)).length;
  const issues: AnalysisEvidenceQualityIssue[] = [];
  if (candidateResult.candidates.length === 0) {
    issues.push({
      code: "NO_ELIGIBLE_SHOTS",
      severity: "error",
      message: "没有同时具备有效时间和本地源文件的 Shot，不能生成可执行粗剪。",
    });
  }
  if (describedShotCount < scopedShots.length) {
    issues.push({
      code: "SEMANTIC_DESCRIPTION_INCOMPLETE",
      severity: "warning",
      message: `${scopedShots.length - describedShotCount} 个 Shot 缺少可用的事件描述。`,
    });
  }
  if (transcriptSegmentCount === 0) {
    issues.push({
      code: "TIMED_TRANSCRIPT_MISSING",
      severity: "warning",
      message: "没有可用的带时间字幕，Planner 只能依赖画面语义。",
    });
  } else if (wordTimedSegmentCount < transcriptSegmentCount) {
    issues.push({
      code: "WORD_TIMING_INCOMPLETE",
      severity: "info",
      message: "字幕为分段级时间，不能按逐字时间做精确卡点或关键词高亮。",
    });
  }
  if (invalidSegmentCount > 0) {
    issues.push({
      code: "TRANSCRIPT_RANGE_INVALID",
      severity: "error",
      message: `${invalidSegmentCount} 个字幕分段时间越界或无效，已从质量统计中排除。`,
    });
  }
  if (scopedAppearances.length === 0) {
    issues.push({
      code: "PERSON_TRACKING_MISSING",
      severity: "warning",
      message: "没有人物出镜轨迹，Planner 不会猜测人物身份。",
    });
  } else if (crossVideoPersonCount === 0) {
    issues.push({
      code: "CROSS_VIDEO_IDENTITY_MISSING",
      severity: "info",
      message: "当前没有达到可信阈值的跨素材同一人物。",
    });
  }
  if (invalidAppearanceCount > 0) {
    issues.push({
      code: "PERSON_RANGE_INVALID",
      severity: "error",
      message: `${invalidAppearanceCount} 条人物出镜区间越界或无效。`,
    });
  }
  if (scopedSpeakers.length === 0) {
    issues.push({
      code: "SPEAKER_DIARIZATION_MISSING",
      severity: "info",
      message: "没有说话人分离轨迹，字幕不能可靠归属到具体人物。",
    });
  }
  if (invalidSpeakerTrackCount > 0) {
    issues.push({
      code: "SPEAKER_RANGE_INVALID",
      severity: "error",
      message: `${invalidSpeakerTrackCount} 条说话人区间越界或无效。`,
    });
  }

  const readiness = candidateResult.candidates.length === 0
    ? "blocked"
    : issues.length > 0
      ? "partial"
      : "ready";
  const transcriptCapability = transcriptSegmentCount === 0
    ? "none"
    : wordTimedSegmentCount === transcriptSegmentCount
      ? "word"
      : "segment";
  const identityCapability = videosWithIdentityTracks.size === 0
    ? "none"
    : crossVideoPersonCount > 0
      ? "cross_video"
      : "tracking";
  const speakerCapability = videosWithSpeakerTracks.size === 0
    ? "none"
    : linkedSpeakerTrackCount > 0
      ? "linked"
      : "diarized";

  return {
    generatedAt: options.generatedAt ?? Date.now(),
    videoCount: scopedVideoIds.size,
    shotCount: scopedShots.length,
    semantic: {
      describedShotCount,
      coverageRatio: ratio(describedShotCount, scopedShots.length),
    },
    transcript: {
      capability: transcriptCapability,
      segmentCount: transcriptSegmentCount,
      wordTimedSegmentCount,
      wordTimingCoverageRatio: transcriptSegmentCount > 0
        ? Math.round((wordTimingCoverageSum / transcriptSegmentCount) * 10_000) / 10_000
        : 0,
      invalidSegmentCount,
      videosWithTranscript: videosWithTranscript.size,
      shotCoverageRatio: ratio(shotsWithTranscript, scopedShots.length),
    },
    identity: {
      capability: identityCapability,
      appearanceCount: scopedAppearances.length,
      trustedAppearanceCount,
      unassignedAppearanceCount,
      untrustedAppearanceCount,
      invalidAppearanceCount,
      videosWithTracks: videosWithIdentityTracks.size,
      crossVideoPersonCount,
    },
    speakers: {
      capability: speakerCapability,
      trackCount: scopedSpeakers.length,
      invalidTrackCount: invalidSpeakerTrackCount,
      linkedTrackCount: linkedSpeakerTrackCount,
      videosWithTracks: videosWithSpeakerTracks.size,
    },
    planning: {
      readiness,
      eligibleCandidateCount: candidateResult.candidates.length,
      rejectedCandidateCount: candidateResult.rejected.length,
      issues,
    },
  };
}
