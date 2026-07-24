#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import {
  buildIdentityGroundTruthFromDataset,
  validateVlogEvaluationDataset,
  type VlogEvaluationDatasetManifest,
} from "../electron/editing/vlog-evaluation-dataset";
import {
  evaluateIdentityGroundTruth,
  type VlogQualityEvaluationReport,
} from "../electron/editing/vlog-quality-evaluator";
import type { FaceAnalysisFrame } from "../electron/identity/face-analysis-provider";
import { runPersonAppearanceAnalysis } from "../electron/identity/person-analysis-pipeline";
import { SFACE_AUTO_IDENTITY_POLICY } from "../electron/identity/person-identity-assignment";
import { YuNetFaceAnalysisProvider } from "../electron/identity/yunet-provider";
import { createIdentityRepository } from "../electron/repositories/identity-repository";

type IdentityEvaluationReport = {
  valid: boolean;
  generatedAt: string;
  datasetId: string;
  manifestPath: string;
  policy: typeof SFACE_AUTO_IDENTITY_POLICY;
  models: {
    yunet: { file: string; sha256: string };
    sface: { file: string; sha256: string };
  };
  stats: {
    materialCount: number;
    identityLabelCount: number;
    extractedFrameCount: number;
    appearanceCount: number;
    embeddingAppearanceCount: number;
    assignedAppearanceCount: number;
    matchedExistingTrackCount: number;
    predictedPersonCount: number;
  };
  identity: VlogQualityEvaluationReport["identity"];
  unmappedMaterialKeys: string[];
  unmatchedLabelIds: string[];
};

const require = createRequire(import.meta.url);
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg") as {
  path?: string;
};

function usage(): string {
  return [
    "用法：npm run vlog:evaluate-identity-dataset -- <manifest.json> [选项]",
    "",
    "选项：",
    "  --yunet-model <path>  YuNet ONNX 路径",
    "  --sface-model <path>  SFace ONNX 路径",
    "  --threshold <number>  临时覆盖自动复用阈值",
    "  --json                输出机器可读 JSON",
    "",
    "每个人物真值时间窗只抽中间一帧，走生产 YuNet → SFace →",
    "Tracker → Assignment → 临时 SQLite。不会修改 ClipIQ 业务数据库，",
    "临时帧和身份向量在结束后删除。",
  ].join("\n");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 缺少参数`);
  }
  return value;
}

function defaultModelPath(model: "yunet" | "sface"): string {
  const file = model === "yunet"
    ? "face_detection_yunet_2023mar.onnx"
    : "face_recognition_sface_2021dec.onnx";
  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "AIModels",
    model,
    file,
  );
}

async function requireModelFile(filePath: string, displayName: string): Promise<void> {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size <= 0) {
    throw new Error(`${displayName} 模型文件不存在：${filePath}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function materialPath(manifestDir: string, relativePath: string): string {
  if (
    !relativePath
    || relativePath.includes("\0")
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`素材路径不安全：${relativePath || "(空)"}`);
  }
  const absolutePath = path.resolve(manifestDir, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`素材文件不存在：${absolutePath}`);
  }
  const relativeRealPath = path.relative(
    realpathSync(manifestDir),
    realpathSync(absolutePath),
  );
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
    throw new Error(`素材通过符号链接越出数据集目录：${relativePath}`);
  }
  return absolutePath;
}

function extractFrame(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  timeSec: number,
): void {
  const result = spawnSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(timeSec),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    "-q:v",
    "4",
    outputPath,
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message
      || String(result.stderr || `ffmpeg exit ${result.status}`).trim(),
    );
  }
}

function formatRate(value: number | null): string {
  return value == null ? "未评估" : `${(value * 100).toFixed(1)}%`;
}

async function evaluate(
  manifestPath: string,
  options: {
    yunetModelPath: string;
    sfaceModelPath: string;
    threshold?: number;
  },
): Promise<IdentityEvaluationReport> {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as VlogEvaluationDatasetManifest;
  if ((manifest.profile || "full_vlog") !== "identity_bootstrap") {
    throw new Error("人物身份评测只接受 profile=identity_bootstrap 的固定集");
  }
  const contract = validateVlogEvaluationDataset(manifest);
  if (!contract.valid) {
    throw new Error(
      contract.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.code}：${issue.message}`)
        .join("\n"),
    );
  }
  await Promise.all([
    requireModelFile(options.yunetModelPath, "YuNet"),
    requireModelFile(options.sfaceModelPath, "SFace"),
  ]);
  const ffmpegPath = ffmpegInstaller.path;
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error("未找到 @ffmpeg-installer/ffmpeg");
  }

  const frameDir = await mkdtemp(path.join(tmpdir(), "clipiq-identity-evaluation-"));
  const database = new DatabaseSync(":memory:");
  const repository = createIdentityRepository(database);
  const policy = {
    ...SFACE_AUTO_IDENTITY_POLICY,
    ...(options.threshold == null
      ? {}
      : { autoMergeThreshold: options.threshold }),
  };
  const provider = new YuNetFaceAnalysisProvider({
    modelPath: options.yunetModelPath,
    embeddingModelPath: options.sfaceModelPath,
  });
  const videoIdByMaterialKey: Record<string, string> = {};
  let extractedFrameCount = 0;
  let matchedExistingTrackCount = 0;

  try {
    const manifestDir = path.dirname(manifestPath);
    for (const [materialIndex, material] of manifest.materials.entries()) {
      const videoId = `evaluation:${manifest.id}:${material.key}`;
      videoIdByMaterialKey[material.key] = videoId;
      const inputPath = materialPath(manifestDir, material.file);
      const labels = Array.isArray(material.identities) ? material.identities : [];
      const frames: FaceAnalysisFrame[] = labels.map(
        (label, labelIndex) => {
          const timeSec = (label.startSec + label.endSec) / 2;
          const imagePath = path.join(
            frameDir,
            `${String(materialIndex + 1).padStart(2, "0")}-`
            + `${String(labelIndex + 1).padStart(2, "0")}.jpg`,
          );
          extractFrame(ffmpegPath, inputPath, imagePath, timeSec);
          extractedFrameCount += 1;
          return {
            videoId,
            frameId: `${videoId}:identity-label:${label.id}`,
            timeSec,
            evidenceStartSec: label.startSec,
            evidenceEndSec: label.endSec,
            shotId: `${videoId}:evaluation-shot`,
            imagePath,
          };
        },
      );
      const result = await runPersonAppearanceAnalysis({
        videoId,
        frames,
        provider,
        repository,
        usePolicy: { environment: "production" },
        identityPolicy: policy,
      });
      if (result.status !== "completed") {
        throw new Error(`${material.key} 人物分析不可用：${result.reason || "未知原因"}`);
      }
      matchedExistingTrackCount += result.matchedExistingPersonCount;
    }

    const appearances = repository.listAppearanceEvidence();
    const groundTruth = buildIdentityGroundTruthFromDataset({
      manifest,
      appearances,
      videoIdByMaterialKey,
    });
    const identity = evaluateIdentityGroundTruth(groundTruth.items);
    const valid = identity.status === "measured"
      && identity.matchedSamePairCount > 0
      && identity.falseMergePairCount === 0
      && groundTruth.unmappedMaterialKeys.length === 0
      && groundTruth.unmatchedLabelIds.length === 0;
    const [yunetSha256, sfaceSha256] = await Promise.all([
      sha256File(options.yunetModelPath),
      sha256File(options.sfaceModelPath),
    ]);
    return {
      valid,
      generatedAt: new Date().toISOString(),
      datasetId: manifest.id,
      manifestPath,
      policy,
      models: {
        yunet: {
          file: path.basename(options.yunetModelPath),
          sha256: yunetSha256,
        },
        sface: {
          file: path.basename(options.sfaceModelPath),
          sha256: sfaceSha256,
        },
      },
      stats: {
        materialCount: manifest.materials.length,
        identityLabelCount: manifest.materials.reduce(
          (sum, material) =>
            sum + (Array.isArray(material.identities) ? material.identities.length : 0),
          0,
        ),
        extractedFrameCount,
        appearanceCount: appearances.length,
        embeddingAppearanceCount: appearances.filter(
          (appearance) => Boolean(appearance.embedding?.length),
        ).length,
        assignedAppearanceCount: appearances.filter(
          (appearance) => Boolean(appearance.personId),
        ).length,
        matchedExistingTrackCount,
        predictedPersonCount: repository.listPeople().length,
      },
      identity,
      unmappedMaterialKeys: groundTruth.unmappedMaterialKeys,
      unmatchedLabelIds: groundTruth.unmatchedLabelIds,
    };
  } finally {
    database.close();
    await rm(frameDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  try {
    const manifestArg = args.find((arg, index) =>
      !arg.startsWith("-")
      && !["--yunet-model", "--sface-model", "--threshold"].includes(args[index - 1] || ""));
    if (!manifestArg) {
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const thresholdText = optionValue(args, "--threshold");
    const threshold = thresholdText == null ? undefined : Number(thresholdText);
    if (threshold != null && (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)) {
      throw new Error("--threshold 必须是 -1～1 的有限数值");
    }
    const report = await evaluate(path.resolve(manifestArg), {
      yunetModelPath: path.resolve(
        optionValue(args, "--yunet-model") || defaultModelPath("yunet"),
      ),
      sfaceModelPath: path.resolve(
        optionValue(args, "--sface-model") || defaultModelPath("sface"),
      ),
      threshold,
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`人物身份固定集评测：${report.valid ? "通过" : "未通过"}`);
      console.log(
        `数据集：${report.datasetId} · ${report.stats.materialCount} 条素材 · `
        + `${report.stats.identityLabelCount} 个人物标注`,
      );
      console.log(
        `SFace 阈值 ${report.policy.autoMergeThreshold} · `
        + `有效向量 ${report.stats.embeddingAppearanceCount}/`
        + `${report.stats.identityLabelCount} · `
        + `预测人物 ${report.stats.predictedPersonCount} 个`,
      );
      console.log(
        `同人物 pair ${report.identity.matchedSamePairCount}/`
        + `${report.identity.crossVideoExpectedPairCount} · `
        + `召回 ${formatRate(report.identity.recall)}`,
      );
      console.log(
        `预测同人 pair ${report.identity.predictedSamePairCount} · `
        + `错误合并 ${report.identity.falseMergePairCount} · `
        + `精确率 ${formatRate(report.identity.precision)}`,
      );
      if (report.unmatchedLabelIds.length > 0) {
        console.log(`未命中标注：${report.unmatchedLabelIds.join("、")}`);
      }
    }
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    console.error(
      `人物身份固定集评测失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}

void main();
