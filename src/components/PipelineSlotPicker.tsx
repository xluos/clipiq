import { type FunctionComponent } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ModelProvider, ProviderModel, SlotAssignment, TaskSlotKey } from "../types";

export const NONE = "__none__";

export const CAPABILITY_LABELS_ZH: Record<string, string> = {
  vision: "视觉",
  audio_transcription: "音频",
  reasoning: "推理",
  fast: "快速",
  long_context: "长上下文",
  text: "文本",
};

export type SlotMeta = {
  key: TaskSlotKey | "__audio__";
  label: string;
  difficulty: "simple" | "medium" | "complex";
  axis: "vision" | "text";
  hint: string;
  used: boolean;
};

export type PipelineStage = {
  num: string;
  title: string;
  badges: string[];
  desc: string;
  slot: TaskSlotKey | "__audio__";
  isKey?: boolean;
};

export type PipelineRowProps = {
  stage: PipelineStage;
  isFirst: boolean;
  providers: ModelProvider[];
  meta: SlotMeta;
  assignment: SlotAssignment;
  onChange: (a: SlotAssignment) => void;
  audioMode?: boolean;
  readyLocalIds: Set<string>;
  readyWhisperIds: Set<string>;
  compact?: boolean;
};

export const PipelineRow: FunctionComponent<PipelineRowProps> = ({
  stage, isFirst, providers, meta, assignment, onChange, audioMode, readyLocalIds, readyWhisperIds, compact,
}) => {
  const isModelEligible = (p: ModelProvider, m: ProviderModel) => {
    if (p.source === "local_llama" && !readyLocalIds.has(m.id)) return false;
    if (p.source === "local_whisper" && !readyWhisperIds.has(m.id)) return false;
    return true;
  };

  const candidateProviders = audioMode
    ? providers.filter((p) =>
        p.models.some((m) => isModelEligible(p, m) && m.capabilities.includes("audio_transcription")) ||
        p.endpointType === "openai_audio_transcriptions" ||
        p.endpointType === "local_whisper_cpp",
      )
    : providers.filter((p) =>
        meta.axis === "vision"
          ? p.models.some((m) => isModelEligible(p, m) && m.capabilities.includes("vision"))
          : p.models.some((m) => isModelEligible(p, m)),
      );
  const selectedProvider = assignment ? providers.find((p) => p.id === assignment.providerId) : null;
  const candidateModels = (() => {
    if (!selectedProvider) return [];
    const eligible = selectedProvider.models.filter((m) => isModelEligible(selectedProvider, m));
    if (audioMode) {
      return eligible.filter(
        (m) =>
          m.capabilities.includes("audio_transcription") ||
          selectedProvider.endpointType === "openai_audio_transcriptions" ||
          selectedProvider.endpointType === "local_whisper_cpp",
      );
    }
    if (meta.axis === "vision") {
      return eligible.filter((m) => m.capabilities.includes("vision"));
    }
    return eligible;
  })();

  const handleProviderChange = (id: string) => {
    if (id === NONE) {
      onChange(null);
      return;
    }
    const p = providers.find((x) => x.id === id);
    const eligibleModels = p?.models.filter((m) => isModelEligible(p, m)) || [];
    const firstModel = audioMode
      ? eligibleModels.find((m) => m.capabilities.includes("audio_transcription")) || eligibleModels[0]
      : meta.axis === "vision"
      ? eligibleModels.find((m) => m.capabilities.includes("vision")) || eligibleModels[0]
      : eligibleModels[0];
    onChange(firstModel ? { providerId: id, modelId: firstModel.id } : null);
  };

  const handleModelChange = (id: string) => {
    if (!assignment) return;
    onChange({ ...assignment, modelId: id });
  };

  if (compact) {
    return (
      <div className={`flex items-center gap-3 py-2.5 ${isFirst ? "" : "border-t border-slate-200 dark:border-slate-800"}`}>
        <div className={`w-6 h-6 grid place-items-center rounded font-mono text-[10px] font-medium shrink-0 ${
          stage.isKey
            ? "bg-indigo-600 text-white"
            : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
        }`}>
          {stage.num}
        </div>
        <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100 w-[100px] shrink-0">{stage.title}</div>
        <Select value={assignment?.providerId ?? NONE} onValueChange={handleProviderChange}>
          <SelectTrigger className="h-7 text-[12px] bg-white dark:bg-[#14151a] border-slate-200 dark:border-slate-800 flex-1 min-w-0">
            <SelectValue>{selectedProvider ? selectedProvider.name : "选供应商"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不启用</SelectItem>
            {candidateProviders.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assignment?.modelId ?? NONE} onValueChange={handleModelChange} disabled={!selectedProvider}>
          <SelectTrigger className="h-7 text-[12px] bg-white dark:bg-[#14151a] border-slate-200 dark:border-slate-800 font-mono flex-1 min-w-0">
            <SelectValue>
              {(() => {
                if (!assignment || !selectedProvider) return "选模型";
                const m = selectedProvider.models.find((x) => x.id === assignment.modelId);
                return m?.label || assignment.modelId;
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {candidateModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex items-center gap-2">
                  <span>{m.label}</span>
                  <span className="text-[10px] text-slate-400">{m.capabilities.map((c) => CAPABILITY_LABELS_ZH[c] || c).join(" · ")}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-[36px_minmax(0,1fr)_280px] gap-4 items-start px-5 py-4 ${isFirst ? "" : "border-t border-slate-200 dark:border-slate-800"}`}>
      <div className={`w-7 h-7 grid place-items-center rounded-md font-mono text-[11px] font-medium ${
        stage.isKey
          ? "bg-indigo-600 text-white border border-indigo-600"
          : "bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
      }`}>
        {stage.num}
      </div>
      <div className="min-w-0">
        <h4 className="text-[13.5px] font-semibold text-slate-900 dark:text-slate-100 mb-1 flex items-center gap-2">
          {stage.title}
          {stage.badges.map(b => (
            <span key={b} className={`inline-flex h-5 px-1.5 rounded font-mono text-[10.5px] uppercase tracking-wider items-center ${
              stage.isKey
                ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-900"
                : "bg-transparent text-slate-500 border border-slate-200 dark:border-slate-700"
            }`}>
              {b}
            </span>
          ))}
        </h4>
        <p className="text-[12.5px] text-slate-600 dark:text-slate-400 leading-snug">
          {stage.desc}
        </p>
      </div>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0e0e10] p-2.5 space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">当前使用</div>
        <Select value={assignment?.providerId ?? NONE} onValueChange={handleProviderChange}>
          <SelectTrigger className="h-7 text-[12px] bg-white dark:bg-[#14151a] border-slate-200 dark:border-slate-800">
            <SelectValue placeholder="选供应商">
              {selectedProvider ? selectedProvider.name : "选供应商"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不启用</SelectItem>
            {candidateProviders.length === 0 && (
              <SelectItem value={NONE} disabled>没有符合能力的供应商</SelectItem>
            )}
            {candidateProviders.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assignment?.modelId ?? NONE} onValueChange={handleModelChange} disabled={!selectedProvider}>
          <SelectTrigger className="h-7 text-[12px] bg-white dark:bg-[#14151a] border-slate-200 dark:border-slate-800 font-mono">
            <SelectValue placeholder="选模型">
              {(() => {
                if (!assignment || !selectedProvider) return "选模型";
                const m = selectedProvider.models.find((x) => x.id === assignment.modelId);
                return m?.label || assignment.modelId;
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {candidateModels.length === 0 && (
              <SelectItem value={NONE} disabled>
                {meta.axis === "vision" ? "该供应商无视觉能力的 model" : "该供应商没有 model"}
              </SelectItem>
            )}
            {candidateModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex items-center gap-2">
                  <span>{m.label}</span>
                  <span className="text-[10px] text-slate-400">{m.capabilities.map((c) => CAPABILITY_LABELS_ZH[c] || c).join(" · ")}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(() => {
          if (!assignment || !selectedProvider) return null;
          const m = selectedProvider.models.find((x) => x.id === assignment.modelId);
          if (!m?.isThinking) return null;
          const on = assignment.enableThinking === true;
          return (
            <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
              <span className="text-[11.5px] text-slate-600 dark:text-slate-400">启用思考</span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => onChange({ ...assignment, enableThinking: !on })}
                className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors ${
                  on
                    ? "bg-indigo-600 border-indigo-600"
                    : "bg-slate-200 dark:bg-slate-700 border-slate-300 dark:border-slate-600"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform mt-[1px] ${
                    on ? "translate-x-3.5" : "translate-x-[1px]"
                  }`}
                />
              </button>
            </label>
          );
        })()}
      </div>
    </div>
  );
};
