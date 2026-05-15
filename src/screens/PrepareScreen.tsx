import { useApp } from "../AppContext";
import {
  AlertTriangle, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, LayoutGrid,
} from "lucide-react";
import { type FunctionComponent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisOptions, VideoGenre } from "../types";
import type { RuntimeStatus } from "../electron-api";

type PresetKey = "quick" | "standard" | "deep" | "custom";

type PresetDef = {
  key: Exclude<PresetKey, "custom">;
  title: string;
  est: string;
  description: string;
  nodes: string;
  subtitle: "关" | "开";
  audit: "关" | "开" | "深";
  options: { mode: AnalysisOptions["mode"]; density: AnalysisOptions["density"]; focus: AnalysisOptions["focus"] };
};

const PRESETS: PresetDef[] = [
  {
    key: "quick",
    title: "轻拉片",
    est: "~ 45s",
    description: "只识别镜头切换和关键叙事点,不做方法论审计。适合快速浏览。",
    nodes: "5-8",
    subtitle: "关",
    audit: "关",
    options: { mode: "quick", density: "sparse", focus: "all" },
  },
  {
    key: "standard",
    title: "标准拉片",
    est: "~ 2 min",
    description: "识别节点、情绪曲线、字幕,跑方法论 audit。日常拉片够用。",
    nodes: "10-15",
    subtitle: "开",
    audit: "开",
    options: { mode: "standard", density: "standard", focus: "all" },
  },
  {
    key: "deep",
    title: "深度拉片",
    est: "~ 5 min",
    description: "每个镜头独立分析,加做剪辑意图反推和构图分析。慢但全面。",
    nodes: "20+",
    subtitle: "开",
    audit: "深",
    options: { mode: "detailed", density: "dense", focus: "all" },
  },
];

function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function orientationLabel(o: "landscape" | "portrait" | "square") {
  if (o === "portrait") return "竖屏";
  if (o === "square") return "方形";
  return "横屏";
}

function sourceLabel(source: { type: "local_file" } | { type: "url"; platform: string }) {
  if (source.type === "local_file") return "本地文件";
  switch (source.platform) {
    case "douyin": return "douyin";
    case "bilibili": return "bilibili";
    case "xiaohongshu": return "xiaohongshu";
    case "tiktok": return "tiktok";
    default: return "url";
  }
}

function matchPreset(opts: AnalysisOptions | undefined): PresetKey {
  if (!opts) return "standard";
  for (const p of PRESETS) {
    if (
      p.options.mode === opts.mode &&
      p.options.density === opts.density &&
      p.options.focus === opts.focus
    ) return p.key;
  }
  return "custom";
}

export function PrepareScreen() {
  const { setCurrentScreen, projects, setProjects, activeProjectId, providers, activeVideoProviderId, defaultAnalysis } = useApp();
  const project = projects.find(p => p.id === activeProjectId);
  const provider = providers.find(p => p.id === activeVideoProviderId);

  // 从全局默认 preset 推导首次进入项目时的 mode/density/focus。
  // PRESETS 的 key 是 quick/standard/deep,和 DefaultAnalysisPreset 对齐。
  const defaultPresetOptions = PRESETS.find((p) => p.key === defaultAnalysis.preset)?.options
    || { mode: "standard" as const, density: "standard" as const, focus: "all" as const };

  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<AnalysisOptions["mode"]>(project?.analysisOptions?.mode || defaultPresetOptions.mode);
  const [density, setDensity] = useState<AnalysisOptions["density"]>(project?.analysisOptions?.density || defaultPresetOptions.density);
  const [focus, setFocus] = useState<AnalysisOptions["focus"]>(project?.analysisOptions?.focus || defaultPresetOptions.focus);
  const [manualGenre, setManualGenre] = useState<VideoGenre | "auto">(
    project?.analysisOptions?.manualGenre || defaultAnalysis.manualGenre
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimeChecked, setRuntimeChecked] = useState(false);

  useEffect(() => {
    if (!window.videoAnalyzer) {
      setRuntimeChecked(true);
      return;
    }
    window.videoAnalyzer
      .getRuntimeStatus()
      .then((status) => setRuntimeStatus(status))
      .catch(() => setRuntimeStatus(null))
      .finally(() => setRuntimeChecked(true));
  }, []);

  const missingDeps: string[] = [];
  if (window.videoAnalyzer && runtimeChecked) {
    if (!runtimeStatus?.ffmpeg) missingDeps.push("ffmpeg");
    if (!runtimeStatus?.ffprobe) missingDeps.push("ffprobe");
  }
  const hasMissingDeps = missingDeps.length > 0;
  const missingApiKey = !provider?.apiKeyRef;

  const currentPreset = useMemo<PresetKey>(() => matchPreset({ mode, density, focus, manualGenre }), [mode, density, focus, manualGenre]);
  const selectedPreset = PRESETS.find(p => p.key === currentPreset);

  if (!project) return null;

  const pickPreset = (preset: PresetDef) => {
    setMode(preset.options.mode);
    setDensity(preset.options.density);
    setFocus(preset.options.focus);
  };

  const handleStartAnalysis = () => {
    setProjects(prev => prev.map(p => p.id === project.id ? {
      ...p,
      status: "analyzing",
      providerId: activeVideoProviderId || undefined,
      model: provider?.model,
      analysisOptions: { mode, density, focus, manualGenre },
      updatedAt: new Date().toISOString(),
    } : p));
    setCurrentScreen("progress");
  };

  return (
    <main className="flex-1 overflow-y-auto bg-slate-50 dark:bg-[#0c0d10]">
      <div className="max-w-4xl mx-auto px-8 pt-8 pb-24 space-y-6">

        {/* Top bar */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCurrentScreen("home")}
            className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 transition-colors -ml-1"
          >
            <ArrowLeft className="w-4 h-4" />
            返回首页
          </button>
          <div className="flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              准备就绪
            </span>
            <span>4 个调用点已绑定</span>
          </div>
        </div>

        {/* Header */}
        <header>
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-2">Screen · Prepare</div>
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            挑一个 preset,然后就可以走了。
          </h1>
        </header>

        {/* Video card */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden grid grid-cols-1 md:grid-cols-[340px_1fr]">
          <div className="aspect-video bg-slate-900 relative">
            <video
              ref={videoRef}
              src={project.localVideoPath}
              className="absolute inset-0 w-full h-full object-contain bg-black"
              controls
            />
            <div className="absolute bottom-2 right-2 bg-black/55 text-white font-mono text-[11px] px-2 py-0.5 rounded">
              {formatDuration(project.durationSec)}
            </div>
          </div>
          <div className="p-5 md:p-6">
            <h3 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate" title={project.videoName}>
              {project.videoName}
            </h3>
            <div className="font-mono text-[11px] uppercase tracking-wider text-slate-500 mt-1 truncate">
              {sourceLabel(project.source)}
            </div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 mt-4">
              <MetaCell label="时长" value={formatDuration(project.durationSec)} mono />
              <MetaCell label="分辨率" value={`${project.width} × ${project.height}`} mono />
              <MetaCell label="朝向" value={orientationLabel(project.orientation)} />
              <MetaCell label="音轨" value="自动转写" />
            </dl>
          </div>
        </section>

        {/* Preset section */}
        <section>
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-2.5">Section 01 · 拉片强度</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
            {PRESETS.map(preset => (
              <PresetCard
                key={preset.key}
                preset={preset}
                isSelected={preset.key === currentPreset}
                onClick={() => pickPreset(preset)}
              />
            ))}
          </div>
        </section>

        {/* Advanced */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden">
          <button
            type="button"
            onClick={() => setAdvancedOpen(v => !v)}
            className="w-full px-5 py-3.5 flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-2">
              {advancedOpen ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
              <span className="text-[13.5px] font-medium text-slate-900 dark:text-slate-100">自定义高级参数</span>
            </div>
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500">
              {currentPreset === "custom" ? "已自定义" : "通常不用改"}
            </span>
          </button>
          {advancedOpen && (
            <div className="border-t border-slate-200 dark:border-slate-800 p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <AdvField label="视频类型">
                <Segment
                  value={manualGenre}
                  options={[
                    { value: "auto", label: "自动识别" },
                    { value: "vlog", label: "vlog" },
                    { value: "review", label: "测评" },
                    { value: "short-drama", label: "短剧" },
                  ]}
                  onChange={(v) => setManualGenre(v as VideoGenre | "auto")}
                />
              </AdvField>
              <AdvField label="节点密度">
                <Segment
                  value={density}
                  options={[
                    { value: "sparse", label: "稀疏" },
                    { value: "standard", label: "标准" },
                    { value: "dense", label: "密集" },
                  ]}
                  onChange={(v) => setDensity(v as AnalysisOptions["density"])}
                />
              </AdvField>
              <AdvField label="关注重点">
                <Segment
                  value={focus}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "narrative", label: "叙事" },
                    { value: "rhythm", label: "节奏" },
                    { value: "emotion", label: "情绪" },
                  ]}
                  onChange={(v) => setFocus(v as AnalysisOptions["focus"])}
                />
              </AdvField>
              <AdvField label="分析模式">
                <Segment
                  value={mode}
                  options={[
                    { value: "quick", label: "快速" },
                    { value: "standard", label: "标准" },
                    { value: "detailed", label: "深度" },
                  ]}
                  onChange={(v) => setMode(v as AnalysisOptions["mode"])}
                />
              </AdvField>
            </div>
          )}
        </section>

        {/* Warnings */}
        {hasMissingDeps && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-2.5 text-[13px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              未检测到 {missingDeps.join("、")},需要先安装才能进行视频分析。
              <button
                type="button"
                onClick={() => setCurrentScreen("settings")}
                className="ml-1.5 underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
              >
                打开设置
              </button>
            </span>
          </div>
        )}
        {!hasMissingDeps && missingApiKey && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] px-3.5 py-2.5 text-[13px] text-slate-600 dark:text-slate-400">
            当前未配置模型 API Key,将仅生成基于关键帧的本地启发式节点。
          </div>
        )}

        {/* CTA */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] py-4 px-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <span>
              已选 · <strong className="text-slate-900 dark:text-slate-100 font-medium normal-case tracking-normal">{selectedPreset?.title ?? "自定义"}</strong>
            </span>
            <span>
              预估 · <strong className="text-slate-900 dark:text-slate-100 font-medium normal-case tracking-normal">{selectedPreset?.est ?? "—"}</strong>
            </span>
            <span>
              视频类型 · <strong className="text-slate-900 dark:text-slate-100 font-medium normal-case tracking-normal">{manualGenre === "auto" ? "自动识别" : manualGenre}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 self-end md:self-auto">
            {project.status === "completed" && (
              <button
                type="button"
                onClick={() => setCurrentScreen("workspace")}
                className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-[13.5px] transition-colors"
              >
                <LayoutGrid className="w-4 h-4" />
                查看已有分析
              </button>
            )}
            <button
              type="button"
              onClick={handleStartAnalysis}
              disabled={hasMissingDeps}
              className="inline-flex items-center gap-1.5 h-10 px-5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-[13.5px] font-medium transition-colors"
            >
              {project.status === "completed" ? "重新分析" : "开始分析"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </section>

      </div>
    </main>
  );
}

function MetaCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mb-0.5">{label}</dt>
      <dd className={`text-[13px] text-slate-900 dark:text-slate-100 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

type PresetCardProps = {
  preset: PresetDef;
  isSelected: boolean;
  onClick: () => void;
};

const PresetCard: FunctionComponent<PresetCardProps> = ({ preset, isSelected, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-colors ${
        isSelected
          ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30"
          : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] hover:border-slate-300 dark:hover:border-slate-700"
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <h4 className={`text-[14.5px] font-semibold ${
          isSelected ? "text-indigo-900 dark:text-indigo-200" : "text-slate-900 dark:text-slate-100"
        }`}>
          {preset.title}
        </h4>
        <span className={`font-mono text-[10.5px] uppercase tracking-wider ${
          isSelected ? "text-indigo-700 dark:text-indigo-300" : "text-slate-500"
        }`}>
          {preset.est}
        </span>
      </div>
      <p className="text-[12.5px] text-slate-700 dark:text-slate-300 leading-snug">
        {preset.description}
      </p>
      <div className={`flex gap-2.5 mt-3 pt-3 border-t border-dashed ${
        isSelected ? "border-indigo-200 dark:border-indigo-900" : "border-slate-200 dark:border-slate-800"
      }`}>
        <PresetStat label="节点" value={preset.nodes} />
        <PresetStat label="字幕" value={preset.subtitle} />
        <PresetStat label="审计" value={preset.audit} />
      </div>
    </button>
  );
};

function PresetStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1">
      <div className="font-mono text-[14px] font-medium text-slate-900 dark:text-slate-100">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

function AdvField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Segment<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex p-0.5 rounded-md bg-slate-100 dark:bg-slate-800 w-full">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 px-2.5 py-1.5 rounded text-[12.5px] transition-colors ${
            value === opt.value
              ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-[0_1px_2px_rgba(15,16,20,.05)]"
              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
