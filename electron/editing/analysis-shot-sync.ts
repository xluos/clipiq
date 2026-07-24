import type {
  AnalysisNode,
  FrameContext,
  Shot,
  ShotContext,
} from "../../src/types";

type AnalysisResultLike = {
  nodes?: AnalysisNode[];
  report?: {
    shotContexts?: ShotContext[];
  };
  shotContexts?: ShotContext[];
};

type TimedItem = {
  startSec: number;
  endSec: number;
};

function finiteTime(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function overlapDuration(a: TimedItem, b: TimedItem): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

function bestOverlappingNode(
  context: TimedItem,
  nodes: AnalysisNode[],
): AnalysisNode | undefined {
  let best: AnalysisNode | undefined;
  let bestOverlap = 0;
  for (const node of nodes) {
    const startSec = finiteTime(node.startSec);
    const endSec = finiteTime(node.endSec);
    if (startSec == null || endSec == null || endSec <= startSec) continue;
    const overlap = overlapDuration(context, { startSec, endSec });
    if (overlap > bestOverlap) {
      best = node;
      bestOverlap = overlap;
    }
  }
  return best;
}

function firstFrame(context: ShotContext): FrameContext | undefined {
  return context.representativeFrames?.[0] || context.frames?.[0];
}

function nonPlaceholder(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text !== "—" && text !== "未分析" ? text : undefined;
}

function subtitleForContext(context: ShotContext, node?: AnalysisNode): string | undefined {
  const direct = nonPlaceholder(context.subtitleText);
  if (direct) return direct;
  const fromSegments = context.subtitleSegments
    ?.map((segment) => nonPlaceholder(segment.text))
    .filter((text): text is string => Boolean(text))
    .join(" ");
  return fromSegments || nonPlaceholder(node?.subtitleText);
}

const NARRATIVE_RULES: Array<[RegExp, string]> = [
  [/\bhook\b|钩子|开场|冷开/, "hook"],
  [/\bestablish|环境建立|交代环境|全景建立|建立镜头/, "establishing"],
  [/\bdetail\b|细节|特写/, "detail"],
  [/\breaction\b|反应|回应/, "reaction"],
  [/\btransition\b|转场|过渡|承上启下/, "transition"],
  [/\bemotion\b|情绪|情感|共鸣/, "emotion_anchor"],
  [/\bending\b|\bend\b|结尾|收束|落点/, "ending"],
  [/\baction\b|动作|过程|推进|操作/, "action"],
];

function usageTagsForNode(
  node: AnalysisNode | undefined,
  index: number,
  total: number,
): string[] {
  const haystack = [
    node?.narrativeFunction,
    node?.editIntent,
    node?.title,
    ...(node?.nodeTypes || []),
  ].filter(Boolean).join(" ").toLowerCase();
  const tags = NARRATIVE_RULES
    .filter(([pattern]) => pattern.test(haystack))
    .map(([, tag]) => tag);

  if (node?.isHighlight) tags.push("highlight");
  if (tags.length === 0) {
    if (index === 0) tags.push("hook");
    else if (index === total - 1) tags.push("ending");
    else tags.push("action");
  }
  return [...new Set(tags)];
}

function descriptionForContext(
  context: ShotContext,
  node: AnalysisNode | undefined,
  index: number,
): string {
  return nonPlaceholder(context.shotDescription)
    || nonPlaceholder(node?.shotDescription)
    || nonPlaceholder(firstFrame(context)?.caption)
    || subtitleForContext(context, node)
    || `镜头 ${index + 1}`;
}

export function buildShotsFromAnalysis(
  videoId: string,
  result: AnalysisResultLike,
): Shot[] {
  const rawContexts = result?.report?.shotContexts || result?.shotContexts || [];
  if (!videoId || !Array.isArray(rawContexts) || rawContexts.length === 0) return [];

  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  const contexts = rawContexts
    .map((context, originalIndex) => {
      const startSec = finiteTime(context.startSec);
      const endSec = finiteTime(context.endSec);
      return startSec != null && endSec != null && endSec > startSec
        ? { context, originalIndex, startSec, endSec }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const now = new Date().toISOString();
  return contexts.map(({ context, startSec, endSec }, index) => {
    const node = bestOverlappingNode({ startSec, endSec }, nodes);
    const subtitleText = subtitleForContext(context, node);
    const subtitleSegments = context.subtitleSegments
      ?.map((segment) => {
        const legacySegment = segment as typeof segment & {
          startSec?: number;
          endSec?: number;
        };
        const segmentStart = finiteTime(segment.start ?? legacySegment.startSec);
        const segmentEnd = finiteTime(segment.end ?? legacySegment.endSec);
        const text = String(segment.text || "").trim();
        return segmentStart != null && segmentEnd != null && segmentEnd > segmentStart && text
          ? { startSec: segmentStart, endSec: segmentEnd, text }
          : null;
      })
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
    const audioElements = node?.audioElements
      ?.map(nonPlaceholder)
      .filter((text): text is string => Boolean(text));
    const audioSummary = audioElements?.join(" / ") || subtitleText;
    const shotIndex = index + 1;

    return {
      id: `${videoId}-shot-${shotIndex}`,
      videoId,
      assetProjectId: videoId,
      shotIndex,
      startSec,
      endSec,
      thumbnailUrl: firstFrame(context)?.thumbnailUrl || node?.thumbnailUrl,
      description: descriptionForContext(context, node, index),
      shotType: nonPlaceholder(node?.shotType),
      cameraMovement: nonPlaceholder(node?.cameraMovement),
      usageTags: usageTagsForNode(node, index, contexts.length),
      subtitleText,
      subtitleSegments,
      transcriptGranularity: subtitleSegments?.length ? "segment" : undefined,
      audioSummary,
      createdAt: now,
    };
  });
}
