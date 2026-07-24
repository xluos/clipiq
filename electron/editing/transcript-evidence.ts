import type { ShotTranscriptSegment } from "../../src/types";

const MAX_ALIGNMENT_CHARACTERS = 500;
export const MINIMUM_WORD_TIMING_TEXT_COVERAGE = 0.9;

function alignmentText(value: unknown): string[] {
  return Array.from(
    String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, "")
      .slice(0, MAX_ALIGNMENT_CHARACTERS),
  );
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const previous = new Uint16Array(right.length + 1);
  const current = new Uint16Array(right.length + 1);
  for (const leftCharacter of left) {
    current.fill(0);
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftCharacter === right[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous.set(current);
  }
  return previous[right.length];
}

export function wordTimingTextCoverage(
  segment: Pick<ShotTranscriptSegment, "text" | "words">,
): number {
  const transcript = alignmentText(segment.text);
  const timedWords = alignmentText((segment.words || []).map((word) => word.text).join(""));
  if (transcript.length === 0 || timedWords.length === 0) return 0;
  const matched = longestCommonSubsequenceLength(transcript, timedWords);
  return Math.round((matched / transcript.length) * 10_000) / 10_000;
}

export function hasUsableWordTimings(
  segment: ShotTranscriptSegment,
  minimumCoverage = MINIMUM_WORD_TIMING_TEXT_COVERAGE,
): boolean {
  const words = segment.words || [];
  return words.length > 0
    && words.every((word) =>
      Number.isFinite(word.startSec)
      && Number.isFinite(word.endSec)
      && word.startSec >= segment.startSec
      && word.endSec <= segment.endSec
      && word.endSec > word.startSec
      && Boolean(String(word.text || "").trim()))
    && wordTimingTextCoverage(segment) >= minimumCoverage;
}
