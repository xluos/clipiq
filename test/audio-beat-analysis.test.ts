import { describe, expect, it } from "vitest";
import type { AudioClip, EditPlan, VideoClip } from "../src/types";
import {
  detectAudioBeats,
  suggestBeatAlignedCuts,
} from "../electron/editing/audio-beat-analysis";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";

function clickTrack(
  durationSec: number,
  bpm: number,
  sampleRate = 16_000,
): Float32Array {
  const pcm = new Float32Array(durationSec * sampleRate);
  const periodSamples = Math.round(sampleRate * 60 / bpm);
  const burstSamples = Math.round(sampleRate * 0.025);
  for (let start = 0; start < pcm.length; start += periodSamples) {
    for (let offset = 0; offset < burstSamples && start + offset < pcm.length; offset += 1) {
      const fade = 1 - offset / burstSamples;
      pcm[start + offset] = Math.sin(2 * Math.PI * 440 * offset / sampleRate) * fade;
    }
  }
  return pcm;
}

function videoClip(id: string, timelineInUs: number): VideoClip {
  return {
    id,
    shotId: `shot-${id}`,
    videoId: "video-1",
    sourcePath: "/videos/source.mp4",
    sourceInUs: 0,
    sourceOutUs: 2_000_000,
    timelineInUs,
    speed: 1,
    volume: 1,
    selectionReason: "fixture",
    confidence: 1,
  };
}

function plan(): EditPlan {
  return {
    id: "plan-1",
    version: 1,
    sessionId: "session-1",
    status: "validated",
    canvas: { width: 1080, height: 1920, fps: 30 },
    targetDurationUs: 6_000_000,
    actualDurationUs: 6_000_000,
    tracks: [{
      id: "video-track",
      kind: "video",
      items: [
        videoClip("1", 0),
        videoClip("2", 2_040_000),
        videoClip("3", 4_000_000),
      ],
    }],
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

describe("音频节拍分析", () => {
  it("从固定点击音中恢复可追溯的 120 BPM 节拍网格", () => {
    const result = detectAudioBeats(clickTrack(8, 120), 16_000);

    expect(result.status).toBe("usable");
    expect(result.bpm).toBeCloseTo(120, -1);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.beatTimesUs.length).toBeGreaterThanOrEqual(14);
    expect(result.beatTimesUs.slice(1, 5).map(
      (time, index) => time - result.beatTimesUs[index],
    )).toEqual(expect.arrayContaining([
      expect.closeTo(500_000, -4),
    ]));
  });

  it("静音、过短音频和弱周期不会伪装为可用节拍", () => {
    expect(detectAudioBeats(new Float32Array(16_000 * 2), 16_000).status)
      .toBe("insufficient_audio");
    expect(detectAudioBeats(new Float32Array(16_000 * 5), 16_000).status)
      .toBe("insufficient_audio");
  });

  it("只为容差内的现有切点提供建议，不直接修改 EditPlan", () => {
    const currentPlan = plan();
    const analysis = detectAudioBeats(clickTrack(8, 120), 16_000);
    const music: AudioClip = {
      id: "music-1",
      kind: "music",
      sourcePath: "/music/test.wav",
      timelineInUs: 0,
      sourceInUs: 0,
      sourceOutUs: 6_000_000,
      volume: 0.2,
      beatAnalysis: analysis,
    };
    const before = structuredClone(currentPlan);
    const suggestions = suggestBeatAlignedCuts(currentPlan, music, {
      maximumOffsetUs: 100_000,
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        fromClipId: "1",
        toClipId: "2",
        boundaryTimeUs: 2_040_000,
      }),
      expect.objectContaining({
        fromClipId: "2",
        toClipId: "3",
        boundaryTimeUs: 4_000_000,
      }),
    ]);
    expect(suggestions.every((suggestion) =>
      Math.abs(suggestion.offsetUs) <= 100_000)).toBe(true);
    expect(suggestions[0].beatTimeUs).toBeCloseTo(2_000_000, -5);
    expect(suggestions[1].beatTimeUs).toBeCloseTo(4_000_000, -5);
    expect(currentPlan).toEqual(before);

    currentPlan.transitions = [{
      id: "dissolve",
      fromClipId: "1",
      toClipId: "2",
      type: "dissolve",
      durationUs: 200_000,
    }];
    expect(suggestBeatAlignedCuts(currentPlan, music, {
      maximumOffsetUs: 100_000,
    }).map((suggestion) => suggestion.toClipId)).toEqual(["3"]);
  });

  it("低置信度分析不会产生卡点建议", () => {
    const music: AudioClip = {
      id: "music-1",
      kind: "music",
      timelineInUs: 0,
      sourceInUs: 0,
      sourceOutUs: 6_000_000,
      volume: 0.2,
      beatAnalysis: {
        algorithmVersion: "energy-onset-v1",
        status: "low_confidence",
        sampleRate: 16_000,
        analyzedStartUs: 0,
        analyzedEndUs: 6_000_000,
        bpm: 120,
        confidence: 0.2,
        beatTimesUs: [0, 500_000],
      },
    };

    expect(suggestBeatAlignedCuts(plan(), music)).toEqual([]);
  });

  it("EditPlan 校验拒绝越界或乱序的节拍证据", () => {
    const currentPlan = plan();
    const video = currentPlan.tracks[0];
    if (video.kind !== "video") throw new Error("fixture");
    video.items[1].timelineInUs = 2_000_000;
    video.items[2].timelineInUs = 4_000_000;
    currentPlan.tracks.push({
      id: "audio-track",
      kind: "audio",
      items: [{
        id: "music-1",
        kind: "music",
        sourcePath: "/music/test.wav",
        timelineInUs: 0,
        sourceInUs: 0,
        sourceOutUs: 6_000_000,
        volume: 0.2,
        beatAnalysis: {
          algorithmVersion: "energy-onset-v1",
          status: "usable",
          sampleRate: 16_000,
          analyzedStartUs: 0,
          analyzedEndUs: 6_000_000,
          bpm: 120,
          confidence: 0.9,
          beatTimesUs: [500_000, 400_000, 6_500_000],
        },
      }],
    });

    const result = validateEditPlan(currentPlan);
    expect(result.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "UNSORTED_BEAT_TIMES",
      "BEAT_OUTSIDE_ANALYSIS",
    ]));
  });

  it("EditPlan 校验拒绝过期、跨镜头和非硬切的卡点建议", () => {
    const currentPlan = plan();
    const video = currentPlan.tracks[0];
    if (video.kind !== "video") throw new Error("fixture");
    video.items[1].timelineInUs = 2_000_000;
    video.items[2].timelineInUs = 4_000_000;
    currentPlan.transitions = [{
      id: "dissolve",
      fromClipId: "2",
      toClipId: "3",
      type: "dissolve",
      durationUs: 200_000,
    }];
    currentPlan.tracks.push({
      id: "audio-track",
      kind: "audio",
      items: [{
        id: "music-1",
        kind: "music",
        sourcePath: "/music/test.wav",
        timelineInUs: 0,
        sourceInUs: 0,
        sourceOutUs: 6_000_000,
        volume: 0.2,
        beatAnalysis: {
          algorithmVersion: "energy-onset-v1",
          status: "usable",
          sampleRate: 16_000,
          analyzedStartUs: 0,
          analyzedEndUs: 6_000_000,
          bpm: 120,
          confidence: 0.9,
          beatTimesUs: [0, 2_000_000, 4_000_000, 6_000_000],
        },
        beatSyncSuggestions: [
          {
            fromClipId: "1",
            toClipId: "2",
            boundaryTimeUs: 1_900_000,
            beatTimeUs: 2_000_000,
            offsetUs: 100_000,
            confidence: 0.9,
          },
          {
            fromClipId: "1",
            toClipId: "3",
            boundaryTimeUs: 4_000_000,
            beatTimeUs: 4_000_000,
            offsetUs: 0,
            confidence: 0.9,
          },
          {
            fromClipId: "2",
            toClipId: "3",
            boundaryTimeUs: 4_000_000,
            beatTimeUs: 4_000_000,
            offsetUs: 0,
            confidence: 0.9,
          },
        ],
      }],
    });

    const result = validateEditPlan(currentPlan);
    expect(result.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "BEAT_SUGGESTION_BOUNDARY_STALE",
      "BEAT_SUGGESTION_CLIPS_INVALID",
      "BEAT_SUGGESTION_TRANSITION_INVALID",
    ]));
  });
});
