import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { useApp } from "../AppContext";
import type { ExtensionBridgeStatus, LlamaStatus, ProcessEntry, SystemStats } from "../electron-api";
import type { ModelDescriptor } from "../types";

export function RuntimeStatusIndicator() {
  const [open, setOpen] = useState(false);
  const [llamaStatus, setLlamaStatus] = useState<LlamaStatus | null>(null);
  const [llamaModels, setLlamaModels] = useState<ModelDescriptor[]>([]);
  const [sysStats, setSysStats] = useState<SystemStats | null>(null);
  const [procList, setProcList] = useState<ProcessEntry[] | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<ExtensionBridgeStatus | null>(null);
  const { providers, taskSlots, audioSlot, goModule } = useApp();
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

  // 浏览器插件桥状态: 启动时拉一次, 之后走事件订阅 (main 进程在连接/断开时主动推送)
  useEffect(() => {
    if (!window.videoAnalyzer?.extensionBridge) return;
    window.videoAnalyzer.extensionBridge.getStatus()
      .then(setBridgeStatus)
      .catch(() => setBridgeStatus(null));
    const off = window.videoAnalyzer.extensionBridge.onStatus(setBridgeStatus);
    return off;
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

  // 仅弹层打开时采样系统资源 + 进程列表,1.5s 一次。第一次返回 cpu=0 是采样基线,无碍。
  useEffect(() => {
    if (!open || !window.videoAnalyzer?.getSystemStats) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [s, ps] = await Promise.all([
          window.videoAnalyzer!.getSystemStats(),
          window.videoAnalyzer!.getProcessList?.() ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSysStats(s);
        if (ps) setProcList(ps);
      } catch {
        // ignore
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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
      llamaModels.find((m) => m.id === llamaStatus.modelKey)?.label || llamaStatus.modelKey
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
    const parts: string[] = [];
    if (!llamaStatus) parts.push("加载中");
    else if (llamaStatus.status === "ready") parts.push(`本地推理 · ${llamaModelLabel || llamaStatus.modelKey || ""}`);
    else if (llamaStatus.status === "starting") parts.push("本地推理启动中");
    else if (llamaStatus.status === "error") parts.push("本地推理出错");
    else if (llamaStatus.status === "stopping") parts.push("停止中");
    else parts.push("本地推理未启用");
    if (bridgeStatus) {
      parts.push(bridgeStatus.connected ? "浏览器插件已连接" : "浏览器插件未连接");
    }
    return parts.join(" · ");
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
          className="absolute right-0 top-full mt-1.5 w-96 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0F172A] shadow-lg p-4 z-50 text-sm divide-y divide-slate-200 dark:divide-slate-700"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <Section title="本地推理 · 视觉初筛">
            <div className="flex gap-4">
              <div className="flex-1 min-w-0 space-y-1">
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
              </div>
              {sysStats && (
                <div className="w-32 shrink-0 space-y-2.5 pt-0.5">
                  <MiniGauge label="CPU" percent={sysStats.cpuPercent} />
                  <MiniGauge
                    label="内存"
                    percent={sysStats.memoryPercent}
                    tone={
                      sysStats.memoryPressure === "critical"
                        ? "critical"
                        : sysStats.memoryPressure === "warn"
                        ? "warn"
                        : "ok"
                    }
                    sub={`${formatBytes(sysStats.memoryUsedBytes)} / ${formatBytes(sysStats.memoryTotalBytes)}`}
                    hint={memoryHint(sysStats)}
                  />
                </div>
              )}
            </div>
          </Section>

          <Section title="浏览器插件桥 · 账号视频拉取">
            {!window.videoAnalyzer?.extensionBridge ? (
              <Hint>浏览器预览环境</Hint>
            ) : bridgeStatus?.connected ? (
              <>
                <Row label="状态" value={<StatusPill tone="ok">已连接</StatusPill>} />
                <Row
                  label="端点"
                  value={`${bridgeStatus.host}:${bridgeStatus.port}`}
                  mono
                  small
                />
                {bridgeStatus.connectedAt && (
                  <Row
                    label="自"
                    value={new Date(bridgeStatus.connectedAt).toLocaleTimeString()}
                    mono
                    small
                  />
                )}
              </>
            ) : bridgeStatus ? (
              <>
                <Row label="状态" value={<StatusPill tone="busy">未连接</StatusPill>} />
                <Row
                  label="端点"
                  value={`${bridgeStatus.host}:${bridgeStatus.port}`}
                  mono
                  small
                />
                <Hint>用于借浏览器登录态拉 B 站 / 抖音视频列表,装上插件能绕开 wbi 风控</Hint>
              </>
            ) : (
              <Hint>加载中</Hint>
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

          <Section title="进程占用 · ClipIQ 自身">
            <ProcessTable list={procList} />
          </Section>

          <button
            onClick={() => {
              setOpen(false);
              goModule("settings");
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

function MiniGauge({
  label,
  percent,
  tone,
  sub,
  hint,
}: {
  label: string;
  percent: number;
  tone?: "ok" | "warn" | "critical";
  sub?: string;
  hint?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  // 显式传 tone 时由 tone 决定颜色 (内存这种"百分比≠紧张程度"的指标);
  // 没传 tone 就按 percent 阈值估 (CPU 这种"高即紧张")。
  const barClass = (() => {
    if (tone === "critical") return "bg-red-500 dark:bg-red-400";
    if (tone === "warn") return "bg-amber-500 dark:bg-amber-400";
    if (tone === "ok") return "bg-emerald-500 dark:bg-emerald-400";
    if (clamped >= 85) return "bg-red-500 dark:bg-red-400";
    if (clamped >= 60) return "bg-amber-500 dark:bg-amber-400";
    return "bg-emerald-500 dark:bg-emerald-400";
  })();
  const hintClass =
    tone === "critical"
      ? "text-red-500 dark:text-red-400"
      : tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : "text-slate-400 dark:text-slate-500";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider">
          {label}
        </span>
        <span className="text-[11px] font-mono text-slate-700 dark:text-slate-200 tabular-nums">
          {clamped}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${barClass}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {sub && (
        <div
          className="text-[10px] font-mono text-slate-400 dark:text-slate-500 tabular-nums truncate"
          title={sub}
        >
          {sub}
        </div>
      )}
      {hint && (
        <div className={`text-[10px] ${hintClass} truncate`} title={hint}>
          {hint}
        </div>
      )}
    </div>
  );
}

function memoryHint(s: SystemStats): string | undefined {
  const swap = s.swapUsedBytes ?? 0;
  if (swap > 100 * 1024 * 1024) return `已交换 ${formatBytes(swap)}`;
  if (s.memoryPressure === "critical") return "压力告警";
  if (s.memoryPressure === "warn") return "压力偏高";
  return undefined;
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 10) return `${gb.toFixed(0)}G`;
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}M`;
}

const PROC_KIND_LABEL: Record<ProcessEntry["kind"], string> = {
  main: "主",
  renderer: "渲",
  gpu: "GPU",
  utility: "辅",
  sidecar: "推",
};

const PROC_KIND_TONE: Record<ProcessEntry["kind"], string> = {
  main: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  renderer: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
  gpu: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-500/10 dark:text-fuchsia-300",
  utility: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
  sidecar: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
};

function ProcessTable({ list }: { list: ProcessEntry[] | null }) {
  if (!list) return <Hint>加载中</Hint>;
  if (list.length === 0) return <Hint>无可见进程</Hint>;
  const sorted = [...list].sort((a, b) => b.memoryBytes - a.memoryBytes);
  const totalCpu = list.reduce((s, p) => s + p.cpuPercent, 0);
  const totalMem = list.reduce((s, p) => s + p.memoryBytes, 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[10px] text-slate-400 dark:text-slate-500 font-mono tabular-nums">
        <span>{list.length} 个进程</span>
        <span>
          CPU {totalCpu.toFixed(1)}% · 内存 {formatBytes(totalMem)}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto -mx-1 divide-y divide-slate-100 dark:divide-slate-800">
        {sorted.map((p) => (
          <div key={p.pid} className="flex items-center gap-2 px-1 py-1.5">
            <span
              className={`text-[9px] font-mono rounded px-1 py-0.5 shrink-0 ${PROC_KIND_TONE[p.kind]}`}
            >
              {PROC_KIND_LABEL[p.kind]}
            </span>
            <div className="flex-1 min-w-0">
              <div
                className="text-[12px] text-slate-800 dark:text-slate-100 truncate"
                title={p.detail ? `${p.label} · ${p.detail}` : p.label}
              >
                {p.label}
                {p.detail && (
                  <span className="text-slate-400 dark:text-slate-500"> · {p.detail}</span>
                )}
              </div>
              <div className="text-[9px] font-mono text-slate-400 dark:text-slate-500 tabular-nums">
                pid {p.pid}
              </div>
            </div>
            <span className="text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400 w-11 text-right shrink-0">
              {p.cpuPercent.toFixed(1)}%
            </span>
            <span className="text-[10px] font-mono tabular-nums text-slate-600 dark:text-slate-300 w-12 text-right shrink-0">
              {formatBytes(p.memoryBytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
