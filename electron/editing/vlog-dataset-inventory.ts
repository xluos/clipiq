export type VlogDatasetCandidateOrientation =
  | "landscape"
  | "portrait"
  | "square";

export type VlogDatasetCandidateProbe = {
  absolutePath: string;
  rootPath: string;
  relativePath: string;
  status: "ready" | "probe_failed";
  durationSec?: number;
  width?: number;
  height?: number;
  orientation?: VlogDatasetCandidateOrientation;
  hasAudio?: boolean;
  error?: string;
};

export type VlogDatasetInventoryGap = {
  code:
    | "MATERIAL_COUNT_LOW"
    | "MATERIAL_COUNT_HIGH"
    | "TOTAL_DURATION_LOW"
    | "TOTAL_DURATION_HIGH"
    | "ORIENTATION_MIX_MISSING";
  message: string;
};

export type VlogDatasetInventorySummary = {
  discoveredFileCount: number;
  duplicateFileCount: number;
  readyFileCount: number;
  failedProbeCount: number;
  totalDurationSec: number;
  landscapeCount: number;
  portraitCount: number;
  squareCount: number;
  withAudioCount: number;
  withoutAudioCount: number;
  mechanicalGaps: VlogDatasetInventoryGap[];
  semanticGroundTruth: "not_inferred";
};

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeVlogDatasetCandidates(
  candidates: VlogDatasetCandidateProbe[],
  duplicateFileCount = 0,
): VlogDatasetInventorySummary {
  const ready = candidates.filter((candidate) => candidate.status === "ready");
  const totalDurationSec = ready.reduce(
    (sum, candidate) => sum + Number(candidate.durationSec || 0),
    0,
  );
  const landscapeCount = ready.filter(
    (candidate) => candidate.orientation === "landscape",
  ).length;
  const portraitCount = ready.filter(
    (candidate) => candidate.orientation === "portrait",
  ).length;
  const squareCount = ready.filter(
    (candidate) => candidate.orientation === "square",
  ).length;
  const mechanicalGaps: VlogDatasetInventoryGap[] = [];

  if (ready.length < 10) {
    mechanicalGaps.push({
      code: "MATERIAL_COUNT_LOW",
      message: `可用候选少于 10 条，当前为 ${ready.length} 条。`,
    });
  } else if (ready.length > 20) {
    mechanicalGaps.push({
      code: "MATERIAL_COUNT_HIGH",
      message: `候选多于 20 条，需要人工选出固定子集，当前为 ${ready.length} 条。`,
    });
  }
  if (totalDurationSec < 600) {
    mechanicalGaps.push({
      code: "TOTAL_DURATION_LOW",
      message: `候选总时长不足 10 分钟，当前为 ${(totalDurationSec / 60).toFixed(1)} 分钟。`,
    });
  } else if (totalDurationSec > 1_800) {
    mechanicalGaps.push({
      code: "TOTAL_DURATION_HIGH",
      message: `候选总时长超过 30 分钟，需要人工选出固定子集，当前为 ${(totalDurationSec / 60).toFixed(1)} 分钟。`,
    });
  }
  if (landscapeCount === 0 || portraitCount === 0) {
    mechanicalGaps.push({
      code: "ORIENTATION_MIX_MISSING",
      message: "候选必须同时包含横屏和竖屏素材。",
    });
  }

  return {
    discoveredFileCount: candidates.length + duplicateFileCount,
    duplicateFileCount,
    readyFileCount: ready.length,
    failedProbeCount: candidates.length - ready.length,
    totalDurationSec: rounded(totalDurationSec),
    landscapeCount,
    portraitCount,
    squareCount,
    withAudioCount: ready.filter((candidate) => candidate.hasAudio === true).length,
    withoutAudioCount: ready.filter((candidate) => candidate.hasAudio === false).length,
    mechanicalGaps,
    semanticGroundTruth: "not_inferred",
  };
}
