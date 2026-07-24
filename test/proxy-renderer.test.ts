import { describe, expect, it } from "vitest";
import type { EditPlan, VideoClip } from "../src/types";
import {
  buildProxyAssemblyArgs,
  buildProxySegmentArgs,
  collectProxyCaptions,
  proxyVideoSpecForCanvas,
  serializeSrt,
} from "../electron/editing/proxy-renderer";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";

function clip(patch: Partial<VideoClip> = {}): VideoClip {
  return {
    id: "clip-1",
    shotId: "shot-1",
    videoId: "video-1",
    sourcePath: "/素材/周末 01.mp4",
    sourceInUs: 1_000_000,
    sourceOutUs: 5_000_000,
    timelineInUs: 0,
    speed: 1,
    volume: 0.8,
    selectionReason: "开场",
    confidence: 0.9,
    ...patch,
  };
}

function plan(patch: Partial<EditPlan> = {}): EditPlan {
  return {
    id: "plan-1",
    version: 1,
    sessionId: "session-1",
    status: "validated",
    canvas: { width: 1080, height: 1920, fps: 30 },
    targetDurationUs: 8_000_000,
    actualDurationUs: 8_000_000,
    tracks: [{
      id: "video-track",
      kind: "video",
      items: [
        clip({
          evidence: {
            subtitleSegments: [
              { startUs: 1_500_000, endUs: 2_500_000, text: "第一句" },
              { startUs: 4_500_000, endUs: 6_000_000, text: "越界会裁掉" },
            ],
          },
        }),
        clip({
          id: "clip-2",
          shotId: "shot-2",
          sourceInUs: 10_000_000,
          sourceOutUs: 14_000_000,
          timelineInUs: 4_000_000,
          evidence: {
            subtitleSegments: [
              { startUs: 10_200_000, endUs: 11_200_000, text: "第二句" },
            ],
          },
        }),
      ],
    }],
    transitions: [{
      id: "transition-1",
      fromClipId: "clip-1",
      toClipId: "clip-2",
      type: "cut",
      durationUs: 0,
    }],
    provenance: {
      goal: "周末 Vlog",
      genre: "vlog",
      methodologyIds: [],
      generatedAt: 1,
    },
    validation: { valid: true, warnings: [], errors: [] },
    ...patch,
  };
}

describe("FFmpeg 代理规格", () => {
  it("按画布方向生成 720p 固定偶数尺寸", () => {
    expect(proxyVideoSpecForCanvas({ width: 1080, height: 1920, fps: 29.97 })).toEqual(
      expect.objectContaining({ width: 720, height: 1280, fps: 30 }),
    );
    expect(proxyVideoSpecForCanvas({ width: 1920, height: 1080, fps: 60 })).toEqual(
      expect.objectContaining({ width: 1280, height: 720, fps: 60 }),
    );
    expect(proxyVideoSpecForCanvas({ width: 1000, height: 1000, fps: 120 })).toEqual(
      expect.objectContaining({ width: 720, height: 720, fps: 60 }),
    );
  });

  it("片段命令使用真实入出点、裁切、统一画布和恒定音轨", () => {
    const spec = proxyVideoSpecForCanvas({ width: 1080, height: 1920, fps: 30 });
    const args = buildProxySegmentArgs(
      clip({ crop: { x: 20, y: 30, width: 900, height: 1600 } }),
      "/cache/segment.mp4",
      spec,
      false,
    );
    expect(args).toEqual(expect.arrayContaining([
      "-ss", "1.000000",
      "-t", "4.000000",
      "-i", "/素材/周末 01.mp4",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-c:v", "libx264",
      "-c:a", "aac",
      "/cache/segment.mp4",
    ]));
    const filters = args[args.indexOf("-filter_complex") + 1];
    expect(filters).toContain("crop=900:1600:20:30");
    expect(filters).toContain("scale=720:1280");
    expect(filters).toContain("pad=720:1280");
    expect(filters).toContain("[1:a:0]");
  });
});

describe("代理字幕", () => {
  it("把素材绝对时间精确换算为时间线时间，并裁在片段边界内", () => {
    const cues = collectProxyCaptions(plan());
    expect(cues).toEqual([
      expect.objectContaining({
        startUs: 500_000,
        endUs: 1_500_000,
        text: "第一句",
      }),
      expect.objectContaining({
        startUs: 3_500_000,
        endUs: 4_000_000,
        text: "越界会裁掉",
      }),
      expect.objectContaining({
        startUs: 4_200_000,
        endUs: 5_200_000,
        text: "第二句",
      }),
    ]);
    expect(serializeSrt(cues)).toContain("00:00:00,500 --> 00:00:01,500");
    expect(serializeSrt(cues)).toContain("第二句");
  });
});

describe("代理时间线转场", () => {
  it("全硬切使用无重编码 concat 路径", () => {
    const currentPlan = plan();
    const clips = currentPlan.tracks[0];
    if (clips.kind !== "video") throw new Error("fixture");
    expect(buildProxyAssemblyArgs(
      ["/cache/a.mp4", "/cache/b.mp4"],
      clips.items,
      currentPlan.transitions,
      "/output.mp4",
      proxyVideoSpecForCanvas(currentPlan.canvas),
    )).toBeNull();
  });

  it("叠化生成 xfade 和 acrossfade，且不依赖 shell 转义", () => {
    const currentPlan = plan({
      transitions: [{
        id: "transition-1",
        fromClipId: "clip-1",
        toClipId: "clip-2",
        type: "dissolve",
        durationUs: 500_000,
      }],
    });
    const track = currentPlan.tracks[0];
    if (track.kind !== "video") throw new Error("fixture");
    track.items[1].timelineInUs = 3_500_000;
    track.items[0].evidence = undefined;
    track.items[1].evidence = undefined;
    currentPlan.actualDurationUs = 7_500_000;
    const args = buildProxyAssemblyArgs(
      ["/cache/a.mp4", "/cache/b.mp4"],
      track.items,
      currentPlan.transitions,
      "/output.mp4",
      proxyVideoSpecForCanvas(currentPlan.canvas),
    );
    expect(args).not.toBeNull();
    const filters = args?.[args.indexOf("-filter_complex") + 1] || "";
    expect(filters).toContain("xfade=transition=fade:duration=0.500000:offset=3.500000");
    expect(filters).toContain("acrossfade=d=0.500000");
    expect(validateEditPlan(currentPlan).valid).toBe(true);
  });

  it("拒绝没有对应转场的轨道空白和重叠", () => {
    const gapPlan = plan();
    const gapTrack = gapPlan.tracks[0];
    if (gapTrack.kind !== "video") throw new Error("fixture");
    gapTrack.items[1].timelineInUs = 4_500_000;
    gapPlan.actualDurationUs = 8_500_000;
    expect(validateEditPlan(gapPlan).errors.map((issue) => issue.code))
      .toContain("VIDEO_TRACK_GAP");

    const overlapPlan = plan();
    const overlapTrack = overlapPlan.tracks[0];
    if (overlapTrack.kind !== "video") throw new Error("fixture");
    overlapTrack.items[1].timelineInUs = 3_500_000;
    overlapPlan.actualDurationUs = 7_500_000;
    expect(validateEditPlan(overlapPlan).errors.map((issue) => issue.code))
      .toContain("VIDEO_TRACK_OVERLAP");
  });
});
