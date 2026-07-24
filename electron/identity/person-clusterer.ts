export type PersonPrototype = {
  personId: string;
  embedding: number[];
  sampleCount: number;
};

export type PersonObservation = {
  appearanceId: string;
  embedding: number[];
  quality: number;
  blockedPersonIds?: string[];
};

export type PersonMatchDecision = {
  appearanceId: string;
  personId?: string;
  similarity?: number;
  runnerUpSimilarity?: number;
  reason: "matched" | "low_quality" | "no_candidate" | "below_threshold" | "ambiguous";
};

export type PersonMatchPolicy = {
  minimumQuality: number;
  autoMergeThreshold: number;
  minimumMargin: number;
};

function normalized(vector: number[]): number[] | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return null;
    squaredNorm += value * value;
  }
  if (squaredNorm <= 0) return null;
  const norm = Math.sqrt(squaredNorm);
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  const left = normalized(a);
  const right = normalized(b);
  if (!left || !right) return null;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

/**
 * 只负责把新轨迹匹配到已存在的人物原型，不会自动创建或合并人物实体。
 *
 * 阈值必须由具体 embedding 模型和固定测试集标定；这里不提供看似通用、实际不可靠的默认值。
 * 达不到阈值或第一、第二候选差距太小时保持未知，避免错误合并污染后续所有素材。
 */
export function matchPersonObservations(
  observations: PersonObservation[],
  prototypes: PersonPrototype[],
  policy: PersonMatchPolicy,
): PersonMatchDecision[] {
  return observations.map((observation) => {
    if (observation.quality < policy.minimumQuality) {
      return { appearanceId: observation.appearanceId, reason: "low_quality" };
    }

    const blocked = new Set(observation.blockedPersonIds || []);
    const ranked = prototypes
      .filter((prototype) => !blocked.has(prototype.personId))
      .map((prototype) => ({
        personId: prototype.personId,
        similarity: cosineSimilarity(observation.embedding, prototype.embedding),
      }))
      .filter((candidate): candidate is { personId: string; similarity: number } =>
        candidate.similarity != null)
      .sort((a, b) => b.similarity - a.similarity || a.personId.localeCompare(b.personId));

    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best) {
      return { appearanceId: observation.appearanceId, reason: "no_candidate" };
    }
    if (best.similarity < policy.autoMergeThreshold) {
      return {
        appearanceId: observation.appearanceId,
        similarity: best.similarity,
        runnerUpSimilarity: runnerUp?.similarity,
        reason: "below_threshold",
      };
    }
    if (runnerUp && best.similarity - runnerUp.similarity < policy.minimumMargin) {
      return {
        appearanceId: observation.appearanceId,
        similarity: best.similarity,
        runnerUpSimilarity: runnerUp.similarity,
        reason: "ambiguous",
      };
    }
    return {
      appearanceId: observation.appearanceId,
      personId: best.personId,
      similarity: best.similarity,
      runnerUpSimilarity: runnerUp?.similarity,
      reason: "matched",
    };
  });
}
