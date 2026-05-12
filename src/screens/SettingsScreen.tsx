import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft,
  CheckCircle2,
  DownloadCloud,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ModelInputMode, ModelProvider, ProviderKind } from "../types";
import type { RuntimeStatus, YtDlpUpdateInfo } from "../electron-api";

type Section = "model" | "deps" | "analysis" | "data";

const NONE = "__none__";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "model", label: "模型配置" },
  { key: "deps", label: "本地依赖" },
  { key: "analysis", label: "默认分析" },
  { key: "data", label: "项目数据" },
];

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
  const [section, setSection] = useState<Section>("model");

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
                  ? "bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50"
              }`}
            >
              {s.label}
            </button>
          ))}
        </aside>

        <div className="flex-1 overflow-y-auto p-8 md:p-12">
          <div className="max-w-3xl space-y-8">
            {section === "model" && <ModelSection />}
            {section === "deps" && <DepsSection />}
            {section === "analysis" && <AnalysisDefaultsSection />}
            {section === "data" && <DataSection />}
          </div>
        </div>
      </main>
    </div>
  );
}

function ModelSection() {
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
          baseUrl: "https://api.openai.com/v1",
          apiKeyRef: "",
          model: "whisper-1",
          kind: "audio",
          endpointType: "openai_audio_transcriptions",
          inputMode: "keyframe_sequence",
          language: "zh",
        }
      : {
          id,
          name: "新视觉模型",
          baseUrl: "https://api.openai.com/v1",
          apiKeyRef: "",
          model: "gpt-4o-mini",
          kind: "video",
          endpointType: "openai_chat_completions",
          inputMode: "auto",
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
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">模型配置</h2>

      <section className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-5">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">默认调用模型</h3>
        <div className="grid grid-cols-[140px_1fr] items-center gap-4">
          <Label className="text-right text-slate-500 dark:text-slate-400">视觉理解</Label>
          <Select
            value={activeVideoProviderId ?? NONE}
            onValueChange={(value) => setActiveVideoProviderId(value === NONE ? null : value)}
          >
            <SelectTrigger className="w-full max-w-md bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
              <SelectValue placeholder="选择视觉模型">
                {(() => {
                  const p = providers.find((x) => x.id === activeVideoProviderId);
                  return p ? `${p.name} · ${p.model || "未配置模型"}` : "选择视觉模型";
                })()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {videoProviders.length === 0 && (
                <SelectItem value={NONE} disabled>
                  暂无视觉 Provider
                </SelectItem>
              )}
              {videoProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name} · {provider.model || "未配置模型"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[140px_1fr] items-center gap-4">
          <Label className="text-right text-slate-500 dark:text-slate-400">语音转录</Label>
          <Select
            value={activeAudioProviderId ?? NONE}
            onValueChange={(value) => setActiveAudioProviderId(value === NONE ? null : value)}
          >
            <SelectTrigger className="w-full max-w-md bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
              <SelectValue placeholder="不启用语音转录">
                {(() => {
                  const p = providers.find((x) => x.id === activeAudioProviderId);
                  return p ? `${p.name} · ${p.model || "未配置模型"}` : "不启用语音转录";
                })()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不启用语音转录</SelectItem>
              {audioProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name} · {provider.model || "未配置模型"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      <ProviderGroup
        kind="video"
        title="🎞️ 视觉模型"
        emptyHint="还没添加视觉模型，点右上新增按钮添加一个 OpenAI 兼容 chat/completions endpoint。"
        providers={videoProviders}
        activeId={activeVideoProviderId}
        onAdd={() => handleAdd("video")}
        onSetDefault={(id) => setActiveVideoProviderId(id)}
        onDelete={handleDelete}
        onUpdate={updateProvider}
      />

      <ProviderGroup
        kind="audio"
        title="🎙️ 语音模型"
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
  provider,
  isDefault,
  onSetDefault,
  onDelete,
  onUpdate,
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

  const isLocalWhisper = provider.endpointType === "local_whisper_wasm";
  const modelKey = isLocalWhisper ? provider.localWhisperModel || provider.model : null;

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
        const result = await window.videoAnalyzer.testProvider(provider);
        setTestResult(result);
        if (isLocalWhisper && modelKey) {
          const refreshed = await window.videoAnalyzer.isWhisperModelCached(modelKey).catch(() => null);
          if (refreshed) setWhisperCache(refreshed);
        }
        return;
      }
      const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
        method: "GET",
        headers: provider.apiKeyRef ? { authorization: `Bearer ${provider.apiKeyRef}` } : {},
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
          <span className="truncate font-medium text-slate-800 dark:text-slate-100">{provider.name}</span>
          {isDefault && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              默认
            </span>
          )}
          {provider.endpointType === "local_whisper_wasm" ? (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
              本地
            </span>
          ) : (
            !provider.apiKeyRef && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                缺 Key
              </span>
            )
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isDefault && (
            <Button variant="outline" size="sm" onClick={onSetDefault} className="border-slate-200 dark:border-slate-800">
              设为默认
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            <Trash2 className="w-4 h-4 mr-1" />
            删除
          </Button>
        </div>
      </header>

      <div className="p-5 space-y-4 text-sm">
        <Field label="名称">
          <Input value={provider.name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder="给这个 Provider 起个名字" />
        </Field>
        {kind === "audio" && (
          <Field label="模式">
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
                  {provider.endpointType === "local_whisper_wasm" ? "本地 (whisper.cpp WASM)" : "云端 (OpenAI 兼容)"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local_whisper_wasm">本地 (whisper.cpp WASM，按需下载模型)</SelectItem>
                <SelectItem value="openai_audio_transcriptions">云端 (OpenAI /audio/transcriptions)</SelectItem>
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
          <Field label="本地模型">
            <Select
              value={provider.localWhisperModel || "Xenova/whisper-base"}
              onValueChange={(v) => onUpdate({ localWhisperModel: v, model: v })}
            >
              <SelectTrigger className="w-[300px]">
                <SelectValue>{provider.localWhisperModel || "Xenova/whisper-base"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Xenova/whisper-tiny">whisper-tiny (~40 MB, 最快 / 准确率一般)</SelectItem>
                <SelectItem value="Xenova/whisper-base">whisper-base (~75 MB, 推荐默认)</SelectItem>
                <SelectItem value="Xenova/whisper-small">whisper-small (~250 MB, 中文较准)</SelectItem>
                <SelectItem value="Xenova/whisper-medium">whisper-medium (~500 MB, 准确率高 / 慢)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        {kind === "video" ? (
          <>
            <Field label="API 协议">
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
                  <SelectItem value="openai_chat_completions">/v1/chat/completions（兼容性广）</SelectItem>
                  <SelectItem value="openai_responses">/v1/responses（OpenAI 新协议）</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="输入模式">
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
                  <SelectItem value="auto">自动选择（先 keyframe）</SelectItem>
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
        <span className="text-[10px] text-slate-400 font-mono shrink-0">{provider.id}</span>
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <Label className="text-right text-slate-500 dark:text-slate-400 text-xs">{label}</Label>
      <div>{children}</div>
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
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 whitespace-nowrap dark:bg-blue-500/15 dark:text-blue-300">
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
