import type {
  VideoClipEvidence,
  VideoClipEvidenceSegment,
  VideoClipPersonEvidence,
  VideoClipSpeakerEvidence,
  VideoClipSubtitleEvidence,
} from "../../src/types";

export type BuildAlignedEvidenceSegmentsInput = {
  startUs: number;
  endUs: number;
  eventSummary?: string;
  transcriptGranularity?: "segment" | "word";
  subtitleSegments?: VideoClipSubtitleEvidence[];
  personAppearances?: VideoClipPersonEvidence[];
  speakerTracks?: VideoClipSpeakerEvidence[];
};

function validRange(startUs: number, endUs: number): boolean {
  return Number.isSafeInteger(startUs)
    && Number.isSafeInteger(endUs)
    && startUs >= 0
    && endUs > startUs;
}

function overlaps(
  item: { startUs: number; endUs: number },
  startUs: number,
  endUs: number,
): boolean {
  return item.startUs < endUs && item.endUs > startUs;
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function segmentPayload(segment: VideoClipEvidenceSegment): string {
  return JSON.stringify({
    eventSummary: segment.eventSummary,
    eventGranularity: segment.eventGranularity,
    subtitleText: segment.subtitleText,
    transcriptGranularity: segment.transcriptGranularity,
    visiblePeople: segment.visiblePeople,
    activeSpeakers: segment.activeSpeakers,
  });
}

function activePeople(
  appearances: VideoClipPersonEvidence[],
  startUs: number,
  endUs: number,
): VideoClipEvidenceSegment["visiblePeople"] {
  const selected = new Map<string, VideoClipEvidenceSegment["visiblePeople"][number]>();
  for (const appearance of appearances) {
    if (!overlaps(appearance, startUs, endUs)) continue;
    const key = `${appearance.personId || ""}:${appearance.trackId}`;
    const value = {
      appearanceId: appearance.appearanceId,
      trackId: appearance.trackId,
      ...(appearance.personId ? { personId: appearance.personId } : {}),
    };
    const previous = selected.get(key);
    if (!previous || value.appearanceId.localeCompare(previous.appearanceId) < 0) {
      selected.set(key, value);
    }
  }
  return [...selected.values()].sort((left, right) =>
    (left.personId || "").localeCompare(right.personId || "")
    || left.trackId.localeCompare(right.trackId)
    || left.appearanceId.localeCompare(right.appearanceId));
}

function activeSpeakers(
  tracks: VideoClipSpeakerEvidence[],
  startUs: number,
  endUs: number,
): VideoClipEvidenceSegment["activeSpeakers"] {
  const selected = new Map<string, VideoClipEvidenceSegment["activeSpeakers"][number]>();
  for (const track of tracks) {
    if (!overlaps(track, startUs, endUs)) continue;
    const key = `${track.speakerId}:${track.personId || ""}`;
    const value = {
      trackId: track.trackId,
      speakerId: track.speakerId,
      ...(track.personId ? { personId: track.personId } : {}),
    };
    const previous = selected.get(key);
    if (!previous || value.trackId.localeCompare(previous.trackId) < 0) {
      selected.set(key, value);
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.speakerId.localeCompare(right.speakerId)
    || (left.personId || "").localeCompare(right.personId || "")
    || left.trackId.localeCompare(right.trackId));
}

export function buildAlignedEvidenceSegments(
  input: BuildAlignedEvidenceSegmentsInput,
): VideoClipEvidenceSegment[] {
  if (!validRange(input.startUs, input.endUs)) {
    throw new Error("素材证据时间范围无效");
  }
  const subtitles = (input.subtitleSegments || []).filter((segment) =>
    validRange(segment.startUs, segment.endUs)
    && overlaps(segment, input.startUs, input.endUs));
  const appearances = (input.personAppearances || []).filter((appearance) =>
    validRange(appearance.startUs, appearance.endUs)
    && overlaps(appearance, input.startUs, input.endUs));
  const speakers = (input.speakerTracks || []).filter((track) =>
    validRange(track.startUs, track.endUs)
    && overlaps(track, input.startUs, input.endUs));
  const boundaries = sortedUnique([
    input.startUs,
    input.endUs,
    ...subtitles.flatMap((segment) => [
      Math.max(input.startUs, segment.startUs),
      Math.min(input.endUs, segment.endUs),
    ]),
    ...appearances.flatMap((appearance) => [
      Math.max(input.startUs, appearance.startUs),
      Math.min(input.endUs, appearance.endUs),
    ]),
    ...speakers.flatMap((track) => [
      Math.max(input.startUs, track.startUs),
      Math.min(input.endUs, track.endUs),
    ]),
  ]);

  const atomicSegments: VideoClipEvidenceSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startUs = boundaries[index];
    const endUs = boundaries[index + 1];
    if (endUs <= startUs) continue;
    const activeSubtitles = subtitles
      .filter((segment) => overlaps(segment, startUs, endUs))
      .sort((left, right) =>
        left.startUs - right.startUs
        || left.endUs - right.endUs
        || left.text.localeCompare(right.text));
    const subtitleText = [...new Set(
      activeSubtitles.map((segment) => segment.text.trim()).filter(Boolean),
    )].join(" / ");
    atomicSegments.push({
      startUs,
      endUs,
      ...(input.eventSummary?.trim()
        ? { eventSummary: input.eventSummary.trim(), eventGranularity: "shot" as const }
        : {}),
      ...(subtitleText ? { subtitleText } : {}),
      ...(subtitleText && input.transcriptGranularity
        ? { transcriptGranularity: input.transcriptGranularity }
        : {}),
      visiblePeople: activePeople(appearances, startUs, endUs),
      activeSpeakers: activeSpeakers(speakers, startUs, endUs),
    });
  }

  const merged: VideoClipEvidenceSegment[] = [];
  for (const segment of atomicSegments) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.endUs === segment.startUs
      && segmentPayload(previous) === segmentPayload(segment)
    ) {
      previous.endUs = segment.endUs;
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

export function clipVideoEvidenceToRange(
  evidence: VideoClipEvidence,
  startUs: number,
  endUs: number,
): VideoClipEvidence {
  if (!validRange(startUs, endUs)) {
    throw new Error("裁切后的素材证据时间范围无效");
  }
  const subtitleSegments = (evidence.subtitleSegments || []).flatMap((segment) => {
    if (!validRange(segment.startUs, segment.endUs) || !overlaps(segment, startUs, endUs)) {
      return [];
    }
    const clippedStartUs = Math.max(startUs, segment.startUs);
    const clippedEndUs = Math.min(endUs, segment.endUs);
    const words = (segment.words || []).filter((word) =>
      validRange(word.startUs, word.endUs)
      && word.startUs >= clippedStartUs
      && word.endUs <= clippedEndUs);
    return [{
      ...segment,
      startUs: clippedStartUs,
      endUs: clippedEndUs,
      text: words.length
        ? words.map((word) => word.text).join("").trim()
        : segment.text,
      ...(words.length ? { words } : { words: undefined }),
    }];
  });
  const personAppearances = (evidence.personAppearances || []).flatMap((appearance) =>
    validRange(appearance.startUs, appearance.endUs)
    && overlaps(appearance, startUs, endUs)
      ? [{
        ...appearance,
        startUs: Math.max(startUs, appearance.startUs),
        endUs: Math.min(endUs, appearance.endUs),
      }]
      : []);
  const speakerTracks = (evidence.speakerTracks || []).flatMap((track) =>
    validRange(track.startUs, track.endUs)
    && overlaps(track, startUs, endUs)
      ? [{
        ...track,
        startUs: Math.max(startUs, track.startUs),
        endUs: Math.min(endUs, track.endUs),
      }]
      : []);
  const personIds = [...new Set(personAppearances
    .map((appearance) => appearance.personId)
    .filter((personId): personId is string => Boolean(personId)))].sort();
  const speakerIds = [...new Set(speakerTracks.map((track) => track.speakerId))].sort();
  const transcriptGranularity = subtitleSegments.length
    ? evidence.transcriptGranularity
    : undefined;
  return {
    ...(evidence.eventSummary ? { eventSummary: evidence.eventSummary } : {}),
    ...(transcriptGranularity ? { transcriptGranularity } : {}),
    ...(subtitleSegments.length ? { subtitleSegments } : {}),
    ...(personAppearances.length ? { personAppearances } : {}),
    ...(speakerTracks.length ? { speakerTracks } : {}),
    ...(personIds.length ? { personIds } : {}),
    ...(speakerIds.length ? { speakerIds } : {}),
    alignedSegments: buildAlignedEvidenceSegments({
      startUs,
      endUs,
      eventSummary: evidence.eventSummary,
      transcriptGranularity,
      subtitleSegments,
      personAppearances,
      speakerTracks,
    }),
  };
}
