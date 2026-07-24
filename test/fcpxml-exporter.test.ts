import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EditPlan, VideoClip } from "../src/types";
import {
  fcpxmlTime,
  renderEditPlanFcpxml,
} from "../electron/editing/exporters/fcpxml-exporter";

function videoClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: "clip-1",
    shotId: "shot-1",
    videoId: "video-1",
    sourcePath: "media/001-周末 & 海边.mp4",
    sourceInUs: 1_000_000,
    sourceOutUs: 5_000_000,
    timelineInUs: 0,
    speed: 2,
    volume: 0.5,
    selectionReason: "测试",
    confidence: 1,
    ...overrides,
  };
}

function plan(clips: VideoClip[] = [videoClip()]): EditPlan {
  return {
    id: "plan-<海边>",
    version: 1,
    revision: 2,
    sessionId: "session-1",
    status: "rendered",
    canvas: { width: 1080, height: 1920, fps: 29.97 },
    targetDurationUs: 4_000_000,
    actualDurationUs: 4_000_000,
    tracks: [
      {
        id: "video-track",
        kind: "video",
        items: clips,
      },
      {
        id: "audio-track",
        kind: "audio",
        items: [{
          id: "music-1",
          kind: "music",
          sourcePath: "audio/002-背景 音乐.wav",
          timelineInUs: 0,
          sourceInUs: 0,
          sourceOutUs: 2_000_000,
          volume: 0.5,
          fadeInUs: 100_000,
        }],
      },
      {
        id: "caption-track",
        kind: "caption",
        items: [{
          id: "caption-1",
          startUs: 0,
          endUs: 500_000,
          text: "字幕",
          styleId: "default",
        }],
      },
      {
        id: "overlay-track",
        kind: "overlay",
        items: [{
          id: "overlay-1",
          kind: "text",
          startUs: 0,
          endUs: 500_000,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
          },
        }],
      },
    ],
    transitions: [],
    provenance: {
      goal: "测试",
      genre: "vlog",
      methodologyIds: [],
      generatedAt: 1,
    },
    validation: { valid: true, warnings: [], errors: [] },
  };
}

describe("FCPXML 导出", () => {
  it("用有理数秒生成可导入的媒体引用、裁切和变速时间", () => {
    const packagePath = path.join("/tmp", "ClipIQ 导出 & 测试");
    const result = renderEditPlanFcpxml(plan(), {
      packagePath,
      projectName: '周末 <海边> & "朋友"',
    });

    expect(result.xml).toContain('<fcpxml version="1.10">');
    expect(result.xml).toContain('frameDuration="100/2997s"');
    expect(result.xml).toContain('name="周末 &lt;海边&gt; &amp; &quot;朋友&quot;"');
    expect(result.xml).toContain(
      "ClipIQ%20%E5%AF%BC%E5%87%BA%20&amp;%20%E6%B5%8B%E8%AF%95/media/001-%E5%91%A8%E6%9C%AB%20&amp;%20%E6%B5%B7%E8%BE%B9.mp4",
    );
    expect(result.xml).toContain('start="1s" duration="2s"');
    expect(result.xml).toContain(
      '<timept time="3s" value="5s" interp="linear"/>',
    );
    expect(result.xml).toContain('lane="-1"');
    expect(result.xml).toContain('audioRole="music"');
    expect(result.xml).toContain('<adjust-volume amount="-6.02dB"/>');
    expect(result.durationUs).toBe(2_000_000);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "FCPXML_AUDIO_MIX_PARTIAL",
        "FCPXML_OVERLAY_NOT_INCLUDED",
        "FCPXML_CAPTIONS_AS_SRT",
      ]),
    );
  });

  it("把未验证的重叠转场线性化为硬切并明确告警", () => {
    const first = videoClip({
      speed: 1,
      sourceInUs: 0,
      sourceOutUs: 2_000_000,
    });
    const second = videoClip({
      id: "clip-2",
      shotId: "shot-2",
      videoId: "video-2",
      sourcePath: "media/002-second.mp4",
      sourceInUs: 0,
      sourceOutUs: 2_000_000,
      timelineInUs: 1_500_000,
      speed: 1,
      crop: { x: 20, y: 40, width: 800, height: 1_400 },
    });
    const editPlan = plan([first, second]);
    editPlan.transitions = [{
      id: "transition-1",
      fromClipId: first.id,
      toClipId: second.id,
      type: "dissolve",
      durationUs: 500_000,
    }];

    const result = renderEditPlanFcpxml(editPlan, {
      packagePath: "/tmp/export",
    });

    expect(result.durationUs).toBe(4_000_000);
    expect(result.xml).toContain('name="002-second.mp4" ref=');
    expect(result.xml).toContain('offset="2s" start="0s" duration="2s"');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "FCPXML_TRANSITION_DOWNGRADED",
        itemId: "transition-1",
      }),
      expect.objectContaining({
        code: "FCPXML_CROP_NOT_INCLUDED",
        itemId: "clip-2",
      }),
    ]));
  });

  it("把微秒稳定约分为 FCPXML 时间", () => {
    expect(fcpxmlTime(0)).toBe("0s");
    expect(fcpxmlTime(500_000)).toBe("1/2s");
    expect(fcpxmlTime(1_001_000)).toBe("1001/1000s");
  });
});
