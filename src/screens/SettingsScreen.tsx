import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, DownloadCloud, Loader2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ModelInputMode, ModelProvider } from "../types";
import type { RuntimeStatus, YtDlpUpdateInfo } from "../electron-api";

export function SettingsScreen() {
  const { providers, setProviders, activeProviderId, setActiveProviderId } = useApp();

  const currentProvider = providers.find(p => p.id === activeProviderId) || providers[0];

  const [name, setName] = useState(currentProvider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(currentProvider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(currentProvider?.apiKeyRef ?? "");
  const [model, setModel] = useState(currentProvider?.model ?? "");
  const [inputMode, setInputMode] = useState<ModelInputMode>(currentProvider?.inputMode ?? "auto");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [ytDlpInfo, setYtDlpInfo] = useState<YtDlpUpdateInfo | null>(null);
  const [ytDlpInstalling, setYtDlpInstalling] = useState(false);
  const [ytDlpStatus, setYtDlpStatus] = useState<string>("");

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  const refreshRuntime = () => {
    if (!window.videoAnalyzer) return;
    window.videoAnalyzer.getRuntimeStatus().then(setRuntimeStatus).catch(() => setRuntimeStatus(null));
    window.videoAnalyzer.checkYtDlpUpdate().then(setYtDlpInfo).catch(() => setYtDlpInfo(null));
  };

  useEffect(() => {
    refreshRuntime();
    if (!window.videoAnalyzer) return;
    const unsub = window.videoAnalyzer.onYtDlpProgress((p) => {
      setYtDlpStatus(`${p.stage === "download" ? "下载中" : p.stage === "resolve" ? "查询版本" : "完成"}：${p.message}`);
    });
    return unsub;
  }, []);

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

  useEffect(() => {
    if (!currentProvider) return;
    setName(currentProvider.name);
    setBaseUrl(currentProvider.baseUrl);
    setApiKey(currentProvider.apiKeyRef);
    setModel(currentProvider.model);
    setInputMode(currentProvider.inputMode);
    setTestResult(null);
    setSaveStatus("idle");
  }, [currentProvider?.id]);

  const handleSave = () => {
    if (!currentProvider) return;
    setProviders(prev => prev.map(p =>
      p.id === currentProvider.id ? { ...p, name: name || p.name, baseUrl, apiKeyRef: apiKey, model, inputMode } : p
    ));
    setSaveStatus("saved");
    window.setTimeout(() => setSaveStatus("idle"), 1800);
  };

  const handleAdd = () => {
    const id = `provider-${Date.now()}`;
    const draft: ModelProvider = {
      id,
      name: "新 Provider",
      baseUrl: "https://",
      apiKeyRef: "",
      model: "",
      endpointType: "openai_chat_completions",
      inputMode: "auto",
    };
    setProviders(prev => [...prev, draft]);
    setActiveProviderId(id);
  };

  const handleDelete = () => {
    if (!currentProvider) return;
    if (providers.length <= 1) return;
    if (!window.confirm(`确定删除 Provider「${currentProvider.name}」？`)) return;
    const remaining = providers.filter(p => p.id !== currentProvider.id);
    setProviders(remaining);
    setActiveProviderId(remaining[0]?.id ?? null);
  };

  const handleTest = async () => {
    if (!currentProvider) return;
    setIsTesting(true);
    setTestResult(null);
    const candidate: ModelProvider = { ...currentProvider, name, baseUrl, apiKeyRef: apiKey, model, inputMode };
    try {
      if (window.videoAnalyzer) {
        const result = await window.videoAnalyzer.testProvider(candidate);
        setTestResult(result);
        return;
      }
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        method: "GET",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
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

  return (
    <div className="flex-1 flex h-full">
      <main className="flex-1 flex bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
        <div className="w-48 border-r border-slate-200 dark:border-slate-800/50 bg-white dark:bg-[#0E0E10] p-4 space-y-1 overflow-y-auto hidden md:block">
           <div className="text-xs font-bold text-slate-500 uppercase tracking-widest pl-3 mt-2 mb-4">设置</div>
           <button className="w-full text-left px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 text-sm font-medium">模型配置</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm">本地依赖</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm">默认分析</button>
           <button className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-400 text-sm">项目数据</button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 md:p-12">
          <div className="max-w-3xl space-y-8">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">模型与本地能力</h2>

            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="p-6 md:p-8 space-y-6">
                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">模型供应商</Label>
                  <div className="flex flex-wrap gap-2">
                    <Select
                      value={currentProvider?.id ?? ""}
                      onValueChange={(value) => setActiveProviderId(value)}
                    >
                      <SelectTrigger className="w-[260px] bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                        <SelectValue placeholder="选择 Provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map(provider => (
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" onClick={handleAdd} className="border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10]">
                      <Plus className="w-4 h-4 mr-1" />
                      新增
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleDelete}
                      disabled={providers.length <= 1}
                      className="border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      删除
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">名称</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 text-sm max-w-md"
                    placeholder="给这个 Provider 起个名字"
                  />
                </div>

                <div className="h-px bg-slate-200 dark:bg-slate-800/50" />

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">API Base URL</Label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 font-mono text-sm max-w-md"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">API Key</Label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 font-mono text-sm max-w-md"
                    placeholder="sk-..."
                  />
                </div>

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">模型名</Label>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 font-mono text-sm max-w-[260px]"
                    placeholder="gpt-4o-mini / qwen-vl-max / ..."
                  />
                </div>

                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400">输入模式</Label>
                  <Select value={inputMode} onValueChange={(v) => setInputMode(v as ModelInputMode)}>
                    <SelectTrigger className="w-[260px] bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                      <SelectValue placeholder="选择输入模式" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动选择（先 keyframe）</SelectItem>
                      <SelectItem value="direct_video">直接视频上传</SelectItem>
                      <SelectItem value="keyframe_sequence">抽帧序列</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="h-px bg-slate-200 dark:bg-slate-800/50" />

                <div className="grid grid-cols-[140px_1fr] items-start gap-4">
                  <Label className="text-right text-slate-500 dark:text-slate-400 pt-1">本地依赖</Label>
                  <div className="grid gap-2 text-sm">
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
                    {ytDlpStatus && (
                      <p className="text-xs text-slate-500">{ytDlpStatus}</p>
                    )}
                    {!window.videoAnalyzer && (
                      <p className="text-xs text-slate-500">当前是浏览器预览环境，依赖检测只在 Electron 中可用。</p>
                    )}
                  </div>
                </div>

              </div>

              <div className="p-4 bg-slate-50 dark:bg-[#0A0A0B] border-t border-slate-200 dark:border-slate-800 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-3 min-w-0">
                  <Button variant="secondary" onClick={handleTest} disabled={isTesting || !baseUrl} className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900 shrink-0">
                    <CheckCircle2 className="w-4 h-4 mr-2 text-slate-400 flex-none" />
                    {isTesting ? "测试中..." : "测试连接"}
                  </Button>
                  {testResult && (
                    <span className={`text-sm flex items-start gap-2 min-w-0 break-words ${testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                      {testResult.ok ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 flex-none" />
                      ) : (
                        <XCircle className="w-4 h-4 mt-0.5 flex-none" />
                      )}
                      <span>{testResult.message}</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 self-end md:self-auto">
                  {saveStatus === "saved" && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">已保存</span>
                  )}
                  <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700 text-white border border-blue-700">保存设置</Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
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
