import { describe, expect, it } from "vitest";
import type {
  PersonAppearance,
  Shot,
  SpeakerTrack,
  Video,
} from "../src/types";
import { buildVlogCandidates } from "../electron/editing/candidate-builder";
import {
  buildAnalysisEvidenceQualityReport,
} from "../electron/editing/analysis-evidence-quality";

function video(id: string): Video {
  return {
    id,
    title: id,
    sourceType: "local",
    localPath: `/videos/${id}.mp4`,
    durationSec: 10,
    width: 1920,
    height: 1080,
    orientation: "landscape",
    videoRole: "asset",
    status: "completed",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}

function shot(videoId: string, id: string, startSec: number): Shot {
  return {
    id,
    videoId,
    assetProjectId: videoId,
    shotIndex: 1,
    startSec,
    endSec: startSec + 3,
    description: "人物在厨房准备早餐",
    usageTags: ["action"],
    transcriptGranularity: "word",
    subtitleSegments: [{
      startSec: startSec + 0.2,
      endSec: startSec + 1.4,
      text: "先准备今天的早餐",
      speakerId: "speaker-a",
      words: [
        { text: "先准备", startSec: startSec + 0.2, endSec: startSec + 0.7 },
        { text: "今天的早餐", startSec: startSec + 0.7, endSec: startSec + 1.4 },
      ],
    }],
  };
}

describe("分析证据质量报告", () => {
  it("区分逐字字幕、单素材轨迹、可信跨素材身份和说话人关联", () => {
    const videos = [video("video-1"), video("video-2")];
    const shots = [
      shot("video-1", "shot-1", 0),
      shot("video-2", "shot-2", 2),
    ];
    const appearances: PersonAppearance[] = [
      {
        id: "appearance-1",
        personId: "person-main",
        videoId: "video-1",
        shotId: "shot-1",
        trackId: "track-1",
        startSec: 0,
        endSec: 3,
        confidence: 0.96,
        identityConfidence: 0.93,
        source: "face_track",
      },
      {
        id: "appearance-2",
        personId: "person-main",
        videoId: "video-2",
        shotId: "shot-2",
        trackId: "track-2",
        startSec: 2,
        endSec: 5,
        confidence: 0.94,
        identityConfidence: 0.91,
        source: "face_track",
      },
      {
        id: "appearance-unknown",
        videoId: "video-2",
        shotId: "shot-2",
        trackId: "track-unknown",
        startSec: 2,
        endSec: 3,
        confidence: 0.8,
        source: "face_track",
      },
    ];
    const speakers: SpeakerTrack[] = [{
      id: "speaker-track-1",
      videoId: "video-1",
      shotId: "shot-1",
      speakerId: "speaker-a",
      personId: "person-main",
      startSec: 0.2,
      endSec: 1.4,
      confidence: 0.9,
      linkConfidence: 0.88,
    }];
    const candidates = buildVlogCandidates(
      shots,
      videos,
      appearances,
      speakers,
      { minimumIdentityConfidence: 0.8 },
    );
    const report = buildAnalysisEvidenceQualityReport(
      videos,
      shots,
      appearances,
      speakers,
      candidates,
      {
        generatedAt: 123,
        minimumIdentityConfidence: 0.8,
      },
    );

    expect(report).toMatchObject({
      generatedAt: 123,
      videoCount: 2,
      shotCount: 2,
      semantic: {
        describedShotCount: 2,
        coverageRatio: 1,
      },
      transcript: {
        capability: "word",
        segmentCount: 2,
        wordTimedSegmentCount: 2,
        wordTimingCoverageRatio: 1,
        invalidSegmentCount: 0,
        videosWithTranscript: 2,
        shotCoverageRatio: 1,
      },
      identity: {
        capability: "cross_video",
        appearanceCount: 3,
        trustedAppearanceCount: 2,
        unassignedAppearanceCount: 1,
        untrustedAppearanceCount: 0,
        invalidAppearanceCount: 0,
        videosWithTracks: 2,
        crossVideoPersonCount: 1,
      },
      speakers: {
        capability: "linked",
        trackCount: 1,
        invalidTrackCount: 0,
        linkedTrackCount: 1,
        videosWithTracks: 1,
      },
      planning: {
        readiness: "ready",
        eligibleShotCount: 2,
        rejectedShotCount: 0,
      },
    });
  });

  it("没有可执行 Shot 时阻止规划，并显式报告缺失证据", () => {
    const videos = [{ ...video("video-1"), localPath: undefined }];
    const shots = [{
      ...shot("video-1", "shot-1", 0),
      description: "镜头 1",
      subtitleSegments: undefined,
      transcriptGranularity: undefined,
    }];
    const candidates = buildVlogCandidates(shots, videos, [], []);
    const report = buildAnalysisEvidenceQualityReport(
      videos,
      shots,
      [],
      [],
      candidates,
      { generatedAt: 456 },
    );

    expect(report.planning.readiness).toBe("blocked");
    expect(report.planning.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "NO_ELIGIBLE_SHOTS",
      "SEMANTIC_DESCRIPTION_INCOMPLETE",
      "TIMED_TRANSCRIPT_MISSING",
      "PERSON_TRACKING_MISSING",
      "SPEAKER_DIARIZATION_MISSING",
    ]));
  });
});
