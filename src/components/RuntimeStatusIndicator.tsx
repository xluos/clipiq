import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { useApp } from "../AppContext";
import type { LlamaModelInfo, LlamaStatus } from "../electron-api";

export function RuntimeStatusIndicator() {
  const [open, setOpen] = useState(false);
  const [llamaStatus, setLlamaStatus] = useState<LlamaStatus | null>(null);
  const [llamaModels, setLlamaModels] = useState<LlamaModelInfo[]>([]);
  const { providers, taskSlots, audioSlot, setCurrentScreen } = useApp();
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

  // 主分析: complex_vision 槽 → provider + model label
  const visionSlot = taskSlots.complex_vision;
  const visionProvider = visionSlot ? providers.find((p) => p.id === visionSlot.providerId) : null;
  const visionModelLabel = (() => {
    if (!visionSlot || !visionProvider) return null;
    return visionProvider.models.find((m) => m.id === visionSlot.modelId)?.label || visionSlot.modelId;
  })();

  // 音频: audioSlot → provider + model label
  const audioProvider = audioSlot ? providers.find((p) => p.id === audioSlot.providerId) : null;
  const audioModelLabel = (() => {
    if (!audioSlot || !audioProvider) return null;
    return audioProvider.models.find((m) => m.id === audioSlot.modelId)?.label || audioSlot.modelId;
  })();

  // 本地推理: llamaStatus.modelKey 映射到 model.label
  const llamaModelLabel = (() => {
    if (!llamaStatus?.modelKey) return null;
    return (
      llamaModels.find((m) => m.key === llamaStatus.modelKey)?.name || llamaStatus.modelKey
    );
  })();

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
    if (llamaStatus.status === "ready") return `本地推理 · ${llamaModelLabel || llamaStatus.modelKey || ""}`;
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
          className="absolute right-0 top-full mt-1.5 w-80 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0F172A] shadow-lg p-4 z-50 text-sm divide-y divide-slate-200 dark:divide-slate-700"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <Section title="本地推理 · 视觉初筛">
            {!window.videoAnalyzer?.llama ? (
              <Hint>浏览器预览环境</Hint>
            ) : llamaStatus?.running ? (
              <>
                <Row label="状态" value={<StatusPill tone="ok">运行中</StatusPill>} />
                <Row label="模型" value={llamaModelLabel || "-"} />
                <Row label="端口" value={String(llamaStatus.port || "-")} mono />
              </>
            ) : llamaStatus?.status === "starting" ? (
              <Row label="状态" value={<StatusPill tone="busy">启动中…</StatusPill>} />
            ) : llamaStatus?.status === "error" ? (
              <>
                <Row label="状态" value={<StatusPill tone="error">出错</StatusPill>} />
                {llamaStatus.lastError && (
                  <Hint className="break-words">{llamaStatus.lastError}</Hint>
                )}
              </>
            ) : llamaStatus?.binaryFound ? (
              <Hint>未启动（去设置启动，或下次会自动恢复）</Hint>
            ) : (
              <Hint>推理引擎未安装</Hint>
            )}
          </Section>

          <Section title="主分析 · 视觉理解">
            {visionProvider ? (
              <>
                <Row label="供应商" value={visionProvider.name} />
                <Row label="模型" value={visionModelLabel || "-"} />
                <Row label="端点" value={visionProvider.baseUrl || "-"} mono small />
              </>
            ) : (
              <Hint>未配置</Hint>
            )}
          </Section>

          <Section title="音频字幕识别">
            {audioProvider ? (
              <>
                <Row label="供应商" value={audioProvider.name} />
                <Row label="模型" value={audioModelLabel || "-"} />
                {audioProvider.source !== "local_whisper" && audioProvider.baseUrl && (
                  <Row label="端点" value={audioProvider.baseUrl} mono small />
                )}
              </>
            ) : (
              <Hint>未启用</Hint>
            )}
          </Section>

          <button
            onClick={() => {
              setOpen(false);
              setCurrentScreen("settings");
            }}
            className="w-full text-center text-xs text-indigo-600 dark:text-indigo-400 hover:underline pt-3 cursor-pointer"
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
    <div className="py-3 first:pt-0 last:pb-0 space-y-1">
      <div className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider mb-1.5">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[11px] text-slate-400 dark:text-slate-500 w-12 shrink-0">{label}</span>
      <span
        className={`flex-1 min-w-0 truncate ${
          small ? "text-[11px]" : "text-sm"
        } text-slate-800 dark:text-slate-100 ${mono ? "font-mono" : ""}`}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function Hint({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`text-xs text-slate-500 dark:text-slate-400 ${className}`}>{children}</div>;
}

function StatusPill({ children, tone }: { children: ReactNode; tone: "ok" | "busy" | "error" }) {
  const cls =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "busy"
      ? "text-amber-500"
      : "text-red-500";
  return <span className={`text-sm font-medium ${cls}`}>{children}</span>;
}
