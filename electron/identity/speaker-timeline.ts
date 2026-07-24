import type { SpeakerTrack } from "../../src/types";
import type { SpeakerDiarizationSegment } from "./speaker-diarization-provider";

type TranscriptWord = {
  text?: string;
  word?: string;
  start?: number;
  end?: number;
  confidence?: number;
  speakerId?: string;
};

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  speakerId?: string;
  words?: TranscriptWord[];
  [key: string]: unknown;
};

export type SpeakerAnnotatedTranscript = {
  segments: TranscriptSegment[];
  [key: string]: unknown;
};

export type BuildSpeakerTimelineResult = {
  speakerTracks: SpeakerTrack[];
  transcript: SpeakerAnnotatedTranscript | null;
  speakerCount: number;
};

const NEUTRAL_PROVIDER_CONFIDENCE = 0.5;

function overlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function normalizeSegments(segments: SpeakerDiarizationSegment[]) {
  return segments
    .filter((segment) => (
      Number.isInteger(segment.speakerIndex)
      && segment.speakerIndex >= 0
      && Number.isFinite(segment.startSec)
      && Number.isFinite(segment.endSec)
      && segment.startSec >= 0
      && segment.endSec > segment.startSec
    ))
    .sort((left, right) => (
      left.startSec - right.startSec
      || left.endSec - right.endSec
      || left.speakerIndex - right.speakerIndex
    ));
}

function chooseSpeaker(
  startSec: number,
  endSec: number,
  tracks: SpeakerTrack[],
  policy: { minimumCoverage: number; minimumDominance: number; minimumMargin: number },
): string | undefined {
  const duration = endSec - startSec;
  if (!(duration > 0)) return undefined;
  const bySpeaker = new Map<string, number>();
  for (const track of tracks) {
    const seconds = overlap(startSec, endSec, track.startSec, track.endSec);
    if (seconds > 0) {
      bySpeaker.set(track.speakerId, (bySpeaker.get(track.speakerId) || 0) + seconds);
    }
  }
  const ranked = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return undefined;
  const total = ranked.reduce((sum, entry) => sum + entry[1], 0);
  const top = ranked[0][1];
  const second = ranked[1]?.[1] || 0;
  if (Math.min(1, total / duration) < policy.minimumCoverage) return undefined;
  if (top / total < policy.minimumDominance) return undefined;
  if ((top - second) / total < policy.minimumMargin) return undefined;
  return ranked[0][0];
}

function transcriptTextForRange(
  startSec: number,
  endSec: number,
  transcript: SpeakerAnnotatedTranscript | null,
): string | undefined {
  if (!transcript) return undefined;
  const text = transcript.segments
    .filter((segment) => overlap(startSec, endSec, segment.start, segment.end) > 0)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ");
  return text || undefined;
}

export function buildSpeakerTimeline(input: {
  videoId: string;
  segments: SpeakerDiarizationSegment[];
  transcript?: SpeakerAnnotatedTranscript | null;
}): BuildSpeakerTimelineResult {
  if (!input.videoId) throw new Error("说话人时间轴缺少 videoId");
  const segments = normalizeSegments(input.segments);
  const speakerOrder = new Map<number, number>();
  for (const segment of segments) {
    if (!speakerOrder.has(segment.speakerIndex)) {
      speakerOrder.set(segment.speakerIndex, speakerOrder.size + 1);
    }
  }

  const now = new Date().toISOString();
  const speakerTracks: SpeakerTrack[] = segments.map((segment, index) => {
    const ordinal = speakerOrder.get(segment.speakerIndex);
    const speakerId = `${input.videoId}:speaker:${ordinal}`;
    return {
      id: `${input.videoId}:speaker-track:${index + 1}`,
      videoId: input.videoId,
      speakerId,
      startSec: segment.startSec,
      endSec: segment.endSec,
      // Sherpa 当前不返回逐段置信度；0.5 是明确的中性占位，不参与自动人物关联。
      confidence: NEUTRAL_PROVIDER_CONFIDENCE,
      transcriptText: transcriptTextForRange(
        segment.startSec,
        segment.endSec,
        input.transcript || null,
      ),
      manualLocked: false,
      createdAt: now,
      updatedAt: now,
    };
  });

  const transcript = input.transcript
    ? {
        ...input.transcript,
        segments: input.transcript.segments.map((segment) => {
          const speakerId = chooseSpeaker(segment.start, segment.end, speakerTracks, {
            minimumCoverage: 0.35,
            minimumDominance: 0.75,
            minimumMargin: 0.25,
          });
          const words = Array.isArray(segment.words)
            ? segment.words.map((word) => {
                const start = Number(word.start);
                const end = Number(word.end);
                if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
                  return { ...word, speakerId: undefined };
                }
                return {
                  ...word,
                  speakerId: chooseSpeaker(start, end, speakerTracks, {
                    minimumCoverage: 0.5,
                    minimumDominance: 0.7,
                    minimumMargin: 0.2,
                  }),
                };
              })
            : segment.words;
          return {
            ...segment,
            speakerId,
            ...(words ? { words } : {}),
          };
        }),
      }
    : null;

  return {
    speakerTracks,
    transcript,
    speakerCount: speakerOrder.size,
  };
}
