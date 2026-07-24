import { describe, it, expect } from "vitest";
import {
  estimateShotsCount,
  estimateCandidateFrames,
  estimateKeptFrames,
  estimateChunksCount,
} from "./eta-estimator.cjs";

describe("eta-estimator: estimateShotsCount", () => {
  it("约每 7.5s 一个镜头,至少 1", () => {
    expect(estimateShotsCount(0)).toBe(1);
    expect(estimateShotsCount(75)).toBe(10);
    expect(estimateShotsCount(7.5)).toBe(1);
  });
  it("时长越长镜头越多", () => {
    expect(estimateShotsCount(300)).toBeGreaterThan(estimateShotsCount(60));
  });
});

describe("eta-estimator: estimateCandidateFrames", () => {
  it("无 prefilter 时 = 目标帧数", () => {
    const noPre = estimateCandidateFrames(120, undefined, false);
    expect(noPre).toBeGreaterThanOrEqual(6);
  });
  it("有 prefilter 时候选帧更多(要给精筛留余量)", () => {
    const withPre = estimateCandidateFrames(120, undefined, true);
    const noPre = estimateCandidateFrames(120, undefined, false);
    expect(withPre).toBeGreaterThan(noPre);
  });
});

describe("eta-estimator: estimateKeptFrames", () => {
  it("无 prefilter 原样返回", () => {
    expect(estimateKeptFrames(40, false)).toBe(40);
  });
  it("有 prefilter 约保留 40%,下限 4", () => {
    expect(estimateKeptFrames(100, true)).toBe(40);
    expect(estimateKeptFrames(2, true)).toBe(4);
  });
});

describe("eta-estimator: estimateChunksCount", () => {
  it("至少 1 个 chunk", () => {
    expect(estimateChunksCount(60, 8192, 40, 8, 300, false)).toBeGreaterThanOrEqual(1);
  });
  it("帧数/字数越多 chunk 越多(同 ctx)", () => {
    const small = estimateChunksCount(60, 8192, 10, 4, 100, true);
    const big = estimateChunksCount(60, 8192, 200, 40, 5000, true);
    expect(big).toBeGreaterThanOrEqual(small);
  });
  it("本地 provider(每帧 token 少)chunk 数 ≤ 远程", () => {
    const local = estimateChunksCount(60, 8192, 100, 20, 1000, true);
    const remote = estimateChunksCount(60, 8192, 100, 20, 1000, false);
    expect(local).toBeLessThanOrEqual(remote);
  });
});
