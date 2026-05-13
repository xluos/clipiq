import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { useApp } from "../AppContext";
import type { LlamaModelInfo, LlamaStatus } from "../electron-api";

export function RuntimeStatusIndicator() {
  const [open, setOpen] = useState(false);
  const [llamaStatus, setLlamaStatus] = useState<LlamaStatus | null>(null);
  const [llamaModels, setLlamaModels] = useState<LlamaModelInfo[]>([]);
  const { providers, activeVideoProviderId, activeAudioProviderId, setCurrentScreen } = useApp();
  const wrapRef = useRef<HTMLDivElement>(null);

  // 轮询 + 事件刷新: 启动期间事件密集,空闲时 3s 一次拉一下兜底
  useEffect(() => {
    if (!window.videoAnalyzer?.llama) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [s, m] = await Promise.all([
          window.videoAnalyzer!.llama.getStatus(),
          window.videoAnalyzer!.llama.listModels(),
        ]);
        if (cancelled) return;
        setLlamaStatus(s);
        setLlamaModels(m);
      } catch {
        // ignore
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    const unsubProgress = window.videoAnalyzer.llama.onProgress(() => refresh());
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubProgress();
    };
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const videoProvider = providers.find((p) => p.id === activeVideoProviderId) || null;
  const audioProvider = providers.find((p) => p.id === activeAudioProviderId) || null;

  const dotClass = (() => {
    switch (llamaStatus?.status) {
      case "ready":
        return "bg-emerald-500";
      case "starting":
        return "bg-amber-400 animate-pulse";
      case "error":
        return "bg-red-500";
      case "stopping":
        return "bg-slate-400 animate-pulse";
      default:
        return "bg-slate-400";
    }
  })();

  const summary = (() => {
    if (!llamaStatus) return "加载中";
    if (llamaStatus.status === "ready") return `本地推理 · ${llamaStatus.modelKey || ""}`;
    if (llamaStatus.status === "starting") return "本地推理启动中";
    if (llamaStatus.status === "error") return "本地推理出错";
    if (llamaStatus.status === "stopping") return "停止中";
    return "本地推理未启用";
  })();

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={summary}
        className="p-1.5 flex items-center gap-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <Activity className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 w-80 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0F172A] shadow-lg p-4 space-y-3 z-50 text-sm"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <Section title="本地推理(视觉初筛)">
            {!window.videoAnalyzer?.llama ? (
              <div className="text-slate-500 text-xs">浏览器预览环境</div>
            ) : llamaStatus?.running ? (
              <>
                <div className="text-emerald-600 dark:text-emerald-400">运行中 · 端口 {llamaStatus.port}</div>
                <Sub>模型: {llamaStatus.modelKey}</Sub>
              </>
            ) : llamaStatus?.status === "starting" ? (
              <div className="text-amber-600 dark:text-amber-400">启动中…</div>
            ) : llamaStatus?.status === "error" ? (
              <>
                <div className="text-red-600">出错</div>
                <Sub className="break-words">{llamaStatus.lastError || ""}</Sub>
              </>
            ) : llamaStatus?.binaryFound ? (
              <div className="text-slate-500">未启动(可去设置启动,或下次会自动恢复)</div>
            ) : (
              <div className="text-slate-500">推理引擎未安装</div>
            )}
            {llamaModels.length > 0 && (
              <Sub>
                可用模型:{" "}
                {llamaModels
                  .map((m) => `${m.downloaded ? "✓" : "·"} ${m.name}`)
                  .join("  ")}
              </Sub>
            )}
          </Section>

          <Divider />

          <Section title="视觉模型(主分析)">
            {videoProvider ? (
              <>
                <div className="text-slate-800 dark:text-slate-200">{videoProvider.name}</div>
                <Sub className="break-all">
                  {videoProvider.model} · {videoProvider.baseUrl}
                </Sub>
              </>
            ) : (
              <div className="text-slate-500">未配置</div>
            )}
          </Section>

          <Divider />

          <Section title="音频模型">
            {audioProvider ? (
              <>
                <div className="text-slate-800 dark:text-slate-200">{audioProvider.name}</div>
                <Sub>
                  {audioProvider.endpointType === "local_whisper_wasm"
                    ? `本地 · ${audioProvider.localWhisperModel || audioProvider.model}`
                    : `${audioProvider.model} · ${audioProvider.baseUrl}`}
                </Sub>
              </>
            ) : (
              <div className="text-slate-500">未启用</div>
            )}
          </Section>

          <button
            onClick={() => {
              setOpen(false);
              setCurrentScreen("settings");
            }}
            className="w-full text-center text-xs text-indigo-600 dark:text-indigo-400 hover:underline pt-1 cursor-pointer"
          >
            打开设置 →
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">{title}</div>
      {children}
    </div>
  );
}

function Sub({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`text-xs text-slate-500 mt-0.5 ${className}`}>{children}</div>;
}

function Divider() {
  return <div className="border-t border-slate-200 dark:border-slate-700" />;
}
