import { describe, expect, it } from "vitest";
import {
  buildAudioBeatDecodeArgs,
  decodeFloat32Le,
} from "../electron/editing/audio-beat-runtime";

describe("真实音频节拍运行时", () => {
  it("FFmpeg 参数固定输出 16 kHz 单声道 f32le，并限制分析时长", () => {
    expect(buildAudioBeatDecodeArgs(
      "/素材/背景 音乐.wav",
      12_345_678,
    )).toEqual([
      "-nostdin",
      "-v", "error",
      "-i", "/素材/背景 音乐.wav",
      "-vn",
      "-t", "12.345678",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_f32le",
      "-f", "f32le",
      "pipe:1",
    ]);
  });

  it("解码 f32le 并忽略末尾不完整样本", () => {
    const buffer = Buffer.alloc(14);
    buffer.writeFloatLE(0.25, 0);
    buffer.writeFloatLE(-0.5, 4);
    buffer.writeFloatLE(1, 8);
    buffer.writeUInt16LE(123, 12);

    expect([...decodeFloat32Le(buffer)]).toEqual([0.25, -0.5, 1]);
  });

  it("拒绝空路径和无效时长", () => {
    expect(() => buildAudioBeatDecodeArgs("", 1_000_000))
      .toThrow("节拍分析缺少音频路径");
    expect(() => buildAudioBeatDecodeArgs("/music.wav", 0))
      .toThrow("节拍分析时长无效");
  });
});
