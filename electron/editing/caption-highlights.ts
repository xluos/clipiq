import type {
  CaptionCue,
  VideoClip,
  VideoClipSubtitleEvidence,
} from "../../src/types";

type CaptionHighlight = NonNullable<CaptionCue["highlights"]>[number];

function normalizeKeyword(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0;
  const previous = new Array(right.length + 1).fill(0);
  let best = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        previous[rightIndex] = diagonal + 1;
        best = Math.max(best, previous[rightIndex]);
      } else {
        previous[rightIndex] = 0;
      }
      diagonal = above;
    }
  }
  return best;
}

function sequentialWordOffsets(cue: CaptionCue): Array<{
  text: string;
  startOffset: number;
  endOffset: number;
  startUs: number;
  endUs: number;
  confidence: number;
}> {
  const offsets = [];
  let cursor = 0;
  for (const word of cue.wordTimings || []) {
    const text = word.text.trim();
    if (!text) continue;
    const startOffset = cue.text.indexOf(text, cursor);
    if (startOffset < 0) continue;
    const endOffset = startOffset + text.length;
    offsets.push({
      text,
      startOffset,
      endOffset,
      startUs: word.startUs,
      endUs: word.endUs,
      confidence: Number.isFinite(word.confidence)
        ? Math.max(0, Math.min(1, Number(word.confidence)))
        : 0.75,
    });
    cursor = endOffset;
  }
  return offsets;
}

export function deriveCaptionHighlights(
  cue: CaptionCue,
  eventSummaries: string[],
  maximumCount = 2,
): CaptionHighlight[] {
  if (!(cue.wordTimings?.length && maximumCount > 0)) return [];
  const normalizedEvents = eventSummaries
    .map(normalizeKeyword)
    .filter(Boolean);
  const candidates = sequentialWordOffsets(cue).flatMap((word) => {
    const normalized = normalizeKeyword(word.text);
    if (!normalized) return [];
    const numeric = /(?:\p{N}|百分之|第[一二三四五六七八九十百千万])/u.test(normalized);
    const eventMatchLength = normalizedEvents.reduce(
      (best, event) => Math.max(
        best,
        longestCommonSubstringLength(normalized, event),
      ),
      0,
    );
    const eventMatchRatio = eventMatchLength / normalized.length;
    const eventKeyword = normalized.length >= 2
      && eventMatchLength >= 2
      && eventMatchRatio >= 0.4;
    if (!numeric && !eventKeyword) return [];
    const reason: CaptionHighlight["reason"] = numeric ? "number" : "event_keyword";
    const semanticConfidence = numeric
      ? 0.95
      : Math.min(0.95, 0.65 + eventMatchRatio * 0.3);
    return [{
      ...word,
      reason,
      confidence: Number((semanticConfidence * word.confidence).toFixed(4)),
      score: semanticConfidence * word.confidence,
    }];
  });

  return candidates
    .sort((left, right) =>
      right.score - left.score || left.startOffset - right.startOffset)
    .slice(0, maximumCount)
    .sort((left, right) => left.startOffset - right.startOffset)
    .map(({ score: _score, ...highlight }) => highlight);
}

export function captionEventSummaries(clip: VideoClip): string[] {
  return [
    ...(clip.evidence?.eventSegments || []).map((event) => event.summary),
    clip.evidence?.eventSummary || "",
  ].filter(Boolean);
}

export function captionCueFromEvidenceSegment(
  clip: VideoClip,
  segment: VideoClipSubtitleEvidence,
  index: number,
  options: {
    id?: string;
    styleId?: string;
  } = {},
): CaptionCue | null {
  const text = segment.text.trim();
  const sourceStartUs = Math.max(clip.sourceInUs, segment.startUs);
  const sourceEndUs = Math.min(clip.sourceOutUs, segment.endUs);
  if (!text || sourceEndUs <= sourceStartUs) return null;
  const startUs = clip.timelineInUs
    + Math.round((sourceStartUs - clip.sourceInUs) / clip.speed);
  const endUs = clip.timelineInUs
    + Math.round((sourceEndUs - clip.sourceInUs) / clip.speed);
  if (endUs <= startUs) return null;
  const wordTimings = (segment.words || []).flatMap((word) => {
    const wordStartUs = Math.max(sourceStartUs, word.startUs);
    const wordEndUs = Math.min(sourceEndUs, word.endUs);
    const wordText = word.text.trim();
    if (!wordText || wordEndUs <= wordStartUs) return [];
    return [{
      text: wordText,
      startUs: clip.timelineInUs
        + Math.round((wordStartUs - clip.sourceInUs) / clip.speed),
      endUs: clip.timelineInUs
        + Math.round((wordEndUs - clip.sourceInUs) / clip.speed),
      ...(Number.isFinite(word.confidence)
        ? { confidence: Number(word.confidence) }
        : {}),
      ...(word.speakerId ? { speakerId: word.speakerId } : {}),
    }];
  });
  const cue: CaptionCue = {
    id: options.id || `${clip.id}-caption-${index + 1}`,
    startUs,
    endUs,
    text,
    styleId: options.styleId || "proxy-default",
    sourceClipId: clip.id,
    sourceStartUs,
    sourceEndUs,
    ...(wordTimings.length > 0 ? { wordTimings } : {}),
  };
  const highlights = deriveCaptionHighlights(cue, captionEventSummaries(clip));
  return highlights.length > 0 ? { ...cue, highlights } : cue;
}
