import type { IdentityEvidenceBatch } from "../repositories/identity-repository";
import type { PersonAppearance } from "../../src/types";
import {
  validateSpeakerDiarizationProviderForUse,
  type SpeakerDiarizationProvider,
  type SpeakerDiarizationUsePolicy,
} from "./speaker-diarization-provider";
import {
  buildSpeakerTimeline,
  type SpeakerAnnotatedTranscript,
} from "./speaker-timeline";
import {
  linkSpeakerTracksToPeople,
  type SpeakerPersonLinkDecision,
} from "./speaker-person-linker";

export type SpeakerDiarizationRepository = {
  replaceEvidenceForVideo(videoId: string, batch: IdentityEvidenceBatch): void;
  listAppearances?(videoId?: string): PersonAppearance[];
};

export type SpeakerDiarizationResult = {
  status: "completed" | "unavailable";
  videoId: string;
  speakerCount: number;
  trackCount: number;
  linkedTrackCount: number;
  linkDecisions: SpeakerPersonLinkDecision[];
  transcript: SpeakerAnnotatedTranscript | null;
  reason?: string;
};

export async function runSpeakerDiarization(input: {
  videoId: string;
  wavPath: string;
  transcript?: SpeakerAnnotatedTranscript | null;
  provider: SpeakerDiarizationProvider;
  repository: SpeakerDiarizationRepository;
  usePolicy: SpeakerDiarizationUsePolicy;
  signal?: AbortSignal;
}): Promise<SpeakerDiarizationResult> {
  if (!input.videoId) throw new Error("说话人识别缺少 videoId");
  if (!input.wavPath) throw new Error("说话人识别缺少音频路径");
  const issues = validateSpeakerDiarizationProviderForUse(
    input.provider.descriptor,
    input.usePolicy,
  );
  if (issues.length > 0) throw new Error(issues.join("；"));

  const readiness = await input.provider.getReadiness();
  if (readiness.ready === false) {
    return {
      status: "unavailable",
      videoId: input.videoId,
      speakerCount: 0,
      trackCount: 0,
      linkedTrackCount: 0,
      linkDecisions: [],
      transcript: input.transcript || null,
      reason: readiness.reason,
    };
  }

  const segments = await input.provider.diarize(input.wavPath, {
    signal: input.signal,
  });
  const timeline = buildSpeakerTimeline({
    videoId: input.videoId,
    segments,
    transcript: input.transcript,
  });
  const linked = linkSpeakerTracksToPeople({
    speakerTracks: timeline.speakerTracks,
    appearances: input.repository.listAppearances?.(input.videoId) || [],
  });
  input.repository.replaceEvidenceForVideo(input.videoId, {
    speakerTracks: linked.speakerTracks,
  });
  return {
    status: "completed",
    videoId: input.videoId,
    speakerCount: timeline.speakerCount,
    trackCount: timeline.speakerTracks.length,
    linkedTrackCount: linked.linkedTrackCount,
    linkDecisions: linked.decisions,
    transcript: timeline.transcript,
  };
}
