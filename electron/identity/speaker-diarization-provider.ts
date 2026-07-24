export type SpeakerDiarizationModelRole = "segmentation" | "embedding";

export type SpeakerDiarizationModelDescriptor = {
  id: string;
  role: SpeakerDiarizationModelRole;
  version?: string;
  sourceUrl?: string;
  licenseName: string;
  productionUse: "allowed" | "blocked" | "requires_user_attestation";
};

export type SpeakerDiarizationProviderDescriptor = {
  id: string;
  version: string;
  runtime: {
    id: string;
    version: string;
    licenseName: string;
  };
  models: SpeakerDiarizationModelDescriptor[];
};

export type SpeakerDiarizationReadiness =
  | { ready: true }
  | { ready: false; reason: string };

export type SpeakerDiarizationSegment = {
  startSec: number;
  endSec: number;
  speakerIndex: number;
};

export interface SpeakerDiarizationProvider {
  readonly descriptor: SpeakerDiarizationProviderDescriptor;
  getReadiness(): Promise<SpeakerDiarizationReadiness>;
  diarize(
    wavPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<SpeakerDiarizationSegment[]>;
}

export type SpeakerDiarizationUsePolicy = {
  environment: "development" | "production";
  allowAttestedUserModels?: boolean;
};

export function validateSpeakerDiarizationProviderForUse(
  descriptor: SpeakerDiarizationProviderDescriptor,
  policy: SpeakerDiarizationUsePolicy,
): string[] {
  const issues: string[] = [];
  const roles = new Set(descriptor.models.map((model) => model.role));
  if (!roles.has("segmentation")) issues.push(`说话人 Provider ${descriptor.id} 未声明分段模型`);
  if (!roles.has("embedding")) issues.push(`说话人 Provider ${descriptor.id} 未声明声纹模型`);
  if (!descriptor.runtime.licenseName) issues.push(`说话人 Provider ${descriptor.id} 未声明运行时许可`);
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
