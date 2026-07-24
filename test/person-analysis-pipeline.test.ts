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
