import { createHash } from "node:crypto";
import type { EditPlan, EditPlanVariant } from "../../src/types";
import type { PlannerCandidateSelection } from "./edit-plan-compiler";

export type VlogVariantSpec = Pick<
  EditPlanVariant,
  "key" | "label" | "description"
> & {
  instruction: string;
};

export const VLOG_VARIANT_SPECS: readonly VlogVariantSpec[] = [
  {
    key: "balanced",
    label: "叙事均衡",
    description: "兼顾事件完整、节奏变化和情绪收束",
    instruction: "优先形成清楚的开场、发展、转折和收尾；在信息、动作、人物反应和环境镜头之间保持均衡。",
  },
  {
    key: "pace",
    label: "节奏优先",
    description: "更快推进，强化动作和信息密度",
    instruction: "优先选择更短、更有动作变化或信息增量的窗口，减少重复铺垫和非必要旁白，但仍要保留明确收尾。",
  },
  {
    key: "character",
    label: "人物优先",
    description: "强化主角连续性、反应和情绪锚点",
    instruction: "优先保持可信 personId 的主角连续性，增加真实反应和情绪锚点；人物未知时不得猜身份，也不能牺牲事件可理解性。",
  },
] as const;

export function vlogVariantSpecs(count: number): VlogVariantSpec[] {
  if (!Number.isInteger(count) || count < 1 || count > VLOG_VARIANT_SPECS.length) {
    throw new Error(`粗剪对比版本数必须在 1 到 ${VLOG_VARIANT_SPECS.length} 之间`);
  }
  return VLOG_VARIANT_SPECS.slice(0, count).map((item) => ({ ...item }));
}

export function plannerSelectionSignature(
  selections: PlannerCandidateSelection[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(selections.map((selection) => selection.candidateId)))
    .digest("hex");
}

export async function generateDistinctVlogVariants<T>(input: {
  specs: Array<VlogVariantSpec | null>;
  maximumAttempts?: number;
  generate: (
    spec: VlogVariantSpec | null,
    avoidCandidateSequences: string[][],
    attempt: number,
  ) => Promise<{
    selections: PlannerCandidateSelection[];
    errors: string[];
    value: T;
  }>;
}): Promise<Array<{
  spec: VlogVariantSpec | null;
  signature: string;
  value: T;
}>> {
  const maximumAttempts = Math.max(1, input.maximumAttempts ?? 2);
  const priorCandidateSequences: string[][] = [];
  const priorSignatures = new Set<string>();
  const output: Array<{
    spec: VlogVariantSpec | null;
    signature: string;
    value: T;
  }> = [];

  for (const spec of input.specs) {
    let lastErrors: string[] = [];
    let duplicate = false;
    let accepted: Awaited<ReturnType<typeof input.generate>> | null = null;
    let signature = "";
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const result = await input.generate(
        spec,
        priorCandidateSequences.map((sequence) => [...sequence]),
        attempt,
      );
      lastErrors = result.errors;
      if (result.errors.length > 0) continue;
      signature = plannerSelectionSignature(result.selections);
      duplicate = priorSignatures.has(signature);
      if (duplicate) continue;
      accepted = result;
      break;
    }
    if (!accepted) {
      if (lastErrors.length > 0) {
        throw new Error(`Vlog Planner 输出无效: ${lastErrors.join("；")}`);
      }
      if (duplicate) {
        throw new Error(
          `「${spec?.label || "默认"}」版本与已有版本镜头选择完全相同，请调整目标或补充素材后重试`,
        );
      }
      throw new Error("Vlog Planner 没有返回可编译结果");
    }
    output.push({ spec, signature, value: accepted.value });
    priorSignatures.add(signature);
    priorCandidateSequences.push(
      accepted.selections.map((selection) => selection.candidateId),
    );
  }
  return output;
}

export function variantSummary(plan: EditPlan): {
  clipCount: number;
  videoCount: number;
  durationUs: number;
  subtitleCueCount: number;
  emotionTones: string[];
} {
  const videoTrack = plan.tracks.find((track) => track.kind === "video");
  const captionTrack = plan.tracks.find((track) => track.kind === "caption");
  const clips = videoTrack?.kind === "video" ? videoTrack.items : [];
  return {
    clipCount: clips.length,
    videoCount: new Set(clips.map((clip) => clip.videoId)).size,
    durationUs: plan.actualDurationUs,
    subtitleCueCount: captionTrack?.kind === "caption"
      ? captionTrack.items.length
      : 0,
    emotionTones: [...new Set(
      (plan.emotionSegments || []).map((segment) => segment.tone),
    )],
  };
}
