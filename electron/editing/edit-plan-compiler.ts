import { createHash } from "node:crypto";
import type {
  AnalysisEvidenceQualityReport,
  CaptionCue,
  EditPlan,
  EditPlanIssue,
  PersonAppearance,
  Shot,
  SpeakerTrack,
  VideoClip,
} from "../../src/types";
import type { PlannerVoiceover } from "./vlog-planner";
import { buildAlignedEvidenceSegments } from "./aligned-evidence";
import {
  validateEditPlan,
  type EditPlanValidationOptions,
  type ShotValidationSource,
} from "./edit-plan-validator";
import { hasUsableWordTimings } from "./transcript-evidence";
import { personAwareCrop } from "./smart-reframe";

export type PlannerShotSelection = {
  shotId: string;
  intent: string;
  confidence: number;
};

export type EditPlanShotSource = {
  shot: Shot;
  videoId: string;
  sourcePath: string;
  sourceWidth?: number;
  sourceHeight?: number;
  appearances?: PersonAppearance[];
  speakerTracks?: SpeakerTrack[];
};

export type CompileEditPlanOptions = {
  planId: string;
  sessionId: string;
  targetDurationUs: number;
  canvas: EditPlan["canvas"];
  goal: string;
  methodologyIds?: string[];
  generatedAt: number;
  plannerProvider?: string;
  plannerModel?: string;
  evidenceQuality?: AnalysisEvidenceQualityReport;
  maxClipDurationUs?: number;
  minimumIdentityConfidence?: number;
  voiceovers?: PlannerVoiceover[];
  sourceExists?: EditPlanValidationOptions["sourceExists"];
};

const US_PER_SECOND = 1_000_000;

function secondsToUs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * US_PER_SECOND);
  return Number.isSafeInteger(result) ? result : null;
}

function stablePlannerDigest(
  selections: PlannerShotSelection[],
  sources: EditPlanShotSource[],
  options: CompileEditPlanOptions,
): string {
  const evidenceQuality = options.evidenceQuality
    ? { ...options.evidenceQuality, generatedAt: 0 }
    : null;
  const canonical = {
    goal: options.goal,
    targetDurationUs: options.targetDurationUs,
    canvas: options.canvas,
    methodologyIds: [...new Set(options.methodologyIds || [])].sort(),
    minimumIdentityConfidence: options.minimumIdentityConfidence,
    evidenceQuality,
    selections,
    voiceovers: options.voiceovers || [],
    sources: sources
      .map((source) => ({
        shotId: source.shot.id,
        videoId: source.videoId,
        sourcePath: source.sourcePath,
        startSec: source.shot.startSec,
        endSec: source.shot.endSec,
        description: source.shot.description,
        usageTags: [...new Set(source.shot.usageTags || [])].sort(),
        subtitleSegments: (source.shot.subtitleSegments || [])
          .map((segment) => ({
            startSec: segment.startSec,
            endSec: segment.endSec,
            text: segment.text,
            speakerId: segment.speakerId,
            words: (segment.words || []).map((word) => ({
              text: word.text,
              startSec: word.startSec,
              endSec: word.endSec,
              confidence: word.confidence,
              speakerId: word.speakerId,
            })),
          }))
          .sort((left, right) =>
            left.startSec - right.startSec
            || left.endSec - right.endSec
            || left.text.localeCompare(right.text)),
        sourceWidth: source.sourceWidth,
        sourceHeight: source.sourceHeight,
        appearances: (source.appearances || [])
          .filter((appearance) => appearance.videoId === source.videoId)
          .map((appearance) => ({
            id: appearance.id,
            videoId: appearance.videoId,
            trackId: appearance.trackId,
            personId: appearance.personId,
            startSec: appearance.startSec,
            endSec: appearance.endSec,
            confidence: appearance.confidence,
            identityConfidence: appearance.identityConfidence,
            manualLocked: appearance.manualLocked,
            focusBounds: appearance.focusBounds,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        speakerTracks: (source.speakerTracks || [])
          .filter((track) => track.videoId === source.videoId)
          .map((track) => ({
            id: track.id,
            videoId: track.videoId,
            speakerId: track.speakerId,
            personId: track.personId,
            startSec: track.startSec,
            endSec: track.endSec,
            confidence: track.confidence,
            linkConfidence: track.linkConfidence,
            manualLocked: track.manualLocked,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.shotId.localeCompare(b.shotId)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function overlaps(
  startUs: number,
  endUs: number,
  itemStartSec: number,
  itemEndSec: number,
): boolean {
  const itemStartUs = secondsToUs(itemStartSec);
  const itemEndUs = secondsToUs(itemEndSec);
  return itemStartUs != null
    && itemEndUs != null
    && itemStartUs < endUs
    && itemEndUs > startUs;
}

function buildEvidence(
  source: EditPlanShotSource,
  sourceInUs: number,
  sourceOutUs: number,
  minimumIdentityConfidence?: number,
): VideoClip["evidence"] {
  const subtitleSegments = (source.shot.subtitleSegments || [])
    .map((segment) => ({
      startUs: secondsToUs(segment.startSec),
      endUs: secondsToUs(segment.endSec),
      text: segment.text,
      speakerId: segment.speakerId,
      wordTimingUsable: hasUsableWordTimings(segment),
      words: (segment.words || [])
        .map((word) => ({
          text: String(word.text || "").trim(),
          startUs: secondsToUs(word.startSec),
          endUs: secondsToUs(word.endSec),
          ...(word.speakerId ? { speakerId: word.speakerId } : {}),
          ...(Number.isFinite(word.confidence)
            ? { confidence: Number(word.confidence) }
            : {}),
        }))
        .filter((word): word is {
          text: string;
          startUs: number;
          endUs: number;
          confidence?: number;
          speakerId?: string;
        } =>
          word.startUs != null
          && word.endUs != null
          && word.endUs > word.startUs
          && word.startUs >= sourceInUs
          && word.endUs <= sourceOutUs
          && Boolean(word.text)),
    }))
    .filter((segment): segment is {
      startUs: number;
      endUs: number;
      text: string;
      speakerId: string | undefined;
      wordTimingUsable: boolean;
      words: Array<{
        text: string;
        startUs: number;
        endUs: number;
        confidence?: number;
        speakerId?: string;
      }>;
    } =>
      segment.startUs != null
      && segment.endUs != null
      && segment.endUs > sourceInUs
      && segment.startUs < sourceOutUs
      && segment.endUs > segment.startUs
      && Boolean(segment.text.trim()))
    .map((segment) => {
      const clippedStartUs = Math.max(segment.startUs, sourceInUs);
      const clippedEndUs = Math.min(segment.endUs, sourceOutUs);
      const words = segment.wordTimingUsable
        ? segment.words.filter((word) =>
          word.startUs >= clippedStartUs && word.endUs <= clippedEndUs)
        : [];
      return {
        startUs: clippedStartUs,
        endUs: clippedEndUs,
        text: words.length
          ? words.map((word) => word.text).join("").trim()
          : segment.text,
        ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
        ...(words.length
          ? {
            words: words.map((word) => ({
              text: word.text,
              startUs: word.startUs,
              endUs: word.endUs,
              ...(word.speakerId ? { speakerId: word.speakerId } : {}),
              ...(Number.isFinite(word.confidence)
                ? { confidence: Number(word.confidence) }
                : {}),
            })),
          }
          : {}),
      };
    });

  const personAppearances = (source.appearances || []).flatMap((appearance) => {
    if (
      appearance.videoId !== source.videoId
      || !overlaps(sourceInUs, sourceOutUs, appearance.startSec, appearance.endSec)
    ) return [];
    const appearanceStartUs = secondsToUs(appearance.startSec);
    const appearanceEndUs = secondsToUs(appearance.endSec);
    if (appearanceStartUs == null || appearanceEndUs == null) return [];
    const personId = appearance.personId && (
      appearance.manualLocked
      || (
        minimumIdentityConfidence != null
        && appearance.identityConfidence != null
        && appearance.identityConfidence >= minimumIdentityConfidence
      )
    )
      ? appearance.personId
      : undefined;
    return [{
      appearanceId: appearance.id,
      trackId: appearance.trackId,
      ...(personId ? { personId } : {}),
      startUs: Math.max(sourceInUs, appearanceStartUs),
      endUs: Math.min(sourceOutUs, appearanceEndUs),
      detectionConfidence: appearance.confidence,
      ...(appearance.identityConfidence == null
        ? {}
        : { identityConfidence: appearance.identityConfidence }),
      ...(appearance.manualLocked ? { manualConfirmed: true } : {}),
      ...(appearance.focusBounds ? { focusBounds: appearance.focusBounds } : {}),
    }];
  });
  const timedSpeakerTracks = (source.speakerTracks || []).flatMap((track) => {
    if (
      track.videoId !== source.videoId
      || !overlaps(sourceInUs, sourceOutUs, track.startSec, track.endSec)
    ) return [];
    const trackStartUs = secondsToUs(track.startSec);
    const trackEndUs = secondsToUs(track.endSec);
    if (trackStartUs == null || trackEndUs == null) return [];
    const linkedPersonId = track.personId && (
      track.manualLocked
      || (
        minimumIdentityConfidence != null
        && track.linkConfidence != null
        && track.linkConfidence >= minimumIdentityConfidence
      )
    )
      ? track.personId
      : undefined;
    return [{
      trackId: track.id,
      speakerId: track.speakerId,
      ...(linkedPersonId ? { personId: linkedPersonId } : {}),
      startUs: Math.max(sourceInUs, trackStartUs),
      endUs: Math.min(sourceOutUs, trackEndUs),
      confidence: track.confidence,
      ...(track.linkConfidence == null ? {} : { linkConfidence: track.linkConfidence }),
      ...(track.manualLocked ? { manualConfirmed: true } : {}),
    }];
  });
  const personIds = [...new Set(personAppearances
    .map((appearance) => appearance.personId)
    .filter((personId): personId is string => Boolean(personId)))].sort();
  const speakerIds = [...new Set(timedSpeakerTracks
    .map((track) => track.speakerId)
    .filter(Boolean))].sort();
  const transcriptGranularity = subtitleSegments.length
    ? subtitleSegments.every((segment) => segment.words?.length)
      ? "word" as const
      : "segment" as const
    : undefined;
  const alignedSegments = buildAlignedEvidenceSegments({
    startUs: sourceInUs,
    endUs: sourceOutUs,
    eventSummary: source.shot.description,
    transcriptGranularity,
    subtitleSegments,
    personAppearances,
    speakerTracks: timedSpeakerTracks,
  });

  const evidence: NonNullable<VideoClip["evidence"]> = {
    ...(source.shot.description ? { eventSummary: source.shot.description } : {}),
    ...(transcriptGranularity ? { transcriptGranularity } : {}),
    ...(subtitleSegments.length ? { subtitleSegments } : {}),
    ...(personAppearances.length ? { personAppearances } : {}),
    ...(timedSpeakerTracks.length ? { speakerTracks: timedSpeakerTracks } : {}),
    ...(personIds.length ? { personIds } : {}),
    ...(speakerIds.length ? { speakerIds } : {}),
    alignedSegments,
  };
  return Object.keys(evidence).length ? evidence : undefined;
}

export function compileEditPlan(
  selections: PlannerShotSelection[],
  sources: EditPlanShotSource[],
  options: CompileEditPlanOptions,
): EditPlan {
  const compileErrors: EditPlanIssue[] = [];
  const sourceByShotId = new Map<string, EditPlanShotSource>();
  const validationSources = new Map<string, ShotValidationSource>();

  for (const source of sources) {
    const shotId = source.shot.id;
    const startUs = secondsToUs(source.shot.startSec);
    const endUs = secondsToUs(source.shot.endSec);
    if (!shotId || startUs == null || endUs == null || endUs <= startUs) continue;
    if (sourceByShotId.has(shotId)) {
      compileErrors.push({
        code: "DUPLICATE_SOURCE_SHOT",
        message: "候选素材中出现重复 shotId。",
        path: `sources.${shotId}`,
      });
      continue;
    }
    sourceByShotId.set(shotId, source);
    validationSources.set(shotId, {
      shotId,
      videoId: source.videoId,
      sourcePath: source.sourcePath,
      startUs,
      endUs,
    });
  }

  const clips: VideoClip[] = [];
  const seenShotIds = new Set<string>();
  let timelineUs = 0;

  for (const [index, selection] of selections.entries()) {
    if (!selection.shotId) {
      compileErrors.push({
        code: "MISSING_SELECTION_SHOT",
        message: "Planner 返回了缺少 shotId 的选择。",
        path: `selections[${index}].shotId`,
      });
      continue;
    }
    if (seenShotIds.has(selection.shotId)) {
      compileErrors.push({
        code: "DUPLICATE_SELECTION_SHOT",
        message: "Planner 重复选择了同一个 Shot。",
        path: `selections[${index}].shotId`,
        meta: { shotId: selection.shotId },
      });
      continue;
    }
    seenShotIds.add(selection.shotId);

    const source = sourceByShotId.get(selection.shotId);
    if (!source) {
      compileErrors.push({
        code: "UNKNOWN_SELECTION_SHOT",
        message: "Planner 引用了候选集之外的 Shot。",
        path: `selections[${index}].shotId`,
        meta: { shotId: selection.shotId },
      });
      continue;
    }
    if (timelineUs >= options.targetDurationUs) continue;

    const shotStartUs = secondsToUs(source.shot.startSec)!;
    const shotEndUs = secondsToUs(source.shot.endSec)!;
    const fullDurationUs = shotEndUs - shotStartUs;
    const maxClipDurationUs = options.maxClipDurationUs && options.maxClipDurationUs > 0
      ? Math.min(fullDurationUs, options.maxClipDurationUs)
      : fullDurationUs;
    const remainingUs = Math.max(0, options.targetDurationUs - timelineUs);
    const durationUs = Math.min(maxClipDurationUs, remainingUs);
    if (durationUs <= 0) continue;

    const sourceOutUs = shotStartUs + durationUs;
    const clipAppearances = (source.appearances || []).filter((appearance) => (
      appearance.videoId === source.videoId
      && overlaps(shotStartUs, sourceOutUs, appearance.startSec, appearance.endSec)
    ));
    const crop = personAwareCrop({
      sourceWidth: source.sourceWidth,
      sourceHeight: source.sourceHeight,
      canvas: options.canvas,
      appearances: clipAppearances,
    });
    clips.push({
      id: `${options.planId}-video-${clips.length + 1}`,
      shotId: selection.shotId,
      videoId: source.videoId,
      sourcePath: source.sourcePath,
      sourceInUs: shotStartUs,
      sourceOutUs,
      timelineInUs: timelineUs,
      speed: 1,
      volume: 1,
      ...(crop ? { crop } : {}),
      selectionReason: selection.intent,
      confidence: selection.confidence,
      evidence: buildEvidence(
        source,
        shotStartUs,
        sourceOutUs,
        options.minimumIdentityConfidence,
      ),
    });
    timelineUs += durationUs;
  }

  const transitions = clips.slice(1).map((clip, index) => ({
    id: `${options.planId}-transition-${index + 1}`,
    fromClipId: clips[index].id,
    toClipId: clip.id,
    type: "cut" as const,
    durationUs: 0,
  }));
  const captions: CaptionCue[] = clips.flatMap((clip) =>
    (clip.evidence?.subtitleSegments || []).map((segment, index) => ({
      id: `${clip.id}-caption-${index + 1}`,
      startUs: clip.timelineInUs
        + Math.round((segment.startUs - clip.sourceInUs) / clip.speed),
      endUs: clip.timelineInUs
        + Math.round((segment.endUs - clip.sourceInUs) / clip.speed),
      text: segment.text,
      styleId: "proxy-default",
      sourceClipId: clip.id,
      sourceStartUs: segment.startUs,
      sourceEndUs: segment.endUs,
      ...(segment.words?.length
        ? {
          wordTimings: segment.words.map((word) => ({
            text: word.text,
            startUs: clip.timelineInUs
              + Math.round((word.startUs - clip.sourceInUs) / clip.speed),
            endUs: clip.timelineInUs
              + Math.round((word.endUs - clip.sourceInUs) / clip.speed),
            ...(word.speakerId ? { speakerId: word.speakerId } : {}),
            ...(Number.isFinite(word.confidence)
              ? { confidence: Number(word.confidence) }
              : {}),
          })),
        }
        : {}),
    })));
  const voiceovers = (options.voiceovers || []).flatMap((voiceover, index) => {
    const anchorIndex = clips.findIndex((clip) => clip.shotId === voiceover.afterShotId);
    const anchorClip = anchorIndex >= 0 ? clips[anchorIndex + 1] : undefined;
    if (!anchorClip) {
      compileErrors.push({
        code: "VOICEOVER_ANCHOR_MISSING",
        message: "旁白锚点没有对应的后续镜头。",
        path: `voiceovers[${index}].afterShotId`,
        meta: { afterShotId: voiceover.afterShotId },
      });
      return [];
    }
    const durationUs = Math.min(
      Math.max(600_000, Math.round(voiceover.text.length / 4.5 * US_PER_SECOND)),
      Math.round((anchorClip.sourceOutUs - anchorClip.sourceInUs) / anchorClip.speed),
    );
    return [{
      id: `${options.planId}-voiceover-${index + 1}`,
      kind: "voiceover" as const,
      ttsText: voiceover.text,
      anchorClipId: anchorClip.id,
      timelineInUs: anchorClip.timelineInUs,
      sourceInUs: 0,
      sourceOutUs: durationUs,
      volume: 1,
      fadeInUs: Math.min(80_000, Math.floor(durationUs / 4)),
      fadeOutUs: Math.min(120_000, Math.floor(durationUs / 4)),
    }];
  });
  const basePlan: EditPlan = {
    id: options.planId,
    version: 1,
    revision: 1,
    sessionId: options.sessionId,
    status: "draft",
    canvas: options.canvas,
    targetDurationUs: options.targetDurationUs,
    actualDurationUs: timelineUs,
    tracks: [
      {
        id: `${options.planId}-video-track-1`,
        kind: "video",
        items: clips,
      },
      ...(captions.length > 0 ? [{
        id: `${options.planId}-caption-track-1`,
        kind: "caption" as const,
        items: captions,
      }] : []),
      ...(voiceovers.length > 0 ? [{
        id: `${options.planId}-audio-track-1`,
        kind: "audio" as const,
        items: voiceovers,
      }] : []),
    ],
    transitions,
    provenance: {
      goal: options.goal,
      genre: "vlog",
      methodologyIds: [...new Set(options.methodologyIds || [])],
      generatedAt: options.generatedAt,
      ...(options.plannerProvider ? { plannerProvider: options.plannerProvider } : {}),
      ...(options.plannerModel ? { plannerModel: options.plannerModel } : {}),
      plannerInputDigest: stablePlannerDigest(selections, sources, options),
      plannerOutput: {
        selections,
        voiceover: options.voiceovers || [],
      },
      ...(options.evidenceQuality ? { evidenceQuality: options.evidenceQuality } : {}),
    },
    validation: {
      valid: false,
      warnings: [],
      errors: [],
    },
  };

  const validation = validateEditPlan(basePlan, {
    shots: validationSources,
    sourceExists: options.sourceExists,
  });
  const errors = [...compileErrors, ...validation.errors];
  return {
    ...basePlan,
    status: errors.length === 0 ? "validated" : "draft",
    validation: {
      valid: errors.length === 0,
      warnings: validation.warnings,
      errors,
    },
  };
}
