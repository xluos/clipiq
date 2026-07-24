import { describe, expect, it } from "vitest";
import {
  validateFaceProviderForUse,
  type FaceFrameAnalysis,
} from "../electron/identity/face-analysis-provider";
import {
  buildFaceTrackAppearances,
  buildFaceTracks,
} from "../electron/identity/face-tracker";

function frame(
  timeSec: number,
  shotId: string,
  detections: FaceFrameAnalysis["detections"],
): FaceFrameAnalysis {
  return {
    frame: {
      videoId: "video-a",
      frameId: `frame-${timeSec}`,
      timeSec,
      evidenceStartSec: timeSec,
      evidenceEndSec: timeSec + 0.2,
      shotId,
      imagePath: `/frames/${timeSec}.jpg`,
      thumbnailUrl: `media://frame/${timeSec}`,
    },
    detections,
  };
}

function face(
  detectionId: string,
  x: number,
  embedding?: number[],
): FaceFrameAnalysis["detections"][number] {
  return {
    detectionId,
    bbox: { x, y: 0.2, width: 0.2, height: 0.3 },
    confidence: 0.95,
    quality: 0.9,
    ...(embedding
      ? { embedding: { modelId: "licensed-face-v1", vector: embedding } }
      : {}),
  };
}

describe("人脸 Provider 许可门禁", () => {
  it("生产环境拒绝研究用途模型和未确认的用户模型", () => {
    const issues = validateFaceProviderForUse({
      id: "mixed-provider",
      version: "1",
      capabilities: { detection: true, landmarks: false, embedding: true },
      models: [
        {
          id: "yunet",
          role: "detection",
          productionUse: "allowed",
        },
        {
          id: "research-embedding",
          role: "embedding",
          productionUse: "blocked",
        },
        {
          id: "user-embedding",
          role: "embedding",
          productionUse: "requires_user_attestation",
        },
      ],
    }, { environment: "production" });

    expect(issues).toEqual([
      "模型 research-embedding 的许可不允许进入生产分析",
      "模型 user-embedding 需要用户确认许可后才能进入生产分析",
    ]);
  });

  it("开发环境仍校验能力声明，但不阻止模型实验", () => {
    expect(validateFaceProviderForUse({
      id: "broken-provider",
      version: "1",
      capabilities: { detection: false, landmarks: false, embedding: true },
      models: [],
    }, { environment: "development" })).toEqual([
      "人脸分析 Provider broken-provider 不具备检测能力",
      "人脸分析 Provider broken-provider 未声明检测模型",
      "人脸分析 Provider broken-provider 声明支持特征向量，但未声明 embedding 模型",
    ]);
  });
});

describe("单素材人脸轨迹", () => {
  it("同镜头内按空间连续性保持匿名 trackId", () => {
    const tracks = buildFaceTracks([
      frame(0, "shot-a", [face("a-1", 0.1)]),
      frame(0.5, "shot-a", [face("a-2", 0.12)]),
      frame(1, "shot-a", [face("a-3", 0.14)]),
    ]);

    expect(tracks).toHaveLength(1);
    expect(tracks[0].trackId).toBe("video-a:face-track-1");
    expect(tracks[0].observations).toHaveLength(3);
    const appearances = buildFaceTrackAppearances(tracks);
    expect(appearances).toMatchObject([{
      videoId: "video-a",
      shotId: "shot-a",
      trackId: "video-a:face-track-1",
      startSec: 0,
      endSec: 1.2,
    }]);
    expect(appearances[0]).not.toHaveProperty("personId");
  });

  it("没有人脸向量时不跨镜头误合并同一画面位置的人", () => {
    const tracks = buildFaceTracks([
      frame(0, "shot-a", [face("person-a", 0.1)]),
      frame(0.5, "shot-b", [face("person-b", 0.1)]),
    ]);

    expect(tracks).toHaveLength(2);
  });

  it("同模型高相似向量可以跨相邻镜头延续 trackId，并按 Shot 拆出区间", () => {
    const tracks = buildFaceTracks([
      frame(0, "shot-a", [face("a-1", 0.1, [1, 0, 0])]),
      frame(0.5, "shot-b", [face("a-2", 0.7, [0.99, 0.01, 0])]),
    ]);
    const appearances = buildFaceTrackAppearances(tracks);

    expect(tracks).toHaveLength(1);
    expect(appearances).toHaveLength(2);
    expect(new Set(appearances.map((appearance) => appearance.trackId)).size).toBe(1);
    expect(appearances.map((appearance) => appearance.shotId)).toEqual(["shot-a", "shot-b"]);
    expect(appearances[0].embeddingModel).toBe("licensed-face-v1");
  });

  it("多人交叉移动时使用向量避免轨迹互换", () => {
    const tracks = buildFaceTracks([
      frame(0, "shot-a", [
        face("left-a", 0.1, [1, 0]),
        face("right-b", 0.7, [0, 1]),
      ]),
      frame(0.5, "shot-a", [
        face("right-a", 0.7, [1, 0]),
        face("left-b", 0.1, [0, 1]),
      ]),
    ]);

    expect(tracks).toHaveLength(2);
    expect(tracks[0].observations.map((item) => item.detectionId)).toEqual([
      "left-a",
      "right-a",
    ]);
    expect(tracks[1].observations.map((item) => item.detectionId)).toEqual([
      "right-b",
      "left-b",
    ]);
  });

  it("不同向量模型即使在同一 Shot 也不能参与同一条轨迹关联", () => {
    const first = face("a-1", 0.1, [1, 0]);
    const second = face("a-2", 0.1, [1, 0]);
    if (second.embedding) second.embedding.modelId = "other-model";
    const tracks = buildFaceTracks([
      frame(0, "shot-a", [first]),
      frame(0.5, "shot-a", [second]),
    ]);

    expect(tracks).toHaveLength(2);
  });

  it("同模型但向量维度变化时拒绝关联", () => {
    const tracks = buildFaceTracks([
      frame(0, "shot-a", [face("a-1", 0.1, [1, 0])]),
      frame(0.5, "shot-a", [face("a-2", 0.1, [1, 0, 0])]),
    ]);

    expect(tracks).toHaveLength(2);
  });

  it("过滤越界框和无效时间，不产生伪人物证据", () => {
    const invalid = face("invalid", 0.9);
    invalid.bbox.width = 0.2;
    const analysis = frame(0, "shot-a", [invalid]);
    analysis.frame.timeSec = Number.NaN;

    expect(buildFaceTracks([analysis])).toEqual([]);
  });

  it("落库区间使用采样证据窗口，不把抽帧中点误当开始时间", () => {
    const analysis = frame(1.5, "shot-a", [face("a-1", 0.1)]);
    analysis.frame.evidenceStartSec = 1;
    analysis.frame.evidenceEndSec = 2;
    const appearances = buildFaceTrackAppearances(buildFaceTracks([analysis]));

    expect(appearances[0]).toMatchObject({
      startSec: 1,
      endSec: 2,
    });
  });
});
