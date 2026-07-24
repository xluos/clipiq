import type { VideoClipEvidenceSegment } from "../../src/types";

export const DEFAULT_CANDIDATE_WINDOW_MAX_DURATION_US = 6_000_000;
export const DEFAULT_CANDIDATE_WINDOW_MIN_DURATION_US = 800_000;

export type CandidateWindow = {
  candidateId: string;
  startUs: number;
  endUs: number;
  boundaryReason: "shot" | "evidence" | "duration";
};

export type BuildCandidateWindowsOptions = {
  maximumDurationUs?: number;
  minimumDurationUs?: number;
};

function validIntegerTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function candidateIdForShotWindow(
  shotId: string,
  startUs: number,
  endUs: number,
): string {
  if (!shotId || !validIntegerTime(startUs) || !validIntegerTime(endUs) || endUs <= startUs) {
    throw new Error("候选窗口标识参数无效");
  }
  return `${shotId}::${startUs}-${endUs}`;
}

export function buildCandidateWindows(
  shotId: string,
  shotStartUs: number,
  shotEndUs: number,
  alignedSegments: VideoClipEvidenceSegment[],
  options: BuildCandidateWindowsOptions = {},
): CandidateWindow[] {
  if (
    !shotId
    || !validIntegerTime(shotStartUs)
    || !validIntegerTime(shotEndUs)
    || shotEndUs <= shotStartUs
  ) {
    throw new Error("Shot 候选窗口时间范围无效");
  }
  const maximumDurationUs = Math.max(
    1,
    Math.round(options.maximumDurationUs ?? DEFAULT_CANDIDATE_WINDOW_MAX_DURATION_US),
  );
  const minimumDurationUs = Math.min(
    maximumDurationUs,
    Math.max(
      1,
      Math.round(options.minimumDurationUs ?? DEFAULT_CANDIDATE_WINDOW_MIN_DURATION_US),
    ),
  );
  if (!validIntegerTime(maximumDurationUs) || !validIntegerTime(minimumDurationUs)) {
    throw new Error("候选窗口时长参数无效");
  }
  const evidenceBoundaries = [...new Set(
    alignedSegments.flatMap((segment) => [segment.startUs, segment.endUs])
      .filter((value) =>
        validIntegerTime(value)
        && value > shotStartUs
        && value < shotEndUs),
  )].sort((left, right) => left - right);

  const windows: CandidateWindow[] = [];
  let startUs = shotStartUs;
  while (startUs < shotEndUs) {
    const remainingUs = shotEndUs - startUs;
    if (remainingUs <= maximumDurationUs) {
      windows.push({
        candidateId: candidateIdForShotWindow(shotId, startUs, shotEndUs),
        startUs,
        endUs: shotEndUs,
        boundaryReason: windows.length === 0 ? "shot" : "duration",
      });
      break;
    }

    const hardEndUs = startUs + maximumDurationUs;
    const usableEvidenceBoundaries = evidenceBoundaries.filter((boundaryUs) =>
      boundaryUs >= startUs + minimumDurationUs
      && boundaryUs <= hardEndUs
      && shotEndUs - boundaryUs >= minimumDurationUs);
    let endUs = usableEvidenceBoundaries.at(-1) ?? hardEndUs;
    let boundaryReason: CandidateWindow["boundaryReason"] =
      usableEvidenceBoundaries.length > 0 ? "evidence" : "duration";

    if (shotEndUs - endUs < minimumDurationUs) {
      endUs = shotEndUs - minimumDurationUs;
      boundaryReason = "duration";
    }
    if (endUs <= startUs) {
      throw new Error("候选窗口无法取得有效进展");
    }
    windows.push({
      candidateId: candidateIdForShotWindow(shotId, startUs, endUs),
      startUs,
      endUs,
      boundaryReason,
    });
    startUs = endUs;
  }
  return windows;
}
