import { describe, expect, it } from "vitest";
import type {
  PersonAppearance,
  SpeakerTrack,
} from "../src/types";
import {
  linkSpeakerTracksToPeople,
} from "../electron/identity/speaker-person-linker";

function speaker(patch: Partial<SpeakerTrack> = {}): SpeakerTrack {
  return {
    id: "speaker-track-1",
    videoId: "video-1",
    speakerId: "video-1:speaker:1",
    startSec: 0,
    endSec: 4,
    confidence: 0.5,
    ...patch,
  };
}

function appearance(
  personId: string,
  patch: Partial<PersonAppearance> = {},
): PersonAppearance {
  return {
    id: `appearance-${personId}`,
    personId,
    videoId: "video-1",
    trackId: `face-track-${personId}`,
    startSec: 0,
    endSec: 4,
    confidence: 0.95,
    identityConfidence: 0.92,
    speakingConfidence: 0.94,
    source: "face_track",
    ...patch,
  };
}

describe("说话人到出镜人物的保守关联", () => {
  it("显式口型活动、可信身份和主导覆盖都通过时才关联", () => {
    const result = linkSpeakerTracksToPeople({
      speakerTracks: [speaker()],
      appearances: [
        appearance("person-a", { startSec: 0.2, endSec: 3.8 }),
        appearance("person-b", {
          startSec: 0,
          endSec: 0.3,
          speakingConfidence: 0.86,
        }),
      ],
    });

    expect(result.linkedTrackCount).toBe(1);
    expect(result.speakerTracks[0]).toEqual(expect.objectContaining({
      personId: "person-a",
      linkConfidence: expect.any(Number),
    }));
    expect(result.speakerTracks[0].linkConfidence).toBeGreaterThanOrEqual(0.8);
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      reason: "linked",
      personId: "person-a",
      coverage: 0.9,
    }));
  });

  it("只有同时出镜、没有口型活动证据时保持未知并清除旧自动关联", () => {
    const result = linkSpeakerTracksToPeople({
      speakerTracks: [speaker({
        personId: "stale-person",
        linkConfidence: 0.99,
      })],
      appearances: [
        appearance("person-a", { speakingConfidence: undefined }),
      ],
    });

    expect(result.linkedTrackCount).toBe(0);
    expect(result.speakerTracks[0].personId).toBeUndefined();
    expect(result.speakerTracks[0].linkConfidence).toBeUndefined();
    expect(result.decisions[0].reason).toBe("no_speaking_evidence");
  });

  it("多人都有强口型活动且没有明显主导时不猜人物", () => {
    const result = linkSpeakerTracksToPeople({
      speakerTracks: [speaker()],
      appearances: [
        appearance("person-a"),
        appearance("person-b", { speakingConfidence: 0.93 }),
      ],
    });

    expect(result.speakerTracks[0].personId).toBeUndefined();
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      reason: "ambiguous_people",
      dominance: expect.closeTo(0.5, 2),
    }));
  });

  it("口型证据覆盖过短或跨素材身份不可信时保持未知", () => {
    const insufficient = linkSpeakerTracksToPeople({
      speakerTracks: [speaker()],
      appearances: [
        appearance("person-a", { startSec: 0, endSec: 1 }),
      ],
    });
    const untrusted = linkSpeakerTracksToPeople({
      speakerTracks: [speaker()],
      appearances: [
        appearance("person-a", { identityConfidence: 0.6 }),
      ],
    });

    expect(insufficient.decisions[0].reason).toBe("insufficient_coverage");
    expect(untrusted.decisions[0].reason).toBe("untrusted_identity");
  });

  it("人工关联和人工保持未知都不被自动结果覆盖", () => {
    const linked = speaker({
      id: "manual-linked",
      personId: "person-manual",
      linkConfidence: 1,
      manualLocked: true,
    });
    const unlinked = speaker({
      id: "manual-unlinked",
      manualLocked: true,
    });
    const result = linkSpeakerTracksToPeople({
      speakerTracks: [linked, unlinked],
      appearances: [appearance("person-a")],
    });

    expect(result.speakerTracks).toEqual([linked, unlinked]);
    expect(result.decisions.map((decision) => decision.reason)).toEqual([
      "manual_preserved",
      "manual_preserved",
    ]);
  });
});
