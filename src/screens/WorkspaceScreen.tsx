import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Play, Pause, ArrowLeft, Folder, Search, Star, ExternalLink, Copy, Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnalysisNode, AnalysisNodeType, DanmakuEmotionAxis, Video } from "../types";
import { formatTime } from "@/lib/utils";

// 弹幕情绪 → 颜色 / 中文标签 (用于时间轴情绪带 + 节点卡片小标签)
const EMOTION_COLORS: Record<DanmakuEmotionAxis | "neutral", string> = {
  joy: "#f59e0b",       // amber
  surprise: "#06b6d4",  // cyan
  anger: "#ef4444",     // red
  sadness: "#3b82f6",   // blue
  disgust: "#84cc16",   // lime
  neutral: "#94a3b8",   // slate
};
const EMOTION_ZH: Record<DanmakuEmotionAxis | "neutral", string> = {
  joy: "笑场",
  surprise: "惊讶",
  anger: "吐槽",
  sadness: "感伤",
  disgust: "无语",
  neutral: "平淡",
};

export function WorkspaceScreen() {
  const { setCurrentScreen, projects, activeProjectId, activeAnalysisId: ctxAnalysisId, nodesByAnalysis, setNodesForAnalysis, reportByAnalysis, startAnalysisForProject, analysisRecordsByProject, analysesByVideo, switchAnalysis } = useApp();

  const project = projects.find(p => p.id === activeProjectId);
  const currentAnalysisId = ctxAnalysisId
    || project?.currentAnalysisId
    || (analysesByVideo[activeProjectId || ""] || [])[0]?.id
    || "";
  const nodes = nodesByAnalysis[currentAnalysisId] || [];
  const report = currentAnalysisId ? reportByAnalysis[currentAnalysisId] : undefined;
  const shotContexts = report?.shotContexts || [];

  // 冷加载:nodes/report 不再在启动预热,缓存里没有就按需从 DB 取(switchAnalysis → getAnalysis)。
  useEffect(() => {
    if (currentAnalysisId && activeProjectId && !nodesByAnalysis[currentAnalysisId]) {
      switchAnalysis(activeProjectId, currentAnalysisId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAnalysisId, activeProjectId]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlightsOnly, setHighlightsOnly] = useState(false);
  const [tab, setTab] = useState<"timeline" | "shots" | "insights">("timeline");
  const [sourceCopied, setSourceCopied] = useState(false);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);
  const [hoverProgress, setHoverProgress] = useState<{ x: number; time: number } | null>(null);
  const [expandedSubtitleShots, setExpandedSubtitleShots] = useState<Set<number>>(new Set());
  const progressTrackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      // Find active node
      const current = nodes.find(n => video.currentTime >= n.startSec && video.currentTime < n.endSec);
      if (current && current.id !== activeNodeId) {
        setActiveNodeId(current.id);
        // Ensure visible in list
        const el = document.getElementById(`node-${current.id}`);
        if (el && scrollRef.current) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', () => setIsPlaying(true));
    video.addEventListener('pause', () => setIsPlaying(false));

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', () => setIsPlaying(true));
      video.removeEventListener('pause', () => setIsPlaying(false));
    };
  }, [nodes, activeNodeId]);

  useEffect(() => {
    if (!activeProjectId || !videoRef.current) return;
    const raw = window.sessionStorage.getItem("video-analyzer-pending-seek");
    if (!raw) return;
    try {
      const payload = JSON.parse(raw);
      if (payload.projectId === activeProjectId && Number.isFinite(payload.time)) {
        videoRef.current.currentTime = payload.time;
        setCurrentTime(payload.time);
        window.sessionStorage.removeItem("video-analyzer-pending-seek");
      }
    } catch {
      window.sessionStorage.removeItem("video-analyzer-pending-seek");
    }
  }, [activeProjectId]);

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B]">
        <Folder className="w-16 h-16 text-slate-300 dark:text-slate-700 mb-4" />
        <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-300">暂无选中的项目</h2>
        <p className="text-sm text-slate-500 mt-2">请先从首页选择或创建一个项目</p>
        <Button className="mt-6" onClick={() => setCurrentScreen("home")}>
          返回首页
        </Button>
      </div>
    );
  }

  const handleNodeClick = (node: AnalysisNode) => {
    setActiveNodeId(node.id);
    if (videoRef.current) {
      videoRef.current.currentTime = node.startSec;
      setCurrentTime(node.startSec);
    }
  };

  const handleNodeDoubleClick = (node: AnalysisNode) => {
    setActiveNodeId(node.id);
    if (videoRef.current) {
      videoRef.current.currentTime = node.startSec;
      setCurrentTime(node.startSec);
      videoRef.current.play();
    }
  };

  const seekToFraction = (fraction: number) => {
    if (!videoRef.current) return;
    const clamped = Math.min(Math.max(fraction, 0), 1);
    const target = clamped * project.durationSec;
    videoRef.current.currentTime = target;
    setCurrentTime(target);
  };

  const handleProgressPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = progressTrackRef.current;
    if (!track) return;
    track.setPointerCapture(event.pointerId);
    setIsDraggingProgress(true);
    const rect = track.getBoundingClientRect();
    seekToFraction((event.clientX - rect.left) / rect.width);
  };

  const handleProgressPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = progressTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    setHoverProgress({ x: fraction * rect.width, time: fraction * project.durationSec });
    if (isDraggingProgress) {
      seekToFraction(fraction);
    }
  };

  const handleProgressPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = progressTrackRef.current;
    if (track && track.hasPointerCapture(event.pointerId)) {
      track.releasePointerCapture(event.pointerId);
    }
    setIsDraggingProgress(false);
  };

  const handleProgressPointerLeave = () => {
    setHoverProgress(null);
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
    }
  };

  const updateNode = (nodeId: string, patch: Partial<AnalysisNode>) => {
    if (!activeProjectId) return;
    if (!currentAnalysisId) return;
    setNodesForAnalysis(currentAnalysisId, nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node));
  };

  const filteredNodes = nodes.filter(node => {
    if (highlightsOnly && !node.isHighlight) return false;
    const text = `${node.title} ${node.shotDescription} ${node.narrativeFunction} ${node.emotionLabel} ${node.note || ""}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  });

  const isPortrait = project.orientation === "portrait";

  const totalNodes = nodes.length;
  const highlightCount = nodes.filter(n => n.isHighlight).length;
  const avgConfidence = totalNodes
    ? Math.round((nodes.reduce((sum, n) => sum + (Number(n.confidence) || 0), 0) / totalNodes) * 100)
    : 0;
  const avgEmotion = totalNodes
    ? Math.round((nodes.reduce((sum, n) => sum + (Number(n.emotionIntensity) || 0), 0) / totalNodes) * 10) / 10
    : 0;
  const emotionDistribution: Array<[string, number]> = (Object.entries(
    nodes.reduce<Record<string, number>>((acc, node) => {
      const key = node.emotionLabel || "未标注";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  ) as Array<[string, number]>).sort((a, b) => b[1] - a[1]);
  const nodeTypeLabel: Record<AnalysisNodeType, string> = {
    shot_change: "镜头切换",
    emotion_turn: "情绪转折",
    info_point: "信息点",
    edit_intent: "剪辑意图",
    audio_change: "音频变化",
  };
  const nodeTypeDistribution: Array<[string, number]> = (Object.entries(
    nodes.reduce<Record<string, number>>((acc, node) => {
      for (const type of node.nodeTypes || []) {
        acc[type] = (acc[type] || 0) + 1;
      }
      return acc;
    }, {})
  ) as Array<[string, number]>).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      {/* Top Toolbar */}
      <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0A0A0B]/80 backdrop-blur flex flex-none items-center justify-between px-4 z-10 shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <Button variant="ghost" size="icon" onClick={() => setCurrentScreen("home")} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="h-4 w-px bg-slate-200 dark:bg-slate-800" />
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate max-w-[180px] md:max-w-xs">{project.videoName}</span>
            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-600 shrink-0">{project.id}</span>
            <span className="px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] border border-indigo-100 dark:border-indigo-500/20 shrink-0">
              {project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"}
            </span>
            <SourceBadge
              project={project}
              copied={sourceCopied}
              onCopy={() => {
                const src = project.source;
                const value = src.type === "url" ? src.url : (project.localFilePath || src.originalPath);
                if (!value) return;
                navigator.clipboard?.writeText(value).then(() => {
                  setSourceCopied(true);
                  window.setTimeout(() => setSourceCopied(false), 1500);
                });
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-4">
          {project.status === "analyzing" ? (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>
              <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300 tracking-widest">分析中</span>
            </div>
          ) : project.status === "completed" ? (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 tracking-widest">已完成</span>
            </div>
          ) : null}
          {project.status === "completed" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => startAnalysisForProject(project.id)}
                className="hidden md:flex h-9 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                title="重新分析"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                重新分析
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startAnalysisForProject(project.id)}
                className="flex md:hidden text-slate-600 dark:text-slate-300"
                title="重新分析"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </>
          )}
          <Button variant="secondary" size="sm" onClick={() => setCurrentScreen("report")} className="bg-indigo-600 hover:bg-indigo-700 text-white border-0 hidden md:flex h-9 shadow-sm hover:shadow">
            <FileText className="w-4 h-4 mr-2" />
            查看报告
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setCurrentScreen("report")} className="flex md:hidden text-indigo-600 dark:text-indigo-400">
             <FileText className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className={`flex-1 flex overflow-hidden ${isPortrait ? 'flex-row' : 'flex-col md:flex-row'}`}>
        
        {/* Left: Video Player Area */}
        <div className={`flex flex-col relative ${isPortrait ? 'w-auto max-w-[45%]' : 'flex-1'} min-h-0 bg-slate-100/50 dark:bg-black/20`}>
          <div className="flex-1 relative flex items-center justify-center p-4 min-h-0">
            <div className="relative w-full h-full max-w-full max-h-full flex items-center justify-center rounded-xl overflow-hidden bg-black shadow-xl border border-slate-200/50 dark:border-slate-800/50">
              <video 
                ref={videoRef}
                src={project.localVideoPath}
                poster={project.thumbnailUrl}
                className={`w-full h-full object-contain`}
                onClick={togglePlay}
              />
            </div>
          </div>
          
          {/* Enhanced Progress Bar */}
          <div className="h-32 bg-white dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-800 mx-4 mb-4 p-4 flex flex-col justify-center gap-2 shrink-0 shadow-sm backdrop-blur-sm">
            <div className="flex justify-between items-center text-xs text-slate-500 font-mono mb-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(project.durationSec)}</span>
            </div>
            <div
              ref={progressTrackRef}
              className={`relative h-10 bg-slate-100 dark:bg-[#0A0A0B] rounded-lg border border-slate-200 dark:border-slate-800 overflow-visible group ${isDraggingProgress ? "cursor-grabbing" : "cursor-pointer"}`}
              onPointerDown={handleProgressPointerDown}
              onPointerMove={handleProgressPointerMove}
              onPointerUp={handleProgressPointerUp}
              onPointerCancel={handleProgressPointerUp}
              onPointerLeave={handleProgressPointerLeave}
            >
              <div className="absolute inset-0 rounded-lg overflow-hidden">
                {/* Playhead Area */}
                <div
                  className="absolute top-0 bottom-0 bg-indigo-100 dark:bg-indigo-500/20 border-r border-indigo-400 dark:border-indigo-500/50 transition-all duration-75"
                  style={{ width: `${(currentTime / project.durationSec) * 100}%` }}
                />
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-indigo-600 dark:bg-white z-10 shadow-[0_0_10px_rgba(37,99,235,0.5)] dark:shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all duration-75"
                  style={{ left: `${(currentTime / project.durationSec) * 100}%` }}
                />
                {/* Markers */}
                {nodes.map(node => {
                  const isActive = node.id === activeNodeId;
                  const isHovered = node.id === hoveredNodeId;
                  const base = isActive
                    ? "bg-indigo-600 dark:bg-white w-[3px] z-30"
                    : isHovered
                      ? "bg-amber-600 dark:bg-amber-300 w-[4px] z-30 shadow-[0_0_8px_rgba(245,158,11,0.7)]"
                      : node.isHighlight
                        ? "bg-amber-500 dark:bg-amber-400 w-[3px] z-10"
                        : "bg-slate-400 dark:bg-slate-500 w-[2px]";
                  return (
                    <div
                      key={node.id}
                      className={`absolute top-0 bottom-0 ${base} hover:bg-slate-900 dark:hover:bg-white transition-all cursor-pointer`}
                      style={{ left: `${(node.startSec / project.durationSec) * 100}%` }}
                      onPointerEnter={() => setHoveredNodeId(node.id)}
                      onPointerLeave={() => setHoveredNodeId(prev => (prev === node.id ? null : prev))}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setActiveNodeId(node.id);
                        if (videoRef.current) {
                          videoRef.current.currentTime = node.startSec;
                          setCurrentTime(node.startSec);
                        }
                        const el = document.getElementById(`node-${node.id}`);
                        if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
                      }}
                    />
                  );
                })}
              </div>
              {/* Marker hover popover */}
              {hoveredNodeId && (() => {
                const node = nodes.find(n => n.id === hoveredNodeId);
                if (!node) return null;
                const leftPct = (node.startSec / project.durationSec) * 100;
                return (
                  <div
                    className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] shadow-lg dark:border-slate-700 dark:bg-slate-900 z-40"
                    style={{ left: `${leftPct}%` }}
                  >
                    <div className="flex items-center gap-1.5">
                      {node.isHighlight && <span className="text-amber-500">★</span>}
                      <span className="font-medium text-slate-800 dark:text-slate-100">{node.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                      <span>{formatTime(node.startSec)}</span>
                      <span>·</span>
                      <span>{node.emotionLabel}</span>
                    </div>
                  </div>
                );
              })()}
              {/* Cursor preview time */}
              {hoverProgress && !hoveredNodeId && (
                <div
                  className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-white shadow z-40 dark:bg-slate-200/90 dark:text-slate-900"
                  style={{ left: hoverProgress.x }}
                >
                  {formatTime(hoverProgress.time)}
                </div>
              )}
            </div>
            {/* 弹幕情绪带 (仅 B 站项目, 时间桶 → 颜色) */}
            {report?.danmaku && report.danmaku.windows.length > 0 && (
              <div className="relative h-2 rounded overflow-hidden bg-slate-100 dark:bg-[#0A0A0B] border border-slate-200 dark:border-slate-800/60">
                {report.danmaku.windows.map((w, i) => {
                  if (w.danmakuCount === 0) return null;
                  const leftPct = (w.startSec / project.durationSec) * 100;
                  const widthPct = ((w.endSec - w.startSec) / project.durationSec) * 100;
                  const maxIntensity = Math.max(
                    w.intensities.joy,
                    w.intensities.surprise,
                    w.intensities.anger,
                    w.intensities.sadness,
                    w.intensities.disgust,
                  );
                  const opacity = w.dominantEmotion === "neutral" ? 0.2 : Math.max(0.35, Math.min(1, maxIntensity));
                  return (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        background: EMOTION_COLORS[w.dominantEmotion],
                        opacity,
                      }}
                      title={`${formatTime(w.startSec)}-${formatTime(w.endSec)} · ${w.danmakuCount} 条 · ${w.summary || EMOTION_ZH[w.dominantEmotion]}`}
                    />
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-center mt-1">
              <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={togglePlay}>
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Right: Nodes List Sidebar */}
        <div className={`${isPortrait ? 'flex-1' : 'w-full md:w-[540px]'} border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] flex flex-col min-h-0 shadow-sm z-10`}>
          <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex-none bg-slate-50/80 dark:bg-[#0E0E10] space-y-3">
            {report?.globalSummary && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 font-medium">全局概览</div>
                </div>
                <p className="text-[12.5px] text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-3" title={report.globalSummary}>
                  {report.globalSummary}
                </p>
              </div>
            )}
            <div className="flex border-b border-slate-200 dark:border-slate-800" role="tablist">
              {([
                { key: "timeline", label: "逻辑节点", count: nodes.length },
                { key: "shots", label: "镜头", count: shotContexts.length },
                { key: "insights", label: "概览", count: undefined as number | undefined },
              ] as const).map((item) => {
                const isActive = tab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setTab(item.key)}
                    className={`relative flex-1 h-10 inline-flex items-center justify-center gap-1.5 text-sm transition-colors ${
                      isActive
                        ? "text-slate-900 dark:text-slate-100 font-semibold"
                        : "text-slate-500 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                    }`}
                  >
                    <span>{item.label}</span>
                    {typeof item.count === "number" && item.count > 0 && (
                      <span className={`font-mono text-[10.5px] tabular-nums px-1 rounded ${
                        isActive
                          ? "text-indigo-700 bg-indigo-50 dark:bg-indigo-950/60 dark:text-indigo-300"
                          : "text-slate-400 dark:text-slate-600"
                      }`}>
                        {item.count}
                      </span>
                    )}
                    {isActive && (
                      <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-indigo-600 dark:bg-indigo-400" />
                    )}
                  </button>
                );
              })}
            </div>
            {tab === "timeline" && (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索节点、情绪、备注"
                    className="h-9 bg-white pl-8 text-sm dark:bg-slate-900"
                  />
                </div>
                <Button
                  variant={highlightsOnly ? "default" : "outline"}
                  size="sm"
                  onClick={() => setHighlightsOnly(value => !value)}
                  className={highlightsOnly ? "bg-amber-500 text-white hover:bg-amber-600" : "border-slate-200 dark:border-slate-800"}
                >
                  <Star className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          {tab === "shots" ? (
            <ScrollArea className="flex-1 min-h-0 px-4 py-4">
              <div className="space-y-3 pb-20">
                {shotContexts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-800">
                    本项目还没有镜头级数据。请重新分析以生成镜头时间线。
                  </div>
                ) : (
                  shotContexts.map((sc) => {
                    const isCurrent = currentTime >= sc.startSec && currentTime < sc.endSec;
                    const reps = sc.representativeFrames || [];
                    const allFrames = sc.frames || reps;
                    const heroFrame = reps[0] || allFrames[0] || null;
                    const dur = Math.max(0, sc.endSec - sc.startSec);
                    return (
                      <div
                        key={sc.shotIndex}
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = sc.startSec;
                            setCurrentTime(sc.startSec);
                          }
                        }}
                        className={`p-3 rounded-xl cursor-pointer border transition-all duration-200 ${
                          isCurrent
                            ? "bg-indigo-50/50 dark:bg-indigo-600/10 border-indigo-300 dark:border-indigo-500/40 ring-1 ring-indigo-400/30"
                            : "bg-white dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/60 hover:border-slate-300 dark:hover:bg-slate-900/60"
                        }`}
                      >
                        <div className="flex gap-3">
                          {/* Left: hero thumbnail fills the full card height */}
                          <div
                            className="shrink-0 self-stretch w-[148px] min-h-[83px] rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-900/40 relative"
                            onClick={(e) => {
                              if (!heroFrame) return;
                              e.stopPropagation();
                              if (videoRef.current) {
                                videoRef.current.currentTime = heroFrame.midSec;
                                setCurrentTime(heroFrame.midSec);
                              }
                            }}
                          >
                            {heroFrame ? (
                              <>
                                <img
                                  src={heroFrame.thumbnailUrl}
                                  alt={`t=${heroFrame.midSec.toFixed(1)}s`}
                                  className="absolute inset-0 w-full h-full object-cover"
                                />
                                <div className="absolute bottom-1 left-1 right-1 flex justify-center">
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/65 text-white tabular-nums">
                                    {heroFrame.midSec.toFixed(1)}s
                                  </span>
                                </div>
                              </>
                            ) : (
                              <div className="absolute inset-0 grid place-items-center text-slate-400 dark:text-slate-600 text-[10px] font-mono">
                                NO FRAME
                              </div>
                            )}
                          </div>

                          {/* Right: meta + description */}
                          <div className="flex-1 min-w-0 flex flex-col gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">
                                S{sc.shotIndex + 1}
                              </span>
                              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                                {formatTime(sc.startSec)} → {formatTime(sc.endSec)}
                              </span>
                              <span className="text-[10px] font-mono text-slate-400 tabular-nums">{dur.toFixed(1)}s</span>
                            </div>
                            {sc.shotDescription && (
                              <p className="text-[13px] text-slate-700 dark:text-slate-300 leading-relaxed">
                                {sc.shotDescription}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Subtitles row — full width below the hero+description block */}
                        {Array.isArray(sc.subtitleSegments) && sc.subtitleSegments.length > 0 ? (() => {
                          const isExpanded = expandedSubtitleShots.has(sc.shotIndex);
                          const visible = isExpanded ? sc.subtitleSegments : sc.subtitleSegments.slice(0, 4);
                          const overflow = sc.subtitleSegments.length - 4;
                          return (
                            <div className="mt-3 rounded-md bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800/60 px-3 py-2 space-y-1">
                              {visible.map((seg, si) => (
                                <div key={si} className="text-[12px] text-slate-700 dark:text-slate-300 leading-snug flex gap-2">
                                  <span className="font-mono text-slate-400 tabular-nums shrink-0">
                                    {formatTime(seg.start)}
                                  </span>
                                  <span className="min-w-0">{seg.text}</span>
                                </div>
                              ))}
                              {overflow > 0 && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedSubtitleShots((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(sc.shotIndex)) next.delete(sc.shotIndex);
                                      else next.add(sc.shotIndex);
                                      return next;
                                    });
                                  }}
                                  className="text-[11px] font-mono text-indigo-600 dark:text-indigo-400 hover:underline mt-0.5"
                                >
                                  {isExpanded ? "收起" : `展开剩余 ${overflow} 条`}
                                </button>
                              )}
                            </div>
                          );
                        })() : sc.subtitleText ? (
                          <div className="mt-3 rounded-md bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800/60 px-3 py-2">
                            <p className="text-[12px] text-slate-700 dark:text-slate-300 leading-snug">
                              {sc.subtitleText}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          ) : tab === "insights" ? (
            <ScrollArea className="flex-1 min-h-0 px-4 py-4">
              <div className="space-y-5 pb-20">
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="节点总数" value={String(totalNodes)} />
                  <StatCard label="重点节点" value={`${highlightCount}`} sub={totalNodes ? `${Math.round((highlightCount / totalNodes) * 100)}%` : "—"} />
                  <StatCard label="平均置信度" value={`${avgConfidence}%`} />
                  <StatCard label="平均情绪强度" value={avgEmotion ? `${avgEmotion}/10` : "—"} />
                </div>

                <DistributionList
                  title="情绪分布"
                  total={totalNodes}
                  items={emotionDistribution}
                  emptyHint="暂无情绪标签"
                />

                <DistributionList
                  title="节点类型分布"
                  total={nodeTypeDistribution.reduce((sum, [, count]) => sum + count, 0)}
                  items={nodeTypeDistribution.map(([key, count]) => [
                    nodeTypeLabel[key as AnalysisNodeType] || key,
                    count,
                  ])}
                  emptyHint="暂无节点类型"
                />

                {highlightCount > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300">
                    <p className="font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2">重点速览</p>
                    <ul className="space-y-1">
                      {nodes.filter(n => n.isHighlight).slice(0, 5).map(node => (
                        <li key={node.id} className="flex items-center justify-between gap-2">
                          <span className="truncate">{node.title}</span>
                          <span className="font-mono text-slate-400">{formatTime(node.startSec)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : (
          <ScrollArea className="flex-1 min-h-0 px-4 py-4" ref={scrollRef}>
            <div className="space-y-4 pb-20">
              {filteredNodes.map((node) => {
                const isActive = activeNodeId === node.id;
                const isHovered = hoveredNodeId === node.id;
                const nodeFrames = node.representativeFrames && node.representativeFrames.length > 0
                  ? node.representativeFrames
                  : node.framesInShot || [];
                const heroFrame = nodeFrames[0];
                return (
                  <div
                    key={node.id}
                    id={`node-${node.id}`}
                    onClick={() => handleNodeClick(node)}
                    onDoubleClick={() => handleNodeDoubleClick(node)}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId((prev) => (prev === node.id ? null : prev))}
                    className={`p-4 rounded-xl cursor-pointer border transition-all duration-200 shadow-sm
                      ${isActive
                        ? 'bg-indigo-50/50 dark:bg-indigo-600/10 border-indigo-300 dark:border-indigo-500/40 ring-1 ring-indigo-400/30 dark:ring-indigo-500/20'
                        : isHovered
                          ? 'bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/60 dark:border-amber-500/30'
                          : 'bg-white dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/60 hover:border-slate-300 dark:hover:bg-slate-900/60'
                      }
                    `}
                  >
                    <div className="flex gap-3 items-center">
                      {heroFrame && (
                        <div
                          className="shrink-0 w-[132px] rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-900/40 relative"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (videoRef.current) {
                              videoRef.current.currentTime = heroFrame.midSec;
                              setCurrentTime(heroFrame.midSec);
                            }
                          }}
                          title={`跳转到 ${heroFrame.midSec.toFixed(1)}s`}
                        >
                          <img
                            src={heroFrame.thumbnailUrl}
                            alt={`t=${heroFrame.midSec.toFixed(1)}s`}
                            className="w-full aspect-video object-cover"
                          />
                          <div className="absolute bottom-1 left-1 right-1 flex justify-center">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/65 text-white tabular-nums">
                              {heroFrame.midSec.toFixed(1)}s
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <span className={`text-xs font-mono px-2 py-0.5 rounded-md border tabular-nums ${isActive ? 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-400 dark:border-indigo-500/30' : 'bg-slate-100/50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}>
                              {formatTime(node.startSec)}
                            </span>
                            <h3 className={`font-semibold text-sm leading-snug ${isActive ? 'text-indigo-900 dark:text-slate-50' : 'text-slate-800 dark:text-slate-300'}`}>{node.title}</h3>
                          </div>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              updateNode(node.id, { isHighlight: !node.isHighlight });
                            }}
                            className={`shrink-0 rounded p-1 transition ${node.isHighlight ? "text-amber-500" : "text-slate-400 hover:text-amber-500"}`}
                            title={node.isHighlight ? "取消重点" : "标记重点"}
                          >
                            <Star className={`h-4 w-4 ${node.isHighlight ? "fill-current" : ""}`} />
                          </button>
                        </div>

                        {!isActive && (
                          <>
                            <div className="flex items-center gap-2 flex-wrap">
                              {node.isHighlight ? (
                                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10.5px] font-mono uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20">
                                  <Star className="w-2.5 h-2.5 fill-current" /> 高光
                                </span>
                              ) : (
                                <span className="inline-flex items-center h-5 px-1.5 rounded text-[10.5px] font-mono uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">
                                  {node.narrativeFunction || "节点"}
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 dark:text-slate-500 flex items-center gap-2 flex-wrap">
                              {node.emotionLabel && (
                                <>
                                  <span className="normal-case font-sans">{node.emotionLabel} {node.emotionIntensity}/10</span>
                                  <span className="text-slate-300 dark:text-slate-700">·</span>
                                </>
                              )}
                              {(() => {
                                const hits = (node.methodologyTags || []).filter(t => t.status === "hit").length;
                                const vios = (node.methodologyTags || []).filter(t => t.status === "violation").length;
                                if (hits === 0 && vios === 0) return null;
                                return (
                                  <span>
                                    {hits > 0 && <span className="text-indigo-600 dark:text-indigo-400">命中 {hits}</span>}
                                    {hits > 0 && vios > 0 && <span className="mx-1 text-slate-300 dark:text-slate-700">/</span>}
                                    {vios > 0 && <span className="text-amber-600 dark:text-amber-400">违反 {vios}</span>}
                                  </span>
                                );
                              })()}
                              {node.audienceReaction && node.audienceReaction.danmakuCount > 0 && (
                                <>
                                  <span className="text-slate-300 dark:text-slate-700">·</span>
                                  <span className="normal-case font-sans inline-flex items-center gap-1">
                                    <span
                                      className="inline-block w-1.5 h-1.5 rounded-full"
                                      style={{ background: EMOTION_COLORS[node.audienceReaction.dominantEmotion] }}
                                    />
                                    {node.audienceReaction.summary} · {node.audienceReaction.danmakuCount} 条弹幕
                                  </span>
                                </>
                              )}
                            </div>
                          </>
                        )}

                        {isActive && (
                          <>
                            <div className="flex flex-wrap gap-2">
                              <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 dark:hover:bg-slate-700 text-[11px] px-2 py-0.5 font-medium shadow-none">{node.narrativeFunction}</Badge>
                              <Badge variant="secondary" className="bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 text-[11px] px-2 py-0.5 font-medium dark:border-emerald-500/20 shadow-none">{node.emotionLabel}</Badge>
                              {(node.methodologyTags || []).map((tag, ti) => (
                                <Badge
                                  key={`${tag.ruleId}-${ti}`}
                                  variant="secondary"
                                  title={`${tag.ruleName}${tag.evidence ? "：" + tag.evidence : ""}${tag.status === "violation" && tag.fixSuggestion ? "\n修复：" + tag.fixSuggestion : ""}`}
                                  className={`text-[11px] px-2 py-0.5 font-medium shadow-none ${
                                    tag.status === "hit"
                                      ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-500/20"
                                      : "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20"
                                  }`}
                                >
                                  {tag.status === "hit" ? "✓" : "⚠"} {tag.ruleName}
                                </Badge>
                              ))}
                              {node.prefilterTag && (
                                <Badge
                                  variant="secondary"
                                  title={`本地初筛\n场景: ${node.prefilterTag.sceneType}\n主体: ${node.prefilterTag.subject}\n信息量: ${node.prefilterTag.salience}/10\n签名: ${node.prefilterTag.signature}${node.prefilterTag.hasText !== "none" ? `\n含文字: ${node.prefilterTag.hasText}` : ""}`}
                                  className={`text-[11px] px-2 py-0.5 font-medium shadow-none ${
                                    node.prefilterTag.salience >= 7
                                      ? "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/20"
                                      : "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700"
                                  }`}
                                >
                                  {node.prefilterTag.subject} · {node.prefilterTag.salience}
                                </Badge>
                              )}
                            </div>

                          </>
                        )}
                      </div>
                    </div>

                    {isActive && (
                      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800/50 space-y-4 animate-in fade-in slide-in-from-top-2">
                        {node.shotDescription && (
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-500 mr-2" /> 镜头描述
                            </p>
                            <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                              {node.shotDescription}
                            </p>
                          </div>
                        )}
                        {node.prefilterTag?.caption && (
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-orange-500 mr-2" /> 初筛画面描述
                            </p>
                            <p className="text-sm text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900/40 p-3 rounded-lg border border-slate-100 dark:border-slate-800/50 shadow-sm">{node.prefilterTag.caption}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mr-2" /> 剪辑意图
                          </p>
                          <p className="text-sm text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900/40 p-3 rounded-lg border border-slate-100 dark:border-slate-800/50 shadow-sm inner-shadow">{node.editIntent}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 mr-2" /> 画面要素
                            </p>
                            <ul className="text-sm text-slate-600 dark:text-slate-400 list-disc list-inside space-y-1">
                              {node.visualElements.map((el, i) => <li key={i} className="truncate">{el}</li>)}
                            </ul>
                          </div>
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-2" /> 音频要素
                            </p>
                            <ul className="text-sm text-slate-600 dark:text-slate-400 list-disc list-inside space-y-1">
                              {node.audioElements.map((el, i) => <li key={i} className="truncate">{el}</li>)}
                            </ul>
                          </div>
                        </div>
                        {node.audienceReaction && node.audienceReaction.danmakuCount > 0 && (
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span
                                className="w-1.5 h-1.5 rounded-full mr-2"
                                style={{ background: EMOTION_COLORS[node.audienceReaction.dominantEmotion] }}
                              />
                              观众反应 · {node.audienceReaction.danmakuCount} 条弹幕
                            </p>
                            <div className="rounded-lg border border-slate-100 dark:border-slate-800/50 bg-white dark:bg-slate-900/40 p-3 space-y-2 shadow-sm">
                              <p className="text-sm text-slate-700 dark:text-slate-300">{node.audienceReaction.summary}</p>
                              {node.audienceReaction.topTerms && node.audienceReaction.topTerms.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {node.audienceReaction.topTerms.slice(0, 8).map((t) => (
                                    <span
                                      key={t.text}
                                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400"
                                    >
                                      {t.text}
                                      <span className="ml-1 text-slate-400 dark:text-slate-500">×{t.value}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        <div>
                          <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-2" /> 备注
                          </p>
                          <Textarea
                            value={node.note || ""}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => updateNode(node.id, { note: event.target.value })}
                            placeholder="补充人工备注"
                            className="min-h-20 resize-none bg-white text-sm dark:bg-slate-900/40"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {filteredNodes.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-800">
                  没有匹配的节点
                </div>
              )}
            </div>
          </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceBadge({ project, copied, onCopy }: { project: Video; copied: boolean; onCopy: () => void }) {
  const source = project.source;
  const isUrl = source.type === "url";
  const value = isUrl ? source.url : (project.localFilePath || source.originalPath);
  if (!value) return null;
  const display = isUrl
    ? value.replace(/^https?:\/\//, "")
    : value.replace(/^.*[/\\]/, "");
  const Icon = isUrl ? ExternalLink : Folder;
  return (
    <div
      title={value}
      className="hidden md:flex items-center gap-1.5 min-w-0 max-w-[260px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-[11px] text-slate-500 dark:text-slate-400"
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono">{display}</span>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 ml-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-800 dark:text-slate-100">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 dark:text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function DistributionList({
  title,
  total,
  items,
  emptyHint,
}: {
  title: string;
  total: number;
  items: Array<[string, number]>;
  emptyHint: string;
}) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">
        {emptyHint}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-3">{title}</p>
      <ul className="space-y-2">
        {items.map(([key, count]) => {
          const ratio = total ? Math.round((count / total) * 100) : 0;
          return (
            <li key={key}>
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                <span className="truncate">{key}</span>
                <span className="font-mono text-slate-500 dark:text-slate-400">{count} · {ratio}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
                <div className="h-full rounded-full bg-indigo-500" style={{ width: `${ratio}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
