import { useApp } from "../AppContext";
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
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ModelInputMode,
  ModelProvider,
  ProviderKind,
  SlotAssignment,
  TaskAxis,
  TaskDifficulty,
  TaskSlotKey,
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
    case "Xenova/whisper-tiny":
      return "~40 MB · 最快，但中文准确率一般，适合英文 / 噪声小的素材。";
    case "Xenova/whisper-small":
      return "~250 MB · 中文较准，速度适中，常规拉片推荐。";
    case "Xenova/whisper-medium":
      return "~500 MB · 准确率高，速度慢，长视频耗时较多。";
    case "Xenova/whisper-base":
    default:
      return "~75 MB · 默认选项，速度和准确率折中。";
  }
}

function inputModeHint(mode?: string) {
  switch (mode) {
    case "direct_video":
      return "把整段视频直接喂给模型，仅 Gemini Video / Qwen-VL 等少数模型支持。";
    case "keyframe_sequence":
      return "抽取关键帧序列调用模型，兼容性最好，目前默认走这条路径。";
    case "auto":
    default:
      return "暂时等同于抽帧序列，未来会根据模型能力自动切换到直接视频上传。";
  }
}

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

  const handleDelete = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    if (!window.confirm(`确定删除「${p.name}」？`)) return;
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
        统一列出本地推理与远端 OpenAI-compatible 服务。具体哪个任务用哪个,去「任务分配」页配置。
      </p>

      <ProviderGroup
        kind="video"
        title="🎞️ 视觉/多模态供应商"
        emptyHint="还没添加视觉模型,点右上新增按钮添加一个 OpenAI 兼容 chat/completions endpoint。"
        providers={videoProviders}
        activeId={activeVideoProviderId}
        onAdd={() => handleAdd("video")}
        onSetDefault={(id) => setActiveVideoProviderId(id)}
        onDelete={handleDelete}
        onUpdate={updateProvider}
      />

      <ProviderGroup
        kind="audio"
        title="🎙️ 音频字幕供应商"
        emptyHint="还没添加语音模型。配置 OpenAI 兼容 /audio/transcriptions endpoint 即可启用转录。"
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
  used: boolean; // 当前主管线是否消费这个槽
};

const SLOT_METAS: SlotMeta[] = [
  { key: "simple_vision", label: "简单 · 视觉", difficulty: "simple", axis: "vision", hint: "用于本地视觉初筛打标", used: true },
  { key: "simple_text", label: "简单 · 文本", difficulty: "simple", axis: "text", hint: "暂未消费,留作快速文本任务", used: false },
  { key: "medium_vision", label: "中等 · 视觉", difficulty: "medium", axis: "vision", hint: "暂未消费,留作中等视觉任务", used: false },
  { key: "medium_text", label: "中等 · 文本", difficulty: "medium", axis: "text", hint: "用于字幕推断视频类型", used: true },
  { key: "complex_vision", label: "复杂 · 视觉", difficulty: "complex", axis: "vision", hint: "用于主分析:拉片打标 + 方法论审计", used: true },
  { key: "complex_text", label: "复杂 · 文本", difficulty: "complex", axis: "text", hint: "暂未消费,留作复杂文本任务", used: false },
];

function TaskAssignmentSection() {
  const { providers, taskSlots, setTaskSlot, audioSlot, setAudioSlot } = useApp();

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">任务分配</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 -mt-4">
        把每类任务绑到 (供应商, 模型)。主管线按任务难度 + 是否需要视觉自动选择。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {SLOT_METAS.map((meta) => (
          <Fragment key={meta.key}>
            <SlotCard
              meta={meta}
              providers={providers}
              assignment={taskSlots[meta.key]}
              onChange={(a) => setTaskSlot(meta.key, a)}
            />
          </Fragment>
        ))}
      </div>

      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 pt-2 border-t border-slate-200 dark:border-slate-800">
        音频字幕识别
      </h3>
      <p className="text-xs text-slate-500 dark:text-slate-400 -mt-3">
        独立配置,不参与上面的 6 档矩阵。本地 Whisper 或远端 ASR 均可。
      </p>
      <SlotCard
        meta={{
          key: "__audio__" as unknown as TaskSlotKey,
          label: "音频转录",
          difficulty: "simple",
          axis: "text",
          hint: "用于从视频音轨提取字幕",
          used: true,
        }}
        providers={providers}
        assignment={audioSlot}
        onChange={(a) => setAudioSlot(a)}
        audioMode
      />
    </>
  );
}

function SlotCard({
  meta,
  providers,
  assignment,
  onChange,
  audioMode,
}: {
  meta: SlotMeta;
  providers: ModelProvider[];
  assignment: SlotAssignment;
  onChange: (a: SlotAssignment) => void;
  audioMode?: boolean;
}) {
  // 按 axis/audio 模式过滤候选 provider 和 model
  const candidateProviders = audioMode
    ? providers.filter((p) =>
        p.models.some((m) => m.capabilities.includes("audio_transcription")) ||
        p.endpointType === "openai_audio_transcriptions" ||
        p.endpointType === "local_whisper_wasm",
      )
    : providers.filter((p) =>
        // 任意 model 满足 axis 要求即可:vision 槽需要至少一个 vision 能力 model;text 不限
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
          selectedProvider.endpointType === "local_whisper_wasm",
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
    <div
      className={`rounded-xl border ${meta.used ? "border-slate-200 dark:border-slate-800" : "border-dashed border-slate-200 dark:border-slate-800"} bg-white dark:bg-[#0E0E10] p-4 space-y-2.5 shadow-sm`}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{meta.label}</div>
        {!meta.used && (
          <Badge variant="outline" className="text-[10px] text-slate-400 border-slate-200 dark:border-slate-700">
            暂未消费
          </Badge>
        )}
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{meta.hint}</div>

      <Select value={assignment?.providerId ?? NONE} onValueChange={handleProviderChange}>
        <SelectTrigger className="h-8 text-xs bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
          <SelectValue placeholder="选供应商">
            {selectedProvider ? selectedProvider.name : "选供应商"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>不启用</SelectItem>
          {candidateProviders.length === 0 && (
            <SelectItem value={NONE} disabled>
              没有符合能力的供应商
            </SelectItem>
          )}
          {candidateProviders.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={assignment?.modelId ?? NONE} onValueChange={handleModelChange} disabled={!selectedProvider}>
        <SelectTrigger className="h-8 text-xs bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
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
                <span className="text-[10px] text-slate-400">
                  {m.capabilities.join(" · ")}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
      "inputMode",
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

  const isLocalWhisper = draft.endpointType === "local_whisper_wasm";
  const modelKey = isLocalWhisper ? draft.localWhisperModel || draft.model : null;

  useEffect(() => {
    if (!isLocalWhisper || !modelKey || !window.videoAnalyzer) {
      setWhisperCache(null);
      return;
    }
    let cancelled = false;
    setWhisperCache(null);
    window.videoAnalyzer.isWhisperModelCached(modelKey).then((res) => {
      if (!cancelled) setWhisperCache(res);
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
        if (isLocalWhisper && modelKey) {
          const refreshed = await window.videoAnalyzer.isWhisperModelCached(modelKey).catch(() => null);
          if (refreshed) setWhisperCache(refreshed);
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
          {!persisted.builtin && persisted.endpointType === "local_whisper_wasm" && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
              本地
            </span>
          )}
          {!persisted.builtin && persisted.endpointType !== "local_whisper_wasm" && !persisted.apiKeyRef && (
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
              provider.endpointType === "local_whisper_wasm"
                ? "首次使用会从镜像下载 ONNX 模型，体积 40 – 500 MB；推理在本机 CPU，离线可用。"
                : "走 OpenAI 兼容 /audio/transcriptions，需要配 Base URL 和 API Key。"
            }
          >
            <Select
              value={provider.endpointType === "local_whisper_wasm" ? "local_whisper_wasm" : "openai_audio_transcriptions"}
              onValueChange={(v) => {
                const next = v as ModelProvider["endpointType"];
                if (next === "local_whisper_wasm") {
                  onUpdate({
                    endpointType: next,
                    localWhisperModel: provider.localWhisperModel || "Xenova/whisper-base",
                    localWhisperMirror: provider.localWhisperMirror || "https://hf-mirror.com",
                    model: provider.localWhisperModel || "Xenova/whisper-base",
                  });
                } else {
                  onUpdate({ endpointType: next });
                }
              }}
            >
              <SelectTrigger className="w-[260px]">
                <SelectValue>
                  {provider.endpointType === "local_whisper_wasm" ? "本地" : "云端"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local_whisper_wasm">本地</SelectItem>
                <SelectItem value="openai_audio_transcriptions">云端</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        {provider.endpointType !== "local_whisper_wasm" && (
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
        {kind === "video" || provider.endpointType !== "local_whisper_wasm" ? (
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
              value={provider.localWhisperModel || "Xenova/whisper-base"}
              onValueChange={(v) => onUpdate({ localWhisperModel: v, model: v })}
            >
              <SelectTrigger className="w-[300px]">
                <SelectValue>{provider.localWhisperModel || "Xenova/whisper-base"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Xenova/whisper-tiny">whisper-tiny</SelectItem>
                <SelectItem value="Xenova/whisper-base">whisper-base</SelectItem>
                <SelectItem value="Xenova/whisper-small">whisper-small</SelectItem>
                <SelectItem value="Xenova/whisper-medium">whisper-medium</SelectItem>
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
            <Field label="输入模式" hint={inputModeHint(provider.inputMode)}>
              <Select
                value={provider.inputMode}
                onValueChange={(v) => onUpdate({ inputMode: v as ModelInputMode })}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue>
                    {provider.inputMode === "direct_video" ? "直接视频上传" : provider.inputMode === "keyframe_sequence" ? "抽帧序列" : "自动选择"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动选择</SelectItem>
                  <SelectItem value="direct_video">直接视频上传</SelectItem>
                  <SelectItem value="keyframe_sequence">抽帧序列</SelectItem>
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
            {provider.endpointType === "local_whisper_wasm" && (
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

function LocalInferenceSection() {
  const [status, setStatus] = useState<LlamaStatus | null>(null);
  const [models, setModels] = useState<LlamaModelInfo[]>([]);
  const [progress, setProgress] = useState<LlamaProgress | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
    const [s, m] = await Promise.all([
      window.videoAnalyzer.llama.getStatus(),
      window.videoAnalyzer.llama.listModels(),
    ]);
    setStatus(s);
    setModels(m);
  }, []);

  useEffect(() => {
    refresh();
    if (!window.videoAnalyzer?.llama) return;
    const unsub = window.videoAnalyzer.llama.onProgress((event) => {
      setProgress(event);
    });
    return unsub;
  }, [refresh]);

  // 自动选中:running 的优先,其次第一个已下载的,再退到第一个
  useEffect(() => {
    if (selectedKey && models.some((m) => m.key === selectedKey)) return;
    const next =
      (status?.modelKey && models.find((m) => m.key === status.modelKey)?.key) ||
      models.find((m) => m.downloaded)?.key ||
      models[0]?.key ||
      null;
    setSelectedKey(next);
  }, [models, status?.modelKey, selectedKey]);

  const handleStart = async (modelKey: string) => {
    if (!window.videoAnalyzer?.llama) return;
    setError("");
    setProgress(null);
    try {
      const currentStatus = await window.videoAnalyzer.llama.getStatus();
      if (!currentStatus.binaryFound) {
        setBusyAction("binary");
        await window.videoAnalyzer.llama.ensureBinary();
      }
      const target = (await window.videoAnalyzer.llama.listModels()).find((m) => m.key === modelKey);
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

  const selectedModel = models.find((m) => m.key === selectedKey) || null;
  const runningKey = status?.running ? status.modelKey : null;
  const isSelectedRunning = !!runningKey && runningKey === selectedKey;
  const isBusy = busyAction !== null && busyAction !== "selftest";

  type MainAction = {
    label: string;
    loading: boolean;
    disabled: boolean;
    danger: boolean;
    onClick?: () => void;
  };
  const mainAction: MainAction = (() => {
    if (busyAction === "binary") return { label: "下载引擎中…", loading: true, disabled: true, danger: false };
    if (busyAction === "download") return { label: "下载模型中…", loading: true, disabled: true, danger: false };
    if (busyAction === "start") return { label: "启动中…", loading: true, disabled: true, danger: false };
    if (busyAction === "stop") return { label: "停止中…", loading: true, disabled: true, danger: false };
    if (!selectedModel) return { label: "启动", loading: false, disabled: true, danger: false };
    if (isSelectedRunning) {
      return { label: "停止", loading: false, disabled: false, danger: true, onClick: handleStop };
    }
    if (!!runningKey && !isSelectedRunning) {
      return {
        label: `切换到 ${llamaSizeFromName(selectedModel.name)}`,
        loading: false,
        disabled: false,
        danger: false,
        onClick: () => handleStart(selectedModel.key),
      };
    }
    if (!selectedModel.downloaded) {
      return {
        label: "下载并启动",
        loading: false,
        disabled: false,
        danger: false,
        onClick: () => handleStart(selectedModel.key),
      };
    }
    return {
      label: "启动",
      loading: false,
      disabled: false,
      danger: false,
      onClick: () => handleStart(selectedModel.key),
    };
  })();

  const statusLine = (() => {
    if (status?.status === "ready" && status.modelKey) {
      return (
        <span className="text-emerald-600 dark:text-emerald-400">
          运行中 · {llamaSizeFromName(models.find((m) => m.key === status.modelKey)?.name || status.modelKey)} · 端口 {status.port}
        </span>
      );
    }
    if (status?.status === "starting") return <span className="text-amber-500">启动中…</span>;
    if (status?.status === "error") return <span className="text-red-500">出错: {status.lastError}</span>;
    if (selectedModel?.downloaded) return <span className="text-slate-500">未运行 · 已下载,随时可启动</span>;
    if (selectedModel) return <span className="text-slate-500">未下载 · 首次启动会先下载约 {formatBytes(selectedModel.approxBytes)}</span>;
    return <span className="text-slate-500">未运行</span>;
  })();

  const showProgress =
    progress && (busyAction === "binary" || busyAction === "download") && progress.percent != null;

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">本地推理</h2>

      <section className="rounded-xl border-2 border-orange-300/80 dark:border-orange-500/40 bg-orange-50/40 dark:bg-orange-500/[0.04] shadow-sm overflow-hidden">
        <div className="p-5 flex items-start gap-4">
          <div className="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 grid place-items-center text-white shadow-sm">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center flex-wrap gap-1.5">
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">Qwen3.5-VL</span>
              <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100 border-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30">视觉初筛</Badge>
              <Badge variant="outline" className="text-slate-600 dark:text-slate-300">本地</Badge>
              <Badge variant="outline" className="text-slate-600 dark:text-slate-300">Apple GPU</Badge>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              抽帧后让本地模型给每张候选画面快速打标,按信息量和签名相似度精筛,降低送给视觉主模型的画面数。
            </p>
          </div>
          <div className="shrink-0 space-y-1.5">
            <div className="text-[11px] text-slate-500 text-right">选择规格</div>
            <div className="flex flex-col gap-1.5">
              {models.map((m) => {
                const checked = selectedKey === m.key;
                const running = runningKey === m.key;
                return (
                  <button
                    key={m.key}
                    onClick={() => setSelectedKey(m.key)}
                    disabled={isBusy}
                    className={`group inline-flex items-center gap-3 pl-2.5 pr-3 py-1.5 rounded-md border text-xs transition-colors min-w-[170px] ${
                      checked
                        ? "border-orange-400 bg-white dark:bg-orange-500/10 shadow-sm"
                        : "border-slate-200 dark:border-slate-800 hover:border-slate-300 bg-white/60 dark:bg-slate-900/40"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        checked ? "bg-orange-500 ring-2 ring-orange-200 dark:ring-orange-500/30" : "bg-slate-300 dark:bg-slate-600"
                      }`}
                    />
                    <span className="font-semibold text-slate-700 dark:text-slate-200 text-left">{llamaSizeFromName(m.name)}</span>
                    <span className="ml-auto text-slate-500 dark:text-slate-400">{formatBytes(m.approxBytes)}</span>
                    {running ? (
                      <span className="text-emerald-500" title="运行中">●</span>
                    ) : m.downloaded ? (
                      <span className="text-emerald-500" title="已下载">✓</span>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="border-t border-orange-200/60 dark:border-orange-500/20 bg-white/70 dark:bg-black/20 px-5 py-3.5 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">模型状态</div>
            <div className="text-sm">{statusLine}</div>
            <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
              引擎: {status?.binaryFound ? <span className="text-emerald-500">✓ 已安装</span> : <span className="text-amber-500">未安装 · 启动时会自动下载约 8MB</span>}
            </div>
          </div>
          <Button
            size="sm"
            onClick={mainAction.onClick}
            disabled={mainAction.disabled}
            variant={mainAction.danger ? "outline" : "default"}
            className={
              mainAction.danger
                ? "h-9 px-4 border-red-300 text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                : "h-9 px-4 bg-orange-500 hover:bg-orange-600 text-white border-orange-500"
            }
          >
            {mainAction.loading ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : mainAction.danger ? (
              <Square className="w-3.5 h-3.5 mr-1.5 fill-current" />
            ) : (
              <DownloadCloud className="w-3.5 h-3.5 mr-1.5" />
            )}
            {mainAction.label}
          </Button>
        </div>

        {showProgress && (
          <div className="border-t border-orange-200/60 dark:border-orange-500/20 px-5 py-2.5 bg-white/50 dark:bg-black/10">
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

function AnalysisDefaultsSection() {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">默认分析</h2>
      <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <p>每个项目的分析参数（模式 / 节点密度 / 关注重点）目前在「准备分析」页设置，并和项目一起保存。</p>
        <p>未来这里会暴露：</p>
        <ul className="list-disc list-inside space-y-1 text-slate-500 dark:text-slate-400">
          <li>默认分析模式 / 节点密度 / 关注重点</li>
          <li>抽帧上限 / 每分钟基础帧数</li>
          <li>token 预算上限</li>
          <li>是否在分析失败时回退到骨架结果</li>
        </ul>
      </section>
    </>
  );
}

function DataSection() {
  const { projects } = useApp();
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
    if (!window.confirm(`确定清空 ${info?.projectCount ?? 0} 个项目的本地文件？此操作不可恢复，但应用内的项目列表需要手动删除。`)) return;
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
