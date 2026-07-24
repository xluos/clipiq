import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import {
  cosineSimilarity,
  matchPersonObservations,
} from "../electron/identity/person-clusterer";
import {
  createIdentityRepository,
  migrateIdentitySchema,
} from "../electron/repositories/identity-repository";

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];

function createDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("人物身份 repository", () => {
  it("迁移可重复，证据重跑时保留人工拆分与说话人关联", () => {
    const db = createDatabase();
    migrateIdentitySchema(db);
    migrateIdentitySchema(db);
    const repository = createIdentityRepository(db);

    repository.upsertPeople([
      { id: "person-a", displayName: "人物 A", status: "auto" },
    ]);
    repository.replaceEvidenceForVideo("video-1", {
      appearances: [{
        id: "appearance-1",
        videoId: "video-1",
        shotId: "video-1-shot-1",
        trackId: "track-1",
        personId: "person-a",
        startSec: 1,
        endSec: 4,
        confidence: 0.94,
        identityConfidence: 0.78,
        source: "face_track",
        embeddingModel: "test-face-v1",
        embeddingQuality: 0.88,
        embedding: [0.1, 0.2, 0.3],
      }],
      speakerTracks: [{
        id: "speaker-track-1",
        videoId: "video-1",
        shotId: "video-1-shot-1",
        speakerId: "speaker-1",
        startSec: 1.2,
        endSec: 3.8,
        confidence: 0.91,
        transcriptText: "我们先出发",
      }],
    });

    repository.splitAppearance("appearance-1", {
      id: "person-b",
      displayName: "人物 B",
      status: "confirmed",
    });
    repository.linkSpeakerTrack("speaker-track-1", "person-b");

    repository.replaceEvidenceForVideo("video-1", {
      appearances: [{
        id: "appearance-1",
        videoId: "video-1",
        trackId: "track-1",
        personId: "person-a",
        startSec: 1,
        endSec: 4,
        confidence: 0.99,
        source: "face_track",
        embeddingModel: "test-face-v1",
        embedding: [0.3, 0.2, 0.1],
      }],
      speakerTracks: [{
        id: "speaker-track-1",
        videoId: "video-1",
        speakerId: "speaker-1",
        startSec: 1.2,
        endSec: 3.8,
        confidence: 0.99,
      }],
    });

    expect(repository.listAppearances("video-1")).toEqual([
      expect.objectContaining({
        id: "appearance-1",
        personId: "person-b",
        manualLocked: true,
      }),
    ]);
    expect(repository.listSpeakerTracks("video-1")).toEqual([
      expect.objectContaining({
        id: "speaker-track-1",
        personId: "person-b",
        linkConfidence: 1,
        manualLocked: true,
      }),
    ]);
    expect(repository.listAppearanceEvidence("video-1")[0]).toMatchObject({
      embeddingModel: "test-face-v1",
      embeddingQuality: 0.88,
      embedding: expect.any(Array),
    });
    expect(repository.listAppearances("video-1")[0]).not.toHaveProperty("embedding");
    expect(repository.listDifferentPersonPairs()).toEqual([{
      leftPersonId: "person-a",
      rightPersonId: "person-b",
    }]);
  });

  it("合并人物会迁移全部出镜和说话人证据，并保留被合并实体", () => {
    const repository = createIdentityRepository(createDatabase());
    repository.upsertPeople([
      { id: "person-a", status: "auto" },
      { id: "person-b", displayName: "小林", status: "confirmed" },
    ]);
    repository.replaceEvidenceForVideo("video-1", {
      appearances: [{
        id: "appearance-1",
        videoId: "video-1",
        trackId: "track-1",
        personId: "person-a",
        startSec: 0,
        endSec: 2,
        confidence: 0.9,
        source: "face_track",
      }],
      speakerTracks: [{
        id: "speaker-track-1",
        videoId: "video-1",
        speakerId: "speaker-1",
        personId: "person-a",
        startSec: 0,
        endSec: 2,
        confidence: 0.8,
      }],
    });

    repository.mergePeople("person-a", "person-b");

    expect(repository.listAppearances("video-1")[0]).toMatchObject({
      personId: "person-b",
      manualLocked: true,
    });
    expect(repository.listSpeakerTracks("video-1")[0]).toMatchObject({
      personId: "person-b",
      manualLocked: true,
    });
    expect(repository.listPeople()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "person-a",
        status: "merged",
        mergedIntoPersonId: "person-b",
      }),
      expect.objectContaining({
        id: "person-b",
        status: "confirmed",
        appearanceCount: 1,
      }),
    ]));
    expect(repository.listDifferentPersonPairs()).toEqual([]);
  });

  it("只重跑人物分析时不删除独立的说话人证据", () => {
    const repository = createIdentityRepository(createDatabase());
    repository.replaceEvidenceForVideo("video-1", {
      appearances: [],
      speakerTracks: [{
        id: "speaker-track-1",
        videoId: "video-1",
        speakerId: "speaker-1",
        startSec: 0,
        endSec: 2,
        confidence: 0.8,
      }],
    });

    repository.replaceEvidenceForVideo("video-1", {
      appearances: [{
        id: "appearance-1",
        videoId: "video-1",
        trackId: "track-1",
        startSec: 0,
        endSec: 1,
        confidence: 0.9,
        source: "face_track",
      }],
    });

    expect(repository.listSpeakerTracks("video-1")).toEqual([
      expect.objectContaining({ id: "speaker-track-1" }),
    ]);
  });

  it("自动人物与 embedding 质量在同一事务中落库", () => {
    const repository = createIdentityRepository(createDatabase());
    repository.replaceEvidenceForVideo("video-1", {
      people: [{
        id: "person-auto-a",
        representativeThumbnailUrl: "media://frame/a",
        status: "auto",
      }],
      appearances: [{
        id: "appearance-1",
        videoId: "video-1",
        trackId: "track-1",
        personId: "person-auto-a",
        startSec: 0,
        endSec: 1,
        confidence: 0.93,
        identityConfidence: 1,
        source: "face_track",
        embeddingModel: "opencv-zoo-sface-2021dec",
        embeddingQuality: 0.81,
        embedding: [1, 0, 0],
      }],
    });

    expect(repository.listPeople()).toEqual([
      expect.objectContaining({
        id: "person-auto-a",
        appearanceCount: 1,
      }),
    ]);
    expect(repository.listAppearanceEvidence("video-1")).toEqual([
      expect.objectContaining({
        personId: "person-auto-a",
        embeddingModel: "opencv-zoo-sface-2021dec",
        embeddingQuality: 0.81,
      }),
    ]);
  });
});

describe("跨素材人物匹配策略", () => {
  const policy = {
    minimumQuality: 0.7,
    autoMergeThreshold: 0.9,
    minimumMargin: 0.05,
  };

  it("只在高质量、高相似度且候选间隔足够时自动匹配", () => {
    const decisions = matchPersonObservations([
      {
        appearanceId: "clear",
        embedding: [1, 0, 0, 0],
        quality: 0.95,
      },
      {
        appearanceId: "blurred",
        embedding: [1, 0, 0, 0],
        quality: 0.4,
      },
      {
        appearanceId: "ambiguous",
        embedding: [0, 0, 1, 0],
        quality: 0.95,
      },
    ], [
      { personId: "person-a", embedding: [1, 0, 0, 0], sampleCount: 3 },
      { personId: "person-b", embedding: [0, 1, 0, 0], sampleCount: 2 },
      { personId: "person-c", embedding: [0, 0, 1, 0], sampleCount: 4 },
      { personId: "person-d", embedding: [0, 0, 0.99, 0.1], sampleCount: 3 },
    ], policy);

    expect(decisions).toEqual([
      expect.objectContaining({
        appearanceId: "clear",
        personId: "person-a",
        reason: "matched",
      }),
      { appearanceId: "blurred", reason: "low_quality" },
      expect.objectContaining({
        appearanceId: "ambiguous",
        reason: "ambiguous",
      }),
    ]);
  });

  it("人工排除候选后不会重新误归并", () => {
    const [decision] = matchPersonObservations([{
      appearanceId: "appearance-1",
      embedding: [1, 0],
      quality: 1,
      blockedPersonIds: ["person-a"],
    }], [{
      personId: "person-a",
      embedding: [1, 0],
      sampleCount: 4,
    }], policy);

    expect(decision).toEqual({
      appearanceId: "appearance-1",
      reason: "no_candidate",
    });
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [1])).toBeNull();
  });
});
