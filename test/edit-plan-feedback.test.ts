import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { EditPlan, Shot } from "../src/types";
import { compileEditPlan } from "../electron/editing/edit-plan-compiler";
import { applyEditPlanFeedback } from "../electron/editing/edit-plan-feedback";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";
import {
  createEditFeedbackRepository,
  migrateEditFeedbackSchema,
} from "../electron/repositories/edit-feedback-repository";

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];

function createDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function shot(id: string, startSec: number, endSec: number, text: string): Shot {
  return {
    id,
    videoId: "video-1",
    assetProjectId: "video-1",
    shotIndex: Number(id.replace(/\D/g, "")) || 1,
    startSec,
    endSec,
    description: `${id} 事件`,
    subtitleSegments: [{
      startSec: startSec + 0.2,
      endSec: Math.min(endSec, startSec + 1.2),
      text,
    }],
  };
}

function sourcePlan(): EditPlan {
  const shots = [
    shot("shot-1", 0, 3, "第一句"),
    shot("shot-2", 4, 7, "第二句"),
    shot("shot-3", 8, 11, "第三句"),
  ];
  return compileEditPlan(
    shots.map((item) => ({
      shotId: item.id,
      intent: item.description || item.id,
      confidence: 1,
    })),
    shots.map((item) => ({
      shot: item,
      videoId: "video-1",
      sourcePath: "/videos/video-1.mp4",
    })),
    {
      planId: "plan-1",
      sessionId: "session-1",
      targetDurationUs: 9_000_000,
      canvas: { width: 1080, height: 1920, fps: 30 },
      goal: "测试 Vlog",
      generatedAt: 1,
      sourceExists: () => true,
    },
  );
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("EditPlan 结构化反馈", () => {
  it("拒绝非法 revision 和空父版本 ID", () => {
    const invalid = sourcePlan();
    invalid.revision = 0;
    invalid.parentPlanId = " ";
    const result = validateEditPlan(invalid, { sourceExists: () => true });
    expect(result.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "INVALID_REVISION",
      "INVALID_PARENT_PLAN_ID",
    ]));
  });

  it("删除与重排产生新版本，不修改来源版本，并同步字幕时间", () => {
    const original = sourcePlan();
    const firstTrack = original.tracks[0];
    if (firstTrack.kind !== "video") throw new Error("fixture");
    const removedId = firstTrack.items[1].id;

    const deleted = applyEditPlanFeedback(original, {
      type: "delete_clip",
      clipId: removedId,
    }, {
      newPlanId: "plan-2",
      now: 2,
      sourceExists: () => true,
    });
    const deletedVideo = deleted.tracks.find((track) => track.kind === "video");
    const deletedCaptions = deleted.tracks.find((track) => track.kind === "caption");
    expect(original.tracks[0].items).toHaveLength(3);
    expect(deleted.parentPlanId).toBe("plan-1");
    expect(deleted.revision).toBe(2);
    expect(deletedVideo?.items).toHaveLength(2);
    expect(deletedCaptions?.items.map((cue) => cue.text)).toEqual(["第一句", "第三句"]);
    expect(deleted.actualDurationUs).toBe(6_000_000);

    if (deletedVideo?.kind !== "video") throw new Error("fixture");
    const moved = applyEditPlanFeedback(deleted, {
      type: "move_clip",
      clipId: deletedVideo.items[1].id,
      toIndex: 0,
    }, {
      newPlanId: "plan-3",
      now: 3,
      sourceExists: () => true,
    });
    const movedVideo = moved.tracks.find((track) => track.kind === "video");
    const movedCaptions = moved.tracks.find((track) => track.kind === "caption");
    expect(movedVideo?.items[0].shotId).toBe("shot-3");
    expect(movedCaptions?.items[0].text).toBe("第三句");
    expect(moved.validation.valid).toBe(true);
  });

  it("缩短、字幕修改与叠化保持微秒时间线有效", () => {
    const original = sourcePlan();
    const video = original.tracks[0];
    const captions = original.tracks.find((track) => track.kind === "caption");
    if (video.kind !== "video" || captions?.kind !== "caption") throw new Error("fixture");

    const trimmed = applyEditPlanFeedback(original, {
      type: "trim_clip",
      clipId: video.items[0].id,
      sourceInUs: 0,
      sourceOutUs: 2_000_000,
    }, {
      newPlanId: "plan-trim",
      now: 2,
      sourceExists: () => true,
    });
    expect(trimmed.actualDurationUs).toBe(8_000_000);

    const editedCaption = applyEditPlanFeedback(trimmed, {
      type: "update_caption",
      cueId: captions.items[0].id,
      text: "人工修改后的字幕",
    }, {
      newPlanId: "plan-caption",
      now: 3,
      sourceExists: () => true,
    });
    const editedCues = editedCaption.tracks.find((track) => track.kind === "caption");
    expect(editedCues?.items[0].text).toBe("人工修改后的字幕");

    const editedVideo = editedCaption.tracks.find((track) => track.kind === "video");
    if (editedVideo?.kind !== "video") throw new Error("fixture");
    const dissolved = applyEditPlanFeedback(editedCaption, {
      type: "set_transition",
      fromClipId: editedVideo.items[0].id,
      toClipId: editedVideo.items[1].id,
      transitionType: "dissolve",
      durationUs: 500_000,
    }, {
      newPlanId: "plan-dissolve",
      now: 4,
      sourceExists: () => true,
    });
    const dissolvedVideo = dissolved.tracks.find((track) => track.kind === "video");
    expect(dissolvedVideo?.items[1].timelineInUs).toBe(1_500_000);
    expect(dissolved.actualDurationUs).toBe(7_500_000);
    expect(dissolved.validation.valid).toBe(true);
  });

  it("替换操作只接受已解析的真实 Shot，并重新绑定字幕", () => {
    const original = sourcePlan();
    const video = original.tracks[0];
    if (video.kind !== "video") throw new Error("fixture");
    const oldClip = video.items[1];
    const replacement = {
      ...structuredClone(oldClip),
      id: "replacement-clip",
      shotId: "shot-99",
      videoId: "video-2",
      sourcePath: "/videos/video-2.mp4",
      sourceInUs: 20_000_000,
      sourceOutUs: 22_000_000,
      evidence: {
        eventSummary: "替换事件",
        subtitleSegments: [{
          startUs: 20_200_000,
          endUs: 21_200_000,
          text: "替换字幕",
        }],
      },
    };
    const replaced = applyEditPlanFeedback(original, {
      type: "replace_clip",
      clipId: oldClip.id,
      replacementShotId: "shot-99",
    }, {
      newPlanId: "plan-replaced",
      now: 2,
      replacementClip: replacement,
      sourceExists: () => true,
    });
    const replacedVideo = replaced.tracks.find((track) => track.kind === "video");
    const replacedCaptions = replaced.tracks.find((track) => track.kind === "caption");
    expect(replacedVideo?.items[1]).toMatchObject({
      id: "replacement-clip",
      shotId: "shot-99",
      sourcePath: "/videos/video-2.mp4",
    });
    expect(replacedCaptions?.items.map((cue) => cue.text)).toContain("替换字幕");
    expect(replacedCaptions?.items.map((cue) => cue.text)).not.toContain("第二句");
  });
});

describe("Edit feedback repository", () => {
  it("迁移幂等，并按 session/plan 保存可统计事件", () => {
    const db = createDatabase();
    migrateEditFeedbackSchema(db);
    migrateEditFeedbackSchema(db);
    const repository = createEditFeedbackRepository(db);
    repository.record({
      id: "feedback-1",
      sessionId: "session-1",
      planId: "plan-1",
      resultingPlanId: "plan-2",
      action: { type: "delete_clip", clipId: "clip-1" },
      beforeRevision: 1,
      afterRevision: 2,
      createdAt: 100,
    });

    expect(repository.listForSession("session-1")).toEqual([
      expect.objectContaining({
        id: "feedback-1",
        action: { type: "delete_clip", clipId: "clip-1" },
      }),
    ]);
    expect(repository.listForPlan("plan-2")).toHaveLength(1);
  });
});
