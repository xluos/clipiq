import { describe, expect, it } from "vitest";
import {
  buildAlignedEvidenceSegments,
  clipVideoEvidenceToRange,
} from "../electron/editing/aligned-evidence";

describe("素材时间片证据", () => {
  const evidence = {
    eventSummary: "小林在营地整理装备",
    transcriptGranularity: "word" as const,
    subtitleSegments: [{
      startUs: 300_000,
      endUs: 1_800_000,
      text: "先把装备整理好",
      speakerId: "speaker-1",
      words: [
        { text: "先把", startUs: 300_000, endUs: 800_000, speakerId: "speaker-1" },
        { text: "装备整理好", startUs: 800_000, endUs: 1_800_000, speakerId: "speaker-1" },
      ],
    }],
    personAppearances: [
      {
        appearanceId: "appearance-a",
        trackId: "track-a",
        personId: "person-a",
        startUs: 0,
        endUs: 4_000_000,
        detectionConfidence: 0.95,
        identityConfidence: 0.92,
      },
      {
        appearanceId: "appearance-unknown",
        trackId: "track-unknown",
        startUs: 800_000,
        endUs: 1_200_000,
        detectionConfidence: 0.8,
      },
    ],
    speakerTracks: [{
      trackId: "speaker-track-1",
      speakerId: "speaker-1",
      personId: "person-a",
      startUs: 300_000,
      endUs: 1_800_000,
      confidence: 0.9,
      linkConfidence: 0.95,
    }],
    personIds: ["person-a"],
    speakerIds: ["speaker-1"],
  };

  it("按字幕、出镜和说话边界生成连续微秒时间片，并保留未知人物", () => {
    const segments = buildAlignedEvidenceSegments({
      startUs: 0,
      endUs: 4_000_000,
      ...evidence,
    });

    expect(segments.map((segment) => [segment.startUs, segment.endUs])).toEqual([
      [0, 300_000],
      [300_000, 800_000],
      [800_000, 1_200_000],
      [1_200_000, 1_800_000],
      [1_800_000, 4_000_000],
    ]);
    expect(segments[0]).toMatchObject({
      eventSummary: "小林在营地整理装备",
      eventGranularity: "shot",
      visiblePeople: [{
        appearanceId: "appearance-a",
        trackId: "track-a",
        personId: "person-a",
      }],
      activeSpeakers: [],
    });
    expect(segments[2]).toMatchObject({
      subtitleText: "先把装备整理好",
      transcriptGranularity: "word",
      visiblePeople: expect.arrayContaining([
        expect.objectContaining({ personId: "person-a" }),
        {
          appearanceId: "appearance-unknown",
          trackId: "track-unknown",
        },
      ]),
      activeSpeakers: [{
        trackId: "speaker-track-1",
        speakerId: "speaker-1",
        personId: "person-a",
      }],
    });
  });

  it("裁切后重建连续时间片，移除范围外证据但不伪造人物身份", () => {
    const clipped = clipVideoEvidenceToRange({
      ...evidence,
      alignedSegments: buildAlignedEvidenceSegments({
        startUs: 0,
        endUs: 4_000_000,
        ...evidence,
      }),
    }, 800_000, 3_000_000);

    expect(clipped.subtitleSegments).toEqual([{
      startUs: 800_000,
      endUs: 1_800_000,
      text: "装备整理好",
      speakerId: "speaker-1",
      words: [{
        text: "装备整理好",
        startUs: 800_000,
        endUs: 1_800_000,
        speakerId: "speaker-1",
      }],
    }]);
    expect(clipped.personAppearances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        appearanceId: "appearance-a",
        startUs: 800_000,
        endUs: 3_000_000,
        personId: "person-a",
      }),
      expect.objectContaining({
        appearanceId: "appearance-unknown",
        startUs: 800_000,
        endUs: 1_200_000,
      }),
    ]));
    expect(clipped.alignedSegments?.at(0)?.startUs).toBe(800_000);
    expect(clipped.alignedSegments?.at(-1)?.endUs).toBe(3_000_000);
    expect(clipped.alignedSegments?.flatMap((segment) =>
      segment.visiblePeople.filter((person) => person.trackId === "track-unknown")))
      .toEqual([{
        appearanceId: "appearance-unknown",
        trackId: "track-unknown",
      }]);
  });
});
