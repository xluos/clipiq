import { useApp } from "../AppContext";
import {
  Plus, ArrowUp, ChevronDown, Link as LinkIcon, FileVideo,
  CheckCircle2, Clock, XCircle, Trash2, Film, Loader2, Settings2, Cpu, AlertTriangle,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, type FunctionComponent, type KeyboardEvent, type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";
import type { InspectedVideo } from "../electron-api";
import { BrandLogo } from "../components/BrandLogo";
import { useConfirm } from "../components/ConfirmDialog";
import type { Project, ProjectSource } from "../types";

type SourceKind = "empty" | "url" | "file" | "unknown";

type SourceState = {
  kind: SourceKind;
  platform?: Extract<ProjectSource, { type: "url" }>["platform"];
  label: string;
};

function detectSource(raw: string): SourceState {
  const v = raw.trim();
  if (!v) return { kind: "empty", label: "选择来源" };
  const lower = v.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
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
  const { setCurrentScreen, projects, setActiveProjectId, setProjects, removeProject } = useApp();
  const confirm = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState<"idle" | "downloading" | "failed">("idle");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [dropError, setDropError] = useState("");

  const source = useMemo(() => detectSource(inputValue), [inputValue]);
  const canSubmit = source.kind === "url" || source.kind === "file";

  const { inProgress, completed, broken } = useMemo(() => {
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
    return { inProgress, completed, broken };
  }, [projects]);

  const goToProject = (proj: Project) => {
    setActiveProjectId(proj.id);
    if (proj.status === "completed") setCurrentScreen("workspace");
    else if (proj.status === "analyzing" || proj.status === "downloading") setCurrentScreen("progress");
    else setCurrentScreen("prepare");
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
      status: "not_analyzed",
      createdAt: now,
      updatedAt: now,
    }, ...prev]);
    setActiveProjectId(newProjectId);
    setCurrentScreen("prepare");
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
        status: "not_analyzed",
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(newProjectId);
      setCurrentScreen("prepare");
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

    // url
    setStatus("downloading");
    try {
      if (!window.videoAnalyzer) {
        setError("浏览器预览模式下无法拉取链接,请改用本地视频。");
        setStatus("failed");
        return;
      }
      const video = await window.videoAnalyzer.downloadVideo(inputValue.trim());
      const displayTitle = video.title || video.filename;
      const now = new Date().toISOString();
      setProjects(prev => [{
        id: video.projectId,
        source: { type: "url", url: inputValue.trim(), platform: video.platform },
        localVideoPath: video.mediaUrl,
        localFilePath: video.filePath,
        videoName: displayTitle,
        titleAutoGenerated: !!video.title,
        durationSec: video.durationSec,
        width: video.width,
        height: video.height,
        orientation: video.orientation,
        status: "not_analyzed",
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(video.projectId);
      setStatus("idle");
      setInputValue("");
      window.setTimeout(() => setCurrentScreen("prepare"), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("failed");
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleDelete = async (event: MouseEvent<HTMLButtonElement>, projectId: string) => {
    event.stopPropagation();
    const ok = await confirm({
      title: "删除项目",
      description: "确定要删除这个项目吗?项目的分析结果会从应用记录中一并移除。",
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
        status: "not_analyzed",
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(newProjectId);
      setCurrentScreen("prepare");
    };
  };

  const composerStateClass = (() => {
    if (status === "downloading") return "border-indigo-300 dark:border-indigo-700 ring-4 ring-indigo-50 dark:ring-indigo-950/40";
    if (status === "failed") return "border-rose-300 dark:border-rose-800 ring-4 ring-rose-50 dark:ring-rose-950/40";
    if (source.kind === "url") return "border-indigo-200 dark:border-indigo-900 ring-4 ring-indigo-50 dark:ring-indigo-950/40";
    if (isDragging) return "border-indigo-400 dark:border-indigo-500 ring-4 ring-indigo-100 dark:ring-indigo-950/60";
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
      <div className="max-w-3xl mx-auto px-8 pt-12 pb-24 space-y-10">

        {/* Header */}
        <header className="flex items-center gap-4 select-none">
          <BrandLogo size={56} className="shrink-0" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">ClipIQ</h1>
            <p className="text-xs font-mono text-slate-500 dark:text-slate-500 tracking-wider uppercase mt-1">视频拉片 · 桌面工具</p>
          </div>
        </header>

        {/* Hero block */}
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">新建项目</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">粘贴链接、拖入文件,或输入本地路径。</p>
          </div>

          {/* Composer */}
          <div
            className={`rounded-[18px] border bg-white dark:bg-[#14151a] p-1 transition-all ${composerStateClass}`}
          >
            <div className="flex items-start gap-2 px-3 pt-3 pb-1">
              <button
                type="button"
                onClick={handleFilePicker}
                title="选择本地视频文件"
                className="w-[38px] h-[52px] rounded-[10px] border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#1c1e24] grid place-items-center text-slate-500 hover:text-indigo-600 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors shrink-0"
              >
                <Plus className="w-4 h-4" />
              </button>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleInputKeyDown}
                disabled={status === "downloading"}
                placeholder={isDragging ? "松开即可导入视频" : "粘贴抖音 / B 站 / YouTube 链接,或拖入视频文件"}
                className="flex-1 h-[52px] bg-transparent border-0 outline-none text-base text-slate-900 dark:text-slate-100 placeholder:text-slate-500 dark:placeholder:text-slate-500 px-2 min-w-0 disabled:opacity-60"
              />
              <input type="file" ref={fileInputRef} className="hidden" accept="video/*" onChange={handleFileInputChange} />
            </div>

            <div className="flex justify-between items-center gap-2 pl-3 pr-2 pb-2">
              <div className="flex gap-1.5 flex-wrap min-w-0">
                <SourceChip source={source} status={status} />
                <Chip icon={<Settings2 className="w-3.5 h-3.5" />} label="标准拉片" caret />
                <Chip icon={<Cpu className="w-3.5 h-3.5" />} label="主模型 · 默认" caret />
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

          {/* Hint / error */}
          <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-500 px-1">
            <span>⏎ 回车开始 · ⌘V 粘贴 · ⌥V 选择本地</span>
            {!window.videoAnalyzer && <span className="text-amber-600 dark:text-amber-400">浏览器预览模式</span>}
          </div>

          {(error || dropError) && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error || dropError}</span>
            </div>
          )}
        </section>

        {/* Project groups */}
        {inProgress.length > 0 && (
          <ProjectGroup
            title="进行中"
            count={inProgress.length}
            note="按更新时间排序"
            projects={inProgress}
            onOpen={goToProject}
            onDelete={handleDelete}
          />
        )}
        {completed.length > 0 && (
          <ProjectGroup
            title="已完成"
            count={completed.length}
            note={completed.length >= 5 ? "近 30 天" : undefined}
            projects={completed}
            onOpen={goToProject}
            onDelete={handleDelete}
          />
        )}
        {broken.length > 0 && (
          <ProjectGroup
            title="失败"
            count={broken.length}
            note="可重试"
            projects={broken}
            onOpen={goToProject}
            onDelete={handleDelete}
          />
        )}
        {projects.length === 0 && (
          <div className="text-center py-16 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-white/50 dark:bg-[#0e0e10]/30 text-slate-500 text-sm">
            暂无项目,粘贴链接或拖入视频开始。
          </div>
        )}
      </div>
    </main>
  );
}

function Chip({ icon, label, caret, onClick, active }: {
  icon: ReactNode;
  label: string;
  caret?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full border text-[12.5px] whitespace-nowrap transition-colors ${
        active
          ? "border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300"
          : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#1c1e24] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#222530]"
      }`}
    >
      {icon}
      <span>{label}</span>
      {caret && <ChevronDown className="w-3 h-3 opacity-60" />}
    </button>
  );
}

function SourceChip({ source, status }: { source: SourceState; status: "idle" | "downloading" | "failed" }) {
  if (status === "downloading") {
    return <Chip icon={<Loader2 className="w-3.5 h-3.5 animate-spin" />} label="正在拉取…" active />;
  }
  if (source.kind === "url") {
    return <Chip icon={<LinkIcon className="w-3.5 h-3.5" />} label={source.label} active caret />;
  }
  if (source.kind === "file") {
    return <Chip icon={<FileVideo className="w-3.5 h-3.5" />} label={source.label} active caret />;
  }
  if (source.kind === "unknown") {
    return <Chip icon={<AlertTriangle className="w-3.5 h-3.5" />} label="未识别" />;
  }
  return <Chip icon={<LinkIcon className="w-3.5 h-3.5" />} label="选择来源" caret />;
}

function ProjectGroup({
  title, count, note, projects, onOpen, onDelete,
}: {
  title: string;
  count: number;
  note?: string;
  projects: Project[];
  onOpen: (p: Project) => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>, projectId: string) => void;
}) {
  return (
    <section>
      <div className="flex items-end justify-between mb-2">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          {title}
          <span className="font-normal font-mono text-[11px] text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-px rounded">{count}</span>
        </h3>
        {note && <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">{note}</span>}
      </div>
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-1.5">
        {projects.map(proj => (
          <ProjectRow key={proj.id} project={proj} onOpen={() => onOpen(proj)} onDelete={(e) => onDelete(e, proj.id)} />
        ))}
      </div>
    </section>
  );
}

type ProjectRowProps = {
  project: Project;
  onOpen: () => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
};

const ProjectRow: FunctionComponent<ProjectRowProps> = ({ project, onOpen, onDelete }) => {
  const platformLabel = projectSourceLabel(project.source);
  return (
    <div
      onClick={onOpen}
      className="group grid grid-cols-[100px_1fr_auto] gap-4 items-center p-2.5 rounded-lg cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-[#1c1e24]"
    >
      <div className="w-[100px] h-[60px] rounded relative overflow-hidden border border-slate-200 dark:border-slate-800 bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-800 dark:to-slate-900">
        {project.thumbnailUrl ? (
          <img src={project.thumbnailUrl} alt={project.videoName} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-600">
            <Film className="h-5 w-5" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/15 group-hover:bg-black/5 transition-colors" />
      </div>
      <div className="min-w-0">
        <div className="font-medium text-[13.5px] text-slate-900 dark:text-slate-100 truncate mb-1">{project.videoName}</div>
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide text-slate-500 dark:text-slate-500">
          <span>{formatDuration(project.durationSec)}</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span>{platformLabel}</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <StatusInline status={project.status} />
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] font-mono text-slate-400 hidden md:inline-block tabular-nums">
          {formatDate(new Date(project.updatedAt || project.createdAt || Date.now()))}
        </span>
        <StatusBadge status={project.status} />
        <button
          type="button"
          onClick={onDelete}
          title="删除项目"
          className="h-7 w-7 hidden md:grid place-items-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function StatusInline({ status }: { status: Project["status"] }) {
  switch (status) {
    case "completed": return <span className="text-emerald-700 dark:text-emerald-400 normal-case font-sans">已完成</span>;
    case "analyzing": return <span className="text-indigo-700 dark:text-indigo-400 normal-case font-sans">分析中</span>;
    case "downloading": return <span className="text-indigo-700 dark:text-indigo-400 normal-case font-sans">下载中</span>;
    case "failed": return <span className="text-rose-700 dark:text-rose-400 normal-case font-sans">分析失败</span>;
    case "download_failed": return <span className="text-rose-700 dark:text-rose-400 normal-case font-sans">下载失败</span>;
    default: return <span className="text-slate-600 dark:text-slate-400 normal-case font-sans">待分析</span>;
  }
}

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
