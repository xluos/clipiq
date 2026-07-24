import { describe, it, expect } from "vitest";
import {
  clampBatchSize,
  ctxToBatchCap,
  estimateShotPromptTokens,
  chooseBatchSize,
} from "./shot-merger.cjs";

describe("shot-merger: clampBatchSize", () => {
  it("非数字回默认值 3", () => {
    expect(clampBatchSize(NaN)).toBe(3);
    expect(clampBatchSize(undefined)).toBe(3);
  });
  it("夹到 [min=1, max=12]", () => {
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(9999)).toBe(12);
  });
  it("四舍五入", () => {
    expect(clampBatchSize(3.4)).toBe(3);
    expect(clampBatchSize(3.6)).toBe(4);
  });
});

describe("shot-merger: ctxToBatchCap 单调", () => {
  it("ctx 越大 cap 不减", () => {
    const caps = [2048, 4096, 8192, 16384, 32768, 131072].map(ctxToBatchCap);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
  });
  it("小 ctx 给小 cap", () => {
    expect(ctxToBatchCap(2048)).toBe(2);
    expect(ctxToBatchCap(8192)).toBe(4);
  });
});

describe("shot-merger: estimateShotPromptTokens", () => {
  it("空 shot 也有基础成本", () => {
    expect(estimateShotPromptTokens({})).toBeGreaterThan(0);
  });
  it("字幕越长 token 越多", () => {
    const short = estimateShotPromptTokens({ subtitleText: "短" });
    const long = estimateShotPromptTokens({ subtitleText: "很".repeat(200) });
    expect(long).toBeGreaterThan(short);
  });
  it("帧越多 token 越多", () => {
    const few = estimateShotPromptTokens({ frames: [{ caption: "a" }] });
    const many = estimateShotPromptTokens({ frames: Array.from({ length: 10 }, () => ({ caption: "a" })) });
    expect(many).toBeGreaterThan(few);
  });
});

describe("shot-merger: chooseBatchSize", () => {
  it("空 shots 回默认", () => {
    expect(chooseBatchSize({ contextSize: 8192 }, [])).toBeGreaterThanOrEqual(1);
  });
  it("结果始终在 [1,12]", () => {
    const shots = Array.from({ length: 20 }, () => ({ subtitleText: "字幕", frames: [{ caption: "画面" }] }));
    const b = chooseBatchSize({ contextSize: 8192 }, shots);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(12);
  });
  it("大 ctx 给的 batch ≥ 小 ctx(同一批 shots)", () => {
    const shots = Array.from({ length: 20 }, () => ({ subtitleText: "字幕短", frames: [{ caption: "x" }] }));
    expect(chooseBatchSize({ contextSize: 32768 }, shots)).toBeGreaterThanOrEqual(
      chooseBatchSize({ contextSize: 2048 }, shots),
    );
  });
  it("超长字幕把 batch 压小(不会爆 ctx)", () => {
    const huge = Array.from({ length: 20 }, () => ({ subtitleText: "很".repeat(2000), frames: [{ caption: "x" }] }));
    expect(chooseBatchSize({ contextSize: 2048 }, huge)).toBeLessThanOrEqual(3);
  });
});
