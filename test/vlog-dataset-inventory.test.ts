import { describe, expect, it } from "vitest";
import {
  summarizeVlogDatasetCandidates,
  type VlogDatasetCandidateProbe,
} from "../electron/editing/vlog-dataset-inventory";

function candidate(
  index: number,
  patch: Partial<VlogDatasetCandidateProbe> = {},
): VlogDatasetCandidateProbe {
  return {
    absolutePath: `/素材/video-${index}.mp4`,
    rootPath: "/素材",
    relativePath: `video-${index}.mp4`,
    status: "ready",
    durationSec: 60,
    width: index <= 5 ? 1920 : 1080,
    height: index <= 5 ? 1080 : 1920,
    orientation: index <= 5 ? "landscape" : "portrait",
    hasAudio: index !== 10,
    ...patch,
  };
}

describe("Vlog 固定集候选盘点", () => {
  it("只汇总机械条件，不伪装已经具备语义真值", () => {
    const report = summarizeVlogDatasetCandidates(
      Array.from({ length: 10 }, (_, index) => candidate(index + 1)),
      2,
    );

    expect(report).toEqual({
      discoveredFileCount: 12,
      duplicateFileCount: 2,
      readyFileCount: 10,
      failedProbeCount: 0,
      totalDurationSec: 600,
      landscapeCount: 5,
      portraitCount: 5,
      squareCount: 0,
      withAudioCount: 9,
      withoutAudioCount: 1,
      mechanicalGaps: [],
      semanticGroundTruth: "not_inferred",
    });
  });

  it("明确报告数量、时长和横竖屏缺口", () => {
    const report = summarizeVlogDatasetCandidates([
      candidate(1, {
        durationSec: 120,
        orientation: "portrait",
        width: 1080,
        height: 1920,
      }),
      candidate(2, {
        status: "probe_failed",
        error: "broken",
        durationSec: undefined,
      }),
    ]);

    expect(report.readyFileCount).toBe(1);
    expect(report.failedProbeCount).toBe(1);
    expect(report.mechanicalGaps.map((gap) => gap.code)).toEqual([
      "MATERIAL_COUNT_LOW",
      "TOTAL_DURATION_LOW",
      "ORIENTATION_MIX_MISSING",
    ]);
  });

  it("候选过量时要求人工选择固定子集", () => {
    const report = summarizeVlogDatasetCandidates(
      Array.from({ length: 21 }, (_, index) =>
        candidate(index + 1, { durationSec: 100 })),
    );

    expect(report.mechanicalGaps.map((gap) => gap.code)).toEqual([
      "MATERIAL_COUNT_HIGH",
      "TOTAL_DURATION_HIGH",
    ]);
  });
});
