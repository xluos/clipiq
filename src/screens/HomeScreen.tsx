import { useApp } from "../AppContext";
import {
  Plus, ArrowUp, ChevronDown, Link as LinkIcon, FileVideo,
  CheckCircle2, Clock, XCircle, Trash2, Film, Loader2, AlertTriangle, Sparkles, RefreshCw,
  Upload, BarChart3, Folder, UserSquare, Wand2, ChevronRight,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, type FunctionComponent, type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { InspectedVideo } from "../electron-api";
import { BrandLogo } from "../components/BrandLogo";
import { useConfirm } from "../components/ConfirmDialog";
import type { AnalysisOptions, Project, ProjectSource, VideoGenre } from "../types";

type PresetKey = "quick" | "standard" | "deep" | "custom";

type PresetDef = {
  key: Exclude<PresetKey, "custom">;
  title: string;
  est: string;
  description: string;
  options: { mode: AnalysisOptions["mode"]; density: AnalysisOptions["density"]; focus: AnalysisOptions["focus"] };
};

const PRESETS: PresetDef[] = [
  { key: "quick",    title: "轻拉片",   est: "~ 45s",  description: "只识别镜头切换和关键叙事点,不做方法论审计。", options: { mode: "quick",    density: "sparse",   focus: "all" } },
  { key: "standard", title: "标准拉片", est: "~ 2 min", description: "识别节点、情绪曲线、字幕,跑方法论 audit。",       options: { mode: "standard", density: "standard", focus: "all" } },
  { key: "deep",     title: "深度拉片", est: "~ 5 min", description: "每个镜头独立分析,加做剪辑意图反推和构图分析。",     options: { mode: "detailed", density: "dense",    focus: "all" } },
];

function matchPreset(opts: { mode: AnalysisOptions["mode"]; density: AnalysisOptions["density"]; focus: AnalysisOptions["focus"] }): PresetKey {
  for (const p of PRESETS) {
    if (p.options.mode === opts.mode && p.options.density === opts.density && p.options.focus === opts.focus) return p.key;
  }
  return "custom";
}

type SourceKind = "empty" | "url" | "file" | "unknown";

type SourceState = {
  kind: SourceKind;
  platform?: Extract<ProjectSource, { type: "url" }>["platform"];
  label: string;
};

type Tab = "all" | "inProgress" | "completed" | "broken";

// Match URLs anywhere in the text. Share text from 抖音 / 小红书 / B 站 wraps the URL
// in copy-and-paste blobs like "2.02 复制打开抖音... https://v.douyin.com/xxx/ 05/25 K@j.Cu",
// so we extract the first URL instead of requiring the input to *start* with one.
const URL_REGEX = /https?:\/\/[^\s一-龥,，)]+/i;

export function extractUrl(raw: string): string | null {
  const m = raw.match(URL_REGEX);
  return m ? m[0] : null;
}

function detectSource(raw: string): SourceState {
  const v = raw.trim();
  if (!v) return { kind: "empty", label: "选择来源" };
  const url = extractUrl(v);
  if (url) {
    const lower = url.toLowerCase();
    let platform: Extract<ProjectSource, { type: "url" }>["platform"] = "unknown";
    let label = "链接";
    if (lower.includes("douyin")) { platform = "douyin"; label = "链接 · DOUYIN"; }
    else if (lower.includes("bilibili") || lower.includes("b23.tv")) { platform = "bilibili"; label = "链接 · BILIBILI"; }
    else if (lower.includes("youtube") || lower.includes("youtu.be")) { label = "链接 · YOUTUBE"; }
    else if (lower.includes("xiaohongshu") || lower.includes("xhslink") || lower.includes("xhs")) { platform = "xiaohongshu"; label = "链接 · XHS"; }
    else if (lower.includes("tiktok")) { platform = "tiktok"; label = "链接 · TIKTOK"; }
    return { kind: "url", platform, label };
  }
  if (v.startsWith("/") || v.startsWith("~/")) {
    return { kind: "file", label: "本地路径" };
  }
  return { kind: "unknown", label: "未识别" };
}

function formatDate(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear ? `${m}-${d} ${hh}:${mm}` : `${date.getFullYear()}-${m}-${d} ${hh}:${mm}`;
}

function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatResolution(w?: number, h?: number) {
  if (!w || !h) return null;
  return `${w}×${h}`;
}

function platformBadge(p?: Extract<ProjectSource, { type: "url" }>["platform"]) {
  switch (p) {
    case "douyin": return "DOUYIN";
    case "bilibili": return "BILIBILI";
    case "xiaohongshu": return "XHS";
    case "tiktok": return "TIKTOK";
    case "unknown": return "URL";
    default: return null;
  }
}

function projectSourceLabel(source: ProjectSource): string {
  if (source.type === "local_file") return "LOCAL";
  return platformBadge(source.platform) ?? "URL";
}

export function HomeScreen() {
  const { setCurrentScreen, goModule, projects, setActiveProjectId, setProjects, removeProject, startAnalysisForProject } = useApp();
  const confirm = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState<"idle" | "downloading" | "failed">("idle");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [dropError, setDropError] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [mode, setMode] = useState<AnalysisOptions["mode"]>("standard");
  const [density, setDensity] = useState<AnalysisOptions["density"]>("standard");
  const [focus, setFocus] = useState<AnalysisOptions["focus"]>("all");
  const [manualGenre, setManualGenre] = useState<VideoGenre | "auto">("auto");
  const [presetOpen, setPresetOpen] = useState(false);
  const presetRef = useRef<HTMLDivElement>(null);

  const currentPreset = matchPreset({ mode, density, focus });
  const presetMeta = PRESETS.find(p => p.key === currentPreset);
  const presetLabel = presetMeta?.title ?? "自定义";

  useEffect(() => {
    if (!presetOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (presetRef.current && !presetRef.current.contains(e.target as Node)) setPresetOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [presetOpen]);

  const pickPreset = (preset: PresetDef) => {
    setMode(preset.options.mode);
    setDensity(preset.options.density);
    setFocus(preset.options.focus);
  };

  const analysisOptions: AnalysisOptions = { mode, density, focus, manualGenre };

  const source = useMemo(() => detectSource(inputValue), [inputValue]);
  const canSubmit = source.kind === "url" || source.kind === "file";

  const { inProgress, completed, broken, all } = useMemo(() => {
    const sorted = [...projects].sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt || 0).getTime() -
        new Date(a.updatedAt || a.createdAt || 0).getTime(),
    );
    const inProgress: Project[] = [];
    const completed: Project[] = [];
    const broken: Project[] = [];
    for (const p of sorted) {
      if (p.status === "completed") completed.push(p);
      else if (p.status === "failed" || p.status === "download_failed") broken.push(p);
      else inProgress.push(p);
    }
    return { inProgress, completed, broken, all: sorted };
  }, [projects]);

  const visibleProjects = useMemo(() => {
    switch (tab) {
      case "inProgress": return inProgress;
      case "completed": return completed;
      case "broken": return broken;
      default: return all;
    }
  }, [tab, all, inProgress, completed, broken]);

  const setThumbnail = (projectId: string, dataUrl: string) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, thumbnailUrl: dataUrl } : p));
  };

  const goToProject = (proj: Project) => {
    if (proj.status === "completed") {
      setActiveProjectId(proj.id);
      setCurrentScreen("workspace");
      return;
    }
    if (proj.status === "analyzing" || proj.status === "downloading") {
      setActiveProjectId(proj.id);
      setCurrentScreen("progress");
      return;
    }
    // not_analyzed / failed / download_failed: 用项目自带或全局默认参数直跑
    startAnalysisForProject(proj.id);
  };

  const addInspectedProject = (video: InspectedVideo) => {
    const newProjectId = "proj-" + Date.now();
    const now = new Date().toISOString();
    setProjects(prev => [{
      id: newProjectId,
      source: { type: "local_file", originalPath: video.filePath },
      localVideoPath: video.mediaUrl,
      localFilePath: video.filePath,
      videoName: video.filename,
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
      orientation: video.orientation,
      status: "analyzing",
      analysisOptions,
      createdAt: now,
      updatedAt: now,
    }, ...prev]);
    setActiveProjectId(newProjectId);
    setCurrentScreen("progress");
  };

  const handleFilePicker = async () => {
    setDropError("");
    if (window.videoAnalyzer) {
      try {
        const video = await window.videoAnalyzer.openVideoFile();
        if (video) addInspectedProject(video);
      } catch (err) {
        setDropError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const videoEl = document.createElement("video");
    videoEl.src = objectUrl;
    videoEl.onloadedmetadata = () => {
      const newProjectId = "proj-" + Date.now();
      const now = new Date().toISOString();
      setProjects(prev => [{
        id: newProjectId,
        source: { type: "local_file", originalPath: file.name },
        localVideoPath: objectUrl,
        videoName: file.name,
        durationSec: videoEl.duration,
        width: videoEl.videoWidth,
        height: videoEl.videoHeight,
        orientation: videoEl.videoWidth > videoEl.videoHeight ? "landscape" : videoEl.videoWidth < videoEl.videoHeight ? "portrait" : "square",
        status: "analyzing",
        analysisOptions,
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(newProjectId);
      setCurrentScreen("progress");
    };
  };

  const handleSubmit = async () => {
    if (!canSubmit || status === "downloading") return;
    setError("");

    if (source.kind === "file") {
      const path = inputValue.trim().replace(/^~\//, `${(window as unknown as { videoAnalyzer?: { homedir?: string } }).videoAnalyzer?.homedir ?? ""}/`);
      if (!window.videoAnalyzer) {
        setError("浏览器预览模式下无法直接读取本地路径,请用 + 按钮选择文件。");
        setStatus("failed");
        return;
      }
      try {
        const video = await window.videoAnalyzer.inspectVideoPath(path);
        addInspectedProject(video);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("failed");
      }
      return;
    }

    // url — extract from share text if present (抖音/小红书/B 站口令)
    const targetUrl = extractUrl(inputValue) || inputValue.trim();
    setStatus("downloading");
    try {
      if (!window.videoAnalyzer) {
        setError("浏览器预览模式下无法拉取链接,请改用本地视频。");
        setStatus("failed");
        return;
      }
      // 异步下载:同步拿到 projectId,立刻创建 status="downloading" 项目并跳进度屏。
      // 真实视频元数据由 onDownloadComplete 事件回填(AppContext 顶层订阅)。
      const handle = await window.videoAnalyzer.downloadVideoAsync(targetUrl);
      const now = new Date().toISOString();
      setProjects(prev => [{
        id: handle.projectId,
        source: { type: "url", url: targetUrl, platform: handle.platform },
        localVideoPath: "",
        videoName: targetUrl,
        durationSec: 0,
        width: 0,
        height: 0,
        orientation: "landscape",
        status: "downloading",
        analysisOptions,
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(handle.projectId);
      setStatus("idle");
      setInputValue("");
      setCurrentScreen("progress");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("failed");
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const handleDelete = async (event: MouseEvent<HTMLButtonElement>, projectId: string) => {
    event.stopPropagation();
    const ok = await confirm({
      title: "删除项目",
      description: "确定要删除这个项目吗?分析结果会一同删除。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    removeProject(projectId);
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(true);
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget === event.target) setIsDragging(false);
  };
  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    setDropError("");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name)) {
      setDropError(`不是视频文件: ${file.name}`);
      return;
    }
    if (window.videoAnalyzer) {
      const filePath = window.videoAnalyzer.getPathForFile(file) || (file as File & { path?: string }).path;
      if (filePath) {
        try {
          const video = await window.videoAnalyzer.inspectVideoPath(filePath);
          addInspectedProject(video);
        } catch (err) {
          setDropError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }
    const objectUrl = URL.createObjectURL(file);
    const videoEl = document.createElement("video");
    videoEl.src = objectUrl;
    videoEl.onloadedmetadata = () => {
      const newProjectId = "proj-" + Date.now();
      const now = new Date().toISOString();
      setProjects(prev => [{
        id: newProjectId,
        source: { type: "local_file", originalPath: file.name },
        localVideoPath: objectUrl,
        videoName: file.name,
        durationSec: videoEl.duration,
        width: videoEl.videoWidth,
        height: videoEl.videoHeight,
        orientation: videoEl.videoWidth > videoEl.videoHeight ? "landscape" : videoEl.videoWidth < videoEl.videoHeight ? "portrait" : "square",
        status: "analyzing",
        analysisOptions,
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(newProjectId);
      setCurrentScreen("progress");
    };
  };

  const composerStateClass = (() => {
    if (status === "downloading") return "border-indigo-300 dark:border-indigo-700 ring-4 ring-indigo-50 dark:ring-indigo-950/40";
    if (status === "failed") return "border-rose-300 dark:border-rose-800 ring-4 ring-rose-50 dark:ring-rose-950/40";
    if (source.kind === "url") return "border-indigo-200 dark:border-indigo-900 ring-4 ring-indigo-50 dark:ring-indigo-950/40";
    return "border-slate-200 dark:border-slate-800";
  })();

  return (
    <main
      className="flex-1 overflow-y-auto bg-slate-50 dark:bg-[#0c0d10] relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-4xl mx-auto px-14 pt-10 pb-16 space-y-7">

        {/* Brand header — editorial */}
        <header className="select-none">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400 mb-2">
            CLIPIQ · 创作者剪辑助手
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-tight">
            从哪里开始?
          </h1>
          <p className="text-[15px] text-slate-600 dark:text-slate-400 mt-2.5 max-w-xl">
            分析一条视频,或者进其它三个模块继续上次的工作。
          </p>
        </header>

        {/* Featured — analysis launcher with embedded composer */}
        <section className="space-y-3">
          <div className="rounded-[14px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-5">
            <div className="flex items-start gap-4 mb-3.5">
              <div className="w-[38px] h-[38px] rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 grid place-items-center shrink-0">
                <BarChart3 className="w-[18px] h-[18px]" strokeWidth={1.5} />
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">分析一条视频</h2>
                  <span className="text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400">
                    · {all.length} 条已有项目
                    {inProgress.length > 0 ? ` · ${inProgress.length} 条正在跑` : ""}
                  </span>
                </div>
                <p className="text-[12.5px] text-slate-600 dark:text-slate-400 mt-1">
                  粘贴 B 站链接、拖入本地视频,或输入本地路径。Cmd + Enter 直接开跑。
                </p>
              </div>
            </div>

          {/* Composer */}
          <div
            className={`rounded-[14px] border bg-white dark:bg-[#14151a] p-1 transition-all ${composerStateClass}`}
          >
            <div className="flex items-center gap-2 px-3 pt-3 pb-1">
              <button
                type="button"
                onClick={handleFilePicker}
                title="选择本地视频文件"
                className="self-center w-[38px] h-[52px] rounded-[10px] border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#1c1e24] grid place-items-center text-slate-500 hover:text-indigo-600 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors shrink-0"
              >
                <Plus className="w-4 h-4" />
              </button>
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  autoGrow(e.currentTarget);
                }}
                onKeyDown={handleInputKeyDown}
                disabled={status === "downloading"}
                rows={1}
                placeholder="粘贴抖音 / B 站 / YouTube 链接,或抖音分享口令,或拖入视频文件"
                className="flex-1 min-h-[52px] max-h-[200px] py-[15px] resize-none bg-transparent border-0 outline-none text-sm leading-snug text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 px-2 min-w-0 disabled:opacity-60"
              />
              <input type="file" ref={fileInputRef} className="hidden" accept="video/*" onChange={handleFileInputChange} />
            </div>

            <div className="flex justify-between items-center gap-2 pl-3 pr-2 pb-2">
              <div className="flex gap-1.5 flex-wrap min-w-0 items-center">
                <SourceChip source={source} status={status} />
                <div ref={presetRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setPresetOpen(o => !o)}
                    className={`inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full border text-[12.5px] whitespace-nowrap transition-colors ${
                      presetOpen
                        ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300"
                        : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#1c1e24] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#222530]"
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{presetLabel}</span>
                    <ChevronDown className={`w-3 h-3 opacity-60 transition-transform ${presetOpen ? "rotate-180" : ""}`} />
                  </button>
                  {presetOpen && (
                    <PresetPopover
                      currentPreset={currentPreset}
                      onPickPreset={pickPreset}
                      mode={mode}
                      setMode={setMode}
                      density={density}
                      setDensity={setDensity}
                      focus={focus}
                      setFocus={setFocus}
                      manualGenre={manualGenre}
                      setManualGenre={setManualGenre}
                    />
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit || status === "downloading"}
                title="开始分析"
                className="w-9 h-9 rounded-full bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-600 text-white grid place-items-center transition-all shrink-0"
              >
                {status === "downloading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
              </button>
            </div>
          </div>
          </div>{/* end hero card */}

          {!window.videoAnalyzer && (
            <div className="flex justify-end text-[11px] font-mono uppercase tracking-wider text-amber-600 dark:text-amber-400 px-1">
              浏览器预览模式
            </div>
          )}

          {(error || dropError) && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error || dropError}</span>
            </div>
          )}
        </section>

        {/* Other 3 modules — equal launcher cards */}
        <section className="grid grid-cols-3 gap-2.5">
          <ModuleLaunchCard
            icon={<Folder className="w-3.5 h-3.5" strokeWidth={1.5} />}
            label="上传素材入库"
            desc="把拍摄素材自动分镜,建可检索的镜头索引。"
            onClick={() => goModule("library")}
          />
          <ModuleLaunchCard
            icon={<UserSquare className="w-3.5 h-3.5" strokeWidth={1.5} />}
            label="账号分析"
            desc="输入 UP 主链接,批量分析热门视频,汇总方法论。"
            onClick={() => goModule("account")}
          />
          <ModuleLaunchCard
            icon={<Wand2 className="w-3.5 h-3.5" strokeWidth={1.5} />}
            label="新建剪辑会话"
            desc="从目标出发,结合素材库与方法论生成剪辑思路。"
            onClick={() => goModule("studio")}
          />
        </section>

        {/* Recent projects */}
        {projects.length > 0 ? (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">最近项目</h3>
              <SegmentedTabs
                tab={tab}
                onChange={setTab}
                counts={{
                  all: all.length,
                  inProgress: inProgress.length,
                  completed: completed.length,
                  broken: broken.length,
                }}
              />
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden">
              {/* Header row */}
              <div className="hidden md:grid grid-cols-[80px_1fr_72px_120px_88px_72px] gap-4 items-center px-3 py-2 border-b border-slate-200 dark:border-slate-800 text-[10.5px] font-mono uppercase tracking-wider text-slate-400 dark:text-slate-500">
                <span />
                <span>项目</span>
                <span>时长</span>
                <span>更新</span>
                <span>状态</span>
                <span />
              </div>
              {visibleProjects.length === 0 ? (
                <div className="text-center py-12 text-sm text-slate-400 dark:text-slate-500">
                  {tab === "inProgress" && "暂无进行中项目"}
                  {tab === "completed" && "暂无已完成项目"}
                  {tab === "broken" && "暂无失败项目"}
                  {tab === "all" && "暂无项目"}
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-900">
                  {visibleProjects.map(proj => (
                    <ProjectRow
                      key={proj.id}
                      project={proj}
                      onOpen={() => goToProject(proj)}
                      onDelete={(e) => handleDelete(e, proj.id)}
                      onReanalyze={(e) => {
                        e.stopPropagation();
                        startAnalysisForProject(proj.id);
                      }}
                      onThumbnailReady={(dataUrl) => setThumbnail(proj.id, dataUrl)}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : (
          <div className="text-center py-16 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-white/50 dark:bg-[#0e0e10]/30 text-slate-500 text-sm">
            暂无项目,粘贴链接或拖入视频开始。
          </div>
        )}
      </div>

      {/* Full-page drag overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <div className="absolute inset-4 rounded-2xl border-2 border-dashed border-indigo-400 bg-indigo-50/85 dark:bg-indigo-950/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            <div className="w-14 h-14 rounded-full bg-indigo-600 text-white grid place-items-center">
              <Upload className="w-6 h-6" />
            </div>
            <div className="text-xl font-semibold text-indigo-900 dark:text-indigo-100">释放以导入视频</div>
            <div className="text-[11px] font-mono uppercase tracking-wider text-indigo-700/70 dark:text-indigo-300/70">
              支持 MP4 · MOV · MKV · WEBM · AVI · M4V
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const ModuleLaunchCard: FunctionComponent<{
  icon: ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}> = ({ icon, label, desc, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="text-left p-4 bg-white dark:bg-[#14151a] border border-slate-200 dark:border-slate-800 rounded-xl hover:border-slate-300 dark:hover:border-slate-700 transition-colors group"
    >
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-7 h-7 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 grid place-items-center shrink-0">
          {icon}
        </div>
        <h3 className="text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 flex-1">{label}</h3>
        <ChevronRight className="w-3 h-3 text-slate-400 dark:text-slate-500 group-hover:text-slate-700 dark:group-hover:text-slate-300 transition-colors" strokeWidth={1.5} />
      </div>
      <p className="text-[12.5px] text-slate-600 dark:text-slate-400 leading-relaxed">{desc}</p>
    </button>
  );
};

function SegmentedTabs({
  tab, onChange, counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: Record<Tab, number>;
}) {
  const items: { key: Tab; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "inProgress", label: "进行中" },
    { key: "completed", label: "已完成" },
    { key: "broken", label: "失败" },
  ];
  return (
    <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-0.5">
      {items.map(it => {
        const active = tab === it.key;
        const count = counts[it.key];
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] transition-colors ${
              active
                ? "bg-slate-100 dark:bg-[#1c1e24] text-slate-900 dark:text-slate-100 font-medium"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <span>{it.label}</span>
            {count > 0 && (
              <span className={`font-mono text-[10.5px] tabular-nums ${active ? "text-slate-500 dark:text-slate-400" : "text-slate-400 dark:text-slate-600"}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Chip({ icon, label, active }: {
  icon: ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full border text-[12.5px] whitespace-nowrap select-none ${
        active
          ? "border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300"
          : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#1c1e24] text-slate-500 dark:text-slate-400"
      }`}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}

function SourceChip({ source, status }: { source: SourceState; status: "idle" | "downloading" | "failed" }) {
  if (status === "downloading") {
    return <Chip icon={<Loader2 className="w-3.5 h-3.5 animate-spin" />} label="正在拉取…" active />;
  }
  if (source.kind === "url") {
    return <Chip icon={<LinkIcon className="w-3.5 h-3.5" />} label={source.label} active />;
  }
  if (source.kind === "file") {
    return <Chip icon={<FileVideo className="w-3.5 h-3.5" />} label={source.label} active />;
  }
  if (source.kind === "unknown") {
    return <Chip icon={<AlertTriangle className="w-3.5 h-3.5" />} label="未识别" />;
  }
  return <Chip icon={<LinkIcon className="w-3.5 h-3.5" />} label="自动识别来源" />;
}

type ProjectRowProps = {
  project: Project;
  onOpen: () => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onReanalyze: (e: MouseEvent<HTMLButtonElement>) => void;
  onThumbnailReady: (dataUrl: string) => void;
};

const ProjectRow: FunctionComponent<ProjectRowProps> = ({ project, onOpen, onDelete, onReanalyze, onThumbnailReady }) => {
  const platformLabel = projectSourceLabel(project.source);
  const resolution = formatResolution(project.width, project.height);
  const [thumb, setThumb] = useState<string | null>(project.thumbnailUrl ?? null);
  const captureAttemptedRef = useRef(false);

  useEffect(() => {
    if (thumb || captureAttemptedRef.current) return;
    if (!project.localVideoPath) return;
    captureAttemptedRef.current = true;
    const video = document.createElement("video");
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.src = project.localVideoPath;
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.2, (video.duration || 1) * 0.05);
      } catch {
        cleanup();
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) { cleanup(); return; }
        const targetW = 160;
        const targetH = Math.round(targetW * (h / w));
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) { cleanup(); return; }
        ctx.drawImage(video, 0, 0, targetW, targetH);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        setThumb(dataUrl);
        onThumbnailReady(dataUrl);
      } catch {
        // canvas tainted (cross-origin) — fall back to Film icon
      } finally {
        cleanup();
      }
    };
    video.onerror = cleanup;
    return cleanup;
  }, [project.localVideoPath, thumb, onThumbnailReady]);

  return (
    <div
      onClick={onOpen}
      className="group grid grid-cols-[80px_1fr_72px_120px_88px_72px] gap-4 items-center px-3 py-2.5 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-[#1c1e24]"
    >
      <div className="w-[80px] h-[48px] rounded-md relative overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#1c1e24]">
        {thumb ? (
          <img src={thumb} alt={project.videoName} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-600">
            <Film className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="font-medium text-[13.5px] text-slate-900 dark:text-slate-100 truncate">{project.videoName}</div>
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide text-slate-500 dark:text-slate-500 mt-0.5">
          {resolution && <span>{resolution}</span>}
          {resolution && <span className="text-slate-300 dark:text-slate-700">·</span>}
          <span>{platformLabel}</span>
        </div>
      </div>
      <div className="text-[12px] font-mono tabular-nums text-slate-600 dark:text-slate-400">
        {formatDuration(project.durationSec)}
      </div>
      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-500 tabular-nums">
        {formatDate(new Date(project.updatedAt || project.createdAt || Date.now()))}
      </div>
      <div>
        <StatusBadge status={project.status} />
      </div>
      <div className="flex items-center justify-end gap-1">
        {project.status === "completed" && (
          <button
            type="button"
            onClick={onReanalyze}
            title="重新分析"
            className="h-7 w-7 grid place-items-center rounded-md text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-300 transition-all"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="删除项目"
          className="h-7 w-7 grid place-items-center rounded-md text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 transition-all"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

function StatusBadge({ status }: { status: Project["status"] }) {
  const base = "inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10.5px] font-mono uppercase tracking-wider";
  switch (status) {
    case "completed":
      return <span className={`${base} bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400`}>
        <CheckCircle2 className="w-3 h-3" /> 完成
      </span>;
    case "analyzing":
      return <span className={`${base} bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400`}>
        <Loader2 className="w-3 h-3 animate-spin" /> 分析中
      </span>;
    case "downloading":
      return <span className={`${base} bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400`}>
        <Loader2 className="w-3 h-3 animate-spin" /> 下载中
      </span>;
    case "failed":
    case "download_failed":
      return <span className={`${base} bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400`}>
        <XCircle className="w-3 h-3" /> 失败
      </span>;
    case "not_analyzed":
    default:
      return <span className={`${base} bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400`}>
        <Clock className="w-3 h-3" /> 待开始
      </span>;
  }
}

function PresetPopover({
  currentPreset, onPickPreset,
  mode, setMode, density, setDensity, focus, setFocus, manualGenre, setManualGenre,
}: {
  currentPreset: PresetKey;
  onPickPreset: (p: PresetDef) => void;
  mode: AnalysisOptions["mode"];
  setMode: (v: AnalysisOptions["mode"]) => void;
  density: AnalysisOptions["density"];
  setDensity: (v: AnalysisOptions["density"]) => void;
  focus: AnalysisOptions["focus"];
  setFocus: (v: AnalysisOptions["focus"]) => void;
  manualGenre: VideoGenre | "auto";
  setManualGenre: (v: VideoGenre | "auto") => void;
}) {
  return (
    <div
      className="absolute z-30 top-full mt-2 left-0 w-[460px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] shadow-lg shadow-slate-900/5 dark:shadow-black/40 p-3 space-y-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div>
        <div className="text-[10.5px] font-mono uppercase tracking-wider text-slate-500 mb-2">拉片强度</div>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map(preset => {
            const isActive = preset.key === currentPreset;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => onPickPreset(preset)}
                className={`text-left rounded-lg border p-2.5 transition-colors ${
                  isActive
                    ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30"
                    : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#1c1e24] hover:border-slate-300 dark:hover:border-slate-700"
                }`}
              >
                <div className="mb-1">
                  <span className={`text-[13px] font-semibold ${isActive ? "text-indigo-900 dark:text-indigo-200" : "text-slate-900 dark:text-slate-100"}`}>
                    {preset.title}
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug line-clamp-2">
                  {preset.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10.5px] font-mono uppercase tracking-wider text-slate-500">高级参数</span>
          {currentPreset === "custom" && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-indigo-600 dark:text-indigo-400">已自定义</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <PopoverField label="视频类型" wide>
            <div className="flex flex-wrap gap-1">
              {([
                { value: "auto",        label: "自动识别" },
                { value: "vlog",        label: "vlog" },
                { value: "review",      label: "测评" },
                { value: "travel",      label: "旅行" },
                { value: "tutorial",    label: "教程" },
                { value: "knowledge",   label: "知识" },
                { value: "documentary", label: "纪录" },
                { value: "short-drama", label: "短剧" },
                { value: "other",       label: "其他" },
              ] as const).map(opt => {
                const active = opt.value === manualGenre;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setManualGenre(opt.value)}
                    className={`h-6 px-2 rounded-md text-[11px] border transition-colors ${
                      active
                        ? "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-900"
                        : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800 dark:hover:bg-slate-800"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </PopoverField>
          <PopoverField label="分析模式">
            <PopoverSegment
              value={mode}
              options={[
                { value: "quick", label: "快速" },
                { value: "standard", label: "标准" },
                { value: "detailed", label: "深度" },
              ]}
              onChange={(v) => setMode(v as AnalysisOptions["mode"])}
            />
          </PopoverField>
          <PopoverField label="节点密度">
            <PopoverSegment
              value={density}
              options={[
                { value: "sparse", label: "稀疏" },
                { value: "standard", label: "标准" },
                { value: "dense", label: "密集" },
              ]}
              onChange={(v) => setDensity(v as AnalysisOptions["density"])}
            />
          </PopoverField>
          <PopoverField label="关注重点" wide>
            <PopoverSegment
              value={focus}
              options={[
                { value: "all", label: "全部" },
                { value: "narrative", label: "叙事" },
                { value: "rhythm", label: "节奏" },
                { value: "emotion", label: "情绪" },
              ]}
              onChange={(v) => setFocus(v as AnalysisOptions["focus"])}
            />
          </PopoverField>
        </div>
      </div>
    </div>
  );
}

function PopoverField({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function PopoverSegment({ value, options, onChange }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-md bg-slate-100 dark:bg-slate-900 p-0.5">
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex-1 h-6 px-1.5 rounded text-[11px] transition-colors ${
              active
                ? "bg-white dark:bg-[#14151a] text-slate-900 dark:text-slate-100 font-medium"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
