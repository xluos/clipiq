import type { Shot } from "../../src/types";

export type PersonFrameSample = {
  sampleIndex: number;
  shotId: string;
  timeSec: number;
  evidenceStartSec: number;
  evidenceEndSec: number;
};

export type PersonFrameSamplePlan = {
  samples: PersonFrameSample[];
  intervalSec: number;
  totalEligibleDurationSec: number;
  downsampled: boolean;
};

export type PersonFrameSamplePolicy = {
  baseIntervalSec: number;
  maxFrames: number;
  minimumWindowSec: number;
};

export const DEFAULT_PERSON_FRAME_SAMPLE_POLICY: PersonFrameSamplePolicy = {
  baseIntervalSec: 1,
  maxFrames: 900,
  minimumWindowSec: 0.04,
};

function validShot(shot: Shot): boolean {
  return Boolean(
    shot.id
    && Number.isFinite(shot.startSec)
    && Number.isFinite(shot.endSec)
    && shot.startSec >= 0
    && shot.endSec > shot.startSec,
  );
}

function downsampleEvenly<T>(items: T[], maximum: number): T[] {
  if (items.length <= maximum) return items;
  if (maximum <= 1) return items.slice(0, Math.max(0, maximum));
  const selected: T[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (items.length - 1) / (maximum - 1));
    selected.push(items[sourceIndex]);
  }
  return selected;
}

export function buildPersonFrameSamplePlan(
  inputShots: Shot[],
  inputPolicy: Partial<PersonFrameSamplePolicy> = {},
): PersonFrameSamplePlan {
  const policy = { ...DEFAULT_PERSON_FRAME_SAMPLE_POLICY, ...inputPolicy };
  if (
    !(policy.baseIntervalSec > 0)
    || !Number.isInteger(policy.maxFrames)
    || policy.maxFrames <= 0
    || !(policy.minimumWindowSec > 0)
  ) {
    throw new Error("人物抽帧策略无效");
  }

  const shots = inputShots
    .filter(validShot)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const totalEligibleDurationSec = shots.reduce(
    (sum, shot) => sum + shot.endSec - shot.startSec,
    0,
  );
  const intervalSec = Math.max(
    policy.baseIntervalSec,
    totalEligibleDurationSec / policy.maxFrames,
  );
  const candidates: Omit<PersonFrameSample, "sampleIndex">[] = [];

  for (const shot of shots) {
    for (
      let windowStart = shot.startSec;
      windowStart < shot.endSec;
      windowStart += intervalSec
    ) {
      const windowEnd = Math.min(shot.endSec, windowStart + intervalSec);
      if (windowEnd - windowStart < policy.minimumWindowSec) continue;
      candidates.push({
        shotId: shot.id,
        timeSec: (windowStart + windowEnd) / 2,
        evidenceStartSec: windowStart,
        evidenceEndSec: windowEnd,
      });
    }
  }

  const selected = downsampleEvenly(candidates, policy.maxFrames);
  return {
    samples: selected.map((sample, sampleIndex) => ({ ...sample, sampleIndex })),
    intervalSec,
    totalEligibleDurationSec,
    downsampled: selected.length < candidates.length,
  };
}
