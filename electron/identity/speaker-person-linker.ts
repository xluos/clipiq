import type {
  PersonAppearance,
  SpeakerTrack,
} from "../../src/types";

export type SpeakerPersonLinkPolicy = {
  minimumIdentityConfidence: number;
  minimumSpeakingConfidence: number;
  minimumOverlapCoverage: number;
  minimumDominance: number;
  minimumScoreMargin: number;
};

export const DEFAULT_SPEAKER_PERSON_LINK_POLICY: SpeakerPersonLinkPolicy = {
  minimumIdentityConfidence: 0.8,
  minimumSpeakingConfidence: 0.85,
  minimumOverlapCoverage: 0.5,
  minimumDominance: 0.8,
  minimumScoreMargin: 0.2,
};

export type SpeakerPersonLinkDecisionReason =
  | "linked"
  | "manual_preserved"
  | "no_speaking_evidence"
  | "untrusted_identity"
  | "insufficient_coverage"
  | "ambiguous_people";

export type SpeakerPersonLinkDecision = {
  trackId: string;
  speakerId: string;
  personId?: string;
  linkConfidence?: number;
  reason: SpeakerPersonLinkDecisionReason;
  coverage?: number;
  speakingConfidence?: number;
  dominance?: number;
};

export type SpeakerPersonLinkResult = {
  speakerTracks: SpeakerTrack[];
  decisions: SpeakerPersonLinkDecision[];
  linkedTrackCount: number;
};

type SpeakingInterval = {
  startSec: number;
  endSec: number;
  confidence: number;
};

type PersonCandidate = {
  personId: string;
  coverage: number;
  speakingConfidence: number;
  score: number;
};

function finiteUnit(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function intervalStats(
  track: SpeakerTrack,
  intervals: SpeakingInterval[],
): Pick<PersonCandidate, "coverage" | "speakingConfidence" | "score"> {
  const duration = track.endSec - track.startSec;
  const points = [...new Set([
    track.startSec,
    track.endSec,
    ...intervals.flatMap((item) => [
      Math.max(track.startSec, item.startSec),
      Math.min(track.endSec, item.endSec),
    ]),
  ])].filter(Number.isFinite).sort((left, right) => left - right);
  let coveredSec = 0;
  let weightedSec = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const startSec = points[index];
    const endSec = points[index + 1];
    if (!(endSec > startSec)) continue;
    const confidence = Math.max(
      0,
      ...intervals
        .filter((item) => item.startSec < endSec && item.endSec > startSec)
        .map((item) => item.confidence),
    );
    if (confidence <= 0) continue;
    const segmentDuration = endSec - startSec;
    coveredSec += segmentDuration;
    weightedSec += segmentDuration * confidence;
  }
  const coverage = duration > 0 ? Math.min(1, coveredSec / duration) : 0;
  const speakingConfidence = coveredSec > 0 ? weightedSec / coveredSec : 0;
  return {
    coverage: round(coverage),
    speakingConfidence: round(speakingConfidence),
    score: round(coverage * speakingConfidence),
  };
}

function withoutAutomaticLink(track: SpeakerTrack): SpeakerTrack {
  const {
    personId: _personId,
    linkConfidence: _linkConfidence,
    ...rest
  } = track;
  return rest;
}

/**
 * 只用显式口型活动证据做自动关联。
 *
 * 同时出镜、人脸检测置信度或单纯时间重叠都不是“此人正在说话”的证据；
 * 多人竞争、身份不可信、覆盖不足时清除旧自动关联并保持未知。
 * 人工关联或人工取消关联（manualLocked）始终原样保留。
 */
export function linkSpeakerTracksToPeople(input: {
  speakerTracks: SpeakerTrack[];
  appearances: PersonAppearance[];
  policy?: Partial<SpeakerPersonLinkPolicy>;
}): SpeakerPersonLinkResult {
  const policy = {
    ...DEFAULT_SPEAKER_PERSON_LINK_POLICY,
    ...input.policy,
  };
  const decisions: SpeakerPersonLinkDecision[] = [];
  const speakerTracks = input.speakerTracks.map((track) => {
    if (track.manualLocked) {
      decisions.push({
        trackId: track.id,
        speakerId: track.speakerId,
        ...(track.personId ? { personId: track.personId } : {}),
        ...(track.linkConfidence == null
          ? {}
          : { linkConfidence: track.linkConfidence }),
        reason: "manual_preserved",
      });
      return track;
    }

    const overlapping = input.appearances.filter((appearance) => (
      appearance.videoId === track.videoId
      && appearance.startSec < track.endSec
      && appearance.endSec > track.startSec
      && finiteUnit(appearance.speakingConfidence)
      && appearance.speakingConfidence >= policy.minimumSpeakingConfidence
    ));
    if (overlapping.length === 0) {
      decisions.push({
        trackId: track.id,
        speakerId: track.speakerId,
        reason: "no_speaking_evidence",
      });
      return withoutAutomaticLink(track);
    }

    const trusted = overlapping.filter((appearance) => (
      Boolean(appearance.personId)
      && (
        appearance.manualLocked
        || (
          finiteUnit(appearance.identityConfidence)
          && appearance.identityConfidence >= policy.minimumIdentityConfidence
        )
      )
    ));
    if (trusted.length === 0) {
      decisions.push({
        trackId: track.id,
        speakerId: track.speakerId,
        reason: "untrusted_identity",
      });
      return withoutAutomaticLink(track);
    }

    const intervalsByPerson = new Map<string, SpeakingInterval[]>();
    for (const appearance of trusted) {
      const personId = appearance.personId!;
      const intervals = intervalsByPerson.get(personId) || [];
      intervals.push({
        startSec: Math.max(track.startSec, appearance.startSec),
        endSec: Math.min(track.endSec, appearance.endSec),
        confidence: appearance.speakingConfidence!,
      });
      intervalsByPerson.set(personId, intervals);
    }
    const candidates: PersonCandidate[] = [...intervalsByPerson.entries()]
      .map(([personId, intervals]) => ({
        personId,
        ...intervalStats(track, intervals),
      }))
      .sort((left, right) =>
        right.score - left.score || left.personId.localeCompare(right.personId));
    const top = candidates[0];
    if (!top || top.coverage < policy.minimumOverlapCoverage) {
      decisions.push({
        trackId: track.id,
        speakerId: track.speakerId,
        reason: "insufficient_coverage",
        ...(top
          ? {
            coverage: top.coverage,
            speakingConfidence: top.speakingConfidence,
          }
          : {}),
      });
      return withoutAutomaticLink(track);
    }
    const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
    const secondScore = candidates[1]?.score || 0;
    const dominance = totalScore > 0 ? top.score / totalScore : 0;
    const margin = top.score - secondScore;
    if (
      dominance < policy.minimumDominance
      || margin < policy.minimumScoreMargin
    ) {
      decisions.push({
        trackId: track.id,
        speakerId: track.speakerId,
        reason: "ambiguous_people",
        coverage: top.coverage,
        speakingConfidence: top.speakingConfidence,
        dominance: round(dominance),
      });
      return withoutAutomaticLink(track);
    }
    const linkConfidence = round(Math.min(
      top.speakingConfidence,
      0.75 + top.coverage * 0.25,
      dominance,
    ));
    decisions.push({
      trackId: track.id,
      speakerId: track.speakerId,
      personId: top.personId,
      linkConfidence,
      reason: "linked",
      coverage: top.coverage,
      speakingConfidence: top.speakingConfidence,
      dominance: round(dominance),
    });
    return {
      ...track,
      personId: top.personId,
      linkConfidence,
    };
  });
  return {
    speakerTracks,
    decisions,
    linkedTrackCount: decisions.filter((decision) =>
      decision.reason === "linked").length,
  };
}
