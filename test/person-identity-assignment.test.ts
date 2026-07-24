import { describe, expect, it } from "vitest";
import {
  assignPersonIdentities,
  SFACE_AUTO_IDENTITY_POLICY,
} from "../electron/identity/person-identity-assignment";
import type { PersonAppearanceEvidence } from "../electron/repositories/identity-repository";

function appearance(
  id: string,
  videoId: string,
  trackId: string,
  embedding: number[],
  overrides: Partial<PersonAppearanceEvidence> = {},
): PersonAppearanceEvidence {
  return {
    id,
    videoId,
    trackId,
    startSec: 0,
    endSec: 1,
    confidence: 0.95,
    source: "face_track",
    embeddingModel: "opencv-zoo-sface-2021dec",
    embeddingQuality: 0.9,
    embedding,
    ...overrides,
  };
}

describe("跨素材人物身份分配", () => {
  it("SFace 默认阈值使用真人固定集标定值", () => {
    expect(SFACE_AUTO_IDENTITY_POLICY).toEqual({
      minimumQuality: 0.5,
      autoMergeThreshold: 0.5,
      minimumMargin: 0.08,
    });
  });

  it("同一人物跨视频复用 personId，不同人物创建独立实体", () => {
    const existing = appearance(
      "appearance-a",
      "video-a",
      "track-a",
      [1, 0, 0, 0],
      { personId: "person-a" },
    );
    const result = assignPersonIdentities({
      videoId: "video-b",
      appearances: [
        appearance("same", "video-b", "same-track", [0.99, 0.03, 0, 0]),
        appearance("different", "video-b", "different-track", [0, 1, 0, 0]),
      ],
      existingEvidence: [existing],
      people: [{ id: "person-a", status: "auto" }],
      differentPersonPairs: [],
    });

    expect(result.appearances[0]).toMatchObject({
      id: "same",
      personId: "person-a",
      identityConfidence: expect.any(Number),
    });
    expect(result.appearances[1].personId).toMatch(/^person-auto-/);
    expect(result.appearances[1].personId).not.toBe("person-a");
    expect(result.people).toEqual([
      expect.objectContaining({
        id: result.appearances[1].personId,
        status: "auto",
      }),
    ]);
    expect(result.decisions).toEqual([
      expect.objectContaining({ trackId: "same-track", reason: "matched" }),
      expect.objectContaining({ trackId: "different-track", reason: "created" }),
    ]);
  });

  it("同一视频中断开的同人轨迹复用本批次新建人物", () => {
    const result = assignPersonIdentities({
      videoId: "video-a",
      appearances: [
        appearance("a1", "video-a", "track-1", [1, 0, 0]),
        appearance("a2", "video-a", "track-2", [0.99, 0.02, 0]),
      ],
      existingEvidence: [],
      people: [],
      differentPersonPairs: [],
    });

    expect(result.appearances[0].personId).toBe(result.appearances[1].personId);
    expect(result.people).toHaveLength(1);
    expect(result.decisions.map((decision) => decision.reason)).toEqual([
      "created",
      "matched",
    ]);
  });

  it("模型不一致、质量不足和人工排除都不会误归并", () => {
    const existing = appearance(
      "existing",
      "video-a",
      "track-a",
      [1, 0],
      { personId: "person-a" },
    );
    const result = assignPersonIdentities({
      videoId: "video-b",
      appearances: [
        appearance("wrong-model", "video-b", "track-1", [1, 0], {
          embeddingModel: "another-model",
        }),
        appearance("low-quality", "video-b", "track-2", [1, 0], {
          embeddingQuality: SFACE_AUTO_IDENTITY_POLICY.minimumQuality - 0.01,
        }),
        appearance("blocked", "video-b", "track-3", [1, 0]),
      ],
      existingEvidence: [
        existing,
        appearance("old-track-3", "video-b", "track-3", [1, 0], {
          personId: "person-b",
        }),
      ],
      people: [
        { id: "person-a", status: "confirmed" },
        { id: "person-b", status: "confirmed" },
      ],
      differentPersonPairs: [{
        leftPersonId: "person-a",
        rightPersonId: "person-b",
      }],
    });

    expect(result.appearances[0].personId).not.toBe("person-a");
    expect(result.appearances[1]).not.toHaveProperty("personId");
    expect(result.appearances[2].personId).toBe("person-b");
    expect(result.decisions.map((decision) => decision.reason)).toEqual([
      "created",
      "low_quality",
      "matched",
    ]);
  });
});
