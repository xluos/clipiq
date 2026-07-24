import { promises as fs } from "node:fs";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

export type PixelLandmark = {
  x: number;
  y: number;
};

export type SFacePreparedInput = {
  data: Float32Array;
  width: 112;
  height: 112;
};

export const SFACE_EMBEDDING_MODEL_ID = "opencv-zoo-sface-2021dec";

export const SFACE_REFERENCE_LANDMARKS: readonly PixelLandmark[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

type SimilarityTransform = {
  a: number;
  b: number;
  tx: number;
  ty: number;
};

function finiteLandmarks(landmarks: PixelLandmark[]): boolean {
  return landmarks.length === 5
    && landmarks.every((landmark) =>
      Number.isFinite(landmark.x) && Number.isFinite(landmark.y));
}

/**
 * 求解约束为旋转 + 等比缩放 + 平移的 2D 最小二乘变换：
 * u = a*x - b*y + tx, v = b*x + a*y + ty。
 *
 * 这与 OpenCV FaceRecognizerSF 对五点模板执行的相似变换等价，但不引入
 * opencv 原生依赖。
 */
function solveSimilarityTransform(
  source: PixelLandmark[],
  target: readonly PixelLandmark[],
): SimilarityTransform {
  if (!finiteLandmarks(source) || target.length !== 5) {
    throw new Error("SFace 需要五个有效人脸关键点");
  }
  const sourceMean = source.reduce(
    (mean, point) => ({ x: mean.x + point.x / 5, y: mean.y + point.y / 5 }),
    { x: 0, y: 0 },
  );
  const targetMean = target.reduce(
    (mean, point) => ({ x: mean.x + point.x / 5, y: mean.y + point.y / 5 }),
    { x: 0, y: 0 },
  );

  let denominator = 0;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < 5; index += 1) {
    const sourceX = source[index].x - sourceMean.x;
    const sourceY = source[index].y - sourceMean.y;
    const targetX = target[index].x - targetMean.x;
    const targetY = target[index].y - targetMean.y;
    denominator += sourceX * sourceX + sourceY * sourceY;
    real += sourceX * targetX + sourceY * targetY;
    imaginary += sourceX * targetY - sourceY * targetX;
  }
  if (!Number.isFinite(denominator) || denominator <= 1e-8) {
    throw new Error("SFace 人脸关键点退化，无法对齐");
  }
  const a = real / denominator;
  const b = imaginary / denominator;
  const determinant = a * a + b * b;
  if (!Number.isFinite(determinant) || determinant <= 1e-12) {
    throw new Error("SFace 人脸对齐变换无效");
  }
  return {
    a,
    b,
    tx: targetMean.x - a * sourceMean.x + b * sourceMean.y,
    ty: targetMean.y - b * sourceMean.x - a * sourceMean.y,
  };
}

function bilinearChannel(
  rgba: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  channel: number,
): number {
  if (x < 0 || y < 0 || x > imageWidth - 1 || y > imageHeight - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(imageWidth - 1, x0 + 1);
  const y1 = Math.min(imageHeight - 1, y0 + 1);
  const xWeight = x - x0;
  const yWeight = y - y0;
  const topLeft = rgba[(y0 * imageWidth + x0) * 4 + channel];
  const topRight = rgba[(y0 * imageWidth + x1) * 4 + channel];
  const bottomLeft = rgba[(y1 * imageWidth + x0) * 4 + channel];
  const bottomRight = rgba[(y1 * imageWidth + x1) * 4 + channel];
  const top = topLeft + (topRight - topLeft) * xWeight;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
  return top + (bottom - top) * yWeight;
}

/**
 * jpeg-js 的 RGBA 输入先按五点模板对齐到 112x112，再按 OpenCV
 * blobFromImage(..., swapRB=true) 生成 RGB NCHW、0..255 的张量。
 */
export function prepareSFaceRgbaInput(
  rgba: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  landmarks: PixelLandmark[],
): SFacePreparedInput {
  if (
    !(rgba instanceof Uint8Array)
    || !Number.isInteger(imageWidth)
    || !Number.isInteger(imageHeight)
    || imageWidth <= 0
    || imageHeight <= 0
    || rgba.length < imageWidth * imageHeight * 4
  ) {
    throw new Error("SFace 输入图像无效");
  }
  const transform = solveSimilarityTransform(landmarks, SFACE_REFERENCE_LANDMARKS);
  const determinant = transform.a * transform.a + transform.b * transform.b;
  const width = 112;
  const height = 112;
  const planeSize = width * height;
  const data = new Float32Array(planeSize * 3);

  for (let outputY = 0; outputY < height; outputY += 1) {
    for (let outputX = 0; outputX < width; outputX += 1) {
      const translatedX = outputX - transform.tx;
      const translatedY = outputY - transform.ty;
      const sourceX = (
        transform.a * translatedX + transform.b * translatedY
      ) / determinant;
      const sourceY = (
        -transform.b * translatedX + transform.a * translatedY
      ) / determinant;
      const target = outputY * width + outputX;
      for (let channel = 0; channel < 3; channel += 1) {
        data[channel * planeSize + target] = bilinearChannel(
          rgba,
          imageWidth,
          imageHeight,
          sourceX,
          sourceY,
          channel,
        );
      }
    }
  }
  return { data, width, height };
}

function normalizeEmbedding(values: ArrayLike<number>): number[] {
  if (values.length === 0) throw new Error("SFace 返回了空向量");
  let squaredNorm = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) throw new Error("SFace 返回了无效向量");
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new Error("SFace 返回了零向量");
  }
  const norm = Math.sqrt(squaredNorm);
  return Array.from(values, (value) => Number(value) / norm);
}

export class SFaceEmbedder {
  private sessionPromise?: Promise<OrtSession>;

  constructor(private readonly modelPath: string) {}

  private getSession(): Promise<OrtSession> {
    if (!this.sessionPromise) {
      const ort = require("onnxruntime-node") as OrtModule;
      this.sessionPromise = ort.InferenceSession.create(this.modelPath, {
        logSeverityLevel: 3,
      });
    }
    return this.sessionPromise;
  }

  async getReadiness(): Promise<{ ready: true } | { ready: false; reason: string }> {
    try {
      const stat = await fs.stat(this.modelPath);
      if (!stat.isFile() || stat.size <= 0) {
        return { ready: false, reason: "SFace 模型文件不存在" };
      }
      const session = await this.getSession();
      if (!session.inputNames.includes("data") || !session.outputNames.includes("fc1")) {
        return { ready: false, reason: "SFace 模型输入输出契约不兼容" };
      }
      return { ready: true };
    } catch (error) {
      this.sessionPromise = undefined;
      return {
        ready: false,
        reason: `SFace 运行时不可用: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async embed(
    rgba: Uint8Array,
    imageWidth: number,
    imageHeight: number,
    landmarks: PixelLandmark[],
  ): Promise<number[]> {
    const ort = require("onnxruntime-node") as OrtModule;
    const session = await this.getSession();
    const prepared = prepareSFaceRgbaInput(rgba, imageWidth, imageHeight, landmarks);
    const outputs = await session.run({
      data: new ort.Tensor("float32", prepared.data, [
        1,
        3,
        prepared.height,
        prepared.width,
      ]),
    });
    const output = outputs.fc1;
    if (!output || !(output.data instanceof Float32Array) || output.data.length !== 128) {
      throw new Error("SFace 输出 fc1 缺失或维度异常");
    }
    return normalizeEmbedding(output.data);
  }
}
