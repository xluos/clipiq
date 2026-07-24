import { describe, expect, it } from "vitest";
import type {
  PersonAppearance,
  Shot,
  SpeakerTrack,
  Video,
} from "../src/types";
import { buildVlogCandidates } from "../electron/editing/candidate-builder";
import {
  buildVlogPlannerPrompt,
  parseVlogPlannerOutput,
  VLOG_PLANNER_CONSTRAINTS,
} from "../electron/editing/vlog-planner";

function video(patch: Partial<Video>): Video {
  return {
    id: "video-1",
    title: "露营素材",
    sourceType: "local",
    localPath: "/videos/camping.mp4",
    durationSec: 30,
    width: 1920,
    height: 1080,
    orientation: "landscape",
    videoRole: "asset",
    status: "completed",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...patch,
  };
}

function shot(patch: Partial<Shot>): Shot {
  return {
    id: "shot-1",
    videoId: "video-1",
    assetProjectId: "video-1",
    shotIndex: 1,
    startSec: 0,
    endSec: 4,
    description: "小林在营地整理装备",
    usageTags: ["hook", "highlight"],
    thumbnailUrl: "media://shot-1.jpg",
    subtitleSegments: [{
      startSec: 0.3,
      endSec: 1.8,
      text: "先把装备整理好",
      speakerId: "speaker-1",
      words: [
        { text: "先把", startSec: 0.3, endSec: 0.8, speakerId: "speaker-1" },
        { text: "装备整理好", startSec: 0.8, endSec: 1.8, speakerId: "speaker-1" },
      ],
    }],
    transcriptGranularity: "word",
    ...patch,
  };
}

describe("Vlog Candidate Builder", () => {
  it("只产出有真实路径和有效时间的候选，并保守过滤人物身份", () => {
    const appearances: PersonAppearance[] = [
      {
        id: "appearance-high",
        personId: "person-a",
        videoId: "video-1",
        trackId: "track-a",
        startSec: 0,
        endSec: 4,
        confidence: 0.95,
        identityConfidence: 0.92,
        source: "face_track",
      },
      {
        id: "appearance-low",
        personId: "person-b",
        videoId: "video-1",
        trackId: "track-b",
        startSec: 0,
        endSec: 4,
        confidence: 0.9,
        identityConfidence: 0.5,
        source: "face_track",
      },
      {
        id: "appearance-manual",
        personId: "person-c",
        videoId: "video-1",
        trackId: "track-c",
        startSec: 2,
        endSec: 4,
        confidence: 0.7,
        source: "manual",
        manualLocked: true,
      },
    ];
    const speakerTracks: SpeakerTrack[] = [{
      id: "speaker-track-1",
      videoId: "video-1",
      speakerId: "speaker-1",
      personId: "person-a",
      startSec: 0.3,
      endSec: 1.8,
      confidence: 0.9,
      linkConfidence: 0.5,
    }];
    const result = buildVlogCandidates([
      shot({}),
      shot({
        id: "shot-overlap",
        shotIndex: 2,
        startSec: 0.2,
        endSec: 3.8,
        description: "",
        usageTags: [],
        thumbnailUrl: undefined,
        subtitleSegments: undefined,
      }),
      shot({
        id: "shot-short",
        shotIndex: 3,
        startSec: 5,
        endSec: 5.1,
      }),
      shot({
        id: "shot-missing-path",
        videoId: "video-2",
        assetProjectId: "video-2",
        shotIndex: 1,
      }),
    ], [
      video({}),
      video({ id: "video-2", localPath: undefined }),
    ], appearances, speakerTracks, {
      minimumIdentityConfidence: 0.8,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        shotId: "shot-1",
        sourcePath: "/videos/camping.mp4",
        startUs: 0,
        endUs: 4_000_000,
        personIds: ["person-a", "person-c"],
        speakerIds: ["speaker-1"],
        subtitleSegments: [{
          startUs: 300_000,
          endUs: 1_800_000,
          text: "先把装备整理好",
          speakerId: "speaker-1",
          words: [
            { text: "先把", startUs: 300_000, endUs: 800_000, speakerId: "speaker-1" },
            { text: "装备整理好", startUs: 800_000, endUs: 1_800_000, speakerId: "speaker-1" },
          ],
        }],
        transcriptGranularity: "word",
        personAppearances: expect.arrayContaining([
          expect.objectContaining({
            trackId: "track-a",
            personId: "person-a",
          }),
          expect.objectContaining({
            trackId: "track-b",
          }),
          expect.objectContaining({
            trackId: "track-c",
            personId: "person-c",
            manualConfirmed: true,
          }),
        ]),
      }),
    ]);
    expect(result.rejected.map((item) => item.code)).toEqual(expect.arrayContaining([
      "OVERLAPPING_DUPLICATE",
      "TOO_SHORT",
      "MISSING_SOURCE_PATH",
    ]));
    expect(result.candidates[0].personAppearances
      .find((appearance) => appearance.trackId === "track-b"))
      .not.toHaveProperty("personId");
    expect(result.candidates[0].speakerTracks[0]).not.toHaveProperty("personId");
  });
});

describe("Vlog Planner 契约", () => {
  const candidate = {
    shotId: "shot-1",
    videoId: "video-1",
    sourcePath: "/private/path.mp4",
    startUs: 0,
    endUs: 4_000_000,
    durationUs: 4_000_000,
    description: "小林整理装备",
    subtitleSegments: [{
      startUs: 300_000,
      endUs: 1_800_000,
      text: "先把装备整理好",
    }],
    transcriptGranularity: "segment" as const,
    personAppearances: [{
      appearanceId: "appearance-1",
      trackId: "track-a",
      personId: "person-a",
      startUs: 0,
      endUs: 4_000_000,
      detectionConfidence: 0.95,
      identityConfidence: 0.92,
    }],
    speakerTracks: [{
      trackId: "speaker-track-1",
      speakerId: "speaker-1",
      startUs: 300_000,
      endUs: 1_800_000,
      confidence: 0.9,
    }],
    personIds: ["person-a"],
    speakerIds: ["speaker-1"],
    usageTags: ["hook"],
    qualityScore: 0.9,
    qualitySignals: ["valid_time"],
  };

  it("prompt 包含结构化 Vlog 规则和证据，但不暴露或允许模型生成文件路径", () => {
    const prompt = buildVlogPlannerPrompt({
      goal: "一分钟露营 Vlog",
      targetDurationUs: 60_000_000,
      candidates: [candidate],
      methodologySummaries: ["开头直接给反差"],
    });

    expect(VLOG_PLANNER_CONSTRAINTS.map((rule) => rule.ruleId)).toEqual([
      "R-VLOG-006",
      "R-VLOG-001",
      "R-VLOG-002",
      "R-VLOG-003",
      "R-VLOG-004",
      "R-VLOG-007",
    ]);
    expect(prompt.userText).toContain("shotId=shot-1");
    expect(prompt.userText).toContain("people=person-a");
    expect(prompt.userText).toContain("[0.30-1.80] 先把装备整理好");
    expect(prompt.userText).not.toContain("/private/path.mp4");
    expect(prompt.systemText).toContain("严禁生成 startSec/endSec");
  });

  it("解析时拒绝候选集外引用、重复引用和非法置信度", () => {
    const result = parseVlogPlannerOutput({
      selections: [
        { shotId: "shot-1", intent: "开场钩子", confidence: 0.9 },
        { shotId: "missing", intent: "虚构", confidence: 0.8 },
        { shotId: "shot-1", intent: "重复", confidence: 0.7 },
        { shotId: "shot-1", intent: "非法置信度", confidence: 2 },
      ],
    }, [candidate]);

    expect(result.selections).toEqual([
      { shotId: "shot-1", intent: "开场钩子", confidence: 0.9 },
    ]);
    expect(result.errors).toHaveLength(3);
  });
});
