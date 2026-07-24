import { createHash } from "node:crypto";
import type { Person } from "../../src/types";
import type { PersonAppearanceEvidence } from "../repositories/identity-repository";
import {
  cosineSimilarity,
  matchPersonObservations,
  type PersonMatchPolicy,
  type PersonPrototype,
} from "./person-clusterer";

export const SFACE_AUTO_IDENTITY_POLICY: PersonMatchPolicy = {
  minimumQuality: 0.5,
  autoMergeThreshold: 0.82,
  minimumMargin: 0.08,
};

export type PersonIdentityAssignmentDecision = {
  trackId: string;
  personId?: string;
  similarity?: number;
  runnerUpSimilarity?: number;
  reason:
    | "matched"
    | "created"
    | "manual"
    | "missing_embedding"
    | "low_quality";
};

export type AssignPersonIdentitiesInput = {
  videoId: string;
  appearances: PersonAppearanceEvidence[];
  existingEvidence: PersonAppearanceEvidence[];
  people: Person[];
  differentPersonPairs: Array<{ leftPersonId: string; rightPersonId: string }>;
  policy?: PersonMatchPolicy;
};

export type AssignPersonIdentitiesResult = {
  appearances: PersonAppearanceEvidence[];
  people: Person[];
  decisions: PersonIdentityAssignmentDecision[];
};

type ModelPrototype = PersonPrototype & {
  embeddingModel: string;
};

function normalizedAverage(vectors: number[][]): number[] | undefined {
  const dimension = vectors[0]?.length;
  if (!dimension || vectors.some((vector) => vector.length !== dimension)) return undefined;
  const average = Array.from({ length: dimension }, (_, index) =>
    vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
  const norm = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) return undefined;
  return average.map((value) => value / norm);
}

function automaticPersonId(videoId: string, trackId: string, modelId: string): string {
  const digest = createHash("sha256")
    .update(`${modelId}\0${videoId}\0${trackId}`)
    .digest("hex")
    .slice(0, 20);
  return `person-auto-${digest}`;
}

function buildPrototypes(
  evidence: PersonAppearanceEvidence[],
  activePersonIds: Set<string>,
  minimumQuality: number,
): ModelPrototype[] {
  const groups = new Map<string, {
    personId: string;
    embeddingModel: string;
    vectors: number[][];
  }>();
  for (const appearance of evidence) {
    if (
      !appearance.personId
      || !activePersonIds.has(appearance.personId)
      || !appearance.embeddingModel
      || !appearance.embedding?.length
      || (appearance.embeddingQuality ?? 0) < minimumQuality
    ) {
      continue;
    }
    const key = `${appearance.embeddingModel}\0${appearance.personId}`;
    const group = groups.get(key) || {
      personId: appearance.personId,
      embeddingModel: appearance.embeddingModel,
      vectors: [],
    };
    group.vectors.push(appearance.embedding);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const embedding = normalizedAverage(group.vectors);
    return embedding
      ? [{
        personId: group.personId,
        embeddingModel: group.embeddingModel,
        embedding,
        sampleCount: group.vectors.length,
      }]
      : [];
  });
}

function updatePrototype(
  prototypes: ModelPrototype[],
  personId: string,
  embeddingModel: string,
  vector: number[],
): void {
  const existing = prototypes.find((prototype) =>
    prototype.personId === personId && prototype.embeddingModel === embeddingModel);
  if (!existing) {
    prototypes.push({
      personId,
      embeddingModel,
      embedding: vector,
      sampleCount: 1,
    });
    return;
  }
  const averaged = normalizedAverage([
    existing.embedding.map((value) => value * existing.sampleCount),
    vector,
  ]);
  if (averaged) existing.embedding = averaged;
  existing.sampleCount += 1;
}

/**
 * 给已完成单素材 tracking 的轨迹分配素材库级 personId。
 *
 * - 只比较同一 embedding 模型。
 * - 当前视频旧证据不进入跨视频原型，避免用自身历史结果证明自身。
 * - 达不到阈值或候选有歧义时创建新的自动人物，不污染已有身份。
 * - 无向量和低质量轨迹继续保持匿名。
 */
export function assignPersonIdentities(
  input: AssignPersonIdentitiesInput,
): AssignPersonIdentitiesResult {
  const policy = input.policy || SFACE_AUTO_IDENTITY_POLICY;
  const activePeople = input.people.filter((person) => person.status !== "merged");
  const activePersonIds = new Set(activePeople.map((person) => person.id));
  const prototypes = buildPrototypes(
    input.existingEvidence.filter((appearance) => appearance.videoId !== input.videoId),
    activePersonIds,
    policy.minimumQuality,
  );
  const oldTrackEvidence = new Map(
    input.existingEvidence
      .filter((appearance) => appearance.videoId === input.videoId && appearance.personId)
      .map((appearance) => [appearance.trackId, appearance]),
  );
  const blockedByPerson = new Map<string, Set<string>>();
  for (const pair of input.differentPersonPairs) {
    const left = blockedByPerson.get(pair.leftPersonId) || new Set<string>();
    const right = blockedByPerson.get(pair.rightPersonId) || new Set<string>();
    left.add(pair.rightPersonId);
    right.add(pair.leftPersonId);
    blockedByPerson.set(pair.leftPersonId, left);
    blockedByPerson.set(pair.rightPersonId, right);
  }

  const appearanceIndexesByTrack = new Map<string, number[]>();
  input.appearances.forEach((appearance, index) => {
    const indexes = appearanceIndexesByTrack.get(appearance.trackId) || [];
    indexes.push(index);
    appearanceIndexesByTrack.set(appearance.trackId, indexes);
  });
  const appearances = input.appearances.map((appearance) => ({ ...appearance }));
  const createdPeople = new Map<string, Person>();
  const decisions: PersonIdentityAssignmentDecision[] = [];

  for (const [trackId, indexes] of appearanceIndexesByTrack) {
    const trackAppearances = indexes.map((index) => appearances[index]);
    const manual = trackAppearances.find((appearance) =>
      appearance.manualLocked && appearance.personId);
    if (manual?.personId) {
      decisions.push({ trackId, personId: manual.personId, reason: "manual" });
      continue;
    }
    const embeddingModel = trackAppearances.find(
      (appearance) => appearance.embeddingModel,
    )?.embeddingModel;
    const embedding = normalizedAverage(
      trackAppearances
        .map((appearance) => appearance.embedding)
        .filter((vector): vector is number[] => Boolean(vector?.length)),
    );
    if (!embeddingModel || !embedding) {
      decisions.push({ trackId, reason: "missing_embedding" });
      continue;
    }
    const quality = trackAppearances.reduce(
      (sum, appearance) => sum + (appearance.embeddingQuality ?? 0),
      0,
    ) / trackAppearances.length;
    if (quality < policy.minimumQuality) {
      decisions.push({ trackId, reason: "low_quality" });
      continue;
    }

    const previous = oldTrackEvidence.get(trackId);
    const previousPersonId = previous?.personId;
    const previousEmbeddingMatches = previousPersonId
      && activePersonIds.has(previousPersonId)
      && previous.embeddingModel === embeddingModel
      && previous.embedding
      && (previous.embeddingQuality ?? 0) >= policy.minimumQuality
      && (cosineSimilarity(previous.embedding, embedding) ?? -1)
        >= policy.autoMergeThreshold;
    if (
      previousEmbeddingMatches
      && !prototypes.some((prototype) =>
        prototype.personId === previousPersonId
        && prototype.embeddingModel === embeddingModel)
    ) {
      updatePrototype(prototypes, previousPersonId, embeddingModel, previous!.embedding!);
    }

    const [match] = matchPersonObservations([{
      appearanceId: trackId,
      embedding,
      quality,
      blockedPersonIds: previousPersonId
        ? [...(blockedByPerson.get(previousPersonId) || [])]
        : [],
    }], prototypes.filter((prototype) => prototype.embeddingModel === embeddingModel), policy);

    let personId = match.personId;
    let reason: PersonIdentityAssignmentDecision["reason"] = "matched";
    let identityConfidence = match.similarity;
    if (!personId) {
      personId = automaticPersonId(input.videoId, trackId, embeddingModel);
      reason = "created";
      identityConfidence = 1;
      if (!activePersonIds.has(personId)) {
        createdPeople.set(personId, {
          id: personId,
          representativeThumbnailUrl: trackAppearances.find(
            (appearance) => appearance.thumbnailUrl,
          )?.thumbnailUrl,
          status: "auto",
        });
        activePersonIds.add(personId);
      }
    }
    for (const index of indexes) {
      appearances[index].personId = personId;
      appearances[index].identityConfidence = identityConfidence;
    }
    updatePrototype(prototypes, personId, embeddingModel, embedding);
    decisions.push({
      trackId,
      personId,
      similarity: match.similarity,
      runnerUpSimilarity: match.runnerUpSimilarity,
      reason,
    });
  }

  return {
    appearances,
    people: [...createdPeople.values()],
    decisions,
  };
}
