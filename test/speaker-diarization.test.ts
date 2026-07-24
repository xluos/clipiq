import { describe, expect, it, vi } from "vitest";
import type {
  SpeakerDiarizationProvider,
} from "../electron/identity/speaker-diarization-provider";
import {
  validateSpeakerDiarizationProviderForUse,
} from "../electron/identity/speaker-diarization-provider";
import {
  SHERPA_DIARIZATION_DESCRIPTOR,
  createSherpaDiarizationProvider,
} from "../electron/identity/sherpa-diarization-provider";
import {
  buildSpeakerTimeline,
} from "../electron/identity/speaker-timeline";
import {
  runSpeakerDiarization,
} from "../electron/identity/speaker-diarization-pipeline";

const rawSegments = [
  { startSec: 0, endSec: 1.9, speakerIndex: 3 },
  { startSec: 2.1, endSec: 4, speakerIndex: 8 },
  { startSec: 4.2, endSec: 5.8, speakerIndex: 3 },
];

const transcript = {
  schemaVersion: "v2",
  language: "zh",
  text: "你好出发再见",
  segments: [
    {
      start: 0.1,
      end: 1.8,
      text: "你好",
      words: [{ text: "你好", start: 0.2, end: 1.2, confidence: 0.9 }],
    },
    {
      start: 1.7,
      end: 4.1,
      text: "出发",
      words: [
        { text: "出", start: 2.2, end: 2.8 },
        { text: "发", start: 2.8, end: 3.5 },
      ],
    },
    {
      start: 4.3,
      end: 5.6,
      text: "再见",
    },
  ],
};

describe("说话人时间轴", () => {
  it("按首次出现顺序生成视频内稳定 speakerId，并保留精确时间", () => {
    const result = buildSpeakerTimeline({
      videoId: "video-1",
      segments: rawSegments,
      transcript,
    });

    expect(result.speakerCount).toBe(2);
    expect(result.speakerTracks).toEqual([
      expect.objectContaining({
        id: "video-1:speaker-track:1",
        speakerId: "video-1:speaker:1",
        startSec: 0,
        endSec: 1.9,
        confidence: 0.5,
      }),
      expect.objectContaining({
        id: "video-1:speaker-track:2",
        speakerId: "video-1:speaker:2",
        startSec: 2.1,
        endSec: 4,
      }),
      expect.objectContaining({
        id: "video-1:speaker-track:3",
        speakerId: "video-1:speaker:1",
        startSec: 4.2,
        endSec: 5.8,
      }),
    ]);
    expect(result.transcript?.segments).toEqual([
      expect.objectContaining({
        speakerId: "video-1:speaker:1",
        words: [expect.objectContaining({ speakerId: "video-1:speaker:1" })],
      }),
      expect.objectContaining({
        speakerId: "video-1:speaker:2",
        words: [
          expect.objectContaining({ speakerId: "video-1:speaker:2" }),
          expect.objectContaining({ speakerId: "video-1:speaker:2" }),
        ],
      }),
      expect.objectContaining({ speakerId: "video-1:speaker:1" }),
    ]);
  });

  it("多人重叠且没有明显主导时不臆测整段说话人", () => {
    const result = buildSpeakerTimeline({
      videoId: "video-1",
      segments: [
        { startSec: 0, endSec: 2, speakerIndex: 0 },
        { startSec: 0, endSec: 2, speakerIndex: 1 },
      ],
      transcript: {
        segments: [{ start: 0, end: 2, text: "同时说话" }],
      },
    });
    expect(result.transcript?.segments[0].speakerId).toBeUndefined();
  });
});

describe("说话人识别管线", () => {
  it("完整成功后才原子替换说话人证据", async () => {
    const replaceEvidenceForVideo = vi.fn();
    const provider: SpeakerDiarizationProvider = {
      descriptor: SHERPA_DIARIZATION_DESCRIPTOR,
      getReadiness: async () => ({ ready: true }),
      diarize: async () => rawSegments,
    };

    const result = await runSpeakerDiarization({
      videoId: "video-1",
      wavPath: "/tmp/audio.wav",
      transcript,
      provider,
      repository: { replaceEvidenceForVideo },
      usePolicy: { environment: "production" },
    });

    expect(result).toMatchObject({
      status: "completed",
      speakerCount: 2,
      trackCount: 3,
    });
    expect(replaceEvidenceForVideo).toHaveBeenCalledWith("video-1", {
      speakerTracks: expect.arrayContaining([
        expect.objectContaining({ speakerId: "video-1:speaker:1" }),
      ]),
    });
  });

  it("模型未就绪时保留已有证据", async () => {
    const replaceEvidenceForVideo = vi.fn();
    const provider: SpeakerDiarizationProvider = {
      descriptor: SHERPA_DIARIZATION_DESCRIPTOR,
      getReadiness: async () => ({ ready: false, reason: "缺少模型" }),
      diarize: vi.fn(),
    };
    const result = await runSpeakerDiarization({
      videoId: "video-1",
      wavPath: "/tmp/audio.wav",
      provider,
      repository: { replaceEvidenceForVideo },
      usePolicy: { environment: "production" },
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "缺少模型" });
    expect(replaceEvidenceForVideo).not.toHaveBeenCalled();
  });

  it("生产门禁验证运行时与两类模型许可", () => {
    expect(validateSpeakerDiarizationProviderForUse(
      SHERPA_DIARIZATION_DESCRIPTOR,
      { environment: "production" },
    )).toEqual([]);
  });

  it("开始前已取消时不创建 Worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createSherpaDiarizationProvider({
      segmentationModelPath: "/missing/segmentation.onnx",
      embeddingModelPath: "/missing/embedding.onnx",
    });
    await expect(provider.diarize("/missing/audio.wav", {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
