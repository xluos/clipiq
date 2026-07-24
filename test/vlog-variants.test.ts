import { describe, expect, it } from "vitest";
import type { EditPlan } from "../src/types";
import {
  generateDistinctVlogVariants,
  plannerSelectionSignature,
  variantSummary,
  vlogVariantSpecs,
} from "../electron/editing/vlog-variants";

describe("Vlog 多版本契约", () => {
  it("只暴露三个有明确取舍的固定方向", () => {
    expect(vlogVariantSpecs(3).map((item) => item.key)).toEqual([
      "balanced",
      "pace",
      "character",
    ]);
    expect(() => vlogVariantSpecs(4)).toThrow("粗剪对比版本数必须在 1 到 3 之间");
  });

  it("镜头选择签名只取 candidateId 顺序并保持稳定", () => {
    const selections = [
      {
        candidateId: "candidate-a",
        shotId: "shot-a",
        intent: "开场",
        confidence: 0.9,
      },
      {
        candidateId: "candidate-b",
        shotId: "shot-b",
        intent: "推进",
        confidence: 0.8,
      },
    ];
    const first = plannerSelectionSignature(selections);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(plannerSelectionSignature([
      { ...selections[0], intent: "换一种说法" },
      selections[1],
    ])).toBe(first);
    expect(plannerSelectionSignature([...selections].reverse())).not.toBe(first);
  });

  it("重复版本会携带已有顺序重试，第二次不同才接受", async () => {
    const specs = vlogVariantSpecs(2);
    const responses = [
      ["candidate-a", "candidate-b"],
      ["candidate-a", "candidate-b"],
      ["candidate-b", "candidate-a"],
    ];
    const observedAvoid: string[][][] = [];
    const result = await generateDistinctVlogVariants({
      specs,
      generate: async (_spec, avoidCandidateSequences) => {
        observedAvoid.push(avoidCandidateSequences);
        const candidateIds = responses.shift() || [];
        const selections = candidateIds.map((candidateId) => ({
          candidateId,
          shotId: candidateId,
          intent: candidateId,
          confidence: 1,
        }));
        return {
          selections,
          errors: [],
          value: candidateIds.join(","),
        };
      },
    });

    expect(result.map((item) => item.value)).toEqual([
      "candidate-a,candidate-b",
      "candidate-b,candidate-a",
    ]);
    expect(observedAvoid).toEqual([
      [],
      [["candidate-a", "candidate-b"]],
      [["candidate-a", "candidate-b"]],
    ]);
  });

  it("连续重复两次时明确拒绝伪对比", async () => {
    await expect(generateDistinctVlogVariants({
      specs: vlogVariantSpecs(2),
      generate: async () => ({
        selections: [{
          candidateId: "candidate-a",
          shotId: "shot-a",
          intent: "相同",
          confidence: 1,
        }],
        errors: [],
        value: null,
      }),
    })).rejects.toThrow("镜头选择完全相同");
  });

  it("从真实时间线汇总可比较指标", () => {
    const current = {
      actualDurationUs: 8_000_000,
      tracks: [
        {
          id: "video",
          kind: "video",
          items: [
            { id: "a", videoId: "v1" },
            { id: "b", videoId: "v2" },
            { id: "c", videoId: "v1" },
          ],
        },
        {
          id: "caption",
          kind: "caption",
          items: [{ id: "caption-1" }, { id: "caption-2" }],
        },
      ],
      emotionSegments: [
        { tone: "calm" },
        { tone: "upbeat" },
        { tone: "upbeat" },
      ],
    } as unknown as EditPlan;

    expect(variantSummary(current)).toEqual({
      clipCount: 3,
      videoCount: 2,
      durationUs: 8_000_000,
      subtitleCueCount: 2,
      emotionTones: ["calm", "upbeat"],
    });
  });
});
