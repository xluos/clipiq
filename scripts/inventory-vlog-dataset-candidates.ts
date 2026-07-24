#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import ffprobeStatic from "ffprobe-static";
import {
  summarizeVlogDatasetCandidates,
  type VlogDatasetCandidateOrientation,
  type VlogDatasetCandidateProbe,
} from "../electron/editing/vlog-dataset-inventory";

const VIDEO_EXTENSIONS = new Set([
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".webm",
]);

function usage(): string {
  return [
    "用法：npm run vlog:inventory-dataset -- <目录或视频> [...] [--json]",
    "",
    "只读递归盘点候选视频，按真实文件去重，并用 FFprobe 获取时长、",
    "横竖屏和音轨。不会复制素材，也不会推断事件、人物或负样本真值。",
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

function collectVideoFiles(inputPath: string): string[] {
  const result: string[] = [];
  const visit = (candidatePath: string): void => {
    let metadata;
    try {
      metadata = lstatSync(candidatePath);
    } catch {
      return;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      if (VIDEO_EXTENSIONS.has(path.extname(candidatePath).toLocaleLowerCase())) {
        result.push(candidatePath);
      }
      return;
    }
    if (!metadata.isDirectory()) return;
    let entries;
    try {
      entries = readdirSync(candidatePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visit(path.join(candidatePath, entry.name));
    }
  };
  visit(inputPath);
  return result;
}

function orientation(
  width: number,
  height: number,
): VlogDatasetCandidateOrientation | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

function probeVideo(
  absolutePath: string,
  rootPath: string,
): VlogDatasetCandidateProbe {
  const base: Omit<VlogDatasetCandidateProbe, "status"> = {
    absolutePath,
    rootPath,
    relativePath: path.relative(rootPath, absolutePath) || path.basename(absolutePath),
  };
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
      ...base,
      status: "probe_failed",
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
    const durationSec = Number(payload.format?.duration);
    const width = Number(video?.width);
    const height = Number(video?.height);
    if (
      !Number.isFinite(durationSec)
      || durationSec <= 0
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
    ) {
      throw new Error("缺少有效的视频时长或尺寸");
    }
    return {
      ...base,
      status: "ready",
      durationSec: Math.round(durationSec * 1_000) / 1_000,
      width,
      height,
      orientation: orientation(width, height),
      hasAudio: Boolean(
        payload.streams?.some((stream) => stream.codec_type === "audio"),
      ),
    };
  } catch (error) {
    return {
      ...base,
      status: "probe_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function dedupeFiles(
  roots: string[],
): {
  files: Array<{ absolutePath: string; rootPath: string }>;
  duplicateFileCount: number;
} {
  const files: Array<{ absolutePath: string; rootPath: string }> = [];
  const seen = new Set<string>();
  let duplicateFileCount = 0;
  for (const root of roots) {
    const rootPath = statSync(root).isDirectory()
      ? realpathSync(root)
      : path.dirname(realpathSync(root));
    for (const file of collectVideoFiles(realpathSync(root))) {
      const metadata = statSync(file);
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (seen.has(identity)) {
        duplicateFileCount += 1;
        continue;
      }
      seen.add(identity);
      files.push({
        absolutePath: realpathSync(file),
        rootPath,
      });
    }
  }
  files.sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath, "zh-CN"));
  return { files, duplicateFileCount };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const jsonOutput = args.includes("--json");
  const requestedRoots = args.filter((arg) => !arg.startsWith("-"));
  if (requestedRoots.length === 0) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const missingRoots = requestedRoots
    .map((value) => path.resolve(value))
    .filter((value) => !existsSync(value));
  if (missingRoots.length > 0) {
    console.error(`候选路径不存在：\n${missingRoots.join("\n")}`);
    process.exitCode = 2;
    return;
  }

  const roots = requestedRoots.map((value) => realpathSync(path.resolve(value)));
  const { files, duplicateFileCount } = dedupeFiles(roots);
  const candidates = files.map(({ absolutePath, rootPath }) =>
    probeVideo(absolutePath, rootPath));
  const summary = summarizeVlogDatasetCandidates(
    candidates,
    duplicateFileCount,
  );
  const report = {
    roots,
    generatedAt: new Date().toISOString(),
    summary,
    candidates,
    manualGroundTruthRequired: [
      "eventKey",
      "shotRoles",
      "traits",
      "identities",
    ],
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `候选 ${summary.readyFileCount} 条`
      + ` · 去重 ${summary.duplicateFileCount} 条`
      + ` · ${(summary.totalDurationSec / 60).toFixed(1)} 分钟`,
    );
    console.log(
      `横屏 ${summary.landscapeCount}`
      + ` · 竖屏 ${summary.portraitCount}`
      + ` · 方形 ${summary.squareCount}`
      + ` · 探测失败 ${summary.failedProbeCount}`,
    );
    for (const gap of summary.mechanicalGaps) {
      console.log(`待补齐 ${gap.code}：${gap.message}`);
    }
    console.log("事件、镜头角色、负样本和人物时间段仍需人工真值。");
  }
  if (summary.readyFileCount === 0) process.exitCode = 1;
}

main();
