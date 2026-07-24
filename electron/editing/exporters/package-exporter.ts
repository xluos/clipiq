import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  CaptionCue,
  EditPlan,
} from "../../../src/types";

export type EditPackageFile = {
  kind: "video" | "audio" | "overlay" | "preview" | "caption" | "plan";
  relativePath: string;
  originalName: string;
  bytes: number;
  sha256: string;
  refs: string[];
};

export type EditPackageWarning = {
  code:
    | "PREVIEW_NOT_INCLUDED"
    | "VOICEOVER_NOT_SYNTHESIZED"
    | "OVERLAY_RESOURCE_NOT_PORTABLE";
  message: string;
  itemId?: string;
};

export type EditPackageManifest = {
  schemaVersion: 1;
  kind: "clipiq-edit-package";
  planId: string;
  planRevision: number;
  sessionId: string;
  createdAt: string;
  canvas: EditPlan["canvas"];
  targetDurationUs: number;
  actualDurationUs: number;
  files: EditPackageFile[];
  warnings: EditPackageWarning[];
};

export type EditPackageExportResult = {
  packagePath: string;
  manifestPath: string;
  planPath: string;
  captionsPath?: string;
  previewPath?: string;
  fileCount: number;
  totalBytes: number;
  warnings: EditPackageWarning[];
};

export type EditPackageExportOptions = {
  destinationDirectory: string;
  previewPath?: string;
  now?: Date;
};

type PortableSource = {
  kind: EditPackageFile["kind"];
  sourcePath: string;
  refs: string[];
};

function safePathSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return (normalized || fallback).slice(0, 96);
}

function portableFileName(index: number, sourcePath: string): string {
  const rawExtension = path.extname(sourcePath);
  const extension = rawExtension
    ? `.${safePathSegment(rawExtension.slice(1), "bin").slice(0, 15)}`
    : "";
  const stem = safePathSegment(
    path.basename(sourcePath, path.extname(sourcePath)),
    "asset",
  ).slice(0, Math.max(24, 88 - extension.length));
  return `${String(index + 1).padStart(3, "0")}-${stem}${extension}`;
}

function srtTimestamp(timeUs: number): string {
  const totalMs = Math.max(0, Math.round(timeUs / 1_000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const milliseconds = totalMs % 1_000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`,
  ].join(":");
}

function renderCaptions(cues: CaptionCue[]): string {
  return [...cues]
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
    .map((cue, index) => [
      String(index + 1),
      `${srtTimestamp(cue.startUs)} --> ${srtTimestamp(cue.endUs)}`,
      cue.text.replace(/\r\n?/g, "\n").trim(),
      "",
    ].join("\n"))
    .join("\n");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`${label}不存在: ${filePath}`);
  }
  if (!info.isFile()) throw new Error(`${label}不是普通文件: ${filePath}`);
}

async function unusedPackagePath(
  destinationDirectory: string,
  baseName: string,
): Promise<string> {
  for (let index = 1; index <= 1_000; index += 1) {
    const candidate = path.join(
      destinationDirectory,
      index === 1 ? baseName : `${baseName}-${index}`,
    );
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("无法为导出素材包分配新目录");
}

function collectSources(
  plan: EditPlan,
  previewPath: string | undefined,
  warnings: EditPackageWarning[],
): PortableSource[] {
  const sources = new Map<string, PortableSource>();
  const add = (
    kind: PortableSource["kind"],
    sourcePath: string | undefined,
    ref: string,
  ) => {
    if (!sourcePath) return;
    const absolute = path.resolve(sourcePath);
    const key = `${kind}:${absolute}`;
    const existing = sources.get(key);
    if (existing) {
      existing.refs.push(ref);
    } else {
      sources.set(key, { kind, sourcePath: absolute, refs: [ref] });
    }
  };

  for (const track of plan.tracks) {
    if (track.kind === "video") {
      for (const clip of track.items) add("video", clip.sourcePath, clip.id);
    } else if (track.kind === "audio") {
      for (const clip of track.items) {
        if (!clip.sourcePath && clip.kind === "voiceover" && clip.ttsText?.trim()) {
          warnings.push({
            code: "VOICEOVER_NOT_SYNTHESIZED",
            message: "旁白只有文本、没有已合成音频，素材包保留文本但不包含配音文件。",
            itemId: clip.id,
          });
        }
        add("audio", clip.sourcePath, clip.id);
      }
    } else if (track.kind === "overlay") {
      for (const item of track.items) {
        if (!item.assetPath && item.resourceKey) {
          warnings.push({
            code: "OVERLAY_RESOURCE_NOT_PORTABLE",
            message: "贴图只引用模板资源，素材包无法携带该资源。",
            itemId: item.id,
          });
        }
        add("overlay", item.assetPath, item.id);
      }
    }
  }
  if (previewPath) {
    add("preview", previewPath, "preview");
  } else {
    warnings.push({
      code: "PREVIEW_NOT_INCLUDED",
      message: "当前 EditPlan 没有已生成的代理预览。",
    });
  }
  return [...sources.values()];
}

function replacePortablePaths(
  plan: EditPlan,
  relativePathBySource: Map<string, string>,
): EditPlan {
  const portable = structuredClone(plan);
  for (const track of portable.tracks) {
    if (track.kind === "video") {
      for (const clip of track.items) {
        clip.sourcePath = relativePathBySource.get(`video:${path.resolve(clip.sourcePath)}`)
          || clip.sourcePath;
      }
    } else if (track.kind === "audio") {
      for (const clip of track.items) {
        if (clip.sourcePath) {
          clip.sourcePath = relativePathBySource.get(`audio:${path.resolve(clip.sourcePath)}`)
            || clip.sourcePath;
        }
      }
    } else if (track.kind === "overlay") {
      for (const item of track.items) {
        if (item.assetPath) {
          item.assetPath = relativePathBySource.get(`overlay:${path.resolve(item.assetPath)}`)
            || item.assetPath;
        }
      }
    }
  }
  return portable;
}

export async function exportEditPlanPackage(
  plan: EditPlan,
  options: EditPackageExportOptions,
): Promise<EditPackageExportResult> {
  if (!plan?.id) throw new Error("导出素材包需要有效的 EditPlan");
  if (!plan.validation?.valid) throw new Error("EditPlan 未通过校验，不能导出素材包");
  const destinationDirectory = path.resolve(options.destinationDirectory || "");
  const destinationInfo = await stat(destinationDirectory).catch(() => null);
  if (!destinationInfo?.isDirectory()) throw new Error("导出目标目录不存在");

  const warnings: EditPackageWarning[] = [];
  const sources = collectSources(plan, options.previewPath, warnings);
  for (const source of sources) {
    await assertRegularFile(source.sourcePath, "导出源文件");
  }

  const now = options.now || new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const baseName = safePathSegment(
    `ClipIQ-${plan.id}-r${plan.revision || 1}-${timestamp}`,
    `ClipIQ-export-${timestamp}`,
  );
  const packagePath = await unusedPackagePath(destinationDirectory, baseName);
  const tempPath = await mkdtemp(path.join(destinationDirectory, ".clipiq-export-"));
  const files: EditPackageFile[] = [];
  const relativePathBySource = new Map<string, string>();

  try {
    await Promise.all([
      mkdir(path.join(tempPath, "media"), { recursive: true }),
      mkdir(path.join(tempPath, "audio"), { recursive: true }),
      mkdir(path.join(tempPath, "overlays"), { recursive: true }),
    ]);

    for (const [index, source] of sources.entries()) {
      const directory = source.kind === "video"
        ? "media"
        : source.kind === "audio"
          ? "audio"
          : source.kind === "overlay"
            ? "overlays"
            : "";
      const fileName = portableFileName(index, source.sourcePath);
      const relativePath = directory ? path.posix.join(directory, fileName) : "preview.mp4";
      const targetPath = path.join(tempPath, ...relativePath.split("/"));
      await copyFile(source.sourcePath, targetPath);
      const info = await stat(targetPath);
      files.push({
        kind: source.kind,
        relativePath,
        originalName: path.basename(source.sourcePath),
        bytes: info.size,
        sha256: await sha256File(targetPath),
        refs: [...new Set(source.refs)].sort(),
      });
      relativePathBySource.set(`${source.kind}:${path.resolve(source.sourcePath)}`, relativePath);
    }

    const captionTrack = plan.tracks.find((track) => track.kind === "caption");
    let captionsPath: string | undefined;
    if (captionTrack?.kind === "caption" && captionTrack.items.length > 0) {
      captionsPath = "captions.srt";
      const targetPath = path.join(tempPath, captionsPath);
      await writeFile(targetPath, renderCaptions(captionTrack.items), "utf8");
      const info = await stat(targetPath);
      files.push({
        kind: "caption",
        relativePath: captionsPath,
        originalName: "captions.srt",
        bytes: info.size,
        sha256: await sha256File(targetPath),
        refs: captionTrack.items.map((cue) => cue.id),
      });
    }

    const portablePlan = replacePortablePaths(plan, relativePathBySource);
    const planPath = "edit-plan.json";
    await writeFile(
      path.join(tempPath, planPath),
      `${JSON.stringify(portablePlan, null, 2)}\n`,
      "utf8",
    );
    const planInfo = await stat(path.join(tempPath, planPath));
    files.push({
      kind: "plan",
      relativePath: planPath,
      originalName: "edit-plan.json",
      bytes: planInfo.size,
      sha256: await sha256File(path.join(tempPath, planPath)),
      refs: [plan.id],
    });

    const manifest: EditPackageManifest = {
      schemaVersion: 1,
      kind: "clipiq-edit-package",
      planId: plan.id,
      planRevision: plan.revision || 1,
      sessionId: plan.sessionId,
      createdAt: now.toISOString(),
      canvas: plan.canvas,
      targetDurationUs: plan.targetDurationUs,
      actualDurationUs: plan.actualDurationUs,
      files,
      warnings,
    };
    const manifestPath = path.join(tempPath, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(tempPath, packagePath);

    const exportedManifest = JSON.parse(
      await readFile(path.join(packagePath, "manifest.json"), "utf8"),
    ) as EditPackageManifest;
    return {
      packagePath,
      manifestPath: path.join(packagePath, "manifest.json"),
      planPath: path.join(packagePath, planPath),
      ...(captionsPath ? { captionsPath: path.join(packagePath, captionsPath) } : {}),
      ...(options.previewPath
        && relativePathBySource.has(`preview:${path.resolve(options.previewPath)}`)
        ? {
          previewPath: path.join(
            packagePath,
            relativePathBySource.get(`preview:${path.resolve(options.previewPath)}`)!,
          ),
        }
        : {}),
      fileCount: exportedManifest.files.length,
      totalBytes: exportedManifest.files.reduce((sum, file) => sum + file.bytes, 0),
      warnings,
    };
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    throw error;
  }
}
