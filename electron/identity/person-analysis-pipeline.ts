import type {
  IdentityEvidenceBatch,
  PersonAppearanceEvidence,
} from "../repositories/identity-repository";
import {
  validateFaceProviderForUse,
  type FaceAnalysisFrame,
  type FaceAnalysisProvider,
  type FaceProviderUsePolicy,
} from "./face-analysis-provider";
import {
  buildFaceTrackAppearances,
  buildFaceTracks,
  type FaceTrackPolicy,
} from "./face-tracker";
import {
  assignPersonIdentities,
} from "./person-identity-assignment";

export type PersonAnalysisRepository = {
  replaceEvidenceForVideo(videoId: string, batch: IdentityEvidenceBatch): void;
  listAppearanceEvidence?(videoId?: string): PersonAppearanceEvidence[];
  listPeople?(): import("../../src/types").Person[];
  listDifferentPersonPairs?(): Array<{ leftPersonId: string; rightPersonId: string }>;
};

export type PersonAnalysisResult = {
  status: "completed" | "unavailable";
  videoId: string;
  analyzedFrameCount: number;
  trackCount: number;
  appearanceCount: number;
  embeddingTrackCount: number;
  assignedTrackCount: number;
  matchedExistingPersonCount: number;
  reason?: string;
};

export type RunPersonAnalysisInput = {
  videoId: string;
  frames: FaceAnalysisFrame[];
  provider: FaceAnalysisProvider;
  repository: PersonAnalysisRepository;
  usePolicy: FaceProviderUsePolicy;
  trackPolicy?: Partial<FaceTrackPolicy>;
};

function validateInputFrames(videoId: string, frames: FaceAnalysisFrame[]): void {
  const frameIds = new Set<string>();
  for (const frame of frames) {
    if (frame.videoId !== videoId) {
      throw new Error(`人物分析帧 ${frame.frameId || "unknown"} 不属于视频 ${videoId}`);
    }
    if (!frame.frameId || frameIds.has(frame.frameId)) {
      throw new Error(`人物分析帧 ID 无效或重复: ${frame.frameId || "unknown"}`);
    }
    if (!Number.isFinite(frame.timeSec) || frame.timeSec < 0 || !frame.imagePath) {
      throw new Error(`人物分析帧无效: ${frame.frameId}`);
    }
    frameIds.add(frame.frameId);
  }
}

/**
 * 把人脸 Provider 与持久化解耦。
 *
 * Provider 未就绪时不清空旧证据；只有一次完整推理成功并通过归属校验后，
 * 才以原子 repository 操作替换该视频的自动人物出镜证据。
 */
export async function runPersonAppearanceAnalysis(
  input: RunPersonAnalysisInput,
): Promise<PersonAnalysisResult> {
  const {
    videoId,
    frames,
    provider,
    repository,
    usePolicy,
    trackPolicy,
  } = input;
  if (!videoId) throw new Error("人物分析缺少 videoId");
  validateInputFrames(videoId, frames);

  const providerIssues = validateFaceProviderForUse(provider.descriptor, usePolicy);
  if (providerIssues.length > 0) {
    throw new Error(providerIssues.join("；"));
  }
  const readiness = await provider.getReadiness();
  if (readiness.ready === false) {
    return {
      status: "unavailable",
      videoId,
      analyzedFrameCount: 0,
      trackCount: 0,
      appearanceCount: 0,
      embeddingTrackCount: 0,
      assignedTrackCount: 0,
      matchedExistingPersonCount: 0,
      reason: readiness.reason,
    };
  }

  const requestedFrames = new Map(frames.map((frame) => [frame.frameId, frame]));
  const analyses = await provider.analyzeFrames(frames);
  for (const analysis of analyses) {
    const requested = requestedFrames.get(analysis.frame.frameId);
    if (
      !requested
      || analysis.frame.videoId !== videoId
      || analysis.frame.imagePath !== requested.imagePath
      || analysis.frame.timeSec !== requested.timeSec
      || analysis.frame.evidenceStartSec !== requested.evidenceStartSec
      || analysis.frame.evidenceEndSec !== requested.evidenceEndSec
    ) {
      throw new Error(`人脸 Provider 返回了越界或被篡改的帧: ${analysis.frame.frameId}`);
    }
  }

  const tracks = buildFaceTracks(analyses, trackPolicy);
  const rawAppearances: PersonAppearanceEvidence[] = buildFaceTrackAppearances(tracks);
  const identity = assignPersonIdentities({
    videoId,
    appearances: rawAppearances,
    existingEvidence: repository.listAppearanceEvidence?.() || [],
    people: repository.listPeople?.() || [],
    differentPersonPairs: repository.listDifferentPersonPairs?.() || [],
  });
  const batch: IdentityEvidenceBatch = {
    appearances: identity.appearances,
    ...(identity.people.length ? { people: identity.people } : {}),
  };
  repository.replaceEvidenceForVideo(videoId, batch);
  return {
    status: "completed",
    videoId,
    analyzedFrameCount: analyses.length,
    trackCount: tracks.length,
    appearanceCount: identity.appearances.length,
    embeddingTrackCount: tracks.filter((track) => track.prototypeEmbedding).length,
    assignedTrackCount: identity.decisions.filter((decision) => decision.personId).length,
    matchedExistingPersonCount: identity.decisions.filter(
      (decision) => decision.reason === "matched",
    ).length,
  };
}
