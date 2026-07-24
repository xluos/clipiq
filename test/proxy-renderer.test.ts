import { describe, expect, it } from "vitest";
import type { EditPlan, VideoClip } from "../src/types";
import {
  buildProxyAssemblyArgs,
  buildAudioMixArgs,
  buildProxySegmentArgs,
  collectProxyCaptions,
  collectProxyWarnings,
  proxyVideoSpecForCanvas,
  serializeAss,
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

  it("卡点轻微变速同时作用于画面和原声", () => {
    const spec = proxyVideoSpecForCanvas({ width: 1080, height: 1920, fps: 30 });
    const args = buildProxySegmentArgs(
      clip({ speed: 2_900_000 / 3_000_000 }),
      "/cache/beat-aligned.mp4",
      spec,
      true,
    );
    const filters = args[args.indexOf("-filter_complex") + 1];
    expect(filters).toContain("setpts=(PTS-STARTPTS)/0.966667");
    expect(filters).toContain("atempo=0.966667");
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

  it("ASS 烧录字幕只给已标注关键词着色，外挂 SRT 保持纯文本", () => {
    const cues = [{
      id: "caption-highlight",
      startUs: 500_000,
      endUs: 1_500_000,
      text: "整理装备",
      styleId: "proxy-default",
      highlights: [{
        text: "装备",
        startOffset: 2,
        endOffset: 4,
        startUs: 900_000,
        endUs: 1_400_000,
        reason: "event_keyword" as const,
        confidence: 0.9,
      }],
    }];
    const ass = serializeAss(cues, { width: 720, height: 1280 });

    expect(ass).toContain(
      "Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,整理{\\c&H00E5464F&\\b1}装备{\\r}",
    );
    expect(serializeSrt(cues)).toContain("整理装备");
    expect(serializeSrt(cues)).not.toContain("\\c&");
  });

  it("旧计划有词级时间但没有 highlights 时按镜头事件补齐", () => {
    const currentPlan = plan();
    const video = currentPlan.tracks[0];
    if (video.kind !== "video") throw new Error("fixture");
    video.items[0].evidence = {
      eventSummary: "人物整理露营装备",
    };
    currentPlan.tracks.push({
      id: "caption-track",
      kind: "caption",
      items: [{
        id: "caption-old",
        startUs: 200_000,
        endUs: 1_200_000,
        text: "先整理装备",
        styleId: "proxy-default",
        sourceClipId: video.items[0].id,
        wordTimings: [
          { text: "先", startUs: 200_000, endUs: 400_000 },
          { text: "整理装备", startUs: 400_000, endUs: 1_200_000 },
        ],
      }],
    });

    expect(collectProxyCaptions(currentPlan)[0].highlights).toEqual([
      expect.objectContaining({
        text: "整理装备",
        startOffset: 1,
        endOffset: 5,
        startUs: 400_000,
        endUs: 1_200_000,
      }),
    ]);
  });
});

describe("代理旁白降级", () => {
  it("文本旁白未合成时保留明确 warning，不阻断无旁白预览", () => {
    const currentPlan = plan();
    currentPlan.tracks.push({
      id: "audio-track",
      kind: "audio",
      items: [{
        id: "voiceover-1",
        kind: "voiceover",
        ttsText: "先把装备整理好",
        anchorClipId: "clip-1",
        timelineInUs: 0,
        sourceInUs: 0,
        sourceOutUs: 2_000_000,
        volume: 1,
      }],
    });

    expect(collectProxyWarnings(currentPlan)).toEqual([
      "有 1 段旁白尚未合成，代理预览已跳过。",
    ]);
  });
});

describe("多段 BGM 混音", () => {
  it("为每段音乐应用独立裁切、淡入淡出和时间线延迟", () => {
    const args = buildAudioMixArgs("/cache/base.mp4", [
      {
        id: "music-1",
        kind: "music",
        sourcePath: "/music/calm.wav",
        timelineInUs: 0,
        sourceInUs: 1_000_000,
        sourceOutUs: 5_000_000,
        volume: 0.18,
        fadeInUs: 400_000,
        fadeOutUs: 400_000,
      },
      {
        id: "music-2",
        kind: "music",
        sourcePath: "/music/upbeat.wav",
        timelineInUs: 4_000_000,
        sourceInUs: 0,
        sourceOutUs: 4_000_000,
        volume: 0.2,
        fadeInUs: 400_000,
        fadeOutUs: 400_000,
      },
    ], "/cache/mixed.mp4");
    const filters = args[args.indexOf("-filter_complex") + 1];

    expect(args).toEqual(expect.arrayContaining([
      "-i", "/music/calm.wav",
      "-i", "/music/upbeat.wav",
    ]));
    expect(filters).toContain(
      "[1:a]atrim=start=1.000000:duration=4.000000,asetpts=PTS-STARTPTS,volume=0.180000,afade=t=in:st=0:d=0.400000,afade=t=out:st=3.600000:d=0.400000,adelay=0|0[extra0]",
    );
    expect(filters).toContain("adelay=4000|4000[extra1]");
    expect(filters).toContain(
      "[basea][extra0][extra1]amix=inputs=3:duration=first:dropout_transition=0[mix]",
    );
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
