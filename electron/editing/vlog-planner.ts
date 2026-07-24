import type {
  AnalysisEvidenceQualityReport,
  ClipEmotion,
  EmotionTone,
} from "../../src/types";
import type { VlogCandidate } from "./candidate-builder";
import type { PlannerCandidateSelection } from "./edit-plan-compiler";

export const VLOG_PLANNER_CONSTRAINTS = [
  {
    ruleId: "R-VLOG-006",
    priority: "must",
    instruction: "开头 0-5 秒直接使用最有反差、最有趣或信息密度最高的真实镜头，不用自我介绍铺垫。",
  },
  {
    ruleId: "R-VLOG-001",
    priority: "must",
    instruction: "前中后安排清晰情绪锚点，不能让全片情绪强度保持不变。",
  },
  {
    ruleId: "R-VLOG-002",
    priority: "must",
    instruction: "优先保持主角 personId 和第一人称视角一致；人物未知时不得猜身份。",
  },
  {
    ruleId: "R-VLOG-003",
    priority: "should",
    instruction: "节奏采用两短一长或多短一长，短动作/细节镜头与较长环境/全景镜头交替。",
  },
  {
    ruleId: "R-VLOG-004",
    priority: "should",
    instruction: "避免单一事件或场景占据超过约 40% 片长，素材不足时明确暴露而不是重复镜头。",
  },
  {
    ruleId: "R-VLOG-007",
    priority: "must",
    instruction: "最后安排明确情绪收束，优先 ending、远景、金句或安静动作镜头。",
  },
] as const;

export const VLOG_PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          intent: { type: "string" },
          confidence: { type: "number" },
          emotion: {
            type: "object",
            properties: {
              tone: {
                type: "string",
                enum: ["neutral", "calm", "warm", "upbeat", "tense", "reflective"],
              },
              intensity: { type: "number" },
              confidence: { type: "number" },
              reason: { type: "string" },
            },
            required: ["tone", "intensity", "confidence", "reason"],
          },
        },
        required: ["candidateId", "intent", "confidence", "emotion"],
      },
    },
    voiceover: {
      type: "array",
      items: {
        type: "object",
        properties: {
          afterCandidateId: { type: "string" },
          text: { type: "string" },
        },
        required: ["afterCandidateId", "text"],
      },
    },
  },
  required: ["selections", "voiceover"],
};

export type PlannerVoiceover = {
  afterCandidateId: string;
  text: string;
};

const EMOTION_TONES = new Set<EmotionTone>([
  "neutral",
  "calm",
  "warm",
  "upbeat",
  "tense",
  "reflective",
]);

function alignedSegmentText(
  candidate: VlogCandidate,
): string {
  return candidate.alignedSegments
    .map((segment) => {
      const visiblePeople = segment.visiblePeople
        .map((person) => person.personId || `track:${person.trackId}`)
        .join(",");
      const activeSpeakers = segment.activeSpeakers
        .map((speaker) =>
          speaker.personId
            ? `${speaker.speakerId}->${speaker.personId}`
            : speaker.speakerId)
        .join(",");
      return [
        `[${(segment.startUs / 1_000_000).toFixed(2)}-${(segment.endUs / 1_000_000).toFixed(2)}]`,
        `event=${segment.eventSummary || "(无描述)"}${segment.eventGranularity ? `@${segment.eventGranularity}` : ""}`,
        `subtitle=${segment.subtitleText || "(无字幕)"}`,
        `visible=${visiblePeople || "unknown"}`,
        `speaking=${activeSpeakers || "unknown"}`,
      ].join(" ");
    })
    .join(" / ");
}

function candidateText(candidate: VlogCandidate): string {
  const subtitles = candidate.subtitleSegments
    .map((segment) =>
      `[${(segment.startUs / 1_000_000).toFixed(2)}-${(segment.endUs / 1_000_000).toFixed(2)}] ${segment.text}`)
    .join(" / ");
  const people = candidate.personAppearances
    .slice(0, 12)
    .map((appearance) => {
      const identity = appearance.personId || `track:${appearance.trackId}`;
      return `${identity}@${(appearance.startUs / 1_000_000).toFixed(2)}-${(appearance.endUs / 1_000_000).toFixed(2)}`;
    })
    .join(",");
  const speakers = candidate.speakerTracks
    .slice(0, 12)
    .map((track) => {
      const linkedPerson = track.personId ? `->${track.personId}` : "";
      return `${track.speakerId}${linkedPerson}@${(track.startUs / 1_000_000).toFixed(2)}-${(track.endUs / 1_000_000).toFixed(2)}`;
    })
    .join(",");
  const alignedTimeline = alignedSegmentText(candidate);
  return [
    `candidateId=${candidate.candidateId}`,
    `shotId=${candidate.shotId}`,
    `videoId=${candidate.videoId}`,
    `range=${(candidate.startUs / 1_000_000).toFixed(2)}-${(candidate.endUs / 1_000_000).toFixed(2)}s`,
    `duration=${(candidate.durationUs / 1_000_000).toFixed(2)}s`,
    `boundary=${candidate.boundaryReason}`,
    `quality=${candidate.qualityScore.toFixed(2)}`,
    `roles=${candidate.usageTags.join(",") || "unknown"}`,
    `transcript=${candidate.transcriptGranularity || "none"}`,
    `people=${people || "unknown"}`,
    `speakers=${speakers || "unknown"}`,
    `event=${candidate.description || "(无描述)"}`,
    `subtitles=${subtitles || "(无字幕)"}`,
    `alignedTimeline=${alignedTimeline}`,
  ].join(" | ");
}

export function buildVlogPlannerPrompt(input: {
  goal: string;
  targetDurationUs: number;
  candidates: VlogCandidate[];
  methodologySummaries?: string[];
  evidenceQuality?: AnalysisEvidenceQualityReport;
  variant?: {
    label: string;
    description: string;
    instruction: string;
    avoidCandidateSequences?: string[][];
  };
}): { systemText: string; userText: string } {
  const constraints = VLOG_PLANNER_CONSTRAINTS
    .map((rule) => `- ${rule.ruleId} [${rule.priority}]: ${rule.instruction}`)
    .join("\n");
  const methodology = (input.methodologySummaries || [])
    .map((summary) => `- ${summary}`)
    .join("\n");
  const candidates = input.candidates.map(candidateText).join("\n");
  const evidenceQuality = input.evidenceQuality
    ? [
      `语义能力：${input.evidenceQuality.semantic.capability}，镜头描述覆盖 ${Math.round(input.evidenceQuality.semantic.coverageRatio * 100)}%，分段覆盖 ${Math.round(input.evidenceQuality.semantic.segmentCoverageRatio * 100)}%`,
      `字幕能力：${input.evidenceQuality.transcript.capability}，${input.evidenceQuality.transcript.segmentCount} 段`,
      `人物能力：${input.evidenceQuality.identity.capability}，可信出镜 ${input.evidenceQuality.identity.trustedAppearanceCount} 条，跨素材人物 ${input.evidenceQuality.identity.crossVideoPersonCount} 个`,
      `说话人能力：${input.evidenceQuality.speakers.capability}，${input.evidenceQuality.speakers.trackCount} 条轨迹`,
      ...input.evidenceQuality.planning.issues.map((issue) =>
        `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`),
    ].map((line) => `- ${line}`).join("\n")
    : "";

  return {
    systemText: [
      "你是 Vlog 粗剪规划器。",
      "你只能从候选集中选择 candidateId，并为选择写剪辑意图和 0-1 置信度。",
      "严禁生成 startSec/endSec、文件路径、虚构镜头或虚构人物身份。",
      "每个 candidateId 已绑定真实 shotId 和固定素材时间；程序负责解析，你不能修改范围。",
      "personId 只代表达到可信阈值或人工确认的跨素材身份；track: 前缀只在单素材内保持连续，不能当成同一人。",
      "speakerId 与 personId 是不同证据；没有显式关联时不得推断说话人就是出镜人物。",
      "alignedTimeline 是程序按时间边界对齐后的证据；event@segment 可用于具体时间段，event@shot 只代表整 Shot 降级描述，不得伪装为更细粒度语义。",
      "旁白只补充画面和对白没有表达的信息，不复述现有字幕；最多 3 段，每段不超过 80 个字符。",
      "旁白 afterCandidateId 必须引用已选择且不是最后一个的 candidateId，旁白会从它的下一个镜头开始播放。",
      "每个选择必须根据该候选真实事件、字幕和剪辑作用标注 emotion：tone 只能是 neutral/calm/warm/upbeat/tense/reflective，intensity 与 confidence 均为 0-1，reason 不超过 40 个字符。",
      "emotion 表示成片这一镜头需要承载的情绪，不得把素材中没有证据的具体情感或人物心理当成事实。",
      ...(input.variant ? [
        `本次只生成「${input.variant.label}」版本，必须遵守该版本方向，同时继续满足全部事实证据和 Vlog 约束。`,
      ] : []),
      "只返回合法 JSON，不要 Markdown，不要解释。",
    ].join("\n"),
    userText: [
      "# 剪辑目标",
      input.goal,
      `目标时长：${(input.targetDurationUs / 1_000_000).toFixed(1)} 秒`,
      ...(input.variant ? [
        "",
        "# 本版本方向",
        `${input.variant.label}：${input.variant.description}`,
        input.variant.instruction,
        ...((input.variant.avoidCandidateSequences || []).length > 0
          ? [
            "以下 candidateId 顺序已被其他版本使用，本版本必须给出不同的选择或排序：",
            ...(input.variant.avoidCandidateSequences || [])
              .map((sequence) => `- ${sequence.join(" -> ")}`),
          ]
          : []),
      ] : []),
      "",
      "# Vlog 约束",
      constraints,
      ...(methodology ? ["", "# 已选方法论摘要", methodology] : []),
      ...(evidenceQuality ? ["", "# 分析证据质量", evidenceQuality] : []),
      "",
      "# 真实候选时间窗口",
      candidates,
      "",
      "# 输出",
      '{"selections":[{"candidateId":"真实候选 candidateId","intent":"该时间窗口在叙事中的作用","confidence":0.9,"emotion":{"tone":"upbeat","intensity":0.7,"confidence":0.8,"reason":"动作推进，节奏轻快"}}],"voiceover":[{"afterCandidateId":"已选择且非末尾的 candidateId","text":"下一镜头开始播放的必要补充旁白"}]}',
      "按最终播放顺序排列。不得返回候选集之外的 candidateId，不得重复 candidateId。",
    ].join("\n"),
  };
}

export function parseVlogPlannerOutput(
  parsed: unknown,
  candidates: VlogCandidate[],
): {
  selections: PlannerCandidateSelection[];
  voiceovers: PlannerVoiceover[];
  errors: string[];
} {
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const rawSelections = Array.isArray((parsed as any)?.selections)
    ? (parsed as any).selections
    : [];
  const errors: string[] = [];
  const selections: PlannerCandidateSelection[] = [];
  const voiceovers: PlannerVoiceover[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of rawSelections.entries()) {
    const candidateId = String(raw?.candidateId || "").trim();
    const intent = String(raw?.intent || "").trim();
    const confidence = Number(raw?.confidence);
    const emotionTone = String(raw?.emotion?.tone || "").trim() as EmotionTone;
    const emotionIntensity = Number(raw?.emotion?.intensity);
    const emotionConfidence = Number(raw?.emotion?.confidence);
    const emotionReason = String(raw?.emotion?.reason || "").trim();
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      errors.push(`selections[${index}] 引用了候选集之外的 candidateId: ${candidateId || "(空)"}`);
      continue;
    }
    if (seen.has(candidateId)) {
      errors.push(`selections[${index}] 重复引用 candidateId: ${candidateId}`);
      continue;
    }
    if (!intent) {
      errors.push(`selections[${index}] 缺少剪辑意图: ${candidateId}`);
      continue;
    }
    if (!(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)) {
      errors.push(`selections[${index}] confidence 不在 0-1: ${candidateId}`);
      continue;
    }
    if (
      !EMOTION_TONES.has(emotionTone)
      || !(Number.isFinite(emotionIntensity)
        && emotionIntensity >= 0
        && emotionIntensity <= 1)
      || !(Number.isFinite(emotionConfidence)
        && emotionConfidence >= 0
        && emotionConfidence <= 1)
      || !emotionReason
      || emotionReason.length > 40
    ) {
      errors.push(`selections[${index}] emotion 无效: ${candidateId}`);
      continue;
    }
    const emotion: ClipEmotion = {
      tone: emotionTone,
      intensity: emotionIntensity,
      confidence: emotionConfidence,
      reason: emotionReason,
      source: "planner",
    };
    seen.add(candidateId);
    selections.push({
      candidateId,
      shotId: candidate.shotId,
      intent,
      confidence,
      emotion,
    });
  }
  if (selections.length === 0) errors.push("Planner 没有返回任何有效候选窗口。");
  const selectedIds = selections.map((selection) => selection.candidateId);
  const selectedIndex = new Map(
    selectedIds.map((candidateId, index) => [candidateId, index]),
  );
  const seenVoiceoverAnchors = new Set<string>();
  const rawVoiceovers = Array.isArray((parsed as any)?.voiceover)
    ? (parsed as any).voiceover
    : [];
  if (rawVoiceovers.length > 3) {
    errors.push("voiceover 最多允许 3 段。");
  }
  for (const [index, raw] of rawVoiceovers.slice(0, 3).entries()) {
    const afterCandidateId = String(raw?.afterCandidateId || "").trim();
    const text = String(raw?.text || "").trim();
    const anchorIndex = selectedIndex.get(afterCandidateId);
    if (anchorIndex == null) {
      errors.push(`voiceover[${index}] 引用了未选择的 candidateId: ${afterCandidateId || "(空)"}`);
      continue;
    }
    if (anchorIndex >= selectedIds.length - 1) {
      errors.push(`voiceover[${index}] 不能锚定最后一个候选窗口: ${afterCandidateId}`);
      continue;
    }
    if (seenVoiceoverAnchors.has(afterCandidateId)) {
      errors.push(`voiceover[${index}] 重复锚定候选窗口: ${afterCandidateId}`);
      continue;
    }
    if (!text) {
      errors.push(`voiceover[${index}] 文本为空: ${afterCandidateId}`);
      continue;
    }
    if (text.length > 80) {
      errors.push(`voiceover[${index}] 超过 80 个字符: ${afterCandidateId}`);
      continue;
    }
    seenVoiceoverAnchors.add(afterCandidateId);
    voiceovers.push({ afterCandidateId, text });
  }
  return { selections, voiceovers, errors };
}
