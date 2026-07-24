import { describe, expect, it } from "vitest";
import {
  decodeYuNetOutputs,
  nonMaximumSuppression,
  prepareYuNetRgbaInput,
  YuNetFaceAnalysisProvider,
} from "../electron/identity/yunet-provider";

function emptyOutputs(inputWidth: number, inputHeight: number) {
  return Object.fromEntries([8, 16, 32].flatMap((stride) => {
    const anchors = Math.floor(inputWidth / stride) * Math.floor(inputHeight / stride);
    return [
      [`cls_${stride}`, new Float32Array(anchors)],
      [`obj_${stride}`, new Float32Array(anchors)],
      [`bbox_${stride}`, new Float32Array(anchors * 4)],
      [`kps_${stride}`, new Float32Array(anchors * 10)],
    ];
  }));
}

describe("YuNet Provider", () => {
  it("把 RGBA 转为 YuNet 需要的 BGR NCHW", () => {
    const prepared = prepareYuNetRgbaInput(
      new Uint8Array([
        10, 20, 30, 255,
        40, 50, 60, 255,
      ]),
      2,
      1,
      2,
      1,
    );

    expect(Array.from(prepared.data)).toEqual([
      30, 60,
      20, 50,
      10, 40,
    ]);
    expect(prepared.scale).toBe(1);
  });

  it("解码官方 YuNet 输出并映射回原图坐标", () => {
    const outputs = emptyOutputs(32, 32);
    (outputs.cls_32 as Float32Array)[0] = 0.81;
    (outputs.obj_32 as Float32Array)[0] = 1;
    (outputs.bbox_32 as Float32Array).set([
      0.5,
      0.5,
      Math.log(0.5),
      Math.log(0.5),
    ]);
    (outputs.kps_32 as Float32Array).set([
      0.4, 0.4,
      0.6, 0.4,
      0.5, 0.5,
      0.4, 0.6,
      0.6, 0.6,
    ]);

    const faces = decodeYuNetOutputs(outputs, {
      inputWidth: 32,
      inputHeight: 32,
      imageWidth: 16,
      imageHeight: 16,
      scale: 2,
    }, {
      scoreThreshold: 0.7,
      nmsThreshold: 0.3,
      topK: 100,
    });

    expect(faces).toHaveLength(1);
    expect(faces[0].x).toBeCloseTo(4);
    expect(faces[0].y).toBeCloseTo(4);
    expect(faces[0].width).toBeCloseTo(8);
    expect(faces[0].height).toBeCloseTo(8);
    expect(faces[0].score).toBeCloseTo(0.9);
    expect(faces[0].landmarks[0].x).toBeCloseTo(6.4);
    expect(faces[0].landmarks[0].y).toBeCloseTo(6.4);
  });

  it("NMS 保留高分框并保留不重叠的人脸", () => {
    const face = {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      landmarks: [],
      score: 0.9,
    };
    expect(nonMaximumSuppression([
      face,
      { ...face, x: 1, score: 0.8 },
      { ...face, x: 20, score: 0.7 },
    ], 0.3, 10)).toEqual([
      face,
      { ...face, x: 20, score: 0.7 },
    ]);
  });

  it("模型文件缺失时显式返回不可用", async () => {
    const provider = new YuNetFaceAnalysisProvider({
      modelPath: "/tmp/clipiq-does-not-exist/yunet.onnx",
    });
    await expect(provider.getReadiness()).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining("YuNet"),
    });
  });

  it("只在配置 SFace 时声明跨素材 embedding 能力和许可", () => {
    const detectorOnly = new YuNetFaceAnalysisProvider({
      modelPath: "/tmp/yunet.onnx",
    });
    const withEmbedding = new YuNetFaceAnalysisProvider({
      modelPath: "/tmp/yunet.onnx",
      embeddingModelPath: "/tmp/sface.onnx",
    });

    expect(detectorOnly.descriptor.capabilities.embedding).toBe(false);
    expect(withEmbedding.descriptor.capabilities.embedding).toBe(true);
    expect(withEmbedding.descriptor.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "opencv-zoo-sface-2021dec",
        role: "embedding",
        licenseName: "Apache-2.0",
        productionUse: "allowed",
      }),
    ]));
  });
});
