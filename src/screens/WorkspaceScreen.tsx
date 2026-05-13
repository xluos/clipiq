import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Play, Pause, ArrowLeft, Folder, Search, Star, ExternalLink, Copy, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnalysisNode, AnalysisNodeType, Project } from "../types";
import { formatTime } from "@/lib/utils";

export function WorkspaceScreen() {
  const { setCurrentScreen, projects, activeProjectId, nodesByProject, setNodesForProject } = useApp();
  
  const project = projects.find(p => p.id === activeProjectId);
  const nodes = nodesByProject[activeProjectId || ""] || [];
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlightsOnly, setHighlightsOnly] = useState(false);
  const [tab, setTab] = useState<"timeline" | "insights">("timeline");
  const [sourceCopied, setSourceCopied] = useState(false);

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
    if (videoRef.current) {
      videoRef.current.currentTime = node.startSec;
    }
  };

  const handleNodeDoubleClick = (node: AnalysisNode) => {
    if (videoRef.current) {
      videoRef.current.currentTime = node.startSec;
      videoRef.current.play();
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
    }
  };

  const updateNode = (nodeId: string, patch: Partial<AnalysisNode>) => {
    if (!activeProjectId) return;
    setNodesForProject(activeProjectId, nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node));
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
                className={`w-full h-full object-contain`}
                onClick={togglePlay}
              />
            </div>
          </div>
          
          {/* Enhanced Progress Bar */}
          <div className="h-28 bg-white dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-800 mx-4 mb-4 p-4 flex flex-col justify-center gap-2 shrink-0 shadow-sm backdrop-blur-sm">
            <div className="flex justify-between items-center text-xs text-slate-500 font-mono mb-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(project.durationSec)}</span>
            </div>
            <div className="relative h-10 bg-slate-100 dark:bg-[#0A0A0B] rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer overflow-hidden group" onClick={(e) => {
              if (videoRef.current) {
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                videoRef.current.currentTime = pos * project.durationSec;
              }
            }}>
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
                const color = isActive
                  ? "bg-indigo-600 dark:bg-white"
                  : node.isHighlight
                    ? "bg-amber-500 dark:bg-amber-400"
                    : "bg-slate-400 dark:bg-slate-500";
                return (
                  <div
                    key={node.id}
                    className={`absolute top-0 bottom-0 ${isActive ? "w-[3px] z-20" : node.isHighlight ? "w-[3px] z-10" : "w-[2px]"} ${color} hover:bg-slate-900 dark:hover:bg-white transition-colors cursor-pointer`}
                    style={{ left: `${(node.startSec / project.durationSec) * 100}%` }}
                    title={`${node.title}${node.isHighlight ? " (重点)" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (videoRef.current) videoRef.current.currentTime = node.startSec;
                    }}
                  />
                );
              })}
            </div>
            <div className="flex items-center justify-center mt-1">
              <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={togglePlay}>
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Right: Nodes List Sidebar */}
        <div className={`${isPortrait ? 'flex-1' : 'w-full md:w-[450px]'} border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] flex flex-col min-h-0 shadow-sm z-10`}>
          <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex-none bg-slate-50/80 dark:bg-[#0E0E10] space-y-3">
            <Tabs value={tab} onValueChange={(value) => setTab(value as "timeline" | "insights")}>
              <TabsList className="grid w-full grid-cols-2 bg-slate-100 dark:bg-slate-900 p-1 rounded-lg">
                <TabsTrigger value="timeline" className="data-[state=active]:bg-white dark:data-[state=active]:bg-[#0E0E10] rounded-md shadow-sm dark:shadow-none font-medium">时间线</TabsTrigger>
                <TabsTrigger value="insights" className="data-[state=active]:bg-white dark:data-[state=active]:bg-[#0E0E10] rounded-md shadow-sm dark:shadow-none font-medium">概览</TabsTrigger>
              </TabsList>
            </Tabs>
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

          {tab === "insights" ? (
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
                return (
                  <div
                    key={node.id}
                    id={`node-${node.id}`}
                    onClick={() => handleNodeClick(node)}
                    onDoubleClick={() => handleNodeDoubleClick(node)}
                    className={`p-4 rounded-xl cursor-pointer border transition-all duration-200 shadow-sm
                      ${isActive 
                        ? 'bg-indigo-50/50 dark:bg-indigo-600/10 border-indigo-300 dark:border-indigo-500/40 ring-1 ring-indigo-400/30 dark:ring-indigo-500/20' 
                        : 'bg-white dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/60 hover:border-slate-300 dark:hover:bg-slate-900/60'
                      }
                    `}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center space-x-3">
                        <span className={`text-xs font-mono px-2 py-0.5 rounded-md border ${isActive ? 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-400 dark:border-indigo-500/30' : 'bg-slate-100/50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}>
                          {formatTime(node.startSec)}
                        </span>
                        <h3 className={`font-semibold text-sm ${isActive ? 'text-indigo-900 dark:text-slate-50' : 'text-slate-800 dark:text-slate-300'}`}>{node.title}</h3>
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          updateNode(node.id, { isHighlight: !node.isHighlight });
                        }}
                        className={`rounded p-1 transition ${node.isHighlight ? "text-amber-500" : "text-slate-400 hover:text-amber-500"}`}
                        title={node.isHighlight ? "取消重点" : "标记重点"}
                      >
                        <Star className={`h-4 w-4 ${node.isHighlight ? "fill-current" : ""}`} />
                      </button>
                    </div>
                    
                    <div className="flex flex-wrap gap-2 mb-3">
                      <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 dark:hover:bg-slate-700 text-[11px] px-2 py-0.5 font-medium shadow-none">{node.narrativeFunction}</Badge>
                      <Badge variant="secondary" className="bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 text-[11px] px-2 py-0.5 font-medium dark:border-emerald-500/20 shadow-none">{node.emotionLabel}</Badge>
                    </div>

                    <p className={`text-sm line-clamp-2 leading-relaxed ${isActive ? 'text-slate-700 dark:text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>
                      {node.shotDescription}
                    </p>

                    {isActive && (
                      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800/50 space-y-4 animate-in fade-in slide-in-from-top-2">
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
                        <div>
                          <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-2" /> 备注
                          </p>
                          <Textarea
                            value={node.note || ""}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => updateNode(node.id, { note: event.target.value })}
                            placeholder="补充人工备注，会自动保存到项目数据。"
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

function SourceBadge({ project, copied, onCopy }: { project: Project; copied: boolean; onCopy: () => void }) {
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
