import { describe, expect, it } from "vitest";
import {
  buildSaySynthesisArgs,
  buildVoiceoverProbeArgs,
  parseSystemVoices,
  parseVoiceoverDurationUs,
  selectChineseSystemVoice,
  synthesizeSystemVoiceover,
  voiceoverTextDigest,
} from "../electron/editing/voiceover-runtime";

describe("macOS 旁白合成运行时", () => {
  it("解析系统音色并优先选择普通话 Tingting", () => {
    const voices = parseSystemVoices([
      "Alex                en_US    # Hello",
      "Eddy (中文（中国大陆）)     zh_CN    # 你好",
      "Tingting            zh_CN    # 你好，我叫婷婷。",
    ].join("\n"));

    expect(voices).toEqual([
      { name: "Alex", locale: "en_US" },
      { name: "Eddy (中文（中国大陆）)", locale: "zh_CN" },
      { name: "Tingting", locale: "zh_CN" },
    ]);
    expect(selectChineseSystemVoice(voices)).toBe("Tingting");
  });

  it("命令参数不经过 shell，并固定输出 48kHz PCM WAV", () => {
    expect(buildSaySynthesisArgs({
      text: "今天去山谷露营",
      outputPath: "/缓存/旁白 01.wav",
      voice: "Tingting",
      rateWpm: 190,
    })).toEqual([
      "-v", "Tingting",
      "-r", "190",
      "-o", "/缓存/旁白 01.wav",
      "--file-format=WAVE",
      "--data-format=LEI16@48000",
      "今天去山谷露营",
    ]);
    expect(buildVoiceoverProbeArgs("/缓存/旁白 01.wav")).toEqual([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "json",
      "/缓存/旁白 01.wav",
    ]);
  });

  it("解析 ffprobe 微秒时长，并让文本、音色或语速变化失效缓存", () => {
    expect(parseVoiceoverDurationUs('{"format":{"duration":"1.234567"}}'))
      .toBe(1_234_567);
    expect(() => parseVoiceoverDurationUs("{}"))
      .toThrow("旁白音频没有有效时长");

    const digest = voiceoverTextDigest("出发", "Tingting", 190);
    expect(voiceoverTextDigest("出发", "Tingting", 190)).toBe(digest);
    expect(voiceoverTextDigest("返程", "Tingting", 190)).not.toBe(digest);
    expect(voiceoverTextDigest("出发", "Tingting", 210)).not.toBe(digest);
  });

  it("在启动外部进程前拒绝空文本和无效可用时长", async () => {
    await expect(synthesizeSystemVoiceover({
      sayPath: "/missing/say",
      ffprobePath: "/missing/ffprobe",
      text: " ",
      outputPath: "/tmp/voiceover.wav",
      maximumDurationUs: 1_000_000,
    })).rejects.toThrow("旁白文本不能为空");
    await expect(synthesizeSystemVoiceover({
      sayPath: "/missing/say",
      ffprobePath: "/missing/ffprobe",
      text: "有效文本",
      outputPath: "/tmp/voiceover.wav",
      maximumDurationUs: 100_000,
    })).rejects.toThrow("旁白可用时长不足 0.3 秒");
    await expect(synthesizeSystemVoiceover({
      sayPath: "/missing/say",
      ffprobePath: "/missing/ffprobe",
      text: "有效文本",
      voice: "Tingting",
      outputPath: ({ textDigest }) => `relative/${textDigest}.wav`,
      maximumDurationUs: 1_000_000,
    })).rejects.toThrow("旁白输出路径必须是绝对路径");
  });
});
