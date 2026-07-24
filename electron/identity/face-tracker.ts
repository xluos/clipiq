import type { PersonAppearance } from "../../src/types";
import type {
  FaceBoundingBox,
  FaceDetection,
  FaceEmbedding,
  FaceFrameAnalysis,
} from "./face-analysis-provider";
import { cosineSimilarity } from "./person-clusterer";

export type FaceTrackPolicy = {
  maxGapSec: number;
  minimumIou: number;
  maximumCenterDistance: number;
  minimumEmbeddingSimilarity: number;
  minimumEvidenceDurationSec: number;
};

export type FaceTrackObservation = {
  videoId: string;
  frameId: string;
  detectionId: string;
  timeSec: number;
  evidenceStartSec: number;
  evidenceEndSec: number;
  shotId?: string;
  thumbnailUrl?: string;
  bbox: FaceBoundingBox;
  confidence: number;
  quality: number;
  embedding?: FaceEmbedding;
};

export type FaceTrack = {
  trackId: string;
  videoId: string;
  observations: FaceTrackObservation[];
  confidence: number;
  quality: number;
  representativeThumbnailUrl?: string;
  prototypeEmbedding?: number[];
  embeddingModel?: string;
};

export type FaceTrackAppearance = PersonAppearance & {
  embedding?: number[];
  embeddingModel?: string;
  embeddingQuality?: number;
};

type MutableTrack = Omit<
  FaceTrack,
  "confidence" | "quality" | "representativeThumbnailUrl" | "prototypeEmbedding" | "embeddingModel"
>;

type AssociationCandidate = {
  trackIndex: number;
  observationIndex: number;
  score: number;
};

export const DEFAULT_FACE_TRACK_POLICY: FaceTrackPolicy = {
  maxGapSec: 1.5,
  minimumIou: 0.15,
  maximumCenterDistance: 0.2,
  minimumEmbeddingSimilarity: 0.72,
  minimumEvidenceDurationSec: 0.001,
};

function isFiniteUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validBox(box: FaceBoundingBox): boolean {
  return isFiniteUnit(box.x)
    && isFiniteUnit(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0
    && box.x + box.width <= 1.000001
    && box.y + box.height <= 1.000001;
}

function intersectionOverUnion(a: FaceBoundingBox, b: FaceBoundingBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function centerDistance(a: FaceBoundingBox, b: FaceBoundingBox): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2);
  const dy = a.y + a.height / 2 - (b.y + b.height / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

function normalizedAverage(vectors: number[][]): number[] | undefined {
  const dimension = vectors[0]?.length;
  if (!dimension || vectors.some((vector) => vector.length !== dimension)) return undefined;
  const average = Array.from({ length: dimension }, (_, index) =>
    vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
  const norm = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) return undefined;
  return average.map((value) => value / norm);
}

function trackPrototype(track: MutableTrack): FaceEmbedding | undefined {
  const embedded = track.observations.filter(
    (observation): observation is FaceTrackObservation & { embedding: FaceEmbedding } =>
      Boolean(observation.embedding),
  );
  const modelId = embedded[0]?.embedding.modelId;
  if (!modelId || embedded.some((observation) => observation.embedding.modelId !== modelId)) {
    return undefined;
  }
  const vector = normalizedAverage(embedded.map((observation) => observation.embedding.vector));
  return vector ? { modelId, vector } : undefined;
}

function associationScore(
  track: MutableTrack,
  observation: FaceTrackObservation,
  policy: FaceTrackPolicy,
): number | null {
  const previous = track.observations.at(-1);
  if (!previous || observation.videoId !== track.videoId) return null;
  const gap = observation.timeSec - previous.timeSec;
  if (gap < 0 || gap > policy.maxGapSec) return null;

  const iou = intersectionOverUnion(previous.bbox, observation.bbox);
  const distance = centerDistance(previous.bbox, observation.bbox);
  const prototype = trackPrototype(track);
  if (prototype && observation.embedding) {
    if (prototype.modelId !== observation.embedding.modelId) return null;
    const embeddingSimilarity = cosineSimilarity(
      prototype.vector,
      observation.embedding.vector,
    );
    if (embeddingSimilarity == null) return null;
    if (embeddingSimilarity < policy.minimumEmbeddingSimilarity) return null;
    return 2 + embeddingSimilarity + iou * 0.1 - distance * 0.05;
  }

  // 镜头切换后，画面中相近的位置不能作为同一人物的证据。
  if (previous.shotId !== observation.shotId) return null;
  if (iou < policy.minimumIou && distance > policy.maximumCenterDistance) return null;
  return iou + Math.max(0, policy.maximumCenterDistance - distance);
}

function observationFromDetection(
  analysis: FaceFrameAnalysis,
  detection: FaceDetection,
  policy: FaceTrackPolicy,
): FaceTrackObservation | null {
  const { frame } = analysis;
  if (
    !frame.videoId
    || !frame.frameId
    || !detection.detectionId
    || !Number.isFinite(frame.timeSec)
    || frame.timeSec < 0
    || !validBox(detection.bbox)
    || !isFiniteUnit(detection.confidence)
    || !isFiniteUnit(detection.quality)
  ) {
    return null;
  }
  const explicitEnd = frame.evidenceEndSec;
  const explicitStart = frame.evidenceStartSec;
  const evidenceStartSec = Number.isFinite(explicitStart)
    && Number(explicitStart) >= 0
    && Number(explicitStart) <= frame.timeSec
      ? Number(explicitStart)
      : frame.timeSec;
  const evidenceEndSec = Number.isFinite(explicitEnd) && Number(explicitEnd) > frame.timeSec
    ? Number(explicitEnd)
    : frame.timeSec + policy.minimumEvidenceDurationSec;
  const embedding = detection.embedding
    && detection.embedding.modelId
    && Array.isArray(detection.embedding.vector)
    && detection.embedding.vector.length > 0
    && detection.embedding.vector.every(Number.isFinite)
      ? detection.embedding
      : undefined;
  return {
    videoId: frame.videoId,
    frameId: frame.frameId,
    detectionId: detection.detectionId,
    timeSec: frame.timeSec,
    evidenceStartSec,
    evidenceEndSec,
    shotId: frame.shotId,
    thumbnailUrl: frame.thumbnailUrl,
    bbox: detection.bbox,
    confidence: detection.confidence,
    quality: detection.quality,
    embedding,
  };
}

function finishTrack(track: MutableTrack): FaceTrack {
  const confidence = track.observations.reduce(
    (sum, observation) => sum + observation.confidence,
    0,
  ) / track.observations.length;
  const quality = track.observations.reduce(
    (sum, observation) => sum + observation.quality,
    0,
  ) / track.observations.length;
  const representative = [...track.observations]
    .filter((observation) => observation.thumbnailUrl)
    .sort((a, b) => b.quality - a.quality || a.timeSec - b.timeSec)[0];
  const prototype = trackPrototype(track);
  return {
    ...track,
    confidence,
    quality,
    representativeThumbnailUrl: representative?.thumbnailUrl,
    prototypeEmbedding: prototype?.vector,
    embeddingModel: prototype?.modelId,
  };
}

export function buildFaceTracks(
  analyses: FaceFrameAnalysis[],
  inputPolicy: Partial<FaceTrackPolicy> = {},
): FaceTrack[] {
  const policy = { ...DEFAULT_FACE_TRACK_POLICY, ...inputPolicy };
  const frames = [...analyses].sort(
    (a, b) => a.frame.timeSec - b.frame.timeSec || a.frame.frameId.localeCompare(b.frame.frameId),
  );
  const tracks: MutableTrack[] = [];
  let nextTrackNumber = 1;

  for (const analysis of frames) {
    const observations = analysis.detections
      .map((detection) => observationFromDetection(analysis, detection, policy))
      .filter((observation): observation is FaceTrackObservation => Boolean(observation))
      .sort((a, b) => a.detectionId.localeCompare(b.detectionId));
    const candidates: AssociationCandidate[] = [];

    tracks.forEach((track, trackIndex) => {
      observations.forEach((observation, observationIndex) => {
        const score = associationScore(track, observation, policy);
        if (score != null) candidates.push({ trackIndex, observationIndex, score });
      });
    });
    candidates.sort(
      (a, b) =>
        b.score - a.score
        || a.trackIndex - b.trackIndex
        || a.observationIndex - b.observationIndex,
    );

    const assignedTracks = new Set<number>();
    const assignedObservations = new Set<number>();
    for (const candidate of candidates) {
      if (
        assignedTracks.has(candidate.trackIndex)
        || assignedObservations.has(candidate.observationIndex)
      ) {
        continue;
      }
      tracks[candidate.trackIndex].observations.push(observations[candidate.observationIndex]);
      assignedTracks.add(candidate.trackIndex);
      assignedObservations.add(candidate.observationIndex);
    }

    observations.forEach((observation, index) => {
      if (assignedObservations.has(index)) return;
      tracks.push({
        trackId: `${observation.videoId}:face-track-${nextTrackNumber}`,
        videoId: observation.videoId,
        observations: [observation],
      });
      nextTrackNumber += 1;
    });
  }

  return tracks.map(finishTrack);
}

function segmentTrackByShot(track: FaceTrack): FaceTrackObservation[][] {
  const segments: FaceTrackObservation[][] = [];
  for (const observation of track.observations) {
    const current = segments.at(-1);
    if (!current || current.at(-1)?.shotId !== observation.shotId) {
      segments.push([observation]);
    } else {
      current.push(observation);
    }
  }
  return segments;
}

export function buildFaceTrackAppearances(tracks: FaceTrack[]): FaceTrackAppearance[] {
  return tracks.flatMap((track) =>
    segmentTrackByShot(track).map((observations, segmentIndex) => {
      const first = observations[0];
      const last = observations.at(-1) || first;
      return {
        id: `${track.trackId}:appearance-${segmentIndex + 1}`,
        videoId: track.videoId,
        shotId: first.shotId,
        trackId: track.trackId,
        startSec: first.evidenceStartSec,
        endSec: last.evidenceEndSec,
        confidence: observations.reduce(
          (sum, observation) => sum + observation.confidence,
          0,
        ) / observations.length,
        thumbnailUrl: [...observations]
          .filter((observation) => observation.thumbnailUrl)
          .sort((a, b) => b.quality - a.quality || a.timeSec - b.timeSec)[0]?.thumbnailUrl,
        source: "face_track",
        embedding: track.prototypeEmbedding,
        embeddingModel: track.embeddingModel,
        embeddingQuality: track.prototypeEmbedding ? track.quality : undefined,
      };
    }),
  );
}
