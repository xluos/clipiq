import { describe, expect, it } from "vitest";
import type {
  EditFeedbackEvent,
  Shot,
  Video,
} from "../src/types";
import { buildVlogCandidates } from "../electron/editing/candidate-builder";
import { compileEditPlan } from "../electron/editing/edit-plan-compiler";
import { evaluateVlogQuality } from "../electron/editing/vlog-quality-evaluator";

function video(id: string): Video {
  return {
    id,
    title: id,
    sourceType: "local",
    localPath: `/fixtures/${id}.mp4`,
    durationSec: 8,
    width: 1920,
    height: 1080,
    orientation: "landscape",
    videoRole: "asset",
    status: "completed",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}

function shot(videoId: string, index: number): Shot {
  const startSec = index * 4;
  const endSec = startSec + 4;
  return {
    id: `${videoId}-shot-${index + 1}`,
    videoId,
    assetProjectId: videoId,
    shotIndex: index + 1,
    startSec,
    endSec,
    description: index === 0 ? "人物整理装备" : "人物到达营地",
    usageTags: index === 0 ? ["hook"] : ["ending"],
    eventSegments: [{
      startSec,
      endSec,
      summary: index === 0 ? "人物整理装备" : "人物到达营地",
      granularity: "segment",
      source: "analysis_node",
      sourceNodeId: `${videoId}-event-${index + 1}`,
      confidence: 0.95,
    }],
    subtitleSegments: [{
      startSec: startSec + 0.5,
      endSec: startSec + 1.5,
      text: index === 0 ? "准备出发" : "终于到了",
    }],
  };
}

function fixture() {
  const videos = [video("video-1"), video("video-2")];
  const shots = [shot("video-1", 0), shot("video-2", 1)];
  const candidateResult = buildVlogCandidates(shots, videos, [], []);
  const candidates = [...candidateResult.candidates]
    .sort((left, right) => left.videoId.localeCompare(right.videoId));
  const shotById = new Map(shots.map((item) => [item.id, item]));
  const plan = compileEditPlan(
    candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      shotId: candidate.shotId,
      intent: candidate.description,
      confidence: 0.9,
    })),
    candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      shot: shotById.get(candidate.shotId)!,
      videoId: candidate.videoId,
      sourcePath: candidate.sourcePath,
      sourceInUs: candidate.startUs,
      sourceOutUs: candidate.endUs,
    })),
    {
      planId: "quality-plan",
      sessionId: "quality-session",
      targetDurationUs: 8_000_000,
      canvas: { width: 1920, height: 1080, fps: 30 },
      goal: "固定素材质量评估",
      generatedAt: 1000,
    },
  );
  return { videos, shots, candidates, plan };
}

function feedback(
  planId: string,
  eventId: string,
  action: EditFeedbackEvent["action"],
): EditFeedbackEvent {
  return {
    id: eventId,
    sessionId: "quality-session",
    planId,
    resultingPlanId: `${planId}-${eventId}`,
    action,
    beforeRevision: 1,
    afterRevision: 2,
    createdAt: 1000,
  };
}

describe("Vlog 固定素材质量评估", () => {
  it("量化候选绑定、时间范围、运行成功率、人物一致性和编辑动作", () => {
    const { shots, candidates, plan } = fixture();
    const clips = plan.tracks.find((track) => track.kind === "video");
    if (clips?.kind !== "video") throw new Error("fixture");
    const events = [
      feedback(plan.id, "move", {
        type: "move_clip",
        clipId: clips.items[0].id,
        toIndex: 1,
      }),
      feedback(plan.id, "replace", {
        type: "replace_clip",
        clipId: clips.items[1].id,
        replacementCandidateId: candidates[0].candidateId,
      }),
    ];
    const report = evaluateVlogQuality({
      candidates,
      plan,
      initialPlan: plan,
      shots,
      previewAttempts: [{ succeeded: true }, { succeeded: true }],
      identityGroundTruth: [
        {
          appearanceId: "appearance-a-1",
          videoId: "video-1",
          expectedPersonKey: "person-a",
          predictedPersonId: "person-stable-a",
        },
        {
          appearanceId: "appearance-a-2",
          videoId: "video-2",
          expectedPersonKey: "person-a",
          predictedPersonId: "person-stable-a",
        },
        {
          appearanceId: "appearance-b",
          videoId: "video-2",
          expectedPersonKey: "person-b",
          predictedPersonId: "person-stable-b",
        },
      ],
      feedbackEvents: events,
    }, 123);

    expect(report).toMatchObject({
      generatedAt: 123,
      technical: {
        candidateBindingViolations: { failures: 0, rate: 0 },
        shotBoundsViolations: { failures: 0, rate: 0 },
        subtitleRangeViolations: { failures: 0, rate: 0 },
        eventRangeViolations: { failures: 0, rate: 0 },
        preview: { attempted: 2, succeeded: 2, successRate: 1 },
        jianyingDraftOpen: { attempted: 0, succeeded: 0, successRate: null },
      },
      identity: {
        status: "measured",
        comparedCrossVideoPairCount: 2,
        crossVideoExpectedPairCount: 1,
        predictedSamePairCount: 1,
        matchedSamePairCount: 1,
        falseMergePairCount: 0,
        recall: 1,
        precision: 1,
      },
      editing: {
        operationCount: 2,
        retainedClipRatio: 1,
        reorderedClipRatio: 0.5,
        replacementRatio: 0.5,
      },
      status: "partial",
    });
    expect(report.gates.find((gate) => gate.key === "jianying_open")?.passed)
      .toBeNull();
  });

  it("任何候选越界、证据越界、预览失败或人物错误合并都会失败", () => {
    const { shots, candidates, plan } = fixture();
    const invalid = structuredClone(plan);
    const clips = invalid.tracks.find((track) => track.kind === "video");
    if (clips?.kind !== "video") throw new Error("fixture");
    clips.items[0].candidateId = "missing";
    clips.items[0].sourceOutUs += 1_000_000;
    clips.items[0].evidence!.subtitleSegments![0].endUs += 5_000_000;
    clips.items[0].evidence!.eventSegments![0].endUs += 5_000_000;

    const report = evaluateVlogQuality({
      candidates,
      plan: invalid,
      shots,
      previewAttempts: [{ succeeded: false }],
      jianyingDraftOpenAttempts: [{ succeeded: false }],
      identityGroundTruth: [
        {
          appearanceId: "appearance-a",
          videoId: "video-1",
          expectedPersonKey: "person-a",
          predictedPersonId: "person-wrongly-merged",
        },
        {
          appearanceId: "appearance-b",
          videoId: "video-2",
          expectedPersonKey: "person-b",
          predictedPersonId: "person-wrongly-merged",
        },
      ],
    }, 456);

    expect(report.status).toBe("failed");
    expect(report.technical.candidateBindingViolations.failures).toBe(1);
    expect(report.technical.shotBoundsViolations.failures).toBe(1);
    expect(report.technical.subtitleRangeViolations.failures).toBe(1);
    expect(report.technical.eventRangeViolations.failures).toBe(1);
    expect(report.identity.falseMergePairCount).toBe(1);
    expect(report.gates.every((gate) => gate.passed === false)).toBe(true);
  });

  it("只有单素材人物标注时不伪装成跨素材身份评估", () => {
    const { shots, candidates, plan } = fixture();
    const report = evaluateVlogQuality({
      candidates,
      plan,
      shots,
      identityGroundTruth: [
        {
          appearanceId: "appearance-a-1",
          videoId: "video-1",
          expectedPersonKey: "person-a",
          predictedPersonId: "person-stable-a",
        },
        {
          appearanceId: "appearance-a-2",
          videoId: "video-1",
          expectedPersonKey: "person-a",
          predictedPersonId: "person-stable-a",
        },
      ],
    }, 789);

    expect(report.identity).toMatchObject({
      status: "not_evaluated",
      comparedCrossVideoPairCount: 0,
      recall: null,
      precision: null,
    });
    expect(report.gates.find((gate) => gate.key === "identity_false_merge")?.passed)
      .toBeNull();
  });
});
