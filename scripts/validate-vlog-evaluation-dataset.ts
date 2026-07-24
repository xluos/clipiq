#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ffprobeStatic from "ffprobe-static";
import {
  validateVlogEvaluationDataset,
  type VlogEvaluationDatasetManifest,
  type VlogEvaluationMediaProbe,
} from "../electron/editing/vlog-evaluation-dataset";

function usage(): string {
  return [
    "用法：npm run vlog:validate-dataset -- <manifest.json> [--json]",
    "",
    "manifest 中的素材路径相对 manifest 文件所在目录解析。",
    "命令会用 ffprobe 核对文件存在性、时长、横竖屏和音轨，不会修改素材。",
  ].join("\n");
}

function ffprobePath(): string {
  const value: unknown = ffprobeStatic;
  const bundled = typeof value === "string"
    ? value
    : value && typeof value === "object" && "path" in value
      ? String(value.path || "")
      : "";
  return process.env.FFPROBE_PATH || bundled || "ffprobe";
}

function probeMaterial(
  material: VlogEvaluationDatasetManifest["materials"][number],
  manifestDir: string,
): VlogEvaluationMediaProbe {
  const file = String(material?.file || "");
  const materialKey = String(material?.key || "");
  const unsafe = !file
    || file.includes("\0")
    || path.isAbsolute(file)
    || file.split(/[\\/]/).includes("..");
  const absolutePath = path.resolve(manifestDir, file);
  if (unsafe) {
    return {
      materialKey,
      absolutePath,
      exists: false,
      error: "路径不安全，未执行 ffprobe",
    };
  }
  if (!existsSync(absolutePath)) {
    return {
      materialKey,
      absolutePath,
      exists: false,
    };
  }
  try {
    const relativeRealPath = path.relative(
      realpathSync(manifestDir),
      realpathSync(absolutePath),
    );
    if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
      return {
        materialKey,
        absolutePath,
        exists: true,
        error: "素材通过符号链接越出了数据集目录，未执行 ffprobe",
      };
    }
  } catch (error) {
    return {
      materialKey,
      absolutePath,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const result = spawnSync(ffprobePath(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,width,height",
    "-of",
    "json",
    absolutePath,
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      materialKey,
      absolutePath,
      exists: true,
      error: result.error?.message
        || String(result.stderr || `ffprobe exit ${result.status}`).trim(),
    };
  }
  try {
    const payload = JSON.parse(result.stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
      }>;
    };
    const video = payload.streams?.find((stream) => stream.codec_type === "video");
    return {
      materialKey,
      absolutePath,
      exists: true,
      durationSec: Number(payload.format?.duration),
      width: Number(video?.width),
      height: Number(video?.height),
      hasAudio: Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")),
    };
  } catch (error) {
    return {
      materialKey,
      absolutePath,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const jsonOutput = args.includes("--json");
  const manifestArg = args.find((arg) => !arg.startsWith("-"));
  if (!manifestArg) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.resolve(manifestArg);
  let manifest: VlogEvaluationDatasetManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as VlogEvaluationDatasetManifest;
  } catch (error) {
    console.error(`无法读取测试集 manifest：${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }
  const materials = Array.isArray(manifest.materials) ? manifest.materials : [];
  const probes = materials.map((material) =>
    probeMaterial(material, path.dirname(manifestPath)));
  const report = validateVlogEvaluationDataset(
    manifest,
    probes,
    { requireFileProbes: true },
  );
  if (jsonOutput) {
    console.log(JSON.stringify({ manifestPath, probes, report }, null, 2));
  } else {
    const mark = report.valid ? "通过" : "未通过";
    console.log(`Vlog 固定素材集校验：${mark}`);
    console.log(`数据集：${report.datasetId || "(无 id)"}`);
    console.log(
      `素材 ${report.stats.materialCount} 条 · `
      + `总时长 ${(report.stats.totalDurationSec / 60).toFixed(1)} 分钟 · `
      + `横屏 ${report.stats.landscapeCount} · 竖屏 ${report.stats.portraitCount}`,
    );
    console.log(
      `人物标注 ${report.stats.identityLabelCount} 条 · `
      + `人物 ${report.stats.personCount} 个 · `
      + `跨 3 条以上素材 ${report.stats.crossVideoPersonCount} 个`,
    );
    for (const issue of report.issues) {
      console.log(
        `${issue.severity === "error" ? "ERROR" : "WARN"} `
        + `${issue.code}${issue.materialKey ? ` [${issue.materialKey}]` : ""}：`
        + issue.message,
      );
    }
  }
  if (!report.valid) process.exitCode = 1;
}

void main();
