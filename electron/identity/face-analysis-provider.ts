export type FaceBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FaceLandmark = {
  x: number;
  y: number;
};

export type FaceModelRole = "detection" | "landmarks" | "embedding";

export type FaceModelProductionUse =
  | "allowed"
  | "blocked"
  | "requires_user_attestation";

export type FaceModelDescriptor = {
  id: string;
  role: FaceModelRole;
  version?: string;
  sourceUrl?: string;
  licenseName?: string;
  productionUse: FaceModelProductionUse;
};

export type FaceAnalysisProviderDescriptor = {
  id: string;
  version: string;
  models: FaceModelDescriptor[];
  capabilities: {
    detection: boolean;
    landmarks: boolean;
    embedding: boolean;
  };
};

export type FaceAnalysisFrame = {
  videoId: string;
  frameId: string;
  timeSec: number;
  evidenceEndSec?: number;
  shotId?: string;
  imagePath: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
};

export type FaceEmbedding = {
  vector: number[];
  modelId: string;
};

export type FaceDetection = {
  detectionId: string;
  bbox: FaceBoundingBox;
  confidence: number;
  quality: number;
  landmarks?: FaceLandmark[];
  embedding?: FaceEmbedding;
};

export type FaceFrameAnalysis = {
  frame: FaceAnalysisFrame;
  detections: FaceDetection[];
};

export type FaceAnalysisReadiness =
  | { ready: true }
  | { ready: false; reason: string };

export interface FaceAnalysisProvider {
  readonly descriptor: FaceAnalysisProviderDescriptor;
  getReadiness(): Promise<FaceAnalysisReadiness>;
  analyzeFrames(frames: FaceAnalysisFrame[]): Promise<FaceFrameAnalysis[]>;
}

export type FaceProviderUsePolicy = {
  environment: "development" | "production";
  allowAttestedUserModels?: boolean;
};

/**
 * 模型能力和模型许可必须同时通过门禁。
 *
 * Provider 实现不能仅因为权重可以下载、可以运行，就把它当成可用于生产的模型。
 * 用户自带模型也必须在产品明确取得用户确认后才能进入生产分析管线。
 */
export function validateFaceProviderForUse(
  descriptor: FaceAnalysisProviderDescriptor,
  policy: FaceProviderUsePolicy,
): string[] {
  const issues: string[] = [];
  if (!descriptor.capabilities.detection) {
    issues.push(`人脸分析 Provider ${descriptor.id} 不具备检测能力`);
  }

  const declaredRoles = new Set(descriptor.models.map((model) => model.role));
  if (!declaredRoles.has("detection")) {
    issues.push(`人脸分析 Provider ${descriptor.id} 未声明检测模型`);
  }
  if (descriptor.capabilities.embedding && !declaredRoles.has("embedding")) {
    issues.push(`人脸分析 Provider ${descriptor.id} 声明支持特征向量，但未声明 embedding 模型`);
  }

  if (policy.environment !== "production") return issues;

  for (const model of descriptor.models) {
    if (model.productionUse === "blocked") {
      issues.push(`模型 ${model.id} 的许可不允许进入生产分析`);
    }
    if (
      model.productionUse === "requires_user_attestation"
      && !policy.allowAttestedUserModels
    ) {
      issues.push(`模型 ${model.id} 需要用户确认许可后才能进入生产分析`);
    }
  }
  return issues;
}
