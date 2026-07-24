import { describe, expect, it } from "vitest";
import normalizer from "./transcript-normalizer.cjs";

const { normalizeTranscriptSegments } = normalizer;

describe("transcript normalizer", () => {
  it("保留有效词级时间和置信度，过滤零时长标点与损坏字符", () => {
    expect(normalizeTranscriptSegments([{
      start: 0,
      end: 2,
      text: "今天天气很好。",
      words: [
        { word: "今天", start: 0.1, end: 0.5, probability: 0.98 },
        { word: "天气", start: 0.5, end: 1.1, probability: 0.96 },
        { word: "�", start: 1.1, end: 1.2, probability: 0.9 },
        { word: "。", start: 1.8, end: 1.8, probability: 0.8 },
      ],
    }], (value) => String(value || "").replace("氣", "气").trim())).toEqual([{
      start: 0,
      end: 2,
      text: "今天天气很好。",
      words: [
        { text: "今天", start: 0.1, end: 0.5, confidence: 0.98 },
        { text: "天气", start: 0.5, end: 1.1, confidence: 0.96 },
      ],
    }]);
  });

  it("丢弃非法分段，不用 0 掩盖坏时间", () => {
    expect(normalizeTranscriptSegments([
      { start: -1, end: 2, text: "负时间" },
      { start: 2, end: 2, text: "零时长" },
      { start: 0, end: 1, text: "" },
      { start: 1, end: 2, text: "有效" },
    ])).toEqual([{ start: 1, end: 2, text: "有效" }]);
  });
});
