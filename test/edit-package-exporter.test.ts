import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditPlan } from "../src/types";
import {
  exportEditPlanPackage,
  type EditPackageManifest,
} from "../electron/editing/exporters/package-exporter";

const temporaryRoots: string[] = [];

async function fixture(): Promise<{
  root: string;
  destination: string;
  plan: EditPlan;
  previewPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "clipiq-package-"));
  temporaryRoots.push(root);
  const sources = path.join(root, "中文 素材");
  const destination = path.join(root, "导出 目录");
  await Promise.all([
    mkdir(sources, { recursive: true }),
    mkdir(destination, { recursive: true }),
  ]);
  const videoPath = path.join(sources, "周末 片段.mp4");
  const musicPath = path.join(sources, "背景 音乐.wav");
  const overlayPath = path.join(sources, "贴图 标识.png");
  const previewPath = path.join(sources, "代理 预览.mp4");
  await Promise.all([
    writeFile(videoPath, "video-fixture"),
    writeFile(musicPath, "music-fixture"),
    writeFile(overlayPath, "overlay-fixture"),
    writeFile(previewPath, "preview-fixture"),
  ]);

  const plan: EditPlan = {
    id: "plan-export",
    version: 1,
    revision: 3,
    parentPlanId: "plan-export-parent",
    sessionId: "session-export",
    status: "rendered",
    canvas: { width: 1080, height: 1920, fps: 30 },
    targetDurationUs: 4_000_000,
    actualDurationUs: 4_000_000,
    tracks: [
      {
        id: "video-track",
        kind: "video",
        items: [{
          id: "clip-1",
          shotId: "shot-1",
          videoId: "video-1",
          sourcePath: videoPath,
          sourceInUs: 100_000,
          sourceOutUs: 4_100_000,
          timelineInUs: 0,
          speed: 1,
          volume: 1,
          selectionReason: "测试片段",
          confidence: 1,
        }],
      },
      {
        id: "audio-track",
        kind: "audio",
        items: [
          {
            id: "music-1",
            kind: "music",
            sourcePath: musicPath,
            timelineInUs: 0,
            sourceInUs: 0,
            sourceOutUs: 4_000_000,
            volume: 0.2,
          },
          {
            id: "voiceover-1",
            kind: "voiceover",
            ttsText: "尚未合成的旁白",
            timelineInUs: 0,
            sourceInUs: 0,
            sourceOutUs: 4_000_000,
            volume: 1,
          },
        ],
      },
      {
        id: "caption-track",
        kind: "caption",
        items: [{
          id: "caption-1",
          startUs: 123_000,
          endUs: 1_456_000,
          text: "第一行\n第二行",
          styleId: "default",
          sourceClipId: "clip-1",
          sourceStartUs: 223_000,
          sourceEndUs: 1_556_000,
        }],
      },
      {
        id: "overlay-track",
        kind: "overlay",
        items: [
          {
            id: "overlay-1",
            kind: "image",
            assetPath: overlayPath,
            startUs: 1_000_000,
            endUs: 3_000_000,
            transform: {
              x: 0.5,
              y: 0.5,
              scaleX: 0.3,
              scaleY: 0.3,
              rotationDeg: 0,
              opacity: 1,
            },
          },
          {
            id: "overlay-template",
            kind: "sticker",
            resourceKey: "template-only",
            startUs: 2_000_000,
            endUs: 3_000_000,
            transform: {
              x: 0,
              y: 0,
              scaleX: 1,
              scaleY: 1,
              rotationDeg: 0,
              opacity: 1,
            },
          },
        ],
      },
    ],
    transitions: [],
    provenance: {
      goal: "测试导出",
      genre: "vlog",
      methodologyIds: [],
      generatedAt: 1,
      plannerInputDigest: "fixture",
      plannerOutput: [],
    },
    validation: { valid: true, warnings: [], errors: [] },
  };
  return { root, destination, plan, previewPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("EditPlan 素材包导出", () => {
  it("原子生成可移植计划、素材、SRT、预览和诊断 manifest", async () => {
    const { destination, plan, previewPath } = await fixture();
    const result = await exportEditPlanPackage(plan, {
      destinationDirectory: destination,
      previewPath,
      now: new Date("2026-07-24T05:00:00.000Z"),
    });

    const portablePlan = JSON.parse(await readFile(result.planPath, "utf8")) as EditPlan;
    const manifest = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as EditPackageManifest;
    const serialized = JSON.stringify({ portablePlan, manifest });

    const videoTrack = portablePlan.tracks.find((track) => track.kind === "video");
    const audioTrack = portablePlan.tracks.find((track) => track.kind === "audio");
    const overlayTrack = portablePlan.tracks.find((track) => track.kind === "overlay");
    expect(videoTrack?.items[0].sourcePath).toMatch(/^media\//);
    expect(audioTrack?.items[0].sourcePath).toMatch(/^audio\//);
    expect(overlayTrack?.items[0].assetPath).toMatch(/^overlays\//);
    expect(serialized).not.toContain(path.dirname(previewPath));
    expect(result.previewPath).toBe(path.join(result.packagePath, "preview.mp4"));
    expect(await readFile(result.captionsPath!, "utf8")).toContain(
      "00:00:00,123 --> 00:00:01,456\n第一行\n第二行",
    );
    expect(manifest.files.map((file) => file.kind)).toEqual(expect.arrayContaining([
      "video",
      "audio",
      "overlay",
      "preview",
      "caption",
      "plan",
    ]));
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(manifest.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "VOICEOVER_NOT_SYNTHESIZED",
      "OVERLAY_RESOURCE_NOT_PORTABLE",
    ]));
  });

  it("重复导出只创建新目录，不覆盖已有素材包", async () => {
    const { destination, plan } = await fixture();
    const first = await exportEditPlanPackage(plan, {
      destinationDirectory: destination,
      now: new Date("2026-07-24T05:00:00.000Z"),
    });
    const second = await exportEditPlanPackage(plan, {
      destinationDirectory: destination,
      now: new Date("2026-07-24T05:00:00.000Z"),
    });

    expect(second.packagePath).not.toBe(first.packagePath);
    expect(path.basename(second.packagePath)).toMatch(/-2$/);
    expect(second.warnings.map((warning) => warning.code)).toContain("PREVIEW_NOT_INCLUDED");
  });

  it("源文件缺失时不留下半成品目录", async () => {
    const { destination, plan } = await fixture();
    const video = plan.tracks.find((track) => track.kind === "video");
    if (video?.kind !== "video") throw new Error("fixture");
    video.items[0].sourcePath = path.join(destination, "missing.mp4");

    await expect(exportEditPlanPackage(plan, {
      destinationDirectory: destination,
    })).rejects.toThrow("导出源文件不存在");
    expect((await readdir(destination)).filter((name) =>
      name.startsWith(".clipiq-export-"))).toEqual([]);
  });
});
