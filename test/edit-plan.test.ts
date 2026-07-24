import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { EditPlan, Shot } from "../src/types";
import { compileEditPlan } from "../electron/editing/edit-plan-compiler";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";
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

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("EditPlan 确定性编译", () => {
  it("只接受 shotId 和剪辑意图，并由程序编译真实微秒范围", () => {
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
    ];
    const plan = compileEditPlan([
      { shotId: "shot-1", intent: "交代准备过程", confidence: 0.95 },
      { shotId: "shot-2", intent: "推进到出发", confidence: 0.9 },
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
          },
        },
        {
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
      }],
    });
  });

  it("候选集外引用和重复引用会产生可解释错误，不猜测时间", () => {
    const source = {
      shot: shot({}),
      videoId: "video-1",
      sourcePath: "/videos/video-1.mp4",
    };
    const plan = compileEditPlan([
      { shotId: "missing", intent: "不存在", confidence: 0.8 },
      { shotId: "shot-1", intent: "有效", confidence: 0.9 },
      { shotId: "shot-1", intent: "重复", confidence: 0.9 },
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
      "UNKNOWN_SELECTION_SHOT",
      "DUPLICATE_SELECTION_SHOT",
    ]);
  });
});

describe("EditPlan 硬校验", () => {
  it("拒绝超出 Shot、轨道重叠和不一致的实际时长", () => {
    const plan = compileEditPlan([
      { shotId: "shot-1", intent: "片段 1", confidence: 0.9 },
      { shotId: "shot-2", intent: "片段 2", confidence: 0.9 },
    ], [
      {
        shot: shot({}),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      },
      {
        shot: shot({ id: "shot-2", shotIndex: 2, startSec: 5, endSec: 8 }),
        videoId: "video-1",
        sourcePath: "/videos/video-1.mp4",
      },
    ], {
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
    const plan = compileEditPlan([
      { shotId: "shot-1", intent: "保留动作", confidence: 0.9 },
    ], [{
      shot: shot({}),
      videoId: "video-1",
      sourcePath: "/videos/video-1.mp4",
    }], {
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
