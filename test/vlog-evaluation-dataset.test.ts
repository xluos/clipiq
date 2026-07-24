import { describe, expect, it } from "vitest";
import type { PersonAppearance } from "../src/types";
import {
  buildIdentityGroundTruthFromDataset,
  validateVlogEvaluationDataset,
  type VlogEvaluationDatasetManifest,
  type VlogEvaluationMediaProbe,
  type VlogEvaluationMaterial,
} from "../electron/editing/vlog-evaluation-dataset";

function material(
  index: number,
  patch: Partial<VlogEvaluationMaterial> = {},
): VlogEvaluationMaterial {
  return {
    key: `material-${index}`,
    file: index === 1
      ? "中文 素材/周末 01.mp4"
      : `素材/material-${index}.mp4`,
    durationSec: 60,
    orientation: index <= 5 ? "landscape" : "portrait",
    eventKey: index <= 5 ? "weekend-camp" : `event-${index}`,
    shotRoles: [
      ["wide", "person", "action", "detail", "reaction"][index - 1]
        || "action",
    ] as VlogEvaluationMaterial["shotRoles"],
    traits: ({
      1: ["blurry", "multi_person"],
      2: ["shaky", "back_view"],
      3: ["duplicate", "occlusion"],
      4: ["silent", "lookalike_negative"],
      5: ["noisy", "voice_over"],
    } as Record<number, VlogEvaluationMaterial["traits"]>)[index] || [],
    identities: index <= 3
      ? [{
        id: `owner-${index}`,
        personKey: "owner",
        startSec: 5,
        endSec: 20,
        ...(index === 1
          ? { focusBounds: { x: 0.1, y: 0.15, width: 0.2, height: 0.3 } }
          : {}),
        conditions: [(["outfit_change", "side_face", "lighting_change"] as const)[index - 1]],
      }]
      : index <= 5
        ? [{
          id: `friend-${index}`,
          personKey: "friend",
          startSec: 10,
          endSec: 25,
        }]
        : [],
    ...patch,
  };
}

function manifest(): VlogEvaluationDatasetManifest {
  return {
    version: 1,
    id: "weekend-vlog-real-v1",
    title: "周末生活记录固定集",
    materials: Array.from({ length: 10 }, (_, index) => material(index + 1)),
  };
}

function probes(
  value: VlogEvaluationDatasetManifest,
): VlogEvaluationMediaProbe[] {
  return value.materials.map((item) => ({
    materialKey: item.key,
    absolutePath: `/fixtures/${item.file}`,
    exists: true,
    durationSec: item.durationSec,
    width: item.orientation === "landscape" ? 1920 : 1080,
    height: item.orientation === "landscape" ? 1080 : 1920,
    hasAudio: !item.traits.includes("silent"),
  }));
}

describe("Vlog 真人固定素材集", () => {
  it("校验素材数量、总时长、路径、横竖屏、负样本和跨素材人物覆盖", () => {
    const value = manifest();
    const report = validateVlogEvaluationDataset(
      value,
      probes(value),
      { requireFileProbes: true },
    );

    expect(report).toMatchObject({
      valid: true,
      datasetId: "weekend-vlog-real-v1",
      stats: {
        materialCount: 10,
        probedMaterialCount: 10,
        totalDurationSec: 600,
        landscapeCount: 5,
        portraitCount: 5,
        identityLabelCount: 5,
        personCount: 2,
        crossVideoPersonCount: 1,
      },
      issues: [],
    });
  });

  it("缺少真实文件、必要负样本和跨素材人物时明确失败", () => {
    const value: VlogEvaluationDatasetManifest = {
      version: 1,
      id: "incomplete",
      materials: [material(1, {
        file: "../outside.mp4",
        traits: [],
        identities: [],
      })],
    };
    const report = validateVlogEvaluationDataset(
      value,
      [{
        materialKey: "material-1",
        absolutePath: "/outside.mp4",
        exists: false,
      }],
      { requireFileProbes: true },
    );
    const codes = new Set(report.issues.map((issue) => issue.code));

    expect(report.valid).toBe(false);
    expect(codes.has("MATERIAL_COUNT_OUT_OF_RANGE")).toBe(true);
    expect(codes.has("MATERIAL_PATH_UNSAFE")).toBe(true);
    expect(codes.has("MEDIA_FILE_MISSING")).toBe(true);
    expect(codes.has("REQUIRED_TRAIT_MISSING")).toBe(true);
    expect(codes.has("CROSS_VIDEO_PERSON_MISSING")).toBe(true);
  });

  it("按素材映射和时间重叠生成身份真值，缺失检测保持可计入召回", () => {
    const value = manifest();
    value.materials = value.materials.slice(0, 3);
    const appearances: PersonAppearance[] = [
      {
        id: "appearance-decoy",
        videoId: "video-1",
        trackId: "track-decoy",
        personId: "predicted-friend",
        startSec: 3,
        endSec: 22,
        confidence: 0.99,
        identityConfidence: 0.99,
        focusBounds: { x: 0.7, y: 0.15, width: 0.2, height: 0.3 },
        source: "face_track",
      },
      {
        id: "appearance-1",
        videoId: "video-1",
        trackId: "track-1",
        personId: "predicted-owner",
        startSec: 4,
        endSec: 21,
        confidence: 0.98,
        identityConfidence: 0.94,
        focusBounds: { x: 0.1, y: 0.15, width: 0.2, height: 0.3 },
        source: "face_track",
      },
      {
        id: "appearance-2",
        videoId: "video-2",
        trackId: "track-2",
        personId: "predicted-owner",
        startSec: 7,
        endSec: 18,
        confidence: 0.96,
        identityConfidence: 0.92,
        source: "face_track",
      },
    ];

    const result = buildIdentityGroundTruthFromDataset({
      manifest: value,
      appearances,
      videoIdByMaterialKey: {
        "material-1": "video-1",
        "material-2": "video-2",
        "material-3": "video-3",
      },
    });

    expect(result.items).toEqual([
      {
        appearanceId: "appearance-1",
        videoId: "video-1",
        expectedPersonKey: "owner",
        predictedPersonId: "predicted-owner",
      },
      {
        appearanceId: "appearance-2",
        videoId: "video-2",
        expectedPersonKey: "owner",
        predictedPersonId: "predicted-owner",
      },
      {
        appearanceId: "missing:material-3:owner-3",
        videoId: "video-3",
        expectedPersonKey: "owner",
      },
    ]);
    expect(result.unmappedMaterialKeys).toEqual([]);
    expect(result.unmatchedLabelIds).toEqual(["material-3:owner-3"]);
  });
});
