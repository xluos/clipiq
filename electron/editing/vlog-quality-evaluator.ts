import type {
  EditFeedbackEvent,
  EditPlan,
  Shot,
} from "../../src/types";
import type { VlogCandidate } from "./candidate-builder";

export type QualityRate = {
  failures: number;
  total: number;
  rate: number;
};

export type RuntimeAttemptMetric = {
  attempted: number;
  succeeded: number;
  successRate: number | null;
};

export type IdentityGroundTruthItem = {
  appearanceId: string;
  videoId: string;
  expectedPersonKey: string;
  predictedPersonId?: string;
};

export type VlogQualityEvaluationInput = {
  candidates: VlogCandidate[];
  plan: EditPlan;
  initialPlan?: EditPlan;
  shots: Shot[];
  previewAttempts?: Array<{ succeeded: boolean }>;
  jianyingDraftOpenAttempts?: Array<{ succeeded: boolean }>;
  identityGroundTruth?: IdentityGroundTruthItem[];
  feedbackEvents?: EditFeedbackEvent[];
};

export type VlogQualityEvaluationReport = {
  planId: string;
  generatedAt: number;
  technical: {
    candidateBindingViolations: QualityRate;
    shotBoundsViolations: QualityRate;
    subtitleRangeViolations: QualityRate;
    eventRangeViolations: QualityRate;
    preview: RuntimeAttemptMetric;
    jianyingDraftOpen: RuntimeAttemptMetric;
  };
  identity: {
    status: "measured" | "not_evaluated";
    comparedCrossVideoPairCount: number;
    crossVideoExpectedPairCount: number;
    predictedSamePairCount: number;
    matchedSamePairCount: number;
    falseMergePairCount: number;
    recall: number | null;
    precision: number | null;
  };
  editing: {
    operationCount: number;
    retainedClipRatio: number | null;
    reorderedClipRatio: number | null;
    replacementRatio: number | null;
  };
  gates: Array<{
    key:
      | "candidate_binding"
      | "shot_bounds"
      | "subtitle_ranges"
      | "event_ranges"
      | "preview_success"
      | "jianying_open"
      | "identity_false_merge";
    target: string;
    passed: boolean | null;
  }>;
  status: "passed" | "failed" | "partial";
};

function rate(failures: number, total: number): QualityRate {
  return {
    failures,
    total,
    rate: total > 0 ? failures / total : 0,
  };
}

function runtimeMetric(
  attempts: Array<{ succeeded: boolean }> | undefined,
): RuntimeAttemptMetric {
  const attempted = attempts?.length || 0;
  const succeeded = attempts?.filter((attempt) => attempt.succeeded).length || 0;
  return {
    attempted,
    succeeded,
    successRate: attempted > 0 ? succeeded / attempted : null,
  };
}

function videoClips(plan: EditPlan) {
  const track = plan.tracks.find((item) => item.kind === "video");
  return track?.kind === "video" ? track.items : [];
}

function evaluateIdentity(items: IdentityGroundTruthItem[] | undefined) {
  if (!items || items.length < 2) {
    return {
      status: "not_evaluated" as const,
      comparedCrossVideoPairCount: 0,
      crossVideoExpectedPairCount: 0,
      predictedSamePairCount: 0,
      matchedSamePairCount: 0,
      falseMergePairCount: 0,
      recall: null,
      precision: null,
    };
  }
  let crossVideoExpectedPairCount = 0;
  let comparedCrossVideoPairCount = 0;
  let predictedSamePairCount = 0;
  let matchedSamePairCount = 0;
  let falseMergePairCount = 0;
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      if (left.videoId === right.videoId) continue;
      comparedCrossVideoPairCount += 1;
      const expectedSame = left.expectedPersonKey === right.expectedPersonKey;
      const predictedSame = Boolean(
        left.predictedPersonId
        && right.predictedPersonId
        && left.predictedPersonId === right.predictedPersonId,
      );
      if (expectedSame) crossVideoExpectedPairCount += 1;
      if (predictedSame) predictedSamePairCount += 1;
      if (expectedSame && predictedSame) matchedSamePairCount += 1;
      if (!expectedSame && predictedSame) falseMergePairCount += 1;
    }
  }
  if (comparedCrossVideoPairCount === 0) {
    return {
      status: "not_evaluated" as const,
      comparedCrossVideoPairCount,
      crossVideoExpectedPairCount,
      predictedSamePairCount,
      matchedSamePairCount,
      falseMergePairCount,
      recall: null,
      precision: null,
    };
  }
  return {
    status: "measured" as const,
    comparedCrossVideoPairCount,
    crossVideoExpectedPairCount,
    predictedSamePairCount,
    matchedSamePairCount,
    falseMergePairCount,
    recall: crossVideoExpectedPairCount > 0
      ? matchedSamePairCount / crossVideoExpectedPairCount
      : null,
    precision: predictedSamePairCount > 0
      ? matchedSamePairCount / predictedSamePairCount
      : null,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function evaluateVlogQuality(
  input: VlogQualityEvaluationInput,
  generatedAt = Date.now(),
): VlogQualityEvaluationReport {
  const clips = videoClips(input.plan);
  const candidateById = new Map(
    input.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const shotById = new Map(input.shots.map((shot) => [shot.id, shot]));
  let candidateBindingFailureCount = 0;
  let shotBoundsFailureCount = 0;
  let subtitleFailureCount = 0;
  let subtitleCount = 0;
  let eventFailureCount = 0;
  let eventCount = 0;

  for (const clip of clips) {
    const candidate = clip.candidateId
      ? candidateById.get(clip.candidateId)
      : undefined;
    if (
      !candidate
      || candidate.shotId !== clip.shotId
      || candidate.videoId !== clip.videoId
      || clip.sourceInUs < candidate.startUs
      || clip.sourceOutUs > candidate.endUs
    ) {
      candidateBindingFailureCount += 1;
    }
    const shot = shotById.get(clip.shotId);
    const shotStartUs = shot ? Math.round(shot.startSec * 1_000_000) : null;
    const shotEndUs = shot ? Math.round(shot.endSec * 1_000_000) : null;
    if (
      !shot
      || (shot.videoId || shot.assetProjectId) !== clip.videoId
      || shotStartUs == null
      || shotEndUs == null
      || clip.sourceInUs < shotStartUs
      || clip.sourceOutUs > shotEndUs
    ) {
      shotBoundsFailureCount += 1;
    }
    for (const segment of clip.evidence?.subtitleSegments || []) {
      subtitleCount += 1;
      if (
        segment.startUs < clip.sourceInUs
        || segment.endUs > clip.sourceOutUs
        || segment.endUs <= segment.startUs
      ) {
        subtitleFailureCount += 1;
      }
    }
    for (const segment of clip.evidence?.eventSegments || []) {
      eventCount += 1;
      if (
        segment.startUs < clip.sourceInUs
        || segment.endUs > clip.sourceOutUs
        || segment.endUs <= segment.startUs
        || !segment.summary.trim()
      ) {
        eventFailureCount += 1;
      }
    }
  }

  const preview = runtimeMetric(input.previewAttempts);
  const jianyingDraftOpen = runtimeMetric(input.jianyingDraftOpenAttempts);
  const identity = evaluateIdentity(input.identityGroundTruth);
  const feedbackEvents = input.feedbackEvents || [];
  const initialClips = input.initialPlan ? videoClips(input.initialPlan) : [];
  const finalClipIds = new Set(clips.map((clip) => clip.id));
  const retainedInitialClips = initialClips.filter((clip) => finalClipIds.has(clip.id));
  const movedClipIds = new Set(
    feedbackEvents
      .filter((event) => event.action.type === "move_clip")
      .map((event) => event.action.type === "move_clip" ? event.action.clipId : ""),
  );
  const replacedClipIds = new Set(
    feedbackEvents
      .filter((event) => event.action.type === "replace_clip")
      .map((event) =>
        event.action.type === "replace_clip" ? event.action.clipId : ""),
  );
  const candidateBindingViolations = rate(candidateBindingFailureCount, clips.length);
  const shotBoundsViolations = rate(shotBoundsFailureCount, clips.length);
  const subtitleRangeViolations = rate(subtitleFailureCount, subtitleCount);
  const eventRangeViolations = rate(eventFailureCount, eventCount);
  const gates: VlogQualityEvaluationReport["gates"] = [
    {
      key: "candidate_binding",
      target: "0%",
      passed: candidateBindingViolations.failures === 0,
    },
    {
      key: "shot_bounds",
      target: "0%",
      passed: shotBoundsViolations.failures === 0,
    },
    {
      key: "subtitle_ranges",
      target: "0%",
      passed: subtitleRangeViolations.failures === 0,
    },
    {
      key: "event_ranges",
      target: "0%",
      passed: eventRangeViolations.failures === 0,
    },
    {
      key: "preview_success",
      target: "100%",
      passed: preview.successRate == null ? null : preview.successRate === 1,
    },
    {
      key: "jianying_open",
      target: "100%",
      passed: jianyingDraftOpen.successRate == null
        ? null
        : jianyingDraftOpen.successRate === 1,
    },
    {
      key: "identity_false_merge",
      target: "0",
      passed: identity.status === "measured"
        ? identity.falseMergePairCount === 0
        : null,
    },
  ];
  const measuredGates = gates.filter((gate) => gate.passed != null);
  const status = measuredGates.some((gate) => gate.passed === false)
    ? "failed"
    : gates.some((gate) => gate.passed == null)
      ? "partial"
      : "passed";

  return {
    planId: input.plan.id,
    generatedAt,
    technical: {
      candidateBindingViolations,
      shotBoundsViolations,
      subtitleRangeViolations,
      eventRangeViolations,
      preview,
      jianyingDraftOpen,
    },
    identity,
    editing: {
      operationCount: feedbackEvents.length,
      retainedClipRatio: ratio(retainedInitialClips.length, initialClips.length),
      reorderedClipRatio: ratio(movedClipIds.size, initialClips.length),
      replacementRatio: ratio(replacedClipIds.size, initialClips.length),
    },
    gates,
    status,
  };
}
