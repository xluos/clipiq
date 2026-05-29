import { describe, it, expect } from "vitest";
import {
  sanitizeTag,
  extractJsonFromText,
  signatureSimilarity,
  refineByTags,
  SCENE_TYPES,
} from "./prefilter.cjs";

describe("prefilter: extractJsonFromText", () => {
  it("直接 JSON", () => {
    expect(extractJsonFromText('{"a":1}')).toEqual({ a: 1 });
  });
  it("从带前后文的文本里抠出 JSON", () => {
    expect(extractJsonFromText('好的,结果是 {"a":2} 完毕')).toEqual({ a: 2 });
  });
  it("非法 / 空返回 null", () => {
    expect(extractJsonFromText("没有 json")).toBeNull();
    expect(extractJsonFromText("")).toBeNull();
    expect(extractJsonFromText(null)).toBeNull();
  });
});

describe("prefilter: sanitizeTag 字段兜底", () => {
  it("非对象输入回 neutralTag", () => {
    const t = sanitizeTag(null);
    expect(t.subject).toBe("未识别");
    expect(t.salience).toBe(5);
  });
  it("非法 sceneType 归一到 other", () => {
    expect(sanitizeTag({ sceneType: "瞎写的" }).sceneType).toBe("other");
    expect(SCENE_TYPES).toContain(sanitizeTag({ sceneType: SCENE_TYPES[0] }).sceneType);
  });
  it("salience 夹到 0..10 并取整", () => {
    expect(sanitizeTag({ salience: 99 }).salience).toBe(10);
    expect(sanitizeTag({ salience: -5 }).salience).toBe(0);
    expect(sanitizeTag({ salience: 3.7 }).salience).toBe(4);
    expect(sanitizeTag({ salience: "abc" }).salience).toBe(5);
  });
  it("subject / caption 截断", () => {
    expect(sanitizeTag({ subject: "字".repeat(50) }).subject.length).toBe(24);
    expect(sanitizeTag({ caption: "字".repeat(200) }).caption.length).toBe(90);
  });
  it("signature 缺失时回落到 subject", () => {
    expect(sanitizeTag({ subject: "猫" }).signature).toBe("猫");
  });
});

describe("prefilter: signatureSimilarity", () => {
  it("完全相同 = 1", () => {
    expect(signatureSimilarity("abc", "abc")).toBe(1);
  });
  it("完全不同 = 0", () => {
    expect(signatureSimilarity("abc", "xyz")).toBe(0);
  });
  it("空输入 = 0", () => {
    expect(signatureSimilarity("", "abc")).toBe(0);
  });
  it("部分重叠在 (0,1)", () => {
    const s = signatureSimilarity("abc", "abd");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("prefilter: refineByTags", () => {
  const frame = (index, tag, midSec = index) => ({ index, midSec, prefilterTag: tag });

  it("空输入返回空结果", () => {
    expect(refineByTags([])).toEqual({ kept: [], dropped: [], reasons: {} });
  });

  it("低 salience 帧被删,但至少保留 minKeep", () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      frame(i, { salience: 1, signature: `sig${i}` }),
    );
    const { kept } = refineByTags(frames, { minKeep: 4 });
    expect(kept.length).toBe(4); // 全低分 → 兜底保留 top minKeep
  });

  it("相似画面聚类:同 signature 只留 salience 高的", () => {
    const frames = [
      frame(0, { salience: 5, signature: "猫猫猫" }),
      frame(1, { salience: 8, signature: "猫猫猫" }),
      frame(2, { salience: 6, signature: "狗狗狗" }),
    ];
    const { kept } = refineByTags(frames, { minKeep: 1, maxKeep: 12 });
    const sigs = kept.map((f) => f.prefilterTag.signature);
    // 猫簇只保留一张(salience=8 那张),狗保留
    expect(kept.find((f) => f.prefilterTag.signature === "猫猫猫").index).toBe(1);
    expect(sigs).toContain("狗狗狗");
  });

  it("超过 maxKeep 按 salience 截断,结果按时间排序", () => {
    const frames = Array.from({ length: 8 }, (_, i) =>
      frame(i, { salience: i + 1, signature: `uniq${i}` }, i),
    );
    const { kept } = refineByTags(frames, { minKeep: 1, maxKeep: 3 });
    expect(kept.length).toBe(3);
    // 时间序(midSec 升序)
    const mids = kept.map((f) => f.midSec);
    expect([...mids].sort((a, b) => a - b)).toEqual(mids);
  });
});
