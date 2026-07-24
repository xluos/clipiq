import { describe, expect, it } from "vitest";
import type {
  PersonAppearance,
  Shot,
  SpeakerTrack,
  Video,
} from "../src/types";
import { buildVlogCandidates } from "../electron/editing/candidate-builder";
import {
  buildVlogPlannerPrompt,
  parseVlogPlannerOutput,
  VLOG_PLANNER_CONSTRAINTS,
} from "../electron/editing/vlog-planner";

function video(patch: Partial<Video>): Video {
  return {
    id: "video-1",
    title: "露营素材",
    sourceType: "local",
    localPath: "/videos/camping.mp4",
    durationSec: 30,
    width: 1920,
    height: 1080,
    orientation: "landscape",
    videoRole: "asset",
    status: "completed",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...patch,
  };
}

function shot(patch: Partial<Shot>): Shot {
  return {
    id: "shot-1",
    videoId: "video-1",
    assetProjectId: "video-1",
    shotIndex: 1,
    startSec: 0,
    endSec: 4,
    description: "小林在营地整理装备",
    usageTags: ["hook", "highlight"],
    thumbnailUrl: "media://shot-1.jpg",
    subtitleSegments: [{
      startSec: 0.3,
      endSec: 1.8,
      text: "先把装备整理好",
      speakerId: "speaker-1",
      words: [
        { text: "先把", startSec: 0.3, endSec: 0.8, speakerId: "speaker-1" },
        { text: "装备整理好", startSec: 0.8, endSec: 1.8, speakerId: "speaker-1" },
      ],
    }],
    transcriptGranularity: "word",
    ...patch,
  };
}

describe("Vlog Candidate Builder", () => {
  it("只产出有真实路径和有效时间的候选，并保守过滤人物身份", () => {
    const appearances: PersonAppearance[] = [
      {
        id: "appearance-high",
        personId: "person-a",
        videoId: "video-1",
        trackId: "track-a",
        startSec: 0,
        endSec: 4,
        confidence: 0.95,
        identityConfidence: 0.92,
        focusBounds: { x: 0.2, y: 0.1, width: 0.3, height: 0.4 },
        source: "face_track",
      },
      {
        id: "appearance-low",
        personId: "person-b",
        videoId: "video-1",
        trackId: "track-b",
        startSec: 0,
        endSec: 4,
        confidence: 0.9,
        identityConfidence: 0.5,
        source: "face_track",
      },
      {
        id: "appearance-manual",
        personId: "person-c",
        videoId: "video-1",
        trackId: "track-c",
        startSec: 2,
        endSec: 4,
        confidence: 0.7,
        source: "manual",
        manualLocked: true,
      },
    ];
    const speakerTracks: SpeakerTrack[] = [{
      id: "speaker-track-1",
      videoId: "video-1",
      speakerId: "speaker-1",
      personId: "person-a",
      startSec: 0.3,
      endSec: 1.8,
      confidence: 0.9,
      linkConfidence: 0.5,
    }];
    const result = buildVlogCandidates([
      shot({}),
      shot({
        id: "shot-overlap",
        shotIndex: 2,
        startSec: 0.2,
        endSec: 3.8,
        description: "",
        usageTags: [],
        thumbnailUrl: undefined,
        subtitleSegments: undefined,
      }),
      shot({
        id: "shot-short",
        shotIndex: 3,
        startSec: 5,
        endSec: 5.1,
      }),
      shot({
        id: "shot-missing-path",
        videoId: "video-2",
        assetProjectId: "video-2",
        shotIndex: 1,
      }),
    ], [
      video({}),
      video({ id: "video-2", localPath: undefined }),
    ], appearances, speakerTracks, {
      minimumIdentityConfidence: 0.8,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        shotId: "shot-1",
        sourcePath: "/videos/camping.mp4",
        startUs: 0,
        endUs: 4_000_000,
        personIds: ["person-a", "person-c"],
        speakerIds: ["speaker-1"],
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
        transcriptGranularity: "word",
        personAppearances: expect.arrayContaining([
          expect.objectContaining({
            trackId: "track-a",
            personId: "person-a",
            focusBounds: { x: 0.2, y: 0.1, width: 0.3, height: 0.4 },
          }),
          expect.objectContaining({
            trackId: "track-b",
          }),
          expect.objectContaining({
            trackId: "track-c",
            personId: "person-c",
            manualConfirmed: true,
          }),
        ]),
      }),
    ]);
    expect(result.rejected.map((item) => item.code)).toEqual(expect.arrayContaining([
      "OVERLAPPING_DUPLICATE",
      "TOO_SHORT",
      "MISSING_SOURCE_PATH",
    ]));
    expect(result.candidates[0].personAppearances
      .find((appearance) => appearance.trackId === "track-b"))
      .not.toHaveProperty("personId");
    expect(result.candidates[0].speakerTracks[0]).not.toHaveProperty("personId");
  });

  it("可按人物、说话人、事件、对白和素材时间范围检索真实 Shot", () => {
    const shots = [
      shot({}),
      shot({
        id: "shot-2",
        shotIndex: 2,
        startSec: 10,
        endSec: 14,
        description: "营地远景",
        usageTags: ["ending"],
        subtitleSegments: [{
          startSec: 10.2,
          endSec: 11.5,
          text: "今天先到这里",
        }],
      }),
    ];
    const appearances: PersonAppearance[] = [{
      id: "appearance-1",
      personId: "person-a",
      videoId: "video-1",
      trackId: "track-a",
      startSec: 0,
      endSec: 4,
      confidence: 0.95,
      identityConfidence: 0.92,
      source: "face_track",
    }];
    const speakers: SpeakerTrack[] = [{
      id: "speaker-track-1",
      videoId: "video-1",
      speakerId: "speaker-1",
      startSec: 0.2,
      endSec: 2,
      confidence: 0.5,
    }];

    const result = buildVlogCandidates(
      shots,
      [video({})],
      appearances,
      speakers,
      {
        minimumIdentityConfidence: 0.8,
        personIds: ["person-a"],
        speakerIds: ["speaker-1"],
        eventQuery: "整理装备",
        dialogueQuery: "装备",
        sourceTimeRanges: [{
          videoId: "video-1",
          startUs: 0,
          endUs: 5_000_000,
        }],
      },
    );

    expect(result.candidates.map((candidate) => candidate.shotId)).toEqual(["shot-1"]);
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ shotId: "shot-2", code: "FILTER_PERSON" }),
    ]));
    expect(() => buildVlogCandidates(shots, [video({})], appearances, speakers, {
      sourceTimeRanges: [{ videoId: "video-1", startUs: 2, endUs: 1 }],
    })).toThrow("候选素材时间范围无效");
  });

  it("长 Shot 按对齐证据边界生成多个固定范围候选，而不是默认截开头", () => {
    const result = buildVlogCandidates([
      shot({
        id: "shot-long",
        startSec: 0,
        endSec: 15,
        subtitleSegments: [
          { startSec: 0.2, endSec: 1.8, text: "先整理装备" },
          { startSec: 4, endSec: 5, text: "准备出发" },
          { startSec: 8, endSec: 9, text: "终于到了" },
        ],
      }),
    ], [video({})], [], [], {
      maximumWindowDurationUs: 6_000_000,
      minimumWindowDurationUs: 800_000,
    });
    const ordered = [...result.candidates].sort((left, right) =>
      left.startUs - right.startUs);

    expect(ordered.map((candidate) => ({
      candidateId: candidate.candidateId,
      startUs: candidate.startUs,
      endUs: candidate.endUs,
      boundaryReason: candidate.boundaryReason,
    }))).toEqual([
      {
        candidateId: "shot-long::0-5000000",
        startUs: 0,
        endUs: 5_000_000,
        boundaryReason: "evidence",
      },
      {
        candidateId: "shot-long::5000000-9000000",
        startUs: 5_000_000,
        endUs: 9_000_000,
        boundaryReason: "evidence",
      },
      {
        candidateId: "shot-long::9000000-15000000",
        startUs: 9_000_000,
        endUs: 15_000_000,
        boundaryReason: "duration",
      },
    ]);
    expect(ordered[1].subtitleSegments).toEqual([{
      startUs: 8_000_000,
      endUs: 9_000_000,
      text: "终于到了",
    }]);
    expect(ordered.every((candidate) =>
      candidate.alignedSegments.at(0)?.startUs === candidate.startUs
      && candidate.alignedSegments.at(-1)?.endUs === candidate.endUs))
      .toBe(true);
  });

  it("跨素材同一可信人物在时间片中复用稳定 personId", () => {
    const result = buildVlogCandidates([
      shot({}),
      shot({
        id: "shot-video-2",
        videoId: "video-2",
        assetProjectId: "video-2",
        startSec: 5,
        endSec: 9,
      }),
    ], [
      video({}),
      video({ id: "video-2", localPath: "/videos/camping-2.mp4" }),
    ], [
      {
        id: "appearance-video-1",
        personId: "person-a",
        videoId: "video-1",
        trackId: "track-video-1",
        startSec: 0,
        endSec: 4,
        confidence: 0.95,
        identityConfidence: 0.92,
        source: "face_track",
      },
      {
        id: "appearance-video-2",
        personId: "person-a",
        videoId: "video-2",
        trackId: "track-video-2",
        startSec: 5,
        endSec: 9,
        confidence: 0.94,
        identityConfidence: 0.9,
        source: "face_track",
      },
    ], [], {
      minimumIdentityConfidence: 0.8,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.personIds)).toEqual([
      ["person-a"],
      ["person-a"],
    ]);
    expect(result.candidates.map((candidate) => [...new Set(
      candidate.alignedSegments.flatMap((segment) =>
        segment.visiblePeople.map((person) => person.personId)),
    )]))
      .toEqual([["person-a"], ["person-a"]]);
    expect(result.candidates.map((candidate) =>
      candidate.alignedSegments[0].visiblePeople[0].trackId))
      .toEqual(["track-video-1", "track-video-2"]);
  });
});

describe("Vlog Planner 契约", () => {
  const candidate = {
    candidateId: "shot-1::0-4000000",
    shotId: "shot-1",
    videoId: "video-1",
    sourcePath: "/private/path.mp4",
    startUs: 0,
    endUs: 4_000_000,
    durationUs: 4_000_000,
    description: "小林整理装备",
    subtitleSegments: [{
      startUs: 300_000,
      endUs: 1_800_000,
      text: "先把装备整理好",
    }],
    transcriptGranularity: "segment" as const,
    personAppearances: [{
      appearanceId: "appearance-1",
      trackId: "track-a",
      personId: "person-a",
      startUs: 0,
      endUs: 4_000_000,
      detectionConfidence: 0.95,
      identityConfidence: 0.92,
    }],
    speakerTracks: [{
      trackId: "speaker-track-1",
      speakerId: "speaker-1",
      startUs: 300_000,
      endUs: 1_800_000,
      confidence: 0.9,
    }],
    boundaryReason: "shot" as const,
    alignedSegments: [{
      startUs: 0,
      endUs: 300_000,
      eventSummary: "小林整理装备",
      eventGranularity: "shot" as const,
      visiblePeople: [{
        appearanceId: "appearance-1",
        trackId: "track-a",
        personId: "person-a",
      }],
      activeSpeakers: [],
    }, {
      startUs: 300_000,
      endUs: 1_800_000,
      eventSummary: "小林整理装备",
      eventGranularity: "shot" as const,
      subtitleText: "先把装备整理好",
      transcriptGranularity: "segment" as const,
      visiblePeople: [{
        appearanceId: "appearance-1",
        trackId: "track-a",
        personId: "person-a",
      }],
      activeSpeakers: [{
        trackId: "speaker-track-1",
        speakerId: "speaker-1",
      }],
    }, {
      startUs: 1_800_000,
      endUs: 4_000_000,
      eventSummary: "小林整理装备",
      eventGranularity: "shot" as const,
      visiblePeople: [{
        appearanceId: "appearance-1",
        trackId: "track-a",
        personId: "person-a",
      }],
      activeSpeakers: [],
    }],
    personIds: ["person-a"],
    speakerIds: ["speaker-1"],
    usageTags: ["hook"],
    qualityScore: 0.9,
    qualitySignals: ["valid_time"],
  };

  it("prompt 包含结构化 Vlog 规则和证据，但不暴露或允许模型生成文件路径", () => {
    const prompt = buildVlogPlannerPrompt({
      goal: "一分钟露营 Vlog",
      targetDurationUs: 60_000_000,
      candidates: [candidate],
      methodologySummaries: ["开头直接给反差"],
    });

    expect(VLOG_PLANNER_CONSTRAINTS.map((rule) => rule.ruleId)).toEqual([
      "R-VLOG-006",
      "R-VLOG-001",
      "R-VLOG-002",
      "R-VLOG-003",
      "R-VLOG-004",
      "R-VLOG-007",
    ]);
    expect(prompt.userText).toContain("shotId=shot-1");
    expect(prompt.userText).toContain("candidateId=shot-1::0-4000000");
    expect(prompt.userText).toContain("people=person-a");
    expect(prompt.userText).toContain("[0.30-1.80] 先把装备整理好");
    expect(prompt.userText).toContain(
      "[0.30-1.80] event=小林整理装备@shot subtitle=先把装备整理好 visible=person-a speaking=speaker-1",
    );
    expect(prompt.userText).not.toContain("/private/path.mp4");
    expect(prompt.systemText).toContain("严禁生成 startSec/endSec");
    expect(prompt.systemText).toContain("每个 candidateId 已绑定真实 shotId");
  });

  it("解析时拒绝候选集外引用、重复引用和非法置信度", () => {
    const result = parseVlogPlannerOutput({
      selections: [
        { candidateId: candidate.candidateId, intent: "开场钩子", confidence: 0.9 },
        { candidateId: "missing", intent: "虚构", confidence: 0.8 },
        { candidateId: candidate.candidateId, intent: "重复", confidence: 0.7 },
        { candidateId: candidate.candidateId, intent: "非法置信度", confidence: 2 },
      ],
    }, [candidate]);

    expect(result.selections).toEqual([
      {
        candidateId: candidate.candidateId,
        shotId: "shot-1",
        intent: "开场钩子",
        confidence: 0.9,
      },
    ]);
    expect(result.errors).toHaveLength(3);
  });

  it("旁白只能锚定已选择且非末尾的候选窗口", () => {
    const secondCandidate = {
      ...candidate,
      candidateId: "shot-2::4000000-8000000",
      shotId: "shot-2",
      startUs: 4_000_000,
      endUs: 8_000_000,
    };
    const valid = parseVlogPlannerOutput({
      selections: [
        { candidateId: candidate.candidateId, intent: "准备", confidence: 0.9 },
        { candidateId: secondCandidate.candidateId, intent: "出发", confidence: 0.9 },
      ],
      voiceover: [{
        afterCandidateId: candidate.candidateId,
        text: "山谷天气比预想得更冷。",
      }],
    }, [candidate, secondCandidate]);
    expect(valid.errors).toEqual([]);
    expect(valid.voiceovers).toEqual([{
      afterCandidateId: candidate.candidateId,
      text: "山谷天气比预想得更冷。",
    }]);

    const invalid = parseVlogPlannerOutput({
      selections: [
        { candidateId: candidate.candidateId, intent: "准备", confidence: 0.9 },
        { candidateId: secondCandidate.candidateId, intent: "出发", confidence: 0.9 },
      ],
      voiceover: [
        { afterCandidateId: secondCandidate.candidateId, text: "不能锚定最后一段" },
        { afterCandidateId: "missing", text: "不能引用虚构镜头" },
      ],
    }, [candidate, secondCandidate]);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      `voiceover[0] 不能锚定最后一个候选窗口: ${secondCandidate.candidateId}`,
      "voiceover[1] 引用了未选择的 candidateId: missing",
    ]));
  });
});
