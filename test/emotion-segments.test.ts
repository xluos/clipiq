import { describe, expect, it } from "vitest";
import type { AudioClip, EditPlan, EmotionTone, VideoClip } from "../src/types";
import { buildEmotionSegments } from "../electron/editing/emotion-segments";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";

function clip(
  id: string,
  timelineInUs: number,
  durationUs: number,
  tone: EmotionTone,
  intensity: number,
): VideoClip {
  return {
    id,
    shotId: `shot-${id}`,
    videoId: "video-1",
    sourcePath: "/videos/source.mp4",
    sourceInUs: timelineInUs,
    sourceOutUs: timelineInUs + durationUs,
    timelineInUs,
    speed: 1,
    volume: 1,
    selectionReason: id,
    confidence: 0.9,
    emotion: {
      tone,
      intensity,
      confidence: 0.8,
      reason: `${id}-${tone}`,
      source: "planner",
    },
  };
}

function planWith(
  clips: VideoClip[],
  audio: AudioClip[],
): EditPlan {
  const actualDurationUs = clips.reduce(
    (maximum, item) =>
      Math.max(maximum, item.timelineInUs + item.sourceOutUs - item.sourceInUs),
    0,
  );
  return {
    id: "plan-emotion",
    version: 1,
    sessionId: "session-1",
    status: "validated",
    canvas: { width: 1080, height: 1920, fps: 30 },
    targetDurationUs: actualDurationUs,
    actualDurationUs,
    tracks: [
      { id: "video-track", kind: "video", items: clips },
      { id: "audio-track", kind: "audio", items: audio },
    ],
    transitions: clips.slice(1).map((item, index) => ({
      id: `transition-${index + 1}`,
      fromClipId: clips[index].id,
      toClipId: item.id,
      type: "cut",
      durationUs: 0,
    })),
    emotionSegments: buildEmotionSegments(clips, actualDurationUs, {
      minimumSegmentDurationUs: 0,
    }),
    provenance: {
      goal: "情绪 BGM",
      genre: "vlog",
      methodologyIds: [],
      generatedAt: 1,
    },
    validation: { valid: true, warnings: [], errors: [] },
  };
}

describe("情绪段落编排", () => {
  it("合并连续同类镜头，并连续覆盖完整时间线", () => {
    const clips = [
      clip("a", 0, 3_000_000, "calm", 0.2),
      clip("b", 3_000_000, 2_000_000, "calm", 0.5),
      clip("c", 5_000_000, 4_000_000, "upbeat", 0.9),
    ];

    expect(buildEmotionSegments(clips, 9_000_000, {
      minimumSegmentDurationUs: 0,
    })).toEqual([
      {
        id: "emotion-01",
        startUs: 0,
        endUs: 5_000_000,
        tone: "calm",
        intensity: 0.32,
        confidence: 0.8,
        clipIds: ["a", "b"],
        reason: "a-calm；b-calm",
      },
      {
        id: "emotion-02",
        startUs: 5_000_000,
        endUs: 9_000_000,
        tone: "upbeat",
        intensity: 0.9,
        confidence: 0.8,
        clipIds: ["c"],
        reason: "c-upbeat",
      },
    ]);
  });

  it("确定性合并短段并限制最多四段", () => {
    const clips = Array.from({ length: 6 }, (_, index) =>
      clip(
        String(index + 1),
        index * 2_000_000,
        2_000_000,
        index % 2 === 0 ? "calm" : "upbeat",
        index / 10,
      ));
    const segments = buildEmotionSegments(clips, 12_000_000);

    expect(segments.length).toBeLessThanOrEqual(4);
    expect(segments[0].startUs).toBe(0);
    expect(segments.at(-1)?.endUs).toBe(12_000_000);
    expect(segments.slice(1).every((item, index) =>
      item.startUs === segments[index].endUs)).toBe(true);
    expect(segments.flatMap((item) => item.clipIds).sort()).toEqual(
      clips.map((item) => item.id).sort(),
    );
  });

  it("多段 BGM 必须与情绪段落一一对齐", () => {
    const clips = [
      clip("a", 0, 5_000_000, "calm", 0.3),
      clip("b", 5_000_000, 4_000_000, "upbeat", 0.8),
    ];
    const music: AudioClip[] = [
      {
        id: "music-1",
        kind: "music",
        sourcePath: "/music/calm.wav",
        timelineInUs: 0,
        sourceInUs: 0,
        sourceOutUs: 5_000_000,
        volume: 0.18,
        emotionSegmentId: "emotion-01",
        mood: "calm",
      },
      {
        id: "music-2",
        kind: "music",
        sourcePath: "/music/upbeat.wav",
        timelineInUs: 5_000_000,
        sourceInUs: 0,
        sourceOutUs: 4_000_000,
        volume: 0.18,
        emotionSegmentId: "emotion-02",
        mood: "upbeat",
      },
    ];
    const current = planWith(clips, music);

    expect(validateEditPlan(current).valid).toBe(true);
    current.tracks[1].items[1].mood = "tense";
    expect(validateEditPlan(current).errors.map((issue) => issue.code))
      .toContain("MUSIC_EMOTION_TONE_MISMATCH");
  });

  it("没有 Planner 情绪时不伪造段落", () => {
    const current = clip("a", 0, 2_000_000, "calm", 0.4);
    delete current.emotion;
    expect(buildEmotionSegments([current], 2_000_000)).toEqual([]);
  });
});
