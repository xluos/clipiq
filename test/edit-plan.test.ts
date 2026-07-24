import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { EditPlan, Shot } from "../src/types";
import { compileEditPlan } from "../electron/editing/edit-plan-compiler";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";
import { candidateIdForShotWindow } from "../electron/editing/candidate-windows";
import {
  createEditPlanRepository,
  migrateEditPlanSchema,
} from "../electron/repositories/edit-plan-repository";

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];

function createDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function shot(patch: Partial<Shot>): Shot {
  return {
    id: "shot-1",
    videoId: "video-1",
    assetProjectId: "video-1",
    shotIndex: 1,
    startSec: 0,
    endSec: 4,
    description: "人物整理露营装备",
    usageTags: ["action"],
    ...patch,
  };
}

function candidateSource<T extends {
  shot: Shot;
  videoId: string;
  sourcePath: string;
}>(source: T): T & {
  candidateId: string;
  sourceInUs: number;
  sourceOutUs: number;
} {
  const sourceInUs = Math.round(source.shot.startSec * 1_000_000);
  const sourceOutUs = Math.round(source.shot.endSec * 1_000_000);
  return {
    ...source,
    candidateId: candidateIdForShotWindow(source.shot.id, sourceInUs, sourceOutUs),
    sourceInUs,
    sourceOutUs,
  };
}

function candidateSelection(
  source: ReturnType<typeof candidateSource>,
  intent: string,
  confidence: number,
) {
  return {
    candidateId: source.candidateId,
    shotId: source.shot.id,
    intent,
    confidence,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("EditPlan 确定性编译", () => {
  it("持久化并校验多版本分组元数据", () => {
    const source = candidateSource({
      shot: shot({}),
      videoId: "video-1",
      sourcePath: "/videos/video-1.mp4",
    });
    const selection = candidateSelection(source, "叙事均衡", 0.9);
    const selectionSignature = "a".repeat(64);
    const plan = compileEditPlan([selection], [source], {
      planId: "plan-variant",
      sessionId: "session-1",
      targetDurationUs: 4_000_000,
      canvas: { width: 1080, height: 1920, fps: 30 },
      goal: "测试多版本",
      generatedAt: 1,
      variant: {
        groupId: "variant-group-1",
        key: "balanced",
        label: "叙事均衡",
        description: "兼顾事件与节奏",
        index: 0,
        count: 3,
        selectionSignature,
      },
      sourceExists: () => true,
    });

    expect(plan.provenance.variant).toEqual({
      groupId: "variant-group-1",
      key: "balanced",
      label: "叙事均衡",
      description: "兼顾事件与节奏",
      index: 0,
      count: 3,
      selectionSignature,
    });
    expect(plan.validation.valid).toBe(true);
    const invalid = structuredClone(plan);
    invalid.provenance.variant!.index = 3;
    expect(validateEditPlan(invalid).errors.map((issue) => issue.code))
      .toContain("INVALID_PLAN_VARIANT");
  });

  it("只接受 candidateId 和剪辑意图，并由程序编译真实微秒范围", () => {
    const sources = [
      {
        shot: shot({
          subtitleSegments: [{
            startSec: 0.2,
            endSec: 1.4,
            text: "先把装备整理好",
            speakerId: "speaker-1",
            words: [
              { text: "先把", startSec: 0.2, endSec: 0.6, speakerId: "speaker-1" },
              { text: "装备整理好", startSec: 0.6, endSec: 1.4, speakerId: "speaker-1" },
            ],
          }],
          transcriptGranularity: "word",
        }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
        sourceWidth: 1920,
        sourceHeight: 1080,
        appearances: [
          {
            id: "appearance-high",
            personId: "person-a",
            videoId: "video-1",
            trackId: "track-a",
            startSec: 0,
            endSec: 4,
            confidence: 0.95,
            identityConfidence: 0.91,
            focusBounds: { x: 0.72, y: 0.2, width: 0.12, height: 0.3 },
            source: "face_track" as const,
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
            source: "face_track" as const,
          },
          {
            id: "appearance-other-video",
            personId: "person-other",
            videoId: "video-2",
            trackId: "track-other",
            startSec: 0,
            endSec: 4,
            confidence: 1,
            identityConfidence: 1,
            source: "face_track" as const,
          },
        ],
        speakerTracks: [
          {
            id: "speaker-track-1",
            videoId: "video-1",
            speakerId: "speaker-1",
            startSec: 0.2,
            endSec: 1.4,
            confidence: 0.8,
          },
          {
            id: "speaker-track-other",
            videoId: "video-2",
            speakerId: "speaker-other",
            startSec: 0.2,
            endSec: 1.4,
            confidence: 1,
          },
        ],
      },
      {
        shot: shot({
          id: "shot-2",
          shotIndex: 2,
          startSec: 10,
          endSec: 15,
          description: "人物背起装备出发",
        }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      },
    ].map(candidateSource);
    const plan = compileEditPlan([
      {
        ...candidateSelection(sources[0], "交代准备过程", 0.95),
        emotion: {
          tone: "calm" as const,
          intensity: 0.35,
          confidence: 0.88,
          reason: "整理装备，建立情境",
          source: "planner" as const,
        },
      },
      {
        ...candidateSelection(sources[1], "推进到出发", 0.9),
        emotion: {
          tone: "upbeat" as const,
          intensity: 0.8,
          confidence: 0.91,
          reason: "背起装备出发",
          source: "planner" as const,
        },
      },
    ], sources, {
      planId: "plan-1",
      sessionId: "session-1",
      targetDurationUs: 6_000_000,
      canvas: { width: 1080, height: 1920, fps: 30 },
      goal: "一分钟露营 Vlog",
      generatedAt: 1000,
      minimumIdentityConfidence: 0.8,
      sourceExists: (sourcePath) => sourcePath === "/videos/video-1.mp4",
    });

    expect(plan.status).toBe("validated");
    expect(plan.validation).toEqual({ valid: true, warnings: [], errors: [] });
    expect(plan.actualDurationUs).toBe(6_000_000);
    expect(plan.tracks[0]).toMatchObject({
      kind: "video",
      items: [
        {
          candidateId: "shot-1::0-4000000",
          shotId: "shot-1",
          sourceInUs: 0,
          sourceOutUs: 4_000_000,
          timelineInUs: 0,
          crop: {
            x: 1192,
            y: 0,
            width: 606,
            height: 1080,
          },
          selectionReason: "交代准备过程",
          evidence: {
            eventSummary: "人物整理露营装备",
            personIds: ["person-a"],
            speakerIds: ["speaker-1"],
            personAppearances: expect.arrayContaining([
              expect.objectContaining({
                appearanceId: "appearance-high",
                focusBounds: { x: 0.72, y: 0.2, width: 0.12, height: 0.3 },
              }),
            ]),
            subtitleSegments: [{
              startUs: 200_000,
              endUs: 1_400_000,
              text: "先把装备整理好",
              speakerId: "speaker-1",
              words: [
                { text: "先把", startUs: 200_000, endUs: 600_000, speakerId: "speaker-1" },
                { text: "装备整理好", startUs: 600_000, endUs: 1_400_000, speakerId: "speaker-1" },
              ],
            }],
            transcriptGranularity: "word",
            alignedSegments: expect.arrayContaining([
              expect.objectContaining({
                startUs: 200_000,
                endUs: 1_400_000,
                eventSummary: "人物整理露营装备",
                eventGranularity: "shot",
                subtitleText: "先把装备整理好",
                visiblePeople: expect.arrayContaining([
                  expect.objectContaining({
                    trackId: "track-a",
                    personId: "person-a",
                  }),
                  expect.objectContaining({
                    trackId: "track-b",
                  }),
                ]),
                activeSpeakers: [{
                  trackId: "speaker-track-1",
                  speakerId: "speaker-1",
                }],
              }),
            ]),
          },
        },
        {
          candidateId: "shot-2::10000000-15000000",
          shotId: "shot-2",
          sourceInUs: 10_000_000,
          sourceOutUs: 12_000_000,
          timelineInUs: 4_000_000,
        },
      ],
    });
    expect(plan.transitions).toEqual([{
      id: "plan-1-transition-1",
      fromClipId: "plan-1-video-1",
      toClipId: "plan-1-video-2",
      type: "cut",
      durationUs: 0,
    }]);
    expect(plan.emotionSegments).toEqual([
      {
        id: "emotion-01",
        startUs: 0,
        endUs: 6_000_000,
        tone: "calm",
        intensity: 0.5,
        confidence: 0.89,
        clipIds: ["plan-1-video-1", "plan-1-video-2"],
        reason: "整理装备，建立情境；背起装备出发",
      },
    ]);
    expect(plan.provenance.plannerInputDigest).toMatch(/^[a-f0-9]{64}$/);
    const firstVideoTrack = plan.tracks.find((track) => track.kind === "video");
    if (firstVideoTrack?.kind !== "video") throw new Error("测试期望视频轨道");
    expect(firstVideoTrack?.items[0].evidence?.personAppearances
      ?.map((appearance) => appearance.trackId)).toEqual(["track-a", "track-b"]);
    expect(firstVideoTrack?.items[0].evidence?.speakerTracks
      ?.map((track) => track.speakerId)).toEqual(["speaker-1"]);
    expect(plan.tracks.find((track) => track.kind === "caption")).toMatchObject({
      kind: "caption",
      items: [{
        wordTimings: [
          { text: "先把", startUs: 200_000, endUs: 600_000, speakerId: "speaker-1" },
          { text: "装备整理好", startUs: 600_000, endUs: 1_400_000, speakerId: "speaker-1" },
        ],
        highlights: [{
          text: "装备整理好",
          startOffset: 2,
          endOffset: 7,
          startUs: 600_000,
          endUs: 1_400_000,
          reason: "event_keyword",
        }],
      }],
    });
    const invalidHighlightPlan = structuredClone(plan);
    const invalidCaptions = invalidHighlightPlan.tracks.find((track) =>
      track.kind === "caption");
    if (invalidCaptions?.kind !== "caption") throw new Error("测试期望字幕轨道");
    invalidCaptions.items[0].highlights![0].text = "错误文字";
    expect(validateEditPlan(invalidHighlightPlan).errors.map((issue) => issue.code))
      .toContain("CAPTION_HIGHLIGHT_TEXT_MISMATCH");
  });

  it("候选集外引用和重复引用会产生可解释错误，不猜测时间", () => {
    const source = candidateSource({
      shot: shot({}),
      videoId: "video-1",
      sourcePath: "/videos/video-1.mp4",
    });
    const validSelection = candidateSelection(source, "有效", 0.9);
    const plan = compileEditPlan([
      {
        candidateId: "missing::0-1000000",
        shotId: "missing",
        intent: "不存在",
        confidence: 0.8,
      },
      validSelection,
      { ...validSelection, intent: "重复" },
    ], [source], {
      planId: "plan-errors",
      sessionId: "session-1",
      targetDurationUs: 4_000_000,
      canvas: { width: 1920, height: 1080, fps: 30 },
      goal: "测试",
      generatedAt: 1000,
    });

    expect(plan.status).toBe("draft");
    expect(plan.tracks[0].items).toHaveLength(1);
    expect(plan.validation.errors.map((issue) => issue.code)).toEqual([
      "UNKNOWN_SELECTION_CANDIDATE",
      "DUPLICATE_SELECTION_CANDIDATE",
    ]);
  });

  it("同一长 Shot 的多个 candidateId 可解析为不重叠的精确来源范围", () => {
    const longShot = shot({
      id: "shot-long",
      startSec: 0,
      endSec: 10,
      eventSegments: [
        {
          startSec: 0,
          endSec: 5,
          summary: "人物整理装备",
          granularity: "segment",
          source: "analysis_node",
          sourceNodeId: "event-prepare",
        },
        {
          startSec: 5,
          endSec: 10,
          summary: "人物到达营地",
          granularity: "segment",
          source: "analysis_node",
          sourceNodeId: "event-arrive",
        },
      ],
      subtitleSegments: [
        { startSec: 0.2, endSec: 1, text: "第一段" },
        { startSec: 7, endSec: 8, text: "第二段" },
      ],
    });
    const sources = [
      {
        candidateId: candidateIdForShotWindow(longShot.id, 0, 5_000_000),
        shot: longShot,
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
        sourceInUs: 0,
        sourceOutUs: 5_000_000,
      },
      {
        candidateId: candidateIdForShotWindow(
          longShot.id,
          5_000_000,
          10_000_000,
        ),
        shot: longShot,
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
        sourceInUs: 5_000_000,
        sourceOutUs: 10_000_000,
      },
    ];
    const plan = compileEditPlan([
      candidateSelection(sources[0], "动作开端", 0.9),
      candidateSelection(sources[1], "动作结果", 0.9),
    ], sources, {
      planId: "plan-long",
      sessionId: "session-1",
      targetDurationUs: 10_000_000,
      canvas: { width: 1920, height: 1080, fps: 30 },
      goal: "保留完整过程",
      generatedAt: 1000,
    });

    const video = plan.tracks.find((track) => track.kind === "video");
    const captions = plan.tracks.find((track) => track.kind === "caption");
    if (video?.kind !== "video" || captions?.kind !== "caption") {
      throw new Error("测试期望视频和字幕轨道");
    }
    expect(plan.validation.valid).toBe(true);
    expect(video.items.map((clip) => ({
      candidateId: clip.candidateId,
      shotId: clip.shotId,
      sourceInUs: clip.sourceInUs,
      sourceOutUs: clip.sourceOutUs,
    }))).toEqual([
      {
        candidateId: "shot-long::0-5000000",
        shotId: "shot-long",
        sourceInUs: 0,
        sourceOutUs: 5_000_000,
      },
      {
        candidateId: "shot-long::5000000-10000000",
        shotId: "shot-long",
        sourceInUs: 5_000_000,
        sourceOutUs: 10_000_000,
      },
    ]);
    expect(captions.items.map((cue) => ({
      text: cue.text,
      startUs: cue.startUs,
      endUs: cue.endUs,
    }))).toEqual([
      { text: "第一段", startUs: 200_000, endUs: 1_000_000 },
      { text: "第二段", startUs: 7_000_000, endUs: 8_000_000 },
    ]);
    expect(video.items.map((clip) => ({
      eventSummary: clip.evidence?.eventSummary,
      events: clip.evidence?.eventSegments?.map((segment) => ({
        startUs: segment.startUs,
        endUs: segment.endUs,
        summary: segment.summary,
        granularity: segment.granularity,
      })),
    }))).toEqual([
      {
        eventSummary: "人物整理装备",
        events: [{
          startUs: 0,
          endUs: 5_000_000,
          summary: "人物整理装备",
          granularity: "segment",
        }],
      },
      {
        eventSummary: "人物到达营地",
        events: [{
          startUs: 5_000_000,
          endUs: 10_000_000,
          summary: "人物到达营地",
          granularity: "segment",
        }],
      },
    ]);
  });

  it("字幕、事件和人物证据变化会改变 Planner 输入摘要", () => {
    const compile = (description: string, personId: string) => {
      const source = candidateSource({
        shot: shot({
          description,
          subtitleSegments: [{
            startSec: 0.2,
            endSec: 1.2,
            text: "准备出发",
          }],
        }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
        appearances: [{
          id: "appearance-1",
          personId,
          videoId: "video-1",
          trackId: "track-1",
          startSec: 0,
          endSec: 4,
          confidence: 1,
          identityConfidence: 1,
          source: "face_track" as const,
        }],
      });
      return compileEditPlan([
        candidateSelection(source, "测试", 1),
      ], [source], {
        planId: `plan-${personId}`,
        sessionId: "session-1",
        targetDurationUs: 4_000_000,
        canvas: { width: 1920, height: 1080, fps: 30 },
        goal: "测试",
        generatedAt: 1000,
        minimumIdentityConfidence: 0.8,
      });
    };

    const first = compile("人物整理露营装备", "person-a");
    const changedEvent = compile("人物背起装备出发", "person-a");
    const changedPerson = compile("人物整理露营装备", "person-b");
    expect(first.provenance.plannerInputDigest)
      .not.toBe(changedEvent.provenance.plannerInputDigest);
    expect(first.provenance.plannerInputDigest)
      .not.toBe(changedPerson.provenance.plannerInputDigest);
  });

  it("把 Planner 旁白锚定到后续真实镜头，并保留待合成降级状态", () => {
    const sources = [
      candidateSource({
        shot: shot({ id: "shot-1", startSec: 0, endSec: 4 }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      }),
      candidateSource({
        shot: shot({ id: "shot-2", shotIndex: 2, startSec: 5, endSec: 9 }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      }),
    ];
    const plan = compileEditPlan([
      candidateSelection(sources[0], "准备", 0.9),
      candidateSelection(sources[1], "出发", 0.9),
    ], sources, {
      planId: "plan-voiceover",
      sessionId: "session-1",
      targetDurationUs: 8_000_000,
      canvas: { width: 1920, height: 1080, fps: 30 },
      goal: "测试旁白",
      generatedAt: 1000,
      voiceovers: [{
        afterCandidateId: sources[0].candidateId,
        text: "山谷天气比预想得更冷。",
      }],
    });

    const video = plan.tracks.find((track) => track.kind === "video");
    const audio = plan.tracks.find((track) => track.kind === "audio");
    if (video?.kind !== "video" || audio?.kind !== "audio") throw new Error("fixture");
    expect(plan.validation.valid).toBe(true);
    expect(plan.validation.warnings.map((issue) => issue.code))
      .toContain("VOICEOVER_NOT_SYNTHESIZED");
    expect(audio.items).toEqual([
      expect.objectContaining({
        kind: "voiceover",
        ttsText: "山谷天气比预想得更冷。",
        anchorClipId: video.items[1].id,
        timelineInUs: video.items[1].timelineInUs,
      }),
    ]);
    expect(plan.provenance.plannerOutput).toEqual({
      selections: [
        candidateSelection(sources[0], "准备", 0.9),
        candidateSelection(sources[1], "出发", 0.9),
      ],
      voiceover: [{
        afterCandidateId: sources[0].candidateId,
        text: "山谷天气比预想得更冷。",
      }],
    });
  });
});

describe("EditPlan 硬校验", () => {
  it("拒绝超出 Shot、轨道重叠和不一致的实际时长", () => {
    const sources = [
      candidateSource({
        shot: shot({}),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      }),
      candidateSource({
        shot: shot({ id: "shot-2", shotIndex: 2, startSec: 5, endSec: 8 }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      }),
    ];
    const plan = compileEditPlan([
      candidateSelection(sources[0], "片段 1", 0.9),
      candidateSelection(sources[1], "片段 2", 0.9),
    ], sources, {
      planId: "plan-invalid",
      sessionId: "session-1",
      targetDurationUs: 7_000_000,
      canvas: { width: 1920, height: 1080, fps: 25 },
      goal: "测试",
      generatedAt: 1000,
    });
    const invalid = structuredClone(plan);
    const track = invalid.tracks[0];
    if (track.kind !== "video") throw new Error("测试期望视频轨道");
    track.items[0].sourceOutUs = 4_500_000;
    track.items[1].timelineInUs = 3_000_000;
    invalid.actualDurationUs = 123;

    const result = validateEditPlan(invalid, {
      shots: new Map([
        ["shot-1", {
          shotId: "shot-1",
          videoId: "video-1",
          sourcePath: "/videos/video-1.mp4",
          startUs: 0,
          endUs: 4_000_000,
        }],
        ["shot-2", {
          shotId: "shot-2",
          videoId: "video-1",
          sourcePath: "/videos/video-1.mp4",
          startUs: 5_000_000,
          endUs: 8_000_000,
        }],
      ]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SOURCE_OUTSIDE_SHOT",
      "ALIGNED_EVIDENCE_INCOMPLETE",
      "VIDEO_TRACK_OVERLAP",
      "ACTUAL_DURATION_MISMATCH",
    ]));
  });
});

describe("EditPlan repository", () => {
  it("迁移可重复，按 session 保存完整方案且删除结果明确", () => {
    const db = createDatabase();
    migrateEditPlanSchema(db);
    migrateEditPlanSchema(db);
    const repository = createEditPlanRepository(db);
    const source = candidateSource({
      shot: shot({}),
      videoId: "video-1",
      sourcePath: "/videos/video-1.mp4",
    });
    const plan = compileEditPlan([
      candidateSelection(source, "保留动作", 0.9),
    ], [source], {
      planId: "plan-1",
      sessionId: "session-1",
      targetDurationUs: 4_000_000,
      canvas: { width: 1920, height: 1080, fps: 30 },
      goal: "测试",
      generatedAt: 1000,
    });

    repository.save(plan);
    repository.save({
      ...plan,
      status: "rendered",
    });

    expect(repository.get("plan-1")).toMatchObject({
      id: "plan-1",
      sessionId: "session-1",
      status: "rendered",
    } satisfies Partial<EditPlan>);
    expect(repository.list("session-1")).toHaveLength(1);
    expect(repository.list("other")).toEqual([]);
    expect(repository.delete("plan-1")).toBe(true);
    expect(repository.delete("plan-1")).toBe(false);
  });
});
