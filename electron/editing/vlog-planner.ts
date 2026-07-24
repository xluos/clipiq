import type { AnalysisEvidenceQualityReport } from "../../src/types";
import type { VlogCandidate } from "./candidate-builder";
import type { PlannerShotSelection } from "./edit-plan-compiler";

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
          shotId: { type: "string" },
          intent: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["shotId", "intent", "confidence"],
      },
    },
  },
  required: ["selections"],
};

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
  return [
    `shotId=${candidate.shotId}`,
    `videoId=${candidate.videoId}`,
    `range=${(candidate.startUs / 1_000_000).toFixed(2)}-${(candidate.endUs / 1_000_000).toFixed(2)}s`,
    `duration=${(candidate.durationUs / 1_000_000).toFixed(2)}s`,
    `quality=${candidate.qualityScore.toFixed(2)}`,
    `roles=${candidate.usageTags.join(",") || "unknown"}`,
    `transcript=${candidate.transcriptGranularity || "none"}`,
    `people=${people || "unknown"}`,
    `speakers=${speakers || "unknown"}`,
    `event=${candidate.description || "(无描述)"}`,
    `subtitles=${subtitles || "(无字幕)"}`,
  ].join(" | ");
}

export function buildVlogPlannerPrompt(input: {
  goal: string;
  targetDurationUs: number;
  candidates: VlogCandidate[];
  methodologySummaries?: string[];
  evidenceQuality?: AnalysisEvidenceQualityReport;
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
      `语义覆盖：${Math.round(input.evidenceQuality.semantic.coverageRatio * 100)}%`,
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
      "你只能从候选集中选择 shotId，并为选择写剪辑意图和 0-1 置信度。",
      "严禁生成 startSec/endSec、文件路径、虚构镜头或虚构人物身份。",
      "程序会把 shotId 编译为真实素材时间；你只负责叙事选择与排序。",
      "personId 只代表达到可信阈值或人工确认的跨素材身份；track: 前缀只在单素材内保持连续，不能当成同一人。",
      "speakerId 与 personId 是不同证据；没有显式关联时不得推断说话人就是出镜人物。",
      "只返回合法 JSON，不要 Markdown，不要解释。",
    ].join("\n"),
    userText: [
      "# 剪辑目标",
      input.goal,
      `目标时长：${(input.targetDurationUs / 1_000_000).toFixed(1)} 秒`,
      "",
      "# Vlog 约束",
      constraints,
      ...(methodology ? ["", "# 已选方法论摘要", methodology] : []),
      ...(evidenceQuality ? ["", "# 分析证据质量", evidenceQuality] : []),
      "",
      "# 真实候选 Shot",
      candidates,
      "",
      "# 输出",
      '{"selections":[{"shotId":"真实候选 shotId","intent":"该镜头在叙事中的作用","confidence":0.9}]}',
      "按最终播放顺序排列。不得返回候选集之外的 shotId，不得重复 shotId。",
    ].join("\n"),
  };
}

export function parseVlogPlannerOutput(
  parsed: unknown,
  candidates: VlogCandidate[],
): {
  selections: PlannerShotSelection[];
  errors: string[];
} {
  const candidateIds = new Set(candidates.map((candidate) => candidate.shotId));
  const rawSelections = Array.isArray((parsed as any)?.selections)
    ? (parsed as any).selections
    : [];
  const errors: string[] = [];
  const selections: PlannerShotSelection[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of rawSelections.entries()) {
    const shotId = String(raw?.shotId || "").trim();
    const intent = String(raw?.intent || "").trim();
    const confidence = Number(raw?.confidence);
    if (!candidateIds.has(shotId)) {
      errors.push(`selections[${index}] 引用了候选集之外的 shotId: ${shotId || "(空)"}`);
      continue;
    }
    if (seen.has(shotId)) {
      errors.push(`selections[${index}] 重复引用 shotId: ${shotId}`);
      continue;
    }
    if (!intent) {
      errors.push(`selections[${index}] 缺少剪辑意图: ${shotId}`);
      continue;
    }
    if (!(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)) {
      errors.push(`selections[${index}] confidence 不在 0-1: ${shotId}`);
      continue;
    }
    seen.add(shotId);
    selections.push({ shotId, intent, confidence });
  }
  if (selections.length === 0) errors.push("Planner 没有返回任何有效 Shot。");
  return { selections, errors };
}
