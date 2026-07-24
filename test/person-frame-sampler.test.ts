import { describe, expect, it } from "vitest";
import type { Shot } from "../src/types";
import { buildPersonFrameSamplePlan } from "../electron/identity/person-frame-sampler";

function shot(id: string, startSec: number, endSec: number): Shot {
  return {
    id,
    videoId: "video-a",
    shotIndex: 1,
    startSec,
    endSec,
    description: id,
    usageTags: [],
  };
}

describe("人物分析抽帧计划", () => {
  it("按 Shot 生成一秒证据窗口，抽帧点位于窗口中点", () => {
    const plan = buildPersonFrameSamplePlan([
      shot("shot-a", 0, 2.4),
      shot("shot-b", 2.4, 3),
    ]);

    expect(plan.samples).toEqual([
      {
        sampleIndex: 0,
        shotId: "shot-a",
        timeSec: 0.5,
        evidenceStartSec: 0,
        evidenceEndSec: 1,
      },
      {
        sampleIndex: 1,
        shotId: "shot-a",
        timeSec: 1.5,
        evidenceStartSec: 1,
        evidenceEndSec: 2,
      },
      {
        sampleIndex: 2,
        shotId: "shot-a",
        timeSec: 2.2,
        evidenceStartSec: 2,
        evidenceEndSec: 2.4,
      },
      {
        sampleIndex: 3,
        shotId: "shot-b",
        timeSec: 2.7,
        evidenceStartSec: 2.4,
        evidenceEndSec: 3,
      },
    ]);
    expect(plan.downsampled).toBe(false);
  });

  it("长素材自适应增大间隔并遵守帧数上限", () => {
    const plan = buildPersonFrameSamplePlan(
      [shot("shot-long", 0, 100)],
      { maxFrames: 10 },
    );

    expect(plan.intervalSec).toBe(10);
    expect(plan.samples).toHaveLength(10);
    expect(plan.samples.at(-1)).toMatchObject({
      evidenceStartSec: 90,
      evidenceEndSec: 100,
    });
  });

  it("大量短镜头超过上限时均匀保留，不偷偷突破预算", () => {
    const plan = buildPersonFrameSamplePlan(
      Array.from({ length: 20 }, (_, index) =>
        shot(`shot-${index}`, index, index + 0.5)),
      { maxFrames: 5 },
    );

    expect(plan.samples).toHaveLength(5);
    expect(plan.downsampled).toBe(true);
    expect(plan.samples[0].shotId).toBe("shot-0");
    expect(plan.samples.at(-1)?.shotId).toBe("shot-19");
  });

  it("过滤无效时间范围", () => {
    expect(buildPersonFrameSamplePlan([
      shot("valid", 0, 1),
      shot("invalid", 2, 1),
    ]).samples).toHaveLength(1);
  });
});
