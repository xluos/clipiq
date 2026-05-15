import { useApp } from "../AppContext";
import { useConfirm } from "../components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft,
  CheckCircle2,
  DownloadCloud,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { Fragment, type FunctionComponent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  DefaultAnalysisPreset,
  ModelProvider,
  ProviderKind,
  SlotAssignment,
  TaskAxis,
  TaskDifficulty,
  TaskSlotKey,
  VideoGenre,
} from "../types";
import type { LlamaModelInfo, LlamaProgress, LlamaStatus, RuntimeStatus, YtDlpUpdateInfo } from "../electron-api";

type Section = "providers" | "tasks" | "deps" | "local" | "analysis" | "data";

const NONE = "__none__";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "providers", label: "供应商" },
  { key: "tasks", label: "任务分配" },
  { key: "local", label: "本地推理" },
  { key: "deps", label: "本地依赖" },
  { key: "analysis", label: "默认分析" },
  { key: "data", label: "项目数据" },
];

function whisperModelHint(modelId?: string) {
  switch (modelId) {
    case "ggml-tiny":
      return "~75 MB · 最快,但中文准确率一般,适合英文 / 噪声小的素材。";
    case "ggml-small":
      return "~466 MB · 中文较准,速度适中,常规拉片推荐。";
    case "ggml-medium":
      return "~1.5 GB · 准确率高,速度慢,长视频耗时较多。";
    case "ggml-base":
    default:
      return "~142 MB · 默认选项,速度和准确率折中。";
  }
}

// ModelCapability (provider.models[i].capabilities) 的中文映射,任务分配 dropdown 用
const CAPABILITY_LABELS_ZH: Record<string, string> = {
  vision: "视觉",
  reasoning: "推理",
  fast: "快速",
  audio_transcription: "音频",
};

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit += 1;
  }
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function SettingsScreen() {
  const { setCurrentScreen } = useApp();
  const [section, setSection] = useState<Section>("providers");

  return (
    <div className="flex-1 flex h-full">
      <main className="flex-1 flex bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
        <aside className="w-48 border-r border-slate-200 dark:border-slate-800/50 bg-white dark:bg-[#0E0E10] p-4 space-y-1 overflow-y-auto hidden md:block">
          <div className="flex items-center gap-1.5 pl-1 mt-2 mb-4">
            <button
              type="button"
              onClick={() => setCurrentScreen("home")}
              className="p-1.5 -ml-1 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="返回首页"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">设置</div>
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                section === s.key
                  ? "bg-indigo-50 dark:bg-indigo-600/20 text-indigo-600 dark:text-indigo-400 font-medium"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50"
              }`}
            >
              {s.label}
            </button>
          ))}
        </aside>

        <div className="flex-1 overflow-y-auto p-8 md:p-12">
          <div className="max-w-3xl space-y-8">
            {section === "providers" && <ProvidersSection />}
            {section === "tasks" && <TaskAssignmentSection />}
            {section === "deps" && <DepsSection />}
            {section === "local" && <LocalInferenceSection />}
            {section === "analysis" && <AnalysisDefaultsSection />}
            {section === "data" && <DataSection />}
          </div>
        </div>
      </main>
    </div>
  );
}

function ProvidersSection() {
  const {
    providers,
    setProviders,
    activeVideoProviderId,
    setActiveVideoProviderId,
    activeAudioProviderId,
    setActiveAudioProviderId,
  } = useApp();
  const confirm = useConfirm();

  const videoProviders = useMemo(() => providers.filter((p) => p.kind === "video"), [providers]);
  const audioProviders = useMemo(() => providers.filter((p) => p.kind === "audio"), [providers]);

  const updateProvider = useCallback(
    (id: string, patch: Partial<ModelProvider>) => {
      setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    [setProviders]
  );

  const handleAdd = (kind: ProviderKind) => {
    const id = `provider-${Date.now()}`;
    const draft: ModelProvider = kind === "audio"
      ? {
          id,
          name: "新语音模型",
          source: "remote",
          baseUrl: "https://api.openai.com/v1",
          apiKeyRef: "",
          endpointType: "openai_audio_transcriptions",
          inputMode: "keyframe_sequence",
          models: [
            {
              id: "whisper-1",
              label: "whisper-1",
              capabilities: ["audio_transcription"],
              language: "zh",
            },
          ],
          model: "whisper-1",
          kind: "audio",
          language: "zh",
        }
      : {
          id,
          name: "新视觉模型",
          source: "remote",
          baseUrl: "https://api.openai.com/v1",
          apiKeyRef: "",
          endpointType: "openai_chat_completions",
          inputMode: "auto",
          models: [
            {
              id: "gpt-4o-mini",
              label: "gpt-4o-mini",
              capabilities: ["vision", "reasoning"],
            },
          ],
          model: "gpt-4o-mini",
          kind: "video",
        };
    setProviders((prev) => [...prev, draft]);
  };

  const handleDelete = async (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const ok = await confirm({
      title: "删除供应商",
      description: `确定删除「${p.name}」?这个供应商配置将从应用中移除。`,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    setProviders((prev) => prev.filter((x) => x.id !== id));
    if (activeVideoProviderId === id) {
      const next = providers.find((x) => x.kind === "video" && x.id !== id);
      setActiveVideoProviderId(next?.id ?? null);
    }
    if (activeAudioProviderId === id) setActiveAudioProviderId(null);
  };

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">供应商</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 -mt-4">
        管理可用的模型供应商。在「任务分配」里挑选每个分析步骤实际使用哪个。
      </p>

      <ProviderGroup
        kind="video"
        title="视觉模型"
        emptyHint="还没有添加视觉模型,点右上「新增」配置一个。"
        providers={videoProviders}
        activeId={activeVideoProviderId}
        onAdd={() => handleAdd("video")}
        onSetDefault={(id) => setActiveVideoProviderId(id)}
        onDelete={handleDelete}
        onUpdate={updateProvider}
      />

      <ProviderGroup
        kind="audio"
        title="字幕识别"
        emptyHint="还没有添加字幕识别服务,点右上「新增」配置一个。"
        providers={audioProviders}
        activeId={activeAudioProviderId}
        onAdd={() => handleAdd("audio")}
        onSetDefault={(id) => setActiveAudioProviderId(id)}
        onDelete={handleDelete}
        onUpdate={updateProvider}
      />
    </>
  );
}

type SlotMeta = {
  key: TaskSlotKey;
  label: string;
  difficulty: TaskDifficulty;
  axis: TaskAxis;
  hint: string;
  used: boolean;
};

const SLOT_METAS: SlotMeta[] = [
  { key: "simple_vision", label: "简单 · 视觉", difficulty: "simple", axis: "vision", hint: "用于本地视觉初筛打标", used: true },
  { key: "medium_text", label: "中等 · 文本", difficulty: "medium", axis: "text", hint: "用于字幕推断视频类型", used: true },
  { key: "complex_vision", label: "复杂 · 视觉", difficulty: "complex", axis: "vision", hint: "用于主分析:拉片打标 + 方法论审计", used: true },
];

const PIPELINE_STAGES: Array<{
  num: string;
  title: string;
  badges: string[];
  desc: string;
  slot: TaskSlotKey | "__audio__";
  isKey?: boolean;
}> = [
  { num: "01", title: "抽帧初筛", badges: ["simple · vision"], desc: "对每秒 1-2 帧的抽帧打标(场景类型、主体、是否空帧),过滤重复与低信息量帧。", slot: "simple_vision" },
  { num: "02", title: "字幕识别", badges: ["audio"], desc: "从音轨提取台词,作为节点字幕来源。", slot: "__audio__" },
  { num: "03", title: "镜头合并 + 全局摘要", badges: ["medium · text"], desc: "把同一镜头的若干帧合并成镜头描述,聚合成全局摘要并推断视频类型。", slot: "medium_text" },
  { num: "04", title: "主分析", badges: ["complex · vision"], desc: "基于镜头描述 + 字幕 + 关键帧,产出节点评审、方法论审计、情绪曲线。", slot: "complex_vision", isKey: true },
];

function TaskAssignmentSection() {
  const { providers, taskSlots, setTaskSlot, audioSlot, setAudioSlot } = useApp();

  const slotMetaByKey: Record<string, SlotMeta> = SLOT_METAS.reduce((acc, m) => {
    acc[m.key] = m;
    return acc;
  }, {} as Record<string, SlotMeta>);
  const audioMeta: SlotMeta = {
    key: "__audio__" as unknown as TaskSlotKey,
    label: "字幕识别",
    difficulty: "simple",
    axis: "text",
    hint: "本地 Whisper 速度快、隐私好;远端服务准确度更高",
    used: true,
  };

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">分析管线</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 -mt-4">
        每一步绑定独立模型。
      </p>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden">
        {PIPELINE_STAGES.map((stage, idx) => {
          const isAudio = stage.slot === "__audio__";
          const meta = isAudio ? audioMeta : slotMetaByKey[stage.slot];
          const assignment = isAudio ? audioSlot : taskSlots[stage.slot as TaskSlotKey];
          const onChange = isAudio
            ? (a: SlotAssignment) => setAudioSlot(a)
            : (a: SlotAssignment) => setTaskSlot(stage.slot as TaskSlotKey, a);
          return (
            <PipelineRow
              key={stage.slot}
              stage={stage}
              isFirst={idx === 0}
              providers={providers}
              meta={meta}
              assignment={assignment}
              onChange={onChange}
              audioMode={isAudio}
            />
          );
        })}
      </div>
    </>
  );
}

type PipelineRowProps = {
  stage: { num: string; title: string; badges: string[]; desc: string; isKey?: boolean };
  isFirst: boolean;
  providers: ModelProvider[];
  meta: SlotMeta;
  assignment: SlotAssignment;
  onChange: (a: SlotAssignment) => void;
  audioMode?: boolean;
};

const PipelineRow: FunctionComponent<PipelineRowProps> = ({
  stage, isFirst, providers, meta, assignment, onChange, audioMode,
}) => {
  const candidateProviders = audioMode
    ? providers.filter((p) =>
        p.models.some((m) => m.capabilities.includes("audio_transcription")) ||
        p.endpointType === "openai_audio_transcriptions" ||
        p.endpointType === "local_whisper_cpp",
      )
    : providers.filter((p) =>
        meta.axis === "vision"
          ? p.models.some((m) => m.capabilities.includes("vision"))
          : true,
      );
  const selectedProvider = assignment ? providers.find((p) => p.id === assignment.providerId) : null;
  const candidateModels = (() => {
    if (!selectedProvider) return [];
    if (audioMode) {
      return selectedProvider.models.filter(
        (m) =>
          m.capabilities.includes("audio_transcription") ||
          selectedProvider.endpointType === "openai_audio_transcriptions" ||
          selectedProvider.endpointType === "local_whisper_cpp",
      );
    }
    if (meta.axis === "vision") {
      return selectedProvider.models.filter((m) => m.capabilities.includes("vision"));
    }
    return selectedProvider.models;
  })();

  const handleProviderChange = (id: string) => {
    if (id === NONE) {
      onChange(null);
      return;
    }
    const p = providers.find((x) => x.id === id);
    const firstModel = audioMode
      ? p?.models.find((m) => m.capabilities.includes("audio_transcription")) || p?.models[0]
      : meta.axis === "vision"
      ? p?.models.find((m) => m.capabilities.includes("vision")) || p?.models[0]
      : p?.models[0];
    onChange(firstModel ? { providerId: id, modelId: firstModel.id } : null);
  };

  const handleModelChange = (id: string) => {
    if (!assignment) return;
    onChange({ ...assignment, modelId: id });
  };

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
      </div>
    </div>
  );
}

function ProviderGroup({
  kind,
  title,
  emptyHint,
  providers,
  activeId,
  onAdd,
  onSetDefault,
  onDelete,
  onUpdate,
}: {
  kind: ProviderKind;
  title: string;
  emptyHint: string;
  providers: ModelProvider[];
  activeId: string | null;
  onAdd: () => void;
  onSetDefault: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ModelProvider>) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
        <Button variant="outline" size="sm" onClick={onAdd} className="border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10]">
          <Plus className="w-4 h-4 mr-1" /> 新增
        </Button>
      </div>
      {providers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 p-6 text-sm text-slate-500 dark:text-slate-400">
          {emptyHint}
        </div>
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => (
            <Fragment key={provider.id}>
              <ProviderCard
                provider={provider}
                isDefault={activeId === provider.id}
                onSetDefault={() => onSetDefault(provider.id)}
                onDelete={() => onDelete(provider.id)}
                onUpdate={(patch) => onUpdate(provider.id, patch)}
                kind={kind}
              />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function ProviderCard({
  provider: persisted,
  isDefault,
  onSetDefault,
  onDelete,
  onUpdate: persist,
  kind,
}: {
  provider: ModelProvider;
  isDefault: boolean;
  onSetDefault: () => void;
  onDelete: () => void;
  onUpdate: (patch: Partial<ModelProvider>) => void;
  kind: ProviderKind;
}) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [whisperCache, setWhisperCache] = useState<{ cached: boolean; sizeBytes?: number } | null>(null);
  const [draft, setDraft] = useState<ModelProvider>(persisted);

  // 当外部 persisted 引用变化（保存后 / 切换默认 / 改名），同步 draft
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const isDirty = useMemo(() => {
    const keys: (keyof ModelProvider)[] = [
      "name",
      "baseUrl",
      "apiKeyRef",
      "model",
      "endpointType",
      "language",
      "localWhisperModel",
      "localWhisperMirror",
    ];
    return keys.some((k) => (draft[k] ?? "") !== (persisted[k] ?? ""));
  }, [draft, persisted]);

  // 这两个别名让下方 JSX 的编辑控件直接走草稿 / 草稿写入,header 和保存提交才走 persisted
  const provider = draft;
  const onUpdate = (patch: Partial<ModelProvider>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const handleSave = () => {
    persist(draft);
  };

  const handleReset = () => {
    setDraft(persisted);
  };

  const isLocalWhisper = draft.endpointType === "local_whisper_cpp";
  const modelKey = isLocalWhisper ? draft.localWhisperModel || draft.model : null;

  // 通过 whisperCpp.listModels 拿"已下载 + size"信息, 给按钮文案提供"已就绪 (XX MB)" / "下载并预热"
  useEffect(() => {
    if (!isLocalWhisper || !modelKey || !window.videoAnalyzer?.whisperCpp) {
      setWhisperCache(null);
      return;
    }
    let cancelled = false;
    setWhisperCache(null);
    window.videoAnalyzer.whisperCpp.listModels().then((models) => {
      if (cancelled) return;
      const target = models.find((m) => m.key === modelKey);
      if (target) {
        setWhisperCache({ cached: target.downloaded, sizeBytes: target.downloadedBytes });
      } else {
        setWhisperCache({ cached: false });
      }
    }).catch(() => {
      if (!cancelled) setWhisperCache({ cached: false });
    });
    return () => {
      cancelled = true;
    };
  }, [isLocalWhisper, modelKey]);

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      if (window.videoAnalyzer) {
        const result = await window.videoAnalyzer.testProvider(draft);
        setTestResult(result);
        if (isLocalWhisper && modelKey && window.videoAnalyzer.whisperCpp) {
          const models = await window.videoAnalyzer.whisperCpp.listModels().catch(() => null);
          const target = models?.find((m) => m.key === modelKey);
          if (target) setWhisperCache({ cached: target.downloaded, sizeBytes: target.downloadedBytes });
        }
        return;
      }
      const response = await fetch(`${draft.baseUrl.replace(/\/+$/, "")}/models`, {
        method: "GET",
        headers: draft.apiKeyRef ? { authorization: `Bearer ${draft.apiKeyRef}` } : {},
      });
      setTestResult({
        ok: response.ok,
        message: response.ok ? "连接成功 (浏览器预览)。" : `请求失败 ${response.status}`,
      });
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsTesting(false);
    }
  };

  const cachedSizeLabel = whisperCache?.cached && whisperCache.sizeBytes
    ? ` · ${formatBytes(whisperCache.sizeBytes)}`
    : "";
  const isWhisperReady = isLocalWhisper && whisperCache?.cached === true;
  const buttonLabel = isTesting
    ? isLocalWhisper
      ? (whisperCache?.cached ? "加载中..." : "下载中...")
      : "测试中..."
    : isLocalWhisper
      ? (isWhisperReady ? `已就绪${cachedSizeLabel}` : "下载并预热")
      : "测试连接";

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] shadow-sm overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-800/60 bg-slate-50/60 dark:bg-slate-900/20">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate font-medium text-slate-800 dark:text-slate-100">{persisted.name}</span>
          {isDefault && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              默认
            </span>
          )}
          {persisted.builtin && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
              内置
            </span>
          )}
          {!persisted.builtin && persisted.endpointType === "local_whisper_cpp" && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
              本地
            </span>
          )}
          {!persisted.builtin && persisted.endpointType !== "local_whisper_cpp" && !persisted.apiKeyRef && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              缺 Key
            </span>
          )}
          {isDirty && (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              未保存
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isDefault && (
            <Button variant="outline" size="sm" onClick={onSetDefault} className="border-slate-200 dark:border-slate-800">
              设为默认
            </Button>
          )}
          {!provider.builtin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              删除
            </Button>
          )}
        </div>
      </header>

      <div className="p-5 space-y-4 text-sm">
        <Field label="名称">
          <Input value={provider.name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder="给这个 Provider 起个名字" />
        </Field>
        {kind === "audio" && (
          <Field
            label="模式"
            hint={
              provider.endpointType === "local_whisper_cpp"
                ? "首次使用会下载模型文件(40 – 500 MB),之后在本机离线运行。"
                : "通过远端 API 转录,需要配 Base URL 和 API Key。"
            }
          >
            <Select
              value={provider.endpointType === "local_whisper_cpp" ? "local_whisper_cpp" : "openai_audio_transcriptions"}
              onValueChange={(v) => {
                const next = v as ModelProvider["endpointType"];
                if (next === "local_whisper_cpp") {
                  onUpdate({
                    endpointType: next,
                    localWhisperModel: provider.localWhisperModel || "ggml-base",
                    localWhisperMirror: provider.localWhisperMirror || "https://hf-mirror.com",
                    model: provider.localWhisperModel || "ggml-base",
                  });
                } else {
                  onUpdate({ endpointType: next });
                }
              }}
            >
              <SelectTrigger className="w-[260px]">
                <SelectValue>
                  {provider.endpointType === "local_whisper_cpp" ? "本地" : "云端"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local_whisper_cpp">本地</SelectItem>
                <SelectItem value="openai_audio_transcriptions">云端</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        {provider.endpointType !== "local_whisper_cpp" && (
          <>
            <Field label="API Base URL">
              <Input
                value={provider.baseUrl}
                onChange={(e) => onUpdate({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="font-mono"
              />
            </Field>
            <Field label="API Key">
              <Input
                type="password"
                value={provider.apiKeyRef}
                onChange={(e) => onUpdate({ apiKeyRef: e.target.value })}
                placeholder="sk-..."
                className="font-mono"
              />
            </Field>
          </>
        )}
        {kind === "video" || provider.endpointType !== "local_whisper_cpp" ? (
          <Field label="模型名">
            <Input
              value={provider.model}
              onChange={(e) => onUpdate({ model: e.target.value })}
              placeholder={kind === "audio" ? "whisper-1 / large-v3 / ..." : "gpt-4o-mini / qwen-vl-max / ..."}
              className="font-mono max-w-[260px]"
            />
          </Field>
        ) : (
          <Field label="本地模型" hint={whisperModelHint(provider.localWhisperModel)}>
            <Select
              value={provider.localWhisperModel || "ggml-base"}
              onValueChange={(v) => onUpdate({ localWhisperModel: v, model: v })}
            >
              <SelectTrigger className="w-[300px]">
                <SelectValue>{provider.localWhisperModel || "ggml-base"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ggml-tiny">whisper-tiny</SelectItem>
                <SelectItem value="ggml-base">whisper-base</SelectItem>
                <SelectItem value="ggml-small">whisper-small</SelectItem>
                <SelectItem value="ggml-medium">whisper-medium</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        {kind === "video" ? (
          <>
            <Field
              label="API 协议"
              hint={
                provider.endpointType === "openai_responses"
                  ? "OpenAI 新版协议，部分网关 / 国产平台尚未完整实现，谨慎使用。"
                  : "兼容性最广，OpenAI / DashScope / 字节豆包 / 智谱等大多数 OpenAI 兼容服务都支持。"
              }
            >
              <Select
                value={provider.endpointType === "openai_responses" ? "openai_responses" : "openai_chat_completions"}
                onValueChange={(v) => onUpdate({ endpointType: v as ModelProvider["endpointType"] })}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue>
                    {provider.endpointType === "openai_responses" ? "/v1/responses" : "/v1/chat/completions"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai_chat_completions">/v1/chat/completions</SelectItem>
                  <SelectItem value="openai_responses">/v1/responses</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </>
        ) : (
          <>
            <Field label="语言提示">
              <Input
                value={provider.language ?? ""}
                onChange={(e) => onUpdate({ language: e.target.value || undefined })}
                placeholder="zh / en / 留空自动"
                className="font-mono max-w-[160px]"
              />
            </Field>
            {provider.endpointType === "local_whisper_cpp" && (
              <Field label="HF 镜像">
                <Input
                  value={provider.localWhisperMirror ?? "https://hf-mirror.com"}
                  onChange={(e) => onUpdate({ localWhisperMirror: e.target.value })}
                  placeholder="https://hf-mirror.com 或 https://huggingface.co"
                  className="font-mono"
                />
              </Field>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-100 dark:border-slate-800/60 bg-slate-50/60 dark:bg-slate-900/20">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={isTesting || (!isLocalWhisper && !provider.baseUrl)}
            className={
              isWhisperReady
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20 shrink-0"
                : "bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 shrink-0"
            }
          >
            {isTesting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin text-slate-400" />
            ) : (
              <CheckCircle2 className={`w-4 h-4 mr-2 ${isWhisperReady ? "text-emerald-500" : "text-slate-400"}`} />
            )}
            {buttonLabel}
          </Button>
          {testResult && (
            <span className={`text-xs flex items-start gap-1.5 min-w-0 break-words ${testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
              {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-none" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 flex-none" />}
              <span>{testResult.message}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isDirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100"
            >
              撤销
            </Button>
          )}
          <Button
            variant={isDirty ? "default" : "outline"}
            size="sm"
            onClick={handleSave}
            disabled={!isDirty}
            className={
              isDirty
                ? "bg-indigo-600 hover:bg-indigo-700 text-white"
                : "border-slate-200 dark:border-slate-800 text-slate-400"
            }
          >
            保存
          </Button>
          <span className="text-[10px] text-slate-400 font-mono">{persisted.id}</span>
        </div>
      </footer>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-3">
      <Label className="text-right text-slate-500 dark:text-slate-400 text-xs pt-2">{label}</Label>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

function DepsSection() {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [ytDlpInfo, setYtDlpInfo] = useState<YtDlpUpdateInfo | null>(null);
  const [ytDlpInstalling, setYtDlpInstalling] = useState(false);
  const [ytDlpStatus, setYtDlpStatus] = useState<string>("");

  const refreshRuntime = useCallback(() => {
    if (!window.videoAnalyzer) return;
    window.videoAnalyzer.getRuntimeStatus().then(setRuntimeStatus).catch(() => setRuntimeStatus(null));
    window.videoAnalyzer.checkYtDlpUpdate().then(setYtDlpInfo).catch(() => setYtDlpInfo(null));
  }, []);

  useEffect(() => {
    refreshRuntime();
    if (!window.videoAnalyzer) return;
    const unsub = window.videoAnalyzer.onYtDlpProgress((p) => {
      setYtDlpStatus(`${p.stage === "download" ? "下载中" : p.stage === "resolve" ? "查询版本" : "完成"}：${p.message}`);
    });
    return unsub;
  }, [refreshRuntime]);

  const handleInstallYtDlp = async () => {
    if (!window.videoAnalyzer) return;
    setYtDlpInstalling(true);
    setYtDlpStatus("");
    try {
      const result = await window.videoAnalyzer.installYtDlp();
      setYtDlpStatus(`已安装 ${result.installedVersion ?? result.latestVersion}`);
      refreshRuntime();
    } catch (error) {
      setYtDlpStatus(`安装失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setYtDlpInstalling(false);
    }
  };

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">本地依赖</h2>
      <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
        <DependencyRow label="ffmpeg" value={runtimeStatus?.ffmpeg} bundled={runtimeStatus?.ffmpegBundled} />
        <DependencyRow label="ffprobe" value={runtimeStatus?.ffprobe} bundled={runtimeStatus?.ffprobeBundled} />
        <DependencyRow
          label="yt-dlp"
          value={runtimeStatus?.ytDlp}
          bundled={runtimeStatus?.ytDlpBundled}
          version={runtimeStatus?.ytDlpVersion ?? ytDlpInfo?.installedVersion}
          latestVersion={ytDlpInfo?.latestVersion}
          updateAvailable={ytDlpInfo?.updateAvailable}
          action={(
            <Button
              size="sm"
              variant="outline"
              disabled={ytDlpInstalling}
              onClick={handleInstallYtDlp}
              className="h-7 border-slate-200 dark:border-slate-800"
            >
              {ytDlpInstalling ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : runtimeStatus?.ytDlp ? (
                <RefreshCw className="w-3 h-3 mr-1" />
              ) : (
                <DownloadCloud className="w-3 h-3 mr-1" />
              )}
              {runtimeStatus?.ytDlp ? "更新" : "安装"}
            </Button>
          )}
        />
        {ytDlpStatus && <p className="text-xs text-slate-500">{ytDlpStatus}</p>}
        {!window.videoAnalyzer && (
          <p className="text-xs text-slate-500">当前是浏览器预览环境，依赖检测只在 Electron 中可用。</p>
        )}
      </section>
    </>
  );
}

// 从 "Qwen3.5-0.8B (Q4_K_M)" 抽 "0.8B"。key 容易把版本号 "3_5" 误识别为 size。
function llamaSizeFromName(name: string) {
  const m = name.match(/-(\d+(?:\.\d+)?B)/i);
  return m ? m[1] : name;
}

// 主能力(决定槽位过滤)的中文标签
const PRIMARY_LABELS: Record<string, string> = {
  vision: "视觉",
  audio: "音频",
  text: "文本",
};

// 副能力(纯展示 hint)的中文标签
const SECONDARY_LABELS: Record<string, string> = {
  chinese: "中文",
  english: "英文",
  code: "代码",
  reasoning: "推理",
  video: "视频",
  long_context: "长上下文",
  fast: "快速",
};

// fit 四档中文化
const FIT_LABELS: Record<string, string> = {
  perfect: "推荐",
  good: "可用",
  marginal: "紧张",
  tight: "不可用",
};

function FitChip({ fit }: { fit?: string }) {
  if (!fit) return null;
  const cls = ({
    perfect: "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300",
    good: "bg-emerald-50/50 border-emerald-100 text-emerald-700 dark:bg-emerald-900/10 dark:border-emerald-900/40 dark:text-emerald-400",
    marginal: "bg-amber-50/40 border-amber-100 text-amber-700 dark:bg-amber-900/10 dark:border-amber-900/40 dark:text-amber-400",
    tight: "bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300",
  } as Record<string, string>)[fit] || "border-slate-200 text-slate-600";
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-2 py-0.5 rounded border ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {FIT_LABELS[fit] || fit}
    </span>
  );
}

type ManifestModel = {
  key: string;
  family: string;
  params: string;
  name: string;
  description: string;
  primaryCapabilities: string[];
  secondaryTags: string[];
  available: boolean;
  contextSize: number;
  quantizations: Array<{ key: string; label: string; sizeBytes: number }>;
  fit?: string;
  memPercent?: number;
  tps?: number;
  downloaded?: boolean;
};

type MachineInfo = {
  platform: string;
  arch: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  isAppleSilicon: boolean;
  cpuModel: string;
  backend: string;
  speedConstant: number;
  recommendedQuant: string;
};

function LocalInferenceSection() {
  const [status, setStatus] = useState<LlamaStatus | null>(null);
  const [machine, setMachine] = useState<MachineInfo | null>(null);
  const [manifestModels, setManifestModels] = useState<ManifestModel[]>([]);
  const [progress, setProgress] = useState<LlamaProgress | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"binary" | "download" | "start" | "stop" | "selftest" | null>(null);
  const [error, setError] = useState<string>("");
  const [selfTestImage, setSelfTestImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [selfTestResult, setSelfTestResult] = useState<{
    latencyMs: number;
    text: string;
    usage: { total_tokens?: number } | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!window.videoAnalyzer?.llama) return;
    const [s, manifest] = await Promise.all([
      window.videoAnalyzer.llama.getStatus(),
      window.videoAnalyzer.llama.listManifest(),
    ]);
    setStatus(s);
    setMachine(manifest.machine as unknown as MachineInfo);
    setManifestModels(manifest.models as unknown as ManifestModel[]);
  }, []);

  useEffect(() => {
    refresh();
    if (!window.videoAnalyzer?.llama) return;
    const unsub = window.videoAnalyzer.llama.onProgress((event) => {
      setProgress(event);
    });
    return unsub;
  }, [refresh]);

  const handleStart = async (modelKey: string) => {
    if (!window.videoAnalyzer?.llama) return;
    setError("");
    setProgress(null);
    setBusyKey(modelKey);
    try {
      const currentStatus = await window.videoAnalyzer.llama.getStatus();
      if (!currentStatus.binaryFound) {
        setBusyAction("binary");
        await window.videoAnalyzer.llama.ensureBinary();
      }
      const target = manifestModels.find((m) => m.key === modelKey);
      if (target && !target.downloaded) {
        setBusyAction("download");
        await window.videoAnalyzer.llama.ensureModel(modelKey);
      }
      setBusyAction("start");
      await window.videoAnalyzer.llama.start(modelKey);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusyAction(null);
      setBusyKey(null);
    }
  };

  const handleStop = async () => {
    if (!window.videoAnalyzer?.llama) return;
    setBusyAction("stop");
    try {
      await window.videoAnalyzer.llama.stop();
      await refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handlePickImage = async (file: File) => {
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
    setSelfTestImage({ name: file.name, dataUrl });
    setSelfTestResult(null);
  };

  const handleSelfTest = async () => {
    if (!window.videoAnalyzer?.llama) return;
    if (!selfTestImage) {
      setError("请先选择一张图片");
      return;
    }
    setBusyAction("selftest");
    setError("");
    setSelfTestResult(null);
    try {
      const result = await window.videoAnalyzer.llama.selfTest({
        imageDataUrl: selfTestImage.dataUrl,
        prompt: "用 1-2 句中文描述这张图片的主体、场景和氛围。",
      });
      setSelfTestResult({
        latencyMs: result.latencyMs,
        text: result.text,
        usage: result.usage,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  };

  if (!window.videoAnalyzer?.llama) {
    return (
      <>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">本地推理</h2>
        <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm text-sm text-slate-500">
          当前是浏览器预览环境,本地推理只在 Electron 中可用。
        </section>
      </>
    );
  }

  const runningKey = status?.running ? status.modelKey : null;
  const isAnyBusy = busyAction !== null && busyAction !== "selftest";

  const visionModels = manifestModels.filter((m) => m.primaryCapabilities.includes("vision"));
  const textModels = manifestModels.filter((m) =>
    !m.primaryCapabilities.includes("vision") && m.primaryCapabilities.includes("text")
  );

  const showProgress =
    progress && (busyAction === "binary" || busyAction === "download") && progress.percent != null;

  const totalMemoryGB = machine ? machine.totalMemoryBytes / 1024 / 1024 / 1024 : 0;
  const availMemoryGB = machine ? machine.availableMemoryBytes / 1024 / 1024 / 1024 : 0;
  const sysReservedGB = totalMemoryGB - availMemoryGB;

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">本地推理</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 -mt-4">
        下载与管理可在本机运行的开源模型。任务分配里再决定每个步骤用哪个。
      </p>

      {/* Machine banner */}
      {machine && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] px-5 py-3.5 grid grid-cols-[auto_1fr_auto] gap-5 items-center">
          <div className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 grid place-items-center font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-300">
            {machine.isAppleSilicon ? machine.arch.toUpperCase() : machine.platform}
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[12.5px] text-slate-900 dark:text-slate-100">
              {machine.cpuModel} · {totalMemoryGB.toFixed(0)} GB unified memory
            </div>
            <div className="text-[12px] text-slate-500 dark:text-slate-400">
              系统占用 <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">~{sysReservedGB.toFixed(1)} GB</code>
              {" · "}可用于推理 <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">~{availMemoryGB.toFixed(1)} GB</code>
              {" · "}{machine.backend === "metal" ? "Metal" : machine.backend === "cuda" ? "CUDA" : machine.backend === "rocm" ? "ROCm" : "CPU"} 后端
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">建议量化</span>
            <span className="font-mono text-[12.5px] px-2 py-0.5 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300">
              {machine.recommendedQuant}
            </span>
          </div>
        </section>
      )}

      {/* 模型库 */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-baseline justify-between bg-slate-50/60 dark:bg-slate-900/20">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">本地模型库</h3>
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500">按能力分组 · 按适配度排序</span>
        </div>

        <div className="p-5 space-y-6">
          <ModelGroup
            title="视觉 · 多模态"
            subtitle="用于 simple_vision / medium_vision / complex_vision · 也可被 text 槽位选"
            models={visionModels}
            runningKey={runningKey}
            busyKey={busyKey}
            busyAction={busyAction}
            isAnyBusy={isAnyBusy}
            onStart={handleStart}
            onStop={handleStop}
          />
          <ModelGroup
            title="纯文本"
            subtitle="仅用于 simple_text / medium_text / complex_text"
            models={textModels}
            runningKey={runningKey}
            busyKey={busyKey}
            busyAction={busyAction}
            isAnyBusy={isAnyBusy}
            onStart={handleStart}
            onStop={handleStop}
          />
        </div>

        {showProgress && (
          <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-2.5 bg-slate-50/60 dark:bg-slate-900/20">
            <Progress value={progress!.percent || 0} className="h-1.5" />
            <div className="text-[11px] text-slate-500 mt-1.5">{progress!.message}</div>
          </div>
        )}

        {error && (
          <div className="border-t border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-5 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
      </section>

      <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">自检</h3>
          <span className="text-[11px] text-slate-400">需先启动模型</span>
        </div>
        <p className="text-xs text-slate-500">
          选一张本地图片(可以是项目里抽的视频帧),让运行中的模型描述它,验证视觉链路是否真的工作,顺便看每帧推理延迟。
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handlePickImage(f);
              }}
            />
            <span className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-xs">
              {selfTestImage ? "更换图片" : "选择图片"}
            </span>
          </label>
          {selfTestImage && (
            <span className="text-xs text-slate-500 truncate max-w-xs">{selfTestImage.name}</span>
          )}
          <Button
            size="sm"
            disabled={!selfTestImage || !status?.running || busyAction === "selftest"}
            onClick={handleSelfTest}
            className="h-8"
          >
            {busyAction === "selftest" && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            运行自检
          </Button>
        </div>
        {selfTestImage && (
          <img
            src={selfTestImage.dataUrl}
            alt="self-test"
            className="max-h-48 rounded border border-slate-200 dark:border-slate-800"
          />
        )}
        {selfTestResult && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/10 dark:border-emerald-800 p-3 text-sm space-y-2">
            <div className="text-xs text-emerald-700 dark:text-emerald-300 font-mono">
              延迟 {selfTestResult.latencyMs} ms
              {selfTestResult.usage?.total_tokens != null && ` · ${selfTestResult.usage.total_tokens} tokens`}
            </div>
            <div className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{selfTestResult.text}</div>
          </div>
        )}
      </section>
    </>
  );
}

type ModelGroupProps = {
  title: string;
  subtitle: string;
  models: ManifestModel[];
  runningKey: string | null | undefined;
  busyKey: string | null;
  busyAction: "binary" | "download" | "start" | "stop" | "selftest" | null;
  isAnyBusy: boolean;
  onStart: (modelKey: string) => void;
  onStop: () => void;
};

const ModelGroup: FunctionComponent<ModelGroupProps> = ({
  title, subtitle, models, runningKey, busyKey, busyAction, isAnyBusy, onStart, onStop,
}) => {
  if (models.length === 0) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-[12.5px] font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{subtitle}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {models.map((m) => (
          <ModelCard
            key={m.key}
            model={m}
            runningKey={runningKey}
            busyKey={busyKey}
            busyAction={busyAction}
            isAnyBusy={isAnyBusy}
            onStart={onStart}
            onStop={onStop}
          />
        ))}
      </div>
    </div>
  );
};

type ModelCardProps = {
  model: ManifestModel;
  runningKey: string | null | undefined;
  busyKey: string | null;
  busyAction: "binary" | "download" | "start" | "stop" | "selftest" | null;
  isAnyBusy: boolean;
  onStart: (modelKey: string) => void;
  onStop: () => void;
};

const ModelCard: FunctionComponent<ModelCardProps> = ({
  model, runningKey, busyKey, busyAction, isAnyBusy, onStart, onStop,
}) => {
  const isRunning = runningKey === model.key;
  const isDownloaded = !!model.downloaded;
  const isBusy = busyKey === model.key && isAnyBusy;
  const defaultQuant = model.quantizations[0];

  let action: { label: string; variant: "default" | "outline" | "ghost"; onClick?: () => void; disabled?: boolean };
  if (!model.available) {
    action = { label: "即将上线", variant: "ghost", disabled: true };
  } else if (isBusy) {
    const lbl = busyAction === "binary" ? "下载引擎…" : busyAction === "download" ? "下载…" : "启动…";
    action = { label: lbl, variant: "outline", disabled: true };
  } else if (isRunning) {
    action = { label: "停止", variant: "outline", onClick: onStop };
  } else if (runningKey) {
    action = { label: "切换", variant: "default", onClick: () => onStart(model.key) };
  } else if (!isDownloaded) {
    action = { label: "下载", variant: "default", onClick: () => onStart(model.key) };
  } else {
    action = { label: "启动", variant: "default", onClick: () => onStart(model.key) };
  }

  const cardCls = isRunning
    ? "border-indigo-300 bg-indigo-50/50 dark:border-indigo-500/40 dark:bg-indigo-500/10 shadow-[inset_2px_0_0] shadow-indigo-600"
    : isDownloaded
      ? "border-indigo-200 bg-indigo-50/30 dark:border-indigo-500/30 dark:bg-indigo-500/5"
      : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10]";

  const statusPill = isRunning
    ? <span className="font-mono text-[9.5px] uppercase tracking-wide bg-emerald-100 border border-emerald-200 text-emerald-700 px-1.5 py-0.5 rounded dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300">运行中</span>
    : isDownloaded
      ? <span className="font-mono text-[9.5px] uppercase tracking-wide bg-indigo-100 border border-indigo-200 text-indigo-700 px-1.5 py-0.5 rounded dark:bg-indigo-900/30 dark:border-indigo-700 dark:text-indigo-300">已安装</span>
      : null;

  return (
    <div className={`relative rounded-lg border ${cardCls} p-3 flex flex-col gap-1.5`}>
      {/* row1 — 身份 */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-semibold text-[13px] text-slate-900 dark:text-slate-100 truncate">{model.name}</span>
        {statusPill}
        <span className="flex-1" />
        <FitChip fit={model.fit} />
        <button
          type="button"
          disabled={action.disabled}
          onClick={action.onClick}
          className={
            action.variant === "default"
              ? "px-2.5 py-1 text-[11.5px] rounded border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium shrink-0"
              : action.variant === "outline"
                ? "px-2.5 py-1 text-[11.5px] rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                : "px-2.5 py-1 text-[11.5px] rounded text-slate-400 disabled:cursor-not-allowed shrink-0"
          }
        >
          {action.label}
        </button>
      </div>

      {/* row2 — 数字 meta */}
      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
        <span className="bg-white dark:bg-[#0A0A0B] border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded">
          {defaultQuant?.label || "—"}
        </span>
        <span className="text-slate-300">·</span>
        <span className="text-slate-700 dark:text-slate-300">{formatBytes(defaultQuant?.sizeBytes || 0)}</span>
        <span className="text-slate-300">·</span>
        <span><span className="text-slate-700 dark:text-slate-300">{model.memPercent ?? 0}%</span> 内存</span>
        <span className="text-slate-300">·</span>
        <span><span className="text-slate-700 dark:text-slate-300">{model.tps ?? 0}</span> tok/s</span>
      </div>

      {/* row3 — 能力 chip */}
      <div className="flex flex-wrap gap-1">
        {model.primaryCapabilities.map((cap) => (
          <span key={cap} className="text-[10.5px] px-1.5 py-0.5 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300">
            {PRIMARY_LABELS[cap] || cap}
          </span>
        ))}
        {model.secondaryTags.map((tag) => (
          <span key={tag} className="text-[10.5px] px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
            {SECONDARY_LABELS[tag] || tag}
          </span>
        ))}
      </div>
    </div>
  );
};

const PRESET_OPTIONS: { key: DefaultAnalysisPreset; title: string; est: string; hint: string }[] = [
  { key: "quick", title: "轻拉片", est: "~ 45s", hint: "5-8 个节点;不跑方法论审计。" },
  { key: "standard", title: "标准拉片", est: "~ 2 min", hint: "10-15 个节点 + 字幕 + 方法论审计。" },
  { key: "deep", title: "深度拉片", est: "~ 5 min", hint: "20+ 节点;含构图 / 剪辑意图反推。" },
];

const GENRE_OPTIONS: { value: VideoGenre | "auto"; label: string }[] = [
  { value: "auto", label: "自动识别" },
  { value: "vlog", label: "vlog" },
  { value: "review", label: "测评" },
  { value: "short-drama", label: "短剧" },
];

function AnalysisDefaultsSection() {
  const { defaultAnalysis, setDefaultAnalysis } = useApp();

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">默认分析</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 -mt-4">
        新建项目首次进入「准备分析」时使用的默认参数。每个项目仍可单独覆盖。
      </p>

      <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800/60">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-3">默认拉片强度</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {PRESET_OPTIONS.map((p) => {
              const active = defaultAnalysis.preset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setDefaultAnalysis((prev) => ({ ...prev, preset: p.key }))}
                  className={`text-left rounded-lg border p-4 transition-colors ${
                    active
                      ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 dark:border-indigo-500/50"
                      : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0A0A0B] hover:border-slate-300 dark:hover:border-slate-700"
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className={`text-sm font-semibold ${active ? "text-indigo-700 dark:text-indigo-300" : "text-slate-900 dark:text-slate-100"}`}>
                      {p.title}
                    </span>
                    <span className="font-mono text-[10.5px] text-slate-500">{p.est}</span>
                  </div>
                  <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1.5 leading-snug">{p.hint}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-3">默认视频类型</div>
          <div className="flex flex-wrap gap-2">
            {GENRE_OPTIONS.map((g) => {
              const active = defaultAnalysis.manualGenre === g.value;
              return (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setDefaultAnalysis((prev) => ({ ...prev, manualGenre: g.value }))}
                  className={`h-8 px-3 rounded-md border text-xs transition-colors ${
                    active
                      ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:border-indigo-500/50 dark:text-indigo-300"
                      : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0A0A0B] text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700"
                  }`}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-2.5">
            选「自动识别」时,管线会让 LLM 根据字幕和镜头切换推断;指定具体类型可加载对应规则集。
          </p>
        </div>
      </section>
    </>
  );
}

function DataSection() {
  const { projects } = useApp();
  const confirm = useConfirm();
  const [info, setInfo] = useState<{
    userDataPath: string;
    projectsPath: string;
    configPath: string;
    dbPath: string;
    projectCount: number;
    dbProjectCount: number;
    totalBytes: number;
    dbBytes: number;
  } | null>(null);
  const [purging, setPurging] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const refresh = useCallback(() => {
    if (!window.videoAnalyzer) return;
    window.videoAnalyzer.getDataInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleOpenUserData = async () => {
    if (!window.videoAnalyzer) return;
    await window.videoAnalyzer.openDataFolder("userData");
  };
  const handleOpenProjects = async () => {
    if (!window.videoAnalyzer) return;
    await window.videoAnalyzer.openDataFolder("projects");
  };
  const handlePurge = async () => {
    if (!window.videoAnalyzer) return;
    const ok = await confirm({
      title: "清空本地项目数据",
      description: `确定清空 ${info?.projectCount ?? 0} 个项目的本地文件?此操作不可恢复;应用内的项目列表需要单独从首页删除。`,
      confirmLabel: "清空",
      destructive: true,
    });
    if (!ok) return;
    setPurging(true);
    setStatusMessage("");
    try {
      const result = await window.videoAnalyzer.purgeProjects();
      setStatusMessage(result.ok ? "已清空项目本地文件。" : `清空失败：${result.message}`);
      refresh();
    } finally {
      setPurging(false);
    }
  };

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">项目数据</h2>
      <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4 text-sm">
        <Stat label="项目数量（应用内）" value={`${projects.length} 个`} />
        <Stat label="项目数量（SQLite）" value={info ? `${info.dbProjectCount} 个` : "—"} />
        <Stat label="项目数量（磁盘目录）" value={info ? `${info.projectCount} 个` : "—"} />
        <Stat label="项目目录占用" value={info ? formatBytes(info.totalBytes) : "—"} />
        <Stat label="SQLite 大小" value={info ? formatBytes(info.dbBytes) : "—"} />
        <Stat label="userData 路径" value={info?.userDataPath ?? "—"} mono />
        <Stat label="config.json" value={info?.configPath ?? "—"} mono />
        <Stat label="data.db" value={info?.dbPath ?? "—"} mono />
        <Stat label="项目根目录" value={info?.projectsPath ?? "—"} mono />

        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleOpenUserData} disabled={!window.videoAnalyzer} className="border-slate-200 dark:border-slate-800">
            <FolderOpen className="w-4 h-4 mr-1.5" />
            打开 userData
          </Button>
          <Button variant="outline" size="sm" onClick={handleOpenProjects} disabled={!window.videoAnalyzer} className="border-slate-200 dark:border-slate-800">
            <FolderOpen className="w-4 h-4 mr-1.5" />
            打开项目根目录
          </Button>
          <Button variant="ghost" size="sm" onClick={refresh} className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100">
            <RefreshCw className="w-4 h-4 mr-1.5" />
            刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={purging}
            onClick={handlePurge}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            <Trash2 className="w-4 h-4 mr-1.5" />
            清空所有项目文件
          </Button>
        </div>
        {statusMessage && <p className="text-xs text-slate-500">{statusMessage}</p>}
      </section>
    </>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-start gap-3">
      <span className="text-slate-500 dark:text-slate-400 text-right">{label}</span>
      <span className={`min-w-0 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function DependencyRow({
  label,
  value,
  bundled,
  version,
  latestVersion,
  updateAvailable,
  action,
}: {
  label: string;
  value?: string | null;
  bundled?: boolean;
  version?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  action?: ReactNode;
}) {
  const ok = Boolean(value);
  const displayValue = version || (bundled ? "已内置" : value);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-[#0A0A0B]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <span className="font-mono text-xs text-slate-600 dark:text-slate-400">{label}</span>
          {bundled && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 whitespace-nowrap dark:bg-emerald-500/15 dark:text-emerald-300">
              内置
            </span>
          )}
          {ok && !bundled && (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600 whitespace-nowrap dark:bg-slate-800 dark:text-slate-300">
              系统
            </span>
          )}
          {updateAvailable && (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 whitespace-nowrap dark:bg-indigo-500/15 dark:text-indigo-300">
              有更新
            </span>
          )}
        </div>
        <span
          title={value || ""}
          className={`min-w-0 flex-1 truncate text-right font-mono text-xs ${ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
        >
          {ok ? displayValue : "未检测到"}
        </span>
      </div>
      {(latestVersion || action) && (
        <div className="flex items-center justify-between gap-3 pl-1">
          <span className="text-[10px] text-slate-500 dark:text-slate-500 font-mono truncate">
            {latestVersion ? `最新: ${latestVersion}` : ""}
          </span>
          {action}
        </div>
      )}
    </div>
  );
}
