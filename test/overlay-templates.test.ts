import { describe, expect, it } from "vitest";
import type { EditPlan, VideoClip } from "../src/types";
import { applyEditPlanFeedback } from "../electron/editing/edit-plan-feedback";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";
import {
  createTemplateOverlay,
  listOverlayTemplates,
  OVERLAY_TEMPLATE_KEYS,
  overlayTemplateManifest,
} from "../electron/editing/overlay-templates";
import {
  collectProxyOverlays,
  collectProxyWarnings,
  serializeAss,
} from "../electron/editing/proxy-renderer";

function clip(id: string, timelineInUs: number): VideoClip {
  return {
    id,
    candidateId: `${id}::0-3000000`,
    shotId: id.replace("clip", "shot"),
    videoId: "video-1",
    sourcePath: "/videos/source.mp4",
    sourceInUs: 0,
    sourceOutUs: 3_000_000,
    timelineInUs,
    speed: 1,
    volume: 1,
    selectionReason: id,
    confidence: 1,
  };
}

function plan(): EditPlan {
  return {
    id: "plan-overlay",
    version: 1,
    revision: 1,
    sessionId: "session-overlay",
    status: "validated",
    canvas: { width: 1080, height: 1920, fps: 30 },
    targetDurationUs: 6_000_000,
    actualDurationUs: 6_000_000,
    tracks: [{
      id: "video-track",
      kind: "video",
      items: [clip("clip-1", 0), clip("clip-2", 3_000_000)],
    }],
    transitions: [{
      id: "transition-1",
      fromClipId: "clip-1",
      toClipId: "clip-2",
      type: "cut",
      durationUs: 0,
    }],
    provenance: {
      goal: "模板测试",
      genre: "vlog",
      methodologyIds: [],
      generatedAt: 1,
    },
    validation: { valid: true, warnings: [], errors: [] },
  };
}

describe("贴纸与花字模板", () => {
  it("只暴露版本化中立模板，不包含剪映资源 ID", () => {
    const templates = listOverlayTemplates();

    expect(templates).toHaveLength(3);
    expect(templates.map((template) => template.key)).toEqual([
      OVERLAY_TEMPLATE_KEYS.punch,
      OVERLAY_TEMPLATE_KEYS.note,
      OVERLAY_TEMPLATE_KEYS.spark,
    ]);
    expect(JSON.stringify(overlayTemplateManifest(templates.map((item) => item.key))))
      .not.toMatch(/jianying|capcut|material_id/i);
  });

  it("花字必须有文本并受字符上限约束", () => {
    const anchor = clip("clip-1", 0);

    expect(() => createTemplateOverlay({
      id: "overlay-empty",
      templateKey: OVERLAY_TEMPLATE_KEYS.punch,
      anchorClip: anchor,
    })).toThrow("需要填写文本");
    expect(() => createTemplateOverlay({
      id: "overlay-long",
      templateKey: OVERLAY_TEMPLATE_KEYS.punch,
      anchorClip: anchor,
      text: "一".repeat(19),
    })).toThrow("最多 18 个字符");
  });

  it("结构化反馈生成 revision，并让模板跟随镜头重排和删除", () => {
    const original = plan();
    const added = applyEditPlanFeedback(original, {
      type: "set_overlay_template",
      anchorClipId: "clip-2",
      templateKey: OVERLAY_TEMPLATE_KEYS.punch,
      text: "抵达营地",
    }, {
      newPlanId: "plan-overlay-added",
      now: 2,
      sourceExists: () => true,
    });
    const addedTrack = added.tracks.find((track) => track.kind === "overlay");
    expect(addedTrack?.items[0]).toMatchObject({
      kind: "text",
      text: "抵达营地",
      anchorClipId: "clip-2",
      startUs: 3_000_000,
      endUs: 4_800_000,
    });
    expect(original.tracks.some((track) => track.kind === "overlay")).toBe(false);
    expect(added.validation.valid).toBe(true);

    const moved = applyEditPlanFeedback(added, {
      type: "move_clip",
      clipId: "clip-2",
      toIndex: 0,
    }, {
      newPlanId: "plan-overlay-moved",
      now: 3,
      sourceExists: () => true,
    });
    const movedTrack = moved.tracks.find((track) => track.kind === "overlay");
    expect(movedTrack?.items[0]).toMatchObject({
      anchorClipId: "clip-2",
      startUs: 0,
      endUs: 1_800_000,
    });

    const removedByClip = applyEditPlanFeedback(added, {
      type: "delete_clip",
      clipId: "clip-2",
    }, {
      newPlanId: "plan-overlay-anchor-deleted",
      now: 4,
      sourceExists: () => true,
    });
    expect(removedByClip.tracks.some((track) => track.kind === "overlay")).toBe(false);
  });

  it("ASS 同时保留基础字幕、花字和矢量贴纸时间", () => {
    const anchor = clip("clip-1", 0);
    const flower = createTemplateOverlay({
      id: "overlay-flower",
      templateKey: OVERLAY_TEMPLATE_KEYS.punch,
      anchorClip: anchor,
      text: "开始出发",
    });
    const sticker = createTemplateOverlay({
      id: "overlay-sticker",
      templateKey: OVERLAY_TEMPLATE_KEYS.spark,
      anchorClip: anchor,
    });
    const current = plan();
    current.tracks.push({
      id: "overlay-track",
      kind: "overlay",
      items: [flower, sticker],
    });

    const overlays = collectProxyOverlays(current);
    const ass = serializeAss([{
      id: "caption-1",
      startUs: 0,
      endUs: 1_000_000,
      text: "字幕",
      styleId: "proxy-default",
    }], { width: 720, height: 1280 }, overlays);

    expect(overlays).toHaveLength(2);
    expect(ass).toContain("开始出发");
    expect(ass).toContain("\\p1");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:01.80");
    expect(collectProxyWarnings(current)).toEqual([]);
  });

  it("未知 resourceKey 明确降级，不阻断旧计划", () => {
    const current = plan();
    current.tracks.push({
      id: "overlay-track",
      kind: "overlay",
      items: [{
        id: "legacy-template",
        kind: "sticker",
        resourceKey: "legacy.template",
        startUs: 0,
        endUs: 1_000_000,
        transform: {
          x: 0.5,
          y: 0.5,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
        },
        animation: { in: "bounce" },
      }],
    });

    const validation = validateEditPlan(current, { sourceExists: () => true });
    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((warning) => warning.code))
      .toEqual(expect.arrayContaining([
        "OVERLAY_TEMPLATE_UNAVAILABLE",
        "UNSUPPORTED_OVERLAY_ANIMATION",
      ]));
    expect(collectProxyWarnings(current)).toEqual([
      "有 1 个自定义贴图或未知模板无法烧录，代理预览已跳过。",
    ]);
  });
});
