import { useState } from "react";
import { useApp } from "../AppContext";
import { useSidecarReadiness } from "../hooks/useSidecarReadiness";
import { PipelineRow, type SlotMeta, type PipelineStage } from "./PipelineSlotPicker";
import type { SlotAssignment, SlotOverrides, TaskSlotKey } from "../types";
import { X } from "lucide-react";

const AUDIO_META: SlotMeta = {
  key: "__audio__" as unknown as TaskSlotKey,
  label: "字幕识别",
  difficulty: "simple",
  axis: "text",
  hint: "本地 Whisper 速度快、隐私好;远端服务准确度更高",
  used: true,
};

const VISION_META: SlotMeta = {
  key: "complex_vision",
  label: "复杂 · 视觉",
  difficulty: "complex",
  axis: "vision",
  hint: "视觉分析",
  used: true,
};

const SIMPLE_VISION_META: SlotMeta = {
  key: "simple_vision",
  label: "简单 · 视觉",
  difficulty: "simple",
  axis: "vision",
  hint: "本地视觉初筛",
  used: true,
};

const MEDIUM_TEXT_META: SlotMeta = {
  key: "medium_text",
  label: "中等 · 文本",
  difficulty: "medium",
  axis: "text",
  hint: "文本处理",
  used: true,
};

const CONTENT_STAGES: PipelineStage[] = [
  { num: "01", title: "字幕识别", badges: ["audio"], desc: "从音轨提取台词。", slot: "__audio__" },
  { num: "02", title: "内容分析", badges: ["complex · vision"], desc: "基于关键帧和字幕,分析视频内容。", slot: "complex_vision", isKey: true },
];

const PIPELINE_STAGES: PipelineStage[] = [
  { num: "01", title: "抽帧初筛", badges: ["simple · vision"], desc: "对抽帧打标,过滤重复与低信息量帧。", slot: "simple_vision" },
  { num: "02", title: "字幕识别", badges: ["audio"], desc: "从音轨提取台词。", slot: "__audio__" },
  { num: "03", title: "镜头合并 + 全局摘要", badges: ["medium · text"], desc: "合并镜头描述,聚合全局摘要。", slot: "medium_text" },
  { num: "04", title: "主分析", badges: ["complex · vision"], desc: "产出节点评审、方法论审计、情绪曲线。", slot: "complex_vision", isKey: true },
];

const META_BY_SLOT: Record<string, SlotMeta> = {
  __audio__: AUDIO_META,
  complex_vision: VISION_META,
  simple_vision: SIMPLE_VISION_META,
  medium_text: MEDIUM_TEXT_META,
};

export type ModelConfigResult = {
  overrides: SlotOverrides;
  customPrompt?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  mode: "content" | "pipeline";
  title?: string;
  initialOverrides?: SlotOverrides;
  initialPrompt?: string;
  onConfirm: (result: ModelConfigResult) => void;
};

export function ModelConfigDialog({ open, onClose, mode, title, initialOverrides, initialPrompt, onConfirm }: Props) {
  const { providers, getPipelineSlot } = useApp();
  const { readyLocalIds, readyWhisperIds } = useSidecarReadiness();

  const pipelineId = mode as import("../types").PipelineId;
  const stages = mode === "content" ? CONTENT_STAGES : PIPELINE_STAGES;

  const [localSlots, setLocalSlots] = useState<Record<string, SlotAssignment>>(() => {
    const init: Record<string, SlotAssignment> = {};
    for (const s of stages) {
      if (s.slot === "__audio__") {
        init.__audio__ = initialOverrides?.audio !== undefined ? initialOverrides.audio : getPipelineSlot(pipelineId, "__audio__");
      } else {
        const key = s.slot as keyof SlotOverrides;
        init[s.slot] = initialOverrides?.[key] !== undefined ? initialOverrides[key]! : getPipelineSlot(pipelineId, s.slot as TaskSlotKey);
      }
    }
    return init;
  });
  const [prompt, setPrompt] = useState(initialPrompt || "");

  if (!open) return null;

  const handleConfirm = () => {
    const overrides: SlotOverrides = {};
    for (const s of stages) {
      const key = s.slot === "__audio__" ? "audio" : s.slot;
      const slotKey = s.slot === "__audio__" ? "__audio__" : s.slot;
      (overrides as any)[key] = localSlots[slotKey];
    }
    onConfirm({ overrides, customPrompt: prompt.trim() || undefined });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-[#14151a] rounded-xl border border-slate-200 dark:border-slate-800 shadow-xl w-full max-w-2xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">
            {title || (mode === "content" ? "内容分析 · 模型配置" : "结构拆解 · 模型配置")}
          </h3>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 py-3 space-y-1">
          {stages.map((stage, idx) => {
            const isAudio = stage.slot === "__audio__";
            const slotKey = isAudio ? "__audio__" : stage.slot;
            const meta = META_BY_SLOT[slotKey] || VISION_META;
            return (
              <PipelineRow
                key={slotKey + stage.num}
                stage={stage}
                isFirst={idx === 0}
                providers={providers}
                meta={meta}
                assignment={localSlots[slotKey]}
                onChange={(a) => setLocalSlots((prev) => ({ ...prev, [slotKey]: a }))}
                audioMode={isAudio}
                readyLocalIds={readyLocalIds}
                readyWhisperIds={readyWhisperIds}
                compact
              />
            );
          })}
        </div>

        {mode === "content" && (
          <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 mb-1.5">分析方向（可选）</div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="想重点关注什么？如：分析视频的变现方式和商业价值、关注画面构图和色彩搭配..."
              rows={2}
              className="w-full rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e0e10] px-3 py-2 text-[12.5px] text-slate-700 dark:text-slate-300 placeholder-slate-400 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800">
          <button onClick={onClose} className="h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
            取消
          </button>
          <button onClick={handleConfirm} className="h-8 px-4 rounded-md text-[12.5px] font-medium bg-indigo-600 hover:bg-indigo-700 text-white">
            确认并开始
          </button>
        </div>
      </div>
    </div>
  );
}
