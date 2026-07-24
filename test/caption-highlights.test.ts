import { describe, expect, it } from "vitest";
import type { CaptionCue, VideoClip } from "../src/types";
import {
  captionCueFromEvidenceSegment,
  deriveCaptionHighlights,
} from "../electron/editing/caption-highlights";

describe("字幕关键词高亮", () => {
  it("只从有词级时间的事件词和数字生成可追溯高亮", () => {
    const cue: CaptionCue = {
      id: "caption-1",
      startUs: 0,
      endUs: 2_000_000,
      text: "先把装备整理好，一共3件",
      styleId: "proxy-default",
      wordTimings: [
        { text: "先把", startUs: 0, endUs: 300_000, confidence: 0.9 },
        { text: "装备整理好", startUs: 300_000, endUs: 1_000_000, confidence: 0.95 },
        { text: "一共", startUs: 1_000_000, endUs: 1_300_000, confidence: 0.8 },
        { text: "3件", startUs: 1_300_000, endUs: 1_700_000, confidence: 0.9 },
      ],
    };

    const highlights = deriveCaptionHighlights(cue, ["人物整理装备，准备出发"]);

    expect(highlights.map((highlight) => ({
      text: highlight.text,
      renderedText: cue.text.slice(highlight.startOffset, highlight.endOffset),
      startUs: highlight.startUs,
      endUs: highlight.endUs,
      reason: highlight.reason,
    }))).toEqual([
      {
        text: "装备整理好",
        renderedText: "装备整理好",
        startUs: 300_000,
        endUs: 1_000_000,
        reason: "event_keyword",
      },
      {
        text: "3件",
        renderedText: "3件",
        startUs: 1_300_000,
        endUs: 1_700_000,
        reason: "number",
      },
    ]);
  });

  it("把素材词级时间按片段变速换算到时间线并生成高亮", () => {
    const clip: VideoClip = {
      id: "clip-1",
      shotId: "shot-1",
      videoId: "video-1",
      sourcePath: "/videos/clip.mp4",
      sourceInUs: 1_000_000,
      sourceOutUs: 5_000_000,
      timelineInUs: 2_000_000,
      speed: 2,
      volume: 1,
      selectionReason: "测试",
      confidence: 1,
      evidence: {
        eventSummary: "人物整理装备",
      },
    };
    const cue = captionCueFromEvidenceSegment(clip, {
      startUs: 1_200_000,
      endUs: 3_200_000,
      text: "开始整理装备",
      words: [
        { text: "开始", startUs: 1_200_000, endUs: 1_600_000 },
        { text: "整理装备", startUs: 1_600_000, endUs: 3_200_000 },
      ],
    }, 0);

    expect(cue).toMatchObject({
      startUs: 2_100_000,
      endUs: 3_100_000,
      wordTimings: [
        { text: "开始", startUs: 2_100_000, endUs: 2_300_000 },
        { text: "整理装备", startUs: 2_300_000, endUs: 3_100_000 },
      ],
      highlights: [{
        text: "整理装备",
        startUs: 2_300_000,
        endUs: 3_100_000,
        reason: "event_keyword",
      }],
    });
  });

  it("没有可靠词级时间时保持普通字幕", () => {
    const cue: CaptionCue = {
      id: "caption-1",
      startUs: 0,
      endUs: 1_000_000,
      text: "只有句级字幕",
      styleId: "proxy-default",
    };
    expect(deriveCaptionHighlights(cue, ["句级字幕"])).toEqual([]);
  });
});
