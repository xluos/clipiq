import { describe, expect, it } from "vitest";
import {
  buildCandidateWindows,
  candidateIdForShotWindow,
} from "../electron/editing/candidate-windows";
import type { VideoClipEvidenceSegment } from "../src/types";

function segment(startUs: number, endUs: number): VideoClipEvidenceSegment {
  return {
    startUs,
    endUs,
    visiblePeople: [],
    activeSpeakers: [],
  };
}

describe("确定性子镜头候选窗口", () => {
  it("短 Shot 保持完整范围并生成稳定 candidateId", () => {
    expect(buildCandidateWindows(
      "shot-1",
      2_000_000,
      6_000_000,
      [segment(2_000_000, 6_000_000)],
    )).toEqual([{
      candidateId: "shot-1::2000000-6000000",
      startUs: 2_000_000,
      endUs: 6_000_000,
      boundaryReason: "shot",
    }]);
    expect(candidateIdForShotWindow("shot-1", 2_000_000, 6_000_000))
      .toBe("shot-1::2000000-6000000");
  });

  it("长 Shot 优先在字幕或人物证据边界切分，窗口连续且不超过上限", () => {
    const windows = buildCandidateWindows(
      "shot-long",
      0,
      15_000_000,
      [
        segment(0, 1_800_000),
        segment(1_800_000, 5_000_000),
        segment(5_000_000, 9_000_000),
        segment(9_000_000, 15_000_000),
      ],
      { maximumDurationUs: 6_000_000, minimumDurationUs: 800_000 },
    );

    expect(windows).toEqual([
      {
        candidateId: "shot-long::0-5000000",
        startUs: 0,
        endUs: 5_000_000,
        boundaryReason: "evidence",
      },
      {
        candidateId: "shot-long::5000000-9000000",
        startUs: 5_000_000,
        endUs: 9_000_000,
        boundaryReason: "evidence",
      },
      {
        candidateId: "shot-long::9000000-15000000",
        startUs: 9_000_000,
        endUs: 15_000_000,
        boundaryReason: "duration",
      },
    ]);
    expect(windows.every((window, index) =>
      window.endUs - window.startUs <= 6_000_000
      && (index === 0 || windows[index - 1].endUs === window.startUs)))
      .toBe(true);
  });

  it("缺少可用证据边界时按硬上限切分，并避免不足最小时长的尾段", () => {
    expect(buildCandidateWindows(
      "shot-flat",
      0,
      12_400_000,
      [segment(0, 12_400_000)],
      { maximumDurationUs: 6_000_000, minimumDurationUs: 800_000 },
    )).toEqual([
      expect.objectContaining({ startUs: 0, endUs: 6_000_000 }),
      expect.objectContaining({ startUs: 6_000_000, endUs: 11_600_000 }),
      expect.objectContaining({ startUs: 11_600_000, endUs: 12_400_000 }),
    ]);
  });
});
