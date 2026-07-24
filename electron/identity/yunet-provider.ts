import { promises as fs } from "node:fs";
import type {
  FaceAnalysisFrame,
  FaceAnalysisProvider,
  FaceAnalysisProviderDescriptor,
  FaceDetection,
  FaceFrameAnalysis,
} from "./face-analysis-provider";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;
type JpegModule = typeof import("jpeg-js");

type YuNetRawOutputs = Record<string, ArrayLike<number>>;

export type YuNetProviderOptions = {
  modelPath: string;
  scoreThreshold?: number;
  nmsThreshold?: number;
  topK?: number;
  inputWidth?: number;
  inputHeight?: number;
};

export type YuNetPreparedInput = {
  data: Float32Array;
  inputWidth: number;
  inputHeight: number;
  imageWidth: number;
  imageHeight: number;
  scale: number;
};

export type YuNetDecodedFace = {
  x: number;
  y: number;
  width: number;
  height: number;
  landmarks: Array<{ x: number; y: number }>;
  score: number;
};

const YUNET_OUTPUT_NAMES = [
  "cls_8",
  "cls_16",
  "cls_32",
  "obj_8",
  "obj_16",
  "obj_32",
  "bbox_8",
  "bbox_16",
  "bbox_32",
  "kps_8",
  "kps_16",
  "kps_32",
] as const;

export const YUNET_PROVIDER_DESCRIPTOR: FaceAnalysisProviderDescriptor = {
  id: "yunet-onnxruntime",
  version: "2023mar",
  capabilities: {
    detection: true,
    landmarks: true,
    embedding: false,
  },
  models: [{
    id: "opencv-zoo-yunet-2023mar",
    role: "detection",
    version: "2023mar",
    sourceUrl: "https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet",
    licenseName: "MIT",
    productionUse: "allowed",
  }],
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function intersectionOverUnion(a: YuNetDecodedFace, b: YuNetDecodedFace): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function nonMaximumSuppression(
  faces: YuNetDecodedFace[],
  threshold: number,
  topK: number,
): YuNetDecodedFace[] {
  const sorted = [...faces]
    .sort((a, b) => b.score - a.score || b.width * b.height - a.width * a.height)
    .slice(0, topK);
  const kept: YuNetDecodedFace[] = [];
  for (const face of sorted) {
    if (kept.every((candidate) => intersectionOverUnion(candidate, face) <= threshold)) {
      kept.push(face);
    }
  }
  return kept;
}

/**
 * jpeg-js 输出 RGBA；YuNet 与 OpenCV blobFromImage 的默认输入一致，使用 BGR NCHW、
 * 0..255 浮点值。固定 640 模型按比例缩放到左上角，剩余区域补零。
 */
export function prepareYuNetRgbaInput(
  rgba: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  inputWidth = 640,
  inputHeight = 640,
): YuNetPreparedInput {
  if (
    !(rgba instanceof Uint8Array)
    || !Number.isInteger(imageWidth)
    || !Number.isInteger(imageHeight)
    || imageWidth <= 0
    || imageHeight <= 0
    || rgba.length < imageWidth * imageHeight * 4
    || !Number.isInteger(inputWidth)
    || !Number.isInteger(inputHeight)
    || inputWidth <= 0
    || inputHeight <= 0
  ) {
    throw new Error("YuNet 输入图像无效");
  }

  const scale = Math.min(inputWidth / imageWidth, inputHeight / imageHeight);
  const resizedWidth = Math.max(1, Math.round(imageWidth * scale));
  const resizedHeight = Math.max(1, Math.round(imageHeight * scale));
  const planeSize = inputWidth * inputHeight;
  const data = new Float32Array(planeSize * 3);

  for (let y = 0; y < resizedHeight; y += 1) {
    const sourceY = clamp((y + 0.5) / scale - 0.5, 0, imageHeight - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(imageHeight - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < resizedWidth; x += 1) {
      const sourceX = clamp((x + 0.5) / scale - 0.5, 0, imageWidth - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(imageWidth - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const target = y * inputWidth + x;

      for (let channel = 0; channel < 3; channel += 1) {
        const rgbaChannel = 2 - channel;
        const topLeft = rgba[(y0 * imageWidth + x0) * 4 + rgbaChannel];
        const topRight = rgba[(y0 * imageWidth + x1) * 4 + rgbaChannel];
        const bottomLeft = rgba[(y1 * imageWidth + x0) * 4 + rgbaChannel];
        const bottomRight = rgba[(y1 * imageWidth + x1) * 4 + rgbaChannel];
        const top = topLeft + (topRight - topLeft) * xWeight;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        data[channel * planeSize + target] = top + (bottom - top) * yWeight;
      }
    }
  }

  return {
    data,
    inputWidth,
    inputHeight,
    imageWidth,
    imageHeight,
    scale,
  };
}

function requireOutput(
  outputs: YuNetRawOutputs,
  name: string,
  minimumLength: number,
): ArrayLike<number> {
  const output = outputs[name];
  if (!output || output.length < minimumLength) {
    throw new Error(`YuNet 输出 ${name} 缺失或维度异常`);
  }
  return output;
}

export function decodeYuNetOutputs(
  outputs: YuNetRawOutputs,
  prepared: Pick<
    YuNetPreparedInput,
    "inputWidth" | "inputHeight" | "imageWidth" | "imageHeight" | "scale"
  >,
  options: {
    scoreThreshold: number;
    nmsThreshold: number;
    topK: number;
  },
): YuNetDecodedFace[] {
  const rawFaces: YuNetDecodedFace[] = [];
  for (const stride of [8, 16, 32]) {
    const columns = Math.floor(prepared.inputWidth / stride);
    const rows = Math.floor(prepared.inputHeight / stride);
    const anchors = columns * rows;
    const cls = requireOutput(outputs, `cls_${stride}`, anchors);
    const obj = requireOutput(outputs, `obj_${stride}`, anchors);
    const bbox = requireOutput(outputs, `bbox_${stride}`, anchors * 4);
    const kps = requireOutput(outputs, `kps_${stride}`, anchors * 10);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const score = Math.sqrt(
          clamp(Number(cls[index]), 0, 1) * clamp(Number(obj[index]), 0, 1),
        );
        if (!Number.isFinite(score) || score < options.scoreThreshold) continue;

        const centerX = (column + Number(bbox[index * 4])) * stride;
        const centerY = (row + Number(bbox[index * 4 + 1])) * stride;
        const rawWidth = Math.exp(Number(bbox[index * 4 + 2])) * stride;
        const rawHeight = Math.exp(Number(bbox[index * 4 + 3])) * stride;
        const left = clamp(
          (centerX - rawWidth / 2) / prepared.scale,
          0,
          prepared.imageWidth,
        );
        const top = clamp(
          (centerY - rawHeight / 2) / prepared.scale,
          0,
          prepared.imageHeight,
        );
        const right = clamp(
          (centerX + rawWidth / 2) / prepared.scale,
          0,
          prepared.imageWidth,
        );
        const bottom = clamp(
          (centerY + rawHeight / 2) / prepared.scale,
          0,
          prepared.imageHeight,
        );
        if (!(right > left && bottom > top)) continue;

        const landmarks = Array.from({ length: 5 }, (_, point) => ({
          x: clamp(
            (Number(kps[index * 10 + point * 2]) + column) * stride / prepared.scale,
            0,
            prepared.imageWidth,
          ),
          y: clamp(
            (Number(kps[index * 10 + point * 2 + 1]) + row) * stride / prepared.scale,
            0,
            prepared.imageHeight,
          ),
        }));
        rawFaces.push({
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
          landmarks,
          score,
        });
      }
    }
  }
  return nonMaximumSuppression(rawFaces, options.nmsThreshold, options.topK);
}

function faceQuality(face: YuNetDecodedFace, imageWidth: number, imageHeight: number): number {
  const areaRatio = face.width * face.height / (imageWidth * imageHeight);
  const sizeQuality = clamp(Math.sqrt(areaRatio) * 3, 0, 1);
  return clamp(face.score * sizeQuality, 0, 1);
}

function toDetection(
  face: YuNetDecodedFace,
  index: number,
  frame: FaceAnalysisFrame,
  imageWidth: number,
  imageHeight: number,
): FaceDetection {
  return {
    detectionId: `${frame.frameId}:face-${index + 1}`,
    bbox: {
      x: face.x / imageWidth,
      y: face.y / imageHeight,
      width: face.width / imageWidth,
      height: face.height / imageHeight,
    },
    confidence: clamp(face.score, 0, 1),
    quality: faceQuality(face, imageWidth, imageHeight),
    landmarks: face.landmarks.map((landmark) => ({
      x: landmark.x / imageWidth,
      y: landmark.y / imageHeight,
    })),
  };
}

export class YuNetFaceAnalysisProvider implements FaceAnalysisProvider {
  readonly descriptor = YUNET_PROVIDER_DESCRIPTOR;
  private readonly options: Required<YuNetProviderOptions>;
  private sessionPromise?: Promise<OrtSession>;

  constructor(options: YuNetProviderOptions) {
    this.options = {
      modelPath: options.modelPath,
      scoreThreshold: options.scoreThreshold ?? 0.7,
      nmsThreshold: options.nmsThreshold ?? 0.3,
      topK: options.topK ?? 5000,
      inputWidth: options.inputWidth ?? 640,
      inputHeight: options.inputHeight ?? 640,
    };
  }

  private getSession(): Promise<OrtSession> {
    if (!this.sessionPromise) {
      const ort = require("onnxruntime-node") as OrtModule;
      this.sessionPromise = ort.InferenceSession.create(this.options.modelPath);
    }
    return this.sessionPromise;
  }

  async getReadiness(): Promise<
    { ready: true } | { ready: false; reason: string }
  > {
    try {
      const stat = await fs.stat(this.options.modelPath);
      if (!stat.isFile() || stat.size <= 0) {
        return { ready: false, reason: "YuNet 模型文件不存在" };
      }
      const session = await this.getSession();
      const missingOutputs = YUNET_OUTPUT_NAMES.filter(
        (name) => !session.outputNames.includes(name),
      );
      if (!session.inputNames.includes("input") || missingOutputs.length > 0) {
        return { ready: false, reason: "YuNet 模型输入输出契约不兼容" };
      }
      return { ready: true };
    } catch (error) {
      this.sessionPromise = undefined;
      return {
        ready: false,
        reason: `YuNet 运行时不可用: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async analyzeFrames(frames: FaceAnalysisFrame[]): Promise<FaceFrameAnalysis[]> {
    const ort = require("onnxruntime-node") as OrtModule;
    const jpeg = require("jpeg-js") as JpegModule;
    const session = await this.getSession();
    const analyses: FaceFrameAnalysis[] = [];

    for (const frame of frames) {
      const bytes = await fs.readFile(frame.imagePath);
      let image: { data: Uint8Array; width: number; height: number };
      try {
        image = jpeg.decode(bytes, {
          useTArray: true,
          formatAsRGBA: true,
        }) as unknown as { data: Uint8Array; width: number; height: number };
      } catch (error) {
        throw new Error(
          `YuNet 无法读取分析帧 ${frame.frameId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const prepared = prepareYuNetRgbaInput(
        image.data,
        image.width,
        image.height,
        this.options.inputWidth,
        this.options.inputHeight,
      );
      const outputTensors = await session.run({
        input: new ort.Tensor("float32", prepared.data, [
          1,
          3,
          prepared.inputHeight,
          prepared.inputWidth,
        ]),
      });
      const outputs: YuNetRawOutputs = {};
      for (const [name, tensor] of Object.entries(outputTensors)) {
        if (!(tensor.data instanceof Float32Array)) {
          throw new Error(`YuNet 输出 ${name} 不是 float32`);
        }
        outputs[name] = tensor.data;
      }
      const faces = decodeYuNetOutputs(outputs, prepared, this.options);
      analyses.push({
        frame,
        detections: faces.map((face, index) =>
          toDetection(face, index, frame, image.width, image.height)),
      });
    }
    return analyses;
  }
}
