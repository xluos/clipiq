import { describe, expect, it, vi } from "vitest";
import type {
  FaceAnalysisProvider,
  FaceAnalysisProviderDescriptor,
  FaceFrameAnalysis,
} from "../electron/identity/face-analysis-provider";
import { runPersonAppearanceAnalysis } from "../electron/identity/person-analysis-pipeline";

const descriptor: FaceAnalysisProviderDescriptor = {
  id: "test-provider",
  version: "1",
  capabilities: {
    detection: true,
    landmarks: false,
    embedding: false,
  },
  models: [{
    id: "test-detector",
    role: "detection",
    productionUse: "allowed",
  }],
};

function provider(
  analyses: FaceFrameAnalysis[],
  ready: true | string = true,
  providerDescriptor: FaceAnalysisProviderDescriptor = descriptor,
): FaceAnalysisProvider {
  return {
    descriptor: providerDescriptor,
    getReadiness: vi.fn(async () =>
      ready === true ? { ready: true } : { ready: false, reason: ready }),
    analyzeFrames: vi.fn(async () => analyses),
  };
}

const inputFrame = {
  videoId: "video-a",
  frameId: "frame-1",
  timeSec: 1,
  evidenceEndSec: 1.2,
  shotId: "shot-a",
  imagePath: "/frames/1.jpg",
  thumbnailUrl: "media://frame/1",
};

describe("人物分析编排", () => {
  it("Provider 未就绪时保留旧证据，不触发 repository 写入", async () => {
    const repository = { replaceEvidenceForVideo: vi.fn() };
    const result = await runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: provider([], "YuNet 模型未安装"),
      repository,
      usePolicy: { environment: "production" },
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "YuNet 模型未安装",
    });
    expect(repository.replaceEvidenceForVideo).not.toHaveBeenCalled();
  });

  it("完整分析成功后才替换该视频人物证据", async () => {
    const repository = { replaceEvidenceForVideo: vi.fn() };
    const result = await runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: provider([{
        frame: inputFrame,
        detections: [{
          detectionId: "face-1",
          bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.95,
          quality: 0.9,
        }],
      }]),
      repository,
      usePolicy: { environment: "production" },
    });

    expect(result).toEqual({
      status: "completed",
      videoId: "video-a",
      analyzedFrameCount: 1,
      trackCount: 1,
      appearanceCount: 1,
      embeddingTrackCount: 0,
      assignedTrackCount: 0,
      matchedExistingPersonCount: 0,
      linkedSpeakerTrackCount: 0,
      speakerLinkDecisions: [],
    });
    expect(repository.replaceEvidenceForVideo).toHaveBeenCalledWith(
      "video-a",
      {
        appearances: [
          expect.objectContaining({
            videoId: "video-a",
            shotId: "shot-a",
            startSec: 1,
            endSec: 1.2,
          }),
        ],
      },
    );
  });

  it("身份向量和独立口型证据都可信时重算已有说话人关联", async () => {
    const replaceEvidenceForVideo = vi.fn();
    const repository = {
      replaceEvidenceForVideo,
      listAppearanceEvidence: () => [{
        id: "existing-appearance",
        personId: "person-a",
        videoId: "video-b",
        trackId: "video-b:face-track-1",
        startSec: 0,
        endSec: 1,
        confidence: 0.95,
        identityConfidence: 1,
        source: "face_track" as const,
        embedding: [1, 0],
        embeddingModel: "licensed-face-v1",
        embeddingQuality: 0.9,
      }],
      listPeople: () => [{
        id: "person-a",
        status: "auto" as const,
      }],
      listDifferentPersonPairs: () => [],
      listSpeakerTracks: () => [{
        id: "speaker-track-1",
        videoId: "video-a",
        speakerId: "video-a:speaker:1",
        startSec: 1,
        endSec: 1.2,
        confidence: 0.5,
      }],
    };
    const speakingDescriptor: FaceAnalysisProviderDescriptor = {
      id: "licensed-speaking-provider",
      version: "1",
      capabilities: {
        detection: true,
        landmarks: true,
        embedding: true,
        speakingActivity: true,
      },
      models: [
        {
          id: "detector",
          role: "detection",
          productionUse: "allowed",
        },
        {
          id: "identity",
          role: "embedding",
          productionUse: "allowed",
        },
        {
          id: "lip-activity",
          role: "speaking_activity",
          productionUse: "allowed",
        },
      ],
    };

    const result = await runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: provider([{
        frame: inputFrame,
        detections: [{
          detectionId: "face-1",
          bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.95,
          quality: 0.9,
          speakingConfidence: 0.94,
          embedding: {
            modelId: "licensed-face-v1",
            vector: [1, 0],
          },
        }],
      }], true, speakingDescriptor),
      repository,
      usePolicy: { environment: "production" },
    });

    expect(result).toMatchObject({
      matchedExistingPersonCount: 1,
      linkedSpeakerTrackCount: 1,
      speakerLinkDecisions: [{
        reason: "linked",
        personId: "person-a",
      }],
    });
    expect(replaceEvidenceForVideo).toHaveBeenCalledWith("video-a", {
      appearances: [expect.objectContaining({
        personId: "person-a",
        speakingConfidence: 0.94,
      })],
      speakerTracks: [expect.objectContaining({
        personId: "person-a",
        linkConfidence: expect.any(Number),
      })],
    });
  });

  it("评测可覆盖身份阈值而不修改生产默认策略", async () => {
    const replaceEvidenceForVideo = vi.fn();
    const embeddingDescriptor: FaceAnalysisProviderDescriptor = {
      id: "licensed-embedding-provider",
      version: "1",
      capabilities: {
        detection: true,
        landmarks: true,
        embedding: true,
      },
      models: [
        {
          id: "detector",
          role: "detection",
          productionUse: "allowed",
        },
        {
          id: "identity",
          role: "embedding",
          productionUse: "allowed",
        },
      ],
    };
    const result = await runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: provider([{
        frame: inputFrame,
        detections: [{
          detectionId: "face-1",
          bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.95,
          quality: 0.9,
          embedding: {
            modelId: "licensed-face-v1",
            vector: [0.6, 0.8],
          },
        }],
      }], true, embeddingDescriptor),
      repository: {
        replaceEvidenceForVideo,
        listAppearanceEvidence: () => [{
          id: "existing-appearance",
          personId: "person-a",
          videoId: "video-b",
          trackId: "video-b:face-track-1",
          startSec: 0,
          endSec: 1,
          confidence: 0.95,
          source: "face_track" as const,
          embedding: [1, 0],
          embeddingModel: "licensed-face-v1",
          embeddingQuality: 0.9,
        }],
        listPeople: () => [{ id: "person-a", status: "auto" as const }],
        listDifferentPersonPairs: () => [],
      },
      usePolicy: { environment: "production" },
      identityPolicy: { autoMergeThreshold: 0.7 },
    });

    expect(result.matchedExistingPersonCount).toBe(0);
    expect(replaceEvidenceForVideo).toHaveBeenCalledWith("video-a", {
      appearances: [expect.objectContaining({
        personId: expect.stringMatching(/^person-auto-/),
      })],
      people: [expect.objectContaining({
        id: expect.stringMatching(/^person-auto-/),
      })],
    });
  });

  it("Provider 返回请求范围外的帧时拒绝写入", async () => {
    const repository = { replaceEvidenceForVideo: vi.fn() };
    await expect(runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: provider([{
        frame: { ...inputFrame, timeSec: 99 },
        detections: [],
      }]),
      repository,
      usePolicy: { environment: "production" },
    })).rejects.toThrow("人脸 Provider 返回了越界或被篡改的帧");
    expect(repository.replaceEvidenceForVideo).not.toHaveBeenCalled();
  });

  it("Provider 未声明独立口型能力时拒绝伪造说话证据", async () => {
    const repository = { replaceEvidenceForVideo: vi.fn() };
    await expect(runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: provider([{
        frame: inputFrame,
        detections: [{
          detectionId: "face-1",
          bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.95,
          quality: 0.9,
          speakingConfidence: 0.99,
        }],
      }]),
      repository,
      usePolicy: { environment: "production" },
    })).rejects.toThrow("返回了未声明的口型活动证据");
    expect(repository.replaceEvidenceForVideo).not.toHaveBeenCalled();
  });

  it("生产环境在启动推理前拒绝禁止商用的模型", async () => {
    const unsafeProvider = provider([], true, {
      ...descriptor,
      models: [{
        id: "research-only",
        role: "detection",
        productionUse: "blocked",
      }],
    });
    await expect(runPersonAppearanceAnalysis({
      videoId: "video-a",
      frames: [inputFrame],
      provider: unsafeProvider,
      repository: { replaceEvidenceForVideo: vi.fn() },
      usePolicy: { environment: "production" },
    })).rejects.toThrow("模型 research-only 的许可不允许进入生产分析");
    expect(unsafeProvider.getReadiness).not.toHaveBeenCalled();
  });
});
